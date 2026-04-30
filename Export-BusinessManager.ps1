<#!
  Root Record Business Manager — copy the tree for backup, handoff, or agent (Emergent) context.

  Default profile **Lean** omits: `.git`, `node_modules`, folders named `output` (e.g. installer build output),
  and `RootRecordBusinessManager.exe` (huge; rebuild from source).

  Usage (run in this directory):
    .\Export-BusinessManager.ps1
    .\Export-BusinessManager.ps1 -Profile SourceOnly -OutputPath D:\rr-bm-src
    .\Export-BusinessManager.ps1 -Profile Fat     -OutputPath D:\rr-bm-full
    .\Export-BusinessManager.ps1 -WhatIf
#>
[CmdletBinding()]
param(
  [ValidateSet("Lean", "Fat", "SourceOnly")]
  [string] $Profile = "Lean",
  [string] $OutputPath = "",
  [string] $SourceRoot = "",
  [switch] $WhatIf
)

$ErrorActionPreference = "Stop"

if (-not $SourceRoot) { $SourceRoot = $PSScriptRoot }
$SourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path

if (-not $OutputPath) {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $OutputPath = Join-Path (Join-Path $env:USERPROFILE "Desktop") "rootrecord-bm-export-$stamp"
}
$OutputPath = $OutputPath.Trim()

$copyFrom = $SourceRoot
# Lean: smallest sensible handoff. Fat: include build/output and main exe; still skip git + node_modules.
$xd = @(".git", "node_modules", "output")
$xf = @("RootRecordBusinessManager.exe")
if ($Profile -eq "Fat") {
  $xd = @(".git", "node_modules")
  $xf = @()
}

if ($Profile -eq "SourceOnly") {
  $copyFrom = Join-Path $SourceRoot "app\resources\app"
  if (-not (Test-Path -LiteralPath $copyFrom)) {
    throw "SourceOnly expects tree under: $copyFrom"
  }
  $copyFrom = (Resolve-Path -LiteralPath $copyFrom).Path
  $xd = @("node_modules", "output")
  $xf = @()
}

if ($WhatIf) {
  Write-Host "Profile:     $Profile"
  Write-Host "Source:      $copyFrom"
  Write-Host "Destination: $OutputPath"
  Write-Host "Exclude dirs: $($xd -join ', ')"
  if ($xf.Count) { Write-Host "Exclude file: $($xf -join ', ')" }
  exit 0
}

if (Test-Path -LiteralPath $OutputPath) {
  throw "Output path already exists: $OutputPath`nRemove it or choose a new -OutputPath."
}
New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null

# robocopy: exit 0-7 = success, >=8 = failure
$robo = @(
  $copyFrom, $OutputPath, "/E",
  "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np"
)
$robo += "/XD"
$robo += $xd
if ($xf.Count -ge 1) {
  $robo += "/XF"
  $robo += $xf
}

& robocopy @robo
$exit = $LASTEXITCODE
if ($exit -ge 8) { throw "robocopy failed with exit code $exit" }

$desc = switch ($Profile) {
  "SourceOnly" { "Only app/resources/app (Electron app project). Excludes: node_modules, any folder named 'output'." }
  "Lean" { "Full product folder (README, Build-Installer, app/ tree). Excludes: .git, node_modules, 'output' folders, RootRecordBusinessManager.exe." }
  "Fat" { "Full product folder. Excludes only: .git, node_modules. Includes build/output and RootRecordBusinessManager.exe if present." }
}

$meta = @"
Root Record Business Manager — export
======================================
Generated: $(Get-Date -Format "o")
Profile:   $Profile

$desc

Prereqs to build (after copy)
-----------------------------
- Node LTS, npm. In app\resources\app:  npm install
- Inno Setup 6 (PATH), see app\resources\app\docs\RELEASE.md
- Optional: see EMERGENT_APP_VERSION.md, docs\BM_EXPORT.md
"@
$metaPath = Join-Path $OutputPath "EXPORT_README.txt"
Set-Content -LiteralPath $metaPath -Value $meta -Encoding UTF8
Write-Host "OK -> $OutputPath (robocopy exit $exit) EXPORT_README.txt written"
