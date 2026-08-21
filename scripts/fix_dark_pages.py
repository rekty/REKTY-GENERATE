#!/usr/bin/env python3
"""Fix: override add_page to always apply dark background + add new slides"""

import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "build_presentation.py")

with open(SCRIPT, "r", encoding="utf-8") as f:
    content = f.read()

# Fix 1: Override add_page to always apply dark background
old_init = '''class PDF(FPDF):
    def __init__(self):
        super().__init__()
        self.set_auto_page_break(auto=True, margin=15)

    def dark(self):
        self.set_fill_color(*BG)
        self.rect(0, 0, 210, 297, 'F')'''

new_init = '''class PDF(FPDF):
    def __init__(self):
        super().__init__()
        self.set_auto_page_break(auto=True, margin=15)

    def add_page(self, orientation="", format=""):
        super().add_page(orientation, format)
        self.dark()

    def dark(self):
        self.set_fill_color(*BG)
        self.rect(0, 0, 210, 297, 'F')'''

content = content.replace(old_init, new_init)

# Fix 2: Add new slides before LICENSE (section 34)
new_slides = '''
    # ===== 35: WEBSITE VAIA =====
    pdf.section(35, "Kunjungi Website VAIA")
    pdf.txt("Untuk merasakan langsung bagaimana VAIA GENERATOR bekerja, kunjungi website resminya.")
    pdf.ln(3)
    pdf.code("https://visualaiartwork.pages.dev")
    pdf.ln(3)
    pdf.txt("VAIA tersedia gratis dan dapat diakses dari browser manapun, baik di komputer maupun HP.")
    pdf.ln(2)
    pdf.diagram([
        "Buka browser",
        "   |",
        "   v",
        "https://visualaiartwork.pages.dev",
        "   |",
        "   v",
        "Mulai Generate / Chat / Img2Img",
        "   |",
        "   v",
        "Pilih provider (Pollinations gratis)",
        "   |",
        "   v",
        "Masukkan prompt -> Generate!"
    ])

    # ===== 36: PRAKTEK LANGSUNG =====
    pdf.section(36, "Praktek Langsung: BYOP + Pollen Quest")
    pdf.txt("Berikut langkah-langkah untuk menggunakan VAIA secara gratis dengan BYOP (Bring Your Own Pollen).")
    pdf.ln(2)

    pdf.sub_heading("Langkah 1: Buat Akun Pollinations")
    pdf.bullet("Buka https://enter.pollinations.ai")
    pdf.bullet("Klik Login / Register")
    pdf.bullet("Daftar dengan email atau akun Google")
    pdf.bullet("Verifikasi email jika diminta")
    pdf.ln(2)

    pdf.sub_heading("Langkah 2: Buat API Key (sk_*)")
    pdf.bullet("Setelah login, masuk ke menu Keys")
    pdf.bullet("Klik Create New Key")
    pdf.bullet("Beri nama key (misal: VAIA-Generate)")
    pdf.bullet("Copy key yang berawal sk_*")
    pdf.bullet("Simpan di tempat aman (jangan bagikan)")
    pdf.ln(2)

    pdf.sub_heading("Langkah 3: Login BYOP di VAIA")
    pdf.bullet("Buka https://visualaiartwork.pages.dev")
    pdf.bullet("Klik tab Chat atau Generate")
    pdf.bullet("Di panel API, klik Login dengan Pollinations")
    pdf.bullet("Authorize di enter.pollinations.ai")
    pdf.bullet("Token akan tersimpan otomatis di backend")
    pdf.ln(2)

    pdf.sub_heading("Langkah 4: Dapatkan Pollen dari Quest")
    pdf.bullet("Klik tombol saldo pollen di panel chat")
    pdf.bullet("Klik kumpulkan lewat quest")
    pdf.bullet("Selesaikan quest harian untuk mendapatkan pollen")
    pdf.bullet("Pollen digunakan untuk generate & chat")
    pdf.ln(2)

    pdf.sub_heading("Langkah 5: Mulai Generate!")
    pdf.bullet("Pilih provider: Pollinations")
    pdf.bullet("Pilih model: Z-Image, Krea, FLUX, dll")
    pdf.bullet("Masukkan prompt")
    pdf.bullet("Klik Generate")
    pdf.bullet("Hasil akan muncul di grid + tersimpan di riwayat")
    pdf.ln(2)

    pdf.code("TIP: Tanpa API key, VAIA tetap bisa dipakai\\ndengan mode Demo (simulasi picsum).\\n\\nUntuk generate asli, gunakan BYOP atau\\nisi API key TAMS/Replicate/fal.ai.")
    pdf.ln(1)

    # ===== 37: LICENSE =====
    pdf.section(37, "License")
'''

# Insert before LICENSE
old_license = '    # ===== 34: LICENSE =====\n    pdf.section(34, "License")'
new_license = new_slides + '    # ===== 38: LICENSE =====\n    pdf.section(38, "License")'

content = content.replace(old_license, new_license)

with open(SCRIPT, "w", encoding="utf-8") as f:
    f.write(content)

print("Done! Dark background fix + new slides added.")
