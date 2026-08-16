# 📅 Jadwal Restart Sesi Kaggle (REKTY Endpoint)

Sesi Kaggle gratis **mati otomatis maks ±12 jam** — saat mati, URL endpoint ikut mati
dan Pollinations tidak bisa diakses. Ini jadwalnya biar endpoint tetap hidup saat
menunggu review community model.

## ⏰ Jadwal Harian (waktu lokal)

| Jam | Kegiatan | Waktu |
|---|---|---|
| **08:00 pagi** | Cek endpoint (skrip) → kalau mati, Run all | 2 menit |
| **20:00 malam** | Cek endpoint (skrip) → kalau mati, Run all | 2 menit |
| **pengganti otomatis** | Task Windows "REKTY_Restart" membuka notebook jam 20:00 | otomatis |

> Sesi biasanya di-restart jam 20:00 → hidup lagi 12 jam → mati ±08:00 pagi berikutnya
> → restart lagi. Dua kali sehari cukup.

## 🚀 Cara restart (30 detik)

1. Buka notebook: `https://www.kaggle.com/code/rektyanjany/notebookc1c56b446c`
2. Klik **Run All** (atau ▶ di sel 1–8 saja — download model sudah ada, cepat)
3. Tunggu sampai sel terakhir keluar:
   ```
   ENDPOINT PUBLIK KAMU : https://xxxxx.trycloudflare.com
   ```
4. **Salin URL baru** → paste di aplikasi REKTY → Pengaturan → **Endpoint Self-Host**
5. Jalankan **sel KEEP-ALIVE** (sel terakhir) — biarkan berjalan
6. (Opsional) Update URL di `scripts/cek_endpoint.bat`

## 🔍 Cek endpoint sekali klik

Jalankan `scripts/cek_endpoint.bat` di Windows (double-click):
- **"Endpoint HIDUP - aman."** → tidak perlu apa-apa
- **"Endpoint MATI"** → ikuti langkah restart di atas

Atau dari terminal:
```bash
curl -s -m 15 https://confidence-trained-compatible-relevance.trycloudflare.com/health
```
→ balas `{"ok":true,...}` = hidup.

## ⚠️ Catatan

- URL berubah SETIAP sesi di-restart → selalu update di app REKTY + skrip cek.
- Sel KEEP-ALIVE mencegah kematian karena *idle*, TAPI tidak mencegah batas 12 jam.
- Kalau Pollinations sudah approve dan mau benar-benar 24/7 → butuh VPS GPU berbayar
  (lihat `README.md`).
