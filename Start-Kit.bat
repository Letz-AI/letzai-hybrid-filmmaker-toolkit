@echo off
rem LetzAI Hybrid Filmmaker Kit - Windows launcher. Double-click to start.
rem Optional: Start-Kit.bat --project "D:\Films\My film"   (opens that film directly)
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js 20 or newer is needed. Download it from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)
node server\index.js %*
if errorlevel 1 pause
