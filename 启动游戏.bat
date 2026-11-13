@echo off
rem Rhythm4K launcher - portable, everything relative to this folder.
rem NOTE: no parenthesised blocks on purpose. A variable containing "(x86)"
rem       would close the block early and break parsing.
setlocal
set "ROOT=%~dp0"
set "HTML=%ROOT%www\index.html"
if not exist "%HTML%" goto :nohtml
set "URL=file:///%HTML:\=/%"
set "PROFILE=%LocalAppData%\Rhythm4K\profile"
if not exist "%PROFILE%" mkdir "%PROFILE%" >nul 2>&1

set "BROWSER="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%LocalAppData%\Microsoft\Edge\Application\msedge.exe" set "BROWSER=%LocalAppData%\Microsoft\Edge\Application\msedge.exe"
if not defined BROWSER if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not defined BROWSER if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"

echo %date% %time% launching > "%ROOT%launch.log"
if not defined BROWSER goto :fallback
echo browser=%BROWSER% >> "%ROOT%launch.log"
rem --user-data-dir keeps the game away from the browser profile you use every day
start "" "%BROWSER%" --app="%URL%" --user-data-dir="%PROFILE%" --window-size=1920,1080 --start-fullscreen --no-first-run --no-default-browser-check --allow-file-access-from-files
exit /b 0

:fallback
echo fallback=default-browser >> "%ROOT%launch.log"
rem No Edge/Chrome: let whatever opens .html handle it (still playable, just has an address bar)
start "" "%HTML%"
exit /b 0

:nohtml
echo.
echo   [Rhythm4K] Cannot find www\index.html next to this file.
echo   Make sure you unzipped the whole package, not just the .bat.
echo.
pause
exit /b 1
