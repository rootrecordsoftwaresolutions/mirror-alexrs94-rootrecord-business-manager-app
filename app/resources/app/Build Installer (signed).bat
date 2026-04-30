@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo Building Inno installer WITH Azure Trusted Signing...
echo Requires: Azure signing script (see README): sibling ..\Root Record Business Manager old\, Homestead Manager\, etc., or set RR_SIGN_SCRIPT / RR_AZURE_SIGN_ROOT
echo           and artifact_signing_metadata.json (see classic build folder).
echo.
call npm run build:installer:signed
set ERR=%ERRORLEVEL%
if %ERR% neq 0 (
  echo Failed with exit code %ERR%.
  pause
  exit /b %ERR%
)
echo.
echo Signed output: build\output\Root Record Business Manager-Setup-*.exe and build\output\latest.yml
pause
exit /b 0
