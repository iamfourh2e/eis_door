@echo off
setlocal enabledelayedexpansion

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [doorwatch] Node.js 22.13+ is required. Download it from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [doorwatch] Installing npm dependencies...
  call npm ci --ignore-scripts --no-audit --no-fund
  if errorlevel 1 (
    echo [doorwatch] npm install failed.
    pause
    exit /b 1
  )
)

if not exist ".env" (
  if exist ".env.example" (
    echo [doorwatch] Creating .env from .env.example...
    copy /y ".env.example" ".env" >nul
    echo [doorwatch] Review .env and update ADMIN_PASSWORD / ZKBIO settings as needed.
  )
)

node scripts/start-windows.mjs %*
set EXIT_CODE=%errorlevel%

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [doorwatch] Server stopped with exit code %EXIT_CODE%.
  pause
)

exit /b %EXIT_CODE%
