# RootRecord Business Manager (V2)

Desktop app for local business data, time tracking, and finance tools (**Electron** + **SQLite**) with online license sign-in. **Default install directory** (Inno Setup **`{autopf}\RootRecord\Business Manager`**): on a typical PC with Windows on **C:**, that is **`C:\Program Files\RootRecord\Business Manager`**. The drive and “Program Files” folder follow the machine (not hardcoded to **C:**). Main executable: **`RootRecordBusinessManager.exe`**. App data root: **`%USERPROFILE%\RootRecord\Business Manager`** (license/session JSON, device id, feedback queue). Business database and related files: **`%USERPROFILE%\RootRecord\Business Manager\business_data`** (SQLite, `machine_session.json`, `users\`, backups). Override with **`RR_BUSINESS_MANAGER_HOME`** or **`ROOTRECORD_HOME`**; **`SQLITE_PATH`** for a custom database file path.

**Changelog:** [CHANGELOG.md](./CHANGELOG.md) · **Export / full agent context:** [docs/BM_EXPORT.md](./docs/BM_EXPORT.md)

## Current release line: 2.x

**Package version:** **2.0.12** (`package.json`). Unsigned Inno output: **`Unsigned-Root Record Business Manager-Setup-2.0.12.exe`**. After Azure signing, the shipped name matches **`Root Record Business Manager-Setup-{version}.exe`** (see **`docs/RELEASE.md`**).

**Building this tree:** from **`app/resources/app`**, run **`npm run build:installer`** (needs **Inno Setup 6**). From the app’s work folder, run **`Build-Installer.bat`** (see **`apps/root-record-business-manager/Build-Installer.bat`**). Patch bump: **`npm run bump:patch`** then build. **`build:installer:signed`** / **`build:installer:signed:no-bump`** currently run the same unsigned pipeline; wire **`sign_release_azure.ps1`** separately when you ship signed bits.

### Release notes (2.0.9) — copy for GitHub / “What’s new”

Use (and trim) when you publish **`v2.0.9`**:

```text
RootRecord Business Manager 2.0.9

Fixed — Reporting timezone: Dashboard, “today” / period totals, and default date fields now honor Program Settings → Time zone (IANA) correctly. Calendar midnight-to-midnight boundaries no longer silently followed the wrong clock when a specific zone was set.

Added — Guest mode: if you continue without signing in, a red banner explains the restricted local session (account sync and cloud backup stay off until you sign in).

Local data: business files live under %USERPROFILE%\RootRecord\Business Manager\business_data (SQLite, machine session, users, backups). License/session JSON stays in the Business Manager folder.

DELETE ALL DATA: wipes business_data and the feedback queue only — not your sign-in / license files.

Windows (GitHub): signed installer Root Record Business Manager-Setup-{version}.exe + latest.yml on Releases. Microsoft Store builds update through the Store, not GitHub.

Windows install folder (wizard default): Program Files\RootRecord\Business Manager (Inno: {autopf}\RootRecord\Business Manager; drive follows the machine).
```

### GitHub Releases & auto-update

Maintainer checklist and copy-paste release text: **[docs/RELEASE.md](./docs/RELEASE.md)**.

Official Windows installers and **`latest.yml`** (electron-updater metadata) are published here:

**[github.com/RootRecord/rootrecord-business-manager-download/releases](https://github.com/RootRecord/rootrecord-business-manager-download/releases)**

The in-app updater pulls from that repository (`build/app-update.yml` → packaged `resources/app-update.yml`). **Microsoft Store** installs use Store updates instead of GitHub.

### Microsoft Store

Public listing (**same product ID as the legacy app**):

**[RootRecord Business Manager on Microsoft Store](https://apps.microsoft.com/detail/xp9k0bcs18g16p?hl=en-US&gl=US)** (`xp9k0bcs18g16p`)

Partner Center uploads are **not** automated from GitHub; use **`docs/partner-center-store-update-checklist.md`** when submitting **Business Manager V2**. Compliance notes: **`docs/microsoft-store-and-sac-compliance-review.md`**.

### Signing & Smart App Control

Production installers are **Authenticode-signed** with **Azure Trusted Signing** via a sibling repo’s **`build/sign_release_azure.ps1`** (same script tree as classic Business Manager). The signed build searches, in order: **`RR_SIGN_SCRIPT`** (full path to the `.ps1`), **`RR_AZURE_SIGN_ROOT`** / **`RR_SIGN_REPO_ROOT`** (repo root that contains **`build/`**), then **`../Root Record Business Manager`**, **`../Root Record Business Manager old`**, **`../Root Record Homestead Manager`**. Signing covers the **installer** and **all PE binaries** shipped in the packaged app (`exe`, `dll`, `.node`), which is required for sensible behavior under **Smart App Control** and modern Windows defaults.

### Subscription and entitlement refresh

For **signed-in** users, the app **caches** the result of the last **entitlement** call to the license API. The default **stale** interval is **7 days** (see `WEEK_MS` in `src/main/licenseService.js`). **Pro (paid) users:** the first time the app sees an active subscription for an email, it records a timestamp in **`license_pro_first_paid.json`** (user data). For **32 days** after that anchor, routine `license-prepare` does **not** call the API (treats entitlement as still fresh), except when **force refresh** runs. After that window, the **7-day** rule applies again. This does not remove the need to sign in with a valid session token; it only skips periodic online entitlement refreshes.

**When the UI forces a fresh entitlement check** (same session, no need to wait 7 days):

| Trigger | Behavior |
|--------|----------|
| **Open Account Settings** | Calls `licensePrepare({ forceRefresh: true })` so membership / Pro labels match the server immediately. |
| **Return from “Upgrade to Pro”** | After the external checkout URL opens in the browser, when the app window **regains focus** once, a **one-time** forced refresh updates Pro-related UI (and reloads Account Settings if that panel is active). |

**IPC / internals:** The `license-prepare` handler accepts an optional payload **`{ forceRefresh: true }`**; preload passes it through from `rootRecord.licensePrepare(...)`.

---

## Requirements (development)

| Requirement | Purpose |
|-------------|---------|
| **Node.js** (LTS) + **npm** | Dependencies and scripts |
| **Windows** | Installer and signing workflow below |
| **Inno Setup 6** (`ISCC.exe`) | Compile `build/installer.iss` |
| **Signing repo** next to V2 (see Azure row above) | **`build/sign_release_azure.ps1`**, **`build/artifact_signing_metadata.json`** (or env override) |
| **`gh` (GitHub CLI)** + **`gh auth login`** | **`npm run release:publish-github`** |

Optional: Windows SDK **signtool.exe** (x64), Azure Artifact Signing prerequisites as documented in `sign_release_azure.ps1`.

---

## Scripts

| Command | Description |
|--------|-------------|
| `npm install` | Install dependencies |
| `npm start` | Run the app |
| `npm run dev` | Run with developer tools (`--dev`) |
| `npm run dist:win` | Package Windows app only → `dist\RootRecordBusinessManager-win32-x64\` |
| `npm run build:installer` | Package + Inno installer **without** Authenticode signing |
| `npm run build:installer:signed` | Same as **`build:installer`** in this workspace (unsigned Inno + **`latest.yml`**); use **`npm run bump:patch`** first when you want a routine patch bump |
| `npm run build:installer:signed:no-bump` | Alias of **`build:installer`** (kept for older docs / muscle memory) |
| `npm run bump:patch` | Increments **`package.json`** patch segment by **1** |
| `npm run write:latest-yml` | Regenerate `latest.yml` beside an installer (full signed build runs this twice: before and after signing) |
| `npm run release:publish-github` | Upload **`Root Record Business Manager-Setup-{version}.exe`** + **`latest.yml`** to **`RootRecord/rootrecord-business-manager-download`** (needs **`gh`**) |

### Batch shortcuts (folder root)

| Batch file | Runs |
|------------|------|
| **`..\Build-Installer.bat`** (from **`apps/root-record-business-manager/`**) | `cd app\resources\app` then **`npm run build:installer`** (unsigned Inno + **`latest.yml`**) |
| **`Build Installer (no signing).bat`** | `npm run build:installer` → **`Unsigned-Root Record Business Manager-Setup-{version}.exe`** |
| **`Build Installer (signed).bat`** | `npm run build:installer:signed` (same unsigned pipeline in this workspace; Authenticode is still a separate step — **`docs/RELEASE.md`**) |
| **`Publish Release to GitHub.bat`** | Same as **`npm run release:publish-github`** |

Use **`npm run bump:patch`** when you want a one-line version bump before **`Build Installer (signed).bat`** or **`npm run build:installer`**.

---

## Publishing a GitHub release (maintainers)

Follow this order so **`latest.yml`** SHA512 matches the **signed** installer users download.

1. Commit and push app changes to **`RootRecord/rootrecord-business-manager-download`** on the branch you release from (`main` or release branch). Set **`package.json`** to the version you intend to ship (or run **`npm run bump:patch`** first).
2. Produce the installer and **`latest.yml`**:
   - **`Build Installer (no signing).bat`** or **`npm run build:installer`** → unsigned **`Unsigned-Root Record Business Manager-Setup-{version}.exe`** plus **`latest.yml`** in **`build/output/`**.
   - **Authenticode:** run your existing **`sign_release_azure.ps1`** flow (see **`docs/RELEASE.md`**) on the machine that has the sibling signing repo; this workspace does not invoke Azure by itself.
   Outputs (unsigned step): **`build\output\Unsigned-Root Record Business Manager-Setup-{version}.exe`**, **`build\output\latest.yml`**. After signing and renaming per your release process, the public name is **`Root Record Business Manager-Setup-{version}.exe`**.
3. Commit and push **`package.json`** / **`package-lock.json`** if the signed build updated them (routine bump). With **no-bump**, they should already match the target version — still commit any other release-related changes.
4. Optional: `Get-AuthenticodeSignature "build\output\Root Record Business Manager-Setup-*.exe"` → **Valid**.
5. Run **`Publish Release to GitHub.bat`** or **`npm run release:publish-github`** ( **`gh auth login`** required ). The script refuses an unsigned installer unless **`-SkipSignatureCheck`** is used (local testing only).
6. Existing installs from **GitHub** check for updates shortly after startup; **Store** installs ignore this channel.

**Release automation note:** **`scripts/publish-github-release.ps1`** targets **`RootRecord/rootrecord-business-manager-download`** and creates/tags **`v{version}`**.

---

## Build troubleshooting

| Issue | What to do |
|-------|------------|
| **`EBUSY` renaming `dist\RootRecordBusinessManager-win32-x64`** | Quit **`RootRecordBusinessManager.exe`** if it was launched **from `dist`**, close File Explorer under **`dist`**, retry. The build script retries rename, then deletes the folder in place. |
| **Signing: `ExtraFiles` / parameter binding** | Use current **`build-installer.cjs`**: paths are passed via **`-ExtraFilesListPath`** (temp line-list file) to **`sign_release_azure.ps1`** — required for PowerShell 5.1. |
| **`rootRecord is not defined` at startup** | Preload must expose the bridge even if **jsPDF** fails to load; use current **`preload.js`**. **Rebuild** after pulling changes. |
| **Prepare / login errors** | **`license-prepare`** returns plain JSON over IPC; use current **`main.js`** handler if startup errors look like IPC clone failures. |

---

## Build outputs

| Artifact | Location |
|----------|----------|
| Packaged app | `dist\RootRecordBusinessManager-win32-x64\` |
| Unsigned installer | `build\output\Unsigned-Root Record Business Manager-Setup-{version}.exe` |
| Signed installer | `build\output\Root Record Business Manager-Setup-{version}.exe` |
| Update metadata | `build\output\latest.yml` — **SHA512 for the signed installer** (attach alongside the same `.exe` on GitHub) |

---

## Brand assets (from classic Business Manager)

| Location | Purpose |
|----------|---------|
| **`assets/favicon.ico`** | Window / taskbar + Inno |
| **`assets/about_panel_default.png`** | About panel |
| **`build/branding/*.bmp`, `*.png`** | Inno wizard art |
| **`src/renderer/assets/`** | UI copies (`brand-logo.png`, etc.) |

---

## Environment

| Variable | Purpose |
|----------|---------|
| **`LICENSE_PAYMENT_LINK_URL`** | Optional Stripe Payment Link override for **Upgrade to Pro** |
| **`LICENSE_API_BASE_URL`** | Optional licence / entitlement API base URL |
| **`RR_BUSINESS_MANAGER_HOME`** | Override local app data root |
| **`ROOTRECORD_HOME`** | Data under **`{ROOTRECORD_HOME}\Business Manager`** |

---

## Uninstall

- Uninstaller removes files under the install directory (default **`Program Files\RootRecord\Business Manager`**, typically **`C:\Program Files\RootRecord\Business Manager`** on a standard **C:** system). User data under **`%USERPROFILE%\RootRecord\...`** remains unless you delete it manually.
- If uninstall reports items left behind, ensure the app is closed and retry, or remove leftover files once handles are released.

---

## License

Private / **UNLICENSED** unless otherwise stated in **`package.json`**.
