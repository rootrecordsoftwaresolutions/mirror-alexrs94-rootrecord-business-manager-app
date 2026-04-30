# Master prompt: RootRecord Business Manager → Android (parity with Weather Manager mobile)

Use this document as the **single briefing** for an AI agent or engineering team porting **RootRecord Business Manager (V2)** from **Windows / Electron / SQLite** to **Android**, following the **same product and release discipline** as **Root Record Weather Manager** on mobile.

---

## Canonical GitHub repositories (Weather + Business Manager)

**Weather Manager — Android (private application source)**  
**https://github.com/RootRecord/rr-weather-manager-mobile**  
This is the real mobile codebase (React + Capacitor, `frontend/`, `backend/`, Gradle, docs). Clone or browse **this** repo for implementation patterns—not a guess from folder names alone.

**Weather Manager — Android (public: APK, changelog, consumer README only — no app source)**  
**https://github.com/RootRecord/rootrecord-weather-manager-mobile**  
Releases: **https://github.com/RootRecord/rootrecord-weather-manager-mobile/releases**  
Maintainers sync the minimal public tree from the sibling **`rootrecord-weather-manager-mobile-public`** folder in automation/docs; never push full source there.

**Weather Manager — Windows desktop installers (public)**  
**https://github.com/RootRecord/rootrecord-weather-manager-download** (installers / `latest.yml` for the Electron desktop app—not the Android repo).

**Business Manager — Windows / Electron app snapshot (private; BM-only tree)**  
**https://github.com/RootRecord/rootrecord-business-manager-app**  
Contains this `app/resources/app/` tree, export script, screenshots, and **this** Android port prompt.

**Full RootRecord workspace (optional; large monorepo)**  
**https://github.com/RootRecord/rootrecord-workspace**  
May include a **local checkout** under `Mobile App Development/rr-weather-manager-mobile/` that **tracks** `rr-weather-manager-mobile`—but agents should still use the **GitHub URLs above** as source of truth.

---

## 0. North star

Deliver **RootRecord Business Manager on Android**: **local-first** business data (time, money, clients, inventory, scheduling, reports), **SQLite** on device, **optional** online features where they exist on desktop (license sign-in, entitlement refresh, sync/backup if the product defines them), and **RootRecord account** alignment with **`rootrecord.info`** and the existing **Cloudflare license / primary** APIs.

Match **Weather Manager mobile** in **process**, not necessarily in stack line-for-line:

| Dimension | Weather Manager (Android) reference | Business Manager (current) |
|-----------|-------------------------------------|------------------------------|
| Public vs private | **Private source:** [rr-weather-manager-mobile](https://github.com/RootRecord/rr-weather-manager-mobile). **Public storefront:** [rootrecord-weather-manager-mobile](https://github.com/RootRecord/rootrecord-weather-manager-mobile) (Releases only). | Mirror: **private** `rr-business-manager-mobile` (TBD) + **public** `rootrecord-business-manager-mobile` (TBD) for APK/AAB + notes. |
| Client | **React** app + **Capacitor 6** (`frontend/`), Gradle under `frontend/android/`. | Plan a **mobile client** (recommended: **React + Capacitor** or **Kotlin + Compose** with a shared logic layer—decide in §3). |
| Workspace | Sits under **`Mobile App Development`** with **pnpm** workspace, `pnpm weather:start`. | New package e.g. `pnpm business:start` or sibling app under same workspace. |
| Backend | Optional **FastAPI** + Mongo for some features; client talks HTTP. | **Reuse** existing **license Worker** + **primary Worker** HTTP APIs where desktop does; **no** requirement to duplicate Windows-only paths. |
| Install | **APK** on GitHub Releases; Play **AAB** pipeline documented. | Same: debug APK for testers; `bundleRelease` + signing for Play. |

---

## 1. Source of truth (read in this order)

1. **Windows / Electron app (canonical behavior)**  
   **GitHub (BM-only snapshot):** [rootrecord-business-manager-app](https://github.com/RootRecord/rootrecord-business-manager-app)  
   Monorepo path (if you have the full workspace): `Windows App Development/apps/root-record-business-manager/`  
   Dev root: **`app/resources/app/`** — `package.json`, `src/main/**`, `src/renderer/**`, `src/main/licenseService.js`, `src/main/database.js`, `src/main/paths.js`, `src/main/syncEngine.js` (if present).

2. **Product + data model docs**  
   - `app/resources/app/README.md` — install paths, env vars, subscription/entitlement rules, updater.  
   - `app/resources/app/docs/RELEASE.md` — shipping and signing (Windows-specific; adapt principles for Android signing).  
   - `app/resources/app/docs/BM_EXPORT.md` — layout, export script, reading order.  
   - `app/resources/app/docs/screenshots/` — UI reference.

3. **Weather Manager mobile (process + code template)**  
   **Clone and read:** [https://github.com/RootRecord/rr-weather-manager-mobile](https://github.com/RootRecord/rr-weather-manager-mobile)  
   Entry: **`README.md`** (pnpm workspace, `pnpm weather:start`, Capacitor, `frontend/android/`, `pnpm run android:play:ready`).  
   Docs: **`docs/PORTING-AND-INTEGRATION.md`**, **`docs/SECURITY-AND-SECRETS.md`** in that repo.  
   **Public** sibling workflow: [rootrecord-weather-manager-mobile](https://github.com/RootRecord/rootrecord-weather-manager-mobile) — compare with local **`Mobile App Development/rootrecord-weather-manager-mobile-public/`** only if you maintain that mirror from the monorepo.

4. **APIs and site alignment**  
   - Account portal pattern: **`https://rootrecord.info`** same-origin `/v1/*` via Pages (see main site).  
   - Primary Worker base (desktop / server): **`https://rootrecord-primary.rootrecord.workers.dev`** (auth, weather, solana-site routes as applicable).  
   - License Worker: **`https://rootrecord-license.rootrecord.workers.dev`** — Business Manager desktop uses this for licence flows (`licenseService.js`). Android must use the **same** HTTP contract (`POST /v1/auth/login`, entitlement, `/v1/me`, logout as implemented).  
   - Workspace reference env (non-secret mirror): repo root **`rootrecord-sites-reference.env`** (Stripe publishable + pricing table IDs, public URLs).

Do **not** invent new API hosts or D1 schemas; extend only what the Workers already expose.

---

## 2. Functional parity matrix (plan → build → verify)

For each area, state **MVP**, **phase 2**, or **out of scope v1**.

| Area | Windows / Electron behavior (investigate in code) | Android expectation |
|------|---------------------------------------------------|------------------------|
| Local DB | SQLite under user profile `business_data`; `SQLITE_PATH` / `RR_BUSINESS_MANAGER_HOME` | **SQL** on device (SQLite via Capacitor plugin, SQLDelight, Room, or raw); **scoped app storage**; migration path from desktop export if product requires. |
| Auth / licence | `licenseService.js`, session JSON, device id, entitlement cache, `license-prepare` IPC | Same HTTP flows; secure **token storage** (Android Keystore / EncryptedSharedPreferences); no secrets in client beyond publishable Stripe if needed for billing WebView. |
| UI | Large `renderer` HTML/JS/CSS | **Re-implement** screens (React or native). Use **screenshots** under `docs/screenshots/` for visual reference; do not embed Electron. |
| Updates | `electron-updater` + GitHub Releases + `latest.yml` | **Play In-App Updates** and/or **self-hosted APK** on GitHub Releases (mirror Weather). |
| Offline | Core DB local; online for licence refresh rules in README | Same offline-first posture; document airplane behavior. |
| Reports / PDF | `jspdf` etc. on desktop | Use compatible libs on mobile or server-side export—decide per performance. |
| Timezone | Documented in README / changelog | Use **IANA** zones on Android (`java.time` / Luxon equivalent). |

---

## 3. Architecture choice (mandatory decision record)

Pick **one** primary approach and document tradeoffs in `docs/ANDROID_ARCHITECTURE.md` in the new mobile repo:

**Option A — React + Capacitor (closest to Weather Manager)**  
- Pros: Shared web skills, Capacitor plugins for SQLite/files/push, Gradle pipeline already proven in Weather.  
- Cons: Heavy UI from desktop is not reusable as DOM; substantial **rewrite** of renderer. Native feel needs discipline (navigation, back stack, keyboard).

**Option B — Kotlin + Compose (native)**  
- Pros: Performance, Play compliance, Android-first UX.  
- Cons: Reimplement all UI and bridge; consider **shared Rust/Kotlin** module only if team has capacity.

**Option C — Hybrid**  
- Compose shell + **WebView** for select complex screens (short-term only; document escape hatch).

Deliverable: **ADR** (Architecture Decision Record) with chosen option + **module diagram** (data, network, UI, background jobs).

---

## 4. Engineering workstreams (parallelizable)

### 4.1 Repository & CI

- Create **private** `rr-business-manager-mobile` (name TBD) under `Mobile App Development/apps/` or sibling to Weather.  
- Create **public** `rootrecord-business-manager-mobile` for APK/AAB + CHANGELOG only (no source), mirroring Weather public repo rules.  
- CI: `pnpm install --frozen-lockfile`, unit tests, `android:assemble`, lint; protect `main`.

### 4.2 Data layer

- Specify **SQLite schema** parity with desktop: extract migrations / `database.js` / `migrateSql.js` — generate **single source of truth** (SQL files) shared or ported.  
- Define **backup/export** format compatible with desktop import/export if required.  
- Encryption at rest (SQLCipher or file-based encryption) if product policy requires.

### 4.3 Network / licence

- Implement client against **`licenseService.js`** contract: base URL, headers, error shapes, `forceRefresh`, cache intervals (`WEEK_MS`, 32-day rule from README).  
- Use **staging** Worker + test accounts before production.  
- Do **not** embed `LICENSE_API_SECRET` in release builds if desktop pattern forbids it; follow same rules as Electron.

### 4.4 UI / UX

- Navigation: bottom nav or drawer; map desktop “modules” to screens.  
- **Accessibility**: TalkBack, font scaling, contrast.  
- **Tablet**: responsive layouts if Weather supports them—match expectation.

### 4.5 Android platform

- **Min SDK / target SDK** aligned with Play policy (declare).  
- **Notifications** only if product has reminders (optional v1).  
- **Biometric app lock** (optional).  
- **Proguard / R8** rules for release; keep licence + model classes.

### 4.6 Release engineering

- Versioning: **semantic** version aligned with desktop **major.minor** where marketing wants parity; **build** number monotonic for Play.  
- Signing: Play App Signing; upload key management documented (`SECURITY-AND-SECRETS` pattern).  
- **Internal testing track** before production.

---

## 5. Explicit non-goals (default v1)

Unless product owner removes these:

- Feature parity with **every** obscure desktop report on day one.  
- Windows installer or Electron on Android.  
- Breaking existing **license_accounts** or D1 schema without migration plan.  
- Storing full business DB on RootRecord servers without a designed sync protocol.

---

## 6. Verification checklist (before “done”)

- [ ] Cold start offline: app opens, DB readable, no crash.  
- [ ] Login: same email/password as `rootrecord.info` test account; `/v1/me` happy path.  
- [ ] Entitlement refresh matches documented desktop rules (forced vs cached).  
- [ ] Upgrade path: old APK → new APK, schema migration applied.  
- [ ] Release APK on **public** repo; **no** secrets in artifact.  
- [ ] Privacy: data stays on device; network calls documented for store listing.

---

## 7. First sprint backlog (suggested)

1. Repo scaffold + Capacitor hello world + CI debug APK.  
2. SQLite open + empty schema + one CRUD screen.  
3. Licence login + token persistence + `/v1/me` display.  
4. One vertical slice (e.g. “clients” or “time entries”) end-to-end.  
5. Internal APK to GitHub **pre-release** + tester instructions.

---

## 8. Prompt text you can paste into an agent (minimal wrapper)

```
You are implementing RootRecord Business Manager for Android.

Constraints:
- Study the existing Android reference implementation (clone): https://github.com/RootRecord/rr-weather-manager-mobile — README, docs/, Capacitor frontend, Android Gradle, release flow. Public APK home (no source): https://github.com/RootRecord/rootrecord-weather-manager-mobile/releases
- Read Business Manager desktop behavior: https://github.com/RootRecord/rootrecord-business-manager-app — app/resources/app/ (README, docs/BM_EXPORT, docs/screenshots, licenseService.js, database paths).
- Mirror Weather’s process: private mobile source repo + public releases-only repo; React+Capacitor unless ADR says otherwise.
- Reuse existing Cloudflare APIs: license + primary workers; same URLs as rootrecord-sites-reference.env (monorepo) for non-secret values.
- Local-first SQLite on device; no new server-side product DB without an approved design.

Deliver: ADR, repo layout, schema port plan, licence client module, first vertical slice UI, CI debug APK, and public-repo release notes template.
```

---

## 9. Maintainer reminders

- Keep **desktop Windows** repo shipping independently; Android is a **sibling** product line.  
- Update **`rootrecord.info`** product pages only when Play/APK is real (coordinate with site maintainer).  
- BETA / earn integrations (if any) must match **app id** conventions used on Weather Android (`rootrecord_weather_manager_android` pattern)—define `rootrecord_business_manager_android` with backend before shipping.

---

*End of master prompt. Revise this file when ADR or Play scope changes.*
