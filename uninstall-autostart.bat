@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\windows-autostart.ps1" -Action uninstall %*
set EXIT_CODE=%errorlevel%

echo.
pause
exit /b %EXIT_CODE%
