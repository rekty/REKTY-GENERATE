# REKTY GENERATOR — Panduan Deploy & API Key

Web text-to-image generator (UI mirip Tensor.Art), frontend statis satu file
`index.html` + backend opsional (proxy ke Tensor.Art Model Service / TAMS)
untuk generate gambar asli.

---

## 1. API key pakai apa?

**Jawaban singkat: API key Tensor.Art (TAMS).**

- Kaggle **tidak punya API untuk generate gambar** — upload model ke Kaggle
  hanya menyimpan file (bisa di-download), bukan menyediakan *inference
  endpoint* + API key. Jadi model di Kaggle tidak bisa langsung dipakai web ini.
- Tensor.Art menyediakan API gratis dan UI ini memang dibuat untuk model
  Tensor.Art (ID model Z Image / SDXL / FLUX.1 dll sudah ada di daftar Model).

Cara dapat API key TAMS:

1. Buka **https://tams.tensor.art** → daftar/login (bisa pakai akun Tensor.Art).
2. Masuk menu **API** → buat/buka token. Ini `Bearer` token yang kita pakai.
3. Tempel token di web → panel kiri bawah **API → API Key**, lalu **Simpan**.
   (Tersimpan di browser kamu, localStorage — tidak dikirim ke server lain.)
   Atau pasang sebagai environment variable saat deploy (lihat bawah) supaya
   key tidak perlu diketik pengguna lain.

### Alternatif tanpa key TAMS

Web juga mendukung provider lain lewat pemilih **Provider** di panel API:

| Provider | Model | Env variable | Catatan |
|---|---|---|---|
| Tensor.Art (TAMS) | daftar Model di UI (Z Image, SDXL, dst.) | `TENSORART_API_KEY` | default, dukung Img2Img |
| Replicate | pilih di kartu Model (FLUX, SDXL, SD 3.5, dst.) | `REPLICATE_API_TOKEN` | key dari replicate.com |
| fal.ai | pilih di kartu Model (FLUX, Fast SDXL, dst.) | `FAL_API_KEY` | key dari fal.ai |

Dropdown **Model** otomatis mengikuti provider aktif — klik kartu Model untuk
memilih (TAMS: 12 model; Replicate: 8; fal.ai: 7, termasuk **Krea 2 Turbo**).
Dropdown **LoRA** juga mengikuti provider: Replicate berisi model LoRA asli
(`black-forest-labs/flux-schnell-lora`, `flux-dev-lora`,
`zylim0702/sdxl-lora-customize-model` — SDXL + URL LoRA custom,
`ikea-instructions-lora-sdxl`), fal.ai berisi `fal-ai/flux-lora`,
`fal-ai/fast-sdxl` (SDXL + URL LoRA via input `loras`), dan
`fal-ai/krea-2/turbo/lora` (**Krea 2 + LoRA custom**). Model LoRA yang butuh
URL menampilkan field URL `.safetensors` di kartu LoRA — URL harus publik
langsung (mis. HuggingFace resolve; **Kaggle tidak bisa** karena butuh login).
Saat LoRA aktif, backend mengarahkan task ke model LoRA itu sendiri (pola
Replicate/fal); LoRA Krea 2 dikirim via input `loras` tanpa negative
prompt/steps (Krea 2 distilled). Img2Img belum didukung Replicate/fal.ai.
API key cukup satu; provider aktif ditentukan dari panel API (tersimpan di
localStorage).

> **Pakai LoRA-mu sendiri** (mis. dari `D:\ComfyUI\models\loras`)? File lokal
> tidak bisa dipakai langsung — provider hanya menerima URL publik. Caranya:
> 1. Upload file `.safetensors` ke HuggingFace (gratis, publik) → URL
>    `https://huggingface.co/<user>/<repo>/resolve/main/<file>.safetensors`.
>    Kaggle tidak bisa (download butuh login + API key, bukan URL publik).
> 2. Di web: pilih provider **fal.ai**, Model **Krea 2 Turbo** (kalau LoRA-mu
>    base Krea 2; atau FLUX/SDXL sesuai base LoRA), tambah LoRA
>    **Krea 2 LoRA (turbo)**, tempel URL-nya di kartu LoRA, lalu Generate.
>    Base model di ComfyUI (mis. `Krea2_by_Rekty_...`) tidak ikut di-upload —
>    provider menyediakan base-nya sendiri.

---

## 2. Mode di web (panel kiri → API)

| Mode  | Perilaku |
|-------|----------|
| **Auto** (default) | Coba backend `/api`; kalau gagal/tidak ada key, otomatis simulasi demo |
| **Real API** | Wajib backend + API key; error ditampilkan, tidak fallback |
| **Demo** | Selalu simulasi (gambar picsum), tanpa internet/backend |

---

## 3. Deploy ke Cloudflare Pages (gratis — yang dipakai sekarang)

Backend di-deploy sebagai **Advanced Mode `_worker.js`** (satu worker
self-contained: `/api/*` → logika backend, path lain → `index.html`).
Alasan: pada direct-upload via wrangler, Pages Functions berbasis file
(`functions/`) kadang tidak ter-attach di akun baru, dan binding `env.ASSETS`
pada direct-upload tidak menyajikan file statis. `_worker.js` menghindari
keduanya. (Folder `functions/` tetap ada sebagai opsi deploy via dashboard Git.)

**Langkah deploy (CLI, sudah diverifikasi):**
```bash
npx wrangler login                                  # login browser (sekali)
node scripts/build_worker.mjs                       # bangun _worker.js dari functions/api.js + index.html
npx wrangler pages project create rekty-generator --production-branch main   # sekali saja
npx wrangler pages deploy . --project-name rekty-generator --branch main
npx wrangler pages secret put TENSORART_API_KEY --project-name rekty-generator    # token TAMS
npx wrangler pages secret put REPLICATE_API_TOKEN --project-name rekty-generator  # token Replicate
npx wrangler pages secret put FAL_API_KEY --project-name rekty-generator          # key fal.ai
```
> Pakai `wrangler@3` (mis. `npx wrangler@3.90.0`) — wrangler 4 sempat gagal
> upload (500) di akun baru. Setelah mengubah `index.html` / `functions/api.js`,
> jalankan ulang `node scripts/build_worker.mjs` sebelum deploy.

Upload otomatis mengecualikan `firebase-backend/`, `node_modules`, dan berkas
lokal via `.assetsignore`.

Hasil: `https://<project>.pages.dev` — frontend + `/api/*` di origin yang sama,
jadi tidak ada masalah CORS dan API key aman di server.

**Cara alternatif — dashboard Git:** Cloudflare Pages → **Create project** →
hubungkan repo GitHub → Build settings kosong, output dir `/` → Deploy.
Kalau jalur ini yang dipakai, backend memakai `functions/api.js` (Pages
Functions) secara otomatis.

### 3a. Penyimpanan gambar permanen (Cloudflare KV — tanpa kartu kredit)

Secara default hasil generate hanya berupa **URL sementara dari provider**
(signed URL TAMS bisa kedaluwarsa → riwayat di browser jadi rusak). Dengan
KV, setiap gambar hasil **otomatis diarsip** dan disajikan lewat URL
permanen `/img/<nama>` (cache immutable).

> Kenapa KV, bukan R2? Aktivasi R2 **mewajibkan metode pembayaran** (kartu)
> walau tagihannya $0/bulan. KV termasuk free plan Workers **tanpa billing**
> sama sekali (1 GB storage, 100rb read/hari — lebih dari cukup untuk pemakaian
> pribadi).

**Setup (sudah selesai di repo ini):**
```bash
npx wrangler@3.90.0 kv namespace create REKTY_IMAGES   # sekali; catat id-nya
# lalu taruh id-nya di wrangler.toml ([[kv_namespaces]] binding = "IMAGES")
node scripts/build_worker.mjs
npx wrangler@3.90.0 pages deploy . --project-name rekty-generator --branch main
curl https://rekty-generator.pages.dev/api/health        # harus ada "storage": "kv"
```

**Catatan teknis:** namespace KV baru (`supports_url_encoding`) punya bug
runtime di Pages Advanced Mode — `get(key, {type:'stream'})` mengembalikan
stream **kosong** (len 0). Solusi yang dipakai di kode: `{type:'arrayBuffer'}`
(terbukti bekerja) + content-type ditebak dari ekstensi file.

Perilaku saat KV tidak aktif: `storage: null` di health, gambar tetap
dikembalikan dengan URL asli provider (fallback aman, tidak error). Gambar
> 20 MiB juga dilewati (batas KV 25 MiB).

---

## 4. Deploy ke Firebase (Hosting + Cloud Functions)

> **Penting — paket Spark (gratis) TIDAK bisa menjalankan Cloud Functions**
> (wajib Blaze/pay-as-you-go). Di Spark hanya hosting statis yang jalan →
> mode generate asli (`/api`) mati, hanya mode Demo yang berfungsi. Kalau
> mau full gratis, pakai **Cloudflare Pages** (bagian 3 di atas): backend
> `functions/api.js` sudah siap dan free tier-nya menyediakan fungsi.
> Kalau tetap mau Firebase gratis untuk UI saja: pakai
> `firebase-free.json` (tanpa rewrite fungsi):
> ```bash
> firebase deploy --config firebase-free.json --only hosting
> ```

Konfigurasi sudah ada di repo (`firebase.json` + `firebase-backend/`).
Prasyarat (mode penuh): project Firebase dengan paket **Blaze** (Cloud
Functions butuh pay-as-you-go), `npm i -g firebase-tools`, sudah
`firebase login`.

1. Hubungkan folder ini ke project Firebase-mu:
   ```bash
   firebase use --add        # pilih project (kalau belum ada: buat di console.firebase.google.com)
   ```
2. Install dependency functions:
   ```bash
   cd firebase-backend && npm install && cd ..
   ```
3. Set API key sebagai secret (minimal satu, sesuai provider yang dipakai):
   ```bash
   firebase functions:secrets:set TENSORART_API_KEY
   firebase functions:secrets:set REPLICATE_API_TOKEN
   firebase functions:secrets:set FAL_API_KEY
   ```
   Deploy tetap jalan tanpa secret (key bisa dikirim dari browser via panel
   API), tapi untuk publik selalu pakai secret.
4. Deploy:
   ```bash
   firebase deploy
   ```
   Hosting + Functions sekaligus. Rewrite `/api/**` → fungsi `api` sudah diatur
   di `firebase.json`; region fungsi (`asia-southeast2`) sudah disamakan di
   `firebase-backend/index.js` — kalau mau ganti region, ubah **keduanya**.
5. Verifikasi: buka `https://<project>.web.app/api/health` → `{"ok": true, ...}`.

Uji handler functions lokal tanpa deploy (butuh step 2 dulu):
```bash
node scripts/smoke_firebase.cjs
```

---

## 5. Uji coba lokal (tanpa API key)

```bash
python scripts/dev_server.py
# buka http://127.0.0.1:8787
```
Server ini menyediakan `index.html` + **mock** `/api` (TAMS palsu) sehingga
alur task → poll → progress → hasil bisa dicoba. Set Mode = "Real API" dan
isi API key bebas (mis. `test`) untuk melihat alur lengkapnya, atau biarkan
Mode = Auto untuk simulasi.

---

## 6. Struktur & endpoint backend

```
index.html                  UI lengkap (satu file, tanpa build)
functions/api.js            Cloudflare Pages Function: /api/generate, /api/task, /api/health
firebase-backend/            Versi Firebase Cloud Functions (sama logikanya)
firebase.json               Konfigurasi Firebase (hosting + rewrite /api -> functions)
scripts/dev_server.py       Server lokal + mock TAMS untuk uji coba
```

Backend menerima payload `buildPayload()` dari frontend (format yang sudah
dibuat), menerjemahkannya ke format job TAMS (`v1/jobs`, stages
`INPUT_INITIALIZE` + `DIFFUSION`), lalu mengecek status via `v1/jobs/{id}`.
Payload membawa field `provider` (`tams` | `replicate` | `fal`); task id
ber-prefix `replicate:` / `fal:` supaya polling tahu provider mana. Tanpa
field provider, default TAMS. Tes integrasi: `node scripts/test_backend.mjs`
(3 provider, fetch tiruan, tanpa API asli).

Alur: `POST /api/generate` → `{taskId}` → polling `GET /api/task?id=...` →
`{status, progress, images}` → tampil di grid + riwayat (tersimpan di
localStorage browser, max 60 hasil).

---

## 7. Catatan

- Tab **Edit / Video / Prime** masih placeholder "segera hadir".
- **Img2Img** sudah berfungsi: upload gambar awal + denoising strength di
  panel tengah (tab Img2Img); backend meng-upload gambar ke TAMS lalu
  memakai `imageResourceId` sebagai input diffusion.
- LoRA memakai trigger words + slider bobot. TAMS: hanya dikirim LoRA ber-id
  numerik asli (`loraModel`), sisanya cukup trigger words-nya yang masuk ke
  prompt. Replicate/fal: dropdown LoRA berisi model LoRA asli dan saat aktif
  task diarahkan ke model LoRA tersebut; model FLUX-LoRA butuh URL `.safetensors`
  di kartu LoRA (`lora_url` + `lora_scale` + trigger phrase dikirim ke API).
  LoRA SDXL custom (`zylim0702/sdxl-lora-customize-model` di Replicate,
  `fal-ai/fast-sdxl` via `loras` di fal) dan **Krea 2 LoRA** (`fal-ai/krea-2/turbo/lora`)
  juga didukung — Krea 2 tidak menerima negative prompt/steps/guidance.
- Riwayat hasil hanya tersimpan di browser masing-masing (localStorage).
