@echo off
cd /d "%~dp0"
where wt >nul 2>nul
if %ERRORLEVEL% equ 0 (
    wt -d "%~dp0." powershell -NoExit -Command "node index.js" ; new-tab -d "%~dp0." powershell -NoExit -Command "node index.js" ; new-tab -d "%~dp0." powershell -NoExit -Command "node index.js" ; new-tab -d "%~dp0." powershell -NoExit -Command "node index.js" ; new-tab -d "%~dp0." powershell -NoExit -Command "node index.js"
) else (
    echo Windows Terminal wt not found. Opening 5 separate PowerShell windows instead.
    start powershell -NoExit -Command "node index.js"
    start powershell -NoExit -Command "node index.js"
    start powershell -NoExit -Command "node index.js"
    start powershell -NoExit -Command "node index.js"
    start powershell -NoExit -Command "node index.js"
    
)
