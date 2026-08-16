---
language:
- en
license: other
license_name: krea-2-community-license
license_link: https://huggingface.co/Comfy-Org/Krea-2/blob/main/LICENSE.pdf
pipeline_tag: text-to-image
base_model: krea/Krea-2-Turbo
tags:
- krea-2
- text-to-image
- comfyui
- diffusers
---

# KREA2_BY_REKTY — Krea 2 Turbo (Quantize) by Rekty

Checkpoint **Krea 2 Turbo** (fp8-scaled) hasil **quantize + merge LoRA** oleh
Rekty, dalam format ComfyUI (`UNETLoader`, bare diffusion model).

- **Base:** `krea2_turbo_fp8_scaled.safetensors` (Krea 2 Turbo, Comfy-Org/Krea-2)
- **Format:** UNET-only, 942 tensor (`model.diffusion_model.*`)
- **Cocok dipasangkan dengan:**
  - Text encoder: `qwen3vl_4b_fp8_scaled.safetensors` (CLIPLoader type `krea2`)
  - VAE: `qwen_image_vae.safetensors`
  - LoRA: [`rekty1988/REKTY_ANJANY`](https://huggingface.co/rekty1988/REKTY_ANJANY) (Krea 2, strength ~0.5)
- **Setting dasar (ComfyUI):** steps 8 · CFG 1.0 · sampler `er_sde` · scheduler `simple` · ukuran bebas (1K–2K)

## Cara pakai di aplikasi REKTY (web)

Notebook Colab siap pakai: `selfhost/rekty_colab.ipynb` di repo
`rekty/REKTY-GENERATE` (GitHub). Isi `CHECKPOINT_URL` dengan URL file ini:

```
https://huggingface.co/rekty1988/KREA2_BY_REKTY/resolve/main/Krea2_by_Rekty_Quantize_00001_.safetensors
```

## Lisensi ⚖️

Model **Krea 2** dikembangkan oleh **Krea.ai** dan dirilis di bawah
**Krea 2 Community License Agreement v.1** (22 Juni 2026). File ini adalah
turunan dari `krea2_turbo_fp8_scaled.safetensors`, sehingga penggunaannya
tunduk pada lisensi komunitas tersebut.

- 📄 Teks lisensi lengkap: [`KREA2_LICENSE.md`](./KREA2_LICENSE.md) (salinan resmi)
- 🔗 Sumber: [Comfy-Org/Krea-2/LICENSE.pdf](https://huggingface.co/Comfy-Org/Krea-2/blob/main/LICENSE.pdf)

Baca ketentuan lisensi (termasuk batasan penggunaan komersial) sebelum
menggunakan model ini.
