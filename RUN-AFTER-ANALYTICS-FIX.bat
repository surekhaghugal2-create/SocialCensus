@echo off
setlocal
cd /d "%~dp0"
echo.
echo [1/3] Installing/checking dependencies...
call npm install
if errorlevel 1 goto :fail

echo.
echo [2/3] Generating Prisma client and updating local database...
call npx prisma generate
if errorlevel 1 goto :fail
call npx prisma db push
if errorlevel 1 goto :fail

echo.
echo [3/3] Starting SocialCensus on http://localhost:3002 ...
call npm run dev
goto :eof

:fail
echo.
echo SocialCensus setup stopped because a command failed above.
pause
exit /b 1
