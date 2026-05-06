import os
import io
import time
import requests
import pytest

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://electrical-inbox.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

@pytest.fixture(scope="session")
def token():
    phone = "9999900001"
    r = requests.post(f"{API}/auth/send-otp", json={"phone": phone}, timeout=15)
    assert r.status_code == 200
    otp = r.json()["dev_otp"]
    r2 = requests.post(f"{API}/auth/verify-otp", json={"phone": phone, "otp": otp}, timeout=15)
    assert r2.status_code == 200
    return r2.json()["token"]

@pytest.fixture(scope="session")
def fresh_phone():
    return f"98765{int(time.time()) % 100000:05d}"

# --- Auth ---
def test_send_otp_returns_dev_otp():
    r = requests.post(f"{API}/auth/send-otp", json={"phone": "9999911111"}, timeout=15)
    assert r.status_code == 200
    assert "dev_otp" in r.json()

def test_verify_otp_invalid():
    r = requests.post(f"{API}/auth/verify-otp", json={"phone": "9999911111", "otp": "000000"}, timeout=15)
    assert r.status_code == 401

# --- Settings ---
def test_settings_get_default(token):
    r = requests.get(f"{API}/settings", timeout=15)
    assert r.status_code == 200
    j = r.json()
    assert "business_name" in j and "prefix_tag" in j

def test_settings_update(token):
    payload = {"business_name": "Veer Electrical", "prefix_tag": "VE", "owner_phone": ""}
    r = requests.put(f"{API}/settings", json=payload, timeout=15)
    assert r.status_code == 200
    assert r.json()["prefix_tag"] == "VE"

# --- Catalog ---
def test_catalog_seeded():
    r = requests.get(f"{API}/catalog", timeout=15)
    assert r.status_code == 200
    items = r.json()
    assert len(items) >= 5
    names = {i["name"] for i in items}
    for n in ["Switches", "Fans", "LEDs", "MCBs", "Wires"]:
        assert n in names
    sw = next(i for i in items if i["name"] == "Switches")
    assert len(sw["brands"]) == 4
    brand0 = sw["brands"][0]
    assert len(brand0["series"]) >= 1

def test_catalog_crud_range():
    r = requests.post(f"{API}/catalog/range", json={"name": "TEST_Range"}, timeout=15)
    assert r.status_code == 200
    rid = r.json()["id"]
    # add brand
    rb = requests.post(f"{API}/catalog/range/{rid}/brand", json={"name": "TEST_Brand"}, timeout=15)
    assert rb.status_code == 200
    bid = rb.json()["id"]
    rs = requests.post(f"{API}/catalog/range/{rid}/brand/{bid}/series", json={"name": "TEST_Series"}, timeout=15)
    assert rs.status_code == 200
    sid = rs.json()["id"]
    # PDF upload
    files = {"file": ("test.pdf", b"%PDF-1.4 dummy", "application/pdf")}
    rp = requests.post(f"{API}/catalog/range/{rid}/brand/{bid}/series/{sid}/pdf", files=files, timeout=20)
    assert rp.status_code == 200
    assert "file_id" in rp.json()
    # cleanup
    requests.delete(f"{API}/catalog/range/{rid}/brand/{bid}/series/{sid}", timeout=15)
    requests.delete(f"{API}/catalog/range/{rid}/brand/{bid}", timeout=15)
    requests.delete(f"{API}/catalog/range/{rid}", timeout=15)

# --- Bot State Machine ---
def test_bot_full_flow(fresh_phone):
    phone = fresh_phone
    requests.post(f"{API}/bot/reset/{phone}", timeout=15)
    # 1. New customer first reply
    r = requests.post(f"{API}/bot/incoming", json={"phone": phone, "message": "hi"}, timeout=15)
    assert r.status_code == 200
    replies = r.json()["replies"]
    assert len(replies) == 1
    assert "Firm" in replies[0]["text"] or "firm" in replies[0]["text"].lower()
    # 2. Bad format
    r = requests.post(f"{API}/bot/incoming", json={"phone": phone, "message": "just text"}, timeout=15)
    replies = r.json()["replies"]
    assert any("format" in x["text"].lower() for x in replies)
    # 3. Good format -> saved + range menu
    r = requests.post(f"{API}/bot/incoming", json={"phone": phone, "message": "TEST Traders, Surat, Gujarat"}, timeout=15)
    replies = r.json()["replies"]
    assert len(replies) == 2
    assert "Saved" in replies[0]["text"] or "VE" in replies[0]["text"]
    assert "1." in replies[1]["text"]  # menu
    # 4. Pick a range
    r = requests.post(f"{API}/bot/incoming", json={"phone": phone, "message": "1"}, timeout=15)
    replies = r.json()["replies"]
    assert any("1." in x["text"] for x in replies)
    # 5. Pick a brand
    r = requests.post(f"{API}/bot/incoming", json={"phone": phone, "message": "1"}, timeout=15)
    replies = r.json()["replies"]
    assert any("1." in x["text"] for x in replies)
    # 6. Pick a series -> pdf_missing fallback (no PDF uploaded)
    r = requests.post(f"{API}/bot/incoming", json={"phone": phone, "message": "1"}, timeout=15)
    replies = r.json()["replies"]
    assert len(replies) == 1
    assert replies[0]["type"] in ("text", "pdf")
    # 7. Returning customer with random text -> SILENT
    r = requests.post(f"{API}/bot/incoming", json={"phone": phone, "message": "hello again"}, timeout=15)
    assert r.json()["replies"] == []
    # 8. 'send pdf' restarts the menu
    r = requests.post(f"{API}/bot/incoming", json={"phone": phone, "message": "Send PDF"}, timeout=15)
    replies = r.json()["replies"]
    assert len(replies) == 1
    assert "1." in replies[0]["text"]
    # cleanup
    requests.post(f"{API}/bot/reset/{phone}", timeout=15)

# --- Leads ---
def test_leads_list_and_export():
    r = requests.get(f"{API}/leads", timeout=15)
    assert r.status_code == 200
    assert isinstance(r.json(), list)
    r2 = requests.get(f"{API}/leads", params={"q": "Surat"}, timeout=15)
    assert r2.status_code == 200
    re = requests.get(f"{API}/leads/export", timeout=20)
    assert re.status_code == 200
    assert "spreadsheet" in re.headers.get("content-type", "") or len(re.content) > 100

# --- Templates ---
def test_templates_list_and_update():
    r = requests.get(f"{API}/templates", timeout=15)
    assert r.status_code == 200
    items = r.json()
    assert len(items) == 9
    tid = items[0]["id"]
    original = items[0]["text"]
    u = requests.put(f"{API}/templates/{tid}", json={"text": "TEST_TEXT"}, timeout=15)
    assert u.status_code == 200
    rs = requests.post(f"{API}/templates/reset/{tid}", timeout=15)
    assert rs.status_code == 200
    items2 = requests.get(f"{API}/templates", timeout=15).json()
    new_text = next(t for t in items2 if t["id"] == tid)["text"]
    assert new_text == original

# --- Senders ---
def test_senders_crud():
    r = requests.get(f"{API}/senders", timeout=15)
    assert r.status_code == 200
    cr = requests.post(f"{API}/senders", json={"label": "TEST_Sender", "phone": "9000011111"}, timeout=15)
    assert cr.status_code == 200
    sid = cr.json()["id"]
    cn = requests.post(f"{API}/senders/{sid}/connect", timeout=15)
    assert cn.status_code == 200
    assert cn.json()["qr_simulated"] is True
    dl = requests.delete(f"{API}/senders/{sid}", timeout=15)
    assert dl.status_code == 200

# --- Broadcast ---
def test_broadcast_parse_paste():
    payload = {"text": "9999900002, John\n9999900003 Jane"}
    r = requests.post(f"{API}/broadcast/parse-paste", json=payload, timeout=15)
    assert r.status_code == 200
    contacts = r.json()["contacts"]
    assert len(contacts) == 2

def test_broadcast_start_and_cap():
    contacts = [{"phone": f"99999000{i:02d}", "name": f"User{i}"} for i in range(3)]
    r = requests.post(f"{API}/broadcast/start", json={"contacts": contacts, "message": "hi", "mode": "A"}, timeout=15)
    assert r.status_code == 200
    job_id = r.json()["id"]
    # poll
    time.sleep(5)
    poll = requests.get(f"{API}/broadcast/{job_id}", timeout=15)
    assert poll.status_code == 200
    # cap
    big = [{"phone": f"9000000{i:03d}", "name": "x"} for i in range(51)]
    rb = requests.post(f"{API}/broadcast/start", json={"contacts": big, "message": "hi", "mode": "A"}, timeout=15)
    assert rb.status_code == 400
