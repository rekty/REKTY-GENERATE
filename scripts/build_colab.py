"""
scripts/build_colab.py — Bangun selfhost/rekty_colab.ipynb (reproducible).

Notebook berjalan di Google Colab ATAU Kaggle (deteksi otomatis):
- Colab  -> /content
- Kaggle -> /kaggle/working (baca checkpoint dari dataset input bila DATASET_SLUG diisi)

Gateway.py disisipkan sebagai base64 agar tidak bergantung pada repo GitHub
(yang privat). Jalankan ulang setiap kali gateway.py berubah:

    python scripts/build_colab.py

Output: selfhost/rekty_colab.ipynb
"""
import base64
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATEWAY = os.path.join(ROOT, "selfhost", "gateway.py")
OUT = os.path.join(ROOT, "selfhost", "rekty_colab.ipynb")


def b64_gateway() -> str:
    src = open(GATEWAY, encoding="utf-8").read()
    # buang docstring modul awal agar tidak bentrok dengan string triple-quote
    body = src.split('"""', 2)[2]
    return base64.b64encode(body.encode()).decode()


def cell(kind: str, lines: list[str]) -> dict:
    return {
        "cell_type": kind,
        "metadata": {},
        **( {"source": lines} if kind == "markdown" else {"execution_count": None, "outputs": [], "source": lines} ),
    }


def md(text: str) -> dict:
    return cell("markdown", [text])


def code(*lines: str) -> dict:
    return cell("code", [l + "\n" for l in lines])


CONFIG = code(
    "# ============================================================",
    "#  KONFIGURASI  -  ubah sesuai kebutuhan, lalu jalankan sel ini",
    "# ============================================================",
    "",
    "# Di KAGGLE: kalau checkpoint-mu terpasang sebagai dataset input, isi nama",
    "# dataset-nya di sini (lihat panel Input, mis. rektyanjany/krea2-by-rekty).",
    "# Notebook otomatis membaca file dari /kaggle/input/<DATASET_SLUG>/",
    'DATASET_SLUG = ""',
    'CKPT_FILENAME = "Krea2_by_Rekty_Quantize_00001_.safetensors"',
    "",
    "# CHECKPOINT via URL (dipakai kalau bukan dari dataset Kaggle):",
    "# default = file REKTY di HuggingFace; kosongkan untuk Krea 2 Turbo resmi.",
    'CHECKPOINT_URL = "https://huggingface.co/rekty1988/KREA2_BY_REKTY/resolve/main/Krea2_by_Rekty_Quantize_00001_.safetensors"',
    "",
    "# LoRA REKTY ANJANY-mu (sudah publik di HuggingFace - dipakai otomatis)",
    'LORA_URL      = "https://huggingface.co/rekty1988/REKTY_ANJANY/resolve/main/rekty%20anjany.safetensors"',
    "",
    "# LORA_STRENGTH - kekuatan TAMBAHAN LoRA di runtime.",
    "# Checkpoint Krea2_by_Rekty SUDAH baked-in LoRA ANJANY (0.5 saat quantize),",
    "# jadi default 0.0 = TIDAK dobel (LoRA tetap termuat tapi tanpa efek tambahan).",
    "# Naikkan ke 0.3-0.5 kalau mau gaya ANJANY lebih kuat lagi dari bawaan.",
    "LORA_STRENGTH = 0.0",
    "",
    "# File pendukung resmi Krea 2 (jangan diubah)",
    'TE_URL  = "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_fp8_scaled.safetensors"',
    'VAE_URL = "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/vae/qwen_image_vae.safetensors"',
    'OFFICIAL_CKPT_URL = "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/diffusion_models/krea2_turbo_fp8_scaled.safetensors"',
    "",
    "# Parameter generate default (bisa diubah lewat endpoint nanti)",
    "STEPS, CFG = 8, 1.0",
    'SAMPLER, SCHEDULER = "er_sde", "simple"',
    'MODEL_ID = "rekty1988/anjany"',
    "",
    'print("Konfigurasi siap. DATASET_SLUG :", DATASET_SLUG or "(kosong - pakai URL)")',
)

GPU_CHECK = code(
    "# 1) Cek GPU - harus ada Tesla T4 / P100 / L4 (bukan CPU)",
    "!nvidia-smi",
)

INSTALL = code(
    "# 2) Deteksi platform + install ComfyUI (sekali saja)",
    "import os",
    'IS_KAGGLE = os.path.exists("/kaggle")',
    'WORK = "/kaggle/working" if IS_KAGGLE else "/content"',
    'COMFY = WORK + "/ComfyUI"',
    'print("Platform :", "Kaggle" if IS_KAGGLE else "Colab", "| WORK :", WORK)',
    'if not os.path.exists(COMFY + "/main.py"):',
    "    !git clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git {COMFY}",
    "    !pip install -q -r {COMFY}/requirements.txt",
    'print("ComfyUI siap di", COMFY)',
)

DOWNLOAD = code(
    "# 3) Siapkan model - urutan: dataset Kaggle -> URL HF -> Krea 2 Turbo resmi",
    "import os, urllib.request, glob",
    "",
    "# Ukuran file yang diharapkan (byte) - diverifikasi otomatis setelah download",
    "EXPECTED_SIZE = {",
    '    "Krea2_by_Rekty_Quantize_00001_.safetensors": 13_784_917_560,  # file REKTY-mu (13,8 GB)',
    '    "krea2_turbo_fp8_scaled.safetensors":        13_141_730_784,  # Krea 2 Turbo resmi (13,1 GB)',
    "}",
    "",
    "def _check_size(dest):",
    '    """Verifikasi ukuran file; True kalau cocok dengan yang diharapkan."""',
    "    name = os.path.basename(dest)",
    "    exp = EXPECTED_SIZE.get(name)",
    "    if exp is None:",
    "        return True",
    "    sz = os.path.getsize(dest)",
    "    ok = (sz == exp)",
    '    print(f"  verifikasi {name}: {sz:,} byte vs {exp:,} ->", "OK" if ok else "TIDAK COCOK")',
    "    return ok",
    "",
    "def dl(url, dest):",
    "    if os.path.exists(dest) and os.path.getsize(dest) > 1_000_000:",
    '        print("sudah ada :", os.path.basename(dest))',
    "        return _check_size(dest)",
    '    print("Download  :", os.path.basename(dest))',
    "    urllib.request.urlretrieve(url, dest)",
    '    print("  selesai :", round(os.path.getsize(dest) / 2**30, 2), "GB")',
    "    return _check_size(dest)",
    "",
    "# --- (a) Checkpoint dari dataset Kaggle (kalau ada) ---",
    "got = None",
    "ckpt_source = None",
    "if IS_KAGGLE and DATASET_SLUG:",
    '    hits = glob.glob("/kaggle/input/" + DATASET_SLUG + "/**/" + CKPT_FILENAME, recursive=True)',
    "    if hits:",
    "        got = hits[0]",
    '        ckpt_source = "dataset Kaggle"',
    '        print("Checkpoint dari dataset Kaggle :", got)',
    "",
    "# --- (b) Checkpoint dari URL HF (file-mu dulu, lalu resmi) ---",
    "if got is None:",
    "    for url in [CHECKPOINT_URL, OFFICIAL_CKPT_URL]:",
    "        if not url:",
    "            continue",
    '        name = os.path.basename(url).split("?")[0]',
    '        dest = COMFY + "/models/diffusion_models/" + name',
    "        try:",
    "            if dl(url, dest):",
    "                got = dest",
    '                ckpt_source = "REKTY (HuggingFace)" if url == CHECKPOINT_URL else "Krea 2 RESMI (fallback)"',
    "                break",
    "        except Exception as e:",
    '            print("Gagal download", name, ":", e)',
    '            print("-> coba alternatif...")',
    "",
    "assert got is not None, \"Tidak ada checkpoint yang bisa dipakai!\"",
    "ckpt_name = os.path.basename(got)",
    "CKPT_DEST = got",
    "",
    "# Peringatan JELAS kalau checkpoint BUKAN file REKTY-mu",
    'if ckpt_source not in ("REKTY (HuggingFace)", "dataset Kaggle"):',
    "    print()",
    '    print("=" * 60)',
    '    print("  PERINGATAN: checkpoint yang dipakai =", ckpt_source)',
    '    print("  BUKAN file REKTY-mu (Krea2_by_Rekty_Quantize_00001_)!")',
    '    print("  Cek CHECKPOINT_URL / koneksi ke HuggingFace, lalu Run all ulang.")',
    '    print("=" * 60)',
    "",
    "# Pastikan folder model ada (aman walau ComfyUI belum pernah dijalankan)",
    'for _d in ["diffusion_models", "text_encoders", "vae", "loras"]:',
    '    os.makedirs(COMFY + "/models/" + _d, exist_ok=True)',
    "",
    "# --- (c) Text encoder + VAE + LoRA (dari HuggingFace, publik) ---",
    "for url, dest in [",
    "    (TE_URL,   COMFY + \"/models/text_encoders/qwen3vl_4b_fp8_scaled.safetensors\"),",
    "    (VAE_URL,  COMFY + \"/models/vae/qwen_image_vae.safetensors\"),",
    "    (LORA_URL, COMFY + \"/models/loras/rekty anjany.safetensors\"),",
    "]:",
    "    try:",
    "        dl(url, dest)",
    "    except Exception as e:",
    '        print("Gagal download", os.path.basename(dest), ":", e)',
    "",
    "print()",
    'print("SEMUA MODEL SIAP. Checkpoint :", ckpt_name, "| sumber:", ckpt_source)',
)

WORKFLOW = code(
    "# 4) Bangun workflow ComfyUI (API format) - Krea 2 + LoRA REKTY ANJANY",
    "import json",
    "",
    "workflow = {",
    '  "1":  {"class_type": "UNETLoader",          "inputs": {"unet_name": ckpt_name, "weight_dtype": "default"}},',
    '  "2":  {"class_type": "LoraLoaderModelOnly", "inputs": {"lora_name": "rekty anjany.safetensors", "strength_model": LORA_STRENGTH, "model": ["1", 0]}},',
    '  "3":  {"class_type": "CLIPLoader",          "inputs": {"clip_name": "qwen3vl_4b_fp8_scaled.safetensors", "type": "krea2"}},',
    '  "4":  {"class_type": "CLIPTextEncode",      "inputs": {"text": "contoh prompt", "clip": ["3", 0]}},',
    '  "5":  {"class_type": "CLIPTextEncode",      "inputs": {"text": "low quality, worst quality, blurry", "clip": ["3", 0]}},',
    '  "6":  {"class_type": "EmptyLatentImage",    "inputs": {"width": 832, "height": 1536, "batch_size": 1}},',
    '  "7":  {"class_type": "KSampler",            "inputs": {"seed": 42, "steps": STEPS, "cfg": CFG, "sampler_name": SAMPLER, "scheduler": SCHEDULER, "denoise": 1.0, "model": ["2", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0]}},',
    '  "8":  {"class_type": "VAEDecode",           "inputs": {"samples": ["7", 0], "vae": ["9", 0]}},',
    '  "9":  {"class_type": "VAELoader",           "inputs": {"vae_name": "qwen_image_vae.safetensors"}},',
    '  "10": {"class_type": "SaveImage",           "inputs": {"filename_prefix": "rekty", "images": ["8", 0]}},',
    "}",
    "",
    'with open(WORK + "/workflow_api.json", "w") as f:',
    "    json.dump(workflow, f)",
    'print("workflow_api.json siap -", ckpt_name)',
)

START_COMFY = code(
    "# 5) Jalankan ComfyUI di background + tunggu sampai siap",
    "import subprocess, sys, time, urllib.request",
    "",
    'log = open(WORK + "/comfy.log", "w")',
    "proc = subprocess.Popen(",
    '    [sys.executable, "main.py", "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch"],',
    "    cwd=COMFY, stdout=log, stderr=subprocess.STDOUT)",
    "",
    "ok = False",
    "for _ in range(120):",
    "    time.sleep(3)",
    "    try:",
    '        r = urllib.request.urlopen("http://127.0.0.1:8188/system_stats", timeout=3)',
    "        if r.status == 200:",
    "            ok = True",
    "            break",
    "    except Exception:",
    "        pass",
    "",
    "if ok:",
    '    print("ComfyUI SIAP di port 8188 (pid", proc.pid, ")")',
    "else:",
    '    print("Belum siap - lihat", WORK + "/comfy.log :")',
    '    print(open(WORK + "/comfy.log").read()[-2000:])',
)

GATEWAY = code(
    "# 6) Pasang + jalankan gateway OpenAI-compatible (endpoint /v1/images/generations)",
    "import base64, os, subprocess, sys, time, urllib.request",
    "",
    'GATEWAY_B64 = "%s"' % b64_gateway(),
    "",
    'open(WORK + "/gateway.py", "w").write(base64.b64decode(GATEWAY_B64).decode("utf-8"))',
    "!pip install -q fastapi uvicorn requests",
    "",
    "# matikan gateway lama yang masih pegang port 8000 (supaya yang baru pasti terpakai)",
    "import glob",
    "for d in glob.glob('/proc/[0-9]*'):",
    "    try:",
    "        cmd = open(d + '/cmdline', 'rb').read().replace(b'\\0', b' ').decode('utf-8', 'ignore')",
    "        if 'gateway.py' in cmd:",
    "            os.kill(int(d.split('/')[-1]), 9)",
    "    except Exception:",
    "        pass",
    "time.sleep(3)",
    "",
    "env = dict(os.environ,",
    '           WORKFLOW_FILE=WORK + "/workflow_api.json",',
    '           LORA_NAME="rekty anjany.safetensors")',
    "",
    'glog = open(WORK + "/gateway.log", "w")',
    "gproc = subprocess.Popen([sys.executable, WORK + \"/gateway.py\"],",
    "                         stdout=glog, stderr=subprocess.STDOUT, env=env)",
    "",
    "ok = False",
    "for _ in range(60):",
    "    time.sleep(2)",
    "    try:",
    '        r = urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3)',
    "        if r.status == 200:",
    "            ok = True",
    "            break",
    "    except Exception:",
    "        pass",
    "",
    "if ok:",
    '    print("GATEWAY SIAP di port 8000 (pid", gproc.pid, ")")',
    "else:",
    '    print("Belum siap - lihat", WORK + "/gateway.log :")',
    '    print(open(WORK + "/gateway.log").read()[-2000:])',
)

TUNNEL = code(
    "# 7) Publikasikan dengan Cloudflare Tunnel (gratis) - cetak URL publik",
    "!wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared",
    "!chmod +x /usr/local/bin/cloudflared",
    "",
    "import re, subprocess, time",
    "",
    'tlog = open(WORK + "/tunnel.log", "w")',
    "tproc = subprocess.Popen(",
    '    ["cloudflared", "tunnel", "--url", "http://127.0.0.1:8000", "--no-autoupdate"],',
    "    stdout=tlog, stderr=subprocess.STDOUT)",
    "",
    "url = None",
    "for i in range(120):",
    "    time.sleep(2)",
    '    txt = open(WORK + "/tunnel.log").read()',
    '    m = re.search(r"https://[-a-z0-9]+\\.trycloudflare\\.com", txt)',
    "    if m:",
    "        url = m.group(0)",
    "        break",
    "    if i % 10 == 0:",
    '        print("  menunggu URL cloudflared...", (i + 1) * 2, "s", flush=True)',
    "",
    "# Simpan URL ke file - biar sel KEEP-ALIVE bisa mencetaknya ulang",
    'with open(WORK + "/endpoint.txt", "w") as f:',
    '    f.write(url or "")',
    "",
    "print()",
    'print("============================================================")',
    'print("  ENDPOINT PUBLIK KAMU :", url or "(belum dapat - lihat " + WORK + "/tunnel.log)")',
    'print("============================================================")',
    "if url:",
    '    print("Tes cepat  :")',
    '    print("  curl", url + "/v1/models")',
    '    print("  curl -X POST", url + "/v1/images/generations",',
    "          \"-H 'Content-Type: application/json'\",",
    '          "-d \'{\\"prompt\\":\\"a cat with blue eyes\\",\\"size\\":\\"832x1536\\"}\'")',
)

KEEP_ALIVE = code(
    "# 8) KEEP-ALIVE \u2014 biarkan sel ini BERJALAN SELAMANYA (jangan di-stop).",
    "# Selama sel ini mengeksekusi, sesi tidak dianggap idle -> tidak di-timeout",
    "# karena nganggur. Tiap 45 detik: cek ComfyUI (8188) + gateway (8000);",
    "# kalau mati, restart otomatis.",
    "import time, subprocess, sys, os, urllib.request",
    "",
    'COMFY = WORK + "/ComfyUI"',
    'GW = WORK + "/gateway.py"',
    "",
    "def _up(port):",
    "    try:",
    '        r = urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5)',
    "        return r.status == 200",
    "    except Exception:",
    "        return False",
    "",
    "def _start_comfy():",
    '    log = open(WORK + "/comfy.log", "w")',
    '    subprocess.Popen([sys.executable, "main.py", "--listen", "127.0.0.1", "--port", "8188", "--disable-auto-launch"],',
    "                     cwd=COMFY, stdout=log, stderr=subprocess.STDOUT)",
    "",
    "def _start_gateway():",
    '    env = dict(os.environ, WORKFLOW_FILE=WORK + "/workflow_api.json", LORA_NAME="rekty anjany.safetensors")',
    '    log = open(WORK + "/gateway.log", "w")',
    "    subprocess.Popen([sys.executable, GW], stdout=log, stderr=subprocess.STDOUT, env=env)",
    "",
    "def _endpoint():",
    "    try:",
    '        with open(WORK + "/endpoint.txt") as f:',
    "            return f.read().strip()",
    "    except Exception:",
    '        return ""',
    "",
    "t0 = time.time()",
    "print(time.strftime('%H:%M:%S'), 'KEEP-ALIVE berjalan. ENDPOINT:',",
    "      _endpoint() or '(belum ada - tunggu sel tunnel)', flush=True)",
    "while True:",
    "    if not _up(8188):",
    '        print(time.strftime("%H:%M:%S"), "ComfyUI mati -> restart", flush=True)',
    "        _start_comfy()",
    "    if not _up(8000):",
    '        print(time.strftime("%H:%M:%S"), "gateway mati -> restart", flush=True)',
    "        _start_gateway()",
    "    elif time.time() - t0 > 3600:",
    '        ep = _endpoint()',
    '        print(time.strftime("%H:%M:%S"), "semua OK (heartbeat) - ENDPOINT:",',
    '              ep or "(belum dapat - jalankan sel tunnel)", flush=True)',
    "        t0 = time.time()",
    "    time.sleep(45)",
)

NOTEBOOK = {
    "nbformat": 4,
    "nbformat_minor": 0,
    "metadata": {
        "colab": {"provenance": [], "gpuType": "T4"},
        "kernelspec": {"name": "python3", "display_name": "Python 3"},
        "language_info": {"name": "python"},
    },
    "cells": [
        md(
            "# REKTY \u2014 Krea 2 + LoRA REKTY ANJANY di Colab / Kaggle (gratis)\n"
            "\n"
            "Jalankan **base model Krea 2 + LoRA REKTY ANJANY-mu** di GPU gratis "
            "(Google Colab **atau** Kaggle), lalu publikasikan lewat Cloudflare Tunnel "
            "sebagai endpoint **OpenAI-compatible** (`/v1/images/generations`) \u2014 "
            "siap didaftarkan ke Pollinations sebagai community model.\n"
            "\n"
            "```\n"
            "[GPU gratis]  ComfyUI (Krea 2 + LoRA REKTY ANJANY)\n"
            "      |  /prompt + /history\n"
            "      v\n"
            "gateway.py  ->  POST /v1/images/generations  (format OpenAI)\n"
            "      |\n"
            "      v\n"
            "cloudflared  ->  https://xxxx.trycloudflare.com  (URL publik)\n"
            "```\n"
            "\n"
            "**Cara pakai:** jalankan semua sel dari atas ke bawah (Runtime -> Run all), "
            "tunggu sampai muncul URL `https://xxx.trycloudflare.com`, lalu pakai URL itu "
            "di Pollinations / app REKTY. Total download ~19 GB (sekali saja)."
        ),
        md(
            "## \u2699\ufe0f KONFIGURASI\n"
            "\n"
            "Jalankan sel berikut, lalu pilih platform:\n"
            "\n"
            "**Google Colab** \u2014 Runtime -> Change runtime type -> **GPU T4**\n"
            "\n"
            "**Kaggle** \u2014 di Settings notebook: **Accelerator = GPU** (T4/P100) dan "
            "**Internet = On**; kalau checkpoint-mu terpasang sebagai dataset input, "
            "isi `DATASET_SLUG` di sel KONFIGURASI (lihat panel Input).\n"
            "\n"
            "Lalu Runtime -> **Run all** (atau jalankan sel satu per satu)."
        ),
        CONFIG,
        GPU_CHECK,
        INSTALL,
        DOWNLOAD,
        WORKFLOW,
        START_COMFY,
        GATEWAY,
        TUNNEL,
        KEEP_ALIVE,
        md(
            "## \u2705 Selesai \u2014 cara pakai URL-nya\n"
            "\n"
            "1. **Salin URL** `https://xxx.trycloudflare.com` dari output sel terakhir (biarkan sel itu tetap berjalan).\n"
            "2. **Tes langsung** (boleh di sel baru / terminal lokal):\n"
            "   ```\n"
            "   curl https://xxx.trycloudflare.com/v1/models\n"
            "   curl -X POST https://xxx.trycloudflare.com/v1/images/generations \\\n"
            "     -H \"Content-Type: application/json\" \\\n"
            "     -d '{\"model\":\"rekty1988/anjany\",\"prompt\":\"a cat with blue eyes\",\"size\":\"832x1536\"}'\n"
            "   ```\n"
            "3. **Daftarkan ke Pollinations** (biar muncul di katalog): login **enter.pollinations.ai** dengan akun "
            "GitHub \u2192 ajukan akses publisher lewat template issue **\"Community Model Publisher Allowlist\"** "
            "\u2192 setelah disetujui, daftarkan di **my-models**:\n"
            "   - Nama model : `rekty1988/anjany`\n"
            "   - Endpoint   : `https://xxx.trycloudflare.com/v1`\n"
            "4. Model muncul di katalog Pollinations \u2192 otomatis terlihat di **dropdown model Pollinations** di aplikasi REKTY.\n"
            "\n"
            "### \u26a0\ufe0f Penting (batas gratis)\n"
            "- Sesi Colab/Kaggle gratis **mati otomatis** (idle ~90 mnt / maks ~12 jam). Saat mati, URL ikut mati "
            "\u2014 jalankan ulang semua sel (model tersimpan di disk, download tidak perlu diulang).\n"
            "- Kaggle: kuota ~30 jam/minggu; wajib verifikasi HP untuk GPU.\n"
            "- Untuk **24/7** (syarat Pollinations community model) butuh VPS GPU berbayar \u2014 lihat `selfhost/README.md`.\n"
            "- Checkpoint sumber: dataset Kaggle (isi `DATASET_SLUG`) -> URL HF-mu (`CHECKPOINT_URL`) -> "
            "otomatis jatuh ke **Krea 2 Turbo resmi** bila gagal.\n"
            "\n"
            "### \u23f1\ufe0f Jaga sesi tetap hidup (penting saat nunggu review Pollinations)\n"
            "\n"
            "Jalankan **sel KEEP-ALIVE** (sel terakhir) dan **biarkan berjalan** \u2014 selama sel itu "
            "mengeksekusi, sesi tidak dianggap idle sehingga tidak di-timeout karena nganggur. "
            "Cek tiap 45 detik: kalau ComfyUI/gateway mati, restart otomatis. "
            "Batasan tetap: sesi gratis maks \u00b112 jam \u2014 setelah itu mati dan tinggal Run all ulang "
            "(download tidak diulang selama sesi masih hidup)."
        ),
    ],
}

with open(OUT, "w", encoding="utf-8") as f:
    json.dump(NOTEBOOK, f, ensure_ascii=False, indent=1)

print("OK ->", OUT, "|", len(NOTEBOOK["cells"]), "cells")
