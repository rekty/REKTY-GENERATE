"""
REKTY GENERATOR — server uji coba lokal.

Menjalankan index.html plus MOCK backend /api (Tensor.Art Model Service
palsu), jadi kamu bisa mencoba seluruh alur generate (task -> poll ->
progress -> hasil gambar) TANPA API key asli.

Jalankan:
    python scripts/dev_server.py          # default http://127.0.0.1:8787
    python scripts/dev_server.py 9000     # port lain

Di browser: isi prompt, set Mode = "Real API", isi API Key bebas (mis. "test"),
klik Generate -> lihat progress lalu gambar hasil (picsum).

Untuk generate asli: deploy fungsi /api (lihat DEPLOY.md) dan isi API key TAMS.
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787

# Simulasi status job per task id (tidak perlu thread-safe untuk uji coba).
_jobs = {}
_lock = threading.Lock()

# Fallback daftar model image Pollinations (dipakai kalau proxy ke API asli gagal).
_POLL_MODELS_FALLBACK = [
    {"name": "zimage", "title": "Z-Image Turbo", "brand": "Alibaba", "category": "image", "paid_only": False},
    {"name": "grok-imagine-image-2.0", "title": "Grok Imagine Image 2.0", "brand": "xAI", "category": "image", "paid_only": True},
    {"name": "krea", "title": "Krea 2 Medium", "brand": "Krea", "category": "image", "paid_only": True},
    {"name": "dreamshaper", "title": "DreamShaper 8 LCM", "brand": "Lykon", "category": "image", "paid_only": False},
    {"name": "recraft-v4.1-vector", "title": "Recraft V4.1 Vector", "brand": "Recraft", "category": "image", "paid_only": True},
    {"name": "qwen-image-3", "title": "Qwen Image 3", "brand": "Qwen", "category": "image", "paid_only": True},
    {"name": "seedream5-pro", "title": "Seedream 5.0 Pro", "brand": "ByteDance", "category": "image", "paid_only": True},
    {"name": "nanobanana-2-lite", "title": "Nano Banana 2 Lite", "brand": "Google", "category": "image", "paid_only": True},
    {"name": "ideogram-v4-balanced", "title": "Ideogram 4.0 Balanced", "brand": "Ideogram", "category": "image", "paid_only": True},
    {"name": "ideogram-v4-quality", "title": "Ideogram 4.0 Quality", "brand": "Ideogram", "category": "image", "paid_only": True},
    {"name": "ideogram-v4-turbo", "title": "Ideogram 4.0 Turbo", "brand": "Ideogram", "category": "image", "paid_only": True},
    {"name": "gpt-image-2", "title": "GPT Image 2", "brand": "OpenAI", "category": "image", "paid_only": False},
    {"name": "wan-image", "title": "Wan 2.7 Image", "brand": "Alibaba", "category": "image", "paid_only": True},
    {"name": "wan-image-pro", "title": "Wan 2.7 Image Pro", "brand": "Alibaba", "category": "image", "paid_only": True},
    {"name": "grok-imagine-pro", "title": "Grok Imagine Pro", "brand": "xAI", "category": "image", "paid_only": True},
    {"name": "qwen-image", "title": "Qwen Image", "brand": "Qwen", "category": "image", "paid_only": True},
    {"name": "p-image", "title": "Pruna p-image", "brand": "Pruna", "category": "image", "paid_only": True},
    {"name": "p-image-edit", "title": "Pruna p-image-edit", "brand": "Pruna", "category": "image", "paid_only": True},
    {"name": "nanobanana-2", "title": "Nano Banana 2", "brand": "Google", "category": "image", "paid_only": True},
    {"name": "seedream5", "title": "Seedream 5.0 Lite", "brand": "ByteDance", "category": "image", "paid_only": True},
    {"name": "grok-imagine", "title": "Grok Imagine", "brand": "xAI", "category": "image", "paid_only": True},
    {"name": "seedream-pro", "title": "Seedream 4.5", "brand": "ByteDance", "category": "image", "paid_only": True},
    {"name": "nanobanana-pro", "title": "Nano Banana Pro", "brand": "Google", "category": "image", "paid_only": True},
    {"name": "nanobanana", "title": "Nano Banana", "brand": "Google", "category": "image", "paid_only": True},
    {"name": "seedream", "title": "Seedream 4.0", "brand": "ByteDance", "category": "image", "paid_only": True},
    {"name": "nova-canvas", "title": "Nova Canvas", "brand": "Amazon", "category": "image", "paid_only": False},
    {"name": "klein", "title": "FLUX.2 Klein 4B", "brand": "Black Forest Labs", "category": "image", "paid_only": False},
    {"name": "gptimage-large", "title": "GPT Image 1.5", "brand": "OpenAI", "category": "image", "paid_only": False},
    {"name": "gptimage", "title": "GPT Image 1 Mini", "brand": "OpenAI", "category": "image", "paid_only": False},
    {"name": "flux", "title": "FLUX.1 Schnell", "brand": "Black Forest Labs", "category": "image", "paid_only": False},
    {"name": "kontext", "title": "FLUX.1 Kontext Pro", "brand": "Black Forest Labs", "category": "image", "paid_only": False},
    {"name": "vendouple/uncensored-image-enhanced", "title": "Uncensored Enhanced", "brand": "OrchidLLM Proxy", "category": "image", "paid_only": False},
    {"name": "vendouple/wai-illustrious-xl", "title": "WAI Illustrious XL v17", "brand": "OrchidLLM Proxy", "category": "image", "paid_only": False},
    {"name": "CloudCompile/agnes-image-2.0-flash", "title": "Agnes Image 2.0 Flash", "brand": "SneezeJay", "category": "image", "paid_only": False},
    {"name": "vendouple/nano-banana-pro", "title": "Nano Banana Pro", "brand": "OrchidLLM Proxy", "category": "image", "paid_only": False},
    {"name": "vendouple/animagine", "title": "Animagine (read description)", "brand": "OrchidLLM Proxy", "category": "image", "paid_only": False},
    {"name": "vendouple/luma-photon-1", "title": "Luma Photon 1 (Luma Labs)", "brand": "OrchidLLM Proxy", "category": "image", "paid_only": False},
    {"name": "Catniti/agnes-image-2.1-flash", "title": "Agnes Image 2.1 Flash", "brand": "Catniti AI", "category": "image", "paid_only": False},
    {"name": "sharktide/inferenceport-ai-lightning-image-turbo", "title": "Lightning Image Turbo", "brand": "InferencePort AI", "category": "image", "paid_only": False},
    {"name": "Catniti/agnes-image-2.0-flash", "title": "Agnes Image 2.0 Flash", "brand": "Catniti AI", "category": "image", "paid_only": False},
]


def _job_state(task_id):
    with _lock:
        if task_id not in _jobs:
            _jobs[task_id] = {"calls": 0, "created": time.time()}
        return _jobs[task_id]


def _mock_task(task_id):
    """Naikkan status bertahap: WAITING -> RUNNING -> SUCCESS."""
    st = _job_state(task_id)
    st["calls"] += 1
    n = st["calls"]
    if n == 1:
        return {"ok": True, "status": "WAITING", "progress": 0, "queue": "#2/7"}
    if n <= 3:
        return {"ok": True, "status": "RUNNING", "progress": 15 + (n - 1) * 25}
    if n <= 4:
        return {"ok": True, "status": "RUNNING", "progress": 70}
    return {
        "ok": True,
        "status": "SUCCESS",
        "progress": 100,
        "credits": 1.22,
        "images": [
            f"https://picsum.photos/seed/{task_id}-{i}/512" for i in range(1, 3)
        ],
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass  # tenang

    def _send(self, code, obj, ctype="application/json"):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, x-api-key")
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/health":
            return self._send(200, {"ok": True, "hasKeys": {"tams": False, "replicate": False, "fal": False, "pollinations": True}, "tams": "mock"})
        if path == "/api/pollinations-models":
            # Proxy ke katalog asli Pollinations; fallback ke daftar statis lokal
            # supaya dropdown Model tetap lengkap walau jaringan/blokir.
            try:
                import urllib.request
                req = urllib.request.Request(
                    "https://gen.pollinations.ai/image/models",
                    headers={"User-Agent": "rekty-dev-server"},
                )
                with urllib.request.urlopen(req, timeout=20) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                if isinstance(data, list) and data:
                    return self._send(200, {"ok": True, "models": data})
            except Exception as exc:
                print("[pollinations-models] proxy gagal, pakai fallback:", exc)
            return self._send(200, {"ok": True, "models": _POLL_MODELS_FALLBACK})
        if path == "/api/task":
            task_id = ""
            for part in self.path.split("?")[1:]:
                for kv in part.split("&"):
                    k, _, v = kv.partition("=")
                    if k == "id":
                        task_id = v
            if not task_id:
                return self._send(400, {"error": "Parameter id wajib diisi"})
            return self._send(200, _mock_task(task_id))
        if path == "/":
            path = "/index.html"
        fp = os.path.join(ROOT, path.lstrip("/"))
        if os.path.isfile(fp):
            ctype = {
                ".html": "text/html",
                ".js": "text/javascript",
                ".css": "text/css",
                ".json": "application/json",
                ".png": "image/png",
            }.get(os.path.splitext(fp)[1].lower(), "application/octet-stream")
            with open(fp, "rb") as f:
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(os.path.getsize(fp)))
                self.end_headers()
                self.wfile.write(f.read())
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/generate":
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                payload = json.loads(raw)
            except Exception:
                return self._send(400, {"error": "JSON tidak valid"})
            # cetak payload untuk debugging struktur buildPayload()
            print("=== /api/generate payload ===")
            print(json.dumps(payload, ensure_ascii=False, indent=2)[:2000])
            print("==============================")
            provider = payload.get("provider", "tams") if isinstance(payload, dict) else "tams"
            task_id = f"{provider}-mock-" + str(int(time.time() * 1000))
            _job_state(task_id)
            return self._send(200, {"ok": True, "provider": provider, "taskId": task_id})
        self._send(404, {"error": "not found"})


if __name__ == "__main__":
    print(f"REKTY dev server: http://127.0.0.1:{PORT}  (mock TAMS aktif)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
