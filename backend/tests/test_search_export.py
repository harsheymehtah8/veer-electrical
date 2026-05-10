"""
Backend tests for global search across Contacts, Groups, Blast Templates,
plus xlsx export endpoints. Covers regression + edge cases (empty q,
special regex chars, unicode/Hindi).
"""
import os
import pytest
import requests

BASE_URL = os.environ['REACT_APP_BACKEND_URL'].rstrip('/')
API = f"{BASE_URL}/api"


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def seeded_templates(session):
    # Seed deterministic templates
    payloads = [
        {"name": "TEST_Diwali Offer 2026", "message": "Switches & cables flat 20% off"},
        {"name": "TEST_Cables Promo", "message": "Best wires this season", "attachment_name": "cables.pdf"},
        {"name": "TEST_Switches Combo", "message": "Modular switches at wholesale"},
        {"name": "TEST_Special+Char.Test", "message": "Plus and dot regex test"},
        {"name": "TEST_हिन्दी टेम्प्लेट", "message": "स्विच ऑफर"},
    ]
    created = []
    for p in payloads:
        r = session.post(f"{API}/blast-templates", json=p)
        assert r.status_code == 200, r.text
        created.append(r.json())
    yield created
    # cleanup
    for c in created:
        session.delete(f"{API}/blast-templates/{c['id']}")


@pytest.fixture(scope="module")
def seeded_contacts(session):
    payloads = [
        {"name": "TEST_Veer Trader", "shop_name": "TEST_Veer Hardware", "mobile": "9999900001", "city": "Surat", "state": "Gujarat"},
        {"name": "TEST_Acme", "shop_name": "TEST_Acme Electric", "mobile": "9999900002", "city": "Mumbai", "state": "Maharashtra"},
    ]
    created = []
    for p in payloads:
        r = session.post(f"{API}/contacts", json=p)
        assert r.status_code == 200, r.text
        created.append(r.json())
    yield created
    for c in created:
        cid = c.get("id")
        if cid:
            session.delete(f"{API}/contacts/{cid}")


@pytest.fixture(scope="module")
def seeded_groups(session):
    payloads = [
        {"name": "TEST_Surat Wholesalers"},
        {"name": "TEST_Mumbai Retailers"},
    ]
    created = []
    for p in payloads:
        r = session.post(f"{API}/groups", json=p)
        assert r.status_code == 200, r.text
        created.append(r.json())
    yield created
    for g in created:
        session.delete(f"{API}/groups/{g['id']}")


# ---------- Blast Templates search ----------
class TestBlastTemplatesSearch:
    def test_no_query_returns_all(self, session, seeded_templates):
        r = session.get(f"{API}/blast-templates")
        assert r.status_code == 200
        names = [t["name"] for t in r.json()]
        for t in seeded_templates:
            assert t["name"] in names

    def test_empty_query_returns_all(self, session, seeded_templates):
        r = session.get(f"{API}/blast-templates", params={"q": ""})
        assert r.status_code == 200
        # Empty string is falsy in backend (if q:) so should return all
        names = [t["name"] for t in r.json()]
        for t in seeded_templates:
            assert t["name"] in names

    def test_search_by_name(self, session, seeded_templates):
        r = session.get(f"{API}/blast-templates", params={"q": "diwali"})
        assert r.status_code == 200
        names = [t["name"] for t in r.json()]
        assert any("Diwali" in n for n in names)
        assert not any("Cables Promo" in n for n in names)

    def test_search_by_message(self, session, seeded_templates):
        r = session.get(f"{API}/blast-templates", params={"q": "wires"})
        assert r.status_code == 200
        names = [t["name"] for t in r.json()]
        assert any("Cables Promo" in n for n in names)

    def test_search_matches_name_or_message(self, session, seeded_templates):
        r = session.get(f"{API}/blast-templates", params={"q": "switches"})
        assert r.status_code == 200
        names = [t["name"] for t in r.json()]
        # Diwali message has "Switches" + Switches Combo name
        assert any("Switches Combo" in n for n in names)
        assert any("Diwali" in n for n in names)

    def test_search_by_attachment_name(self, session, seeded_templates):
        r = session.get(f"{API}/blast-templates", params={"q": "cables.pdf"})
        assert r.status_code == 200
        names = [t["name"] for t in r.json()]
        assert any("Cables Promo" in n for n in names)

    def test_special_regex_chars_escaped(self, session, seeded_templates):
        # '+' and '.' should be treated as literal (re.escape applied in backend)
        r = session.get(f"{API}/blast-templates", params={"q": "Special+Char.Test"})
        assert r.status_code == 200, r.text
        names = [t["name"] for t in r.json()]
        assert any("Special+Char.Test" in n for n in names)

    def test_unicode_hindi_search(self, session, seeded_templates):
        r = session.get(f"{API}/blast-templates", params={"q": "हिन्दी"})
        assert r.status_code == 200, r.text
        names = [t["name"] for t in r.json()]
        assert any("हिन्दी" in n for n in names)

    def test_no_match_returns_empty(self, session, seeded_templates):
        r = session.get(f"{API}/blast-templates", params={"q": "zzzz_nomatch_xyz"})
        assert r.status_code == 200
        assert r.json() == [] or all("zzzz_nomatch_xyz" in t["name"].lower() for t in r.json())


# ---------- Contacts search regression ----------
class TestContactsSearch:
    def test_search_by_name(self, session, seeded_contacts):
        r = session.get(f"{API}/contacts", params={"q": "Veer Trader"})
        assert r.status_code == 200
        data = r.json()
        assert "items" in data
        names = [c["name"] for c in data["items"]]
        assert any("Veer Trader" in n for n in names)

    def test_search_by_city(self, session, seeded_contacts):
        r = session.get(f"{API}/contacts", params={"q": "Surat"})
        assert r.status_code == 200
        cities = [c["city"] for c in r.json()["items"]]
        assert "Surat" in cities

    def test_search_by_mobile(self, session, seeded_contacts):
        r = session.get(f"{API}/contacts", params={"q": "9999900001"})
        assert r.status_code == 200
        mobiles = [c["mobile"] for c in r.json()["items"]]
        assert any("9999900001" in m for m in mobiles)

    def test_no_query_returns_paginated_list(self, session, seeded_contacts):
        r = session.get(f"{API}/contacts")
        assert r.status_code == 200
        assert "items" in r.json() and "total" in r.json()


# ---------- Groups search regression ----------
class TestGroupsSearch:
    def test_search_by_name(self, session, seeded_groups):
        r = session.get(f"{API}/groups", params={"q": "Surat"})
        assert r.status_code == 200
        names = [g["name"] for g in r.json()]
        assert any("Surat" in n for n in names)

    def test_no_query_returns_all(self, session, seeded_groups):
        r = session.get(f"{API}/groups")
        assert r.status_code == 200
        names = [g["name"] for g in r.json()]
        for g in seeded_groups:
            assert g["name"] in names


# ---------- Exports ----------
class TestExports:
    def test_contacts_export_xlsx(self, session, seeded_contacts):
        r = session.get(f"{API}/contacts/export")
        assert r.status_code == 200
        assert "spreadsheet" in r.headers.get("content-type", "")
        # xlsx magic = PK\x03\x04 (zip)
        assert r.content[:2] == b"PK"
        assert len(r.content) > 1000

    def test_leads_export_xlsx(self, session):
        r = session.get(f"{API}/leads/export")
        assert r.status_code == 200
        assert "spreadsheet" in r.headers.get("content-type", "")
        assert r.content[:2] == b"PK"
