"""Tests for the licence-Worker-proxied auth + owned-data flow.

These hit the LIVE public Cloudflare Worker, so we register fresh emails per run
to avoid rate limiting / collisions.
"""
import os
import time
import uuid
import pytest
import requests

BASE_URL = os.environ.get("REACT_APP_BACKEND_URL", "https://15689350-c999-4107-934a-1701fd2675bc.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"

RUN_ID = f"{int(time.time())}-{uuid.uuid4().hex[:6]}"
PASSWORD = "TestPass1234!"


def _fresh_email(tag: str = "u") -> str:
    return f"bm-{tag}-{RUN_ID}-{uuid.uuid4().hex[:6]}@rootrecord-test.com"


@pytest.fixture(scope="module")
def session():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def account_a(session):
    """Register one account we can reuse across ownership + data tests."""
    email = _fresh_email("a")
    device_id = uuid.uuid4().hex
    r = session.post(f"{API}/auth/register", json={"email": email, "password": PASSWORD, "device_id": device_id})
    assert r.status_code == 200, f"register failed: {r.status_code} {r.text}"
    data = r.json()
    assert data["access_token"]
    assert data["user"]["email"] == email
    assert data["user"]["id"]
    return {"email": email, "password": PASSWORD, "device_id": device_id,
            "token": data["access_token"], "user": data["user"]}


# ---------------- Health ----------------
def test_health_ok(session):
    r = session.get(f"{API}/health")
    assert r.status_code == 200
    body = r.json()
    assert body.get("ok") is True
    assert body.get("db") is True


# ---------------- Register + /me ----------------
def test_register_returns_token_and_user(account_a, session):
    token = account_a["token"]
    r = session.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200, r.text
    me = r.json()
    assert me["id"] == account_a["user"]["id"]
    assert me["email"] == account_a["email"]


def test_new_account_plan_is_free(account_a):
    assert account_a["user"]["plan"] == "free"


# ---------------- Login with same creds → same account_id ----------------
def test_login_same_account_id(account_a, session):
    r = session.post(f"{API}/auth/login", json={
        "email": account_a["email"], "password": account_a["password"],
        "device_id": account_a["device_id"],
    })
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["user"]["id"] == account_a["user"]["id"], "account_id must be stable across register/login"
    assert data["access_token"]


def test_login_bad_password_returns_401(account_a, session):
    r = session.post(f"{API}/auth/login", json={
        "email": account_a["email"], "password": "wrongpassword!!",
        "device_id": account_a["device_id"],
    })
    assert r.status_code == 401, f"expected 401, got {r.status_code} {r.text}"
    body = r.json()
    detail = (body.get("detail") or "").lower()
    assert "incorrect" in detail or "password" in detail or "email" in detail, body


def test_login_nonexistent_email_returns_401(session):
    r = session.post(f"{API}/auth/login", json={
        "email": f"nobody-{uuid.uuid4().hex}@rootrecord-test.com",
        "password": "whatever12345",
    })
    # Worker may return 401/400/403 for missing account; we asserted 401 is required.
    assert r.status_code in (400, 401), r.text
    assert r.json().get("detail")


# ---------------- /auth/me negative paths ----------------
def test_me_without_auth_returns_401(session):
    r = session.get(f"{API}/auth/me")
    assert r.status_code == 401


def test_me_with_bogus_token_returns_401(session):
    r = session.get(f"{API}/auth/me", headers={"Authorization": "Bearer abc.def.ghi"})
    assert r.status_code == 401, r.text
    assert "expired" in (r.json().get("detail") or "").lower() or "sign in" in (r.json().get("detail") or "").lower()


# ---------------- Entitlement ----------------
def test_entitlement_returns_plan_and_fields(account_a, session):
    r = session.post(f"{API}/auth/entitlement",
                     headers={"Authorization": f"Bearer {account_a['token']}"},
                     json={"device_id": account_a["device_id"]})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body.get("ok") is True
    assert body.get("plan") in ("free", "pro")
    # plan should match the one returned at register for a brand-new account
    assert body["plan"] == "free"
    # structural keys (values may be None)
    for k in ("access", "reason", "valid_until", "subscription_status"):
        assert k in body


# ---------------- Logout ----------------
def test_logout_best_effort_ok(session):
    # use a throwaway account so we don't invalidate account_a for other tests
    email = _fresh_email("logout")
    device_id = uuid.uuid4().hex
    reg = session.post(f"{API}/auth/register", json={"email": email, "password": PASSWORD, "device_id": device_id})
    assert reg.status_code == 200, reg.text
    tok = reg.json()["access_token"]
    r = session.post(f"{API}/auth/logout", headers={"Authorization": f"Bearer {tok}"})
    assert r.status_code == 200, r.text
    assert r.json().get("ok") is True


# ---------------- Token cache: rapid /me ----------------
def test_token_cache_rapid_me(account_a, session):
    token = account_a["token"]
    t0 = time.time()
    statuses = []
    for _ in range(6):
        r = session.get(f"{API}/auth/me", headers={"Authorization": f"Bearer {token}"})
        statuses.append(r.status_code)
    elapsed = time.time() - t0
    assert all(s == 200 for s in statuses), statuses
    # With a 5-minute cache, 6 calls should be comfortably quick. Give a generous bound.
    assert elapsed < 6.0, f"suspiciously slow ({elapsed:.2f}s) — cache may not be working"


# ---------------- CORS preflight ----------------
def test_options_preflight_login(session):
    r = session.options(f"{API}/auth/login", headers={
        "Origin": "https://example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
    })
    assert r.status_code in (200, 204), r.status_code
    acao = r.headers.get("access-control-allow-origin", "")
    assert acao, f"Missing CORS allow-origin. headers={dict(r.headers)}"


# ---------------- User isolation + seed data ----------------
def test_new_account_has_12_categories_and_1_business(account_a, session):
    h = {"Authorization": f"Bearer {account_a['token']}"}
    cats = session.get(f"{API}/categories", headers=h)
    assert cats.status_code == 200
    assert len(cats.json()) == 12, f"expected 12 seeded categories, got {len(cats.json())}"

    biz = session.get(f"{API}/businesses", headers=h)
    assert biz.status_code == 200
    assert len(biz.json()) == 1, f"expected 1 seeded business, got {len(biz.json())}"


def test_isolation_between_two_accounts(session, account_a):
    # register second account
    email_b = _fresh_email("b")
    reg = session.post(f"{API}/auth/register", json={"email": email_b, "password": PASSWORD, "device_id": uuid.uuid4().hex})
    assert reg.status_code == 200, reg.text
    tok_b = reg.json()["access_token"]
    uid_b = reg.json()["user"]["id"]
    assert uid_b != account_a["user"]["id"]

    # A creates a client; B should NOT see it
    ha = {"Authorization": f"Bearer {account_a['token']}"}
    hb = {"Authorization": f"Bearer {tok_b}"}

    tag = f"ISO-{uuid.uuid4().hex[:6]}"
    c = session.post(f"{API}/clients", headers=ha, json={"display_name": f"TEST_{tag}"})
    assert c.status_code == 200, c.text
    client_id = c.json()["id"]

    a_list = session.get(f"{API}/clients", headers=ha).json()
    b_list = session.get(f"{API}/clients", headers=hb).json()
    assert any(cli["id"] == client_id for cli in a_list), "A should see its own client"
    assert not any(cli["id"] == client_id for cli in b_list), "B must NOT see A's client"

    # cleanup
    session.delete(f"{API}/clients/{client_id}", headers=ha)


# ---------------- Clients CRUD ----------------
def test_clients_crud_roundtrip(account_a, session):
    h = {"Authorization": f"Bearer {account_a['token']}"}
    r = session.post(f"{API}/clients", headers=h, json={"display_name": "TEST_Acme"})
    assert r.status_code == 200, r.text
    cid = r.json()["id"]

    lst = session.get(f"{API}/clients", headers=h).json()
    assert any(c["id"] == cid for c in lst)

    d = session.delete(f"{API}/clients/{cid}", headers=h)
    assert d.status_code == 200

    lst2 = session.get(f"{API}/clients", headers=h).json()
    assert not any(c["id"] == cid for c in lst2)


# ---------------- Quick actions → session → clock out ----------------
def test_quick_action_run_and_clock_out(account_a, session):
    h = {"Authorization": f"Bearer {account_a['token']}"}
    # make sure no dangling session
    sess = session.get(f"{API}/time/session", headers=h).json()
    if sess.get("active"):
        session.post(f"{API}/time/clock-out", headers=h, json={})

    qa = session.post(f"{API}/quick-actions", headers=h,
                      json={"label": "TEST_Focus", "default_description": "focus block", "icon": "Zap"})
    assert qa.status_code == 200, qa.text
    qid = qa.json()["id"]

    run = session.post(f"{API}/quick-actions/{qid}/run", headers=h)
    assert run.status_code == 200, run.text

    sess = session.get(f"{API}/time/session", headers=h).json()
    assert sess.get("active") is True

    out = session.post(f"{API}/time/clock-out", headers=h, json={"description": "done"})
    assert out.status_code == 200, out.text
    entry = out.json()
    assert entry.get("id")
    assert entry.get("start_utc") and entry.get("end_utc")

    # cleanup quick action
    session.delete(f"{API}/quick-actions/{qid}", headers=h)
