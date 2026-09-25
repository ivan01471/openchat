@echo off
REM ============================================================
REM  OSINT FREE TOOLS - Menu de lancement (Windows)
REM  Ouvre ce fichier en double-clic.
REM ============================================================
setlocal
set "PY=C:\Program Files\Python312\python.exe"
set "PYSCRIPTS=%APPDATA%\Python\Python312\Scripts"
set "TOOLS=%USERPROFILE%\tools"
cd /d "%TOOLS%"

:menu
cls
echo ===================================================
echo    OSINT gratuit - Menu principal
echo ===================================================
echo  1) Sherlock        - pseudo sur 400+ reseaux sociaux
echo  2) Maigret         - pseudo sur 3000+ sites (plus complet)
echo  3) theHarvester    - emails, sous-domaines, gens (cible = domaine)
echo  4) PhoneInfoga     - infos sur un numero de telephone
echo  5) SpiderFoot      - scan OSINT automatise (200+ modules, web)
echo  6) TruecallerJS    - nom du proprietaire d'un numero (login requis)
echo  0) Quitter
echo ===================================================
set /p CHOIX=Choisis une option (0-6) : 

if "%CHOIX%"=="1" (
  set /p USER=Pseudo a chercher : 
  "%PY%" -m sherlock_project "%USER%" --print-found --no-color
  goto fin
)
if "%CHOIX%"=="2" (
  set /p USER=Pseudo a chercher : 
  "%PYSCRIPTS%\maigret.exe" "%USER%" --no-color
  goto fin
)
if "%CHOIX%"=="3" (
  set /p DOM=Domaine cible (ex: example.com) : 
  "C:\Python314\Scripts\theHarvester.exe" -d %DOM% -l 50 -b all
  goto fin
)
if "%CHOIX%"=="4" (
  set /p NUM=Numero au format international (ex: +33612345678) : 
  "%TOOLS%\phoneinfoga.exe" scan -n %NUM%
  goto fin
)
if "%CHOIX%"=="5" (
  echo Interface web SpiderFoot sur http://localhost:5001
  "%PY%" "%TOOLS%\spiderfoot\sf.py" -l 127.0.0.1:5001
  goto fin
)
if "%CHOIX%"=="6" (
  call "%APPDATA%\npm\truecallerjs.cmd" -s
  goto fin
)
if "%CHOIX%"=="0" goto :eof
goto menu

:fin
echo.
pause