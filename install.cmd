@echo off
rem JARVIS one-click install for Windows. Double-click it, or run it from a terminal.
rem Running it again later updates everything in place.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
echo.
pause
