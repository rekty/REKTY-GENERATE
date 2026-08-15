@echo off
chcp 65001 >nul
title Cek Endpoint REKTY Self-Host
rem ============================================================
rem  GANTI URL INI setiap kali sesi Kaggle di-restart
rem  (URL baru muncul di output notebook: ENDPOINT PUBLIK KAMU)
rem ============================================================
set URL=https://confidence-trained-compatible-relevance.trycloudflare.com/health

echo.
echo [Cek] %URL%
curl -s -m 15 %URL% | find "ok" >nul
if %errorlevel%==0 (
  echo.
  echo   ✅ Endpoint HIDUP - aman. Tidak perlu apa-apa.
) else (
  echo.
  echo   ❌ Endpoint MATI atau sesi sudah mati.
  echo.
  echo   Langkah restart (30 detik):
  echo     1. Buka  https://www.kaggle.com/code/rektyanjany/notebookc1c56b446c
  echo     2. Klik Run All, tunggu URL baru keluar
  echo     3. Salin URL baru -^> paste di aplikasi REKTY -^> Pengaturan -^> Endpoint Self-Host
  echo     4. Jalankan sel KEEP-ALIVE (sel terakhir)
  echo     5. Update URL di skrip ini
)
echo.
pause
