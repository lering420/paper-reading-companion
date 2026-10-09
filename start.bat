@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Paper Reader - Lun Wen Ban Du
if exist "runtime\win-x64\node.exe" goto :bundled
where node >nul 2>nul
if %errorlevel%==0 goto :system
goto :nonode
:bundled
"runtime\win-x64\node.exe" "app\server.js"
goto :end
:system
node "app\server.js"
goto :end
:nonode
echo.
echo  [ERROR] Node.js runtime not found.
echo  Make sure the whole app folder is complete (it should contain the runtime folder),
echo  or install Node.js and try again.
echo.
pause
exit /b 1
:end
echo.
echo  Program exited. Double-click start.bat to start again.
pause
