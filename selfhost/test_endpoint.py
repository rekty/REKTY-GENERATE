#!/usr/bin/env python3
"""
Tes endpoint self-host Krea 2 sebelum didaftarkan ke Pollinations.

Pakai (Windows / Linux / macOS):
    python selfhost/test_endpoint.py https://xxx.trycloudflare.com

Tanpa dependensi tambahan — stdlib saja (urllib + base64 + json).
"""
import base64
import json
import os
import sys
import tempfile
import urllib.error
import urllib.request

# Windows console default cp1252 tidak bisa cetak emoji — paksa UTF-8.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE = (sys.argv[1] if len(sys.argv) > 1 else "").rstrip("/")
if not BASE:
    print("❌ Pakai: python test_endpoint.py https://xxx.trycloudflare.com")
    sys.exit(1)

PASS = 0
FAIL = 0


def say(t):
    print(f"\n=== {t} ===")


def ok(t):
    global PASS
    PASS += 1
    print(f"  ✅ {t}")


def bad(t):
    global FAIL
    FAIL += 1
    print(f"  ❌ {t}")


def http(url, payload=None, timeout=120):
    data = json.dumps(payload).encode("utf-8") if payload else None
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST" if payload else "GET",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


say("1) /v1/models — cek id model yang dijawab endpoint")
try:
    body = http(BASE + "/v1/models", timeout=20).decode("utf-8", "replace")
    print("  " + body[:500].replace("\n", " "))
    try:
        ids = [m.get("id") for m in json.loads(body).get("data", []) if m.get("id")]
    except Exception:
        ids = []
    if ids:
        print("  ID model tersedia:")
        for i in ids[:5]:
            print(f"    - {i}")
        ok("/v1/models menjawab dengan model id")
    else:
        bad("/v1/models tidak memuat id model (cek gateway)")
except Exception as e:
    bad(f"/v1/models tidak menjawab: {e}")

say("2) Generate tes 832x1536 (prompt sederhana)")
out_dir = os.path.join(tempfile.gettempdir(), "rekty_ep_test")
os.makedirs(out_dir, exist_ok=True)
try:
    body = http(
        BASE + "/v1/images/generations",
        {
            "model": "rekty1988/anjany",
            "prompt": "a cute cat with blue eyes, studio lighting",
            "size": "832x1536",
            "steps": 8,
            "cfg_scale": 1.0,
        },
        timeout=120,
    )
    print("  " + body[:200].decode("utf-8", "replace").replace("\n", " "))
    b64 = ""
    try:
        b64 = json.loads(body).get("data", [{}])[0].get("b64_json", "")
    except Exception:
        pass
    if b64:
        raw = base64.b64decode(b64)
        png = os.path.join(out_dir, "test.png")
        with open(png, "wb") as f:
            f.write(raw)
        print(f"  ukuran file: {len(raw):,} byte")
        magic = raw[:8].hex()
        if magic.startswith("89504e47"):
            ok(f"Gambar valid PNG ({magic[:8]})")
        elif magic.startswith("ffd8ff"):
            ok(f"Gambar valid JPEG ({magic[:8]})")
        else:
            bad(f"File bukan gambar ({magic[:8]})")
        print(f"  tersimpan: {png}")
    else:
        bad("Respons tidak memuat b64_json — cek log gateway")
except Exception as e:
    bad(f"Generate gagal: {e}")

print("\n=== HASIL ===")
print(f"  Lulus: {PASS} | Gagal: {FAIL}")
if FAIL == 0:
    print("  🎉 Endpoint SIAP didaftarkan ke Pollinations (lihat REGISTER_POLLINATIONS.md)")
else:
    print("  ⚠️ Ada yang gagal — perbaiki dulu sebelum daftar ke Pollinations")
sys.exit(1 if FAIL else 0)
