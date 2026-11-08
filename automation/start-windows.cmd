@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found. Install Node.js and try again.
  pause
  exit /b 1
)
if not exist "node_modules\playwright" (
  call npm.cmd install
  if errorlevel 1 (pause & exit /b 1)
)
node src\app.mjs
if errorlevel 1 pause
