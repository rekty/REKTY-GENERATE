### App Name
REKTY GENERATOR

### App Description
REKTY GENERATOR is a free, open-source AI image generator web app that supports multiple providers in one interface. It uses **Pollinations AI** for:
- **Image generation** via Pollinations API (57+ models: Z-Image, Krea, FLUX, etc.)
- **Text/Chat** via Pollinations text models (openai-fast, nova-fast, gemini-fast, gemini-3-flash, gpt-5.6-luna)
- **BYOP (Bring Your Own Pollen)** integration - users login with Pollinations account via OAuth PKCE
- **Audio generation** via Pollinations API

**Latest Features:**
- Multi-language support (18 languages: ID, EN, JA, KO, ZH, ES, FR, DE, PT, RU, AR, HI, TH, VI, TR, PL, NL, IT)
- Fast chat models (nova-fast, gemini-fast, gemini-3-flash)
- Turnstile anti-bot (chat + generate, only shows once)
- Admin panel with multi-select delete
- Auto-save settings on refresh
- Responsive design (desktop + mobile)
- WD14 Tagger (online via HF Space)
- Auto-archive images to KV

### App URL
https://visualaiartwork.pages.dev

### GitHub Repository URL
https://github.com/rekty/REKTY-GENERATE

### App Category
image

### App Language
id (multi-language: 18 languages supported)

### Discord Username
rekty

### Pollinations Integration Evidence
- **Image Generation**: /api/generate endpoint calls Pollinations image API with model parameter
- **Chat/Text**: /api/chat endpoint calls Pollinations chat completions API (openai-fast, nova-fast, gemini-fast, gemini-3-flash, gpt-5.6-luna)
- **BYOP OAuth**: Login with Pollinations button triggers OAuth PKCE flow
- **Provider Selection**: Dropdown API panel lets user choose Pollinations as provider
- **Frontend mention**: Pollinations visible in provider selector and footer

### Live Demo
- Desktop: https://visualaiartwork.pages.dev
- Mobile: Same URL, responsive design
- Note: Single-file index.html (409KB) + Cloudflare Worker backend
