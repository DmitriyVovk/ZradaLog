@echo off
setlocal

echo Stopping SOLIDWORKS Electrical SQL services...

sc stop "SQLTELEMETRY$TEW_SQLEXPRESS"
sc stop "SQLBrowser"
sc stop "MSSQL$TEW_SQLEXPRESS"

echo.
echo SQLWriter is left running intentionally. It is a lightweight VSS writer.
echo Done.
pause
