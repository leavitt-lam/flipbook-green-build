@echo off
setlocal EnableExtensions
cd /d "%~dp0"
if not exist "tool_update.zip" goto UPDATE_MISSING
if exist "tool.backup" rmdir /s /q "tool.backup"
if exist "tool" move /y "tool" "tool.backup" >nul
mkdir "tool"
powershell -NoProfile -Command "Expand-Archive -LiteralPath 'tool_update.zip' -DestinationPath 'tool' -Force"
if errorlevel 1 goto UPDATE_FAILED
echo Tool updated. The runtime folder was not changed.
pause
exit /b 0

:UPDATE_MISSING
echo Put tool_update.zip beside this script, then run again.
pause
exit /b 1

:UPDATE_FAILED
rmdir /s /q "tool"
if exist "tool.backup" move /y "tool.backup" "tool" >nul
echo Update failed. The previous tool folder was restored.
pause
exit /b 1
