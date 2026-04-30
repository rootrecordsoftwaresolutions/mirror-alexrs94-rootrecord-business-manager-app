# Business Manager — full extract & context for agents (Emergent / humans)

This app is **RootRecord Business Manager v2** (Electron + SQLite + licence sign-in). The **authoritative dev root** is this directory: `app/resources/app/` (where `package.json` and `src/` live).

## What “the product” is (two layers)

| Layer | Path (under `…/root-record-business-manager/`) | Role |
|--------|-----------------------------------------------|------|
| **Install / runtime shell** | `app/` | Recovery/packaged layout: Electron bits, `locales/*.pak`, `resources/`, etc. Treat as “what ships next to the installer,” not always rebuilt from npm. |
| **Application project** | `app/resources/app/` | **Build this:** `package.json`, `src/`, `scripts/`, `build/installer.iss`, `docs/`. Run `npm install` and `npm run build:installer` here. |

Agents should **change code under `app/resources/app/`** for features and releases. The parent `README.md` (repo root of this app folder) explains the recovered `app/` layout.

## One-command export (Windows)

From `root-record-business-manager/` (next to `Build-Installer.bat`):

```powershell
.\Export-BusinessManager.ps1
```

| Profile | Use | Skips |
|--------|-----|--------|
| **Lean** (default) | Handoff / git / agents; smaller zip | `.git`, `node_modules`, any dir named `output`, `RootRecordBusinessManager.exe` |
| **Fat** | Full disk snapshot including last installer output + main exe | Only `.git` and `node_modules` |
| **SourceOnly** | Only the npm project (this `app/resources/app` tree) | `node_modules`, `output` dirs |

Destination defaults to `Desktop\rootrecord-bm-export-<timestamp>`. Use `-OutputPath` to set a folder. Each export includes **`EXPORT_README.txt`** at the destination.

## UI screenshots

See **`screenshots/`** in this `docs/` folder (`photo_*.jpg`) for visual context of the shipped app.

## Android port (Weather-style)

Extensive briefing + agent-ready prompt: **`ANDROID_PORT_MASTER_PROMPT.md`** in this folder.

## Reading order (maximum context, minimum thrash)

1. **`../EMERGENT_APP_VERSION.md`** — version bump → build → optional GitHub release.
2. **`README.md`** (this `app/resources/app` folder) — paths, env, install locations, links to Microsoft Store / GitHub Releases.
3. **`RELEASE.md`** (this folder) — signed build, Azure signing script resolution, `latest.yml`, `gh` release.
4. **`CHANGELOG.md`** — what changed per version.
5. **`package.json`** — `version`, `scripts`, `repository` (download releases repo).
6. **`src/main.js`**, **`src/main/licenseService.js`**, **`src/main/paths.js`** — process model, licence API base, data paths.
7. **`build/installer.iss`** — Inno Setup; **`scripts/build-installer.cjs`** — pipeline.

## Build prerequisites (short)

- **Node** + `npm install` in **`app/resources/app/`**
- **Inno Setup 6** on PATH (installer)
- **Optional:** Authenticode signing per `RELEASE.md` (`RR_SIGN_SCRIPT` / `RR_AZURE_SIGN_ROOT` or sibling signing repo)

## What not to invent

- **Licence / billing API** base: shipped default in `src/main/licenseService.js` (override with `LICENSE_API_BASE_URL` for dev only).
- **Do not** point agents at monorepo `credentials.env` unless the operator pastes values; use product docs and env *names* only.

## Repo layout note

This tree may exist **inside a larger monorepo** or as **its own git repo** (`rootrecord-business-manager-app`). The export script and this doc are the same either way; only the path to `Export-BusinessManager.ps1` changes (one level above `app/resources/app`).
