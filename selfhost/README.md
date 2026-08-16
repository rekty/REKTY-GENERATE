# Self-Host: Krea 2 + LoRA REKTY ANJANY → Community Model Pollinations

Tujuan: menjalankan **base model Krea 2 + LoRA REKTY ANJANY** di VPS GPU,
dipublikasikan sebagai endpoint OpenAI-compatible, lalu didaftarkan ke
Pollinations sebagai community model (muncul di katalog + bisa dipakai
di aplikasi web REKTY).

```
[VPS GPU] ComfyUI (Krea2 + LoRA REKTY ANJANY)
    │  /prompt + /history
    ▼
gateway.py (FastAPI) → POST /v1/images/generations  (format OpenAI)
    │
    ▼
cloudflared (Cloudflare Tunnel) → https://nama.trycloudflare.com (publik)
    │
    ▼
Daftarkan di Pollinations (allowlist + my-models di enter.pollinations.ai)
```

## Lisensi

Model **Krea 2** (RAW & Turbo) dirilis oleh Krea.ai di bawah
**Krea 2 Community License Agreement v.1** (22 Juni 2026). Teks resmi
lengkap tersedia di **`KREA2_LICENSE.md`** (folder ini) — diambil dari
`Comfy-Org/Krea-2/LICENSE.pdf`.

Checkpoint `Krea2_by_Rekty_Quantize_00001_.safetensors` adalah turunan
(quantize + merge LoRA) dari `krea2_turbo_fp8_scaled.safetensors`, jadi
penggunaannya tunduk pada lisensi komunitas yang sama. Baca ketentuannya
sebelum penggunaan komersial.

## 0. Jalan cepat GRATIS: Google Colab

Tidak punya VPS? Buka **`selfhost/rekty_colab.ipynb`** di
[colab.research.google.com](https://colab.research.google.com) (Runtime ->
**Change runtime type -> GPU T4**, lalu Run all). Notebook otomatis:

1. Install ComfyUI
2. Download Krea 2 Turbo fp8 (13 GB) + Qwen3-VL-4B text encoder + VAE + **LoRA REKTY ANJANY**
   *(atau checkpoint-mu sendiri — tempel URL HuggingFace di `CHECKPOINT_URL`)*
3. Bangun workflow Krea 2 + LoRA (node: UNETLoader -> LoraLoaderModelOnly ->
   CLIPLoader krea2 -> KSampler er_sde/simple -> VAEDecode)
4. Jalankan `gateway.py` (OpenAI-compatible)
5. Expose lewat **Cloudflare Tunnel** -> mencetak URL publik

Lalu pakai URL itu seperti bagian 6 di bawah. Catatan: sesi Colab gratis mati
otomatis (~90 mnt idle / ~12 jam) — URL ikut mati, jalankan ulang notebook.

> Notebook di-generate dari `gateway.py` lewat `scripts/build_colab.py`.
> Kalau `gateway.py` berubah, jalankan ulang: `python scripts/build_colab.py`

## 1. Siapkan VPS GPU

Pilih salah satu (terjangkau → mahal):
- **Vast.ai** / **TensorDock** / **RunPod** — paling murah ($10–40/bln, GPU 12–24GB)
- **Lambda** / **Google Cloud / AWS** — lebih stabil, lebih mahal

Syarat minimal GPU: **16 GB VRAM** (Krea 2 turbo + LoRA nyaman di 12–16 GB).

## 2. Pasang ComfyUI + model-mu di VPS

```bash
git clone https://github.com/comfyanonymous/ComfyUI.git
cd ComfyUI
pip install -r requirements.txt
# masukkan ke models/checkpoints/:  Krea2_by_Rekty_Quantize_00001_.safetensors
# masukkan ke models/loras/:        rekty anjany.safetensors
python main.py --listen 0.0.0.0 --port 8188
```

## 3. Export workflow (API format) — WAJIB

1. Buka ComfyUI di browser, buat workflow: **CheckpointLoader (Krea2)** →
   **LoraLoader (rekty anjany)** → **KSampler** → **VAEDecode** → **SaveImage**
2. Klik menu → **Save (API Format)** → simpan sebagai
   `selfhost/workflow_api.json` di proyek ini

## 4. Jalankan gateway

```bash
cd selfhost
pip install -r requirements.txt
python gateway.py          # http://0.0.0.0:8000
```

*(Di Colab, gateway dijalankan otomatis oleh notebook — lihat bagian 0.)*

Tes lokal:
```bash
curl -X POST http://localhost:8000/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"prompt":"a cat with blue eyes","size":"832x1536","seed":123}'
```

Variabel env opsional:
- `COMFY_URL` — alamat ComfyUI (default `http://127.0.0.1:8188`)
- `LORA_NAME` — nama file LoRA di ComfyUI (default `rekty anjany.safetensors`)
- `WORKFLOW_FILE` — path workflow API JSON
- `GATEWAY_TOKEN` — kalau mau proteksi endpoint dengan token sendiri
- `PORT` — port gateway (default 8000)

## 5. Publikasikan dengan Cloudflare Tunnel (gratis)

```bash
# instal cloudflared di VPS, lalu:
cloudflared tunnel --url http://localhost:8000
# muncul URL publik seperti: https://xxxx.trycloudflare.com
```

Catat URL itu — ini yang didaftarkan ke Pollinations.
*(Tips: tanpa cloudflared, pakai reverse proxy Nginx + HTTPS + domain sendiri.)*

## 6. Daftarkan ke Pollinations

1. Login **enter.pollinations.ai** dengan akun **GitHub**
2. Ajukan akses publisher lewat template issue
   **"Community Model Publisher Allowlist"** di
   `github.com/pollinations/pollinations/issues/new` —
   isi jenis model **Image generation**, endpoint URL gateway-mu,
   hosting & limits, konfirmasi wajib
3. Setelah disetujui, daftarkan model di dashboard **my-models**:
   - Nama model: `rekty1988/anjany`
   - Endpoint: `https://xxxx.trycloudflare.com/v1`
4. Model muncul di katalog → otomatis terlihat di dropdown model
   Pollinations di aplikasi REKTY

## Verifikasi kesiapan endpoint

```bash
# Pollinations mensyaratkan OpenAI-compatible — cek:
curl https://xxxx.trycloudflare.com/v1/models
curl -X POST https://xxxx.trycloudflare.com/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"model":"rekty1988/anjany","prompt":"test","size":"832x1536"}'
```

## Estimasi biaya

| Item | Biaya |
|---|---|
| VPS GPU (Vast.ai, 16GB) | ~$10–25/bln |
| ComfyUI + gateway | gratis |
| Cloudflare Tunnel | gratis |
| **Total** | **~$10–25/bln** |
