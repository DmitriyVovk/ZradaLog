@echo off
setlocal

net session >nul 2>&1
if errorlevel 1 (
  echo Run this script as Administrator.
  pause
  exit /b 1
)

echo Restoring SOLIDWORKS Electrical SQL services to automatic startup...

sc config "MSSQL$TEW_SQLEXPRESS" start= delayed-auto
sc config "SQLBrowser" start= auto
sc config "SQLTELEMETRY$TEW_SQLEXPRESS" start= delayed-auto

echo.
echo SQLWriter is left unchanged.
echo Done.
pause
