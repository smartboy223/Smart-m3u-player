@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required. Install it from https://nodejs.org/
  pause
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0])<20)process.exit(1)" >nul 2>nul
if errorlevel 1 (
  echo Please update Node.js to version 20 or newer from https://nodejs.org/
  pause
  exit /b 1
)
node -e "require.resolve('hls.js');require.resolve('iptv-playlist-parser');require('node:fs').accessSync(require('ffmpeg-static'));require('node:fs').accessSync(require('ffprobe-static').path)" >nul 2>nul
if errorlevel 1 (
  echo Preparing the player and media tools. First setup needs internet access.
  call npm ci --no-audit --no-fund
  if errorlevel 1 (
    echo Setup failed. Check your internet connection and run start.bat again.
    pause
    exit /b 1
  )
)
echo Starting SignalDeck...
echo Keep this window open while using the player. Press Ctrl+C to stop it.
node server.js --open
if errorlevel 1 pause
