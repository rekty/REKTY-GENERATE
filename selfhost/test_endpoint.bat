@echo off
rem ============================================================
rem  Tes endpoint self-host Krea 2 (Windows, tanpa Git Bash)
rem  Pakai:  test_endpoint.bat https://xxx.trycloudflare.com
rem ============================================================
chcp 65001 >nul
setlocal

if "%~1"=="" (
    echo.
    echo  Pakai: test_endpoint.bat https://xxx.trycloudflare.com
    echo.
    pause
    exit /b 1
)

where python >nul 2>nul
if errorlevel 1 (
    echo.
    echo  [ERROR] Python tidak ditemukan di PATH.
    echo  Install dari https://www.python.org/downloads/ lalu coba lagi.
    echo.
    pause
    exit /b 1
)

python "%~dp0test_endpoint.py" "%~1"

echo.
pause
