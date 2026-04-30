"""RootRecord Business Manager — Mobile API.

Local-first parity with the desktop Electron + SQLite app: time, money, clients,
inventory, scheduling. Auth proxies to the RootRecord licence Worker so the same
email/password used by the Windows desktop app works on mobile.
"""

from dotenv import load_dotenv
load_dotenv()

import os
import time
import uuid
from datetime import datetime, timezone
from typing import Optional, List, Any

import httpx
from fastapi import FastAPI, HTTPException, Depends, Request, APIRouter
from fastapi.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, EmailStr, Field

# ---------------------------------------------------------------------------
# Config + DB
# ---------------------------------------------------------------------------

MONGO_URL = os.environ["MONGO_URL"]
DB_NAME = os.environ["DB_NAME"]
LICENSE_API_BASE_URL = os.environ.get("LICENSE_API_BASE_URL", "").rstrip("/")
LOCAL_AUTH_FALLBACK = LICENSE_API_BASE_URL in ("", "local")

client = AsyncIOMotorClient(MONGO_URL)
db = client[DB_NAME]

app = FastAPI(title="RootRecord Business Manager — Mobile API", version="0.2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api")

# In-memory cache of validated bearer tokens to avoid hammering the Worker on every API call.
# Stores token -> (account_id, email, expires_at_epoch).
_TOKEN_CACHE: dict = {}
_TOKEN_TTL_SEC = 300  # 5 minutes

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

def new_id() -> str:
    return uuid.uuid4().hex

# ---------------------------------------------------------------------------
# Licence Worker proxy (RootRecord licence service)
# ---------------------------------------------------------------------------
# Worker base: https://rootrecord-license.rootrecord.workers.dev
# Endpoints used: /v1/auth/login, /v1/auth/signup, /v1/auth/logout, /v1/me, /v1/entitlement
# Mirrors the desktop app's licenseService.js HTTP contract.

async def _worker_post(path: str, body: dict, bearer: Optional[str] = None) -> tuple[int, dict]:
    if not LICENSE_API_BASE_URL:
        raise HTTPException(status_code=503, detail="Online sign-in is not configured.")
    headers = {"Content-Type": "application/json"}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
    url = f"{LICENSE_API_BASE_URL}{path}"
    async with httpx.AsyncClient(timeout=httpx.Timeout(35.0)) as cx:
        try:
            r = await cx.post(url, json=body, headers=headers)
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"Licence service unreachable: {e}")
    return _normalize_worker_response(r)

async def _worker_get(path: str, bearer: str) -> tuple[int, dict]:
    if not LICENSE_API_BASE_URL:
        raise HTTPException(status_code=503, detail="Online sign-in is not configured.")
    url = f"{LICENSE_API_BASE_URL}{path}"
    async with httpx.AsyncClient(timeout=httpx.Timeout(22.0)) as cx:
        try:
            r = await cx.get(url, headers={"Authorization": f"Bearer {bearer}"})
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"Licence service unreachable: {e}")
    return _normalize_worker_response(r)

def _normalize_worker_response(r) -> tuple[int, dict]:
    """Parse a Worker response into (status, json-ish dict). When the Worker returns
    HTML (e.g. Cloudflare error 1101/1102), surface a short message instead of the
    raw 4KB HTML page."""
    ctype = (r.headers.get("content-type") or "").lower()
    text = r.text or ""
    if "application/json" in ctype:
        try:
            return r.status_code, r.json()
        except Exception:
            pass
    looks_like_html = "<html" in text.lower() or "<!doctype" in text.lower()
    if looks_like_html or not text.strip():
        # Log full HTML server-side for forensics; user gets the short message.
        try:
            print(f"[licence-worker] non-JSON {r.status_code} response from {r.request.url}: {text[:512]}")
        except Exception:
            pass
        msg = "Sign-in service is temporarily unavailable — try again in a moment."
        if r.status_code == 429:
            msg = "Too many sign-in attempts — try again in a minute."
        return r.status_code, {"detail": msg}
    # Non-HTML, non-JSON (e.g. plain text). Cap to keep responses sane.
    return r.status_code, {"detail": (text.strip()[:300] or f"HTTP {r.status_code}")}

def _worker_error(status: int, body: dict) -> str:
    if isinstance(body, dict):
        for k in ("detail", "message", "error"):
            v = body.get(k)
            if isinstance(v, str) and v:
                return v
            if isinstance(v, dict):
                m = v.get("message") or v.get("code") or v.get("detail")
                if m:
                    return str(m)
    return f"Licence service returned HTTP {status}."

def _plan_from_entitlement(ent: dict) -> str:
    """access=full + reason=paid → pro; otherwise free."""
    access = str(ent.get("access") or "").lower()
    reason = str(ent.get("reason") or "").lower()
    sub = str(ent.get("subscription_status") or "").lower()
    if access == "full" and (reason == "paid" or sub == "active"):
        return "pro"
    return "free"

async def _ensure_user_seeded(account_id: str, email: str) -> dict:
    """Create a local mirror of the licence account so we can scope owned data."""
    u = await db.users.find_one({"id": account_id}, {"_id": 0})
    if u:
        # keep email + last_seen current
        await db.users.update_one(
            {"id": account_id},
            {"$set": {"email": email, "last_seen": now_iso()}},
        )
        u = await db.users.find_one({"id": account_id}, {"_id": 0})
        # First-run safety: if for any reason this account has no business, seed it.
        if await db.businesses.count_documents({"user_id": account_id}) == 0:
            await _seed_default_business(account_id)
        return u
    doc = {
        "id": account_id,
        "email": email,
        "name": email.split("@")[0],
        "role": "user",
        "plan": "free",
        "created_at": now_iso(),
        "last_seen": now_iso(),
    }
    await db.users.insert_one(dict(doc))
    await _seed_default_business(account_id)
    return doc

async def _validate_token(token: str) -> dict:
    """Validate via Worker /v1/me with a 5-minute in-memory cache."""
    cached = _TOKEN_CACHE.get(token)
    if cached and cached[2] > time.time():
        account_id, email, _ = cached
        return {"id": account_id, "email": email}
    status, body = await _worker_get("/v1/me", token)
    if status == 401:
        _TOKEN_CACHE.pop(token, None)
        raise HTTPException(status_code=401, detail="Session expired. Sign in again.")
    if status >= 400:
        raise HTTPException(status_code=502, detail=_worker_error(status, body))
    account_id = str(body.get("account_id") or "")
    email = str(body.get("email") or "").lower()
    if not account_id:
        raise HTTPException(status_code=502, detail="Licence service returned no account_id.")
    _TOKEN_CACHE[token] = (account_id, email, time.time() + _TOKEN_TTL_SEC)
    return {"id": account_id, "email": email, "subscription_status": body.get("subscription_status"), "has_password": body.get("has_password")}

async def get_current_user(request: Request) -> dict:
    auth = request.headers.get("Authorization", "")
    token = ""
    if auth.startswith("Bearer "):
        token = auth[7:].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    info = await _validate_token(token)
    user = await _ensure_user_seeded(info["id"], info["email"])
    user["_token"] = token  # available for endpoints that need to forward the bearer
    return user

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class RegisterIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    name: Optional[str] = None
    device_id: Optional[str] = None

class LoginIn(BaseModel):
    email: EmailStr
    password: str
    device_id: Optional[str] = None

class UserOut(BaseModel):
    id: str
    email: str
    name: str = ""
    plan: str = "free"  # free | pro
    role: str = "user"
    created_at: str
    subscription_status: Optional[str] = None
    valid_until: Optional[str] = None

class AuthOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut

def _device_id(value: Optional[str]) -> str:
    v = (value or "").strip()
    return v if len(v) >= 8 else str(uuid.uuid4())

@api.post("/auth/login", response_model=AuthOut)
async def login(body: LoginIn):
    """Proxies to the RootRecord licence Worker so the same email/password used by the
    Windows desktop installer works on mobile."""
    email = body.email.lower().strip()
    device_id = _device_id(body.device_id)
    status, body_resp = await _worker_post("/v1/auth/login", {
        "email": email, "password": body.password, "device_id": device_id,
    })
    if status >= 400:
        # Map worker error strings into the messages the desktop app uses.
        msg = _worker_error(status, body_resp)
        passthrough = {400, 401, 403, 409, 422, 429}
        raise HTTPException(status_code=status if status in passthrough else 502, detail=msg)
    token = str(body_resp.get("access_token") or "").strip()
    if not token:
        raise HTTPException(status_code=502, detail="Licence service did not return a token.")
    # Resolve user identity
    me_status, me_body = await _worker_get("/v1/me", token)
    if me_status >= 400:
        raise HTTPException(status_code=me_status, detail=_worker_error(me_status, me_body))
    account_id = str(me_body.get("account_id") or body_resp.get("account_id") or "")
    if not account_id:
        raise HTTPException(status_code=502, detail="Licence service returned no account_id.")
    u = await _ensure_user_seeded(account_id, email)
    plan = _plan_from_entitlement(body_resp)
    if plan != u.get("plan"):
        await db.users.update_one({"id": account_id}, {"$set": {"plan": plan}})
        u["plan"] = plan
    _TOKEN_CACHE[token] = (account_id, email, time.time() + _TOKEN_TTL_SEC)
    return AuthOut(
        access_token=token,
        user=UserOut(
            id=account_id,
            email=email,
            name=u.get("name", email.split("@")[0]),
            plan=plan,
            role=u.get("role", "user"),
            created_at=u.get("created_at", now_iso()),
            subscription_status=me_body.get("subscription_status") or body_resp.get("subscription_status"),
            valid_until=body_resp.get("valid_until"),
        ),
    )

@api.post("/auth/register", response_model=AuthOut)
async def register(body: RegisterIn):
    """Proxies to the licence Worker /v1/auth/signup."""
    email = body.email.lower().strip()
    device_id = _device_id(body.device_id)
    status, body_resp = await _worker_post("/v1/auth/signup", {
        "email": email, "password": body.password, "device_id": device_id,
    })
    if status >= 400:
        msg = _worker_error(status, body_resp)
        passthrough = {400, 401, 403, 409, 422, 429}
        raise HTTPException(status_code=status if status in passthrough else 502, detail=msg)
    token = str(body_resp.get("access_token") or "").strip()
    if not token:
        raise HTTPException(status_code=502, detail="Licence service did not return a token.")
    me_status, me_body = await _worker_get("/v1/me", token)
    if me_status >= 400:
        raise HTTPException(status_code=me_status, detail=_worker_error(me_status, me_body))
    account_id = str(me_body.get("account_id") or body_resp.get("account_id") or "")
    if not account_id:
        raise HTTPException(status_code=502, detail="Licence service returned no account_id.")
    u = await _ensure_user_seeded(account_id, email)
    if body.name:
        await db.users.update_one({"id": account_id}, {"$set": {"name": body.name}})
        u["name"] = body.name
    plan = _plan_from_entitlement(body_resp)
    _TOKEN_CACHE[token] = (account_id, email, time.time() + _TOKEN_TTL_SEC)
    return AuthOut(
        access_token=token,
        user=UserOut(
            id=account_id, email=email, name=u.get("name", email.split("@")[0]),
            plan=plan, role=u.get("role", "user"),
            created_at=u.get("created_at", now_iso()),
            subscription_status=me_body.get("subscription_status"),
            valid_until=body_resp.get("valid_until"),
        ),
    )

@api.get("/auth/me", response_model=UserOut)
async def me(current=Depends(get_current_user)):
    return UserOut(
        id=current["id"], email=current["email"], name=current.get("name", ""),
        plan=current.get("plan", "free"), role=current.get("role", "user"),
        created_at=current.get("created_at", now_iso()),
        subscription_status=current.get("subscription_status"),
    )

@api.post("/auth/logout")
async def logout(current=Depends(get_current_user)):
    token = current.get("_token", "")
    _TOKEN_CACHE.pop(token, None)
    if token and LICENSE_API_BASE_URL:
        try:
            await _worker_post("/v1/auth/logout", {}, bearer=token)
        except Exception:
            pass  # best effort
    return {"ok": True}

class EntitlementIn(BaseModel):
    device_id: Optional[str] = None

@api.post("/auth/entitlement")
async def refresh_entitlement(body: EntitlementIn, current=Depends(get_current_user)):
    """Force a fresh entitlement check against the licence Worker.
    Mirrors desktop's `licensePrepare({forceRefresh: true})` from licenseService.js."""
    token = current.get("_token", "")
    device_id = _device_id(body.device_id)
    status, body_resp = await _worker_post("/v1/entitlement", {
        "email": current["email"], "device_id": device_id,
    }, bearer=token)
    if status >= 400:
        passthrough = {400, 401, 403, 422, 429}
        raise HTTPException(status_code=status if status in passthrough else 502, detail=_worker_error(status, body_resp))
    plan = _plan_from_entitlement(body_resp)
    await db.users.update_one(
        {"id": current["id"]},
        {"$set": {"plan": plan, "last_entitlement_check_utc": now_iso()}},
    )
    return {
        "ok": True,
        "plan": plan,
        "access": body_resp.get("access"),
        "reason": body_resp.get("reason"),
        "valid_until": body_resp.get("valid_until"),
        "subscription_status": body_resp.get("subscription_status"),
    }

# ---------------------------------------------------------------------------
# Generic CRUD factory for owned collections
# ---------------------------------------------------------------------------

OWNED_COLLECTIONS = {
    "categories": "Work categories (time/expense)",
    "projects": "Projects",
    "clients": "Clients",
    "invoices": "Invoices",
    "products": "Stock products",
    "supplies": "Internal supplies",
    "businesses": "Business profiles",
    "schedule_events": "Schedule & bookings",
    "debts": "Debts",
    "scheduled_expenses": "Scheduled (recurring) expenses",
    "resources": "Owner resources / contributions",
    "funds": "Available funds accounts",
    "feedback": "Feedback queue",
}

class IdOnly(BaseModel):
    id: str

def _strip(d: dict) -> dict:
    if "_id" in d:
        d.pop("_id")
    return d

async def _list(coll: str, user_id: str, extra: Optional[dict] = None) -> List[dict]:
    q = {"user_id": user_id}
    if extra:
        q.update(extra)
    cursor = db[coll].find(q, {"_id": 0}).sort("created_at", -1)
    return [d async for d in cursor]

async def _create(coll: str, user_id: str, data: dict) -> dict:
    doc = {**data, "id": new_id(), "user_id": user_id, "created_at": now_iso(), "updated_at": now_iso()}
    await db[coll].insert_one(doc)
    return _strip(dict(doc))

async def _update(coll: str, user_id: str, item_id: str, data: dict) -> dict:
    data = {**data, "updated_at": now_iso()}
    res = await db[coll].update_one({"id": item_id, "user_id": user_id}, {"$set": data})
    if res.matched_count == 0:
        raise HTTPException(status_code=404, detail=f"{coll} not found")
    doc = await db[coll].find_one({"id": item_id, "user_id": user_id}, {"_id": 0})
    return doc

async def _delete(coll: str, user_id: str, item_id: str) -> None:
    res = await db[coll].delete_one({"id": item_id, "user_id": user_id})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail=f"{coll} not found")

# ---------------------------------------------------------------------------
# Categories & Projects (used everywhere)
# ---------------------------------------------------------------------------

DEFAULT_CATEGORIES = [
    {"name": "Coding", "color": "#2B8A8F", "kind": "time"},
    {"name": "Development", "color": "#06B6D4", "kind": "time"},
    {"name": "Marketing", "color": "#F59E0B", "kind": "time"},
    {"name": "Research", "color": "#6366F1", "kind": "time"},
    {"name": "Evaluation", "color": "#8B5CF6", "kind": "time"},
    {"name": "Design", "color": "#EC4899", "kind": "time"},
    {"name": "Testing", "color": "#A855F7", "kind": "time"},
    {"name": "Admin", "color": "#F43F5E", "kind": "time"},
    {"name": "Analytics", "color": "#10B981", "kind": "time"},
    {"name": "Operations", "color": "#EAB308", "kind": "time"},
    {"name": "Meetings", "color": "#14B8A6", "kind": "time"},
    {"name": "Break", "color": "#687777", "kind": "time"},
]

async def _seed_default_business(user_id: str):
    existing = await db.businesses.find_one({"user_id": user_id})
    if not existing:
        await db.businesses.insert_one({
            "id": new_id(), "user_id": user_id, "name": "My Business",
            "legal_name": "", "owner": "", "tax_id": "", "email": "",
            "phone": "", "website": "", "address": "", "timezone": "system",
            "invoice_notes": "", "is_default": True,
            "created_at": now_iso(), "updated_at": now_iso(),
        })
    if await db.categories.count_documents({"user_id": user_id}) == 0:
        await db.categories.insert_many([
            {**c, "id": new_id(), "user_id": user_id, "billable": 1,
             "default_hourly_cents": None, "sort_order": i, "archived": 0,
             "created_at": now_iso(), "updated_at": now_iso()}
            for i, c in enumerate(DEFAULT_CATEGORIES)
        ])
    if await db.settings.find_one({"user_id": user_id}) is None:
        await db.settings.insert_one({
            "user_id": user_id,
            "currency_default": "USD",
            "theme": "dark",
            "prompt_interval_sec": 900,
            "prompt_first_delay_sec": 120,
            "prompt_response_timeout_sec": 45,
            "default_hourly_cents": 0,
            "show_money_in_dashboard": True,
            "help_bubbles_enabled": True,
            "business_timezone": "system",
            "active_business_id": None,
            "updated_at": now_iso(),
        })
    # Seed default quick actions, mapping by category name.
    if await db.quick_actions.count_documents({"user_id": user_id}) == 0:
        cats_by_name: dict = {}
        async for c in db.categories.find({"user_id": user_id}, {"_id": 0, "id": 1, "name": 1}):
            cats_by_name[c["name"]] = c["id"]
        SEEDS = [
            {"label": "Code", "category_name": "Coding", "default_description": "Development work", "icon": "Code"},
            {"label": "Meeting", "category_name": "Meetings", "default_description": "Team / client meeting", "icon": "Users"},
            {"label": "Review", "category_name": "Coding", "default_description": "Code review and feedback", "icon": "FileSearch"},
        ]
        await db.quick_actions.insert_many([
            {
                "id": new_id(), "user_id": user_id,
                "label": s["label"],
                "category_id": cats_by_name.get(s["category_name"]),
                "default_description": s["default_description"],
                "icon": s["icon"],
                "sort_order": i,
                "created_at": now_iso(), "updated_at": now_iso(),
            }
            for i, s in enumerate(SEEDS)
        ])

class CategoryIn(BaseModel):
    name: str
    color: Optional[str] = "#2B8A8F"
    icon: Optional[str] = ""
    kind: Optional[str] = "time"  # time | expense | both
    billable: Optional[int] = 1
    default_hourly_cents: Optional[int] = None
    sort_order: Optional[int] = 0

@api.get("/categories")
async def list_categories(current=Depends(get_current_user)):
    cursor = db.categories.find({"user_id": current["id"]}, {"_id": 0}).sort([("sort_order", 1), ("name", 1)])
    return [d async for d in cursor]

@api.post("/categories")
async def create_category(body: CategoryIn, current=Depends(get_current_user)):
    return await _create("categories", current["id"], body.model_dump())

@api.patch("/categories/{cid}")
async def update_category(cid: str, body: CategoryIn, current=Depends(get_current_user)):
    return await _update("categories", current["id"], cid, body.model_dump())

@api.delete("/categories/{cid}")
async def delete_category(cid: str, current=Depends(get_current_user)):
    await _delete("categories", current["id"], cid)
    return {"ok": True}

class ProjectIn(BaseModel):
    name: str
    client_name: Optional[str] = None
    color: Optional[str] = "#5C4D7D"
    default_hourly_cents: Optional[int] = None
    currency: Optional[str] = "USD"
    notes: Optional[str] = None

@api.get("/projects")
async def list_projects(current=Depends(get_current_user)):
    return await _list("projects", current["id"])

@api.post("/projects")
async def create_project(body: ProjectIn, current=Depends(get_current_user)):
    return await _create("projects", current["id"], body.model_dump())

@api.delete("/projects/{pid}")
async def delete_project(pid: str, current=Depends(get_current_user)):
    await _delete("projects", current["id"], pid)
    return {"ok": True}

# ---------------------------------------------------------------------------
# Quick Actions — one-tap clock-in shortcuts (parity with desktop FACTORY_QUICK_ACTION_SEEDS)
# ---------------------------------------------------------------------------

class QuickActionIn(BaseModel):
    label: str
    category_id: Optional[str] = None
    project_id: Optional[str] = None
    default_description: Optional[str] = ""
    icon: Optional[str] = "Zap"
    sort_order: Optional[int] = 0

@api.get("/quick-actions")
async def list_quick_actions(current=Depends(get_current_user)):
    cursor = db.quick_actions.find({"user_id": current["id"]}, {"_id": 0}).sort([("sort_order", 1), ("created_at", 1)])
    return [d async for d in cursor]

@api.post("/quick-actions")
async def create_quick_action(body: QuickActionIn, current=Depends(get_current_user)):
    return await _create("quick_actions", current["id"], body.model_dump())

@api.patch("/quick-actions/{qid}")
async def update_quick_action(qid: str, body: QuickActionIn, current=Depends(get_current_user)):
    return await _update("quick_actions", current["id"], qid, body.model_dump())

@api.delete("/quick-actions/{qid}")
async def delete_quick_action(qid: str, current=Depends(get_current_user)):
    await _delete("quick_actions", current["id"], qid)
    return {"ok": True}

@api.post("/quick-actions/{qid}/run")
async def run_quick_action(qid: str, current=Depends(get_current_user)):
    """One-tap: clock in (if not already) using this action's category/project/description."""
    qa = await db.quick_actions.find_one({"id": qid, "user_id": current["id"]}, {"_id": 0})
    if not qa:
        raise HTTPException(status_code=404, detail="Quick action not found")
    existing = await db.active_sessions.find_one({"user_id": current["id"]})
    if existing:
        raise HTTPException(status_code=409, detail="Already clocked in")
    s = {
        "user_id": current["id"], "active": True,
        "category_id": qa.get("category_id"), "project_id": qa.get("project_id"),
        "description": qa.get("default_description") or "",
        "started_at_utc": now_iso(),
        "started_via_quick_action_id": qa["id"],
    }
    await db.active_sessions.insert_one(dict(s))
    return _strip(dict(s))

# ---------------------------------------------------------------------------
# Time entries + active session
# ---------------------------------------------------------------------------

class ClockInIn(BaseModel):
    category_id: Optional[str] = None
    project_id: Optional[str] = None
    description: Optional[str] = ""

class ClockOutIn(BaseModel):
    description: Optional[str] = ""

class ManualTimeIn(BaseModel):
    start_utc: str
    end_utc: str
    category_id: Optional[str] = None
    project_id: Optional[str] = None
    description: str = ""

@api.get("/time/session")
async def get_active_session(current=Depends(get_current_user)):
    s = await db.active_sessions.find_one({"user_id": current["id"]}, {"_id": 0})
    return s or {"active": False}

@api.post("/time/clock-in")
async def clock_in(body: ClockInIn, current=Depends(get_current_user)):
    existing = await db.active_sessions.find_one({"user_id": current["id"]})
    if existing:
        raise HTTPException(status_code=409, detail="Already clocked in")
    s = {
        "user_id": current["id"], "active": True,
        "category_id": body.category_id, "project_id": body.project_id,
        "description": body.description or "",
        "started_at_utc": now_iso(),
    }
    await db.active_sessions.insert_one(dict(s))
    return _strip(s)

@api.post("/time/clock-out")
async def clock_out(body: ClockOutIn, current=Depends(get_current_user)):
    s = await db.active_sessions.find_one({"user_id": current["id"]})
    if not s:
        raise HTTPException(status_code=404, detail="No active session")
    end_utc = now_iso()
    entry = {
        "id": new_id(), "user_id": current["id"],
        "start_utc": s["started_at_utc"], "end_utc": end_utc,
        "category_id": s.get("category_id"), "project_id": s.get("project_id"),
        "description": body.description or s.get("description", ""),
        "source": "clock", "created_at": now_iso(), "updated_at": now_iso(),
    }
    await db.time_entries.insert_one(entry)
    await db.active_sessions.delete_one({"user_id": current["id"]})
    return _strip(dict(entry))

@api.get("/time/entries")
async def list_time_entries(
    start: Optional[str] = None,
    end: Optional[str] = None,
    q: Optional[str] = None,
    category_id: Optional[str] = None,
    current=Depends(get_current_user),
):
    query: dict = {"user_id": current["id"]}
    if start:
        query.setdefault("start_utc", {})["$gte"] = start
    if end:
        query.setdefault("start_utc", {})["$lte"] = end
    if category_id:
        query["category_id"] = category_id
    if q:
        query["description"] = {"$regex": q, "$options": "i"}
    cursor = db.time_entries.find(query, {"_id": 0}).sort("start_utc", -1).limit(500)
    return [d async for d in cursor]

@api.post("/time/manual")
async def manual_time_entry(body: ManualTimeIn, current=Depends(get_current_user)):
    doc = {**body.model_dump(), "source": "manual"}
    return await _create("time_entries", current["id"], doc)

@api.delete("/time/entries/{tid}")
async def delete_time_entry(tid: str, current=Depends(get_current_user)):
    await _delete("time_entries", current["id"], tid)
    return {"ok": True}

class TimeEntryUpdate(BaseModel):
    start_utc: Optional[str] = None
    end_utc: Optional[str] = None
    category_id: Optional[str] = None
    project_id: Optional[str] = None
    description: Optional[str] = None

@api.patch("/time/entries/{tid}")
async def update_time_entry(tid: str, body: TimeEntryUpdate, current=Depends(get_current_user)):
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    return await _update("time_entries", current["id"], tid, data)

# ---------------------------------------------------------------------------
# Money: income / expenses
# ---------------------------------------------------------------------------

class IncomeIn(BaseModel):
    amount_cents: int
    currency: str = "USD"
    description: str = ""
    category_id: Optional[str] = None
    project_id: Optional[str] = None
    received_at_utc: Optional[str] = None

class ExpenseIn(BaseModel):
    amount_cents: int
    currency: str = "USD"
    description: str = ""
    funding: str = "cash"  # cash | bank | credit
    category_id: Optional[str] = None
    project_id: Optional[str] = None
    merchant: Optional[str] = None
    spent_at_utc: Optional[str] = None

@api.get("/money/income")
async def list_income(current=Depends(get_current_user)):
    return await _list("income_entries", current["id"])

@api.post("/money/income")
async def create_income(body: IncomeIn, current=Depends(get_current_user)):
    data = body.model_dump()
    if not data.get("received_at_utc"):
        data["received_at_utc"] = now_iso()
    return await _create("income_entries", current["id"], data)

@api.delete("/money/income/{iid}")
async def delete_income(iid: str, current=Depends(get_current_user)):
    await _delete("income_entries", current["id"], iid)
    return {"ok": True}

@api.get("/money/expenses")
async def list_expenses(current=Depends(get_current_user)):
    return await _list("expense_entries", current["id"])

@api.post("/money/expenses")
async def create_expense(body: ExpenseIn, current=Depends(get_current_user)):
    data = body.model_dump()
    if not data.get("spent_at_utc"):
        data["spent_at_utc"] = now_iso()
    return await _create("expense_entries", current["id"], data)

@api.delete("/money/expenses/{eid}")
async def delete_expense(eid: str, current=Depends(get_current_user)):
    await _delete("expense_entries", current["id"], eid)
    return {"ok": True}

# ---------------------------------------------------------------------------
# Clients & Invoices
# ---------------------------------------------------------------------------

class ClientIn(BaseModel):
    display_name: str
    company: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    address: Optional[str] = None
    website: Optional[str] = None
    tax_id: Optional[str] = None
    notes: Optional[str] = None

@api.get("/clients")
async def list_clients(current=Depends(get_current_user)):
    return await _list("clients", current["id"])

@api.post("/clients")
async def create_client(body: ClientIn, current=Depends(get_current_user)):
    return await _create("clients", current["id"], body.model_dump())

@api.patch("/clients/{cid}")
async def update_client(cid: str, body: ClientIn, current=Depends(get_current_user)):
    return await _update("clients", current["id"], cid, body.model_dump())

@api.delete("/clients/{cid}")
async def delete_client(cid: str, current=Depends(get_current_user)):
    await _delete("clients", current["id"], cid)
    return {"ok": True}

class InvoiceLine(BaseModel):
    description: str
    quantity: float = 1
    unit_price_cents: int = 0

class InvoiceIn(BaseModel):
    client_id: Optional[str] = None
    invoice_number: str
    status: str = "draft"  # draft | sent | paid | void
    issued_at_utc: Optional[str] = None
    due_at_utc: Optional[str] = None
    currency: str = "USD"
    notes: Optional[str] = ""
    lines: List[InvoiceLine] = []

@api.get("/invoices")
async def list_invoices(current=Depends(get_current_user)):
    return await _list("invoices", current["id"])

@api.post("/invoices")
async def create_invoice(body: InvoiceIn, current=Depends(get_current_user)):
    data = body.model_dump()
    if not data.get("issued_at_utc"):
        data["issued_at_utc"] = now_iso()
    lines = data.get("lines", [])
    subtotal = sum(int(line.get("quantity", 1) * line.get("unit_price_cents", 0)) for line in lines)
    data["subtotal_cents"] = subtotal
    data["tax_cents"] = 0
    data["total_cents"] = subtotal
    return await _create("invoices", current["id"], data)

@api.patch("/invoices/{iid}")
async def update_invoice(iid: str, body: InvoiceIn, current=Depends(get_current_user)):
    data = body.model_dump()
    lines = data.get("lines", [])
    subtotal = sum(int(line.get("quantity", 1) * line.get("unit_price_cents", 0)) for line in lines)
    data["subtotal_cents"] = subtotal
    data["total_cents"] = subtotal + data.get("tax_cents", 0)
    return await _update("invoices", current["id"], iid, data)

@api.delete("/invoices/{iid}")
async def delete_invoice(iid: str, current=Depends(get_current_user)):
    await _delete("invoices", current["id"], iid)
    return {"ok": True}

# ---------------------------------------------------------------------------
# Stock products & supplies
# ---------------------------------------------------------------------------

class ProductIn(BaseModel):
    name: str
    sku: Optional[str] = None
    description: Optional[str] = None
    unit: str = "ea"
    qty_on_hand: float = 0
    reorder_level: float = 0
    unit_cost_cents: Optional[int] = None
    unit_price_cents: Optional[int] = None
    currency: str = "USD"
    notes: Optional[str] = None

@api.get("/products")
async def list_products(current=Depends(get_current_user)):
    return await _list("products", current["id"])

@api.post("/products")
async def create_product(body: ProductIn, current=Depends(get_current_user)):
    return await _create("products", current["id"], body.model_dump())

@api.patch("/products/{pid}")
async def update_product(pid: str, body: ProductIn, current=Depends(get_current_user)):
    return await _update("products", current["id"], pid, body.model_dump())

@api.delete("/products/{pid}")
async def delete_product(pid: str, current=Depends(get_current_user)):
    await _delete("products", current["id"], pid)
    return {"ok": True}

class SupplyIn(BaseModel):
    name: str
    category: Optional[str] = None
    unit: str = "ea"
    qty_on_hand: float = 0
    reorder_level: float = 0
    vendor: Optional[str] = None
    notes: Optional[str] = None

@api.get("/supplies")
async def list_supplies(current=Depends(get_current_user)):
    return await _list("supplies", current["id"])

@api.post("/supplies")
async def create_supply(body: SupplyIn, current=Depends(get_current_user)):
    return await _create("supplies", current["id"], body.model_dump())

@api.patch("/supplies/{sid}")
async def update_supply(sid: str, body: SupplyIn, current=Depends(get_current_user)):
    return await _update("supplies", current["id"], sid, body.model_dump())

@api.delete("/supplies/{sid}")
async def delete_supply(sid: str, current=Depends(get_current_user)):
    await _delete("supplies", current["id"], sid)
    return {"ok": True}

# ---------------------------------------------------------------------------
# Schedule events
# ---------------------------------------------------------------------------

class ScheduleEventIn(BaseModel):
    title: str
    starts_at_utc: str
    ends_at_utc: Optional[str] = None
    all_day: bool = False
    client_id: Optional[str] = None
    project_id: Optional[str] = None
    location: Optional[str] = None
    notes: Optional[str] = None
    status: str = "scheduled"  # scheduled | done | cancelled

@api.get("/schedule")
async def list_schedule(current=Depends(get_current_user)):
    return await _list("schedule_events", current["id"])

@api.post("/schedule")
async def create_schedule(body: ScheduleEventIn, current=Depends(get_current_user)):
    return await _create("schedule_events", current["id"], body.model_dump())

@api.patch("/schedule/{sid}")
async def update_schedule(sid: str, body: ScheduleEventIn, current=Depends(get_current_user)):
    return await _update("schedule_events", current["id"], sid, body.model_dump())

@api.delete("/schedule/{sid}")
async def delete_schedule(sid: str, current=Depends(get_current_user)):
    await _delete("schedule_events", current["id"], sid)
    return {"ok": True}

# ---------------------------------------------------------------------------
# Debts / Funds / Scheduled / Resources
# ---------------------------------------------------------------------------

class DebtIn(BaseModel):
    amount_cents: int
    currency: str = "USD"
    creditor: Optional[str] = None
    description: str = ""
    due_at_utc: Optional[str] = None
    status: str = "open"  # open | paid

@api.get("/debts")
async def list_debts(current=Depends(get_current_user)):
    return await _list("debts", current["id"])

@api.post("/debts")
async def create_debt(body: DebtIn, current=Depends(get_current_user)):
    return await _create("debts", current["id"], body.model_dump())

@api.patch("/debts/{did}")
async def update_debt(did: str, body: DebtIn, current=Depends(get_current_user)):
    return await _update("debts", current["id"], did, body.model_dump())

@api.delete("/debts/{did}")
async def delete_debt(did: str, current=Depends(get_current_user)):
    await _delete("debts", current["id"], did)
    return {"ok": True}

class ScheduledExpenseIn(BaseModel):
    description: str
    amount_cents: int
    currency: str = "USD"
    frequency: str = "monthly"  # weekly | monthly | yearly
    next_due_utc: str
    merchant: Optional[str] = None
    active: bool = True

@api.get("/scheduled-expenses")
async def list_scheduled(current=Depends(get_current_user)):
    return await _list("scheduled_expenses", current["id"])

@api.post("/scheduled-expenses")
async def create_scheduled(body: ScheduledExpenseIn, current=Depends(get_current_user)):
    return await _create("scheduled_expenses", current["id"], body.model_dump())

@api.delete("/scheduled-expenses/{sid}")
async def delete_scheduled(sid: str, current=Depends(get_current_user)):
    await _delete("scheduled_expenses", current["id"], sid)
    return {"ok": True}

class ResourceIn(BaseModel):
    amount_cents: int
    currency: str = "USD"
    source_type: str = "owner_contribution"  # owner_contribution | grant | other
    description: str = ""
    at_utc: Optional[str] = None

@api.get("/resources")
async def list_resources(current=Depends(get_current_user)):
    return await _list("resources", current["id"])

@api.post("/resources")
async def create_resource(body: ResourceIn, current=Depends(get_current_user)):
    data = body.model_dump()
    if not data.get("at_utc"):
        data["at_utc"] = now_iso()
    return await _create("resources", current["id"], data)

@api.delete("/resources/{rid}")
async def delete_resource(rid: str, current=Depends(get_current_user)):
    await _delete("resources", current["id"], rid)
    return {"ok": True}

class FundIn(BaseModel):
    account_name: str
    account_type: str = "cash"  # cash | bank | credit
    currency: str = "USD"
    current_balance_cents: int = 0
    credit_limit_cents: int = 0
    notes: str = ""

@api.get("/funds")
async def list_funds(current=Depends(get_current_user)):
    return await _list("funds", current["id"])

@api.post("/funds")
async def create_fund(body: FundIn, current=Depends(get_current_user)):
    return await _create("funds", current["id"], body.model_dump())

@api.patch("/funds/{fid}")
async def update_fund(fid: str, body: FundIn, current=Depends(get_current_user)):
    return await _update("funds", current["id"], fid, body.model_dump())

@api.delete("/funds/{fid}")
async def delete_fund(fid: str, current=Depends(get_current_user)):
    await _delete("funds", current["id"], fid)
    return {"ok": True}

# ---------------------------------------------------------------------------
# Businesses & Settings
# ---------------------------------------------------------------------------

class BusinessIn(BaseModel):
    name: str
    legal_name: Optional[str] = ""
    owner: Optional[str] = ""
    tax_id: Optional[str] = ""
    email: Optional[str] = ""
    phone: Optional[str] = ""
    website: Optional[str] = ""
    address: Optional[str] = ""
    timezone: Optional[str] = "system"
    invoice_notes: Optional[str] = ""

@api.get("/businesses")
async def list_businesses(current=Depends(get_current_user)):
    return await _list("businesses", current["id"])

@api.post("/businesses")
async def create_business(body: BusinessIn, current=Depends(get_current_user)):
    return await _create("businesses", current["id"], body.model_dump())

@api.patch("/businesses/{bid}")
async def update_business(bid: str, body: BusinessIn, current=Depends(get_current_user)):
    return await _update("businesses", current["id"], bid, body.model_dump())

@api.delete("/businesses/{bid}")
async def delete_business(bid: str, current=Depends(get_current_user)):
    await _delete("businesses", current["id"], bid)
    return {"ok": True}

class SettingsIn(BaseModel):
    currency_default: Optional[str] = None
    theme: Optional[str] = None
    prompt_interval_sec: Optional[int] = None
    prompt_first_delay_sec: Optional[int] = None
    prompt_response_timeout_sec: Optional[int] = None
    default_hourly_cents: Optional[int] = None
    show_money_in_dashboard: Optional[bool] = None
    help_bubbles_enabled: Optional[bool] = None
    business_timezone: Optional[str] = None
    active_business_id: Optional[str] = None

@api.get("/settings")
async def get_settings(current=Depends(get_current_user)):
    s = await db.settings.find_one({"user_id": current["id"]}, {"_id": 0})
    if not s:
        await _seed_default_business(current["id"])
        s = await db.settings.find_one({"user_id": current["id"]}, {"_id": 0})
    return s

@api.patch("/settings")
async def update_settings(body: SettingsIn, current=Depends(get_current_user)):
    data = {k: v for k, v in body.model_dump().items() if v is not None}
    data["updated_at"] = now_iso()
    await db.settings.update_one({"user_id": current["id"]}, {"$set": data}, upsert=True)
    s = await db.settings.find_one({"user_id": current["id"]}, {"_id": 0})
    return s

# ---------------------------------------------------------------------------
# Feedback
# ---------------------------------------------------------------------------

class FeedbackIn(BaseModel):
    type: str = "general"
    message: str
    reply_email: Optional[str] = None
    include_diagnostics: bool = True

@api.post("/feedback")
async def send_feedback(body: FeedbackIn, current=Depends(get_current_user)):
    return await _create("feedback", current["id"], body.model_dump())

# ---------------------------------------------------------------------------
# Dashboard / Reports aggregates
# ---------------------------------------------------------------------------

@api.get("/dashboard/summary")
async def dashboard_summary(
    start: Optional[str] = None,
    end: Optional[str] = None,
    current=Depends(get_current_user),
):
    """Hours, income, expenses, net + breakdown by category for the window."""
    user_id = current["id"]
    start = start or (datetime.now(timezone.utc).replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)).isoformat().replace("+00:00", "Z")
    end = end or now_iso()

    # Time entries → hours per category
    cur = db.time_entries.find({
        "user_id": user_id,
        "start_utc": {"$gte": start, "$lte": end},
    }, {"_id": 0})
    by_cat: dict = {}
    total_seconds = 0
    async for e in cur:
        try:
            s = datetime.fromisoformat(e["start_utc"].replace("Z", "+00:00"))
            f = datetime.fromisoformat(e["end_utc"].replace("Z", "+00:00"))
            secs = max(0, int((f - s).total_seconds()))
        except Exception:
            secs = 0
        total_seconds += secs
        key = e.get("category_id") or "uncategorized"
        by_cat[key] = by_cat.get(key, 0) + secs

    # Resolve category names + colors
    cats = {c["id"]: c async for c in db.categories.find({"user_id": user_id}, {"_id": 0})}
    breakdown = []
    for cid, secs in by_cat.items():
        c = cats.get(cid)
        breakdown.append({
            "category_id": cid,
            "name": c["name"] if c else "Uncategorized",
            "color": c["color"] if c else "#687777",
            "hours": round(secs / 3600.0, 2),
        })
    breakdown.sort(key=lambda x: x["hours"], reverse=True)

    # Income / expenses
    inc_total = 0
    async for d in db.income_entries.find({
        "user_id": user_id,
        "received_at_utc": {"$gte": start, "$lte": end},
    }, {"_id": 0, "amount_cents": 1}):
        inc_total += int(d.get("amount_cents", 0) or 0)
    exp_total = 0
    async for d in db.expense_entries.find({
        "user_id": user_id,
        "spent_at_utc": {"$gte": start, "$lte": end},
    }, {"_id": 0, "amount_cents": 1}):
        exp_total += int(d.get("amount_cents", 0) or 0)

    return {
        "start": start,
        "end": end,
        "hours": round(total_seconds / 3600.0, 2),
        "income_cents": inc_total,
        "expense_cents": exp_total,
        "net_cents": inc_total - exp_total,
        "breakdown": breakdown,
    }

# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

@api.get("/health")
async def health():
    try:
        await db.command("ping")
        return {"ok": True, "db": True}
    except Exception as e:
        return {"ok": False, "db": False, "error": str(e)}

# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------

@app.on_event("startup")
async def on_startup():
    # email index but NOT unique anymore — accounts can re-appear with same id, and the
    # canonical id field is `id` (= licence Worker account_id).
    await db.users.create_index("id", unique=True)
    await db.users.create_index("email")
    await db.time_entries.create_index([("user_id", 1), ("start_utc", -1)])
    await db.income_entries.create_index([("user_id", 1), ("received_at_utc", -1)])
    await db.expense_entries.create_index([("user_id", 1), ("spent_at_utc", -1)])
    await db.schedule_events.create_index([("user_id", 1), ("starts_at_utc", -1)])
    # Drop legacy unique index on email if present (carried from local-auth build).
    try:
        await db.users.drop_index("email_1")
    except Exception:
        pass
    # Drop any local-only password fields from prior local-auth installs.
    try:
        await db.users.update_many({}, {"$unset": {"password_hash": ""}})
    except Exception:
        pass

app.include_router(api)
