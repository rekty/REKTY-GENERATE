# Daftarkan model `krea2-by-rekty` ke Pollinations (CLI)

Panduan lengkap mendaftarkan model privat **Krea 2 by Rekty** ke Pollinations
begitu endpoint self-host sudah hidup. Semua perintah memakai CLI resmi
`@pollinations/cli` (dijalankan lewat `npx`).

> ⚠️ Prasyarat: **endpoint OpenAI-compatible harus hidup dulu** (dari notebook
> Colab/Kaggle atau VPS), contoh `https://xxxx.trycloudflare.com`. URL
> trycloudflare berubah tiap sesi — kalau sesi mati, URL ikut mati.

---

## 0. Cek status login

```bash
npx -y @pollinations/cli auth status
```

Harus muncul `authenticated: true` dengan nama akun (`rekty`) dan saldo pollen.
Kalau belum login, jalankan device-flow:

```bash
npx -y @pollinations/cli auth login
```

Akan muncul URL + kode — approve dari HP/browser, lalu ulangi `auth status`.

---

## 1. Lihat model apa saja yang dijawab endpoint (sebelum daftar)

```bash
npx -y @pollinations/cli my-models models \
  --base-url https://xxxx.trycloudflare.com/v1 \
  --bearer-token <TOKEN_KALAU_ADA>
```

Ini memanggil `/v1/models` pada endpoint. Catat **id model persis** yang
dijawab (kemungkinan `krea2` atau `rekty1988/anjany`) — itu yang dipakai di
`--upstream-model`.

---

## 2. Tes endpoint dulu (WAJIB sebelum create)

```bash
npx -y @pollinations/cli my-models test \
  --base-url https://xxxx.trycloudflare.com/v1 \
  --bearer-token <TOKEN_KALAU_ADA> \
  --model krea2 \
  --modality image
```

Kalau berhasil → Pollinations bisa memanggil endpoint dan dapat gambar balik.
Kalau gagal, perbaiki endpoint dulu (jangan lanjut ke create).

---

## 3. Daftarkan model privat

```bash
npx -y @pollinations/cli my-models create \
  --name krea2-by-rekty \
  --title "Krea 2 by Rekty" \
  --description "Model gambar Krea 2 Turbo (quantize) by Rekty — cepat dan detail, cocok untuk anime, realistik, dan cyberpunk." \
  --base-url https://xxxx.trycloudflare.com/v1 \
  --upstream-model krea2 \
  --bearer-token <TOKEN_KALAU_ADA> \
  --modality image \
  --input-modalities text,image \
  --visibility private
```

Penjelasan flag:
| Flag | Isi |
|---|---|
| `--name` | id model di Pollinations (`krea2-by-rekty`) |
| `--title` | judul tampilan di katalog |
| `--base-url` | URL endpoint **+ `/v1`** (format OpenAI-compatible) |
| `--upstream-model` | id model yang dijawab endpoint (dari langkah 1) |
| `--bearer-token` | token endpoint — **kosongkan** kalau gateway tidak pakai token |
| `--modality image` | keluarga model = gambar |
| `--input-modalities text,image` | terima prompt teks + gambar (img2img) |
| `--visibility private` | hanya akunmu yang bisa memanggil (default) |

---

## 4. Verifikasi terdaftar

```bash
npx -y @pollinations/cli my-models list
```

Model `krea2-by-rekty` harus muncul di daftar.

---

## 5. Ganti endpoint / ubah model (kalau URL tunnel berganti)

```bash
npx -y @pollinations/cli my-models update krea2-by-rekty \
  --base-url https://URL_BARU.trycloudflare.com/v1 \
  --upstream-model krea2 \
  --bearer-token <TOKEN_KALAU_ADA>
```

Cukup satu perintah — identitas model tidak perlu dibuat ulang.

---

## 6. Hapus model (kalau tidak dipakai lagi)

```bash
npx -y @pollinations/cli my-models delete krea2-by-rekty
```

---

## Catatan penting

- **`--input-modalities text,image`** wajib kalau mau mendukung img2img
  (Krea 2 menerima teks + gambar). Tanpa `image`, Pollinations hanya kirim teks.
- Model **privat** bisa langsung dipakai tanpa approval. Untuk **publik**
  (muncul di katalog semua orang) perlu allowlist via issue GitHub
  (template Community Model Publisher Allowlist) — dan endpoint harus 24/7.
- Token endpoint disimpan **terenkripsi** oleh Pollinations.
- Saldo pollen: tes/create model biasanya butuh saldo > 0 — cek `auth status`.
