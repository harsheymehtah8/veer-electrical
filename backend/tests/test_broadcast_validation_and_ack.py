"""Backend tests for iteration 3:

- POST /api/broadcast/start: phone validation (all-invalid -> 400, mixed -> 200 + invalid_numbers),
  normalization of Indian numbers.
- POST /api/whatsapp/ack: legacy ['id'] shape AND new [{'id','reason'}] shape, stores error_reason.
- GET /api/whatsapp/queue/recent: returns error_reason for failed items.
"""
import os
import time

import pytest
import requests
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/") if os.environ.get("REACT_APP_BACKEND_URL") else None
if not BASE_URL:
    # Fallback: read from frontend env file directly
    with open("/app/frontend/.env") as fh:
        for line in fh:
            if line.startswith("REACT_APP_BACKEND_URL="):
                BASE_URL = line.split("=", 1)[1].strip().rstrip("/")
                break

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]

mongo = MongoClient(MONGO_URL)
db = mongo[DB_NAME]


@pytest.fixture(scope="module")
def webhook_secret():
    s = db.settings.find_one({"_id": "settings"})
    assert s, "settings doc missing"
    secret = s.get("webhook_secret")
    assert secret, "webhook_secret missing in settings"
    return secret


@pytest.fixture
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ---------- /broadcast/start ----------

class TestBroadcastStartValidation:
    def test_all_invalid_returns_400(self, api):
        r = api.post(f"{BASE_URL}/api/broadcast/start", json={
            "contacts": [{"phone": "99870003415"}, {"phone": "abc"}],
            "message": "TEST_invalid",
            "mode": "A",
        })
        assert r.status_code == 400, r.text
        body = r.json()
        # FastAPI returns {detail: "..."}
        detail = body.get("detail") or body.get("error") or body.get("message") or ""
        assert "invalid" in detail.lower()

    def test_mixed_valid_invalid_returns_200_with_invalid_numbers(self, api):
        r = api.post(f"{BASE_URL}/api/broadcast/start", json={
            "contacts": [
                {"phone": "9999911111"},   # valid 10-digit Indian
                {"phone": "99870003415"},  # invalid 11-digit
                {"phone": "+91 99999-22222"},  # valid w/ formatting
                {"phone": "xyz"},          # invalid
            ],
            "message": "TEST_mixed",
            "mode": "A",
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["total"] == 2, f"expected 2 valid, got {body['total']}"
        assert "invalid_numbers" in body
        assert len(body["invalid_numbers"]) == 2
        invalid_strs = [str(x) for x in body["invalid_numbers"]]
        assert any("99870003415" in s for s in invalid_strs)
        assert any("xyz" in s for s in invalid_strs)
        # Verify normalization persisted on the cleaned contacts
        phones = [c["phone"] for c in body["contacts"]]
        assert "919999911111" in phones
        assert "919999922222" in phones
        # cleanup
        db.broadcasts.delete_one({"_id": body["id"]})

    def test_normalization_variants(self, api):
        r = api.post(f"{BASE_URL}/api/broadcast/start", json={
            "contacts": [
                {"phone": "9876543210"},        # plain 10-digit
                {"phone": "+91 99999-11111"},   # formatted +91
                {"phone": "09876543211"},       # leading 0
            ],
            "message": "TEST_norm",
            "mode": "A",
        })
        assert r.status_code == 200, r.text
        body = r.json()
        phones = sorted(c["phone"] for c in body["contacts"])
        assert phones == sorted(["919876543210", "919999911111", "919876543211"]), phones
        assert body["total"] == 3
        db.broadcasts.delete_one({"_id": body["id"]})


# ---------- /whatsapp/ack legacy + new shapes ----------

class TestWhatsappAck:
    def _create_outbox(self, broadcast_id=None):
        from uuid import uuid4
        oid = uuid4().hex
        doc = {
            "_id": oid,
            "phone": "919999911111",
            "payload": {"type": "text", "text": "TEST_ack"},
            "sender_id": "test-sender",
            "status": "sending",
            "created_at": "2026-01-01T00:00:00Z",
        }
        if broadcast_id:
            doc["broadcast_id"] = broadcast_id
        db.outbox.insert_one(doc)
        return oid

    def _create_broadcast(self):
        from uuid import uuid4
        bid = uuid4().hex
        db.broadcasts.insert_one({
            "_id": bid, "id": bid, "contacts": [], "message": "TEST_ack_bcast",
            "mode": "A", "total": 1, "sent": 0, "failed": 0, "status": "running",
            "created_at": "2026-01-01T00:00:00Z",
        })
        return bid

    def test_ack_legacy_string_failed(self, api, webhook_secret):
        bid = self._create_broadcast()
        oid = self._create_outbox(broadcast_id=bid)
        r = api.post(
            f"{BASE_URL}/api/whatsapp/ack",
            headers={"X-Webhook-Secret": webhook_secret},
            json={"sent": [], "failed": [oid], "sender_id": "test-sender"},
        )
        assert r.status_code == 200, r.text
        doc = db.outbox.find_one({"_id": oid})
        assert doc["status"] == "failed"
        assert doc.get("error_reason") == "send failed"  # default reason
        bdoc = db.broadcasts.find_one({"_id": bid})
        assert bdoc.get("failed") == 1
        db.outbox.delete_one({"_id": oid})
        db.broadcasts.delete_one({"_id": bid})

    def test_ack_new_dict_failed_stores_reason(self, api, webhook_secret):
        bid = self._create_broadcast()
        oid = self._create_outbox(broadcast_id=bid)
        reason = "not on whatsapp"
        r = api.post(
            f"{BASE_URL}/api/whatsapp/ack",
            headers={"X-Webhook-Secret": webhook_secret},
            json={
                "sent": [],
                "failed": [{"id": oid, "reason": reason}],
                "sender_id": "test-sender",
            },
        )
        assert r.status_code == 200, r.text
        doc = db.outbox.find_one({"_id": oid})
        assert doc["status"] == "failed"
        assert doc.get("error_reason") == reason
        bdoc = db.broadcasts.find_one({"_id": bid})
        assert bdoc.get("failed") == 1
        db.outbox.delete_one({"_id": oid})
        db.broadcasts.delete_one({"_id": bid})

    def test_ack_bad_secret_rejected(self, api):
        r = api.post(
            f"{BASE_URL}/api/whatsapp/ack",
            headers={"X-Webhook-Secret": "wrong"},
            json={"sent": [], "failed": []},
        )
        assert r.status_code == 401

    def test_queue_recent_returns_error_reason(self, api, webhook_secret):
        bid = self._create_broadcast()
        oid = self._create_outbox(broadcast_id=bid)
        api.post(
            f"{BASE_URL}/api/whatsapp/ack",
            headers={"X-Webhook-Secret": webhook_secret},
            json={"failed": [{"id": oid, "reason": "TEST_reason_xyz"}], "sender_id": "test-sender"},
        )
        r = api.get(f"{BASE_URL}/api/whatsapp/queue/recent?limit=200")
        assert r.status_code == 200
        items = r.json()
        match = [it for it in items if it["id"] == oid]
        assert match, "outbox doc not present in queue/recent"
        assert match[0].get("error_reason") == "TEST_reason_xyz"
        db.outbox.delete_one({"_id": oid})
        db.broadcasts.delete_one({"_id": bid})


# ---------- regression: blast-templates list still works ----------

class TestBlastTemplatesRegression:
    def test_list_templates(self, api):
        r = api.get(f"{BASE_URL}/api/blast-templates")
        assert r.status_code == 200
        assert isinstance(r.json(), list)

    def test_create_template_via_save_as(self, api):
        name = f"TEST_save_as_{int(time.time())}"
        r = api.post(f"{BASE_URL}/api/blast-templates", json={
            "name": name,
            "message": "from save-as-template button",
            "attachment_id": None,
            "attachment_name": None,
        })
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["name"] == name
        # cleanup
        tid = body.get("id") or body.get("_id")
        if tid:
            db.blast_templates.delete_one({"_id": tid})
        else:
            db.blast_templates.delete_many({"name": name})
