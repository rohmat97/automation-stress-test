@echo off
cd /d "%~dp0"

echo Launching 100 separate PowerShell windows running index.js...

for /l %%i in (1,1,100) do (
    start powershell -NoExit -Command "node index.js"
)

echo 100 instances started.
