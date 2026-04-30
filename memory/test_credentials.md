# RootRecord Business Manager — Mobile (Test Credentials)

## Admin (seeded on backend startup)
- **Email:** `admin@rootrecord.app`
- **Password:** `admin123`
- **Role:** `admin`
- **Plan:** `pro`

## Auth endpoints (all under `/api`)
- `POST /api/auth/register` — `{ email, password, name? }` → returns `{ access_token, user }`
- `POST /api/auth/login` — `{ email, password }` → returns `{ access_token, user }`
- `GET  /api/auth/me` — Bearer token required → returns user
- `POST /api/auth/logout` — Bearer token required → `{ ok: true }`
- `POST /api/auth/upgrade-pro` — Bearer token required → flips current user to Pro plan

## How tokens are sent
Frontend stores the JWT in `localStorage.rrbm_token` and attaches it as `Authorization: Bearer <token>` on every API call (no cookies, no CORS-credentials).

## Quick login curl
```bash
API="https://15689350-c999-4107-934a-1701fd2675bc.preview.emergentagent.com/api"
TOKEN=$(curl -s -X POST $API/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@rootrecord.app","password":"admin123"}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
curl -s "$API/auth/me" -H "Authorization: Bearer $TOKEN"
```

## Notes for testing agents
- Email `admin@rootrecord.local` is **not** valid — `email-validator` rejects `.local`. Use `.app`.
- Guest mode is supported in the React UI (button "Continue without an account") but does not call the API. Use admin login for backend tests.
- The backend has CORS `allow_origins=["*"]` and **does not** set cookies — testing agents should not pass `withCredentials`.
