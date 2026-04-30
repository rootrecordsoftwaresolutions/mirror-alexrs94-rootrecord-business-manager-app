@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo Publishing signed installer + latest.yml to GitHub...
echo Repo: RootRecord/rootrecord-business-manager-download
echo Requires: gh CLI authenticated ^(gh auth login^)
echo           Signed build from "Build Installer (signed).bat"
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish-github-release.ps1"
set ERR=%ERRORLEVEL%
if %ERR% neq 0 (
  echo Publish failed with exit code %ERR%.
  pause
  exit /b %ERR%
)
pause
exit /b 0
