@echo off
setlocal

net session >nul 2>&1
if errorlevel 1 (
  echo Run this script as Administrator.
  pause
  exit /b 1
)

echo Setting SOLIDWORKS Electrical SQL services to manual startup...

sc config "MSSQL$TEW_SQLEXPRESS" start= demand
sc config "SQLBrowser" start= demand
sc config "SQLTELEMETRY$TEW_SQLEXPRESS" start= demand

echo.
echo SQLWriter is left unchanged.
echo SQLAgent$TEW_SQLEXPRESS is already stopped/disabled on this machine.
echo Done.
pause
