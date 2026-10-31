@echo off
title BDO Balenciaga
echo Starting BDO Balenciaga...

if not exist ".env" (
  echo ERROR: .env file not found.
  echo Please copy .env.example to .env and fill in your values.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies for the first time...
  call npm install
  if errorlevel 1 (
    echo ERROR: npm install failed. Make sure Node.js is installed.
    pause
    exit /b 1
  )
)

rem Opens the desktop window (tray app). No restart loop: choosing Exit in the
rem tray must stay exited. Hosting ON/OFF is controlled from the window.
node src/main.js
