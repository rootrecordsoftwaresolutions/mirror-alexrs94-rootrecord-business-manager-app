# RootRecord Business Manager — Mobile (Test Credentials)

## ⚠️ Auth has changed (2026-04-30)
Authentication now **proxies to the live RootRecord licence Worker** at `https://rootrecord-license.rootrecord.workers.dev`, mirroring the desktop installer's `licenseService.js`. The same email/password used by the Windows app works on mobile.

The previously-seeded `admin@rootrecord.app / admin123` local-only admin account **no longer exists** — passwords are managed by the licence Worker, not stored locally.

## How to test

### Option 1 — Use a real RootRecord account (preferred)
Use the email/password the user already has on rootrecord.info. Plan (Free vs Pro) is derived from the Worker's entitlement response.

### Option 2 — Create a fresh test account against the live Worker
The signup endpoint hits the real Worker, so any unique email works:

```bash
API="https://15689350-c999-4107-934a-1701fd2675bc.preview.emergentagent.com/api"
EMAIL="bm-test-$(date +%s)@rootrecord-test.com"
PASS="TestPass1234!"
RESP=$(curl -s -X POST $API/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"device_id\":\"$(python3 -c 'import uuid;print(uuid.uuid4())')\"}")
echo "$RESP"
TOKEN=$(echo "$RESP" | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s "$API/auth/me" -H "Authorization: Bearer $TOKEN"
```

Verified working: signup → token → /me → entitlement (account_id stable across login & signup; new accounts return `plan=free`).

## Endpoints (under `/api`)
- `POST /api/auth/register` — `{email, password, name?, device_id?}` → proxies to Worker `/v1/auth/signup`. Returns `{access_token, user}`.
- `POST /api/auth/login` — `{email, password, device_id?}` → proxies to Worker `/v1/auth/login`.
- `GET  /api/auth/me` — Bearer token → validates via Worker `/v1/me`, returns local mirror.
- `POST /api/auth/logout` — Bearer → calls Worker `/v1/auth/logout` best-effort + clears cache.
- `POST /api/auth/entitlement` — Bearer + optional `{device_id}` → proxies to Worker `/v1/entitlement`. Updates local plan.

## How tokens are sent
Frontend stores the Worker JWT in `localStorage.rrbm_token` and a stable `rrbm_device_id` (UUID). Backend caches `(token → account_id, email)` for 5 minutes to avoid hammering the Worker on every API call.

## Notes for testing agents
- Email validator rejects `.local` and `.test` TLDs. Use `.com` / `.app`.
- Plan derivation: `access=full + (reason=paid OR subscription_status=active)` → `pro`; otherwise `free`.
- Owned data (time entries, money, clients, etc.) is keyed by Worker's `account_id` — completely isolated per user.
- Backend env: `LICENSE_API_BASE_URL=https://rootrecord-license.rootrecord.workers.dev`.
