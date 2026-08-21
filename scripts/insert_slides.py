#!/usr/bin/env python3
"""Insert new slides about Cloudflare into build_presentation.py"""

import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "build_presentation.py")

with open(SCRIPT, "r", encoding="utf-8") as f:
    content = f.read()

# New slides to insert before LICENSE section
new_slides = '''
    # ===== 29: CLOUDFLARE WORKERS =====
    pdf.section(29, "Cloudflare Workers")
    pdf.txt("VAIA menggunakan Cloudflare Workers sebagai backend serverless.")
    pdf.ln(2)
    pdf.txt("Apa itu Cloudflare Workers?", bold=True)
    pdf.ln(1)
    pdf.txt("Cloudflare Workers adalah platform serverless yang menjalankan JavaScript di edge network Cloudflare. Tidak perlu server tradisional.")
    pdf.ln(2)
    pdf.diagram([
        "Pengguna",
        "   |",
        "   v",
        "Cloudflare Edge (terdekat)",
        "   |",
        "   v",
        "Worker (functions/api.js)",
        "   |-- Authentication",
        "   |-- Rate Limiting",
        "   |-- Request Validation",
        "   |-- Provider Routing",
        "   |",
        "   v",
        "AI Provider",
        "   |",
        "   v",
        "Result -> Pengguna"
    ])
    pdf.ln(1)
    pdf.txt("Keunggulan Cloudflare Workers:", bold=True)
    pdf.bullet("Gratis: 100.000 requests/hari (free tier)")
    pdf.bullet("Cepat: berjalan di edge network global")
    pdf.bullet("Tanpa server: tidak perlu manage VPS")
    pdf.bullet("Auto-scale: menyesuaikan traffic otomatis")
    pdf.bullet("Terintegrasi: langsung dengan KV, R2, Turnstile")
    pdf.ln(2)
    pdf.txt("Di VAIA, Worker menangani:", bold=True)
    pdf.bullet("POST /api/generate -> generate gambar")
    pdf.bullet("GET /api/task -> polling status job")
    pdf.bullet("POST /api/chat -> AI chat response")
    pdf.bullet("GET /api/health -> status backend")
    pdf.bullet("POST /api/wd14 -> WD14 tagger")
    pdf.bullet("/img/* -> serve archived images from KV")
    pdf.ln(2)
    pdf.code("_worker.js = functions/api.js + index.html\\n(deploy via wrangler pages deploy)")
    pdf.ln(1)
    pdf.txt("Worker dibangun dari dua file menjadi satu file self-contained yang di-obfuscate untuk keamanan.")

    # ===== 30: CLOUDFLARE KV =====
    pdf.section(30, "Cloudflare KV (Key-Value Storage)")
    pdf.txt("Cloudflare KV adalah sistem storage key-value yang digunakan VAIA untuk menyimpan data secara permanen.")
    pdf.ln(2)
    pdf.txt("Apa itu KV?", bold=True)
    pdf.ln(1)
    pdf.txt("KV adalah database key-value simple. Setiap data disimpan sebagai pasangan key + value. Tidak ada relational structure.")
    pdf.ln(2)
    pdf.code("Key: /img/generation-abc123.jpg\\nValue: (binary image data)\\nTTL: Permanent (immutable)")
    pdf.ln(2)
    pdf.txt("Cara kerja KV:", bold=True)
    pdf.diagram([
        "Request masuk",
        "   |",
        "   v",
        "Worker cek KV",
        "   |",
        "   |-- Key ada? -> Return value",
        "   |",
        "   +-- Key tidak ada? -> Fetch dari provider",
        "            |",
        "            v",
        "         Simpan ke KV",
        "            |",
        "            v",
        "         Return value"
    ])
    pdf.ln(2)
    pdf.txt("Di VAIA, KV digunakan untuk:", bold=True)
    pdf.bullet("Image archiving: gambar hasil generate disimpan permanen")
    pdf.bullet("Rate limiting: counter request per IP")
    pdf.bullet("OAuth sessions: token BYOP pengguna")
    pdf.bullet("Audit logs: catatan aktivitas admin")
    pdf.bullet("WD14 cache: hasil tagger di-cache 7 hari")
    pdf.ln(2)
    pdf.txt("Mengapa KV, bukan R2?", bold=True)
    pdf.ln(1)
    pdf.diagram([
        "Cloudflare KV",
        "  |-- Gratis (free tier)",
        "  |-- Tanpa billing requirement",
        "  |-- 1 GB storage + 100k reads/hari",
        "  +-- Cocok untuk VAIA",
        "",
        "Cloudflare R2",
        "  |-- Gratis storage + egress",
        "  |-- TAPI: wajib add payment method",
        "  +-- Tagihan $0/bulan tapi perlu kartu"
    ])
    pdf.ln(1)
    pdf.txt("VAIA memilih KV karena tidak memerlukan kartu kredit. Gratis sepenuhnya.", bold=True)
    pdf.ln(2)
    pdf.txt("Limitasi KV:", bold=True)
    pdf.bullet("Max 25 MiB per value (ukuran gambar)")
    pdf.bullet("Eventual consistency (bukan real-time)")
    pdf.bullet("Tidak cocok untuk data yang sering berubah")
    pdf.bullet("1 GB total storage (free tier)")
    pdf.ln(2)
    pdf.code("KV Namespace: REKTY_IMAGES\\nBinding: env.IMAGES\\nConfig: wrangler.toml")

    # ===== 31: CLOUDFLARE R2 =====
    pdf.section(31, "Cloudflare R2 (Object Storage)")
    pdf.txt("Cloudflare R2 adalah layanan object storage seperti AWS S3, tetapi tanpa biaya egress.")
    pdf.ln(2)
    pdf.txt("Perbandingan:", bold=True)
    pdf.diagram([
        "AWS S3",
        "  |-- Storage: $0.023/GB/bulan",
        "  |-- Egress: $0.09/GB (MAHAL)",
        "  +-- Total: bisa mahal untuk banyak akses",
        "",
        "Cloudflare R2",
        "  |-- Storage: $0.015/GB/bulan",
        "  |-- Egress: GRATIS (tanpa biaya)",
        "  +-- Total: jauh lebih murah"
    ])
    pdf.ln(2)
    pdf.txt("R2 sangat cocok untuk:", bold=True)
    pdf.bullet("Menyimpan file besar (gambar, video, model)")
    pdf.bullet("CDN global (akses cepat dari mana saja)")
    pdf.bullet("Backup data")
    pdf.bullet("Static assets")
    pdf.ln(2)
    pdf.txt("Mengapa VAIA tidak pakai R2?", bold=True)
    pdf.ln(1)
    pdf.txt("R2 memerlukan payment method (kartu kredit) meskipun tagihannya $0/bulan. VAIA memilih KV karena benar-benar gratis tanpa kartu.")
    pdf.ln(2)
    pdf.txt("Jika di masa depan VAIA membutuhkan storage lebih dari 1 GB atau file > 25 MiB, R2 bisa menjadi pilihan.", bold=True)
    pdf.ln(2)
    pdf.diagram([
        "Masa Depan VAIA:",
        "  |-- KV: image archiving (free, < 25 MiB)",
        "  +-- R2: file besar, model, backup (perlu billing)"
    ])

    # ===== 32: CLOUDFLARE TURNSTILE =====
    pdf.section(32, "Cloudflare Turnstile (Anti-Bot)")
    pdf.txt("Cloudflare Turnstile adalah sistem captcha yang digunakan VAIA untuk mencegah bot.")
    pdf.ln(2)
    pdf.txt("Apa itu Turnstile?", bold=True)
    pdf.ln(1)
    pdf.txt("Turnstile adalah alternatif modern untuk reCAPTCHA. Tidak menampilkan checkbox atau puzzle. Verifikasi dilakukan secara invisible di background.")
    pdf.ln(2)
    pdf.diagram([
        "User klik Generate",
        "   |",
        "   v",
        "Frontend: invisibleTurnstile()",
        "   |",
        "   v",
        "Cloudflare: verifikasi browser",
        "   |",
        "   |-- Token valid -> Lanjut generate",
        "   |",
        "   +-- Token invalid -> Tolak"
    ])
    pdf.ln(2)
    pdf.txt("Cara kerja di VAIA:", bold=True)
    pdf.bullet("Generate ke-1: Turnstile muncul (invisible)")
    pdf.bullet("Generate ke-2 dst: skip (token cached)")
    pdf.bullet("Chat ke-1: Turnstile muncul")
    pdf.bullet("Chat ke-2 dst: skip (backend terima token kosong)")
    pdf.ln(2)
    pdf.code("Backend logic:\\nif (!token) return { ok: true }\\n// Token kosong = skip verifikasi\\n// Hanya generate/chat pertama yang perlu captcha")
    pdf.ln(1)
    pdf.txt("Mengapa Turnstile?", bold=True)
    pdf.bullet("Gratis: 1 juta verifikasi/bulan")
    pdf.bullet("Invisible: user tidak perlu klik apa pun")
    pdf.bullet("Cepat: verifikasi dalam milliseconds")
    pdf.bullet("Aman: deteksi bot lebih baik dari CAPTCHA tradisional")
    pdf.bullet("Privasi: tidak tracking user seperti Google")

    # ===== 33: TEKNOLOGI LAIN VAIA =====
    pdf.section(33, "Teknologi Lain yang Dipakai VAIA")
    pdf.txt("Selain Cloudflare stack, VAIA menggunakan beberapa teknologi lain:")
    pdf.ln(2)
    pdf.sub_heading("Frontend")
    pdf.bullet("HTML5: single-file architecture (index.html)")
    pdf.bullet("Tailwind CSS: utility-first CSS via CDN")
    pdf.bullet("Phosphor Icons: icon library via CDN")
    pdf.bullet("Vanilla JavaScript: tanpa framework (React/Vue)")
    pdf.bullet("JavaScript Obfuscator: proteksi kode di production")
    pdf.ln(1)
    pdf.sub_heading("AI Providers")
    pdf.bullet("Tensor.Art (TAMS): Z Image, SDXL, FLUX, LoRA, Upscale")
    pdf.bullet("Replicate: FLUX schnell/dev, SDXL, SD 3.5")
    pdf.bullet("fal.ai: FLUX, Fast SDXL, Krea 2 Turbo")
    pdf.bullet("Pollinations: 57+ models (gratis + BYOP)")
    pdf.ln(1)
    pdf.sub_heading("Chat & Translate")
    pdf.bullet("Pollinations Chat: 10 models (openai-fast, gpt-5.6-luna, dll)")
    pdf.bullet("Google Translate GTX: terjemahan gratis (tanpa API key)")
    pdf.bullet("Web Researcher: Wikipedia + DuckDuckGo (tanpa key)")
    pdf.ln(1)
    pdf.sub_heading("Tools & Utility")
    pdf.bullet("WD14 Tagger: HF Space deepghs/wd14_tagging_online")
    pdf.bullet("OAuth PKCE: BYOP login (enter.pollinations.ai)")
    pdf.bullet("SSE (Server-Sent Events): streaming response")
    pdf.bullet("localStorage: riwayat gambar + settings browser")
    pdf.ln(1)
    pdf.sub_heading("DevOps")
    pdf.bullet("GitHub: version control")
    pdf.bullet("Wrangler CLI: deploy ke Cloudflare Pages")
    pdf.bullet("Firebase (opsional): alternatif backend")
    pdf.bullet("Python dev server: testing lokal + mock API")

'''

# Insert before LICENSE section
old_license = '    # ===== 29: LICENSE =====\n    pdf.section(29, "License")'
new_license = new_slides + '\n    # ===== 34: LICENSE =====\n    pdf.section(34, "License")'

content = content.replace(old_license, new_license)

with open(SCRIPT, "w", encoding="utf-8") as f:
    f.write(content)

print("Done! Slides inserted.")
