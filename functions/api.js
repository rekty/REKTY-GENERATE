/**
 * REKTY GENERATOR — backend proxy untuk Tensor.Art Model Service (TAMS).
 *
 * File ini adalah Cloudflare Pages Function. Saat di-deploy ke Cloudflare
 * Pages, folder `functions/` otomatis menjadi backend di origin yang sama
 * (jadi tidak kena CORS dan API key tidak bocor ke browser).
 *
 * Endpoint:
 *   GET  /api/health           -> status backend + apakah API key tersedia
 *   POST /api/generate         -> terima payload web-format, buat job di TAMS
 *   GET  /api/task?id=<jobId>  -> status job (progress, hasil, error)
 *
 * API key:
 *   1. Environment variable TENSORART_API_KEY (paling aman, via dashboard
 *      Cloudflare Pages -> Settings -> Environment variables), ATAU
 *   2. Header `x-api-key`, ATAU
 *   3. Body `apiKey` (dikirim frontend dari pengaturan di browser).
 *
 * Referensi API TAMS: https://tams.tensor.art  (buat token gratis di sana)
 */

const TAMS_BASE = 'https://ap-east-1.tensorart.cloud';
const REPLICATE_BASE = 'https://api.replicate.com';
const FAL_QUEUE = 'https://queue.fal.run';
const FAL_MODEL = 'fal-ai/fast-sdxl';
const POLLINATIONS_IMG = 'https://image.pollinations.ai/prompt/'; // legacy gratis (tanpa key)
const GEN_POLLINATIONS = 'https://gen.pollinations.ai/image/';   // API baru (wajib key sk_*)
const GEN_POLLINATIONS_CHAT = 'https://gen.pollinations.ai/v1/chat/completions'; // text LLM (refine prompt)
const GTX_TRANSLATE = 'https://translate.googleapis.com/translate_a/single';     // terjemahan gratis (tanpa key)
const ENTER_AUTH = 'https://enter.pollinations.ai';              // OAuth BYOP (Bring Your Own Pollen)
const MAX_BODY = 4_000_000; // batas JSON payload yang diterima (chars)

// Pemetaan sampler UI -> scheduler Replicate (SDXL). Nama UI = nama ComfyUI
// (euler, euler_ancestral, dpmpp_2m, ...) sesuai daftar sampler di aplikasi.
// Key lama (nama tampilan A1111) dipertahankan agar payload lama tetap jalan.
const REPLICATE_SCHEDULER = {
  'Euler a': 'K_EULER_ANCESTRAL',
  'Euler': 'K_EULER',
  'LMS': 'KLMS',
  'LMS Karras': 'KLMS',
  'DDIM': 'DDIM',
  'Heun': 'Heun',
  'DPM++ 2M': 'DPMSolverMultistep',
  'DPM++ 2M Karras': 'DPMSolverMultistep',
  'DPM++ 2S a Karras': 'DPMSolverMultistep',
  'DPM++ SDE Karras': 'DPMSolverSDE',
  // nama ComfyUI (dropdown aplikasi sekarang)
  'euler': 'K_EULER',
  'euler_ancestral': 'K_EULER_ANCESTRAL',
  'heun': 'Heun',
  'lms': 'KLMS',
  'ddim': 'DDIM',
  'dpm_2': 'K_DPM_2',
  'dpm_2_ancestral': 'K_DPM_2_ANCESTRAL',
  'dpmpp_2m': 'DPMSolverMultistep',
  'dpmpp_2s_ancestral': 'DPMSolverMultistep',
  'dpmpp_2m_sde_gpu': 'DPMSolverSDE',
  'dpmpp_sde_gpu': 'DPMSolverSDE',
  'dpmpp_3m_sde_gpu': 'DPMSolverSDE',
};

// Pemetaan sampler UI (nama ComfyUI) -> sampler fal-ai/fast-sdxl.
const FAL_SAMPLER = {
  euler: 'euler',
  euler_ancestral: 'euler_a',
  heun: 'heun',
  lms: 'lms',
  dpmpp_2s_ancestral: 'dpmpp_2s_a',
  dpmpp_sde_gpu: 'dpmpp_sde',
  dpmpp_2m: 'dpmpp_2m',
  dpmpp_2m_sde_gpu: 'dpmpp_2m_sde',
  dpmpp_3m_sde_gpu: 'dpmpp_3m_sde',
  ddpm: 'ddpm',
  lcm: 'lcm',
  ddim: 'ddim',
  uni_pc: 'uni_pc',
  uni_pc_bh2: 'uni_pc_bh2',
};

/* ----------------------------- helpers ----------------------------- */

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(), ...extra },
  });
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function clampFloat(v, min, max, dflt) {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

/** Seed: Pollinations/TAMS int32 <= 2147483647; 0 = random. */
function toSeed(seed) {
  const s = String(seed ?? '').trim();
  if (/^\d{1,10}$/.test(s)) {
    const n = parseInt(s, 10);
    if (n > 0) return Math.min(n, 2147483647);
  }
  return 0; // random
}

const PROVIDERS = ['tams', 'replicate', 'fal', 'pollinations', 'selfhost'];
const PROVIDER_ENV = {
  tams: 'TENSORART_API_KEY',
  replicate: 'REPLICATE_API_TOKEN',
  fal: 'FAL_API_KEY',
  pollinations: 'POLLINATIONS_API_KEY', // opsional — gratis tanpa key, sk_* untuk API baru
  selfhost: 'SELFHOST_BASE_URL',        // opsional — URL endpoint ComfyUI-mu (tanpa /v1)
};

function pickApiKey(env, request, body, provider) {
  const envName = PROVIDER_ENV[provider] || 'TENSORART_API_KEY';
  if (env && env[envName]) return env[envName];
  const h = request && request.headers && request.headers.get('x-api-key');
  if (h) return h;
  if (body && typeof body.apiKey === 'string' && body.apiKey.trim()) return body.apiKey.trim();
  return null;
}

/**
 * Resolusi key untuk provider Pollinations (urutan prioritas):
 *   1. Sesi BYOP (x-session header / body.session) — user membawa pollen mereka
 *      sendiri lewat OAuth. Token scoped disimpan di KV: oauth:<session>.
 *   2. Secret env POLLINATIONS_API_KEY (milik pemilik app).
 *   3. Key via header x-api-key / body.apiKey (browser, manual).
 */
async function pickPollKey(env, request, body) {
  const sid = String((request && request.headers && request.headers.get('x-session')) || (body && body.session) || '').trim();
  if (sid && env && env.IMAGES) {
    const raw = await env.IMAGES.get('oauth:' + sid, { type: 'text' }).catch(() => null);
    if (raw) {
      const rec = safeJson(raw);
      if (rec && rec.token && (!rec.expiresAt || rec.expiresAt > Date.now())) return rec.token;
    }
  }
  if (env && env.POLLINATIONS_API_KEY) return env.POLLINATIONS_API_KEY;
  return pickApiKey(env, request, body, 'pollinations');
}

async function fetchWithTimeout(url, opts, ms = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---- Web Researcher: riset web tanpa API key (Wikipedia + DuckDuckGo) ----
const SSE_H = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
const WEB_UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VAIA-Chatbot/1.0' };
async function webSearch(query) {
  const q = String(query || '').trim().slice(0, 120);
  if (!q) return [];
  const out = [];
  const grab = async function (fn) { try { return await fn(); } catch (e) { return null; } };
  // 1) Wikipedia: cari artikel + ringkasan 2 teratas
  const wj = await grab(async function () {
    const r = await fetchWithTimeout('https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=' + encodeURIComponent(q) + '&srlimit=3&format=json&origin=*', { headers: WEB_UA }, 10000);
    return await r.json();
  });
  const titles = ((wj && wj.query && wj.query.search) || []).map(function (s) { return s.title; });
  for (const t of titles.slice(0, 2)) {
    const ej = await grab(async function () {
      const r = await fetchWithTimeout('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(String(t).replace(/ /g, '_')), { headers: WEB_UA }, 10000);
      return await r.json();
    });
    if (ej && ej.extract) out.push({ source: 'Wikipedia', title: String(ej.title || t), snippet: String(ej.extract).slice(0, 600) });
  }
  // 2) DuckDuckGo Instant Answer
  const dj = await grab(async function () {
    const r = await fetchWithTimeout('https://api.duckduckgo.com/?q=' + encodeURIComponent(q) + '&format=json&no_html=1', { headers: WEB_UA }, 10000);
    return await r.json();
  });
  if (dj && dj.AbstractText) out.push({ source: 'DuckDuckGo', title: String(dj.Heading || q), snippet: String(dj.AbstractText).slice(0, 600) });
  if (dj && Array.isArray(dj.RelatedTopics)) {
    dj.RelatedTopics.slice(0, 3).forEach(function (rt) {
      if (rt && rt.Text && out.length < 5) {
        const parts = String(rt.Text).split(' - ');
        out.push({ source: 'DuckDuckGo', title: (parts[0] || q).slice(0, 80), snippet: String(rt.Text).slice(0, 600) });
      }
    });
  }
  return out.slice(0, 5);
}

function stripMarkers(t) {
  return String(t || '').replace(/\[WEB_SEARCH:[^\]]*\]/gi, '').trim();
}

function researchTxtFor(marker, results) {
  return 'Hasil riset web (skill Web Researcher) untuk "' + marker + '":\n'
    + (results && results.length
      ? results.map(function (r) { return '- [' + r.source + '] ' + r.title + ': ' + r.snippet; }).join('\n')
      : '(Pencarian web tidak menemukan hasil — jawab berdasarkan pengetahuanmu dan beri tahu user bahwa hasil pencarian kosong.)')
    + '\n\nJawab langsung berdasarkan hasil riset di atas. JANGAN keluarkan format [WEB_SEARCH] lagi.';
}

// Saring marker [WEB_SEARCH: ...] dari stream (jaga kalau model mengulang marker)
function sseClean(src) {
  const reader = src.getReader();
  const dec = new TextDecoder();
  let buf = '';
  return new ReadableStream({
    start(controller) {
      function flushSafe() {
        const keep = 40;
        const safe = buf.length > keep ? buf.slice(0, buf.length - keep) : '';
        buf = buf.slice(safe.length);
        const out = safe.replace(/\[WEB_SEARCH:[^\]]*\]/gi, '');
        if (out) controller.enqueue(new TextEncoder().encode(out));
      }
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            const out = buf.replace(/\[WEB_SEARCH:[^\]]*\]/gi, '');
            if (out) controller.enqueue(new TextEncoder().encode(out));
            controller.close();
            return;
          }
          buf += dec.decode(r.value, { stream: true });
          flushSafe();
          return pump();
        });
      }
      return pump();
    },
    cancel() { try { reader.cancel(); } catch (e) {} },
  });
}

/* --------------------------- TAMS client ---------------------------- */

/** Upload gambar (data URL) ke TAMS, kembalikan resourceId. */
async function tamsUploadImage(dataUrl, apiKey) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) throw new Error('Format gambar tidak dikenal');
  const mime = (dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/png');
  const b64 = dataUrl.slice(comma + 1);

  const res = await fetchWithTimeout(TAMS_BASE + '/v1/resource/image', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify({ expireSec: 86400 }),
  });
  const txt = await res.text();
  if (!res.ok) {
    throw new Error('TAMS resource image ' + res.status + ': ' + txt.slice(0, 300));
  }
  const d = safeJson(txt) || {};
  const resourceId = d.resourceId;
  const putUrl = d.putUrl;
  if (!resourceId || !putUrl) {
    throw new Error('TAMS tidak mengembalikan upload URL: ' + txt.slice(0, 200));
  }

  // b64 -> Uint8Array
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const up = await fetchWithTimeout(putUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mime, ...(d.headers || {}) },
    body: bytes,
  }, 90000);
  if (!up.ok) {
    throw new Error('Upload gambar gagal (HTTP ' + up.status + ')');
  }
  return resourceId;
}

/** Terjemahkan payload web-format (buildPayload di index.html) -> job TAMS. */
async function tamsCreateJob(body, apiKey) {
  const params = body.params || body;
  const taskType = String(body.taskType || 'TXT2IMG').toUpperCase();
  const isImg = taskType === 'IMG2IMG' || (params.enablePix2pix === true);

  const diffusion = {
    width: clampInt(params.width, 512, 2048, 768),
    height: clampInt(params.height, 512, 2048, 1152),
    prompts: [{ text: String(params.prompt || '').slice(0, 1500) }],
    negativePrompts: params.negativePrompt
      ? [{ text: String(params.negativePrompt).slice(0, 1500) }]
      : [],
    sdModel: String((params.baseModel && params.baseModel.modelId) || params.sdModel || ''),
    sdVae: params.sdVae === 'none' ? 'None' : String(params.sdVae || 'Automatic'),
    sampler: String(params.ksamplerName || params.sampler || 'DPM++ 2M Karras'),
    steps: clampInt(params.steps, 1, 60, 15),
    cfgScale: clampFloat(params.cfgScale, 1, 30, 7),
    clipSkip: clampInt(params.clipSkip, 1, 12, 2),
    etaNoiseSeedDelta: clampInt(params.etaNoiseSeedDelta, 0, 31337, 31337),
    enablePix2pix: isImg ? true : false,
  };
  if (params.schedule && String(params.schedule).trim()) {
    diffusion.scheduleName = String(params.schedule).trim();
  }
  if (params.v1Clip === true) diffusion.v1Clip = true;

  // LoRA hanya dikirim kalau punya id model nyata (angka).
  const loras = (Array.isArray(params.models) ? params.models : [])
    .filter((m) => m && /^\d+$/.test(String(m.loraModel || '')))
    .map((m) => ({
      loraModel: String(m.loraModel),
      weight: clampFloat(m.weight, 0, 2, 0.8),
    }));
  if (loras.length) diffusion.lora = { items: loras };

  const inputInit = {
    seed: toSeed(params.seed),
    count: clampInt(params.imageCount, 1, 4, 1),
  };

  const hasImage = isImg && Array.isArray(params.images) && params.images[0];
  const hasMask = isImg && hasImage && Array.isArray(params.masks) && params.masks[0];
  if (hasImage) {
    const resourceId = await tamsUploadImage(params.images[0], apiKey);
    inputInit.imageResourceId = resourceId;
    diffusion.denoisingStrength = clampFloat(
      params.denoisingStrength != null ? params.denoisingStrength : params.denoising_strength,
      0, 1, 0.5,
    );
  }

  const stages = [
    { type: 'INPUT_INITIALIZE', inputInitialize: inputInit },
  ];
  // Tool Inpaint (mask brush): stage IMAGE_TO_INPAINT — area putih di mask = digambar ulang.
  // Per docs TAMS: mask hitam + bagian yang mau di-redraw berwarna putih, resolusi sama dengan aslinya.
  if (hasMask) {
    const maskResourceId = await tamsUploadImage(params.masks[0], apiKey);
    inputInit.count = 1;
    stages.push({
      type: 'IMAGE_TO_INPAINT',
      imageToInpaint: {
        resizeMode: 'JUST_RESIZE',
        maskImageResourceId: maskResourceId,
        maskBlur: 4,
        inpaintingFill: 'ORIGINAL',
        inpaintFullRes: true,
        inpaintFullResPadding: 32,
        diffusion,
      },
    });
  } else {
    stages.push({ type: 'DIFFUSION', diffusion });
  }
  // Tool Upscale 2x (ala Tensor.Art): tambah stage IMAGE_TO_UPSCALER setelah DIFFUSION
  // supaya hasil generate otomatis di-upscale 2x oleh TAMS.
  if (params.upscale === true) {
    stages.push({
      type: 'IMAGE_TO_UPSCALER',
      image_to_upscaler: {
        hr_upscaler: '4x-UltraSharp',
        hr_scale: 2,
        hr_second_pass_steps: 10,
        denoising_strength: 0.3,
      },
    });
  }

  const payload = {
    request_id: 'rekty-' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    stages,
  };

  const res = await fetchWithTimeout(TAMS_BASE + '/v1/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(payload),
  }, 60000);
  const txt = await res.text();
  if (!res.ok) {
    let detail = txt.slice(0, 300);
    const d = safeJson(txt);
    if (d && (d.message || d.msg)) detail = String(d.message || d.msg).slice(0, 300);
    throw new Error('TAMS menolak task (HTTP ' + res.status + '): ' + detail);
  }
  const d = safeJson(txt) || {};
  const job = d.job || (d.data && d.data.job) || d.data || {};
  const taskId = job.id || job.jobId || d.taskId || (d.data && d.data.taskId) || (d.data && d.data.jobId);
  if (!taskId) {
    throw new Error('TAMS tidak mengembalikan job id: ' + txt.slice(0, 200));
  }
  return { taskId: String(taskId), credits: job.credits != null ? job.credits : null };
}

/** Ambil status job dari TAMS dan normalisasi untuk frontend. */
async function tamsGetJob(jobId, apiKey) {
  const res = await fetchWithTimeout(TAMS_BASE + '/v1/jobs/' + encodeURIComponent(jobId), {
    method: 'GET',
    headers: { Authorization: 'Bearer ' + apiKey },
  }, 30000);
  const txt = await res.text();
  if (!res.ok) {
    throw new Error('TAMS get job ' + res.status + ': ' + txt.slice(0, 200));
  }
  const d = safeJson(txt) || {};
  const job = d.job || (d.data && d.data.job) || d.data || {};

  const status = String(job.status || 'DEFAULT').toUpperCase();
  const out = { status, progress: 0 };

  if (status === 'RUNNING' || status === 'PENDING') {
    const ri = job.runningInfo || {};
    out.progress = clampFloat(
      (ri.workflowFinishItem && ri.workflowFinishItem.progress) ||
      (ri.processingImages && ri.processingImages[0] && ri.processingImages[0].progress),
      0, 100, 0,
    );
  } else if (status === 'WAITING' && job.waitingInfo) {
    out.queue = '#' + job.waitingInfo.queueRank + '/' + job.waitingInfo.queueLen;
    out.progress = 0;
  } else if (status === 'SUCCESS') {
    const si = job.successInfo || {};
    const imgs = (si.images || []).map((i) => i && i.url).filter(Boolean);
    out.images = imgs;
    out.progress = 100;
  } else if (status === 'FAILED') {
    out.error = (job.failedInfo && (job.failedInfo.reason || job.failedInfo.message)) || 'Task gagal di sisi TAMS';
  }

  if (job.credits != null) out.credits = job.credits;
  return out;
}

/* --------------------------- Replicate ------------------------------ */

/** Pilih aspect ratio terdekat (format Flux) dari ukuran w x h. */
function arFromWH(w, h) {
  const ratio = (parseInt(w, 10) || 768) / (parseInt(h, 10) || 1152);
  const list = [['21:9', 21 / 9], ['16:9', 16 / 9], ['3:2', 1.5], ['4:3', 4 / 3], ['1:1', 1], ['3:4', 3 / 4], ['2:3', 2 / 3], ['9:16', 9 / 16], ['9:21', 9 / 21]];
  let best = '1:1';
  let bestD = Infinity;
  for (const [k, v] of list) {
    const d = Math.abs(ratio - v);
    if (d < bestD) { bestD = d; best = k; }
  }
  return best;
}

/** Buat prediction di Replicate — model dipilih dari params.model (owner/name). */
async function replicateCreateJob(body, apiKey) {
  const params = body.params || body;
  if (params.enablePix2pix === true || String(body.taskType || '').toUpperCase() === 'IMG2IMG') {
    throw new Error('Provider Replicate belum mendukung Img2Img — pakai TAMS atau mode demo');
  }
  // LoRA aktif (models dengan weight > 0 dan id model nyata berisi '/')
  // mengalihkan target prediction ke model LoRA itu sendiri — pola Replicate:
  // LoRA dijalankan sebagai model. ID numerik (TAMS) diabaikan di sini.
  const loras = (Array.isArray(params.models) ? params.models : [])
    .filter((m) => m && Number(m.weight || 0) > 0 && String(m.loraModel || '').includes('/'));
  let model = String(params.model || 'stability-ai/sdxl');
  let lora = null;
  if (loras.length && String(loras[0].loraModel || '').trim()) {
    model = String(loras[0].loraModel).trim();
    lora = loras[0];
  }
  const lower = model.toLowerCase();
  const isFlux = lower.includes('flux');
  const isLightning = lower.includes('lightning');
  const isLoraModel = lower.includes('lora');

  let input;
  if (isFlux) {
    input = {
      prompt: String(params.prompt || ''),
      num_outputs: clampInt(params.imageCount, 1, 4, 1),
      aspect_ratio: arFromWH(params.width, params.height),
      num_inference_steps: lower.includes('schnell') ? 4 : clampInt(params.steps, 1, 50, 28),
      guidance_scale: clampFloat(params.cfgScale, 0, 10, 3.5),
      disable_safety_checker: false,
    };
    if (isLoraModel) {
      if (!lora || !String(lora.loraUrl || '').trim()) {
        throw new Error('LoRA ' + model + ' butuh URL file (.safetensors) — isi field URL di kartu LoRA');
      }
      input.lora_url = String(lora.loraUrl).trim();
      input.lora_scale = clampFloat(lora.weight, 0, 1, 0.8);
      const trigs = (lora && Array.isArray(lora.triggerWords) ? lora.triggerWords : []).filter(Boolean);
      const promptText = String(params.prompt || '');
      const missing = trigs.filter((t) => !promptText.toLowerCase().includes(String(t).toLowerCase()));
      if (missing.length) input.lora_trigger_phrase = missing.join(', ');
    }
  } else {
    input = {
      prompt: String(params.prompt || ''),
      width: clampInt(params.width, 512, 2048, 768),
      height: clampInt(params.height, 512, 2048, 1152),
      num_outputs: clampInt(params.imageCount, 1, 4, 1),
      num_inference_steps: isLightning ? clampInt(params.steps, 1, 8, 4) : clampInt(params.steps, 1, 60, 25),
    };
    if (!isLightning) {
      input.guidance_scale = clampFloat(params.cfgScale, 1, 30, 7);
      const sched = REPLICATE_SCHEDULER[String(params.ksamplerName || params.sampler || '')];
      if (sched) input.scheduler = sched;
    }
    if (params.negativePrompt) input.negative_prompt = String(params.negativePrompt);
    // LoRA SDXL via URL (model generik zylim0702/sdxl-lora-customize-model)
    if (lora && lower === 'zylim0702/sdxl-lora-customize-model') {
      if (!String(lora.loraUrl || '').trim()) {
        throw new Error('LoRA SDXL (URL) butuh URL file LoRA — isi field URL di kartu LoRA');
      }
      input.lora_url = String(lora.loraUrl).trim();
      input.lora_scale = clampFloat(lora.weight, 0, 2, 0.8);
    }
  }
  const seed = toSeed(params.seed);
  if (seed > 0) input.seed = seed;

  const res = await fetchWithTimeout(
    REPLICATE_BASE + '/v1/models/' + model + '/predictions',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ input }),
    }, 60000,
  );
  const txt = await res.text();
  if (!res.ok) {
    let detail = txt.slice(0, 300);
    const d = safeJson(txt);
    if (d && (d.detail || d.error)) detail = String(d.detail || d.error).slice(0, 300);
    throw new Error('Replicate menolak task (HTTP ' + res.status + '): ' + detail);
  }
  const d = safeJson(txt) || {};
  const id = d.id;
  if (!id) throw new Error('Replicate tidak mengembalikan prediction id: ' + txt.slice(0, 200));
  return { taskId: 'replicate:' + id, credits: null };
}

/** Ambil status prediction Replicate. */
async function replicateGetJob(jobId, apiKey) {
  const res = await fetchWithTimeout(
    REPLICATE_BASE + '/v1/predictions/' + encodeURIComponent(jobId),
    { method: 'GET', headers: { Authorization: 'Bearer ' + apiKey } }, 30000,
  );
  const txt = await res.text();
  if (!res.ok) throw new Error('Replicate get prediction ' + res.status + ': ' + txt.slice(0, 200));
  const d = safeJson(txt) || {};
  const st = String(d.status || '').toLowerCase();
  const out = { status: 'PENDING', progress: 0 };
  if (st === 'starting') { out.status = 'RUNNING'; out.progress = 10; }
  else if (st === 'processing') { out.status = 'RUNNING'; out.progress = 50; }
  else if (st === 'succeeded') {
    out.status = 'SUCCESS'; out.progress = 100;
    const o = d.output;
    out.images = (Array.isArray(o) ? o : (o ? [o] : [])).map((x) => typeof x === 'string' ? x : (x && x.url)).filter(Boolean);
  }
  else if (st === 'failed') { out.status = 'FAILED'; out.error = String(d.error || 'Prediction gagal').slice(0, 400); }
  else if (st === 'canceled') out.status = 'CANCELED';
  else if (st === 'queued') { out.status = 'WAITING'; }
  return out;
}

/* ------------------------------ fal.ai ------------------------------- */

/** Buat request di fal.ai — model dipilih dari params.model (fal-ai/...). */
async function falCreateJob(body, apiKey) {
  const params = body.params || body;
  if (params.enablePix2pix === true || String(body.taskType || '').toUpperCase() === 'IMG2IMG') {
    throw new Error('Provider fal.ai belum mendukung Img2Img — pakai TAMS atau mode demo');
  }
  // LoRA aktif (id model nyata berisi '/', mis. fal-ai/flux-lora) mengalihkan
  // target ke model LoRA. ID numerik (TAMS) diabaikan di sini.
  const loras = (Array.isArray(params.models) ? params.models : [])
    .filter((m) => m && Number(m.weight || 0) > 0 && String(m.loraModel || '').includes('/'));
  let model = String(params.model || FAL_MODEL);
  let lora = null;
  if (loras.length && String(loras[0].loraModel || '').trim()) {
    model = String(loras[0].loraModel).trim();
    lora = loras[0];
  }
  const lower = model.toLowerCase();
  const isFlux = lower.includes('/flux');
  const isSchnell = isFlux && lower.includes('schnell');
  const isKrea2 = lower.includes('krea');

  const input = {
    prompt: String(params.prompt || ''),
    image_size: {
      width: clampInt(params.width, 512, 2048, 768),
      height: clampInt(params.height, 512, 2048, 1152),
    },
    num_images: clampInt(params.imageCount, 1, 4, 1),
  };
  const seed = toSeed(params.seed);
  if (seed > 0) input.seed = seed;
  if (isKrea2) {
    // Krea 2 (turbo) — distilled: tanpa negative prompt / steps / guidance.
    if (lora) {
      if (!String(lora.loraUrl || '').trim()) {
        throw new Error('LoRA Krea 2 butuh URL file LoRA — isi field URL di kartu LoRA');
      }
      input.loras = [{ path: String(lora.loraUrl).trim(), scale: clampFloat(lora.weight, 0, 2, 0.8) }];
    }
  } else if (isFlux) {
    input.num_inference_steps = isSchnell ? 4 : clampInt(params.steps, 1, 50, 28);
    input.guidance_scale = clampFloat(params.cfgScale, 0, 10, 3.5);
    if (lora) {
      if (!String(lora.loraUrl || '').trim()) {
        throw new Error('LoRA ' + model + ' butuh URL file LoRA — isi field URL di kartu LoRA');
      }
      input.lora_url = String(lora.loraUrl).trim();
      input.lora_scale = clampFloat(lora.weight, 0, 1, 0.8);
    }
  } else {
    input.num_inference_steps = clampInt(params.steps, 1, 60, 25);
    input.guidance_scale = clampFloat(params.cfgScale, 1, 30, 7);
    if (params.negativePrompt) input.negative_prompt = String(params.negativePrompt);
    // Sampler hanya dikirim ke fast-sdxl (fal) yang menerimanya.
    if (lower === 'fal-ai/fast-sdxl') {
      const smp = FAL_SAMPLER[String(params.ksamplerName || params.sampler || '').toLowerCase()];
      if (smp) input.sampler = smp;
    }
    // LoRA SDXL via URL — fast-sdxl menerima input asli `loras`
    if (lora && lower === 'fal-ai/fast-sdxl') {
      if (!String(lora.loraUrl || '').trim()) {
        throw new Error('LoRA SDXL (fast-sdxl) butuh URL file LoRA — isi field URL di kartu LoRA');
      }
      input.loras = [{ path: String(lora.loraUrl).trim(), scale: clampFloat(lora.weight, 0, 2, 0.8) }];
    }
  }

  const res = await fetchWithTimeout(
    FAL_QUEUE + '/' + model,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Key ' + apiKey },
      body: JSON.stringify(input),
    }, 60000,
  );
  const txt = await res.text();
  if (!res.ok) {
    let detail = txt.slice(0, 300);
    const d = safeJson(txt);
    if (d && (d.detail || d.error)) detail = String(d.detail || d.error).slice(0, 300);
    throw new Error('fal.ai menolak task (HTTP ' + res.status + '): ' + detail);
  }
  const d = safeJson(txt) || {};
  const id = d.request_id;
  if (!id) throw new Error('fal.ai tidak mengembalikan request_id: ' + txt.slice(0, 200));
  // Task id menyandikan model supaya polling tahu endpoint status yang benar.
  return { taskId: 'fal:' + model + ':' + id, credits: null };
}

/** Ambil status request fal.ai (queue status + hasil). */
async function falGetJob(jobId, apiKey, model) {
  const base = FAL_QUEUE + '/' + (model || FAL_MODEL) + '/requests/' + encodeURIComponent(jobId);
  const res = await fetchWithTimeout(base + '/status', {
    method: 'GET', headers: { Authorization: 'Key ' + apiKey },
  }, 30000);
  const txt = await res.text();
  if (!res.ok) throw new Error('fal.ai status ' + res.status + ': ' + txt.slice(0, 200));
  const d = safeJson(txt) || {};
  const st = String(d.status || '').toUpperCase();
  const out = { status: 'PENDING', progress: 0 };
  if (st === 'COMPLETED') {
    const resUrl = d.response_url || base;
    const r2 = await fetchWithTimeout(resUrl, {
      method: 'GET', headers: { Authorization: 'Key ' + apiKey },
    }, 30000);
    const txt2 = await r2.text();
    const dd = safeJson(txt2) || {};
    out.status = 'SUCCESS'; out.progress = 100;
    out.images = (dd.images || []).map((i) => i && i.url).filter(Boolean);
  } else if (st === 'IN_PROGRESS') {
    out.status = 'RUNNING';
    out.progress = clampFloat(d.progress, 0, 95, 50);
  } else if (st === 'IN_QUEUE' || st === 'BUFFERING') {
    out.status = 'WAITING';
    if (d.queue_position != null) out.queue = '#' + d.queue_position;
  }
  return out;
}

/* ----------------------- penyimpanan gambar (KV) ----------------------- */

/**
 * Simpan bytes gambar ke Cloudflare KV (binding IMAGES) dan kembalikan URL
 * permanen `/img/<nama>`, atau null kalau gagal/terlalu besar (batas KV 25
 * MiB — gambar > 20 MiB dilewati). KV dipakai karena gratis tanpa billing
 * (R2 mewajibkan kartu saat aktivasi).
 */
const CT_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
};
function extFromCt(ct) { return CT_EXT[String(ct).toLowerCase().split(';')[0]] || 'png'; }

async function storeImageBuf(buf, ct, env) {
  if (!env || !env.IMAGES || !buf || !buf.byteLength) return null;
  if (buf.byteLength > 20 * 1024 * 1024) return null;
  const name = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2)) + '.' + extFromCt(ct);
  try {
    await env.IMAGES.put(name, buf);
    return '/img/' + name;
  } catch {
    return null;
  }
}

/** Unduh gambar dari URL provider lalu arsip ke KV; fallback ke URL asli. */
async function archiveImages(urls, env) {
  if (!env || !env.IMAGES || !Array.isArray(urls) || !urls.length) return urls;
  const out = [];
  for (const u of urls) {
    if (!u) { out.push(u); continue; }
    try {
      const res = await fetchWithTimeout(u, {}, 60000);
      if (!res.ok) { out.push(u); continue; }
      const buf = await res.arrayBuffer();
      const ct = String(res.headers.get('content-type') || 'image/png').split(';')[0] || 'image/png';
      out.push((await storeImageBuf(buf, ct, env)) || u);
    } catch {
      out.push(u); // gagal arsip — tetap tampilkan URL asli provider
    }
  }
  return out;
}

/* --------------------------- Self-Host (ComfyUI gateway) --------------------------- */

/** Deteksi tipe gambar dari magic bytes. */
function sniffImageCt(buf) {
  try {
    const b = new Uint8Array(buf);
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'image/webp';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  } catch { /* ignore */ }
  return 'image/png';
}

/** Decode base64 (string) ke ArrayBuffer. */
function b64ToBuf(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Generate via gateway OpenAI-compatible self-host (ComfyUI + LoRA-mu).
 * Pakai MODE ASYNC gateway: POST balas task_id langsung (< 2 detik), generate
 * jalan di background gateway, dan /api/task polling GET /v1/tasks/<id>.
 * Dengan begitu tidak ada fetch panjang di Worker -> tidak kena timeout 504.
 */
async function selfhostCreateJob(body, env) {
  const params = body.params || body;
  const base = String((env && env.SELFHOST_BASE_URL) || body.selfhostUrl || body.endpoint || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  if (!/^https?:\/\//.test(base)) {
    throw new Error('URL endpoint self-host belum diatur. Isi di Pengaturan -> Endpoint Self-Host, atau set env SELFHOST_BASE_URL.');
  }
  const width = clampInt(params.width, 64, 2048, 832);
  const height = clampInt(params.height, 64, 2048, 1536);
  const seed = toSeed(params.seed);
  const payload = {
    model: String(params.model || 'rekty1988/anjany'),
    prompt: String(params.prompt || '').slice(0, 1500),
    size: width + 'x' + height,
    n: Math.max(1, parseInt(params.imageCount, 10) || 1),
    steps: Math.max(1, parseInt(params.steps, 10) || 8),
    cfg: parseFloat(params.cfgScale) >= 0 ? parseFloat(params.cfgScale) : 1.0,
    sampler: String(params.ksamplerName || 'er_sde'),
    scheduler: String(params.schedule || 'simple'),
    negative_prompt: String(params.negativePrompt || 'low quality, worst quality').slice(0, 500),
    async: true,
  };
  if (seed > 0) payload.seed = seed;

  const res = await fetchWithTimeout(base + '/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 25000);
  const txt = await res.text();
  if (!res.ok) {
    let msg = txt.slice(0, 300);
    try { msg = (JSON.parse(txt).error && (JSON.parse(txt).error.message || msg)) || msg; } catch { /* keep */ }
    throw new Error('Self-Host gagal (HTTP ' + res.status + '): ' + msg);
  }
  let d = null;
  try { d = JSON.parse(txt); } catch { /* ignore */ }
  const gatewayTask = String((d && d.task_id) || '');
  if (!gatewayTask) throw new Error('Gateway tidak membalas task id (mode async)');

  const taskId = 'selfhost:' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2));
  if (env && env.IMAGES) {
    await env.IMAGES.put('task:' + taskId, JSON.stringify({
      status: 'RUNNING', progress: 0, startedAt: Date.now(),
      endpoint: base, gatewayTask,
    })).catch(() => {});
  }
  return { taskId, images: [] };
}

async function selfhostGetTask(jobId, env) {
  if (!env || !env.IMAGES) return { status: 'RUNNING', progress: 0 };
  const raw = await env.IMAGES.get('task:selfhost:' + jobId, { type: 'text' }).catch(() => null);
  if (!raw) return { status: 'RUNNING', progress: 0 };
  const rec = safeJson(raw);
  if (!rec) return { status: 'FAILED', error: 'Task tidak dikenal' };
  if (rec.status === 'SUCCESS' || rec.status === 'FAILED') return rec;

  // RUNNING -> tanya gateway sampai selesai.
  const base = String(rec.endpoint || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '');
  const gt = String(rec.gatewayTask || '');
  if (!base || !gt) return { status: 'RUNNING', progress: 0 };
  let d = null;
  try {
    const res = await fetchWithTimeout(base + '/v1/tasks/' + encodeURIComponent(gt), {}, 15000);
    if (res.ok) d = safeJson(await res.text());
  } catch { d = null; }
  if (!d || d.status === 'processing') {
    // Endpoint tidak terjangkau lama -> biar tidak polling selamanya.
    if (Date.now() - (rec.startedAt || 0) > 6 * 60 * 1000) {
      const err = 'Endpoint self-host tidak terjangkau (sesi Kaggle mungkin mati) — restart notebook lalu update URL di Pengaturan.';
      await env.IMAGES.put('task:selfhost:' + jobId, JSON.stringify({ status: 'FAILED', error: err })).catch(() => {});
      return { status: 'FAILED', error: err };
    }
    return { status: 'RUNNING', progress: 0 };
  }
  if (d.status === 'error') {
    const err = String(d.error || 'Gateway error');
    await env.IMAGES.put('task:selfhost:' + jobId, JSON.stringify({ status: 'FAILED', error: err })).catch(() => {});
    return { status: 'FAILED', error: err };
  }
  // completed -> arsip base64 ke KV.
  const list = (Array.isArray(d.data) ? d.data : []).filter((x) => x && x.b64_json);
  const urls = [];
  for (const it of list) {
    try {
      const buf = b64ToBuf(it.b64_json);
      urls.push((await storeImageBuf(buf, sniffImageCt(buf), env)) || null);
    } catch { urls.push(null); }
  }
  const images = urls.filter(Boolean);
  const final = { status: 'SUCCESS', progress: 100, images };
  await env.IMAGES.put('task:selfhost:' + jobId, JSON.stringify(final)).catch(() => {});
  return final;
}

/* --------------------------- Pollinations --------------------------- */

/**
 * Generate sinkron via Pollinations:
 *   - dengan API key (sk_*): https://gen.pollinations.ai/image/<prompt> (Bearer)
 *   - tanpa key: legacy gratis https://image.pollinations.ai/prompt/<prompt>
 * Hasil langsung diarsip ke KV (URL permanen /img/<nama>), hasil task disimpan
 * di KV juga supaya polling /api/task bisa membaca status SUCCESS.
 */
async function pollinationsCreateJob(body, env, apiKey) {
  const params = body.params || body;
  // Pollinations menyesuaikan ukuran per model (maxSideLength) — jangan
  // di-clamp ketat, biarkan sisi panjang sampai 4096 (rasio bebas).
  let width = clampInt(params.width, 64, 4096, 1024);
  let height = clampInt(params.height, 64, 4096, 1024);
  // Tool Upscale 2x: minta gambar 2x ukuran (Pollinations tidak punya stage upscale terpisah).
  if (params.upscale === true) {
    width = clampInt(width * 2, 64, 4096, width);
    height = clampInt(height * 2, 64, 4096, height);
  }
  const seed = toSeed(params.seed);
  const model = String(params.model || '').trim();
  const prompt = String(params.prompt || '').slice(0, 1500);
  const url = new URL((apiKey ? GEN_POLLINATIONS : POLLINATIONS_IMG) + encodeURIComponent(prompt));
  url.searchParams.set('width', String(width));
  url.searchParams.set('height', String(height));
  if (model) url.searchParams.set('model', model);
  if (seed > 0) url.searchParams.set('seed', String(seed));
  if (apiKey) url.searchParams.set('nologo', 'true');
  // Pollinations mendukung negative_prompt & guidance_scale (sampler tidak didukung).
  const neg = String(params.negativePrompt || '').slice(0, 500);
  if (neg) url.searchParams.set('negative_prompt', neg);
  const gs = clampFloat(params.cfgScale, 0, 10, 0);
  if (gs > 0) url.searchParams.set('guidance_scale', String(gs));

  const res = await fetchWithTimeout(url.toString(), apiKey ? { headers: { Authorization: 'Bearer ' + apiKey } } : {}, 120000);
  if (!res.ok) {
    const txt = (await res.text()).slice(0, 300);
    if (res.status === 402) {
      throw new Error('Model ini berbayar — saldo pollen 0. Top up di enter.pollinations.ai atau pilih model gratis (zimage, flux, dreamshaper, klein).');
    }
    throw new Error('Pollinations gagal (HTTP ' + res.status + '): ' + txt);
  }
  const buf = await res.arrayBuffer();
  const ct = String(res.headers.get('content-type') || 'image/jpeg').split(';')[0] || 'image/jpeg';

  // Arsip ke KV (permanen); kalau KV tidak aktif, pakai URL Pollinations langsung.
  const stored = await storeImageBuf(buf, ct, env);
  const img = stored || url.toString();

  const taskId = 'pollinations:' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2));
  if (env && env.IMAGES) {
    await env.IMAGES.put('task:' + taskId, JSON.stringify({ status: 'SUCCESS', progress: 100, images: [img] })).catch(() => {});
  }
  return { taskId, images: [img] };
}

/** Baca hasil task Pollinations dari KV. */
async function pollinationsGetTask(jobId, env) {
  if (!env || !env.IMAGES) {
    return { status: 'SUCCESS', progress: 100, images: [] };
  }
  const raw = await env.IMAGES.get('task:pollinations:' + jobId, { type: 'text' });
  if (!raw) return { status: 'FAILED', error: 'Task tidak ditemukan' };
  return safeJson(raw) || { status: 'FAILED', error: 'Data task rusak' };
}

/* ---------------------------- handlers ------------------------------ */

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    // ---- health ----
    if (method === 'GET' && url.pathname === '/api/health') {
      return json({
        ok: true,
        storage: env && env.IMAGES ? 'kv' : null,
        hasKeys: {
          tams: !!(env && env.TENSORART_API_KEY),
          replicate: !!(env && env.REPLICATE_API_TOKEN),
          fal: !!(env && env.FAL_API_KEY),
          pollinations: true, // gratis, tanpa key
          selfhost: true,     // pakai URL endpoint (bukan API key)
        },
        byop: !!(env && env.POLLINATIONS_APP_KEY), // OAuth BYOP siap
        tams: TAMS_BASE,
      });
    }

    // ---- OAuth BYOP: konfigurasi untuk membangun URL authorize (PKCE) ----
    if (method === 'GET' && url.pathname === '/api/oauth/config') {
      const host = url.host;
      const loopback = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
      const proto = loopback ? 'http' : 'https';
      return json({
        ok: true,
        clientId: (env && env.POLLINATIONS_APP_KEY) || '',
        authorizeBase: ENTER_AUTH + '/authorize',
        tokenEndpoint: ENTER_AUTH + '/api/oauth/token',
        redirectUri: proto + '://' + host + '/callback',
      });
    }

    // ---- OAuth BYOP: tukar kode otorisasi -> token user (sk_ scoped) ----
    // Token disimpan di KV (oauth:<session>); browser hanya pegang session id.
    if (method === 'POST' && url.pathname === '/api/oauth/token') {
      const body = safeJson(await request.text());
      if (!body || !body.code || !body.code_verifier) {
        return json({ error: 'Parameter code dan code_verifier wajib diisi' }, 400);
      }
      const clientId = (env && env.POLLINATIONS_APP_KEY) || '';
      if (!clientId) return json({ error: 'POLLINATIONS_APP_KEY belum diatur di backend' }, 500);
      const form = new URLSearchParams();
      form.set('grant_type', 'authorization_code');
      form.set('code', String(body.code));
      form.set('client_id', clientId);
      form.set('code_verifier', String(body.code_verifier));
      if (body.redirect_uri) form.set('redirect_uri', String(body.redirect_uri));
      const res = await fetchWithTimeout(ENTER_AUTH + '/api/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      }, 30000);
      const txt = await res.text();
      const d = safeJson(txt) || {};
      if (!res.ok || !d.access_token) {
        const reason = d.error_description || d.error || ('HTTP ' + res.status);
        return json({ error: 'OAuth gagal: ' + reason }, 502);
      }
      const session = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
      const expiresIn = Number(d.expires_in) || 604800;
      const rec = { token: d.access_token, scope: d.scope || '', expiresAt: Date.now() + expiresIn * 1000 };
      if (env && env.IMAGES) await env.IMAGES.put('oauth:' + session, JSON.stringify(rec)).catch(() => {});
      return json({ ok: true, session, expiresIn, scope: rec.scope });
    }

    // ---- OAuth BYOP: status sesi (terhubung? sisa saldo pollen?) ----
    if (method === 'GET' && url.pathname === '/api/oauth/status') {
      const sid = String(url.searchParams.get('session') || '');
      if (!sid || !env || !env.IMAGES) return json({ ok: true, connected: false });
      const raw = await env.IMAGES.get('oauth:' + sid, { type: 'text' }).catch(() => null);
      if (!raw) return json({ ok: true, connected: false });
      const rec = safeJson(raw);
      if (!rec || !rec.token || (rec.expiresAt && rec.expiresAt <= Date.now())) {
        return json({ ok: true, connected: false });
      }
      const expiresIn = Math.max(0, Math.round((rec.expiresAt - Date.now()) / 1000));
      let balance = null;
      try {
        const b = await fetchWithTimeout('https://gen.pollinations.ai/account/balance', {
          headers: { Authorization: 'Bearer ' + rec.token },
        }, 15000);
        if (b.ok) balance = safeJson(await b.text()) || null;
      } catch { /* balance opsional */ }
      return json({ ok: true, connected: true, expiresIn, balance });
    }

    // ---- OAuth BYOP: logout (hapus sesi dari KV) ----
    if (method === 'POST' && url.pathname === '/api/oauth/logout') {
      const body = safeJson(await request.text()) || {};
      const sid = String(body.session || '');
      if (sid && env && env.IMAGES) await env.IMAGES.delete('oauth:' + sid).catch(() => {});
      return json({ ok: true });
    }

    // ---- terjemahan prompt (semua bahasa -> Inggris, gratis via Google gtx) ----
    if (method === 'GET' && url.pathname === '/api/translate') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json({ error: 'Parameter q kosong' }, 400);
      const gtx = GTX_TRANSLATE + '?client=gtx&sl=auto&tl=en&dt=t&q=' + encodeURIComponent(q);
      const res = await fetchWithTimeout(gtx, {}, 20000);
      const txt = await res.text();
      if (!res.ok) return json({ error: 'Layanan terjemahan tidak tersedia' }, 502);
      try {
        // format gtx: [[["terjemahan","asli",...],...], "en", ...]
        const data = JSON.parse(txt);
        const segs = (data && Array.isArray(data[0])) ? data[0] : [];
        const text = segs.map(function (s) { return (s && s[0]) || ''; }).join('').trim();
        if (!text) return json({ error: 'Terjemahan kosong' }, 502);
        return json({ ok: true, text, detected: (data && data[2]) || '' });
      } catch (e) {
        return json({ error: 'Response terjemahan tidak valid' }, 502);
      }
    }

    // ---- refine/expand prompt (Pollinations text LLM, pakai key BYOP/session) ----
    if (method === 'POST' && url.pathname === '/api/refine') {
      const body = safeJson(await request.text());
      const prompt = String((body && body.prompt) || '').trim();
      if (!prompt) return json({ error: 'Prompt kosong' }, 400);
      const apiKey = await pickPollKey(env, request, body);
      if (!apiKey) return json({ error: 'Perlu login Pollinations (BYOP) atau API key untuk Refine' }, 400);
      // Deteksi input gaya tag WD14/booru ("1girl, solo, sweet smile, ...") —
      // perkuas tiap tag jadi prompt alami, persis mode tag-to-prompt Tensor.Art.
      function looksLikeTags(s) {
        const segs = s.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        if (segs.length < 3) return false;
        const short = segs.every(function (x) { return x.length <= 28; });
        const marker = /(^|,|\s)(1girl|1boy|1other|solo|masterpiece|best quality|highres|absurdres|depth of field|ultra-detailed|detailed eyes)(,|\s|$)/i.test(s);
        return short || marker;
      }
      const isTags = looksLikeTags(prompt);
      const framingRule = 'CRITICAL: preserve the original framing/composition of the user\'s prompt (close-up, headshot, upper body, half body, full body, full portrait, wide shot, etc.). Never change the framing, never add framing words that conflict with it (for example do NOT add "full body" to a close-up prompt, and do NOT add "close-up" to a full-body prompt).';
      const system = isTags
        ? 'You are an expert AI image prompt engineer specialized in booru/WD14 tag-to-prompt expansion. The user gives comma-separated image tags (WD14 tagger style, e.g. "1girl, solo, sweet smile, long hair, ..."). Expand each tag into detailed descriptive English phrases and weave them into ONE flowing natural-language prompt for an AI image generator. Requirements: keep EVERY original tag/concept exactly (subject, pose, expression, clothing, background, style); enrich each with concrete visual detail (lighting, camera angle, composition, texture, atmosphere); keep key quality tags (masterpiece, best quality, highres, absurdres, ultra-detailed) at the end; never remove, contradict, or invent a different subject. ' + framingRule + ' Answer ONLY with the expanded prompt in English, no explanations, no quotes.'
        : 'You are an expert AI image prompt engineer. Rewrite and improve the given prompt for an AI image generator: keep the core subject/style, add useful details (lighting, composition, quality tags), fix grammar. ' + framingRule + ' Answer ONLY with the improved prompt in English, no explanations, no quotes.';
      const payload = {
        model: 'openai',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        max_tokens: 320,
      };
      let res;
      try {
        res = await fetchWithTimeout(GEN_POLLINATIONS_CHAT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
          body: JSON.stringify(payload),
        }, 25000);
      } catch (e) {
        return json({ error: 'Server AI sedang lambat. Coba lagi beberapa detik lagi.' }, 504);
      }
      const j = safeJson(await res.text());
      if (!res.ok || !j) {
        const msg = (j && j.error && (j.error.message || j.error)) || 'Refine gagal (saldo pollen?)';
        return json({ error: String(msg) }, 502);
      }
      const text = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
      if (!text) return json({ error: 'Refine kosong' }, 502);
      return json({ ok: true, text });
    }

    // ---- VAIA Chat (Pollinations text LLM — gpt-5.6-luna via gen, BYOP/key) ----
    // Tanpa key: fallback anonim ke text.pollinations.ai (model openai, gratis).
    if (method === 'POST' && url.pathname === '/api/chat') {
      const body = safeJson(await request.text());
      const msgs = Array.isArray(body && body.messages) ? body.messages : [];
      if (!msgs.length) return json({ error: 'Pesan kosong' }, 400);
      // Model chat: default openai-fast (stabil). gpt-5.6-luna hanya bila
      // user pilih (butuh saldo pollen / key berizin). Model lain -> openai-fast.
      let model = String((body && body.model) || 'openai-fast').trim() || 'openai-fast';
      if (model !== 'openai-fast' && model !== 'gpt-5.6-luna') model = 'openai-fast';
      const wantStream = !!(body && body.stream);
      const chatMode = (body && body.mode === 'setia') ? 'setia' : 'kreatif';
      const MODE_PROMPT = chatMode === 'setia'
        ? '\n\nMODE VARIASI: SETIA (faithful). Saat user meminta prompt gambar, semua Prompt N harus VARIASI DEKAT: subjek, karakter, pose, pakaian, ekspresi, objek, adegan, lokasi, waktu, dan gaya utama TETAP IDENTIK dengan permintaan user dan satu sama lain. Prompt 2-3 hanya boleh mengubah detail kecil yang TIDAK mengubah identitas: sudut kamera, pencahayaan, palet warna, komposisi, atau kualitas rendering. JANGAN mengubah gaya artistik utama (jika user minta realistis, semua variasi realistis; jangan ubah ke anime/fantasy) dan JANGAN menambah elemen baru yang mengubah makna. Negative Prompt harus KONSISTEN untuk semua variasi (satu blok di baris terakhir).'
        : '\n\nMODE VARIASI: KREATIF (wild). Saat user meminta prompt gambar, Prompt 1 = prompt utama yang setia pada permintaan user, sedangkan Prompt 2-3 = VARIASI LIAR yang benar-benar berbeda: boleh mengubah gaya artistik (realistis vs anime vs fantasy vs cyberpunk), sudut/lighting/atmosfer yang berlawanan, atau menambah elemen dramatis/magis — selama subjek INTI (siapa/apa yang user minta) tetap jelas terlihat. Negative Prompt boleh menyesuaikan per gaya (tetap satu blok Negative Prompt di baris terakhir, isi umum yang aman untuk semua variasi).';
      const modeMsg = { role: 'system', content: MODE_PROMPT };
      const apiKey = await pickPollKey(env, request, body);
      const sidHeader = String((request && request.headers && request.headers.get('x-session')) || (body && body.session) || '').trim();
      const keyDariSesi = !!(sidHeader && apiKey && apiKey.indexOf('sk_') === 0);
      // Baca teks/kode panjang: ambil 60 pesan terakhir, sisakan maks ~90rb karakter
      // (buang pesan tertua dulu; pesan terbaru — biasanya berisi kode/teks user — selalu utuh).
      const CHAT_BUDGET = 90000;
      let chatMsgs = msgs.slice(-60).map(function (m) {
        const role = m && (m.role === 'system' || m.role === 'assistant') ? m.role : 'user';
        return { role: role, content: String((m && m.content) || '') };
      }).filter(function (m) { return m.content.length > 0; });
      let chatTotal = chatMsgs.reduce(function (s, m) { return s + m.content.length; }, 0);
      while (chatTotal > CHAT_BUDGET && chatMsgs.length > 1) {
        const removed = chatMsgs.shift();
        chatTotal -= removed.content.length;
      }
      if (!chatMsgs.length) return json({ error: 'Pesan kosong' }, 400);
      // Keamanan: buang system message dari client, lalu sisipkan guard rahasia di akhir
      // (system terakhir = prioritas tertinggi) supaya AI tidak pernah membocorkan
      // API key, app key, kredensial, kode worker, konfigurasi, atau detail teknis web.
      // Sistem Skill VAIA — daftar lengkap kemampuan asisten (aktif otomatis).
      const VAIA_SKILLS = [
        ['CORE AI', 'Advanced Reasoning, Problem Solving, Planning & Task Decomposition, Decision Support, Fact Checking, Critical Thinking'],
        ['WEB & RESEARCH', 'Web Researcher, Deep Researcher, Real-Time Information Search, Source Verification, Source Comparison, News Researcher, Documentation Researcher, Academic Researcher, GitHub Researcher, GitLab Researcher, Open-Source Project Finder, Repository Analyzer, Code Search & Reference Analysis, Citation & Source Manager'],
        ['PROMPT ENGINEERING', 'Image Prompt Engineer, Video Prompt Engineer, Audio Prompt Engineer, AI Art Prompt Engineer, Character Prompt Designer, Consistent Character Prompting, Style & Composition Prompting, Prompt Optimization, Negative Prompt Designer, Prompt Debugger'],
        ['IMAGE PROMPT · VISUAL STYLES', 'Anime, Manga, Manhwa, Cartoon, Western Cartoon, Chibi, Kawaii, Realistic, Photorealistic, Hyperrealistic, Cinematic, Surrealism, Abstract, Concept Art, Digital Art, AI Art, Fantasy Art, Sci-Fi Art, Dark Fantasy, Gothic, Horror, Cyberpunk, Steampunk, Solarpunk, Retro, Vintage, Vaporwave, Synthwave, Minimalist, Pop Art, Low Poly, Isometric, Pixel Art, 3D Render, Clay Art, Paper Art, Claymation, Diorama, Illustration, Editorial Illustration, Children\'s Illustration, Comic Art, Graphic Novel, Storybook Art'],
        ['IMAGE PROMPT · ANIME & ILLUSTRATION', 'Modern Anime, Classic Anime, 90s Anime, Shonen, Shojo, Seinen, Josei, Isekai, Mecha, Magical Girl, Anime Film Look, Manga Panel, Ink Illustration, Cel Shading, Soft Anime Rendering, Painterly Anime, Anime Background Art, Character Sheet, Key Visual, Poster Art'],
        ['IMAGE PROMPT · PHOTOGRAPHY', 'Portrait Photography, Fashion Photography, Street Photography, Studio Photography, Editorial Photography, Product Photography, Architecture Photography, Landscape Photography, Wildlife Photography, Documentary Photography, Sports Photography, Macro Photography, Film Photography, Instant Camera Look, Vintage Photography, Analog Photography'],
        ['IMAGE PROMPT · CAMERA & LENS', 'DSLR, Mirrorless, Film Camera, 35mm Film, Medium Format, Polaroid Style, Smartphone Camera Look, Wide Angle, Ultra Wide Angle, Telephoto, Macro Lens, Portrait Lens, Fisheye, Tilt-Shift, Shallow Depth of Field, Deep Depth of Field, Bokeh, Motion Blur, Long Exposure'],
        ['IMAGE PROMPT · CAMERA ANGLES', 'Eye Level, Low Angle, High Angle, Bird\'s Eye View, Worm\'s Eye View, Overhead, Dutch Angle, Front View, Side View, Three-Quarter View, Back View, POV, Over-the-Shoulder, Close-Up, Extreme Close-Up, Medium Shot, Full Body, Wide Shot'],
        ['IMAGE PROMPT · COMPOSITION', 'Rule of Thirds, Center Composition, Symmetrical Composition, Leading Lines, Framing, Negative Space, Foreground/Midground/Background, Depth, Layering, Diagonal Composition, Golden Ratio, Dynamic Composition, Minimal Composition, Cinematic Composition, Portrait Composition, Environmental Composition'],
        ['IMAGE PROMPT · LIGHTING', 'Natural Light, Golden Hour, Blue Hour, Soft Light, Hard Light, Diffused Light, Backlighting, Rim Light, Side Lighting, Top Lighting, Underlighting, Studio Lighting, Three-Point Lighting, Neon Lighting, Volumetric Lighting, God Rays, Dramatic Lighting, Moody Lighting, Ambient Lighting, Candlelight, Firelight, Moonlight'],
        ['IMAGE PROMPT · COLOR & GRADING', 'Warm Tones, Cool Tones, Monochrome, Duotone, Pastel, Muted Colors, Vibrant Colors, High Saturation, Low Saturation, Earth Tones, Neon Colors, Film Color Grade, Cinematic Color Grade, Vintage Color Grade, Black and White, Sepia, Teal and Orange, Color Harmony, Complementary Colors'],
        ['IMAGE PROMPT · MATERIALS & TEXTURES', 'Skin Texture, Hair Texture, Fabric, Denim, Leather, Metal, Glass, Wood, Stone, Marble, Plastic, Ceramic, Paper, Water, Smoke, Fire, Ice, Fur, Feathers, Holographic Material, Metallic Surface'],
        ['IMAGE PROMPT · ENVIRONMENT', 'City, Countryside, Forest, Mountain, Beach, Desert, Ocean, Space, Futuristic City, Cyberpunk City, Ancient Ruins, Castle, Temple, Laboratory, Classroom, Bedroom, Café, Street, Studio, Fantasy World, Alien Planet'],
        ['IMAGE PROMPT · CHARACTER DESIGN', 'Character Concept, Character Sheet, Full Body Character, Portrait, Facial Expression, Pose, Gesture, Hairstyle, Clothing, Accessories, Costume Design, Armor Design, Creature Design, Robot Design, Fantasy Character, Sci-Fi Character, Age-Appropriate Character Design, Character Consistency'],
        ['IMAGE PROMPT · POSES & EXPRESSIONS', 'Standing, Sitting, Walking, Running, Action Pose, Dynamic Pose, Relaxed Pose, Hero Pose, Crouching, Looking at Camera, Looking Away, Smiling, Serious, Surprised, Confused, Determined, Calm, Sad, Excited'],
        ['IMAGE PROMPT · CINEMATIC LANGUAGE', 'Movie Still, Film Still, Establishing Shot, Close-Up, Hero Shot, Dramatic Reveal, Atmospheric Shot, Cinematic Depth, Storytelling Frame, Visual Narrative, Epic Scale, Intimate Scene, Suspenseful Atmosphere'],
        ['IMAGE PROMPT · ERA & CULTURAL', 'Ancient, Medieval, Renaissance, Victorian, Edwardian, 1920s, 1940s, 1950s, 1960s, 1970s, 1980s, 1990s, Y2K, Retro Futurism, Contemporary, Near Future'],
        ['IMAGE PROMPT · ART TECHNIQUES', 'Watercolor, Oil Painting, Acrylic, Gouache, Pencil Sketch, Charcoal, Ink, Colored Pencil, Pastel, Digital Painting, Matte Painting, Line Art, Cross Hatching, Impasto, Brush Painting, Airbrush, Collage, Mixed Media'],
        ['IMAGE PROMPT · 3D & CGI', '3D Character, 3D Environment, CGI, Blender-Style Render, Game Asset, Game Character, Game Environment, Unreal Engine Look, Architectural Visualization, Product Visualization, Octane-Style Render, Stylized 3D, Realistic 3D, Isometric 3D'],
        ['IMAGE PROMPT · QUALITY & DETAIL', 'High Detail, Fine Details, Sharp Focus, Clean Linework, Detailed Background, Realistic Materials, Natural Skin Detail, Accurate Lighting, Depth and Dimension, Atmospheric Perspective, High-Fidelity Rendering'],
        ['IMAGE PROMPT · GENERATION CONTROL', 'Positive Prompt, Negative Prompt, Prompt Weighting, Composition Control, Style Strength, Detail Control, Aspect Ratio, Seed Consistency, Character Consistency, Reference Image Guidance, Pose Guidance, Structure Guidance, Image-to-Image Prompting, Inpainting, Outpainting, Upscaling, Variation Generation'],
        ['IMAGE PROMPT · CONSISTENCY ENGINE', 'Same Character, Same Face, Same Hairstyle, Same Outfit, Same Color Palette, Same Art Style, Same Environment, Same Lighting, Same Camera Language, Multi-Image Character Consistency, Scene-to-Scene Consistency, Character Turnaround, Expression Sheet, Pose Sheet'],
        ['IMAGE PROMPT · STRUCTURE', 'Subject, Character/Object Details, Action/Pose, Environment, Composition, Camera, Lens, Lighting, Color Palette, Material/Texture, Art Style, Mood/Atmosphere, Quality/Detail, Technical Parameters, Negative Prompt'],
        ['IMAGE PROMPT · OPTIMIZATION', 'Convert Simple Idea to Detailed Prompt, Improve Weak Prompts, Remove Conflicting Instructions, Prioritize Visual Elements, Adapt to Different Generators, Short/Medium/Detailed Versions, Positive & Negative Prompt, Preserve Core Concept, Detect Ambiguous Descriptions, Resolve Conflicting Styles, Optimize Composition, Optimize Lighting, Optimize Character Consistency'],
        ['IMAGE PROMPT · GENERATOR ADAPTATION', 'Adapt to Generator Conventions, Avoid Universal Syntax, Tailor to Model Strengths, Preserve Core Concept'],
        ['IMAGE PROMPT · VISUAL ANALYSIS', 'Analyze Subject, Analyze Style, Analyze Composition, Analyze Camera Angle, Analyze Lens Impression, Analyze Lighting, Analyze Color Palette, Analyze Materials, Analyze Environment, Analyze Mood, Analyze Clothing, Analyze Pose, Analyze Background, Analyze Rendering Technique, Reconstruct Descriptive Prompt'],
        ['IMAGE PROMPT · CREATIVE MODE', 'Expand Short Idea, Detail Subject, Detail Appearance, Detail Outfit, Detail Pose, Detail Environment, Detail Weather, Detail Lighting, Detail Camera, Detail Composition, Detail Color Palette, Detail Atmosphere, Detail Art Style, Detail Level'],
        ['IMAGE PROMPT · SAFETY & QUALITY', 'Avoid Unnecessary Real-Person Impersonation, Avoid Unsafe or Prohibited Visual Content, Preserve Intended Concept, Keep Prompt Clear and Usable'],
        ['PROGRAMMING', 'Programming Expert, Python, JavaScript, TypeScript, HTML/CSS, SQL, API Development, REST API, JSON, Database Design, Debugging, Code Review, Refactoring, Automation, Software Architecture, Repository Analysis'],
        ['PROGRAMMING LANGUAGES', 'C, C++, C#, Objective-C, Go (Golang), Rust, Zig, Nim, D, Swift, Kotlin, Java, Scala, Groovy, Clojure, Python, Ruby, Perl, PHP, JavaScript, TypeScript, Dart, Lua, R, MATLAB, Julia, SQL, PL/SQL, T-SQL, Haskell, Erlang, Elixir, OCaml, F#, Lisp, Scheme, Racket, Prolog, Ada, Pascal, Delphi, Fortran, COBOL, Assembly, Bash/Shell, PowerShell, Batch, VBA, Visual Basic .NET, Solidity, Vyper, WebAssembly, Verilog, VHDL, SystemVerilog, Smalltalk'],
        ['WEB & APP FRAMEWORKS', 'React, Vue, Angular, Svelte, SolidJS, Next.js, Nuxt, Remix, Gatsby, Astro, Node.js, Express, NestJS, Fastify, Koa, Hono, Django, Flask, FastAPI, Laravel, Symfony, CodeIgniter, Lumen, Spring Boot, Spring MVC, Jakarta EE, Quarkus, Micronaut, ASP.NET Core, .NET MAUI, Blazor, WPF, Ruby on Rails, Sinatra, Gin, Echo, Fiber, Axum, Actix-web, Rocket, Phoenix, Flutter, React Native, Ionic, Expo, NativeScript, Bootstrap, Tailwind CSS, Material UI, Chakra UI, shadcn/ui, jQuery, D3.js, Chart.js, Three.js, GSAP, Redux, Zustand, TanStack Query, Prisma, TypeORM, Sequelize, Mongoose, SQLAlchemy, Hibernate, Entity Framework Core, GORM, Jest, Vitest, Cypress, Playwright, pytest, JUnit, PHPUnit, RSpec, WordPress, Drupal, Magento, Shopify, GraphQL, Apollo, Relay, Webpack, Vite, Rollup, esbuild, Babel, Pandas, NumPy, TensorFlow, PyTorch, scikit-learn, LangChain, Unity, Unreal Engine, Godot'],
        ['CYBERSECURITY', 'Defensive Security, Secure Coding, Vulnerability Analysis, Security Best Practices, Privacy & Data Protection, Authentication & Authorization'],
        ['MOBILE DEVELOPMENT', 'Android Development, Kotlin, Java, Jetpack Compose, Android SDK & Gradle, Flutter, React Native, Mobile App Architecture, Mobile UI Design, Cross-Platform Development, iOS Development'],
        ['CREATIVE', 'Creative Director, Storytelling, Character Design, Worldbuilding, Concept Development, Branding, Copywriting, Image Analysis, Visual Direction, Video Concept Development, UI/UX Design'],
        ['WRITING', 'Article Writing, Technical Writing, Documentation, Report Writing, Proposal Writing, SOP Creation, Email Writing, Social Media Content, Story Writing, Script Writing'],
        ['EDUCATION', 'AI Tutor, Mathematics, Science, Programming Tutor, Language Tutor, Study Planner, Concept Explainer, Quiz Generator, Step-by-Step Learning'],
        ['DATA', 'Data Analysis, Data Cleaning, Statistics, Data Visualization, Spreadsheet Analysis, Pattern Detection, Report Generation'],
        ['BUSINESS', 'Business Strategy, Product Strategy, Product Design, Market Research, Marketing Strategy, SEO, Content Strategy, Competitor Analysis, Business Idea Analysis, Project Management'],
        ['TOOLS & AUTOMATION', 'Workflow Automation, API Integration, File Analysis, Document Processing, Spreadsheet Processing, Code Execution, Git/GitHub Workflow, Task Automation'],
        ['QUALITY CONTROL', 'Hallucination Detection, Fact Verification, Code Validation, Prompt Testing, Output Critique, Consistency Checking, Error Detection, Self-Review'],
        ['MULTIMODAL', 'Image Understanding, Image Analysis, Image Prompt Generation, Screenshot Analysis, Document Understanding, PDF Analysis, Chart & Diagram Understanding']
      ];
      const SKILLS_PROMPT = 'Kamu memiliki sistem skill berikut. AKTIFKAN SECARA OTOMATIS skill yang relevan dengan kebutuhan user (tanpa diminta) dan kerjakan dengan sungguh-sungguh serta detail:\n'
        + VAIA_SKILLS.map(function (g) { return '— ' + g[0] + ': ' + g[1]; }).join('\n')
        + '\n\nPanduan teks/kode panjang (seperti Claude): saat menerima kode, file, atau teks panjang, BACA SELURUHNYA dengan teliti tanpa memotong; berikan analisis mendalam; tampilkan kode utuh bila diminta; jangan meringkas kode kecuali diminta.'
        + '\n\nAturan Web Researcher (skill riset web): jika pertanyaan user membutuhkan informasi AKTUAL/TERBARU dari internet (berita, harga terkini, peristiwa terbaru, riset terbaru, data terkini, skor pertandingan, dll), JAWAB dengan mengeluarkan PERSIS satu baris di awal jawaban, tanpa teks lain apa pun: [WEB_SEARCH: query singkat dalam bahasa Inggris] lalu BERHENTI — sistem akan mencari di web dan melanjutkan jawabanmu. Jika tidak butuh pencarian web, jawab langsung seperti biasa tanpa baris itu.'
        + '\n\nKamu menguasai SEMUA bahasa pemrograman, framework, dan pustaka yang terdaftar di atas (kategori PROGRAMMING LANGUAGES, WEB & APP FRAMEWORKS, MOBILE DEVELOPMENT) — termasuk sintaks, versi terbaru, cara setup, struktur proyek, pola terbaik, dan kode idiomatik. Saat diminta kode dalam bahasa/framework apa pun, berikan kode yang benar, lengkap, dan idiomatik.'
        + '\n\nAturan Ahli Prompt Gambar (Image Prompt Engineer / AI Art Prompt Engineer): saat diminta membuat atau memperbaiki prompt gambar, WAJIB MEMPERTAHANKAN 100% permintaan user: (1) JANGAN mengubah subjek, orang/karakter, pose, pakaian, ekspresi, objek, adegan, lokasi, waktu, gaya, atau framing yang user minta — pertahankan persis apa adanya. (2) Jika user menyebut ukuran/aspek rasio (mis. 832x1536, portrait, landscape, 1:1), sesuaikan deskripsi framing dengan itu tanpa mengubah isi. (3) Perkaya hanya dengan detail yang TIDAK bertentangan: kualitas (masterpiece, best quality, ultra detailed, 8k), pencahayaan, sudut kamera, warna, tekstur, dan gaya artistik bila relevan. (4) JANGAN menambah elemen yang mengubah makna (mis. user minta "wanita di taman bunga" — jangan menambahkan pria, jangan pindahkan ke pantai). (5) Hasilkan prompt final dalam bahasa Inggris (kecuali diminta bahasa lain), bersih, tanpa tanda kutip berlebih, siap tempel ke generator gambar. (6) Boleh tawarkan 2-3 variasi kecil gaya, tetapi subjek utama tetap identik dengan permintaan user. (7) JADILAH KREATIF DAN BERANI: prompt final yang setia pada permintaan user itu hanyalah dasar — perkaya dengan imajinasi seluas-luasnya selama TIDAK mengubah subjek inti (siapa/apa yang user minta tetap persis): kombinasikan gaya, mood, pencahayaan dramatis, sudut kamera sinematik, palet warna yang berani, detail material yang kaya, dan sentuhan artistik yang mengejutkan. Setelah prompt utama, tawarkan juga 2-3 VARIASI KREATIF yang benar-benar berbeda (mis. versi realistis vs anime vs fantasy, atau sudut/lighting/atmosfer yang berlawanan) sebagai opsi pilihan. (8) Jika user meminta "kreatif", "imajinatif", "beda", atau "wow", bebas berimajinasi liar (elemen magis, sinematik, dramatis, konsep tak terduga) — tetapi tetap jangan menghilangkan identitas permintaan awal user: semua variasi harus jelas masih tentang subjek yang user minta, hanya dibingkai lebih kreatif. (9) FORMAT OUTPUT WAJIB: keluarkan prompt-prompt sebagai DAFTAR BERNOMOR yang bersih dan TERPISAH — tulis baris \"Prompt 1: <isi prompt lengkap>\", lalu baris \"Prompt 2: <isi prompt lengkap>\", \"Prompt 3: <isi prompt lengkap>\", dst. (jumlah sesuai permintaan user; default 3 prompt: Prompt 1 = prompt utama yang setia pada permintaan, Prompt 2-3 = variasi kreatif yang benar-benar berbeda). SETIAP prompt di paragraf/barisnya sendiri, terpisah jelas satu sama lain. JANGAN tulis teks pengantar seperti \"Berikut prompt...\" atau \"siap digunakan\"; JANGAN pakai header markdown (###, **); JANGAN sertakan blok \"Parameter Opsional\" atau penjelasan tambahan apa pun — keluarkan HANYA baris-baris \"Prompt N:\" yang berisi prompt lengkap siap tempel ke generator gambar. (10) NEGATIVE PROMPT WAJIB & JELAS: setiap membuat prompt gambar, SELALU sertakan Negative Prompt dengan label persis \"Negative Prompt:\" yang DITULIS DI AWAL BARIS SENDIRI di baris/paragraf TERAKHIR setelah semua Prompt N (satu blok negative untuk semua variasi). Isi negative prompt = hal yang HARUS DIHINDARI generator (mis. blurry, low quality, extra fingers, bad anatomy, deformed hands, watermark, text, logo). NEGATIVE PROMPT TIDAK BOLEH pernah tercampur ke dalam isi Prompt N mana pun, dan TIDAK BOLEH memakai header markdown — tulis persis: \"Negative Prompt: <isi negative, dipisah koma>\" supaya aplikasi otomatis menaruhnya ke kolom Negative di generator.'
        + '\n\nIMAGE PROMPT ENGINEER — terapkan semua 25 kategori skill gambar di atas saat user minta membuat/memperbaiki/menganalisis prompt gambar: (A) susun prompt final berurutan: [Subject] + [Character/Object Details] + [Action/Pose] + [Environment] + [Composition] + [Camera] + [Lens] + [Lighting] + [Color Palette] + [Material/Texture] + [Art Style] + [Mood/Atmosphere] + [Quality/Detail] + [Technical Parameters] + [Negative Prompt]. (B) pilih elemen dari kategori relevan di atas (visual styles, anime/ilustrasi, fotografi, kamera & lensa, sudut kamera, komposisi, lighting, warna, material, lingkungan, karakter, pose, sinematik, era, teknik seni, 3D/CGI, kualitas). (C) CREATIVE MODE: ide singkat (mis. "gadis di kota cyberpunk saat hujan") -> kembangkan lengkap (subject, penampilan, outfit, pose, environment, cuaca, lighting, camera, komposisi, palet, atmosfer, gaya, detail) TANPA mengubah ide inti. (D) optimasi: perbaiki prompt lemah, buang instruksi konflik, prioritaskan elemen penting, buat versi pendek/sedang/detail, deteksi deskripsi ambigu. (E) sesuaikan konvensi prompt dengan generator tujuan (Stable Diffusion/Flux/Midjourney/ComfyUI/API), jangan paksa satu sintaks universal. (F) VISUAL ANALYSIS: jika diberi gambar, analisis subjek, gaya, komposisi, sudut, lensa, lighting, palet, material, lingkungan, mood, pakaian, pose, latar, teknik render -> rekonstruksi prompt deskriptif berguna. (G) jaga keamanan: hindari impersonasi orang nyata yang tidak perlu, hindari konten visual terlarang, pertahankan konsep user, jaga prompt jelas dan bisa dipakai.';
      const SECRET_GUARD = 'Kamu adalah VAIA Rekty, asisten AI dari aplikasi web Visual AI Artwork. Aturan wajib: (1) JANGAN PERNAH menyebut, mengungkap, membocorkan, atau mengisyaratkan rahasia internal aplikasi ini: API key, app key, bearer token, kredensial, kata sandi, kode Cloudflare Worker, konfigurasi server, endpoint backend, variabel lingkungan, source code web ini, atau detail implementasi apa pun. (2) Jika ditanya tentang rahasia atau source code tersebut, tolak dengan sopan dan arahkan kembali ke bantuan umum. (3) NAMAMU ADALAH Vaia Rekty — JANGAN PERNAH mengaku atau menyebut dirimu sebagai ChatGPT, Claude, Gemini, atau chatbot/AI buatan perusahaan lain apa pun; jika ditanya, jawab bahwa kamu adalah Vaia Rekty dari Visual AI Artwork. (4) Bantulah pengguna dengan ramah, dalam bahasa Indonesia kecuali diminta lain.';
      const baseMsgs = chatMsgs.filter(function (m) { return m.role !== 'system'; });
      const safeMsgs = baseMsgs.slice();
      safeMsgs.push({ role: 'system', content: SKILLS_PROMPT });
      safeMsgs.push(modeMsg);
      safeMsgs.push({ role: 'system', content: SECRET_GUARD });
      // Dengan key: gen.pollinations.ai (akses gpt-5.6-luna). Tanpa key: legacy anonim (openai).
      const payload = { model: apiKey ? model : 'openai', messages: safeMsgs, private: true };
      if (wantStream) payload.stream = true;
      const opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      };
      if (apiKey) opts.headers.Authorization = 'Bearer ' + apiKey;
      let usedModel = apiKey ? model : 'openai';
      let res;
      try {
        // Batas 25 dtk — Cloudflare Worker maksimal 30 dtk per permintaan; kalau
        // upstream lebih lambat, balas pesan ramah (bukan error 522 mentah).
        res = await fetchWithTimeout(apiKey ? GEN_POLLINATIONS_CHAT : 'https://text.pollinations.ai/openai', opts, 25000);
      } catch (e) {
        return json({ error: 'Server AI (Pollinations) sedang lambat atau tidak terjangkau. Coba lagi beberapa detik lagi — jika terus gagal, muat ulang halaman.' }, 504);
      }
      // Key ditolak gen (401/402/403). Coba key cadangan secara berurutan:
      //   1) key sesi BYOP user (sk_) — pakai saldo pollen akun user
      //   2) App Key worker (env POLLINATIONS_API_KEY) — jaminan chat tetap jalan
      //   3) anonim legacy text.pollinations.ai (timeout singkat)
      // Gagal semua -> pesan ramah sesuai penyebab (bukan 522 mentah).
      if (!res.ok && (res.status === 401 || res.status === 402 || res.status === 403)) {
        const envKey = (env && env.POLLINATIONS_API_KEY) ? String(env.POLLINATIONS_API_KEY) : '';
        const coba = [];
        if (keyDariSesi && apiKey) coba.push(apiKey);
        if (envKey && envKey !== apiKey) coba.push(envKey);
        if (!keyDariSesi && apiKey && !envKey) coba.push(apiKey);
        for (let k of coba) {
          const fb = { model: model, messages: safeMsgs, private: true };
          if (wantStream) fb.stream = true;
          const fo = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fb) };
          fo.headers.Authorization = 'Bearer ' + k;
          let fres = null;
          try { fres = await fetchWithTimeout(GEN_POLLINATIONS_CHAT, fo, 25000); } catch (e) { fres = null; }
          if (fres && fres.ok) { res = fres; usedModel = model; break; }
        }
        if (!res.ok && !keyDariSesi) {
          // App Key juga gagal / tidak ada -> coba anonim sekali (timeout singkat)
          const fb = { model: 'openai', messages: safeMsgs, private: true };
          if (wantStream) fb.stream = true;
          let fres = null;
          try {
            fres = await fetchWithTimeout('https://text.pollinations.ai/openai', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(fb),
            }, 12000);
          } catch (e) { fres = null; }
          if (fres && fres.ok) { res = fres; usedModel = 'openai'; }
        }
        if (!res.ok) {
          const j = safeJson(await res.text());
          let msg = String((j && j.error && (j.error.message || j.error)) || ('Chat gagal (HTTP ' + res.status + ')')).trim();
          if (keyDariSesi) {
            if (res.status === 402) msg += ' — saldo pollen akunmu habis. Kumpulkan pollen lewat quest di enter.pollinations.ai atau top up.';
            else if (res.status === 403) msg += ' — akunmu tidak diizinkan memakai model ini (cek paket di enter.pollinations.ai).';
            else if (res.status === 401) msg += ' — sesi login Pollinations kadaluarsa. Login ulang lewat tombol BYOP.';
          } else {
            msg = 'Chat butuh login Pollinations (BYOP) — klik tombol \u201cLogin dengan Pollinations\u201d di Pengaturan API, atau pastikan App Key di worker valid. Detail: ' + msg;
          }
          return json({ error: msg }, 502);
        }
      }
      if (!res.ok) {
        const j = safeJson(await res.text());
        let msg = String((j && j.error && (j.error.message || j.error)) || ('Chat gagal (HTTP ' + res.status + ')')).trim();
        if (res.status === 401) msg += ' — perlu login Pollinations (BYOP) atau API key di Pengaturan.';
        else if (res.status === 402) msg += ' — saldo pollen tidak cukup. Kumpulkan pollen lewat quest di enter.pollinations.ai.';
        else if (res.status === 403) msg += ' — model tidak diizinkan untuk key ini (cek saldo/paket di enter.pollinations.ai).';
        else if (res.status >= 500 || /522|524|529|timed? ?out|overload|tidak tersedia/i.test(msg)) {
          msg = 'Server AI (Pollinations) sedang sibuk — coba lagi beberapa detik lagi.';
        }
        return json({ error: msg }, 502);
      }
      if (wantStream) {
        // --- Web Researcher: tangkap marker [WEB_SEARCH: ...] di awal stream ---
        const reader0 = res.body && res.body.getReader ? res.body.getReader() : null;
        if (!reader0) {
          return new Response(res.body, { headers: SSE_H });
        }
        const dec0 = new TextDecoder();
        // Deteksi marker berdasarkan KONTEN delta (bukan byte mentah — overhead SSE besar)
        let rawAcc = '', contentAcc = '', marker = null;
        try {
          while (contentAcc.length < 300) {
            const r = await reader0.read();
            if (r.done) break;
            rawAcc += dec0.decode(r.value, { stream: true });
            try {
              const lines = rawAcc.split('\n');
              for (let i = 0; i < lines.length - 1; i++) {
                const line = lines[i].trim();
                if (line.indexOf('data:') !== 0) continue;
                const payload = line.slice(5).trim();
                if (payload === '[DONE]') continue;
                const ev = JSON.parse(payload);
                const c = ev && ev.choices && ev.choices[0] && ev.choices[0].delta && ev.choices[0].delta.content;
                if (c) contentAcc += c;
              }
            } catch (e) {}
            const m = contentAcc.match(/\[WEB_SEARCH:\s*"?([^\]]+?)"?\]/i);
            if (m) { marker = m[1].trim().replace(/^"+|"$/g, ''); break; }
          }
        } catch (e) { marker = null; }
        if (!marker) {
          // Bukan permintaan riset: teruskan teks yang sudah terbaca + sisa stream
          const stream = new ReadableStream({
            start(controller) {
              if (rawAcc) controller.enqueue(new TextEncoder().encode(rawAcc));
              function pump() {
                return reader0.read().then(function (rr) {
                  if (rr.done) { controller.close(); return; }
                  controller.enqueue(rr.value);
                  return pump();
                });
              }
              return pump();
            },
            cancel() { try { reader0.cancel(); } catch (e) {} },
          });
          return new Response(stream, { headers: SSE_H });
        }
        // Marker ketemu -> riset web lalu jawaban final (stream fase 2)
        try { await reader0.cancel(); } catch (e) {}
        const results = await webSearch(marker);
        const researchTxt = researchTxtFor(marker, results);
        const p2 = baseMsgs.concat([
          { role: 'system', content: researchTxt },
          { role: 'system', content: SKILLS_PROMPT },
          { role: 'system', content: MODE_PROMPT },
          { role: 'system', content: SECRET_GUARD },
        ]);
        const payload2 = { model: apiKey ? model : 'openai', messages: p2, private: true, stream: true };
        const opts2 = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload2) };
        if (apiKey) opts2.headers.Authorization = 'Bearer ' + apiKey;
        let res2;
        try {
          res2 = await fetchWithTimeout(apiKey ? GEN_POLLINATIONS_CHAT : 'https://text.pollinations.ai/openai', opts2, 25000);
        } catch (e) {
          return json({ error: 'Riset web selesai, tapi server AI tidak merespons tepat waktu. Coba lagi.' }, 504);
        }
        if (!res2.ok) return json({ error: 'Riset web selesai, tapi jawaban gagal dibuat (HTTP ' + res2.status + ').' }, 502);
        return new Response(sseClean(res2.body), { headers: SSE_H });
      }
      const j = safeJson(await res.text());
      let text = String((j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
      if (!text) return json({ error: 'Respons kosong' }, 502);
      const mm = text.match(/\[WEB_SEARCH:\s*"?([^\]]+?)"?\]/i);
      if (mm) {
        const results = await webSearch(mm[1].trim());
        const researchTxt = researchTxtFor(mm[1].trim(), results);
        const p2 = baseMsgs.concat([
          { role: 'system', content: researchTxt },
          { role: 'system', content: SKILLS_PROMPT },
          { role: 'system', content: MODE_PROMPT },
          { role: 'system', content: SECRET_GUARD },
        ]);
        let res2 = null;
        try {
          res2 = await fetchWithTimeout(apiKey ? GEN_POLLINATIONS_CHAT : 'https://text.pollinations.ai/openai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}) },
            body: JSON.stringify({ model: apiKey ? model : 'openai', messages: p2, private: true }),
          }, 25000);
        } catch (e) { res2 = null; }
        if (res2 && res2.ok) {
          const j2 = safeJson(await res2.text());
          const t2 = stripMarkers(String((j2 && j2.choices && j2.choices[0] && j2.choices[0].message && j2.choices[0].message.content) || ''));
          if (t2) return json({ ok: true, text: t2, model: usedModel, researched: mm[1].trim() });
        }
      }
      return json({ ok: true, text: stripMarkers(text), model: usedModel });
    }

    // ---- daftar model Pollinations (publik, tanpa auth) ----
    if (method === 'GET' && url.pathname === '/api/pollinations-models') {
      const res = await fetchWithTimeout(GEN_POLLINATIONS + 'models', {}, 30000);
      const txt = await res.text();
      if (!res.ok) return json({ error: 'Gagal ambil daftar model Pollinations' }, 502);
      const list = safeJson(txt);
      if (!Array.isArray(list)) return json({ error: 'Response daftar model tidak valid' }, 502);
      return json({ ok: true, models: list });
    }

    // ---- buat job generate ----
    if (method === 'POST' && url.pathname === '/api/generate') {
      if ((request.headers.get('content-length') || 0) > MAX_BODY) {
        return json({ error: 'Payload terlalu besar' }, 413);
      }
      const body = safeJson(await request.text());
      if (!body) return json({ error: 'JSON tidak valid' }, 400);

      const provider = String(body.provider || 'tams').toLowerCase();
      if (!PROVIDERS.includes(provider)) {
        return json({ error: 'Provider tidak dikenal: ' + provider }, 400);
      }
      const apiKey = provider === 'pollinations'
        ? await pickPollKey(env, request, body)
        : pickApiKey(env, request, body, provider);
      // Pollinations & self-host gratis tanpa API key — provider lain wajib key.
      if (!apiKey && provider !== 'pollinations' && provider !== 'selfhost') {
        return json({
          error: 'API key ' + provider + ' belum diatur. Isi di Pengaturan -> API Key, atau set env ' + (PROVIDER_ENV[provider] || 'TENSORART_API_KEY') + ' saat deploy.',
        }, 401);
      }

      let r;
      if (provider === 'replicate') r = await replicateCreateJob(body, apiKey);
      else if (provider === 'fal') r = await falCreateJob(body, apiKey);
      else if (provider === 'pollinations') {
        // Sinkron langsung: generate sekarang, balas hasil (tidak lewat antrian).
        r = await pollinationsCreateJob(body, env, apiKey);
      }
      else if (provider === 'selfhost') r = await selfhostCreateJob(body, env);
      else r = await tamsCreateJob(body, apiKey);
      return json({ ok: true, provider, ...r });
    }

    // ---- cek status job ----
    if (method === 'GET' && url.pathname === '/api/task') {
      const rawId = url.searchParams.get('id') || '';
      if (!rawId) return json({ error: 'Parameter id wajib diisi' }, 400);

      // Task id menyandikan provider: 'replicate:<id>', 'fal:<model>:<id>',
      // 'pollinations:<id>', atau id TAMS polos.
      let provider = 'tams';
      let jobId = rawId;
      let falModel = FAL_MODEL;
      if (rawId.startsWith('replicate:')) { provider = 'replicate'; jobId = rawId.slice(11); }
      else if (rawId.startsWith('selfhost:')) { provider = 'selfhost'; jobId = rawId.slice(9); }
      else if (rawId.startsWith('pollinations:')) { provider = 'pollinations'; jobId = rawId.slice(13); }
      else if (rawId.startsWith('fal:')) {
        provider = 'fal';
        const rest = rawId.slice(4);
        const lastColon = rest.lastIndexOf(':');
        if (lastColon > 0) { falModel = rest.slice(0, lastColon); jobId = rest.slice(lastColon + 1); }
        else jobId = rest;
      }

      const apiKey = provider === 'pollinations'
        ? await pickPollKey(env, request, {})
        : pickApiKey(env, request, {}, provider);
      if (!apiKey && provider !== 'pollinations' && provider !== 'selfhost') {
        return json({ error: 'API key ' + provider + ' belum diatur' }, 401);
      }

      let r;
      if (provider === 'replicate') r = await replicateGetJob(jobId, apiKey);
      else if (provider === 'fal') r = await falGetJob(jobId, apiKey, falModel);
      else if (provider === 'pollinations') r = await pollinationsGetTask(jobId, env);
      else if (provider === 'selfhost') r = await selfhostGetTask(jobId, env);
      else r = await tamsGetJob(jobId, apiKey);

      // Arsipkan gambar hasil ke R2 supaya URL-nya permanen (tidak kedaluwarsa).
      if (Array.isArray(r.images) && r.images.length) {
        r.images = await archiveImages(r.images, env);
      }
      return json({ ok: true, provider, ...r });
    }

    // ---- arsip gambar base64 (hasil generate langsung provider selfhost) ----
    if (method === 'POST' && url.pathname === '/api/archive') {
      if ((request.headers.get('content-length') || 0) > MAX_BODY) {
        return json({ error: 'Payload terlalu besar' }, 413);
      }
      const body = safeJson(await request.text());
      if (!body) return json({ error: 'JSON tidak valid' }, 400);
      const items = Array.isArray(body.images) ? body.images : [];
      if (!items.length) return json({ error: 'Field images wajib diisi (array base64)' }, 400);
      const out = [];
      for (const it of items) {
        const b64 = String((it && (it.b64 || it.b64_json)) || '').trim();
        if (!b64) { out.push(null); continue; }
        try {
          const buf = b64ToBuf(b64);
          out.push((await storeImageBuf(buf, sniffImageCt(buf), env)) || null);
        } catch { out.push(null); }
      }
      return json({ ok: true, images: out });
    }

    // ---- panel admin KV: daftar + hapus gambar arsip ----
    // PIN dari env ADMIN_PIN (fallback default lokal). Endpoint dilindungi PIN
    // supaya sembarang orang tidak bisa membuka daftar gambar user.
    const ADMIN_PIN = (env && env.ADMIN_PIN) || 'vaia-admin-2026';
    function pinOk(req) {
      const h = req.headers.get('x-admin-pin') || '';
      const q = new URL(req.url).searchParams.get('pin') || '';
      return h === ADMIN_PIN || q === ADMIN_PIN;
    }
    if (method === 'GET' && url.pathname === '/api/admin') {
      if (!pinOk(request)) return json({ error: 'PIN salah atau tidak disertakan' }, 403);
      if (!env || !env.IMAGES) return json({ error: 'Penyimpanan gambar belum diaktifkan' }, 404);
      // Key arsip gambar = nama file dengan ekstensi gambar (UUID.jpg/png/webp/...),
      // tanpa prefix. Key task:/oauth: adalah status internal, bukan gambar.
      const IMG_EXT = /^[a-zA-Z0-9-]+\.(png|jpe?g|webp|gif|avif|svg)$/;
      let keys = [];
      let cursor;
      do {
        const page = await env.IMAGES.list({ cursor, limit: 1000 });
        keys = keys.concat(page.keys || []);
        cursor = page.cursor;
      } while (cursor);
      const images = keys
        .filter(function (k) { return IMG_EXT.test(k.name); })
        .map(function (k) {
          return {
            name: k.name,
            size: (k.metadata && k.metadata.size) || 0,
            url: '/img/' + k.name,
          };
        });
      return json({ ok: true, pin: true, images, totalKeys: keys.length, imageCount: images.length });
    }
    if (method === 'POST' && url.pathname === '/api/admin/delete') {
      if (!pinOk(request)) return json({ error: 'PIN salah atau tidak disertakan' }, 403);
      if (!env || !env.IMAGES) return json({ error: 'Penyimpanan gambar belum diaktifkan' }, 404);
      let body = {};
      try { body = await request.json(); } catch (e) {}
      const name = String(body.name || '').trim();
      if (!name) return json({ error: 'Nama key wajib diisi' }, 400);
      // Amankan: hanya boleh hapus nama file gambar (UUID.ext), bukan task:/oauth:
      const allowed = /^[a-zA-Z0-9-]+\.(png|jpe?g|webp|gif|avif|svg)$/.test(name);
      if (!allowed) return json({ error: 'Hanya file gambar arsip yang bisa dihapus' }, 400);
      await env.IMAGES.delete(name);
      return json({ ok: true, deleted: name });
    }

    // ---- sajikan gambar arsip (URL permanen /img/<nama>) ----
    if (method === 'GET' && url.pathname.startsWith('/img/')) {
      const name = url.pathname.slice(5);
      if (!name || !env || !env.IMAGES) return json({ error: 'Penyimpanan gambar belum diaktifkan' }, 404);
      // Catatan: pakai { type: 'arrayBuffer' }, bukan 'stream' — pada namespace
      // KV format URL-encoded, get type stream mengembalikan stream kosong
      // (bug runtime); arrayBuffer terbukti bekerja.
      const buf = await env.IMAGES.get(name, { type: 'arrayBuffer' });
      if (buf === null || buf === undefined) return json({ error: 'Gambar tidak ditemukan' }, 404);
      const ext = name.split('.').pop().toLowerCase();
      const ct = ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml' })[ext] || 'image/png';
      return new Response(buf, {
        status: 200,
        headers: { 'Content-Type': ct, 'Cache-Control': 'public, max-age=31536000, immutable', ...corsHeaders() },
      });
    }

    return json({ error: 'Endpoint tidak dikenal' }, 404);
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    // Validasi payload (mis. LoRA butuh URL) → 400, bukan 500
    const status = String(msg).includes('butuh URL file LoRA') ? 400 : 500;
    return json({ error: msg }, status);
  }
}
