@echo off
setlocal EnableExtensions
cd /d "%~dp0app\resources\app"
echo Root Record Business Manager — building unsigned installer (Inno)...
echo Working directory: %CD%
call npm run build:installer
set ERR=%ERRORLEVEL%
if %ERR% neq 0 (
  echo Failed with exit code %ERR%.
  exit /b %ERR%
)
echo.
echo Output: app\resources\app\build\output\Unsigned-Root Record Business Manager-Setup-*.exe and latest.yml
exit /b 0
