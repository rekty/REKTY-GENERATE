### App Name
REKTY GENERATOR

### App Description
REKTY GENERATOR is a free, open-source AI image generator web app that supports multiple providers in one interface. It uses **Pollinations AI** for:
- **Image generation** via Pollinations API (57+ models: Z-Image, Krea, FLUX, etc.)
- **Text/Chat** via Pollinations text models (openai-fast, nova-fast, gemini-fast, gpt-5.6-luna)
- **BYOP (Bring Your Own Pollen)** integration - users login with Pollinations account via OAuth PKCE
- **Audio generation** via Pollinations API

The app features responsive design (desktop + mobile), auto-archive, WD14 Tagger, and multiple AI providers (Pollinations, Tensor.Art, Replicate, fal.ai).

### App URL
https://visualaiartwork.pages.dev

### GitHub Repository URL
https://github.com/rekty/REKTY-GENERATE

### App Category
image

### App Language
id

### Discord Username
rekty

### Pollinations Integration Evidence
- **Image Generation**: /api/generate endpoint calls Pollinations image API with model parameter
- **Chat/Text**: /api/chat endpoint calls Pollinations chat completions API
- **BYOP OAuth**: Login with Pollinations button triggers OAuth PKCE flow
- **Provider Selection**: Dropdown API panel lets user choose Pollinations as provider
- **Frontend mention**: Pollinations visible in provider selector and footer

### Live Demo
- Desktop: https://visualaiartwork.pages.dev
- Mobile: Same URL, responsive design
- Note: Single-file index.html (409KB) + Cloudflare Worker backend
