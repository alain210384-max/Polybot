@echo off
title POLYBOT
color 0A
echo.
echo  ╔══════════════════════════════════╗
echo  ║     🤖 POLYBOT INICIANDO...      ║
echo  ╚══════════════════════════════════╝
echo.
cd /d "%~dp0"
echo  Instalando dependencias...
call npm install --silent
echo.
echo  ✅ Iniciando bot...
echo  📊 Dashboard: http://localhost:3002
echo.
start "" /min cmd /c "timeout /t 4 >nul & start http://localhost:3002"
node server.js
pause
