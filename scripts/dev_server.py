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
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787

# Simulasi status job per task id (tidak perlu thread-safe untuk uji coba).
_jobs = {}
_lock = threading.Lock()

# BYOP OAuth: sesi yang ditukar lewat enter.pollinations.ai (disimpan di memori).
_oauth = {}
OAUTH_AUTHORIZE = 'https://enter.pollinations.ai/authorize'
OAUTH_TOKEN = 'https://enter.pollinations.ai/api/oauth/token'
# client_id (pk_*) App Key Pollinations. Di production key hidup sebagai secret
# Cloudflare (env POLLINATIONS_APP_KEY); di dev pakai fallback key publik yang sama
# dengan yang production serve lewat /api/oauth/config, supaya login BYOP dari
# server lokal juga berfungsi (tanpa harus set env manual).
OAUTH_CLIENT = os.environ.get('POLLINATIONS_APP_KEY') or 'pk_HHh3o6nL2KBmlUjo'


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


def _demo_svg(w, h):
    """Placeholder SVG artwork rasio-tepat (langit + matahari + gunung + bintang, tidak di-crop)."""
    import math, base64
    fs = max(12, min(w, h) * 0.045)
    sun = max(20, w * 0.13)
    def mtn(base, amp, color):
        pts = []
        for i in range(17):
            px = w * i / 16.0
            py = h * (0.62 - math.sin(i * 0.9 + base) * amp)
            pts.append("%.1f,%.1f" % (px, py))
        return '<polygon points="0,%.1f %s %.1f,%.1f" fill="%s"/>' % (h * 0.62, " ".join(pts), w, h, color)
    stars = ''.join(
        '<rect x="%.1f" y="%.1f" width="1.5" height="1.5"/>'
        % ((i * 37 + 11) % w, (i * 23 + 7) % max(1, int(h * 0.32)))
        for i in range(50)
    )
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">'
        '<defs>'
        '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1">'
        '<stop offset="0" stop-color="#1e1b4b"/><stop offset=".45" stop-color="#312e81"/>'
        '<stop offset=".75" stop-color="#4c1d95"/><stop offset="1" stop-color="#0d1117"/></linearGradient>'
        '<radialGradient id="sg"><stop offset="0" stop-color="rgba(253,224,71,.95)"/><stop offset=".35" stop-color="rgba(251,146,60,.6)"/><stop offset="1" stop-color="rgba(251,146,60,0)"/></radialGradient>'
        '</defs>'
        '<rect width="%d" height="%d" fill="url(#g)"/>'
        '<circle cx="%.1f" cy="%.1f" r="%.1f" fill="url(#sg)"/>'
        '<circle cx="%.1f" cy="%.1f" r="%.1f" fill="#fde047"/>'
        + mtn(0, 0.17, 'rgba(91,33,182,.85)')
        + mtn(2, 0.14, 'rgba(76,29,149,.9)')
        + mtn(4, 0.11, 'rgba(49,46,129,.95)')
        + mtn(6, 0.08, 'rgba(17,24,39,.95)')
        + '<g fill="rgba(255,255,255,.65)">' + stars + '</g>'
        + '</svg>'
    ) % (
        w, h, w, h,
        w, h,
        w / 2, h * 0.40, sun * 2.6,
        w / 2, h * 0.40, sun * 0.6,
    )
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")


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
    size = st.get("size", (768, 1152))
    cnt = st.get("count", 1)
    return {
        "ok": True,
        "status": "SUCCESS",
        "progress": 100,
        "credits": 1.22,
        "images": [_demo_svg(size[0], size[1]) for _ in range(cnt)],
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
        try:
            self._do_GET()
        except (ConnectionError, OSError, BrokenPipeError):
            pass  # klien membatalkan koneksi (mis. iframe ditutup) — jangan crash server

    def _do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/health":
            return self._send(200, {"ok": True, "hasKeys": {"tams": False, "replicate": False, "fal": False, "pollinations": True}, "tams": "mock"})
        if path == "/api/admin":
            # Mock panel admin KV untuk pengembangan lokal (PIN: test123)
            pin = self.headers.get("X-Admin-Pin", "")
            if pin != "test123" and "pin=test123" not in self.path:
                return self._send(403, {"error": "PIN salah atau tidak disertakan"})
            return self._send(200, {
                "ok": True, "pin": True,
                "images": [
                    {"name": "demo-a1b2c3.jpg", "size": 138541, "url": "/img/demo-a1b2c3.jpg", "expiresAt": int(time.time() * 1000) + 5 * 86400 * 1000, "createdAt": int(time.time() * 1000) - 2 * 86400 * 1000},
                    {"name": "demo-d4e5f6.png", "size": 245000, "url": "/img/demo-d4e5f6.png", "expiresAt": int(time.time() * 1000) + 2 * 86400 * 1000, "createdAt": int(time.time() * 1000) - 5 * 86400 * 1000},
                ],
                "totalKeys": 5, "imageCount": 2,
            })

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
        if path == "/api/oauth/config":
            host = self.headers.get("Host", f"127.0.0.1:{PORT}")
            proto = "http" if "localhost" in host or "127.0.0.1" in host else "https"
            # loopback OAuth Pollinations: gunakan 'localhost' (bebas port), bukan 127.0.0.1
            if host.startswith("127.0.0.1:"):
                host = "localhost:" + host.split(":", 1)[1]
            return self._send(200, {
                "ok": True, "clientId": OAUTH_CLIENT,
                "authorizeBase": OAUTH_AUTHORIZE,
                "tokenEndpoint": OAUTH_TOKEN,
                "redirectUri": proto + "://" + host + "/callback",
            })
        if path == "/api/oauth/status":
            sid = ""
            for part in self.path.split("?")[1:]:
                for kv in part.split("&"):
                    k, _, v = kv.partition("=")
                    if k == "session":
                        sid = v
            rec = _oauth.get(sid)
            if not rec or rec.get("expiresAt", 0) <= time.time() * 1000:
                return self._send(200, {"ok": True, "connected": False})
            return self._send(200, {"ok": True, "connected": True,
                                    "expiresIn": max(0, int((rec["expiresAt"] - time.time() * 1000) / 1000)),
                                    "balance": rec.get("balance")})
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
        if path == "/callback":
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
        try:
            self._do_POST()
        except (ConnectionError, OSError, BrokenPipeError):
            pass

    def _do_POST(self):
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
            st = _job_state(task_id)
            try:
                prm = payload.get("params", {}) if isinstance(payload, dict) else {}
                st["size"] = (int(prm.get("width") or 768), int(prm.get("height") or 1152))
                st["count"] = int(payload.get("imageCount") or 1)
            except Exception:
                st["size"] = (768, 1152)
                st["count"] = 1
            return self._send(200, {"ok": True, "provider": provider, "taskId": task_id})
        if path == "/api/admin/delete":
            pin = self.headers.get("X-Admin-Pin", "")
            if pin != "test123":
                return self._send(403, {"error": "PIN salah atau tidak disertakan"})
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw or b"{}")
            except Exception:
                body = {}
            name = str(body.get("name", "")).strip()
            if not name or "." not in name:
                return self._send(400, {"error": "Hanya file gambar arsip yang bisa dihapus"})
            print("=== admin delete ===", name)
            return self._send(200, {"ok": True, "deleted": name})
        if path == "/api/oauth/token":
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw)
            except Exception:
                return self._send(400, {"error": "JSON tidak valid"})
            code = (body or {}).get("code") or ""
            verifier = (body or {}).get("code_verifier") or ""
            if not code or not verifier:
                return self._send(400, {"error": "Parameter code dan code_verifier wajib diisi"})
            form = ("grant_type=authorization_code&code=" + urllib.parse.quote(code)
                    + "&client_id=" + urllib.parse.quote(OAUTH_CLIENT)
                    + "&code_verifier=" + urllib.parse.quote(verifier)
                    + "&redirect_uri=" + urllib.parse.quote((body or {}).get("redirect_uri") or ("http://127.0.0.1:%d/callback" % PORT)))
            try:
                req = urllib.request.Request(OAUTH_TOKEN, data=form.encode("utf-8"),
                                             headers={"Content-Type": "application/x-www-form-urlencoded",
                                                      "User-Agent": "rekty-dev-server"}, method="POST")
                with urllib.request.urlopen(req, timeout=30) as resp:
                    d = json.loads(resp.read().decode("utf-8"))
            except Exception as exc:
                return self._send(502, {"error": "OAuth gagal: " + str(exc)})
            if not d.get("access_token"):
                return self._send(502, {"error": "OAuth gagal: " + str(d.get("error_description") or d.get("error") or "unknown")})
            import uuid
            sid = str(uuid.uuid4())
            expiresIn = int(d.get("expires_in") or 604800)
            _oauth[sid] = {"token": d["access_token"], "scope": d.get("scope") or "",
                           "expiresAt": int(time.time() * 1000) + expiresIn * 1000,
                           "balance": {"pollenBalance": 15.45, "balance": 15.45, "currency": "pollen"}}
            return self._send(200, {"ok": True, "session": sid, "expiresIn": expiresIn, "scope": _oauth[sid]["scope"]})
        if path == "/api/oauth/logout":
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw)
            except Exception:
                body = {}
            sid = (body or {}).get("session") or ""
            if sid in _oauth:
                del _oauth[sid]
            return self._send(200, {"ok": True})
        if path == "/api/chat":
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            try:
                body = json.loads(raw)
            except Exception:
                return self._send(400, {"error": "JSON tidak valid"})
            msgs = (body or {}).get("messages") or []
            stream = bool((body or {}).get("stream"))
            last = str((msgs[-1] or {}).get("content", ""))[:80] if msgs else ""
            reply = ("Halo! Saya **VAIA Chat** (mode demo). Kamu bilang: \"" + last + "\"\n\n"
                     "Ini **demo streaming** — di produksi saya memakai model Vaia Rekty dari Visual AI Artwork Agent. "
                     "Tulis pesan lain atau klik tombol sampah untuk memulai percakapan baru.")
            if not stream:
                return self._send(200, {"ok": True, "text": reply, "model": "gpt-5.6-luna"})
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            import time as _time
            for i in range(0, len(reply), 6):
                chunk = reply[i:i + 6]
                ev = json.dumps({"choices": [{"delta": {"content": chunk}}]}, ensure_ascii=False)
                self.wfile.write(("data: " + ev + "\n\n").encode("utf-8"))
                self.wfile.flush()
                _time.sleep(0.03)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
            return
        self._send(404, {"error": "not found"})


if __name__ == "__main__":
    print(f"REKTY dev server: http://127.0.0.1:{PORT}  (mock TAMS aktif)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
