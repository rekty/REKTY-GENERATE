# Panduan Menjalankan `selfhost/rekty_colab.ipynb` (Krea 2 by Rekty)

Notebook ini menjalankan **Krea 2 + LoRA REKTY ANJANY** di GPU gratis
(Google Colab / Kaggle) dan mempublikasikannya sebagai endpoint OpenAI-compatible
(`/v1/images/generations`) lewat Cloudflare Tunnel — siap didaftarkan ke Pollinations.

Struktur notebook (12 sel):
| Sel | Isi |
|---|---|
| 0–1 | Intro + cara pakai |
| 2 | ⚙️ KONFIGURASI (ubah di sini) |
| 3 | Cek GPU |
| 4 | Install ComfyUI (sekali saja) |
| 5 | Siapkan model (Kaggle dataset → URL HF → fallback Krea 2 resmi) |
| 6–7 | Bangun workflow + jalankan ComfyUI |
| 8 | Gateway OpenAI-compatible |
| 9 | Cloudflare Tunnel → **cetak URL publik** |
| 10 | KEEP-ALIVE (biarkan berjalan) |
| 11 | Cara pakai URL |

Total download ~19 GB — **hanya sekali** (tersimpan di disk sesi).

---

## A. GOOGLE COLAB

### Langkah 1 — Buka & upload notebook
1. Buka https://colab.research.google.com
2. **File → Upload notebook** → pilih `selfhost/rekty_colab.ipynb`
   (atau: File → Open notebook → GitHub → repo `rekty/REKTY-GENERATE`)

### Langkah 2 — Pilih GPU
- Menu **Runtime → Change runtime type**
- **Hardware accelerator: GPU (T4)** → Save

### Langkah 3 — Cek konfigurasi (sel 2)
- `CHECKPOINT_URL` sudah mengarah ke HuggingFace-mu
  (`https://huggingface.co/rekty1988/KREA2_BY_REKTY/resolve/main/...`) — **tidak perlu diubah**
- `LORA_STRENGTH = 0.0` (sudah baked-in di checkpoint, tidak dobel) — biarkan
- `DATASET_SLUG = ""` — biarkan kosong (pakai URL HF)

### Langkah 4 — Jalankan
- **Runtime → Run all** (atau jalankan sel satu per satu dari atas)
- Tunggu: download model ±10–15 menit (19 GB), lalu ComfyUI + gateway + tunnel
- Sel 9 akan mencetak URL:
  ```
  ✅ ENDPOINT PUBLIK (OpenAI-compatible):
  https://xxxxxxxxxxxx.trycloudflare.com
  ```
- **Salin URL itu** (format `https://xxx.trycloudflare.com`)

### Langkah 5 — Jaga sesi tetap hidup
- Sel 10 (**KEEP-ALIVE**) harus **tetap berjalan** — jangan di-stop
- Selama sel itu mengeksekusi, sesi tidak dianggap idle → tidak timeout karena nganggur
- ⚠️ Batas sesi gratis ±12 jam — setelah itu mati; tinggal **Run all** ulang
  (download tidak diulang selama sesi masih hidup)

### Langkah 6 — Tes URL
Buka terminal lokal (atau sel baru di notebook):
```bash
curl https://xxx.trycloudflare.com/v1/models
curl -X POST https://xxx.trycloudflare.com/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"model":"rekty1988/anjany","prompt":"a cat with blue eyes","size":"832x1536"}'
```

---

## B. KAGGLE

### Langkah 0 — Persiapan akun
- Daftar di https://www.kaggle.com
- **Verifikasi nomor HP** (wajib untuk GPU): Settings → Phone verification
- GPU quota: ±30 jam GPU/minggu

### Langkah 1 — Buat & import notebook
1. https://www.kaggle.com → **Create → New Notebook**
2. **File → Import Notebook** → pilih `selfhost/rekty_colab.ipynb`

### Langkah 2 — Pengaturan notebook (WAJIB)
- **Settings → Accelerator: GPU T4 x2** (atau T4 x1 kalau tidak ada)
- **Settings → Internet: ON** ⚠️ (tanpa ini download model gagal)
- (Opsional) kalau model-mu terpasang sebagai **dataset input** di panel
  kanan (mis. `rektyanjany/krea2-by-rekty`) → isi `DATASET_SLUG` di sel 2.
  Kalau tidak → biarkan `""`, notebook pakai URL HF otomatis.

### Langkah 3 — Jalankan
- **Run All** → tunggu download + setup (±15–20 menit)
- Sel 9 mencetak URL publik `https://xxx.trycloudflare.com` → **salin**
- Sel 10 (KEEP-ALIVE) biarkan berjalan

### Langkah 4 — Tes URL (sama seperti Colab langkah 6)

---

## Setelah URL dapat

1. **Tes endpoint** (lihat `REGISTER_POLLINATIONS.md`):
   ```bash
   npx -y @pollinations/cli my-models models --base-url https://xxx.trycloudflare.com/v1
   npx -y @pollinations/cli my-models test --base-url https://xxx.trycloudflare.com/v1 --model krea2 --modality image
   ```
2. **Daftarkan** model `krea2-by-rekty` (privat) — perintah lengkap ada di
   `selfhost/REGISTER_POLLINATIONS.md`.
3. Kalau URL tunnel berganti (sesi baru) → tinggal `my-models update` dengan URL baru.

## ⚠️ Perbedaan Colab vs Kaggle
| | Colab | Kaggle |
|---|---|---|
| GPU | T4 | T4 (kuota 30 jam/minggu) |
| Verifikasi HP | Tidak wajib | **Wajib** untuk GPU |
| Internet | Otomatis ON | **Harus nyalakan manual** |
| Sesi maks | ±12 jam | ±9 jam |
| Download ulang | Tidak (tersimpan) | Tidak (tersimpan) |

## Tips
- Jangan tutup tab browser — sesi mati kalau browser ditutup lama (idle)
- Kalau generate pertama lambat (cold start ±30–60 dtk), itu normal — model
  sedang dimuat
- Untuk 24/7 stabil (syarat model publik) → butuh VPS GPU — lihat `DEPLOY_VPS.md`
