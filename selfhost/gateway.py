"""
selfhost/gateway.py — Gateway OpenAI-compatible untuk ComfyUI.

Endpoint ini yang didaftarkan ke Pollinations sebagai community model.
Format request = OpenAI Images API:

    POST /v1/images/generations
    { "model": "rekty1988/anjany", "prompt": "...", "n": 1, "size": "832x1536", "seed": 123 }

Alur:
1. Terima request OpenAI
2. Muat workflow ComfyUI (export "Save (API Format)" dari UI ComfyUI-mu,
   workflow sudah berisi: CheckpointLoader Krea2 + LoraLoader REKTY ANJANY
   + KSampler + VAEDecode)
3. Isi prompt / seed / steps / cfg / size / sampler / scheduler / lora
4. POST ke ComfyUI /prompt -> poll /history -> balas base64 gambar

Jalankan:
    pip install -r requirements.txt
    python gateway.py                  # http://0.0.0.0:8000
    # tes: curl -X POST http://localhost:8000/v1/images/generations -H "Content-Type: application/json" -d '{"prompt":"a cat","size":"832x1536"}'
"""
import base64
import io
import json
import os
import threading
import time
import urllib.parse
import uuid

import requests
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# ---------------- konfigurasi ----------------
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")   # URL ComfyUI
WORKFLOW_FILE = os.environ.get(
    "WORKFLOW_FILE",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "workflow_api.json"),
)
LORA_NAME = os.environ.get("LORA_NAME", "rekty anjany.safetensors")
API_TOKEN = os.environ.get("GATEWAY_TOKEN", "")   # opsional: kasih token sendiri
MODEL_NAMES = ["rekty1988/anjany", "krea2", "anjany", "rekty"]

app = FastAPI(title="REKTY ComfyUI Gateway (OpenAI-compatible)")

# CORS terbuka: endpoint publik — dipanggil langsung dari browser
# (app REKTY di https://rekty-generator.pages.dev) untuk generate tanpa
# melewati proxy (menghindari batas timeout subrequest Cloudflare Workers).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["*"],
)

# ---------------- task async (biar request tidak menggantung) ----------------
# Mode async: POST /v1/images/generations {\"async\": true} balas task_id
# langsung, generate jalan di thread background, klien polling
# GET /v1/tasks/<task_id> sampai status completed.
TASKS: dict = {}
_TASKS_LOCK = threading.Lock()


def _bg_generate(task_id: str, body: dict) -> None:
    """Jalankan generate di background dan simpan hasilnya ke TASKS."""
    try:
        model = str(body.get("model", "rekty1988/anjany"))
        if model not in MODEL_NAMES:
            raise ValueError(f"Model '{model}' tidak dikenal")
        prompt = str(body.get("prompt", "")).strip()
        if not prompt:
            raise ValueError("prompt kosong")
        size = str(body.get("size", "832x1536"))
        n = int(body.get("n", 1) or 1)
        seed = int(body.get("seed", 0) or 0)
        steps = int(body.get("steps", 25) or 25)
        cfg = float(body.get("cfg", 1.0) or 1.0)
        sampler = str(body.get("sampler", "er_sde"))
        scheduler = str(body.get("scheduler", "simple"))
        negative = str(body.get("negative_prompt", "low quality, worst quality"))
        wf = load_workflow()
        inject(wf, prompt, size, seed, steps, cfg, sampler, scheduler, negative, LORA_NAME)
        imgs = run_comfy(wf)
        out = [{"b64_json": imgs[i % len(imgs)]} for i in range(n)]
        with _TASKS_LOCK:
            TASKS[task_id] = {"status": "completed", "data": out}
    except Exception as e:
        with _TASKS_LOCK:
            TASKS[task_id] = {"status": "error", "error": str(e)}


@app.get("/v1/tasks/{task_id}")
async def task_status(task_id: str):
    with _TASKS_LOCK:
        t = TASKS.get(task_id)
    if t is None:
        return JSONResponse({"error": {"message": "task tidak dikenal", "type": "invalid_request_error"}}, status_code=404)
    if t["status"] == "processing":
        return {"task_id": task_id, "status": "processing"}
    if t["status"] == "error":
        return {"task_id": task_id, "status": "error", "error": t["error"]}
    return {"task_id": task_id, "status": "completed", "data": t["data"]}


def load_workflow() -> dict:
    with open(WORKFLOW_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def find_nodes(wf: dict, node_type: str):
    """Semua node ComfyUI dengan tipe tertentu (API format: dict {id: {class_type, inputs}})."""
    out = []
    for nid, node in wf.items():
        if node.get("class_type") == node_type:
            out.append((nid, node))
    return out


def inject(wf: dict, prompt: str, size: str, seed: int, steps: int, cfg: float,
           sampler: str, scheduler: str, negative: str, lora_name: str) -> dict:
    w, h = (int(x) for x in size.lower().split("x"))
    # prompt positif: CLIPTextEncode pertama (biasanya "positive")
    encs = find_nodes(wf, "CLIPTextEncode")
    if encs:
        encs[0][1]["inputs"]["text"] = prompt
        if len(encs) > 1:
            encs[1][1]["inputs"]["text"] = negative
    # ukuran latensi
    for _nid, node in find_nodes(wf, "EmptyLatentImage"):
        node["inputs"]["width"] = w
        node["inputs"]["height"] = h
    # sampler
    for _nid, node in find_nodes(wf, "KSampler"):
        node["inputs"]["seed"] = seed
        node["inputs"]["steps"] = steps
        node["inputs"]["cfg"] = cfg
        if node.get("inputs", {}).get("sampler_name") is not None:
            node["inputs"]["sampler_name"] = sampler
        if node.get("inputs", {}).get("scheduler") is not None:
            node["inputs"]["scheduler"] = scheduler
    # LoRA (LoraLoader biasa maupun LoraLoaderModelOnly untuk UNET-only)
    lora_nodes = find_nodes(wf, "LoraLoader") + find_nodes(wf, "LoraLoaderModelOnly")
    for _nid, node in lora_nodes:
        node["inputs"]["lora_name"] = lora_name
    return wf


def run_comfy(wf: dict, timeout: int = 600) -> list:
    """Kirim workflow ke ComfyUI, tunggu selesai, balas daftar b64 image."""
    r = requests.post(f"{COMFY_URL}/prompt", json={"prompt": wf}, timeout=30)
    r.raise_for_status()
    prompt_id = r.json()["prompt_id"]
    # poll history
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(1.5)
        h = requests.get(f"{COMFY_URL}/history/{prompt_id}", timeout=30)
        if h.status_code != 200:
            continue
        data = h.json()
        if prompt_id not in data:
            continue
        outputs = data[prompt_id].get("outputs", {})
        images = []
        for _nid, out in outputs.items():
            for img in out.get("images", []):
                fn = img["filename"]
                sub = img.get("subfolder", "")
                ct = img.get("type", "output")
                q = urllib.parse.urlencode({"filename": fn, "subfolder": sub, "type": ct})
                raw = requests.get(f"{COMFY_URL}/view?{q}", timeout=60)
                raw.raise_for_status()
                images.append(base64.b64encode(raw.content).decode("ascii"))
        if images:
            return images
        if data[prompt_id].get("status", {}).get("status_str") == "error":
            raise RuntimeError("ComfyUI workflow error")
    raise TimeoutError("ComfyUI tidak selesai dalam batas waktu")


@app.post("/v1/images/generations")
async def images_generations(req: Request):
    try:
        body = await req.json()
    except Exception:
        return JSONResponse({"error": {"message": "JSON tidak valid", "type": "invalid_request_error"}}, status_code=400)

    # auth opsional (token sendiri)
    if API_TOKEN:
        auth = req.headers.get("authorization", "").replace("Bearer ", "")
        if auth != API_TOKEN:
            return JSONResponse({"error": {"message": "Token salah", "type": "invalid_api_key"}}, status_code=401)

    model = str(body.get("model", "rekty1988/anjany"))
    if model not in MODEL_NAMES:
        return JSONResponse({"error": {"message": f"Model '{model}' tidak dikenal", "type": "invalid_request_error"}}, status_code=400)
    prompt = str(body.get("prompt", "")).strip()
    if not prompt:
        return JSONResponse({"error": {"message": "prompt kosong", "type": "invalid_request_error"}}, status_code=400)
    size = str(body.get("size", "832x1536"))
    n = int(body.get("n", 1) or 1)
    seed = int(body.get("seed", 0) or 0)
    steps = int(body.get("steps", 25) or 25)
    cfg = float(body.get("cfg", 1.0) or 1.0)
    sampler = str(body.get("sampler", "er_sde"))
    scheduler = str(body.get("scheduler", "simple"))
    negative = str(body.get("negative_prompt", "low quality, worst quality"))

    # Mode async: balas task_id langsung, generate di background thread.
    if bool(body.get("async", False)):
        task_id = uuid.uuid4().hex
        with _TASKS_LOCK:
            TASKS[task_id] = {"status": "processing"}
        threading.Thread(target=_bg_generate, args=(task_id, body), daemon=True).start()
        return {"task_id": task_id, "status": "processing"}

    try:
        wf = load_workflow()
        inject(wf, prompt, size, seed, steps, cfg, sampler, scheduler, negative, LORA_NAME)
        imgs = run_comfy(wf)
        # pakai gambar pertama n kali bila diminta lebih (atau kirim sesuai n)
        out = [{"b64_json": imgs[i % len(imgs)]} for i in range(n)]
        return {"created": int(time.time()), "data": out}
    except Exception as e:
        return JSONResponse({"error": {"message": str(e), "type": "server_error"}}, status_code=500)


@app.get("/v1/models")
async def models():
    return {"object": "list", "data": [{"id": m, "object": "model", "created": 0, "owned_by": "rekty"} for m in MODEL_NAMES]}


@app.get("/health")
async def health():
    return {"ok": True, "comfy": COMFY_URL}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
