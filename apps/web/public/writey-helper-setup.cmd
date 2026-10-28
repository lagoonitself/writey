@echo off
rem Writey Helper setup for Windows. Installs uv (if needed) and the Helper, then starts it.
rem After this the Helper starts hidden whenever you sign in to Windows.
title Writey Helper setup
echo.
echo   Setting up Writey Helper. This takes under a minute.
echo.

where uv >nul 2>nul
if errorlevel 1 (
  echo   Installing uv, the Python tool manager...
  powershell -NoProfile -ExecutionPolicy ByPass -Command "irm https://astral.sh/uv/install.ps1 | iex"
  set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)

set "ATTEMPT=1"
:install
uv tool install --force --python 3.12 "writey-helper @ git+https://github.com/lagoonitself/writey#subdirectory=apps/helper"
if not errorlevel 1 goto installed
if %ATTEMPT% geq 3 goto failed
set /a ATTEMPT+=1
echo.
echo   Download interrupted. Trying again (%ATTEMPT% of 3)...
echo.
goto install
:installed

for /f "delims=" %%i in ('uv tool dir --bin') do set "BIN=%%i"
"%BIN%\writey-helper.exe" install
if errorlevel 1 goto failed

echo.
echo   Done. Go back to Writey and Continue with ChatGPT.
echo.
timeout /t 8 >nul
exit /b 0

:failed
echo.
echo   Setup didn't finish. Scroll up for the error, or ask at github.com/lagoonitself/writey/issues
pause
exit /b 1
