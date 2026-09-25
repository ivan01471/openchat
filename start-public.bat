@echo off
REM ============================================================
REM  OpenChat - Lancement public automatique (Windows)
REM  1. Demarre le serveur Node sur le port 3000
REM  2. Ouvre un tunnel public HTTPS/WSS via Cloudflare (gratuit,
REM     sans mot de passe, sans compte)
REM  Alternative si Cloudflare est bloque : Localtunnel (lt)
REM ============================================================
setlocal
cd /d "C:\Users\jacob\projects\openchat"
set "PATH=C:\Program Files\nodejs;%PATH%"
where cloudflared >nul 2>&1
if %errorlevel%==0 goto :cloudflare

echo [OpenChat] cloudflared introuvable, utilisation de Localtunnel...
echo Demarrage du serveur OpenChat...
start "OpenChat Server" /min node server.js
timeout /t 2 >nul
echo Demarrage du tunnel public Localtunnel...
call npx --yes localtunnel --port 3000
goto :eof

:cloudflare
echo [OpenChat] Lancement du serveur (port 3000)...
start "OpenChat Server" /min node server.js
timeout /t 2 >nul
echo [OpenChat] Ouverture du tunnel public Cloudflare Quick Tunnel...
echo [OpenChat] Ton URL publique https://...trycloudflare.com va s'afficher ci-dessous :
cloudflared tunnel --url http://localhost:3000
