@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo        SOCIAL CENSUS - LOCAL START
 echo ========================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed.
  echo Install Node.js 22 LTS, then run this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing packages for the first time...
  call npm install
  if errorlevel 1 (
    echo.
    echo npm install failed. Please check the error above.
    pause
    exit /b 1
  )
)
echo.
echo Starting Social Census at http://localhost:3002
echo Keep this window open while using the app.
echo.
start "" "http://localhost:3002"
call npm run dev
pause
