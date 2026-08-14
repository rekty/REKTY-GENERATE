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

// Pemetaan sampler UI -> scheduler Replicate (SDXL).
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

/** Seed TAMS hanya int64 <= 4294967295; 0 = random. */
function toSeed(seed) {
  const s = String(seed ?? '').trim();
  if (/^\d{1,10}$/.test(s)) {
    const n = parseInt(s, 10);
    if (n > 0) return n;
  }
  return 0; // random
}

const PROVIDERS = ['tams', 'replicate', 'fal', 'pollinations'];
const PROVIDER_ENV = {
  tams: 'TENSORART_API_KEY',
  replicate: 'REPLICATE_API_TOKEN',
  fal: 'FAL_API_KEY',
  pollinations: 'POLLINATIONS_API_KEY', // opsional — gratis tanpa key, sk_* untuk API baru
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
    width: clampInt(params.width, 512, 1536, 768),
    height: clampInt(params.height, 512, 1536, 1152),
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

  // IMG2IMG: upload gambar input lalu pakai sebagai inisialisasi diffusion.
  if (isImg && Array.isArray(params.images) && params.images[0]) {
    const resourceId = await tamsUploadImage(params.images[0], apiKey);
    inputInit.imageResourceId = resourceId;
    diffusion.denoisingStrength = clampFloat(
      params.denoisingStrength != null ? params.denoisingStrength : params.denoising_strength,
      0, 1, 0.5,
    );
  }

  const payload = {
    request_id: 'rekty-' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
    stages: [
      { type: 'INPUT_INITIALIZE', inputInitialize: inputInit },
      { type: 'DIFFUSION', diffusion },
    ],
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
      width: clampInt(params.width, 512, 1536, 768),
      height: clampInt(params.height, 512, 1536, 1152),
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
      width: clampInt(params.width, 512, 1536, 768),
      height: clampInt(params.height, 512, 1536, 1152),
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
  const width = clampInt(params.width, 256, 1920, 1024);
  const height = clampInt(params.height, 256, 1920, 1024);
  const seed = toSeed(params.seed);
  const model = String(params.model || '').trim();
  const prompt = String(params.prompt || '').slice(0, 1500);
  const url = new URL((apiKey ? GEN_POLLINATIONS : POLLINATIONS_IMG) + encodeURIComponent(prompt));
  url.searchParams.set('width', String(width));
  url.searchParams.set('height', String(height));
  if (model) url.searchParams.set('model', model);
  if (seed > 0) url.searchParams.set('seed', String(seed));
  if (apiKey) url.searchParams.set('nologo', 'true');

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

async function onRequest(context) {
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
      const payload = {
        model: 'openai',
        messages: [
          { role: 'system', content: 'You are an expert AI image prompt engineer. Rewrite and improve the given prompt for an AI image generator: keep the core subject/style, add useful details (lighting, composition, quality tags), fix grammar. Answer ONLY with the improved prompt in English, no explanations, no quotes.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 220,
      };
      const res = await fetchWithTimeout(GEN_POLLINATIONS_CHAT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify(payload),
      }, 45000);
      const j = safeJson(await res.text());
      if (!res.ok || !j) {
        const msg = (j && j.error && (j.error.message || j.error)) || 'Refine gagal (saldo pollen?)';
        return json({ error: String(msg) }, 502);
      }
      const text = String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '').trim();
      if (!text) return json({ error: 'Refine kosong' }, 502);
      return json({ ok: true, text });
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
      // Pollinations gratis tanpa API key — semua provider lain wajib key.
      if (!apiKey && provider !== 'pollinations') {
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
      if (!apiKey && provider !== 'pollinations') {
        return json({ error: 'API key ' + provider + ' belum diatur' }, 401);
      }

      let r;
      if (provider === 'replicate') r = await replicateGetJob(jobId, apiKey);
      else if (provider === 'fal') r = await falGetJob(jobId, apiKey, falModel);
      else if (provider === 'pollinations') r = await pollinationsGetTask(jobId, env);
      else r = await tamsGetJob(jobId, apiKey);

      // Arsipkan gambar hasil ke R2 supaya URL-nya permanen (tidak kedaluwarsa).
      if (Array.isArray(r.images) && r.images.length) {
        r.images = await archiveImages(r.images, env);
      }
      return json({ ok: true, provider, ...r });
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


/* ---------- Advanced Mode: /api/* -> backend, path lain -> index.html ---------- */
// index.html di-embed sebagai base64 (ASCII murni, aman untuk bundler/minifier).
const HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImlkIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04IiAvPgo8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLGluaXRpYWwtc2NhbGU9MSIgLz4KPHRpdGxlPlJla3R5IEFJIOKAlCBUZXh0IHRvIEltYWdlPC90aXRsZT4KPHNjcmlwdD53aW5kb3cuX190YV9zdHlsZV9fPXRydWU8L3NjcmlwdD4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuLnRhaWx3aW5kY3NzLmNvbSI+PC9zY3JpcHQ+CjxzY3JpcHQgc3JjPSJodHRwczovL3VucGtnLmNvbS9AcGhvc3Bob3ItaWNvbnMvd2ViL3Bob3NwaG9yLWljb24uanMiPjwvc2NyaXB0Pgo8bGluayByZWw9InByZWNvbm5lY3QiIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20iPgo8bGluayBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tL2NzczI/ZmFtaWx5PUludGVyOndnaHRANDAwOzUwMDs2MDA7NzAwJmRpc3BsYXk9c3dhcCIgcmVsPSJzdHlsZXNoZWV0Ij4KPHN0eWxlPgpodG1sLGJvZHl7bWFyZ2luOjA7cGFkZGluZzowO2ZvbnQtZmFtaWx5Oi1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LCdTZWdvZSBVSScsUm9ib3RvLCdIZWx2ZXRpY2EgTmV1ZScsQXJpYWwsJ05vdG8gU2Fucycsc2Fucy1zZXJpZjtiYWNrZ3JvdW5kOiMwZDExMTc7Y29sb3I6I2U4ZThlODttaW4taGVpZ2h0OjEwMHZofQouaGlkZWJhcjo6LXdlYmtpdC1zY3JvbGxiYXJ7ZGlzcGxheTpub25lfS5oaWRlYmFye3Njcm9sbGJhci13aWR0aDpub25lfQo6Oi13ZWJraXQtc2Nyb2xsYmFye3dpZHRoOjhweDtoZWlnaHQ6OHB4fQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1ie2JhY2tncm91bmQ6IzMwMzYzZDtib3JkZXItcmFkaXVzOjRweH0KOjotd2Via2l0LXNjcm9sbGJhci10aHVtYjpob3ZlcntiYWNrZ3JvdW5kOiMzZDQ0NGR9Cjo6LXdlYmtpdC1zY3JvbGxiYXItdHJhY2t7YmFja2dyb3VuZDp0cmFuc3BhcmVudH0KLmdmaWx7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjExcHg7Y29sb3I6IzljYTNhZjtiYWNrZ3JvdW5kOiMxYzIxMjg7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjouMTJzfQouZ2ZpbDpob3Zlcntjb2xvcjojZmZmO2JvcmRlci1jb2xvcjojM2Q0NDRkfQouZ2ZpbC5zZWx7YmFja2dyb3VuZDojZmZmO2NvbG9yOiMwZDExMTc7Ym9yZGVyLWNvbG9yOiNmZmY7Zm9udC13ZWlnaHQ6NjAwfQouYmR7Ym9yZGVyLWNvbG9yOiMzMDM2M2R9Ci5pbnB7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2JvcmRlci1yYWRpdXM6OHB4O2JhY2tncm91bmQ6IzFjMjEyODtjb2xvcjojZThlOGU4O3BhZGRpbmc6OHB4IDExcHg7b3V0bGluZTpub25lO2ZvbnQtc2l6ZToxM3B4O3dpZHRoOjEwMCV9Ci5pbnA6Zm9jdXN7Ym9yZGVyLWNvbG9yOiM2RjVERkZ9Ci5idG57Ym9yZGVyLXJhZGl1czoxMHB4O2ZvbnQtd2VpZ2h0OjYwMDt0cmFuc2l0aW9uOi4xNXM7Y3Vyc29yOnBvaW50ZXI7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtnYXA6NnB4O2ZvbnQtc2l6ZToxM3B4fQouYnRuLWJsdWV7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiAwJSwjMjdENENEIDU5LjclLCM3NEZGN0UgMTAwJSk7Ym9yZGVyOm5vbmU7Y29sb3I6I2ZmZjtib3gtc2hhZG93OjAgMCAxOHB4IHJnYmEoMTExLDkzLDI1NSwuMzUpO3BhZGRpbmc6MCAxOHB4fQouYnRuLWJsdWU6aG92ZXJ7ZmlsdGVyOmJyaWdodG5lc3MoMS4xKTtib3gtc2hhZG93OjAgMCAyNHB4IHJnYmEoMTExLDkzLDI1NSwuNSl9Ci5idG4tYmx1ZTphY3RpdmV7dHJhbnNmb3JtOnNjYWxlKC45OCl9Ci8qIFRvbWJvbCBHZW5lcmF0ZSBzZXBlcnRpIFRlbnNvci5BcnQ6IHR1cnF1b2lzZS1ibHVlICovCi5idG4tdHVycXtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzFGQzdDRSAwJSwjMkU3Q0YwIDEwMCUpO2JvcmRlcjpub25lO2NvbG9yOiNmZmY7Ym94LXNoYWRvdzowIDAgMTZweCByZ2JhKDMxLDE5OSwyMDYsLjM1KTtwYWRkaW5nOjAgMTZweH0KLmJ0bi10dXJxOmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMSk7Ym94LXNoYWRvdzowIDAgMjJweCByZ2JhKDMxLDE5OSwyMDYsLjUpfQouYnRuLXR1cnE6YWN0aXZle3RyYW5zZm9ybTpzY2FsZSguOTgpfQouYnRuLWdob3N0e2NvbG9yOiNhMWExYWE7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHRyYW5zcGFyZW50fS5idG4tZ2hvc3Q6aG92ZXJ7YmFja2dyb3VuZDojMWMyMTI4O2NvbG9yOiNlOGU4ZTh9Ci50YWJ7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtwYWRkaW5nOjZweCAxMnB4O2JvcmRlci1yYWRpdXM6OHB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7Zm9udC13ZWlnaHQ6NTAwO3doaXRlLXNwYWNlOm5vd3JhcDt0cmFuc2l0aW9uOi4xMnN9Ci50YWI6aG92ZXJ7Y29sb3I6I2ZmZjtiYWNrZ3JvdW5kOiMxYzIxMjh9LnRhYi5zZWx7Y29sb3I6I2ZmZjtiYWNrZ3JvdW5kOiMxYzIxMjh9Ci50YWIgLmRvdHt3aWR0aDo2cHg7aGVpZ2h0OjZweDtib3JkZXItcmFkaXVzOjUwJTtkaXNwbGF5OmlubGluZS1ibG9ja30KLnRhYi5zZWwgLmRvdHtkaXNwbGF5Om5vbmV9Ci50YWIuc2VsOjphZnRlcntjb250ZW50OiIiO3Bvc2l0aW9uOmFic29sdXRlO2JvdHRvbTotMXB4O2xlZnQ6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGVYKC01MCUpO3dpZHRoOjIwcHg7aGVpZ2h0OjJweDtib3JkZXItcmFkaXVzOjJweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5NWRlZywjNkY1REZGLCMyN0Q0Q0QpO3Bvc2l0aW9uOmFic29sdXRlfQoudGFie3Bvc2l0aW9uOnJlbGF0aXZlfQouc2xpZGVyey13ZWJraXQtYXBwZWFyYW5jZTpub25lO2FwcGVhcmFuY2U6bm9uZTtoZWlnaHQ6NHB4O2JvcmRlci1yYWRpdXM6NHB4O2JhY2tncm91bmQ6IzMwMzYzZDtvdXRsaW5lOm5vbmU7d2lkdGg6MTAwJX0KLnNsaWRlcjo6LXdlYmtpdC1zbGlkZXItdGh1bWJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7YXBwZWFyYW5jZTpub25lO3dpZHRoOjE1cHg7aGVpZ2h0OjE1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDojZmZmO2JvcmRlcjozcHggc29saWQgIzZGNURGRjtjdXJzb3I6cG9pbnRlcjtib3gtc2hhZG93OjAgMCA2cHggcmdiYSgxMTEsOTMsMjU1LC40KTt0cmFuc2l0aW9uOi4xMnN9Ci5zbGlkZXI6Oi13ZWJraXQtc2xpZGVyLXRodW1iOmhvdmVye3RyYW5zZm9ybTpzY2FsZSgxLjEpfQoubG9yYS1zbHstd2Via2l0LWFwcGVhcmFuY2U6bm9uZTthcHBlYXJhbmNlOm5vbmU7aGVpZ2h0OjRweDtib3JkZXItcmFkaXVzOjRweDtiYWNrZ3JvdW5kOiMzMDM2M2Q7b3V0bGluZTpub25lfQoubG9yYS1zbDo6LXdlYmtpdC1zbGlkZXItdGh1bWJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7d2lkdGg6MTRweDtoZWlnaHQ6MTRweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjJweCBzb2xpZCAjNkY1REZGO2N1cnNvcjpwb2ludGVyfQoubG9yYS1jYXJke3Bvc2l0aW9uOnJlbGF0aXZlO2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjEwcHg7YmFja2dyb3VuZDojMWMyMTI4O3RyYW5zaXRpb246LjEycztwYWRkaW5nOjhweCAxMHB4IDEwcHh9Ci5sb3JhLWNhcmQ6aG92ZXJ7Ym9yZGVyLWNvbG9yOiMzZDQ0NGR9Ci5sb3JhLWxhYmVse3Bvc2l0aW9uOmFic29sdXRlO3RvcDowO2xlZnQ6MDtmb250LXNpemU6OXB4O2NvbG9yOiM5YTlhYTI7YmFja2dyb3VuZDojMjEyNjJkO2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMSk7cGFkZGluZzoycHggNnB4O2JvcmRlci1yYWRpdXM6NnB4O2JvcmRlci10b3AtbGVmdC1yYWRpdXM6MTBweDtib3JkZXItYm90dG9tLXJpZ2h0LXJhZGl1czo2cHg7ei1pbmRleDoyfQoubG9yYS10b3B7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4O21hcmdpbi10b3A6OHB4fQoubG9yYS10aHVtYnt3aWR0aDozNHB4O2hlaWdodDozNHB4O2JvcmRlci1yYWRpdXM6NnB4O2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtvYmplY3QtZml0OmNvdmVyO2ZsZXgtc2hyaW5rOjB9Ci5sb3JhLW5hbWV7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOiNlOGU4ZTg7ZmxleDoxO21pbi13aWR0aDowO3doaXRlLXNwYWNlOm5vd3JhcDtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpc30KLmxvcmEtaWNvbnN7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MnB4O2ZsZXgtc2hyaW5rOjB9Ci5sb3JhLWljb257d2lkdGg6MjJweDtoZWlnaHQ6MjJweDtib3JkZXItcmFkaXVzOjRweDtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y29sb3I6IzcxNzE3YTtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O3RyYW5zaXRpb246LjEyc30KLmxvcmEtaWNvbjpob3ZlcntiYWNrZ3JvdW5kOiMyMTI2MmQ7Y29sb3I6I2ZmZn0KLmxvcmEtaWNvbi5kZWw6aG92ZXJ7YmFja2dyb3VuZDpyZ2JhKDIzOSw2OCw2OCwuMTUpO2NvbG9yOiNlZjQ0NDR9Ci5sb3JhLWljb24gc3Zne3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7c3Ryb2tlOmN1cnJlbnRDb2xvcjtmaWxsOm5vbmU7c3Ryb2tlLXdpZHRoOjJ9Ci5sb3JhLXNsaWRlci1yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6NHB4O21hcmdpbi10b3A6NnB4fQoubC1zbGlkZXJ7cG9zaXRpb246cmVsYXRpdmU7ZmxleDoxO2hlaWdodDoxNnB4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5sLXRyYWNre3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDtyaWdodDowO2hlaWdodDo0cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDojMzAzNjNkfQoubC1maWxse3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDt0b3A6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpO2hlaWdodDo0cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiwjMjdENENEKX0KLmwtaGFuZGxle3Bvc2l0aW9uOmFic29sdXRlO3RvcDo1MCU7dHJhbnNmb3JtOnRyYW5zbGF0ZSgtNTAlLC01MCUpO3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoycHggc29saWQgIzZGNURGRjtib3gtc2hhZG93OjAgMXB4IDNweCByZ2JhKDAsMCwwLC40KTtwb2ludGVyLWV2ZW50czpub25lfQoubG9yYS1zbHtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7b3BhY2l0eTowO2N1cnNvcjpwb2ludGVyfQoubC1udW17ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MnB4O2ZsZXgtc2hyaW5rOjB9Ci5sb3JhLWlucHV0e3dpZHRoOjMwcHg7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xNSk7Ym9yZGVyLXJhZGl1czo2cHg7YmFja2dyb3VuZDojMGQxMTE3O2NvbG9yOiNlOGU4ZTg7Zm9udC1zaXplOjEycHg7dGV4dC1hbGlnbjpjZW50ZXI7b3V0bGluZTpub25lO3BhZGRpbmc6NHB4IDB9Ci5sb3JhLWlucHV0OmZvY3Vze2JvcmRlci1jb2xvcjojNkY1REZGfQoubG9yYS11cmwtaW5we2ZvbnQtc2l6ZToxMXB4O3BhZGRpbmc6NnB4IDlweDttYXJnaW4tdG9wOjJweH0KLmxvcmEtYnRue3dpZHRoOjIycHg7aGVpZ2h0OjIycHg7Ym9yZGVyLXJhZGl1czo1MCU7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOiM5YTlhYTI7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTt0cmFuc2l0aW9uOi4xMnN9Ci5sb3JhLWJ0bjpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjEpO2NvbG9yOiNmZmZ9Ci5sb3JhLWJ0biBzdmd7d2lkdGg6MTRweDtoZWlnaHQ6MTRweDtzdHJva2U6Y3VycmVudENvbG9yO2ZpbGw6bm9uZTtzdHJva2Utd2lkdGg6MjtzdHJva2UtbGluZWNhcDpyb3VuZH0KLnRhZ3tiYWNrZ3JvdW5kOiMxYzIxMjg7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2NvbG9yOiNlMGUwZTA7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjRweDtmb250LXNpemU6MTJweDtwYWRkaW5nOjRweCA4cHg7Ym9yZGVyLXJhZGl1czo2cHh9Ci5hcntib3JkZXI6MXB4IHNvbGlkICMzMDM2M2Q7Ym9yZGVyLXJhZGl1czoxMHB4O2JhY2tncm91bmQ6IzFjMjEyODtjb2xvcjojZmZmO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjJweDtwYWRkaW5nOjhweCAycHg7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjouMTJzO21pbi13aWR0aDowfQouYXI6aG92ZXJ7Ym9yZGVyLWNvbG9yOiMzZDQ0NGR9Ci5hci5zZWx7Ym9yZGVyLWNvbG9yOiMyN0Q0Q0Q7YmFja2dyb3VuZDojMTYxYjIyfQouYXIuc2VsIC5hci1kZXNje2NvbG9yOiMyN0Q0Q0R9Ci5hci1pY297d2lkdGg6MjRweDtoZWlnaHQ6MjRweDtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXJ9Ci5hci1pY28gc3Zne3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCV9Ci5hci1uYW1le2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiNlOGU4ZTg7d2hpdGUtc3BhY2U6bm93cmFwfQouYXItZGVzY3tmb250LXNpemU6OXB4O2NvbG9yOiM5YTlhYTI7d2hpdGUtc3BhY2U6bm93cmFwfQouZmllbGR7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6M3B4fQoucnRhYntib3JkZXI6MXB4IHNvbGlkIHRyYW5zcGFyZW50O2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50fQoucnRhYjpob3Zlcntjb2xvcjojZmZmfS5ydGFiLnNlbHtiYWNrZ3JvdW5kOiMxYzIxMjg7Y29sb3I6I2ZmZn0KLnJjYXJke2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjEwcHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6IzE2MWIyMn0KLmNoaXB7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOiMxYzIxMjg7dHJhbnNpdGlvbjouMTJzfQouY2hpcDpob3Zlcntjb2xvcjojZmZmfS5jaGlwLm9ue2JvcmRlci1jb2xvcjojNkY1REZGO2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMTYxYjIyfQojdG9hc3R7Ym94LXNoYWRvdzowIDhweCAzMHB4IHJnYmEoMCwwLDAsLjUpfQpAbWVkaWEgKG1heC13aWR0aDoxMDIzcHgpeyNyaWdodFBhbi5tb2JpbGUtb3Blbntwb3NpdGlvbjpmaXhlZDt0b3A6NTZweDtyaWdodDowO2JvdHRvbTowO2xlZnQ6YXV0bzt6LWluZGV4OjQwO2Rpc3BsYXk6ZmxleDt3aWR0aDptaW4oMjFyZW0sOTJ2dyk7Ym94LXNoYWRvdzotOHB4IDAgMzBweCByZ2JhKDAsMCwwLC41KX19CnRleHRhcmVhe2NhcmV0LWNvbG9yOiM2RjVERkZ9CmlucHV0W3R5cGU9Y2hlY2tib3hde3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7Y3Vyc29yOnBvaW50ZXJ9CmlucHV0W3R5cGU9cmFuZ2Vde2N1cnNvcjpwb2ludGVyfQo6Zm9jdXMtdmlzaWJsZXtvdXRsaW5lOjJweCBzb2xpZCAjNkY1REZGO291dGxpbmUtb2Zmc2V0OjJweH0KLnd2bnVte2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOiMxYzIxMjg7Y29sb3I6I2U4ZThlODtwYWRkaW5nOjNweCA2cHg7d2lkdGg6NjRweDtmb250LXNpemU6MTJweDt0ZXh0LWFsaWduOnJpZ2h0O291dGxpbmU6bm9uZX0KLnd2bnVtOmZvY3Vze2JvcmRlci1jb2xvcjojMjdENENEfQoubXRhYntwYWRkaW5nOjhweCAxNHB4O2JvcmRlci1yYWRpdXM6OHB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7Zm9udC13ZWlnaHQ6NTAwO3doaXRlLXNwYWNlOm5vd3JhcDt0cmFuc2l0aW9uOi4xMnN9Ci5tdGFiOmhvdmVye2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMWMyMTI4fS5tdGFiLnNlbHtjb2xvcjojZmZmO2JhY2tncm91bmQ6IzFjMjEyODtib3JkZXItYm90dG9tOjJweCBzb2xpZCAjNkY1REZGfQoubWNoaXB7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOiMxYzIxMjg7dHJhbnNpdGlvbjouMTJzO3doaXRlLXNwYWNlOm5vd3JhcH0KLm1jaGlwOmhvdmVye2NvbG9yOiNmZmZ9Lm1jaGlwLm9ue2JvcmRlci1jb2xvcjojNkY1REZGO2NvbG9yOiNmZmY7YmFja2dyb3VuZDpyZ2JhKDExMSw5MywyNTUsLjE1KX0KLm1jYXJke2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjEwcHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6IzFjMjEyODt0cmFuc2l0aW9uOi4xNXN9Ci5tY2FyZDpob3Zlcntib3JkZXItY29sb3I6cmdiYSgxMTEsOTMsMjU1LC41NSk7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTJweCk7Ym94LXNoYWRvdzowIDZweCAxOHB4IHJnYmEoMCwwLDAsLjM1KX0KLm1jYXJkLWltZ3twb3NpdGlvbjpyZWxhdGl2ZTthc3BlY3QtcmF0aW86My80O292ZXJmbG93OmhpZGRlbn0KLm1jYXJkLWltZyBpbWd7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtvYmplY3QtZml0OmNvdmVyO3RyYW5zaXRpb246LjNzfQoubWNhcmQ6aG92ZXIgLm1jYXJkLWltZyBpbWd7dHJhbnNmb3JtOnNjYWxlKDEuMDUpfQoubWNhcmQtYmFkZ2V7cG9zaXRpb246YWJzb2x1dGU7dG9wOjZweDtsZWZ0OjZweDtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjY1KTtiYWNrZHJvcC1maWx0ZXI6Ymx1cig0cHgpO2ZvbnQtc2l6ZToxMHB4O3BhZGRpbmc6MnB4IDZweDtib3JkZXItcmFkaXVzOjRweDtjb2xvcjojZThlOGU4O2ZvbnQtd2VpZ2h0OjUwMH0KLm1jYXJkLXN0YXJ7cG9zaXRpb246YWJzb2x1dGU7dG9wOjZweDtyaWdodDo2cHg7d2lkdGg6MjZweDtoZWlnaHQ6MjZweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjUpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDRweCk7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2N1cnNvcjpwb2ludGVyO2NvbG9yOiM5YTlhYTI7dHJhbnNpdGlvbjouMTJzfQoubWNhcmQtc3Rhcjpob3Zlcntjb2xvcjojZWFiMzA4fS5tY2FyZC1zdGFyLm9ue2NvbG9yOiNlYWIzMDh9Ci5tY2FyZC12aWV3c3twb3NpdGlvbjphYnNvbHV0ZTtib3R0b206NnB4O2xlZnQ6NnB4O2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNik7YmFja2Ryb3AtZmlsdGVyOmJsdXIoNHB4KTtmb250LXNpemU6MTBweDtwYWRkaW5nOjJweCA2cHg7Ym9yZGVyLXJhZGl1czo0cHg7Y29sb3I6I2U4ZThlODtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDozcHh9Ci5tY2FyZC1pbmZve3BhZGRpbmc6OHB4fQoubWNhcmQtbmFtZXtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo2MDA7Y29sb3I6I2U4ZThlODt3aGl0ZS1zcGFjZTpub3dyYXA7b3ZlcmZsb3c6aGlkZGVuO3RleHQtb3ZlcmZsb3c6ZWxsaXBzaXN9Ci5tY2FyZC1tZXRhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47bWFyZ2luLXRvcDo2cHh9Ci5tY2FyZC12ZXJ7Zm9udC1zaXplOjExcHg7Y29sb3I6IzlhOWFhMjtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjRweDtwYWRkaW5nOjJweCA2cHh9Ci5tY2FyZC1zZWx7Zm9udC1zaXplOjExcHg7Ym9yZGVyOjFweCBzb2xpZCAjNkY1REZGO2NvbG9yOiM2RjVERkY7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXItcmFkaXVzOjRweDtwYWRkaW5nOjJweCAxMHB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcjt0cmFuc2l0aW9uOi4xMnN9Ci5tY2FyZC1zZWw6aG92ZXJ7YmFja2dyb3VuZDojNkY1REZGO2NvbG9yOiNmZmZ9Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+Cgo8aGVhZGVyIGNsYXNzPSJmaXhlZCB0b3AtMCBsZWZ0LTAgcmlnaHQtMCB6LTQwIGgtMTQgYmctWyMwZDExMTddLzg1IGJhY2tkcm9wLWJsdXIgYm9yZGVyLWIgYmQgZmxleCBpdGVtcy1jZW50ZXIgcHgtMiBzbTpweC0zIGdhcC0yIj4KICA8YnV0dG9uIGlkPSJtbWVudSIgY2xhc3M9ImxnOmhpZGRlbiB0ZXh0LW5ldXRyYWwtNDAwIHAtMSI+PGkgZGF0YS1pY29uPSJsaXN0IiBjbGFzcz0idy01IGgtNSI+PC9pPjwvYnV0dG9uPgogIDxkaXYgY2xhc3M9InctNiBoLTYgc2hyaW5rLTAgaGlkZGVuIHNtOmZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIj4KICAgIDxzdmcgd2lkdGg9IjIyIiBoZWlnaHQ9IjIyIiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgcng9IjUiIGZpbGw9InVybCgjZykiLz48cGF0aCBkPSJNNyAxMi41bDMgMyA3LTciIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjI0IiB5Mj0iMjQiPjxzdG9wIHN0b3AtY29sb3I9IiM2RjVERkYiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM2RjVERkYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48L3N2Zz4KICA8L2Rpdj4KICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMC41IGhpZGViYXIgb3ZlcmZsb3cteC1hdXRvIGZsZXgtMSI+CiAgICA8ZGl2IGNsYXNzPSJ0YWIgc2VsIiBkYXRhLXRhYj0idGV4dCI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6IzZGNURGRiI+PC9zcGFuPlRleHQySW1nPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJ0YWIiIGRhdGEtdGFiPSJpbWciPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiMyMmM1NWUiPjwvc3Bhbj5JbWcySW1nPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJ0YWIiIGRhdGEtdGFiPSJlZGl0Ij48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDojZWFiMzA4Ij48L3NwYW4+RWRpdDwvZGl2PgogICAgPGRpdiBjbGFzcz0idGFiIiBkYXRhLXRhYj0idmlkZW8iPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiNlZjQ0NDQiPjwvc3Bhbj5WaWRlbzwvZGl2PgogICAgPGRpdiBjbGFzcz0idGFiIiBkYXRhLXRhYj0icHJpbWUiPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiMzYjgyZjYiPjwvc3Bhbj5QcmltZTwvZGl2PgogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUgc206Z2FwLTIgbWwtYXV0byBzaHJpbmstMCI+CiAgICA8YnV0dG9uIGlkPSJuY29sIiBjbGFzcz0idGV4dC1uZXV0cmFsLTQwMCBob3Zlcjp0ZXh0LXdoaXRlIHAtMS41IGhpZGRlbiBzbTpmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSB0ZXh0LXhzIiB0aXRsZT0iSnVtbGFoIGtvbG9tIj48aSBkYXRhLWljb249InNxdWFyZXMtZm91ciIgY2xhc3M9InctNCBoLTQiPjwvaT48c3BhbiBpZD0ibmNvbGxibCI+Mjwvc3Bhbj48L2J1dHRvbj4KICA8L2Rpdj4KPC9oZWFkZXI+Cgo8ZGl2IGlkPSJvdmVybGF5IiBjbGFzcz0iZml4ZWQgaW5zZXQtMCBiZy1ibGFjay82MCB6LTMwIGhpZGRlbiBsZzpoaWRkZW4iPjwvZGl2PgoKPGRpdiBjbGFzcz0icHQtMTQgZmxleCBoLVtjYWxjKDEwMHZoLTU2cHgpXSBvdmVyZmxvdy1oaWRkZW4iPgoKICA8IS0tIExFRlQgUEFORUwgLS0+CiAgPGFzaWRlIGlkPSJsZWZ0cGFuIiBjbGFzcz0iZml4ZWQgbGc6c3RhdGljIHotNDAgaW5zZXQteS0wIGxlZnQtMCBwdC0xNCBsZzpwdC0wIHctWzIycmVtXSBtYXgtdy1bODh2d10gLXRyYW5zbGF0ZS14LWZ1bGwgbGc6dHJhbnNsYXRlLXgtMCB0cmFuc2l0aW9uLXRyYW5zZm9ybSBkdXJhdGlvbi0yMDAgc2hyaW5rLTAgYm9yZGVyLXIgYmQgb3ZlcmZsb3cteS1hdXRvIGJnLVsjMTYxYjIyXSI+CiAgICA8ZGl2IGNsYXNzPSJwLTQgc3BhY2UteS00Ij4KCiAgICAgIDwhLS0gTW9kZWxzICh1cnV0YW4gc2VwZXJ0aSBUZW5zb3IuQXJ0OiBNb2RlbHMgLT4gVkFFIC0+IFNldHRpbmdzKSAtLT4KICAgICAgPGRpdiBjbGFzcz0ic3BhY2UteS0zIj4KICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5Nb2RlbHM8L3NwYW4+CiAgICAgICAgPGRpdiBpZD0ibW9kZWwtY2FyZCIgY2xhc3M9InJlbGF0aXZlIGJvcmRlciBiZCByb3VuZGVkLXhsIGJnLVsjMWMyMTI4XSBob3Zlcjpib3JkZXItWyMzZDQ0NGRdIGN1cnNvci1wb2ludGVyIHAtMyI+CiAgICAgICAgICA8c3BhbiBpZD0ibW9kZWwtYmFkZ2UiIGNsYXNzPSJhYnNvbHV0ZSB0b3AtMCBsZWZ0LTAgdGV4dC1bOXB4XSB0ZXh0LW5ldXRyYWwtNDAwIGJnLVsjMjEyNjJkXSBib3JkZXIgYmQgcHgtMiBweS0wLjUgcm91bmRlZC10bC14bCByb3VuZGVkLWJyLW1kIHotMTAiPkJhc2ljIE1vZGVsIC0gWiBJbWFnZTwvc3Bhbj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0zIG10LTIiPgogICAgICAgICAgICA8aW1nIGlkPSJtb2RlbC10aHVtYiIgc3JjPSJodHRwczovL3BpY3N1bS5waG90b3Mvc2VlZC96aW1hZ2UvNjQiIGNsYXNzPSJ3LTE2IGgtMTYgcm91bmRlZC1sZyBvYmplY3QtY292ZXIgc2hyaW5rLTAgYm9yZGVyIGJkIiBhbHQ9Im1vZGVsIi8+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImZsZXgtMSBtaW4tdy0wIj4KICAgICAgICAgICAgICA8ZGl2IGlkPSJtb2RlbC1uYW1lIiBjbGFzcz0iZm9udC1zZW1pYm9sZCB0ZXh0LXNtIHRydW5jYXRlIj5aIEltYWdlIC0gYmFzZS1iZjE2PC9kaXY+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8YnV0dG9uIGlkPSJtb2RlbC1pbmZvIiBjbGFzcz0idy02IGgtNiBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciByb3VuZGVkIHRleHQtbmV1dHJhbC01MDAgaG92ZXI6dGV4dC13aGl0ZSBob3ZlcjpiZy1bIzIxMjYyZF0gdHJhbnNpdGlvbiIgdGl0bGU9IkluZm8iPgogICAgICAgICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGNsYXNzPSJ3LTQgaC00Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIvPjxsaW5lIHgxPSIxMiIgeTE9IjE2IiB4Mj0iMTIiIHkyPSIxMiIvPjxsaW5lIHgxPSIxMiIgeTE9IjgiIHgyPSIxMi4wMSIgeTI9IjgiLz48L3N2Zz4KICAgICAgICAgICAgPC9idXR0b24+CiAgICAgICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGNsYXNzPSJ3LTQgaC00IHRleHQtbmV1dHJhbC01MDAgc2hyaW5rLTAiPjxwb2x5bGluZSBwb2ludHM9IjkgMTggMTUgMTIgOSA2Ii8+PC9zdmc+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGdhcC0yIj4KICAgICAgICAgIDxidXR0b24gaWQ9ImJ0bi1hZGRsb3JhIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBmbGV4LTEgaC05IGJvcmRlciBiZCB0ZXh0LXhzIj5BZGQgTG9SQTwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBmbGV4LTEgaC05IGJvcmRlciBiZCB0ZXh0LXhzIj5BZGQgRW1iZWRkaW5nPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1naG9zdCB3LWZ1bGwgaC05IGJvcmRlciBiZCB0ZXh0LXhzIj5BZGQgQ29udHJvbE5ldDwvYnV0dG9uPgogICAgICA8L2Rpdj4KCiAgICAgIDwhLS0gTG9SQSAtLT4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gbWItMiI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5Mb1JBPC9zcGFuPgogICAgICAgICAgPGkgZGF0YS1pY29uPSJjYXJldC1kb3duIiBjbGFzcz0idy00IGgtNCB0ZXh0LW5ldXRyYWwtNTAwIj48L2k+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBpZD0ibG9yYS1saXN0IiBjbGFzcz0ic3BhY2UteS0yIj48L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIFRyaWdnZXIgV29yZHMgLS0+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPlRyaWdnZXIgV29yZHM8L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIj4oPHNwYW4gaWQ9InRyLWNvdW50Ij4wPC9zcGFuPik8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIG10LTEiPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTQwMCI+QWRkIFRyaWdnZXIgV29yZHMgdG8gUHJvbXB0czwvc3Bhbj4KICAgICAgICAgIDxidXR0b24gaWQ9ImFkZGFsbC10cmlnIiBjbGFzcz0idGV4dC14cyB0ZXh0LVsjNkY1REZGXSBob3Zlcjp1bmRlcmxpbmUgZm9udC1tZWRpdW0iPkFkZCBBbGw8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGZsZXgtd3JhcCBnYXAtMS41IG10LTIiIGlkPSJ0cmlnZ2VycyI+PC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBWQUUgLS0+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4KICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSI+VkFFPC9zcGFuPgogICAgICAgIDxzZWxlY3QgaWQ9InZhZSIgY2xhc3M9ImlucCI+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhdXRvbWF0aWMiPkF1dG9tYXRpYzwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ibm9uZSI+Tm9uZTwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0idmFlLWZ0LW1zZS04NDAwMDAtZW1hLXBydW5lZC5ja3B0Ij52YWUtZnQtbXNlLTg0MDAwMC1lbWEtcHJ1bmVkLmNrcHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImtsLWY4LWFuaW1lLmNrcHQiPmtsLWY4LWFuaW1lLmNrcHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImtsLWY4LWFuaW1lMi5ja3B0Ij5rbC1mOC1hbmltZTIuY2twdDwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iWU9aT1JBLnZhZS5wdCI+WU9aT1JBLnZhZS5wdDwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ib3JhbmdlbWl4LnZhZS5wdCI+b3JhbmdlbWl4LnZhZS5wdDwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYmxlc3NlZDIudmFlLnB0Ij5ibGVzc2VkMi52YWUucHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImFuaW1ldmFlLnB0Ij5hbmltZXZhZS5wdDwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iQ2xlYXJWQUUuc2FmZXRlbnNvcnMiPkNsZWFyVkFFLnNhZmV0ZW5zb3JzPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJwYXN0ZWwtd2FpZnUtZGlmZnVzaW9uLnZhZS5wdCI+cGFzdGVsLXdhaWZ1LWRpZmZ1c2lvbi52YWUucHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImN1dGVfdmFlLnNhZmV0ZW5zb3JzIj5jdXRlX3ZhZS5zYWZldGVuc29yczwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2R4bF92YWUuc2FmZXRlbnNvcnMiPnNkeGxfdmFlLnNhZmV0ZW5zb3JzPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJzZHhsLXZhZS1mcDE2LWZpeC5zYWZldGVuc29ycyI+c2R4bC12YWUtZnAxNi1maXguc2FmZXRlbnNvcnM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InhsVkFFQ19jOTEuc2FmZXRlbnNvcnMiPnhsVkFFQ19jOTEuc2FmZXRlbnNvcnM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Imxhc3RwaWVjZVhMVkFFX2Jhc2VvbkEwODk3LnNhZmV0ZW5zb3JzIj5sYXN0cGllY2VYTFZBRV9iYXNlb25BMDg5Ny5zYWZldGVuc29yczwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icGxheWdyb3VuZC12Mi41LWZwMTYtdmFlLnNhZmV0ZW5zb3JzIj5wbGF5Z3JvdW5kLXYyLjUtZnAxNi12YWUuc2FmZXRlbnNvcnM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImFlLnNmdCI+YWUuc2Z0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJwaXhlbF9zcGFjZSI+cGl4ZWxfc3BhY2U8L29wdGlvbj4KICAgICAgICA8L3NlbGVjdD4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIFNldHRpbmdzIC0tPgogICAgICA8ZGl2IGNsYXNzPSJzcGFjZS15LTQiPgogICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPlNldHRpbmdzPC9zcGFuPgogICAgICAgIDxkaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJncmlkIGdyaWQtY29scy00IGdhcC0yIj4KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYXIiIGRhdGEtYXI9InBvcnRyYWl0Ij4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItaWNvIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PHJlY3QgeD0iNiIgeT0iMi41IiB3aWR0aD0iMTIiIGhlaWdodD0iMTkiIHJ4PSIyLjUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjEuNiIvPjwvc3ZnPjwvc3Bhbj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItbmFtZSI+UG9ydHJhaXQ8L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWRlc2MiPjc2OHgxMTUyPC9zcGFuPgogICAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYXIiIGRhdGEtYXI9ImxhbmRzY2FwZSI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHg9IjIuNSIgeT0iNiIgd2lkdGg9IjE5IiBoZWlnaHQ9IjEyIiByeD0iMi41IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiLz48L3N2Zz48L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLW5hbWUiPkxhbmRzY2FwZTwvc3Bhbj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItZGVzYyI+MTE1Mng3Njg8L3NwYW4+CiAgICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJhciIgZGF0YS1hcj0ic3F1YXJlIj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItaWNvIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PHJlY3QgeD0iMi41IiB5PSIyLjUiIHdpZHRoPSIxOSIgaGVpZ2h0PSIxOSIgcng9IjIuNSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMS42Ii8+PC9zdmc+PC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5TcXVhcmU8L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWRlc2MiPjEwMjR4MTAyNDwvc3Bhbj4KICAgICAgICAgICAgPC9idXR0b24+CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9ImFyIHNlbCIgZGF0YS1hcj0iY3VzdG9tIj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItaWNvIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PHBhdGggZD0iTTQgOGg1TTEzIDhoN000IDE2aDlNMTcgMTZoM005IDUuNXY1TTE3IDEzLjV2NSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMS44IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48L3N2Zz48L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLW5hbWUiPmN1c3RvbTwvc3Bhbj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItZGVzYyI+Y3VzdG9tPC9zcGFuPgogICAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIG10LTEuNSIgaWQ9ImFyLWxhYmVsIj5jdXN0b208L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIGl0ZW1zLWNlbnRlciI+PHNwYW4+V2lkdGg8L3NwYW4+CiAgICAgICAgICAgIDxpbnB1dCBpZD0id3YiIHR5cGU9Im51bWJlciIgbWluPSIyNTYiIG1heD0iMTUzNiIgc3RlcD0iNjQiIHZhbHVlPSI3NjgiIGNsYXNzPSJ3dm51bSIvPjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgaWQ9IndpZHRoIiB0eXBlPSJyYW5nZSIgbWluPSIyNTYiIG1heD0iMTUzNiIgc3RlcD0iNjQiIHZhbHVlPSI3NjgiIGNsYXNzPSJzbGlkZXIgbXQtMSIvPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXY+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4gaXRlbXMtY2VudGVyIj48c3Bhbj5IZWlnaHQ8L3NwYW4+CiAgICAgICAgICAgIDxpbnB1dCBpZD0iaHYiIHR5cGU9Im51bWJlciIgbWluPSIyNTYiIG1heD0iMTUzNiIgc3RlcD0iNjQiIHZhbHVlPSIxMTUyIiBjbGFzcz0id3ZudW0iLz48L2xhYmVsPgogICAgICAgICAgPGlucHV0IGlkPSJoZWlnaHQiIHR5cGU9InJhbmdlIiBtaW49IjI1NiIgbWF4PSIxNTM2IiBzdGVwPSI2NCIgdmFsdWU9IjExNTIiIGNsYXNzPSJzbGlkZXIgbXQtMSIvPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4iPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC14cyI+U2FtcGxpbmcgTWV0aG9kPC9zcGFuPgogICAgICAgICAgICA8YnV0dG9uIGlkPSJhZHYtdG9nZ2xlIiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEiPjxpIGRhdGEtaWNvbj0iY2FyZXQtZG93biIgY2xhc3M9InctMy41IGgtMy41Ij48L2k+QWR2YW5jZWQ8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBncmlkLWNvbHMtMiBnYXAtMiBtdC0xIj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+U2FtcGxlcjwvbGFiZWw+CiAgICAgICAgICAgICAgPHNlbGVjdCBpZD0ic2FtcGxlciIgY2xhc3M9ImlucCB0ZXh0LXhzIj4KICAgICAgICAgICAgICAgIDxvcHRpb24+RXVsZXIgYTwvb3B0aW9uPjxvcHRpb24+RXVsZXI8L29wdGlvbj48b3B0aW9uPkxNUzwvb3B0aW9uPjxvcHRpb24+TE1TIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RERJTTwvb3B0aW9uPjxvcHRpb24+TENNPC9vcHRpb24+PG9wdGlvbj5IZXVuPC9vcHRpb24+PG9wdGlvbj5EUE0gZmFzdDwvb3B0aW9uPjxvcHRpb24+RFBNMjwvb3B0aW9uPjxvcHRpb24+RFBNMiBhPC9vcHRpb24+PG9wdGlvbj5EUE0yIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNMiBhIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNKysgMlMgYTwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk08L29wdGlvbj48b3B0aW9uPkRQTSsrIFNERTwvb3B0aW9uPjxvcHRpb24+RFBNKysgMlMgYSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNKysgU0RFIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0RFIEthcnJhczwvb3B0aW9uPjxvcHRpb24+UmVzdGFydDwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0RFIEV4cG9uZW50aWFsPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBTREUgSGV1bjwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0RFIEhldW4gS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBTREUgSGV1biBFeHBvbmVudGlhbDwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0dNIFVuaWZvcm08L29wdGlvbj48b3B0aW9uPkRQTSsrIDNNIFNERTwvb3B0aW9uPjxvcHRpb24+RFBNKysgM00gU0RFIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNKysgM00gU0RFIEV4cG9uZW50aWFsPC9vcHRpb24+PG9wdGlvbj5ldWxlcl9keTwvb3B0aW9uPjxvcHRpb24+ZXVsZXJfc21lYV9keTwvb3B0aW9uPgogICAgICAgICAgICAgIDwvc2VsZWN0PjwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsIGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIj5TY2hlZHVsZXI8L2xhYmVsPgogICAgICAgICAgICAgIDxzZWxlY3QgaWQ9InNjaGVkIiBjbGFzcz0iaW5wIHRleHQteHMiPjxvcHRpb24+bm9ybWFsPC9vcHRpb24+PG9wdGlvbj5zaW1wbGU8L29wdGlvbj48b3B0aW9uPmthcnJhczwvb3B0aW9uPjxvcHRpb24+ZXhwb25lbnRpYWw8L29wdGlvbj48b3B0aW9uPnNnbV91bmlmb3JtPC9vcHRpb24+PG9wdGlvbj5kZGltX3VuaWZvcm08L29wdGlvbj48b3B0aW9uPmJldGE8L29wdGlvbj48b3B0aW9uPmxpbmVhcl9xdWFkcmF0aWM8L29wdGlvbj48L3NlbGVjdD48L2Rpdj4KICAgICAgICAgIDwvZGl2Pgo8ZGl2IGNsYXNzPSJzcGFjZS15LTMgbXQtMyI+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TYW1wbGluZyBTdGVwczwvc3Bhbj48c3BhbiBpZD0ic3YiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj4xMDwvc3Bhbj48L2xhYmVsPgogICAgICAgICAgICAgIDxpbnB1dCBpZD0ic3RlcHMiIHR5cGU9InJhbmdlIiBtaW49IjEiIG1heD0iNTAiIHZhbHVlPSIxMCIgY2xhc3M9InNsaWRlciBtdC0xIi8+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8ZGl2PgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q0ZHIFNjYWxlPC9zcGFuPjxzcGFuIGlkPSJjZnYiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj4xPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGlucHV0IGlkPSJjZmciIHR5cGU9InJhbmdlIiBtaW49IjEiIG1heD0iMTAiIHN0ZXA9IjAuNSIgdmFsdWU9IjEiIGNsYXNzPSJzbGlkZXIgbXQtMSIvPgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgPGRpdj4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4gaXRlbXMtY2VudGVyIj48c3Bhbj5TZWVkPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNjAwIj5SYW5kb208L3NwYW4+PC9sYWJlbD4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGdhcC0xLjUgbXQtMSI+CiAgICAgICAgICAgICAgICA8aW5wdXQgaWQ9InNlZWQiIGNsYXNzPSJpbnAgdGV4dC14cyBmbGV4LTEiIHZhbHVlPSIxMDEwOTMzMzQ3OTQzNDYyIi8+CiAgICAgICAgICAgICAgICA8YnV0dG9uIGlkPSJkaWNlIiBjbGFzcz0idy04IGgtOCByb3VuZGVkLWxnIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHNocmluay0wIGJvcmRlciBiZCBiZy1bIzFjMjEyOF0gdGV4dC1uZXV0cmFsLTMwMCBob3Zlcjp0ZXh0LXdoaXRlIGhvdmVyOmJvcmRlci1bIzZGNURGRl0iIHRpdGxlPSJBY2FrIHNlZWQiPjxpIGRhdGEtaWNvbj0iZGljZS1maXZlIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPGRpdiBpZD0iYWR2LWZpZWxkcyIgY2xhc3M9ImhpZGRlbiBzcGFjZS15LTMgbXQtNCBib3JkZXItdCBiZCBwdC0zIj4KICAgICAgICAgICAgPGRpdj4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNsaXAgU2tpcDwvc3Bhbj48c3BhbiBpZD0iY3N2IiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+Mjwvc3Bhbj48L2xhYmVsPgogICAgICAgICAgICAgIDxpbnB1dCBpZD0iY2xpcHNraXAiIHR5cGU9InJhbmdlIiBtaW49IjEiIG1heD0iMTIiIHZhbHVlPSIyIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5FTlNEPC9zcGFuPjxzcGFuIGlkPSJlbnNkIiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MzEzMzc8L3NwYW4+PC9sYWJlbD4KICAgICAgICAgICAgICA8aW5wdXQgaWQ9ImV0YW5zZCIgdHlwZT0icmFuZ2UiIG1pbj0iMCIgbWF4PSIzMTMzNyIgdmFsdWU9IjMxMzM3IiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KCiAgICAgICAgPCEtLSBVcHNjYWxlIChzZXBhcmF0ZSwgZGkgYmF3YWgpIC0tPgogICAgICAgIDxkaXYgY2xhc3M9Im10LTQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIGl0ZW1zLWNlbnRlciI+PHNwYW4+VXBzY2FsZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+Mng8L3NwYW4+PC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCBpZD0idXBzY2FsZSIgdHlwZT0icmFuZ2UiIG1pbj0iMSIgbWF4PSI0IiBzdGVwPSIwLjUiIHZhbHVlPSIyIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIEFQSSBTZXR0aW5ncyAtLT4KICAgICAgPGRpdiBjbGFzcz0iYm9yZGVyIGJkIHJvdW5kZWQteGwgYmctWyMxYzIxMjhdIHAtMyBzcGFjZS15LTIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5BUEk8L3NwYW4+CiAgICAgICAgICA8c3BhbiBpZD0iYXBpLXN0YXR1cyIgY2xhc3M9InRleHQtWzEwcHhdIHRleHQtbmV1dHJhbC01MDAiPjwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAiPlByb3ZpZGVyPC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9ImFwaXByb3ZpZGVyIiBjbGFzcz0iaW5wIHRleHQteHMiPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJ0YW1zIj5UZW5zb3IuQXJ0IChUQU1TKTwvb3B0aW9uPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJyZXBsaWNhdGUiPlJlcGxpY2F0ZSAoU0RYTCk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iZmFsIj5mYWwuYWkgKGZhc3Qtc2R4bCk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icG9sbGluYXRpb25zIj5Qb2xsaW5hdGlvbnMgKEdSQVRJUywgdGFucGEga2V5KTwvb3B0aW9uPgogICAgICAgICAgPC9zZWxlY3Q+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIGlkPSJhcGlrZXktZmllbGQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIiBpZD0iYXBpa2V5LWxhYmVsIj5BUEkgS2V5IFRBTVMgKHRhbXMudGVuc29yLmFydCk8L2xhYmVsPgogICAgICAgICAgPGlucHV0IGlkPSJhcGlrZXkiIHR5cGU9InBhc3N3b3JkIiBjbGFzcz0iaW5wIiBwbGFjZWhvbGRlcj0iQmVhcmVyIHRva2VuLi4uIiBhdXRvY29tcGxldGU9Im9mZiIvPgogICAgICAgIDwvZGl2PgogICAgICAgIDwhLS0gQllPUCBQb2xsaW5hdGlvbnM6IGxvZ2luIE9BdXRoIChidWthbiBrb2xvbSBBUEkga2V5KSAtLT4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCBoaWRkZW4iIGlkPSJieW9wLXJvdyI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAiPkxvZ2luIFBvbGxpbmF0aW9uczwvbGFiZWw+CiAgICAgICAgICA8YnV0dG9uIGlkPSJieW9wLWxvZ2luIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCB3LWZ1bGwgaC04IGJvcmRlciBiZCB0ZXh0LXhzIGp1c3RpZnktY2VudGVyIj5Mb2dpbiBkZW5nYW4gUG9sbGluYXRpb25zIChCWU9QKTwvYnV0dG9uPgogICAgICAgICAgPGRpdiBpZD0iYnlvcC1zdGF0dXMiIGNsYXNzPSJoaWRkZW4gdGV4dC1bMTBweF0gdGV4dC1uZXV0cmFsLTUwMCBtdC0xIj48L2Rpdj4KICAgICAgICAgIDxidXR0b24gaWQ9ImJ5b3AtbG9nb3V0IiBjbGFzcz0iaGlkZGVuIGJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOCBib3JkZXIgYmQgdGV4dC14cyBqdXN0aWZ5LWNlbnRlciBtdC0xIj5Mb2dvdXQ8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJhcGktaGludCIgY2xhc3M9InRleHQtWzEwcHhdIHRleHQtbmV1dHJhbC02MDAiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+TW9kZTwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJhcGltb2RlIiBjbGFzcz0iaW5wIHRleHQteHMiPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhdXRvIj5BdXRvIChiYWNrZW5kICZyYXJyOyBkZW1vKTwvb3B0aW9uPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJyZWFsIj5SZWFsIEFQSSAod2FqaWIgYmFja2VuZCk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iZGVtbyI+RGVtbyAoc2ltdWxhc2kgc2FqYSk8L29wdGlvbj4KICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggZ2FwLTIiPgogICAgICAgICAgPGJ1dHRvbiBpZD0iYXBpLXNhdmUiIGNsYXNzPSJidG4gYnRuLWdob3N0IGZsZXgtMSBoLTggYm9yZGVyIGJkIHRleHQteHMiPlNpbXBhbjwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBpZD0iYXBpLXRlc3QiIGNsYXNzPSJidG4gYnRuLWdob3N0IGZsZXgtMSBoLTggYm9yZGVyIGJkIHRleHQteHMiPlRlczwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDwhLS0gQm90dG9tIC0tPgogICAgICA8ZGl2IGNsYXNzPSJwdC0xIGJvcmRlci10IGJkIHNwYWNlLXktMiI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1naG9zdCB3LWZ1bGwgaC05IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+UGFzdGUgR2VuZXJhdGlvbiBEYXRhPC9zcGFuPjxpIGRhdGEtaWNvbj0iY2xpcGJvYXJkIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOSBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlByZXNldHM8L3NwYW4+PGkgZGF0YS1pY29uPSJib29rbWFyay1zaW1wbGUiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1naG9zdCB3LWZ1bGwgaC05IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+UmVzZXQ8L3NwYW4+PGkgZGF0YS1pY29uPSJrZXkiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgPC9hc2lkZT4KCiAgPCEtLSBDRU5URVI6IGltYWdlIGdyaWQgb25seSAtLT4KICA8bWFpbiBpZD0iY2FudmFzIiBjbGFzcz0iZmxleC0xIG92ZXJmbG93LXktYXV0byBvdmVyZmxvdy14LWhpZGRlbiBiZy1bIzBkMTExN10iPgogICAgPGRpdiBjbGFzcz0icC00IG1heC13LTN4bCBteC1hdXRvIj4KCiAgICAgIDwhLS0gUHJvbXB0IGJhciAoVGVuc29yLkFydDogZGkgdGVuZ2FoIGF0YXMsIGRpIGF0YXMgZ3JpZCBnYW1iYXIpIC0tPgogICAgICA8ZGl2IGlkPSJwcm9tcHRiYXIiIGNsYXNzPSJtYi00IHJvdW5kZWQtMnhsIGJvcmRlciBiZCBiZy1bIzE2MWIyMl0gb3ZlcmZsb3ctaGlkZGVuIj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWxhdGl2ZSBweC00IHB0LTMiPgogICAgICAgICAgPHRleHRhcmVhIGlkPSJwcm9tcHQiIHJvd3M9IjMiIGNsYXNzPSJ3LWZ1bGwgYmctdHJhbnNwYXJlbnQgYm9yZGVyLTAgb3V0bGluZS1ub25lIHJlc2l6ZS15IHRleHQtWzE1cHhdIHRleHQtbmV1dHJhbC0xMDAgcGxhY2Vob2xkZXItbmV1dHJhbC02MDAgbGVhZGluZy1yZWxheGVkIHByLTEyIG1pbi1oLVs0LjVyZW1dIiBwbGFjZWhvbGRlcj0iSmVsYXNrYW4gYXBhIHlhbmcgaW5naW4ga2FtdSBidWF0Li4uIj48L3RleHRhcmVhPgogICAgICAgICAgPGRpdiBjbGFzcz0iYWJzb2x1dGUgdG9wLTMgcmlnaHQtMyBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMC41Ij4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0iYnRuLXRyYW5zbGF0ZSIgY2xhc3M9InctNyBoLTcgcm91bmRlZC1sZyBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB0ZXh0LW5ldXRyYWwtNDAwIGhvdmVyOnRleHQtd2hpdGUgaG92ZXI6YmctWyMyMTI2MmRdIHRyYW5zaXRpb24tY29sb3JzIiB0aXRsZT0iVGVyamVtYWhrYW4gcHJvbXB0IGtlIGJhaGFzYSBJbmdncmlzIChzZW11YSBiYWhhc2EpIj48aSBkYXRhLWljb249InRyYW5zbGF0ZSIgY2xhc3M9InctNCBoLTQiPjwvaT48L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0iYnRuLWVuaGFuY2UiIGNsYXNzPSJ3LTcgaC03IHJvdW5kZWQtbGcgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC1uZXV0cmFsLTQwMCBob3Zlcjp0ZXh0LXdoaXRlIGhvdmVyOmJnLVsjMjEyNjJkXSB0cmFuc2l0aW9uLWNvbG9ycyIgdGl0bGU9IlByb21wdCBFbmhhbmNlIOKAlCBwZXJsdWFzICYgcGVyYmFpa2kgcHJvbXB0IGRlbmdhbiBBSSI+PGkgZGF0YS1pY29uPSJtYWdpYy13YW5kIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0yIGZsZXgtd3JhcCBweC0zIHB5LTIgYm9yZGVyLXQgYmQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41IGN1cnNvci1wb2ludGVyIHNlbGVjdC1ub25lIj4KICAgICAgICAgICAgPGlucHV0IGlkPSJuZWdjaGVjayIgdHlwZT0iY2hlY2tib3giIGNsYXNzPSJhY2NlbnQtWyM2RjVERkZdIi8+CiAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAiPk5lZ2F0aXZlPC9zcGFuPgogICAgICAgICAgPC9sYWJlbD4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0yIGZsZXgtd3JhcCBqdXN0aWZ5LWVuZCI+CiAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJjaGlwIiBpZD0iY2hpcC1hMTExMSI+QTExMTE8L3NwYW4+CiAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJjaGlwIiBpZD0iY2hpcC1lbGxhIj5FbGxhPC9zcGFuPgogICAgICAgICAgICA8c2VsZWN0IGlkPSJuY291bnQiIGNsYXNzPSJpbnAgdy1bNS40cmVtXSB0ZXh0LXhzIGgtOCIgdGl0bGU9Ikp1bWxhaCBnYW1iYXIiPgogICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9IjEiIHNlbGVjdGVkPjEgaW1hZ2U8L29wdGlvbj4KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIyIj4yIGltYWdlczwvb3B0aW9uPgogICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9IjQiPjQgaW1hZ2VzPC9vcHRpb24+CiAgICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgICAgICA8YnV0dG9uIGlkPSJidG4tZ28iIGNsYXNzPSJidG4gYnRuLXR1cnEgaC05IHB4LTQgd2hpdGVzcGFjZS1ub3dyYXAiPgogICAgICAgICAgICAgIDxpIGRhdGEtaWNvbj0ibGlnaHRuaW5nIiBjbGFzcz0idy00IGgtNCI+PC9pPkdlbmVyYXRlCiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQteHMgb3BhY2l0eS05MCBmb250LW5vcm1hbCIgaWQ9InByaWNlIj4tIDEuMjI8L3NwYW4+CiAgICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBpZD0ibmVnd3JhcCIgY2xhc3M9ImhpZGRlbiBib3JkZXItdCBiZCBweC00IHB5LTMiPgogICAgICAgICAgPHRleHRhcmVhIGlkPSJuZWdwcm9tcHQiIHJvd3M9IjIiIGNsYXNzPSJ3LWZ1bGwgYmctdHJhbnNwYXJlbnQgYm9yZGVyLTAgb3V0bGluZS1ub25lIHJlc2l6ZS1ub25lIHRleHQtWzEzcHhdIHRleHQtbmV1dHJhbC0xMDAgcGxhY2Vob2xkZXItbmV1dHJhbC02MDAiIHBsYWNlaG9sZGVyPSJOZWdhdGl2ZSBwcm9tcHQuLi4iPjwvdGV4dGFyZWE+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBJbWcySW1nIHVwbG9hZCAtLT4KICAgICAgPGRpdiBpZD0iaW1nMmltZy1jYXJkIiBjbGFzcz0iaGlkZGVuIG1iLTQgYm9yZGVyIGJkIHJvdW5kZWQteGwgYmctWyMxNjFiMjJdIHAtNCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIG1iLTIiPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+SW1nMkltZyDigJQgZ2FtYmFyIGF3YWw8L3NwYW4+CiAgICAgICAgICA8c3BhbiBpZD0iaTJpLWNsZWFyIiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgY3Vyc29yLXBvaW50ZXIiPkhhcHVzPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImkyaS1kcm9wIiBjbGFzcz0iYm9yZGVyLTIgYm9yZGVyLWRhc2hlZCBiZCByb3VuZGVkLXhsIHAtNiB0ZXh0LWNlbnRlciBjdXJzb3ItcG9pbnRlciB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOmJvcmRlci1bIzZGNURGRl0gdGV4dC14cyI+CiAgICAgICAgICBLbGlrIGF0YXUgc2VyZXQgZ2FtYmFyIGtlIHNpbmkKICAgICAgICA8L2Rpdj4KICAgICAgICA8aW5wdXQgaWQ9ImkyaS1maWxlIiB0eXBlPSJmaWxlIiBhY2NlcHQ9ImltYWdlLyoiIGNsYXNzPSJoaWRkZW4iLz4KICAgICAgICA8ZGl2IGlkPSJpMmktcHJldmlldyIgY2xhc3M9ImhpZGRlbiBtdC0zIj4KICAgICAgICAgIDxpbWcgaWQ9ImkyaS1pbWciIGNsYXNzPSJ3LTQwIGgtNDAgb2JqZWN0LWNvdmVyIHJvdW5kZWQtbGcgYm9yZGVyIGJkIiBhbHQ9IiIvPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im10LTMiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5EZW5vaXNpbmcgU3RyZW5ndGg8L3NwYW4+PHNwYW4gaWQ9ImkyaS1kc3YiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj4wLjUwPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgaWQ9ImkyaS1kcyIgdHlwZT0icmFuZ2UiIG1pbj0iMCIgbWF4PSIxIiBzdGVwPSIwLjA1IiB2YWx1ZT0iMC41IiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIFRhYiBwbGFjZWhvbGRlciAoRWRpdC9WaWRlby9QcmltZSkgLS0+CiAgICAgIDxkaXYgaWQ9InRhYi1wbGFjZWhvbGRlciIgY2xhc3M9ImhpZGRlbiBmbGV4LWNvbCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgaC1bNTB2aF0gdGV4dC1uZXV0cmFsLTYwMCI+CiAgICAgICAgPGkgZGF0YS1pY29uPSJob3VyZ2xhc3MtbWVkaXVtIiBjbGFzcz0idy0xMiBoLTEyIG1iLTMiPjwvaT4KICAgICAgICA8cCBjbGFzcz0idGV4dC1zbSIgaWQ9InRhYi1wbGFjZWhvbGRlci10ZXh0Ij5UYWIgaW5pIHNlZ2VyYSBoYWRpcjwvcD4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGlkPSJlbXB0eSIgY2xhc3M9ImZsZXggZmxleC1jb2wgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGgtWzYwdmhdIHRleHQtbmV1dHJhbC02MDAiPgogICAgICAgIDxpIGRhdGEtaWNvbj0iaW1hZ2Utc3F1YXJlIiBjbGFzcz0idy0xNCBoLTE0IG1iLTMiPjwvaT4KICAgICAgICA8cCBjbGFzcz0idGV4dC1zbSI+SGFzaWwgZ2VuZXJhdGUgYWthbiB0YW1waWwgZGkgc2luaTwvcD4KICAgICAgICA8cCBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNzAwIG10LTEiPklzaSBwcm9tcHQgbGFsdSB0ZWthbiBHZW5lcmF0ZTwvcD4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgaWQ9ImdmaWx0ZXIiIGNsYXNzPSJoaWRkZW4gZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEgbWItMyB0ZXh0LXhzIj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJnZmlsIHNlbCIgZGF0YS1mPSJhbGwiPkFsbDwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImdmaWwiIGRhdGEtZj0idmlkZW8iPlZpZGVvPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iZ2ZpbCIgZGF0YS1mPSJpbWFnZSI+SW1hZ2U8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJnZmlsIiBkYXRhLWY9ImF1ZGlvIj5BdWRpbzwvYnV0dG9uPgogICAgICAgIDxzcGFuIGNsYXNzPSJmbGV4LTEiPjwvc3Bhbj4KICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTYwMCBwLTEiIHRpdGxlPSJMaXN0Ij48aSBkYXRhLWljb249Imxpc3QiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9zcGFuPgogICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNjAwIHAtMSIgdGl0bGU9IkdyaWQiPjxpIGRhdGEtaWNvbj0ic3F1YXJlcy1mb3VyIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvc3Bhbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgaWQ9ImdyaWQiIGNsYXNzPSJzcGFjZS15LTMiPjwvZGl2PgogICAgPC9kaXY+CiAgPC9tYWluPgoKICA8IS0tIFJJR0hUIFBBTkVMIC0tPgogIDxhc2lkZSBpZD0icmlnaHRQYW4iIGNsYXNzPSJ3LVsyMXJlbV0gc2hyaW5rLTAgYm9yZGVyLWwgYmQgYmctWyMxNjFiMjJdIGhpZGRlbiBsZzpmbGV4IGZsZXgtY29sIj4KICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBweC0zIHB5LTIgYm9yZGVyLWIgYmQiPgogICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIiBpZD0icnB0aXRsZSI+VGV4dCB0byBJbWFnZTwvc3Bhbj4KICAgICAgPGRpdiBjbGFzcz0iZmxleCBnYXAtMSI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0icnRhYiBzZWwiIGRhdGEtcD0iZGV0YWlsIj5EZXRhaWw8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJydGFiIiBkYXRhLXA9Imhpc3RvcnkiPlJpd2F5YXQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDwhLS0gRGV0YWlsIGhhc2lsIGFrdGlmIChzZXBlcnRpIFRlbnNvci5BcnQ6IElucHV0ICsgRGV0YWlscyArIHBhcmFtcykgLS0+CiAgICA8ZGl2IGlkPSJyZGV0YWlsIiBjbGFzcz0iZmxleC0xIG92ZXJmbG93LXktc2Nyb2xsIHAtMyBzcGFjZS15LTMiPjwvZGl2PgogICAgPCEtLSBSaXdheWF0IGdlbmVyYXRlIChrYXJ0dSkgLS0+CiAgICA8ZGl2IGlkPSJyaGlzdG9yeSIgY2xhc3M9ImhpZGRlbiBmbGV4LTEgb3ZlcmZsb3cteS1zY3JvbGwgcC0yIHNwYWNlLXktMyI+CiAgICAgIDxwIGlkPSJyY291bnQiIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgcHgtMSBwdC0xIj4wIGhhc2lsPC9wPgogICAgICA8ZGl2IGlkPSJybGlzdCIgY2xhc3M9InNwYWNlLXktMyI+PC9kaXY+CiAgICA8L2Rpdj4KICA8L2FzaWRlPgo8L2Rpdj4KCjwhLS0gTW9iaWxlIGhpc3RvcnkgdG9nZ2xlIC0tPgo8YnV0dG9uIGlkPSJidG4taGlzdG9yeSIgY2xhc3M9ImxnOmhpZGRlbiBmaXhlZCBib3R0b20tNCByaWdodC00IHotMzAgYnRuIGJ0bi1ibHVlIGgtMTEgcHgtNCI+PGkgZGF0YS1pY29uPSJjbG9jay1jb3VudGVyLWNsb2Nrd2lzZSIgY2xhc3M9InctNCBoLTQiPjwvaT4gUml3YXlhdDwvYnV0dG9uPgoKPCEtLSA9PT09PT09PT09PT0gUFJPR1JFU1MgT1ZFUkxBWSA9PT09PT09PT09PT0gLS0+CjxkaXYgaWQ9InByb2dvdmVybGF5IiBjbGFzcz0iaGlkZGVuIGZpeGVkIGluc2V0LTAgei0zMCBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBiZy1ibGFjay81MCBwLTQiIHN0eWxlPSJ0b3A6NTZweCI+CiAgPGRpdiBjbGFzcz0idy1mdWxsIG1heC13LXNtIGJnLVsjMTYxYjIyXSBib3JkZXIgYmQgcm91bmRlZC0yeGwgcC01IHNwYWNlLXktMyI+CiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4iPgogICAgICA8c3BhbiBpZD0icHJvZy10aXRsZSIgY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+R2VuZXJhdGluZy4uLjwvc3Bhbj4KICAgICAgPGJ1dHRvbiBpZD0icHJvZy1jYW5jZWwiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgdGV4dC1sZyBsZWFkaW5nLW5vbmUiIHRpdGxlPSJCYXRhbCI+4pyVPC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InJlbGF0aXZlIGgtMiBiZy1bIzFjMjEyOF0gcm91bmRlZC1mdWxsIG92ZXJmbG93LWhpZGRlbiI+CiAgICAgIDxkaXYgaWQ9InByb2ctYmFyIiBjbGFzcz0iYWJzb2x1dGUgaW5zZXQteS0wIGxlZnQtMCB3LTAgcm91bmRlZC1mdWxsIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiwjMjdENENEKTt0cmFuc2l0aW9uOndpZHRoIC40cyI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiB0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAiPgogICAgICA8c3BhbiBpZD0icHJvZy1zdGF0dXMiPk1lbmdpcmltIHRhc2suLi48L3NwYW4+CiAgICAgIDxzcGFuIGlkPSJwcm9nLXBjdCI+MCU8L3NwYW4+CiAgICA8L2Rpdj4KICA8L2Rpdj4KPC9kaXY+Cgo8IS0tID09PT09PT09PT09PSBMSUdIVEJPWCA9PT09PT09PT09PT0gLS0+CjxkaXYgaWQ9ImxpZ2h0Ym94IiBjbGFzcz0iZml4ZWQgaW5zZXQtMCB6LTUwIGhpZGRlbiBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcC00IGJnLWJsYWNrLzgwIj4KICA8ZGl2IGNsYXNzPSJyZWxhdGl2ZSBtYXgtdy0zeGwgdy1mdWxsIGJnLVsjMTYxYjIyXSBib3JkZXIgYmQgcm91bmRlZC0yeGwgb3ZlcmZsb3ctaGlkZGVuIj4KICAgIDxidXR0b24gaWQ9ImxiLWNsb3NlIiBjbGFzcz0iYWJzb2x1dGUgdG9wLTIgcmlnaHQtMiB6LTEwIHctOSBoLTkgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC13aGl0ZSBob3ZlcjpiZy13aGl0ZS8xMCByb3VuZGVkLWxnIHRleHQteGwiPuKclTwvYnV0dG9uPgogICAgPGltZyBpZD0ibGItaW1nIiBjbGFzcz0idy1mdWxsIG1heC1oLVs2MHZoXSBvYmplY3QtY29udGFpbiBiZy1ibGFjayIgYWx0PSIiLz4KICAgIDxkaXYgaWQ9ImxiLW1ldGEiIGNsYXNzPSJwLTQgc3BhY2UteS0xLjUgdGV4dC14cyB0ZXh0LW5ldXRyYWwtNDAwIG92ZXJmbG93LXktYXV0byBtYXgtaC1bMzB2aF0iPjwvZGl2PgogIDwvZGl2Pgo8L2Rpdj4KCjwhLS0gPT09PT09PT09PT09IFBST01QVCBFTkhBTkNFIChoYXNpbCByZWZpbmUsIGtvbmZpcm1hc2kgZHVsdSkgPT09PT09PT09PT09IC0tPgo8ZGl2IGlkPSJlbmgtbW9kYWwiIGNsYXNzPSJmaXhlZCBpbnNldC0wIHotNTAgaGlkZGVuIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBwLTQgYmctYmxhY2svNzAiPgogIDxkaXYgY2xhc3M9InctZnVsbCBtYXgtdy14bCBiZy1bIzE2MWIyMl0gYm9yZGVyIGJkIHJvdW5kZWQtMnhsIG92ZXJmbG93LWhpZGRlbiI+CiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gcHgtNCBweS0zIGJvcmRlci1iIGJkIj4KICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41Ij48aSBkYXRhLWljb249Im1hZ2ljLXdhbmQiIGNsYXNzPSJ3LTQgaC00IHRleHQtWyM2RjVERkZdIj48L2k+UHJvbXB0IEVuaGFuY2U8L3NwYW4+CiAgICAgIDxidXR0b24gaWQ9ImVuaC1jbG9zZSIgY2xhc3M9InctOCBoLTggZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC1uZXV0cmFsLTQwMCBob3Zlcjp0ZXh0LXdoaXRlIGhvdmVyOmJnLXdoaXRlLzUgcm91bmRlZC1sZyI+4pyVPC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InAtNCBzcGFjZS15LTMiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAgbWItMSI+UHJvbXB0IGFzbGk8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJlbmgtb3JpZyIgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTQwMCBiZy1ibGFjay80MCBib3JkZXIgYmQgcm91bmRlZC1sZyBwLTMgbWF4LWgtMjQgb3ZlcmZsb3cteS1hdXRvIGxlYWRpbmctcmVsYXhlZCI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAgbWItMSI+SGFzaWwgRW5oYW5jZSA8c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTYwMCI+KGJpc2EgZGllZGl0KTwvc3Bhbj48L2Rpdj4KICAgICAgICA8dGV4dGFyZWEgaWQ9ImVuaC10ZXh0IiByb3dzPSI1IiBjbGFzcz0idy1mdWxsIGJnLWJsYWNrLzQwIGJvcmRlciBiZCByb3VuZGVkLWxnIHAtMyB0ZXh0LXhzIHRleHQtbmV1dHJhbC0xMDAgb3V0bGluZS1ub25lIHJlc2l6ZS1ub25lIGZvY3VzOmJvcmRlci1bIzZGNURGRl0gbGVhZGluZy1yZWxheGVkIj48L3RleHRhcmVhPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0yIj4KICAgICAgICA8YnV0dG9uIGlkPSJlbmgtcmVnZW4iIGNsYXNzPSJidG4gYnRuLWdob3N0IGgtOSBweC0zIHRleHQteHMiPjxpIGRhdGEtaWNvbj0iYXJyb3dzLWNsb2Nrd2lzZSIgY2xhc3M9InctMy41IGgtMy41Ij48L2k+R2VuZXJhdGUgbGFnaTwvYnV0dG9uPgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggZ2FwLTIiPgogICAgICAgICAgPGJ1dHRvbiBpZD0iZW5oLWNhbmNlbCIgY2xhc3M9ImJ0biBidG4tZ2hvc3QgaC05IHB4LTQgdGV4dC14cyI+QmF0YWw8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gaWQ9ImVuaC11c2UiIGNsYXNzPSJidG4gYnRuLWJsdWUgaC05IHB4LTQgdGV4dC14cyI+UGFrYWkgcHJvbXB0IGluaTwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvZGl2Pgo8L2Rpdj4KCjwhLS0gPT09PT09PT09PT09IFRPQVNUID09PT09PT09PT09PSAtLT4KPGRpdiBpZD0idG9hc3QiIGNsYXNzPSJmaXhlZCBib3R0b20tMjAgbGVmdC0xLzIgLXRyYW5zbGF0ZS14LTEvMiB6LTUwIGhpZGRlbiBiZy1bIzFjMjEyOF0gYm9yZGVyIGJkIHJvdW5kZWQteGwgcHgtNCBweS0yLjUgdGV4dC1zbSBzaGFkb3ctbGcgbWF4LXctWzg1dnddIj48L2Rpdj4KCjwhLS0gPT09PT09PT09PT09IFNFTEVDVE9SIE1PREFMID09PT09PT09PT09PSAtLT4KPGRpdiBpZD0ibW9kYWwiIGNsYXNzPSJmaXhlZCBpbnNldC0wIGJnLWJsYWNrLzYwIHotNTAgaGlkZGVuIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBwLTQiPgogIDxkaXYgY2xhc3M9InctZnVsbCBtYXgtdy01eGwgYmctWyMxNjFiMjJdIGJvcmRlciBiZCByb3VuZGVkLTJ4bCBvdmVyZmxvdy1oaWRkZW4iPgogICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIHB4LTQgcHQtMyBwYi0yIGJvcmRlci1iIGJkIj4KICAgICAgPGRpdiBpZD0ibW9kYWwtdGFicyIgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xIj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJtdGFiIHNlbCIgZGF0YS1tdGFiPSJiYXNpYyI+QmFzaWMgTW9kZWw8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJtdGFiIiBkYXRhLW10YWI9InN0YXJyZWQiPk15IFN0YXJyZWQ8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJtdGFiIiBkYXRhLW10YWI9Im15bW9kZWxzIj5NeSBNb2RlbHM8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0yIj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWxhdGl2ZSI+CiAgICAgICAgICA8aSBkYXRhLWljb249Im1hZ25pZnlpbmctZ2xhc3MiIGNsYXNzPSJ3LTQgaC00IGFic29sdXRlIGxlZnQtMyB0b3AtMS8yIC10cmFuc2xhdGUteS0xLzIgdGV4dC1uZXV0cmFsLTUwMCI+PC9pPgogICAgICAgICAgPGlucHV0IGlkPSJtc2VhcmNoIiBjbGFzcz0iaW5wIHBsLTkgdy01NiBoLTkiIHBsYWNlaG9sZGVyPSJTZWFyY2guLi4iLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8YnV0dG9uIGlkPSJtZmlsdGVycyIgY2xhc3M9ImJ0biBidG4tZ2hvc3QgaC05IHB4LTMgYm9yZGVyIGJkIHRleHQteHMgc2hyaW5rLTAiPjxpIGRhdGEtaWNvbj0ic2xpZGVycy1ob3Jpem9udGFsIiBjbGFzcz0idy00IGgtNCI+PC9pPkZpbHRlcnM8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGlkPSJtb2RhbC1jbG9zZSIgY2xhc3M9InctOSBoLTkgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC13aGl0ZSBob3ZlcjpiZy1bIzFjMjEyOF0gcm91bmRlZC1sZyB0ZXh0LXhsIGxlYWRpbmctbm9uZSIgdGl0bGU9IlR1dHVwIj7inJU8L2J1dHRvbj4KICAgICAgICA8aDMgaWQ9Im1vZGFsLXRpdGxlIiBjbGFzcz0iaGlkZGVuIGZvbnQtc2VtaWJvbGQgdGV4dC1zbSI+UGlsaWggTW9kZWw8L2gzPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0ibWNhdCIgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUgcHgtNCBweS0yIGhpZGViYXIgb3ZlcmZsb3cteC1hdXRvIj48L2Rpdj4KICAgIDxkaXYgaWQ9Im1vZGFsLWJvZHkiIGNsYXNzPSJtYXgtaC1bNTV2aF0gb3ZlcmZsb3cteS1hdXRvIHAtNCI+PC9kaXY+CiAgPC9kaXY+CjwvZGl2PgoKCjxzY3JpcHQ+CmNvbnN0ICQgPSBpZCA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CmNvbnN0IFMgPSAnaHR0cHM6Ly9waWNzdW0ucGhvdG9zL3NlZWQvJzsKY29uc3Qgc3RhdGUgPSB7IHJlc3VsdHM6W10sIHBhZ2U6J3RleHQnLCBhc3BlY3Q6J3BvcnRyYWl0JywgbmNvbDoxLCBtb2RlbDpudWxsIH07CgovKiA9PT09PSBMb1JBIOKAlCBkYWZ0YXIgYXNsaSBwZXIgcHJvdmlkZXIgPT09PT0gKi8KdmFyIExPUkFfTElCUyA9IHsKICB0YW1zOiBbCiAgICB7IG5hbWU6J1otSW1hZ2UgTG9SQSB8IERldGFpbCcsIHRhZ3M6WydkZXRhaWxlZCcsJ3NoYXJwJ10sIHRodW1iOidhZnJvJywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMTJLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sCiAgICB7IG5hbWU6J1otSW1hZ2UgVHVyYm8nLCB0YWdzOlsndHVyYm8nLCdmYXN0J10sIHRodW1iOidyZXRybycsIGJhZGdlOidaLUlNQUdFLVRVUkJPJywgdmlld3M6JzhLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sCiAgICB7IG5hbWU6J1otSW1hZ2UgSERSJywgdGFnczpbJ2hkcicsJ3ZpdmlkJ10sIHRodW1iOidoZHInLCBiYWRnZTonWi1JTUFHRScsIHZpZXdzOicxNUsnLCB2ZXI6J1YxJywgYmFzZTonWiBJbWFnZScgfSwKICAgIHsgbmFtZTonWi1JbWFnZSBQb3J0cmFpdCcsIHRhZ3M6Wydwb3J0cmFpdCcsJ2Jva2VoJ10sIHRodW1iOidwdHJ0JywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMjJLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sCiAgICB7IG5hbWU6J1otSW1hZ2UgQXJ0aXN0aWMnLCB0YWdzOlsnYXJ0aXN0aWMnLCdwYWludCddLCB0aHVtYjonYXJ0JywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMThLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sCiAgICB7IG5hbWU6J0ZsdXggUmVhbGlzbSBMb1JBJywgdGFnczpbJ3JlYWxpc3RpYycsJ3Bob3RvJ10sIHRodW1iOidmbHV4bCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzQ1SycsIHZlcjonVjEnLCBiYXNlOidGTFVYLjEnIH0sCiAgICB7IG5hbWU6J0ZsdXggQ2luZW1hdGljIExvUkEnLCB0YWdzOlsnY2luZW1hdGljJywnbW9vZHknXSwgdGh1bWI6J2ZsdXhjJywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonMzNLJywgdmVyOidWMScsIGJhc2U6J0ZMVVguMScgfSwKICAgIHsgbmFtZTonU0RYTCBGaW5lIERldGFpbCcsIHRhZ3M6WydkZXRhaWxlZCcsJ3NoYXJwJ10sIHRodW1iOidkZXRhaWwnLCBiYWRnZTonU0RYTCcsIHZpZXdzOic1MDBLJywgdmVyOidWMScsIGJhc2U6J1NEWEwnIH0sCiAgICB7IG5hbWU6J1NEWEwgQW5pbWUgU3R5bGUnLCB0YWdzOlsnYW5pbWUnLCdjZWwnXSwgdGh1bWI6J2FuaW1lc2wnLCBiYWRnZTonU0RYTCcsIHZpZXdzOicyODBLJywgdmVyOidWMScsIGJhc2U6J1NEWEwnIH0sCiAgICB7IG5hbWU6J1BvbnkgRXF1ZXN0cmlhbiBBcnQnLCB0YWdzOlsncG9ueScsJ2ZhbnRhc3knXSwgdGh1bWI6J3BvbnlsJywgYmFkZ2U6J1BPTlknLCB2aWV3czonMTUwSycsIHZlcjonVjEnLCBiYXNlOidQb255JyB9LAogICAgeyBuYW1lOidOaXBwb24tQ29yZSBSZXRybyAtIHYwLjEnLCB0YWdzOlsnamFwcmV0cjdjb21tJywncmV0cm8gbWFnYXppbmUnXSwgdGh1bWI6J2JpbGliaW4nLCBiYWRnZTonU1RZTEUnLCB2aWV3czonOTZLJywgdmVyOidWLjEnLCBiYXNlOidTRFhMJyB9LAogICAgeyBuYW1lOidJdmFuIEJpbGliaW4gLSB2MC43JywgdGFnczpbJ2l2YW5iaWxpYmluNXonLCdpbGx1c3RyYXRpb24nLCdhcnQgZGVjbyddLCB0aHVtYjonZGV0YWlsJywgYmFkZ2U6J0lMTFVTVFJBVElPTicsIHZpZXdzOicxNTRLJywgdmVyOidWLjEnLCBiYXNlOidTRFhMJyB9LAogICAgeyBuYW1lOidEZXRhaWwgVHdlYWtlciAtIHYxLjAnLCB0YWdzOlsnZGV0YWlsZWQnXSwgdGh1bWI6J2dyYWluJywgYmFkZ2U6J1VUSUxJVFknLCB2aWV3czonMS4yTScsIHZlcjonVi4xJywgYmFzZTonU0RYTCcgfSwKICAgIHsgbmFtZTonRmlsbSBHcmFpbiAtIHYwLjUnLCB0YWdzOlsnZmlsbSBncmFpbicsJ2FuYWxvZyddLCB0aHVtYjonZ3JhaW4nLCBiYWRnZTonVVRJTElUWScsIHZpZXdzOic2N0snLCB2ZXI6J1YuMScsIGJhc2U6J1NEWEwnIH0sCiAgXSwKICByZXBsaWNhdGU6IFsKICAgIHsgbmFtZTonRkxVWC4xIFtzY2huZWxsXSBMb1JBJywgYmFzZTonRkxVWCcsIG1vZGVsOidibGFjay1mb3Jlc3QtbGFicy9mbHV4LXNjaG5lbGwtbG9yYScsIHRhZ3M6WydmbHV4LWxvcmEnXSwgdGh1bWI6J2ZsdXhsJywgYmFkZ2U6J0ZMVVgtTE9SQScsIHZpZXdzOicxMjBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogICAgeyBuYW1lOidGTFVYLjEgW2Rldl0gTG9SQScsIGJhc2U6J0ZMVVgnLCBtb2RlbDonYmxhY2stZm9yZXN0LWxhYnMvZmx1eC1kZXYtbG9yYScsIHRhZ3M6WydmbHV4LWxvcmEnXSwgdGh1bWI6J2ZsdXhkbCcsIGJhZGdlOidGTFVYLUxPUkEnLCB2aWV3czonOTBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogICAgeyBuYW1lOidTRFhMICsgTG9SQSBVUkwgKGN1c3RvbSknLCBiYXNlOidTRFhMJywgbW9kZWw6J3p5bGltMDcwMi9zZHhsLWxvcmEtY3VzdG9taXplLW1vZGVsJywgdGFnczpbJ2xvcmEnXSwgdGh1bWI6J3NkeGxsJywgYmFkZ2U6J1NEWEwtTE9SQScsIHZpZXdzOiczMTBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogICAgeyBuYW1lOidJS0VBIEluc3RydWN0aW9ucyAoU0RYTCwgYmF3YWFuKScsIGJhc2U6J1NEWEwnLCBtb2RlbDonb3N0cmlzL2lrZWEtaW5zdHJ1Y3Rpb25zLWxvcmEtc2R4bCcsIHRhZ3M6Wydpa2VhIGluc3RydWN0aW9ucyddLCB0aHVtYjonaWtlYScsIGJhZGdlOidTVFlMRScsIHZpZXdzOicyMTBLJywgdmVyOidWMScgfSwKICBdLAogIGZhbDogWwogICAgeyBuYW1lOidGTFVYIExvUkEnLCBiYXNlOidGTFVYJywgbW9kZWw6J2ZhbC1haS9mbHV4LWxvcmEnLCB0YWdzOlsnZmx1eC1sb3JhJ10sIHRodW1iOidmbHV4bCcsIGJhZGdlOidGTFVYLUxPUkEnLCB2aWV3czonMTUwSycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwKICAgIHsgbmFtZTonU0RYTCArIExvUkEgVVJMIChmYXN0LXNkeGwpJywgYmFzZTonU0RYTCcsIG1vZGVsOidmYWwtYWkvZmFzdC1zZHhsJywgdGFnczpbJ2xvcmEnXSwgdGh1bWI6J3NkeGxsJywgYmFkZ2U6J1NEWEwtTE9SQScsIHZpZXdzOicxMjBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogICAgeyBuYW1lOidLcmVhIDIgTG9SQSAodHVyYm8pJywgYmFzZTonS3JlYSAyJywgbW9kZWw6J2ZhbC1haS9rcmVhLTIvdHVyYm8vbG9yYScsIHRhZ3M6WydrcmVhMiddLCB0aHVtYjona3JlYScsIGJhZGdlOidLUkVBMi1MT1JBJywgdmlld3M6JzY2SycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwKICBdLAogIHBvbGxpbmF0aW9uczogW10sIC8vIExvUkEgdGlkYWsgZGlkdWt1bmcg4oCUIGdyYXRpcywgbW9kZWwgYmF3YWFuIHNhamEKfTsKdmFyIExPUkFfTElCID0gTE9SQV9MSUJTLnRhbXM7IC8vIGRhZnRhciBha3RpZiBtZW5naWt1dGkgcHJvdmlkZXIKY29uc3QgTE9SQSA9IFtdOwovKiA9PT09PSBNb2RlbCBtb2RhbCDigJQgZGFmdGFyIG1vZGVsIGFzbGkgcGVyIHByb3ZpZGVyID09PT09ICovCnZhciBNT0RFTF9MSUJTID0gewogIHRhbXM6IFsKICAgIHsgbmFtZTonWiBJbWFnZSAtIGJhc2UtYmYxNicsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonWiBJbWFnZScsIHRodW1iOid6aW1hZ2UnLCBiYWRnZTonWicsIHZpZXdzOic0NEsnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYyNTMyNjA2MDM4MDUnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjI1NDMzNDM2NjI0NScgfSwKICAgIHsgbmFtZTonRkxVWC4xIFtkZXZdJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidGTFVYLjEnLCB0aHVtYjonZmx1eCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzE1NEsnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYyODI2NDQ1MjUwNTYnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjI4MjY0NDUyNTA1NycgfSwKICAgIHsgbmFtZTonU3RhYmxlIERpZmZ1c2lvbiBYTCcsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonU0RYTCcsIHRodW1iOidzZHhsJywgYmFkZ2U6J1NEWEwgMS4wJywgdmlld3M6Jzg5MksnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYzMDkwMzIxMzY3MDQnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjMwOTAzMjEzNjcwNScgfSwKICAgIHsgbmFtZTonU3RhYmxlIERpZmZ1c2lvbiAzLjUgTWVkaXVtJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRCAzLjUnLCB0aHVtYjonc2QzNScsIGJhZGdlOidTRCAzLjUnLCB2aWV3czonMzEySycsIHZlcjonVi4xJywgbW9kZWxJZDonMTAyNzkwNjMxNzQ1MjgwODE5MicsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzE3NDUyODA4MTkzJyB9LAogICAgeyBuYW1lOidQb255IERpZmZ1c2lvbiBWNicsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonUG9ueScsIHRodW1iOidwb255JywgYmFkZ2U6J1BPTlknLCB2aWV3czonMi4xTScsIHZlcjonVjYnLCBtb2RlbElkOicxMDI3OTA2MzI2ODc0MjcxNzQ0JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzMjY4NzQyNzE3NDUnIH0sCiAgICB7IG5hbWU6J0lsbHVzdHJpb3VzIFhMJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidJbGx1c3RyaW91cycsIHRodW1iOidpbGx1c3QnLCBiYWRnZTonSUxMVVNUUklPVVMnLCB2aWV3czonNjdLJywgdmVyOidWLjEnLCBtb2RlbElkOicxMDI3OTA2MzM1NzgyNDE0MzM2JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzMzU3ODI0MTQzMzcnIH0sCiAgICB7IG5hbWU6J0FuaW1hJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidBbmltYScsIHRodW1iOidhbmltYScsIGJhZGdlOidBTklNQScsIHZpZXdzOic1MksnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYzNDQ3MTY3NzE4NDAnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM0NDcxNjc3MTg0MScgfSwKICAgIHsgbmFtZTonRHJlYW1TaGFwZXInLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonZHJlYW0nLCBiYWRnZTonRFMnLCB2aWV3czonODEySycsIHZlcjonVi41JywgbW9kZWxJZDonMTAyNzkwNjM1MzQ5OTQyOTg4OCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzUzNDk5NDI5ODg5JyB9LAogICAgeyBuYW1lOidSZWFsaXN0aWMgVmlzaW9uJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J3JlYWwnLCBiYWRnZTonUlYnLCB2aWV3czonNjQ1SycsIHZlcjonVi42LjAnLCBtb2RlbElkOicxMDI3OTA2MzYyNDEyNTMxNzEyJywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzNjI0MTI1MzE3MTMnIH0sCiAgICB7IG5hbWU6J0NvdW50ZXJmZWl0JywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J2NvdW50ZXInLCBiYWRnZTonQ09VTlRFUkZFSVQnLCB2aWV3czonNDIwSycsIHZlcjonVi41JywgbW9kZWxJZDonMTAyNzkwNjM3MTMzNDcyNzY4MCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzcxMzM0NzI3NjgxJyB9LAogICAgeyBuYW1lOidMeXJpZWwnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonbHlyaWVsJywgYmFkZ2U6J0xZUklFTCcsIHZpZXdzOiczMjBLJywgdmVyOidWLjEuNicsIG1vZGVsSWQ6JzEwMjc5MDYzNzk5OTYwMTM1NjgnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM3OTk5NjAxMzU2OScgfSwKICAgIHsgbmFtZTonSnVnZ2VybmF1dCcsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonU0RYTCcsIHRodW1iOidqdWcnLCBiYWRnZTonSlVHRycsIHZpZXdzOicyMTBLJywgdmVyOidWLjknLCBtb2RlbElkOicxMDI3OTA2Mzg4NDIxMDk5NTIwJywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzODg0MjEwOTk1MjEnIH0sCiAgXSwKICByZXBsaWNhdGU6IFsKICAgIHsgbmFtZTonRkxVWC4xIFtzY2huZWxsXScsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J0ZMVVgnLCB0aHVtYjonZmx1eCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzRNJywgdmVyOidWMScsIG1vZGVsOidibGFjay1mb3Jlc3QtbGFicy9mbHV4LXNjaG5lbGwnIH0sCiAgICB7IG5hbWU6J0ZMVVguMSBbZGV2XScsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J0ZMVVgnLCB0aHVtYjonZmx1eGQnLCBiYWRnZTonRkxVWCcsIHZpZXdzOicyLjFNJywgdmVyOidWMScsIG1vZGVsOidibGFjay1mb3Jlc3QtbGFicy9mbHV4LWRldicgfSwKICAgIHsgbmFtZTonU0RYTCAxLjAnLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J3NkeGwnLCBiYWRnZTonU0RYTCAxLjAnLCB2aWV3czonMS4yTScsIHZlcjonVjEnLCBtb2RlbDonc3RhYmlsaXR5LWFpL3NkeGwnIH0sCiAgICB7IG5hbWU6J1N0YWJsZSBEaWZmdXNpb24gMy41IExhcmdlJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0QgMy41JywgdGh1bWI6J3NkMzUnLCBiYWRnZTonU0QgMy41Jywgdmlld3M6JzEuNU0nLCB2ZXI6J1YxJywgbW9kZWw6J3N0YWJpbGl0eS1haS9zdGFibGUtZGlmZnVzaW9uLTMuNS1sYXJnZScgfSwKICAgIHsgbmFtZTonU0RYTCBMaWdodG5pbmcgNC1TdGVwJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0RYTCcsIHRodW1iOidsaWdodG5pbmcnLCBiYWRnZTonTElHSFROSU5HJywgdmlld3M6JzEuOE0nLCB2ZXI6J1YxJywgbW9kZWw6J2J5dGVkYW5jZS9zZHhsLWxpZ2h0bmluZy00c3RlcCcgfSwKICAgIHsgbmFtZTonUmVhbFZpc1hMIFY0LjAnLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J3JlYWwnLCBiYWRnZTonUkVBTElTVElDJywgdmlld3M6JzkwMEsnLCB2ZXI6J1Y0LjAnLCBtb2RlbDonbHVjYXRhY28vcmVhbHZpc3hsLXY0LjAnIH0sCiAgICB7IG5hbWU6J0p1Z2dlcm5hdXQgWEwgVjknLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J2p1ZycsIGJhZGdlOidKVUdHJywgdmlld3M6Jzc1MEsnLCB2ZXI6J1Y5JywgbW9kZWw6J2RpZ2lwbGF5L0p1Z2dlcm5hdXRfWExfdjknIH0sCiAgICB7IG5hbWU6J1NEWEwgRW1vamknLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J2Vtb2ppJywgYmFkZ2U6J0VNT0pJJywgdmlld3M6JzYwMEsnLCB2ZXI6J1YxJywgbW9kZWw6J2ZvZnIvc2R4bC1lbW9qaScgfSwKICBdLAogIGZhbDogWwogICAgeyBuYW1lOidGTFVYLjEgW3NjaG5lbGxdJywgYmFzZTonZmFsLmFpJywgYXJjaDonRkxVWCcsIHRodW1iOidmbHV4JywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonNU0nLCB2ZXI6J1YxJywgbW9kZWw6J2ZhbC1haS9mbHV4L3NjaG5lbGwnIH0sCiAgICB7IG5hbWU6J0ZMVVguMSBbZGV2XScsIGJhc2U6J2ZhbC5haScsIGFyY2g6J0ZMVVgnLCB0aHVtYjonZmx1eGQnLCBiYWRnZTonRkxVWCcsIHZpZXdzOiczTScsIHZlcjonVjEnLCBtb2RlbDonZmFsLWFpL2ZsdXgvZGV2JyB9LAogICAgeyBuYW1lOidGYXN0IFNEWEwnLCBiYXNlOidmYWwuYWknLCBhcmNoOidTRFhMJywgdGh1bWI6J2Zhc3RzZHhsJywgYmFkZ2U6J0ZBTCcsIHZpZXdzOicyLjVNJywgdmVyOidWMScsIG1vZGVsOidmYWwtYWkvZmFzdC1zZHhsJyB9LAogICAgeyBuYW1lOidTRFhMJywgYmFzZTonZmFsLmFpJywgYXJjaDonU0RYTCcsIHRodW1iOidzZHhsJywgYmFkZ2U6J1NEWEwgMS4wJywgdmlld3M6JzEuMU0nLCB2ZXI6J1YxJywgbW9kZWw6J2ZhbC1haS9zZHhsJyB9LAogICAgeyBuYW1lOidTdGFibGUgRGlmZnVzaW9uIDMuNSBMYXJnZScsIGJhc2U6J2ZhbC5haScsIGFyY2g6J1NEIDMuNScsIHRodW1iOidzZDM1JywgYmFkZ2U6J1NEIDMuNScsIHZpZXdzOic5MDBLJywgdmVyOidWMScsIG1vZGVsOidmYWwtYWkvc3RhYmxlLWRpZmZ1c2lvbi12MzUtbGFyZ2UnIH0sCiAgICB7IG5hbWU6J1BsYXlncm91bmQgdjIuNScsIGJhc2U6J2ZhbC5haScsIGFyY2g6J1NEWEwnLCB0aHVtYjoncGxheScsIGJhZGdlOidQTEFZJywgdmlld3M6JzcwMEsnLCB2ZXI6J1YyLjUnLCBtb2RlbDonZmFsLWFpL3BsYXlncm91bmQvdjIuNScgfSwKICAgIHsgbmFtZTonS3JlYSAyIFR1cmJvJywgYmFzZTonZmFsLmFpJywgYXJjaDonS3JlYSAyJywgdGh1bWI6J2tyZWEnLCBiYWRnZTonS1JFQTInLCB2aWV3czonMS4xTScsIHZlcjonVjInLCBtb2RlbDonZmFsLWFpL2tyZWEtMi90dXJibycgfSwKICBdLAogIHBvbGxpbmF0aW9uczogWwogICAgeyBuYW1lOidaLUltYWdlIFR1cmJvJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonQWxpYmFiYScsIHRodW1iOid6aW1hZ2UnLCBiYWRnZTonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J3ppbWFnZScgfSwKICAgIHsgbmFtZTonR1BUIEltYWdlIDInLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidPcGVuQUknLCB0aHVtYjonZ3B0JywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidncHQtaW1hZ2UtMicgfSwKICAgIHsgbmFtZTonRkxVWC4xIFNjaG5lbGwnLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidCbGFjayBGb3Jlc3QgTGFicycsIHRodW1iOidmbHV4JywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidmbHV4JyB9LAogICAgeyBuYW1lOidEcmVhbVNoYXBlciA4IExDTScsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0x5a29uJywgdGh1bWI6J2RyZWFtJywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidkcmVhbXNoYXBlcicgfSwKICAgIHsgbmFtZTonRkxVWC4yIEtsZWluIDRCJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonQmxhY2sgRm9yZXN0IExhYnMnLCB0aHVtYjona2xlaW4nLCBiYWRnZTonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J2tsZWluJyB9LAogICAgeyBuYW1lOidLcmVhIDIgTWVkaXVtJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonS3JlYScsIHRodW1iOidrcmVhJywgYmFkZ2U6J1BBSUQnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidrcmVhJyB9LAogICAgeyBuYW1lOidTZWVkcmVhbSA1LjAgTGl0ZScsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0J5dGVEYW5jZScsIHRodW1iOidzZWVkJywgYmFkZ2U6J1BBSUQnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidzZWVkcmVhbTUnIH0sCiAgICB7IG5hbWU6J1F3ZW4gSW1hZ2UgMycsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J1F3ZW4nLCB0aHVtYjoncXdlbicsIGJhZGdlOidQQUlEJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDoncXdlbi1pbWFnZS0zJyB9LAogICAgeyBuYW1lOidOYW5vIEJhbmFuYSAyJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonR29vZ2xlJywgdGh1bWI6J25hbm8nLCBiYWRnZTonUEFJRCcsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J25hbm9iYW5hbmEtMicgfSwKICBdLAp9Owp2YXIgTU9ERUxTID0gTU9ERUxfTElCUy50YW1zOyAvLyBkYWZ0YXIgYWt0aWYgbWVuZ2lrdXRpIHByb3ZpZGVyCnZhciBNQ0FUID0gWydUcnkgTm93JywnQUxMJywnT0ZGSUNJQUwgTU9ERUwnLCdNRU1FJywnRVhDTFVTSVZFJywnQkVBVVRZJywnM0QnLCcyLjVEJywnTUFMRScsJ0FOSU1FJywnUkVBTElTVElDJywnU1RZTEUnLCdHQU1FJywnREVTSUdOJywnU0NFTkVSWScsJ0JVSUxESU5HUycsJ01FQ0hBJ107CnZhciBfY3VyTGlzdD1bXSwgX2N1ck9uU2VsPWZ1bmN0aW9uKCl7fTsKZnVuY3Rpb24gcmVuZGVyQ2FyZHMobGlzdCwgb25TZWwpewogIF9jdXJMaXN0PWxpc3Q7IF9jdXJPblNlbD1vblNlbDsKICB2YXIgYj0kKCdtb2RhbC1ib2R5Jyk7IGIuaW5uZXJIVE1MPScnOwogIGlmKCFsaXN0Lmxlbmd0aCl7IGIuaW5uZXJIVE1MPSc8cCBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIHAtMyB0ZXh0LWNlbnRlciI+VGlkYWsgYWRhIGhhc2lsLjwvcD4nOyByZXR1cm47IH0KICB2YXIgZ3JpZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICBncmlkLmNsYXNzTmFtZT0nZ3JpZCBncmlkLWNvbHMtMyBzbTpncmlkLWNvbHMtNCBtZDpncmlkLWNvbHMtNSBnYXAtMyc7CiAgbGlzdC5mb3JFYWNoKGZ1bmN0aW9uKG0pewogICAgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBkLmNsYXNzTmFtZT0nbWNhcmQnOwogICAgZC5pbm5lckhUTUwgPSc8ZGl2IGNsYXNzPSJtY2FyZC1pbWciPicKICAgICAgKyc8aW1nIHNyYz0iJytTK20udGh1bWIrJy8zMDAiLz4nCiAgICAgICsnPHNwYW4gY2xhc3M9Im1jYXJkLWJhZGdlIj4nK20uYmFkZ2UrJzwvc3Bhbj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibWNhcmQtc3RhciI+PGkgZGF0YS1pY29uPSJzdGFyIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC12aWV3cyI+PGkgZGF0YS1pY29uPSJwbGF5LWZpbGwiIGNsYXNzPSJ3LTMgaC0zIj48L2k+JyttLnZpZXdzKyc8L2Rpdj4nCiAgICAgICsnPC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9Im1jYXJkLWluZm8iPicKICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC1uYW1lIiB0aXRsZT0iJyttLm5hbWUrJyI+JyttLm5hbWUrJzwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC1tZXRhIj4nCiAgICAgICsnPHNlbGVjdCBjbGFzcz0ibWNhcmQtdmVyIj48b3B0aW9uPicrbS52ZXIrJzwvb3B0aW9uPjxvcHRpb24+Vi4yPC9vcHRpb24+PG9wdGlvbj5WLjM8L29wdGlvbj48L3NlbGVjdD4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibWNhcmQtc2VsIj5TZWxlY3Q8L2J1dHRvbj4nCiAgICAgICsnPC9kaXY+PC9kaXY+JzsKICAgIGQucXVlcnlTZWxlY3RvcignLm1jYXJkLXN0YXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oZSl7IGUudGFyZ2V0LmNsb3Nlc3QoJy5tY2FyZC1zdGFyJykuY2xhc3NMaXN0LnRvZ2dsZSgnb24nKTsgfSk7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5tY2FyZC1zZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgX2N1ck9uU2VsKG0pOyB9KTsKICAgIGdyaWQuYXBwZW5kQ2hpbGQoZCk7CiAgfSk7CiAgYi5hcHBlbmRDaGlsZChncmlkKTsKfQpmdW5jdGlvbiBhcHBseVNlYXJjaCgpewogIHZhciBxPSgkKCdtc2VhcmNoJykudmFsdWV8fCcnKS50b0xvd2VyQ2FzZSgpOwogIHJlbmRlckNhcmRzKF9jdXJMaXN0LmZpbHRlcihmdW5jdGlvbihtKXtyZXR1cm4gIXF8fG0ubmFtZS50b0xvd2VyQ2FzZSgpLmluZGV4T2YocSk+PTB9KSwgX2N1ck9uU2VsKTsKfQokKCdtc2VhcmNoJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGFwcGx5U2VhcmNoKTsKJCgnbWZpbHRlcnMnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgnbWNhdCcpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicpOyAkKCdtZmlsdGVycycpLmNsYXNzTGlzdC50b2dnbGUoJ29uJyk7IH0pOwpkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubXRhYicpLmZvckVhY2goZnVuY3Rpb24odCl7CiAgdC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tdGFiJykuZm9yRWFjaChmdW5jdGlvbih4KXt4LmNsYXNzTGlzdC5yZW1vdmUoJ3NlbCcpfSk7CiAgICB0LmNsYXNzTGlzdC5hZGQoJ3NlbCcpOwogICAgaWYodC5kYXRhc2V0Lm10YWI9PT0nYmFzaWMnKSByZW5kZXJDYXJkcyhNT0RFTFMsIGZ1bmN0aW9uKG0peyBzZXRNb2RlbChtKTsgY2xvc2VNb2RhbCgpOyB9KTsKICAgIGVsc2UgcmVuZGVyQ2FyZHMoW10sIG51bGwpOwogIH0pOwp9KTsKZnVuY3Rpb24gcmVuZGVyTUNhdChvblBpY2spewogIHZhciBjPSQoJ21jYXQnKTsKICBpZighb25QaWNrKSBvblBpY2s9ZnVuY3Rpb24oKXt9OwogIHZhciBodG1sPScnOwogIE1DQVQuZm9yRWFjaChmdW5jdGlvbihjYXQsaSl7CiAgICBodG1sKz0nPGJ1dHRvbiBjbGFzcz0ibWNoaXAiIGRhdGEtbWNhdD0iJytjYXQrJyI+JytjYXQrJzwvYnV0dG9uPic7CiAgfSk7CiAgYy5pbm5lckhUTUw9aHRtbDsKICBjLnF1ZXJ5U2VsZWN0b3IoJy5tY2hpcCcpLmNsYXNzTGlzdC5hZGQoJ29uJyk7CiAgYy5xdWVyeVNlbGVjdG9yQWxsKCcubWNoaXAnKS5mb3JFYWNoKGZ1bmN0aW9uKGNoKXsKICAgIGNoLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICAgICBjLnF1ZXJ5U2VsZWN0b3JBbGwoJy5tY2hpcCcpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QucmVtb3ZlKCdvbicpfSk7CiAgICAgIGNoLmNsYXNzTGlzdC5hZGQoJ29uJyk7CiAgICAgIG9uUGljayhjaC5kYXRhc2V0Lm1jYXQpOwogICAgfSk7CiAgfSk7Cn0KZnVuY3Rpb24gc2V0TW9kZWwobSl7CiAgc3RhdGUubW9kZWw9bTsKICAkKCdtb2RlbC1uYW1lJykudGV4dENvbnRlbnQ9bS5uYW1lOwogICQoJ21vZGVsLXRodW1iJykuc3JjPSdodHRwczovL3BpY3N1bS5waG90b3Mvc2VlZC8nK20udGh1bWIrJy82NCc7CiAgdmFyIGI9JCgnbW9kZWwtYmFkZ2UnKTsgaWYoYikgYi50ZXh0Q29udGVudD0obS5iYXNlfHwnTW9kZWwnKSsnIC0gJysobS5hcmNofHwnJyk7Cn0KZnVuY3Rpb24gb3Blbk1vZGVsU2VsZWN0b3IoKXsKICAkKCdtb2RhbC10aXRsZScpLnRleHRDb250ZW50PSdQaWxpaCBNb2RlbCc7CiAgcmVuZGVyTUNhdChmdW5jdGlvbigpeyByZW5kZXJDYXJkcyhNT0RFTFMsIGZ1bmN0aW9uKG0peyBzZXRNb2RlbChtKTsgY2xvc2VNb2RhbCgpOyB9KTsgfSk7CiAgcmVuZGVyQ2FyZHMoTU9ERUxTLCBmdW5jdGlvbihtKXsgc2V0TW9kZWwobSk7IGNsb3NlTW9kYWwoKTsgfSk7CiAgb3Blbk1vZGFsKCk7Cn0KJCgnbW9kZWwtY2FyZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxvcGVuTW9kZWxTZWxlY3Rvcik7CmZ1bmN0aW9uIG9wZW5Mb3JhTW9kYWwoKXsKICAkKCdtb2RhbC10aXRsZScpLnRleHRDb250ZW50PSdQaWxpaCBMb1JBJzsKICB2YXIgYXJjaD1zdGF0ZS5tb2RlbD9zdGF0ZS5tb2RlbC5hcmNoOicnOwogIHZhciBhdmFpbD1mdW5jdGlvbigpeyByZXR1cm4gTE9SQV9MSUIuZmlsdGVyKGZ1bmN0aW9uKGwpewogICAgcmV0dXJuICghTE9SQS5zb21lKGZ1bmN0aW9uKHgpe3JldHVybiB4Lm5hbWU9PT1sLm5hbWV9KSkgJiYgKCFhcmNoIHx8ICFsLmJhc2UgfHwgbC5iYXNlPT09YXJjaCk7CiAgfSk7IH07CiAgdmFyIG9uU2VsPWZ1bmN0aW9uKGwpewogICAgTE9SQS5wdXNoKHsgbmFtZTpsLm5hbWUsIHc6MC44LCB0YWdzOmwudGFncywgdGh1bWI6bC50aHVtYiwgYmFzZTpsLmJhc2UsIGxvcmFNb2RlbDpsLm1vZGVsfHwnJywgbmVlZFVybDpsLm5lZWRVcmwsIGxvcmFVcmw6JycgfSk7CiAgICByZW5kZXJMb3JhKCk7IGNsb3NlTW9kYWwoKTsKICB9OwogIHJlbmRlck1DYXQoZnVuY3Rpb24oKXsgcmVuZGVyQ2FyZHMoYXZhaWwoKSwgb25TZWwpOyB9KTsKICByZW5kZXJDYXJkcyhhdmFpbCgpLCBvblNlbCk7CiAgaWYoIWF2YWlsKCkubGVuZ3RoKXsgJCgnbW9kYWwtdGl0bGUnKS50ZXh0Q29udGVudD0nVGlkYWsgYWRhIExvUkEgdW50dWsgJythcmNoOyB9CiAgb3Blbk1vZGFsKCk7Cn0KZnVuY3Rpb24gb3Blbk1vZGFsKCl7ICQoJ21vZGFsJykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ21vZGFsJykuY2xhc3NMaXN0LmFkZCgnZmxleCcpOyB9CmZ1bmN0aW9uIGNsb3NlTW9kYWwoKXsgJCgnbW9kYWwnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgnbW9kYWwnKS5jbGFzc0xpc3QucmVtb3ZlKCdmbGV4Jyk7IH0KZnVuY3Rpb24gb3BlbkxvcmFJbmZvKGwpewogICQoJ21vZGFsLXRpdGxlJykudGV4dENvbnRlbnQ9J0RldGFpbCBMb1JBJzsKICAkKCdtY2F0JykuaW5uZXJIVE1MPScnOwogIHZhciBiPSQoJ21vZGFsLWJvZHknKTsKICBiLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZmxleCBnYXAtMyBwLTIiPicKICAgICsnPGltZyBzcmM9IicrUytsLnRodW1iKycvMTQwIiBjbGFzcz0idy0yOCBoLTI4IHJvdW5kZWQtbGcgb2JqZWN0LWNvdmVyIHNocmluay0wIi8+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4LTEgbWluLXctMCI+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGZsZXgtd3JhcCBnYXAtMS41IG1iLTEiPicKICAgICsnPHNwYW4gY2xhc3M9InRleHQtWzEwcHhdIGZvbnQtc2VtaWJvbGQgYmctWyMxYzIxMjhdIGJvcmRlciBiZCBweC0xLjUgcHktMC41IHJvdW5kZWQgdGV4dC1uZXV0cmFsLTQwMCI+TE9SQTwvc3Bhbj4nCiAgICArJzxzcGFuIGNsYXNzPSJ0ZXh0LVsxMHB4XSBmb250LXNlbWlib2xkIGJnLVtyZ2JhKDExMSw5MywyNTUsLjE1KV0gYm9yZGVyIGJvcmRlci1bIzZGNURGRl0gcHgtMS41IHB5LTAuNSByb3VuZGVkIHRleHQtWyM2RjVERkZdIj4nK2wuYmFkZ2UrJzwvc3Bhbj4nCiAgICArJzxzcGFuIGNsYXNzPSJ0ZXh0LVsxMHB4XSBmb250LXNlbWlib2xkIGJnLVsjMWMyMTI4XSBib3JkZXIgYmQgcHgtMS41IHB5LTAuNSByb3VuZGVkIHRleHQtbmV1dHJhbC00MDAiPk9yaWdpbmFsPC9zcGFuPicKICAgICsnPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPicrbC5uYW1lKyc8L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBtdC0wLjUiPlJla3R5IEFJPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSBtdC0xIHRleHQteHMgdGV4dC1uZXV0cmFsLTQwMCI+PGkgZGF0YS1pY29uPSJkb3dubG9hZC1zaW1wbGUiIGNsYXNzPSJ3LTMuNSBoLTMuNSI+PC9pPicrKGwudmlld3M/bC52aWV3czonMTJLJykrJyBkb3dubG9hZHM8L2Rpdj4nCiAgICArJzwvZGl2PjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iYm9yZGVyLXQgYmQgbXQtMiBwdC0zIj4nCiAgICArJzxkaXYgY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCBtYi0yIGZsZXggaXRlbXMtY2VudGVyIGdhcC0xIj48aSBkYXRhLWljb249InRhZyIgY2xhc3M9InctNCBoLTQiPjwvaT5WZXJzaW9uIERldGFpbDwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZ3JpZCBncmlkLWNvbHMtMiBnYXAtMiB0ZXh0LXhzIj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGJvcmRlciBiZCByb3VuZGVkLWxnIHB4LTIgcHktMS41Ij48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+QmFzZSBNb2RlbDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+WiBJbWFnZTwvc3Bhbj48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGJvcmRlciBiZCByb3VuZGVkLWxnIHB4LTIgcHktMS41Ij48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+U3RlcHM8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPjI1MDA8L3NwYW4+PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiBib3JkZXIgYmQgcm91bmRlZC1sZyBweC0yIHB5LTEuNSI+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPkVwb2NoPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4xMjwvc3Bhbj48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGJvcmRlciBiZCByb3VuZGVkLWxnIHB4LTIgcHktMS41Ij48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+VHJpZ2dlciBXb3Jkczwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1bIzI3RDRDRF0iPicrbC50YWdzLnNsaWNlKDAsMikuam9pbignLCAnKSsnPC9zcGFuPjwvZGl2PicKICAgICsnPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgbXQtMyBtYi0xIj5EZXNjcmlwdGlvbjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNDAwIGxlYWRpbmctcmVsYXhlZCI+JytsLnRhZ3Muam9pbignLCAnKSsnIOKAlCBMb1JBIHVudHVrIGdheWEgZGFuIGRldGFpbCB0YW1iYWhhbiBkaSBaIEltYWdlLjwvZGl2Pic7CiAgb3Blbk1vZGFsKCk7Cn0KJCgnbW9kZWwtaW5mbycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgZS5zdG9wUHJvcGFnYXRpb24oKTsgb3BlbkxvcmFJbmZvKHtuYW1lOiQoJ21vZGVsLW5hbWUnKS50ZXh0Q29udGVudCxiYWRnZTonWiBJbWFnZScsdGh1bWI6J3ppbWFnZScsdGFnczpbJ2RldGFpbCcsJ3NoYXJwJ119KTsgfSk7CiQoJ21vZGFsLWNsb3NlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGNsb3NlTW9kYWwpOwokKCdtb2RhbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgaWYoZS50YXJnZXQ9PT0kKCdtb2RhbCcpKSBjbG9zZU1vZGFsKCk7IH0pOwokKCdidG4tYWRkbG9yYScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxvcGVuTG9yYU1vZGFsKTsKZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsZnVuY3Rpb24oZSl7IGlmKGUua2V5PT09J0VzY2FwZScpIGNsb3NlTW9kYWwoKTsgfSk7CmZ1bmN0aW9uIHJlbmRlckxvcmEoKXsKICB2YXIgbGlzdCA9ICQoJ2xvcmEtbGlzdCcpOyBsaXN0LmlubmVySFRNTD0nJzsKICBpZighTE9SQS5sZW5ndGgpeyBsaXN0LmlubmVySFRNTD0nPGRpdiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNjAwIGJvcmRlciBib3JkZXItZGFzaGVkIGJvcmRlci1bIzMwMzYzZF0gcm91bmRlZC1sZyBwLTMgdGV4dC1jZW50ZXIiPkJlbHVtIGFkYSBMb1JBLiBLbGlrICJBZGQgTG9SQSIuPC9kaXY+JzsgcmVuZGVyVHJpZ2dlcnMoKTsgcmV0dXJuOyB9CiAgTE9SQS5mb3JFYWNoKGZ1bmN0aW9uKGwscmkpewogICAgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBkLmNsYXNzTmFtZT0nbG9yYS1jYXJkJzsKICAgIGQuaW5uZXJIVE1MPScnCiAgICAgICsnPHNwYW4gY2xhc3M9ImxvcmEtbGFiZWwiPkxvUkEgLSAnKyhsLmJhc2V8fCdaIEltYWdlJykrJzwvc3Bhbj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibG9yYS10b3AiPicKICAgICAgKyc8aW1nIHNyYz0iJytTK2wudGh1bWIrJy80MCIgY2xhc3M9ImxvcmEtdGh1bWIiIGFsdD0iIi8+JwogICAgICArJzxzcGFuIGNsYXNzPSJsb3JhLW5hbWUiPicrbC5uYW1lKyc8L3NwYW4+JwogICAgICArJzxkaXYgY2xhc3M9ImxvcmEtaWNvbnMiPicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJsb3JhLWljb24iIGRhdGEtaW5mbz0iJytyaSsnIiB0aXRsZT0iSW5mbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48bGluZSB4MT0iMTIiIHkxPSIxNiIgeDI9IjEyIiB5Mj0iMTIiLz48bGluZSB4MT0iMTIiIHkxPSI4IiB4Mj0iMTIuMDEiIHkyPSI4Ii8+PC9zdmc+PC9idXR0b24+JwogICAgICArJzxidXR0b24gY2xhc3M9ImxvcmEtaWNvbiBkZWwiIGRhdGEtZGVsPSInK3JpKyciIHRpdGxlPSJIYXB1cyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBvbHlsaW5lIHBvaW50cz0iMyA2IDUgNiAyMSA2Ii8+PHBhdGggZD0iTTE5IDZ2MTRhMiAyIDAgMCAxLTIgMkg3YTIgMiAwIDAgMS0yLTJWNm0zIDBWNGEyIDIgMCAwIDEgMi0yaDRhMiAyIDAgMCAxIDIgMnYyIi8+PGxpbmUgeDE9IjEwIiB5MT0iMTEiIHgyPSIxMCIgeTI9IjE3Ii8+PGxpbmUgeDE9IjE0IiB5MT0iMTEiIHgyPSIxNCIgeTI9IjE3Ii8+PC9zdmc+PC9idXR0b24+JwogICAgICArJzwvZGl2PicKICAgICAgKyc8L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibG9yYS1zbGlkZXItcm93Ij4nCiAgICAgICsnPGRpdiBjbGFzcz0ibC1zbGlkZXIiPjxkaXYgY2xhc3M9ImwtdHJhY2siPjwvZGl2PjxkaXYgY2xhc3M9ImwtZmlsbCIgc3R5bGU9IndpZHRoOicrKGwudy8yKjEwMCkrJyUiPjwvZGl2PjxkaXYgY2xhc3M9ImwtaGFuZGxlIiBzdHlsZT0ibGVmdDonKyhsLncvMioxMDApKyclIj48L2Rpdj48aW5wdXQgdHlwZT0icmFuZ2UiIG1pbj0iMCIgbWF4PSIyIiBzdGVwPSIwLjEiIHZhbHVlPSInK2wudysnIiBkYXRhLXJpPSInK3JpKyciIGNsYXNzPSJsb3JhLXNsIi8+PC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9ImwtbnVtIj4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibG9yYS1idG4iIGRhdGEtZGVjPSInK3JpKyciPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxsaW5lIHgxPSI1IiB5MT0iMTIiIHgyPSIxOSIgeTI9IjEyIi8+PC9zdmc+PC9idXR0b24+JwogICAgICArJzxpbnB1dCB0eXBlPSJ0ZXh0IiB2YWx1ZT0iJytsLncudG9GaXhlZCgxKSsnIiBjbGFzcz0ibG9yYS1pbnB1dCIgZGF0YS1yaT0iJytyaSsnIiBpbnB1dG1vZGU9ImRlY2ltYWwiLz4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibG9yYS1idG4iIGRhdGEtaW5jPSInK3JpKyciPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxsaW5lIHgxPSIxMiIgeTE9IjUiIHgyPSIxMiIgeTI9IjE5Ii8+PGxpbmUgeDE9IjUiIHkxPSIxMiIgeDI9IjE5IiB5Mj0iMTIiLz48L3N2Zz48L2J1dHRvbj4nCiAgICAgICsnPC9kaXY+JwogICAgICArKGwubmVlZFVybD8nPGRpdiBjbGFzcz0ibXQtMiI+PGlucHV0IHR5cGU9InRleHQiIGNsYXNzPSJpbnAgbG9yYS11cmwtaW5wIiB2YWx1ZT0iJysobC5sb3JhVXJsfHwnJykrJyIgZGF0YS11cmw9IicrcmkrJyIgcGxhY2Vob2xkZXI9Imh0dHBzOi8vaHVnZ2luZ2ZhY2UuY28vdXNlci9yZXBvL3Jlc29sdmUvbWFpbi9sb3JhLnNhZmV0ZW5zb3JzIi8+PGRpdiBjbGFzcz0ibXQtMSB0ZXh0LVsxMHB4XSBsZWFkaW5nLXNudWcgdGV4dC1uZXV0cmFsLTUwMCI+VVJMIHB1YmxpayBsYW5nc3VuZyAoLnNhZmV0ZW5zb3JzKSDigJQgY29udG9oIEh1Z2dpbmdGYWNlIHJlc29sdmUuIEthZ2dsZSB0aWRhayBiaXNhIChidXR1aCBsb2dpbikuPC9kaXY+PC9kaXY+JzonJykKICAgICAgKyc8L2Rpdj4nOwogICAgdmFyIHNsPWQucXVlcnlTZWxlY3RvcignLmwtc2xpZGVyIFtkYXRhLXJpPSInK3JpKyciXScpOwogICAgdmFyIHVJbnA9ZC5xdWVyeVNlbGVjdG9yKCdbZGF0YS11cmw9IicrcmkrJyJdJyk7CiAgICBpZih1SW5wKXsgdUlucC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7IExPUkFbcmldLmxvcmFVcmw9ZS50YXJnZXQudmFsdWUudHJpbSgpOyB9KTsgfQogICAgc2wuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpewogICAgICB2YXIgdj1wYXJzZUZsb2F0KGUudGFyZ2V0LnZhbHVlKTsgaWYoaXNOYU4odikpcmV0dXJuOwogICAgICBMT1JBW3JpXS53PXY7CiAgICAgIHZhciBwY3Q9KHYvMioxMDApOwogICAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5sLWZpbGwnKS5zdHlsZS53aWR0aD1wY3QrJyUnOwogICAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5sLWhhbmRsZScpLnN0eWxlLmxlZnQ9cGN0KyclJzsKICAgICAgZC5xdWVyeVNlbGVjdG9yKCcubG9yYS1pbnB1dCcpLnZhbHVlPXYudG9GaXhlZCgxKTsKICAgICAgcmVuZGVyVHJpZ2dlcnMoKTsKICAgIH0pOwogICAgZC5xdWVyeVNlbGVjdG9yKCcubC1udW0gW2RhdGEtaW5jPSInK3JpKyciXScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBzZXRMVyhyaSwrKExPUkFbcmldLncrMC4xKS50b0ZpeGVkKDEpKTsgcmVuZGVyTG9yYSgpOyB9KTsKICAgIGQucXVlcnlTZWxlY3RvcignLmwtbnVtIFtkYXRhLWRlYz0iJytyaSsnIl0nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgc2V0TFcocmksKyhMT1JBW3JpXS53LTAuMSkudG9GaXhlZCgxKSk7IHJlbmRlckxvcmEoKTsgfSk7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWRlbD0iJytyaSsnIl0nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgTE9SQS5zcGxpY2UocmksMSk7IHJlbmRlckxvcmEoKTsgcmVuZGVyVHJpZ2dlcnMoKTsgfSk7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWluZm89IicrcmkrJyJdJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IG9wZW5Mb3JhSW5mbyhsKTsgfSk7CiAgICBsaXN0LmFwcGVuZENoaWxkKGQpOwogIH0pOwogIHJlbmRlclRyaWdnZXJzKCk7Cn0KZnVuY3Rpb24gc2V0TFcoaSx2KXsgTE9SQVtpXS53PU1hdGgubWF4KDAsTWF0aC5taW4oMix2KSk7IH0KdmFyIF9wZW5kaW5nVHJpZyA9IFtdOwpmdW5jdGlvbiByZW5kZXJUcmlnZ2VycygpewogIHZhciBwPSgkKCdwcm9tcHQnKS52YWx1ZXx8JycpLnRvTG93ZXJDYXNlKCk7CiAgdmFyIHQ9JCgndHJpZ2dlcnMnKTsgdC5pbm5lckhUTUw9Jyc7CiAgX3BlbmRpbmdUcmlnPVtdOwogIExPUkEuZmlsdGVyKGZ1bmN0aW9uKGwpe3JldHVybiBsLnc+MH0pLmZvckVhY2goZnVuY3Rpb24obCl7CiAgICBsLnRhZ3MuZm9yRWFjaChmdW5jdGlvbih3KXsgaWYocC5pbmRleE9mKHcudG9Mb3dlckNhc2UoKSk8MCkgX3BlbmRpbmdUcmlnLnB1c2goe3dvcmQ6dyxsb3JhOmwubmFtZX0pOyB9KTsKICB9KTsKICAkKCd0ci1jb3VudCcpLnRleHRDb250ZW50PV9wZW5kaW5nVHJpZy5sZW5ndGg7CiAgaWYoIV9wZW5kaW5nVHJpZy5sZW5ndGgpeyB0LmlubmVySFRNTD0nPHNwYW4gY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTYwMCI+VGlkYWsgYWRhIHRyaWdnZXIgd29yZCB0ZXJzaXNhPC9zcGFuPic7IHJldHVybjsgfQogIF9wZW5kaW5nVHJpZy5mb3JFYWNoKGZ1bmN0aW9uKGl0ZW0pewogICAgdmFyIGI9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7CiAgICBiLmNsYXNzTmFtZT0ndGFnIGN1cnNvci1wb2ludGVyIGhvdmVyOmJvcmRlci1bIzI3RDRDRF0gaG92ZXI6dGV4dC1bIzI3RDRDRF0gdHJhbnNpdGlvbic7CiAgICBiLmlubmVySFRNTD0nPGkgZGF0YS1pY29uPSJzcGFya2xlIiBjbGFzcz0idy0zIGgtMyB0ZXh0LVsjMjdENENEXSI+PC9pPicraXRlbS53b3JkOwogICAgYi50aXRsZT0nVGFtYmFoa2FuIGtlIHByb21wdCAoJytpdGVtLmxvcmErJyknOwogICAgYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgICAgYWRkV29yZChpdGVtLndvcmQpOwogICAgICByZW5kZXJUcmlnZ2VycygpOwogICAgfSk7CiAgICB0LmFwcGVuZENoaWxkKGIpOwogIH0pOwp9CmZ1bmN0aW9uIGFkZFdvcmQodyl7CiAgdmFyIHByPSQoJ3Byb21wdCcpLCBjdj1wci52YWx1ZS50cmltKCk7CiAgaWYoY3YgJiYgIWN2LmVuZHNXaXRoKCcsJykpIGN2Kz0nLCc7CiAgcHIudmFsdWU9Y3YrdysnLCc7CiAgcHIuZm9jdXMoKTsKfQpmdW5jdGlvbiBhZGRBbGxUcmlnKCl7CiAgdmFyIGFsbD1fcGVuZGluZ1RyaWcubWFwKGZ1bmN0aW9uKHgpe3JldHVybiB4LndvcmR9KTsKICBhbGwuZm9yRWFjaChhZGRXb3JkKTsKICByZW5kZXJUcmlnZ2VycygpOwp9CiQoJ2FkZGFsbC10cmlnJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGFkZEFsbFRyaWcpOwoKLyogPT09PT0gYXNwZWN0IHJhdGlvID09PT09ICovCnZhciBBUl9NQVAgPSB7CiAgcG9ydHJhaXQ6WydQb3J0cmFpdCcsNzY4LDExNTJdLAogIGxhbmRzY2FwZTpbJ0xhbmRzY2FwZScsMTE1Miw3NjhdLAogIHNxdWFyZTpbJ1NxdWFyZScsMTAyNCwxMDI0XSwKICBjdXN0b206WydjdXN0b20nLG51bGwsbnVsbF0KfTsKZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmFyJykuZm9yRWFjaChmdW5jdGlvbihiKXsKICBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICAgdmFyIGFyPWIuZGF0YXNldC5hcjsgc3RhdGUuYXNwZWN0PWFyOwogICAgc2V0QXJBY3RpdmUoYXIpOwogICAgaWYoYXIhPT0nY3VzdG9tJyl7ICQoJ3dpZHRoJykudmFsdWU9QVJfTUFQW2FyXVsxXTsgJCgnaGVpZ2h0JykudmFsdWU9QVJfTUFQW2FyXVsyXTsgfQogICAgdXBkV0goKTsKICB9KTsKfSk7CmZ1bmN0aW9uIHVwZFdIKCl7ICQoJ3d2JykudmFsdWU9JCgnd2lkdGgnKS52YWx1ZTsgJCgnaHYnKS52YWx1ZT0kKCdoZWlnaHQnKS52YWx1ZTsgfQokKCd3aWR0aCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbigpeyAkKCd3dicpLnZhbHVlPSQoJ3dpZHRoJykudmFsdWU7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsKJCgnaGVpZ2h0JykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKCl7ICQoJ2h2JykudmFsdWU9JCgnaGVpZ2h0JykudmFsdWU7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsKJCgnd3YnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLGZ1bmN0aW9uKCl7IHZhciB2PU1hdGgubWF4KDI1NixNYXRoLm1pbigxNTM2LHBhcnNlSW50KCQoJ3d2JykudmFsdWUpfHw3NjgpKTsgdj1NYXRoLnJvdW5kKHYvNjQpKjY0OyAkKCd3dicpLnZhbHVlPXY7ICQoJ3dpZHRoJykudmFsdWU9djsgc3RhdGUuYXNwZWN0PSdjdXN0b20nOyBzZXRBckFjdGl2ZSgnY3VzdG9tJyk7IH0pOwokKCdodicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsZnVuY3Rpb24oKXsgdmFyIHY9TWF0aC5tYXgoMjU2LE1hdGgubWluKDE1MzYscGFyc2VJbnQoJCgnaHYnKS52YWx1ZSl8fDExNTIpKTsgdj1NYXRoLnJvdW5kKHYvNjQpKjY0OyAkKCdodicpLnZhbHVlPXY7ICQoJ2hlaWdodCcpLnZhbHVlPXY7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsKZnVuY3Rpb24gc2V0QXJBY3RpdmUoYXIpewogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hcicpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QudG9nZ2xlKCdzZWwnLCB4LmRhdGFzZXQuYXI9PT1hcil9KTsKICAkKCdhci1sYWJlbCcpLnRleHRDb250ZW50PUFSX01BUFthcl1bMF07Cn0KJCgnc3RlcHMnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7JCgnc3YnKS50ZXh0Q29udGVudD1lLnRhcmdldC52YWx1ZX0pOwokKCdjZmcnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7JCgnY2Z2JykudGV4dENvbnRlbnQ9ZS50YXJnZXQudmFsdWV9KTsKJCgnY2xpcHNraXAnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7JCgnY3N2JykudGV4dENvbnRlbnQ9ZS50YXJnZXQudmFsdWV9KTsKJCgnZXRhbnNkJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpeyQoJ2Vuc2QnKS50ZXh0Q29udGVudD1lLnRhcmdldC52YWx1ZX0pOwokKCdhZHYtdG9nZ2xlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7JCgnYWR2LWZpZWxkcycpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicpfSk7CiQoJ2RpY2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXskKCdzZWVkJykudmFsdWU9U3RyaW5nKE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSo5OTk5OTk5OTk5OTk5OTk5KSl9KTsKJCgnbmVnY2hlY2snKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLGZ1bmN0aW9uKGUpeyQoJ25lZ3dyYXAnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLCFlLnRhcmdldC5jaGVja2VkKX0pOwokKCdwcm9tcHQnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcscmVuZGVyVHJpZ2dlcnMpOwovKiBUcmFuc2xhdGU6IHNlbXVhIGJhaGFzYSAtPiBJbmdncmlzIChiYWNrZW5kIC9hcGkvdHJhbnNsYXRlLCBncmF0aXMpICovCmZ1bmN0aW9uIHNldFRyYW5zbGF0ZUJ1c3koYil7CiAgdmFyIGVsPSQoJ2J0bi10cmFuc2xhdGUnKTsKICBlbC5pbm5lckhUTUw9Yj8nPGkgZGF0YS1pY29uPSJjaXJjbGUtbm90Y2giIGNsYXNzPSJ3LTQgaC00IGFuaW1hdGUtc3BpbiI+PC9pPic6JzxpIGRhdGEtaWNvbj0idHJhbnNsYXRlIiBjbGFzcz0idy00IGgtNCI+PC9pPic7Cn0KJCgnYnRuLXRyYW5zbGF0ZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogIHZhciBwPSgkKCdwcm9tcHQnKS52YWx1ZXx8JycpLnRyaW0oKTsKICBpZighcCl7ICQoJ3Byb21wdCcpLmZvY3VzKCk7IHJldHVybjsgfQogIHNldFRyYW5zbGF0ZUJ1c3kodHJ1ZSk7CiAgZmV0Y2goJy9hcGkvdHJhbnNsYXRlP3E9JytlbmNvZGVVUklDb21wb25lbnQocCkpLnRoZW4oZnVuY3Rpb24ocil7IHJldHVybiByLmpzb24oKTsgfSkudGhlbihmdW5jdGlvbihkKXsKICAgIGlmKGQub2smJmQudGV4dCl7ICQoJ3Byb21wdCcpLnZhbHVlPWQudGV4dDsgcmVuZGVyVHJpZ2dlcnMoKTsgdG9hc3QoJ0RpdGVyamVtYWhrYW4ga2UgSW5nZ3JpcyDinJMnKTsgfQogICAgZWxzZSB0b2FzdChkLmVycm9yfHwnR2FnYWwgbWVuZXJqZW1haGthbicpOwogIH0pLmNhdGNoKGZ1bmN0aW9uKCl7IHRvYXN0KCdHYWdhbCBtZW5lcmplbWFoa2FuJyk7IH0pLmZpbmFsbHkoZnVuY3Rpb24oKXsgc2V0VHJhbnNsYXRlQnVzeShmYWxzZSk7IH0pOwp9KTsKLyogUHJvbXB0IEVuaGFuY2UgKHNlcGVydGkgVGVuc29yLkFydCk6IGhhc2lsIHJlZmluZSB0YW1waWwgZGkgcG9wdXAgdW50dWsKICAgZGlrb25maXJtYXNpL2RpZWRpdCBzZWJlbHVtIGRpcGFrYWkuIEJhY2tlbmQgL2FwaS9yZWZpbmUgKExMTSBQb2xsaW5hdGlvbnMpLAogICBmYWxsYmFjayB0ZW1wbGF0ZSBsb2thbCBrYWxhdSB0YW5wYSBrZXkuICovCnZhciBfZW5oT3JpZz0nJzsKZnVuY3Rpb24gZmFsbGJhY2tFbmhhbmNlKHApewogIHJldHVybiBwCiAgICArJ1xuXG5FbmhhbmNlIGRldGFpbCwgbGlnaHRpbmcsIGNvbXBvc2l0aW9uLCBhbmQgYXRtb3NwaGVyZS4gJwogICAgKydVbHRyYS1kZXRhaWxlZCwgcHJvZmVzc2lvbmFsIHBob3RvZ3JhcGh5LCBzaGFycCBmb2N1cywgY2luZW1hdGljIGxpZ2h0aW5nLic7Cn0KZnVuY3Rpb24gb3BlbkVuaE1vZGFsKHApewogIF9lbmhPcmlnPXA7CiAgJCgnZW5oLW9yaWcnKS50ZXh0Q29udGVudD1wOwogICQoJ2VuaC10ZXh0JykudmFsdWU9Jyc7CiAgJCgnZW5oLW1vZGFsJykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ2VuaC1tb2RhbCcpLmNsYXNzTGlzdC5hZGQoJ2ZsZXgnKTsKfQpmdW5jdGlvbiBjbG9zZUVuaE1vZGFsKCl7ICQoJ2VuaC1tb2RhbCcpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyAkKCdlbmgtbW9kYWwnKS5jbGFzc0xpc3QucmVtb3ZlKCdmbGV4Jyk7IH0KZnVuY3Rpb24gZG9FbmhhbmNlKCl7CiAgdmFyIHA9KCQoJ3Byb21wdCcpLnZhbHVlfHwnJykudHJpbSgpOwogIGlmKCFwKXsgJCgncHJvbXB0JykuZm9jdXMoKTsgcmV0dXJuOyB9CiAgb3BlbkVuaE1vZGFsKHApOwogICQoJ2VuaC10ZXh0JykudmFsdWU9J01lbmdoYXNpbGthbiBwcm9tcHQgeWFuZyBsZWJpaCBiYWlrLi4uJzsKICB2YXIgYj0kKCdlbmgtcmVnZW4nKTsgYi5kaXNhYmxlZD10cnVlOyBiLnN0eWxlLm9wYWNpdHk9JzAuNSc7CiAgZmV0Y2goJy9hcGkvcmVmaW5lJyx7bWV0aG9kOidQT1NUJyxoZWFkZXJzOl9hcGlIZWFkZXJzKHsnQ29udGVudC1UeXBlJzonYXBwbGljYXRpb24vanNvbid9KSxib2R5OkpTT04uc3RyaW5naWZ5KHtwcm9tcHQ6cH0pfSkKICAgIC50aGVuKGZ1bmN0aW9uKHIpeyByZXR1cm4gci5qc29uKCk7IH0pCiAgICAudGhlbihmdW5jdGlvbihkKXsKICAgICAgJCgnZW5oLXRleHQnKS52YWx1ZT0oZC5vayYmZC50ZXh0KT9kLnRleHQ6ZmFsbGJhY2tFbmhhbmNlKHApOwogICAgICBpZighZC5vaykgdG9hc3QoJ1JlZmluZSBvZmZsaW5lIOKAlCBwYWthaSB0ZW1wbGF0ZSBsb2thbCcpOwogICAgfSkKICAgIC5jYXRjaChmdW5jdGlvbigpeyAkKCdlbmgtdGV4dCcpLnZhbHVlPWZhbGxiYWNrRW5oYW5jZShwKTsgdG9hc3QoJ1JlZmluZSBvZmZsaW5lIOKAlCBwYWthaSB0ZW1wbGF0ZSBsb2thbCcpOyB9KQogICAgLmZpbmFsbHkoZnVuY3Rpb24oKXsgYi5kaXNhYmxlZD1mYWxzZTsgYi5zdHlsZS5vcGFjaXR5PScnOyB9KTsKfQokKCdidG4tZW5oYW5jZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxkb0VuaGFuY2UpOwokKCdlbmgtY2xvc2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsY2xvc2VFbmhNb2RhbCk7CiQoJ2VuaC1jYW5jZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsY2xvc2VFbmhNb2RhbCk7CiQoJ2VuaC1tb2RhbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgaWYoZS50YXJnZXQ9PT0kKCdlbmgtbW9kYWwnKSkgY2xvc2VFbmhNb2RhbCgpOyB9KTsKJCgnZW5oLXJlZ2VuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgJCgncHJvbXB0JykudmFsdWU9KCQoJ2VuaC10ZXh0JykudmFsdWV8fCcnKS50cmltKCl8fF9lbmhPcmlnOwogIHJlbmRlclRyaWdnZXJzKCk7CiAgZG9FbmhhbmNlKCk7Cn0pOwokKCdlbmgtdXNlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgdmFyIHY9KCQoJ2VuaC10ZXh0JykudmFsdWV8fCcnKS50cmltKCk7CiAgaWYoIXYpIHJldHVybjsKICAkKCdwcm9tcHQnKS52YWx1ZT12OyByZW5kZXJUcmlnZ2VycygpOyBjbG9zZUVuaE1vZGFsKCk7IHRvYXN0KCdQcm9tcHQgRW5oYW5jZSBkaXRlcmFwa2FuIOKckycpOwp9KTsKZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNoaXAnKS5mb3JFYWNoKGZ1bmN0aW9uKGMpewogIGMuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7Yy5jbGFzc0xpc3QudG9nZ2xlKCdvbicpfSk7Cn0pOwoKLyogPT09PT0gdGFicyA9PT09PSAqLwpkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudGFiJykuZm9yRWFjaChmdW5jdGlvbih0KXsKICB0LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRhYicpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QucmVtb3ZlKCdzZWwnKX0pOwogICAgdC5jbGFzc0xpc3QuYWRkKCdzZWwnKTsgc3RhdGUucGFnZT10LmRhdGFzZXQudGFiOwogICAgcmVuZGVyQ2FudmFzKCk7CiAgfSk7Cn0pOwpkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucnRhYicpLmZvckVhY2goZnVuY3Rpb24odCl7CiAgdC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5ydGFiJykuZm9yRWFjaChmdW5jdGlvbih4KXt4LmNsYXNzTGlzdC5yZW1vdmUoJ3NlbCcpfSk7CiAgICB0LmNsYXNzTGlzdC5hZGQoJ3NlbCcpOwogICAgdmFyIHA9dC5kYXRhc2V0LnA7IC8vIGRldGFpbCB8IGhpc3RvcnkKICAgICQoJ3JkZXRhaWwnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLHAhPT0nZGV0YWlsJyk7CiAgICAkKCdyaGlzdG9yeScpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicscCE9PSdoaXN0b3J5Jyk7CiAgfSk7Cn0pOwovKiBGaWx0ZXIgZ2FsZXJpIChBbGwvVmlkZW8vSW1hZ2UvQXVkaW8pIOKAlCBzZXBlcnRpIFRlbnNvci5BcnQgKi8KZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmdmaWwnKS5mb3JFYWNoKGZ1bmN0aW9uKGYpewogIGYuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuZ2ZpbCcpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QucmVtb3ZlKCdzZWwnKX0pOwogICAgZi5jbGFzc0xpc3QuYWRkKCdzZWwnKTsKICAgIHZhciB0PWYuZGF0YXNldC5mOyAvLyBhbGwgfCB2aWRlbyB8IGltYWdlIHwgYXVkaW8KICAgIEFycmF5LnByb3RvdHlwZS5mb3JFYWNoLmNhbGwoZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnI2dyaWQgPiBkaXYnKSxmdW5jdGlvbihyb3cpewogICAgICByb3cuc3R5bGUuZGlzcGxheT0odD09PSdhbGwnfHx0PT09J2ltYWdlJyk/Jyc6J25vbmUnOwogICAgfSk7CiAgfSk7Cn0pOwoKLyogPT09PT0gbW9iaWxlIGRyYXdlciA9PT09PSAqLwokKCdtbWVudScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBvcGVuTGVmdCgpOyB9KTsKJCgnb3ZlcmxheScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBjbG9zZUxlZnQoKTsgfSk7CmZ1bmN0aW9uIG9wZW5MZWZ0KCl7ICQoJ292ZXJsYXknKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgJCgnbGVmdHBhbicpLmNsYXNzTGlzdC5yZW1vdmUoJy10cmFuc2xhdGUteC1mdWxsJyk7IH0KZnVuY3Rpb24gY2xvc2VMZWZ0KCl7ICQoJ292ZXJsYXknKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgaWYod2luZG93LmlubmVyV2lkdGg8MTAyNCkgJCgnbGVmdHBhbicpLmNsYXNzTGlzdC5hZGQoJy10cmFuc2xhdGUteC1mdWxsJyk7IH0KCi8qID09PT09IGltYWdlIGNvdW50IChkcm9wZG93biBkaSBwcm9tcHQgYmFyICsgdG9tYm9sIG5hdmJhcikgPT09PT0gKi8KZnVuY3Rpb24gYXBwbHlOY29sKCl7CiAgdmFyIHNlbD0kKCduY291bnQnKTsgaWYoc2VsKSBzZWwudmFsdWU9U3RyaW5nKHN0YXRlLm5jb2wpOwogIC8vIFRhbXBpbGFuIHRlbmdhaCBzZWxhbHUgMSBnYW1iYXIgc2VzdWFpIGFzcGVjdCByYXRpbyAoc2VwZXJ0aSBUZW5zb3IuQXJ0KS4KICAvLyBuY29sIGhhbnlhIG1lbmVudHVrYW4ganVtbGFoIGdhbWJhciBwZXIgZ2VuZXJhdGUgKGltYWdlQ291bnQpLgogICQoJ25jb2xsYmwnKS50ZXh0Q29udGVudD1TdHJpbmcoc3RhdGUubmNvbCk7CiAgcmVuZGVyR3JpZCgpOwp9CiQoJ25jb2wnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICBzdGF0ZS5uY29sID0gc3RhdGUubmNvbD09PTI/MToyOwogIGFwcGx5TmNvbCgpOwp9KTsKJCgnbmNvdW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbigpewogIHN0YXRlLm5jb2w9cGFyc2VJbnQoJCgnbmNvdW50JykudmFsdWUpfHwxOwogIGFwcGx5TmNvbCgpOwp9KTsKCi8qID09PT09IGdlbmVyYXRlIChyZWFsIEFQSSAvIGRlbW8gZmFsbGJhY2spID09PT09ICovCiQoJ2J0bi1nbycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxkb0dlbmVyYXRlKTsKZnVuY3Rpb24gc2V0QnVzeShiKXsKICB2YXIgZWw9JCgnYnRuLWdvJyk7IGlmKCFlbCkgcmV0dXJuOwogIGVsLmRpc2FibGVkPWI7IGVsLnN0eWxlLm9wYWNpdHk9Yj8nMC41JzonMSc7CiAgZWwuaW5uZXJIVE1MPWI/JzxpIGRhdGEtaWNvbj0iY2lyY2xlLW5vdGNoIiBjbGFzcz0idy00IGgtNCBhbmltYXRlLXNwaW4iPjwvaT5HZW5lcmF0aW5nLi4uJwogICAgOic8aSBkYXRhLWljb249ImxpZ2h0bmluZyIgY2xhc3M9InctNCBoLTQiPjwvaT5HZW5lcmF0ZSA8c3BhbiBjbGFzcz0idGV4dC14cyBvcGFjaXR5LTkwIGZvbnQtbm9ybWFsIiBpZD0icHJpY2UiPi0gMS4yMjwvc3Bhbj4nOwp9CmZ1bmN0aW9uIGV4dHJhY3RJbWFnZXMoZGF0YSl7CiAgaWYoIWRhdGEpIHJldHVybiBbXTsKICBpZihBcnJheS5pc0FycmF5KGRhdGEpKSBkYXRhPXtpbWFnZXM6ZGF0YX07CiAgdmFyIGltZ3M9ZGF0YS5pbWFnZXN8fGRhdGEuZGF0YSYmZGF0YS5kYXRhLmltYWdlc3x8ZGF0YS5yZXN1bHQmJmRhdGEucmVzdWx0LmltYWdlc3x8ZGF0YS51cmxzfHxbXTsKICByZXR1cm4gaW1ncy5tYXAoZnVuY3Rpb24oaSl7IHJldHVybiB0eXBlb2YgaT09PSdzdHJpbmcnP2k6KGkudXJsfHxpLnNyY3x8aS5pbWFnZXx8aS5wYXRoKTsgfSkuZmlsdGVyKEJvb2xlYW4pOwp9Ci8qID09PT09IGhhc2lsICsgcml3YXlhdCAocGVyc2lzdCBsb2NhbFN0b3JhZ2UpID09PT09ICovCmZ1bmN0aW9uIHBlcnNpc3RSZXN1bHRzKCl7CiAgdHJ5eyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShSRVNVTFRTX0tFWSxKU09OLnN0cmluZ2lmeShzdGF0ZS5yZXN1bHRzLnNsaWNlKDAsNjApKSk7IH1jYXRjaChlKXt9Cn0KLyogVGFtcGlsYW4gdGVuZ2FoOiBnYWxlcmkgc2VtdWEgaGFzaWwgbWVudW1wdWsga2UgYmF3YWggKHNlcGVydGkgVGVuc29yLkFydCksCiAgIHRpYXAgYmFyaXMgPSBnYW1iYXIgKyBkZXRhaWwgZGkga2FuYW5ueWEuIFNjcm9sbCBrZSBiYXdhaCBtdW5jdWwgc2VtdWEuICovCnZhciBfdmlld0lkeD0wOyAvLyBpbmRleCBrZSBzdGF0ZS5yZXN1bHRzICgwID0gdGVyYmFydSkKZnVuY3Rpb24gbWFrZUdhbGxlcnlSb3cocixpKXsKICB2YXIgcm93PWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogIHJvdy5jbGFzc05hbWU9J2ZsZXggZ2FwLTQgYm9yZGVyIGJkIHJvdW5kZWQtMnhsIGJnLVsjMTYxYjIyXSBwLTMnOwogIHZhciBpbWdXcmFwPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogIGltZ1dyYXAuY2xhc3NOYW1lPSdzaHJpbmstMCB3LVs0MiVdIHNtOnctWzM0JV0gZmxleCBpdGVtcy1zdGFydCBqdXN0aWZ5LWNlbnRlciBiZy1ibGFjay8zMCByb3VuZGVkLXhsIG92ZXJmbG93LWhpZGRlbic7CiAgdmFyIGltZz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbWcnKTsKICBpbWcuc3JjPXIuc3JjOwogIGltZy5jbGFzc05hbWU9J3ctZnVsbCBoLWF1dG8gbWF4LWgtWzcwdmhdIG9iamVjdC1jb250YWluIGN1cnNvci16b29tLWluJzsKICBpbWcuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IG9wZW5MaWdodGJveChyKTsgfSk7CiAgaW1nV3JhcC5hcHBlbmRDaGlsZChpbWcpOwogIGlmKHIuZGVtbyl7CiAgICB2YXIgYmQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpOwogICAgYmQuY2xhc3NOYW1lPSdhYnNvbHV0ZSB0b3AtMiBsZWZ0LTIgdGV4dC1bOXB4XSBiZy1ibGFjay82MCBweC0xLjUgcHktMC41IHJvdW5kZWQgdGV4dC1uZXV0cmFsLTMwMCc7CiAgICBiZC50ZXh0Q29udGVudD0nREVNTyc7IGltZ1dyYXAuYXBwZW5kQ2hpbGQoYmQpOwogIH0KICByb3cuYXBwZW5kQ2hpbGQoaW1nV3JhcCk7CiAgdmFyIG1ldGE9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgbWV0YS5jbGFzc05hbWU9J2ZsZXgtMSBtaW4tdy0wIHRleHQteHMgc3BhY2UteS0xLjUgdGV4dC1uZXV0cmFsLTQwMCc7CiAgdmFyIGxibD1yLmRlbW8/J0RlbW8gKHNpbXVsYXNpKSc6KHIucGFnZT09PSdpbWcnPydJbWFnZSB0byBJbWFnZSc6J1RleHQgdG8gSW1hZ2UnKTsKICB2YXIgZXhwaXJlcz1yLnRzP25ldyBEYXRlKHIudHMrNyoyNCozNjAwKjEwMDApLnRvTG9jYWxlU3RyaW5nKCdpZC1JRCcpOicnOwogIHZhciBoPScnOwogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41Ij48aSBkYXRhLWljb249InNwYXJrbGUiIGNsYXNzPSJ3LTMgaC0zIHRleHQtdmlvbGV0LTQwMCI+PC9pPjxzcGFuIGNsYXNzPSJiZy12aW9sZXQtNTAwLzEwIHRleHQtdmlvbGV0LTMwMCBweC0xLjUgcHktcHggcm91bmRlZCB0ZXh0LVsxMHB4XSI+JytsYmwrJzwvc3Bhbj4nOwogIGgrPSc8c3BhbiBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCB0cnVuY2F0ZSI+Jysoci5tb2RlbHx8JycpKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iYmctYmxhY2svNDAgcm91bmRlZC1sZyBwLTIgdGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTMwMCBsZWFkaW5nLXNudWcgY3Vyc29yLXBvaW50ZXIgaG92ZXI6dGV4dC13aGl0ZSIgdGl0bGU9IkxpaGF0IGRldGFpbCI+Jysoci5wcm9tcHR8fCcnKS5zbGljZSgwLDE2MCkrJzwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9InNwYWNlLXktMSB0ZXh0LVsxMHB4XSI+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlRhc2sgSUQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAgdHJ1bmNhdGUgbWF4LXctWzY1JV0iIHRpdGxlPSInK2VzYyhyLnRhc2tJZCkrJyI+Jytlc2Moci50YXNrSWR8fCctJykrJzwvc3Bhbj48L2Rpdj4nOwogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q3JlZGl0czwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+Jysoci5jcmVkaXRzfHwnLScpKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNyZWF0ZWQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrZm10RGF0ZVRpbWUoci50cykrJzwvc3Bhbj48L2Rpdj4nOwogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+RXhwaXJlczwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+JytleHBpcmVzKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNpemU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrci5zaXplKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNlZWQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrci5zZWVkKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlN0ZXBzPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nKyhyLnN0ZXBzIT1udWxsJiZyLnN0ZXBzIT09Jyc/ci5zdGVwczonLScpKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNGRzwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+Jysoci5jZmchPW51bGwmJnIuY2ZnIT09Jyc/ci5jZmc6Jy0nKSsnPC9zcGFuPjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TYW1wbGVyPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nKyhyLnNhbXBsZXJ8fCctJykrJzwvc3Bhbj48L2Rpdj4nOwogIGgrPSc8L2Rpdj4nOwogIG1ldGEuaW5uZXJIVE1MPWg7CiAgbWV0YS5xdWVyeVNlbGVjdG9yKCdkaXZbdGl0bGU9IkxpaGF0IGRldGFpbCJdJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IF92aWV3SWR4PWk7IHJlbmRlckdyaWQoKTsgcmVuZGVyRGV0YWlsKCk7IH0pOwogIHJvdy5hcHBlbmRDaGlsZChtZXRhKTsKICByZXR1cm4gcm93Owp9CmZ1bmN0aW9uIHJlbmRlckdyaWQoKXsKICB2YXIgZ3JpZD0kKCdncmlkJyk7IGdyaWQuaW5uZXJIVE1MPScnOwogIHZhciBmaWw9JCgnZ2ZpbHRlcicpOwogIGlmKCFzdGF0ZS5yZXN1bHRzLmxlbmd0aCl7ICQoJ2VtcHR5Jykuc3R5bGUuZGlzcGxheT0nJzsgaWYoZmlsKSBmaWwuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7IHJldHVybjsgfQogICQoJ2VtcHR5Jykuc3R5bGUuZGlzcGxheT0nbm9uZSc7CiAgaWYoZmlsKSBmaWwuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7CiAgaWYoX3ZpZXdJZHg+PXN0YXRlLnJlc3VsdHMubGVuZ3RoKSBfdmlld0lkeD1zdGF0ZS5yZXN1bHRzLmxlbmd0aC0xOwogIHZhciBhcnI9c3RhdGUucmVzdWx0cy5zbGljZSgpOyAvLyB0ZXJiYXJ1IGR1bHVhbiAoaW5kZXggMCkKICBhcnIuZm9yRWFjaChmdW5jdGlvbihyLGkpeyBncmlkLmFwcGVuZENoaWxkKG1ha2VHYWxsZXJ5Um93KHIsaSkpOyB9KTsKfQpmdW5jdGlvbiBhZGRSZXN1bHQocil7CiAgc3RhdGUucmVzdWx0cy51bnNoaWZ0KHIpOwogIGlmKHN0YXRlLnJlc3VsdHMubGVuZ3RoPjYwKSBzdGF0ZS5yZXN1bHRzLmxlbmd0aD02MDsKICBfdmlld0lkeD0wOyAvLyB0YW1waWxrYW4gaGFzaWwgdGVyYmFydQogIHBlcnNpc3RSZXN1bHRzKCk7CiAgcmVuZGVyR3JpZCgpOwogIHJlbmRlckRldGFpbCgpOwogIHJlbmRlclJpZ2h0KCk7Cn0KCi8qID09PT09IHBhbmVsIGthbmFuOiBEZXRhaWwgaGFzaWwgYWt0aWYgKHNlcGVydGkgVGVuc29yLkFydCkgPT09PT0gKi8KZnVuY3Rpb24gZm10RGF0ZSh0cyl7IHRyeXsgcmV0dXJuIG5ldyBEYXRlKHRzKS50b0xvY2FsZURhdGVTdHJpbmcoJ2lkLUlEJyk7IH1jYXRjaChlKXsgcmV0dXJuICcnOyB9IH0KZnVuY3Rpb24gZm10RGF0ZVRpbWUodHMpeyB0cnl7IHJldHVybiBuZXcgRGF0ZSh0cykudG9Mb2NhbGVTdHJpbmcoJ2lkLUlEJyk7IH1jYXRjaChlKXsgcmV0dXJuICcnOyB9IH0KZnVuY3Rpb24gY29weVRleHQodil7CiAgaWYoIXYpIHJldHVybjsKICBpZihuYXZpZ2F0b3IuY2xpcGJvYXJkJiZuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dCl7IG5hdmlnYXRvci5jbGlwYm9hcmQud3JpdGVUZXh0KHYpLnRoZW4oZnVuY3Rpb24oKXsgdG9hc3QoJ1RlcnNhbGluIOKckycpOyB9KTsgfQogIGVsc2UgdG9hc3QoJ1Rhc2sgSUQ6ICcrdik7Cn0KZnVuY3Rpb24gcmVuZGVyRGV0YWlsKCl7CiAgdmFyIGVsPSQoJ3JkZXRhaWwnKTsgaWYoIWVsKSByZXR1cm47CiAgaWYoIXN0YXRlLnJlc3VsdHMubGVuZ3RoKXsgZWwuaW5uZXJIVE1MPSc8cCBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIHAtNCB0ZXh0LWNlbnRlciI+QmVsdW0gYWRhIGhhc2lsLjwvcD4nOyByZXR1cm47IH0KICBpZihfdmlld0lkeD49c3RhdGUucmVzdWx0cy5sZW5ndGgpIF92aWV3SWR4PXN0YXRlLnJlc3VsdHMubGVuZ3RoLTE7CiAgdmFyIHI9c3RhdGUucmVzdWx0c1tfdmlld0lkeF07CiAgdmFyIGxibD1yLmRlbW8/J0RlbW8gKHNpbXVsYXNpKSc6KHIucGFnZT09PSdpbWcnPydJbWFnZSB0byBJbWFnZSc6J1RleHQgdG8gSW1hZ2UnKTsKICB2YXIgZXhwaXJlcz1yLnRzP25ldyBEYXRlKHIudHMrNyoyNCozNjAwKjEwMDApLnRvTG9jYWxlU3RyaW5nKCdpZC1JRCcpOicnOwogIHZhciBoPScnOwogIC8vIG1vZGVsIGJhZGdlCiAgaCs9JzxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0yLjUgYm9yZGVyIGJkIHJvdW5kZWQteGwgcC0yLjUgYmctWyMxYzIxMjhdIj4nCiAgICArJzxpbWcgc3JjPSInKyhyLnNyY3x8JycpKyciIGNsYXNzPSJ3LTEwIGgtMTAgcm91bmRlZC1sZyBvYmplY3QtY292ZXIgYm9yZGVyIGJkIi8+JwogICAgKyc8ZGl2IGNsYXNzPSJtaW4tdy0wIj48ZGl2IGNsYXNzPSJ0ZXh0LXhzIGZvbnQtbWVkaXVtIHRydW5jYXRlIj4nKyhyLm1vZGVsfHwnTW9kZWwnKSsnPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNTAwIj4nK2xibCsnPC9kaXY+PC9kaXY+JwogICAgKyc8YnV0dG9uIGNsYXNzPSJtbC1hdXRvIHctNyBoLTcgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC1uZXV0cmFsLTUwMCBob3Zlcjp0ZXh0LXdoaXRlIiB0aXRsZT0iVHV0dXAgZGV0YWlsIj48aSBkYXRhLWljb249IngiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9idXR0b24+JwogICAgKyc8L2Rpdj4nOwogIC8vIGlucHV0IHByb21wdAogIGgrPSc8ZGl2PjxkaXYgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAgbWItMSI+SW5wdXQ8L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImJnLWJsYWNrLzQwIGJvcmRlciBiZCByb3VuZGVkLWxnIHAtMi41IHRleHQtWzExcHhdIHRleHQtbmV1dHJhbC0zMDAgbGVhZGluZy1yZWxheGVkIG1heC1oLTI4IG92ZXJmbG93LXktYXV0byBoaWRlYmFyIj4nKyhyLnByb21wdHx8Jy0nKSsnPC9kaXY+PC9kaXY+JzsKICAvLyBkZXRhaWxzCiAgaCs9JzxkaXY+PGRpdiBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCBtYi0xIj5EZXRhaWxzPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJzcGFjZS15LTEuNSB0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNDAwIj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGdhcC0yIj48c3Bhbj5UYXNrIElEPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIGZsZXggaXRlbXMtY2VudGVyIGdhcC0xIG1pbi13LTAiPjxzcGFuIGNsYXNzPSJ0cnVuY2F0ZSIgdGl0bGU9IicrZXNjKHIudGFza0lkKSsnIj4nKyhyLnRhc2tJZHx8Jy0nKSsnPC9zcGFuPicKICAgICsoci50YXNrSWQ/JzxidXR0b24gY2xhc3M9InRleHQtbmV1dHJhbC01MDAgaG92ZXI6dGV4dC13aGl0ZSBzaHJpbmstMCIgdGl0bGU9IlNhbGluIj48aSBkYXRhLWljb249ImNvcHkiIGNsYXNzPSJ3LTMuNSBoLTMuNSI+PC9pPjwvYnV0dG9uPic6JycpKyc8L3NwYW4+PC9kaXY+JwogICAgKyhyLmNyZWRpdHM/JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DcmVkaXRzPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK3IuY3JlZGl0cysnPC9zcGFuPjwvZGl2Pic6JycpCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DcmVhdGVkIGRhdGU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrZm10RGF0ZVRpbWUoci50cykrJzwvc3Bhbj48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5FeHBpcmVzIGRhdGU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrZXhwaXJlcysnPC9zcGFuPjwvZGl2PicKICAgICsnPC9kaXY+PC9kaXY+JzsKICAvLyBuZWdhdGl2ZSBwcm9tcHQKICBoKz0nPGRpdj48ZGl2IGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIG1iLTEiPk5lZ2F0aXZlIHByb21wdDwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iYmctYmxhY2svNDAgYm9yZGVyIGJkIHJvdW5kZWQtbGcgcC0yLjUgdGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTMwMCBsZWFkaW5nLXJlbGF4ZWQgbWF4LWgtMjAgb3ZlcmZsb3cteS1hdXRvIGhpZGViYXIiPicrKHIubmVnfHwnLScpKyc8L2Rpdj48L2Rpdj4nOwogIC8vIHBhcmFtcwogIGgrPSc8ZGl2IGNsYXNzPSJncmlkIGdyaWQtY29scy0yIGdhcC14LTMgZ2FwLXktMS41IHRleHQtWzExcHhdIHRleHQtbmV1dHJhbC00MDAgYm9yZGVyLXQgYmQgcHQtMi41Ij4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TaXplPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK3Iuc2l6ZSsnPC9zcGFuPjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNlZWQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAgdHJ1bmNhdGUiPicrci5zZWVkKyc8L3NwYW4+PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U3RlcHM8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrKHIuc3RlcHMhPW51bGw/ci5zdGVwczonLScpKyc8L3NwYW4+PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q0ZHIHNjYWxlPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nKyhyLmNmZyE9bnVsbD9yLmNmZzonLScpKyc8L3NwYW4+PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2FtcGxlcjwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+Jysoci5zYW1wbGVyfHwnLScpKyc8L3NwYW4+PC9kaXY+JwogICAgKyc8L2Rpdj4nOwogIGVsLmlubmVySFRNTD1oOwogIHZhciBjb3B5QnRuPWVsLnF1ZXJ5U2VsZWN0b3IoJ2J1dHRvblt0aXRsZT0iU2FsaW4iXScpOwogIGlmKGNvcHlCdG4pIGNvcHlCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IGNvcHlUZXh0KHIudGFza0lkKTsgfSk7CiAgdmFyIGNsb3NlQnRuPWVsLnF1ZXJ5U2VsZWN0b3IoJ2J1dHRvblt0aXRsZT0iVHV0dXAgZGV0YWlsIl0nKTsKICBpZihjbG9zZUJ0bikgY2xvc2VCdG4uYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7ICQoJ3JpZ2h0UGFuJykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7IH0pOwp9CmZ1bmN0aW9uIGVzYyhzKXsgcmV0dXJuIFN0cmluZyhzPT1udWxsPycnOnMpLnJlcGxhY2UoLyYvZywnJmFtcDsnKS5yZXBsYWNlKC88L2csJyZsdDsnKS5yZXBsYWNlKC8+L2csJyZndDsnKS5yZXBsYWNlKC8iL2csJyZxdW90OycpOyB9CgovKiA9PT09PSByaWdodCBoaXN0b3J5ID09PT09ICovCmZ1bmN0aW9uIHJlbmRlclJpZ2h0KCl7CiAgdmFyIGxpc3Q9JCgncmxpc3QnKTsgbGlzdC5pbm5lckhUTUw9Jyc7CiAgaWYoIXN0YXRlLnJlc3VsdHMubGVuZ3RoKXsgbGlzdC5pbm5lckhUTUw9JzxwIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgcC00IHRleHQtY2VudGVyIj5CZWx1bSBhZGEgaGFzaWwuPC9wPic7ICQoJ3Jjb3VudCcpLnRleHRDb250ZW50PScwIGhhc2lsJzsgcmV0dXJuOyB9CiAgJCgncmNvdW50JykudGV4dENvbnRlbnQ9c3RhdGUucmVzdWx0cy5sZW5ndGgrJyBoYXNpbCc7CiAgc3RhdGUucmVzdWx0cy5mb3JFYWNoKGZ1bmN0aW9uKHIsaSl7CiAgICB2YXIgZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsgZC5jbGFzc05hbWU9J3JjYXJkJzsKICAgIHZhciBsYmw9ci5kZW1vPydEZW1vIChzaW11bGFzaSknOihyLnBhZ2U9PT0naW1nJz8nSW1hZ2UgdG8gSW1hZ2UnOidUZXh0IHRvIEltYWdlJyk7CiAgICBkLmlubmVySFRNTD0nPGRpdiBjbGFzcz0icmVsYXRpdmUiPicKICAgICAgKyc8aW1nIHNyYz0iJytyLnNyYysnIiBjbGFzcz0idy1mdWxsIGFzcGVjdC1bNC8zXSBvYmplY3QtY292ZXIgY3Vyc29yLXBvaW50ZXIiLz4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0iYWJzb2x1dGUgdG9wLTEuNSByaWdodC0xLjUgdy02IGgtNiByb3VuZGVkLW1kIGJnLWJsYWNrLzUwIGhvdmVyOmJnLXJlZC01MDAvODAgdGV4dC13aGl0ZSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB0ZXh0LXhzIiB0aXRsZT0iSGFwdXMiPuKclTwvYnV0dG9uPicKICAgICAgKyc8L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0icC0yLjUgc3BhY2UteS0xLjUgdGV4dC14cyI+JwogICAgICArJzxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUiPjxpIGRhdGEtaWNvbj0ic3BhcmtsZSIgY2xhc3M9InctMyBoLTMgdGV4dC12aW9sZXQtNDAwIj48L2k+PHNwYW4gY2xhc3M9ImJnLXZpb2xldC01MDAvMTAgdGV4dC12aW9sZXQtMzAwIHB4LTEuNSBweS1weCByb3VuZGVkIHRleHQtWzEwcHhdIj4nK2xibCsnPC9zcGFuPjwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJiZy1ibGFjay80MCByb3VuZGVkIHAtMS41IHRleHQtWzExcHhdIHRleHQtbmV1dHJhbC0zMDAgbGVhZGluZy1zbnVnIGN1cnNvci1wb2ludGVyIGhvdmVyOnRleHQtd2hpdGUiIHRpdGxlPSJMaWhhdCBkZXRhaWwiPicrKHIucHJvbXB0fHwnJykuc2xpY2UoMCw5MCkrJzwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSB0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNTAwIj48aSBkYXRhLWljb249ImxheWVycyIgY2xhc3M9InctMyBoLTMiPjwvaT4nK0xPUkEuZmlsdGVyKGZ1bmN0aW9uKGwpe3JldHVybiBsLnc+MH0pLmxlbmd0aCsnIExvUkE8L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0ic3BhY2UteS0xIHRleHQtWzEwcHhdIHRleHQtbmV1dHJhbC01MDAiPicKICAgICAgKyhyLnRhc2tJZD8nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlRhc2sgSUQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAgdHJ1bmNhdGUgbWF4LXctWzYwJV0iIHRpdGxlPSInK2VzYyhyLnRhc2tJZCkrJyI+Jytlc2Moci50YXNrSWQpKyc8L3NwYW4+PC9kaXY+JzonJykKICAgICAgKyhyLmNyZWRpdHM/JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DcmVkaXRzPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK3IuY3JlZGl0cysnPC9zcGFuPjwvZGl2Pic6JycpCiAgICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNyZWF0ZWQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrZm10RGF0ZShyLnRzKSsnPC9zcGFuPjwvZGl2PicKICAgICAgKyhyLm5lZz8nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPk5lZ2F0aXZlPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIHRydW5jYXRlIG1heC13LVs2MCVdIiB0aXRsZT0iJytlc2Moci5uZWcpKyciPicrZXNjKHIubmVnKSsnPC9zcGFuPjwvZGl2Pic6JycpCiAgICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNpemU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrci5zaXplKyc8L3NwYW4+PC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TZWVkPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK3Iuc2VlZCsnPC9zcGFuPjwvZGl2PicKICAgICAgKyc8L2Rpdj48L2Rpdj4nOwogICAgZC5xdWVyeVNlbGVjdG9yKCdpbWcnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgX3ZpZXdJZHg9aTsgcmVuZGVyR3JpZCgpOyByZW5kZXJEZXRhaWwoKTsgb3BlbkxpZ2h0Ym94KHIpOyB9KTsKICAgIGQucXVlcnlTZWxlY3RvcignLmJnLWJsYWNrXFwvNDAnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgX3ZpZXdJZHg9aTsgcmVuZGVyR3JpZCgpOyByZW5kZXJEZXRhaWwoKTsgb3BlbkxpZ2h0Ym94KHIpOyB9KTsKICAgIGQucXVlcnlTZWxlY3RvcignYnV0dG9uJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgICAgIHN0YXRlLnJlc3VsdHMuc3BsaWNlKGksMSk7IHBlcnNpc3RSZXN1bHRzKCk7IHJlbmRlckdyaWQoKTsgcmVuZGVyRGV0YWlsKCk7IHJlbmRlclJpZ2h0KCk7CiAgICB9KTsKICAgIGxpc3QuYXBwZW5kQ2hpbGQoZCk7CiAgfSk7Cn0KCi8qID09PT09IGxpZ2h0Ym94ID09PT09ICovCmZ1bmN0aW9uIG9wZW5MaWdodGJveChyKXsKICAkKCdsYi1pbWcnKS5zcmM9ci5zcmM7CiAgdmFyIGg9Jyc7CiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5Nb2RlbDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+Jysoci5tb2RlbHx8Jy0nKSsnPC9zcGFuPjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5Qcm9tcHQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrKHIucHJvbXB0fHwnLScpKyc8L3NwYW4+PC9kaXY+JzsKICBpZihyLm5lZykgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5OZWdhdGl2ZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+JytyLm5lZysnPC9zcGFuPjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TaXplPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nKyhyLnNpemV8fCctJykrJzwvc3Bhbj48L2Rpdj4nOwogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2VlZDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+Jysoci5zZWVkfHwnLScpKyc8L3NwYW4+PC9kaXY+JzsKICBpZihyLnRhc2tJZCkgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5UYXNrIElEPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nK3IudGFza0lkKyc8L3NwYW4+PC9kaXY+JzsKICBpZihyLmNyZWRpdHMpIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q3JlZGl0czwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+JytyLmNyZWRpdHMrJzwvc3Bhbj48L2Rpdj4nOwogIGgrPSc8ZGl2IGNsYXNzPSJtdC0yIj48YSBocmVmPSInK3Iuc3JjKyciIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIiBjbGFzcz0idGV4dC1bIzZGNURGRl0gaG92ZXI6dW5kZXJsaW5lIHRleHQteHMiPkJ1a2EgZ2FtYmFyIGFzbGkgJm5lYXJyOzwvYT48L2Rpdj4nOwogICQoJ2xiLW1ldGEnKS5pbm5lckhUTUw9aDsKICAkKCdsaWdodGJveCcpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyAkKCdsaWdodGJveCcpLmNsYXNzTGlzdC5hZGQoJ2ZsZXgnKTsKfQokKCdsYi1jbG9zZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyAkKCdsaWdodGJveCcpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyAkKCdsaWdodGJveCcpLmNsYXNzTGlzdC5yZW1vdmUoJ2ZsZXgnKTsgfSk7CiQoJ2xpZ2h0Ym94JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKGUpeyBpZihlLnRhcmdldD09PSQoJ2xpZ2h0Ym94JykpeyAkKCdsaWdodGJveCcpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyAkKCdsaWdodGJveCcpLmNsYXNzTGlzdC5yZW1vdmUoJ2ZsZXgnKTsgfSB9KTsKCi8qID09PT09IHBheWxvYWQgKHN0cnVrdHVyIG55YXRhIFRlbnNvci5BcnQpID09PT09ICovCmZ1bmN0aW9uIGJ1aWxkUGF5bG9hZCgpewogIHZhciBuZWc9JCgnbmVnY2hlY2snKS5jaGVja2VkPyQoJ25lZ3Byb21wdCcpLnZhbHVlOicnOwogIHZhciBtPXN0YXRlLm1vZGVsOwogIHJldHVybiB7CiAgICBwYXJhbXM6ewogICAgICBiYXNlTW9kZWw6eyBtb2RlbElkOm0ubW9kZWxJZCwgbW9kZWxGaWxlSWQ6bS5tb2RlbEZpbGVJZCB9LAogICAgICBtb2RlbDpzZXR0aW5ncy5wcm92aWRlcj09PSd0YW1zJz8nJzoobSYmbS5tb2RlbD9tLm1vZGVsOicnKSwKICAgICAgc2R4bDp7IHJlZmluZXI6ZmFsc2UgfSwKICAgICAgbW9kZWxzOkxPUkEuZmlsdGVyKGZ1bmN0aW9uKGwpe3JldHVybiBsLnc+MH0pLm1hcChmdW5jdGlvbihsKXtyZXR1cm4geyBuYW1lOmwubmFtZSwgd2VpZ2h0OmwudywgdHJpZ2dlcldvcmRzOmwudGFncywgbG9yYU1vZGVsOmwubG9yYU1vZGVsfHwnJywgbG9yYVVybDpsLmxvcmFVcmx8fCcnIH0gfSksCiAgICAgIGVtYmVkZGluZ01vZGVsczpbXSwKICAgICAgc2RWYWU6JCgndmFlJykudmFsdWU9PT0nYXV0b21hdGljJz8nQXV0b21hdGljJzokKCd2YWUnKS52YWx1ZSwKICAgICAgcHJvbXB0OiQoJ3Byb21wdCcpLnZhbHVlLAogICAgICBuZWdhdGl2ZVByb21wdDpuZWcsCiAgICAgIGhlaWdodDpwYXJzZUludCgkKCdoZWlnaHQnKS52YWx1ZSksCiAgICAgIHdpZHRoOnBhcnNlSW50KCQoJ3dpZHRoJykudmFsdWUpLAogICAgICBpbWFnZUNvdW50OnN0YXRlLm5jb2wsCiAgICAgIHN0ZXBzOnBhcnNlSW50KCQoJ3N0ZXBzJykudmFsdWUpLAogICAgICBpbWFnZXM6aTJpRGF0YVVybD9baTJpRGF0YVVybF06W10sCiAgICAgIGRlbm9pc2luZ1N0cmVuZ3RoOnBhcnNlRmxvYXQoJCgnaTJpLWRzJykudmFsdWUpfHwwLjUsCiAgICAgIGNmZ1NjYWxlOnBhcnNlRmxvYXQoJCgnY2ZnJykudmFsdWUpLAogICAgICBzZWVkOigkKCdzZWVkJykudmFsdWV8fCcnKS50cmltKCl8fFN0cmluZyhNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkqOTk5OTk5OTk5OSkpLAogICAgICBjbGlwU2tpcDpwYXJzZUludCgkKCdjbGlwc2tpcCcpLnZhbHVlKSwKICAgICAgZXRhTm9pc2VTZWVkRGVsdGE6cGFyc2VJbnQoJCgnZXRhbnNkJykudmFsdWUpLAogICAgICB2MUNsaXA6ZmFsc2UsCiAgICAgIGVuYWJsZVBpeDJwaXg6c3RhdGUucGFnZT09PSdpbWcnJiYhIWkyaURhdGFVcmwsCiAgICAgIGd1aWRhbmNlOjMuNSwKICAgICAgdXNlRmlyc3RMYXN0RnJhbWU6ZmFsc2UsCiAgICAgIGtzYW1wbGVyTmFtZTokKCdzYW1wbGVyJykudmFsdWUsCiAgICAgIHNjaGVkdWxlOiQoJ3NjaGVkJykudmFsdWUKICAgIH0sCiAgICBwcm92aWRlcjpzZXR0aW5ncy5wcm92aWRlcnx8J3RhbXMnLAogICAgY3JlZGl0czoxLjIyLAogICAgdGFza1R5cGU6c3RhdGUucGFnZT09PSdpbWcnJiZpMmlEYXRhVXJsPydJTUcySU1HJzonVFhUMklNRycsCiAgICBpc1JlbWl4OmZhbHNlLAogICAgY2FwdGNoYVR5cGU6J0NMT1VERkxBUkVfVFVSTlNUSUxFJwogIH07Cn0KLyogPT09PT09PT09PT09IFJFS1RZIEdFTkVSQVRPUiDigJQgdmVyc2kgd2ViIGZ1bGwgPT09PT09PT09PT09CiAqIEdlbmVyYXRlIGFzbGkgdmlhIGJhY2tlbmQgKC9hcGkgLT4gVGVuc29yLkFydCBNb2RlbCBTZXJ2aWNlKQogKiBhdGF1IG1vZGUgZGVtbyAocGljc3VtKSBrYWxhdSBiYWNrZW5kL0FQSSBrZXkgYmVsdW0gYWt0aWYuCiAqID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KdmFyIFNFVFRJTkdTX0tFWT0ncmVrdHkuc2V0dGluZ3MnLCBSRVNVTFRTX0tFWT0ncmVrdHkucmVzdWx0cyc7CnZhciBzZXR0aW5ncz17IG1vZGU6J2F1dG8nLCBwcm92aWRlcjondGFtcycsIGFwaUtleTonJywgcG9sbFNlc3Npb246JycgfTsKdmFyIFBST1ZJREVSX0lORk89ewogIHRhbXM6eyBsYWJlbDonQVBJIEtleSBUQU1TICh0YW1zLnRlbnNvci5hcnQpJywgaGludDonR3JhdGlzIGRpIHRhbXMudGVuc29yLmFydCDigJQgcGFrYWkgZGFmdGFyIE1vZGVsIGRpIFVJLicgfSwKICByZXBsaWNhdGU6eyBsYWJlbDonQVBJIFRva2VuIFJlcGxpY2F0ZSAocmVwbGljYXRlLmNvbSknLCBoaW50OidQaWxpaCBtb2RlbCBkaSBrYXJ0dSBNb2RlbCAoRkxVWCwgU0RYTCwgZHN0KS4gSW1nMkltZyBiZWx1bSBkaWR1a3VuZy4nIH0sCiAgZmFsOnsgbGFiZWw6J0FQSSBLZXkgZmFsLmFpIChmYWwuYWkpJywgaGludDonUGlsaWggbW9kZWwgZGkga2FydHUgTW9kZWwgKEZMVVgsIFNEWEwsIGRzdCkuIEltZzJJbWcgYmVsdW0gZGlkdWt1bmcuJyB9LAogIHBvbGxpbmF0aW9uczp7IGxhYmVsOidBUEkgS2V5IFBvbGxpbmF0aW9ucyAob3BzaW9uYWwg4oCUIHNrXyopJywgaGludDonR3JhdGlzIHRhbnBhIGtleSAobW9kZWwgb3RvbWF0aXMpLiBJc2kga2V5IHNrXyogZGFyaSBlbnRlci5wb2xsaW5hdGlvbnMuYWkva2V5cyB1bnR1ayBkYWZ0YXIgbW9kZWwgbGVuZ2thcC4gSGFzaWwgb3RvbWF0aXMgZGlhcnNpcCBwZXJtYW5lbi4nIH0KfTsKCmZ1bmN0aW9uIGxvYWRTZXR0aW5ncygpewogIHRyeXsKICAgIHZhciBzPUpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oU0VUVElOR1NfS0VZKXx8J3t9Jyk7CiAgICBpZihzJiZ0eXBlb2Ygcz09PSdvYmplY3QnKXsKICAgICAgc2V0dGluZ3MubW9kZT1zLm1vZGV8fCdhdXRvJzsgc2V0dGluZ3MucHJvdmlkZXI9cy5wcm92aWRlcnx8J3RhbXMnOyBzZXR0aW5ncy5hcGlLZXk9cy5hcGlLZXl8fCcnOwogICAgICBzZXR0aW5ncy5wb2xsU2Vzc2lvbj1zLnBvbGxTZXNzaW9ufHwnJzsKICAgIH0KICB9Y2F0Y2goZSl7fQp9CmZ1bmN0aW9uIHNhdmVTZXR0aW5ncygpeyB0cnl7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKFNFVFRJTkdTX0tFWSxKU09OLnN0cmluZ2lmeShzZXR0aW5ncykpOyB9Y2F0Y2goZSl7fSB9CmZ1bmN0aW9uIGFwcGx5U2V0dGluZ3NVSSgpewogICQoJ2FwaW1vZGUnKS52YWx1ZT1zZXR0aW5ncy5tb2RlOyAkKCdhcGlrZXknKS52YWx1ZT1zZXR0aW5ncy5hcGlLZXk7CiAgdXBkYXRlUHJvdmlkZXJVSSgpOwp9CmZ1bmN0aW9uIHVwZGF0ZVByb3ZpZGVyVUkoKXsKICB2YXIgaW5mbz1QUk9WSURFUl9JTkZPW3NldHRpbmdzLnByb3ZpZGVyXXx8UFJPVklERVJfSU5GTy50YW1zOwogICQoJ2FwaXByb3ZpZGVyJykudmFsdWU9c2V0dGluZ3MucHJvdmlkZXI7CiAgJCgnYXBpa2V5LWxhYmVsJykudGV4dENvbnRlbnQ9aW5mby5sYWJlbDsKICAkKCdhcGktaGludCcpLnRleHRDb250ZW50PWluZm8uaGludDsKICB2YXIgaXNQb2xsPXNldHRpbmdzLnByb3ZpZGVyPT09J3BvbGxpbmF0aW9ucyc7CiAgJCgnYXBpa2V5LWZpZWxkJykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJyxpc1BvbGwpOwogICQoJ2J5b3Atcm93JykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJywhaXNQb2xsKTsKICBpZihpc1BvbGwpIHJlZnJlc2hPQXV0aFN0YXR1cygpOwogIHVwZGF0ZUFwaVN0YXR1cygpOwogIC8vIEdhbnRpIGRhZnRhciBtb2RlbCBzZXN1YWkgcHJvdmlkZXIgYWt0aWYuCiAgdmFyIGxpYj1NT0RFTF9MSUJTW3NldHRpbmdzLnByb3ZpZGVyXXx8TU9ERUxfTElCUy50YW1zOwogIGlmKE1PREVMUyE9PWxpYil7CiAgICBNT0RFTFM9bGliOwogICAgaWYoTU9ERUxTLmxlbmd0aCkgc2V0TW9kZWwoTU9ERUxTWzBdKTsKICB9CiAgLy8gR2FudGkgZGFmdGFyIExvUkEgc2VzdWFpIHByb3ZpZGVyIChMb1JBIGxhbWEgZGliZXJzaWhrYW4pLgogIExPUkFfTElCPUxPUkFfTElCU1tzZXR0aW5ncy5wcm92aWRlcl18fExPUkFfTElCUy50YW1zOwogIExPUkEubGVuZ3RoPTA7CiAgcmVuZGVyTG9yYSgpOwogIC8vIFBvbGxpbmF0aW9uczogYW1iaWwgZGFmdGFyIG1vZGVsIGFzbGkgZGFyaSBBUEkgKGZhbGxiYWNrIGtlIGRhZnRhciBzdGF0aXMpLgogIGlmKHNldHRpbmdzLnByb3ZpZGVyPT09J3BvbGxpbmF0aW9ucycpIHJlZnJlc2hQb2xsaW5hdGlvbnNNb2RlbHMoKTsKfQpmdW5jdGlvbiByZWZyZXNoUG9sbGluYXRpb25zTW9kZWxzKCl7CiAgZmV0Y2goJy9hcGkvcG9sbGluYXRpb25zLW1vZGVscycpLnRoZW4oZnVuY3Rpb24ocil7IHJldHVybiByLmpzb24oKTsgfSkudGhlbihmdW5jdGlvbihkKXsKICAgIGlmKCFkfHwhQXJyYXkuaXNBcnJheShkLm1vZGVscyl8fCFkLm1vZGVscy5sZW5ndGgpIHJldHVybjsKICAgIHZhciBsaWI9ZC5tb2RlbHMKICAgICAgLmZpbHRlcihmdW5jdGlvbihtKXsgcmV0dXJuIG0uY2F0ZWdvcnk9PT0naW1hZ2UnJiZtLm5hbWUmJm0ubmFtZS5pbmRleE9mKCdieW9wLycpIT09MDsgfSkKICAgICAgLnNsaWNlKDAsODApCiAgICAgIC5tYXAoZnVuY3Rpb24obSl7IHJldHVybiB7IG5hbWU6bS50aXRsZXx8bS5uYW1lLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOm0uYnJhbmR8fCcnLCB0aHVtYjpTdHJpbmcobS5uYW1lKS5yZXBsYWNlKC9bXmEtejAtOV0vZ2ksJycpLCBiYWRnZTptLnBhaWRfb25seT8nUEFJRCc6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOm0ubmFtZSB9OyB9KQogICAgICAuc29ydChmdW5jdGlvbihhLGIpeyByZXR1cm4gKGEuYmFkZ2U9PT0nUEFJRCc/MTowKS0oYi5iYWRnZT09PSdQQUlEJz8xOjApOyB9KTsKICAgIGlmKCFsaWIubGVuZ3RoKSByZXR1cm47CiAgICBNT0RFTF9MSUJTLnBvbGxpbmF0aW9ucz1saWI7CiAgICBpZihNT0RFTFM9PT1NT0RFTF9MSUJTLnBvbGxpbmF0aW9ucyl7IHNldE1vZGVsKE1PREVMU1swXSk7IH0KICB9KS5jYXRjaChmdW5jdGlvbigpe30pOwp9CmZ1bmN0aW9uIHVwZGF0ZUFwaVN0YXR1cygpewogIHZhciBlbD0kKCdhcGktc3RhdHVzJyk7IGlmKCFlbCkgcmV0dXJuOwogIGlmKHNldHRpbmdzLnByb3ZpZGVyPT09J3BvbGxpbmF0aW9ucycpewogICAgZWwudGV4dENvbnRlbnQ9c2V0dGluZ3MucG9sbFNlc3Npb24/J1BvbGxpbmF0aW9ucyDCtyBCWU9QJzonUG9sbGluYXRpb25zIMK3IGdyYXRpcyc7CiAgICBlbC5zdHlsZS5jb2xvcj1zZXR0aW5ncy5wb2xsU2Vzc2lvbj8nIzI3RDRDRCc6JyM5YTlhYTInOwogICAgcmV0dXJuOwogIH0KICB2YXIgbmFtZT1zZXR0aW5ncy5wcm92aWRlcj09PSd0YW1zJz8nVEFNUyc6KHNldHRpbmdzLnByb3ZpZGVyPT09J3JlcGxpY2F0ZSc/J1JlcGxpY2F0ZSc6J2ZhbC5haScpOwogIGVsLnRleHRDb250ZW50PW5hbWUrKHNldHRpbmdzLmFwaUtleT8nIMK3IGtleSc6JyDCtyB0YW5wYSBrZXknKTsKICBlbC5zdHlsZS5jb2xvcj1zZXR0aW5ncy5hcGlLZXk/JyMyN0Q0Q0QnOicjOWE5YWEyJzsKfQokKCdhcGlwcm92aWRlcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsZnVuY3Rpb24oKXsKICBzZXR0aW5ncy5wcm92aWRlcj0kKCdhcGlwcm92aWRlcicpLnZhbHVlOyBzYXZlU2V0dGluZ3MoKTsgdXBkYXRlUHJvdmlkZXJVSSgpOwp9KTsKJCgnYXBpLXNhdmUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICBzZXR0aW5ncy5tb2RlPSQoJ2FwaW1vZGUnKS52YWx1ZTsgc2V0dGluZ3MuYXBpS2V5PSQoJ2FwaWtleScpLnZhbHVlLnRyaW0oKTsKICBzYXZlU2V0dGluZ3MoKTsgdXBkYXRlUHJvdmlkZXJVSSgpOyB0b2FzdCgnUGVuZ2F0dXJhbiBBUEkgZGlzaW1wYW4nKTsKfSk7CiQoJ2FwaS10ZXN0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGFzeW5jIGZ1bmN0aW9uKCl7CiAgdmFyIGI9JCgnYXBpLXRlc3QnKTsgYi5kaXNhYmxlZD10cnVlOyBiLnRleHRDb250ZW50PSdUZXMuLi4nOwogIGlmKHNldHRpbmdzLnByb3ZpZGVyPT09J3BvbGxpbmF0aW9ucycpewogICAgdHJ5ewogICAgICB2YXIgcj1hd2FpdCBmZXRjaCgnL2FwaS9oZWFsdGgnKTsKICAgICAgdmFyIGQ9YXdhaXQgci5qc29uKCkuY2F0Y2goZnVuY3Rpb24oKXtyZXR1cm4gbnVsbDt9KTsKICAgICAgaWYoIXIub2spIHRocm93IG5ldyBFcnJvcignSFRUUCAnK3Iuc3RhdHVzKTsKICAgICAgdG9hc3QoJ0JhY2tlbmQgT0sgwrcgQllPUCAnKyhkJiZkLmJ5b3A/J3NpYXAgKEFwcCBLZXkgdGVycGFzYW5nKSc6J2JlbHVtIGRpa29uZmlndXJhc2kgKEFwcCBLZXkpJykrJyDCtyAnKyhzZXR0aW5ncy5wb2xsU2Vzc2lvbj8nc2VzaSBha3RpZic6J2JlbHVtIGxvZ2luJykpOwogICAgICByZWZyZXNoT0F1dGhTdGF0dXMoKTsKICAgIH1jYXRjaChlKXsgdG9hc3QoJ0JhY2tlbmQgdGlkYWsgYWt0aWYg4oCUIGRlcGxveSBkZW5nYW4gRnVuY3Rpb25zIGF0YXUgcGFrYWkgbW9kZSBkZW1vJyk7IH0KICAgIGIuZGlzYWJsZWQ9ZmFsc2U7IGIudGV4dENvbnRlbnQ9J1Rlcyc7CiAgICByZXR1cm47CiAgfQogIHRyeXsKICAgIHZhciByPWF3YWl0IGZldGNoKCcvYXBpL2hlYWx0aCcse2hlYWRlcnM6eyd4LWFwaS1rZXknOiQoJ2FwaWtleScpLnZhbHVlLnRyaW0oKXx8c2V0dGluZ3MuYXBpS2V5fX0pOwogICAgdmFyIGQ9YXdhaXQgci5qc29uKCkuY2F0Y2goZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH0pOwogICAgaWYoIXIub2spIHRocm93IG5ldyBFcnJvcignSFRUUCAnK3Iuc3RhdHVzKTsKICAgIHZhciBwYXJ0cz1bXTsKICAgIGlmKGQmJmQuaGFzS2V5cyl7IFsndGFtcycsJ3JlcGxpY2F0ZScsJ2ZhbCddLmZvckVhY2goZnVuY3Rpb24ocCl7IGlmKGQuaGFzS2V5c1twXSkgcGFydHMucHVzaChwKTsgfSk7IH0KICAgIHRvYXN0KCdCYWNrZW5kIE9LLiBLZXkgZGkgZW52OiAnKyhwYXJ0cy5sZW5ndGg/cGFydHMuam9pbignLCAnKTondGlkYWsgYWRhJykrJy4gS2V5IGRpIGJyb3dzZXI6ICcrKHNldHRpbmdzLmFwaUtleT8nYWRhJzondGlkYWsnKSk7CiAgfWNhdGNoKGUpeyB0b2FzdCgnQmFja2VuZCB0aWRhayBha3RpZiDigJQgZGVwbG95IGRlbmdhbiBGdW5jdGlvbnMgYXRhdSBwYWthaSBtb2RlIGRlbW8nKTsgfQogIGIuZGlzYWJsZWQ9ZmFsc2U7IGIudGV4dENvbnRlbnQ9J1Rlcyc7Cn0pOwoKLyogLS0tIEJZT1AgT0F1dGggKEJyaW5nIFlvdXIgT3duIFBvbGxlbikgLS0tCiAqIExvZ2luIHZpYSBlbnRlci5wb2xsaW5hdGlvbnMuYWkgKFBLQ0UgY29kZSBmbG93KSDihpIgYmFja2VuZCB0dWthciBrb2RlIOKGkgogKiB0b2tlbiBza18gc2NvcGVkIHVzZXIgZGlzaW1wYW4gZGkgS1YgYmFja2VuZDsgYnJvd3NlciBjdW1hIHBlZ2FuZyBzZXNzaW9uLgogKi8KdmFyIF9vYXV0aFZlcmlmaWVyS2V5PSdyZWt0eS5vYXV0aC52ZXJpZmllcicsIF9vYXV0aFN0YXRlS2V5PSdyZWt0eS5vYXV0aC5zdGF0ZSc7CmZ1bmN0aW9uIF9iNjR1cmwoYnVmKXsKICB2YXIgcz1idG9hKFN0cmluZy5mcm9tQ2hhckNvZGUuYXBwbHkobnVsbCxuZXcgVWludDhBcnJheShidWYpKSk7CiAgcmV0dXJuIHMucmVwbGFjZSgvXCsvZywnLScpLnJlcGxhY2UoL1wvL2csJ18nKS5yZXBsYWNlKC89KyQvLCcnKTsKfQpmdW5jdGlvbiBfcmFuZEI2NChsZW4peyB2YXIgYT1uZXcgVWludDhBcnJheShsZW4pOyBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGEpOyByZXR1cm4gX2I2NHVybChhKTsgfQphc3luYyBmdW5jdGlvbiBfc2hhMjU2QjY0dXJsKHRleHQpewogIHZhciBidWY9YXdhaXQgY3J5cHRvLnN1YnRsZS5kaWdlc3QoJ1NIQS0yNTYnLG5ldyBUZXh0RW5jb2RlcigpLmVuY29kZSh0ZXh0KSk7CiAgcmV0dXJuIF9iNjR1cmwoYnVmKTsKfQpmdW5jdGlvbiBzdGFydFBvbGxPQXV0aCgpewogIHZhciB2ZXJpZmllcj1fcmFuZEI2NCg0OCk7CiAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oX29hdXRoVmVyaWZpZXJLZXksdmVyaWZpZXIpOwogIHZhciBzdGF0ZT1fcmFuZEI2NCgxNik7CiAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oX29hdXRoU3RhdGVLZXksc3RhdGUpOwogIGZldGNoKCcvYXBpL29hdXRoL2NvbmZpZycpLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIHIuanNvbigpO30pLnRoZW4oYXN5bmMgZnVuY3Rpb24oY2ZnKXsKICAgIGlmKCFjZmd8fCFjZmcuY2xpZW50SWQpIHRocm93IG5ldyBFcnJvcignYmFja2VuZCBiZWx1bSBwdW55YSBBcHAgS2V5IFBvbGxpbmF0aW9ucycpOwogICAgdmFyIGNoYWxsZW5nZT1hd2FpdCBfc2hhMjU2QjY0dXJsKHZlcmlmaWVyKTsKICAgIHZhciBwPW5ldyBVUkxTZWFyY2hQYXJhbXMoewogICAgICByZXNwb25zZV90eXBlOidjb2RlJywgY2xpZW50X2lkOmNmZy5jbGllbnRJZCwgcmVkaXJlY3RfdXJpOmNmZy5yZWRpcmVjdFVyaSwKICAgICAgc2NvcGU6J3VzYWdlJywgc3RhdGU6c3RhdGUsCiAgICAgIGNvZGVfY2hhbGxlbmdlOmNoYWxsZW5nZSwgY29kZV9jaGFsbGVuZ2VfbWV0aG9kOidTMjU2JwogICAgfSk7CiAgICB3aW5kb3cubG9jYXRpb24uaHJlZj1jZmcuYXV0aG9yaXplQmFzZSsnPycrcC50b1N0cmluZygpOwogIH0pLmNhdGNoKGZ1bmN0aW9uKGUpeyB0b2FzdCgnR2FnYWwgbXVsYWkgbG9naW46ICcrKGUmJmUubWVzc2FnZXx8ZSkpOyB9KTsKfQpmdW5jdGlvbiByZWZyZXNoT0F1dGhTdGF0dXMoKXsKICB2YXIgZWw9JCgnYnlvcC1zdGF0dXMnKSwgYnRuPSQoJ2J5b3AtbG9naW4nKSwgb3V0PSQoJ2J5b3AtbG9nb3V0Jyk7CiAgaWYoIXNldHRpbmdzLnBvbGxTZXNzaW9uKXsgaWYoZWwpZWwuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7IGlmKG91dClvdXQuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7IHJldHVybjsgfQogIGZldGNoKCcvYXBpL29hdXRoL3N0YXR1cz9zZXNzaW9uPScrZW5jb2RlVVJJQ29tcG9uZW50KHNldHRpbmdzLnBvbGxTZXNzaW9uKSkudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gci5qc29uKCk7fSkudGhlbihmdW5jdGlvbihkKXsKICAgIGlmKGQmJmQuY29ubmVjdGVkKXsKICAgICAgdmFyIGJhbFR4dD0nJzsKICAgICAgaWYoZC5iYWxhbmNlJiZ0eXBlb2YgZC5iYWxhbmNlPT09J29iamVjdCcpewogICAgICAgIHZhciBidj1kLmJhbGFuY2UucG9sbGVuQmFsYW5jZSE9bnVsbD9kLmJhbGFuY2UucG9sbGVuQmFsYW5jZTooZC5iYWxhbmNlLmJhbGFuY2UhPW51bGw/ZC5iYWxhbmNlLmJhbGFuY2U6bnVsbCk7CiAgICAgICAgaWYoYnYhPW51bGwpIGJhbFR4dD0nIMK3IHNhbGRvICcrYnYrJyBwb2xsZW4nOwogICAgICB9CiAgICAgIGVsLnRleHRDb250ZW50PSdUZXJodWJ1bmcg4pyTJysoZC5leHBpcmVzSW4/KCcgwrcgc2lzYSAnK01hdGguY2VpbChkLmV4cGlyZXNJbi84NjQwMCkrJyBoYXJpJyk6JycpK2JhbFR4dDsKICAgICAgZWwuc3R5bGUuY29sb3I9JyMyN0Q0Q0QnOyBlbC5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsKICAgICAgYnRuLnRleHRDb250ZW50PSdMb2dpbiB1bGFuZyAoZ2FudGkgYWt1biknOyBvdXQuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7CiAgICB9ZWxzZXsKICAgICAgZWwudGV4dENvbnRlbnQ9J1Nlc2kgYmVyYWtoaXIg4oCUIGxvZ2luIHVsYW5nJzsgZWwuc3R5bGUuY29sb3I9JyNlNWE1MGEnOwogICAgICBlbC5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgb3V0LmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOwogICAgICBzZXR0aW5ncy5wb2xsU2Vzc2lvbj0nJzsgc2F2ZVNldHRpbmdzKCk7IHVwZGF0ZUFwaVN0YXR1cygpOwogICAgfQogIH0pLmNhdGNoKGZ1bmN0aW9uKCl7fSk7Cn0KZnVuY3Rpb24gcG9sbExvZ291dCgpewogIGZldGNoKCcvYXBpL29hdXRoL2xvZ291dCcse21ldGhvZDonUE9TVCcsaGVhZGVyczp7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nfSxib2R5OkpTT04uc3RyaW5naWZ5KHtzZXNzaW9uOnNldHRpbmdzLnBvbGxTZXNzaW9ufSl9KS5jYXRjaChmdW5jdGlvbigpe30pOwogIHNldHRpbmdzLnBvbGxTZXNzaW9uPScnOyBzYXZlU2V0dGluZ3MoKTsgdXBkYXRlQXBpU3RhdHVzKCk7IHJlZnJlc2hPQXV0aFN0YXR1cygpOwogIHRvYXN0KCdTZXNpIFBvbGxpbmF0aW9ucyBkaWNhYnV0Jyk7Cn0KYXN5bmMgZnVuY3Rpb24gaGFuZGxlT0F1dGhDYWxsYmFjaygpewogIGlmKGxvY2F0aW9uLnBhdGhuYW1lIT09Jy9jYWxsYmFjaycpIHJldHVybjsKICB2YXIgcT1uZXcgVVJMU2VhcmNoUGFyYW1zKGxvY2F0aW9uLnNlYXJjaCk7CiAgdmFyIGg9bmV3IFVSTFNlYXJjaFBhcmFtcyhsb2NhdGlvbi5oYXNoLnNsaWNlKDEpKTsKICB2YXIgZXJyPXEuZ2V0KCdlcnJvcicpfHxoLmdldCgnZXJyb3InKTsKICBpZihlcnIpeyB0b2FzdCgnTG9naW4gZGliYXRhbGthbjogJytlcnIpOyBoaXN0b3J5LnJlcGxhY2VTdGF0ZShudWxsLCcnLCcvJyk7IHJldHVybjsgfQogIHZhciBjb2RlPXEuZ2V0KCdjb2RlJyk7CiAgdmFyIHN0YXRlPXEuZ2V0KCdzdGF0ZScpOwogIHZhciBzYXZlZFN0YXRlPWxvY2FsU3RvcmFnZS5nZXRJdGVtKF9vYXV0aFN0YXRlS2V5KTsKICB2YXIgdmVyaWZpZXI9bG9jYWxTdG9yYWdlLmdldEl0ZW0oX29hdXRoVmVyaWZpZXJLZXkpOwogIGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKF9vYXV0aFN0YXRlS2V5KTsgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oX29hdXRoVmVyaWZpZXJLZXkpOwogIGlmKCFjb2RlfHwhc3RhdGV8fHN0YXRlIT09c2F2ZWRTdGF0ZXx8IXZlcmlmaWVyKXsKICAgIHRvYXN0KCdDYWxsYmFjayBPQXV0aCB0aWRhayB2YWxpZCcpOyBoaXN0b3J5LnJlcGxhY2VTdGF0ZShudWxsLCcnLCcvJyk7IHJldHVybjsKICB9CiAgdmFyIGNmZz1hd2FpdCBmZXRjaCgnL2FwaS9vYXV0aC9jb25maWcnKS50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiByLmpzb24oKTt9KS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsO30pOwogIHRyeXsKICAgIHZhciByPWF3YWl0IGZldGNoKCcvYXBpL29hdXRoL3Rva2VuJyx7bWV0aG9kOidQT1NUJyxoZWFkZXJzOnsnQ29udGVudC1UeXBlJzonYXBwbGljYXRpb24vanNvbid9LAogICAgICBib2R5OkpTT04uc3RyaW5naWZ5KHtjb2RlOmNvZGUsY29kZV92ZXJpZmllcjp2ZXJpZmllcixyZWRpcmVjdF91cmk6KGNmZyYmY2ZnLnJlZGlyZWN0VXJpKXx8Jyd9KX0pOwogICAgdmFyIGQ9YXdhaXQgci5qc29uKCkuY2F0Y2goZnVuY3Rpb24oKXtyZXR1cm4gbnVsbDt9KTsKICAgIGlmKCFyLm9rfHwhZC5zZXNzaW9uKSB0aHJvdyBuZXcgRXJyb3IoKGQmJmQuZXJyb3IpfHwoJ0hUVFAgJytyLnN0YXR1cykpOwogICAgc2V0dGluZ3MucG9sbFNlc3Npb249ZC5zZXNzaW9uOyBzYXZlU2V0dGluZ3MoKTsgdXBkYXRlUHJvdmlkZXJVSSgpOwogICAgdG9hc3QoJ0xvZ2luIFBvbGxpbmF0aW9ucyBiZXJoYXNpbCEnKTsKICB9Y2F0Y2goZSl7IHRvYXN0KCdHYWdhbCB0dWthciBrb2RlOiAnKyhlJiZlLm1lc3NhZ2V8fGUpKTsgfQogIGhpc3RvcnkucmVwbGFjZVN0YXRlKG51bGwsJycsJy8nKTsKfQokKCdieW9wLWxvZ2luJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLHN0YXJ0UG9sbE9BdXRoKTsKJCgnYnlvcC1sb2dvdXQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycscG9sbExvZ291dCk7CgovKiAtLS0gdG9hc3QgLS0tICovCnZhciBfdG9hc3RUaW1lcj1udWxsOwpmdW5jdGlvbiB0b2FzdChtc2cpewogIHZhciB0PSQoJ3RvYXN0Jyk7IGlmKCF0KSByZXR1cm47CiAgdC50ZXh0Q29udGVudD1tc2c7IHQuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7CiAgY2xlYXJUaW1lb3V0KF90b2FzdFRpbWVyKTsKICBfdG9hc3RUaW1lcj1zZXRUaW1lb3V0KGZ1bmN0aW9uKCl7IHQuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7IH0sMzUwMCk7Cn0KCi8qIC0tLSBwcm9ncmVzcyBvdmVybGF5IC0tLSAqLwp2YXIgX3BvbGxTdG9wPWZhbHNlOwpmdW5jdGlvbiBzaG93UHJvZ3Jlc3ModGl0bGUsc3RhdHVzLHBjdCl7CiAgJCgncHJvZy10aXRsZScpLnRleHRDb250ZW50PXRpdGxlOwogICQoJ3Byb2ctc3RhdHVzJykudGV4dENvbnRlbnQ9c3RhdHVzfHwnJzsKICAkKCdwcm9nLWJhcicpLnN0eWxlLndpZHRoPU1hdGgubWF4KDAsTWF0aC5taW4oMTAwLHBjdHx8MCkpKyclJzsKICAkKCdwcm9nLXBjdCcpLnRleHRDb250ZW50PU1hdGgucm91bmQocGN0fHwwKSsnJSc7CiAgJCgncHJvZ292ZXJsYXknKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgJCgncHJvZ292ZXJsYXknKS5jbGFzc0xpc3QuYWRkKCdmbGV4Jyk7Cn0KZnVuY3Rpb24gaGlkZVByb2dyZXNzKCl7ICQoJ3Byb2dvdmVybGF5JykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ3Byb2dvdmVybGF5JykuY2xhc3NMaXN0LnJlbW92ZSgnZmxleCcpOyB9CiQoJ3Byb2ctY2FuY2VsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IF9wb2xsU3RvcD10cnVlOyB0b2FzdCgnTWVtYmF0YWxrYW4uLi4nKTsgfSk7CgovKiAtLS0gQVBJIGNsaWVudCAtLS0gKi8KZnVuY3Rpb24gYnVpbGRBcGlLZXkoKXsgcmV0dXJuIHNldHRpbmdzLmFwaUtleXx8JCgnYXBpa2V5JykudmFsdWUudHJpbSgpOyB9CgpmdW5jdGlvbiBfYXBpSGVhZGVycyhleHRyYSl7CiAgdmFyIGg9eyd4LWFwaS1rZXknOmJ1aWxkQXBpS2V5KCl9OwogIGlmKHNldHRpbmdzLnByb3ZpZGVyPT09J3BvbGxpbmF0aW9ucycmJnNldHRpbmdzLnBvbGxTZXNzaW9uKSBoWyd4LXNlc3Npb24nXT1zZXR0aW5ncy5wb2xsU2Vzc2lvbjsKICBpZihleHRyYSkgZm9yKHZhciBrIGluIGV4dHJhKSBoW2tdPWV4dHJhW2tdOwogIHJldHVybiBoOwp9CmFzeW5jIGZ1bmN0aW9uIGFwaUdlbmVyYXRlKHBheWxvYWQpewogIHZhciByZXM9YXdhaXQgZmV0Y2goJy9hcGkvZ2VuZXJhdGUnLHttZXRob2Q6J1BPU1QnLGhlYWRlcnM6X2FwaUhlYWRlcnMoeydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJ30pLGJvZHk6SlNPTi5zdHJpbmdpZnkocGF5bG9hZCl9KTsKICB2YXIgZD1hd2FpdCByZXMuanNvbigpLmNhdGNoKGZ1bmN0aW9uKCl7cmV0dXJuIG51bGx9KTsKICBpZighcmVzLm9rKSB0aHJvdyBuZXcgRXJyb3IoKGQmJmQuZXJyb3IpfHwoJ0hUVFAgJytyZXMuc3RhdHVzKSk7CiAgcmV0dXJuIGR8fHt9Owp9CmFzeW5jIGZ1bmN0aW9uIGFwaVRhc2sodGFza0lkKXsKICB2YXIgcmVzPWF3YWl0IGZldGNoKCcvYXBpL3Rhc2s/aWQ9JytlbmNvZGVVUklDb21wb25lbnQodGFza0lkKSx7aGVhZGVyczpfYXBpSGVhZGVycyh7fSl9KTsKICB2YXIgZD1hd2FpdCByZXMuanNvbigpLmNhdGNoKGZ1bmN0aW9uKCl7cmV0dXJuIG51bGx9KTsKICBpZighcmVzLm9rKSB0aHJvdyBuZXcgRXJyb3IoKGQmJmQuZXJyb3IpfHwoJ0hUVFAgJytyZXMuc3RhdHVzKSk7CiAgcmV0dXJuIGR8fHt9Owp9Cgphc3luYyBmdW5jdGlvbiBwb2xsVGFzayh0YXNrSWQsb25Qcm9nKXsKICB2YXIgc3RhcnQ9RGF0ZS5ub3coKSwgbWF4TXM9Nio2MCoxMDAwOwogIHdoaWxlKERhdGUubm93KCktc3RhcnQ8bWF4TXMpewogICAgaWYoX3BvbGxTdG9wKSB0aHJvdyBuZXcgRXJyb3IoJ2RpYmF0YWxrYW4gcGVuZ2d1bmEnKTsKICAgIHZhciBkPWF3YWl0IGFwaVRhc2sodGFza0lkKTsKICAgIGlmKGQuc3RhdHVzPT09J1NVQ0NFU1MnKSByZXR1cm4gZC5pbWFnZXN8fFtdOwogICAgaWYoZC5zdGF0dXM9PT0nRkFJTEVEJykgdGhyb3cgbmV3IEVycm9yKGQuZXJyb3J8fCdUYXNrIGdhZ2FsJyk7CiAgICBpZihkLnN0YXR1cz09PSdDQU5DRUxFRCcpIHRocm93IG5ldyBFcnJvcignVGFzayBkaWJhdGFsa2FuJyk7CiAgICB2YXIgc3Q9KGQuc3RhdHVzPT09J1dBSVRJTkcnKT8oJ0FudHJlICcrKGQucXVldWV8fCcnKSk6KGQuc3RhdHVzPT09J1JVTk5JTkcnPydHZW5lcmF0aW5nLi4uJzonTWVudW5nZ3UuLi4nKTsKICAgIG9uUHJvZyhzdCxkLnByb2dyZXNzfHwwKTsKICAgIGF3YWl0IG5ldyBQcm9taXNlKGZ1bmN0aW9uKHIpeyBzZXRUaW1lb3V0KHIsIGQuc3RhdHVzPT09J1dBSVRJTkcnPzQwMDA6MjAwMCk7IH0pOwogIH0KICB0aHJvdyBuZXcgRXJyb3IoJ1RpbWVvdXQgbWVudW5nZ3UgaGFzaWwgZ2VuZXJhdGUnKTsKfQoKLyogLS0tIGhhc2lsIC0tLSAqLwpmdW5jdGlvbiBta1Jlc3VsdChzcmMscGFyLHRhc2tJZCxjcmVkaXRzKXsKICByZXR1cm4gewogICAgc3JjOnNyYywgcHJvbXB0OnBhci5wYXJhbXMucHJvbXB0LCBuZWc6cGFyLnBhcmFtcy5uZWdhdGl2ZVByb21wdCwKICAgIG1vZGVsOnN0YXRlLm1vZGVsP3N0YXRlLm1vZGVsLm5hbWU6JycsCiAgICBzaXplOnBhci5wYXJhbXMud2lkdGgrJ3gnK3Bhci5wYXJhbXMuaGVpZ2h0LCBzZWVkOnBhci5wYXJhbXMuc2VlZCwKICAgIHRhc2tJZDp0YXNrSWR8fCcnLCBjcmVkaXRzOmNyZWRpdHMhPW51bGw/Y3JlZGl0czonJywKICAgIHN0ZXBzOnBhci5wYXJhbXMuc3RlcHMhPW51bGw/cGFyLnBhcmFtcy5zdGVwczonJywKICAgIGNmZzpwYXIucGFyYW1zLmNmZ1NjYWxlIT1udWxsP3Bhci5wYXJhbXMuY2ZnU2NhbGU6JycsCiAgICBzYW1wbGVyOnBhci5wYXJhbXMua3NhbXBsZXJOYW1lfHxwYXIucGFyYW1zLnNhbXBsZXJ8fCcnLAogICAgdHM6RGF0ZS5ub3coKSwgZGVtbzpmYWxzZSwgcGFnZTpzdGF0ZS5wYWdlCiAgfTsKfQpmdW5jdGlvbiBkZW1vUmVzdWx0cyhwYXIpewogIHNob3dQcm9ncmVzcygnTW9kZSBkZW1vJywnTWVueWlhcGthbiBnYW1iYXIgc2ltdWxhc2kuLi4nLDE1KTsKICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7CiAgICBmb3IodmFyIGk9MDtpPHN0YXRlLm5jb2w7aSsrKXsKICAgICAgdmFyIHNyYz1TK01hdGguZmxvb3IoTWF0aC5yYW5kb20oKSoxZTkpKycvNTEyJzsKICAgICAgYWRkUmVzdWx0KHtzcmM6c3JjLCBwcm9tcHQ6cGFyLnBhcmFtcy5wcm9tcHQsIG5lZzpwYXIucGFyYW1zLm5lZ2F0aXZlUHJvbXB0LAogICAgICAgIG1vZGVsOnN0YXRlLm1vZGVsP3N0YXRlLm1vZGVsLm5hbWU6JycsIHNpemU6cGFyLnBhcmFtcy53aWR0aCsneCcrcGFyLnBhcmFtcy5oZWlnaHQsCiAgICAgICAgc2VlZDpwYXIucGFyYW1zLnNlZWQsIHRhc2tJZDonJywgY3JlZGl0czonJywgdHM6RGF0ZS5ub3coKSwgZGVtbzp0cnVlLCBwYWdlOnN0YXRlLnBhZ2UsCiAgICAgICAgc3RlcHM6cGFyLnBhcmFtcy5zdGVwcyE9bnVsbD9wYXIucGFyYW1zLnN0ZXBzOicnLAogICAgICAgIGNmZzpwYXIucGFyYW1zLmNmZ1NjYWxlIT1udWxsP3Bhci5wYXJhbXMuY2ZnU2NhbGU6JycsCiAgICAgICAgc2FtcGxlcjpwYXIucGFyYW1zLmtzYW1wbGVyTmFtZXx8cGFyLnBhcmFtcy5zYW1wbGVyfHwnJ30pOwogICAgfQogICAgaGlkZVByb2dyZXNzKCk7CiAgfSw3MDApOwp9Cgphc3luYyBmdW5jdGlvbiBkb0dlbmVyYXRlKCl7CiAgaWYoc3RhdGUuYnVzeSkgcmV0dXJuOwogIHZhciBwPSQoJ3Byb21wdCcpLnZhbHVlLnRyaW0oKTsKICBpZighcCl7IG9wZW5MZWZ0KCk7ICQoJ3Byb21wdCcpLmZvY3VzKCk7IHRvYXN0KCdJc2kgcHJvbXB0IGR1bHUnKTsgcmV0dXJuOyB9CiAgdmFyIHBhcj1idWlsZFBheWxvYWQoKTsKICBzdGF0ZS5idXN5PXRydWU7IHNldEJ1c3kodHJ1ZSk7IF9wb2xsU3RvcD1mYWxzZTsKICB0cnl7CiAgICBpZihzZXR0aW5ncy5tb2RlPT09J2RlbW8nfHwoIWJ1aWxkQXBpS2V5KCkmJnNldHRpbmdzLnByb3ZpZGVyIT09J3BvbGxpbmF0aW9ucycpKXsKICAgICAgYXdhaXQgbmV3IFByb21pc2UoZnVuY3Rpb24ocil7IHNldFRpbWVvdXQociwzMDApOyB9KTsKICAgICAgZGVtb1Jlc3VsdHMocGFyKTsKICAgICAgaWYoIWJ1aWxkQXBpS2V5KCkpIHRvYXN0KCdCZWx1bSBhZGEgQVBJIGtleSDigJQgaGFzaWwgc2ltdWxhc2kuIElzaSBBUEkgS2V5IFRBTVMgZGkgcGFuZWwga2lyaSB1bnR1ayBnZW5lcmF0ZSBhc2xpLicpOwogICAgICBlbHNlIHRvYXN0KCdNb2RlIGRlbW8gYWt0aWYg4oCUIGhhc2lsIHNpbXVsYXNpLicpOwogICAgfWVsc2V7CiAgICAgIHNob3dQcm9ncmVzcygnTWVuZ2lyaW0ga2UgVEFNUy4uLicsJ01lbnlpYXBrYW4gdGFzay4uLicsNSk7CiAgICAgIHZhciByPWF3YWl0IGFwaUdlbmVyYXRlKHBhcik7CiAgICAgIHZhciB0YXNrSWQ9ci50YXNrSWR8fHIuam9iSWQ7CiAgICAgIGlmKHRhc2tJZCl7CiAgICAgICAgdmFyIGltZ3M9YXdhaXQgcG9sbFRhc2sodGFza0lkLGZ1bmN0aW9uKHN0LHBjdCl7IHNob3dQcm9ncmVzcygnR2VuZXJhdGluZy4uLicsc3QscGN0KTsgfSk7CiAgICAgICAgaW1ncy5mb3JFYWNoKGZ1bmN0aW9uKHNyYyl7IGFkZFJlc3VsdChta1Jlc3VsdChzcmMscGFyLHRhc2tJZCxyLmNyZWRpdHMpKTsgfSk7CiAgICAgIH1lbHNlewogICAgICAgIHZhciBpbWdzMj1leHRyYWN0SW1hZ2VzKHIpOwogICAgICAgIGlmKCFpbWdzMi5sZW5ndGgpIHRocm93IG5ldyBFcnJvcignUmVzcG9uc2UgdGFucGEgZ2FtYmFyJyk7CiAgICAgICAgaW1nczIuZm9yRWFjaChmdW5jdGlvbihzcmMpeyBhZGRSZXN1bHQobWtSZXN1bHQoc3JjLHBhciwnJyxyLmNyZWRpdHMpKTsgfSk7CiAgICAgIH0KICAgIH0KICB9Y2F0Y2goZSl7CiAgICBpZihzZXR0aW5ncy5tb2RlPT09J2F1dG8nKXsKICAgICAgdG9hc3QoJ0JhY2tlbmQvQVBJIGJlbHVtIGFrdGlmICgnK2UubWVzc2FnZSsnKSDigJQgcGFrYWkgc2ltdWxhc2kgZGVtbycpOwogICAgICBkZW1vUmVzdWx0cyhwYXIpOwogICAgfWVsc2V7CiAgICAgIHRvYXN0KCdHYWdhbDogJytlLm1lc3NhZ2UpOwogICAgfQogIH1maW5hbGx5ewogICAgaGlkZVByb2dyZXNzKCk7IHN0YXRlLmJ1c3k9ZmFsc2U7IHNldEJ1c3koZmFsc2UpOwogIH0KfQoKLyogLS0tIEltZzJJbWcgLS0tICovCnZhciBpMmlEYXRhVXJsPW51bGw7CiQoJ2kyaS1kcm9wJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7ICQoJ2kyaS1maWxlJykuY2xpY2soKTsgfSk7CiQoJ2kyaS1maWxlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbihlKXsgaGFuZGxlSTJpRmlsZShlLnRhcmdldC5maWxlcyYmZS50YXJnZXQuZmlsZXNbMF0pOyB9KTsKJCgnaTJpLWRyb3AnKS5hZGRFdmVudExpc3RlbmVyKCdkcmFnb3ZlcicsZnVuY3Rpb24oZSl7IGUucHJldmVudERlZmF1bHQoKTsgfSk7CiQoJ2kyaS1kcm9wJykuYWRkRXZlbnRMaXN0ZW5lcignZHJvcCcsZnVuY3Rpb24oZSl7IGUucHJldmVudERlZmF1bHQoKTsgaGFuZGxlSTJpRmlsZShlLmRhdGFUcmFuc2Zlci5maWxlcyYmZS5kYXRhVHJhbnNmZXIuZmlsZXNbMF0pOyB9KTsKJCgnaTJpLWRzJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpeyAkKCdpMmktZHN2JykudGV4dENvbnRlbnQ9cGFyc2VGbG9hdChlLnRhcmdldC52YWx1ZSkudG9GaXhlZCgyKTsgfSk7CiQoJ2kyaS1jbGVhcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogIGkyaURhdGFVcmw9bnVsbDsgJCgnaTJpLXByZXZpZXcnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgnaTJpLWltZycpLnNyYz0nJzsgJCgnaTJpLWRyb3AnKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsKfSk7CmZ1bmN0aW9uIGhhbmRsZUkyaUZpbGUoZil7CiAgaWYoIWYpIHJldHVybjsKICB2YXIgcmQ9bmV3IEZpbGVSZWFkZXIoKTsKICByZC5vbmxvYWQ9ZnVuY3Rpb24oKXsKICAgIGkyaURhdGFVcmw9cmQucmVzdWx0OwogICAgJCgnaTJpLWltZycpLnNyYz1yZC5yZXN1bHQ7ICQoJ2kyaS1wcmV2aWV3JykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ2kyaS1kcm9wJykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7CiAgfTsKICByZC5yZWFkQXNEYXRhVVJMKGYpOwp9CgovKiAtLS0gcmVuZGVyIHBlciB0YWIgLS0tICovCmZ1bmN0aW9uIHJlbmRlckNhbnZhcygpewogIHZhciBwYWdlPXN0YXRlLnBhZ2U7CiAgdmFyIGhpZGVNYWluID0gIShwYWdlPT09J3RleHQnfHxwYWdlPT09J2ltZycpOwogICQoJ2ltZzJpbWctY2FyZCcpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicsIHBhZ2UhPT0naW1nJyk7CiAgJCgnZW1wdHknKS5zdHlsZS5kaXNwbGF5ID0gKGhpZGVNYWluIHx8IHN0YXRlLnJlc3VsdHMubGVuZ3RoPjApID8gJ25vbmUnIDogJyc7CiAgJCgnZ3JpZCcpLnN0eWxlLmRpc3BsYXkgPSBoaWRlTWFpbj8nbm9uZSc6Jyc7CiAgJCgndGFiLXBsYWNlaG9sZGVyJykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJywgIWhpZGVNYWluKTsKICAkKCd0YWItcGxhY2Vob2xkZXInKS5jbGFzc0xpc3QudG9nZ2xlKCdmbGV4JywgaGlkZU1haW4pOwogIGlmKHBhZ2U9PT0nZWRpdCcpICQoJ3RhYi1wbGFjZWhvbGRlci10ZXh0JykudGV4dENvbnRlbnQ9J0VkaXQgLyBJbnBhaW50aW5nIOKAlCBzZWdlcmEgaGFkaXInOwogIGVsc2UgaWYocGFnZT09PSd2aWRlbycpICQoJ3RhYi1wbGFjZWhvbGRlci10ZXh0JykudGV4dENvbnRlbnQ9J1RleHQgLyBJbWFnZSB0byBWaWRlbyDigJQgc2VnZXJhIGhhZGlyJzsKICBlbHNlIGlmKHBhZ2U9PT0ncHJpbWUnKSAkKCd0YWItcGxhY2Vob2xkZXItdGV4dCcpLnRleHRDb250ZW50PSdQcmltZSDigJQgc2VnZXJhIGhhZGlyJzsKfQoKLyogLS0tIHJpd2F5YXQgZGkgbW9iaWxlIC0tLSAqLwokKCdidG4taGlzdG9yeScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyAkKCdyaWdodFBhbicpLmNsYXNzTGlzdC50b2dnbGUoJ21vYmlsZS1vcGVuJyk7IH0pOwokKCdvdmVybGF5JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7ICQoJ3JpZ2h0UGFuJykuY2xhc3NMaXN0LnJlbW92ZSgnbW9iaWxlLW9wZW4nKTsgfSk7CgpyZW5kZXJMb3JhKCk7CnNldE1vZGVsKE1PREVMU1swXSk7CnVwZFdIKCk7CmFwcGx5TmNvbCgpOwpsb2FkU2V0dGluZ3MoKTsgYXBwbHlTZXR0aW5nc1VJKCk7CmhhbmRsZU9BdXRoQ2FsbGJhY2soKTsKdHJ5ewogIHZhciBzYXZlZD1KU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFJFU1VMVFNfS0VZKXx8J1tdJyk7CiAgaWYoQXJyYXkuaXNBcnJheShzYXZlZCkpIHN0YXRlLnJlc3VsdHM9c2F2ZWQ7Cn1jYXRjaChlKXt9CnJlbmRlckNhbnZhcygpOwpyZW5kZXJHcmlkKCk7CnJlbmRlckRldGFpbCgpOwpyZW5kZXJSaWdodCgpOwo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+CgoK';
const INDEX_HTML = new TextDecoder().decode(Uint8Array.from(atob(HTML_B64), (c) => c.charCodeAt(0)));
const HTML_CT = { 'Content-Type': 'text/html; charset=utf-8' };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/img/')) {
      return onRequest({ request, env, data: {}, waitUntil: ctx.waitUntil.bind(ctx) });
    }
    return new Response(INDEX_HTML, { status: 200, headers: HTML_CT });
  },
};
