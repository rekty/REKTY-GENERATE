# 🖥️ Rencana Deploy VPS GPU 24/7 — Endpoint Stabil untuk Pollinations

> Tujuan: mengganti sesi Kaggle/Colab gratis (max ~12 jam, URL berubah tiap sesi) dengan
> **server GPU 24/7** supaya model `rekty1988/anjany` memenuhi syarat katalog Pollinations
> (endpoint stabil + uptime tinggi) — persis yang diminta reviewer di issue #13440.

---

## 1. Kebutuhan hardware

Model yang dijalankan (per sesi GPU):
| Komponen | File | Ukuran |
|---|---|---|
| Diffusion model (fp8) | `Krea2_by_Rekty_Quantize_00001_.safetensors` | 13,8 GB |
| Text encoder (fp8) | `qwen3vl_4b_fp8_scaled.safetensors` | 4,9 GB |
| VAE | `qwen_image_vae.safetensors` | 254 MB |
| LoRA | `rekty anjany.safetensors` | 469 MB |

**VRAM yang dibutuhkan ≈ 19–20 GB** (model 13,8 + TE 4,9 + VAE + aktivasi saat sampling 832×1536).

> ⚠️ **Pilih GPU 24 GB VRAM** (RTX 4090 / 3090 / A5000 / L4 / RTX Pro 4000).
> 16 GB (mis. RTX A4000, RTX 4080) terlalu ketat dan berisiko OOM saat generate
> ukuran besar — meski tarifnya murah, tidak cocok untuk uptime stabil.

Spesifikasi non-GPU minimal:
- RAM: **≥ 32 GB** (untuk cache model + proses)
- Disk: **≥ 120 GB NVMe** (13,8 + 4,9 + sistem ≈ 25 GB, sisakan ruang output)
- OS: Ubuntu 22.04/24.04

---

## 2. Perbandingan provider + estimasi biaya (harga Agustus 2026)

| Provider | GPU (24 GB) | Harga | Perkiraan /bulan (24/7) | Catatan |
|---|---|---|---|---|
| **Vast.ai** (interruptible) | RTX 3090 / 4090 | $0,13–0,20/jam | **~$95–145** | Paling murah, tapi instance bisa di-reclaim |
| **TensorDock** | RTX 3090 | ~$0,20/jam | ~$145 | Murah, bayar per jam |
| **GPU Mart** | RTX Pro 4000 (24 GB) | $199/bln flat | **~$199** | Harga pasti, simpel |
| **RunPod** (Secure) | RTX 4090 | $0,34–0,39/jam | ~$245–280 | Paling mudah dipakai, support bagus |
| **Hostkey** | RTX 4090 | $272/bln flat | **~$272** | Dedicated, harga pasti |
| **TensorDock** | RTX 4090 | $0,31–0,37/jam | ~$225–270 | Bayar per jam |
| **Clore.ai** | RTX 4090 | $0,10–0,30/jam | ~$75–215 | Fluktuatif, bisa sangat murah |
| ~~Kaggle/Colab~~ | T4 (16 GB) | gratis | $0 | Max ~12 jam, TIDAK stabil ❌ |

### Rekomendasi
- **Anggaran kecil + fleksibel**: **Vast.ai RTX 3090/4090 interruptible** (~$100–150/bln).
  Risiko: sesekali di-reclaim → perlu auto-restart otomatis (lihat bagian 5).
- **Stabil + harga pasti**: **GPU Mart $199/bln** atau **Hostkey $272/bln** (flat, dedicated) —
  paling sesuai syarat "stable server with stable uptime" dari reviewer.
- **Paling mudah setup**: **RunPod** (template ComfyUI 1-klik + storage persisten) ~$245–280/bln.

---

## 3. Arsitektur target

```
                    ┌─────────────────────────────────────────────┐
User/app REKTY ───► │ https://api.domainmu.com  (STABIL, tetap)  │
                    │   Cloudflare Tunnel (named tunnel, gratis)  │
                    └──────────────────┬──────────────────────────┘
                                       │ 127.0.0.1:8000
                    ┌──────────────────▼──────────────────────────┐
                    │  gateway.py  (FastAPI OpenAI-compatible)    │
                    │  /v1/images/generations · /v1/models · /health
                    └──────────────────┬──────────────────────────┘
                                       │ 127.0.0.1:8188
                    ┌──────────────────▼──────────────────────────┐
                    │  ComfyUI  (Krea 2 + LoRA workflow)          │
                    └─────────────────────────────────────────────┘
```

**Penting — endpoint stabil vs quick tunnel:**
- `trycloudflare` (quick tunnel) → URL **berubah setiap restart**. Tidak stabil ❌
- **Named Tunnel Cloudflare + domain** → URL **tetap selamanya** ✅ (gratis selama domain
  diarahkan ke Cloudflare). Butuh domain murah (~$1–3/tahun, mis. `.xyz`/`.my.id`) atau
  pakai domain yang sudah kamu punya.

---

## 4. Langkah setup (sekali jalan)

```bash
# 1) Update sistem + install dependency
sudo apt update && sudo apt install -y git python3.11 python3.11-venv python3-pip curl unzip

# 2) ComfyUI
git clone https://github.com/comfyanonymous/ComfyUI ~/ComfyUI
cd ~/ComfyUI
python3.11 -m venv venv && source venv/bin/activate
pip install -r requirements.txt

# 3) Model — unduh otomatis dari HuggingFace (file-mu sudah LIVE)
mkdir -p models/diffusion_models models/text_encoders models/vae models/loras
wget -q --show-progress -O models/diffusion_models/Krea2_by_Rekty_Quantize_00001_.safetensors \
  "https://huggingface.co/rekty1988/KREA2_BY_REKTY/resolve/main/Krea2_by_Rekty_Quantize_00001_.safetensors"
wget -q --show-progress -O models/text_encoders/qwen3vl_4b_fp8_scaled.safetensors \
  "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors"
wget -q --show-progress -O models/vae/qwen_image_vae.safetensors \
  "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors"
wget -q --show-progress -O models/loras/rekty\ anjany.safetensors \
  "https://huggingface.co/rekty1988/REKTY_ANJANY/resolve/main/rekty%20anjany.safetensors"

# 4) Gateway + workflow (dari repo REKTY-GENERATE)
mkdir -p ~/rekty-gw
cp selfhost/gateway.py ~/rekty-gw/gateway.py
# workflow_api.json dihasilkan cell 6 notebook; atau salin dari sesi Kaggle terakhir

# 5) Uji manual dulu (sebelum systemd)
cd ~/ComfyUI && source venv/bin/activate
python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch &
cd ~/rekty-gw && python gateway.py &
curl http://127.0.0.1:8000/health
curl -X POST http://127.0.0.1:8000/v1/images/generations \
  -H "Content-Type: application/json" \
  -d '{"model":"rekty1988/anjany","prompt":"test","size":"832x1536"}'
```

---

## 5. Auto-restart + boot (systemd) — kunci "stable uptime"

Buat `/etc/systemd/system/comfyui.service`:
```ini
[Unit]
Description=ComfyUI (Krea 2 + REKTY)
After=network.target

[Service]
WorkingDirectory=/root/ComfyUI
ExecStart=/root/ComfyUI/venv/bin/python main.py --listen 127.0.0.1 --port 8188 --disable-auto-launch
Restart=always
RestartSec=10
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
```

Buat `/etc/systemd/system/rekty-gateway.service`:
```ini
[Unit]
Description=REKTY OpenAI-compatible gateway
After=comfyui.service

[Service]
WorkingDirectory=/root/rekty-gw
Environment=WORKFLOW_FILE=/root/rekty-gw/workflow_api.json
Environment=LORA_NAME=rekty anjany.safetensors
ExecStart=/root/ComfyUI/venv/bin/python /root/rekty-gw/gateway.py
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Aktifkan:
```bash
sudo systemctl daemon-reload
sudo systemctl enable --now comfyui.service rekty-gateway.service
# Uji: systemctl status, lalu curl localhost:8000/health
```

> Dengan `Restart=always`, kalau ComfyUI/gateway crash atau VPS reboot →
> **semua naik lagi otomatis**, dan URL tetap sama (named tunnel).

---

## 6. Endpoint stabil dengan Cloudflare Named Tunnel

```bash
# Install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

# Login (buka URL yang dicetak, pilih domain yang sudah di Cloudflare)
cloudflared tunnel login

# Buat tunnel bernama (sekali saja)
cloudflared tunnel create rekty-krea2

# Routing: krea2.domainmu.com -> http://localhost:8000
cloudflared tunnel route dns rekty-krea2 krea2.domainmu.com

# Konfigurasi /root/.cloudflared/config.yml
# tunnel: <TUNNEL_ID>
# credentials-file: /root/.cloudflared/<TUNNEL_ID>.json
# ingress:
#   - hostname: krea2.domainmu.com
#     service: http://localhost:8000
#   - service: http_status:404

# systemd (nama tunnel -> URL TETAP, auto-start)
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

Hasil: **`https://krea2.domainmu.com/v1`** — tetap selamanya, tidak pernah berubah.
Ini yang didaftarkan ke Pollinations (menggantikan trycloudflare yang rotasi).

---

## 7. Monitoring

- **Uptime Kuma** (gratis, bisa di VPS yang sama atau laptop): monitor
  `https://krea2.domainmu.com/health` tiap 60 dtk, notifikasi email/Telegram.
- **Cron healthcheck sederhana**:
  ```bash
  # crontab -e (tiap 5 menit; kalau mati 3× beruntun kirim peringatan)
  */5 * * * * curl -sf -m 20 https://krea2.domainmu.com/health || echo "DOWN $(date)" >> /var/log/rekty-health.log
  ```
- **Cek VRAM**: `nvidia-smi` — kalau sering dekat 100%, turunkan ukuran default atau
  tambah `--reserve-vram` ComfyUI.

---

## 8. Estimasi biaya bulanan (ringkas)

| Jalur | Biaya VPS | Domain | Total/bln |
|---|---|---|---|
| Hemat (Vast.ai interruptible 3090) | $95–145 | ~$1–3/thn | **~$100–150** |
| Stabil (GPU Mart 24 GB flat) | $199 | ~$1–3/thn | **~$200** |
| Stabil (Hostkey 4090 dedicated) | $272 | ~$1–3/thn | **~$273** |
| Paling mudah (RunPod 4090) | $245–280 | ~$1–3/thn | **~$245–280** |
| ~~Kaggle/Colab~~ | $0 | — | gratis tapi **tidak stabil** ❌ |

Cloudflare Tunnel + domain diarahkan ke Cloudflare = **gratis** (tier free).

---

## 9. Checklist sebelum "go live" ke Pollinations

- [ ] VPS GPU 24 GB VRAM aktif (≥32 GB RAM, ≥120 GB disk)
- [ ] ComfyUI + model (13,8 GB dari HF) + TE + VAE + LoRA terpasang
- [ ] Test generate 1 gambar sukses via `localhost:8000`
- [ ] systemd `comfyui` + `rekty-gateway` aktif (Restart=always)
- [ ] Named tunnel + domain → `https://krea2.domainmu.com/health` = `{"ok":true,...}`
- [ ] Uptime Kuma / cron healthcheck aktif
- [ ] Update issue Pollinations #13440 dengan endpoint permanen
- [ ] (Opsional) API key gateway via `GATEWAY_TOKEN` supaya publik tidak bisa pakai gratis tanpa batas

---

*Disusun 17 Agustus 2026 · harga bersifat estimasi dan bisa berubah · model:
`rekty1988/KREA2_BY_REKTY` (13,8 GB, terverifikasi) · notebook: `selfhost/rekty_colab.ipynb`*
