# RootRecord Business Manager — Mobile (PRD)

## Original problem statement
Port the RootRecord Business Manager Windows desktop app (Electron + SQLite) to a mobile target, mirroring the discipline used for Weather Manager mobile (private React + Capacitor source / public APK-only repo). Match the desktop modules: time, money, clients, inventory, scheduling, work log, reports. Local-first SQLite on device with the same RootRecord account + licence model as the Windows app. Keep the dark teal aesthetic and the brand tagline "Your grounding root for business productivity."

User clarification (verbatim): *"This is my project. I just want you to build a mobile version of business manager, please look at the screenshots inside the repo for context. I will fully edit this more. I just need all the features the windows app has in the mobile version."*

## Architecture (this build)
- **Frontend**: React 18 mobile-first PWA (Manrope + Work Sans, Tailwind dark teal theme #2B8A8F). React Router. Recharts for charts. jsPDF for the Reports → PDF export.
- **Backend**: FastAPI + Motor (async MongoDB). JWT bearer auth (bcrypt password hashing, 7-day token). All endpoints under `/api`.
- **Storage**: MongoDB collections mirror the SQL tables from `migrateSql.js` (categories, projects, time_entries, income_entries, expense_entries, clients, invoices, products, supplies, schedule_events, debts, scheduled_expenses, resources, funds, businesses, settings, feedback). The schema is portable to Capacitor SQLite when wrapping for Android.
- **Theme**: Mirrors desktop dark teal. Bottom-tab navigation: Dashboard / Track / Money / Schedule / More.

## Modules implemented (matches desktop screenshots)
1. **Auth** — sign in / sign up / continue as guest. JWT stored in `localStorage`.
2. **Dashboard** — Hours / Income / Expenses / Net KPI cards; year + month chip selector; category pie + bar chart.
3. **Time & Tracking** — clock in / clock out, category + project selectors, manual time entry.
4. **Work Log** — date range, search, category filter, list, delete.
5. **Reports** — date range, summary KPIs, pie + bar charts, downloadable PDF.
6. **Finance & Clients** — segmented control: Money (income/expenses), Clients, Invoices, Debts, Funds, Scheduled, Resources, Tax estimator.
7. **Schedule & Bookings** — event creation form + list (90 day-friendly).
8. **Stock & Supplies** — Products tab + Supplies tab (qty, reorder, low-stock badge).
9. **Account Settings** — sign in / log out, plan card (Free/Pro), demo "Upgrade to Pro" hook (production target: license Worker `/v1/entitlement`).
10. **Business Settings** — multi-business profiles, address, timezone.
11. **Program Settings** — currency, theme, prompts, hourly rate, IANA timezone, dashboard toggles.
12. **About & Help** — version, brand principles, plan blurb.
13. **Feedback** — type / message / reply email / diagnostics opt-in.

## What's been implemented (2026-04-30)
- All 13 modules above, mobile-responsive, with `data-testid` on every interactive element.
- Backend with full CRUD endpoints for each module.
- **Auth wired to the live RootRecord licence Worker** (2026-04-30 follow-up): backend proxies `/api/auth/{login,register,me,logout,entitlement}` to `https://rootrecord-license.rootrecord.workers.dev`. Same email/password as the Windows installer works on mobile. `account_id` from the Worker is the canonical user id for owned-data scoping. Plan derivation: `access=full + (reason=paid OR subscription_status=active) → pro`. 5-minute in-memory token cache. `device_id` generated client-side and persisted in localStorage (parity with desktop's `loadOrCreateDeviceId`). HTML 5xx from upstream is sanitized into short user-facing messages. 429 (rate-limit) is passed through to the client. Local password storage removed.
- Default work categories (12) seeded for new users; default business profile auto-created.
- Demo data shows hours, income, expenses, net, and a category breakdown chart.
- **Quick Actions**: one-tap clock-in shortcuts on the Dashboard. Default seeds (Code/Meeting/Review) match desktop's `FACTORY_QUICK_ACTION_SEEDS`. Manage from the Track screen — add, delete, run. Active-session banner with live timer & stop button on Dashboard. Endpoints: `/api/quick-actions` (list/post/patch/delete) + `/api/quick-actions/{id}/run`.
- **Account Settings**: shows real subscription status from the Worker, "Refresh entitlement" button (calls `/api/auth/entitlement`), and a clean external "Upgrade on rootrecord.info" link (no more demo upgrade).

## Known gaps / next phase (P1)
- **Cloud sync**: the desktop app pushes/pulls via `https://rootrecord-license.rootrecord.workers.dev/v1/sync/{push,pull}`. The mobile build today only writes to its own MongoDB; wiring to the licence Worker is deferred (would also enable session-token parity with the desktop installer).
- **Capacitor wrapper**: the React PWA is the deliverable in this Linux sandbox. To produce a signed APK, drop the `frontend/` source into a Capacitor 6 Gradle project (mirroring `rr-weather-manager-mobile`). Recommended scaffold:
  ```bash
  yarn add @capacitor/core @capacitor/android
  npx cap init "RootRecord Business Manager" com.rootrecord.businessmanager
  npx cap add android
  npx cap copy
  npx cap open android   # builds via Android Studio / Gradle
  ```
- **Licence Worker auth contract**: `licenseService.js` uses POST `/v1/auth/login`, GET `/v1/me`, POST `/v1/entitlement`, POST `/v1/auth/logout`. The current `api.js` file structure (single bearer token, `/auth/login`) was kept intentionally compatible — swap the base URL + payload shape and the rest of the UI works.
- **Reports PDF**: today renders a simple text PDF via jsPDF. Desktop uses `jspdf-autotable` for richer tables — same library, same call site.

## Backlog (P2)
- Server-side sync engine (port `syncEngine.js` semantics).
- Power snapshots / quake events from desktop (these are Weather/USGS plugins that don't belong in BM mobile v1).
- Multi-business rollups across businesses (Pro feature parity).
- Notifications for scheduled expenses / low stock.
- Biometric app lock + EncryptedSharedPreferences for the JWT once on Android.

## Testing
- See `/app/memory/test_credentials.md` for admin login.
- Backend smoke tests via curl. UI smoke tests via screenshot tool. Comprehensive test pass via `testing_agent_v3`.

## Reference (kept on-disk)
The original Electron app source is preserved under `/app/app/resources/app/` (read-only). The Android port master prompt is at `/app/app/resources/app/docs/ANDROID_PORT_MASTER_PROMPT.md`. Screenshots used to mirror UI: `/app/app/resources/app/docs/screenshots/photo_*.jpg`.
