# Releasing RootRecord Business Manager (V2)

Target download repo: **[RootRecord/rootrecord-business-manager-download](https://github.com/RootRecord/rootrecord-business-manager-download)** (installers + `latest.yml` for **electron-updater**).

## Before you build

1. **`package.json`** version is the release you want (e.g. **2.0.9**), or you will use the **patch-bump** signed build to advance it.
2. **`CHANGELOG.md`** at repo root matches what you are shipping.
3. **`README.md`** “Release notes” code block is updated for copy/paste to GitHub if you use it.

## Build & sign

**Azure script path:** `scripts/build-installer.cjs` resolves `build/sign_release_azure.ps1` from a **sibling** folder (`Root Record Business Manager`, **`Root Record Business Manager old`**, `Root Record Homestead Manager`) or from **`RR_SIGN_SCRIPT`** / **`RR_AZURE_SIGN_ROOT`**.

| Goal | Command |
|------|---------|
| Routine (bumps patch then builds) | **`Build Installer (signed).bat`** or **`npm run build:installer:signed`** |
| Version already set (no bump) | **`npm run build:installer:signed:no-bump`** |

Outputs (typical):

- **`build\output\Root Record Business Manager-Setup-{version}.exe`**
- **`build\output\latest.yml`** (checksum must match the **signed** EXE you upload)

## Publish to GitHub

1. Verify **Authenticode** on the installer: `Get-AuthenticodeSignature "build\output\Root Record Business Manager-Setup-*.exe"` → **Valid** (unless testing with script overrides).
2. Commit **`package.json`** / **`package-lock.json`** if the signed build changed them.
3. Run **`Publish Release to GitHub.bat`** or **`npm run release:publish-github`** (`gh auth login` required). The script creates **`v{version}`** if missing and uploads the **EXE** + **`latest.yml`**.

## Suggested GitHub release description (v2.0.9)

Copy/edit for the release body:

```markdown
## RootRecord Business Manager 2.0.9

### Fixed
- **Reporting timezone** — Program Settings → **Time zone (IANA)** is now applied correctly to dashboard and calendar windows (async settings read is awaited in timezone helpers; no more silent fallback to the wrong day boundary).

### Added
- **Guest mode banner** — When you continue without signing in, a clear banner explains restricted local use until you sign in.

**Installer:** `Root Record Business Manager-Setup-2.0.9.exe`  
**Auto-update:** `latest.yml` (must accompany the same signed EXE on this release).
```

Store builds update through **Partner Center**, not this GitHub channel.
