@echo off
chcp 65001 >nul
title AutoQC Studio
cd /d "%~dp0"
echo [AutoQC Studio] Checking packages (first run: 1-2 min)...
call npm install --no-audit --no-fund --loglevel=error
if errorlevel 1 (
  echo Install failed. Check your internet connection and Node.js.
  pause
  exit /b 1
)
echo [AutoQC Studio] Closing any previous AutoQC Studio server on port 5178...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5178" ^| findstr "LISTENING"') do taskkill /F /PID %%a >nul 2>&1
echo [AutoQC Studio] Starting... the browser will open automatically.
call npm start
pause
