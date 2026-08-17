# WD14 Tagger 🔮 — Deteksi Prompt dari Gambar

Alat **image → booru tags** berbasis model [WD 1.4 (SmilingWolf)](https://huggingface.co/SmilingWolf)
yang berjalan **100% di browser** (ONNX Runtime Web / WASM) — tanpa server, tanpa
API key, gambar tidak pernah dikirim keluar perangkat.

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

## Model yang dipakai

| Model | Sumber asli (fp32) | Versi fp16 di repo ini | Ukuran |
|---|---|---|---|
| **ConvNeXtV2** | [`SmilingWolf/wd-v1-4-convnextv2-tagger-v2`](https://huggingface.co/SmilingWolf/wd-v1-4-convnextv2-tagger-v2) | [`wd14_fp16.onnx`](https://huggingface.co/rekty1988/WD14_TAGGER/resolve/main/wd14_fp16.onnx) | 194 MB |
| **ViT** | [`SmilingWolf/wd-v1-4-vit-tagger-v2`](https://huggingface.co/SmilingWolf/wd-v1-4-vit-tagger-v2) | [`wd14_vit_fp16.onnx`](https://huggingface.co/rekty1988/WD14_TAGGER/resolve/main/wd14_vit_fp16.onnx) | 187 MB |

**Repo HuggingFace:** [`rekty1988/WD14_TAGGER`](https://huggingface.co/rekty1988/WD14_TAGGER)
berisi `wd14_fp16.onnx`, `wd14_vit_fp16.onnx`, dan `selected_tags.csv`.

### Kenapa fp16?

Versi fp16 **setengah ukuran** (~190 MB vs ~380 MB) dengan kualitas nyaris
identik (korelasi output ±0.98, top tag sama) — sekali unduh lalu **di-cache**
di browser (Cache API), ganti-ganti model berikutnya instan.

### Spesifikasi model (penting untuk integrasi)

- **Input**: `input_1:0`, float32, `[1, 448, 448, 3]` (NHWC, RGB) — **piksel mentah 0–255**
  ⚠️ Jangan normalisasi dulu di sisi pemanggil: graph ONNX sudah menormalkan
  sendiri via `Sub(x, 127.5)` lalu `Mul(x, 1/127.5)` → rentang `[-1, 1]`.
  (Bug preprocessing lama = gambar apa pun selalu keluar `monochrome/greyscale`.)
- **Output**: `predictions_sigmoid`, `[1, 9083]` (sudah sigmoid):
  rating 4 (`general/sensitive/questionable/explicit`) + general 6947 + character 2132.
- **Runtime**: `onnxruntime-web@1.19.2` (WASM), cache key `vaia-wd14-convnext` / `vaia-wd14-vit`.

### Reproduksi model fp16 (untuk pembaruan/verifikasi)

```python
import onnx
from onnxconverter_common import float16

m = onnx.load("model.onnx")  # dari SmilingWolf (fp32)
m16 = float16.convert_float_to_float16(m, keep_io_types=True)
onnx.save(m16, "wd14_fp16.onnx")  # atau wd14_vit_fp16.onnx
```

Verifikasi cepat: jalankan fp32 vs fp16 dengan input piksel mentah pada foto
yang sama → top tag harus identik.

---

## Catatan & batasan

- **Unduh sekali saja**: model pertama diunduh ±190 MB (tampil progress di
  dialog); setelah itu instan dari cache browser. Ganti-ganti model di-cache
  terpisah.
- **100% lokal**: setelah model ter-cache, deteksi jalan offline (tanpa internet).
- **Lisensi**: model dasar WD 1.4 oleh SmilingWolf, lisensi `apache-2.0`.

## Struktur terkait

```
wd14-tagger/README.md   # dokumen ini
index.html              # implementasi (chatWd14*, wd14Hist*, dialog + logika)
```
