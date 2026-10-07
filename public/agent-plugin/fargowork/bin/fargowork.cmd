@echo off
setlocal
set "FARGOWORK_EXE=%~dp0fargowork.exe"
if not exist "%FARGOWORK_EXE%" (
  >&2 echo FargoWork is installed without its platform executable. Run fargowork repair.
  exit /b 4
)
"%FARGOWORK_EXE%" %*
