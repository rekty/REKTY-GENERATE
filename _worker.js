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
const HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImlkIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04IiAvPgo8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLGluaXRpYWwtc2NhbGU9MSIgLz4KPHRpdGxlPlJla3R5IEFJIOKAlCBUZXh0IHRvIEltYWdlPC90aXRsZT4KPHNjcmlwdD53aW5kb3cuX190YV9zdHlsZV9fPXRydWU8L3NjcmlwdD4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuLnRhaWx3aW5kY3NzLmNvbSI+PC9zY3JpcHQ+CjxzY3JpcHQgc3JjPSJodHRwczovL3VucGtnLmNvbS9AcGhvc3Bob3ItaWNvbnMvd2ViL3Bob3NwaG9yLWljb24uanMiPjwvc2NyaXB0Pgo8bGluayByZWw9InByZWNvbm5lY3QiIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20iPgo8bGluayBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tL2NzczI/ZmFtaWx5PUludGVyOndnaHRANDAwOzUwMDs2MDA7NzAwJmRpc3BsYXk9c3dhcCIgcmVsPSJzdHlsZXNoZWV0Ij4KPHN0eWxlPgpodG1sLGJvZHl7bWFyZ2luOjA7cGFkZGluZzowO2ZvbnQtZmFtaWx5Oi1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LCdTZWdvZSBVSScsUm9ib3RvLCdIZWx2ZXRpY2EgTmV1ZScsQXJpYWwsJ05vdG8gU2Fucycsc2Fucy1zZXJpZjtiYWNrZ3JvdW5kOiMwZDExMTc7Y29sb3I6I2U4ZThlODttaW4taGVpZ2h0OjEwMHZofQouaGlkZWJhcjo6LXdlYmtpdC1zY3JvbGxiYXJ7ZGlzcGxheTpub25lfS5oaWRlYmFye3Njcm9sbGJhci13aWR0aDpub25lfQo6Oi13ZWJraXQtc2Nyb2xsYmFye3dpZHRoOjhweDtoZWlnaHQ6OHB4fQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1ie2JhY2tncm91bmQ6IzMwMzYzZDtib3JkZXItcmFkaXVzOjRweH0KOjotd2Via2l0LXNjcm9sbGJhci10aHVtYjpob3ZlcntiYWNrZ3JvdW5kOiMzZDQ0NGR9Cjo6LXdlYmtpdC1zY3JvbGxiYXItdHJhY2t7YmFja2dyb3VuZDp0cmFuc3BhcmVudH0KLmJke2JvcmRlci1jb2xvcjojMzAzNjNkfQouaW5we2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjhweDtiYWNrZ3JvdW5kOiMxYzIxMjg7Y29sb3I6I2U4ZThlODtwYWRkaW5nOjhweCAxMXB4O291dGxpbmU6bm9uZTtmb250LXNpemU6MTNweDt3aWR0aDoxMDAlfQouaW5wOmZvY3Vze2JvcmRlci1jb2xvcjojNkY1REZGfQouYnRue2JvcmRlci1yYWRpdXM6MTBweDtmb250LXdlaWdodDo2MDA7dHJhbnNpdGlvbjouMTVzO2N1cnNvcjpwb2ludGVyO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjZweDtmb250LXNpemU6MTNweH0KLmJ0bi1ibHVle2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDk1ZGVnLCM2RjVERkYgMCUsIzI3RDRDRCA1OS43JSwjNzRGRjdFIDEwMCUpO2JvcmRlcjpub25lO2NvbG9yOiNmZmY7Ym94LXNoYWRvdzowIDAgMThweCByZ2JhKDExMSw5MywyNTUsLjM1KTtwYWRkaW5nOjAgMThweH0KLmJ0bi1ibHVlOmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMSk7Ym94LXNoYWRvdzowIDAgMjRweCByZ2JhKDExMSw5MywyNTUsLjUpfQouYnRuLWJsdWU6YWN0aXZle3RyYW5zZm9ybTpzY2FsZSguOTgpfQovKiBUb21ib2wgR2VuZXJhdGUgc2VwZXJ0aSBUZW5zb3IuQXJ0OiB0dXJxdW9pc2UtYmx1ZSAqLwouYnRuLXR1cnF7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLCMxRkM3Q0UgMCUsIzJFN0NGMCAxMDAlKTtib3JkZXI6bm9uZTtjb2xvcjojZmZmO2JveC1zaGFkb3c6MCAwIDE2cHggcmdiYSgzMSwxOTksMjA2LC4zNSk7cGFkZGluZzowIDE2cHh9Ci5idG4tdHVycTpob3ZlcntmaWx0ZXI6YnJpZ2h0bmVzcygxLjEpO2JveC1zaGFkb3c6MCAwIDIycHggcmdiYSgzMSwxOTksMjA2LC41KX0KLmJ0bi10dXJxOmFjdGl2ZXt0cmFuc2Zvcm06c2NhbGUoLjk4KX0KLmJ0bi1naG9zdHtjb2xvcjojYTFhMWFhO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOjFweCBzb2xpZCB0cmFuc3BhcmVudH0uYnRuLWdob3N0OmhvdmVye2JhY2tncm91bmQ6IzFjMjEyODtjb2xvcjojZThlOGU4fQoudGFie2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHg7cGFkZGluZzo2cHggMTJweDtib3JkZXItcmFkaXVzOjhweDtmb250LXNpemU6MTNweDtjb2xvcjojOWE5YWEyO2N1cnNvcjpwb2ludGVyO2ZvbnQtd2VpZ2h0OjUwMDt3aGl0ZS1zcGFjZTpub3dyYXA7dHJhbnNpdGlvbjouMTJzfQoudGFiOmhvdmVye2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMWMyMTI4fS50YWIuc2Vse2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMWMyMTI4fQoudGFiIC5kb3R7d2lkdGg6NnB4O2hlaWdodDo2cHg7Ym9yZGVyLXJhZGl1czo1MCU7ZGlzcGxheTppbmxpbmUtYmxvY2t9Ci50YWIuc2VsIC5kb3R7ZGlzcGxheTpub25lfQoudGFiLnNlbDo6YWZ0ZXJ7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtib3R0b206LTFweDtsZWZ0OjUwJTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTt3aWR0aDoyMHB4O2hlaWdodDoycHg7Ym9yZGVyLXJhZGl1czoycHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiwjMjdENENEKTtwb3NpdGlvbjphYnNvbHV0ZX0KLnRhYntwb3NpdGlvbjpyZWxhdGl2ZX0KLnNsaWRlcnstd2Via2l0LWFwcGVhcmFuY2U6bm9uZTthcHBlYXJhbmNlOm5vbmU7aGVpZ2h0OjRweDtib3JkZXItcmFkaXVzOjRweDtiYWNrZ3JvdW5kOiMzMDM2M2Q7b3V0bGluZTpub25lO3dpZHRoOjEwMCV9Ci5zbGlkZXI6Oi13ZWJraXQtc2xpZGVyLXRodW1iey13ZWJraXQtYXBwZWFyYW5jZTpub25lO2FwcGVhcmFuY2U6bm9uZTt3aWR0aDoxNXB4O2hlaWdodDoxNXB4O2JvcmRlci1yYWRpdXM6NTAlO2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6M3B4IHNvbGlkICM2RjVERkY7Y3Vyc29yOnBvaW50ZXI7Ym94LXNoYWRvdzowIDAgNnB4IHJnYmEoMTExLDkzLDI1NSwuNCk7dHJhbnNpdGlvbjouMTJzfQouc2xpZGVyOjotd2Via2l0LXNsaWRlci10aHVtYjpob3Zlcnt0cmFuc2Zvcm06c2NhbGUoMS4xKX0KLmxvcmEtc2x7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7YXBwZWFyYW5jZTpub25lO2hlaWdodDo0cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDojMzAzNjNkO291dGxpbmU6bm9uZX0KLmxvcmEtc2w6Oi13ZWJraXQtc2xpZGVyLXRodW1iey13ZWJraXQtYXBwZWFyYW5jZTpub25lO3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoycHggc29saWQgIzZGNURGRjtjdXJzb3I6cG9pbnRlcn0KLmxvcmEtY2FyZHtwb3NpdGlvbjpyZWxhdGl2ZTtib3JkZXI6MXB4IHNvbGlkICMzMDM2M2Q7Ym9yZGVyLXJhZGl1czoxMHB4O2JhY2tncm91bmQ6IzFjMjEyODt0cmFuc2l0aW9uOi4xMnM7cGFkZGluZzo4cHggMTBweCAxMHB4fQoubG9yYS1jYXJkOmhvdmVye2JvcmRlci1jb2xvcjojM2Q0NDRkfQoubG9yYS1sYWJlbHtwb3NpdGlvbjphYnNvbHV0ZTt0b3A6MDtsZWZ0OjA7Zm9udC1zaXplOjlweDtjb2xvcjojOWE5YWEyO2JhY2tncm91bmQ6IzIxMjYyZDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsLjEpO3BhZGRpbmc6MnB4IDZweDtib3JkZXItcmFkaXVzOjZweDtib3JkZXItdG9wLWxlZnQtcmFkaXVzOjEwcHg7Ym9yZGVyLWJvdHRvbS1yaWdodC1yYWRpdXM6NnB4O3otaW5kZXg6Mn0KLmxvcmEtdG9we2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDttYXJnaW4tdG9wOjhweH0KLmxvcmEtdGh1bWJ7d2lkdGg6MzRweDtoZWlnaHQ6MzRweDtib3JkZXItcmFkaXVzOjZweDtib3JkZXI6MXB4IHNvbGlkICMzMDM2M2Q7b2JqZWN0LWZpdDpjb3ZlcjtmbGV4LXNocmluazowfQoubG9yYS1uYW1le2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjojZThlOGU4O2ZsZXg6MTttaW4td2lkdGg6MDt3aGl0ZS1zcGFjZTpub3dyYXA7b3ZlcmZsb3c6aGlkZGVuO3RleHQtb3ZlcmZsb3c6ZWxsaXBzaXN9Ci5sb3JhLWljb25ze2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjJweDtmbGV4LXNocmluazowfQoubG9yYS1pY29ue3dpZHRoOjIycHg7aGVpZ2h0OjIycHg7Ym9yZGVyLXJhZGl1czo0cHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOiM3MTcxN2E7YmFja2dyb3VuZDp0cmFuc3BhcmVudDt0cmFuc2l0aW9uOi4xMnN9Ci5sb3JhLWljb246aG92ZXJ7YmFja2dyb3VuZDojMjEyNjJkO2NvbG9yOiNmZmZ9Ci5sb3JhLWljb24uZGVsOmhvdmVye2JhY2tncm91bmQ6cmdiYSgyMzksNjgsNjgsLjE1KTtjb2xvcjojZWY0NDQ0fQoubG9yYS1pY29uIHN2Z3t3aWR0aDoxNHB4O2hlaWdodDoxNHB4O3N0cm9rZTpjdXJyZW50Q29sb3I7ZmlsbDpub25lO3N0cm9rZS13aWR0aDoyfQoubG9yYS1zbGlkZXItcm93e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjRweDttYXJnaW4tdG9wOjZweH0KLmwtc2xpZGVye3Bvc2l0aW9uOnJlbGF0aXZlO2ZsZXg6MTtoZWlnaHQ6MTZweDtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyfQoubC10cmFja3twb3NpdGlvbjphYnNvbHV0ZTtsZWZ0OjA7cmlnaHQ6MDtoZWlnaHQ6NHB4O2JvcmRlci1yYWRpdXM6NHB4O2JhY2tncm91bmQ6IzMwMzYzZH0KLmwtZmlsbHtwb3NpdGlvbjphYnNvbHV0ZTtsZWZ0OjA7dG9wOjUwJTt0cmFuc2Zvcm06dHJhbnNsYXRlWSgtNTAlKTtoZWlnaHQ6NHB4O2JvcmRlci1yYWRpdXM6NHB4O2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDk1ZGVnLCM2RjVERkYsIzI3RDRDRCl9Ci5sLWhhbmRsZXtwb3NpdGlvbjphYnNvbHV0ZTt0b3A6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGUoLTUwJSwtNTAlKTt3aWR0aDoxNHB4O2hlaWdodDoxNHB4O2JvcmRlci1yYWRpdXM6NTAlO2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MnB4IHNvbGlkICM2RjVERkY7Ym94LXNoYWRvdzowIDFweCAzcHggcmdiYSgwLDAsMCwuNCk7cG9pbnRlci1ldmVudHM6bm9uZX0KLmxvcmEtc2x7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6MDt3aWR0aDoxMDAlO2hlaWdodDoxMDAlO29wYWNpdHk6MDtjdXJzb3I6cG9pbnRlcn0KLmwtbnVte2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjJweDtmbGV4LXNocmluazowfQoubG9yYS1pbnB1dHt3aWR0aDozMHB4O2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTUpO2JvcmRlci1yYWRpdXM6NnB4O2JhY2tncm91bmQ6IzBkMTExNztjb2xvcjojZThlOGU4O2ZvbnQtc2l6ZToxMnB4O3RleHQtYWxpZ246Y2VudGVyO291dGxpbmU6bm9uZTtwYWRkaW5nOjRweCAwfQoubG9yYS1pbnB1dDpmb2N1c3tib3JkZXItY29sb3I6IzZGNURGRn0KLmxvcmEtdXJsLWlucHtmb250LXNpemU6MTFweDtwYWRkaW5nOjZweCA5cHg7bWFyZ2luLXRvcDoycHh9Ci5sb3JhLWJ0bnt3aWR0aDoyMnB4O2hlaWdodDoyMnB4O2JvcmRlci1yYWRpdXM6NTAlO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjb2xvcjojOWE5YWEyO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOm5vbmU7dHJhbnNpdGlvbjouMTJzfQoubG9yYS1idG46aG92ZXJ7YmFja2dyb3VuZDpyZ2JhKDI1NSwyNTUsMjU1LC4xKTtjb2xvcjojZmZmfQoubG9yYS1idG4gc3Zne3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7c3Ryb2tlOmN1cnJlbnRDb2xvcjtmaWxsOm5vbmU7c3Ryb2tlLXdpZHRoOjI7c3Ryb2tlLWxpbmVjYXA6cm91bmR9Ci50YWd7YmFja2dyb3VuZDojMWMyMTI4O2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtjb2xvcjojZTBlMGUwO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo0cHg7Zm9udC1zaXplOjEycHg7cGFkZGluZzo0cHggOHB4O2JvcmRlci1yYWRpdXM6NnB4fQouYXJ7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2JvcmRlci1yYWRpdXM6MTBweDtiYWNrZ3JvdW5kOiMxYzIxMjg7Y29sb3I6I2ZmZjtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2dhcDoycHg7cGFkZGluZzo4cHggMnB4O2N1cnNvcjpwb2ludGVyO3RyYW5zaXRpb246LjEyczttaW4td2lkdGg6MH0KLmFyOmhvdmVye2JvcmRlci1jb2xvcjojM2Q0NDRkfQouYXIuc2Vse2JvcmRlci1jb2xvcjojMjdENENEO2JhY2tncm91bmQ6IzE2MWIyMn0KLmFyLnNlbCAuYXItZGVzY3tjb2xvcjojMjdENENEfQouYXItaWNve3dpZHRoOjI0cHg7aGVpZ2h0OjI0cHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyfQouYXItaWNvIHN2Z3t3aWR0aDoxMDAlO2hlaWdodDoxMDAlfQouYXItbmFtZXtmb250LXNpemU6MTFweDtjb2xvcjojZThlOGU4O3doaXRlLXNwYWNlOm5vd3JhcH0KLmFyLWRlc2N7Zm9udC1zaXplOjlweDtjb2xvcjojOWE5YWEyO3doaXRlLXNwYWNlOm5vd3JhcH0KLmZpZWxke2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjNweH0KLnJ0YWJ7Ym9yZGVyOjFweCBzb2xpZCB0cmFuc3BhcmVudDtib3JkZXItcmFkaXVzOjZweDtwYWRkaW5nOjRweCAxMHB4O2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7YmFja2dyb3VuZDp0cmFuc3BhcmVudH0KLnJ0YWI6aG92ZXJ7Y29sb3I6I2ZmZn0ucnRhYi5zZWx7YmFja2dyb3VuZDojMWMyMTI4O2NvbG9yOiNmZmZ9Ci5yY2FyZHtib3JkZXI6MXB4IHNvbGlkICMzMDM2M2Q7Ym9yZGVyLXJhZGl1czoxMHB4O292ZXJmbG93OmhpZGRlbjtiYWNrZ3JvdW5kOiMxNjFiMjJ9Ci5jaGlwe2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjZweDtwYWRkaW5nOjRweCAxMHB4O2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7YmFja2dyb3VuZDojMWMyMTI4O3RyYW5zaXRpb246LjEyc30KLmNoaXA6aG92ZXJ7Y29sb3I6I2ZmZn0uY2hpcC5vbntib3JkZXItY29sb3I6IzZGNURGRjtjb2xvcjojZmZmO2JhY2tncm91bmQ6IzE2MWIyMn0KI3RvYXN0e2JveC1zaGFkb3c6MCA4cHggMzBweCByZ2JhKDAsMCwwLC41KX0KQG1lZGlhIChtYXgtd2lkdGg6MTAyM3B4KXsjcmlnaHRQYW4ubW9iaWxlLW9wZW57cG9zaXRpb246Zml4ZWQ7dG9wOjU2cHg7cmlnaHQ6MDtib3R0b206MDtsZWZ0OmF1dG87ei1pbmRleDo0MDtkaXNwbGF5OmZsZXg7d2lkdGg6bWluKDIxcmVtLDkydncpO2JveC1zaGFkb3c6LThweCAwIDMwcHggcmdiYSgwLDAsMCwuNSl9fQp0ZXh0YXJlYXtjYXJldC1jb2xvcjojNkY1REZGfQppbnB1dFt0eXBlPWNoZWNrYm94XXt3aWR0aDoxNHB4O2hlaWdodDoxNHB4O2N1cnNvcjpwb2ludGVyfQppbnB1dFt0eXBlPXJhbmdlXXtjdXJzb3I6cG9pbnRlcn0KOmZvY3VzLXZpc2libGV7b3V0bGluZToycHggc29saWQgIzZGNURGRjtvdXRsaW5lLW9mZnNldDoycHh9Ci53dm51bXtib3JkZXI6MXB4IHNvbGlkICMzMDM2M2Q7Ym9yZGVyLXJhZGl1czo2cHg7YmFja2dyb3VuZDojMWMyMTI4O2NvbG9yOiNlOGU4ZTg7cGFkZGluZzozcHggNnB4O3dpZHRoOjY0cHg7Zm9udC1zaXplOjEycHg7dGV4dC1hbGlnbjpyaWdodDtvdXRsaW5lOm5vbmV9Ci53dm51bTpmb2N1c3tib3JkZXItY29sb3I6IzI3RDRDRH0KLm10YWJ7cGFkZGluZzo4cHggMTRweDtib3JkZXItcmFkaXVzOjhweDtmb250LXNpemU6MTNweDtjb2xvcjojOWE5YWEyO2N1cnNvcjpwb2ludGVyO2ZvbnQtd2VpZ2h0OjUwMDt3aGl0ZS1zcGFjZTpub3dyYXA7dHJhbnNpdGlvbjouMTJzfQoubXRhYjpob3Zlcntjb2xvcjojZmZmO2JhY2tncm91bmQ6IzFjMjEyOH0ubXRhYi5zZWx7Y29sb3I6I2ZmZjtiYWNrZ3JvdW5kOiMxYzIxMjg7Ym9yZGVyLWJvdHRvbToycHggc29saWQgIzZGNURGRn0KLm1jaGlwe2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjZweDtwYWRkaW5nOjRweCAxMHB4O2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7YmFja2dyb3VuZDojMWMyMTI4O3RyYW5zaXRpb246LjEyczt3aGl0ZS1zcGFjZTpub3dyYXB9Ci5tY2hpcDpob3Zlcntjb2xvcjojZmZmfS5tY2hpcC5vbntib3JkZXItY29sb3I6IzZGNURGRjtjb2xvcjojZmZmO2JhY2tncm91bmQ6cmdiYSgxMTEsOTMsMjU1LC4xNSl9Ci5tY2FyZHtib3JkZXI6MXB4IHNvbGlkICMzMDM2M2Q7Ym9yZGVyLXJhZGl1czoxMHB4O292ZXJmbG93OmhpZGRlbjtiYWNrZ3JvdW5kOiMxYzIxMjg7dHJhbnNpdGlvbjouMTVzfQoubWNhcmQ6aG92ZXJ7Ym9yZGVyLWNvbG9yOnJnYmEoMTExLDkzLDI1NSwuNTUpO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpO2JveC1zaGFkb3c6MCA2cHggMThweCByZ2JhKDAsMCwwLC4zNSl9Ci5tY2FyZC1pbWd7cG9zaXRpb246cmVsYXRpdmU7YXNwZWN0LXJhdGlvOjMvNDtvdmVyZmxvdzpoaWRkZW59Ci5tY2FyZC1pbWcgaW1ne3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7b2JqZWN0LWZpdDpjb3Zlcjt0cmFuc2l0aW9uOi4zc30KLm1jYXJkOmhvdmVyIC5tY2FyZC1pbWcgaW1ne3RyYW5zZm9ybTpzY2FsZSgxLjA1KX0KLm1jYXJkLWJhZGdle3Bvc2l0aW9uOmFic29sdXRlO3RvcDo2cHg7bGVmdDo2cHg7YmFja2dyb3VuZDpyZ2JhKDAsMCwwLC42NSk7YmFja2Ryb3AtZmlsdGVyOmJsdXIoNHB4KTtmb250LXNpemU6MTBweDtwYWRkaW5nOjJweCA2cHg7Ym9yZGVyLXJhZGl1czo0cHg7Y29sb3I6I2U4ZThlODtmb250LXdlaWdodDo1MDB9Ci5tY2FyZC1zdGFye3Bvc2l0aW9uOmFic29sdXRlO3RvcDo2cHg7cmlnaHQ6NnB4O3dpZHRoOjI2cHg7aGVpZ2h0OjI2cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDpyZ2JhKDAsMCwwLC41KTtiYWNrZHJvcC1maWx0ZXI6Ymx1cig0cHgpO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjdXJzb3I6cG9pbnRlcjtjb2xvcjojOWE5YWEyO3RyYW5zaXRpb246LjEyc30KLm1jYXJkLXN0YXI6aG92ZXJ7Y29sb3I6I2VhYjMwOH0ubWNhcmQtc3Rhci5vbntjb2xvcjojZWFiMzA4fQoubWNhcmQtdmlld3N7cG9zaXRpb246YWJzb2x1dGU7Ym90dG9tOjZweDtsZWZ0OjZweDtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjYpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDRweCk7Zm9udC1zaXplOjEwcHg7cGFkZGluZzoycHggNnB4O2JvcmRlci1yYWRpdXM6NHB4O2NvbG9yOiNlOGU4ZTg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6M3B4fQoubWNhcmQtaW5mb3twYWRkaW5nOjhweH0KLm1jYXJkLW5hbWV7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOiNlOGU4ZTg7d2hpdGUtc3BhY2U6bm93cmFwO292ZXJmbG93OmhpZGRlbjt0ZXh0LW92ZXJmbG93OmVsbGlwc2lzfQoubWNhcmQtbWV0YXtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO21hcmdpbi10b3A6NnB4fQoubWNhcmQtdmVye2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiM5YTlhYTI7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkICMzMDM2M2Q7Ym9yZGVyLXJhZGl1czo0cHg7cGFkZGluZzoycHggNnB4fQoubWNhcmQtc2Vse2ZvbnQtc2l6ZToxMXB4O2JvcmRlcjoxcHggc29saWQgIzZGNURGRjtjb2xvcjojNkY1REZGO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyLXJhZGl1czo0cHg7cGFkZGluZzoycHggMTBweDtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjouMTJzfQoubWNhcmQtc2VsOmhvdmVye2JhY2tncm91bmQ6IzZGNURGRjtjb2xvcjojZmZmfQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5PgoKPGhlYWRlciBjbGFzcz0iZml4ZWQgdG9wLTAgbGVmdC0wIHJpZ2h0LTAgei00MCBoLTE0IGJnLVsjMGQxMTE3XS84NSBiYWNrZHJvcC1ibHVyIGJvcmRlci1iIGJkIGZsZXggaXRlbXMtY2VudGVyIHB4LTIgc206cHgtMyBnYXAtMiI+CiAgPGJ1dHRvbiBpZD0ibW1lbnUiIGNsYXNzPSJsZzpoaWRkZW4gdGV4dC1uZXV0cmFsLTQwMCBwLTEiPjxpIGRhdGEtaWNvbj0ibGlzdCIgY2xhc3M9InctNSBoLTUiPjwvaT48L2J1dHRvbj4KICA8ZGl2IGNsYXNzPSJ3LTYgaC02IHNocmluay0wIGhpZGRlbiBzbTpmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciI+CiAgICA8c3ZnIHdpZHRoPSIyMiIgaGVpZ2h0PSIyMiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSJ1cmwoI2cpIi8+PHBhdGggZD0iTTcgMTIuNWwzIDMgNy03IiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIyNCIgeTI9IjI0Ij48c3RvcCBzdG9wLWNvbG9yPSIjNkY1REZGIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNkY1REZGIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PC9zdmc+CiAgPC9kaXY+CiAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTAuNSBoaWRlYmFyIG92ZXJmbG93LXgtYXV0byBmbGV4LTEiPgogICAgPGRpdiBjbGFzcz0idGFiIHNlbCIgZGF0YS10YWI9InRleHQiPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiM2RjVERkYiPjwvc3Bhbj5UZXh0MkltZzwvZGl2PgogICAgPGRpdiBjbGFzcz0idGFiIiBkYXRhLXRhYj0iaW1nIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDojMjJjNTVlIj48L3NwYW4+SW1nMkltZzwvZGl2PgogICAgPGRpdiBjbGFzcz0idGFiIiBkYXRhLXRhYj0iZWRpdCI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6I2VhYjMwOCI+PC9zcGFuPkVkaXQ8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InRhYiIgZGF0YS10YWI9InZpZGVvIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDojZWY0NDQ0Ij48L3NwYW4+VmlkZW88L2Rpdj4KICAgIDxkaXYgY2xhc3M9InRhYiIgZGF0YS10YWI9InByaW1lIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDojM2I4MmY2Ij48L3NwYW4+UHJpbWU8L2Rpdj4KICA8L2Rpdj4KICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41IHNtOmdhcC0yIG1sLWF1dG8gc2hyaW5rLTAiPgogICAgPGJ1dHRvbiBpZD0ibmNvbCIgY2xhc3M9InRleHQtbmV1dHJhbC00MDAgaG92ZXI6dGV4dC13aGl0ZSBwLTEuNSBoaWRkZW4gc206ZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEgdGV4dC14cyIgdGl0bGU9Ikp1bWxhaCBrb2xvbSI+PGkgZGF0YS1pY29uPSJzcXVhcmVzLWZvdXIiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PHNwYW4gaWQ9Im5jb2xsYmwiPjI8L3NwYW4+PC9idXR0b24+CiAgPC9kaXY+CjwvaGVhZGVyPgoKPGRpdiBpZD0ib3ZlcmxheSIgY2xhc3M9ImZpeGVkIGluc2V0LTAgYmctYmxhY2svNjAgei0zMCBoaWRkZW4gbGc6aGlkZGVuIj48L2Rpdj4KCjxkaXYgY2xhc3M9InB0LTE0IGZsZXggaC1bY2FsYygxMDB2aC01NnB4KV0gb3ZlcmZsb3ctaGlkZGVuIj4KCiAgPCEtLSBMRUZUIFBBTkVMIC0tPgogIDxhc2lkZSBpZD0ibGVmdHBhbiIgY2xhc3M9ImZpeGVkIGxnOnN0YXRpYyB6LTQwIGluc2V0LXktMCBsZWZ0LTAgcHQtMTQgbGc6cHQtMCB3LVsyMnJlbV0gbWF4LXctWzg4dnddIC10cmFuc2xhdGUteC1mdWxsIGxnOnRyYW5zbGF0ZS14LTAgdHJhbnNpdGlvbi10cmFuc2Zvcm0gZHVyYXRpb24tMjAwIHNocmluay0wIGJvcmRlci1yIGJkIG92ZXJmbG93LXktYXV0byBiZy1bIzE2MWIyMl0iPgogICAgPGRpdiBjbGFzcz0icC00IHNwYWNlLXktNCI+CgogICAgICA8IS0tIE1vZGVscyAodXJ1dGFuIHNlcGVydGkgVGVuc29yLkFydDogTW9kZWxzIC0+IFZBRSAtPiBTZXR0aW5ncykgLS0+CiAgICAgIDxkaXYgY2xhc3M9InNwYWNlLXktMyI+CiAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+TW9kZWxzPC9zcGFuPgogICAgICAgIDxkaXYgaWQ9Im1vZGVsLWNhcmQiIGNsYXNzPSJyZWxhdGl2ZSBib3JkZXIgYmQgcm91bmRlZC14bCBiZy1bIzFjMjEyOF0gaG92ZXI6Ym9yZGVyLVsjM2Q0NDRkXSBjdXJzb3ItcG9pbnRlciBwLTMiPgogICAgICAgICAgPHNwYW4gaWQ9Im1vZGVsLWJhZGdlIiBjbGFzcz0iYWJzb2x1dGUgdG9wLTAgbGVmdC0wIHRleHQtWzlweF0gdGV4dC1uZXV0cmFsLTQwMCBiZy1bIzIxMjYyZF0gYm9yZGVyIGJkIHB4LTIgcHktMC41IHJvdW5kZWQtdGwteGwgcm91bmRlZC1ici1tZCB6LTEwIj5CYXNpYyBNb2RlbCAtIFogSW1hZ2U8L3NwYW4+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMyBtdC0yIj4KICAgICAgICAgICAgPGltZyBpZD0ibW9kZWwtdGh1bWIiIHNyYz0iaHR0cHM6Ly9waWNzdW0ucGhvdG9zL3NlZWQvemltYWdlLzY0IiBjbGFzcz0idy0xNiBoLTE2IHJvdW5kZWQtbGcgb2JqZWN0LWNvdmVyIHNocmluay0wIGJvcmRlciBiZCIgYWx0PSJtb2RlbCIvPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4LTEgbWluLXctMCI+CiAgICAgICAgICAgICAgPGRpdiBpZD0ibW9kZWwtbmFtZSIgY2xhc3M9ImZvbnQtc2VtaWJvbGQgdGV4dC1zbSB0cnVuY2F0ZSI+WiBJbWFnZSAtIGJhc2UtYmYxNjwvZGl2PgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0ibW9kZWwtaW5mbyIgY2xhc3M9InctNiBoLTYgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcm91bmRlZCB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgaG92ZXI6YmctWyMyMTI2MmRdIHRyYW5zaXRpb24iIHRpdGxlPSJJbmZvIj4KICAgICAgICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBjbGFzcz0idy00IGgtNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48bGluZSB4MT0iMTIiIHkxPSIxNiIgeDI9IjEyIiB5Mj0iMTIiLz48bGluZSB4MT0iMTIiIHkxPSI4IiB4Mj0iMTIuMDEiIHkyPSI4Ii8+PC9zdmc+CiAgICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBjbGFzcz0idy00IGgtNCB0ZXh0LW5ldXRyYWwtNTAwIHNocmluay0wIj48cG9seWxpbmUgcG9pbnRzPSI5IDE4IDE1IDEyIDkgNiIvPjwvc3ZnPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBnYXAtMiI+CiAgICAgICAgICA8YnV0dG9uIGlkPSJidG4tYWRkbG9yYSIgY2xhc3M9ImJ0biBidG4tZ2hvc3QgZmxleC0xIGgtOSBib3JkZXIgYmQgdGV4dC14cyI+QWRkIExvUkE8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3QgZmxleC0xIGgtOSBib3JkZXIgYmQgdGV4dC14cyI+QWRkIEVtYmVkZGluZzwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOSBib3JkZXIgYmQgdGV4dC14cyI+QWRkIENvbnRyb2xOZXQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIExvUkEgLS0+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIG1iLTIiPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+TG9SQTwvc3Bhbj4KICAgICAgICAgIDxpIGRhdGEtaWNvbj0iY2FyZXQtZG93biIgY2xhc3M9InctNCBoLTQgdGV4dC1uZXV0cmFsLTUwMCI+PC9pPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImxvcmEtbGlzdCIgY2xhc3M9InNwYWNlLXktMiI+PC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBUcmlnZ2VyIFdvcmRzIC0tPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5UcmlnZ2VyIFdvcmRzPC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCI+KDxzcGFuIGlkPSJ0ci1jb3VudCI+MDwvc3Bhbj4pPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBtdC0xIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAiPkFkZCBUcmlnZ2VyIFdvcmRzIHRvIFByb21wdHM8L3NwYW4+CiAgICAgICAgICA8YnV0dG9uIGlkPSJhZGRhbGwtdHJpZyIgY2xhc3M9InRleHQteHMgdGV4dC1bIzZGNURGRl0gaG92ZXI6dW5kZXJsaW5lIGZvbnQtbWVkaXVtIj5BZGQgQWxsPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBmbGV4LXdyYXAgZ2FwLTEuNSBtdC0yIiBpZD0idHJpZ2dlcnMiPjwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDwhLS0gVkFFIC0tPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20iPlZBRTwvc3Bhbj4KICAgICAgICA8c2VsZWN0IGlkPSJ2YWUiIGNsYXNzPSJpbnAiPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYXV0b21hdGljIj5BdXRvbWF0aWM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Im5vbmUiPk5vbmU8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InZhZS1mdC1tc2UtODQwMDAwLWVtYS1wcnVuZWQuY2twdCI+dmFlLWZ0LW1zZS04NDAwMDAtZW1hLXBydW5lZC5ja3B0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJrbC1mOC1hbmltZS5ja3B0Ij5rbC1mOC1hbmltZS5ja3B0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJrbC1mOC1hbmltZTIuY2twdCI+a2wtZjgtYW5pbWUyLmNrcHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9IllPWk9SQS52YWUucHQiPllPWk9SQS52YWUucHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Im9yYW5nZW1peC52YWUucHQiPm9yYW5nZW1peC52YWUucHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImJsZXNzZWQyLnZhZS5wdCI+Ymxlc3NlZDIudmFlLnB0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhbmltZXZhZS5wdCI+YW5pbWV2YWUucHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9IkNsZWFyVkFFLnNhZmV0ZW5zb3JzIj5DbGVhclZBRS5zYWZldGVuc29yczwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icGFzdGVsLXdhaWZ1LWRpZmZ1c2lvbi52YWUucHQiPnBhc3RlbC13YWlmdS1kaWZmdXNpb24udmFlLnB0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJjdXRlX3ZhZS5zYWZldGVuc29ycyI+Y3V0ZV92YWUuc2FmZXRlbnNvcnM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InNkeGxfdmFlLnNhZmV0ZW5zb3JzIj5zZHhsX3ZhZS5zYWZldGVuc29yczwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2R4bC12YWUtZnAxNi1maXguc2FmZXRlbnNvcnMiPnNkeGwtdmFlLWZwMTYtZml4LnNhZmV0ZW5zb3JzPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJ4bFZBRUNfYzkxLnNhZmV0ZW5zb3JzIj54bFZBRUNfYzkxLnNhZmV0ZW5zb3JzPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJsYXN0cGllY2VYTFZBRV9iYXNlb25BMDg5Ny5zYWZldGVuc29ycyI+bGFzdHBpZWNlWExWQUVfYmFzZW9uQTA4OTcuc2FmZXRlbnNvcnM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InBsYXlncm91bmQtdjIuNS1mcDE2LXZhZS5zYWZldGVuc29ycyI+cGxheWdyb3VuZC12Mi41LWZwMTYtdmFlLnNhZmV0ZW5zb3JzPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhZS5zZnQiPmFlLnNmdDwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icGl4ZWxfc3BhY2UiPnBpeGVsX3NwYWNlPC9vcHRpb24+CiAgICAgICAgPC9zZWxlY3Q+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBTZXR0aW5ncyAtLT4KICAgICAgPGRpdiBjbGFzcz0ic3BhY2UteS00Ij4KICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5TZXR0aW5nczwvc3Bhbj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBncmlkLWNvbHMtNCBnYXAtMiI+CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9ImFyIiBkYXRhLWFyPSJwb3J0cmFpdCI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHg9IjYiIHk9IjIuNSIgd2lkdGg9IjEyIiBoZWlnaHQ9IjE5IiByeD0iMi41IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiLz48L3N2Zz48L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLW5hbWUiPlBvcnRyYWl0PC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1kZXNjIj43Njh4MTE1Mjwvc3Bhbj4KICAgICAgICAgICAgPC9idXR0b24+CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9ImFyIiBkYXRhLWFyPSJsYW5kc2NhcGUiPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1pY28iPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj48cmVjdCB4PSIyLjUiIHk9IjYiIHdpZHRoPSIxOSIgaGVpZ2h0PSIxMiIgcng9IjIuNSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMS42Ii8+PC9zdmc+PC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5MYW5kc2NhcGU8L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWRlc2MiPjExNTJ4NzY4PC9zcGFuPgogICAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYXIiIGRhdGEtYXI9InNxdWFyZSI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHg9IjIuNSIgeT0iMi41IiB3aWR0aD0iMTkiIGhlaWdodD0iMTkiIHJ4PSIyLjUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjEuNiIvPjwvc3ZnPjwvc3Bhbj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItbmFtZSI+U3F1YXJlPC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1kZXNjIj4xMDI0eDEwMjQ8L3NwYW4+CiAgICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJhciBzZWwiIGRhdGEtYXI9ImN1c3RvbSI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxwYXRoIGQ9Ik00IDhoNU0xMyA4aDdNNCAxNmg5TTE3IDE2aDNNOSA1LjV2NU0xNyAxMy41djUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+PC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5jdXN0b208L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWRlc2MiPmN1c3RvbTwvc3Bhbj4KICAgICAgICAgICAgPC9idXR0b24+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBtdC0xLjUiIGlkPSJhci1sYWJlbCI+Y3VzdG9tPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiBpdGVtcy1jZW50ZXIiPjxzcGFuPldpZHRoPC9zcGFuPgogICAgICAgICAgICA8aW5wdXQgaWQ9Ind2IiB0eXBlPSJudW1iZXIiIG1pbj0iMjU2IiBtYXg9IjE1MzYiIHN0ZXA9IjY0IiB2YWx1ZT0iNzY4IiBjbGFzcz0id3ZudW0iLz48L2xhYmVsPgogICAgICAgICAgPGlucHV0IGlkPSJ3aWR0aCIgdHlwZT0icmFuZ2UiIG1pbj0iMjU2IiBtYXg9IjE1MzYiIHN0ZXA9IjY0IiB2YWx1ZT0iNzY4IiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIGl0ZW1zLWNlbnRlciI+PHNwYW4+SGVpZ2h0PC9zcGFuPgogICAgICAgICAgICA8aW5wdXQgaWQ9Imh2IiB0eXBlPSJudW1iZXIiIG1pbj0iMjU2IiBtYXg9IjE1MzYiIHN0ZXA9IjY0IiB2YWx1ZT0iMTE1MiIgY2xhc3M9Ind2bnVtIi8+PC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCBpZD0iaGVpZ2h0IiB0eXBlPSJyYW5nZSIgbWluPSIyNTYiIG1heD0iMTUzNiIgc3RlcD0iNjQiIHZhbHVlPSIxMTUyIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIj4KICAgICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQteHMiPlNhbXBsaW5nIE1ldGhvZDwvc3Bhbj4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0iYWR2LXRvZ2dsZSIgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBob3Zlcjp0ZXh0LXdoaXRlIGZsZXggaXRlbXMtY2VudGVyIGdhcC0xIj48aSBkYXRhLWljb249ImNhcmV0LWRvd24iIGNsYXNzPSJ3LTMuNSBoLTMuNSI+PC9pPkFkdmFuY2VkPC9idXR0b24+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZ3JpZC1jb2xzLTIgZ2FwLTIgbXQtMSI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWwgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAiPlNhbXBsZXI8L2xhYmVsPgogICAgICAgICAgICAgIDxzZWxlY3QgaWQ9InNhbXBsZXIiIGNsYXNzPSJpbnAgdGV4dC14cyI+CiAgICAgICAgICAgICAgICA8b3B0aW9uPkV1bGVyIGE8L29wdGlvbj48b3B0aW9uPkV1bGVyPC9vcHRpb24+PG9wdGlvbj5MTVM8L29wdGlvbj48b3B0aW9uPkxNUyBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRESU08L29wdGlvbj48b3B0aW9uPkxDTTwvb3B0aW9uPjxvcHRpb24+SGV1bjwvb3B0aW9uPjxvcHRpb24+RFBNIGZhc3Q8L29wdGlvbj48b3B0aW9uPkRQTTI8L29wdGlvbj48b3B0aW9uPkRQTTIgYTwvb3B0aW9uPjxvcHRpb24+RFBNMiBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTTIgYSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJTIGE8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNPC9vcHRpb24+PG9wdGlvbj5EUE0rKyBTREU8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJTIGEgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIFNERSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNERSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPlJlc3RhcnQ8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNERSBFeHBvbmVudGlhbDwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0RFIEhldW48L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNERSBIZXVuIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0RFIEhldW4gRXhwb25lbnRpYWw8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNHTSBVbmlmb3JtPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAzTSBTREU8L29wdGlvbj48b3B0aW9uPkRQTSsrIDNNIFNERSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIDNNIFNERSBFeHBvbmVudGlhbDwvb3B0aW9uPjxvcHRpb24+ZXVsZXJfZHk8L29wdGlvbj48b3B0aW9uPmV1bGVyX3NtZWFfZHk8L29wdGlvbj4KICAgICAgICAgICAgICA8L3NlbGVjdD48L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+U2NoZWR1bGVyPC9sYWJlbD4KICAgICAgICAgICAgICA8c2VsZWN0IGlkPSJzY2hlZCIgY2xhc3M9ImlucCB0ZXh0LXhzIj48b3B0aW9uPm5vcm1hbDwvb3B0aW9uPjxvcHRpb24+c2ltcGxlPC9vcHRpb24+PG9wdGlvbj5rYXJyYXM8L29wdGlvbj48b3B0aW9uPmV4cG9uZW50aWFsPC9vcHRpb24+PG9wdGlvbj5zZ21fdW5pZm9ybTwvb3B0aW9uPjxvcHRpb24+ZGRpbV91bmlmb3JtPC9vcHRpb24+PG9wdGlvbj5iZXRhPC9vcHRpb24+PG9wdGlvbj5saW5lYXJfcXVhZHJhdGljPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+CiAgICAgICAgICA8L2Rpdj4KPGRpdiBjbGFzcz0ic3BhY2UteS0zIG10LTMiPgogICAgICAgICAgICA8ZGl2PgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2FtcGxpbmcgU3RlcHM8L3NwYW4+PHNwYW4gaWQ9InN2IiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MTA8L3NwYW4+PC9sYWJlbD4KICAgICAgICAgICAgICA8aW5wdXQgaWQ9InN0ZXBzIiB0eXBlPSJyYW5nZSIgbWluPSIxIiBtYXg9IjUwIiB2YWx1ZT0iMTAiIGNsYXNzPSJzbGlkZXIgbXQtMSIvPgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgPGRpdj4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNGRyBTY2FsZTwvc3Bhbj48c3BhbiBpZD0iY2Z2IiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MTwvc3Bhbj48L2xhYmVsPgogICAgICAgICAgICAgIDxpbnB1dCBpZD0iY2ZnIiB0eXBlPSJyYW5nZSIgbWluPSIxIiBtYXg9IjEwIiBzdGVwPSIwLjUiIHZhbHVlPSIxIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIGl0ZW1zLWNlbnRlciI+PHNwYW4+U2VlZDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1bMTBweF0gdGV4dC1uZXV0cmFsLTYwMCI+UmFuZG9tPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBnYXAtMS41IG10LTEiPgogICAgICAgICAgICAgICAgPGlucHV0IGlkPSJzZWVkIiBjbGFzcz0iaW5wIHRleHQteHMgZmxleC0xIiB2YWx1ZT0iMTAxMDkzMzM0Nzk0MzQ2MiIvPgogICAgICAgICAgICAgICAgPGJ1dHRvbiBpZD0iZGljZSIgY2xhc3M9InctOCBoLTggcm91bmRlZC1sZyBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBzaHJpbmstMCBib3JkZXIgYmQgYmctWyMxYzIxMjhdIHRleHQtbmV1dHJhbC0zMDAgaG92ZXI6dGV4dC13aGl0ZSBob3Zlcjpib3JkZXItWyM2RjVERkZdIiB0aXRsZT0iQWNhayBzZWVkIj48aSBkYXRhLWljb249ImRpY2UtZml2ZSIgY2xhc3M9InctNCBoLTQiPjwvaT48L2J1dHRvbj4KICAgICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgaWQ9ImFkdi1maWVsZHMiIGNsYXNzPSJoaWRkZW4gc3BhY2UteS0zIG10LTQgYm9yZGVyLXQgYmQgcHQtMyI+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DbGlwIFNraXA8L3NwYW4+PHNwYW4gaWQ9ImNzdiIgY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPjI8L3NwYW4+PC9sYWJlbD4KICAgICAgICAgICAgICA8aW5wdXQgaWQ9ImNsaXBza2lwIiB0eXBlPSJyYW5nZSIgbWluPSIxIiBtYXg9IjEyIiB2YWx1ZT0iMiIgY2xhc3M9InNsaWRlciBtdC0xIi8+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8ZGl2PgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+RU5TRDwvc3Bhbj48c3BhbiBpZD0iZW5zZCIgY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPjMxMzM3PC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGlucHV0IGlkPSJldGFuc2QiIHR5cGU9InJhbmdlIiBtaW49IjAiIG1heD0iMzEzMzciIHZhbHVlPSIzMTMzNyIgY2xhc3M9InNsaWRlciBtdC0xIi8+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CgogICAgICAgIDwhLS0gVXBzY2FsZSAoc2VwYXJhdGUsIGRpIGJhd2FoKSAtLT4KICAgICAgICA8ZGl2IGNsYXNzPSJtdC00Ij4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiBpdGVtcy1jZW50ZXIiPjxzcGFuPlVwc2NhbGU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPjJ4PC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgaWQ9InVwc2NhbGUiIHR5cGU9InJhbmdlIiBtaW49IjEiIG1heD0iNCIgc3RlcD0iMC41IiB2YWx1ZT0iMiIgY2xhc3M9InNsaWRlciBtdC0xIi8+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBBUEkgU2V0dGluZ3MgLS0+CiAgICAgIDxkaXYgY2xhc3M9ImJvcmRlciBiZCByb3VuZGVkLXhsIGJnLVsjMWMyMTI4XSBwLTMgc3BhY2UteS0yIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4iPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+QVBJPC9zcGFuPgogICAgICAgICAgPHNwYW4gaWQ9ImFwaS1zdGF0dXMiIGNsYXNzPSJ0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNTAwIj48L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIj5Qcm92aWRlcjwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJhcGlwcm92aWRlciIgY2xhc3M9ImlucCB0ZXh0LXhzIj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0idGFtcyI+VGVuc29yLkFydCAoVEFNUyk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icmVwbGljYXRlIj5SZXBsaWNhdGUgKFNEWEwpPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImZhbCI+ZmFsLmFpIChmYXN0LXNkeGwpPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9InBvbGxpbmF0aW9ucyI+UG9sbGluYXRpb25zIChHUkFUSVMsIHRhbnBhIGtleSk8L29wdGlvbj4KICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBpZD0iYXBpa2V5LWZpZWxkIj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCIgaWQ9ImFwaWtleS1sYWJlbCI+QVBJIEtleSBUQU1TICh0YW1zLnRlbnNvci5hcnQpPC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCBpZD0iYXBpa2V5IiB0eXBlPSJwYXNzd29yZCIgY2xhc3M9ImlucCIgcGxhY2Vob2xkZXI9IkJlYXJlciB0b2tlbi4uLiIgYXV0b2NvbXBsZXRlPSJvZmYiLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8IS0tIEJZT1AgUG9sbGluYXRpb25zOiBsb2dpbiBPQXV0aCAoYnVrYW4ga29sb20gQVBJIGtleSkgLS0+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQgaGlkZGVuIiBpZD0iYnlvcC1yb3ciPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIj5Mb2dpbiBQb2xsaW5hdGlvbnM8L2xhYmVsPgogICAgICAgICAgPGJ1dHRvbiBpZD0iYnlvcC1sb2dpbiIgY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOCBib3JkZXIgYmQgdGV4dC14cyBqdXN0aWZ5LWNlbnRlciI+TG9naW4gZGVuZ2FuIFBvbGxpbmF0aW9ucyAoQllPUCk8L2J1dHRvbj4KICAgICAgICAgIDxkaXYgaWQ9ImJ5b3Atc3RhdHVzIiBjbGFzcz0iaGlkZGVuIHRleHQtWzEwcHhdIHRleHQtbmV1dHJhbC01MDAgbXQtMSI+PC9kaXY+CiAgICAgICAgICA8YnV0dG9uIGlkPSJieW9wLWxvZ291dCIgY2xhc3M9ImhpZGRlbiBidG4gYnRuLWdob3N0IHctZnVsbCBoLTggYm9yZGVyIGJkIHRleHQteHMganVzdGlmeS1jZW50ZXIgbXQtMSI+TG9nb3V0PC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBpZD0iYXBpLWhpbnQiIGNsYXNzPSJ0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNjAwIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAiPk1vZGU8L2xhYmVsPgogICAgICAgICAgPHNlbGVjdCBpZD0iYXBpbW9kZSIgY2xhc3M9ImlucCB0ZXh0LXhzIj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYXV0byI+QXV0byAoYmFja2VuZCAmcmFycjsgZGVtbyk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icmVhbCI+UmVhbCBBUEkgKHdhamliIGJhY2tlbmQpPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImRlbW8iPkRlbW8gKHNpbXVsYXNpIHNhamEpPC9vcHRpb24+CiAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGdhcC0yIj4KICAgICAgICAgIDxidXR0b24gaWQ9ImFwaS1zYXZlIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBmbGV4LTEgaC04IGJvcmRlciBiZCB0ZXh0LXhzIj5TaW1wYW48L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gaWQ9ImFwaS10ZXN0IiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBmbGV4LTEgaC04IGJvcmRlciBiZCB0ZXh0LXhzIj5UZXM8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIEJvdHRvbSAtLT4KICAgICAgPGRpdiBjbGFzcz0icHQtMSBib3JkZXItdCBiZCBzcGFjZS15LTIiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOSBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlBhc3RlIEdlbmVyYXRpb24gRGF0YTwvc3Bhbj48aSBkYXRhLWljb249ImNsaXBib2FyZCIgY2xhc3M9InctNCBoLTQiPjwvaT48L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IHctZnVsbCBoLTkganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5QcmVzZXRzPC9zcGFuPjxpIGRhdGEtaWNvbj0iYm9va21hcmstc2ltcGxlIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOSBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlJlc2V0PC9zcGFuPjxpIGRhdGEtaWNvbj0ia2V5IiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvYXNpZGU+CgogIDwhLS0gQ0VOVEVSOiBpbWFnZSBncmlkIG9ubHkgLS0+CiAgPG1haW4gaWQ9ImNhbnZhcyIgY2xhc3M9ImZsZXgtMSBvdmVyZmxvdy15LWF1dG8gb3ZlcmZsb3cteC1oaWRkZW4gYmctWyMwZDExMTddIj4KICAgIDxkaXYgY2xhc3M9InAtNCBtYXgtdy0zeGwgbXgtYXV0byI+CgogICAgICA8IS0tIFByb21wdCBiYXIgKFRlbnNvci5BcnQ6IGRpIHRlbmdhaCBhdGFzLCBkaSBhdGFzIGdyaWQgZ2FtYmFyKSAtLT4KICAgICAgPGRpdiBpZD0icHJvbXB0YmFyIiBjbGFzcz0ibWItNCByb3VuZGVkLTJ4bCBib3JkZXIgYmQgYmctWyMxNjFiMjJdIG92ZXJmbG93LWhpZGRlbiI+CiAgICAgICAgPGRpdiBjbGFzcz0icmVsYXRpdmUgcHgtNCBwdC0zIj4KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0icHJvbXB0IiByb3dzPSIzIiBjbGFzcz0idy1mdWxsIGJnLXRyYW5zcGFyZW50IGJvcmRlci0wIG91dGxpbmUtbm9uZSByZXNpemUteSB0ZXh0LVsxNXB4XSB0ZXh0LW5ldXRyYWwtMTAwIHBsYWNlaG9sZGVyLW5ldXRyYWwtNjAwIGxlYWRpbmctcmVsYXhlZCBwci0xMiBtaW4taC1bNC41cmVtXSIgcGxhY2Vob2xkZXI9IkplbGFza2FuIGFwYSB5YW5nIGluZ2luIGthbXUgYnVhdC4uLiI+PC90ZXh0YXJlYT4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFic29sdXRlIHRvcC0zIHJpZ2h0LTMgZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTAuNSI+CiAgICAgICAgICAgIDxidXR0b24gaWQ9ImJ0bi10cmFuc2xhdGUiIGNsYXNzPSJ3LTcgaC03IHJvdW5kZWQtbGcgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC1uZXV0cmFsLTQwMCBob3Zlcjp0ZXh0LXdoaXRlIGhvdmVyOmJnLVsjMjEyNjJkXSB0cmFuc2l0aW9uLWNvbG9ycyIgdGl0bGU9IlRlcmplbWFoa2FuIHByb21wdCBrZSBiYWhhc2EgSW5nZ3JpcyAoc2VtdWEgYmFoYXNhKSI+PGkgZGF0YS1pY29uPSJ0cmFuc2xhdGUiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9idXR0b24+CiAgICAgICAgICAgIDxidXR0b24gaWQ9ImJ0bi1lbmhhbmNlIiBjbGFzcz0idy03IGgtNyByb3VuZGVkLWxnIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHRleHQtbmV1dHJhbC00MDAgaG92ZXI6dGV4dC13aGl0ZSBob3ZlcjpiZy1bIzIxMjYyZF0gdHJhbnNpdGlvbi1jb2xvcnMiIHRpdGxlPSJQcm9tcHQgRW5oYW5jZSDigJQgcGVybHVhcyAmIHBlcmJhaWtpIHByb21wdCBkZW5nYW4gQUkiPjxpIGRhdGEtaWNvbj0ibWFnaWMtd2FuZCIgY2xhc3M9InctNCBoLTQiPjwvaT48L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMiBmbGV4LXdyYXAgcHgtMyBweS0yIGJvcmRlci10IGJkIj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSBjdXJzb3ItcG9pbnRlciBzZWxlY3Qtbm9uZSI+CiAgICAgICAgICAgIDxpbnB1dCBpZD0ibmVnY2hlY2siIHR5cGU9ImNoZWNrYm94IiBjbGFzcz0iYWNjZW50LVsjNkY1REZGXSIvPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNDAwIj5OZWdhdGl2ZTwvc3Bhbj4KICAgICAgICAgIDwvbGFiZWw+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMiBmbGV4LXdyYXAganVzdGlmeS1lbmQiPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0iY2hpcCIgaWQ9ImNoaXAtYTExMTEiPkExMTExPC9zcGFuPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0iY2hpcCIgaWQ9ImNoaXAtZWxsYSI+RWxsYTwvc3Bhbj4KICAgICAgICAgICAgPHNlbGVjdCBpZD0ibmNvdW50IiBjbGFzcz0iaW5wIHctWzUuNHJlbV0gdGV4dC14cyBoLTgiIHRpdGxlPSJKdW1sYWggZ2FtYmFyIj4KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIxIiBzZWxlY3RlZD4xIGltYWdlPC9vcHRpb24+CiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iMiI+MiBpbWFnZXM8L29wdGlvbj4KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSI0Ij40IGltYWdlczwvb3B0aW9uPgogICAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0iYnRuLWdvIiBjbGFzcz0iYnRuIGJ0bi10dXJxIGgtOSBweC00IHdoaXRlc3BhY2Utbm93cmFwIj4KICAgICAgICAgICAgICA8aSBkYXRhLWljb249ImxpZ2h0bmluZyIgY2xhc3M9InctNCBoLTQiPjwvaT5HZW5lcmF0ZQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIG9wYWNpdHktOTAgZm9udC1ub3JtYWwiIGlkPSJwcmljZSI+LSAxLjIyPC9zcGFuPgogICAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgaWQ9Im5lZ3dyYXAiIGNsYXNzPSJoaWRkZW4gYm9yZGVyLXQgYmQgcHgtNCBweS0zIj4KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0ibmVncHJvbXB0IiByb3dzPSIyIiBjbGFzcz0idy1mdWxsIGJnLXRyYW5zcGFyZW50IGJvcmRlci0wIG91dGxpbmUtbm9uZSByZXNpemUtbm9uZSB0ZXh0LVsxM3B4XSB0ZXh0LW5ldXRyYWwtMTAwIHBsYWNlaG9sZGVyLW5ldXRyYWwtNjAwIiBwbGFjZWhvbGRlcj0iTmVnYXRpdmUgcHJvbXB0Li4uIj48L3RleHRhcmVhPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDwhLS0gSW1nMkltZyB1cGxvYWQgLS0+CiAgICAgIDxkaXYgaWQ9ImltZzJpbWctY2FyZCIgY2xhc3M9ImhpZGRlbiBtYi00IGJvcmRlciBiZCByb3VuZGVkLXhsIGJnLVsjMTYxYjIyXSBwLTQiPgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBtYi0yIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPkltZzJJbWcg4oCUIGdhbWJhciBhd2FsPC9zcGFuPgogICAgICAgICAgPHNwYW4gaWQ9ImkyaS1jbGVhciIgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBob3Zlcjp0ZXh0LXdoaXRlIGN1cnNvci1wb2ludGVyIj5IYXB1czwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJpMmktZHJvcCIgY2xhc3M9ImJvcmRlci0yIGJvcmRlci1kYXNoZWQgYmQgcm91bmRlZC14bCBwLTYgdGV4dC1jZW50ZXIgY3Vyc29yLXBvaW50ZXIgdGV4dC1uZXV0cmFsLTUwMCBob3Zlcjpib3JkZXItWyM2RjVERkZdIHRleHQteHMiPgogICAgICAgICAgS2xpayBhdGF1IHNlcmV0IGdhbWJhciBrZSBzaW5pCiAgICAgICAgPC9kaXY+CiAgICAgICAgPGlucHV0IGlkPSJpMmktZmlsZSIgdHlwZT0iZmlsZSIgYWNjZXB0PSJpbWFnZS8qIiBjbGFzcz0iaGlkZGVuIi8+CiAgICAgICAgPGRpdiBpZD0iaTJpLXByZXZpZXciIGNsYXNzPSJoaWRkZW4gbXQtMyI+CiAgICAgICAgICA8aW1nIGlkPSJpMmktaW1nIiBjbGFzcz0idy00MCBoLTQwIG9iamVjdC1jb3ZlciByb3VuZGVkLWxnIGJvcmRlciBiZCIgYWx0PSIiLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtdC0zIj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+RGVub2lzaW5nIFN0cmVuZ3RoPC9zcGFuPjxzcGFuIGlkPSJpMmktZHN2IiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MC41MDwvc3Bhbj48L2xhYmVsPgogICAgICAgICAgPGlucHV0IGlkPSJpMmktZHMiIHR5cGU9InJhbmdlIiBtaW49IjAiIG1heD0iMSIgc3RlcD0iMC4wNSIgdmFsdWU9IjAuNSIgY2xhc3M9InNsaWRlciBtdC0xIi8+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBUYWIgcGxhY2Vob2xkZXIgKEVkaXQvVmlkZW8vUHJpbWUpIC0tPgogICAgICA8ZGl2IGlkPSJ0YWItcGxhY2Vob2xkZXIiIGNsYXNzPSJoaWRkZW4gZmxleC1jb2wgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGgtWzUwdmhdIHRleHQtbmV1dHJhbC02MDAiPgogICAgICAgIDxpIGRhdGEtaWNvbj0iaG91cmdsYXNzLW1lZGl1bSIgY2xhc3M9InctMTIgaC0xMiBtYi0zIj48L2k+CiAgICAgICAgPHAgY2xhc3M9InRleHQtc20iIGlkPSJ0YWItcGxhY2Vob2xkZXItdGV4dCI+VGFiIGluaSBzZWdlcmEgaGFkaXI8L3A+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBpZD0iZW1wdHkiIGNsYXNzPSJmbGV4IGZsZXgtY29sIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBoLVs2MHZoXSB0ZXh0LW5ldXRyYWwtNjAwIj4KICAgICAgICA8aSBkYXRhLWljb249ImltYWdlLXNxdWFyZSIgY2xhc3M9InctMTQgaC0xNCBtYi0zIj48L2k+CiAgICAgICAgPHAgY2xhc3M9InRleHQtc20iPkhhc2lsIGdlbmVyYXRlIGFrYW4gdGFtcGlsIGRpIHNpbmk8L3A+CiAgICAgICAgPHAgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTcwMCBtdC0xIj5Jc2kgcHJvbXB0IGxhbHUgdGVrYW4gR2VuZXJhdGU8L3A+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGlkPSJncmlkIiBjbGFzcz0iZmxleCBmbGV4LWNvbCBpdGVtcy1jZW50ZXIgZ2FwLTMiPjwvZGl2PgogICAgPC9kaXY+CiAgPC9tYWluPgoKICA8IS0tIFJJR0hUIFBBTkVMIC0tPgogIDxhc2lkZSBpZD0icmlnaHRQYW4iIGNsYXNzPSJ3LVsyMXJlbV0gc2hyaW5rLTAgYm9yZGVyLWwgYmQgYmctWyMxNjFiMjJdIGhpZGRlbiBsZzpmbGV4IGZsZXgtY29sIj4KICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBweC0zIHB5LTIgYm9yZGVyLWIgYmQiPgogICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIiBpZD0icnB0aXRsZSI+VGV4dCB0byBJbWFnZTwvc3Bhbj4KICAgICAgPGRpdiBjbGFzcz0iZmxleCBnYXAtMSI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0icnRhYiBzZWwiIGRhdGEtcD0iZGV0YWlsIj5EZXRhaWw8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJydGFiIiBkYXRhLXA9Imhpc3RvcnkiPlJpd2F5YXQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDwhLS0gRGV0YWlsIGhhc2lsIGFrdGlmIChzZXBlcnRpIFRlbnNvci5BcnQ6IElucHV0ICsgRGV0YWlscyArIHBhcmFtcykgLS0+CiAgICA8ZGl2IGlkPSJyZGV0YWlsIiBjbGFzcz0iZmxleC0xIG92ZXJmbG93LXktc2Nyb2xsIHAtMyBzcGFjZS15LTMiPjwvZGl2PgogICAgPCEtLSBSaXdheWF0IGdlbmVyYXRlIChrYXJ0dSkgLS0+CiAgICA8ZGl2IGlkPSJyaGlzdG9yeSIgY2xhc3M9ImhpZGRlbiBmbGV4LTEgb3ZlcmZsb3cteS1zY3JvbGwgcC0yIHNwYWNlLXktMyI+CiAgICAgIDxwIGlkPSJyY291bnQiIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgcHgtMSBwdC0xIj4wIGhhc2lsPC9wPgogICAgICA8ZGl2IGlkPSJybGlzdCIgY2xhc3M9InNwYWNlLXktMyI+PC9kaXY+CiAgICA8L2Rpdj4KICA8L2FzaWRlPgo8L2Rpdj4KCjwhLS0gTW9iaWxlIGhpc3RvcnkgdG9nZ2xlIC0tPgo8YnV0dG9uIGlkPSJidG4taGlzdG9yeSIgY2xhc3M9ImxnOmhpZGRlbiBmaXhlZCBib3R0b20tNCByaWdodC00IHotMzAgYnRuIGJ0bi1ibHVlIGgtMTEgcHgtNCI+PGkgZGF0YS1pY29uPSJjbG9jay1jb3VudGVyLWNsb2Nrd2lzZSIgY2xhc3M9InctNCBoLTQiPjwvaT4gUml3YXlhdDwvYnV0dG9uPgoKPCEtLSA9PT09PT09PT09PT0gUFJPR1JFU1MgT1ZFUkxBWSA9PT09PT09PT09PT0gLS0+CjxkaXYgaWQ9InByb2dvdmVybGF5IiBjbGFzcz0iaGlkZGVuIGZpeGVkIGluc2V0LTAgei0zMCBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBiZy1ibGFjay81MCBwLTQiIHN0eWxlPSJ0b3A6NTZweCI+CiAgPGRpdiBjbGFzcz0idy1mdWxsIG1heC13LXNtIGJnLVsjMTYxYjIyXSBib3JkZXIgYmQgcm91bmRlZC0yeGwgcC01IHNwYWNlLXktMyI+CiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4iPgogICAgICA8c3BhbiBpZD0icHJvZy10aXRsZSIgY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+R2VuZXJhdGluZy4uLjwvc3Bhbj4KICAgICAgPGJ1dHRvbiBpZD0icHJvZy1jYW5jZWwiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgdGV4dC1sZyBsZWFkaW5nLW5vbmUiIHRpdGxlPSJCYXRhbCI+4pyVPC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InJlbGF0aXZlIGgtMiBiZy1bIzFjMjEyOF0gcm91bmRlZC1mdWxsIG92ZXJmbG93LWhpZGRlbiI+CiAgICAgIDxkaXYgaWQ9InByb2ctYmFyIiBjbGFzcz0iYWJzb2x1dGUgaW5zZXQteS0wIGxlZnQtMCB3LTAgcm91bmRlZC1mdWxsIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiwjMjdENENEKTt0cmFuc2l0aW9uOndpZHRoIC40cyI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiB0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAiPgogICAgICA8c3BhbiBpZD0icHJvZy1zdGF0dXMiPk1lbmdpcmltIHRhc2suLi48L3NwYW4+CiAgICAgIDxzcGFuIGlkPSJwcm9nLXBjdCI+MCU8L3NwYW4+CiAgICA8L2Rpdj4KICA8L2Rpdj4KPC9kaXY+Cgo8IS0tID09PT09PT09PT09PSBMSUdIVEJPWCA9PT09PT09PT09PT0gLS0+CjxkaXYgaWQ9ImxpZ2h0Ym94IiBjbGFzcz0iZml4ZWQgaW5zZXQtMCB6LTUwIGhpZGRlbiBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcC00IGJnLWJsYWNrLzgwIj4KICA8ZGl2IGNsYXNzPSJyZWxhdGl2ZSBtYXgtdy0zeGwgdy1mdWxsIGJnLVsjMTYxYjIyXSBib3JkZXIgYmQgcm91bmRlZC0yeGwgb3ZlcmZsb3ctaGlkZGVuIj4KICAgIDxidXR0b24gaWQ9ImxiLWNsb3NlIiBjbGFzcz0iYWJzb2x1dGUgdG9wLTIgcmlnaHQtMiB6LTEwIHctOSBoLTkgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC13aGl0ZSBob3ZlcjpiZy13aGl0ZS8xMCByb3VuZGVkLWxnIHRleHQteGwiPuKclTwvYnV0dG9uPgogICAgPGltZyBpZD0ibGItaW1nIiBjbGFzcz0idy1mdWxsIG1heC1oLVs2MHZoXSBvYmplY3QtY29udGFpbiBiZy1ibGFjayIgYWx0PSIiLz4KICAgIDxkaXYgaWQ9ImxiLW1ldGEiIGNsYXNzPSJwLTQgc3BhY2UteS0xLjUgdGV4dC14cyB0ZXh0LW5ldXRyYWwtNDAwIG92ZXJmbG93LXktYXV0byBtYXgtaC1bMzB2aF0iPjwvZGl2PgogIDwvZGl2Pgo8L2Rpdj4KCjwhLS0gPT09PT09PT09PT09IFBST01QVCBFTkhBTkNFIChoYXNpbCByZWZpbmUsIGtvbmZpcm1hc2kgZHVsdSkgPT09PT09PT09PT09IC0tPgo8ZGl2IGlkPSJlbmgtbW9kYWwiIGNsYXNzPSJmaXhlZCBpbnNldC0wIHotNTAgaGlkZGVuIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBwLTQgYmctYmxhY2svNzAiPgogIDxkaXYgY2xhc3M9InctZnVsbCBtYXgtdy14bCBiZy1bIzE2MWIyMl0gYm9yZGVyIGJkIHJvdW5kZWQtMnhsIG92ZXJmbG93LWhpZGRlbiI+CiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gcHgtNCBweS0zIGJvcmRlci1iIGJkIj4KICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41Ij48aSBkYXRhLWljb249Im1hZ2ljLXdhbmQiIGNsYXNzPSJ3LTQgaC00IHRleHQtWyM2RjVERkZdIj48L2k+UHJvbXB0IEVuaGFuY2U8L3NwYW4+CiAgICAgIDxidXR0b24gaWQ9ImVuaC1jbG9zZSIgY2xhc3M9InctOCBoLTggZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC1uZXV0cmFsLTQwMCBob3Zlcjp0ZXh0LXdoaXRlIGhvdmVyOmJnLXdoaXRlLzUgcm91bmRlZC1sZyI+4pyVPC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InAtNCBzcGFjZS15LTMiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAgbWItMSI+UHJvbXB0IGFzbGk8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJlbmgtb3JpZyIgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTQwMCBiZy1ibGFjay80MCBib3JkZXIgYmQgcm91bmRlZC1sZyBwLTMgbWF4LWgtMjQgb3ZlcmZsb3cteS1hdXRvIGxlYWRpbmctcmVsYXhlZCI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAgbWItMSI+SGFzaWwgRW5oYW5jZSA8c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTYwMCI+KGJpc2EgZGllZGl0KTwvc3Bhbj48L2Rpdj4KICAgICAgICA8dGV4dGFyZWEgaWQ9ImVuaC10ZXh0IiByb3dzPSI1IiBjbGFzcz0idy1mdWxsIGJnLWJsYWNrLzQwIGJvcmRlciBiZCByb3VuZGVkLWxnIHAtMyB0ZXh0LXhzIHRleHQtbmV1dHJhbC0xMDAgb3V0bGluZS1ub25lIHJlc2l6ZS1ub25lIGZvY3VzOmJvcmRlci1bIzZGNURGRl0gbGVhZGluZy1yZWxheGVkIj48L3RleHRhcmVhPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0yIj4KICAgICAgICA8YnV0dG9uIGlkPSJlbmgtcmVnZW4iIGNsYXNzPSJidG4gYnRuLWdob3N0IGgtOSBweC0zIHRleHQteHMiPjxpIGRhdGEtaWNvbj0iYXJyb3dzLWNsb2Nrd2lzZSIgY2xhc3M9InctMy41IGgtMy41Ij48L2k+R2VuZXJhdGUgbGFnaTwvYnV0dG9uPgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggZ2FwLTIiPgogICAgICAgICAgPGJ1dHRvbiBpZD0iZW5oLWNhbmNlbCIgY2xhc3M9ImJ0biBidG4tZ2hvc3QgaC05IHB4LTQgdGV4dC14cyI+QmF0YWw8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gaWQ9ImVuaC11c2UiIGNsYXNzPSJidG4gYnRuLWJsdWUgaC05IHB4LTQgdGV4dC14cyI+UGFrYWkgcHJvbXB0IGluaTwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvZGl2Pgo8L2Rpdj4KCjwhLS0gPT09PT09PT09PT09IFRPQVNUID09PT09PT09PT09PSAtLT4KPGRpdiBpZD0idG9hc3QiIGNsYXNzPSJmaXhlZCBib3R0b20tMjAgbGVmdC0xLzIgLXRyYW5zbGF0ZS14LTEvMiB6LTUwIGhpZGRlbiBiZy1bIzFjMjEyOF0gYm9yZGVyIGJkIHJvdW5kZWQteGwgcHgtNCBweS0yLjUgdGV4dC1zbSBzaGFkb3ctbGcgbWF4LXctWzg1dnddIj48L2Rpdj4KCjwhLS0gPT09PT09PT09PT09IFNFTEVDVE9SIE1PREFMID09PT09PT09PT09PSAtLT4KPGRpdiBpZD0ibW9kYWwiIGNsYXNzPSJmaXhlZCBpbnNldC0wIGJnLWJsYWNrLzYwIHotNTAgaGlkZGVuIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBwLTQiPgogIDxkaXYgY2xhc3M9InctZnVsbCBtYXgtdy01eGwgYmctWyMxNjFiMjJdIGJvcmRlciBiZCByb3VuZGVkLTJ4bCBvdmVyZmxvdy1oaWRkZW4iPgogICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIHB4LTQgcHQtMyBwYi0yIGJvcmRlci1iIGJkIj4KICAgICAgPGRpdiBpZD0ibW9kYWwtdGFicyIgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xIj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJtdGFiIHNlbCIgZGF0YS1tdGFiPSJiYXNpYyI+QmFzaWMgTW9kZWw8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJtdGFiIiBkYXRhLW10YWI9InN0YXJyZWQiPk15IFN0YXJyZWQ8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJtdGFiIiBkYXRhLW10YWI9Im15bW9kZWxzIj5NeSBNb2RlbHM8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0yIj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWxhdGl2ZSI+CiAgICAgICAgICA8aSBkYXRhLWljb249Im1hZ25pZnlpbmctZ2xhc3MiIGNsYXNzPSJ3LTQgaC00IGFic29sdXRlIGxlZnQtMyB0b3AtMS8yIC10cmFuc2xhdGUteS0xLzIgdGV4dC1uZXV0cmFsLTUwMCI+PC9pPgogICAgICAgICAgPGlucHV0IGlkPSJtc2VhcmNoIiBjbGFzcz0iaW5wIHBsLTkgdy01NiBoLTkiIHBsYWNlaG9sZGVyPSJTZWFyY2guLi4iLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8YnV0dG9uIGlkPSJtZmlsdGVycyIgY2xhc3M9ImJ0biBidG4tZ2hvc3QgaC05IHB4LTMgYm9yZGVyIGJkIHRleHQteHMgc2hyaW5rLTAiPjxpIGRhdGEtaWNvbj0ic2xpZGVycy1ob3Jpem9udGFsIiBjbGFzcz0idy00IGgtNCI+PC9pPkZpbHRlcnM8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGlkPSJtb2RhbC1jbG9zZSIgY2xhc3M9InctOSBoLTkgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC13aGl0ZSBob3ZlcjpiZy1bIzFjMjEyOF0gcm91bmRlZC1sZyB0ZXh0LXhsIGxlYWRpbmctbm9uZSIgdGl0bGU9IlR1dHVwIj7inJU8L2J1dHRvbj4KICAgICAgICA8aDMgaWQ9Im1vZGFsLXRpdGxlIiBjbGFzcz0iaGlkZGVuIGZvbnQtc2VtaWJvbGQgdGV4dC1zbSI+UGlsaWggTW9kZWw8L2gzPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0ibWNhdCIgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUgcHgtNCBweS0yIGhpZGViYXIgb3ZlcmZsb3cteC1hdXRvIj48L2Rpdj4KICAgIDxkaXYgaWQ9Im1vZGFsLWJvZHkiIGNsYXNzPSJtYXgtaC1bNTV2aF0gb3ZlcmZsb3cteS1hdXRvIHAtNCI+PC9kaXY+CiAgPC9kaXY+CjwvZGl2PgoKCjxzY3JpcHQ+CmNvbnN0ICQgPSBpZCA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CmNvbnN0IFMgPSAnaHR0cHM6Ly9waWNzdW0ucGhvdG9zL3NlZWQvJzsKY29uc3Qgc3RhdGUgPSB7IHJlc3VsdHM6W10sIHBhZ2U6J3RleHQnLCBhc3BlY3Q6J3BvcnRyYWl0JywgbmNvbDoxLCBtb2RlbDpudWxsIH07CgovKiA9PT09PSBMb1JBIOKAlCBkYWZ0YXIgYXNsaSBwZXIgcHJvdmlkZXIgPT09PT0gKi8KdmFyIExPUkFfTElCUyA9IHsKICB0YW1zOiBbCiAgICB7IG5hbWU6J1otSW1hZ2UgTG9SQSB8IERldGFpbCcsIHRhZ3M6WydkZXRhaWxlZCcsJ3NoYXJwJ10sIHRodW1iOidhZnJvJywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMTJLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sCiAgICB7IG5hbWU6J1otSW1hZ2UgVHVyYm8nLCB0YWdzOlsndHVyYm8nLCdmYXN0J10sIHRodW1iOidyZXRybycsIGJhZGdlOidaLUlNQUdFLVRVUkJPJywgdmlld3M6JzhLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sCiAgICB7IG5hbWU6J1otSW1hZ2UgSERSJywgdGFnczpbJ2hkcicsJ3ZpdmlkJ10sIHRodW1iOidoZHInLCBiYWRnZTonWi1JTUFHRScsIHZpZXdzOicxNUsnLCB2ZXI6J1YxJywgYmFzZTonWiBJbWFnZScgfSwKICAgIHsgbmFtZTonWi1JbWFnZSBQb3J0cmFpdCcsIHRhZ3M6Wydwb3J0cmFpdCcsJ2Jva2VoJ10sIHRodW1iOidwdHJ0JywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMjJLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sCiAgICB7IG5hbWU6J1otSW1hZ2UgQXJ0aXN0aWMnLCB0YWdzOlsnYXJ0aXN0aWMnLCdwYWludCddLCB0aHVtYjonYXJ0JywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMThLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sCiAgICB7IG5hbWU6J0ZsdXggUmVhbGlzbSBMb1JBJywgdGFnczpbJ3JlYWxpc3RpYycsJ3Bob3RvJ10sIHRodW1iOidmbHV4bCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzQ1SycsIHZlcjonVjEnLCBiYXNlOidGTFVYLjEnIH0sCiAgICB7IG5hbWU6J0ZsdXggQ2luZW1hdGljIExvUkEnLCB0YWdzOlsnY2luZW1hdGljJywnbW9vZHknXSwgdGh1bWI6J2ZsdXhjJywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonMzNLJywgdmVyOidWMScsIGJhc2U6J0ZMVVguMScgfSwKICAgIHsgbmFtZTonU0RYTCBGaW5lIERldGFpbCcsIHRhZ3M6WydkZXRhaWxlZCcsJ3NoYXJwJ10sIHRodW1iOidkZXRhaWwnLCBiYWRnZTonU0RYTCcsIHZpZXdzOic1MDBLJywgdmVyOidWMScsIGJhc2U6J1NEWEwnIH0sCiAgICB7IG5hbWU6J1NEWEwgQW5pbWUgU3R5bGUnLCB0YWdzOlsnYW5pbWUnLCdjZWwnXSwgdGh1bWI6J2FuaW1lc2wnLCBiYWRnZTonU0RYTCcsIHZpZXdzOicyODBLJywgdmVyOidWMScsIGJhc2U6J1NEWEwnIH0sCiAgICB7IG5hbWU6J1BvbnkgRXF1ZXN0cmlhbiBBcnQnLCB0YWdzOlsncG9ueScsJ2ZhbnRhc3knXSwgdGh1bWI6J3BvbnlsJywgYmFkZ2U6J1BPTlknLCB2aWV3czonMTUwSycsIHZlcjonVjEnLCBiYXNlOidQb255JyB9LAogICAgeyBuYW1lOidOaXBwb24tQ29yZSBSZXRybyAtIHYwLjEnLCB0YWdzOlsnamFwcmV0cjdjb21tJywncmV0cm8gbWFnYXppbmUnXSwgdGh1bWI6J2JpbGliaW4nLCBiYWRnZTonU1RZTEUnLCB2aWV3czonOTZLJywgdmVyOidWLjEnLCBiYXNlOidTRFhMJyB9LAogICAgeyBuYW1lOidJdmFuIEJpbGliaW4gLSB2MC43JywgdGFnczpbJ2l2YW5iaWxpYmluNXonLCdpbGx1c3RyYXRpb24nLCdhcnQgZGVjbyddLCB0aHVtYjonZGV0YWlsJywgYmFkZ2U6J0lMTFVTVFJBVElPTicsIHZpZXdzOicxNTRLJywgdmVyOidWLjEnLCBiYXNlOidTRFhMJyB9LAogICAgeyBuYW1lOidEZXRhaWwgVHdlYWtlciAtIHYxLjAnLCB0YWdzOlsnZGV0YWlsZWQnXSwgdGh1bWI6J2dyYWluJywgYmFkZ2U6J1VUSUxJVFknLCB2aWV3czonMS4yTScsIHZlcjonVi4xJywgYmFzZTonU0RYTCcgfSwKICAgIHsgbmFtZTonRmlsbSBHcmFpbiAtIHYwLjUnLCB0YWdzOlsnZmlsbSBncmFpbicsJ2FuYWxvZyddLCB0aHVtYjonZ3JhaW4nLCBiYWRnZTonVVRJTElUWScsIHZpZXdzOic2N0snLCB2ZXI6J1YuMScsIGJhc2U6J1NEWEwnIH0sCiAgXSwKICByZXBsaWNhdGU6IFsKICAgIHsgbmFtZTonRkxVWC4xIFtzY2huZWxsXSBMb1JBJywgYmFzZTonRkxVWCcsIG1vZGVsOidibGFjay1mb3Jlc3QtbGFicy9mbHV4LXNjaG5lbGwtbG9yYScsIHRhZ3M6WydmbHV4LWxvcmEnXSwgdGh1bWI6J2ZsdXhsJywgYmFkZ2U6J0ZMVVgtTE9SQScsIHZpZXdzOicxMjBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogICAgeyBuYW1lOidGTFVYLjEgW2Rldl0gTG9SQScsIGJhc2U6J0ZMVVgnLCBtb2RlbDonYmxhY2stZm9yZXN0LWxhYnMvZmx1eC1kZXYtbG9yYScsIHRhZ3M6WydmbHV4LWxvcmEnXSwgdGh1bWI6J2ZsdXhkbCcsIGJhZGdlOidGTFVYLUxPUkEnLCB2aWV3czonOTBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogICAgeyBuYW1lOidTRFhMICsgTG9SQSBVUkwgKGN1c3RvbSknLCBiYXNlOidTRFhMJywgbW9kZWw6J3p5bGltMDcwMi9zZHhsLWxvcmEtY3VzdG9taXplLW1vZGVsJywgdGFnczpbJ2xvcmEnXSwgdGh1bWI6J3NkeGxsJywgYmFkZ2U6J1NEWEwtTE9SQScsIHZpZXdzOiczMTBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogICAgeyBuYW1lOidJS0VBIEluc3RydWN0aW9ucyAoU0RYTCwgYmF3YWFuKScsIGJhc2U6J1NEWEwnLCBtb2RlbDonb3N0cmlzL2lrZWEtaW5zdHJ1Y3Rpb25zLWxvcmEtc2R4bCcsIHRhZ3M6Wydpa2VhIGluc3RydWN0aW9ucyddLCB0aHVtYjonaWtlYScsIGJhZGdlOidTVFlMRScsIHZpZXdzOicyMTBLJywgdmVyOidWMScgfSwKICBdLAogIGZhbDogWwogICAgeyBuYW1lOidGTFVYIExvUkEnLCBiYXNlOidGTFVYJywgbW9kZWw6J2ZhbC1haS9mbHV4LWxvcmEnLCB0YWdzOlsnZmx1eC1sb3JhJ10sIHRodW1iOidmbHV4bCcsIGJhZGdlOidGTFVYLUxPUkEnLCB2aWV3czonMTUwSycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwKICAgIHsgbmFtZTonU0RYTCArIExvUkEgVVJMIChmYXN0LXNkeGwpJywgYmFzZTonU0RYTCcsIG1vZGVsOidmYWwtYWkvZmFzdC1zZHhsJywgdGFnczpbJ2xvcmEnXSwgdGh1bWI6J3NkeGxsJywgYmFkZ2U6J1NEWEwtTE9SQScsIHZpZXdzOicxMjBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogICAgeyBuYW1lOidLcmVhIDIgTG9SQSAodHVyYm8pJywgYmFzZTonS3JlYSAyJywgbW9kZWw6J2ZhbC1haS9rcmVhLTIvdHVyYm8vbG9yYScsIHRhZ3M6WydrcmVhMiddLCB0aHVtYjona3JlYScsIGJhZGdlOidLUkVBMi1MT1JBJywgdmlld3M6JzY2SycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwKICBdLAogIHBvbGxpbmF0aW9uczogW10sIC8vIExvUkEgdGlkYWsgZGlkdWt1bmcg4oCUIGdyYXRpcywgbW9kZWwgYmF3YWFuIHNhamEKfTsKdmFyIExPUkFfTElCID0gTE9SQV9MSUJTLnRhbXM7IC8vIGRhZnRhciBha3RpZiBtZW5naWt1dGkgcHJvdmlkZXIKY29uc3QgTE9SQSA9IFtdOwovKiA9PT09PSBNb2RlbCBtb2RhbCDigJQgZGFmdGFyIG1vZGVsIGFzbGkgcGVyIHByb3ZpZGVyID09PT09ICovCnZhciBNT0RFTF9MSUJTID0gewogIHRhbXM6IFsKICAgIHsgbmFtZTonWiBJbWFnZSAtIGJhc2UtYmYxNicsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonWiBJbWFnZScsIHRodW1iOid6aW1hZ2UnLCBiYWRnZTonWicsIHZpZXdzOic0NEsnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYyNTMyNjA2MDM4MDUnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjI1NDMzNDM2NjI0NScgfSwKICAgIHsgbmFtZTonRkxVWC4xIFtkZXZdJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidGTFVYLjEnLCB0aHVtYjonZmx1eCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzE1NEsnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYyODI2NDQ1MjUwNTYnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjI4MjY0NDUyNTA1NycgfSwKICAgIHsgbmFtZTonU3RhYmxlIERpZmZ1c2lvbiBYTCcsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonU0RYTCcsIHRodW1iOidzZHhsJywgYmFkZ2U6J1NEWEwgMS4wJywgdmlld3M6Jzg5MksnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYzMDkwMzIxMzY3MDQnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjMwOTAzMjEzNjcwNScgfSwKICAgIHsgbmFtZTonU3RhYmxlIERpZmZ1c2lvbiAzLjUgTWVkaXVtJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRCAzLjUnLCB0aHVtYjonc2QzNScsIGJhZGdlOidTRCAzLjUnLCB2aWV3czonMzEySycsIHZlcjonVi4xJywgbW9kZWxJZDonMTAyNzkwNjMxNzQ1MjgwODE5MicsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzE3NDUyODA4MTkzJyB9LAogICAgeyBuYW1lOidQb255IERpZmZ1c2lvbiBWNicsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonUG9ueScsIHRodW1iOidwb255JywgYmFkZ2U6J1BPTlknLCB2aWV3czonMi4xTScsIHZlcjonVjYnLCBtb2RlbElkOicxMDI3OTA2MzI2ODc0MjcxNzQ0JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzMjY4NzQyNzE3NDUnIH0sCiAgICB7IG5hbWU6J0lsbHVzdHJpb3VzIFhMJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidJbGx1c3RyaW91cycsIHRodW1iOidpbGx1c3QnLCBiYWRnZTonSUxMVVNUUklPVVMnLCB2aWV3czonNjdLJywgdmVyOidWLjEnLCBtb2RlbElkOicxMDI3OTA2MzM1NzgyNDE0MzM2JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzMzU3ODI0MTQzMzcnIH0sCiAgICB7IG5hbWU6J0FuaW1hJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidBbmltYScsIHRodW1iOidhbmltYScsIGJhZGdlOidBTklNQScsIHZpZXdzOic1MksnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYzNDQ3MTY3NzE4NDAnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM0NDcxNjc3MTg0MScgfSwKICAgIHsgbmFtZTonRHJlYW1TaGFwZXInLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonZHJlYW0nLCBiYWRnZTonRFMnLCB2aWV3czonODEySycsIHZlcjonVi41JywgbW9kZWxJZDonMTAyNzkwNjM1MzQ5OTQyOTg4OCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzUzNDk5NDI5ODg5JyB9LAogICAgeyBuYW1lOidSZWFsaXN0aWMgVmlzaW9uJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J3JlYWwnLCBiYWRnZTonUlYnLCB2aWV3czonNjQ1SycsIHZlcjonVi42LjAnLCBtb2RlbElkOicxMDI3OTA2MzYyNDEyNTMxNzEyJywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzNjI0MTI1MzE3MTMnIH0sCiAgICB7IG5hbWU6J0NvdW50ZXJmZWl0JywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J2NvdW50ZXInLCBiYWRnZTonQ09VTlRFUkZFSVQnLCB2aWV3czonNDIwSycsIHZlcjonVi41JywgbW9kZWxJZDonMTAyNzkwNjM3MTMzNDcyNzY4MCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzcxMzM0NzI3NjgxJyB9LAogICAgeyBuYW1lOidMeXJpZWwnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonbHlyaWVsJywgYmFkZ2U6J0xZUklFTCcsIHZpZXdzOiczMjBLJywgdmVyOidWLjEuNicsIG1vZGVsSWQ6JzEwMjc5MDYzNzk5OTYwMTM1NjgnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM3OTk5NjAxMzU2OScgfSwKICAgIHsgbmFtZTonSnVnZ2VybmF1dCcsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonU0RYTCcsIHRodW1iOidqdWcnLCBiYWRnZTonSlVHRycsIHZpZXdzOicyMTBLJywgdmVyOidWLjknLCBtb2RlbElkOicxMDI3OTA2Mzg4NDIxMDk5NTIwJywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzODg0MjEwOTk1MjEnIH0sCiAgXSwKICByZXBsaWNhdGU6IFsKICAgIHsgbmFtZTonRkxVWC4xIFtzY2huZWxsXScsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J0ZMVVgnLCB0aHVtYjonZmx1eCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzRNJywgdmVyOidWMScsIG1vZGVsOidibGFjay1mb3Jlc3QtbGFicy9mbHV4LXNjaG5lbGwnIH0sCiAgICB7IG5hbWU6J0ZMVVguMSBbZGV2XScsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J0ZMVVgnLCB0aHVtYjonZmx1eGQnLCBiYWRnZTonRkxVWCcsIHZpZXdzOicyLjFNJywgdmVyOidWMScsIG1vZGVsOidibGFjay1mb3Jlc3QtbGFicy9mbHV4LWRldicgfSwKICAgIHsgbmFtZTonU0RYTCAxLjAnLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J3NkeGwnLCBiYWRnZTonU0RYTCAxLjAnLCB2aWV3czonMS4yTScsIHZlcjonVjEnLCBtb2RlbDonc3RhYmlsaXR5LWFpL3NkeGwnIH0sCiAgICB7IG5hbWU6J1N0YWJsZSBEaWZmdXNpb24gMy41IExhcmdlJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0QgMy41JywgdGh1bWI6J3NkMzUnLCBiYWRnZTonU0QgMy41Jywgdmlld3M6JzEuNU0nLCB2ZXI6J1YxJywgbW9kZWw6J3N0YWJpbGl0eS1haS9zdGFibGUtZGlmZnVzaW9uLTMuNS1sYXJnZScgfSwKICAgIHsgbmFtZTonU0RYTCBMaWdodG5pbmcgNC1TdGVwJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0RYTCcsIHRodW1iOidsaWdodG5pbmcnLCBiYWRnZTonTElHSFROSU5HJywgdmlld3M6JzEuOE0nLCB2ZXI6J1YxJywgbW9kZWw6J2J5dGVkYW5jZS9zZHhsLWxpZ2h0bmluZy00c3RlcCcgfSwKICAgIHsgbmFtZTonUmVhbFZpc1hMIFY0LjAnLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J3JlYWwnLCBiYWRnZTonUkVBTElTVElDJywgdmlld3M6JzkwMEsnLCB2ZXI6J1Y0LjAnLCBtb2RlbDonbHVjYXRhY28vcmVhbHZpc3hsLXY0LjAnIH0sCiAgICB7IG5hbWU6J0p1Z2dlcm5hdXQgWEwgVjknLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J2p1ZycsIGJhZGdlOidKVUdHJywgdmlld3M6Jzc1MEsnLCB2ZXI6J1Y5JywgbW9kZWw6J2RpZ2lwbGF5L0p1Z2dlcm5hdXRfWExfdjknIH0sCiAgICB7IG5hbWU6J1NEWEwgRW1vamknLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J2Vtb2ppJywgYmFkZ2U6J0VNT0pJJywgdmlld3M6JzYwMEsnLCB2ZXI6J1YxJywgbW9kZWw6J2ZvZnIvc2R4bC1lbW9qaScgfSwKICBdLAogIGZhbDogWwogICAgeyBuYW1lOidGTFVYLjEgW3NjaG5lbGxdJywgYmFzZTonZmFsLmFpJywgYXJjaDonRkxVWCcsIHRodW1iOidmbHV4JywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonNU0nLCB2ZXI6J1YxJywgbW9kZWw6J2ZhbC1haS9mbHV4L3NjaG5lbGwnIH0sCiAgICB7IG5hbWU6J0ZMVVguMSBbZGV2XScsIGJhc2U6J2ZhbC5haScsIGFyY2g6J0ZMVVgnLCB0aHVtYjonZmx1eGQnLCBiYWRnZTonRkxVWCcsIHZpZXdzOiczTScsIHZlcjonVjEnLCBtb2RlbDonZmFsLWFpL2ZsdXgvZGV2JyB9LAogICAgeyBuYW1lOidGYXN0IFNEWEwnLCBiYXNlOidmYWwuYWknLCBhcmNoOidTRFhMJywgdGh1bWI6J2Zhc3RzZHhsJywgYmFkZ2U6J0ZBTCcsIHZpZXdzOicyLjVNJywgdmVyOidWMScsIG1vZGVsOidmYWwtYWkvZmFzdC1zZHhsJyB9LAogICAgeyBuYW1lOidTRFhMJywgYmFzZTonZmFsLmFpJywgYXJjaDonU0RYTCcsIHRodW1iOidzZHhsJywgYmFkZ2U6J1NEWEwgMS4wJywgdmlld3M6JzEuMU0nLCB2ZXI6J1YxJywgbW9kZWw6J2ZhbC1haS9zZHhsJyB9LAogICAgeyBuYW1lOidTdGFibGUgRGlmZnVzaW9uIDMuNSBMYXJnZScsIGJhc2U6J2ZhbC5haScsIGFyY2g6J1NEIDMuNScsIHRodW1iOidzZDM1JywgYmFkZ2U6J1NEIDMuNScsIHZpZXdzOic5MDBLJywgdmVyOidWMScsIG1vZGVsOidmYWwtYWkvc3RhYmxlLWRpZmZ1c2lvbi12MzUtbGFyZ2UnIH0sCiAgICB7IG5hbWU6J1BsYXlncm91bmQgdjIuNScsIGJhc2U6J2ZhbC5haScsIGFyY2g6J1NEWEwnLCB0aHVtYjoncGxheScsIGJhZGdlOidQTEFZJywgdmlld3M6JzcwMEsnLCB2ZXI6J1YyLjUnLCBtb2RlbDonZmFsLWFpL3BsYXlncm91bmQvdjIuNScgfSwKICAgIHsgbmFtZTonS3JlYSAyIFR1cmJvJywgYmFzZTonZmFsLmFpJywgYXJjaDonS3JlYSAyJywgdGh1bWI6J2tyZWEnLCBiYWRnZTonS1JFQTInLCB2aWV3czonMS4xTScsIHZlcjonVjInLCBtb2RlbDonZmFsLWFpL2tyZWEtMi90dXJibycgfSwKICBdLAogIHBvbGxpbmF0aW9uczogWwogICAgeyBuYW1lOidaLUltYWdlIFR1cmJvJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonQWxpYmFiYScsIHRodW1iOid6aW1hZ2UnLCBiYWRnZTonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J3ppbWFnZScgfSwKICAgIHsgbmFtZTonR1BUIEltYWdlIDInLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidPcGVuQUknLCB0aHVtYjonZ3B0JywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidncHQtaW1hZ2UtMicgfSwKICAgIHsgbmFtZTonRkxVWC4xIFNjaG5lbGwnLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidCbGFjayBGb3Jlc3QgTGFicycsIHRodW1iOidmbHV4JywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidmbHV4JyB9LAogICAgeyBuYW1lOidEcmVhbVNoYXBlciA4IExDTScsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0x5a29uJywgdGh1bWI6J2RyZWFtJywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidkcmVhbXNoYXBlcicgfSwKICAgIHsgbmFtZTonRkxVWC4yIEtsZWluIDRCJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonQmxhY2sgRm9yZXN0IExhYnMnLCB0aHVtYjona2xlaW4nLCBiYWRnZTonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J2tsZWluJyB9LAogICAgeyBuYW1lOidLcmVhIDIgTWVkaXVtJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonS3JlYScsIHRodW1iOidrcmVhJywgYmFkZ2U6J1BBSUQnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidrcmVhJyB9LAogICAgeyBuYW1lOidTZWVkcmVhbSA1LjAgTGl0ZScsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0J5dGVEYW5jZScsIHRodW1iOidzZWVkJywgYmFkZ2U6J1BBSUQnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidzZWVkcmVhbTUnIH0sCiAgICB7IG5hbWU6J1F3ZW4gSW1hZ2UgMycsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J1F3ZW4nLCB0aHVtYjoncXdlbicsIGJhZGdlOidQQUlEJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDoncXdlbi1pbWFnZS0zJyB9LAogICAgeyBuYW1lOidOYW5vIEJhbmFuYSAyJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonR29vZ2xlJywgdGh1bWI6J25hbm8nLCBiYWRnZTonUEFJRCcsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J25hbm9iYW5hbmEtMicgfSwKICBdLAp9Owp2YXIgTU9ERUxTID0gTU9ERUxfTElCUy50YW1zOyAvLyBkYWZ0YXIgYWt0aWYgbWVuZ2lrdXRpIHByb3ZpZGVyCnZhciBNQ0FUID0gWydUcnkgTm93JywnQUxMJywnT0ZGSUNJQUwgTU9ERUwnLCdNRU1FJywnRVhDTFVTSVZFJywnQkVBVVRZJywnM0QnLCcyLjVEJywnTUFMRScsJ0FOSU1FJywnUkVBTElTVElDJywnU1RZTEUnLCdHQU1FJywnREVTSUdOJywnU0NFTkVSWScsJ0JVSUxESU5HUycsJ01FQ0hBJ107CnZhciBfY3VyTGlzdD1bXSwgX2N1ck9uU2VsPWZ1bmN0aW9uKCl7fTsKZnVuY3Rpb24gcmVuZGVyQ2FyZHMobGlzdCwgb25TZWwpewogIF9jdXJMaXN0PWxpc3Q7IF9jdXJPblNlbD1vblNlbDsKICB2YXIgYj0kKCdtb2RhbC1ib2R5Jyk7IGIuaW5uZXJIVE1MPScnOwogIGlmKCFsaXN0Lmxlbmd0aCl7IGIuaW5uZXJIVE1MPSc8cCBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIHAtMyB0ZXh0LWNlbnRlciI+VGlkYWsgYWRhIGhhc2lsLjwvcD4nOyByZXR1cm47IH0KICB2YXIgZ3JpZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICBncmlkLmNsYXNzTmFtZT0nZ3JpZCBncmlkLWNvbHMtMyBzbTpncmlkLWNvbHMtNCBtZDpncmlkLWNvbHMtNSBnYXAtMyc7CiAgbGlzdC5mb3JFYWNoKGZ1bmN0aW9uKG0pewogICAgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBkLmNsYXNzTmFtZT0nbWNhcmQnOwogICAgZC5pbm5lckhUTUwgPSc8ZGl2IGNsYXNzPSJtY2FyZC1pbWciPicKICAgICAgKyc8aW1nIHNyYz0iJytTK20udGh1bWIrJy8zMDAiLz4nCiAgICAgICsnPHNwYW4gY2xhc3M9Im1jYXJkLWJhZGdlIj4nK20uYmFkZ2UrJzwvc3Bhbj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibWNhcmQtc3RhciI+PGkgZGF0YS1pY29uPSJzdGFyIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC12aWV3cyI+PGkgZGF0YS1pY29uPSJwbGF5LWZpbGwiIGNsYXNzPSJ3LTMgaC0zIj48L2k+JyttLnZpZXdzKyc8L2Rpdj4nCiAgICAgICsnPC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9Im1jYXJkLWluZm8iPicKICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC1uYW1lIiB0aXRsZT0iJyttLm5hbWUrJyI+JyttLm5hbWUrJzwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC1tZXRhIj4nCiAgICAgICsnPHNlbGVjdCBjbGFzcz0ibWNhcmQtdmVyIj48b3B0aW9uPicrbS52ZXIrJzwvb3B0aW9uPjxvcHRpb24+Vi4yPC9vcHRpb24+PG9wdGlvbj5WLjM8L29wdGlvbj48L3NlbGVjdD4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibWNhcmQtc2VsIj5TZWxlY3Q8L2J1dHRvbj4nCiAgICAgICsnPC9kaXY+PC9kaXY+JzsKICAgIGQucXVlcnlTZWxlY3RvcignLm1jYXJkLXN0YXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oZSl7IGUudGFyZ2V0LmNsb3Nlc3QoJy5tY2FyZC1zdGFyJykuY2xhc3NMaXN0LnRvZ2dsZSgnb24nKTsgfSk7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5tY2FyZC1zZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgX2N1ck9uU2VsKG0pOyB9KTsKICAgIGdyaWQuYXBwZW5kQ2hpbGQoZCk7CiAgfSk7CiAgYi5hcHBlbmRDaGlsZChncmlkKTsKfQpmdW5jdGlvbiBhcHBseVNlYXJjaCgpewogIHZhciBxPSgkKCdtc2VhcmNoJykudmFsdWV8fCcnKS50b0xvd2VyQ2FzZSgpOwogIHJlbmRlckNhcmRzKF9jdXJMaXN0LmZpbHRlcihmdW5jdGlvbihtKXtyZXR1cm4gIXF8fG0ubmFtZS50b0xvd2VyQ2FzZSgpLmluZGV4T2YocSk+PTB9KSwgX2N1ck9uU2VsKTsKfQokKCdtc2VhcmNoJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGFwcGx5U2VhcmNoKTsKJCgnbWZpbHRlcnMnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgnbWNhdCcpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicpOyAkKCdtZmlsdGVycycpLmNsYXNzTGlzdC50b2dnbGUoJ29uJyk7IH0pOwpkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubXRhYicpLmZvckVhY2goZnVuY3Rpb24odCl7CiAgdC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tdGFiJykuZm9yRWFjaChmdW5jdGlvbih4KXt4LmNsYXNzTGlzdC5yZW1vdmUoJ3NlbCcpfSk7CiAgICB0LmNsYXNzTGlzdC5hZGQoJ3NlbCcpOwogICAgaWYodC5kYXRhc2V0Lm10YWI9PT0nYmFzaWMnKSByZW5kZXJDYXJkcyhNT0RFTFMsIGZ1bmN0aW9uKG0peyBzZXRNb2RlbChtKTsgY2xvc2VNb2RhbCgpOyB9KTsKICAgIGVsc2UgcmVuZGVyQ2FyZHMoW10sIG51bGwpOwogIH0pOwp9KTsKZnVuY3Rpb24gcmVuZGVyTUNhdChvblBpY2spewogIHZhciBjPSQoJ21jYXQnKTsKICBpZighb25QaWNrKSBvblBpY2s9ZnVuY3Rpb24oKXt9OwogIHZhciBodG1sPScnOwogIE1DQVQuZm9yRWFjaChmdW5jdGlvbihjYXQsaSl7CiAgICBodG1sKz0nPGJ1dHRvbiBjbGFzcz0ibWNoaXAiIGRhdGEtbWNhdD0iJytjYXQrJyI+JytjYXQrJzwvYnV0dG9uPic7CiAgfSk7CiAgYy5pbm5lckhUTUw9aHRtbDsKICBjLnF1ZXJ5U2VsZWN0b3IoJy5tY2hpcCcpLmNsYXNzTGlzdC5hZGQoJ29uJyk7CiAgYy5xdWVyeVNlbGVjdG9yQWxsKCcubWNoaXAnKS5mb3JFYWNoKGZ1bmN0aW9uKGNoKXsKICAgIGNoLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICAgICBjLnF1ZXJ5U2VsZWN0b3JBbGwoJy5tY2hpcCcpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QucmVtb3ZlKCdvbicpfSk7CiAgICAgIGNoLmNsYXNzTGlzdC5hZGQoJ29uJyk7CiAgICAgIG9uUGljayhjaC5kYXRhc2V0Lm1jYXQpOwogICAgfSk7CiAgfSk7Cn0KZnVuY3Rpb24gc2V0TW9kZWwobSl7CiAgc3RhdGUubW9kZWw9bTsKICAkKCdtb2RlbC1uYW1lJykudGV4dENvbnRlbnQ9bS5uYW1lOwogICQoJ21vZGVsLXRodW1iJykuc3JjPSdodHRwczovL3BpY3N1bS5waG90b3Mvc2VlZC8nK20udGh1bWIrJy82NCc7CiAgdmFyIGI9JCgnbW9kZWwtYmFkZ2UnKTsgaWYoYikgYi50ZXh0Q29udGVudD0obS5iYXNlfHwnTW9kZWwnKSsnIC0gJysobS5hcmNofHwnJyk7Cn0KZnVuY3Rpb24gb3Blbk1vZGVsU2VsZWN0b3IoKXsKICAkKCdtb2RhbC10aXRsZScpLnRleHRDb250ZW50PSdQaWxpaCBNb2RlbCc7CiAgcmVuZGVyTUNhdChmdW5jdGlvbigpeyByZW5kZXJDYXJkcyhNT0RFTFMsIGZ1bmN0aW9uKG0peyBzZXRNb2RlbChtKTsgY2xvc2VNb2RhbCgpOyB9KTsgfSk7CiAgcmVuZGVyQ2FyZHMoTU9ERUxTLCBmdW5jdGlvbihtKXsgc2V0TW9kZWwobSk7IGNsb3NlTW9kYWwoKTsgfSk7CiAgb3Blbk1vZGFsKCk7Cn0KJCgnbW9kZWwtY2FyZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxvcGVuTW9kZWxTZWxlY3Rvcik7CmZ1bmN0aW9uIG9wZW5Mb3JhTW9kYWwoKXsKICAkKCdtb2RhbC10aXRsZScpLnRleHRDb250ZW50PSdQaWxpaCBMb1JBJzsKICB2YXIgYXJjaD1zdGF0ZS5tb2RlbD9zdGF0ZS5tb2RlbC5hcmNoOicnOwogIHZhciBhdmFpbD1mdW5jdGlvbigpeyByZXR1cm4gTE9SQV9MSUIuZmlsdGVyKGZ1bmN0aW9uKGwpewogICAgcmV0dXJuICghTE9SQS5zb21lKGZ1bmN0aW9uKHgpe3JldHVybiB4Lm5hbWU9PT1sLm5hbWV9KSkgJiYgKCFhcmNoIHx8ICFsLmJhc2UgfHwgbC5iYXNlPT09YXJjaCk7CiAgfSk7IH07CiAgdmFyIG9uU2VsPWZ1bmN0aW9uKGwpewogICAgTE9SQS5wdXNoKHsgbmFtZTpsLm5hbWUsIHc6MC44LCB0YWdzOmwudGFncywgdGh1bWI6bC50aHVtYiwgYmFzZTpsLmJhc2UsIGxvcmFNb2RlbDpsLm1vZGVsfHwnJywgbmVlZFVybDpsLm5lZWRVcmwsIGxvcmFVcmw6JycgfSk7CiAgICByZW5kZXJMb3JhKCk7IGNsb3NlTW9kYWwoKTsKICB9OwogIHJlbmRlck1DYXQoZnVuY3Rpb24oKXsgcmVuZGVyQ2FyZHMoYXZhaWwoKSwgb25TZWwpOyB9KTsKICByZW5kZXJDYXJkcyhhdmFpbCgpLCBvblNlbCk7CiAgaWYoIWF2YWlsKCkubGVuZ3RoKXsgJCgnbW9kYWwtdGl0bGUnKS50ZXh0Q29udGVudD0nVGlkYWsgYWRhIExvUkEgdW50dWsgJythcmNoOyB9CiAgb3Blbk1vZGFsKCk7Cn0KZnVuY3Rpb24gb3Blbk1vZGFsKCl7ICQoJ21vZGFsJykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ21vZGFsJykuY2xhc3NMaXN0LmFkZCgnZmxleCcpOyB9CmZ1bmN0aW9uIGNsb3NlTW9kYWwoKXsgJCgnbW9kYWwnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgnbW9kYWwnKS5jbGFzc0xpc3QucmVtb3ZlKCdmbGV4Jyk7IH0KZnVuY3Rpb24gb3BlbkxvcmFJbmZvKGwpewogICQoJ21vZGFsLXRpdGxlJykudGV4dENvbnRlbnQ9J0RldGFpbCBMb1JBJzsKICAkKCdtY2F0JykuaW5uZXJIVE1MPScnOwogIHZhciBiPSQoJ21vZGFsLWJvZHknKTsKICBiLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZmxleCBnYXAtMyBwLTIiPicKICAgICsnPGltZyBzcmM9IicrUytsLnRodW1iKycvMTQwIiBjbGFzcz0idy0yOCBoLTI4IHJvdW5kZWQtbGcgb2JqZWN0LWNvdmVyIHNocmluay0wIi8+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4LTEgbWluLXctMCI+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGZsZXgtd3JhcCBnYXAtMS41IG1iLTEiPicKICAgICsnPHNwYW4gY2xhc3M9InRleHQtWzEwcHhdIGZvbnQtc2VtaWJvbGQgYmctWyMxYzIxMjhdIGJvcmRlciBiZCBweC0xLjUgcHktMC41IHJvdW5kZWQgdGV4dC1uZXV0cmFsLTQwMCI+TE9SQTwvc3Bhbj4nCiAgICArJzxzcGFuIGNsYXNzPSJ0ZXh0LVsxMHB4XSBmb250LXNlbWlib2xkIGJnLVtyZ2JhKDExMSw5MywyNTUsLjE1KV0gYm9yZGVyIGJvcmRlci1bIzZGNURGRl0gcHgtMS41IHB5LTAuNSByb3VuZGVkIHRleHQtWyM2RjVERkZdIj4nK2wuYmFkZ2UrJzwvc3Bhbj4nCiAgICArJzxzcGFuIGNsYXNzPSJ0ZXh0LVsxMHB4XSBmb250LXNlbWlib2xkIGJnLVsjMWMyMTI4XSBib3JkZXIgYmQgcHgtMS41IHB5LTAuNSByb3VuZGVkIHRleHQtbmV1dHJhbC00MDAiPk9yaWdpbmFsPC9zcGFuPicKICAgICsnPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPicrbC5uYW1lKyc8L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBtdC0wLjUiPlJla3R5IEFJPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSBtdC0xIHRleHQteHMgdGV4dC1uZXV0cmFsLTQwMCI+PGkgZGF0YS1pY29uPSJkb3dubG9hZC1zaW1wbGUiIGNsYXNzPSJ3LTMuNSBoLTMuNSI+PC9pPicrKGwudmlld3M/bC52aWV3czonMTJLJykrJyBkb3dubG9hZHM8L2Rpdj4nCiAgICArJzwvZGl2PjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iYm9yZGVyLXQgYmQgbXQtMiBwdC0zIj4nCiAgICArJzxkaXYgY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCBtYi0yIGZsZXggaXRlbXMtY2VudGVyIGdhcC0xIj48aSBkYXRhLWljb249InRhZyIgY2xhc3M9InctNCBoLTQiPjwvaT5WZXJzaW9uIERldGFpbDwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZ3JpZCBncmlkLWNvbHMtMiBnYXAtMiB0ZXh0LXhzIj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGJvcmRlciBiZCByb3VuZGVkLWxnIHB4LTIgcHktMS41Ij48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+QmFzZSBNb2RlbDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+WiBJbWFnZTwvc3Bhbj48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGJvcmRlciBiZCByb3VuZGVkLWxnIHB4LTIgcHktMS41Ij48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+U3RlcHM8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPjI1MDA8L3NwYW4+PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiBib3JkZXIgYmQgcm91bmRlZC1sZyBweC0yIHB5LTEuNSI+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPkVwb2NoPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4xMjwvc3Bhbj48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGJvcmRlciBiZCByb3VuZGVkLWxnIHB4LTIgcHktMS41Ij48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+VHJpZ2dlciBXb3Jkczwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1bIzI3RDRDRF0iPicrbC50YWdzLnNsaWNlKDAsMikuam9pbignLCAnKSsnPC9zcGFuPjwvZGl2PicKICAgICsnPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgbXQtMyBtYi0xIj5EZXNjcmlwdGlvbjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNDAwIGxlYWRpbmctcmVsYXhlZCI+JytsLnRhZ3Muam9pbignLCAnKSsnIOKAlCBMb1JBIHVudHVrIGdheWEgZGFuIGRldGFpbCB0YW1iYWhhbiBkaSBaIEltYWdlLjwvZGl2Pic7CiAgb3Blbk1vZGFsKCk7Cn0KJCgnbW9kZWwtaW5mbycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgZS5zdG9wUHJvcGFnYXRpb24oKTsgb3BlbkxvcmFJbmZvKHtuYW1lOiQoJ21vZGVsLW5hbWUnKS50ZXh0Q29udGVudCxiYWRnZTonWiBJbWFnZScsdGh1bWI6J3ppbWFnZScsdGFnczpbJ2RldGFpbCcsJ3NoYXJwJ119KTsgfSk7CiQoJ21vZGFsLWNsb3NlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGNsb3NlTW9kYWwpOwokKCdtb2RhbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgaWYoZS50YXJnZXQ9PT0kKCdtb2RhbCcpKSBjbG9zZU1vZGFsKCk7IH0pOwokKCdidG4tYWRkbG9yYScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxvcGVuTG9yYU1vZGFsKTsKZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsZnVuY3Rpb24oZSl7IGlmKGUua2V5PT09J0VzY2FwZScpIGNsb3NlTW9kYWwoKTsgfSk7CmZ1bmN0aW9uIHJlbmRlckxvcmEoKXsKICB2YXIgbGlzdCA9ICQoJ2xvcmEtbGlzdCcpOyBsaXN0LmlubmVySFRNTD0nJzsKICBpZighTE9SQS5sZW5ndGgpeyBsaXN0LmlubmVySFRNTD0nPGRpdiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNjAwIGJvcmRlciBib3JkZXItZGFzaGVkIGJvcmRlci1bIzMwMzYzZF0gcm91bmRlZC1sZyBwLTMgdGV4dC1jZW50ZXIiPkJlbHVtIGFkYSBMb1JBLiBLbGlrICJBZGQgTG9SQSIuPC9kaXY+JzsgcmVuZGVyVHJpZ2dlcnMoKTsgcmV0dXJuOyB9CiAgTE9SQS5mb3JFYWNoKGZ1bmN0aW9uKGwscmkpewogICAgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBkLmNsYXNzTmFtZT0nbG9yYS1jYXJkJzsKICAgIGQuaW5uZXJIVE1MPScnCiAgICAgICsnPHNwYW4gY2xhc3M9ImxvcmEtbGFiZWwiPkxvUkEgLSAnKyhsLmJhc2V8fCdaIEltYWdlJykrJzwvc3Bhbj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibG9yYS10b3AiPicKICAgICAgKyc8aW1nIHNyYz0iJytTK2wudGh1bWIrJy80MCIgY2xhc3M9ImxvcmEtdGh1bWIiIGFsdD0iIi8+JwogICAgICArJzxzcGFuIGNsYXNzPSJsb3JhLW5hbWUiPicrbC5uYW1lKyc8L3NwYW4+JwogICAgICArJzxkaXYgY2xhc3M9ImxvcmEtaWNvbnMiPicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJsb3JhLWljb24iIGRhdGEtaW5mbz0iJytyaSsnIiB0aXRsZT0iSW5mbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48bGluZSB4MT0iMTIiIHkxPSIxNiIgeDI9IjEyIiB5Mj0iMTIiLz48bGluZSB4MT0iMTIiIHkxPSI4IiB4Mj0iMTIuMDEiIHkyPSI4Ii8+PC9zdmc+PC9idXR0b24+JwogICAgICArJzxidXR0b24gY2xhc3M9ImxvcmEtaWNvbiBkZWwiIGRhdGEtZGVsPSInK3JpKyciIHRpdGxlPSJIYXB1cyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBvbHlsaW5lIHBvaW50cz0iMyA2IDUgNiAyMSA2Ii8+PHBhdGggZD0iTTE5IDZ2MTRhMiAyIDAgMCAxLTIgMkg3YTIgMiAwIDAgMS0yLTJWNm0zIDBWNGEyIDIgMCAwIDEgMi0yaDRhMiAyIDAgMCAxIDIgMnYyIi8+PGxpbmUgeDE9IjEwIiB5MT0iMTEiIHgyPSIxMCIgeTI9IjE3Ii8+PGxpbmUgeDE9IjE0IiB5MT0iMTEiIHgyPSIxNCIgeTI9IjE3Ii8+PC9zdmc+PC9idXR0b24+JwogICAgICArJzwvZGl2PicKICAgICAgKyc8L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibG9yYS1zbGlkZXItcm93Ij4nCiAgICAgICsnPGRpdiBjbGFzcz0ibC1zbGlkZXIiPjxkaXYgY2xhc3M9ImwtdHJhY2siPjwvZGl2PjxkaXYgY2xhc3M9ImwtZmlsbCIgc3R5bGU9IndpZHRoOicrKGwudy8yKjEwMCkrJyUiPjwvZGl2PjxkaXYgY2xhc3M9ImwtaGFuZGxlIiBzdHlsZT0ibGVmdDonKyhsLncvMioxMDApKyclIj48L2Rpdj48aW5wdXQgdHlwZT0icmFuZ2UiIG1pbj0iMCIgbWF4PSIyIiBzdGVwPSIwLjEiIHZhbHVlPSInK2wudysnIiBkYXRhLXJpPSInK3JpKyciIGNsYXNzPSJsb3JhLXNsIi8+PC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9ImwtbnVtIj4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibG9yYS1idG4iIGRhdGEtZGVjPSInK3JpKyciPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxsaW5lIHgxPSI1IiB5MT0iMTIiIHgyPSIxOSIgeTI9IjEyIi8+PC9zdmc+PC9idXR0b24+JwogICAgICArJzxpbnB1dCB0eXBlPSJ0ZXh0IiB2YWx1ZT0iJytsLncudG9GaXhlZCgxKSsnIiBjbGFzcz0ibG9yYS1pbnB1dCIgZGF0YS1yaT0iJytyaSsnIiBpbnB1dG1vZGU9ImRlY2ltYWwiLz4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibG9yYS1idG4iIGRhdGEtaW5jPSInK3JpKyciPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxsaW5lIHgxPSIxMiIgeTE9IjUiIHgyPSIxMiIgeTI9IjE5Ii8+PGxpbmUgeDE9IjUiIHkxPSIxMiIgeDI9IjE5IiB5Mj0iMTIiLz48L3N2Zz48L2J1dHRvbj4nCiAgICAgICsnPC9kaXY+JwogICAgICArKGwubmVlZFVybD8nPGRpdiBjbGFzcz0ibXQtMiI+PGlucHV0IHR5cGU9InRleHQiIGNsYXNzPSJpbnAgbG9yYS11cmwtaW5wIiB2YWx1ZT0iJysobC5sb3JhVXJsfHwnJykrJyIgZGF0YS11cmw9IicrcmkrJyIgcGxhY2Vob2xkZXI9Imh0dHBzOi8vaHVnZ2luZ2ZhY2UuY28vdXNlci9yZXBvL3Jlc29sdmUvbWFpbi9sb3JhLnNhZmV0ZW5zb3JzIi8+PGRpdiBjbGFzcz0ibXQtMSB0ZXh0LVsxMHB4XSBsZWFkaW5nLXNudWcgdGV4dC1uZXV0cmFsLTUwMCI+VVJMIHB1YmxpayBsYW5nc3VuZyAoLnNhZmV0ZW5zb3JzKSDigJQgY29udG9oIEh1Z2dpbmdGYWNlIHJlc29sdmUuIEthZ2dsZSB0aWRhayBiaXNhIChidXR1aCBsb2dpbikuPC9kaXY+PC9kaXY+JzonJykKICAgICAgKyc8L2Rpdj4nOwogICAgdmFyIHNsPWQucXVlcnlTZWxlY3RvcignLmwtc2xpZGVyIFtkYXRhLXJpPSInK3JpKyciXScpOwogICAgdmFyIHVJbnA9ZC5xdWVyeVNlbGVjdG9yKCdbZGF0YS11cmw9IicrcmkrJyJdJyk7CiAgICBpZih1SW5wKXsgdUlucC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7IExPUkFbcmldLmxvcmFVcmw9ZS50YXJnZXQudmFsdWUudHJpbSgpOyB9KTsgfQogICAgc2wuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpewogICAgICB2YXIgdj1wYXJzZUZsb2F0KGUudGFyZ2V0LnZhbHVlKTsgaWYoaXNOYU4odikpcmV0dXJuOwogICAgICBMT1JBW3JpXS53PXY7CiAgICAgIHZhciBwY3Q9KHYvMioxMDApOwogICAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5sLWZpbGwnKS5zdHlsZS53aWR0aD1wY3QrJyUnOwogICAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5sLWhhbmRsZScpLnN0eWxlLmxlZnQ9cGN0KyclJzsKICAgICAgZC5xdWVyeVNlbGVjdG9yKCcubG9yYS1pbnB1dCcpLnZhbHVlPXYudG9GaXhlZCgxKTsKICAgICAgcmVuZGVyVHJpZ2dlcnMoKTsKICAgIH0pOwogICAgZC5xdWVyeVNlbGVjdG9yKCcubC1udW0gW2RhdGEtaW5jPSInK3JpKyciXScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBzZXRMVyhyaSwrKExPUkFbcmldLncrMC4xKS50b0ZpeGVkKDEpKTsgcmVuZGVyTG9yYSgpOyB9KTsKICAgIGQucXVlcnlTZWxlY3RvcignLmwtbnVtIFtkYXRhLWRlYz0iJytyaSsnIl0nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgc2V0TFcocmksKyhMT1JBW3JpXS53LTAuMSkudG9GaXhlZCgxKSk7IHJlbmRlckxvcmEoKTsgfSk7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWRlbD0iJytyaSsnIl0nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgTE9SQS5zcGxpY2UocmksMSk7IHJlbmRlckxvcmEoKTsgcmVuZGVyVHJpZ2dlcnMoKTsgfSk7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWluZm89IicrcmkrJyJdJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IG9wZW5Mb3JhSW5mbyhsKTsgfSk7CiAgICBsaXN0LmFwcGVuZENoaWxkKGQpOwogIH0pOwogIHJlbmRlclRyaWdnZXJzKCk7Cn0KZnVuY3Rpb24gc2V0TFcoaSx2KXsgTE9SQVtpXS53PU1hdGgubWF4KDAsTWF0aC5taW4oMix2KSk7IH0KdmFyIF9wZW5kaW5nVHJpZyA9IFtdOwpmdW5jdGlvbiByZW5kZXJUcmlnZ2VycygpewogIHZhciBwPSgkKCdwcm9tcHQnKS52YWx1ZXx8JycpLnRvTG93ZXJDYXNlKCk7CiAgdmFyIHQ9JCgndHJpZ2dlcnMnKTsgdC5pbm5lckhUTUw9Jyc7CiAgX3BlbmRpbmdUcmlnPVtdOwogIExPUkEuZmlsdGVyKGZ1bmN0aW9uKGwpe3JldHVybiBsLnc+MH0pLmZvckVhY2goZnVuY3Rpb24obCl7CiAgICBsLnRhZ3MuZm9yRWFjaChmdW5jdGlvbih3KXsgaWYocC5pbmRleE9mKHcudG9Mb3dlckNhc2UoKSk8MCkgX3BlbmRpbmdUcmlnLnB1c2goe3dvcmQ6dyxsb3JhOmwubmFtZX0pOyB9KTsKICB9KTsKICAkKCd0ci1jb3VudCcpLnRleHRDb250ZW50PV9wZW5kaW5nVHJpZy5sZW5ndGg7CiAgaWYoIV9wZW5kaW5nVHJpZy5sZW5ndGgpeyB0LmlubmVySFRNTD0nPHNwYW4gY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTYwMCI+VGlkYWsgYWRhIHRyaWdnZXIgd29yZCB0ZXJzaXNhPC9zcGFuPic7IHJldHVybjsgfQogIF9wZW5kaW5nVHJpZy5mb3JFYWNoKGZ1bmN0aW9uKGl0ZW0pewogICAgdmFyIGI9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7CiAgICBiLmNsYXNzTmFtZT0ndGFnIGN1cnNvci1wb2ludGVyIGhvdmVyOmJvcmRlci1bIzI3RDRDRF0gaG92ZXI6dGV4dC1bIzI3RDRDRF0gdHJhbnNpdGlvbic7CiAgICBiLmlubmVySFRNTD0nPGkgZGF0YS1pY29uPSJzcGFya2xlIiBjbGFzcz0idy0zIGgtMyB0ZXh0LVsjMjdENENEXSI+PC9pPicraXRlbS53b3JkOwogICAgYi50aXRsZT0nVGFtYmFoa2FuIGtlIHByb21wdCAoJytpdGVtLmxvcmErJyknOwogICAgYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgICAgYWRkV29yZChpdGVtLndvcmQpOwogICAgICByZW5kZXJUcmlnZ2VycygpOwogICAgfSk7CiAgICB0LmFwcGVuZENoaWxkKGIpOwogIH0pOwp9CmZ1bmN0aW9uIGFkZFdvcmQodyl7CiAgdmFyIHByPSQoJ3Byb21wdCcpLCBjdj1wci52YWx1ZS50cmltKCk7CiAgaWYoY3YgJiYgIWN2LmVuZHNXaXRoKCcsJykpIGN2Kz0nLCc7CiAgcHIudmFsdWU9Y3YrdysnLCc7CiAgcHIuZm9jdXMoKTsKfQpmdW5jdGlvbiBhZGRBbGxUcmlnKCl7CiAgdmFyIGFsbD1fcGVuZGluZ1RyaWcubWFwKGZ1bmN0aW9uKHgpe3JldHVybiB4LndvcmR9KTsKICBhbGwuZm9yRWFjaChhZGRXb3JkKTsKICByZW5kZXJUcmlnZ2VycygpOwp9CiQoJ2FkZGFsbC10cmlnJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGFkZEFsbFRyaWcpOwoKLyogPT09PT0gYXNwZWN0IHJhdGlvID09PT09ICovCnZhciBBUl9NQVAgPSB7CiAgcG9ydHJhaXQ6WydQb3J0cmFpdCcsNzY4LDExNTJdLAogIGxhbmRzY2FwZTpbJ0xhbmRzY2FwZScsMTE1Miw3NjhdLAogIHNxdWFyZTpbJ1NxdWFyZScsMTAyNCwxMDI0XSwKICBjdXN0b206WydjdXN0b20nLG51bGwsbnVsbF0KfTsKZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmFyJykuZm9yRWFjaChmdW5jdGlvbihiKXsKICBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICAgdmFyIGFyPWIuZGF0YXNldC5hcjsgc3RhdGUuYXNwZWN0PWFyOwogICAgc2V0QXJBY3RpdmUoYXIpOwogICAgaWYoYXIhPT0nY3VzdG9tJyl7ICQoJ3dpZHRoJykudmFsdWU9QVJfTUFQW2FyXVsxXTsgJCgnaGVpZ2h0JykudmFsdWU9QVJfTUFQW2FyXVsyXTsgfQogICAgdXBkV0goKTsKICB9KTsKfSk7CmZ1bmN0aW9uIHVwZFdIKCl7ICQoJ3d2JykudmFsdWU9JCgnd2lkdGgnKS52YWx1ZTsgJCgnaHYnKS52YWx1ZT0kKCdoZWlnaHQnKS52YWx1ZTsgfQokKCd3aWR0aCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbigpeyAkKCd3dicpLnZhbHVlPSQoJ3dpZHRoJykudmFsdWU7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsKJCgnaGVpZ2h0JykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKCl7ICQoJ2h2JykudmFsdWU9JCgnaGVpZ2h0JykudmFsdWU7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsKJCgnd3YnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLGZ1bmN0aW9uKCl7IHZhciB2PU1hdGgubWF4KDI1NixNYXRoLm1pbigxNTM2LHBhcnNlSW50KCQoJ3d2JykudmFsdWUpfHw3NjgpKTsgdj1NYXRoLnJvdW5kKHYvNjQpKjY0OyAkKCd3dicpLnZhbHVlPXY7ICQoJ3dpZHRoJykudmFsdWU9djsgc3RhdGUuYXNwZWN0PSdjdXN0b20nOyBzZXRBckFjdGl2ZSgnY3VzdG9tJyk7IH0pOwokKCdodicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsZnVuY3Rpb24oKXsgdmFyIHY9TWF0aC5tYXgoMjU2LE1hdGgubWluKDE1MzYscGFyc2VJbnQoJCgnaHYnKS52YWx1ZSl8fDExNTIpKTsgdj1NYXRoLnJvdW5kKHYvNjQpKjY0OyAkKCdodicpLnZhbHVlPXY7ICQoJ2hlaWdodCcpLnZhbHVlPXY7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsKZnVuY3Rpb24gc2V0QXJBY3RpdmUoYXIpewogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hcicpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QudG9nZ2xlKCdzZWwnLCB4LmRhdGFzZXQuYXI9PT1hcil9KTsKICAkKCdhci1sYWJlbCcpLnRleHRDb250ZW50PUFSX01BUFthcl1bMF07Cn0KJCgnc3RlcHMnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7JCgnc3YnKS50ZXh0Q29udGVudD1lLnRhcmdldC52YWx1ZX0pOwokKCdjZmcnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7JCgnY2Z2JykudGV4dENvbnRlbnQ9ZS50YXJnZXQudmFsdWV9KTsKJCgnY2xpcHNraXAnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7JCgnY3N2JykudGV4dENvbnRlbnQ9ZS50YXJnZXQudmFsdWV9KTsKJCgnZXRhbnNkJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpeyQoJ2Vuc2QnKS50ZXh0Q29udGVudD1lLnRhcmdldC52YWx1ZX0pOwokKCdhZHYtdG9nZ2xlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7JCgnYWR2LWZpZWxkcycpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicpfSk7CiQoJ2RpY2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXskKCdzZWVkJykudmFsdWU9U3RyaW5nKE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSo5OTk5OTk5OTk5OTk5OTk5KSl9KTsKJCgnbmVnY2hlY2snKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLGZ1bmN0aW9uKGUpeyQoJ25lZ3dyYXAnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLCFlLnRhcmdldC5jaGVja2VkKX0pOwokKCdwcm9tcHQnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcscmVuZGVyVHJpZ2dlcnMpOwovKiBUcmFuc2xhdGU6IHNlbXVhIGJhaGFzYSAtPiBJbmdncmlzIChiYWNrZW5kIC9hcGkvdHJhbnNsYXRlLCBncmF0aXMpICovCmZ1bmN0aW9uIHNldFRyYW5zbGF0ZUJ1c3koYil7CiAgdmFyIGVsPSQoJ2J0bi10cmFuc2xhdGUnKTsKICBlbC5pbm5lckhUTUw9Yj8nPGkgZGF0YS1pY29uPSJjaXJjbGUtbm90Y2giIGNsYXNzPSJ3LTQgaC00IGFuaW1hdGUtc3BpbiI+PC9pPic6JzxpIGRhdGEtaWNvbj0idHJhbnNsYXRlIiBjbGFzcz0idy00IGgtNCI+PC9pPic7Cn0KJCgnYnRuLXRyYW5zbGF0ZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogIHZhciBwPSgkKCdwcm9tcHQnKS52YWx1ZXx8JycpLnRyaW0oKTsKICBpZighcCl7ICQoJ3Byb21wdCcpLmZvY3VzKCk7IHJldHVybjsgfQogIHNldFRyYW5zbGF0ZUJ1c3kodHJ1ZSk7CiAgZmV0Y2goJy9hcGkvdHJhbnNsYXRlP3E9JytlbmNvZGVVUklDb21wb25lbnQocCkpLnRoZW4oZnVuY3Rpb24ocil7IHJldHVybiByLmpzb24oKTsgfSkudGhlbihmdW5jdGlvbihkKXsKICAgIGlmKGQub2smJmQudGV4dCl7ICQoJ3Byb21wdCcpLnZhbHVlPWQudGV4dDsgcmVuZGVyVHJpZ2dlcnMoKTsgdG9hc3QoJ0RpdGVyamVtYWhrYW4ga2UgSW5nZ3JpcyDinJMnKTsgfQogICAgZWxzZSB0b2FzdChkLmVycm9yfHwnR2FnYWwgbWVuZXJqZW1haGthbicpOwogIH0pLmNhdGNoKGZ1bmN0aW9uKCl7IHRvYXN0KCdHYWdhbCBtZW5lcmplbWFoa2FuJyk7IH0pLmZpbmFsbHkoZnVuY3Rpb24oKXsgc2V0VHJhbnNsYXRlQnVzeShmYWxzZSk7IH0pOwp9KTsKLyogUHJvbXB0IEVuaGFuY2UgKHNlcGVydGkgVGVuc29yLkFydCk6IGhhc2lsIHJlZmluZSB0YW1waWwgZGkgcG9wdXAgdW50dWsKICAgZGlrb25maXJtYXNpL2RpZWRpdCBzZWJlbHVtIGRpcGFrYWkuIEJhY2tlbmQgL2FwaS9yZWZpbmUgKExMTSBQb2xsaW5hdGlvbnMpLAogICBmYWxsYmFjayB0ZW1wbGF0ZSBsb2thbCBrYWxhdSB0YW5wYSBrZXkuICovCnZhciBfZW5oT3JpZz0nJzsKZnVuY3Rpb24gZmFsbGJhY2tFbmhhbmNlKHApewogIHJldHVybiBwCiAgICArJ1xuXG5FbmhhbmNlIGRldGFpbCwgbGlnaHRpbmcsIGNvbXBvc2l0aW9uLCBhbmQgYXRtb3NwaGVyZS4gJwogICAgKydVbHRyYS1kZXRhaWxlZCwgcHJvZmVzc2lvbmFsIHBob3RvZ3JhcGh5LCBzaGFycCBmb2N1cywgY2luZW1hdGljIGxpZ2h0aW5nLic7Cn0KZnVuY3Rpb24gb3BlbkVuaE1vZGFsKHApewogIF9lbmhPcmlnPXA7CiAgJCgnZW5oLW9yaWcnKS50ZXh0Q29udGVudD1wOwogICQoJ2VuaC10ZXh0JykudmFsdWU9Jyc7CiAgJCgnZW5oLW1vZGFsJykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ2VuaC1tb2RhbCcpLmNsYXNzTGlzdC5hZGQoJ2ZsZXgnKTsKfQpmdW5jdGlvbiBjbG9zZUVuaE1vZGFsKCl7ICQoJ2VuaC1tb2RhbCcpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyAkKCdlbmgtbW9kYWwnKS5jbGFzc0xpc3QucmVtb3ZlKCdmbGV4Jyk7IH0KZnVuY3Rpb24gZG9FbmhhbmNlKCl7CiAgdmFyIHA9KCQoJ3Byb21wdCcpLnZhbHVlfHwnJykudHJpbSgpOwogIGlmKCFwKXsgJCgncHJvbXB0JykuZm9jdXMoKTsgcmV0dXJuOyB9CiAgb3BlbkVuaE1vZGFsKHApOwogICQoJ2VuaC10ZXh0JykudmFsdWU9J01lbmdoYXNpbGthbiBwcm9tcHQgeWFuZyBsZWJpaCBiYWlrLi4uJzsKICB2YXIgYj0kKCdlbmgtcmVnZW4nKTsgYi5kaXNhYmxlZD10cnVlOyBiLnN0eWxlLm9wYWNpdHk9JzAuNSc7CiAgZmV0Y2goJy9hcGkvcmVmaW5lJyx7bWV0aG9kOidQT1NUJyxoZWFkZXJzOl9hcGlIZWFkZXJzKHsnQ29udGVudC1UeXBlJzonYXBwbGljYXRpb24vanNvbid9KSxib2R5OkpTT04uc3RyaW5naWZ5KHtwcm9tcHQ6cH0pfSkKICAgIC50aGVuKGZ1bmN0aW9uKHIpeyByZXR1cm4gci5qc29uKCk7IH0pCiAgICAudGhlbihmdW5jdGlvbihkKXsKICAgICAgJCgnZW5oLXRleHQnKS52YWx1ZT0oZC5vayYmZC50ZXh0KT9kLnRleHQ6ZmFsbGJhY2tFbmhhbmNlKHApOwogICAgICBpZighZC5vaykgdG9hc3QoJ1JlZmluZSBvZmZsaW5lIOKAlCBwYWthaSB0ZW1wbGF0ZSBsb2thbCcpOwogICAgfSkKICAgIC5jYXRjaChmdW5jdGlvbigpeyAkKCdlbmgtdGV4dCcpLnZhbHVlPWZhbGxiYWNrRW5oYW5jZShwKTsgdG9hc3QoJ1JlZmluZSBvZmZsaW5lIOKAlCBwYWthaSB0ZW1wbGF0ZSBsb2thbCcpOyB9KQogICAgLmZpbmFsbHkoZnVuY3Rpb24oKXsgYi5kaXNhYmxlZD1mYWxzZTsgYi5zdHlsZS5vcGFjaXR5PScnOyB9KTsKfQokKCdidG4tZW5oYW5jZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxkb0VuaGFuY2UpOwokKCdlbmgtY2xvc2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsY2xvc2VFbmhNb2RhbCk7CiQoJ2VuaC1jYW5jZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsY2xvc2VFbmhNb2RhbCk7CiQoJ2VuaC1tb2RhbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgaWYoZS50YXJnZXQ9PT0kKCdlbmgtbW9kYWwnKSkgY2xvc2VFbmhNb2RhbCgpOyB9KTsKJCgnZW5oLXJlZ2VuJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgJCgncHJvbXB0JykudmFsdWU9KCQoJ2VuaC10ZXh0JykudmFsdWV8fCcnKS50cmltKCl8fF9lbmhPcmlnOwogIHJlbmRlclRyaWdnZXJzKCk7CiAgZG9FbmhhbmNlKCk7Cn0pOwokKCdlbmgtdXNlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgdmFyIHY9KCQoJ2VuaC10ZXh0JykudmFsdWV8fCcnKS50cmltKCk7CiAgaWYoIXYpIHJldHVybjsKICAkKCdwcm9tcHQnKS52YWx1ZT12OyByZW5kZXJUcmlnZ2VycygpOyBjbG9zZUVuaE1vZGFsKCk7IHRvYXN0KCdQcm9tcHQgRW5oYW5jZSBkaXRlcmFwa2FuIOKckycpOwp9KTsKZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNoaXAnKS5mb3JFYWNoKGZ1bmN0aW9uKGMpewogIGMuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7Yy5jbGFzc0xpc3QudG9nZ2xlKCdvbicpfSk7Cn0pOwoKLyogPT09PT0gdGFicyA9PT09PSAqLwpkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcudGFiJykuZm9yRWFjaChmdW5jdGlvbih0KXsKICB0LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRhYicpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QucmVtb3ZlKCdzZWwnKX0pOwogICAgdC5jbGFzc0xpc3QuYWRkKCdzZWwnKTsgc3RhdGUucGFnZT10LmRhdGFzZXQudGFiOwogICAgcmVuZGVyQ2FudmFzKCk7CiAgfSk7Cn0pOwpkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucnRhYicpLmZvckVhY2goZnVuY3Rpb24odCl7CiAgdC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5ydGFiJykuZm9yRWFjaChmdW5jdGlvbih4KXt4LmNsYXNzTGlzdC5yZW1vdmUoJ3NlbCcpfSk7CiAgICB0LmNsYXNzTGlzdC5hZGQoJ3NlbCcpOwogICAgdmFyIHA9dC5kYXRhc2V0LnA7IC8vIGRldGFpbCB8IGhpc3RvcnkKICAgICQoJ3JkZXRhaWwnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLHAhPT0nZGV0YWlsJyk7CiAgICAkKCdyaGlzdG9yeScpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicscCE9PSdoaXN0b3J5Jyk7CiAgfSk7Cn0pOwoKLyogPT09PT0gbW9iaWxlIGRyYXdlciA9PT09PSAqLwokKCdtbWVudScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBvcGVuTGVmdCgpOyB9KTsKJCgnb3ZlcmxheScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBjbG9zZUxlZnQoKTsgfSk7CmZ1bmN0aW9uIG9wZW5MZWZ0KCl7ICQoJ292ZXJsYXknKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgJCgnbGVmdHBhbicpLmNsYXNzTGlzdC5yZW1vdmUoJy10cmFuc2xhdGUteC1mdWxsJyk7IH0KZnVuY3Rpb24gY2xvc2VMZWZ0KCl7ICQoJ292ZXJsYXknKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgaWYod2luZG93LmlubmVyV2lkdGg8MTAyNCkgJCgnbGVmdHBhbicpLmNsYXNzTGlzdC5hZGQoJy10cmFuc2xhdGUteC1mdWxsJyk7IH0KCi8qID09PT09IGltYWdlIGNvdW50IChkcm9wZG93biBkaSBwcm9tcHQgYmFyICsgdG9tYm9sIG5hdmJhcikgPT09PT0gKi8KZnVuY3Rpb24gYXBwbHlOY29sKCl7CiAgdmFyIHNlbD0kKCduY291bnQnKTsgaWYoc2VsKSBzZWwudmFsdWU9U3RyaW5nKHN0YXRlLm5jb2wpOwogIC8vIFRhbXBpbGFuIHRlbmdhaCBzZWxhbHUgMSBnYW1iYXIgc2VzdWFpIGFzcGVjdCByYXRpbyAoc2VwZXJ0aSBUZW5zb3IuQXJ0KS4KICAvLyBuY29sIGhhbnlhIG1lbmVudHVrYW4ganVtbGFoIGdhbWJhciBwZXIgZ2VuZXJhdGUgKGltYWdlQ291bnQpLgogICQoJ25jb2xsYmwnKS50ZXh0Q29udGVudD1TdHJpbmcoc3RhdGUubmNvbCk7CiAgcmVuZGVyR3JpZCgpOwp9CiQoJ25jb2wnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICBzdGF0ZS5uY29sID0gc3RhdGUubmNvbD09PTI/MToyOwogIGFwcGx5TmNvbCgpOwp9KTsKJCgnbmNvdW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbigpewogIHN0YXRlLm5jb2w9cGFyc2VJbnQoJCgnbmNvdW50JykudmFsdWUpfHwxOwogIGFwcGx5TmNvbCgpOwp9KTsKCi8qID09PT09IGdlbmVyYXRlIChyZWFsIEFQSSAvIGRlbW8gZmFsbGJhY2spID09PT09ICovCiQoJ2J0bi1nbycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxkb0dlbmVyYXRlKTsKZnVuY3Rpb24gc2V0QnVzeShiKXsKICB2YXIgZWw9JCgnYnRuLWdvJyk7IGlmKCFlbCkgcmV0dXJuOwogIGVsLmRpc2FibGVkPWI7IGVsLnN0eWxlLm9wYWNpdHk9Yj8nMC41JzonMSc7CiAgZWwuaW5uZXJIVE1MPWI/JzxpIGRhdGEtaWNvbj0iY2lyY2xlLW5vdGNoIiBjbGFzcz0idy00IGgtNCBhbmltYXRlLXNwaW4iPjwvaT5HZW5lcmF0aW5nLi4uJwogICAgOic8aSBkYXRhLWljb249ImxpZ2h0bmluZyIgY2xhc3M9InctNCBoLTQiPjwvaT5HZW5lcmF0ZSA8c3BhbiBjbGFzcz0idGV4dC14cyBvcGFjaXR5LTkwIGZvbnQtbm9ybWFsIiBpZD0icHJpY2UiPi0gMS4yMjwvc3Bhbj4nOwp9CmZ1bmN0aW9uIGV4dHJhY3RJbWFnZXMoZGF0YSl7CiAgaWYoIWRhdGEpIHJldHVybiBbXTsKICBpZihBcnJheS5pc0FycmF5KGRhdGEpKSBkYXRhPXtpbWFnZXM6ZGF0YX07CiAgdmFyIGltZ3M9ZGF0YS5pbWFnZXN8fGRhdGEuZGF0YSYmZGF0YS5kYXRhLmltYWdlc3x8ZGF0YS5yZXN1bHQmJmRhdGEucmVzdWx0LmltYWdlc3x8ZGF0YS51cmxzfHxbXTsKICByZXR1cm4gaW1ncy5tYXAoZnVuY3Rpb24oaSl7IHJldHVybiB0eXBlb2YgaT09PSdzdHJpbmcnP2k6KGkudXJsfHxpLnNyY3x8aS5pbWFnZXx8aS5wYXRoKTsgfSkuZmlsdGVyKEJvb2xlYW4pOwp9Ci8qID09PT09IGhhc2lsICsgcml3YXlhdCAocGVyc2lzdCBsb2NhbFN0b3JhZ2UpID09PT09ICovCmZ1bmN0aW9uIHBlcnNpc3RSZXN1bHRzKCl7CiAgdHJ5eyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShSRVNVTFRTX0tFWSxKU09OLnN0cmluZ2lmeShzdGF0ZS5yZXN1bHRzLnNsaWNlKDAsNjApKSk7IH1jYXRjaChlKXt9Cn0KLyogVGFtcGlsYW4gdGVuZ2FoOiAxIGdhbWJhciBzZXN1YWkgYXNwZWN0IHJhdGlvIChzZXBlcnRpIFRlbnNvci5BcnQpLAogICBvYmplY3QtY29udGFpbiArIGNlbnRlcmVkICsgbmF2IHByZXYvbmV4dCBsZXdhdCByaXdheWF0LiAqLwp2YXIgX3ZpZXdJZHg9MDsgLy8gaW5kZXgga2Ugc3RhdGUucmVzdWx0cyAoMCA9IHRlcmJhcnUpCmZ1bmN0aW9uIHJlbmRlckdyaWQoKXsKICB2YXIgZ3JpZD0kKCdncmlkJyk7IGdyaWQuaW5uZXJIVE1MPScnOwogIGlmKCFzdGF0ZS5yZXN1bHRzLmxlbmd0aCl7ICQoJ2VtcHR5Jykuc3R5bGUuZGlzcGxheT0nJzsgcmV0dXJuOyB9CiAgJCgnZW1wdHknKS5zdHlsZS5kaXNwbGF5PSdub25lJzsKICBpZihfdmlld0lkeD49c3RhdGUucmVzdWx0cy5sZW5ndGgpIF92aWV3SWR4PXN0YXRlLnJlc3VsdHMubGVuZ3RoLTE7CiAgdmFyIHI9c3RhdGUucmVzdWx0c1tfdmlld0lkeF07CiAgdmFyIHdyYXA9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgd3JhcC5jbGFzc05hbWU9J3JlbGF0aXZlIGZsZXggZmxleC1jb2wgaXRlbXMtY2VudGVyIHctZnVsbCc7CiAgdmFyIGltZz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbWcnKTsKICBpbWcuc3JjPXIuc3JjOwogIGltZy5jbGFzc05hbWU9J21heC13LWZ1bGwgbWF4LWgtW2NhbGMoMTAwdmgtMjUwcHgpXSB3LWF1dG8gb2JqZWN0LWNvbnRhaW4gcm91bmRlZC14bCBib3JkZXIgYmQgYmctYmxhY2svNDAgY3Vyc29yLXpvb20taW4nOwogIGltZy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgb3BlbkxpZ2h0Ym94KHIpOyB9KTsKICB3cmFwLmFwcGVuZENoaWxkKGltZyk7CiAgaWYoci5kZW1vKXsKICAgIHZhciBiZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdzcGFuJyk7CiAgICBiZC5jbGFzc05hbWU9J2Fic29sdXRlIHRvcC0yIGxlZnQtMiB0ZXh0LVs5cHhdIGJnLWJsYWNrLzYwIHB4LTEuNSBweS0wLjUgcm91bmRlZCB0ZXh0LW5ldXRyYWwtMzAwJzsKICAgIGJkLnRleHRDb250ZW50PSdERU1PJzsgd3JhcC5hcHBlbmRDaGlsZChiZCk7CiAgfQogIGdyaWQuYXBwZW5kQ2hpbGQod3JhcCk7Cn0KZnVuY3Rpb24gYWRkUmVzdWx0KHIpewogIHN0YXRlLnJlc3VsdHMudW5zaGlmdChyKTsKICBpZihzdGF0ZS5yZXN1bHRzLmxlbmd0aD42MCkgc3RhdGUucmVzdWx0cy5sZW5ndGg9NjA7CiAgX3ZpZXdJZHg9MDsgLy8gdGFtcGlsa2FuIGhhc2lsIHRlcmJhcnUKICBwZXJzaXN0UmVzdWx0cygpOwogIHJlbmRlckdyaWQoKTsKICByZW5kZXJEZXRhaWwoKTsKICByZW5kZXJSaWdodCgpOwp9CgovKiA9PT09PSBwYW5lbCBrYW5hbjogRGV0YWlsIGhhc2lsIGFrdGlmIChzZXBlcnRpIFRlbnNvci5BcnQpID09PT09ICovCmZ1bmN0aW9uIGZtdERhdGUodHMpeyB0cnl7IHJldHVybiBuZXcgRGF0ZSh0cykudG9Mb2NhbGVEYXRlU3RyaW5nKCdpZC1JRCcpOyB9Y2F0Y2goZSl7IHJldHVybiAnJzsgfSB9CmZ1bmN0aW9uIGZtdERhdGVUaW1lKHRzKXsgdHJ5eyByZXR1cm4gbmV3IERhdGUodHMpLnRvTG9jYWxlU3RyaW5nKCdpZC1JRCcpOyB9Y2F0Y2goZSl7IHJldHVybiAnJzsgfSB9CmZ1bmN0aW9uIGNvcHlUZXh0KHYpewogIGlmKCF2KSByZXR1cm47CiAgaWYobmF2aWdhdG9yLmNsaXBib2FyZCYmbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQpeyBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dCh2KS50aGVuKGZ1bmN0aW9uKCl7IHRvYXN0KCdUZXJzYWxpbiDinJMnKTsgfSk7IH0KICBlbHNlIHRvYXN0KCdUYXNrIElEOiAnK3YpOwp9CmZ1bmN0aW9uIHJlbmRlckRldGFpbCgpewogIHZhciBlbD0kKCdyZGV0YWlsJyk7IGlmKCFlbCkgcmV0dXJuOwogIGlmKCFzdGF0ZS5yZXN1bHRzLmxlbmd0aCl7IGVsLmlubmVySFRNTD0nPHAgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBwLTQgdGV4dC1jZW50ZXIiPkJlbHVtIGFkYSBoYXNpbC48L3A+JzsgcmV0dXJuOyB9CiAgaWYoX3ZpZXdJZHg+PXN0YXRlLnJlc3VsdHMubGVuZ3RoKSBfdmlld0lkeD1zdGF0ZS5yZXN1bHRzLmxlbmd0aC0xOwogIHZhciByPXN0YXRlLnJlc3VsdHNbX3ZpZXdJZHhdOwogIHZhciBsYmw9ci5kZW1vPydEZW1vIChzaW11bGFzaSknOihyLnBhZ2U9PT0naW1nJz8nSW1hZ2UgdG8gSW1hZ2UnOidUZXh0IHRvIEltYWdlJyk7CiAgdmFyIGV4cGlyZXM9ci50cz9uZXcgRGF0ZShyLnRzKzcqMjQqMzYwMCoxMDAwKS50b0xvY2FsZVN0cmluZygnaWQtSUQnKTonJzsKICB2YXIgaD0nJzsKICAvLyBtb2RlbCBiYWRnZQogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMi41IGJvcmRlciBiZCByb3VuZGVkLXhsIHAtMi41IGJnLVsjMWMyMTI4XSI+JwogICAgKyc8aW1nIHNyYz0iJysoci5zcmN8fCcnKSsnIiBjbGFzcz0idy0xMCBoLTEwIHJvdW5kZWQtbGcgb2JqZWN0LWNvdmVyIGJvcmRlciBiZCIvPicKICAgICsnPGRpdiBjbGFzcz0ibWluLXctMCI+PGRpdiBjbGFzcz0idGV4dC14cyBmb250LW1lZGl1bSB0cnVuY2F0ZSI+Jysoci5tb2RlbHx8J01vZGVsJykrJzwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0idGV4dC1bMTBweF0gdGV4dC1uZXV0cmFsLTUwMCI+JytsYmwrJzwvZGl2PjwvZGl2PicKICAgICsnPGJ1dHRvbiBjbGFzcz0ibWwtYXV0byB3LTcgaC03IGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHRleHQtbmV1dHJhbC01MDAgaG92ZXI6dGV4dC13aGl0ZSIgdGl0bGU9IlR1dHVwIGRldGFpbCI+PGkgZGF0YS1pY29uPSJ4IiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPicKICAgICsnPC9kaXY+JzsKICAvLyBpbnB1dCBwcm9tcHQKICBoKz0nPGRpdj48ZGl2IGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIG1iLTEiPklucHV0PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJiZy1ibGFjay80MCBib3JkZXIgYmQgcm91bmRlZC1sZyBwLTIuNSB0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtMzAwIGxlYWRpbmctcmVsYXhlZCBtYXgtaC0yOCBvdmVyZmxvdy15LWF1dG8gaGlkZWJhciI+Jysoci5wcm9tcHR8fCctJykrJzwvZGl2PjwvZGl2Pic7CiAgLy8gZGV0YWlscwogIGgrPSc8ZGl2PjxkaXYgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAgbWItMSI+RGV0YWlsczwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0ic3BhY2UteS0xLjUgdGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTQwMCI+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiBnYXAtMiI+PHNwYW4+VGFzayBJRDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSBtaW4tdy0wIj48c3BhbiBjbGFzcz0idHJ1bmNhdGUiIHRpdGxlPSInK2VzYyhyLnRhc2tJZCkrJyI+Jysoci50YXNrSWR8fCctJykrJzwvc3Bhbj4nCiAgICArKHIudGFza0lkPyc8YnV0dG9uIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgc2hyaW5rLTAiIHRpdGxlPSJTYWxpbiI+PGkgZGF0YS1pY29uPSJjb3B5IiBjbGFzcz0idy0zLjUgaC0zLjUiPjwvaT48L2J1dHRvbj4nOicnKSsnPC9zcGFuPjwvZGl2PicKICAgICsoci5jcmVkaXRzPyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q3JlZGl0czwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+JytyLmNyZWRpdHMrJzwvc3Bhbj48L2Rpdj4nOicnKQogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q3JlYXRlZCBkYXRlPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK2ZtdERhdGVUaW1lKHIudHMpKyc8L3NwYW4+PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+RXhwaXJlcyBkYXRlPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK2V4cGlyZXMrJzwvc3Bhbj48L2Rpdj4nCiAgICArJzwvZGl2PjwvZGl2Pic7CiAgLy8gbmVnYXRpdmUgcHJvbXB0CiAgaCs9JzxkaXY+PGRpdiBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCBtYi0xIj5OZWdhdGl2ZSBwcm9tcHQ8L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImJnLWJsYWNrLzQwIGJvcmRlciBiZCByb3VuZGVkLWxnIHAtMi41IHRleHQtWzExcHhdIHRleHQtbmV1dHJhbC0zMDAgbGVhZGluZy1yZWxheGVkIG1heC1oLTIwIG92ZXJmbG93LXktYXV0byBoaWRlYmFyIj4nKyhyLm5lZ3x8Jy0nKSsnPC9kaXY+PC9kaXY+JzsKICAvLyBwYXJhbXMKICBoKz0nPGRpdiBjbGFzcz0iZ3JpZCBncmlkLWNvbHMtMiBnYXAteC0zIGdhcC15LTEuNSB0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNDAwIGJvcmRlci10IGJkIHB0LTIuNSI+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2l6ZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+JytyLnNpemUrJzwvc3Bhbj48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TZWVkPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIHRydW5jYXRlIj4nK3Iuc2VlZCsnPC9zcGFuPjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlN0ZXBzPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nKyhyLnN0ZXBzIT1udWxsP3Iuc3RlcHM6Jy0nKSsnPC9zcGFuPjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNGRyBzY2FsZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+Jysoci5jZmchPW51bGw/ci5jZmc6Jy0nKSsnPC9zcGFuPjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNhbXBsZXI8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrKHIuc2FtcGxlcnx8Jy0nKSsnPC9zcGFuPjwvZGl2PicKICAgICsnPC9kaXY+JzsKICBlbC5pbm5lckhUTUw9aDsKICB2YXIgY29weUJ0bj1lbC5xdWVyeVNlbGVjdG9yKCdidXR0b25bdGl0bGU9IlNhbGluIl0nKTsKICBpZihjb3B5QnRuKSBjb3B5QnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBjb3B5VGV4dChyLnRhc2tJZCk7IH0pOwogIHZhciBjbG9zZUJ0bj1lbC5xdWVyeVNlbGVjdG9yKCdidXR0b25bdGl0bGU9IlR1dHVwIGRldGFpbCJdJyk7CiAgaWYoY2xvc2VCdG4pIGNsb3NlQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyAkKCdyaWdodFBhbicpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyB9KTsKfQpmdW5jdGlvbiBlc2Mocyl7IHJldHVybiBTdHJpbmcocz09bnVsbD8nJzpzKS5yZXBsYWNlKC8mL2csJyZhbXA7JykucmVwbGFjZSgvPC9nLCcmbHQ7JykucmVwbGFjZSgvPi9nLCcmZ3Q7JykucmVwbGFjZSgvIi9nLCcmcXVvdDsnKTsgfQoKLyogPT09PT0gcmlnaHQgaGlzdG9yeSA9PT09PSAqLwpmdW5jdGlvbiByZW5kZXJSaWdodCgpewogIHZhciBsaXN0PSQoJ3JsaXN0Jyk7IGxpc3QuaW5uZXJIVE1MPScnOwogIGlmKCFzdGF0ZS5yZXN1bHRzLmxlbmd0aCl7IGxpc3QuaW5uZXJIVE1MPSc8cCBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIHAtNCB0ZXh0LWNlbnRlciI+QmVsdW0gYWRhIGhhc2lsLjwvcD4nOyAkKCdyY291bnQnKS50ZXh0Q29udGVudD0nMCBoYXNpbCc7IHJldHVybjsgfQogICQoJ3Jjb3VudCcpLnRleHRDb250ZW50PXN0YXRlLnJlc3VsdHMubGVuZ3RoKycgaGFzaWwnOwogIHN0YXRlLnJlc3VsdHMuZm9yRWFjaChmdW5jdGlvbihyLGkpewogICAgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7IGQuY2xhc3NOYW1lPSdyY2FyZCc7CiAgICB2YXIgbGJsPXIuZGVtbz8nRGVtbyAoc2ltdWxhc2kpJzooci5wYWdlPT09J2ltZyc/J0ltYWdlIHRvIEltYWdlJzonVGV4dCB0byBJbWFnZScpOwogICAgZC5pbm5lckhUTUw9JzxkaXYgY2xhc3M9InJlbGF0aXZlIj4nCiAgICAgICsnPGltZyBzcmM9Iicrci5zcmMrJyIgY2xhc3M9InctZnVsbCBhc3BlY3QtWzQvM10gb2JqZWN0LWNvdmVyIGN1cnNvci1wb2ludGVyIi8+JwogICAgICArJzxidXR0b24gY2xhc3M9ImFic29sdXRlIHRvcC0xLjUgcmlnaHQtMS41IHctNiBoLTYgcm91bmRlZC1tZCBiZy1ibGFjay81MCBob3ZlcjpiZy1yZWQtNTAwLzgwIHRleHQtd2hpdGUgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC14cyIgdGl0bGU9IkhhcHVzIj7inJU8L2J1dHRvbj4nCiAgICAgICsnPC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9InAtMi41IHNwYWNlLXktMS41IHRleHQteHMiPicKICAgICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41Ij48aSBkYXRhLWljb249InNwYXJrbGUiIGNsYXNzPSJ3LTMgaC0zIHRleHQtdmlvbGV0LTQwMCI+PC9pPjxzcGFuIGNsYXNzPSJiZy12aW9sZXQtNTAwLzEwIHRleHQtdmlvbGV0LTMwMCBweC0xLjUgcHktcHggcm91bmRlZCB0ZXh0LVsxMHB4XSI+JytsYmwrJzwvc3Bhbj48L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0iYmctYmxhY2svNDAgcm91bmRlZCBwLTEuNSB0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtMzAwIGxlYWRpbmctc251ZyBjdXJzb3ItcG9pbnRlciBob3Zlcjp0ZXh0LXdoaXRlIiB0aXRsZT0iTGloYXQgZGV0YWlsIj4nKyhyLnByb21wdHx8JycpLnNsaWNlKDAsOTApKyc8L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEgdGV4dC1bMTBweF0gdGV4dC1uZXV0cmFsLTUwMCI+PGkgZGF0YS1pY29uPSJsYXllcnMiIGNsYXNzPSJ3LTMgaC0zIj48L2k+JytMT1JBLmZpbHRlcihmdW5jdGlvbihsKXtyZXR1cm4gbC53PjB9KS5sZW5ndGgrJyBMb1JBPC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9InNwYWNlLXktMSB0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNTAwIj4nCiAgICAgICsoci50YXNrSWQ/JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5UYXNrIElEPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIHRydW5jYXRlIG1heC13LVs2MCVdIiB0aXRsZT0iJytlc2Moci50YXNrSWQpKyciPicrZXNjKHIudGFza0lkKSsnPC9zcGFuPjwvZGl2Pic6JycpCiAgICAgICsoci5jcmVkaXRzPyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q3JlZGl0czwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+JytyLmNyZWRpdHMrJzwvc3Bhbj48L2Rpdj4nOicnKQogICAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DcmVhdGVkPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK2ZtdERhdGUoci50cykrJzwvc3Bhbj48L2Rpdj4nCiAgICAgICsoci5uZWc/JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5OZWdhdGl2ZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCB0cnVuY2F0ZSBtYXgtdy1bNjAlXSIgdGl0bGU9IicrZXNjKHIubmVnKSsnIj4nK2VzYyhyLm5lZykrJzwvc3Bhbj48L2Rpdj4nOicnKQogICAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TaXplPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK3Iuc2l6ZSsnPC9zcGFuPjwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2VlZDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+JytyLnNlZWQrJzwvc3Bhbj48L2Rpdj4nCiAgICAgICsnPC9kaXY+PC9kaXY+JzsKICAgIGQucXVlcnlTZWxlY3RvcignaW1nJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IF92aWV3SWR4PWk7IHJlbmRlckdyaWQoKTsgcmVuZGVyRGV0YWlsKCk7IG9wZW5MaWdodGJveChyKTsgfSk7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5iZy1ibGFja1xcLzQwJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IF92aWV3SWR4PWk7IHJlbmRlckdyaWQoKTsgcmVuZGVyRGV0YWlsKCk7IG9wZW5MaWdodGJveChyKTsgfSk7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJ2J1dHRvbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICAgICBzdGF0ZS5yZXN1bHRzLnNwbGljZShpLDEpOyBwZXJzaXN0UmVzdWx0cygpOyByZW5kZXJHcmlkKCk7IHJlbmRlckRldGFpbCgpOyByZW5kZXJSaWdodCgpOwogICAgfSk7CiAgICBsaXN0LmFwcGVuZENoaWxkKGQpOwogIH0pOwp9CgovKiA9PT09PSBsaWdodGJveCA9PT09PSAqLwpmdW5jdGlvbiBvcGVuTGlnaHRib3gocil7CiAgJCgnbGItaW1nJykuc3JjPXIuc3JjOwogIHZhciBoPScnOwogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+TW9kZWw8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrKHIubW9kZWx8fCctJykrJzwvc3Bhbj48L2Rpdj4nOwogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+UHJvbXB0PC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nKyhyLnByb21wdHx8Jy0nKSsnPC9zcGFuPjwvZGl2Pic7CiAgaWYoci5uZWcpIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+TmVnYXRpdmU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrci5uZWcrJzwvc3Bhbj48L2Rpdj4nOwogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2l6ZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+Jysoci5zaXplfHwnLScpKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNlZWQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrKHIuc2VlZHx8Jy0nKSsnPC9zcGFuPjwvZGl2Pic7CiAgaWYoci50YXNrSWQpIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+VGFzayBJRDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+JytyLnRhc2tJZCsnPC9zcGFuPjwvZGl2Pic7CiAgaWYoci5jcmVkaXRzKSBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNyZWRpdHM8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrci5jcmVkaXRzKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0ibXQtMiI+PGEgaHJlZj0iJytyLnNyYysnIiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciIgY2xhc3M9InRleHQtWyM2RjVERkZdIGhvdmVyOnVuZGVybGluZSB0ZXh0LXhzIj5CdWthIGdhbWJhciBhc2xpICZuZWFycjs8L2E+PC9kaXY+JzsKICAkKCdsYi1tZXRhJykuaW5uZXJIVE1MPWg7CiAgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QuYWRkKCdmbGV4Jyk7Cn0KJCgnbGItY2xvc2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QucmVtb3ZlKCdmbGV4Jyk7IH0pOwokKCdsaWdodGJveCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgaWYoZS50YXJnZXQ9PT0kKCdsaWdodGJveCcpKXsgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QucmVtb3ZlKCdmbGV4Jyk7IH0gfSk7CgovKiA9PT09PSBwYXlsb2FkIChzdHJ1a3R1ciBueWF0YSBUZW5zb3IuQXJ0KSA9PT09PSAqLwpmdW5jdGlvbiBidWlsZFBheWxvYWQoKXsKICB2YXIgbmVnPSQoJ25lZ2NoZWNrJykuY2hlY2tlZD8kKCduZWdwcm9tcHQnKS52YWx1ZTonJzsKICB2YXIgbT1zdGF0ZS5tb2RlbDsKICByZXR1cm4gewogICAgcGFyYW1zOnsKICAgICAgYmFzZU1vZGVsOnsgbW9kZWxJZDptLm1vZGVsSWQsIG1vZGVsRmlsZUlkOm0ubW9kZWxGaWxlSWQgfSwKICAgICAgbW9kZWw6c2V0dGluZ3MucHJvdmlkZXI9PT0ndGFtcyc/Jyc6KG0mJm0ubW9kZWw/bS5tb2RlbDonJyksCiAgICAgIHNkeGw6eyByZWZpbmVyOmZhbHNlIH0sCiAgICAgIG1vZGVsczpMT1JBLmZpbHRlcihmdW5jdGlvbihsKXtyZXR1cm4gbC53PjB9KS5tYXAoZnVuY3Rpb24obCl7cmV0dXJuIHsgbmFtZTpsLm5hbWUsIHdlaWdodDpsLncsIHRyaWdnZXJXb3JkczpsLnRhZ3MsIGxvcmFNb2RlbDpsLmxvcmFNb2RlbHx8JycsIGxvcmFVcmw6bC5sb3JhVXJsfHwnJyB9IH0pLAogICAgICBlbWJlZGRpbmdNb2RlbHM6W10sCiAgICAgIHNkVmFlOiQoJ3ZhZScpLnZhbHVlPT09J2F1dG9tYXRpYyc/J0F1dG9tYXRpYyc6JCgndmFlJykudmFsdWUsCiAgICAgIHByb21wdDokKCdwcm9tcHQnKS52YWx1ZSwKICAgICAgbmVnYXRpdmVQcm9tcHQ6bmVnLAogICAgICBoZWlnaHQ6cGFyc2VJbnQoJCgnaGVpZ2h0JykudmFsdWUpLAogICAgICB3aWR0aDpwYXJzZUludCgkKCd3aWR0aCcpLnZhbHVlKSwKICAgICAgaW1hZ2VDb3VudDpzdGF0ZS5uY29sLAogICAgICBzdGVwczpwYXJzZUludCgkKCdzdGVwcycpLnZhbHVlKSwKICAgICAgaW1hZ2VzOmkyaURhdGFVcmw/W2kyaURhdGFVcmxdOltdLAogICAgICBkZW5vaXNpbmdTdHJlbmd0aDpwYXJzZUZsb2F0KCQoJ2kyaS1kcycpLnZhbHVlKXx8MC41LAogICAgICBjZmdTY2FsZTpwYXJzZUZsb2F0KCQoJ2NmZycpLnZhbHVlKSwKICAgICAgc2VlZDooJCgnc2VlZCcpLnZhbHVlfHwnJykudHJpbSgpfHxTdHJpbmcoTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKjk5OTk5OTk5OTkpKSwKICAgICAgY2xpcFNraXA6cGFyc2VJbnQoJCgnY2xpcHNraXAnKS52YWx1ZSksCiAgICAgIGV0YU5vaXNlU2VlZERlbHRhOnBhcnNlSW50KCQoJ2V0YW5zZCcpLnZhbHVlKSwKICAgICAgdjFDbGlwOmZhbHNlLAogICAgICBlbmFibGVQaXgycGl4OnN0YXRlLnBhZ2U9PT0naW1nJyYmISFpMmlEYXRhVXJsLAogICAgICBndWlkYW5jZTozLjUsCiAgICAgIHVzZUZpcnN0TGFzdEZyYW1lOmZhbHNlLAogICAgICBrc2FtcGxlck5hbWU6JCgnc2FtcGxlcicpLnZhbHVlLAogICAgICBzY2hlZHVsZTokKCdzY2hlZCcpLnZhbHVlCiAgICB9LAogICAgcHJvdmlkZXI6c2V0dGluZ3MucHJvdmlkZXJ8fCd0YW1zJywKICAgIGNyZWRpdHM6MS4yMiwKICAgIHRhc2tUeXBlOnN0YXRlLnBhZ2U9PT0naW1nJyYmaTJpRGF0YVVybD8nSU1HMklNRyc6J1RYVDJJTUcnLAogICAgaXNSZW1peDpmYWxzZSwKICAgIGNhcHRjaGFUeXBlOidDTE9VREZMQVJFX1RVUk5TVElMRScKICB9Owp9Ci8qID09PT09PT09PT09PSBSRUtUWSBHRU5FUkFUT1Ig4oCUIHZlcnNpIHdlYiBmdWxsID09PT09PT09PT09PQogKiBHZW5lcmF0ZSBhc2xpIHZpYSBiYWNrZW5kICgvYXBpIC0+IFRlbnNvci5BcnQgTW9kZWwgU2VydmljZSkKICogYXRhdSBtb2RlIGRlbW8gKHBpY3N1bSkga2FsYXUgYmFja2VuZC9BUEkga2V5IGJlbHVtIGFrdGlmLgogKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCnZhciBTRVRUSU5HU19LRVk9J3Jla3R5LnNldHRpbmdzJywgUkVTVUxUU19LRVk9J3Jla3R5LnJlc3VsdHMnOwp2YXIgc2V0dGluZ3M9eyBtb2RlOidhdXRvJywgcHJvdmlkZXI6J3RhbXMnLCBhcGlLZXk6JycsIHBvbGxTZXNzaW9uOicnIH07CnZhciBQUk9WSURFUl9JTkZPPXsKICB0YW1zOnsgbGFiZWw6J0FQSSBLZXkgVEFNUyAodGFtcy50ZW5zb3IuYXJ0KScsIGhpbnQ6J0dyYXRpcyBkaSB0YW1zLnRlbnNvci5hcnQg4oCUIHBha2FpIGRhZnRhciBNb2RlbCBkaSBVSS4nIH0sCiAgcmVwbGljYXRlOnsgbGFiZWw6J0FQSSBUb2tlbiBSZXBsaWNhdGUgKHJlcGxpY2F0ZS5jb20pJywgaGludDonUGlsaWggbW9kZWwgZGkga2FydHUgTW9kZWwgKEZMVVgsIFNEWEwsIGRzdCkuIEltZzJJbWcgYmVsdW0gZGlkdWt1bmcuJyB9LAogIGZhbDp7IGxhYmVsOidBUEkgS2V5IGZhbC5haSAoZmFsLmFpKScsIGhpbnQ6J1BpbGloIG1vZGVsIGRpIGthcnR1IE1vZGVsIChGTFVYLCBTRFhMLCBkc3QpLiBJbWcySW1nIGJlbHVtIGRpZHVrdW5nLicgfSwKICBwb2xsaW5hdGlvbnM6eyBsYWJlbDonQVBJIEtleSBQb2xsaW5hdGlvbnMgKG9wc2lvbmFsIOKAlCBza18qKScsIGhpbnQ6J0dyYXRpcyB0YW5wYSBrZXkgKG1vZGVsIG90b21hdGlzKS4gSXNpIGtleSBza18qIGRhcmkgZW50ZXIucG9sbGluYXRpb25zLmFpL2tleXMgdW50dWsgZGFmdGFyIG1vZGVsIGxlbmdrYXAuIEhhc2lsIG90b21hdGlzIGRpYXJzaXAgcGVybWFuZW4uJyB9Cn07CgpmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKXsKICB0cnl7CiAgICB2YXIgcz1KU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFNFVFRJTkdTX0tFWSl8fCd7fScpOwogICAgaWYocyYmdHlwZW9mIHM9PT0nb2JqZWN0Jyl7CiAgICAgIHNldHRpbmdzLm1vZGU9cy5tb2RlfHwnYXV0byc7IHNldHRpbmdzLnByb3ZpZGVyPXMucHJvdmlkZXJ8fCd0YW1zJzsgc2V0dGluZ3MuYXBpS2V5PXMuYXBpS2V5fHwnJzsKICAgICAgc2V0dGluZ3MucG9sbFNlc3Npb249cy5wb2xsU2Vzc2lvbnx8Jyc7CiAgICB9CiAgfWNhdGNoKGUpe30KfQpmdW5jdGlvbiBzYXZlU2V0dGluZ3MoKXsgdHJ5eyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTRVRUSU5HU19LRVksSlNPTi5zdHJpbmdpZnkoc2V0dGluZ3MpKTsgfWNhdGNoKGUpe30gfQpmdW5jdGlvbiBhcHBseVNldHRpbmdzVUkoKXsKICAkKCdhcGltb2RlJykudmFsdWU9c2V0dGluZ3MubW9kZTsgJCgnYXBpa2V5JykudmFsdWU9c2V0dGluZ3MuYXBpS2V5OwogIHVwZGF0ZVByb3ZpZGVyVUkoKTsKfQpmdW5jdGlvbiB1cGRhdGVQcm92aWRlclVJKCl7CiAgdmFyIGluZm89UFJPVklERVJfSU5GT1tzZXR0aW5ncy5wcm92aWRlcl18fFBST1ZJREVSX0lORk8udGFtczsKICAkKCdhcGlwcm92aWRlcicpLnZhbHVlPXNldHRpbmdzLnByb3ZpZGVyOwogICQoJ2FwaWtleS1sYWJlbCcpLnRleHRDb250ZW50PWluZm8ubGFiZWw7CiAgJCgnYXBpLWhpbnQnKS50ZXh0Q29udGVudD1pbmZvLmhpbnQ7CiAgdmFyIGlzUG9sbD1zZXR0aW5ncy5wcm92aWRlcj09PSdwb2xsaW5hdGlvbnMnOwogICQoJ2FwaWtleS1maWVsZCcpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicsaXNQb2xsKTsKICAkKCdieW9wLXJvdycpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicsIWlzUG9sbCk7CiAgaWYoaXNQb2xsKSByZWZyZXNoT0F1dGhTdGF0dXMoKTsKICB1cGRhdGVBcGlTdGF0dXMoKTsKICAvLyBHYW50aSBkYWZ0YXIgbW9kZWwgc2VzdWFpIHByb3ZpZGVyIGFrdGlmLgogIHZhciBsaWI9TU9ERUxfTElCU1tzZXR0aW5ncy5wcm92aWRlcl18fE1PREVMX0xJQlMudGFtczsKICBpZihNT0RFTFMhPT1saWIpewogICAgTU9ERUxTPWxpYjsKICAgIGlmKE1PREVMUy5sZW5ndGgpIHNldE1vZGVsKE1PREVMU1swXSk7CiAgfQogIC8vIEdhbnRpIGRhZnRhciBMb1JBIHNlc3VhaSBwcm92aWRlciAoTG9SQSBsYW1hIGRpYmVyc2loa2FuKS4KICBMT1JBX0xJQj1MT1JBX0xJQlNbc2V0dGluZ3MucHJvdmlkZXJdfHxMT1JBX0xJQlMudGFtczsKICBMT1JBLmxlbmd0aD0wOwogIHJlbmRlckxvcmEoKTsKICAvLyBQb2xsaW5hdGlvbnM6IGFtYmlsIGRhZnRhciBtb2RlbCBhc2xpIGRhcmkgQVBJIChmYWxsYmFjayBrZSBkYWZ0YXIgc3RhdGlzKS4KICBpZihzZXR0aW5ncy5wcm92aWRlcj09PSdwb2xsaW5hdGlvbnMnKSByZWZyZXNoUG9sbGluYXRpb25zTW9kZWxzKCk7Cn0KZnVuY3Rpb24gcmVmcmVzaFBvbGxpbmF0aW9uc01vZGVscygpewogIGZldGNoKCcvYXBpL3BvbGxpbmF0aW9ucy1tb2RlbHMnKS50aGVuKGZ1bmN0aW9uKHIpeyByZXR1cm4gci5qc29uKCk7IH0pLnRoZW4oZnVuY3Rpb24oZCl7CiAgICBpZighZHx8IUFycmF5LmlzQXJyYXkoZC5tb2RlbHMpfHwhZC5tb2RlbHMubGVuZ3RoKSByZXR1cm47CiAgICB2YXIgbGliPWQubW9kZWxzCiAgICAgIC5maWx0ZXIoZnVuY3Rpb24obSl7IHJldHVybiBtLmNhdGVnb3J5PT09J2ltYWdlJyYmbS5uYW1lJiZtLm5hbWUuaW5kZXhPZignYnlvcC8nKSE9PTA7IH0pCiAgICAgIC5zbGljZSgwLDgwKQogICAgICAubWFwKGZ1bmN0aW9uKG0peyByZXR1cm4geyBuYW1lOm0udGl0bGV8fG0ubmFtZSwgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDptLmJyYW5kfHwnJywgdGh1bWI6U3RyaW5nKG0ubmFtZSkucmVwbGFjZSgvW15hLXowLTldL2dpLCcnKSwgYmFkZ2U6bS5wYWlkX29ubHk/J1BBSUQnOidGUkVFJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDptLm5hbWUgfTsgfSkKICAgICAgLnNvcnQoZnVuY3Rpb24oYSxiKXsgcmV0dXJuIChhLmJhZGdlPT09J1BBSUQnPzE6MCktKGIuYmFkZ2U9PT0nUEFJRCc/MTowKTsgfSk7CiAgICBpZighbGliLmxlbmd0aCkgcmV0dXJuOwogICAgTU9ERUxfTElCUy5wb2xsaW5hdGlvbnM9bGliOwogICAgaWYoTU9ERUxTPT09TU9ERUxfTElCUy5wb2xsaW5hdGlvbnMpeyBzZXRNb2RlbChNT0RFTFNbMF0pOyB9CiAgfSkuY2F0Y2goZnVuY3Rpb24oKXt9KTsKfQpmdW5jdGlvbiB1cGRhdGVBcGlTdGF0dXMoKXsKICB2YXIgZWw9JCgnYXBpLXN0YXR1cycpOyBpZighZWwpIHJldHVybjsKICBpZihzZXR0aW5ncy5wcm92aWRlcj09PSdwb2xsaW5hdGlvbnMnKXsKICAgIGVsLnRleHRDb250ZW50PXNldHRpbmdzLnBvbGxTZXNzaW9uPydQb2xsaW5hdGlvbnMgwrcgQllPUCc6J1BvbGxpbmF0aW9ucyDCtyBncmF0aXMnOwogICAgZWwuc3R5bGUuY29sb3I9c2V0dGluZ3MucG9sbFNlc3Npb24/JyMyN0Q0Q0QnOicjOWE5YWEyJzsKICAgIHJldHVybjsKICB9CiAgdmFyIG5hbWU9c2V0dGluZ3MucHJvdmlkZXI9PT0ndGFtcyc/J1RBTVMnOihzZXR0aW5ncy5wcm92aWRlcj09PSdyZXBsaWNhdGUnPydSZXBsaWNhdGUnOidmYWwuYWknKTsKICBlbC50ZXh0Q29udGVudD1uYW1lKyhzZXR0aW5ncy5hcGlLZXk/JyDCtyBrZXknOicgwrcgdGFucGEga2V5Jyk7CiAgZWwuc3R5bGUuY29sb3I9c2V0dGluZ3MuYXBpS2V5PycjMjdENENEJzonIzlhOWFhMic7Cn0KJCgnYXBpcHJvdmlkZXInKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLGZ1bmN0aW9uKCl7CiAgc2V0dGluZ3MucHJvdmlkZXI9JCgnYXBpcHJvdmlkZXInKS52YWx1ZTsgc2F2ZVNldHRpbmdzKCk7IHVwZGF0ZVByb3ZpZGVyVUkoKTsKfSk7CiQoJ2FwaS1zYXZlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgc2V0dGluZ3MubW9kZT0kKCdhcGltb2RlJykudmFsdWU7IHNldHRpbmdzLmFwaUtleT0kKCdhcGlrZXknKS52YWx1ZS50cmltKCk7CiAgc2F2ZVNldHRpbmdzKCk7IHVwZGF0ZVByb3ZpZGVyVUkoKTsgdG9hc3QoJ1BlbmdhdHVyYW4gQVBJIGRpc2ltcGFuJyk7Cn0pOwokKCdhcGktdGVzdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxhc3luYyBmdW5jdGlvbigpewogIHZhciBiPSQoJ2FwaS10ZXN0Jyk7IGIuZGlzYWJsZWQ9dHJ1ZTsgYi50ZXh0Q29udGVudD0nVGVzLi4uJzsKICBpZihzZXR0aW5ncy5wcm92aWRlcj09PSdwb2xsaW5hdGlvbnMnKXsKICAgIHRyeXsKICAgICAgdmFyIHI9YXdhaXQgZmV0Y2goJy9hcGkvaGVhbHRoJyk7CiAgICAgIHZhciBkPWF3YWl0IHIuanNvbigpLmNhdGNoKGZ1bmN0aW9uKCl7cmV0dXJuIG51bGw7fSk7CiAgICAgIGlmKCFyLm9rKSB0aHJvdyBuZXcgRXJyb3IoJ0hUVFAgJytyLnN0YXR1cyk7CiAgICAgIHRvYXN0KCdCYWNrZW5kIE9LIMK3IEJZT1AgJysoZCYmZC5ieW9wPydzaWFwIChBcHAgS2V5IHRlcnBhc2FuZyknOidiZWx1bSBkaWtvbmZpZ3VyYXNpIChBcHAgS2V5KScpKycgwrcgJysoc2V0dGluZ3MucG9sbFNlc3Npb24/J3Nlc2kgYWt0aWYnOidiZWx1bSBsb2dpbicpKTsKICAgICAgcmVmcmVzaE9BdXRoU3RhdHVzKCk7CiAgICB9Y2F0Y2goZSl7IHRvYXN0KCdCYWNrZW5kIHRpZGFrIGFrdGlmIOKAlCBkZXBsb3kgZGVuZ2FuIEZ1bmN0aW9ucyBhdGF1IHBha2FpIG1vZGUgZGVtbycpOyB9CiAgICBiLmRpc2FibGVkPWZhbHNlOyBiLnRleHRDb250ZW50PSdUZXMnOwogICAgcmV0dXJuOwogIH0KICB0cnl7CiAgICB2YXIgcj1hd2FpdCBmZXRjaCgnL2FwaS9oZWFsdGgnLHtoZWFkZXJzOnsneC1hcGkta2V5JzokKCdhcGlrZXknKS52YWx1ZS50cmltKCl8fHNldHRpbmdzLmFwaUtleX19KTsKICAgIHZhciBkPWF3YWl0IHIuanNvbigpLmNhdGNoKGZ1bmN0aW9uKCl7cmV0dXJuIG51bGx9KTsKICAgIGlmKCFyLm9rKSB0aHJvdyBuZXcgRXJyb3IoJ0hUVFAgJytyLnN0YXR1cyk7CiAgICB2YXIgcGFydHM9W107CiAgICBpZihkJiZkLmhhc0tleXMpeyBbJ3RhbXMnLCdyZXBsaWNhdGUnLCdmYWwnXS5mb3JFYWNoKGZ1bmN0aW9uKHApeyBpZihkLmhhc0tleXNbcF0pIHBhcnRzLnB1c2gocCk7IH0pOyB9CiAgICB0b2FzdCgnQmFja2VuZCBPSy4gS2V5IGRpIGVudjogJysocGFydHMubGVuZ3RoP3BhcnRzLmpvaW4oJywgJyk6J3RpZGFrIGFkYScpKycuIEtleSBkaSBicm93c2VyOiAnKyhzZXR0aW5ncy5hcGlLZXk/J2FkYSc6J3RpZGFrJykpOwogIH1jYXRjaChlKXsgdG9hc3QoJ0JhY2tlbmQgdGlkYWsgYWt0aWYg4oCUIGRlcGxveSBkZW5nYW4gRnVuY3Rpb25zIGF0YXUgcGFrYWkgbW9kZSBkZW1vJyk7IH0KICBiLmRpc2FibGVkPWZhbHNlOyBiLnRleHRDb250ZW50PSdUZXMnOwp9KTsKCi8qIC0tLSBCWU9QIE9BdXRoIChCcmluZyBZb3VyIE93biBQb2xsZW4pIC0tLQogKiBMb2dpbiB2aWEgZW50ZXIucG9sbGluYXRpb25zLmFpIChQS0NFIGNvZGUgZmxvdykg4oaSIGJhY2tlbmQgdHVrYXIga29kZSDihpIKICogdG9rZW4gc2tfIHNjb3BlZCB1c2VyIGRpc2ltcGFuIGRpIEtWIGJhY2tlbmQ7IGJyb3dzZXIgY3VtYSBwZWdhbmcgc2Vzc2lvbi4KICovCnZhciBfb2F1dGhWZXJpZmllcktleT0ncmVrdHkub2F1dGgudmVyaWZpZXInLCBfb2F1dGhTdGF0ZUtleT0ncmVrdHkub2F1dGguc3RhdGUnOwpmdW5jdGlvbiBfYjY0dXJsKGJ1Zil7CiAgdmFyIHM9YnRvYShTdHJpbmcuZnJvbUNoYXJDb2RlLmFwcGx5KG51bGwsbmV3IFVpbnQ4QXJyYXkoYnVmKSkpOwogIHJldHVybiBzLnJlcGxhY2UoL1wrL2csJy0nKS5yZXBsYWNlKC9cLy9nLCdfJykucmVwbGFjZSgvPSskLywnJyk7Cn0KZnVuY3Rpb24gX3JhbmRCNjQobGVuKXsgdmFyIGE9bmV3IFVpbnQ4QXJyYXkobGVuKTsgY3J5cHRvLmdldFJhbmRvbVZhbHVlcyhhKTsgcmV0dXJuIF9iNjR1cmwoYSk7IH0KYXN5bmMgZnVuY3Rpb24gX3NoYTI1NkI2NHVybCh0ZXh0KXsKICB2YXIgYnVmPWF3YWl0IGNyeXB0by5zdWJ0bGUuZGlnZXN0KCdTSEEtMjU2JyxuZXcgVGV4dEVuY29kZXIoKS5lbmNvZGUodGV4dCkpOwogIHJldHVybiBfYjY0dXJsKGJ1Zik7Cn0KZnVuY3Rpb24gc3RhcnRQb2xsT0F1dGgoKXsKICB2YXIgdmVyaWZpZXI9X3JhbmRCNjQoNDgpOwogIGxvY2FsU3RvcmFnZS5zZXRJdGVtKF9vYXV0aFZlcmlmaWVyS2V5LHZlcmlmaWVyKTsKICB2YXIgc3RhdGU9X3JhbmRCNjQoMTYpOwogIGxvY2FsU3RvcmFnZS5zZXRJdGVtKF9vYXV0aFN0YXRlS2V5LHN0YXRlKTsKICBmZXRjaCgnL2FwaS9vYXV0aC9jb25maWcnKS50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiByLmpzb24oKTt9KS50aGVuKGFzeW5jIGZ1bmN0aW9uKGNmZyl7CiAgICBpZighY2ZnfHwhY2ZnLmNsaWVudElkKSB0aHJvdyBuZXcgRXJyb3IoJ2JhY2tlbmQgYmVsdW0gcHVueWEgQXBwIEtleSBQb2xsaW5hdGlvbnMnKTsKICAgIHZhciBjaGFsbGVuZ2U9YXdhaXQgX3NoYTI1NkI2NHVybCh2ZXJpZmllcik7CiAgICB2YXIgcD1uZXcgVVJMU2VhcmNoUGFyYW1zKHsKICAgICAgcmVzcG9uc2VfdHlwZTonY29kZScsIGNsaWVudF9pZDpjZmcuY2xpZW50SWQsIHJlZGlyZWN0X3VyaTpjZmcucmVkaXJlY3RVcmksCiAgICAgIHNjb3BlOid1c2FnZScsIHN0YXRlOnN0YXRlLAogICAgICBjb2RlX2NoYWxsZW5nZTpjaGFsbGVuZ2UsIGNvZGVfY2hhbGxlbmdlX21ldGhvZDonUzI1NicKICAgIH0pOwogICAgd2luZG93LmxvY2F0aW9uLmhyZWY9Y2ZnLmF1dGhvcml6ZUJhc2UrJz8nK3AudG9TdHJpbmcoKTsKICB9KS5jYXRjaChmdW5jdGlvbihlKXsgdG9hc3QoJ0dhZ2FsIG11bGFpIGxvZ2luOiAnKyhlJiZlLm1lc3NhZ2V8fGUpKTsgfSk7Cn0KZnVuY3Rpb24gcmVmcmVzaE9BdXRoU3RhdHVzKCl7CiAgdmFyIGVsPSQoJ2J5b3Atc3RhdHVzJyksIGJ0bj0kKCdieW9wLWxvZ2luJyksIG91dD0kKCdieW9wLWxvZ291dCcpOwogIGlmKCFzZXR0aW5ncy5wb2xsU2Vzc2lvbil7IGlmKGVsKWVsLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyBpZihvdXQpb3V0LmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyByZXR1cm47IH0KICBmZXRjaCgnL2FwaS9vYXV0aC9zdGF0dXM/c2Vzc2lvbj0nK2VuY29kZVVSSUNvbXBvbmVudChzZXR0aW5ncy5wb2xsU2Vzc2lvbikpLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIHIuanNvbigpO30pLnRoZW4oZnVuY3Rpb24oZCl7CiAgICBpZihkJiZkLmNvbm5lY3RlZCl7CiAgICAgIHZhciBiYWxUeHQ9Jyc7CiAgICAgIGlmKGQuYmFsYW5jZSYmdHlwZW9mIGQuYmFsYW5jZT09PSdvYmplY3QnKXsKICAgICAgICB2YXIgYnY9ZC5iYWxhbmNlLnBvbGxlbkJhbGFuY2UhPW51bGw/ZC5iYWxhbmNlLnBvbGxlbkJhbGFuY2U6KGQuYmFsYW5jZS5iYWxhbmNlIT1udWxsP2QuYmFsYW5jZS5iYWxhbmNlOm51bGwpOwogICAgICAgIGlmKGJ2IT1udWxsKSBiYWxUeHQ9JyDCtyBzYWxkbyAnK2J2KycgcG9sbGVuJzsKICAgICAgfQogICAgICBlbC50ZXh0Q29udGVudD0nVGVyaHVidW5nIOKckycrKGQuZXhwaXJlc0luPygnIMK3IHNpc2EgJytNYXRoLmNlaWwoZC5leHBpcmVzSW4vODY0MDApKycgaGFyaScpOicnKStiYWxUeHQ7CiAgICAgIGVsLnN0eWxlLmNvbG9yPScjMjdENENEJzsgZWwuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7CiAgICAgIGJ0bi50ZXh0Q29udGVudD0nTG9naW4gdWxhbmcgKGdhbnRpIGFrdW4pJzsgb3V0LmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOwogICAgfWVsc2V7CiAgICAgIGVsLnRleHRDb250ZW50PSdTZXNpIGJlcmFraGlyIOKAlCBsb2dpbiB1bGFuZyc7IGVsLnN0eWxlLmNvbG9yPScjZTVhNTBhJzsKICAgICAgZWwuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7IG91dC5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsKICAgICAgc2V0dGluZ3MucG9sbFNlc3Npb249Jyc7IHNhdmVTZXR0aW5ncygpOyB1cGRhdGVBcGlTdGF0dXMoKTsKICAgIH0KICB9KS5jYXRjaChmdW5jdGlvbigpe30pOwp9CmZ1bmN0aW9uIHBvbGxMb2dvdXQoKXsKICBmZXRjaCgnL2FwaS9vYXV0aC9sb2dvdXQnLHttZXRob2Q6J1BPU1QnLGhlYWRlcnM6eydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJ30sYm9keTpKU09OLnN0cmluZ2lmeSh7c2Vzc2lvbjpzZXR0aW5ncy5wb2xsU2Vzc2lvbn0pfSkuY2F0Y2goZnVuY3Rpb24oKXt9KTsKICBzZXR0aW5ncy5wb2xsU2Vzc2lvbj0nJzsgc2F2ZVNldHRpbmdzKCk7IHVwZGF0ZUFwaVN0YXR1cygpOyByZWZyZXNoT0F1dGhTdGF0dXMoKTsKICB0b2FzdCgnU2VzaSBQb2xsaW5hdGlvbnMgZGljYWJ1dCcpOwp9CmFzeW5jIGZ1bmN0aW9uIGhhbmRsZU9BdXRoQ2FsbGJhY2soKXsKICBpZihsb2NhdGlvbi5wYXRobmFtZSE9PScvY2FsbGJhY2snKSByZXR1cm47CiAgdmFyIHE9bmV3IFVSTFNlYXJjaFBhcmFtcyhsb2NhdGlvbi5zZWFyY2gpOwogIHZhciBoPW5ldyBVUkxTZWFyY2hQYXJhbXMobG9jYXRpb24uaGFzaC5zbGljZSgxKSk7CiAgdmFyIGVycj1xLmdldCgnZXJyb3InKXx8aC5nZXQoJ2Vycm9yJyk7CiAgaWYoZXJyKXsgdG9hc3QoJ0xvZ2luIGRpYmF0YWxrYW46ICcrZXJyKTsgaGlzdG9yeS5yZXBsYWNlU3RhdGUobnVsbCwnJywnLycpOyByZXR1cm47IH0KICB2YXIgY29kZT1xLmdldCgnY29kZScpOwogIHZhciBzdGF0ZT1xLmdldCgnc3RhdGUnKTsKICB2YXIgc2F2ZWRTdGF0ZT1sb2NhbFN0b3JhZ2UuZ2V0SXRlbShfb2F1dGhTdGF0ZUtleSk7CiAgdmFyIHZlcmlmaWVyPWxvY2FsU3RvcmFnZS5nZXRJdGVtKF9vYXV0aFZlcmlmaWVyS2V5KTsKICBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShfb2F1dGhTdGF0ZUtleSk7IGxvY2FsU3RvcmFnZS5yZW1vdmVJdGVtKF9vYXV0aFZlcmlmaWVyS2V5KTsKICBpZighY29kZXx8IXN0YXRlfHxzdGF0ZSE9PXNhdmVkU3RhdGV8fCF2ZXJpZmllcil7CiAgICB0b2FzdCgnQ2FsbGJhY2sgT0F1dGggdGlkYWsgdmFsaWQnKTsgaGlzdG9yeS5yZXBsYWNlU3RhdGUobnVsbCwnJywnLycpOyByZXR1cm47CiAgfQogIHZhciBjZmc9YXdhaXQgZmV0Y2goJy9hcGkvb2F1dGgvY29uZmlnJykudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gci5qc29uKCk7fSkuY2F0Y2goZnVuY3Rpb24oKXtyZXR1cm4gbnVsbDt9KTsKICB0cnl7CiAgICB2YXIgcj1hd2FpdCBmZXRjaCgnL2FwaS9vYXV0aC90b2tlbicse21ldGhvZDonUE9TVCcsaGVhZGVyczp7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nfSwKICAgICAgYm9keTpKU09OLnN0cmluZ2lmeSh7Y29kZTpjb2RlLGNvZGVfdmVyaWZpZXI6dmVyaWZpZXIscmVkaXJlY3RfdXJpOihjZmcmJmNmZy5yZWRpcmVjdFVyaSl8fCcnfSl9KTsKICAgIHZhciBkPWF3YWl0IHIuanNvbigpLmNhdGNoKGZ1bmN0aW9uKCl7cmV0dXJuIG51bGw7fSk7CiAgICBpZighci5va3x8IWQuc2Vzc2lvbikgdGhyb3cgbmV3IEVycm9yKChkJiZkLmVycm9yKXx8KCdIVFRQICcrci5zdGF0dXMpKTsKICAgIHNldHRpbmdzLnBvbGxTZXNzaW9uPWQuc2Vzc2lvbjsgc2F2ZVNldHRpbmdzKCk7IHVwZGF0ZVByb3ZpZGVyVUkoKTsKICAgIHRvYXN0KCdMb2dpbiBQb2xsaW5hdGlvbnMgYmVyaGFzaWwhJyk7CiAgfWNhdGNoKGUpeyB0b2FzdCgnR2FnYWwgdHVrYXIga29kZTogJysoZSYmZS5tZXNzYWdlfHxlKSk7IH0KICBoaXN0b3J5LnJlcGxhY2VTdGF0ZShudWxsLCcnLCcvJyk7Cn0KJCgnYnlvcC1sb2dpbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxzdGFydFBvbGxPQXV0aCk7CiQoJ2J5b3AtbG9nb3V0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLHBvbGxMb2dvdXQpOwoKLyogLS0tIHRvYXN0IC0tLSAqLwp2YXIgX3RvYXN0VGltZXI9bnVsbDsKZnVuY3Rpb24gdG9hc3QobXNnKXsKICB2YXIgdD0kKCd0b2FzdCcpOyBpZighdCkgcmV0dXJuOwogIHQudGV4dENvbnRlbnQ9bXNnOyB0LmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOwogIGNsZWFyVGltZW91dChfdG9hc3RUaW1lcik7CiAgX3RvYXN0VGltZXI9c2V0VGltZW91dChmdW5jdGlvbigpeyB0LmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyB9LDM1MDApOwp9CgovKiAtLS0gcHJvZ3Jlc3Mgb3ZlcmxheSAtLS0gKi8KdmFyIF9wb2xsU3RvcD1mYWxzZTsKZnVuY3Rpb24gc2hvd1Byb2dyZXNzKHRpdGxlLHN0YXR1cyxwY3QpewogICQoJ3Byb2ctdGl0bGUnKS50ZXh0Q29udGVudD10aXRsZTsKICAkKCdwcm9nLXN0YXR1cycpLnRleHRDb250ZW50PXN0YXR1c3x8Jyc7CiAgJCgncHJvZy1iYXInKS5zdHlsZS53aWR0aD1NYXRoLm1heCgwLE1hdGgubWluKDEwMCxwY3R8fDApKSsnJSc7CiAgJCgncHJvZy1wY3QnKS50ZXh0Q29udGVudD1NYXRoLnJvdW5kKHBjdHx8MCkrJyUnOwogICQoJ3Byb2dvdmVybGF5JykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ3Byb2dvdmVybGF5JykuY2xhc3NMaXN0LmFkZCgnZmxleCcpOwp9CmZ1bmN0aW9uIGhpZGVQcm9ncmVzcygpeyAkKCdwcm9nb3ZlcmxheScpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyAkKCdwcm9nb3ZlcmxheScpLmNsYXNzTGlzdC5yZW1vdmUoJ2ZsZXgnKTsgfQokKCdwcm9nLWNhbmNlbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBfcG9sbFN0b3A9dHJ1ZTsgdG9hc3QoJ01lbWJhdGFsa2FuLi4uJyk7IH0pOwoKLyogLS0tIEFQSSBjbGllbnQgLS0tICovCmZ1bmN0aW9uIGJ1aWxkQXBpS2V5KCl7IHJldHVybiBzZXR0aW5ncy5hcGlLZXl8fCQoJ2FwaWtleScpLnZhbHVlLnRyaW0oKTsgfQoKZnVuY3Rpb24gX2FwaUhlYWRlcnMoZXh0cmEpewogIHZhciBoPXsneC1hcGkta2V5JzpidWlsZEFwaUtleSgpfTsKICBpZihzZXR0aW5ncy5wcm92aWRlcj09PSdwb2xsaW5hdGlvbnMnJiZzZXR0aW5ncy5wb2xsU2Vzc2lvbikgaFsneC1zZXNzaW9uJ109c2V0dGluZ3MucG9sbFNlc3Npb247CiAgaWYoZXh0cmEpIGZvcih2YXIgayBpbiBleHRyYSkgaFtrXT1leHRyYVtrXTsKICByZXR1cm4gaDsKfQphc3luYyBmdW5jdGlvbiBhcGlHZW5lcmF0ZShwYXlsb2FkKXsKICB2YXIgcmVzPWF3YWl0IGZldGNoKCcvYXBpL2dlbmVyYXRlJyx7bWV0aG9kOidQT1NUJyxoZWFkZXJzOl9hcGlIZWFkZXJzKHsnQ29udGVudC1UeXBlJzonYXBwbGljYXRpb24vanNvbid9KSxib2R5OkpTT04uc3RyaW5naWZ5KHBheWxvYWQpfSk7CiAgdmFyIGQ9YXdhaXQgcmVzLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsfSk7CiAgaWYoIXJlcy5vaykgdGhyb3cgbmV3IEVycm9yKChkJiZkLmVycm9yKXx8KCdIVFRQICcrcmVzLnN0YXR1cykpOwogIHJldHVybiBkfHx7fTsKfQphc3luYyBmdW5jdGlvbiBhcGlUYXNrKHRhc2tJZCl7CiAgdmFyIHJlcz1hd2FpdCBmZXRjaCgnL2FwaS90YXNrP2lkPScrZW5jb2RlVVJJQ29tcG9uZW50KHRhc2tJZCkse2hlYWRlcnM6X2FwaUhlYWRlcnMoe30pfSk7CiAgdmFyIGQ9YXdhaXQgcmVzLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsfSk7CiAgaWYoIXJlcy5vaykgdGhyb3cgbmV3IEVycm9yKChkJiZkLmVycm9yKXx8KCdIVFRQICcrcmVzLnN0YXR1cykpOwogIHJldHVybiBkfHx7fTsKfQoKYXN5bmMgZnVuY3Rpb24gcG9sbFRhc2sodGFza0lkLG9uUHJvZyl7CiAgdmFyIHN0YXJ0PURhdGUubm93KCksIG1heE1zPTYqNjAqMTAwMDsKICB3aGlsZShEYXRlLm5vdygpLXN0YXJ0PG1heE1zKXsKICAgIGlmKF9wb2xsU3RvcCkgdGhyb3cgbmV3IEVycm9yKCdkaWJhdGFsa2FuIHBlbmdndW5hJyk7CiAgICB2YXIgZD1hd2FpdCBhcGlUYXNrKHRhc2tJZCk7CiAgICBpZihkLnN0YXR1cz09PSdTVUNDRVNTJykgcmV0dXJuIGQuaW1hZ2VzfHxbXTsKICAgIGlmKGQuc3RhdHVzPT09J0ZBSUxFRCcpIHRocm93IG5ldyBFcnJvcihkLmVycm9yfHwnVGFzayBnYWdhbCcpOwogICAgaWYoZC5zdGF0dXM9PT0nQ0FOQ0VMRUQnKSB0aHJvdyBuZXcgRXJyb3IoJ1Rhc2sgZGliYXRhbGthbicpOwogICAgdmFyIHN0PShkLnN0YXR1cz09PSdXQUlUSU5HJyk/KCdBbnRyZSAnKyhkLnF1ZXVlfHwnJykpOihkLnN0YXR1cz09PSdSVU5OSU5HJz8nR2VuZXJhdGluZy4uLic6J01lbnVuZ2d1Li4uJyk7CiAgICBvblByb2coc3QsZC5wcm9ncmVzc3x8MCk7CiAgICBhd2FpdCBuZXcgUHJvbWlzZShmdW5jdGlvbihyKXsgc2V0VGltZW91dChyLCBkLnN0YXR1cz09PSdXQUlUSU5HJz80MDAwOjIwMDApOyB9KTsKICB9CiAgdGhyb3cgbmV3IEVycm9yKCdUaW1lb3V0IG1lbnVuZ2d1IGhhc2lsIGdlbmVyYXRlJyk7Cn0KCi8qIC0tLSBoYXNpbCAtLS0gKi8KZnVuY3Rpb24gbWtSZXN1bHQoc3JjLHBhcix0YXNrSWQsY3JlZGl0cyl7CiAgcmV0dXJuIHsKICAgIHNyYzpzcmMsIHByb21wdDpwYXIucGFyYW1zLnByb21wdCwgbmVnOnBhci5wYXJhbXMubmVnYXRpdmVQcm9tcHQsCiAgICBtb2RlbDpzdGF0ZS5tb2RlbD9zdGF0ZS5tb2RlbC5uYW1lOicnLAogICAgc2l6ZTpwYXIucGFyYW1zLndpZHRoKyd4JytwYXIucGFyYW1zLmhlaWdodCwgc2VlZDpwYXIucGFyYW1zLnNlZWQsCiAgICB0YXNrSWQ6dGFza0lkfHwnJywgY3JlZGl0czpjcmVkaXRzIT1udWxsP2NyZWRpdHM6JycsCiAgICBzdGVwczpwYXIucGFyYW1zLnN0ZXBzIT1udWxsP3Bhci5wYXJhbXMuc3RlcHM6JycsCiAgICBjZmc6cGFyLnBhcmFtcy5jZmdTY2FsZSE9bnVsbD9wYXIucGFyYW1zLmNmZ1NjYWxlOicnLAogICAgc2FtcGxlcjpwYXIucGFyYW1zLmtzYW1wbGVyTmFtZXx8cGFyLnBhcmFtcy5zYW1wbGVyfHwnJywKICAgIHRzOkRhdGUubm93KCksIGRlbW86ZmFsc2UsIHBhZ2U6c3RhdGUucGFnZQogIH07Cn0KZnVuY3Rpb24gZGVtb1Jlc3VsdHMocGFyKXsKICBzaG93UHJvZ3Jlc3MoJ01vZGUgZGVtbycsJ01lbnlpYXBrYW4gZ2FtYmFyIHNpbXVsYXNpLi4uJywxNSk7CiAgc2V0VGltZW91dChmdW5jdGlvbigpewogICAgZm9yKHZhciBpPTA7aTxzdGF0ZS5uY29sO2krKyl7CiAgICAgIHZhciBzcmM9UytNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkqMWU5KSsnLzUxMic7CiAgICAgIGFkZFJlc3VsdCh7c3JjOnNyYywgcHJvbXB0OnBhci5wYXJhbXMucHJvbXB0LCBuZWc6cGFyLnBhcmFtcy5uZWdhdGl2ZVByb21wdCwKICAgICAgICBtb2RlbDpzdGF0ZS5tb2RlbD9zdGF0ZS5tb2RlbC5uYW1lOicnLCBzaXplOnBhci5wYXJhbXMud2lkdGgrJ3gnK3Bhci5wYXJhbXMuaGVpZ2h0LAogICAgICAgIHNlZWQ6cGFyLnBhcmFtcy5zZWVkLCB0YXNrSWQ6JycsIGNyZWRpdHM6JycsIHRzOkRhdGUubm93KCksIGRlbW86dHJ1ZSwgcGFnZTpzdGF0ZS5wYWdlLAogICAgICAgIHN0ZXBzOnBhci5wYXJhbXMuc3RlcHMhPW51bGw/cGFyLnBhcmFtcy5zdGVwczonJywKICAgICAgICBjZmc6cGFyLnBhcmFtcy5jZmdTY2FsZSE9bnVsbD9wYXIucGFyYW1zLmNmZ1NjYWxlOicnLAogICAgICAgIHNhbXBsZXI6cGFyLnBhcmFtcy5rc2FtcGxlck5hbWV8fHBhci5wYXJhbXMuc2FtcGxlcnx8Jyd9KTsKICAgIH0KICAgIGhpZGVQcm9ncmVzcygpOwogIH0sNzAwKTsKfQoKYXN5bmMgZnVuY3Rpb24gZG9HZW5lcmF0ZSgpewogIGlmKHN0YXRlLmJ1c3kpIHJldHVybjsKICB2YXIgcD0kKCdwcm9tcHQnKS52YWx1ZS50cmltKCk7CiAgaWYoIXApeyBvcGVuTGVmdCgpOyAkKCdwcm9tcHQnKS5mb2N1cygpOyB0b2FzdCgnSXNpIHByb21wdCBkdWx1Jyk7IHJldHVybjsgfQogIHZhciBwYXI9YnVpbGRQYXlsb2FkKCk7CiAgc3RhdGUuYnVzeT10cnVlOyBzZXRCdXN5KHRydWUpOyBfcG9sbFN0b3A9ZmFsc2U7CiAgdHJ5ewogICAgaWYoc2V0dGluZ3MubW9kZT09PSdkZW1vJ3x8KCFidWlsZEFwaUtleSgpJiZzZXR0aW5ncy5wcm92aWRlciE9PSdwb2xsaW5hdGlvbnMnKSl7CiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKGZ1bmN0aW9uKHIpeyBzZXRUaW1lb3V0KHIsMzAwKTsgfSk7CiAgICAgIGRlbW9SZXN1bHRzKHBhcik7CiAgICAgIGlmKCFidWlsZEFwaUtleSgpKSB0b2FzdCgnQmVsdW0gYWRhIEFQSSBrZXkg4oCUIGhhc2lsIHNpbXVsYXNpLiBJc2kgQVBJIEtleSBUQU1TIGRpIHBhbmVsIGtpcmkgdW50dWsgZ2VuZXJhdGUgYXNsaS4nKTsKICAgICAgZWxzZSB0b2FzdCgnTW9kZSBkZW1vIGFrdGlmIOKAlCBoYXNpbCBzaW11bGFzaS4nKTsKICAgIH1lbHNlewogICAgICBzaG93UHJvZ3Jlc3MoJ01lbmdpcmltIGtlIFRBTVMuLi4nLCdNZW55aWFwa2FuIHRhc2suLi4nLDUpOwogICAgICB2YXIgcj1hd2FpdCBhcGlHZW5lcmF0ZShwYXIpOwogICAgICB2YXIgdGFza0lkPXIudGFza0lkfHxyLmpvYklkOwogICAgICBpZih0YXNrSWQpewogICAgICAgIHZhciBpbWdzPWF3YWl0IHBvbGxUYXNrKHRhc2tJZCxmdW5jdGlvbihzdCxwY3QpeyBzaG93UHJvZ3Jlc3MoJ0dlbmVyYXRpbmcuLi4nLHN0LHBjdCk7IH0pOwogICAgICAgIGltZ3MuZm9yRWFjaChmdW5jdGlvbihzcmMpeyBhZGRSZXN1bHQobWtSZXN1bHQoc3JjLHBhcix0YXNrSWQsci5jcmVkaXRzKSk7IH0pOwogICAgICB9ZWxzZXsKICAgICAgICB2YXIgaW1nczI9ZXh0cmFjdEltYWdlcyhyKTsKICAgICAgICBpZighaW1nczIubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ1Jlc3BvbnNlIHRhbnBhIGdhbWJhcicpOwogICAgICAgIGltZ3MyLmZvckVhY2goZnVuY3Rpb24oc3JjKXsgYWRkUmVzdWx0KG1rUmVzdWx0KHNyYyxwYXIsJycsci5jcmVkaXRzKSk7IH0pOwogICAgICB9CiAgICB9CiAgfWNhdGNoKGUpewogICAgaWYoc2V0dGluZ3MubW9kZT09PSdhdXRvJyl7CiAgICAgIHRvYXN0KCdCYWNrZW5kL0FQSSBiZWx1bSBha3RpZiAoJytlLm1lc3NhZ2UrJykg4oCUIHBha2FpIHNpbXVsYXNpIGRlbW8nKTsKICAgICAgZGVtb1Jlc3VsdHMocGFyKTsKICAgIH1lbHNlewogICAgICB0b2FzdCgnR2FnYWw6ICcrZS5tZXNzYWdlKTsKICAgIH0KICB9ZmluYWxseXsKICAgIGhpZGVQcm9ncmVzcygpOyBzdGF0ZS5idXN5PWZhbHNlOyBzZXRCdXN5KGZhbHNlKTsKICB9Cn0KCi8qIC0tLSBJbWcySW1nIC0tLSAqLwp2YXIgaTJpRGF0YVVybD1udWxsOwokKCdpMmktZHJvcCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyAkKCdpMmktZmlsZScpLmNsaWNrKCk7IH0pOwokKCdpMmktZmlsZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsZnVuY3Rpb24oZSl7IGhhbmRsZUkyaUZpbGUoZS50YXJnZXQuZmlsZXMmJmUudGFyZ2V0LmZpbGVzWzBdKTsgfSk7CiQoJ2kyaS1kcm9wJykuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ292ZXInLGZ1bmN0aW9uKGUpeyBlLnByZXZlbnREZWZhdWx0KCk7IH0pOwokKCdpMmktZHJvcCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLGZ1bmN0aW9uKGUpeyBlLnByZXZlbnREZWZhdWx0KCk7IGhhbmRsZUkyaUZpbGUoZS5kYXRhVHJhbnNmZXIuZmlsZXMmJmUuZGF0YVRyYW5zZmVyLmZpbGVzWzBdKTsgfSk7CiQoJ2kyaS1kcycpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbihlKXsgJCgnaTJpLWRzdicpLnRleHRDb250ZW50PXBhcnNlRmxvYXQoZS50YXJnZXQudmFsdWUpLnRvRml4ZWQoMik7IH0pOwokKCdpMmktY2xlYXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICBpMmlEYXRhVXJsPW51bGw7ICQoJ2kyaS1wcmV2aWV3JykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ2kyaS1pbWcnKS5zcmM9Jyc7ICQoJ2kyaS1kcm9wJykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7Cn0pOwpmdW5jdGlvbiBoYW5kbGVJMmlGaWxlKGYpewogIGlmKCFmKSByZXR1cm47CiAgdmFyIHJkPW5ldyBGaWxlUmVhZGVyKCk7CiAgcmQub25sb2FkPWZ1bmN0aW9uKCl7CiAgICBpMmlEYXRhVXJsPXJkLnJlc3VsdDsKICAgICQoJ2kyaS1pbWcnKS5zcmM9cmQucmVzdWx0OyAkKCdpMmktcHJldmlldycpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyAkKCdpMmktZHJvcCcpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOwogIH07CiAgcmQucmVhZEFzRGF0YVVSTChmKTsKfQoKLyogLS0tIHJlbmRlciBwZXIgdGFiIC0tLSAqLwpmdW5jdGlvbiByZW5kZXJDYW52YXMoKXsKICB2YXIgcGFnZT1zdGF0ZS5wYWdlOwogIHZhciBoaWRlTWFpbiA9ICEocGFnZT09PSd0ZXh0J3x8cGFnZT09PSdpbWcnKTsKICAkKCdpbWcyaW1nLWNhcmQnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLCBwYWdlIT09J2ltZycpOwogICQoJ2VtcHR5Jykuc3R5bGUuZGlzcGxheSA9IChoaWRlTWFpbiB8fCBzdGF0ZS5yZXN1bHRzLmxlbmd0aD4wKSA/ICdub25lJyA6ICcnOwogICQoJ2dyaWQnKS5zdHlsZS5kaXNwbGF5ID0gaGlkZU1haW4/J25vbmUnOicnOwogICQoJ3RhYi1wbGFjZWhvbGRlcicpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicsICFoaWRlTWFpbik7CiAgJCgndGFiLXBsYWNlaG9sZGVyJykuY2xhc3NMaXN0LnRvZ2dsZSgnZmxleCcsIGhpZGVNYWluKTsKICBpZihwYWdlPT09J2VkaXQnKSAkKCd0YWItcGxhY2Vob2xkZXItdGV4dCcpLnRleHRDb250ZW50PSdFZGl0IC8gSW5wYWludGluZyDigJQgc2VnZXJhIGhhZGlyJzsKICBlbHNlIGlmKHBhZ2U9PT0ndmlkZW8nKSAkKCd0YWItcGxhY2Vob2xkZXItdGV4dCcpLnRleHRDb250ZW50PSdUZXh0IC8gSW1hZ2UgdG8gVmlkZW8g4oCUIHNlZ2VyYSBoYWRpcic7CiAgZWxzZSBpZihwYWdlPT09J3ByaW1lJykgJCgndGFiLXBsYWNlaG9sZGVyLXRleHQnKS50ZXh0Q29udGVudD0nUHJpbWUg4oCUIHNlZ2VyYSBoYWRpcic7Cn0KCi8qIC0tLSByaXdheWF0IGRpIG1vYmlsZSAtLS0gKi8KJCgnYnRuLWhpc3RvcnknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgncmlnaHRQYW4nKS5jbGFzc0xpc3QudG9nZ2xlKCdtb2JpbGUtb3BlbicpOyB9KTsKJCgnb3ZlcmxheScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyAkKCdyaWdodFBhbicpLmNsYXNzTGlzdC5yZW1vdmUoJ21vYmlsZS1vcGVuJyk7IH0pOwoKcmVuZGVyTG9yYSgpOwpzZXRNb2RlbChNT0RFTFNbMF0pOwp1cGRXSCgpOwphcHBseU5jb2woKTsKbG9hZFNldHRpbmdzKCk7IGFwcGx5U2V0dGluZ3NVSSgpOwpoYW5kbGVPQXV0aENhbGxiYWNrKCk7CnRyeXsKICB2YXIgc2F2ZWQ9SlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShSRVNVTFRTX0tFWSl8fCdbXScpOwogIGlmKEFycmF5LmlzQXJyYXkoc2F2ZWQpKSBzdGF0ZS5yZXN1bHRzPXNhdmVkOwp9Y2F0Y2goZSl7fQpyZW5kZXJDYW52YXMoKTsKcmVuZGVyR3JpZCgpOwpyZW5kZXJEZXRhaWwoKTsKcmVuZGVyUmlnaHQoKTsKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgoKCg==';
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
