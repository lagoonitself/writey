@echo off
rem Writey Helper setup for Windows. Installs uv (if needed) and the Helper, then starts it.
rem After this the Helper starts hidden whenever you sign in to Windows.
title Writey Helper setup
echo.
echo   Setting up Writey Helper. This takes about a minute the first time.
echo.

where uv >nul 2>nul
if errorlevel 1 (
  echo   Installing uv, the Python tool manager...
  powershell -NoProfile -ExecutionPolicy ByPass -Command "irm https://astral.sh/uv/install.ps1 | iex"
  set "PATH=%USERPROFILE%\.local\bin;%PATH%"
)

rem With an NVIDIA GPU, speech runs on it: add CUDA (about 1 GB more). kokoro-onnx asks for the
rem CPU onnxruntime, which would overwrite the GPU one, so it's excluded.
set "SPEC=writey-helper"
where nvidia-smi >nul 2>nul
if not errorlevel 1 (
  echo   NVIDIA GPU found: speech will run on it.
  set "SPEC=writey-helper[gpu]"
)
echo onnxruntime> "%TEMP%\writey-helper-excludes.txt"
uv tool install --force --python 3.12 --excludes "%TEMP%\writey-helper-excludes.txt" "%SPEC% @ git+https://github.com/lagoonitself/writey#subdirectory=apps/helper"
if errorlevel 1 goto failed

for /f "delims=" %%i in ('uv tool dir --bin') do set "BIN=%%i"
"%BIN%\writey-helper.exe" install
if errorlevel 1 goto failed

echo.
echo   Done. Go back to Writey: Continue with ChatGPT, or turn on Voice.
echo.
timeout /t 8 >nul
exit /b 0

:failed
echo.
echo   Setup didn't finish. Scroll up for the error, or ask at github.com/lagoonitself/writey/issues
pause
exit /b 1
