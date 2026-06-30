@echo off
setlocal

call "%~dp0sql-solidworks-electrical-status.bat"
echo.
echo Starting SOLIDWORKS Electrical SQL services...

sc start "MSSQL$TEW_SQLEXPRESS"
sc start "SQLBrowser"

echo.
echo SQL telemetry is intentionally not started. It is not required for local databases.
echo Done.
pause
