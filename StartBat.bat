@echo off
title ZradaLog Launcher
cd /d "D:\IDE\ZradaLog"

echo Clearing screen...
cls

echo Building Electron...
call npm run build:electron
if %errorlevel% neq 0 (
    echo Build failed! Exiting.
    pause
    exit /b %errorlevel%
)

echo Starting dev server...
call npm run dev

pause