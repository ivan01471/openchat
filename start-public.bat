@echo off
setlocal
echo Demarrage du serveur OpenChat...
cd /d "C:\Users\jacob\projects\openchat"
set "PATH=C:\Program Files\nodejs;%PATH%"
start "OpenChat Server" /b node server.js
timeout /t 2 >nul
echo Demarrage du tunnel public Localtunnel...
call npx --yes localtunnel --port 3000
