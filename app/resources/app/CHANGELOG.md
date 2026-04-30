# Changelog

All published Windows installers and `latest.yml` files live on **[GitHub Releases — RootRecord/rootrecord-business-manager-download](https://github.com/RootRecord/rootrecord-business-manager-download/releases)**.

---

## [2.0.12] - 2026-04-25

### Changed

- **Version** — Installer and `package.json` line set to **2.0.12** for the next Windows build. Workspace adds **`scripts/build-windows.cjs`**, **`scripts/build-installer.cjs`**, **`build/installer.iss`**, and **`Build-Installer.bat`** (one folder up from `app/resources/app/`) so unsigned Inno builds run from this tree when **Inno Setup 6** is installed.

---

## [2.0.9] - 2026-04-24

### Fixed

- **Reporting timezone** — Dashboard, “today” / period totals, custom day picker defaults, and other logic that uses **Program Settings → Time zone (IANA)** now **awaits** the async settings read. Previously the timezone module treated a **Promise** as the zone name, so boundaries often fell back to the **OS clock** and **calendar days could be wrong** (for example large hour totals just after local midnight).

### Added

- **Guest mode banner** — If you open the app **without signing in** (continue as local-only guest), a **red banner** at the top states that the session is restricted and that account sync / online backup stay off until you sign in.

### Documentation

- README and this changelog updated for the **2.0.9** release line.

---

## Earlier versions

See **[GitHub Releases](https://github.com/RootRecord/rootrecord-business-manager-download/releases)** for installers, `latest.yml`, and per-tag notes.
