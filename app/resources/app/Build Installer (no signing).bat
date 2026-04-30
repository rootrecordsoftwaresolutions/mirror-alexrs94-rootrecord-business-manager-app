@echo off
setlocal EnableExtensions
cd /d "%~dp0"
echo Building Inno installer WITHOUT Microsoft / Azure signing...
call npm run build:installer
set ERR=%ERRORLEVEL%
if %ERR% neq 0 (
  echo Failed with exit code %ERR%.
  pause
  exit /b %ERR%
)
echo.
echo Output: build\output\Unsigned-Root Record Business Manager-Setup-*.exe and build\output\latest.yml
pause
exit /b 0
