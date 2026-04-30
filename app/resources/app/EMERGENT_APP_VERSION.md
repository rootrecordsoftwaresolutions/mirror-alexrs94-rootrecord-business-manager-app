# Business Manager — how to ship an app version (for agents)

Work **only** under this folder: `app/resources/app/` (this file’s directory). Do not touch other repos, `credentials.env`, or unrelated projects.

**Full tree / export / “what is this layout?”** → see **`docs/BM_EXPORT.md`**. **Export script:** from the folder that contains `Build-Installer.bat` (the `root-record-business-manager` directory), run **`.\Export-BusinessManager.ps1`** in PowerShell (from this file: `..\..\Export-BusinessManager.ps1`).

## 1. Version number

- **Source of truth:** `package.json` → field **`version`** (semver, e.g. `2.0.12`).
- Optional patch bump: from this directory, run **`npm run bump:patch`** (updates `package.json` + `package-lock.json` via `scripts/bump-patch.cjs`).

## 2. Changelog

- Update **`CHANGELOG.md`** here with user-facing notes for the new version.

## 3. Build the Windows installer

- **Prereq:** Node deps (`npm install`), **Inno Setup 6** on PATH (see `README.md` in this folder).
- From **`app/resources/app/`**:
  - Unsigned installer + `latest.yml`: **`npm run build:installer`**
  - Signed / release pipeline (bump behavior per script): **`npm run build:installer:signed`** or **`npm run build:installer:signed:no-bump`**
- Outputs: under **`build/output/`** (installer name includes version; see `docs/RELEASE.md`).

## 4. Publish (optional)

- GitHub Releases + `latest.yml` for auto-update: **`npm run release:publish-github`** (needs `gh` CLI, auth). Target repo is documented in `package.json` `repository` and `docs/RELEASE.md`.
- Do **not** invent API URLs or env files; licence base URL is already set in `src/main/licenseService.js` unless the product owner says otherwise.

## 5. More detail

- Full release checklist: **`docs/RELEASE.md`**
- High-level product + paths: **`README.md`** (this `app/resources/app` tree)

That’s the whole loop: **set version → changelog → build → (optional) publish.**
