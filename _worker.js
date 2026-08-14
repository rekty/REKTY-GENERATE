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

/* ---------------------- Cloudflare Queues (antrian generate) ---------------------- */

/** Jeda mundur eksponensial antar percobaan consumer: 1, 2, 4, 8, 16, ... (maks 60 dtk). */
function queueDelay(attempt) {
  return Math.min(Math.pow(2, Math.max(1, attempt) - 1), 60);
}

/** Error yang layak dicoba ulang (jaringan / timeout / 5xx / 429). */
function isRetryableErr(text) {
  return /timeout|timed ?out|ETIMEDOUT|fetch failed|ECONN|abort|\b5\d\d\b|\b429\b|temporary/i.test(text);
}

/**
 * Producer: kirim job generate Pollinations ke queue, balas taskId seketika.
 * Konsumen (Worker terpisah `rekty-generate-consumer`) memproses di latar
 * belakang: call Pollinations -> arsip KV -> tulis status SUCCESS/FAILED.
 * Frontend tetap polling /api/task (task disimpan WAITING -> RUNNING -> SUCCESS).
 */
async function pollinationsEnqueue(body, env, sessionId) {
  const params = body.params || body;
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random().toString(36).slice(2);
  const taskId = 'pollinations:' + id;
  const job = {
    id,
    provider: 'pollinations',
    params: {
      prompt: String(params.prompt || '').slice(0, 1500),
      model: String(params.model || '').trim(),
      width: clampInt(params.width, 256, 1920, 1024),
      height: clampInt(params.height, 256, 1920, 1024),
      seed: toSeed(params.seed),
    },
    session: sessionId || '',
    createdAt: Date.now(),
  };
  let backlog = 0;
  try {
    const res = await env.REKTY_QUEUE.send(job);
    if (res && res.metadata && res.metadata.metrics) backlog = res.metadata.metrics.backlogCount || 0;
  } catch (e) {
    throw new Error('Antrian generate gagal: ' + ((e && e.message) || e));
  }
  if (env && env.IMAGES) {
    await env.IMAGES.put('task:' + taskId, JSON.stringify({ status: 'WAITING', progress: 0, queue: backlog || '' })).catch(() => {});
  }
  return { taskId, images: [], queue: true, position: backlog };
}

/**
 * Proses satu job Pollinations dari queue.
 * - Job pakai session BYOP -> token diambil dari KV oauth:<session>; kalau
 *   hilang/kedaluwarsa -> GAGAL (jangan diam-diam pindah ke key pemilik).
 * - Tanpa session -> secret env POLLINATIONS_API_KEY, atau jalur gratis.
 */
async function processQueuedJob(job, env) {
  const session = String(job.session || '').trim();
  let apiKey = null;
  if (session && env && env.IMAGES) {
    const raw = await env.IMAGES.get('oauth:' + session, { type: 'text' }).catch(() => null);
    const rec = raw ? safeJson(raw) : null;
    if (rec && rec.token && (!rec.expiresAt || rec.expiresAt > Date.now())) apiKey = rec.token;
    else throw new Error('Sesi Pollinations kedaluwarsa — login ulang di panel API');
  } else if (env && env.POLLINATIONS_API_KEY) {
    apiKey = env.POLLINATIONS_API_KEY;
  }
  return pollinationsCreateJob({ params: job.params || {} }, env, apiKey);
}

/**
 * Consumer handler Cloudflare Queues — dipanggil oleh Worker terpisah
 * (`consumer/`, lihat consumer/wrangler.toml). Pages Functions tidak bisa
 * jadi consumer (batasan resmi), makanya dipisah.
 * Error retryable -> msg.retry() dengan backoff; non-retryable -> FAILED di KV.
 */
export async function queue(batch, env) {
  for (const msg of batch.messages) {
    const job = (msg && msg.body) || {};
    const id = String(job.id || '');
    if (!id) continue;
    try {
      if (env && env.IMAGES) {
        await env.IMAGES.put('task:pollinations:' + id, JSON.stringify({ status: 'RUNNING', progress: 25 })).catch(() => {});
      }
      const r = await processQueuedJob(job, env);
      if (env && env.IMAGES) {
        await env.IMAGES.put('task:pollinations:' + id, JSON.stringify({ status: 'SUCCESS', progress: 100, images: r.images })).catch(() => {});
      }
    } catch (e) {
      const text = (e && e.message) || String(e);
      if (isRetryableErr(text) && msg.attempts < 6) {
        msg.retry({ delaySeconds: queueDelay(msg.attempts) });
      } else if (env && env.IMAGES) {
        await env.IMAGES.put('task:pollinations:' + id, JSON.stringify({ status: 'FAILED', error: text.slice(0, 400) })).catch(() => {});
      }
    }
  }
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
        queue: !!(env && env.REKTY_QUEUE), // Cloudflare Queues (antrian generate Pollinations)
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
        // Queue aktif -> enqueue & balas seketika; konsumen memproses di
        // latar belakang (frontend tetap poll /api/task). Tanpa queue
        // (atau payload minta sinkron: body.queue=false) -> jalur lama.
        if (env && env.REKTY_QUEUE && body.queue !== false) {
          const sessionId = String((request.headers && request.headers.get('x-session')) || (body && body.session) || '').trim();
          r = await pollinationsEnqueue(body, env, sessionId);
        } else {
          r = await pollinationsCreateJob(body, env, apiKey);
        }
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
const HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImlkIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04IiAvPgo8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLGluaXRpYWwtc2NhbGU9MSIgLz4KPHRpdGxlPlJla3R5IEFJIOKAlCBUZXh0IHRvIEltYWdlPC90aXRsZT4KPHNjcmlwdD53aW5kb3cuX190YV9zdHlsZV9fPXRydWU8L3NjcmlwdD4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuLnRhaWx3aW5kY3NzLmNvbSI+PC9zY3JpcHQ+CjxzY3JpcHQgc3JjPSJodHRwczovL3VucGtnLmNvbS9AcGhvc3Bob3ItaWNvbnMvd2ViL3Bob3NwaG9yLWljb24uanMiPjwvc2NyaXB0Pgo8bGluayByZWw9InByZWNvbm5lY3QiIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20iPgo8bGluayBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tL2NzczI/ZmFtaWx5PUludGVyOndnaHRANDAwOzUwMDs2MDA7NzAwJmRpc3BsYXk9c3dhcCIgcmVsPSJzdHlsZXNoZWV0Ij4KPHN0eWxlPgpodG1sLGJvZHl7bWFyZ2luOjA7cGFkZGluZzowO2ZvbnQtZmFtaWx5Oi1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LCdTZWdvZSBVSScsUm9ib3RvLCdIZWx2ZXRpY2EgTmV1ZScsQXJpYWwsJ05vdG8gU2Fucycsc2Fucy1zZXJpZjtiYWNrZ3JvdW5kOiMwZDExMTc7Y29sb3I6I2U4ZThlODttaW4taGVpZ2h0OjEwMHZofQouaGlkZWJhcjo6LXdlYmtpdC1zY3JvbGxiYXJ7ZGlzcGxheTpub25lfS5oaWRlYmFye3Njcm9sbGJhci13aWR0aDpub25lfQo6Oi13ZWJraXQtc2Nyb2xsYmFye3dpZHRoOjZweDtoZWlnaHQ6NnB4fQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1ie2JhY2tncm91bmQ6IzMwMzYzZDtib3JkZXItcmFkaXVzOjRweH0KLmJke2JvcmRlci1jb2xvcjojMzAzNjNkfQouaW5we2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjhweDtiYWNrZ3JvdW5kOiMxYzIxMjg7Y29sb3I6I2U4ZThlODtwYWRkaW5nOjhweCAxMXB4O291dGxpbmU6bm9uZTtmb250LXNpemU6MTNweDt3aWR0aDoxMDAlfQouaW5wOmZvY3Vze2JvcmRlci1jb2xvcjojNkY1REZGfQouYnRue2JvcmRlci1yYWRpdXM6MTBweDtmb250LXdlaWdodDo2MDA7dHJhbnNpdGlvbjouMTVzO2N1cnNvcjpwb2ludGVyO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjZweDtmb250LXNpemU6MTNweH0KLmJ0bi1ibHVle2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDk1ZGVnLCM2RjVERkYgMCUsIzI3RDRDRCA1OS43JSwjNzRGRjdFIDEwMCUpO2JvcmRlcjpub25lO2NvbG9yOiNmZmY7Ym94LXNoYWRvdzowIDAgMThweCByZ2JhKDExMSw5MywyNTUsLjM1KTtwYWRkaW5nOjAgMThweH0KLmJ0bi1ibHVlOmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMSk7Ym94LXNoYWRvdzowIDAgMjRweCByZ2JhKDExMSw5MywyNTUsLjUpfQouYnRuLWJsdWU6YWN0aXZle3RyYW5zZm9ybTpzY2FsZSguOTgpfQouYnRuLWdob3N0e2NvbG9yOiNhMWExYWE7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHRyYW5zcGFyZW50fS5idG4tZ2hvc3Q6aG92ZXJ7YmFja2dyb3VuZDojMWMyMTI4O2NvbG9yOiNlOGU4ZTh9Ci50YWJ7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtwYWRkaW5nOjZweCAxMnB4O2JvcmRlci1yYWRpdXM6OHB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7Zm9udC13ZWlnaHQ6NTAwO3doaXRlLXNwYWNlOm5vd3JhcDt0cmFuc2l0aW9uOi4xMnN9Ci50YWI6aG92ZXJ7Y29sb3I6I2ZmZjtiYWNrZ3JvdW5kOiMxYzIxMjh9LnRhYi5zZWx7Y29sb3I6I2ZmZjtiYWNrZ3JvdW5kOiMxYzIxMjh9Ci50YWIgLmRvdHt3aWR0aDo2cHg7aGVpZ2h0OjZweDtib3JkZXItcmFkaXVzOjUwJTtkaXNwbGF5OmlubGluZS1ibG9ja30KLnRhYi5zZWwgLmRvdHtkaXNwbGF5Om5vbmV9Ci50YWIuc2VsOjphZnRlcntjb250ZW50OiIiO3Bvc2l0aW9uOmFic29sdXRlO2JvdHRvbTotMXB4O2xlZnQ6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGVYKC01MCUpO3dpZHRoOjIwcHg7aGVpZ2h0OjJweDtib3JkZXItcmFkaXVzOjJweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5NWRlZywjNkY1REZGLCMyN0Q0Q0QpO3Bvc2l0aW9uOmFic29sdXRlfQoudGFie3Bvc2l0aW9uOnJlbGF0aXZlfQouc2xpZGVyey13ZWJraXQtYXBwZWFyYW5jZTpub25lO2FwcGVhcmFuY2U6bm9uZTtoZWlnaHQ6NHB4O2JvcmRlci1yYWRpdXM6NHB4O2JhY2tncm91bmQ6IzMwMzYzZDtvdXRsaW5lOm5vbmU7d2lkdGg6MTAwJX0KLnNsaWRlcjo6LXdlYmtpdC1zbGlkZXItdGh1bWJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7YXBwZWFyYW5jZTpub25lO3dpZHRoOjE1cHg7aGVpZ2h0OjE1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDojZmZmO2JvcmRlcjozcHggc29saWQgIzZGNURGRjtjdXJzb3I6cG9pbnRlcjtib3gtc2hhZG93OjAgMCA2cHggcmdiYSgxMTEsOTMsMjU1LC40KTt0cmFuc2l0aW9uOi4xMnN9Ci5zbGlkZXI6Oi13ZWJraXQtc2xpZGVyLXRodW1iOmhvdmVye3RyYW5zZm9ybTpzY2FsZSgxLjEpfQoubG9yYS1zbHstd2Via2l0LWFwcGVhcmFuY2U6bm9uZTthcHBlYXJhbmNlOm5vbmU7aGVpZ2h0OjRweDtib3JkZXItcmFkaXVzOjRweDtiYWNrZ3JvdW5kOiMzMDM2M2Q7b3V0bGluZTpub25lfQoubG9yYS1zbDo6LXdlYmtpdC1zbGlkZXItdGh1bWJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7d2lkdGg6MTRweDtoZWlnaHQ6MTRweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjJweCBzb2xpZCAjNkY1REZGO2N1cnNvcjpwb2ludGVyfQoubG9yYS1jYXJke3Bvc2l0aW9uOnJlbGF0aXZlO2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjEwcHg7YmFja2dyb3VuZDojMWMyMTI4O3RyYW5zaXRpb246LjEycztwYWRkaW5nOjhweCAxMHB4IDEwcHh9Ci5sb3JhLWNhcmQ6aG92ZXJ7Ym9yZGVyLWNvbG9yOiMzZDQ0NGR9Ci5sb3JhLWxhYmVse3Bvc2l0aW9uOmFic29sdXRlO3RvcDowO2xlZnQ6MDtmb250LXNpemU6OXB4O2NvbG9yOiM5YTlhYTI7YmFja2dyb3VuZDojMjEyNjJkO2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMSk7cGFkZGluZzoycHggNnB4O2JvcmRlci1yYWRpdXM6NnB4O2JvcmRlci10b3AtbGVmdC1yYWRpdXM6MTBweDtib3JkZXItYm90dG9tLXJpZ2h0LXJhZGl1czo2cHg7ei1pbmRleDoyfQoubG9yYS10b3B7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4O21hcmdpbi10b3A6OHB4fQoubG9yYS10aHVtYnt3aWR0aDozNHB4O2hlaWdodDozNHB4O2JvcmRlci1yYWRpdXM6NnB4O2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtvYmplY3QtZml0OmNvdmVyO2ZsZXgtc2hyaW5rOjB9Ci5sb3JhLW5hbWV7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOiNlOGU4ZTg7ZmxleDoxO21pbi13aWR0aDowO3doaXRlLXNwYWNlOm5vd3JhcDtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpc30KLmxvcmEtaWNvbnN7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MnB4O2ZsZXgtc2hyaW5rOjB9Ci5sb3JhLWljb257d2lkdGg6MjJweDtoZWlnaHQ6MjJweDtib3JkZXItcmFkaXVzOjRweDtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y29sb3I6IzcxNzE3YTtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O3RyYW5zaXRpb246LjEyc30KLmxvcmEtaWNvbjpob3ZlcntiYWNrZ3JvdW5kOiMyMTI2MmQ7Y29sb3I6I2ZmZn0KLmxvcmEtaWNvbi5kZWw6aG92ZXJ7YmFja2dyb3VuZDpyZ2JhKDIzOSw2OCw2OCwuMTUpO2NvbG9yOiNlZjQ0NDR9Ci5sb3JhLWljb24gc3Zne3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7c3Ryb2tlOmN1cnJlbnRDb2xvcjtmaWxsOm5vbmU7c3Ryb2tlLXdpZHRoOjJ9Ci5sb3JhLXNsaWRlci1yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6NHB4O21hcmdpbi10b3A6NnB4fQoubC1zbGlkZXJ7cG9zaXRpb246cmVsYXRpdmU7ZmxleDoxO2hlaWdodDoxNnB4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5sLXRyYWNre3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDtyaWdodDowO2hlaWdodDo0cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDojMzAzNjNkfQoubC1maWxse3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDt0b3A6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpO2hlaWdodDo0cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiwjMjdENENEKX0KLmwtaGFuZGxle3Bvc2l0aW9uOmFic29sdXRlO3RvcDo1MCU7dHJhbnNmb3JtOnRyYW5zbGF0ZSgtNTAlLC01MCUpO3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoycHggc29saWQgIzZGNURGRjtib3gtc2hhZG93OjAgMXB4IDNweCByZ2JhKDAsMCwwLC40KTtwb2ludGVyLWV2ZW50czpub25lfQoubG9yYS1zbHtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7b3BhY2l0eTowO2N1cnNvcjpwb2ludGVyfQoubC1udW17ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MnB4O2ZsZXgtc2hyaW5rOjB9Ci5sb3JhLWlucHV0e3dpZHRoOjMwcHg7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xNSk7Ym9yZGVyLXJhZGl1czo2cHg7YmFja2dyb3VuZDojMGQxMTE3O2NvbG9yOiNlOGU4ZTg7Zm9udC1zaXplOjEycHg7dGV4dC1hbGlnbjpjZW50ZXI7b3V0bGluZTpub25lO3BhZGRpbmc6NHB4IDB9Ci5sb3JhLWlucHV0OmZvY3Vze2JvcmRlci1jb2xvcjojNkY1REZGfQoubG9yYS11cmwtaW5we2ZvbnQtc2l6ZToxMXB4O3BhZGRpbmc6NnB4IDlweDttYXJnaW4tdG9wOjJweH0KLmxvcmEtYnRue3dpZHRoOjIycHg7aGVpZ2h0OjIycHg7Ym9yZGVyLXJhZGl1czo1MCU7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOiM5YTlhYTI7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTt0cmFuc2l0aW9uOi4xMnN9Ci5sb3JhLWJ0bjpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjEpO2NvbG9yOiNmZmZ9Ci5sb3JhLWJ0biBzdmd7d2lkdGg6MTRweDtoZWlnaHQ6MTRweDtzdHJva2U6Y3VycmVudENvbG9yO2ZpbGw6bm9uZTtzdHJva2Utd2lkdGg6MjtzdHJva2UtbGluZWNhcDpyb3VuZH0KLnRhZ3tiYWNrZ3JvdW5kOiMxYzIxMjg7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2NvbG9yOiNlMGUwZTA7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjRweDtmb250LXNpemU6MTJweDtwYWRkaW5nOjRweCA4cHg7Ym9yZGVyLXJhZGl1czo2cHh9Ci5hcntib3JkZXI6MXB4IHNvbGlkICMzMDM2M2Q7Ym9yZGVyLXJhZGl1czoxMHB4O2JhY2tncm91bmQ6IzFjMjEyODtjb2xvcjojZmZmO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjJweDtwYWRkaW5nOjhweCAycHg7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjouMTJzO21pbi13aWR0aDowfQouYXI6aG92ZXJ7Ym9yZGVyLWNvbG9yOiMzZDQ0NGR9Ci5hci5zZWx7Ym9yZGVyLWNvbG9yOiMyN0Q0Q0Q7YmFja2dyb3VuZDojMTYxYjIyfQouYXIuc2VsIC5hci1kZXNje2NvbG9yOiMyN0Q0Q0R9Ci5hci1pY297d2lkdGg6MjRweDtoZWlnaHQ6MjRweDtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXJ9Ci5hci1pY28gc3Zne3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCV9Ci5hci1uYW1le2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiNlOGU4ZTg7d2hpdGUtc3BhY2U6bm93cmFwfQouYXItZGVzY3tmb250LXNpemU6OXB4O2NvbG9yOiM5YTlhYTI7d2hpdGUtc3BhY2U6bm93cmFwfQouZmllbGR7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6M3B4fQoucnRhYntib3JkZXI6MXB4IHNvbGlkIHRyYW5zcGFyZW50O2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50fQoucnRhYjpob3Zlcntjb2xvcjojZmZmfS5ydGFiLnNlbHtiYWNrZ3JvdW5kOiMxYzIxMjg7Y29sb3I6I2ZmZn0KLnJjYXJke2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjEwcHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6IzE2MWIyMn0KLmNoaXB7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOiMxYzIxMjg7dHJhbnNpdGlvbjouMTJzfQouY2hpcDpob3Zlcntjb2xvcjojZmZmfS5jaGlwLm9ue2JvcmRlci1jb2xvcjojNkY1REZGO2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMTYxYjIyfQojdG9hc3R7Ym94LXNoYWRvdzowIDhweCAzMHB4IHJnYmEoMCwwLDAsLjUpfQpAbWVkaWEgKG1heC13aWR0aDoxMDIzcHgpeyNyaWdodFBhbi5tb2JpbGUtb3Blbntwb3NpdGlvbjpmaXhlZDt0b3A6NTZweDtyaWdodDowO2JvdHRvbTowO2xlZnQ6YXV0bzt6LWluZGV4OjQwO2Rpc3BsYXk6ZmxleDt3aWR0aDptaW4oMjFyZW0sOTJ2dyk7Ym94LXNoYWRvdzotOHB4IDAgMzBweCByZ2JhKDAsMCwwLC41KX19CnRleHRhcmVhe2NhcmV0LWNvbG9yOiM2RjVERkZ9CmlucHV0W3R5cGU9Y2hlY2tib3hde3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7Y3Vyc29yOnBvaW50ZXJ9CmlucHV0W3R5cGU9cmFuZ2Vde2N1cnNvcjpwb2ludGVyfQo6Zm9jdXMtdmlzaWJsZXtvdXRsaW5lOjJweCBzb2xpZCAjNkY1REZGO291dGxpbmUtb2Zmc2V0OjJweH0KLnd2bnVte2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOiMxYzIxMjg7Y29sb3I6I2U4ZThlODtwYWRkaW5nOjNweCA2cHg7d2lkdGg6NjRweDtmb250LXNpemU6MTJweDt0ZXh0LWFsaWduOnJpZ2h0O291dGxpbmU6bm9uZX0KLnd2bnVtOmZvY3Vze2JvcmRlci1jb2xvcjojMjdENENEfQoubXRhYntwYWRkaW5nOjhweCAxNHB4O2JvcmRlci1yYWRpdXM6OHB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7Zm9udC13ZWlnaHQ6NTAwO3doaXRlLXNwYWNlOm5vd3JhcDt0cmFuc2l0aW9uOi4xMnN9Ci5tdGFiOmhvdmVye2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMWMyMTI4fS5tdGFiLnNlbHtjb2xvcjojZmZmO2JhY2tncm91bmQ6IzFjMjEyODtib3JkZXItYm90dG9tOjJweCBzb2xpZCAjNkY1REZGfQoubWNoaXB7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOiMxYzIxMjg7dHJhbnNpdGlvbjouMTJzO3doaXRlLXNwYWNlOm5vd3JhcH0KLm1jaGlwOmhvdmVye2NvbG9yOiNmZmZ9Lm1jaGlwLm9ue2JvcmRlci1jb2xvcjojNkY1REZGO2NvbG9yOiNmZmY7YmFja2dyb3VuZDpyZ2JhKDExMSw5MywyNTUsLjE1KX0KLm1jYXJke2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjEwcHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6IzFjMjEyODt0cmFuc2l0aW9uOi4xNXN9Ci5tY2FyZDpob3Zlcntib3JkZXItY29sb3I6cmdiYSgxMTEsOTMsMjU1LC41NSk7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTJweCk7Ym94LXNoYWRvdzowIDZweCAxOHB4IHJnYmEoMCwwLDAsLjM1KX0KLm1jYXJkLWltZ3twb3NpdGlvbjpyZWxhdGl2ZTthc3BlY3QtcmF0aW86My80O292ZXJmbG93OmhpZGRlbn0KLm1jYXJkLWltZyBpbWd7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtvYmplY3QtZml0OmNvdmVyO3RyYW5zaXRpb246LjNzfQoubWNhcmQ6aG92ZXIgLm1jYXJkLWltZyBpbWd7dHJhbnNmb3JtOnNjYWxlKDEuMDUpfQoubWNhcmQtYmFkZ2V7cG9zaXRpb246YWJzb2x1dGU7dG9wOjZweDtsZWZ0OjZweDtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjY1KTtiYWNrZHJvcC1maWx0ZXI6Ymx1cig0cHgpO2ZvbnQtc2l6ZToxMHB4O3BhZGRpbmc6MnB4IDZweDtib3JkZXItcmFkaXVzOjRweDtjb2xvcjojZThlOGU4O2ZvbnQtd2VpZ2h0OjUwMH0KLm1jYXJkLXN0YXJ7cG9zaXRpb246YWJzb2x1dGU7dG9wOjZweDtyaWdodDo2cHg7d2lkdGg6MjZweDtoZWlnaHQ6MjZweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjUpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDRweCk7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2N1cnNvcjpwb2ludGVyO2NvbG9yOiM5YTlhYTI7dHJhbnNpdGlvbjouMTJzfQoubWNhcmQtc3Rhcjpob3Zlcntjb2xvcjojZWFiMzA4fS5tY2FyZC1zdGFyLm9ue2NvbG9yOiNlYWIzMDh9Ci5tY2FyZC12aWV3c3twb3NpdGlvbjphYnNvbHV0ZTtib3R0b206NnB4O2xlZnQ6NnB4O2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNik7YmFja2Ryb3AtZmlsdGVyOmJsdXIoNHB4KTtmb250LXNpemU6MTBweDtwYWRkaW5nOjJweCA2cHg7Ym9yZGVyLXJhZGl1czo0cHg7Y29sb3I6I2U4ZThlODtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDozcHh9Ci5tY2FyZC1pbmZve3BhZGRpbmc6OHB4fQoubWNhcmQtbmFtZXtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo2MDA7Y29sb3I6I2U4ZThlODt3aGl0ZS1zcGFjZTpub3dyYXA7b3ZlcmZsb3c6aGlkZGVuO3RleHQtb3ZlcmZsb3c6ZWxsaXBzaXN9Ci5tY2FyZC1tZXRhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47bWFyZ2luLXRvcDo2cHh9Ci5tY2FyZC12ZXJ7Zm9udC1zaXplOjExcHg7Y29sb3I6IzlhOWFhMjtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjRweDtwYWRkaW5nOjJweCA2cHh9Ci5tY2FyZC1zZWx7Zm9udC1zaXplOjExcHg7Ym9yZGVyOjFweCBzb2xpZCAjNkY1REZGO2NvbG9yOiM2RjVERkY7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXItcmFkaXVzOjRweDtwYWRkaW5nOjJweCAxMHB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcjt0cmFuc2l0aW9uOi4xMnN9Ci5tY2FyZC1zZWw6aG92ZXJ7YmFja2dyb3VuZDojNkY1REZGO2NvbG9yOiNmZmZ9Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+Cgo8aGVhZGVyIGNsYXNzPSJmaXhlZCB0b3AtMCBsZWZ0LTAgcmlnaHQtMCB6LTQwIGgtMTQgYmctWyMwZDExMTddLzg1IGJhY2tkcm9wLWJsdXIgYm9yZGVyLWIgYmQgZmxleCBpdGVtcy1jZW50ZXIgcHgtMiBzbTpweC0zIGdhcC0yIj4KICA8YnV0dG9uIGlkPSJtbWVudSIgY2xhc3M9ImxnOmhpZGRlbiB0ZXh0LW5ldXRyYWwtNDAwIHAtMSI+PGkgZGF0YS1pY29uPSJsaXN0IiBjbGFzcz0idy01IGgtNSI+PC9pPjwvYnV0dG9uPgogIDxkaXYgY2xhc3M9InctNiBoLTYgc2hyaW5rLTAgaGlkZGVuIHNtOmZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIj4KICAgIDxzdmcgd2lkdGg9IjIyIiBoZWlnaHQ9IjIyIiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgcng9IjUiIGZpbGw9InVybCgjZykiLz48cGF0aCBkPSJNNyAxMi41bDMgMyA3LTciIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjI0IiB5Mj0iMjQiPjxzdG9wIHN0b3AtY29sb3I9IiM2RjVERkYiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM2RjVERkYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48L3N2Zz4KICA8L2Rpdj4KICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMC41IGhpZGViYXIgb3ZlcmZsb3cteC1hdXRvIGZsZXgtMSI+CiAgICA8ZGl2IGNsYXNzPSJ0YWIgc2VsIiBkYXRhLXRhYj0idGV4dCI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6IzZGNURGRiI+PC9zcGFuPlRleHQySW1nPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJ0YWIiIGRhdGEtdGFiPSJpbWciPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiMyMmM1NWUiPjwvc3Bhbj5JbWcySW1nPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJ0YWIiIGRhdGEtdGFiPSJlZGl0Ij48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDojZWFiMzA4Ij48L3NwYW4+RWRpdDwvZGl2PgogICAgPGRpdiBjbGFzcz0idGFiIiBkYXRhLXRhYj0idmlkZW8iPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiNlZjQ0NDQiPjwvc3Bhbj5WaWRlbzwvZGl2PgogICAgPGRpdiBjbGFzcz0idGFiIiBkYXRhLXRhYj0icHJpbWUiPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiMzYjgyZjYiPjwvc3Bhbj5QcmltZTwvZGl2PgogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUgc206Z2FwLTIgbWwtYXV0byBzaHJpbmstMCI+CiAgICA8YnV0dG9uIGlkPSJuY29sIiBjbGFzcz0idGV4dC1uZXV0cmFsLTQwMCBob3Zlcjp0ZXh0LXdoaXRlIHAtMS41IGhpZGRlbiBzbTpmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSB0ZXh0LXhzIiB0aXRsZT0iSnVtbGFoIGtvbG9tIj48aSBkYXRhLWljb249InNxdWFyZXMtZm91ciIgY2xhc3M9InctNCBoLTQiPjwvaT48c3BhbiBpZD0ibmNvbGxibCI+Mjwvc3Bhbj48L2J1dHRvbj4KICAgIDxidXR0b24gaWQ9ImJ0bi1nbyIgY2xhc3M9ImJ0biBidG4tYmx1ZSBoLTEwIHB4LTQgc206cHgtNSB3aGl0ZXNwYWNlLW5vd3JhcCI+CiAgICAgIDxpIGRhdGEtaWNvbj0icGxheSIgY2xhc3M9InctNCBoLTQiPjwvaT5HZW5lcmF0ZQogICAgICA8c3BhbiBjbGFzcz0idGV4dC14cyBvcGFjaXR5LTkwIGZvbnQtbm9ybWFsIiBpZD0icHJpY2UiPiskMC4zMzwvc3Bhbj4KICAgIDwvYnV0dG9uPgogIDwvZGl2Pgo8L2hlYWRlcj4KCjxkaXYgaWQ9Im92ZXJsYXkiIGNsYXNzPSJmaXhlZCBpbnNldC0wIGJnLWJsYWNrLzYwIHotMzAgaGlkZGVuIGxnOmhpZGRlbiI+PC9kaXY+Cgo8ZGl2IGNsYXNzPSJwdC0xNCBmbGV4IGgtW2NhbGMoMTAwdmgtNTZweCldIG92ZXJmbG93LWhpZGRlbiI+CgogIDwhLS0gTEVGVCBQQU5FTCAtLT4KICA8YXNpZGUgaWQ9ImxlZnRwYW4iIGNsYXNzPSJmaXhlZCBsZzpzdGF0aWMgei00MCBpbnNldC15LTAgbGVmdC0wIHB0LTE0IGxnOnB0LTAgdy1bMjJyZW1dIG1heC13LVs4OHZ3XSAtdHJhbnNsYXRlLXgtZnVsbCBsZzp0cmFuc2xhdGUteC0wIHRyYW5zaXRpb24tdHJhbnNmb3JtIGR1cmF0aW9uLTIwMCBzaHJpbmstMCBib3JkZXItciBiZCBvdmVyZmxvdy15LWF1dG8gaGlkZWJhciBiZy1bIzE2MWIyMl0iPgogICAgPGRpdiBjbGFzcz0icC00IHNwYWNlLXktNCI+CgogICAgICA8IS0tIE1vZGVscyAodXJ1dGFuIHNlcGVydGkgVGVuc29yLkFydDogTW9kZWxzIC0+IFZBRSAtPiBTZXR0aW5ncykgLS0+CiAgICAgIDxkaXYgY2xhc3M9InNwYWNlLXktMyI+CiAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+TW9kZWxzPC9zcGFuPgogICAgICAgIDxkaXYgaWQ9Im1vZGVsLWNhcmQiIGNsYXNzPSJyZWxhdGl2ZSBib3JkZXIgYmQgcm91bmRlZC14bCBiZy1bIzFjMjEyOF0gaG92ZXI6Ym9yZGVyLVsjM2Q0NDRkXSBjdXJzb3ItcG9pbnRlciBwLTMiPgogICAgICAgICAgPHNwYW4gaWQ9Im1vZGVsLWJhZGdlIiBjbGFzcz0iYWJzb2x1dGUgdG9wLTAgbGVmdC0wIHRleHQtWzlweF0gdGV4dC1uZXV0cmFsLTQwMCBiZy1bIzIxMjYyZF0gYm9yZGVyIGJkIHB4LTIgcHktMC41IHJvdW5kZWQtdGwteGwgcm91bmRlZC1ici1tZCB6LTEwIj5CYXNpYyBNb2RlbCAtIFogSW1hZ2U8L3NwYW4+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMyBtdC0yIj4KICAgICAgICAgICAgPGltZyBpZD0ibW9kZWwtdGh1bWIiIHNyYz0iaHR0cHM6Ly9waWNzdW0ucGhvdG9zL3NlZWQvemltYWdlLzY0IiBjbGFzcz0idy0xNiBoLTE2IHJvdW5kZWQtbGcgb2JqZWN0LWNvdmVyIHNocmluay0wIGJvcmRlciBiZCIgYWx0PSJtb2RlbCIvPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4LTEgbWluLXctMCI+CiAgICAgICAgICAgICAgPGRpdiBpZD0ibW9kZWwtbmFtZSIgY2xhc3M9ImZvbnQtc2VtaWJvbGQgdGV4dC1zbSB0cnVuY2F0ZSI+WiBJbWFnZSAtIGJhc2UtYmYxNjwvZGl2PgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0ibW9kZWwtaW5mbyIgY2xhc3M9InctNiBoLTYgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcm91bmRlZCB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgaG92ZXI6YmctWyMyMTI2MmRdIHRyYW5zaXRpb24iIHRpdGxlPSJJbmZvIj4KICAgICAgICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBjbGFzcz0idy00IGgtNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48bGluZSB4MT0iMTIiIHkxPSIxNiIgeDI9IjEyIiB5Mj0iMTIiLz48bGluZSB4MT0iMTIiIHkxPSI4IiB4Mj0iMTIuMDEiIHkyPSI4Ii8+PC9zdmc+CiAgICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBjbGFzcz0idy00IGgtNCB0ZXh0LW5ldXRyYWwtNTAwIHNocmluay0wIj48cG9seWxpbmUgcG9pbnRzPSI5IDE4IDE1IDEyIDkgNiIvPjwvc3ZnPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBnYXAtMiI+CiAgICAgICAgICA8YnV0dG9uIGlkPSJidG4tYWRkbG9yYSIgY2xhc3M9ImJ0biBidG4tZ2hvc3QgZmxleC0xIGgtOSBib3JkZXIgYmQgdGV4dC14cyI+QWRkIExvUkE8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3QgZmxleC0xIGgtOSBib3JkZXIgYmQgdGV4dC14cyI+QWRkIEVtYmVkZGluZzwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOSBib3JkZXIgYmQgdGV4dC14cyI+QWRkIENvbnRyb2xOZXQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIExvUkEgLS0+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIG1iLTIiPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+TG9SQTwvc3Bhbj4KICAgICAgICAgIDxpIGRhdGEtaWNvbj0iY2FyZXQtZG93biIgY2xhc3M9InctNCBoLTQgdGV4dC1uZXV0cmFsLTUwMCI+PC9pPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImxvcmEtbGlzdCIgY2xhc3M9InNwYWNlLXktMiI+PC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBUcmlnZ2VyIFdvcmRzIC0tPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5UcmlnZ2VyIFdvcmRzPC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCI+KDxzcGFuIGlkPSJ0ci1jb3VudCI+MDwvc3Bhbj4pPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBtdC0xIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAiPkFkZCBUcmlnZ2VyIFdvcmRzIHRvIFByb21wdHM8L3NwYW4+CiAgICAgICAgICA8YnV0dG9uIGlkPSJhZGRhbGwtdHJpZyIgY2xhc3M9InRleHQteHMgdGV4dC1bIzZGNURGRl0gaG92ZXI6dW5kZXJsaW5lIGZvbnQtbWVkaXVtIj5BZGQgQWxsPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBmbGV4LXdyYXAgZ2FwLTEuNSBtdC0yIiBpZD0idHJpZ2dlcnMiPjwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDwhLS0gVkFFIC0tPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20iPlZBRTwvc3Bhbj4KICAgICAgICA8c2VsZWN0IGlkPSJ2YWUiIGNsYXNzPSJpbnAiPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYXV0b21hdGljIj5BdXRvbWF0aWM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Im5vbmUiPk5vbmU8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InZhZS1mdC1tc2UtODQwMDAwLWVtYS1wcnVuZWQuY2twdCI+dmFlLWZ0LW1zZS04NDAwMDAtZW1hLXBydW5lZC5ja3B0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJrbC1mOC1hbmltZS5ja3B0Ij5rbC1mOC1hbmltZS5ja3B0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJrbC1mOC1hbmltZTIuY2twdCI+a2wtZjgtYW5pbWUyLmNrcHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9IllPWk9SQS52YWUucHQiPllPWk9SQS52YWUucHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Im9yYW5nZW1peC52YWUucHQiPm9yYW5nZW1peC52YWUucHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImJsZXNzZWQyLnZhZS5wdCI+Ymxlc3NlZDIudmFlLnB0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhbmltZXZhZS5wdCI+YW5pbWV2YWUucHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9IkNsZWFyVkFFLnNhZmV0ZW5zb3JzIj5DbGVhclZBRS5zYWZldGVuc29yczwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icGFzdGVsLXdhaWZ1LWRpZmZ1c2lvbi52YWUucHQiPnBhc3RlbC13YWlmdS1kaWZmdXNpb24udmFlLnB0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJjdXRlX3ZhZS5zYWZldGVuc29ycyI+Y3V0ZV92YWUuc2FmZXRlbnNvcnM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InNkeGxfdmFlLnNhZmV0ZW5zb3JzIj5zZHhsX3ZhZS5zYWZldGVuc29yczwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2R4bC12YWUtZnAxNi1maXguc2FmZXRlbnNvcnMiPnNkeGwtdmFlLWZwMTYtZml4LnNhZmV0ZW5zb3JzPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJ4bFZBRUNfYzkxLnNhZmV0ZW5zb3JzIj54bFZBRUNfYzkxLnNhZmV0ZW5zb3JzPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJsYXN0cGllY2VYTFZBRV9iYXNlb25BMDg5Ny5zYWZldGVuc29ycyI+bGFzdHBpZWNlWExWQUVfYmFzZW9uQTA4OTcuc2FmZXRlbnNvcnM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InBsYXlncm91bmQtdjIuNS1mcDE2LXZhZS5zYWZldGVuc29ycyI+cGxheWdyb3VuZC12Mi41LWZwMTYtdmFlLnNhZmV0ZW5zb3JzPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhZS5zZnQiPmFlLnNmdDwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icGl4ZWxfc3BhY2UiPnBpeGVsX3NwYWNlPC9vcHRpb24+CiAgICAgICAgPC9zZWxlY3Q+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBTZXR0aW5ncyAtLT4KICAgICAgPGRpdiBjbGFzcz0ic3BhY2UteS00Ij4KICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5TZXR0aW5nczwvc3Bhbj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBncmlkLWNvbHMtNCBnYXAtMiI+CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9ImFyIiBkYXRhLWFyPSJwb3J0cmFpdCI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHg9IjYiIHk9IjIuNSIgd2lkdGg9IjEyIiBoZWlnaHQ9IjE5IiByeD0iMi41IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiLz48L3N2Zz48L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLW5hbWUiPlBvcnRyYWl0PC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1kZXNjIj43Njh4MTE1Mjwvc3Bhbj4KICAgICAgICAgICAgPC9idXR0b24+CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9ImFyIiBkYXRhLWFyPSJsYW5kc2NhcGUiPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1pY28iPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj48cmVjdCB4PSIyLjUiIHk9IjYiIHdpZHRoPSIxOSIgaGVpZ2h0PSIxMiIgcng9IjIuNSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMS42Ii8+PC9zdmc+PC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5MYW5kc2NhcGU8L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWRlc2MiPjExNTJ4NzY4PC9zcGFuPgogICAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYXIiIGRhdGEtYXI9InNxdWFyZSI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHg9IjIuNSIgeT0iMi41IiB3aWR0aD0iMTkiIGhlaWdodD0iMTkiIHJ4PSIyLjUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjEuNiIvPjwvc3ZnPjwvc3Bhbj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItbmFtZSI+U3F1YXJlPC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1kZXNjIj4xMDI0eDEwMjQ8L3NwYW4+CiAgICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJhciBzZWwiIGRhdGEtYXI9ImN1c3RvbSI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxwYXRoIGQ9Ik00IDhoNU0xMyA4aDdNNCAxNmg5TTE3IDE2aDNNOSA1LjV2NU0xNyAxMy41djUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+PC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5jdXN0b208L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWRlc2MiPmN1c3RvbTwvc3Bhbj4KICAgICAgICAgICAgPC9idXR0b24+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBtdC0xLjUiIGlkPSJhci1sYWJlbCI+Y3VzdG9tPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiBpdGVtcy1jZW50ZXIiPjxzcGFuPldpZHRoPC9zcGFuPgogICAgICAgICAgICA8aW5wdXQgaWQ9Ind2IiB0eXBlPSJudW1iZXIiIG1pbj0iMjU2IiBtYXg9IjE1MzYiIHN0ZXA9IjY0IiB2YWx1ZT0iNzY4IiBjbGFzcz0id3ZudW0iLz48L2xhYmVsPgogICAgICAgICAgPGlucHV0IGlkPSJ3aWR0aCIgdHlwZT0icmFuZ2UiIG1pbj0iMjU2IiBtYXg9IjE1MzYiIHN0ZXA9IjY0IiB2YWx1ZT0iNzY4IiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIGl0ZW1zLWNlbnRlciI+PHNwYW4+SGVpZ2h0PC9zcGFuPgogICAgICAgICAgICA8aW5wdXQgaWQ9Imh2IiB0eXBlPSJudW1iZXIiIG1pbj0iMjU2IiBtYXg9IjE1MzYiIHN0ZXA9IjY0IiB2YWx1ZT0iMTE1MiIgY2xhc3M9Ind2bnVtIi8+PC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCBpZD0iaGVpZ2h0IiB0eXBlPSJyYW5nZSIgbWluPSIyNTYiIG1heD0iMTUzNiIgc3RlcD0iNjQiIHZhbHVlPSIxMTUyIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIj4KICAgICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQteHMiPlNhbXBsaW5nIE1ldGhvZDwvc3Bhbj4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0iYWR2LXRvZ2dsZSIgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBob3Zlcjp0ZXh0LXdoaXRlIGZsZXggaXRlbXMtY2VudGVyIGdhcC0xIj48aSBkYXRhLWljb249ImNhcmV0LWRvd24iIGNsYXNzPSJ3LTMuNSBoLTMuNSI+PC9pPkFkdmFuY2VkPC9idXR0b24+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZ3JpZC1jb2xzLTIgZ2FwLTIgbXQtMSI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWwgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAiPlNhbXBsZXI8L2xhYmVsPgogICAgICAgICAgICAgIDxzZWxlY3QgaWQ9InNhbXBsZXIiIGNsYXNzPSJpbnAgdGV4dC14cyI+CiAgICAgICAgICAgICAgICA8b3B0aW9uPkV1bGVyIGE8L29wdGlvbj48b3B0aW9uPkV1bGVyPC9vcHRpb24+PG9wdGlvbj5MTVM8L29wdGlvbj48b3B0aW9uPkxNUyBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRESU08L29wdGlvbj48b3B0aW9uPkxDTTwvb3B0aW9uPjxvcHRpb24+SGV1bjwvb3B0aW9uPjxvcHRpb24+RFBNIGZhc3Q8L29wdGlvbj48b3B0aW9uPkRQTTI8L29wdGlvbj48b3B0aW9uPkRQTTIgYTwvb3B0aW9uPjxvcHRpb24+RFBNMiBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTTIgYSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJTIGE8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNPC9vcHRpb24+PG9wdGlvbj5EUE0rKyBTREU8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJTIGEgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIFNERSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNERSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPlJlc3RhcnQ8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNERSBFeHBvbmVudGlhbDwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0RFIEhldW48L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNERSBIZXVuIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0RFIEhldW4gRXhwb25lbnRpYWw8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNHTSBVbmlmb3JtPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAzTSBTREU8L29wdGlvbj48b3B0aW9uPkRQTSsrIDNNIFNERSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIDNNIFNERSBFeHBvbmVudGlhbDwvb3B0aW9uPjxvcHRpb24+ZXVsZXJfZHk8L29wdGlvbj48b3B0aW9uPmV1bGVyX3NtZWFfZHk8L29wdGlvbj4KICAgICAgICAgICAgICA8L3NlbGVjdD48L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+U2NoZWR1bGVyPC9sYWJlbD4KICAgICAgICAgICAgICA8c2VsZWN0IGlkPSJzY2hlZCIgY2xhc3M9ImlucCB0ZXh0LXhzIj48b3B0aW9uPm5vcm1hbDwvb3B0aW9uPjxvcHRpb24+c2ltcGxlPC9vcHRpb24+PG9wdGlvbj5rYXJyYXM8L29wdGlvbj48b3B0aW9uPmV4cG9uZW50aWFsPC9vcHRpb24+PG9wdGlvbj5zZ21fdW5pZm9ybTwvb3B0aW9uPjxvcHRpb24+ZGRpbV91bmlmb3JtPC9vcHRpb24+PG9wdGlvbj5iZXRhPC9vcHRpb24+PG9wdGlvbj5saW5lYXJfcXVhZHJhdGljPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+CiAgICAgICAgICA8L2Rpdj4KPGRpdiBjbGFzcz0ic3BhY2UteS0zIG10LTMiPgogICAgICAgICAgICA8ZGl2PgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2FtcGxpbmcgU3RlcHM8L3NwYW4+PHNwYW4gaWQ9InN2IiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MTA8L3NwYW4+PC9sYWJlbD4KICAgICAgICAgICAgICA8aW5wdXQgaWQ9InN0ZXBzIiB0eXBlPSJyYW5nZSIgbWluPSIxIiBtYXg9IjUwIiB2YWx1ZT0iMTAiIGNsYXNzPSJzbGlkZXIgbXQtMSIvPgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgPGRpdj4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNGRyBTY2FsZTwvc3Bhbj48c3BhbiBpZD0iY2Z2IiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MTwvc3Bhbj48L2xhYmVsPgogICAgICAgICAgICAgIDxpbnB1dCBpZD0iY2ZnIiB0eXBlPSJyYW5nZSIgbWluPSIxIiBtYXg9IjEwIiBzdGVwPSIwLjUiIHZhbHVlPSIxIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TZWVkPC9zcGFuPjxidXR0b24gaWQ9ImRpY2UiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUiPjxpIGRhdGEtaWNvbj0iZGljZS1maXZlIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGlucHV0IGlkPSJzZWVkIiBjbGFzcz0iaW5wIHRleHQteHMgbXQtMSIgdmFsdWU9IjEwMTA5MzMzNDc5NDM0NjIiLz4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgaWQ9ImFkdi1maWVsZHMiIGNsYXNzPSJoaWRkZW4gc3BhY2UteS0zIG10LTQgYm9yZGVyLXQgYmQgcHQtMyI+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DbGlwIFNraXA8L3NwYW4+PHNwYW4gaWQ9ImNzdiIgY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPjI8L3NwYW4+PC9sYWJlbD4KICAgICAgICAgICAgICA8aW5wdXQgaWQ9ImNsaXBza2lwIiB0eXBlPSJyYW5nZSIgbWluPSIxIiBtYXg9IjEyIiB2YWx1ZT0iMiIgY2xhc3M9InNsaWRlciBtdC0xIi8+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8ZGl2PgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+RU5TRDwvc3Bhbj48c3BhbiBpZD0iZW5zZCIgY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPjMxMzM3PC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGlucHV0IGlkPSJldGFuc2QiIHR5cGU9InJhbmdlIiBtaW49IjAiIG1heD0iMzEzMzciIHZhbHVlPSIzMTMzNyIgY2xhc3M9InNsaWRlciBtdC0xIi8+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CgogICAgICAgIDwhLS0gVXBzY2FsZSAoc2VwYXJhdGUsIGRpIGJhd2FoKSAtLT4KICAgICAgICA8ZGl2IGNsYXNzPSJtdC00Ij4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiBpdGVtcy1jZW50ZXIiPjxzcGFuPlVwc2NhbGU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPjJ4PC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgaWQ9InVwc2NhbGUiIHR5cGU9InJhbmdlIiBtaW49IjEiIG1heD0iNCIgc3RlcD0iMC41IiB2YWx1ZT0iMiIgY2xhc3M9InNsaWRlciBtdC0xIi8+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBBUEkgU2V0dGluZ3MgLS0+CiAgICAgIDxkaXYgY2xhc3M9ImJvcmRlciBiZCByb3VuZGVkLXhsIGJnLVsjMWMyMTI4XSBwLTMgc3BhY2UteS0yIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4iPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+QVBJPC9zcGFuPgogICAgICAgICAgPHNwYW4gaWQ9ImFwaS1zdGF0dXMiIGNsYXNzPSJ0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNTAwIj48L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIj5Qcm92aWRlcjwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJhcGlwcm92aWRlciIgY2xhc3M9ImlucCB0ZXh0LXhzIj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0idGFtcyI+VGVuc29yLkFydCAoVEFNUyk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icmVwbGljYXRlIj5SZXBsaWNhdGUgKFNEWEwpPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImZhbCI+ZmFsLmFpIChmYXN0LXNkeGwpPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9InBvbGxpbmF0aW9ucyI+UG9sbGluYXRpb25zIChHUkFUSVMsIHRhbnBhIGtleSk8L29wdGlvbj4KICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBpZD0iYXBpa2V5LWZpZWxkIj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCIgaWQ9ImFwaWtleS1sYWJlbCI+QVBJIEtleSBUQU1TICh0YW1zLnRlbnNvci5hcnQpPC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCBpZD0iYXBpa2V5IiB0eXBlPSJwYXNzd29yZCIgY2xhc3M9ImlucCIgcGxhY2Vob2xkZXI9IkJlYXJlciB0b2tlbi4uLiIgYXV0b2NvbXBsZXRlPSJvZmYiLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8IS0tIEJZT1AgUG9sbGluYXRpb25zOiBsb2dpbiBPQXV0aCAoYnVrYW4ga29sb20gQVBJIGtleSkgLS0+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQgaGlkZGVuIiBpZD0iYnlvcC1yb3ciPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIj5Mb2dpbiBQb2xsaW5hdGlvbnM8L2xhYmVsPgogICAgICAgICAgPGJ1dHRvbiBpZD0iYnlvcC1sb2dpbiIgY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOCBib3JkZXIgYmQgdGV4dC14cyBqdXN0aWZ5LWNlbnRlciI+TG9naW4gZGVuZ2FuIFBvbGxpbmF0aW9ucyAoQllPUCk8L2J1dHRvbj4KICAgICAgICAgIDxkaXYgaWQ9ImJ5b3Atc3RhdHVzIiBjbGFzcz0iaGlkZGVuIHRleHQtWzEwcHhdIHRleHQtbmV1dHJhbC01MDAgbXQtMSI+PC9kaXY+CiAgICAgICAgICA8YnV0dG9uIGlkPSJieW9wLWxvZ291dCIgY2xhc3M9ImhpZGRlbiBidG4gYnRuLWdob3N0IHctZnVsbCBoLTggYm9yZGVyIGJkIHRleHQteHMganVzdGlmeS1jZW50ZXIgbXQtMSI+TG9nb3V0PC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBpZD0iYXBpLWhpbnQiIGNsYXNzPSJ0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNjAwIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAiPk1vZGU8L2xhYmVsPgogICAgICAgICAgPHNlbGVjdCBpZD0iYXBpbW9kZSIgY2xhc3M9ImlucCB0ZXh0LXhzIj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYXV0byI+QXV0byAoYmFja2VuZCAmcmFycjsgZGVtbyk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icmVhbCI+UmVhbCBBUEkgKHdhamliIGJhY2tlbmQpPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImRlbW8iPkRlbW8gKHNpbXVsYXNpIHNhamEpPC9vcHRpb24+CiAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGdhcC0yIj4KICAgICAgICAgIDxidXR0b24gaWQ9ImFwaS1zYXZlIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBmbGV4LTEgaC04IGJvcmRlciBiZCB0ZXh0LXhzIj5TaW1wYW48L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gaWQ9ImFwaS10ZXN0IiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBmbGV4LTEgaC04IGJvcmRlciBiZCB0ZXh0LXhzIj5UZXM8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIEJvdHRvbSAtLT4KICAgICAgPGRpdiBjbGFzcz0icHQtMSBib3JkZXItdCBiZCBzcGFjZS15LTIiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOSBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlBhc3RlIEdlbmVyYXRpb24gRGF0YTwvc3Bhbj48aSBkYXRhLWljb249ImNsaXBib2FyZCIgY2xhc3M9InctNCBoLTQiPjwvaT48L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IHctZnVsbCBoLTkganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5QcmVzZXRzPC9zcGFuPjxpIGRhdGEtaWNvbj0iYm9va21hcmstc2ltcGxlIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOSBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlJlc2V0PC9zcGFuPjxpIGRhdGEtaWNvbj0ia2V5IiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvYXNpZGU+CgogIDwhLS0gQ0VOVEVSOiBpbWFnZSBncmlkIG9ubHkgLS0+CiAgPG1haW4gaWQ9ImNhbnZhcyIgY2xhc3M9ImZsZXgtMSBvdmVyZmxvdy15LWF1dG8gaGlkZWJhciBiZy1bIzBkMTExN10iPgogICAgPGRpdiBjbGFzcz0icC00IG1heC13LTN4bCBteC1hdXRvIj4KCiAgICAgIDwhLS0gUHJvbXB0IGJhciAoVGVuc29yLkFydDogZGkgdGVuZ2FoIGF0YXMsIGRpIGF0YXMgZ3JpZCBnYW1iYXIpIC0tPgogICAgICA8ZGl2IGlkPSJwcm9tcHRiYXIiIGNsYXNzPSJtYi00IHJvdW5kZWQtMnhsIGJvcmRlciBiZCBiZy1bIzE2MWIyMl0gb3ZlcmZsb3ctaGlkZGVuIj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWxhdGl2ZSBweC00IHB0LTMiPgogICAgICAgICAgPHRleHRhcmVhIGlkPSJwcm9tcHQiIHJvd3M9IjMiIGNsYXNzPSJ3LWZ1bGwgYmctdHJhbnNwYXJlbnQgYm9yZGVyLTAgb3V0bGluZS1ub25lIHJlc2l6ZS1ub25lIHRleHQtWzE1cHhdIHRleHQtbmV1dHJhbC0xMDAgcGxhY2Vob2xkZXItbmV1dHJhbC02MDAgbGVhZGluZy1yZWxheGVkIHByLTEyIiBwbGFjZWhvbGRlcj0iSmVsYXNrYW4gYXBhIHlhbmcgaW5naW4ga2FtdSBidWF0Li4uIj48L3RleHRhcmVhPgogICAgICAgICAgPGRpdiBjbGFzcz0iYWJzb2x1dGUgdG9wLTMgcmlnaHQtMyBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMC41Ij4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0iYnRuLXRyYW5zbGF0ZSIgY2xhc3M9InctNyBoLTcgcm91bmRlZC1sZyBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB0ZXh0LW5ldXRyYWwtNDAwIGhvdmVyOnRleHQtd2hpdGUgaG92ZXI6YmctWyMyMTI2MmRdIHRyYW5zaXRpb24tY29sb3JzIiB0aXRsZT0iVGVyamVtYWhrYW4gcHJvbXB0IGtlIGJhaGFzYSBJbmdncmlzIChzZW11YSBiYWhhc2EpIj48aSBkYXRhLWljb249InRyYW5zbGF0ZSIgY2xhc3M9InctNCBoLTQiPjwvaT48L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0iYnRuLWVuaGFuY2UiIGNsYXNzPSJ3LTcgaC03IHJvdW5kZWQtbGcgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC1uZXV0cmFsLTQwMCBob3Zlcjp0ZXh0LXdoaXRlIGhvdmVyOmJnLVsjMjEyNjJkXSB0cmFuc2l0aW9uLWNvbG9ycyIgdGl0bGU9IlByb21wdCBFbmhhbmNlIOKAlCBwZXJsdWFzICYgcGVyYmFpa2kgcHJvbXB0IGRlbmdhbiBBSSI+PGkgZGF0YS1pY29uPSJtYWdpYy13YW5kIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0yIGZsZXgtd3JhcCBweC0zIHB5LTIgYm9yZGVyLXQgYmQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41IGN1cnNvci1wb2ludGVyIHNlbGVjdC1ub25lIj4KICAgICAgICAgICAgPGlucHV0IGlkPSJuZWdjaGVjayIgdHlwZT0iY2hlY2tib3giIGNsYXNzPSJhY2NlbnQtWyM2RjVERkZdIi8+CiAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAiPk5lZ2F0aXZlPC9zcGFuPgogICAgICAgICAgPC9sYWJlbD4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0yIGZsZXgtd3JhcCBqdXN0aWZ5LWVuZCI+CiAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJjaGlwIiBpZD0iY2hpcC1hMTExMSI+QTExMTE8L3NwYW4+CiAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJjaGlwIiBpZD0iY2hpcC1lbGxhIj5FbGxhPC9zcGFuPgogICAgICAgICAgICA8c2VsZWN0IGlkPSJuY291bnQiIGNsYXNzPSJpbnAgdy1bNS40cmVtXSB0ZXh0LXhzIGgtOCIgdGl0bGU9Ikp1bWxhaCBnYW1iYXIiPgogICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9IjEiIHNlbGVjdGVkPjEgaW1hZ2U8L29wdGlvbj4KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIyIj4yIGltYWdlczwvb3B0aW9uPgogICAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9IjQiPjQgaW1hZ2VzPC9vcHRpb24+CiAgICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBpZD0ibmVnd3JhcCIgY2xhc3M9ImhpZGRlbiBib3JkZXItdCBiZCBweC00IHB5LTMiPgogICAgICAgICAgPHRleHRhcmVhIGlkPSJuZWdwcm9tcHQiIHJvd3M9IjIiIGNsYXNzPSJ3LWZ1bGwgYmctdHJhbnNwYXJlbnQgYm9yZGVyLTAgb3V0bGluZS1ub25lIHJlc2l6ZS1ub25lIHRleHQtWzEzcHhdIHRleHQtbmV1dHJhbC0xMDAgcGxhY2Vob2xkZXItbmV1dHJhbC02MDAiIHBsYWNlaG9sZGVyPSJOZWdhdGl2ZSBwcm9tcHQuLi4iPjwvdGV4dGFyZWE+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBJbWcySW1nIHVwbG9hZCAtLT4KICAgICAgPGRpdiBpZD0iaW1nMmltZy1jYXJkIiBjbGFzcz0iaGlkZGVuIG1iLTQgYm9yZGVyIGJkIHJvdW5kZWQteGwgYmctWyMxNjFiMjJdIHAtNCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIG1iLTIiPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+SW1nMkltZyDigJQgZ2FtYmFyIGF3YWw8L3NwYW4+CiAgICAgICAgICA8c3BhbiBpZD0iaTJpLWNsZWFyIiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgY3Vyc29yLXBvaW50ZXIiPkhhcHVzPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImkyaS1kcm9wIiBjbGFzcz0iYm9yZGVyLTIgYm9yZGVyLWRhc2hlZCBiZCByb3VuZGVkLXhsIHAtNiB0ZXh0LWNlbnRlciBjdXJzb3ItcG9pbnRlciB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOmJvcmRlci1bIzZGNURGRl0gdGV4dC14cyI+CiAgICAgICAgICBLbGlrIGF0YXUgc2VyZXQgZ2FtYmFyIGtlIHNpbmkKICAgICAgICA8L2Rpdj4KICAgICAgICA8aW5wdXQgaWQ9ImkyaS1maWxlIiB0eXBlPSJmaWxlIiBhY2NlcHQ9ImltYWdlLyoiIGNsYXNzPSJoaWRkZW4iLz4KICAgICAgICA8ZGl2IGlkPSJpMmktcHJldmlldyIgY2xhc3M9ImhpZGRlbiBtdC0zIj4KICAgICAgICAgIDxpbWcgaWQ9ImkyaS1pbWciIGNsYXNzPSJ3LTQwIGgtNDAgb2JqZWN0LWNvdmVyIHJvdW5kZWQtbGcgYm9yZGVyIGJkIiBhbHQ9IiIvPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9Im10LTMiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5EZW5vaXNpbmcgU3RyZW5ndGg8L3NwYW4+PHNwYW4gaWQ9ImkyaS1kc3YiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj4wLjUwPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgaWQ9ImkyaS1kcyIgdHlwZT0icmFuZ2UiIG1pbj0iMCIgbWF4PSIxIiBzdGVwPSIwLjA1IiB2YWx1ZT0iMC41IiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIFRhYiBwbGFjZWhvbGRlciAoRWRpdC9WaWRlby9QcmltZSkgLS0+CiAgICAgIDxkaXYgaWQ9InRhYi1wbGFjZWhvbGRlciIgY2xhc3M9ImhpZGRlbiBmbGV4LWNvbCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgaC1bNTB2aF0gdGV4dC1uZXV0cmFsLTYwMCI+CiAgICAgICAgPGkgZGF0YS1pY29uPSJob3VyZ2xhc3MtbWVkaXVtIiBjbGFzcz0idy0xMiBoLTEyIG1iLTMiPjwvaT4KICAgICAgICA8cCBjbGFzcz0idGV4dC1zbSIgaWQ9InRhYi1wbGFjZWhvbGRlci10ZXh0Ij5UYWIgaW5pIHNlZ2VyYSBoYWRpcjwvcD4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGlkPSJlbXB0eSIgY2xhc3M9ImZsZXggZmxleC1jb2wgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGgtWzYwdmhdIHRleHQtbmV1dHJhbC02MDAiPgogICAgICAgIDxpIGRhdGEtaWNvbj0iaW1hZ2Utc3F1YXJlIiBjbGFzcz0idy0xNCBoLTE0IG1iLTMiPjwvaT4KICAgICAgICA8cCBjbGFzcz0idGV4dC1zbSI+SGFzaWwgZ2VuZXJhdGUgYWthbiB0YW1waWwgZGkgc2luaTwvcD4KICAgICAgICA8cCBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNzAwIG10LTEiPklzaSBwcm9tcHQgbGFsdSB0ZWthbiBHZW5lcmF0ZTwvcD4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgaWQ9ImdyaWQiIGNsYXNzPSJmbGV4IGZsZXgtY29sIGl0ZW1zLWNlbnRlciBnYXAtMyI+PC9kaXY+CiAgICA8L2Rpdj4KICA8L21haW4+CgogIDwhLS0gUklHSFQgUEFORUwgLS0+CiAgPGFzaWRlIGlkPSJyaWdodFBhbiIgY2xhc3M9InctWzIxcmVtXSBzaHJpbmstMCBib3JkZXItbCBiZCBiZy1bIzE2MWIyMl0gaGlkZGVuIGxnOmZsZXggZmxleC1jb2wiPgogICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIHB4LTMgcHktMiBib3JkZXItYiBiZCI+CiAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPkdlbmVyYXRpb24gSGlzdG9yeTwvc3Bhbj4KICAgICAgPGRpdiBjbGFzcz0iZmxleCBnYXAtMSI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0icnRhYiBzZWwiIGRhdGEtZj0iYWxsIj5BbGw8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJydGFiIiBkYXRhLWY9ImltYWdlIj5JbWFnZTwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9InJ0YWIiIGRhdGEtZj0idmlkZW8iPlZpZGVvPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0icnRhYiIgZGF0YS1mPSJhdWRpbyI+QXVkaW88L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIHB4LTMgcHktMS41IGJvcmRlci1iIGJkIHRleHQtbmV1dHJhbC01MDAiPgogICAgICA8YnV0dG9uIGNsYXNzPSJoLTcgdy03IGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHRleHQtbmV1dHJhbC01MDAgaG92ZXI6dGV4dC13aGl0ZSIgdGl0bGU9IktlbG9sYSI+PGkgZGF0YS1pY29uPSJzbGlkZXJzLWhvcml6b250YWwiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9idXR0b24+CiAgICAgIDxzcGFuIGNsYXNzPSJteC1hdXRvIHRleHQteHMiIGlkPSJyY291bnQiPjAgaGFzaWw8L3NwYW4+CiAgICAgIDxidXR0b24gY2xhc3M9ImgtNyB3LTcgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC1uZXV0cmFsLTUwMCBob3Zlcjp0ZXh0LXdoaXRlIiB0aXRsZT0iUmVsb2FkIj48aSBkYXRhLWljb249ImFycm93cy1jbG9ja3dpc2UiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxkaXYgaWQ9InJsaXN0IiBjbGFzcz0iZmxleC0xIG92ZXJmbG93LXktYXV0byBoaWRlYmFyIHAtMiBzcGFjZS15LTMiPjwvZGl2PgogIDwvYXNpZGU+CjwvZGl2PgoKPCEtLSBNb2JpbGUgaGlzdG9yeSB0b2dnbGUgLS0+CjxidXR0b24gaWQ9ImJ0bi1oaXN0b3J5IiBjbGFzcz0ibGc6aGlkZGVuIGZpeGVkIGJvdHRvbS00IHJpZ2h0LTQgei0zMCBidG4gYnRuLWJsdWUgaC0xMSBweC00Ij48aSBkYXRhLWljb249ImNsb2NrLWNvdW50ZXItY2xvY2t3aXNlIiBjbGFzcz0idy00IGgtNCI+PC9pPiBSaXdheWF0PC9idXR0b24+Cgo8IS0tID09PT09PT09PT09PSBQUk9HUkVTUyBPVkVSTEFZID09PT09PT09PT09PSAtLT4KPGRpdiBpZD0icHJvZ292ZXJsYXkiIGNsYXNzPSJoaWRkZW4gZml4ZWQgaW5zZXQtMCB6LTMwIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGJnLWJsYWNrLzUwIHAtNCIgc3R5bGU9InRvcDo1NnB4Ij4KICA8ZGl2IGNsYXNzPSJ3LWZ1bGwgbWF4LXctc20gYmctWyMxNjFiMjJdIGJvcmRlciBiZCByb3VuZGVkLTJ4bCBwLTUgc3BhY2UteS0zIj4KICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiI+CiAgICAgIDxzcGFuIGlkPSJwcm9nLXRpdGxlIiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5HZW5lcmF0aW5nLi4uPC9zcGFuPgogICAgICA8YnV0dG9uIGlkPSJwcm9nLWNhbmNlbCIgY2xhc3M9InRleHQtbmV1dHJhbC01MDAgaG92ZXI6dGV4dC13aGl0ZSB0ZXh0LWxnIGxlYWRpbmctbm9uZSIgdGl0bGU9IkJhdGFsIj7inJU8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0icmVsYXRpdmUgaC0yIGJnLVsjMWMyMTI4XSByb3VuZGVkLWZ1bGwgb3ZlcmZsb3ctaGlkZGVuIj4KICAgICAgPGRpdiBpZD0icHJvZy1iYXIiIGNsYXNzPSJhYnNvbHV0ZSBpbnNldC15LTAgbGVmdC0wIHctMCByb3VuZGVkLWZ1bGwiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5NWRlZywjNkY1REZGLCMyN0Q0Q0QpO3RyYW5zaXRpb246d2lkdGggLjRzIj48L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIHRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCI+CiAgICAgIDxzcGFuIGlkPSJwcm9nLXN0YXR1cyI+TWVuZ2lyaW0gdGFzay4uLjwvc3Bhbj4KICAgICAgPHNwYW4gaWQ9InByb2ctcGN0Ij4wJTwvc3Bhbj4KICAgIDwvZGl2PgogIDwvZGl2Pgo8L2Rpdj4KCjwhLS0gPT09PT09PT09PT09IExJR0hUQk9YID09PT09PT09PT09PSAtLT4KPGRpdiBpZD0ibGlnaHRib3giIGNsYXNzPSJmaXhlZCBpbnNldC0wIHotNTAgaGlkZGVuIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBwLTQgYmctYmxhY2svODAiPgogIDxkaXYgY2xhc3M9InJlbGF0aXZlIG1heC13LTN4bCB3LWZ1bGwgYmctWyMxNjFiMjJdIGJvcmRlciBiZCByb3VuZGVkLTJ4bCBvdmVyZmxvdy1oaWRkZW4iPgogICAgPGJ1dHRvbiBpZD0ibGItY2xvc2UiIGNsYXNzPSJhYnNvbHV0ZSB0b3AtMiByaWdodC0yIHotMTAgdy05IGgtOSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB0ZXh0LXdoaXRlIGhvdmVyOmJnLXdoaXRlLzEwIHJvdW5kZWQtbGcgdGV4dC14bCI+4pyVPC9idXR0b24+CiAgICA8aW1nIGlkPSJsYi1pbWciIGNsYXNzPSJ3LWZ1bGwgbWF4LWgtWzYwdmhdIG9iamVjdC1jb250YWluIGJnLWJsYWNrIiBhbHQ9IiIvPgogICAgPGRpdiBpZD0ibGItbWV0YSIgY2xhc3M9InAtNCBzcGFjZS15LTEuNSB0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAgb3ZlcmZsb3cteS1hdXRvIG1heC1oLVszMHZoXSI+PC9kaXY+CiAgPC9kaXY+CjwvZGl2PgoKPCEtLSA9PT09PT09PT09PT0gUFJPTVBUIEVOSEFOQ0UgKGhhc2lsIHJlZmluZSwga29uZmlybWFzaSBkdWx1KSA9PT09PT09PT09PT0gLS0+CjxkaXYgaWQ9ImVuaC1tb2RhbCIgY2xhc3M9ImZpeGVkIGluc2V0LTAgei01MCBoaWRkZW4gaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHAtNCBiZy1ibGFjay83MCI+CiAgPGRpdiBjbGFzcz0idy1mdWxsIG1heC13LXhsIGJnLVsjMTYxYjIyXSBib3JkZXIgYmQgcm91bmRlZC0yeGwgb3ZlcmZsb3ctaGlkZGVuIj4KICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBweC00IHB5LTMgYm9yZGVyLWIgYmQiPgogICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIGZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUiPjxpIGRhdGEtaWNvbj0ibWFnaWMtd2FuZCIgY2xhc3M9InctNCBoLTQgdGV4dC1bIzZGNURGRl0iPjwvaT5Qcm9tcHQgRW5oYW5jZTwvc3Bhbj4KICAgICAgPGJ1dHRvbiBpZD0iZW5oLWNsb3NlIiBjbGFzcz0idy04IGgtOCBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB0ZXh0LW5ldXRyYWwtNDAwIGhvdmVyOnRleHQtd2hpdGUgaG92ZXI6Ymctd2hpdGUvNSByb3VuZGVkLWxnIj7inJU8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0icC00IHNwYWNlLXktMyI+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCBtYi0xIj5Qcm9tcHQgYXNsaTwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImVuaC1vcmlnIiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNDAwIGJnLWJsYWNrLzQwIGJvcmRlciBiZCByb3VuZGVkLWxnIHAtMyBtYXgtaC0yNCBvdmVyZmxvdy15LWF1dG8gbGVhZGluZy1yZWxheGVkIj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCBtYi0xIj5IYXNpbCBFbmhhbmNlIDxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNjAwIj4oYmlzYSBkaWVkaXQpPC9zcGFuPjwvZGl2PgogICAgICAgIDx0ZXh0YXJlYSBpZD0iZW5oLXRleHQiIHJvd3M9IjUiIGNsYXNzPSJ3LWZ1bGwgYmctYmxhY2svNDAgYm9yZGVyIGJkIHJvdW5kZWQtbGcgcC0zIHRleHQteHMgdGV4dC1uZXV0cmFsLTEwMCBvdXRsaW5lLW5vbmUgcmVzaXplLW5vbmUgZm9jdXM6Ym9yZGVyLVsjNkY1REZGXSBsZWFkaW5nLXJlbGF4ZWQiPjwvdGV4dGFyZWE+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gZ2FwLTIiPgogICAgICAgIDxidXR0b24gaWQ9ImVuaC1yZWdlbiIgY2xhc3M9ImJ0biBidG4tZ2hvc3QgaC05IHB4LTMgdGV4dC14cyI+PGkgZGF0YS1pY29uPSJhcnJvd3MtY2xvY2t3aXNlIiBjbGFzcz0idy0zLjUgaC0zLjUiPjwvaT5HZW5lcmF0ZSBsYWdpPC9idXR0b24+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBnYXAtMiI+CiAgICAgICAgICA8YnV0dG9uIGlkPSJlbmgtY2FuY2VsIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBoLTkgcHgtNCB0ZXh0LXhzIj5CYXRhbDwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBpZD0iZW5oLXVzZSIgY2xhc3M9ImJ0biBidG4tYmx1ZSBoLTkgcHgtNCB0ZXh0LXhzIj5QYWthaSBwcm9tcHQgaW5pPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgPC9kaXY+CjwvZGl2PgoKPCEtLSA9PT09PT09PT09PT0gVE9BU1QgPT09PT09PT09PT09IC0tPgo8ZGl2IGlkPSJ0b2FzdCIgY2xhc3M9ImZpeGVkIGJvdHRvbS0yMCBsZWZ0LTEvMiAtdHJhbnNsYXRlLXgtMS8yIHotNTAgaGlkZGVuIGJnLVsjMWMyMTI4XSBib3JkZXIgYmQgcm91bmRlZC14bCBweC00IHB5LTIuNSB0ZXh0LXNtIHNoYWRvdy1sZyBtYXgtdy1bODV2d10iPjwvZGl2PgoKPCEtLSA9PT09PT09PT09PT0gU0VMRUNUT1IgTU9EQUwgPT09PT09PT09PT09IC0tPgo8ZGl2IGlkPSJtb2RhbCIgY2xhc3M9ImZpeGVkIGluc2V0LTAgYmctYmxhY2svNjAgei01MCBoaWRkZW4gaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHAtNCI+CiAgPGRpdiBjbGFzcz0idy1mdWxsIG1heC13LTV4bCBiZy1bIzE2MWIyMl0gYm9yZGVyIGJkIHJvdW5kZWQtMnhsIG92ZXJmbG93LWhpZGRlbiI+CiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gcHgtNCBwdC0zIHBiLTIgYm9yZGVyLWIgYmQiPgogICAgICA8ZGl2IGlkPSJtb2RhbC10YWJzIiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEiPgogICAgICAgIDxidXR0b24gY2xhc3M9Im10YWIgc2VsIiBkYXRhLW10YWI9ImJhc2ljIj5CYXNpYyBNb2RlbDwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9Im10YWIiIGRhdGEtbXRhYj0ic3RhcnJlZCI+TXkgU3RhcnJlZDwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9Im10YWIiIGRhdGEtbXRhYj0ibXltb2RlbHMiPk15IE1vZGVsczwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTIiPgogICAgICAgIDxkaXYgY2xhc3M9InJlbGF0aXZlIj4KICAgICAgICAgIDxpIGRhdGEtaWNvbj0ibWFnbmlmeWluZy1nbGFzcyIgY2xhc3M9InctNCBoLTQgYWJzb2x1dGUgbGVmdC0zIHRvcC0xLzIgLXRyYW5zbGF0ZS15LTEvMiB0ZXh0LW5ldXRyYWwtNTAwIj48L2k+CiAgICAgICAgICA8aW5wdXQgaWQ9Im1zZWFyY2giIGNsYXNzPSJpbnAgcGwtOSB3LTU2IGgtOSIgcGxhY2Vob2xkZXI9IlNlYXJjaC4uLiIvPgogICAgICAgIDwvZGl2PgogICAgICAgIDxidXR0b24gaWQ9Im1maWx0ZXJzIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBoLTkgcHgtMyBib3JkZXIgYmQgdGV4dC14cyBzaHJpbmstMCI+PGkgZGF0YS1pY29uPSJzbGlkZXJzLWhvcml6b250YWwiIGNsYXNzPSJ3LTQgaC00Ij48L2k+RmlsdGVyczwvYnV0dG9uPgogICAgICAgIDxidXR0b24gaWQ9Im1vZGFsLWNsb3NlIiBjbGFzcz0idy05IGgtOSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB0ZXh0LXdoaXRlIGhvdmVyOmJnLVsjMWMyMTI4XSByb3VuZGVkLWxnIHRleHQteGwgbGVhZGluZy1ub25lIiB0aXRsZT0iVHV0dXAiPuKclTwvYnV0dG9uPgogICAgICAgIDxoMyBpZD0ibW9kYWwtdGl0bGUiIGNsYXNzPSJoaWRkZW4gZm9udC1zZW1pYm9sZCB0ZXh0LXNtIj5QaWxpaCBNb2RlbDwvaDM+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGlkPSJtY2F0IiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSBweC00IHB5LTIgaGlkZWJhciBvdmVyZmxvdy14LWF1dG8iPjwvZGl2PgogICAgPGRpdiBpZD0ibW9kYWwtYm9keSIgY2xhc3M9Im1heC1oLVs1NXZoXSBvdmVyZmxvdy15LWF1dG8gcC00Ij48L2Rpdj4KICA8L2Rpdj4KPC9kaXY+CgoKPHNjcmlwdD4KY29uc3QgJCA9IGlkID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTsKY29uc3QgUyA9ICdodHRwczovL3BpY3N1bS5waG90b3Mvc2VlZC8nOwpjb25zdCBzdGF0ZSA9IHsgcmVzdWx0czpbXSwgcGFnZTondGV4dCcsIGFzcGVjdDoncG9ydHJhaXQnLCBuY29sOjEsIG1vZGVsOm51bGwgfTsKCi8qID09PT09IExvUkEg4oCUIGRhZnRhciBhc2xpIHBlciBwcm92aWRlciA9PT09PSAqLwp2YXIgTE9SQV9MSUJTID0gewogIHRhbXM6IFsKICAgIHsgbmFtZTonWi1JbWFnZSBMb1JBIHwgRGV0YWlsJywgdGFnczpbJ2RldGFpbGVkJywnc2hhcnAnXSwgdGh1bWI6J2Fmcm8nLCBiYWRnZTonWi1JTUFHRScsIHZpZXdzOicxMksnLCB2ZXI6J1YxJywgYmFzZTonWiBJbWFnZScgfSwKICAgIHsgbmFtZTonWi1JbWFnZSBUdXJibycsIHRhZ3M6Wyd0dXJibycsJ2Zhc3QnXSwgdGh1bWI6J3JldHJvJywgYmFkZ2U6J1otSU1BR0UtVFVSQk8nLCB2aWV3czonOEsnLCB2ZXI6J1YxJywgYmFzZTonWiBJbWFnZScgfSwKICAgIHsgbmFtZTonWi1JbWFnZSBIRFInLCB0YWdzOlsnaGRyJywndml2aWQnXSwgdGh1bWI6J2hkcicsIGJhZGdlOidaLUlNQUdFJywgdmlld3M6JzE1SycsIHZlcjonVjEnLCBiYXNlOidaIEltYWdlJyB9LAogICAgeyBuYW1lOidaLUltYWdlIFBvcnRyYWl0JywgdGFnczpbJ3BvcnRyYWl0JywnYm9rZWgnXSwgdGh1bWI6J3B0cnQnLCBiYWRnZTonWi1JTUFHRScsIHZpZXdzOicyMksnLCB2ZXI6J1YxJywgYmFzZTonWiBJbWFnZScgfSwKICAgIHsgbmFtZTonWi1JbWFnZSBBcnRpc3RpYycsIHRhZ3M6WydhcnRpc3RpYycsJ3BhaW50J10sIHRodW1iOidhcnQnLCBiYWRnZTonWi1JTUFHRScsIHZpZXdzOicxOEsnLCB2ZXI6J1YxJywgYmFzZTonWiBJbWFnZScgfSwKICAgIHsgbmFtZTonRmx1eCBSZWFsaXNtIExvUkEnLCB0YWdzOlsncmVhbGlzdGljJywncGhvdG8nXSwgdGh1bWI6J2ZsdXhsJywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonNDVLJywgdmVyOidWMScsIGJhc2U6J0ZMVVguMScgfSwKICAgIHsgbmFtZTonRmx1eCBDaW5lbWF0aWMgTG9SQScsIHRhZ3M6WydjaW5lbWF0aWMnLCdtb29keSddLCB0aHVtYjonZmx1eGMnLCBiYWRnZTonRkxVWCcsIHZpZXdzOiczM0snLCB2ZXI6J1YxJywgYmFzZTonRkxVWC4xJyB9LAogICAgeyBuYW1lOidTRFhMIEZpbmUgRGV0YWlsJywgdGFnczpbJ2RldGFpbGVkJywnc2hhcnAnXSwgdGh1bWI6J2RldGFpbCcsIGJhZGdlOidTRFhMJywgdmlld3M6JzUwMEsnLCB2ZXI6J1YxJywgYmFzZTonU0RYTCcgfSwKICAgIHsgbmFtZTonU0RYTCBBbmltZSBTdHlsZScsIHRhZ3M6WydhbmltZScsJ2NlbCddLCB0aHVtYjonYW5pbWVzbCcsIGJhZGdlOidTRFhMJywgdmlld3M6JzI4MEsnLCB2ZXI6J1YxJywgYmFzZTonU0RYTCcgfSwKICAgIHsgbmFtZTonUG9ueSBFcXVlc3RyaWFuIEFydCcsIHRhZ3M6Wydwb255JywnZmFudGFzeSddLCB0aHVtYjoncG9ueWwnLCBiYWRnZTonUE9OWScsIHZpZXdzOicxNTBLJywgdmVyOidWMScsIGJhc2U6J1BvbnknIH0sCiAgICB7IG5hbWU6J05pcHBvbi1Db3JlIFJldHJvIC0gdjAuMScsIHRhZ3M6WydqYXByZXRyN2NvbW0nLCdyZXRybyBtYWdhemluZSddLCB0aHVtYjonYmlsaWJpbicsIGJhZGdlOidTVFlMRScsIHZpZXdzOic5NksnLCB2ZXI6J1YuMScsIGJhc2U6J1NEWEwnIH0sCiAgICB7IG5hbWU6J0l2YW4gQmlsaWJpbiAtIHYwLjcnLCB0YWdzOlsnaXZhbmJpbGliaW41eicsJ2lsbHVzdHJhdGlvbicsJ2FydCBkZWNvJ10sIHRodW1iOidkZXRhaWwnLCBiYWRnZTonSUxMVVNUUkFUSU9OJywgdmlld3M6JzE1NEsnLCB2ZXI6J1YuMScsIGJhc2U6J1NEWEwnIH0sCiAgICB7IG5hbWU6J0RldGFpbCBUd2Vha2VyIC0gdjEuMCcsIHRhZ3M6WydkZXRhaWxlZCddLCB0aHVtYjonZ3JhaW4nLCBiYWRnZTonVVRJTElUWScsIHZpZXdzOicxLjJNJywgdmVyOidWLjEnLCBiYXNlOidTRFhMJyB9LAogICAgeyBuYW1lOidGaWxtIEdyYWluIC0gdjAuNScsIHRhZ3M6WydmaWxtIGdyYWluJywnYW5hbG9nJ10sIHRodW1iOidncmFpbicsIGJhZGdlOidVVElMSVRZJywgdmlld3M6JzY3SycsIHZlcjonVi4xJywgYmFzZTonU0RYTCcgfSwKICBdLAogIHJlcGxpY2F0ZTogWwogICAgeyBuYW1lOidGTFVYLjEgW3NjaG5lbGxdIExvUkEnLCBiYXNlOidGTFVYJywgbW9kZWw6J2JsYWNrLWZvcmVzdC1sYWJzL2ZsdXgtc2NobmVsbC1sb3JhJywgdGFnczpbJ2ZsdXgtbG9yYSddLCB0aHVtYjonZmx1eGwnLCBiYWRnZTonRkxVWC1MT1JBJywgdmlld3M6JzEyMEsnLCB2ZXI6J1YxJywgbmVlZFVybDp0cnVlIH0sCiAgICB7IG5hbWU6J0ZMVVguMSBbZGV2XSBMb1JBJywgYmFzZTonRkxVWCcsIG1vZGVsOidibGFjay1mb3Jlc3QtbGFicy9mbHV4LWRldi1sb3JhJywgdGFnczpbJ2ZsdXgtbG9yYSddLCB0aHVtYjonZmx1eGRsJywgYmFkZ2U6J0ZMVVgtTE9SQScsIHZpZXdzOic5MEsnLCB2ZXI6J1YxJywgbmVlZFVybDp0cnVlIH0sCiAgICB7IG5hbWU6J1NEWEwgKyBMb1JBIFVSTCAoY3VzdG9tKScsIGJhc2U6J1NEWEwnLCBtb2RlbDonenlsaW0wNzAyL3NkeGwtbG9yYS1jdXN0b21pemUtbW9kZWwnLCB0YWdzOlsnbG9yYSddLCB0aHVtYjonc2R4bGwnLCBiYWRnZTonU0RYTC1MT1JBJywgdmlld3M6JzMxMEsnLCB2ZXI6J1YxJywgbmVlZFVybDp0cnVlIH0sCiAgICB7IG5hbWU6J0lLRUEgSW5zdHJ1Y3Rpb25zIChTRFhMLCBiYXdhYW4pJywgYmFzZTonU0RYTCcsIG1vZGVsOidvc3RyaXMvaWtlYS1pbnN0cnVjdGlvbnMtbG9yYS1zZHhsJywgdGFnczpbJ2lrZWEgaW5zdHJ1Y3Rpb25zJ10sIHRodW1iOidpa2VhJywgYmFkZ2U6J1NUWUxFJywgdmlld3M6JzIxMEsnLCB2ZXI6J1YxJyB9LAogIF0sCiAgZmFsOiBbCiAgICB7IG5hbWU6J0ZMVVggTG9SQScsIGJhc2U6J0ZMVVgnLCBtb2RlbDonZmFsLWFpL2ZsdXgtbG9yYScsIHRhZ3M6WydmbHV4LWxvcmEnXSwgdGh1bWI6J2ZsdXhsJywgYmFkZ2U6J0ZMVVgtTE9SQScsIHZpZXdzOicxNTBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogICAgeyBuYW1lOidTRFhMICsgTG9SQSBVUkwgKGZhc3Qtc2R4bCknLCBiYXNlOidTRFhMJywgbW9kZWw6J2ZhbC1haS9mYXN0LXNkeGwnLCB0YWdzOlsnbG9yYSddLCB0aHVtYjonc2R4bGwnLCBiYWRnZTonU0RYTC1MT1JBJywgdmlld3M6JzEyMEsnLCB2ZXI6J1YxJywgbmVlZFVybDp0cnVlIH0sCiAgICB7IG5hbWU6J0tyZWEgMiBMb1JBICh0dXJibyknLCBiYXNlOidLcmVhIDInLCBtb2RlbDonZmFsLWFpL2tyZWEtMi90dXJiby9sb3JhJywgdGFnczpbJ2tyZWEyJ10sIHRodW1iOidrcmVhJywgYmFkZ2U6J0tSRUEyLUxPUkEnLCB2aWV3czonNjZLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogIF0sCiAgcG9sbGluYXRpb25zOiBbXSwgLy8gTG9SQSB0aWRhayBkaWR1a3VuZyDigJQgZ3JhdGlzLCBtb2RlbCBiYXdhYW4gc2FqYQp9Owp2YXIgTE9SQV9MSUIgPSBMT1JBX0xJQlMudGFtczsgLy8gZGFmdGFyIGFrdGlmIG1lbmdpa3V0aSBwcm92aWRlcgpjb25zdCBMT1JBID0gW107Ci8qID09PT09IE1vZGVsIG1vZGFsIOKAlCBkYWZ0YXIgbW9kZWwgYXNsaSBwZXIgcHJvdmlkZXIgPT09PT0gKi8KdmFyIE1PREVMX0xJQlMgPSB7CiAgdGFtczogWwogICAgeyBuYW1lOidaIEltYWdlIC0gYmFzZS1iZjE2JywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidaIEltYWdlJywgdGh1bWI6J3ppbWFnZScsIGJhZGdlOidaJywgdmlld3M6JzQ0SycsIHZlcjonVi4xJywgbW9kZWxJZDonMTAyNzkwNjI1MzI2MDYwMzgwNScsIG1vZGVsRmlsZUlkOicxMDI3OTA2MjU0MzM0MzY2MjQ1JyB9LAogICAgeyBuYW1lOidGTFVYLjEgW2Rldl0nLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J0ZMVVguMScsIHRodW1iOidmbHV4JywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonMTU0SycsIHZlcjonVi4xJywgbW9kZWxJZDonMTAyNzkwNjI4MjY0NDUyNTA1NicsIG1vZGVsRmlsZUlkOicxMDI3OTA2MjgyNjQ0NTI1MDU3JyB9LAogICAgeyBuYW1lOidTdGFibGUgRGlmZnVzaW9uIFhMJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J3NkeGwnLCBiYWRnZTonU0RYTCAxLjAnLCB2aWV3czonODkySycsIHZlcjonVi4xJywgbW9kZWxJZDonMTAyNzkwNjMwOTAzMjEzNjcwNCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzA5MDMyMTM2NzA1JyB9LAogICAgeyBuYW1lOidTdGFibGUgRGlmZnVzaW9uIDMuNSBNZWRpdW0nLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEIDMuNScsIHRodW1iOidzZDM1JywgYmFkZ2U6J1NEIDMuNScsIHZpZXdzOiczMTJLJywgdmVyOidWLjEnLCBtb2RlbElkOicxMDI3OTA2MzE3NDUyODA4MTkyJywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzMTc0NTI4MDgxOTMnIH0sCiAgICB7IG5hbWU6J1BvbnkgRGlmZnVzaW9uIFY2JywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidQb255JywgdGh1bWI6J3BvbnknLCBiYWRnZTonUE9OWScsIHZpZXdzOicyLjFNJywgdmVyOidWNicsIG1vZGVsSWQ6JzEwMjc5MDYzMjY4NzQyNzE3NDQnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjMyNjg3NDI3MTc0NScgfSwKICAgIHsgbmFtZTonSWxsdXN0cmlvdXMgWEwnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J0lsbHVzdHJpb3VzJywgdGh1bWI6J2lsbHVzdCcsIGJhZGdlOidJTExVU1RSSU9VUycsIHZpZXdzOic2N0snLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYzMzU3ODI0MTQzMzYnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjMzNTc4MjQxNDMzNycgfSwKICAgIHsgbmFtZTonQW5pbWEnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J0FuaW1hJywgdGh1bWI6J2FuaW1hJywgYmFkZ2U6J0FOSU1BJywgdmlld3M6JzUySycsIHZlcjonVi4xJywgbW9kZWxJZDonMTAyNzkwNjM0NDcxNjc3MTg0MCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzQ0NzE2NzcxODQxJyB9LAogICAgeyBuYW1lOidEcmVhbVNoYXBlcicsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonU0RYTCcsIHRodW1iOidkcmVhbScsIGJhZGdlOidEUycsIHZpZXdzOic4MTJLJywgdmVyOidWLjUnLCBtb2RlbElkOicxMDI3OTA2MzUzNDk5NDI5ODg4JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzNTM0OTk0Mjk4ODknIH0sCiAgICB7IG5hbWU6J1JlYWxpc3RpYyBWaXNpb24nLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjoncmVhbCcsIGJhZGdlOidSVicsIHZpZXdzOic2NDVLJywgdmVyOidWLjYuMCcsIG1vZGVsSWQ6JzEwMjc5MDYzNjI0MTI1MzE3MTInLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM2MjQxMjUzMTcxMycgfSwKICAgIHsgbmFtZTonQ291bnRlcmZlaXQnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonY291bnRlcicsIGJhZGdlOidDT1VOVEVSRkVJVCcsIHZpZXdzOic0MjBLJywgdmVyOidWLjUnLCBtb2RlbElkOicxMDI3OTA2MzcxMzM0NzI3NjgwJywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzNzEzMzQ3Mjc2ODEnIH0sCiAgICB7IG5hbWU6J0x5cmllbCcsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonU0RYTCcsIHRodW1iOidseXJpZWwnLCBiYWRnZTonTFlSSUVMJywgdmlld3M6JzMyMEsnLCB2ZXI6J1YuMS42JywgbW9kZWxJZDonMTAyNzkwNjM3OTk5NjAxMzU2OCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2Mzc5OTk2MDEzNTY5JyB9LAogICAgeyBuYW1lOidKdWdnZXJuYXV0JywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J2p1ZycsIGJhZGdlOidKVUdHJywgdmlld3M6JzIxMEsnLCB2ZXI6J1YuOScsIG1vZGVsSWQ6JzEwMjc5MDYzODg0MjEwOTk1MjAnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM4ODQyMTA5OTUyMScgfSwKICBdLAogIHJlcGxpY2F0ZTogWwogICAgeyBuYW1lOidGTFVYLjEgW3NjaG5lbGxdJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonRkxVWCcsIHRodW1iOidmbHV4JywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonNE0nLCB2ZXI6J1YxJywgbW9kZWw6J2JsYWNrLWZvcmVzdC1sYWJzL2ZsdXgtc2NobmVsbCcgfSwKICAgIHsgbmFtZTonRkxVWC4xIFtkZXZdJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonRkxVWCcsIHRodW1iOidmbHV4ZCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzIuMU0nLCB2ZXI6J1YxJywgbW9kZWw6J2JsYWNrLWZvcmVzdC1sYWJzL2ZsdXgtZGV2JyB9LAogICAgeyBuYW1lOidTRFhMIDEuMCcsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J1NEWEwnLCB0aHVtYjonc2R4bCcsIGJhZGdlOidTRFhMIDEuMCcsIHZpZXdzOicxLjJNJywgdmVyOidWMScsIG1vZGVsOidzdGFiaWxpdHktYWkvc2R4bCcgfSwKICAgIHsgbmFtZTonU3RhYmxlIERpZmZ1c2lvbiAzLjUgTGFyZ2UnLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRCAzLjUnLCB0aHVtYjonc2QzNScsIGJhZGdlOidTRCAzLjUnLCB2aWV3czonMS41TScsIHZlcjonVjEnLCBtb2RlbDonc3RhYmlsaXR5LWFpL3N0YWJsZS1kaWZmdXNpb24tMy41LWxhcmdlJyB9LAogICAgeyBuYW1lOidTRFhMIExpZ2h0bmluZyA0LVN0ZXAnLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J2xpZ2h0bmluZycsIGJhZGdlOidMSUdIVE5JTkcnLCB2aWV3czonMS44TScsIHZlcjonVjEnLCBtb2RlbDonYnl0ZWRhbmNlL3NkeGwtbGlnaHRuaW5nLTRzdGVwJyB9LAogICAgeyBuYW1lOidSZWFsVmlzWEwgVjQuMCcsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J1NEWEwnLCB0aHVtYjoncmVhbCcsIGJhZGdlOidSRUFMSVNUSUMnLCB2aWV3czonOTAwSycsIHZlcjonVjQuMCcsIG1vZGVsOidsdWNhdGFjby9yZWFsdmlzeGwtdjQuMCcgfSwKICAgIHsgbmFtZTonSnVnZ2VybmF1dCBYTCBWOScsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J1NEWEwnLCB0aHVtYjonanVnJywgYmFkZ2U6J0pVR0cnLCB2aWV3czonNzUwSycsIHZlcjonVjknLCBtb2RlbDonZGlnaXBsYXkvSnVnZ2VybmF1dF9YTF92OScgfSwKICAgIHsgbmFtZTonU0RYTCBFbW9qaScsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J1NEWEwnLCB0aHVtYjonZW1vamknLCBiYWRnZTonRU1PSkknLCB2aWV3czonNjAwSycsIHZlcjonVjEnLCBtb2RlbDonZm9mci9zZHhsLWVtb2ppJyB9LAogIF0sCiAgZmFsOiBbCiAgICB7IG5hbWU6J0ZMVVguMSBbc2NobmVsbF0nLCBiYXNlOidmYWwuYWknLCBhcmNoOidGTFVYJywgdGh1bWI6J2ZsdXgnLCBiYWRnZTonRkxVWCcsIHZpZXdzOic1TScsIHZlcjonVjEnLCBtb2RlbDonZmFsLWFpL2ZsdXgvc2NobmVsbCcgfSwKICAgIHsgbmFtZTonRkxVWC4xIFtkZXZdJywgYmFzZTonZmFsLmFpJywgYXJjaDonRkxVWCcsIHRodW1iOidmbHV4ZCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzNNJywgdmVyOidWMScsIG1vZGVsOidmYWwtYWkvZmx1eC9kZXYnIH0sCiAgICB7IG5hbWU6J0Zhc3QgU0RYTCcsIGJhc2U6J2ZhbC5haScsIGFyY2g6J1NEWEwnLCB0aHVtYjonZmFzdHNkeGwnLCBiYWRnZTonRkFMJywgdmlld3M6JzIuNU0nLCB2ZXI6J1YxJywgbW9kZWw6J2ZhbC1haS9mYXN0LXNkeGwnIH0sCiAgICB7IG5hbWU6J1NEWEwnLCBiYXNlOidmYWwuYWknLCBhcmNoOidTRFhMJywgdGh1bWI6J3NkeGwnLCBiYWRnZTonU0RYTCAxLjAnLCB2aWV3czonMS4xTScsIHZlcjonVjEnLCBtb2RlbDonZmFsLWFpL3NkeGwnIH0sCiAgICB7IG5hbWU6J1N0YWJsZSBEaWZmdXNpb24gMy41IExhcmdlJywgYmFzZTonZmFsLmFpJywgYXJjaDonU0QgMy41JywgdGh1bWI6J3NkMzUnLCBiYWRnZTonU0QgMy41Jywgdmlld3M6JzkwMEsnLCB2ZXI6J1YxJywgbW9kZWw6J2ZhbC1haS9zdGFibGUtZGlmZnVzaW9uLXYzNS1sYXJnZScgfSwKICAgIHsgbmFtZTonUGxheWdyb3VuZCB2Mi41JywgYmFzZTonZmFsLmFpJywgYXJjaDonU0RYTCcsIHRodW1iOidwbGF5JywgYmFkZ2U6J1BMQVknLCB2aWV3czonNzAwSycsIHZlcjonVjIuNScsIG1vZGVsOidmYWwtYWkvcGxheWdyb3VuZC92Mi41JyB9LAogICAgeyBuYW1lOidLcmVhIDIgVHVyYm8nLCBiYXNlOidmYWwuYWknLCBhcmNoOidLcmVhIDInLCB0aHVtYjona3JlYScsIGJhZGdlOidLUkVBMicsIHZpZXdzOicxLjFNJywgdmVyOidWMicsIG1vZGVsOidmYWwtYWkva3JlYS0yL3R1cmJvJyB9LAogIF0sCiAgcG9sbGluYXRpb25zOiBbCiAgICB7IG5hbWU6J1otSW1hZ2UgVHVyYm8nLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidBbGliYWJhJywgdGh1bWI6J3ppbWFnZScsIGJhZGdlOidGUkVFJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDonemltYWdlJyB9LAogICAgeyBuYW1lOidHUFQgSW1hZ2UgMicsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J09wZW5BSScsIHRodW1iOidncHQnLCBiYWRnZTonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J2dwdC1pbWFnZS0yJyB9LAogICAgeyBuYW1lOidGTFVYLjEgU2NobmVsbCcsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0JsYWNrIEZvcmVzdCBMYWJzJywgdGh1bWI6J2ZsdXgnLCBiYWRnZTonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J2ZsdXgnIH0sCiAgICB7IG5hbWU6J0RyZWFtU2hhcGVyIDggTENNJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonTHlrb24nLCB0aHVtYjonZHJlYW0nLCBiYWRnZTonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J2RyZWFtc2hhcGVyJyB9LAogICAgeyBuYW1lOidGTFVYLjIgS2xlaW4gNEInLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidCbGFjayBGb3Jlc3QgTGFicycsIHRodW1iOidrbGVpbicsIGJhZGdlOidGUkVFJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDona2xlaW4nIH0sCiAgICB7IG5hbWU6J0tyZWEgMiBNZWRpdW0nLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidLcmVhJywgdGh1bWI6J2tyZWEnLCBiYWRnZTonUEFJRCcsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J2tyZWEnIH0sCiAgICB7IG5hbWU6J1NlZWRyZWFtIDUuMCBMaXRlJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonQnl0ZURhbmNlJywgdGh1bWI6J3NlZWQnLCBiYWRnZTonUEFJRCcsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J3NlZWRyZWFtNScgfSwKICAgIHsgbmFtZTonUXdlbiBJbWFnZSAzJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonUXdlbicsIHRodW1iOidxd2VuJywgYmFkZ2U6J1BBSUQnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidxd2VuLWltYWdlLTMnIH0sCiAgICB7IG5hbWU6J05hbm8gQmFuYW5hIDInLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidHb29nbGUnLCB0aHVtYjonbmFubycsIGJhZGdlOidQQUlEJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDonbmFub2JhbmFuYS0yJyB9LAogIF0sCn07CnZhciBNT0RFTFMgPSBNT0RFTF9MSUJTLnRhbXM7IC8vIGRhZnRhciBha3RpZiBtZW5naWt1dGkgcHJvdmlkZXIKdmFyIE1DQVQgPSBbJ1RyeSBOb3cnLCdBTEwnLCdPRkZJQ0lBTCBNT0RFTCcsJ01FTUUnLCdFWENMVVNJVkUnLCdCRUFVVFknLCczRCcsJzIuNUQnLCdNQUxFJywnQU5JTUUnLCdSRUFMSVNUSUMnLCdTVFlMRScsJ0dBTUUnLCdERVNJR04nLCdTQ0VORVJZJywnQlVJTERJTkdTJywnTUVDSEEnXTsKdmFyIF9jdXJMaXN0PVtdLCBfY3VyT25TZWw9ZnVuY3Rpb24oKXt9OwpmdW5jdGlvbiByZW5kZXJDYXJkcyhsaXN0LCBvblNlbCl7CiAgX2N1ckxpc3Q9bGlzdDsgX2N1ck9uU2VsPW9uU2VsOwogIHZhciBiPSQoJ21vZGFsLWJvZHknKTsgYi5pbm5lckhUTUw9Jyc7CiAgaWYoIWxpc3QubGVuZ3RoKXsgYi5pbm5lckhUTUw9JzxwIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgcC0zIHRleHQtY2VudGVyIj5UaWRhayBhZGEgaGFzaWwuPC9wPic7IHJldHVybjsgfQogIHZhciBncmlkPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogIGdyaWQuY2xhc3NOYW1lPSdncmlkIGdyaWQtY29scy0zIHNtOmdyaWQtY29scy00IG1kOmdyaWQtY29scy01IGdhcC0zJzsKICBsaXN0LmZvckVhY2goZnVuY3Rpb24obSl7CiAgICB2YXIgZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICAgIGQuY2xhc3NOYW1lPSdtY2FyZCc7CiAgICBkLmlubmVySFRNTCA9JzxkaXYgY2xhc3M9Im1jYXJkLWltZyI+JwogICAgICArJzxpbWcgc3JjPSInK1MrbS50aHVtYisnLzMwMCIvPicKICAgICAgKyc8c3BhbiBjbGFzcz0ibWNhcmQtYmFkZ2UiPicrbS5iYWRnZSsnPC9zcGFuPicKICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC1zdGFyIj48aSBkYXRhLWljb249InN0YXIiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9Im1jYXJkLXZpZXdzIj48aSBkYXRhLWljb249InBsYXktZmlsbCIgY2xhc3M9InctMyBoLTMiPjwvaT4nK20udmlld3MrJzwvZGl2PicKICAgICAgKyc8L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibWNhcmQtaW5mbyI+JwogICAgICArJzxkaXYgY2xhc3M9Im1jYXJkLW5hbWUiIHRpdGxlPSInK20ubmFtZSsnIj4nK20ubmFtZSsnPC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9Im1jYXJkLW1ldGEiPicKICAgICAgKyc8c2VsZWN0IGNsYXNzPSJtY2FyZC12ZXIiPjxvcHRpb24+JyttLnZlcisnPC9vcHRpb24+PG9wdGlvbj5WLjI8L29wdGlvbj48b3B0aW9uPlYuMzwvb3B0aW9uPjwvc2VsZWN0PicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJtY2FyZC1zZWwiPlNlbGVjdDwvYnV0dG9uPicKICAgICAgKyc8L2Rpdj48L2Rpdj4nOwogICAgZC5xdWVyeVNlbGVjdG9yKCcubWNhcmQtc3RhcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgZS50YXJnZXQuY2xvc2VzdCgnLm1jYXJkLXN0YXInKS5jbGFzc0xpc3QudG9nZ2xlKCdvbicpOyB9KTsKICAgIGQucXVlcnlTZWxlY3RvcignLm1jYXJkLXNlbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBfY3VyT25TZWwobSk7IH0pOwogICAgZ3JpZC5hcHBlbmRDaGlsZChkKTsKICB9KTsKICBiLmFwcGVuZENoaWxkKGdyaWQpOwp9CmZ1bmN0aW9uIGFwcGx5U2VhcmNoKCl7CiAgdmFyIHE9KCQoJ21zZWFyY2gnKS52YWx1ZXx8JycpLnRvTG93ZXJDYXNlKCk7CiAgcmVuZGVyQ2FyZHMoX2N1ckxpc3QuZmlsdGVyKGZ1bmN0aW9uKG0pe3JldHVybiAhcXx8bS5uYW1lLnRvTG93ZXJDYXNlKCkuaW5kZXhPZihxKT49MH0pLCBfY3VyT25TZWwpOwp9CiQoJ21zZWFyY2gnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsYXBwbHlTZWFyY2gpOwokKCdtZmlsdGVycycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyAkKCdtY2F0JykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJyk7ICQoJ21maWx0ZXJzJykuY2xhc3NMaXN0LnRvZ2dsZSgnb24nKTsgfSk7CmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tdGFiJykuZm9yRWFjaChmdW5jdGlvbih0KXsKICB0LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLm10YWInKS5mb3JFYWNoKGZ1bmN0aW9uKHgpe3guY2xhc3NMaXN0LnJlbW92ZSgnc2VsJyl9KTsKICAgIHQuY2xhc3NMaXN0LmFkZCgnc2VsJyk7CiAgICBpZih0LmRhdGFzZXQubXRhYj09PSdiYXNpYycpIHJlbmRlckNhcmRzKE1PREVMUywgZnVuY3Rpb24obSl7IHNldE1vZGVsKG0pOyBjbG9zZU1vZGFsKCk7IH0pOwogICAgZWxzZSByZW5kZXJDYXJkcyhbXSwgbnVsbCk7CiAgfSk7Cn0pOwpmdW5jdGlvbiByZW5kZXJNQ2F0KG9uUGljayl7CiAgdmFyIGM9JCgnbWNhdCcpOwogIGlmKCFvblBpY2spIG9uUGljaz1mdW5jdGlvbigpe307CiAgdmFyIGh0bWw9Jyc7CiAgTUNBVC5mb3JFYWNoKGZ1bmN0aW9uKGNhdCxpKXsKICAgIGh0bWwrPSc8YnV0dG9uIGNsYXNzPSJtY2hpcCIgZGF0YS1tY2F0PSInK2NhdCsnIj4nK2NhdCsnPC9idXR0b24+JzsKICB9KTsKICBjLmlubmVySFRNTD1odG1sOwogIGMucXVlcnlTZWxlY3RvcignLm1jaGlwJykuY2xhc3NMaXN0LmFkZCgnb24nKTsKICBjLnF1ZXJ5U2VsZWN0b3JBbGwoJy5tY2hpcCcpLmZvckVhY2goZnVuY3Rpb24oY2gpewogICAgY2guYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgICAgIGMucXVlcnlTZWxlY3RvckFsbCgnLm1jaGlwJykuZm9yRWFjaChmdW5jdGlvbih4KXt4LmNsYXNzTGlzdC5yZW1vdmUoJ29uJyl9KTsKICAgICAgY2guY2xhc3NMaXN0LmFkZCgnb24nKTsKICAgICAgb25QaWNrKGNoLmRhdGFzZXQubWNhdCk7CiAgICB9KTsKICB9KTsKfQpmdW5jdGlvbiBzZXRNb2RlbChtKXsKICBzdGF0ZS5tb2RlbD1tOwogICQoJ21vZGVsLW5hbWUnKS50ZXh0Q29udGVudD1tLm5hbWU7CiAgJCgnbW9kZWwtdGh1bWInKS5zcmM9J2h0dHBzOi8vcGljc3VtLnBob3Rvcy9zZWVkLycrbS50aHVtYisnLzY0JzsKICB2YXIgYj0kKCdtb2RlbC1iYWRnZScpOyBpZihiKSBiLnRleHRDb250ZW50PShtLmJhc2V8fCdNb2RlbCcpKycgLSAnKyhtLmFyY2h8fCcnKTsKfQpmdW5jdGlvbiBvcGVuTW9kZWxTZWxlY3RvcigpewogICQoJ21vZGFsLXRpdGxlJykudGV4dENvbnRlbnQ9J1BpbGloIE1vZGVsJzsKICByZW5kZXJNQ2F0KGZ1bmN0aW9uKCl7IHJlbmRlckNhcmRzKE1PREVMUywgZnVuY3Rpb24obSl7IHNldE1vZGVsKG0pOyBjbG9zZU1vZGFsKCk7IH0pOyB9KTsKICByZW5kZXJDYXJkcyhNT0RFTFMsIGZ1bmN0aW9uKG0peyBzZXRNb2RlbChtKTsgY2xvc2VNb2RhbCgpOyB9KTsKICBvcGVuTW9kYWwoKTsKfQokKCdtb2RlbC1jYXJkJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLG9wZW5Nb2RlbFNlbGVjdG9yKTsKZnVuY3Rpb24gb3BlbkxvcmFNb2RhbCgpewogICQoJ21vZGFsLXRpdGxlJykudGV4dENvbnRlbnQ9J1BpbGloIExvUkEnOwogIHZhciBhcmNoPXN0YXRlLm1vZGVsP3N0YXRlLm1vZGVsLmFyY2g6Jyc7CiAgdmFyIGF2YWlsPWZ1bmN0aW9uKCl7IHJldHVybiBMT1JBX0xJQi5maWx0ZXIoZnVuY3Rpb24obCl7CiAgICByZXR1cm4gKCFMT1JBLnNvbWUoZnVuY3Rpb24oeCl7cmV0dXJuIHgubmFtZT09PWwubmFtZX0pKSAmJiAoIWFyY2ggfHwgIWwuYmFzZSB8fCBsLmJhc2U9PT1hcmNoKTsKICB9KTsgfTsKICB2YXIgb25TZWw9ZnVuY3Rpb24obCl7CiAgICBMT1JBLnB1c2goeyBuYW1lOmwubmFtZSwgdzowLjgsIHRhZ3M6bC50YWdzLCB0aHVtYjpsLnRodW1iLCBiYXNlOmwuYmFzZSwgbG9yYU1vZGVsOmwubW9kZWx8fCcnLCBuZWVkVXJsOmwubmVlZFVybCwgbG9yYVVybDonJyB9KTsKICAgIHJlbmRlckxvcmEoKTsgY2xvc2VNb2RhbCgpOwogIH07CiAgcmVuZGVyTUNhdChmdW5jdGlvbigpeyByZW5kZXJDYXJkcyhhdmFpbCgpLCBvblNlbCk7IH0pOwogIHJlbmRlckNhcmRzKGF2YWlsKCksIG9uU2VsKTsKICBpZighYXZhaWwoKS5sZW5ndGgpeyAkKCdtb2RhbC10aXRsZScpLnRleHRDb250ZW50PSdUaWRhayBhZGEgTG9SQSB1bnR1ayAnK2FyY2g7IH0KICBvcGVuTW9kYWwoKTsKfQpmdW5jdGlvbiBvcGVuTW9kYWwoKXsgJCgnbW9kYWwnKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgJCgnbW9kYWwnKS5jbGFzc0xpc3QuYWRkKCdmbGV4Jyk7IH0KZnVuY3Rpb24gY2xvc2VNb2RhbCgpeyAkKCdtb2RhbCcpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyAkKCdtb2RhbCcpLmNsYXNzTGlzdC5yZW1vdmUoJ2ZsZXgnKTsgfQpmdW5jdGlvbiBvcGVuTG9yYUluZm8obCl7CiAgJCgnbW9kYWwtdGl0bGUnKS50ZXh0Q29udGVudD0nRGV0YWlsIExvUkEnOwogICQoJ21jYXQnKS5pbm5lckhUTUw9Jyc7CiAgdmFyIGI9JCgnbW9kYWwtYm9keScpOwogIGIuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJmbGV4IGdhcC0zIHAtMiI+JwogICAgKyc8aW1nIHNyYz0iJytTK2wudGh1bWIrJy8xNDAiIGNsYXNzPSJ3LTI4IGgtMjggcm91bmRlZC1sZyBvYmplY3QtY292ZXIgc2hyaW5rLTAiLz4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgtMSBtaW4tdy0wIj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXggZmxleC13cmFwIGdhcC0xLjUgbWItMSI+JwogICAgKyc8c3BhbiBjbGFzcz0idGV4dC1bMTBweF0gZm9udC1zZW1pYm9sZCBiZy1bIzFjMjEyOF0gYm9yZGVyIGJkIHB4LTEuNSBweS0wLjUgcm91bmRlZCB0ZXh0LW5ldXRyYWwtNDAwIj5MT1JBPC9zcGFuPicKICAgICsnPHNwYW4gY2xhc3M9InRleHQtWzEwcHhdIGZvbnQtc2VtaWJvbGQgYmctW3JnYmEoMTExLDkzLDI1NSwuMTUpXSBib3JkZXIgYm9yZGVyLVsjNkY1REZGXSBweC0xLjUgcHktMC41IHJvdW5kZWQgdGV4dC1bIzZGNURGRl0iPicrbC5iYWRnZSsnPC9zcGFuPicKICAgICsnPHNwYW4gY2xhc3M9InRleHQtWzEwcHhdIGZvbnQtc2VtaWJvbGQgYmctWyMxYzIxMjhdIGJvcmRlciBiZCBweC0xLjUgcHktMC41IHJvdW5kZWQgdGV4dC1uZXV0cmFsLTQwMCI+T3JpZ2luYWw8L3NwYW4+JwogICAgKyc8L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+JytsLm5hbWUrJzwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIG10LTAuNSI+UmVrdHkgQUk8L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xIG10LTEgdGV4dC14cyB0ZXh0LW5ldXRyYWwtNDAwIj48aSBkYXRhLWljb249ImRvd25sb2FkLXNpbXBsZSIgY2xhc3M9InctMy41IGgtMy41Ij48L2k+JysobC52aWV3cz9sLnZpZXdzOicxMksnKSsnIGRvd25sb2FkczwvZGl2PicKICAgICsnPC9kaXY+PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJib3JkZXItdCBiZCBtdC0yIHB0LTMiPicKICAgICsnPGRpdiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIG1iLTIgZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEiPjxpIGRhdGEtaWNvbj0idGFnIiBjbGFzcz0idy00IGgtNCI+PC9pPlZlcnNpb24gRGV0YWlsPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJncmlkIGdyaWQtY29scy0yIGdhcC0yIHRleHQteHMiPicKICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4gYm9yZGVyIGJkIHJvdW5kZWQtbGcgcHgtMiBweS0xLjUiPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj5CYXNlIE1vZGVsPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj5aIEltYWdlPC9zcGFuPjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4gYm9yZGVyIGJkIHJvdW5kZWQtbGcgcHgtMiBweS0xLjUiPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj5TdGVwczwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+MjUwMDwvc3Bhbj48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGJvcmRlciBiZCByb3VuZGVkLWxnIHB4LTIgcHktMS41Ij48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+RXBvY2g8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPjEyPC9zcGFuPjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4gYm9yZGVyIGJkIHJvdW5kZWQtbGcgcHgtMiBweS0xLjUiPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj5UcmlnZ2VyIFdvcmRzPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LVsjMjdENENEXSI+JytsLnRhZ3Muc2xpY2UoMCwyKS5qb2luKCcsICcpKyc8L3NwYW4+PC9kaXY+JwogICAgKyc8L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBtdC0zIG1iLTEiPkRlc2NyaXB0aW9uPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAgbGVhZGluZy1yZWxheGVkIj4nK2wudGFncy5qb2luKCcsICcpKycg4oCUIExvUkEgdW50dWsgZ2F5YSBkYW4gZGV0YWlsIHRhbWJhaGFuIGRpIFogSW1hZ2UuPC9kaXY+JzsKICBvcGVuTW9kYWwoKTsKfQokKCdtb2RlbC1pbmZvJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKGUpeyBlLnN0b3BQcm9wYWdhdGlvbigpOyBvcGVuTG9yYUluZm8oe25hbWU6JCgnbW9kZWwtbmFtZScpLnRleHRDb250ZW50LGJhZGdlOidaIEltYWdlJyx0aHVtYjonemltYWdlJyx0YWdzOlsnZGV0YWlsJywnc2hhcnAnXX0pOyB9KTsKJCgnbW9kYWwtY2xvc2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsY2xvc2VNb2RhbCk7CiQoJ21vZGFsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKGUpeyBpZihlLnRhcmdldD09PSQoJ21vZGFsJykpIGNsb3NlTW9kYWwoKTsgfSk7CiQoJ2J0bi1hZGRsb3JhJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLG9wZW5Mb3JhTW9kYWwpOwpkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJyxmdW5jdGlvbihlKXsgaWYoZS5rZXk9PT0nRXNjYXBlJykgY2xvc2VNb2RhbCgpOyB9KTsKZnVuY3Rpb24gcmVuZGVyTG9yYSgpewogIHZhciBsaXN0ID0gJCgnbG9yYS1saXN0Jyk7IGxpc3QuaW5uZXJIVE1MPScnOwogIGlmKCFMT1JBLmxlbmd0aCl7IGxpc3QuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC02MDAgYm9yZGVyIGJvcmRlci1kYXNoZWQgYm9yZGVyLVsjMzAzNjNkXSByb3VuZGVkLWxnIHAtMyB0ZXh0LWNlbnRlciI+QmVsdW0gYWRhIExvUkEuIEtsaWsgIkFkZCBMb1JBIi48L2Rpdj4nOyByZW5kZXJUcmlnZ2VycygpOyByZXR1cm47IH0KICBMT1JBLmZvckVhY2goZnVuY3Rpb24obCxyaSl7CiAgICB2YXIgZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICAgIGQuY2xhc3NOYW1lPSdsb3JhLWNhcmQnOwogICAgZC5pbm5lckhUTUw9JycKICAgICAgKyc8c3BhbiBjbGFzcz0ibG9yYS1sYWJlbCI+TG9SQSAtICcrKGwuYmFzZXx8J1ogSW1hZ2UnKSsnPC9zcGFuPicKICAgICAgKyc8ZGl2IGNsYXNzPSJsb3JhLXRvcCI+JwogICAgICArJzxpbWcgc3JjPSInK1MrbC50aHVtYisnLzQwIiBjbGFzcz0ibG9yYS10aHVtYiIgYWx0PSIiLz4nCiAgICAgICsnPHNwYW4gY2xhc3M9ImxvcmEtbmFtZSI+JytsLm5hbWUrJzwvc3Bhbj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibG9yYS1pY29ucyI+JwogICAgICArJzxidXR0b24gY2xhc3M9ImxvcmEtaWNvbiIgZGF0YS1pbmZvPSInK3JpKyciIHRpdGxlPSJJbmZvIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIvPjxsaW5lIHgxPSIxMiIgeTE9IjE2IiB4Mj0iMTIiIHkyPSIxMiIvPjxsaW5lIHgxPSIxMiIgeTE9IjgiIHgyPSIxMi4wMSIgeTI9IjgiLz48L3N2Zz48L2J1dHRvbj4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibG9yYS1pY29uIGRlbCIgZGF0YS1kZWw9IicrcmkrJyIgdGl0bGU9IkhhcHVzIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cG9seWxpbmUgcG9pbnRzPSIzIDYgNSA2IDIxIDYiLz48cGF0aCBkPSJNMTkgNnYxNGEyIDIgMCAwIDEtMiAySDdhMiAyIDAgMCAxLTItMlY2bTMgMFY0YTIgMiAwIDAgMSAyLTJoNGEyIDIgMCAwIDEgMiAydjIiLz48bGluZSB4MT0iMTAiIHkxPSIxMSIgeDI9IjEwIiB5Mj0iMTciLz48bGluZSB4MT0iMTQiIHkxPSIxMSIgeDI9IjE0IiB5Mj0iMTciLz48L3N2Zz48L2J1dHRvbj4nCiAgICAgICsnPC9kaXY+JwogICAgICArJzwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJsb3JhLXNsaWRlci1yb3ciPicKICAgICAgKyc8ZGl2IGNsYXNzPSJsLXNsaWRlciI+PGRpdiBjbGFzcz0ibC10cmFjayI+PC9kaXY+PGRpdiBjbGFzcz0ibC1maWxsIiBzdHlsZT0id2lkdGg6JysobC53LzIqMTAwKSsnJSI+PC9kaXY+PGRpdiBjbGFzcz0ibC1oYW5kbGUiIHN0eWxlPSJsZWZ0OicrKGwudy8yKjEwMCkrJyUiPjwvZGl2PjxpbnB1dCB0eXBlPSJyYW5nZSIgbWluPSIwIiBtYXg9IjIiIHN0ZXA9IjAuMSIgdmFsdWU9IicrbC53KyciIGRhdGEtcmk9IicrcmkrJyIgY2xhc3M9ImxvcmEtc2wiLz48L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibC1udW0iPicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJsb3JhLWJ0biIgZGF0YS1kZWM9IicrcmkrJyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGxpbmUgeDE9IjUiIHkxPSIxMiIgeDI9IjE5IiB5Mj0iMTIiLz48L3N2Zz48L2J1dHRvbj4nCiAgICAgICsnPGlucHV0IHR5cGU9InRleHQiIHZhbHVlPSInK2wudy50b0ZpeGVkKDEpKyciIGNsYXNzPSJsb3JhLWlucHV0IiBkYXRhLXJpPSInK3JpKyciIGlucHV0bW9kZT0iZGVjaW1hbCIvPicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJsb3JhLWJ0biIgZGF0YS1pbmM9IicrcmkrJyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGxpbmUgeDE9IjEyIiB5MT0iNSIgeDI9IjEyIiB5Mj0iMTkiLz48bGluZSB4MT0iNSIgeTE9IjEyIiB4Mj0iMTkiIHkyPSIxMiIvPjwvc3ZnPjwvYnV0dG9uPicKICAgICAgKyc8L2Rpdj4nCiAgICAgICsobC5uZWVkVXJsPyc8ZGl2IGNsYXNzPSJtdC0yIj48aW5wdXQgdHlwZT0idGV4dCIgY2xhc3M9ImlucCBsb3JhLXVybC1pbnAiIHZhbHVlPSInKyhsLmxvcmFVcmx8fCcnKSsnIiBkYXRhLXVybD0iJytyaSsnIiBwbGFjZWhvbGRlcj0iaHR0cHM6Ly9odWdnaW5nZmFjZS5jby91c2VyL3JlcG8vcmVzb2x2ZS9tYWluL2xvcmEuc2FmZXRlbnNvcnMiLz48ZGl2IGNsYXNzPSJtdC0xIHRleHQtWzEwcHhdIGxlYWRpbmctc251ZyB0ZXh0LW5ldXRyYWwtNTAwIj5VUkwgcHVibGlrIGxhbmdzdW5nICguc2FmZXRlbnNvcnMpIOKAlCBjb250b2ggSHVnZ2luZ0ZhY2UgcmVzb2x2ZS4gS2FnZ2xlIHRpZGFrIGJpc2EgKGJ1dHVoIGxvZ2luKS48L2Rpdj48L2Rpdj4nOicnKQogICAgICArJzwvZGl2Pic7CiAgICB2YXIgc2w9ZC5xdWVyeVNlbGVjdG9yKCcubC1zbGlkZXIgW2RhdGEtcmk9IicrcmkrJyJdJyk7CiAgICB2YXIgdUlucD1kLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLXVybD0iJytyaSsnIl0nKTsKICAgIGlmKHVJbnApeyB1SW5wLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbihlKXsgTE9SQVtyaV0ubG9yYVVybD1lLnRhcmdldC52YWx1ZS50cmltKCk7IH0pOyB9CiAgICBzbC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7CiAgICAgIHZhciB2PXBhcnNlRmxvYXQoZS50YXJnZXQudmFsdWUpOyBpZihpc05hTih2KSlyZXR1cm47CiAgICAgIExPUkFbcmldLnc9djsKICAgICAgdmFyIHBjdD0odi8yKjEwMCk7CiAgICAgIGQucXVlcnlTZWxlY3RvcignLmwtZmlsbCcpLnN0eWxlLndpZHRoPXBjdCsnJSc7CiAgICAgIGQucXVlcnlTZWxlY3RvcignLmwtaGFuZGxlJykuc3R5bGUubGVmdD1wY3QrJyUnOwogICAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5sb3JhLWlucHV0JykudmFsdWU9di50b0ZpeGVkKDEpOwogICAgICByZW5kZXJUcmlnZ2VycygpOwogICAgfSk7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5sLW51bSBbZGF0YS1pbmM9IicrcmkrJyJdJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IHNldExXKHJpLCsoTE9SQVtyaV0udyswLjEpLnRvRml4ZWQoMSkpOyByZW5kZXJMb3JhKCk7IH0pOwogICAgZC5xdWVyeVNlbGVjdG9yKCcubC1udW0gW2RhdGEtZGVjPSInK3JpKyciXScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBzZXRMVyhyaSwrKExPUkFbcmldLnctMC4xKS50b0ZpeGVkKDEpKTsgcmVuZGVyTG9yYSgpOyB9KTsKICAgIGQucXVlcnlTZWxlY3RvcignW2RhdGEtZGVsPSInK3JpKyciXScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBMT1JBLnNwbGljZShyaSwxKTsgcmVuZGVyTG9yYSgpOyByZW5kZXJUcmlnZ2VycygpOyB9KTsKICAgIGQucXVlcnlTZWxlY3RvcignW2RhdGEtaW5mbz0iJytyaSsnIl0nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgb3BlbkxvcmFJbmZvKGwpOyB9KTsKICAgIGxpc3QuYXBwZW5kQ2hpbGQoZCk7CiAgfSk7CiAgcmVuZGVyVHJpZ2dlcnMoKTsKfQpmdW5jdGlvbiBzZXRMVyhpLHYpeyBMT1JBW2ldLnc9TWF0aC5tYXgoMCxNYXRoLm1pbigyLHYpKTsgfQp2YXIgX3BlbmRpbmdUcmlnID0gW107CmZ1bmN0aW9uIHJlbmRlclRyaWdnZXJzKCl7CiAgdmFyIHA9KCQoJ3Byb21wdCcpLnZhbHVlfHwnJykudG9Mb3dlckNhc2UoKTsKICB2YXIgdD0kKCd0cmlnZ2VycycpOyB0LmlubmVySFRNTD0nJzsKICBfcGVuZGluZ1RyaWc9W107CiAgTE9SQS5maWx0ZXIoZnVuY3Rpb24obCl7cmV0dXJuIGwudz4wfSkuZm9yRWFjaChmdW5jdGlvbihsKXsKICAgIGwudGFncy5mb3JFYWNoKGZ1bmN0aW9uKHcpeyBpZihwLmluZGV4T2Yody50b0xvd2VyQ2FzZSgpKTwwKSBfcGVuZGluZ1RyaWcucHVzaCh7d29yZDp3LGxvcmE6bC5uYW1lfSk7IH0pOwogIH0pOwogICQoJ3RyLWNvdW50JykudGV4dENvbnRlbnQ9X3BlbmRpbmdUcmlnLmxlbmd0aDsKICBpZighX3BlbmRpbmdUcmlnLmxlbmd0aCl7IHQuaW5uZXJIVE1MPSc8c3BhbiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNjAwIj5UaWRhayBhZGEgdHJpZ2dlciB3b3JkIHRlcnNpc2E8L3NwYW4+JzsgcmV0dXJuOyB9CiAgX3BlbmRpbmdUcmlnLmZvckVhY2goZnVuY3Rpb24oaXRlbSl7CiAgICB2YXIgYj1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsKICAgIGIuY2xhc3NOYW1lPSd0YWcgY3Vyc29yLXBvaW50ZXIgaG92ZXI6Ym9yZGVyLVsjMjdENENEXSBob3Zlcjp0ZXh0LVsjMjdENENEXSB0cmFuc2l0aW9uJzsKICAgIGIuaW5uZXJIVE1MPSc8aSBkYXRhLWljb249InNwYXJrbGUiIGNsYXNzPSJ3LTMgaC0zIHRleHQtWyMyN0Q0Q0RdIj48L2k+JytpdGVtLndvcmQ7CiAgICBiLnRpdGxlPSdUYW1iYWhrYW4ga2UgcHJvbXB0ICgnK2l0ZW0ubG9yYSsnKSc7CiAgICBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICAgICBhZGRXb3JkKGl0ZW0ud29yZCk7CiAgICAgIHJlbmRlclRyaWdnZXJzKCk7CiAgICB9KTsKICAgIHQuYXBwZW5kQ2hpbGQoYik7CiAgfSk7Cn0KZnVuY3Rpb24gYWRkV29yZCh3KXsKICB2YXIgcHI9JCgncHJvbXB0JyksIGN2PXByLnZhbHVlLnRyaW0oKTsKICBpZihjdiAmJiAhY3YuZW5kc1dpdGgoJywnKSkgY3YrPScsJzsKICBwci52YWx1ZT1jdit3KycsJzsKICBwci5mb2N1cygpOwp9CmZ1bmN0aW9uIGFkZEFsbFRyaWcoKXsKICB2YXIgYWxsPV9wZW5kaW5nVHJpZy5tYXAoZnVuY3Rpb24oeCl7cmV0dXJuIHgud29yZH0pOwogIGFsbC5mb3JFYWNoKGFkZFdvcmQpOwogIHJlbmRlclRyaWdnZXJzKCk7Cn0KJCgnYWRkYWxsLXRyaWcnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsYWRkQWxsVHJpZyk7CgovKiA9PT09PSBhc3BlY3QgcmF0aW8gPT09PT0gKi8KdmFyIEFSX01BUCA9IHsKICBwb3J0cmFpdDpbJ1BvcnRyYWl0Jyw3NjgsMTE1Ml0sCiAgbGFuZHNjYXBlOlsnTGFuZHNjYXBlJywxMTUyLDc2OF0sCiAgc3F1YXJlOlsnU3F1YXJlJywxMDI0LDEwMjRdLAogIGN1c3RvbTpbJ2N1c3RvbScsbnVsbCxudWxsXQp9Owpkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXInKS5mb3JFYWNoKGZ1bmN0aW9uKGIpewogIGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgICB2YXIgYXI9Yi5kYXRhc2V0LmFyOyBzdGF0ZS5hc3BlY3Q9YXI7CiAgICBzZXRBckFjdGl2ZShhcik7CiAgICBpZihhciE9PSdjdXN0b20nKXsgJCgnd2lkdGgnKS52YWx1ZT1BUl9NQVBbYXJdWzFdOyAkKCdoZWlnaHQnKS52YWx1ZT1BUl9NQVBbYXJdWzJdOyB9CiAgICB1cGRXSCgpOwogIH0pOwp9KTsKZnVuY3Rpb24gdXBkV0goKXsgJCgnd3YnKS52YWx1ZT0kKCd3aWR0aCcpLnZhbHVlOyAkKCdodicpLnZhbHVlPSQoJ2hlaWdodCcpLnZhbHVlOyB9CiQoJ3dpZHRoJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKCl7ICQoJ3d2JykudmFsdWU9JCgnd2lkdGgnKS52YWx1ZTsgc3RhdGUuYXNwZWN0PSdjdXN0b20nOyBzZXRBckFjdGl2ZSgnY3VzdG9tJyk7IH0pOwokKCdoZWlnaHQnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oKXsgJCgnaHYnKS52YWx1ZT0kKCdoZWlnaHQnKS52YWx1ZTsgc3RhdGUuYXNwZWN0PSdjdXN0b20nOyBzZXRBckFjdGl2ZSgnY3VzdG9tJyk7IH0pOwokKCd3dicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsZnVuY3Rpb24oKXsgdmFyIHY9TWF0aC5tYXgoMjU2LE1hdGgubWluKDE1MzYscGFyc2VJbnQoJCgnd3YnKS52YWx1ZSl8fDc2OCkpOyB2PU1hdGgucm91bmQodi82NCkqNjQ7ICQoJ3d2JykudmFsdWU9djsgJCgnd2lkdGgnKS52YWx1ZT12OyBzdGF0ZS5hc3BlY3Q9J2N1c3RvbSc7IHNldEFyQWN0aXZlKCdjdXN0b20nKTsgfSk7CiQoJ2h2JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbigpeyB2YXIgdj1NYXRoLm1heCgyNTYsTWF0aC5taW4oMTUzNixwYXJzZUludCgkKCdodicpLnZhbHVlKXx8MTE1MikpOyB2PU1hdGgucm91bmQodi82NCkqNjQ7ICQoJ2h2JykudmFsdWU9djsgJCgnaGVpZ2h0JykudmFsdWU9djsgc3RhdGUuYXNwZWN0PSdjdXN0b20nOyBzZXRBckFjdGl2ZSgnY3VzdG9tJyk7IH0pOwpmdW5jdGlvbiBzZXRBckFjdGl2ZShhcil7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmFyJykuZm9yRWFjaChmdW5jdGlvbih4KXt4LmNsYXNzTGlzdC50b2dnbGUoJ3NlbCcsIHguZGF0YXNldC5hcj09PWFyKX0pOwogICQoJ2FyLWxhYmVsJykudGV4dENvbnRlbnQ9QVJfTUFQW2FyXVswXTsKfQokKCdzdGVwcycpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbihlKXskKCdzdicpLnRleHRDb250ZW50PWUudGFyZ2V0LnZhbHVlfSk7CiQoJ2NmZycpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbihlKXskKCdjZnYnKS50ZXh0Q29udGVudD1lLnRhcmdldC52YWx1ZX0pOwokKCdjbGlwc2tpcCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbihlKXskKCdjc3YnKS50ZXh0Q29udGVudD1lLnRhcmdldC52YWx1ZX0pOwokKCdldGFuc2QnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7JCgnZW5zZCcpLnRleHRDb250ZW50PWUudGFyZ2V0LnZhbHVlfSk7CiQoJ2Fkdi10b2dnbGUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXskKCdhZHYtZmllbGRzJykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJyl9KTsKJCgnZGljZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyQoJ3NlZWQnKS52YWx1ZT1TdHJpbmcoTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKjk5OTk5OTk5OTk5OTk5OTkpKX0pOwokKCduZWdjaGVjaycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsZnVuY3Rpb24oZSl7JCgnbmVnd3JhcCcpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicsIWUudGFyZ2V0LmNoZWNrZWQpfSk7CiQoJ3Byb21wdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxyZW5kZXJUcmlnZ2Vycyk7Ci8qIFRyYW5zbGF0ZTogc2VtdWEgYmFoYXNhIC0+IEluZ2dyaXMgKGJhY2tlbmQgL2FwaS90cmFuc2xhdGUsIGdyYXRpcykgKi8KZnVuY3Rpb24gc2V0VHJhbnNsYXRlQnVzeShiKXsKICB2YXIgZWw9JCgnYnRuLXRyYW5zbGF0ZScpOwogIGVsLmlubmVySFRNTD1iPyc8aSBkYXRhLWljb249ImNpcmNsZS1ub3RjaCIgY2xhc3M9InctNCBoLTQgYW5pbWF0ZS1zcGluIj48L2k+JzonPGkgZGF0YS1pY29uPSJ0cmFuc2xhdGUiIGNsYXNzPSJ3LTQgaC00Ij48L2k+JzsKfQokKCdidG4tdHJhbnNsYXRlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgdmFyIHA9KCQoJ3Byb21wdCcpLnZhbHVlfHwnJykudHJpbSgpOwogIGlmKCFwKXsgJCgncHJvbXB0JykuZm9jdXMoKTsgcmV0dXJuOyB9CiAgc2V0VHJhbnNsYXRlQnVzeSh0cnVlKTsKICBmZXRjaCgnL2FwaS90cmFuc2xhdGU/cT0nK2VuY29kZVVSSUNvbXBvbmVudChwKSkudGhlbihmdW5jdGlvbihyKXsgcmV0dXJuIHIuanNvbigpOyB9KS50aGVuKGZ1bmN0aW9uKGQpewogICAgaWYoZC5vayYmZC50ZXh0KXsgJCgncHJvbXB0JykudmFsdWU9ZC50ZXh0OyByZW5kZXJUcmlnZ2VycygpOyB0b2FzdCgnRGl0ZXJqZW1haGthbiBrZSBJbmdncmlzIOKckycpOyB9CiAgICBlbHNlIHRvYXN0KGQuZXJyb3J8fCdHYWdhbCBtZW5lcmplbWFoa2FuJyk7CiAgfSkuY2F0Y2goZnVuY3Rpb24oKXsgdG9hc3QoJ0dhZ2FsIG1lbmVyamVtYWhrYW4nKTsgfSkuZmluYWxseShmdW5jdGlvbigpeyBzZXRUcmFuc2xhdGVCdXN5KGZhbHNlKTsgfSk7Cn0pOwovKiBQcm9tcHQgRW5oYW5jZSAoc2VwZXJ0aSBUZW5zb3IuQXJ0KTogaGFzaWwgcmVmaW5lIHRhbXBpbCBkaSBwb3B1cCB1bnR1awogICBkaWtvbmZpcm1hc2kvZGllZGl0IHNlYmVsdW0gZGlwYWthaS4gQmFja2VuZCAvYXBpL3JlZmluZSAoTExNIFBvbGxpbmF0aW9ucyksCiAgIGZhbGxiYWNrIHRlbXBsYXRlIGxva2FsIGthbGF1IHRhbnBhIGtleS4gKi8KdmFyIF9lbmhPcmlnPScnOwpmdW5jdGlvbiBmYWxsYmFja0VuaGFuY2UocCl7CiAgcmV0dXJuIHAKICAgICsnXG5cbkVuaGFuY2UgZGV0YWlsLCBsaWdodGluZywgY29tcG9zaXRpb24sIGFuZCBhdG1vc3BoZXJlLiAnCiAgICArJ1VsdHJhLWRldGFpbGVkLCBwcm9mZXNzaW9uYWwgcGhvdG9ncmFwaHksIHNoYXJwIGZvY3VzLCBjaW5lbWF0aWMgbGlnaHRpbmcuJzsKfQpmdW5jdGlvbiBvcGVuRW5oTW9kYWwocCl7CiAgX2VuaE9yaWc9cDsKICAkKCdlbmgtb3JpZycpLnRleHRDb250ZW50PXA7CiAgJCgnZW5oLXRleHQnKS52YWx1ZT0nJzsKICAkKCdlbmgtbW9kYWwnKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgJCgnZW5oLW1vZGFsJykuY2xhc3NMaXN0LmFkZCgnZmxleCcpOwp9CmZ1bmN0aW9uIGNsb3NlRW5oTW9kYWwoKXsgJCgnZW5oLW1vZGFsJykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ2VuaC1tb2RhbCcpLmNsYXNzTGlzdC5yZW1vdmUoJ2ZsZXgnKTsgfQpmdW5jdGlvbiBkb0VuaGFuY2UoKXsKICB2YXIgcD0oJCgncHJvbXB0JykudmFsdWV8fCcnKS50cmltKCk7CiAgaWYoIXApeyAkKCdwcm9tcHQnKS5mb2N1cygpOyByZXR1cm47IH0KICBvcGVuRW5oTW9kYWwocCk7CiAgJCgnZW5oLXRleHQnKS52YWx1ZT0nTWVuZ2hhc2lsa2FuIHByb21wdCB5YW5nIGxlYmloIGJhaWsuLi4nOwogIHZhciBiPSQoJ2VuaC1yZWdlbicpOyBiLmRpc2FibGVkPXRydWU7IGIuc3R5bGUub3BhY2l0eT0nMC41JzsKICBmZXRjaCgnL2FwaS9yZWZpbmUnLHttZXRob2Q6J1BPU1QnLGhlYWRlcnM6X2FwaUhlYWRlcnMoeydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJ30pLGJvZHk6SlNPTi5zdHJpbmdpZnkoe3Byb21wdDpwfSl9KQogICAgLnRoZW4oZnVuY3Rpb24ocil7IHJldHVybiByLmpzb24oKTsgfSkKICAgIC50aGVuKGZ1bmN0aW9uKGQpewogICAgICAkKCdlbmgtdGV4dCcpLnZhbHVlPShkLm9rJiZkLnRleHQpP2QudGV4dDpmYWxsYmFja0VuaGFuY2UocCk7CiAgICAgIGlmKCFkLm9rKSB0b2FzdCgnUmVmaW5lIG9mZmxpbmUg4oCUIHBha2FpIHRlbXBsYXRlIGxva2FsJyk7CiAgICB9KQogICAgLmNhdGNoKGZ1bmN0aW9uKCl7ICQoJ2VuaC10ZXh0JykudmFsdWU9ZmFsbGJhY2tFbmhhbmNlKHApOyB0b2FzdCgnUmVmaW5lIG9mZmxpbmUg4oCUIHBha2FpIHRlbXBsYXRlIGxva2FsJyk7IH0pCiAgICAuZmluYWxseShmdW5jdGlvbigpeyBiLmRpc2FibGVkPWZhbHNlOyBiLnN0eWxlLm9wYWNpdHk9Jyc7IH0pOwp9CiQoJ2J0bi1lbmhhbmNlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGRvRW5oYW5jZSk7CiQoJ2VuaC1jbG9zZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxjbG9zZUVuaE1vZGFsKTsKJCgnZW5oLWNhbmNlbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxjbG9zZUVuaE1vZGFsKTsKJCgnZW5oLW1vZGFsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKGUpeyBpZihlLnRhcmdldD09PSQoJ2VuaC1tb2RhbCcpKSBjbG9zZUVuaE1vZGFsKCk7IH0pOwokKCdlbmgtcmVnZW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAkKCdwcm9tcHQnKS52YWx1ZT0oJCgnZW5oLXRleHQnKS52YWx1ZXx8JycpLnRyaW0oKXx8X2VuaE9yaWc7CiAgcmVuZGVyVHJpZ2dlcnMoKTsKICBkb0VuaGFuY2UoKTsKfSk7CiQoJ2VuaC11c2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICB2YXIgdj0oJCgnZW5oLXRleHQnKS52YWx1ZXx8JycpLnRyaW0oKTsKICBpZighdikgcmV0dXJuOwogICQoJ3Byb21wdCcpLnZhbHVlPXY7IHJlbmRlclRyaWdnZXJzKCk7IGNsb3NlRW5oTW9kYWwoKTsgdG9hc3QoJ1Byb21wdCBFbmhhbmNlIGRpdGVyYXBrYW4g4pyTJyk7Cn0pOwpkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY2hpcCcpLmZvckVhY2goZnVuY3Rpb24oYyl7CiAgYy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXtjLmNsYXNzTGlzdC50b2dnbGUoJ29uJyl9KTsKfSk7CgovKiA9PT09PSB0YWJzID09PT09ICovCmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50YWInKS5mb3JFYWNoKGZ1bmN0aW9uKHQpewogIHQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudGFiJykuZm9yRWFjaChmdW5jdGlvbih4KXt4LmNsYXNzTGlzdC5yZW1vdmUoJ3NlbCcpfSk7CiAgICB0LmNsYXNzTGlzdC5hZGQoJ3NlbCcpOyBzdGF0ZS5wYWdlPXQuZGF0YXNldC50YWI7CiAgICByZW5kZXJDYW52YXMoKTsKICB9KTsKfSk7CmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5ydGFiJykuZm9yRWFjaChmdW5jdGlvbih0KXsKICB0LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnJ0YWInKS5mb3JFYWNoKGZ1bmN0aW9uKHgpe3guY2xhc3NMaXN0LnJlbW92ZSgnc2VsJyl9KTsKICAgIHQuY2xhc3NMaXN0LmFkZCgnc2VsJyk7CiAgfSk7Cn0pOwoKLyogPT09PT0gbW9iaWxlIGRyYXdlciA9PT09PSAqLwokKCdtbWVudScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBvcGVuTGVmdCgpOyB9KTsKJCgnb3ZlcmxheScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBjbG9zZUxlZnQoKTsgfSk7CmZ1bmN0aW9uIG9wZW5MZWZ0KCl7ICQoJ292ZXJsYXknKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgJCgnbGVmdHBhbicpLmNsYXNzTGlzdC5yZW1vdmUoJy10cmFuc2xhdGUteC1mdWxsJyk7IH0KZnVuY3Rpb24gY2xvc2VMZWZ0KCl7ICQoJ292ZXJsYXknKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgaWYod2luZG93LmlubmVyV2lkdGg8MTAyNCkgJCgnbGVmdHBhbicpLmNsYXNzTGlzdC5hZGQoJy10cmFuc2xhdGUteC1mdWxsJyk7IH0KCi8qID09PT09IGltYWdlIGNvdW50IChkcm9wZG93biBkaSBwcm9tcHQgYmFyICsgdG9tYm9sIG5hdmJhcikgPT09PT0gKi8KZnVuY3Rpb24gYXBwbHlOY29sKCl7CiAgdmFyIHNlbD0kKCduY291bnQnKTsgaWYoc2VsKSBzZWwudmFsdWU9U3RyaW5nKHN0YXRlLm5jb2wpOwogIC8vIFRhbXBpbGFuIHRlbmdhaCBzZWxhbHUgMSBnYW1iYXIgc2VzdWFpIGFzcGVjdCByYXRpbyAoc2VwZXJ0aSBUZW5zb3IuQXJ0KS4KICAvLyBuY29sIGhhbnlhIG1lbmVudHVrYW4ganVtbGFoIGdhbWJhciBwZXIgZ2VuZXJhdGUgKGltYWdlQ291bnQpLgogICQoJ25jb2xsYmwnKS50ZXh0Q29udGVudD1TdHJpbmcoc3RhdGUubmNvbCk7CiAgcmVuZGVyR3JpZCgpOwp9CiQoJ25jb2wnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICBzdGF0ZS5uY29sID0gc3RhdGUubmNvbD09PTI/MToyOwogIGFwcGx5TmNvbCgpOwp9KTsKJCgnbmNvdW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbigpewogIHN0YXRlLm5jb2w9cGFyc2VJbnQoJCgnbmNvdW50JykudmFsdWUpfHwxOwogIGFwcGx5TmNvbCgpOwp9KTsKCi8qID09PT09IGdlbmVyYXRlIChyZWFsIEFQSSAvIGRlbW8gZmFsbGJhY2spID09PT09ICovCiQoJ2J0bi1nbycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxkb0dlbmVyYXRlKTsKZnVuY3Rpb24gc2V0QnVzeShiKXsKICB2YXIgZWw9JCgnYnRuLWdvJyk7IGlmKCFlbCkgcmV0dXJuOwogIGVsLmRpc2FibGVkPWI7IGVsLnN0eWxlLm9wYWNpdHk9Yj8nMC41JzonMSc7CiAgZWwuaW5uZXJIVE1MPWI/JzxpIGRhdGEtaWNvbj0iY2lyY2xlLW5vdGNoIiBjbGFzcz0idy00IGgtNCBhbmltYXRlLXNwaW4iPjwvaT5HZW5lcmF0aW5nLi4uJwogICAgOic8aSBkYXRhLWljb249InBsYXkiIGNsYXNzPSJ3LTQgaC00Ij48L2k+R2VuZXJhdGUgPHNwYW4gY2xhc3M9InRleHQteHMgb3BhY2l0eS05MCBmb250LW5vcm1hbCIgaWQ9InByaWNlIj4rJDAuMzM8L3NwYW4+JzsKfQpmdW5jdGlvbiBleHRyYWN0SW1hZ2VzKGRhdGEpewogIGlmKCFkYXRhKSByZXR1cm4gW107CiAgaWYoQXJyYXkuaXNBcnJheShkYXRhKSkgZGF0YT17aW1hZ2VzOmRhdGF9OwogIHZhciBpbWdzPWRhdGEuaW1hZ2VzfHxkYXRhLmRhdGEmJmRhdGEuZGF0YS5pbWFnZXN8fGRhdGEucmVzdWx0JiZkYXRhLnJlc3VsdC5pbWFnZXN8fGRhdGEudXJsc3x8W107CiAgcmV0dXJuIGltZ3MubWFwKGZ1bmN0aW9uKGkpeyByZXR1cm4gdHlwZW9mIGk9PT0nc3RyaW5nJz9pOihpLnVybHx8aS5zcmN8fGkuaW1hZ2V8fGkucGF0aCk7IH0pLmZpbHRlcihCb29sZWFuKTsKfQovKiA9PT09PSBoYXNpbCArIHJpd2F5YXQgKHBlcnNpc3QgbG9jYWxTdG9yYWdlKSA9PT09PSAqLwpmdW5jdGlvbiBwZXJzaXN0UmVzdWx0cygpewogIHRyeXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oUkVTVUxUU19LRVksSlNPTi5zdHJpbmdpZnkoc3RhdGUucmVzdWx0cy5zbGljZSgwLDYwKSkpOyB9Y2F0Y2goZSl7fQp9Ci8qIFRhbXBpbGFuIHRlbmdhaDogMSBnYW1iYXIgc2VzdWFpIGFzcGVjdCByYXRpbyAoc2VwZXJ0aSBUZW5zb3IuQXJ0KSwKICAgb2JqZWN0LWNvbnRhaW4gKyBjZW50ZXJlZCArIG5hdiBwcmV2L25leHQgbGV3YXQgcml3YXlhdC4gKi8KdmFyIF92aWV3SWR4PTA7IC8vIGluZGV4IGtlIHN0YXRlLnJlc3VsdHMgKDAgPSB0ZXJiYXJ1KQpmdW5jdGlvbiByZW5kZXJHcmlkKCl7CiAgdmFyIGdyaWQ9JCgnZ3JpZCcpOyBncmlkLmlubmVySFRNTD0nJzsKICBpZighc3RhdGUucmVzdWx0cy5sZW5ndGgpeyAkKCdlbXB0eScpLnN0eWxlLmRpc3BsYXk9Jyc7IHJldHVybjsgfQogICQoJ2VtcHR5Jykuc3R5bGUuZGlzcGxheT0nbm9uZSc7CiAgaWYoX3ZpZXdJZHg+PXN0YXRlLnJlc3VsdHMubGVuZ3RoKSBfdmlld0lkeD1zdGF0ZS5yZXN1bHRzLmxlbmd0aC0xOwogIHZhciByPXN0YXRlLnJlc3VsdHNbX3ZpZXdJZHhdOwogIHZhciB3cmFwPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogIHdyYXAuY2xhc3NOYW1lPSdyZWxhdGl2ZSBmbGV4IGZsZXgtY29sIGl0ZW1zLWNlbnRlciB3LWZ1bGwnOwogIHZhciBpbWc9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnaW1nJyk7CiAgaW1nLnNyYz1yLnNyYzsKICBpbWcuY2xhc3NOYW1lPSdtYXgtdy1mdWxsIG1heC1oLVtjYWxjKDEwMHZoLTI1MHB4KV0gdy1hdXRvIG9iamVjdC1jb250YWluIHJvdW5kZWQteGwgYm9yZGVyIGJkIGJnLWJsYWNrLzQwIGN1cnNvci16b29tLWluJzsKICBpbWcuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IG9wZW5MaWdodGJveChyKTsgfSk7CiAgd3JhcC5hcHBlbmRDaGlsZChpbWcpOwogIGlmKHIuZGVtbyl7CiAgICB2YXIgYmQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpOwogICAgYmQuY2xhc3NOYW1lPSdhYnNvbHV0ZSB0b3AtMiBsZWZ0LTIgdGV4dC1bOXB4XSBiZy1ibGFjay82MCBweC0xLjUgcHktMC41IHJvdW5kZWQgdGV4dC1uZXV0cmFsLTMwMCc7CiAgICBiZC50ZXh0Q29udGVudD0nREVNTyc7IHdyYXAuYXBwZW5kQ2hpbGQoYmQpOwogIH0KICBpZihzdGF0ZS5yZXN1bHRzLmxlbmd0aD4xKXsKICAgIHZhciBuYXY9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBuYXYuY2xhc3NOYW1lPSdmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMyB0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAgbXQtMic7CiAgICB2YXIgcHJ2PWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOwogICAgcHJ2LmNsYXNzTmFtZT0ndy03IGgtNyByb3VuZGVkLWxnIGJvcmRlciBiZCBob3Zlcjp0ZXh0LXdoaXRlIGhvdmVyOmJvcmRlci1bIzZGNURGRl0gZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXInOyBwcnYuaW5uZXJIVE1MPSfigLknOwogICAgcHJ2LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBfdmlld0lkeD0oX3ZpZXdJZHgrMSklc3RhdGUucmVzdWx0cy5sZW5ndGg7IHJlbmRlckdyaWQoKTsgfSk7CiAgICB2YXIgbnh0PWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOwogICAgbnh0LmNsYXNzTmFtZT0ndy03IGgtNyByb3VuZGVkLWxnIGJvcmRlciBiZCBob3Zlcjp0ZXh0LXdoaXRlIGhvdmVyOmJvcmRlci1bIzZGNURGRl0gZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXInOyBueHQuaW5uZXJIVE1MPSfigLonOwogICAgbnh0LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBfdmlld0lkeD0oX3ZpZXdJZHgtMStzdGF0ZS5yZXN1bHRzLmxlbmd0aCklc3RhdGUucmVzdWx0cy5sZW5ndGg7IHJlbmRlckdyaWQoKTsgfSk7CiAgICB2YXIgY250PWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ3NwYW4nKTsgY250LnRleHRDb250ZW50PShfdmlld0lkeCsxKSsnIC8gJytzdGF0ZS5yZXN1bHRzLmxlbmd0aDsKICAgIG5hdi5hcHBlbmRDaGlsZChwcnYpOyBuYXYuYXBwZW5kQ2hpbGQoY250KTsgbmF2LmFwcGVuZENoaWxkKG54dCk7CiAgICB3cmFwLmFwcGVuZENoaWxkKG5hdik7CiAgfQogIGdyaWQuYXBwZW5kQ2hpbGQod3JhcCk7Cn0KZnVuY3Rpb24gYWRkUmVzdWx0KHIpewogIHN0YXRlLnJlc3VsdHMudW5zaGlmdChyKTsKICBpZihzdGF0ZS5yZXN1bHRzLmxlbmd0aD42MCkgc3RhdGUucmVzdWx0cy5sZW5ndGg9NjA7CiAgX3ZpZXdJZHg9MDsgLy8gdGFtcGlsa2FuIGhhc2lsIHRlcmJhcnUKICBwZXJzaXN0UmVzdWx0cygpOwogIHJlbmRlckdyaWQoKTsKICByZW5kZXJSaWdodCgpOwp9CgovKiA9PT09PSByaWdodCBoaXN0b3J5ID09PT09ICovCmZ1bmN0aW9uIGZtdERhdGUodHMpeyB0cnl7IHJldHVybiBuZXcgRGF0ZSh0cykudG9Mb2NhbGVEYXRlU3RyaW5nKCdpZC1JRCcpOyB9Y2F0Y2goZSl7IHJldHVybiAnJzsgfSB9CmZ1bmN0aW9uIHJlbmRlclJpZ2h0KCl7CiAgdmFyIGxpc3Q9JCgncmxpc3QnKTsgbGlzdC5pbm5lckhUTUw9Jyc7CiAgaWYoIXN0YXRlLnJlc3VsdHMubGVuZ3RoKXsgbGlzdC5pbm5lckhUTUw9JzxwIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgcC00IHRleHQtY2VudGVyIj5CZWx1bSBhZGEgaGFzaWwuPC9wPic7ICQoJ3Jjb3VudCcpLnRleHRDb250ZW50PScwIGhhc2lsJzsgcmV0dXJuOyB9CiAgJCgncmNvdW50JykudGV4dENvbnRlbnQ9c3RhdGUucmVzdWx0cy5sZW5ndGgrJyBoYXNpbCc7CiAgc3RhdGUucmVzdWx0cy5mb3JFYWNoKGZ1bmN0aW9uKHIsaSl7CiAgICB2YXIgZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsgZC5jbGFzc05hbWU9J3JjYXJkJzsKICAgIHZhciBsYmw9ci5kZW1vPydEZW1vIChzaW11bGFzaSknOihyLnBhZ2U9PT0naW1nJz8nSW1hZ2UgdG8gSW1hZ2UnOidUZXh0IHRvIEltYWdlJyk7CiAgICBkLmlubmVySFRNTD0nPGRpdiBjbGFzcz0icmVsYXRpdmUiPicKICAgICAgKyc8aW1nIHNyYz0iJytyLnNyYysnIiBjbGFzcz0idy1mdWxsIGFzcGVjdC1bNC8zXSBvYmplY3QtY292ZXIgY3Vyc29yLXBvaW50ZXIiLz4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0iYWJzb2x1dGUgdG9wLTEuNSByaWdodC0xLjUgdy02IGgtNiByb3VuZGVkLW1kIGJnLWJsYWNrLzUwIGhvdmVyOmJnLXJlZC01MDAvODAgdGV4dC13aGl0ZSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB0ZXh0LXhzIiB0aXRsZT0iSGFwdXMiPuKclTwvYnV0dG9uPicKICAgICAgKyc8L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0icC0yLjUgc3BhY2UteS0xLjUgdGV4dC14cyI+JwogICAgICArJzxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUiPjxpIGRhdGEtaWNvbj0ic3BhcmtsZSIgY2xhc3M9InctMyBoLTMgdGV4dC12aW9sZXQtNDAwIj48L2k+PHNwYW4gY2xhc3M9ImJnLXZpb2xldC01MDAvMTAgdGV4dC12aW9sZXQtMzAwIHB4LTEuNSBweS1weCByb3VuZGVkIHRleHQtWzEwcHhdIj4nK2xibCsnPC9zcGFuPjwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJiZy1ibGFjay80MCByb3VuZGVkIHAtMS41IHRleHQtWzExcHhdIHRleHQtbmV1dHJhbC0zMDAgbGVhZGluZy1zbnVnIGN1cnNvci1wb2ludGVyIGhvdmVyOnRleHQtd2hpdGUiIHRpdGxlPSJMaWhhdCBkZXRhaWwiPicrKHIucHJvbXB0fHwnJykuc2xpY2UoMCw5MCkrJzwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSB0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNTAwIj48aSBkYXRhLWljb249ImxheWVycyIgY2xhc3M9InctMyBoLTMiPjwvaT4nK0xPUkEuZmlsdGVyKGZ1bmN0aW9uKGwpe3JldHVybiBsLnc+MH0pLmxlbmd0aCsnIExvUkE8L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0ic3BhY2UteS0xIHRleHQtWzEwcHhdIHRleHQtbmV1dHJhbC01MDAiPicKICAgICAgKyhyLnRhc2tJZD8nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlRhc2sgSUQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAgdHJ1bmNhdGUgbWF4LXctWzYwJV0iIHRpdGxlPSInK3IudGFza0lkKyciPicrci50YXNrSWQrJzwvc3Bhbj48L2Rpdj4nOicnKQogICAgICArKHIuY3JlZGl0cz8nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNyZWRpdHM8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrci5jcmVkaXRzKyc8L3NwYW4+PC9kaXY+JzonJykKICAgICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q3JlYXRlZDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+JytmbXREYXRlKHIudHMpKyc8L3NwYW4+PC9kaXY+JwogICAgICArKHIubmVnPyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+TmVnYXRpdmU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAgdHJ1bmNhdGUgbWF4LXctWzYwJV0iIHRpdGxlPSInK3IubmVnKyciPicrci5uZWcrJzwvc3Bhbj48L2Rpdj4nOicnKQogICAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TaXplPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK3Iuc2l6ZSsnPC9zcGFuPjwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2VlZDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+JytyLnNlZWQrJzwvc3Bhbj48L2Rpdj4nCiAgICAgICsnPC9kaXY+PC9kaXY+JzsKICAgIGQucXVlcnlTZWxlY3RvcignaW1nJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IF92aWV3SWR4PWk7IHJlbmRlckdyaWQoKTsgb3BlbkxpZ2h0Ym94KHIpOyB9KTsKICAgIGQucXVlcnlTZWxlY3RvcignLmJnLWJsYWNrXFwvNDAnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgX3ZpZXdJZHg9aTsgcmVuZGVyR3JpZCgpOyBvcGVuTGlnaHRib3gocik7IH0pOwogICAgZC5xdWVyeVNlbGVjdG9yKCdidXR0b24nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgICAgc3RhdGUucmVzdWx0cy5zcGxpY2UoaSwxKTsgcGVyc2lzdFJlc3VsdHMoKTsgcmVuZGVyR3JpZCgpOyByZW5kZXJSaWdodCgpOwogICAgfSk7CiAgICBsaXN0LmFwcGVuZENoaWxkKGQpOwogIH0pOwp9CgovKiA9PT09PSBsaWdodGJveCA9PT09PSAqLwpmdW5jdGlvbiBvcGVuTGlnaHRib3gocil7CiAgJCgnbGItaW1nJykuc3JjPXIuc3JjOwogIHZhciBoPScnOwogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+TW9kZWw8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrKHIubW9kZWx8fCctJykrJzwvc3Bhbj48L2Rpdj4nOwogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+UHJvbXB0PC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nKyhyLnByb21wdHx8Jy0nKSsnPC9zcGFuPjwvZGl2Pic7CiAgaWYoci5uZWcpIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+TmVnYXRpdmU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrci5uZWcrJzwvc3Bhbj48L2Rpdj4nOwogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2l6ZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+Jysoci5zaXplfHwnLScpKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNlZWQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrKHIuc2VlZHx8Jy0nKSsnPC9zcGFuPjwvZGl2Pic7CiAgaWYoci50YXNrSWQpIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+VGFzayBJRDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+JytyLnRhc2tJZCsnPC9zcGFuPjwvZGl2Pic7CiAgaWYoci5jcmVkaXRzKSBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNyZWRpdHM8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrci5jcmVkaXRzKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0ibXQtMiI+PGEgaHJlZj0iJytyLnNyYysnIiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciIgY2xhc3M9InRleHQtWyM2RjVERkZdIGhvdmVyOnVuZGVybGluZSB0ZXh0LXhzIj5CdWthIGdhbWJhciBhc2xpICZuZWFycjs8L2E+PC9kaXY+JzsKICAkKCdsYi1tZXRhJykuaW5uZXJIVE1MPWg7CiAgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QuYWRkKCdmbGV4Jyk7Cn0KJCgnbGItY2xvc2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QucmVtb3ZlKCdmbGV4Jyk7IH0pOwokKCdsaWdodGJveCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgaWYoZS50YXJnZXQ9PT0kKCdsaWdodGJveCcpKXsgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QucmVtb3ZlKCdmbGV4Jyk7IH0gfSk7CgovKiA9PT09PSBwYXlsb2FkIChzdHJ1a3R1ciBueWF0YSBUZW5zb3IuQXJ0KSA9PT09PSAqLwpmdW5jdGlvbiBidWlsZFBheWxvYWQoKXsKICB2YXIgbmVnPSQoJ25lZ2NoZWNrJykuY2hlY2tlZD8kKCduZWdwcm9tcHQnKS52YWx1ZTonJzsKICB2YXIgbT1zdGF0ZS5tb2RlbDsKICByZXR1cm4gewogICAgcGFyYW1zOnsKICAgICAgYmFzZU1vZGVsOnsgbW9kZWxJZDptLm1vZGVsSWQsIG1vZGVsRmlsZUlkOm0ubW9kZWxGaWxlSWQgfSwKICAgICAgbW9kZWw6c2V0dGluZ3MucHJvdmlkZXI9PT0ndGFtcyc/Jyc6KG0mJm0ubW9kZWw/bS5tb2RlbDonJyksCiAgICAgIHNkeGw6eyByZWZpbmVyOmZhbHNlIH0sCiAgICAgIG1vZGVsczpMT1JBLmZpbHRlcihmdW5jdGlvbihsKXtyZXR1cm4gbC53PjB9KS5tYXAoZnVuY3Rpb24obCl7cmV0dXJuIHsgbmFtZTpsLm5hbWUsIHdlaWdodDpsLncsIHRyaWdnZXJXb3JkczpsLnRhZ3MsIGxvcmFNb2RlbDpsLmxvcmFNb2RlbHx8JycsIGxvcmFVcmw6bC5sb3JhVXJsfHwnJyB9IH0pLAogICAgICBlbWJlZGRpbmdNb2RlbHM6W10sCiAgICAgIHNkVmFlOiQoJ3ZhZScpLnZhbHVlPT09J2F1dG9tYXRpYyc/J0F1dG9tYXRpYyc6JCgndmFlJykudmFsdWUsCiAgICAgIHByb21wdDokKCdwcm9tcHQnKS52YWx1ZSwKICAgICAgbmVnYXRpdmVQcm9tcHQ6bmVnLAogICAgICBoZWlnaHQ6cGFyc2VJbnQoJCgnaGVpZ2h0JykudmFsdWUpLAogICAgICB3aWR0aDpwYXJzZUludCgkKCd3aWR0aCcpLnZhbHVlKSwKICAgICAgaW1hZ2VDb3VudDpzdGF0ZS5uY29sLAogICAgICBzdGVwczpwYXJzZUludCgkKCdzdGVwcycpLnZhbHVlKSwKICAgICAgaW1hZ2VzOmkyaURhdGFVcmw/W2kyaURhdGFVcmxdOltdLAogICAgICBkZW5vaXNpbmdTdHJlbmd0aDpwYXJzZUZsb2F0KCQoJ2kyaS1kcycpLnZhbHVlKXx8MC41LAogICAgICBjZmdTY2FsZTpwYXJzZUZsb2F0KCQoJ2NmZycpLnZhbHVlKSwKICAgICAgc2VlZDooJCgnc2VlZCcpLnZhbHVlfHwnJykudHJpbSgpfHxTdHJpbmcoTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKjk5OTk5OTk5OTkpKSwKICAgICAgY2xpcFNraXA6cGFyc2VJbnQoJCgnY2xpcHNraXAnKS52YWx1ZSksCiAgICAgIGV0YU5vaXNlU2VlZERlbHRhOnBhcnNlSW50KCQoJ2V0YW5zZCcpLnZhbHVlKSwKICAgICAgdjFDbGlwOmZhbHNlLAogICAgICBlbmFibGVQaXgycGl4OnN0YXRlLnBhZ2U9PT0naW1nJyYmISFpMmlEYXRhVXJsLAogICAgICBndWlkYW5jZTozLjUsCiAgICAgIHVzZUZpcnN0TGFzdEZyYW1lOmZhbHNlLAogICAgICBrc2FtcGxlck5hbWU6JCgnc2FtcGxlcicpLnZhbHVlLAogICAgICBzY2hlZHVsZTokKCdzY2hlZCcpLnZhbHVlCiAgICB9LAogICAgcHJvdmlkZXI6c2V0dGluZ3MucHJvdmlkZXJ8fCd0YW1zJywKICAgIGNyZWRpdHM6MS4yMiwKICAgIHRhc2tUeXBlOnN0YXRlLnBhZ2U9PT0naW1nJyYmaTJpRGF0YVVybD8nSU1HMklNRyc6J1RYVDJJTUcnLAogICAgaXNSZW1peDpmYWxzZSwKICAgIGNhcHRjaGFUeXBlOidDTE9VREZMQVJFX1RVUk5TVElMRScKICB9Owp9Ci8qID09PT09PT09PT09PSBSRUtUWSBHRU5FUkFUT1Ig4oCUIHZlcnNpIHdlYiBmdWxsID09PT09PT09PT09PQogKiBHZW5lcmF0ZSBhc2xpIHZpYSBiYWNrZW5kICgvYXBpIC0+IFRlbnNvci5BcnQgTW9kZWwgU2VydmljZSkKICogYXRhdSBtb2RlIGRlbW8gKHBpY3N1bSkga2FsYXUgYmFja2VuZC9BUEkga2V5IGJlbHVtIGFrdGlmLgogKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCnZhciBTRVRUSU5HU19LRVk9J3Jla3R5LnNldHRpbmdzJywgUkVTVUxUU19LRVk9J3Jla3R5LnJlc3VsdHMnOwp2YXIgc2V0dGluZ3M9eyBtb2RlOidhdXRvJywgcHJvdmlkZXI6J3RhbXMnLCBhcGlLZXk6JycsIHBvbGxTZXNzaW9uOicnIH07CnZhciBQUk9WSURFUl9JTkZPPXsKICB0YW1zOnsgbGFiZWw6J0FQSSBLZXkgVEFNUyAodGFtcy50ZW5zb3IuYXJ0KScsIGhpbnQ6J0dyYXRpcyBkaSB0YW1zLnRlbnNvci5hcnQg4oCUIHBha2FpIGRhZnRhciBNb2RlbCBkaSBVSS4nIH0sCiAgcmVwbGljYXRlOnsgbGFiZWw6J0FQSSBUb2tlbiBSZXBsaWNhdGUgKHJlcGxpY2F0ZS5jb20pJywgaGludDonUGlsaWggbW9kZWwgZGkga2FydHUgTW9kZWwgKEZMVVgsIFNEWEwsIGRzdCkuIEltZzJJbWcgYmVsdW0gZGlkdWt1bmcuJyB9LAogIGZhbDp7IGxhYmVsOidBUEkgS2V5IGZhbC5haSAoZmFsLmFpKScsIGhpbnQ6J1BpbGloIG1vZGVsIGRpIGthcnR1IE1vZGVsIChGTFVYLCBTRFhMLCBkc3QpLiBJbWcySW1nIGJlbHVtIGRpZHVrdW5nLicgfSwKICBwb2xsaW5hdGlvbnM6eyBsYWJlbDonQVBJIEtleSBQb2xsaW5hdGlvbnMgKG9wc2lvbmFsIOKAlCBza18qKScsIGhpbnQ6J0dyYXRpcyB0YW5wYSBrZXkgKG1vZGVsIG90b21hdGlzKS4gSXNpIGtleSBza18qIGRhcmkgZW50ZXIucG9sbGluYXRpb25zLmFpL2tleXMgdW50dWsgZGFmdGFyIG1vZGVsIGxlbmdrYXAuIEhhc2lsIG90b21hdGlzIGRpYXJzaXAgcGVybWFuZW4uJyB9Cn07CgpmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKXsKICB0cnl7CiAgICB2YXIgcz1KU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNFVFRJTkdTX0tFWSl8fCd7fScpOwogICAgaWYocyYmdHlwZW9mIHM9PT0nb2JqZWN0Jyl7CiAgICAgIHNldHRpbmdzLm1vZGU9cy5tb2RlfHwnYXV0byc7IHNldHRpbmdzLnByb3ZpZGVyPXMucHJvdmlkZXJ8fCd0YW1zJzsgc2V0dGluZ3MuYXBpS2V5PXMuYXBpS2V5fHwnJzsKICAgICAgc2V0dGluZ3MucG9sbFNlc3Npb249cy5wb2xsU2Vzc2lvbnx8Jyc7CiAgICB9CiAgfWNhdGNoKGUpe30KfQpmdW5jdGlvbiBzYXZlU2V0dGluZ3MoKXsgdHJ5eyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTRVRUSU5HU19LRVksSlNPTi5zdHJpbmdpZnkoc2V0dGluZ3MpKTsgfWNhdGNoKGUpe30gfQpmdW5jdGlvbiBhcHBseVNldHRpbmdzVUkoKXsKICAkKCdhcGltb2RlJykudmFsdWU9c2V0dGluZ3MubW9kZTsgJCgnYXBpa2V5JykudmFsdWU9c2V0dGluZ3MuYXBpS2V5OwogIHVwZGF0ZVByb3ZpZGVyVUkoKTsKfQpmdW5jdGlvbiB1cGRhdGVQcm92aWRlclVJKCl7CiAgdmFyIGluZm89UFJPVklERVJfSU5GT1tzZXR0aW5ncy5wcm92aWRlcl18fFBST1ZJREVSX0lORk8udGFtczsKICAkKCdhcGlwcm92aWRlcicpLnZhbHVlPXNldHRpbmdzLnByb3ZpZGVyOwogICQoJ2FwaWtleS1sYWJlbCcpLnRleHRDb250ZW50PWluZm8ubGFiZWw7CiAgJCgnYXBpLWhpbnQnKS50ZXh0Q29udGVudD1pbmZvLmhpbnQ7CiAgdmFyIGlzUG9sbD1zZXR0aW5ncy5wcm92aWRlcj09PSdwb2xsaW5hdGlvbnMnOwogICQoJ2FwaWtleS1maWVsZCcpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicsaXNQb2xsKTsKICAkKCdieW9wLXJvdycpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicsIWlzUG9sbCk7CiAgaWYoaXNQb2xsKSByZWZyZXNoT0F1dGhTdGF0dXMoKTsKICB1cGRhdGVBcGlTdGF0dXMoKTsKICAvLyBHYW50aSBkYWZ0YXIgbW9kZWwgc2VzdWFpIHByb3ZpZGVyIGFrdGlmLgogIHZhciBsaWI9TU9ERUxfTElCU1tzZXR0aW5ncy5wcm92aWRlcl18fE1PREVMX0xJQlMudGFtczsKICBpZihNT0RFTFMhPT1saWIpewogICAgTU9ERUxTPWxpYjsKICAgIGlmKE1PREVMUy5sZW5ndGgpIHNldE1vZGVsKE1PREVMU1swXSk7CiAgfQogIC8vIEdhbnRpIGRhZnRhciBMb1JBIHNlc3VhaSBwcm92aWRlciAoTG9SQSBsYW1hIGRpYmVyc2loa2FuKS4KICBMT1JBX0xJQj1MT1JBX0xJQlNbc2V0dGluZ3MucHJvdmlkZXJdfHxMT1JBX0xJQlMudGFtczsKICBMT1JBLmxlbmd0aD0wOwogIHJlbmRlckxvcmEoKTsKICAvLyBQb2xsaW5hdGlvbnM6IGFtYmlsIGRhZnRhciBtb2RlbCBhc2xpIGRhcmkgQVBJIChmYWxsYmFjayBrZSBkYWZ0YXIgc3RhdGlzKS4KICBpZihzZXR0aW5ncy5wcm92aWRlcj09PSdwb2xsaW5hdGlvbnMnKSByZWZyZXNoUG9sbGluYXRpb25zTW9kZWxzKCk7Cn0KZnVuY3Rpb24gcmVmcmVzaFBvbGxpbmF0aW9uc01vZGVscygpewogIGZldGNoKCcvYXBpL3BvbGxpbmF0aW9ucy1tb2RlbHMnKS50aGVuKGZ1bmN0aW9uKHIpeyByZXR1cm4gci5qc29uKCk7IH0pLnRoZW4oZnVuY3Rpb24oZCl7CiAgICBpZighZHx8IUFycmF5LmlzQXJyYXkoZC5tb2RlbHMpfHwhZC5tb2RlbHMubGVuZ3RoKSByZXR1cm47CiAgICB2YXIgbGliPWQubW9kZWxzCiAgICAgIC5maWx0ZXIoZnVuY3Rpb24obSl7IHJldHVybiBtLmNhdGVnb3J5PT09J2ltYWdlJyYmbS5uYW1lJiZtLm5hbWUuaW5kZXhPZignYnlvcC8nKSE9PTA7IH0pCiAgICAgIC5zbGljZSgwLDgwKQogICAgICAubWFwKGZ1bmN0aW9uKG0peyByZXR1cm4geyBuYW1lOm0udGl0bGV8fG0ubmFtZSwgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDptLmJyYW5kfHwnJywgdGh1bWI6U3RyaW5nKG0ubmFtZSkucmVwbGFjZSgvW15hLXowLTldL2dpLCcnKSwgYmFkZ2U6bS5wYWlkX29ubHk/J1BBSUQnOidGUkVFJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDptLm5hbWUgfTsgfSkKICAgICAgLnNvcnQoZnVuY3Rpb24oYSxiKXsgcmV0dXJuIChhLmJhZGdlPT09J1BBSUQnPzE6MCktKGIuYmFkZ2U9PT0nUEFJRCc/MTowKTsgfSk7CiAgICBpZighbGliLmxlbmd0aCkgcmV0dXJuOwogICAgTU9ERUxfTElCUy5wb2xsaW5hdGlvbnM9bGliOwogICAgaWYoTU9ERUxTPT09TU9ERUxfTElCUy5wb2xsaW5hdGlvbnMpeyBzZXRNb2RlbChNT0RFTFNbMF0pOyB9CiAgfSkuY2F0Y2goZnVuY3Rpb24oKXt9KTsKfQpmdW5jdGlvbiB1cGRhdGVBcGlTdGF0dXMoKXsKICB2YXIgZWw9JCgnYXBpLXN0YXR1cycpOyBpZighZWwpIHJldHVybjsKICBpZihzZXR0aW5ncy5wcm92aWRlcj09PSdwb2xsaW5hdGlvbnMnKXsKICAgIGVsLnRleHRDb250ZW50PXNldHRpbmdzLnBvbGxTZXNzaW9uPydQb2xsaW5hdGlvbnMgwrcgQllPUCc6J1BvbGxpbmF0aW9ucyDCtyBncmF0aXMnOwogICAgZWwuc3R5bGUuY29sb3I9c2V0dGluZ3MucG9sbFNlc3Npb24/JyMyN0Q0Q0QnOicjOWE5YWEyJzsKICAgIHJldHVybjsKICB9CiAgdmFyIG5hbWU9c2V0dGluZ3MucHJvdmlkZXI9PT0ndGFtcyc/J1RBTVMnOihzZXR0aW5ncy5wcm92aWRlcj09PSdyZXBsaWNhdGUnPydSZXBsaWNhdGUnOidmYWwuYWknKTsKICBlbC50ZXh0Q29udGVudD1uYW1lKyhzZXR0aW5ncy5hcGlLZXk/JyDCtyBrZXknOicgwrcgdGFucGEga2V5Jyk7CiAgZWwuc3R5bGUuY29sb3I9c2V0dGluZ3MuYXBpS2V5PycjMjdENENEJzonIzlhOWFhMic7Cn0KJCgnYXBpcHJvdmlkZXInKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLGZ1bmN0aW9uKCl7CiAgc2V0dGluZ3MucHJvdmlkZXI9JCgnYXBpcHJvdmlkZXInKS52YWx1ZTsgc2F2ZVNldHRpbmdzKCk7IHVwZGF0ZVByb3ZpZGVyVUkoKTsKfSk7CiQoJ2FwaS1zYXZlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgc2V0dGluZ3MubW9kZT0kKCdhcGltb2RlJykudmFsdWU7IHNldHRpbmdzLmFwaUtleT0kKCdhcGlrZXknKS52YWx1ZS50cmltKCk7CiAgc2F2ZVNldHRpbmdzKCk7IHVwZGF0ZVByb3ZpZGVyVUkoKTsgdG9hc3QoJ1BlbmdhdHVyYW4gQVBJIGRpc2ltcGFuJyk7Cn0pOwokKCdhcGktdGVzdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxhc3luYyBmdW5jdGlvbigpewogIHZhciBiPSQoJ2FwaS10ZXN0Jyk7IGIuZGlzYWJsZWQ9dHJ1ZTsgYi50ZXh0Q29udGVudD0nVGVzLi4uJzsKICBpZihzZXR0aW5ncy5wcm92aWRlcj09PSdwb2xsaW5hdGlvbnMnKXsKICAgIHRyeXsKICAgICAgdmFyIHI9YXdhaXQgZmV0Y2goJy9hcGkvaGVhbHRoJyk7CiAgICAgIHZhciBkPWF3YWl0IHIuanNvbigpLmNhdGNoKGZ1bmN0aW9uKCl7cmV0dXJuIG51bGw7fSk7CiAgICAgIGlmKCFyLm9rKSB0aHJvdyBuZXcgRXJyb3IoJ0hUVFAgJytyLnN0YXR1cyk7CiAgICAgIHRvYXN0KCdCYWNrZW5kIE9LIMK3IEJZT1AgJysoZCYmZC5ieW9wPydzaWFwIChBcHAgS2V5IHRlcnBhc2FuZyknOidiZWx1bSBkaWtvbmZpZ3VyYXNpIChBcHAgS2V5KScpKycgwrcgJysoc2V0dGluZ3MucG9sbFNlc3Npb24/J3Nlc2kgYWt0aWYnOidiZWx1bSBsb2dpbicpKTsKICAgICAgcmVmcmVzaE9BdXRoU3RhdHVzKCk7CiAgICB9Y2F0Y2goZSl7IHRvYXN0KCdCYWNrZW5kIHRpZGFrIGFrdGlmIOKAlCBkZXBsb3kgZGVuZ2FuIEZ1bmN0aW9ucyBhdGF1IHBha2FpIG1vZGUgZGVtbycpOyB9CiAgICBiLmRpc2FibGVkPWZhbHNlOyBiLnRleHRDb250ZW50PSdUZXMnOwogICAgcmV0dXJuOwogIH0KICB0cnl7CiAgICB2YXIgcj1hd2FpdCBmZXRjaCgnL2FwaS9oZWFsdGgnLHtoZWFkZXJzOnsneC1hcGkta2V5JzokKCdhcGlrZXknKS52YWx1ZS50cmltKCl8fHNldHRpbmdzLmFwaUtleX19KTsKICAgIHZhciBkPWF3YWl0IHIuanNvbigpLmNhdGNoKGZ1bmN0aW9uKCl7cmV0dXJuIG51bGx9KTsKICAgIGlmKCFyLm9rKSB0aHJvdyBuZXcgRXJyb3IoJ0hUVFAgJytyLnN0YXR1cyk7CiAgICB2YXIgcGFydHM9W107CiAgICBpZihkJiZkLmhhc0tleXMpeyBbJ3RhbXMnLCdyZXBsaWNhdGUnLCdmYWwnXS5mb3JFYWNoKGZ1bmN0aW9uKHApeyBpZihkLmhhc0tleXNbcF0pIHBhcnRzLnB1c2gocCk7IH0pOyB9CiAgICB0b2FzdCgnQmFja2VuZCBPSy4gS2V5IGRpIGVudjogJysocGFydHMubGVuZ3RoP3BhcnRzLmpvaW4oJywgJyk6J3RpZGFrIGFkYScpKycuIEtleSBkaSBicm93c2VyOiAnKyhzZXR0aW5ncy5hcGlLZXk/J2FkYSc6J3RpZGFrJykpOwogIH1jYXRjaChlKXsgdG9hc3QoJ0JhY2tlbmQgdGlkYWsgYWt0aWYg4oCUIGRlcGxveSBkZW5nYW4gRnVuY3Rpb25zIGF0YXUgcGFrYWkgbW9kZSBkZW1vJyk7IH0KICBiLmRpc2FibGVkPWZhbHNlOyBiLnRleHRDb250ZW50PSdUZXMnOwp9KTsKCi8qIC0tLSBCWU9QIE9BdXRoIChCcmluZyBZb3VyIE93biBQb2xsZW4pIC0tLQogKiBMb2dpbiB2aWEgZW50ZXIucG9sbGluYXRpb25zLmFpIChQS0NFIGNvZGUgZmxvdykg4oaSIGJhY2tlbmQgdHVrYXIga29kZSDihpIKICogdG9rZW4gc2tfIHNjb3BlZCB1c2VyIGRpc2ltcGFuIGRpIEtWIGJhY2tlbmQ7IGJyb3dzZXIgY3VtYSBwZWdhbmcgc2Vzc2lvbi4KICovCnZhciBfb2F1dGhWZXJpZmllcktleT0ncmVrdHkub2F1dGgudmVyaWZpZXInLCBfb2F1dGhTdGF0ZUtleT0ncmVrdHkub2F1dGguc3RhdGUnOwpmdW5jdGlvbiBfYjY0dXJsKGJ1Zil7CiAgdmFyIHM9YnRvYShTdHJpbmcuZnJvbUNoYXJDb2RlLmFwcGx5KG51bGwsbmV3IFVpbnQ4QXJyYXkoYnVmKSkpOwogIHJldHVybiBzLnJlcGxhY2UoL1wrL2csJy0nKS5yZXBsYWNlKC9cLy9nLCdfJykucmVwbGFjZSgvPSskLywnJyk7Cn0KZnVuY3Rpb24gX3JhbmRCNjQobGVuKXsgdmFyIGE9bmV3IFVpbnQ4QXJyYXkobGVuKTsgY3J5cHRvLmdldFJhbmRvbVZhbHVlcyhhKTsgcmV0dXJuIF9iNjR1cmwoYSk7IH0KYXN5bmMgZnVuY3Rpb24gX3NoYTI1NkI2NHVybCh0ZXh0KXsKICB2YXIgYnVmPWF3YWl0IGNyeXB0by5zdWJ0bGUuZGlnZXN0KCdTSEEtMjU2JyxuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUodGV4dCkpOwogIHJldHVybiBfYjY0dXJsKGJ1Zik7Cn0KZnVuY3Rpb24gc3RhcnRQb2xsT0F1dGgoKXsKICB2YXIgdmVyaWZpZXI9X3JhbmRCNjQoNDgpOwogIGxvY2FsU3RvcmFnZS5zZXRJdGVtKF9vYXV0aFZlcmlmaWVyS2V5LHZlcmlmaWVyKTsKICB2YXIgc3RhdGU9X3JhbmRCNjQoMTYpOwogIGxvY2FsU3RvcmFnZS5zZXRJdGVtKF9vYXV0aFN0YXRlS2V5LHN0YXRlKTsKICBmZXRjaCgnL2FwaS9vYXV0aC9jb25maWcnKS50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiByLmpzb24oKTt9KS50aGVuKGFzeW5jIGZ1bmN0aW9uKGNmZyl7CiAgICBpZighY2ZnfHwhY2ZnLmNsaWVudElkKSB0aHJvdyBuZXcgRXJyb3IoJ2JhY2tlbmQgYmVsdW0gcHVueWEgQXBwIEtleSBQb2xsaW5hdGlvbnMnKTsKICAgIHZhciBjaGFsbGVuZ2U9YXdhaXQgX3NoYTI1NkI2NHVybCh2ZXJpZmllcik7CiAgICB2YXIgcD1uZXcgVVJMU2VhcmNoUGFyYW1zKHsKICAgICAgcmVzcG9uc2VfdHlwZTonY29kZScsIGNsaWVudF9pZDpjZmcuY2xpZW50SWQsIHJlZGlyZWN0X3VyaTpjZmcucmVkaXJlY3RVcmksCiAgICAgIHNjb3BlOid1c2FnZScsIHN0YXRlOnN0YXRlLAogICAgICBjb2RlX2NoYWxsZW5nZTpjaGFsbGVuZ2UsIGNvZGVfY2hhbGxlbmdlX21ldGhvZDonUzI1NicKICAgIH0pOwogICAgd2luZG93LmxvY2F0aW9uLmhyZWY9Y2ZnLmF1dGhvcml6ZUJhc2UrJz8nK3AudG9TdHJpbmcoKTsKICB9KS5jYXRjaChmdW5jdGlvbihlKXsgdG9hc3QoJ0dhZ2FsIG11bGFpIGxvZ2luOiAnKyhlJiZlLm1lc3NhZ2V8fGUpKTsgfSk7Cn0KZnVuY3Rpb24gcmVmcmVzaE9BdXRoU3RhdHVzKCl7CiAgdmFyIGVsPSQoJ2J5b3Atc3RhdHVzJyksIGJ0bj0kKCdieW9wLWxvZ2luJyksIG91dD0kKCdieW9wLWxvZ291dCcpOwogIGlmKCFzZXR0aW5ncy5wb2xsU2Vzc2lvbil7IGlmKGVsKWVsLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyBpZihvdXQpb3V0LmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyByZXR1cm47IH0KICBmZXRjaCgnL2FwaS9vYXV0aC9zdGF0dXM/c2Vzc2lvbj0nK2VuY29kZVVSSUNvbXBvbmVudChzZXR0aW5ncy5wb2xsU2Vzc2lvbikpLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIHIuanNvbigpO30pLnRoZW4oZnVuY3Rpb24oZCl7CiAgICBpZihkJiZkLmNvbm5lY3RlZCl7CiAgICAgIHZhciBiYWxUeHQ9Jyc7CiAgICAgIGlmKGQuYmFsYW5jZSYmdHlwZW9mIGQuYmFsYW5jZT09PSdvYmplY3QnKXsKICAgICAgICB2YXIgYnY9ZC5iYWxhbmNlLnBvbGxlbkJhbGFuY2UhPW51bGw/ZC5iYWxhbmNlLnBvbGxlbkJhbGFuY2U6KGQuYmFsYW5jZS5iYWxhbmNlIT1udWxsP2QuYmFsYW5jZS5iYWxhbmNlOm51bGwpOwogICAgICAgIGlmKGJ2IT1udWxsKSBiYWxUeHQ9JyDCtyBzYWxkbyAnK2J2KycgcG9sbGVuJzsKICAgICAgfQogICAgICBlbC50ZXh0Q29udGVudD0nVGVyaHVidW5nIOKckycrKGQuZXhwaXJlc0luPygnIMK3IHNpc2EgJytNYXRoLmNlaWwoZC5leHBpcmVzSW4vODY0MDApKycgaGFyaScpOicnKStiYWxUeHQ7CiAgICAgIGVsLnN0eWxlLmNvbG9yPScjMjdENENEJzsgZWwuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7CiAgICAgIGJ0bi50ZXh0Q29udGVudD0nTG9naW4gdWxhbmcgKGdhbnRpIGFrdW4pJzsgb3V0LmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOwogICAgfWVsc2V7CiAgICAgIGVsLnRleHRDb250ZW50PSdTZXNpIGJlcmFraGlyIOKAlCBsb2dpbiB1bGFuZyc7IGVsLnN0eWxlLmNvbG9yPScjZTVhNTBhJzsKICAgICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7IG91dC5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsKICAgICAgc2V0dGluZ3MucG9sbFNlc3Npb249Jyc7IHNhdmVTZXR0aW5ncygpOyB1cGRhdGVBcGlTdGF0dXMoKTsKICAgIH0KICB9KS5jYXRjaChmdW5jdGlvbigpe30pOwp9CmZ1bmN0aW9uIHBvbGxMb2dvdXQoKXsKICBmZXRjaCgnL2FwaS9vYXV0aC9sb2dvdXQnLHttZXRob2Q6J1BPU1QnLGhlYWRlcnM6eydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJ30sYm9keTpKU09OLnN0cmluZ2lmeSh7c2Vzc2lvbjpzZXR0aW5ncy5wb2xsU2Vzc2lvbn0pfSkuY2F0Y2goZnVuY3Rpb24oKXt9KTsKICBzZXR0aW5ncy5wb2xsU2Vzc2lvbj0nJzsgc2F2ZVNldHRpbmdzKCk7IHVwZGF0ZUFwaVN0YXR1cygpOyByZWZyZXNoT0F1dGhTdGF0dXMoKTsKICB0b2FzdCgnU2VzaSBQb2xsaW5hdGlvbnMgZGljYWJ1dCcpOwp9CmFzeW5jIGZ1bmN0aW9uIGhhbmRsZU9BdXRoQ2FsbGJhY2soKXsKICBpZihsb2NhdGlvbi5wYXRobmFtZSE9PScvY2FsbGJhY2snKSByZXR1cm47CiAgdmFyIHE9bmV3IFVSTFNlYXJjaFBhcmFtcyhsb2NhdGlvbi5zZWFyY2gpOwogIHZhciBoPW5ldyBVUkxTZWFyY2hQYXJhbXMobG9jYXRpb24uaGFzaC5zbGljZSgxKSk7CiAgdmFyIGVycj1xLmdldCgnZXJyb3InKXx8aC5nZXQoJ2Vycm9yJyk7CiAgaWYoZXJyKXsgdG9hc3QoJ0xvZ2luIGRpYmF0YWxrYW46ICcrZXJyKTsgaGlzdG9yeS5yZXBsYWNlU3RhdGUobnVsbCwnJywnLycpOyByZXR1cm47IH0KICB2YXIgY29kZT1xLmdldCgnY29kZScpOwogIHZhciBzdGF0ZT1xLmdldCgnc3RhdGUnKTsKICB2YXIgc2F2ZWRTdGF0ZT1sb2NhbFN0b3JhZ2UuZ2V0SXRlbShfb2F1dGhTdGF0ZUtleSk7CiAgdmFyIHZlcmlmaWVyPWxvY2FsU3RvcmFnZS5nZXRJdGVtKF9vYXV0aFZlcmlmaWVyS2V5KTsKICBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShfb2F1dGhTdGF0ZUtleSk7IGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKF9vYXV0aFZlcmlmaWVyS2V5KTsKICBpZighY29kZXx8IXN0YXRlfHxzdGF0ZSE9PXNhdmVkU3RhdGV8fCF2ZXJpZmllcil7CiAgICB0b2FzdCgnQ2FsbGJhY2sgT0F1dGggdGlkYWsgdmFsaWQnKTsgaGlzdG9yeS5yZXBsYWNlU3RhdGUobnVsbCwnJywnLycpOyByZXR1cm47CiAgfQogIHZhciBjZmc9YXdhaXQgZmV0Y2goJy9hcGkvb2F1dGgvY29uZmlnJykudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gci5qc29uKCk7fSkuY2F0Y2goZnVuY3Rpb24oKXtyZXR1cm4gbnVsbDt9KTsKICB0cnl7CiAgICB2YXIgcj1hd2FpdCBmZXRjaCgnL2FwaS9vYXV0aC90b2tlbicse21ldGhvZDonUE9TVCcsaGVhZGVyczp7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nfSwKICAgICAgYm9keTpKU09OLnN0cmluZ2lmeSh7Y29kZTpjb2RlLGNvZGVfdmVyaWZpZXI6dmVyaWZpZXIscmVkaXJlY3RfdXJpOihjZmcmJmNmZy5yZWRpcmVjdFVyaSl8fCcnfSl9KTsKICAgIHZhciBkPWF3YWl0IHIuanNvbigpLmNhdGNoKGZ1bmN0aW9uKCl7cmV0dXJuIG51bGw7fSk7CiAgICBpZighci5va3x8IWQuc2Vzc2lvbikgdGhyb3cgbmV3IEVycm9yKChkJiZkLmVycm9yKXx8KCdIVFRQICcrci5zdGF0dXMpKTsKICAgIHNldHRpbmdzLnBvbGxTZXNzaW9uPWQuc2Vzc2lvbjsgc2F2ZVNldHRpbmdzKCk7IHVwZGF0ZVByb3ZpZGVyVUkoKTsKICAgIHRvYXN0KCdMb2dpbiBQb2xsaW5hdGlvbnMgYmVyaGFzaWwhJyk7CiAgfWNhdGNoKGUpeyB0b2FzdCgnR2FnYWwgdHVrYXIga29kZTogJysoZSYmZS5tZXNzYWdlfHxlKSk7IH0KICBoaXN0b3J5LnJlcGxhY2VTdGF0ZShudWxsLCcnLCcvJyk7Cn0KJCgnYnlvcC1sb2dpbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxzdGFydFBvbGxPQXV0aCk7CiQoJ2J5b3AtbG9nb3V0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLHBvbGxMb2dvdXQpOwoKLyogLS0tIHRvYXN0IC0tLSAqLwp2YXIgX3RvYXN0VGltZXI9bnVsbDsKZnVuY3Rpb24gdG9hc3QobXNnKXsKICB2YXIgdD0kKCd0b2FzdCcpOyBpZighdCkgcmV0dXJuOwogIHQudGV4dENvbnRlbnQ9bXNnOyB0LmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOwogIGNsZWFyVGltZW91dChfdG9hc3RUaW1lcik7CiAgX3RvYXN0VGltZXI9c2V0VGltZW91dChmdW5jdGlvbigpeyB0LmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyB9LDM1MDApOwp9CgovKiAtLS0gcHJvZ3Jlc3Mgb3ZlcmxheSAtLS0gKi8KdmFyIF9wb2xsU3RvcD1mYWxzZTsKZnVuY3Rpb24gc2hvd1Byb2dyZXNzKHRpdGxlLHN0YXR1cyxwY3QpewogICQoJ3Byb2ctdGl0bGUnKS50ZXh0Q29udGVudD10aXRsZTsKICAkKCdwcm9nLXN0YXR1cycpLnRleHRDb250ZW50PXN0YXR1c3x8Jyc7CiAgJCgncHJvZy1iYXInKS5zdHlsZS53aWR0aD1NYXRoLm1heCgwLE1hdGgubWluKDEwMCxwY3R8fDApKSsnJSc7CiAgJCgncHJvZy1wY3QnKS50ZXh0Q29udGVudD1NYXRoLnJvdW5kKHBjdHx8MCkrJyUnOwogICQoJ3Byb2dvdmVybGF5JykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ3Byb2dvdmVybGF5JykuY2xhc3NMaXN0LmFkZCgnZmxleCcpOwp9CmZ1bmN0aW9uIGhpZGVQcm9ncmVzcygpeyAkKCdwcm9nb3ZlcmxheScpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyAkKCdwcm9nb3ZlcmxheScpLmNsYXNzTGlzdC5yZW1vdmUoJ2ZsZXgnKTsgfQokKCdwcm9nLWNhbmNlbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBfcG9sbFN0b3A9dHJ1ZTsgdG9hc3QoJ01lbWJhdGFsa2FuLi4uJyk7IH0pOwoKLyogLS0tIEFQSSBjbGllbnQgLS0tICovCmZ1bmN0aW9uIGJ1aWxkQXBpS2V5KCl7IHJldHVybiBzZXR0aW5ncy5hcGlLZXl8fCQoJ2FwaWtleScpLnZhbHVlLnRyaW0oKTsgfQoKZnVuY3Rpb24gX2FwaUhlYWRlcnMoZXh0cmEpewogIHZhciBoPXsneC1hcGkta2V5JzpidWlsZEFwaUtleSgpfTsKICBpZihzZXR0aW5ncy5wcm92aWRlcj09PSdwb2xsaW5hdGlvbnMnJiZzZXR0aW5ncy5wb2xsU2Vzc2lvbikgaFsneC1zZXNzaW9uJ109c2V0dGluZ3MucG9sbFNlc3Npb247CiAgaWYoZXh0cmEpIGZvcih2YXIgayBpbiBleHRyYSkgaFtrXT1leHRyYVtrXTsKICByZXR1cm4gaDsKfQphc3luYyBmdW5jdGlvbiBhcGlHZW5lcmF0ZShwYXlsb2FkKXsKICB2YXIgcmVzPWF3YWl0IGZldGNoKCcvYXBpL2dlbmVyYXRlJyx7bWV0aG9kOidQT1NUJyxoZWFkZXJzOl9hcGlIZWFkZXJzKHsnQ29udGVudC1UeXBlJzonYXBwbGljYXRpb24vanNvbid9KSxib2R5OkpTT04uc3RyaW5naWZ5KHBheWxvYWQpfSk7CiAgdmFyIGQ9YXdhaXQgcmVzLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsfSk7CiAgaWYoIXJlcy5vaykgdGhyb3cgbmV3IEVycm9yKChkJiZkLmVycm9yKXx8KCdIVFRQICcrcmVzLnN0YXR1cykpOwogIHJldHVybiBkfHx7fTsKfQphc3luYyBmdW5jdGlvbiBhcGlUYXNrKHRhc2tJZCl7CiAgdmFyIHJlcz1hd2FpdCBmZXRjaCgnL2FwaS90YXNrP2lkPScrZW5jb2RlVVJJQ29tcG9uZW50KHRhc2tJZCkse2hlYWRlcnM6X2FwaUhlYWRlcnMoe30pfSk7CiAgdmFyIGQ9YXdhaXQgcmVzLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsfSk7CiAgaWYoIXJlcy5vaykgdGhyb3cgbmV3IEVycm9yKChkJiZkLmVycm9yKXx8KCdIVFRQICcrcmVzLnN0YXR1cykpOwogIHJldHVybiBkfHx7fTsKfQoKYXN5bmMgZnVuY3Rpb24gcG9sbFRhc2sodGFza0lkLG9uUHJvZyl7CiAgdmFyIHN0YXJ0PURhdGUubm93KCksIG1heE1zPTYqNjAqMTAwMDsKICB3aGlsZShEYXRlLm5vdygpLXN0YXJ0PG1heE1zKXsKICAgIGlmKF9wb2xsU3RvcCkgdGhyb3cgbmV3IEVycm9yKCdkaWJhdGFsa2FuIHBlbmdndW5hJyk7CiAgICB2YXIgZD1hd2FpdCBhcGlUYXNrKHRhc2tJZCk7CiAgICBpZihkLnN0YXR1cz09PSdTVUNDRVNTJykgcmV0dXJuIGQuaW1hZ2VzfHxbXTsKICAgIGlmKGQuc3RhdHVzPT09J0ZBSUxFRCcpIHRocm93IG5ldyBFcnJvcihkLmVycm9yfHwnVGFzayBnYWdhbCcpOwogICAgaWYoZC5zdGF0dXM9PT0nQ0FOQ0VMRUQnKSB0aHJvdyBuZXcgRXJyb3IoJ1Rhc2sgZGliYXRhbGthbicpOwogICAgdmFyIHN0PShkLnN0YXR1cz09PSdXQUlUSU5HJyk/KCdBbnRyZSAnKyhkLnF1ZXVlfHwnJykpOihkLnN0YXR1cz09PSdSVU5OSU5HJz8nR2VuZXJhdGluZy4uLic6J01lbnVuZ2d1Li4uJyk7CiAgICBvblByb2coc3QsZC5wcm9ncmVzc3x8MCk7CiAgICBhd2FpdCBuZXcgUHJvbWlzZShmdW5jdGlvbihyKXsgc2V0VGltZW91dChyLCBkLnN0YXR1cz09PSdXQUlUSU5HJz80MDAwOjIwMDApOyB9KTsKICB9CiAgdGhyb3cgbmV3IEVycm9yKCdUaW1lb3V0IG1lbnVuZ2d1IGhhc2lsIGdlbmVyYXRlJyk7Cn0KCi8qIC0tLSBoYXNpbCAtLS0gKi8KZnVuY3Rpb24gbWtSZXN1bHQoc3JjLHBhcix0YXNrSWQsY3JlZGl0cyl7CiAgcmV0dXJuIHsKICAgIHNyYzpzcmMsIHByb21wdDpwYXIucGFyYW1zLnByb21wdCwgbmVnOnBhci5wYXJhbXMubmVnYXRpdmVQcm9tcHQsCiAgICBtb2RlbDpzdGF0ZS5tb2RlbD9zdGF0ZS5tb2RlbC5uYW1lOicnLAogICAgc2l6ZTpwYXIucGFyYW1zLndpZHRoKyd4JytwYXIucGFyYW1zLmhlaWdodCwgc2VlZDpwYXIucGFyYW1zLnNlZWQsCiAgICB0YXNrSWQ6dGFza0lkfHwnJywgY3JlZGl0czpjcmVkaXRzIT1udWxsP2NyZWRpdHM6JycsCiAgICB0czpEYXRlLm5vdygpLCBkZW1vOmZhbHNlLCBwYWdlOnN0YXRlLnBhZ2UKICB9Owp9CmZ1bmN0aW9uIGRlbW9SZXN1bHRzKHBhcil7CiAgc2hvd1Byb2dyZXNzKCdNb2RlIGRlbW8nLCdNZW55aWFwa2FuIGdhbWJhciBzaW11bGFzaS4uLicsMTUpOwogIHNldFRpbWVvdXQoZnVuY3Rpb24oKXsKICAgIGZvcih2YXIgaT0wO2k8c3RhdGUubmNvbDtpKyspewogICAgICB2YXIgc3JjPVMrTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKjFlOSkrJy81MTInOwogICAgICBhZGRSZXN1bHQoe3NyYzpzcmMsIHByb21wdDpwYXIucGFyYW1zLnByb21wdCwgbmVnOnBhci5wYXJhbXMubmVnYXRpdmVQcm9tcHQsCiAgICAgICAgbW9kZWw6c3RhdGUubW9kZWw/c3RhdGUubW9kZWwubmFtZTonJywgc2l6ZTpwYXIucGFyYW1zLndpZHRoKyd4JytwYXIucGFyYW1zLmhlaWdodCwKICAgICAgICBzZWVkOnBhci5wYXJhbXMuc2VlZCwgdGFza0lkOicnLCBjcmVkaXRzOicnLCB0czpEYXRlLm5vdygpLCBkZW1vOnRydWUsIHBhZ2U6c3RhdGUucGFnZX0pOwogICAgfQogICAgaGlkZVByb2dyZXNzKCk7CiAgfSw3MDApOwp9Cgphc3luYyBmdW5jdGlvbiBkb0dlbmVyYXRlKCl7CiAgaWYoc3RhdGUuYnVzeSkgcmV0dXJuOwogIHZhciBwPSQoJ3Byb21wdCcpLnZhbHVlLnRyaW0oKTsKICBpZighcCl7IG9wZW5MZWZ0KCk7ICQoJ3Byb21wdCcpLmZvY3VzKCk7IHRvYXN0KCdJc2kgcHJvbXB0IGR1bHUnKTsgcmV0dXJuOyB9CiAgdmFyIHBhcj1idWlsZFBheWxvYWQoKTsKICBzdGF0ZS5idXN5PXRydWU7IHNldEJ1c3kodHJ1ZSk7IF9wb2xsU3RvcD1mYWxzZTsKICB0cnl7CiAgICBpZihzZXR0aW5ncy5tb2RlPT09J2RlbW8nfHwoIWJ1aWxkQXBpS2V5KCkmJnNldHRpbmdzLnByb3ZpZGVyIT09J3BvbGxpbmF0aW9ucycpKXsKICAgICAgYXdhaXQgbmV3IFByb21pc2UoZnVuY3Rpb24ocil7IHNldFRpbWVvdXQociwzMDApOyB9KTsKICAgICAgZGVtb1Jlc3VsdHMocGFyKTsKICAgICAgaWYoIWJ1aWxkQXBpS2V5KCkpIHRvYXN0KCdCZWx1bSBhZGEgQVBJIGtleSDigJQgaGFzaWwgc2ltdWxhc2kuIElzaSBBUEkgS2V5IFRBTVMgZGkgcGFuZWwga2lyaSB1bnR1ayBnZW5lcmF0ZSBhc2xpLicpOwogICAgICBlbHNlIHRvYXN0KCdNb2RlIGRlbW8gYWt0aWYg4oCUIGhhc2lsIHNpbXVsYXNpLicpOwogICAgfWVsc2V7CiAgICAgIHNob3dQcm9ncmVzcygnTWVuZ2lyaW0ga2UgVEFNUy4uLicsJ01lbnlpYXBrYW4gdGFzay4uLicsNSk7CiAgICAgIHZhciByPWF3YWl0IGFwaUdlbmVyYXRlKHBhcik7CiAgICAgIHZhciB0YXNrSWQ9ci50YXNrSWR8fHIuam9iSWQ7CiAgICAgIGlmKHRhc2tJZCl7CiAgICAgICAgdmFyIGltZ3M9YXdhaXQgcG9sbFRhc2sodGFza0lkLGZ1bmN0aW9uKHN0LHBjdCl7IHNob3dQcm9ncmVzcygnR2VuZXJhdGluZy4uLicsc3QscGN0KTsgfSk7CiAgICAgICAgaW1ncy5mb3JFYWNoKGZ1bmN0aW9uKHNyYyl7IGFkZFJlc3VsdChta1Jlc3VsdChzcmMscGFyLHRhc2tJZCxyLmNyZWRpdHMpKTsgfSk7CiAgICAgIH1lbHNlewogICAgICAgIHZhciBpbWdzMj1leHRyYWN0SW1hZ2VzKHIpOwogICAgICAgIGlmKCFpbWdzMi5sZW5ndGgpIHRocm93IG5ldyBFcnJvcignUmVzcG9uc2UgdGFucGEgZ2FtYmFyJyk7CiAgICAgICAgaW1nczIuZm9yRWFjaChmdW5jdGlvbihzcmMpeyBhZGRSZXN1bHQobWtSZXN1bHQoc3JjLHBhciwnJyxyLmNyZWRpdHMpKTsgfSk7CiAgICAgIH0KICAgIH0KICB9Y2F0Y2goZSl7CiAgICBpZihzZXR0aW5ncy5tb2RlPT09J2F1dG8nKXsKICAgICAgdG9hc3QoJ0JhY2tlbmQvQVBJIGJlbHVtIGFrdGlmICgnK2UubWVzc2FnZSsnKSDigJQgcGFrYWkgc2ltdWxhc2kgZGVtbycpOwogICAgICBkZW1vUmVzdWx0cyhwYXIpOwogICAgfWVsc2V7CiAgICAgIHRvYXN0KCdHYWdhbDogJytlLm1lc3NhZ2UpOwogICAgfQogIH1maW5hbGx5ewogICAgaGlkZVByb2dyZXNzKCk7IHN0YXRlLmJ1c3k9ZmFsc2U7IHNldEJ1c3koZmFsc2UpOwogIH0KfQoKLyogLS0tIEltZzJJbWcgLS0tICovCnZhciBpMmlEYXRhVXJsPW51bGw7CiQoJ2kyaS1kcm9wJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7ICQoJ2kyaS1maWxlJykuY2xpY2soKTsgfSk7CiQoJ2kyaS1maWxlJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbihlKXsgaGFuZGxlSTJpRmlsZShlLnRhcmdldC5maWxlcyYmZS50YXJnZXQuZmlsZXNbMF0pOyB9KTsKJCgnaTJpLWRyb3AnKS5hZGRFdmVudExpc3RlbmVyKCdkcmFnb3ZlcicsZnVuY3Rpb24oZSl7IGUucHJldmVudERlZmF1bHQoKTsgfSk7CiQoJ2kyaS1kcm9wJykuYWRkRXZlbnRMaXN0ZW5lcignZHJvcCcsZnVuY3Rpb24oZSl7IGUucHJldmVudERlZmF1bHQoKTsgaGFuZGxlSTJpRmlsZShlLmRhdGFUcmFuc2Zlci5maWxlcyYmZS5kYXRhVHJhbnNmZXIuZmlsZXNbMF0pOyB9KTsKJCgnaTJpLWRzJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpeyAkKCdpMmktZHN2JykudGV4dENvbnRlbnQ9cGFyc2VGbG9hdChlLnRhcmdldC52YWx1ZSkudG9GaXhlZCgyKTsgfSk7CiQoJ2kyaS1jbGVhcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogIGkyaURhdGFVcmw9bnVsbDsgJCgnaTJpLXByZXZpZXcnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgnaTJpLWltZycpLnNyYz0nJzsgJCgnaTJpLWRyb3AnKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsKfSk7CmZ1bmN0aW9uIGhhbmRsZUkyaUZpbGUoZil7CiAgaWYoIWYpIHJldHVybjsKICB2YXIgcmQ9bmV3IEZpbGVSZWFkZXIoKTsKICByZC5vbmxvYWQ9ZnVuY3Rpb24oKXsKICAgIGkyaURhdGFVcmw9cmQucmVzdWx0OwogICAgJCgnaTJpLWltZycpLnNyYz1yZC5yZXN1bHQ7ICQoJ2kyaS1wcmV2aWV3JykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ2kyaS1kcm9wJykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7CiAgfTsKICByZC5yZWFkQXNEYXRhVVJMKGYpOwp9CgovKiAtLS0gcmVuZGVyIHBlciB0YWIgLS0tICovCmZ1bmN0aW9uIHJlbmRlckNhbnZhcygpewogIHZhciBwYWdlPXN0YXRlLnBhZ2U7CiAgdmFyIGhpZGVNYWluID0gIShwYWdlPT09J3RleHQnfHxwYWdlPT09J2ltZycpOwogICQoJ2ltZzJpbWctY2FyZCcpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicsIHBhZ2UhPT0naW1nJyk7CiAgJCgnZW1wdHknKS5zdHlsZS5kaXNwbGF5ID0gKGhpZGVNYWluIHx8IHN0YXRlLnJlc3VsdHMubGVuZ3RoPjApID8gJ25vbmUnIDogJyc7CiAgJCgnZ3JpZCcpLnN0eWxlLmRpc3BsYXkgPSBoaWRlTWFpbj8nbm9uZSc6Jyc7CiAgJCgndGFiLXBsYWNlaG9sZGVyJykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJywgIWhpZGVNYWluKTsKICAkKCd0YWItcGxhY2Vob2xkZXInKS5jbGFzc0xpc3QudG9nZ2xlKCdmbGV4JywgaGlkZU1haW4pOwogIGlmKHBhZ2U9PT0nZWRpdCcpICQoJ3RhYi1wbGFjZWhvbGRlci10ZXh0JykudGV4dENvbnRlbnQ9J0VkaXQgLyBJbnBhaW50aW5nIOKAlCBzZWdlcmEgaGFkaXInOwogIGVsc2UgaWYocGFnZT09PSd2aWRlbycpICQoJ3RhYi1wbGFjZWhvbGRlci10ZXh0JykudGV4dENvbnRlbnQ9J1RleHQgLyBJbWFnZSB0byBWaWRlbyDigJQgc2VnZXJhIGhhZGlyJzsKICBlbHNlIGlmKHBhZ2U9PT0ncHJpbWUnKSAkKCd0YWItcGxhY2Vob2xkZXItdGV4dCcpLnRleHRDb250ZW50PSdQcmltZSDigJQgc2VnZXJhIGhhZGlyJzsKfQoKLyogLS0tIHJpd2F5YXQgZGkgbW9iaWxlIC0tLSAqLwokKCdidG4taGlzdG9yeScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyAkKCdyaWdodFBhbicpLmNsYXNzTGlzdC50b2dnbGUoJ21vYmlsZS1vcGVuJyk7IH0pOwokKCdvdmVybGF5JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7ICQoJ3JpZ2h0UGFuJykuY2xhc3NMaXN0LnJlbW92ZSgnbW9iaWxlLW9wZW4nKTsgfSk7CgpyZW5kZXJMb3JhKCk7CnNldE1vZGVsKE1PREVMU1swXSk7CnVwZFdIKCk7CmFwcGx5TmNvbCgpOwpsb2FkU2V0dGluZ3MoKTsgYXBwbHlTZXR0aW5nc1VJKCk7CmhhbmRsZU9BdXRoQ2FsbGJhY2soKTsKdHJ5ewogIHZhciBzYXZlZD1KU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFJFU1VMVFNfS0VZKXx8J1tdJyk7CiAgaWYoQXJyYXkuaXNBcnJheShzYXZlZCkpIHN0YXRlLnJlc3VsdHM9c2F2ZWQ7Cn1jYXRjaChlKXt9CnJlbmRlckNhbnZhcygpOwpyZW5kZXJHcmlkKCk7CnJlbmRlclJpZ2h0KCk7Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4KCgo=';
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
  // Consumer Cloudflare Queues (dipakai oleh Worker terpisah
  // rekty-generate-consumer — Pages Functions tidak bisa jadi consumer).
  async queue(batch, env, ctx) {
    return queue(batch, env, ctx);
  },
};
