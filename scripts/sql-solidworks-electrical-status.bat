@echo off
setlocal

echo SOLIDWORKS Electrical SQL service status
echo.
sc query "MSSQL$TEW_SQLEXPRESS"
echo.
sc query "SQLBrowser"
echo.
sc query "SQLTELEMETRY$TEW_SQLEXPRESS"
echo.
sc query "SQLAgent$TEW_SQLEXPRESS"
echo.
sc query "SQLWriter"
