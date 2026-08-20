# WD14 Tagger 🔮 — Deteksi Prompt dari Gambar

Alat **image → booru tags** berbasis model [WD 1.4 (SmilingWolf)](https://huggingface.co/SmilingWolf)
yang berjalan **online** via HF Space [`deepghs/wd14_tagging_online`](https://huggingface.co/spaces/deepghs/wd14_tagging_online) —
tanpa perlu mengunduh model (~190MB) ke browser.

Tersedia di aplikasi REKTY (Visual AI Artwork) di dua tempat:

1. **Menu `+` di VAIA Chat** → **✨ Deteksi Prompt (WD14)**
2. **Tab Img2Img** → tombol **✨ Deteksi Prompt (WD14)** di bawah gambar referensi

---

## Cara pakai

1. Buka dialog **Deteksi Prompt (WD14)** (dari chat atau Img2Img).
2. **Drop / klik** gambar di area preview (bisa langsung di dialog — tidak perlu
   lampirkan dulu di chat).
3. Tag muncul otomatis (deteksi berjalan live setiap gambar/opsi berubah).
4. Pilih **Format Salin** dan tekan:
   - **Pakai di Text2Img** → tag jadi prompt + pindah ke tab Text2Img
   - **Kirim ke chat** → kirim tag ke VAIA Chat
   - **Salin** → salin ke clipboard

### Kontrol dialog (ala HF Space `wd14_tagging_online`)

| Kontrol | Fungsi |
|---|---|
| **Waifu Model** | `wd14-convnext (v2)` atau `wd14-vit (v2)` — hasil sedikit berbeda, bisa dibandingkan |
| **Tagging Confidence Threshold** | Ambang probabilitas tag (default 0.5); geser → tag langsung diperbarui |
| **Use Space Instead Of _** | `blue_eyes` → `blue eyes` |
| **Use Text Escape** | Escape sintaks A1111: `(`, `)`, `[`, `]`, `{`, `}`, `:`, `,` |
| **Keep Confidences** | Sertakan probabilitas: `blue eyes (0.91)` |
| **Descend By Confidence** | Urut dari confidence tertinggi |
| **Format Salin** | `A1111 kompak` (bersih) · `+ Confidence` (dengan probabilitas) · `Teks Bebas` (polos, bisa diedit) |

### Riwayat & perbandingan antar model

- Tombol **Riwayat** di header dialog → hasil deteksi tersimpan **per gambar**
  (thumbnail + waktu), **satu hasil per model** — deteksi ulang mengganti hasil
  model yang sama.
- Tombol **Bandingkan antar model** → overlay dua kolom: tag `wd14-convnext`
  vs `wd14-vit` untuk gambar yang sama.
- Simpan: `localStorage` (`vaia-wd14-history`, maks 12 gambar × 4 deteksi).

### Pengaturan tersimpan

Model, threshold, dan semua opsi format disimpan di `localStorage`
(`vaia-wd14-settings`) — pulih otomatis saat dialog dibuka lagi.

---

## Arsitektur

### Flow Request

```
Browser → POST /api/wd14 (same-origin, tanpa CORS)
        → Worker cek KV cache
        → [Hit] → Return cached (< 100ms) ⚡
        → [Miss] → Retry + exponential backoff ke HF Space
                 → Cache di KV (7 hari)
                 → Return response
```

### KV Caching

- **Cache key**: `wd14:<model>:<threshold>:<hash_gambar>` (FNV-1a 32-bit)
- **Cache TTL**: 7 hari
- **Cache hit**: response `< 100ms` dengan `_cache: 'hit'`
- **Cache miss**: response dari HF Space dengan `_cache: 'miss'`

### Retry + Exponential Backoff

HF Space cold start sering gagal/timeout pada percobaan pertama. Backend
otomatis retry dengan exponential backoff:

| Percobaan | Timeout | Delay sebelumnya |
|-----------|---------|------------------|
| 1 | 60 detik | - |
| 2 | 90 detik | 5 detik |
| 3 | 120 detik | 15 detik |

- **4xx error** (kecuali 429) = error permanen, tidak di-retry
- **5xx error / timeout** = di-retry sampai max 3 kali
- Response include `_attempts: N` untuk menunjukkan berapa kali percobaan

### Cold Start Timer

Dialog menampilkan timer real-time saat menunggu:

| Waktu | Pesan |
|-------|-------|
| 0-8 detik | `5d` (normal) |
| 8-20 detik | `12d ⏳ Memproses...` |
| 20-45 detik | `25d ⏳ HF Space sedang spin-up...` |
| 45+ detik | `50d ⚠️ Space mungkin sedang cold start` |

### Contoh Response

```json
{
  "data": [
    {"label": "general", "confidences": [...]},
    "1girl, solo, ...",
    {"label": "1girl", "confidences": [...]}
  ],
  "_cache": "hit",
  "_attempts": 1
}
```

### Status Indicator

Dialog menampilkan status caching dan retry:

- `Selesai — 23 tag · rating: general (95%) · layanan online ⚡cache · 0d`
- `Selesai — 23 tag · rating: general (95%) · layanan online · 3x percobaan · 45d`

---

## Endpoint API

- **URL**: `POST /api/wd14`
- **Backend**: `_worker.js` (Cloudflare) atau `functions/api.js` (Firebase)
- **HF Space**: `https://deepghs-wd14-tagging-online.hf.space/api/join`
- **Dev server**: `http://127.0.0.1:8000/api/wd14` (mock data)

### Request Body

```json
{
  "fn_index": 0,
  "data": [
    "data:image/jpeg;base64,...",  // gambar (downscaled ke max 1024px)
    "wd14-convnext",               // atau "wd14-vit"
    0.05,                          // threshold rendah → semua tag di-return
    false,                         // Use Space Instead Of _
    false,                         // Use Text Escape
    false,                         // Keep Confidences
    false                          // Descend By Confidence
  ],
  "session_hash": "wd14..."
}
```

---

## Catatan & batasan

- **Tanpa unduh model**: tidak ada file ONNX 190MB yang diunduh ke browser.
- **Butuh internet**: deteksi membutuhkan koneksi ke HF Space.
- **Cold start**: HF Space butuh waktu spin-up jika baru dibuka (retry otomatis).
- **Cache 7 hari**: gambar yang sama tidak perlu di-proses ulang.
- **Lisensi**: model dasar WD 1.4 oleh SmilingWolf, lisensi `apache-2.0`.

## Struktur terkait

```
wd14-tagger/README.md   # dokumen ini
index.html              # implementasi (chatWd14*, wd14Hist*, dialog + logika)
_worker.js              # backend proxy + KV caching + retry
functions/api.js        # backend Firebase (sama)
scripts/dev_server.py   # mock /api/wd14 untuk localhost
```
