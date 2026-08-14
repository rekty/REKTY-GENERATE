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
            return self._send(200, {"ok": True, "hasKeys": {"tams": False, "replicate": False, "fal": False}, "tams": "mock"})
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
