# REKTY GENERATOR 🎨

Web text-to-image generator (terinspirasi Tensor.Art) — satu file `index.html`
tanpa build, siap di-deploy ke **Firebase Hosting** atau **Cloudflare Pages**.

## Fitur

- **Generate gambar** dari prompt: kirim task → poll progress → hasil tampil
  1 gambar besar di tengah sesuai aspect ratio (seperti Tensor.Art, bisa
  navigasi prev/next) + riwayat (tersimpan di localStorage, metadata asli:
  task ID, kredit, ukuran, seed, prompt)
- **Translate prompt**: tombol **Translate** di prompt bar → terjemahkan prompt
  bahasa apa pun ke Inggris (backend `/api/translate`, gratis via Google gtx)
- **Refine prompt**: tombol **Enhance** → perluas/tingkatkan prompt pakai LLM
  Pollinations (`/api/refine`, pakai pollen BYOP/key; fallback template lokal
  kalau tanpa key)
- **4 provider** — pilih di panel API:
  | Provider | Model | API key (env) |
  |---|---|---|
  | Tensor.Art (TAMS) | Z Image, FLUX.1, SDXL, Pony, dst. | `TENSORART_API_KEY` |
  | Replicate | FLUX schnell/dev, SDXL, SD 3.5, dst. | `REPLICATE_API_TOKEN` |
  | fal.ai | FLUX, Fast SDXL, SD 3.5, **Krea 2 Turbo** | `FAL_API_KEY` |
  | **Pollinations** | **gratis tanpa key** (auto/sana) — atau **login BYOP** (pengguna membawa pollen sendiri, OAuth PKCE) / sk_* untuk 57+ model (Z-Image, Krea, FLUX, dst.) | `POLLINATIONS_API_KEY` (opsional) + `POLLINATIONS_APP_KEY` (BYOP) |
- **Mode API**: Auto / Real / Demo (simulasi picsum) — cocok dicoba tanpa key
- **LoRA custom**: dropdown LoRA mengikuti provider; model yang butuh URL
  menampilkan field URL `.safetensors` (mis. `flux-schnell-lora`, SDXL via
  `zylim0702/sdxl-lora-customize-model` / `fal-ai/fast-sdxl`, **Krea 2** via
  `fal-ai/krea-2/turbo/lora`)
- **BYOP (Bring Your Own Pollen)** untuk Pollinations: tombol **Login dengan
  Pollinations** di panel API → authorize di enter.pollinations.ai (OAuth code
  flow + PKCE) → token sk_ scoped pengguna disimpan di KV backend (browser
  cuma pegang session id) → pengguna membayar dari pollen mereka sendiri.
  App Key `pk_*` = secret `POLLINATIONS_APP_KEY`; redirect URI callback:
  `https://<host>/callback` (terdaftar di enter.pollinations.ai/keys).
- **Generate Pollinations sinkron langsung** (tanpa antrian): `POST /api/generate`
  memanggil Pollinations sekarang juga → hasil arsip KV → balas `images`
  langsung (task tetap bisa di-poll lewat `/api/task`). Lebih cepat karena
  tidak menunggu antrian/consumer.
- **Img2Img** (upload/seret gambar + denoising strength) — TAMS
- Tab Edit / Video / Prime (placeholder), lightbox, riwayat di mobile

## Cara pakai LoRA sendiri

File LoRA lokal (mis. dari `D:\ComfyUI\models\loras`) tidak bisa langsung
dipakai — provider hanya menerima **URL publik**. Upload `.safetensors` ke
HuggingFace, lalu tempel URL `https://huggingface.co/<user>/<repo>/resolve/main/<file>.safetensors`
di kartu LoRA. (Kaggle tidak bisa: download-nya butuh login, bukan URL publik.)
Base model disediakan provider (mis. Krea 2 Turbo untuk LoRA base Krea 2).

## WD14 Tagger 🔮 (deteksi prompt dari gambar)

Fitur **image → booru tags** berjalan **online** via HF Space [`deepghs/wd14_tagging_online`](https://huggingface.co/spaces/deepghs/wd14_tagging_online):
menu `+` di VAIA Chat → **Deteksi Prompt (WD14)**,
dan tombol yang sama di tab **Img2Img** (tag foto referensi jadi prompt).

- 2 model pilihan (**wd14-convnext** / **wd14-vit**),
  slider threshold, opsi format (spasi/escape/confidence/urutan), format salin
  (A1111 kompak / + Confidence / Teks Bebas), pengaturan tersimpan di
  localStorage, dan riwayat hasil per gambar dengan **perbandingan antar model**.
- Tidak perlu mengunduh model (~190MB) — semua diproses di HF Space.
- Hasil di-cache di KV backend selama 7 hari → request kedua lebih cepat.

Panduan lengkap: **[`wd14-tagger/README.md`](wd14-tagger/README.md)**.

## Jalan lokal (tanpa API key)

```bash
python scripts/dev_server.py     # server + mock provider di http://127.0.0.1:8787
node scripts/test_backend.mjs    # 24 tes integrasi backend (fetch tiruan)
```

Buka `index.html` langsung, atau `npx serve` — tanpa build.

## Deploy

Panduan lengkap: **[DEPLOY.md](DEPLOY.md)** — Firebase Hosting + Cloud
Functions, atau Cloudflare Pages + Pages Function. Intinya:

1. Deploy repo ini ke hosting pilihanmu
2. Set API key di env: `TENSORART_API_KEY` (atau `REPLICATE_API_TOKEN` / `FAL_API_KEY`)
3. Buka web → panel kiri bawah **API** → pilih provider & mode

## Struktur

```
index.html              # UI + logika (single file, no build)
functions/api.js        # backend Cloudflare Pages Function (proxy 4 provider)
firebase-backend/        # backend Firebase Cloud Functions (versi sama)
firebase.json           # config Firebase hosting + rewrite /api/**
scripts/dev_server.py   # server lokal + mock provider
scripts/test_backend.mjs# tes integrasi backend
DEPLOY.md               # panduan deploy & API key
wd14-tagger/README.md   # dokumen WD14 Tagger (deteksi prompt dari gambar)
```
