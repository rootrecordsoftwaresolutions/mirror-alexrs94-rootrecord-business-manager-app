# Root Record Business Manager

Recovered from `Root.Record.Business.Manager-Setup-2.0.12.exe` (Inno Setup).

## Export this product (zip / handoff / agent context)

From this directory, run **`.\Export-BusinessManager.ps1`** (PowerShell). Defaults to a **Lean** copy on the Desktop (drops `node_modules`, build `output`, main `.exe`, and `.git`). See **`app/resources/app/docs/BM_EXPORT.md`** for profiles (**Lean** / **Fat** / **SourceOnly**) and the full reading list for tools like Emergent.

## Layout

- **`app/`** — Directory install produced by a silent Inno run (treat as a portable install tree).
- **`app/resources/app/`** — Application payload: `package.json`, `src/`, `assets/`, bundled `node_modules/`, and build scripts. Use this as the starting point when rebuilding a clean dev tree next to the workspace `scripts/` and shared `.env` conventions.

The workspace installer copy lives at:

`../../Root.Record.Business.Manager-Setup-2.0.12.exe`

## Re-run silent extract (same machine)

If you need to refresh `app/` from the installer (for example after clearing the folder), from PowerShell:

```powershell
$exe = "..\..\Root.Record.Business.Manager-Setup-2.0.12.exe"
$dest = Join-Path $PWD "app"
Remove-Item -LiteralPath $dest -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Unblock-File -LiteralPath (Resolve-Path $exe)
Start-Process -FilePath (Resolve-Path $exe) -ArgumentList "/VERYSILENT","/SUPPRESSMSGBOXES","/NORESTART","/SP-","/DIR=$dest" -Wait
```

Adjust paths if you run the script from another working directory.
