# WEB TENSOR ART KW

Tensor.Art clone web interface (frontend). Bahasa UI: Indonesia.

## Progress

- Top-bar tabs: Text2Img, Img2Img, Edit, Video, Prime (NO sidebar)
- **3-column layout** matching TensorArt screenshot:
  - **Left** (scrollable, drawer di mobile): Prompt box di ATAS (negative toggle + A1111/Ella chips), Model card (Z Image - base-bf16), LoRA cards (thumb + weight slider 0-2 + +/- + delete), Trigger words tags (auto dari LoRA aktif), Add LoRA/Embedding/ControlNet, VAE dropdown, Settings (aspect ratio portrait/landscape/square/custom, Width/Height sliders, Sampler/Scheduler, Advanced: Steps/CFG/Seed + dice), Paste Generation Data/Presets/Reset
  - **Center**: murni image grid (toggle 1/2 kolom via tombol ncol), empty state
  - **Right**: Generation History — tab All/Image/Video/Audio, Kelola/Reload bar, result cards dgn metadata (Task ID, Credits 1.22, Created, Expires +7 hari, Negative, Size, Seed)
- Generate button GRADIENT + harga "+$0.33", pakai sendRequest real API (fallback simu picsum)
- Tombol Enhance di prompt box (simulasi LLM, API asli `works/v1/llm/task/generate`)
- Tab aktif punya underline gradien (#6F5DFF→#27D4CD), Generate button glow, slider thumb putih+border violet

## Brand Tokens (copy dari timeline resmi tensor.art CSS)

- Latar body `#181818`, panel `#222`/`#2a2a2a`, border `rgba(255,255,255,.12)`
- Generate/primary: `linear-gradient(95deg,#6F5DFF 0%,#27D4CD 59.7%,#74FF7E 100%)`
- Accent `#6F5DFF`, font system-ui stack, radius 8-12px
- Sumber ref: `https://tensor.art/` (Vue+UnoCSS, create page 404 tanpa JS)

## Architecture

- Single file: `index.html` (Tailwind CDN + Phosphor icons + vanilla JS, no build)
- `buildPayload()` collects all params → ready for backend
- `sendRequest()` POST JSON ke `http://localhost:8000/api/generate`

## Params (buildPayload — struktur NYATA dari console tensor.art)

```js
{
  params:{
    baseModel:{ modelId, modelFileId },
    sdxl:{ refiner:false },
    models:[{ name, weight, triggerWords }],   // LoRA
    embeddingModels:[],
    sdVae:'Automatic',
    prompt,
    negativePrompt,
    height, width,
    imageCount,
    steps,
    images:[],
    cfgScale, seed,
    clipSkip:2, etaNoiseSeedDelta:31337, v1Clip:false,
    enablePix2pix:false, guidance:3.5, useFirstLastFrame:false,
    ksamplerName,   // = sampler (er_sde/euler/dit_gauss)
    schedule        // = scheduler (simple/karras/exponential)
  },
  credits:1.22, taskType:'TXT2IMG', isRemix:false, captchaType:'CLOUDFLARE_TURNSTILE'
}
```

- Endpoint asli: `POST https://api.tensor.art/works/v1/works/task`
- Field camelCase (`negativePrompt`, `cfgScale`, `ksamplerName`), bukan snake_case
- `baseModel` butuh `modelId` + `modelFileId` (bukan nama)
- Credits 1.22 untuk 830x1536, steps 25

## UI State (state obj)

results[], page ('text'|'img'|'edit'|'video'|'prime'), aspect ('portrait'|'landscape'|'square'|'custom'), ncol (1|2). LORA array sumber data LoRA + trigger.

## Next Steps

- Backend integration: ganti setTimeout di handler btn-go dengan `sendRequest(par)`, real image, live progress
- Img2Img: isi tab Img2Img (drag-drop upload, denoising strength)
- Edit tab: inpainting/outpainting
- Mobile: right panel belum tampil di layar kecil

## Commands

- No build; buka `index.html` atau `python -m http.server` / `npx serve`
- JS lint: extract `<script>` → `node --check`
- Simulasi pakai `https://picsum.photos/seed/<seed>/512`

