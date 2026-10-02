@echo off
setlocal
if not exist "%~dp0node_modules\electron\dist\electron.exe" (
  echo Electron runtime missing. Run npm --prefix desktop ci and npm --prefix desktop run install:runtime from the project directory.
  exit /b 1
)
rem The dot prevents the trailing backslash from escaping the closing argv quote.
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0." %*
