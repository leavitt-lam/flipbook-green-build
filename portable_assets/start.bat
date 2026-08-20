@echo off
setlocal
cd /d "%~dp0"
if not exist "runtime\FlipbookForgeRuntime.exe" goto RUNTIME_MISSING
"runtime\FlipbookForgeRuntime.exe"
exit /b %errorlevel%

:RUNTIME_MISSING
echo [ERROR] Bundled runtime is incomplete.
echo Re-extract the full green package. No online installation will be attempted.
pause
exit /b 1
