"""RootRecord Business Manager — Mobile API backend tests.

Covers the full review-request checklist: auth, categories, projects, time,
money, clients/invoices, debts/funds/scheduled/resources, stock, schedule,
businesses, settings, feedback, dashboard summary, health, auth isolation
and CORS.
"""

import os
import uuid
import time
import requests
import pytest

BASE = os.environ.get("REACT_APP_BACKEND_URL",
                      "https://15689350-c999-4107-934a-1701fd2675bc.preview.emergentagent.com").rstrip("/")
API = f"{BASE}/api"

ADMIN_EMAIL = "admin@rootrecord.app"
ADMIN_PASSWORD = "admin123"


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(f"{API}/auth/login",
                      json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=30)
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    data = r.json()
    assert "access_token" in data and data["user"]["email"] == ADMIN_EMAIL
    return data["access_token"]


@pytest.fixture(scope="session")
def admin_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="session")
def user2():
    """Separate user for isolation check."""
    email = f"TEST_user2_{uuid.uuid4().hex[:8]}@rootrecord.app"
    r = requests.post(f"{API}/auth/register",
                      json={"email": email, "password": "passw0rd123", "name": "User Two"}, timeout=30)
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text}"
    data = r.json()
    return {"email": email, "token": data["access_token"], "id": data["user"]["id"]}


@pytest.fixture(scope="session")
def user2_headers(user2):
    return {"Authorization": f"Bearer {user2['token']}", "Content-Type": "application/json"}


# ---------------------------------------------------------------------------
# Health + CORS
# ---------------------------------------------------------------------------

class TestHealth:
    def test_health(self):
        r = requests.get(f"{API}/health", timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert data["ok"] is True and data["db"] is True

    def test_cors_preflight(self):
        r = requests.options(f"{API}/auth/login", headers={
            "Origin": "https://example.com",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Content-Type",
        }, timeout=15)
        assert r.status_code in (200, 204), f"preflight failed: {r.status_code}"
        # allow_origins=* should echo '*' (allow_credentials=False)
        assert r.headers.get("access-control-allow-origin") == "*"


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class TestAuth:
    def test_login_admin(self, admin_token):
        assert isinstance(admin_token, str) and len(admin_token) > 20

    def test_login_bad_password(self):
        r = requests.post(f"{API}/auth/login",
                          json={"email": ADMIN_EMAIL, "password": "wrongpassword"}, timeout=15)
        assert r.status_code == 401

    def test_me_bearer(self, admin_headers):
        r = requests.get(f"{API}/auth/me", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert data["email"] == ADMIN_EMAIL
        assert data["plan"] == "pro"
        assert data["role"] == "admin"

    def test_no_auth_returns_401(self):
        r = requests.get(f"{API}/auth/me", timeout=15)
        assert r.status_code == 401

    def test_bogus_token_returns_401(self):
        r = requests.get(f"{API}/auth/me",
                         headers={"Authorization": "Bearer not-a-valid-jwt"}, timeout=15)
        assert r.status_code == 401

    def test_register_and_me(self):
        email = f"TEST_reg_{uuid.uuid4().hex[:8]}@rootrecord.app"
        r = requests.post(f"{API}/auth/register",
                          json={"email": email, "password": "hunter22", "name": "Reg User"}, timeout=15)
        assert r.status_code == 200
        data = r.json()
        # Backend lowercases emails on register (by design)
        assert data["user"]["email"] == email.lower()
        assert data["user"]["plan"] == "free"
        token = data["access_token"]
        me = requests.get(f"{API}/auth/me",
                          headers={"Authorization": f"Bearer {token}"}, timeout=15)
        assert me.status_code == 200
        assert me.json()["email"] == email.lower()

    def test_upgrade_pro(self):
        email = f"TEST_upg_{uuid.uuid4().hex[:8]}@rootrecord.app"
        r = requests.post(f"{API}/auth/register",
                          json={"email": email, "password": "hunter22"}, timeout=15)
        token = r.json()["access_token"]
        headers = {"Authorization": f"Bearer {token}"}
        up = requests.post(f"{API}/auth/upgrade-pro", headers=headers, timeout=15)
        assert up.status_code == 200
        assert up.json()["plan"] == "pro"
        me = requests.get(f"{API}/auth/me", headers=headers, timeout=15).json()
        assert me["plan"] == "pro"


# ---------------------------------------------------------------------------
# Categories + Projects
# ---------------------------------------------------------------------------

class TestCategoriesProjects:
    def test_default_categories_sorted(self, admin_headers):
        r = requests.get(f"{API}/categories", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        cats = r.json()
        assert len(cats) >= 12
        # Sorted by sort_order → first is 'Coding'
        assert cats[0]["name"] == "Coding"
        orders = [c.get("sort_order", 0) for c in cats[:12]]
        assert orders == sorted(orders)

    def test_project_crud(self, admin_headers):
        payload = {"name": "TEST_Proj", "client_name": "ACME", "color": "#2B8A8F"}
        r = requests.post(f"{API}/projects", headers=admin_headers, json=payload, timeout=15)
        assert r.status_code == 200
        pid = r.json()["id"]

        r = requests.get(f"{API}/projects", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        assert any(p["id"] == pid for p in r.json())

        r = requests.delete(f"{API}/projects/{pid}", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        # Verify removed
        r = requests.get(f"{API}/projects", headers=admin_headers, timeout=15)
        assert not any(p["id"] == pid for p in r.json())


# ---------------------------------------------------------------------------
# Time tracking
# ---------------------------------------------------------------------------

class TestTime:
    def test_clock_flow(self, admin_headers):
        # clean any stuck session
        sess = requests.get(f"{API}/time/session", headers=admin_headers, timeout=15).json()
        if sess.get("active"):
            requests.post(f"{API}/time/clock-out", headers=admin_headers, json={"description": ""}, timeout=15)

        r = requests.post(f"{API}/time/clock-in", headers=admin_headers,
                          json={"description": "TEST_ci"}, timeout=15)
        assert r.status_code == 200
        s = requests.get(f"{API}/time/session", headers=admin_headers, timeout=15).json()
        assert s.get("active") is True

        time.sleep(1)
        r = requests.post(f"{API}/time/clock-out", headers=admin_headers,
                          json={"description": "TEST_done"}, timeout=15)
        assert r.status_code == 200
        entry = r.json()
        assert entry["description"] == "TEST_done"
        tid = entry["id"]

        r = requests.get(f"{API}/time/entries", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        assert any(e["id"] == tid for e in r.json())

        r = requests.patch(f"{API}/time/entries/{tid}", headers=admin_headers,
                           json={"description": "TEST_patched"}, timeout=15)
        assert r.status_code == 200
        assert r.json()["description"] == "TEST_patched"

        r = requests.delete(f"{API}/time/entries/{tid}", headers=admin_headers, timeout=15)
        assert r.status_code == 200

        # session cleared
        s = requests.get(f"{API}/time/session", headers=admin_headers, timeout=15).json()
        assert not s.get("active")

    def test_manual_time(self, admin_headers):
        payload = {
            "start_utc": "2026-01-05T10:00:00Z",
            "end_utc": "2026-01-05T11:30:00Z",
            "description": "TEST_manual",
        }
        r = requests.post(f"{API}/time/manual", headers=admin_headers, json=payload, timeout=15)
        assert r.status_code == 200
        mid = r.json()["id"]
        r = requests.get(f"{API}/time/entries", headers=admin_headers, timeout=15)
        assert any(e["id"] == mid and e.get("source") == "manual" for e in r.json())
        requests.delete(f"{API}/time/entries/{mid}", headers=admin_headers, timeout=15)


# ---------------------------------------------------------------------------
# Money: income + expense
# ---------------------------------------------------------------------------

class TestMoney:
    def test_income(self, admin_headers):
        r = requests.post(f"{API}/money/income", headers=admin_headers,
                          json={"amount_cents": 15000, "description": "TEST_inc"}, timeout=15)
        assert r.status_code == 200
        iid = r.json()["id"]
        lst = requests.get(f"{API}/money/income", headers=admin_headers, timeout=15).json()
        assert any(x["id"] == iid for x in lst)
        assert requests.delete(f"{API}/money/income/{iid}",
                               headers=admin_headers, timeout=15).status_code == 200

    def test_expense(self, admin_headers):
        r = requests.post(f"{API}/money/expenses", headers=admin_headers,
                          json={"amount_cents": 2500, "description": "TEST_exp", "funding": "cash"}, timeout=15)
        assert r.status_code == 200
        eid = r.json()["id"]
        lst = requests.get(f"{API}/money/expenses", headers=admin_headers, timeout=15).json()
        assert any(x["id"] == eid for x in lst)
        assert requests.delete(f"{API}/money/expenses/{eid}",
                               headers=admin_headers, timeout=15).status_code == 200


# ---------------------------------------------------------------------------
# Clients + Invoices
# ---------------------------------------------------------------------------

class TestClientsInvoices:
    def test_client_and_invoice_math(self, admin_headers):
        r = requests.post(f"{API}/clients", headers=admin_headers,
                          json={"display_name": "TEST_Client", "company": "ACME Co"}, timeout=15)
        assert r.status_code == 200
        cid = r.json()["id"]

        inv_payload = {
            "client_id": cid,
            "invoice_number": f"TEST-{uuid.uuid4().hex[:6]}",
            "lines": [
                {"description": "Design", "quantity": 2, "unit_price_cents": 5000},   # 10000
                {"description": "Dev", "quantity": 3, "unit_price_cents": 7500},      # 22500
            ],
        }
        r = requests.post(f"{API}/invoices", headers=admin_headers, json=inv_payload, timeout=15)
        assert r.status_code == 200, r.text
        inv = r.json()
        assert inv["subtotal_cents"] == 32500
        assert inv["total_cents"] == 32500
        iid = inv["id"]

        requests.delete(f"{API}/invoices/{iid}", headers=admin_headers, timeout=15)
        requests.delete(f"{API}/clients/{cid}", headers=admin_headers, timeout=15)


# ---------------------------------------------------------------------------
# Debts / Funds / Scheduled / Resources
# ---------------------------------------------------------------------------

class TestFinanceExtras:
    @pytest.mark.parametrize("endpoint,payload", [
        ("debts", {"amount_cents": 5000, "creditor": "Bank", "description": "TEST_d"}),
        ("funds", {"account_name": "TEST_cash", "account_type": "cash", "current_balance_cents": 10000}),
        ("scheduled-expenses", {"description": "TEST_sub", "amount_cents": 999,
                                "frequency": "monthly", "next_due_utc": "2026-02-01T00:00:00Z"}),
        ("resources", {"amount_cents": 10000, "source_type": "owner_contribution", "description": "TEST_res"}),
    ])
    def test_create_list_delete(self, admin_headers, endpoint, payload):
        r = requests.post(f"{API}/{endpoint}", headers=admin_headers, json=payload, timeout=15)
        assert r.status_code == 200, f"{endpoint} create failed: {r.status_code} {r.text}"
        item_id = r.json()["id"]
        lst = requests.get(f"{API}/{endpoint}", headers=admin_headers, timeout=15).json()
        assert any(x["id"] == item_id for x in lst)
        r = requests.delete(f"{API}/{endpoint}/{item_id}", headers=admin_headers, timeout=15)
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# Stock & supplies
# ---------------------------------------------------------------------------

class TestStock:
    def test_product_and_supply(self, admin_headers):
        r = requests.post(f"{API}/products", headers=admin_headers,
                          json={"name": "TEST_Product", "qty_on_hand": 5}, timeout=15)
        assert r.status_code == 200
        pid = r.json()["id"]
        assert any(p["id"] == pid for p in
                   requests.get(f"{API}/products", headers=admin_headers, timeout=15).json())
        requests.delete(f"{API}/products/{pid}", headers=admin_headers, timeout=15)

        r = requests.post(f"{API}/supplies", headers=admin_headers,
                          json={"name": "TEST_Supply", "vendor": "Costco"}, timeout=15)
        assert r.status_code == 200
        sid = r.json()["id"]
        assert any(s["id"] == sid for s in
                   requests.get(f"{API}/supplies", headers=admin_headers, timeout=15).json())
        requests.delete(f"{API}/supplies/{sid}", headers=admin_headers, timeout=15)


# ---------------------------------------------------------------------------
# Schedule
# ---------------------------------------------------------------------------

class TestSchedule:
    def test_schedule_create_list(self, admin_headers):
        r = requests.post(f"{API}/schedule", headers=admin_headers,
                          json={"title": "TEST_meeting", "starts_at_utc": "2026-01-10T12:00:00Z"}, timeout=15)
        assert r.status_code == 200
        sid = r.json()["id"]
        lst = requests.get(f"{API}/schedule", headers=admin_headers, timeout=15).json()
        assert any(x["id"] == sid for x in lst)
        requests.delete(f"{API}/schedule/{sid}", headers=admin_headers, timeout=15)


# ---------------------------------------------------------------------------
# Businesses + Settings + Feedback
# ---------------------------------------------------------------------------

class TestBusinessAndSettings:
    def test_auto_seeded_business(self, admin_headers):
        r = requests.get(f"{API}/businesses", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert len(data) >= 1
        default = next((b for b in data if b.get("is_default")), data[0])
        # Update it
        bid = default["id"]
        r = requests.patch(f"{API}/businesses/{bid}", headers=admin_headers,
                           json={"name": "RootRecord HQ", "timezone": "UTC"}, timeout=15)
        assert r.status_code == 200
        assert r.json()["name"] == "RootRecord HQ"

    def test_settings_get_patch(self, admin_headers):
        r = requests.get(f"{API}/settings", headers=admin_headers, timeout=15)
        assert r.status_code == 200
        assert r.json()["currency_default"] in ("USD", None) or isinstance(r.json(), dict)
        r = requests.patch(f"{API}/settings", headers=admin_headers,
                           json={"currency_default": "EUR", "theme": "dark"}, timeout=15)
        assert r.status_code == 200
        assert r.json()["currency_default"] == "EUR"
        # revert
        requests.patch(f"{API}/settings", headers=admin_headers,
                       json={"currency_default": "USD"}, timeout=15)

    def test_feedback(self, admin_headers):
        r = requests.post(f"{API}/feedback", headers=admin_headers,
                          json={"type": "bug", "message": "TEST_feedback"}, timeout=15)
        assert r.status_code == 200
        assert r.json()["message"] == "TEST_feedback"


# ---------------------------------------------------------------------------
# Dashboard summary
# ---------------------------------------------------------------------------

class TestDashboard:
    def test_summary(self, admin_headers):
        # seed a time entry + income + expense in window
        time_payload = {
            "start_utc": "2026-01-02T09:00:00Z",
            "end_utc": "2026-01-02T11:00:00Z",
            "description": "TEST_ds",
        }
        t = requests.post(f"{API}/time/manual", headers=admin_headers, json=time_payload, timeout=15).json()
        inc = requests.post(f"{API}/money/income", headers=admin_headers,
                            json={"amount_cents": 20000, "description": "TEST_ds",
                                  "received_at_utc": "2026-01-02T10:00:00Z"}, timeout=15).json()
        exp = requests.post(f"{API}/money/expenses", headers=admin_headers,
                            json={"amount_cents": 5000, "description": "TEST_ds",
                                  "spent_at_utc": "2026-01-02T10:00:00Z"}, timeout=15).json()

        r = requests.get(f"{API}/dashboard/summary",
                         params={"start": "2026-01-01T00:00:00Z", "end": "2026-01-31T23:59:59Z"},
                         headers=admin_headers, timeout=20)
        assert r.status_code == 200
        data = r.json()
        assert data["hours"] >= 2.0
        assert data["income_cents"] >= 20000
        assert data["expense_cents"] >= 5000
        assert data["net_cents"] == data["income_cents"] - data["expense_cents"]
        assert isinstance(data["breakdown"], list)
        for item in data["breakdown"]:
            assert "name" in item and "color" in item and "hours" in item

        # cleanup
        requests.delete(f"{API}/time/entries/{t['id']}", headers=admin_headers, timeout=15)
        requests.delete(f"{API}/money/income/{inc['id']}", headers=admin_headers, timeout=15)
        requests.delete(f"{API}/money/expenses/{exp['id']}", headers=admin_headers, timeout=15)


# ---------------------------------------------------------------------------
# Auth isolation
# ---------------------------------------------------------------------------

class TestIsolation:
    def test_user2_cannot_see_admin_data(self, admin_headers, user2_headers):
        # admin creates a client
        r = requests.post(f"{API}/clients", headers=admin_headers,
                          json={"display_name": "TEST_AdminOnly"}, timeout=15)
        admin_client_id = r.json()["id"]
        try:
            # user2's list
            r = requests.get(f"{API}/clients", headers=user2_headers, timeout=15)
            assert r.status_code == 200
            assert not any(c["id"] == admin_client_id for c in r.json())

            # user2's categories are their own default seed
            cats = requests.get(f"{API}/categories", headers=user2_headers, timeout=15).json()
            assert len(cats) >= 12
            assert cats[0]["name"] == "Coding"

            # user2 cannot delete admin's client
            r = requests.delete(f"{API}/clients/{admin_client_id}",
                                headers=user2_headers, timeout=15)
            assert r.status_code == 404
        finally:
            requests.delete(f"{API}/clients/{admin_client_id}", headers=admin_headers, timeout=15)
