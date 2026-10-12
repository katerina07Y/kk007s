@echo off
setlocal
cd /d "%~dp0"

REM First-run setup: create .env and open it before checking Node.js.
if not exist ".env" (
  if not exist ".env.example" (
    echo ERROR: .env.example was not found in this folder.
    echo Please extract the complete ASSEMBLE_Live_Agent.zip first.
    pause
    exit /b 1
  )
  copy ".env.example" ".env" >nul
  if errorlevel 1 (
    echo ERROR: Could not create .env. Check that this folder is writable.
    pause
    exit /b 1
  )
  echo Created .env from .env.example.
  echo Please add your OPENAI_API_KEY in Notepad, save, close Notepad, then run start.bat again.
  start "" notepad.exe "%CD%\.env"
  pause
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Please install Node.js 22 LTS, then run start.bat again.
  echo https://nodejs.org/
  pause
  exit /b 1
)

echo Starting ASSEMBLE Live Agent...
node server.js
pause
