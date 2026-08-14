# REKTY GENERATOR 🎨

Web text-to-image generator (terinspirasi Tensor.Art) — satu file `index.html`
tanpa build, siap di-deploy ke **Firebase Hosting** atau **Cloudflare Pages**.

## Fitur

- **Generate gambar** dari prompt: kirim task → poll progress → hasil masuk grid
  + riwayat (tersimpan di localStorage, metadata asli: task ID, kredit, ukuran,
  seed, prompt)
- **3 provider** — pilih di panel API:
  | Provider | Model | API key (env) |
  |---|---|---|
  | Tensor.Art (TAMS) | Z Image, FLUX.1, SDXL, Pony, dst. | `TENSORART_API_KEY` |
  | Replicate | FLUX schnell/dev, SDXL, SD 3.5, dst. | `REPLICATE_API_TOKEN` |
  | fal.ai | FLUX, Fast SDXL, SD 3.5, **Krea 2 Turbo** | `FAL_API_KEY` |
- **Mode API**: Auto / Real / Demo (simulasi picsum) — cocok dicoba tanpa key
- **LoRA custom**: dropdown LoRA mengikuti provider; model yang butuh URL
  menampilkan field URL `.safetensors` (mis. `flux-schnell-lora`, SDXL via
  `zylim0702/sdxl-lora-customize-model` / `fal-ai/fast-sdxl`, **Krea 2** via
  `fal-ai/krea-2/turbo/lora`)
- **Img2Img** (upload/seret gambar + denoising strength) — TAMS
- Tab Edit / Video / Prime (placeholder), lightbox, riwayat di mobile

## Cara pakai LoRA sendiri

File LoRA lokal (mis. dari `D:\ComfyUI\models\loras`) tidak bisa langsung
dipakai — provider hanya menerima **URL publik**. Upload `.safetensors` ke
HuggingFace, lalu tempel URL `https://huggingface.co/<user>/<repo>/resolve/main/<file>.safetensors`
di kartu LoRA. (Kaggle tidak bisa: download-nya butuh login, bukan URL publik.)
Base model disediakan provider (mis. Krea 2 Turbo untuk LoRA base Krea 2).

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
functions/api.js        # backend Cloudflare Pages Function (proxy 3 provider)
firebase-backend/        # backend Firebase Cloud Functions (versi sama)
firebase.json           # config Firebase hosting + rewrite /api/**
scripts/dev_server.py   # server lokal + mock provider
scripts/test_backend.mjs# tes integrasi backend
DEPLOY.md               # panduan deploy & API key
```
