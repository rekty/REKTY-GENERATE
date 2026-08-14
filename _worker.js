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
      else if (provider === 'pollinations') r = await pollinationsCreateJob(body, env, apiKey);
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
const HTML_B64 = 'PCFET0NUWVBFIGh0bWw+DQo8aHRtbCBsYW5nPSJpZCI+DQo8aGVhZD4NCjxtZXRhIGNoYXJzZXQ9IlVURi04IiAvPg0KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCxpbml0aWFsLXNjYWxlPTEiIC8+DQo8dGl0bGU+UmVrdHkgQUkg4oCUIFRleHQgdG8gSW1hZ2U8L3RpdGxlPg0KPHNjcmlwdD53aW5kb3cuX190YV9zdHlsZV9fPXRydWU8L3NjcmlwdD4NCjxzY3JpcHQgc3JjPSJodHRwczovL2Nkbi50YWlsd2luZGNzcy5jb20iPjwvc2NyaXB0Pg0KPHNjcmlwdCBzcmM9Imh0dHBzOi8vdW5wa2cuY29tL0BwaG9zcGhvci1pY29ucy93ZWIvcGhvc3Bob3ItaWNvbi5qcyI+PC9zY3JpcHQ+DQo8bGluayByZWw9InByZWNvbm5lY3QiIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20iPg0KPGxpbmsgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbS9jc3MyP2ZhbWlseT1JbnRlcjp3Z2h0QDQwMDs1MDA7NjAwOzcwMCZkaXNwbGF5PXN3YXAiIHJlbD0ic3R5bGVzaGVldCI+DQo8c3R5bGU+DQpodG1sLGJvZHl7bWFyZ2luOjA7cGFkZGluZzowO2ZvbnQtZmFtaWx5Oi1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LCdTZWdvZSBVSScsUm9ib3RvLCdIZWx2ZXRpY2EgTmV1ZScsQXJpYWwsJ05vdG8gU2Fucycsc2Fucy1zZXJpZjtiYWNrZ3JvdW5kOiMxODE4MTg7Y29sb3I6I2U4ZThlODttaW4taGVpZ2h0OjEwMHZofQ0KLmhpZGViYXI6Oi13ZWJraXQtc2Nyb2xsYmFye2Rpc3BsYXk6bm9uZX0uaGlkZWJhcntzY3JvbGxiYXItd2lkdGg6bm9uZX0NCjo6LXdlYmtpdC1zY3JvbGxiYXJ7d2lkdGg6NnB4O2hlaWdodDo2cHh9DQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1ie2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMTIpO2JvcmRlci1yYWRpdXM6NHB4fQ0KLmJke2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwyNTUsMjU1LC4xMil9DQouaW5we2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTYpO2JvcmRlci1yYWRpdXM6OHB4O2JhY2tncm91bmQ6IzJhMmEyYTtjb2xvcjojZThlOGU4O3BhZGRpbmc6OHB4IDExcHg7b3V0bGluZTpub25lO2ZvbnQtc2l6ZToxM3B4O3dpZHRoOjEwMCV9DQouaW5wOmZvY3Vze2JvcmRlci1jb2xvcjojNkY1REZGfQ0KLmJ0bntib3JkZXItcmFkaXVzOjEwcHg7Zm9udC13ZWlnaHQ6NjAwO3RyYW5zaXRpb246LjE1cztjdXJzb3I6cG9pbnRlcjtkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2dhcDo2cHg7Zm9udC1zaXplOjEzcHh9DQouYnRuLWJsdWV7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiAwJSwjMjdENENEIDU5LjclLCM3NEZGN0UgMTAwJSk7Ym9yZGVyOm5vbmU7Y29sb3I6I2ZmZjtib3gtc2hhZG93OjAgMCAxOHB4IHJnYmEoMTExLDkzLDI1NSwuMzUpO3BhZGRpbmc6MCAxOHB4fQ0KLmJ0bi1ibHVlOmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMSk7Ym94LXNoYWRvdzowIDAgMjRweCByZ2JhKDExMSw5MywyNTUsLjUpfQ0KLmJ0bi1ibHVlOmFjdGl2ZXt0cmFuc2Zvcm06c2NhbGUoLjk4KX0NCi5idG4tZ2hvc3R7Y29sb3I6I2ExYTFhYTtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxcHggc29saWQgdHJhbnNwYXJlbnR9LmJ0bi1naG9zdDpob3ZlcntiYWNrZ3JvdW5kOiMyYTJhMmE7Y29sb3I6I2U4ZThlOH0NCi50YWJ7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtwYWRkaW5nOjZweCAxMnB4O2JvcmRlci1yYWRpdXM6OHB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7Zm9udC13ZWlnaHQ6NTAwO3doaXRlLXNwYWNlOm5vd3JhcDt0cmFuc2l0aW9uOi4xMnN9DQoudGFiOmhvdmVye2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMmEyYTJhfS50YWIuc2Vse2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMmEyYTJhfQ0KLnRhYiAuZG90e3dpZHRoOjZweDtoZWlnaHQ6NnB4O2JvcmRlci1yYWRpdXM6NTAlO2Rpc3BsYXk6aW5saW5lLWJsb2NrfQ0KLnRhYi5zZWwgLmRvdHtkaXNwbGF5Om5vbmV9DQoudGFiLnNlbDo6YWZ0ZXJ7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtib3R0b206LTFweDtsZWZ0OjUwJTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTt3aWR0aDoyMHB4O2hlaWdodDoycHg7Ym9yZGVyLXJhZGl1czoycHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiwjMjdENENEKTtwb3NpdGlvbjphYnNvbHV0ZX0NCi50YWJ7cG9zaXRpb246cmVsYXRpdmV9DQouc2xpZGVyey13ZWJraXQtYXBwZWFyYW5jZTpub25lO2FwcGVhcmFuY2U6bm9uZTtoZWlnaHQ6NHB4O2JvcmRlci1yYWRpdXM6NHB4O2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMTQpO291dGxpbmU6bm9uZTt3aWR0aDoxMDAlfQ0KLnNsaWRlcjo6LXdlYmtpdC1zbGlkZXItdGh1bWJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7YXBwZWFyYW5jZTpub25lO3dpZHRoOjE1cHg7aGVpZ2h0OjE1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDojZmZmO2JvcmRlcjozcHggc29saWQgIzZGNURGRjtjdXJzb3I6cG9pbnRlcjtib3gtc2hhZG93OjAgMCA2cHggcmdiYSgxMTEsOTMsMjU1LC40KTt0cmFuc2l0aW9uOi4xMnN9DQouc2xpZGVyOjotd2Via2l0LXNsaWRlci10aHVtYjpob3Zlcnt0cmFuc2Zvcm06c2NhbGUoMS4xKX0NCi5sb3JhLXNsey13ZWJraXQtYXBwZWFyYW5jZTpub25lO2FwcGVhcmFuY2U6bm9uZTtoZWlnaHQ6NHB4O2JvcmRlci1yYWRpdXM6NHB4O2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMTIpO291dGxpbmU6bm9uZX0NCi5sb3JhLXNsOjotd2Via2l0LXNsaWRlci10aHVtYnstd2Via2l0LWFwcGVhcmFuY2U6bm9uZTt3aWR0aDoxNHB4O2hlaWdodDoxNHB4O2JvcmRlci1yYWRpdXM6NTAlO2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MnB4IHNvbGlkICM2RjVERkY7Y3Vyc29yOnBvaW50ZXJ9DQoubG9yYS1jYXJke3Bvc2l0aW9uOnJlbGF0aXZlO2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTIpO2JvcmRlci1yYWRpdXM6MTBweDtiYWNrZ3JvdW5kOiMyYTJhMmE7dHJhbnNpdGlvbjouMTJzO3BhZGRpbmc6OHB4IDEwcHggMTBweH0NCi5sb3JhLWNhcmQ6aG92ZXJ7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDI1NSwyNTUsLjI0KX0NCi5sb3JhLWxhYmVse3Bvc2l0aW9uOmFic29sdXRlO3RvcDowO2xlZnQ6MDtmb250LXNpemU6OXB4O2NvbG9yOiM5YTlhYTI7YmFja2dyb3VuZDojMzMzO2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMSk7cGFkZGluZzoycHggNnB4O2JvcmRlci1yYWRpdXM6NnB4O2JvcmRlci10b3AtbGVmdC1yYWRpdXM6MTBweDtib3JkZXItYm90dG9tLXJpZ2h0LXJhZGl1czo2cHg7ei1pbmRleDoyfQ0KLmxvcmEtdG9we2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDttYXJnaW4tdG9wOjhweH0NCi5sb3JhLXRodW1ie3dpZHRoOjM0cHg7aGVpZ2h0OjM0cHg7Ym9yZGVyLXJhZGl1czo2cHg7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xMik7b2JqZWN0LWZpdDpjb3ZlcjtmbGV4LXNocmluazowfQ0KLmxvcmEtbmFtZXtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo2MDA7Y29sb3I6I2U4ZThlODtmbGV4OjE7bWluLXdpZHRoOjA7d2hpdGUtc3BhY2U6bm93cmFwO292ZXJmbG93OmhpZGRlbjt0ZXh0LW92ZXJmbG93OmVsbGlwc2lzfQ0KLmxvcmEtaWNvbnN7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MnB4O2ZsZXgtc2hyaW5rOjB9DQoubG9yYS1pY29ue3dpZHRoOjIycHg7aGVpZ2h0OjIycHg7Ym9yZGVyLXJhZGl1czo0cHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOiM3MTcxN2E7YmFja2dyb3VuZDp0cmFuc3BhcmVudDt0cmFuc2l0aW9uOi4xMnN9DQoubG9yYS1pY29uOmhvdmVye2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMDgpO2NvbG9yOiNmZmZ9DQoubG9yYS1pY29uLmRlbDpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoMjM5LDY4LDY4LC4xNSk7Y29sb3I6I2VmNDQ0NH0NCi5sb3JhLWljb24gc3Zne3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7c3Ryb2tlOmN1cnJlbnRDb2xvcjtmaWxsOm5vbmU7c3Ryb2tlLXdpZHRoOjJ9DQoubG9yYS1zbGlkZXItcm93e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjRweDttYXJnaW4tdG9wOjZweH0NCi5sLXNsaWRlcntwb3NpdGlvbjpyZWxhdGl2ZTtmbGV4OjE7aGVpZ2h0OjE2cHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcn0NCi5sLXRyYWNre3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDtyaWdodDowO2hlaWdodDo0cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDpyZ2JhKDI1NSwyNTUsMjU1LC4xMyl9DQoubC1maWxse3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDt0b3A6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpO2hlaWdodDo0cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiwjMjdENENEKX0NCi5sLWhhbmRsZXtwb3NpdGlvbjphYnNvbHV0ZTt0b3A6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGUoLTUwJSwtNTAlKTt3aWR0aDoxNHB4O2hlaWdodDoxNHB4O2JvcmRlci1yYWRpdXM6NTAlO2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MnB4IHNvbGlkICM2RjVERkY7Ym94LXNoYWRvdzowIDFweCAzcHggcmdiYSgwLDAsMCwuNCk7cG9pbnRlci1ldmVudHM6bm9uZX0NCi5sb3JhLXNse3Bvc2l0aW9uOmFic29sdXRlO2luc2V0OjA7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtvcGFjaXR5OjA7Y3Vyc29yOnBvaW50ZXJ9DQoubC1udW17ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MnB4O2ZsZXgtc2hyaW5rOjB9DQoubG9yYS1pbnB1dHt3aWR0aDozMHB4O2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTUpO2JvcmRlci1yYWRpdXM6NnB4O2JhY2tncm91bmQ6IzE4MTgxODtjb2xvcjojZThlOGU4O2ZvbnQtc2l6ZToxMnB4O3RleHQtYWxpZ246Y2VudGVyO291dGxpbmU6bm9uZTtwYWRkaW5nOjRweCAwfQ0KLmxvcmEtaW5wdXQ6Zm9jdXN7Ym9yZGVyLWNvbG9yOiM2RjVERkZ9DQoubG9yYS11cmwtaW5we2ZvbnQtc2l6ZToxMXB4O3BhZGRpbmc6NnB4IDlweDttYXJnaW4tdG9wOjJweH0NCi5sb3JhLWJ0bnt3aWR0aDoyMnB4O2hlaWdodDoyMnB4O2JvcmRlci1yYWRpdXM6NTAlO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjb2xvcjojOWE5YWEyO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOm5vbmU7dHJhbnNpdGlvbjouMTJzfQ0KLmxvcmEtYnRuOmhvdmVye2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMSk7Y29sb3I6I2ZmZn0NCi5sb3JhLWJ0biBzdmd7d2lkdGg6MTRweDtoZWlnaHQ6MTRweDtzdHJva2U6Y3VycmVudENvbG9yO2ZpbGw6bm9uZTtzdHJva2Utd2lkdGg6MjtzdHJva2UtbGluZWNhcDpyb3VuZH0NCi50YWd7YmFja2dyb3VuZDojMmEyYTJhO2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTIpO2NvbG9yOiNlMGUwZTA7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjRweDtmb250LXNpemU6MTJweDtwYWRkaW5nOjRweCA4cHg7Ym9yZGVyLXJhZGl1czo2cHh9DQouYXJ7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xMik7Ym9yZGVyLXJhZGl1czoxMHB4O2JhY2tncm91bmQ6IzJhMmEyYTtjb2xvcjojZmZmO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjJweDtwYWRkaW5nOjhweCAycHg7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjouMTJzO21pbi13aWR0aDowfQ0KLmFyOmhvdmVye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwyNTUsMjU1LC4zKX0NCi5hci5zZWx7Ym9yZGVyLWNvbG9yOiMyN0Q0Q0Q7YmFja2dyb3VuZDojMjIyfQ0KLmFyLnNlbCAuYXItZGVzY3tjb2xvcjojMjdENENEfQ0KLmFyLWljb3t3aWR0aDoyNHB4O2hlaWdodDoyNHB4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcn0NCi5hci1pY28gc3Zne3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCV9DQouYXItbmFtZXtmb250LXNpemU6MTFweDtjb2xvcjojZThlOGU4O3doaXRlLXNwYWNlOm5vd3JhcH0NCi5hci1kZXNje2ZvbnQtc2l6ZTo5cHg7Y29sb3I6IzlhOWFhMjt3aGl0ZS1zcGFjZTpub3dyYXB9DQouZmllbGR7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6M3B4fQ0KLnJ0YWJ7Ym9yZGVyOjFweCBzb2xpZCB0cmFuc3BhcmVudDtib3JkZXItcmFkaXVzOjZweDtwYWRkaW5nOjRweCAxMHB4O2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7YmFja2dyb3VuZDp0cmFuc3BhcmVudH0NCi5ydGFiOmhvdmVye2NvbG9yOiNmZmZ9LnJ0YWIuc2Vse2JhY2tncm91bmQ6IzJhMmEyYTtjb2xvcjojZmZmfQ0KLnJjYXJke2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTIpO2JvcmRlci1yYWRpdXM6MTBweDtvdmVyZmxvdzpoaWRkZW47YmFja2dyb3VuZDojMjIyfQ0KLmNoaXB7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xMik7Ym9yZGVyLXJhZGl1czo2cHg7cGFkZGluZzo0cHggMTBweDtmb250LXNpemU6MTJweDtjb2xvcjojOWE5YWEyO2N1cnNvcjpwb2ludGVyO2JhY2tncm91bmQ6IzJhMmEyYTt0cmFuc2l0aW9uOi4xMnN9DQouY2hpcDpob3Zlcntjb2xvcjojZmZmfS5jaGlwLm9ue2JvcmRlci1jb2xvcjojNkY1REZGO2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMjIyfQ0KI3RvYXN0e2JveC1zaGFkb3c6MCA4cHggMzBweCByZ2JhKDAsMCwwLC41KX0NCkBtZWRpYSAobWF4LXdpZHRoOjEwMjNweCl7I3JpZ2h0UGFuLm1vYmlsZS1vcGVue3Bvc2l0aW9uOmZpeGVkO3RvcDo1NnB4O3JpZ2h0OjA7Ym90dG9tOjA7bGVmdDphdXRvO3otaW5kZXg6NDA7ZGlzcGxheTpmbGV4O3dpZHRoOm1pbigyMXJlbSw5MnZ3KTtib3gtc2hhZG93Oi04cHggMCAzMHB4IHJnYmEoMCwwLDAsLjUpfX0NCnRleHRhcmVhe2NhcmV0LWNvbG9yOiM2RjVERkZ9DQppbnB1dFt0eXBlPWNoZWNrYm94XXt3aWR0aDoxNHB4O2hlaWdodDoxNHB4O2N1cnNvcjpwb2ludGVyfQ0KaW5wdXRbdHlwZT1yYW5nZV17Y3Vyc29yOnBvaW50ZXJ9DQo6Zm9jdXMtdmlzaWJsZXtvdXRsaW5lOjJweCBzb2xpZCAjNkY1REZGO291dGxpbmUtb2Zmc2V0OjJweH0NCi53dm51bXtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsLjE2KTtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOiMyYTJhMmE7Y29sb3I6I2U4ZThlODtwYWRkaW5nOjNweCA2cHg7d2lkdGg6NjRweDtmb250LXNpemU6MTJweDt0ZXh0LWFsaWduOnJpZ2h0O291dGxpbmU6bm9uZX0NCi53dm51bTpmb2N1c3tib3JkZXItY29sb3I6IzI3RDRDRH0NCi5tdGFie3BhZGRpbmc6OHB4IDE0cHg7Ym9yZGVyLXJhZGl1czo4cHg7Zm9udC1zaXplOjEzcHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtmb250LXdlaWdodDo1MDA7d2hpdGUtc3BhY2U6bm93cmFwO3RyYW5zaXRpb246LjEyc30NCi5tdGFiOmhvdmVye2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMmEyYTJhfS5tdGFiLnNlbHtjb2xvcjojZmZmO2JhY2tncm91bmQ6IzJhMmEyYTtib3JkZXItYm90dG9tOjJweCBzb2xpZCAjNkY1REZGfQ0KLm1jaGlwe2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTIpO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOiMyYTJhMmE7dHJhbnNpdGlvbjouMTJzO3doaXRlLXNwYWNlOm5vd3JhcH0NCi5tY2hpcDpob3Zlcntjb2xvcjojZmZmfS5tY2hpcC5vbntib3JkZXItY29sb3I6IzZGNURGRjtjb2xvcjojZmZmO2JhY2tncm91bmQ6cmdiYSgxMTEsOTMsMjU1LC4xNSl9DQoubWNhcmR7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xMik7Ym9yZGVyLXJhZGl1czoxMHB4O292ZXJmbG93OmhpZGRlbjtiYWNrZ3JvdW5kOiMyYTJhMmE7dHJhbnNpdGlvbjouMTVzfQ0KLm1jYXJkOmhvdmVye2JvcmRlci1jb2xvcjpyZ2JhKDExMSw5MywyNTUsLjU1KTt0cmFuc2Zvcm06dHJhbnNsYXRlWSgtMnB4KTtib3gtc2hhZG93OjAgNnB4IDE4cHggcmdiYSgwLDAsMCwuMzUpfQ0KLm1jYXJkLWltZ3twb3NpdGlvbjpyZWxhdGl2ZTthc3BlY3QtcmF0aW86My80O292ZXJmbG93OmhpZGRlbn0NCi5tY2FyZC1pbWcgaW1ne3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7b2JqZWN0LWZpdDpjb3Zlcjt0cmFuc2l0aW9uOi4zc30NCi5tY2FyZDpob3ZlciAubWNhcmQtaW1nIGltZ3t0cmFuc2Zvcm06c2NhbGUoMS4wNSl9DQoubWNhcmQtYmFkZ2V7cG9zaXRpb246YWJzb2x1dGU7dG9wOjZweDtsZWZ0OjZweDtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjY1KTtiYWNrZHJvcC1maWx0ZXI6Ymx1cig0cHgpO2ZvbnQtc2l6ZToxMHB4O3BhZGRpbmc6MnB4IDZweDtib3JkZXItcmFkaXVzOjRweDtjb2xvcjojZThlOGU4O2ZvbnQtd2VpZ2h0OjUwMH0NCi5tY2FyZC1zdGFye3Bvc2l0aW9uOmFic29sdXRlO3RvcDo2cHg7cmlnaHQ6NnB4O3dpZHRoOjI2cHg7aGVpZ2h0OjI2cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDpyZ2JhKDAsMCwwLC41KTtiYWNrZHJvcC1maWx0ZXI6Ymx1cig0cHgpO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjdXJzb3I6cG9pbnRlcjtjb2xvcjojOWE5YWEyO3RyYW5zaXRpb246LjEyc30NCi5tY2FyZC1zdGFyOmhvdmVye2NvbG9yOiNlYWIzMDh9Lm1jYXJkLXN0YXIub257Y29sb3I6I2VhYjMwOH0NCi5tY2FyZC12aWV3c3twb3NpdGlvbjphYnNvbHV0ZTtib3R0b206NnB4O2xlZnQ6NnB4O2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNik7YmFja2Ryb3AtZmlsdGVyOmJsdXIoNHB4KTtmb250LXNpemU6MTBweDtwYWRkaW5nOjJweCA2cHg7Ym9yZGVyLXJhZGl1czo0cHg7Y29sb3I6I2U4ZThlODtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDozcHh9DQoubWNhcmQtaW5mb3twYWRkaW5nOjhweH0NCi5tY2FyZC1uYW1le2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjojZThlOGU4O3doaXRlLXNwYWNlOm5vd3JhcDtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpc30NCi5tY2FyZC1tZXRhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47bWFyZ2luLXRvcDo2cHh9DQoubWNhcmQtdmVye2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiM5YTlhYTI7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsLjEyKTtib3JkZXItcmFkaXVzOjRweDtwYWRkaW5nOjJweCA2cHh9DQoubWNhcmQtc2Vse2ZvbnQtc2l6ZToxMXB4O2JvcmRlcjoxcHggc29saWQgIzZGNURGRjtjb2xvcjojNkY1REZGO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyLXJhZGl1czo0cHg7cGFkZGluZzoycHggMTBweDtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjouMTJzfQ0KLm1jYXJkLXNlbDpob3ZlcntiYWNrZ3JvdW5kOiM2RjVERkY7Y29sb3I6I2ZmZn0NCjwvc3R5bGU+DQo8L2hlYWQ+DQo8Ym9keT4NCg0KPGhlYWRlciBjbGFzcz0iZml4ZWQgdG9wLTAgbGVmdC0wIHJpZ2h0LTAgei00MCBoLTE0IGJnLVsjMTgxODE4XS84NSBiYWNrZHJvcC1ibHVyIGJvcmRlci1iIGJkIGZsZXggaXRlbXMtY2VudGVyIHB4LTIgc206cHgtMyBnYXAtMiI+DQogIDxidXR0b24gaWQ9Im1tZW51IiBjbGFzcz0ibGc6aGlkZGVuIHRleHQtbmV1dHJhbC00MDAgcC0xIj48aSBkYXRhLWljb249Imxpc3QiIGNsYXNzPSJ3LTUgaC01Ij48L2k+PC9idXR0b24+DQogIDxkaXYgY2xhc3M9InctNiBoLTYgc2hyaW5rLTAgaGlkZGVuIHNtOmZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIj4NCiAgICA8c3ZnIHdpZHRoPSIyMiIgaGVpZ2h0PSIyMiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSJ1cmwoI2cpIi8+PHBhdGggZD0iTTcgMTIuNWwzIDMgNy03IiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIyNCIgeTI9IjI0Ij48c3RvcCBzdG9wLWNvbG9yPSIjNkY1REZGIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNkY1REZGIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PC9zdmc+DQogIDwvZGl2Pg0KICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMC41IGhpZGViYXIgb3ZlcmZsb3cteC1hdXRvIGZsZXgtMSI+DQogICAgPGRpdiBjbGFzcz0idGFiIHNlbCIgZGF0YS10YWI9InRleHQiPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiM2RjVERkYiPjwvc3Bhbj5UZXh0MkltZzwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9InRhYiIgZGF0YS10YWI9ImltZyI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6IzIyYzU1ZSI+PC9zcGFuPkltZzJJbWc8L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJ0YWIiIGRhdGEtdGFiPSJlZGl0Ij48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDojZWFiMzA4Ij48L3NwYW4+RWRpdDwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9InRhYiIgZGF0YS10YWI9InZpZGVvIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDojZWY0NDQ0Ij48L3NwYW4+VmlkZW88L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJ0YWIiIGRhdGEtdGFiPSJwcmltZSI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6IzNiODJmNiI+PC9zcGFuPlByaW1lPC9kaXY+DQogIDwvZGl2Pg0KICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41IHNtOmdhcC0yIG1sLWF1dG8gc2hyaW5rLTAiPg0KICAgIDxidXR0b24gaWQ9Im5jb2wiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNDAwIGhvdmVyOnRleHQtd2hpdGUgcC0xLjUgaGlkZGVuIHNtOmZsZXggaXRlbXMtY2VudGVyIGdhcC0xIHRleHQteHMiIHRpdGxlPSJKdW1sYWgga29sb20iPjxpIGRhdGEtaWNvbj0ic3F1YXJlcy1mb3VyIiBjbGFzcz0idy00IGgtNCI+PC9pPjxzcGFuIGlkPSJuY29sbGJsIj4yPC9zcGFuPjwvYnV0dG9uPg0KICAgIDxidXR0b24gaWQ9ImJ0bi1nbyIgY2xhc3M9ImJ0biBidG4tYmx1ZSBoLTEwIHB4LTQgc206cHgtNSB3aGl0ZXNwYWNlLW5vd3JhcCI+DQogICAgICA8aSBkYXRhLWljb249InBsYXkiIGNsYXNzPSJ3LTQgaC00Ij48L2k+R2VuZXJhdGUNCiAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIG9wYWNpdHktOTAgZm9udC1ub3JtYWwiIGlkPSJwcmljZSI+KyQwLjMzPC9zcGFuPg0KICAgIDwvYnV0dG9uPg0KICA8L2Rpdj4NCjwvaGVhZGVyPg0KDQo8ZGl2IGlkPSJvdmVybGF5IiBjbGFzcz0iZml4ZWQgaW5zZXQtMCBiZy1ibGFjay82MCB6LTMwIGhpZGRlbiBsZzpoaWRkZW4iPjwvZGl2Pg0KDQo8ZGl2IGNsYXNzPSJwdC0xNCBmbGV4IGgtW2NhbGMoMTAwdmgtNTZweCldIG92ZXJmbG93LWhpZGRlbiI+DQoNCiAgPCEtLSBMRUZUIFBBTkVMIC0tPg0KICA8YXNpZGUgaWQ9ImxlZnRwYW4iIGNsYXNzPSJmaXhlZCBsZzpzdGF0aWMgei00MCBpbnNldC15LTAgbGVmdC0wIHB0LTE0IGxnOnB0LTAgdy1bMjJyZW1dIG1heC13LVs4OHZ3XSAtdHJhbnNsYXRlLXgtZnVsbCBsZzp0cmFuc2xhdGUteC0wIHRyYW5zaXRpb24tdHJhbnNmb3JtIGR1cmF0aW9uLTIwMCBzaHJpbmstMCBib3JkZXItciBiZCBvdmVyZmxvdy15LWF1dG8gaGlkZWJhciBiZy1bIzIyMl0iPg0KICAgIDxkaXYgY2xhc3M9InAtNCBzcGFjZS15LTQiPg0KDQogICAgICA8IS0tIFByb21wdCBibG9jayAodG9wIG9mIGxlZnQgcGFuZWwsIGxpa2UgVGVuc29yQXJ0KSAtLT4NCiAgICAgIDxkaXYgY2xhc3M9InJvdW5kZWQteGwgYmctWyMyYTJhMmFdIGJvcmRlciBiZCBvdmVyZmxvdy1oaWRkZW4iPg0KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLXN0YXJ0IGdhcC0yIHB4LTMgcHQtMiI+DQogICAgICAgICAgPHRleHRhcmVhIGlkPSJwcm9tcHQiIHJvd3M9IjMiIGNsYXNzPSJ3LWZ1bGwgYmctdHJhbnNwYXJlbnQgYm9yZGVyLTAgb3V0bGluZS1ub25lIHJlc2l6ZS1ub25lIHRleHQtWzE1cHhdIHRleHQtbmV1dHJhbC0xMDAgcGxhY2Vob2xkZXItbmV1dHJhbC02MDAgbGVhZGluZy1yZWxheGVkIiBwbGFjZWhvbGRlcj0iSmVsYXNrYW4gYXBhIHlhbmcgaW5naW4ga2FtdSBidWF0Li4uIj48L3RleHRhcmVhPg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIHB4LTMgcHktMiI+DQogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41IGN1cnNvci1wb2ludGVyIHNlbGVjdC1ub25lIj4NCiAgICAgICAgICAgIDxpbnB1dCBpZD0ibmVnY2hlY2siIHR5cGU9ImNoZWNrYm94IiBjbGFzcz0iYWNjZW50LVsjNkY1REZGXSIvPg0KICAgICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTQwMCI+TmVnYXRpdmU8L3NwYW4+DQogICAgICAgICAgPC9sYWJlbD4NCiAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41Ij4NCiAgICAgICAgICAgIDxidXR0b24gaWQ9ImJ0bi1lbmhhbmNlIiBjbGFzcz0idGV4dC14cyB0ZXh0LVsjNkY1REZGXSBob3Zlcjp1bmRlcmxpbmUgZm9udC1tZWRpdW0gZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEiPjxpIGRhdGEtaWNvbj0ic3BhcmtsZSIgY2xhc3M9InctMy41IGgtMy41Ij48L2k+RW5oYW5jZTwvYnV0dG9uPg0KICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImNoaXAiIGlkPSJjaGlwLWExMTExIj5BMTExMTwvc3Bhbj4NCiAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJjaGlwIiBpZD0iY2hpcC1lbGxhIj5FbGxhPC9zcGFuPg0KICAgICAgICAgIDwvZGl2Pg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgPGRpdiBpZD0ibmVnd3JhcCIgY2xhc3M9ImhpZGRlbiBib3JkZXItdCBiZCBweC00IHB5LTMiPg0KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0ibmVncHJvbXB0IiByb3dzPSIyIiBjbGFzcz0idy1mdWxsIGJnLXRyYW5zcGFyZW50IGJvcmRlci0wIG91dGxpbmUtbm9uZSByZXNpemUtbm9uZSB0ZXh0LVsxM3B4XSB0ZXh0LW5ldXRyYWwtMTAwIHBsYWNlaG9sZGVyLW5ldXRyYWwtNjAwIiBwbGFjZWhvbGRlcj0iTmVnYXRpdmUgcHJvbXB0Li4uIj48L3RleHRhcmVhPg0KICAgICAgICA8L2Rpdj4NCiAgICAgIDwvZGl2Pg0KDQogICAgICA8IS0tIE1vZGVsIC0tPg0KICAgICAgPGRpdiBpZD0ibW9kZWwtY2FyZCIgY2xhc3M9InJlbGF0aXZlIGJvcmRlciBiZCByb3VuZGVkLXhsIGJnLVsjMmEyYTJhXSBob3Zlcjpib3JkZXItW3JnYmEoMjU1LDI1NSwyNTUsLjI0KV0gY3Vyc29yLXBvaW50ZXIgcC0zIj4NCiAgICAgICAgPHNwYW4gaWQ9Im1vZGVsLWJhZGdlIiBjbGFzcz0iYWJzb2x1dGUgdG9wLTAgbGVmdC0wIHRleHQtWzlweF0gdGV4dC1uZXV0cmFsLTQwMCBiZy1bIzMzM10gYm9yZGVyIGJkIHB4LTIgcHktMC41IHJvdW5kZWQtdGwteGwgcm91bmRlZC1ici1tZCB6LTEwIj5CYXNpYyBNb2RlbCAtIFogSW1hZ2U8L3NwYW4+DQogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0zIG10LTIiPg0KICAgICAgICAgIDxpbWcgaWQ9Im1vZGVsLXRodW1iIiBzcmM9Imh0dHBzOi8vcGljc3VtLnBob3Rvcy9zZWVkL3ppbWFnZS82NCIgY2xhc3M9InctMTYgaC0xNiByb3VuZGVkLWxnIG9iamVjdC1jb3ZlciBzaHJpbmstMCBib3JkZXIgYmQiIGFsdD0ibW9kZWwiLz4NCiAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4LTEgbWluLXctMCI+DQogICAgICAgICAgICA8ZGl2IGlkPSJtb2RlbC1uYW1lIiBjbGFzcz0iZm9udC1zZW1pYm9sZCB0ZXh0LXNtIHRydW5jYXRlIj5aIEltYWdlIC0gYmFzZS1iZjE2PC9kaXY+DQogICAgICAgICAgPC9kaXY+DQogICAgICAgICAgPGJ1dHRvbiBpZD0ibW9kZWwtaW5mbyIgY2xhc3M9InctNiBoLTYgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcm91bmRlZCB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgaG92ZXI6YmctW3JnYmEoMjU1LDI1NSwyNTUsLjA4KV0gdHJhbnNpdGlvbiIgdGl0bGU9IkluZm8iPg0KICAgICAgICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIgY2xhc3M9InctNCBoLTQiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIi8+PGxpbmUgeDE9IjEyIiB5MT0iMTYiIHgyPSIxMiIgeTI9IjEyIi8+PGxpbmUgeDE9IjEyIiB5MT0iOCIgeDI9IjEyLjAxIiB5Mj0iOCIvPjwvc3ZnPg0KICAgICAgICAgIDwvYnV0dG9uPg0KICAgICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGNsYXNzPSJ3LTQgaC00IHRleHQtbmV1dHJhbC01MDAgc2hyaW5rLTAiPjxwb2x5bGluZSBwb2ludHM9IjkgMTggMTUgMTIgOSA2Ii8+PC9zdmc+DQogICAgICAgIDwvZGl2Pg0KICAgICAgPC9kaXY+DQoNCiAgICAgIDwhLS0gTG9SQSAtLT4NCiAgICAgIDxkaXY+DQogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBtYi0yIj4NCiAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5Mb1JBPC9zcGFuPg0KICAgICAgICAgIDxpIGRhdGEtaWNvbj0iY2FyZXQtZG93biIgY2xhc3M9InctNCBoLTQgdGV4dC1uZXV0cmFsLTUwMCI+PC9pPg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgIDxkaXYgaWQ9ImxvcmEtbGlzdCIgY2xhc3M9InNwYWNlLXktMiI+PC9kaXY+DQogICAgICAgPC9kaXY+DQoNCiAgICAgICA8ZGl2Pg0KICAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIj4NCiAgICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+VHJpZ2dlciBXb3Jkczwvc3Bhbj4NCiAgICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCI+KDxzcGFuIGlkPSJ0ci1jb3VudCI+MDwvc3Bhbj4pPC9zcGFuPg0KICAgICAgICAgPC9kaXY+DQogICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gbXQtMSI+DQogICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAiPkFkZCBUcmlnZ2VyIFdvcmRzIHRvIFByb21wdHM8L3NwYW4+DQogICAgICAgICAgIDxidXR0b24gaWQ9ImFkZGFsbC10cmlnIiBjbGFzcz0idGV4dC14cyB0ZXh0LVsjNkY1REZGXSBob3Zlcjp1bmRlcmxpbmUgZm9udC1tZWRpdW0iPkFkZCBBbGw8L2J1dHRvbj4NCiAgICAgICAgIDwvZGl2Pg0KICAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBmbGV4LXdyYXAgZ2FwLTEuNSBtdC0yIiBpZD0idHJpZ2dlcnMiPjwvZGl2Pg0KICAgICAgIDwvZGl2Pg0KDQogICAgICA8IS0tIEFkZCBidXR0b25zIC0tPg0KICAgICAgPGRpdiBjbGFzcz0iZmxleCBnYXAtMiI+DQogICAgICAgIDxidXR0b24gaWQ9ImJ0bi1hZGRsb3JhIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBmbGV4LTEgaC05IGJvcmRlciBiZCB0ZXh0LXhzIj5BZGQgTG9SQTwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IGZsZXgtMSBoLTkgYm9yZGVyIGJkIHRleHQteHMiPkFkZCBFbWJlZGRpbmc8L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iZmxleCBnYXAtMiI+DQogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3QgZmxleC0xIGgtOSBib3JkZXIgYmQgdGV4dC14cyI+QWRkIENvbnRyb2xOZXQ8L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KDQogICAgICA8IS0tIFZBRSAtLT4NCiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4NCiAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20iPlZBRTwvc3Bhbj4NCiAgICAgICAgPHNlbGVjdCBpZD0idmFlIiBjbGFzcz0iaW5wIj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhdXRvbWF0aWMiPkF1dG9tYXRpYzwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Im5vbmUiPk5vbmU8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJ2YWUtZnQtbXNlLTg0MDAwMC1lbWEtcHJ1bmVkLmNrcHQiPnZhZS1mdC1tc2UtODQwMDAwLWVtYS1wcnVuZWQuY2twdDwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImtsLWY4LWFuaW1lLmNrcHQiPmtsLWY4LWFuaW1lLmNrcHQ8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJrbC1mOC1hbmltZTIuY2twdCI+a2wtZjgtYW5pbWUyLmNrcHQ8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJZT1pPUkEudmFlLnB0Ij5ZT1pPUkEudmFlLnB0PC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ib3JhbmdlbWl4LnZhZS5wdCI+b3JhbmdlbWl4LnZhZS5wdDwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImJsZXNzZWQyLnZhZS5wdCI+Ymxlc3NlZDIudmFlLnB0PC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYW5pbWV2YWUucHQiPmFuaW1ldmFlLnB0PC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iQ2xlYXJWQUUuc2FmZXRlbnNvcnMiPkNsZWFyVkFFLnNhZmV0ZW5zb3JzPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icGFzdGVsLXdhaWZ1LWRpZmZ1c2lvbi52YWUucHQiPnBhc3RlbC13YWlmdS1kaWZmdXNpb24udmFlLnB0PC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iY3V0ZV92YWUuc2FmZXRlbnNvcnMiPmN1dGVfdmFlLnNhZmV0ZW5zb3JzPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2R4bF92YWUuc2FmZXRlbnNvcnMiPnNkeGxfdmFlLnNhZmV0ZW5zb3JzPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2R4bC12YWUtZnAxNi1maXguc2FmZXRlbnNvcnMiPnNkeGwtdmFlLWZwMTYtZml4LnNhZmV0ZW5zb3JzPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ieGxWQUVDX2M5MS5zYWZldGVuc29ycyI+eGxWQUVDX2M5MS5zYWZldGVuc29yczwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Imxhc3RwaWVjZVhMVkFFX2Jhc2VvbkEwODk3LnNhZmV0ZW5zb3JzIj5sYXN0cGllY2VYTFZBRV9iYXNlb25BMDg5Ny5zYWZldGVuc29yczwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InBsYXlncm91bmQtdjIuNS1mcDE2LXZhZS5zYWZldGVuc29ycyI+cGxheWdyb3VuZC12Mi41LWZwMTYtdmFlLnNhZmV0ZW5zb3JzPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYWUuc2Z0Ij5hZS5zZnQ8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJwaXhlbF9zcGFjZSI+cGl4ZWxfc3BhY2U8L29wdGlvbj4NCiAgICAgICAgPC9zZWxlY3Q+DQogICAgICA8L2Rpdj4NCg0KICAgICAgPCEtLSBTZXR0aW5ncyAtLT4NCiAgICAgIDxkaXYgY2xhc3M9InNwYWNlLXktNCI+DQogICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPlNldHRpbmdzPC9zcGFuPg0KICAgICAgICA8ZGl2Pg0KICAgICAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZ3JpZC1jb2xzLTQgZ2FwLTIiPg0KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYXIiIGRhdGEtYXI9InBvcnRyYWl0Ij4NCiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHg9IjYiIHk9IjIuNSIgd2lkdGg9IjEyIiBoZWlnaHQ9IjE5IiByeD0iMi41IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiLz48L3N2Zz48L3NwYW4+DQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5Qb3J0cmFpdDwvc3Bhbj4NCiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWRlc2MiPjc2OHgxMTUyPC9zcGFuPg0KICAgICAgICAgICAgPC9idXR0b24+DQogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJhciIgZGF0YS1hcj0ibGFuZHNjYXBlIj4NCiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHg9IjIuNSIgeT0iNiIgd2lkdGg9IjE5IiBoZWlnaHQ9IjEyIiByeD0iMi41IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiLz48L3N2Zz48L3NwYW4+DQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5MYW5kc2NhcGU8L3NwYW4+DQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1kZXNjIj4xMTUyeDc2ODwvc3Bhbj4NCiAgICAgICAgICAgIDwvYnV0dG9uPg0KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYXIiIGRhdGEtYXI9InNxdWFyZSI+DQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1pY28iPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj48cmVjdCB4PSIyLjUiIHk9IjIuNSIgd2lkdGg9IjE5IiBoZWlnaHQ9IjE5IiByeD0iMi41IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiLz48L3N2Zz48L3NwYW4+DQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5TcXVhcmU8L3NwYW4+DQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1kZXNjIj4xMDI0eDEwMjQ8L3NwYW4+DQogICAgICAgICAgICA8L2J1dHRvbj4NCiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9ImFyIHNlbCIgZGF0YS1hcj0iY3VzdG9tIj4NCiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxwYXRoIGQ9Ik00IDhoNU0xMyA4aDdNNCAxNmg5TTE3IDE2aDNNOSA1LjV2NU0xNyAxMy41djUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+PC9zcGFuPg0KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItbmFtZSI+Y3VzdG9tPC9zcGFuPg0KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItZGVzYyI+Y3VzdG9tPC9zcGFuPg0KICAgICAgICAgICAgPC9idXR0b24+DQogICAgICAgICAgPC9kaXY+DQogICAgICAgICAgPGRpdiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIG10LTEuNSIgaWQ9ImFyLWxhYmVsIj5jdXN0b208L2Rpdj4NCiAgICAgICAgPC9kaXY+DQogICAgICAgIDxkaXY+DQogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIGl0ZW1zLWNlbnRlciI+PHNwYW4+V2lkdGg8L3NwYW4+DQogICAgICAgICAgICA8aW5wdXQgaWQ9Ind2IiB0eXBlPSJudW1iZXIiIG1pbj0iMjU2IiBtYXg9IjE1MzYiIHN0ZXA9IjY0IiB2YWx1ZT0iNzY4IiBjbGFzcz0id3ZudW0iLz48L2xhYmVsPg0KICAgICAgICAgIDxpbnB1dCBpZD0id2lkdGgiIHR5cGU9InJhbmdlIiBtaW49IjI1NiIgbWF4PSIxNTM2IiBzdGVwPSI2NCIgdmFsdWU9Ijc2OCIgY2xhc3M9InNsaWRlciBtdC0xIi8+DQogICAgICAgIDwvZGl2Pg0KICAgICAgICA8ZGl2Pg0KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiBpdGVtcy1jZW50ZXIiPjxzcGFuPkhlaWdodDwvc3Bhbj4NCiAgICAgICAgICAgIDxpbnB1dCBpZD0iaHYiIHR5cGU9Im51bWJlciIgbWluPSIyNTYiIG1heD0iMTUzNiIgc3RlcD0iNjQiIHZhbHVlPSIxMTUyIiBjbGFzcz0id3ZudW0iLz48L2xhYmVsPg0KICAgICAgICAgIDxpbnB1dCBpZD0iaGVpZ2h0IiB0eXBlPSJyYW5nZSIgbWluPSIyNTYiIG1heD0iMTUzNiIgc3RlcD0iNjQiIHZhbHVlPSIxMTUyIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4NCiAgICAgICAgPC9kaXY+DQogICAgICAgIDxkaXY+DQogICAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIj4NCiAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIj5TYW1wbGluZyBNZXRob2Q8L3NwYW4+DQogICAgICAgICAgICA8YnV0dG9uIGlkPSJhZHYtdG9nZ2xlIiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEiPjxpIGRhdGEtaWNvbj0iY2FyZXQtZG93biIgY2xhc3M9InctMy41IGgtMy41Ij48L2k+QWR2YW5jZWQ8L2J1dHRvbj4NCiAgICAgICAgICA8L2Rpdj4NCiAgICAgICAgICA8ZGl2IGNsYXNzPSJncmlkIGdyaWQtY29scy0yIGdhcC0yIG10LTEiPg0KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+U2FtcGxlcjwvbGFiZWw+DQogICAgICAgICAgICAgIDxzZWxlY3QgaWQ9InNhbXBsZXIiIGNsYXNzPSJpbnAgdGV4dC14cyI+DQogICAgICAgICAgICAgICAgPG9wdGlvbj5FdWxlciBhPC9vcHRpb24+PG9wdGlvbj5FdWxlcjwvb3B0aW9uPjxvcHRpb24+TE1TPC9vcHRpb24+PG9wdGlvbj5MTVMgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5ERElNPC9vcHRpb24+PG9wdGlvbj5MQ008L29wdGlvbj48b3B0aW9uPkhldW48L29wdGlvbj48b3B0aW9uPkRQTSBmYXN0PC9vcHRpb24+PG9wdGlvbj5EUE0yPC9vcHRpb24+PG9wdGlvbj5EUE0yIGE8L29wdGlvbj48b3B0aW9uPkRQTTIgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0yIGEgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyUyBhPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTTwvb3B0aW9uPjxvcHRpb24+RFBNKysgU0RFPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyUyBhIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0rKyBTREUgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBTREUgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5SZXN0YXJ0PC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBTREUgRXhwb25lbnRpYWw8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNERSBIZXVuPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBTREUgSGV1biBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNERSBIZXVuIEV4cG9uZW50aWFsPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBTR00gVW5pZm9ybTwvb3B0aW9uPjxvcHRpb24+RFBNKysgM00gU0RFPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAzTSBTREUgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAzTSBTREUgRXhwb25lbnRpYWw8L29wdGlvbj48b3B0aW9uPmV1bGVyX2R5PC9vcHRpb24+PG9wdGlvbj5ldWxlcl9zbWVhX2R5PC9vcHRpb24+DQogICAgICAgICAgICAgIDwvc2VsZWN0PjwvZGl2Pg0KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+U2NoZWR1bGVyPC9sYWJlbD4NCiAgICAgICAgICAgICAgPHNlbGVjdCBpZD0ic2NoZWQiIGNsYXNzPSJpbnAgdGV4dC14cyI+PG9wdGlvbj5ub3JtYWw8L29wdGlvbj48b3B0aW9uPnNpbXBsZTwvb3B0aW9uPjxvcHRpb24+a2FycmFzPC9vcHRpb24+PG9wdGlvbj5leHBvbmVudGlhbDwvb3B0aW9uPjxvcHRpb24+c2dtX3VuaWZvcm08L29wdGlvbj48b3B0aW9uPmRkaW1fdW5pZm9ybTwvb3B0aW9uPjxvcHRpb24+YmV0YTwvb3B0aW9uPjxvcHRpb24+bGluZWFyX3F1YWRyYXRpYzwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2Pg0KICAgICAgICAgIDwvZGl2Pg0KPGRpdiBjbGFzcz0ic3BhY2UteS0zIG10LTMiPg0KICAgICAgICAgICAgPGRpdj4NCiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TYW1wbGluZyBTdGVwczwvc3Bhbj48c3BhbiBpZD0ic3YiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj4xMDwvc3Bhbj48L2xhYmVsPg0KICAgICAgICAgICAgICA8aW5wdXQgaWQ9InN0ZXBzIiB0eXBlPSJyYW5nZSIgbWluPSIxIiBtYXg9IjUwIiB2YWx1ZT0iMTAiIGNsYXNzPSJzbGlkZXIgbXQtMSIvPg0KICAgICAgICAgICAgPC9kaXY+DQogICAgICAgICAgICA8ZGl2Pg0KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNGRyBTY2FsZTwvc3Bhbj48c3BhbiBpZD0iY2Z2IiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MTwvc3Bhbj48L2xhYmVsPg0KICAgICAgICAgICAgICA8aW5wdXQgaWQ9ImNmZyIgdHlwZT0icmFuZ2UiIG1pbj0iMSIgbWF4PSIxMCIgc3RlcD0iMC41IiB2YWx1ZT0iMSIgY2xhc3M9InNsaWRlciBtdC0xIi8+DQogICAgICAgICAgICA8L2Rpdj4NCiAgICAgICAgICAgIDxkaXY+DQogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2VlZDwvc3Bhbj48YnV0dG9uIGlkPSJkaWNlIiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCBob3Zlcjp0ZXh0LXdoaXRlIj48aSBkYXRhLWljb249ImRpY2UtZml2ZSIgY2xhc3M9InctNCBoLTQiPjwvaT48L2J1dHRvbj48L2xhYmVsPg0KICAgICAgICAgICAgICA8aW5wdXQgaWQ9InNlZWQiIGNsYXNzPSJpbnAgdGV4dC14cyBtdC0xIiB2YWx1ZT0iMTAxMDkzMzM0Nzk0MzQ2MiIvPg0KICAgICAgICAgICAgPC9kaXY+DQogICAgICAgICAgPC9kaXY+DQogICAgICAgICAgPGRpdiBpZD0iYWR2LWZpZWxkcyIgY2xhc3M9ImhpZGRlbiBzcGFjZS15LTMgbXQtNCBib3JkZXItdCBiZCBwdC0zIj4NCiAgICAgICAgICAgIDxkaXY+DQogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q2xpcCBTa2lwPC9zcGFuPjxzcGFuIGlkPSJjc3YiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj4yPC9zcGFuPjwvbGFiZWw+DQogICAgICAgICAgICAgIDxpbnB1dCBpZD0iY2xpcHNraXAiIHR5cGU9InJhbmdlIiBtaW49IjEiIG1heD0iMTIiIHZhbHVlPSIyIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4NCiAgICAgICAgICAgIDwvZGl2Pg0KICAgICAgICAgICAgPGRpdj4NCiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5FTlNEPC9zcGFuPjxzcGFuIGlkPSJlbnNkIiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MzEzMzc8L3NwYW4+PC9sYWJlbD4NCiAgICAgICAgICAgICAgPGlucHV0IGlkPSJldGFuc2QiIHR5cGU9InJhbmdlIiBtaW49IjAiIG1heD0iMzEzMzciIHZhbHVlPSIzMTMzNyIgY2xhc3M9InNsaWRlciBtdC0xIi8+DQogICAgICAgICAgICA8L2Rpdj4NCiAgICAgICAgICA8L2Rpdj4NCiAgICAgICAgPC9kaXY+DQoNCiAgICAgICAgPCEtLSBVcHNjYWxlIChzZXBhcmF0ZSwgZGkgYmF3YWgpIC0tPg0KICAgICAgICA8ZGl2IGNsYXNzPSJtdC00Ij4NCiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4gaXRlbXMtY2VudGVyIj48c3Bhbj5VcHNjYWxlPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj4yeDwvc3Bhbj48L2xhYmVsPg0KICAgICAgICAgIDxpbnB1dCBpZD0idXBzY2FsZSIgdHlwZT0icmFuZ2UiIG1pbj0iMSIgbWF4PSI0IiBzdGVwPSIwLjUiIHZhbHVlPSIyIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4NCiAgICAgICAgPC9kaXY+DQogICAgICA8L2Rpdj4NCg0KICAgICAgPCEtLSBBUEkgU2V0dGluZ3MgLS0+DQogICAgICA8ZGl2IGNsYXNzPSJib3JkZXIgYmQgcm91bmRlZC14bCBiZy1bIzJhMmEyYV0gcC0zIHNwYWNlLXktMiI+DQogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiI+DQogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+QVBJPC9zcGFuPg0KICAgICAgICAgIDxzcGFuIGlkPSJhcGktc3RhdHVzIiBjbGFzcz0idGV4dC1bMTBweF0gdGV4dC1uZXV0cmFsLTUwMCI+PC9zcGFuPg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPg0KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+UHJvdmlkZXI8L2xhYmVsPg0KICAgICAgICAgIDxzZWxlY3QgaWQ9ImFwaXByb3ZpZGVyIiBjbGFzcz0iaW5wIHRleHQteHMiPg0KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0idGFtcyI+VGVuc29yLkFydCAoVEFNUyk8L29wdGlvbj4NCiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9InJlcGxpY2F0ZSI+UmVwbGljYXRlIChTRFhMKTwvb3B0aW9uPg0KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iZmFsIj5mYWwuYWkgKGZhc3Qtc2R4bCk8L29wdGlvbj4NCiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9InBvbGxpbmF0aW9ucyI+UG9sbGluYXRpb25zIChHUkFUSVMsIHRhbnBhIGtleSk8L29wdGlvbj4NCiAgICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgPC9kaXY+DQogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBpZD0iYXBpa2V5LWZpZWxkIj4NCiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAiIGlkPSJhcGlrZXktbGFiZWwiPkFQSSBLZXkgVEFNUyAodGFtcy50ZW5zb3IuYXJ0KTwvbGFiZWw+DQogICAgICAgICAgPGlucHV0IGlkPSJhcGlrZXkiIHR5cGU9InBhc3N3b3JkIiBjbGFzcz0iaW5wIiBwbGFjZWhvbGRlcj0iQmVhcmVyIHRva2VuLi4uIiBhdXRvY29tcGxldGU9Im9mZiIvPg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgPCEtLSBCWU9QIFBvbGxpbmF0aW9uczogbG9naW4gT0F1dGggKGJ1a2FuIGtvbG9tIEFQSSBrZXkpIC0tPg0KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCBoaWRkZW4iIGlkPSJieW9wLXJvdyI+DQogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIj5Mb2dpbiBQb2xsaW5hdGlvbnM8L2xhYmVsPg0KICAgICAgICAgIDxidXR0b24gaWQ9ImJ5b3AtbG9naW4iIGNsYXNzPSJidG4gYnRuLWdob3N0IHctZnVsbCBoLTggYm9yZGVyIGJkIHRleHQteHMganVzdGlmeS1jZW50ZXIiPkxvZ2luIGRlbmdhbiBQb2xsaW5hdGlvbnMgKEJZT1ApPC9idXR0b24+DQogICAgICAgICAgPGRpdiBpZD0iYnlvcC1zdGF0dXMiIGNsYXNzPSJoaWRkZW4gdGV4dC1bMTBweF0gdGV4dC1uZXV0cmFsLTUwMCBtdC0xIj48L2Rpdj4NCiAgICAgICAgICA8YnV0dG9uIGlkPSJieW9wLWxvZ291dCIgY2xhc3M9ImhpZGRlbiBidG4gYnRuLWdob3N0IHctZnVsbCBoLTggYm9yZGVyIGJkIHRleHQteHMganVzdGlmeS1jZW50ZXIgbXQtMSI+TG9nb3V0PC9idXR0b24+DQogICAgICAgIDwvZGl2Pg0KICAgICAgICA8ZGl2IGlkPSJhcGktaGludCIgY2xhc3M9InRleHQtWzEwcHhdIHRleHQtbmV1dHJhbC02MDAiPjwvZGl2Pg0KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+DQogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIj5Nb2RlPC9sYWJlbD4NCiAgICAgICAgICA8c2VsZWN0IGlkPSJhcGltb2RlIiBjbGFzcz0iaW5wIHRleHQteHMiPg0KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYXV0byI+QXV0byAoYmFja2VuZCAmcmFycjsgZGVtbyk8L29wdGlvbj4NCiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9InJlYWwiPlJlYWwgQVBJICh3YWppYiBiYWNrZW5kKTwvb3B0aW9uPg0KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iZGVtbyI+RGVtbyAoc2ltdWxhc2kgc2FqYSk8L29wdGlvbj4NCiAgICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgPC9kaXY+DQogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggZ2FwLTIiPg0KICAgICAgICAgIDxidXR0b24gaWQ9ImFwaS1zYXZlIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBmbGV4LTEgaC04IGJvcmRlciBiZCB0ZXh0LXhzIj5TaW1wYW48L2J1dHRvbj4NCiAgICAgICAgICA8YnV0dG9uIGlkPSJhcGktdGVzdCIgY2xhc3M9ImJ0biBidG4tZ2hvc3QgZmxleC0xIGgtOCBib3JkZXIgYmQgdGV4dC14cyI+VGVzPC9idXR0b24+DQogICAgICAgIDwvZGl2Pg0KICAgICAgPC9kaXY+DQoNCiAgICAgIDwhLS0gQm90dG9tIC0tPg0KICAgICAgPGRpdiBjbGFzcz0icHQtMSBib3JkZXItdCBiZCBzcGFjZS15LTIiPg0KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IHctZnVsbCBoLTkganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5QYXN0ZSBHZW5lcmF0aW9uIERhdGE8L3NwYW4+PGkgZGF0YS1pY29uPSJjbGlwYm9hcmQiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9idXR0b24+DQogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOSBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlByZXNldHM8L3NwYW4+PGkgZGF0YS1pY29uPSJib29rbWFyay1zaW1wbGUiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9idXR0b24+DQogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOSBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlJlc2V0PC9zcGFuPjxpIGRhdGEtaWNvbj0ia2V5IiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPg0KICAgICAgPC9kaXY+DQogICAgPC9kaXY+DQogIDwvYXNpZGU+DQoNCiAgPCEtLSBDRU5URVI6IGltYWdlIGdyaWQgb25seSAtLT4NCiAgPG1haW4gaWQ9ImNhbnZhcyIgY2xhc3M9ImZsZXgtMSBvdmVyZmxvdy15LWF1dG8gaGlkZWJhciBiZy1bIzE4MTgxOF0iPg0KICAgIDxkaXYgY2xhc3M9InAtNCBtYXgtdy0zeGwgbXgtYXV0byI+DQogICAgICA8IS0tIEltZzJJbWcgdXBsb2FkIC0tPg0KICAgICAgPGRpdiBpZD0iaW1nMmltZy1jYXJkIiBjbGFzcz0iaGlkZGVuIG1iLTQgYm9yZGVyIGJkIHJvdW5kZWQteGwgYmctWyMyMjJdIHAtNCI+DQogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBtYi0yIj4NCiAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5JbWcySW1nIOKAlCBnYW1iYXIgYXdhbDwvc3Bhbj4NCiAgICAgICAgICA8c3BhbiBpZD0iaTJpLWNsZWFyIiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgY3Vyc29yLXBvaW50ZXIiPkhhcHVzPC9zcGFuPg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgPGRpdiBpZD0iaTJpLWRyb3AiIGNsYXNzPSJib3JkZXItMiBib3JkZXItZGFzaGVkIGJkIHJvdW5kZWQteGwgcC02IHRleHQtY2VudGVyIGN1cnNvci1wb2ludGVyIHRleHQtbmV1dHJhbC01MDAgaG92ZXI6Ym9yZGVyLVsjNkY1REZGXSB0ZXh0LXhzIj4NCiAgICAgICAgICBLbGlrIGF0YXUgc2VyZXQgZ2FtYmFyIGtlIHNpbmkNCiAgICAgICAgPC9kaXY+DQogICAgICAgIDxpbnB1dCBpZD0iaTJpLWZpbGUiIHR5cGU9ImZpbGUiIGFjY2VwdD0iaW1hZ2UvKiIgY2xhc3M9ImhpZGRlbiIvPg0KICAgICAgICA8ZGl2IGlkPSJpMmktcHJldmlldyIgY2xhc3M9ImhpZGRlbiBtdC0zIj4NCiAgICAgICAgICA8aW1nIGlkPSJpMmktaW1nIiBjbGFzcz0idy00MCBoLTQwIG9iamVjdC1jb3ZlciByb3VuZGVkLWxnIGJvcmRlciBiZCIgYWx0PSIiLz4NCiAgICAgICAgPC9kaXY+DQogICAgICAgIDxkaXYgY2xhc3M9Im10LTMiPg0KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+RGVub2lzaW5nIFN0cmVuZ3RoPC9zcGFuPjxzcGFuIGlkPSJpMmktZHN2IiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MC41MDwvc3Bhbj48L2xhYmVsPg0KICAgICAgICAgIDxpbnB1dCBpZD0iaTJpLWRzIiB0eXBlPSJyYW5nZSIgbWluPSIwIiBtYXg9IjEiIHN0ZXA9IjAuMDUiIHZhbHVlPSIwLjUiIGNsYXNzPSJzbGlkZXIgbXQtMSIvPg0KICAgICAgICA8L2Rpdj4NCiAgICAgIDwvZGl2Pg0KDQogICAgICA8IS0tIFRhYiBwbGFjZWhvbGRlciAoRWRpdC9WaWRlby9QcmltZSkgLS0+DQogICAgICA8ZGl2IGlkPSJ0YWItcGxhY2Vob2xkZXIiIGNsYXNzPSJoaWRkZW4gZmxleC1jb2wgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGgtWzUwdmhdIHRleHQtbmV1dHJhbC02MDAiPg0KICAgICAgICA8aSBkYXRhLWljb249ImhvdXJnbGFzcy1tZWRpdW0iIGNsYXNzPSJ3LTEyIGgtMTIgbWItMyI+PC9pPg0KICAgICAgICA8cCBjbGFzcz0idGV4dC1zbSIgaWQ9InRhYi1wbGFjZWhvbGRlci10ZXh0Ij5UYWIgaW5pIHNlZ2VyYSBoYWRpcjwvcD4NCiAgICAgIDwvZGl2Pg0KDQogICAgICA8ZGl2IGlkPSJlbXB0eSIgY2xhc3M9ImZsZXggZmxleC1jb2wgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGgtWzYwdmhdIHRleHQtbmV1dHJhbC02MDAiPg0KICAgICAgICA8aSBkYXRhLWljb249ImltYWdlLXNxdWFyZSIgY2xhc3M9InctMTQgaC0xNCBtYi0zIj48L2k+DQogICAgICAgIDxwIGNsYXNzPSJ0ZXh0LXNtIj5IYXNpbCBnZW5lcmF0ZSBha2FuIHRhbXBpbCBkaSBzaW5pPC9wPg0KICAgICAgICA8cCBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNzAwIG10LTEiPklzaSBwcm9tcHQgbGFsdSB0ZWthbiBHZW5lcmF0ZTwvcD4NCiAgICAgIDwvZGl2Pg0KICAgICAgPGRpdiBpZD0iZ3JpZCIgY2xhc3M9ImdyaWQgZ3JpZC1jb2xzLTIgZ2FwLTMiPjwvZGl2Pg0KICAgIDwvZGl2Pg0KICA8L21haW4+DQoNCiAgPCEtLSBSSUdIVCBQQU5FTCAtLT4NCiAgPGFzaWRlIGlkPSJyaWdodFBhbiIgY2xhc3M9InctWzIxcmVtXSBzaHJpbmstMCBib3JkZXItbCBiZCBiZy1bIzIyMl0gaGlkZGVuIGxnOmZsZXggZmxleC1jb2wiPg0KICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBweC0zIHB5LTIgYm9yZGVyLWIgYmQiPg0KICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+R2VuZXJhdGlvbiBIaXN0b3J5PC9zcGFuPg0KICAgICAgPGRpdiBjbGFzcz0iZmxleCBnYXAtMSI+DQogICAgICAgIDxidXR0b24gY2xhc3M9InJ0YWIgc2VsIiBkYXRhLWY9ImFsbCI+QWxsPC9idXR0b24+DQogICAgICAgIDxidXR0b24gY2xhc3M9InJ0YWIiIGRhdGEtZj0iaW1hZ2UiPkltYWdlPC9idXR0b24+DQogICAgICAgIDxidXR0b24gY2xhc3M9InJ0YWIiIGRhdGEtZj0idmlkZW8iPlZpZGVvPC9idXR0b24+DQogICAgICAgIDxidXR0b24gY2xhc3M9InJ0YWIiIGRhdGEtZj0iYXVkaW8iPkF1ZGlvPC9idXR0b24+DQogICAgICA8L2Rpdj4NCiAgICA8L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBweC0zIHB5LTEuNSBib3JkZXItYiBiZCB0ZXh0LW5ldXRyYWwtNTAwIj4NCiAgICAgIDxidXR0b24gY2xhc3M9ImgtNyB3LTcgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC1uZXV0cmFsLTUwMCBob3Zlcjp0ZXh0LXdoaXRlIiB0aXRsZT0iS2Vsb2xhIj48aSBkYXRhLWljb249InNsaWRlcnMtaG9yaXpvbnRhbCIgY2xhc3M9InctNCBoLTQiPjwvaT48L2J1dHRvbj4NCiAgICAgIDxzcGFuIGNsYXNzPSJteC1hdXRvIHRleHQteHMiIGlkPSJyY291bnQiPjAgaGFzaWw8L3NwYW4+DQogICAgICA8YnV0dG9uIGNsYXNzPSJoLTcgdy03IGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHRleHQtbmV1dHJhbC01MDAgaG92ZXI6dGV4dC13aGl0ZSIgdGl0bGU9IlJlbG9hZCI+PGkgZGF0YS1pY29uPSJhcnJvd3MtY2xvY2t3aXNlIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPg0KICAgIDwvZGl2Pg0KICAgIDxkaXYgaWQ9InJsaXN0IiBjbGFzcz0iZmxleC0xIG92ZXJmbG93LXktYXV0byBoaWRlYmFyIHAtMiBzcGFjZS15LTMiPjwvZGl2Pg0KICA8L2FzaWRlPg0KPC9kaXY+DQoNCjwhLS0gTW9iaWxlIGhpc3RvcnkgdG9nZ2xlIC0tPg0KPGJ1dHRvbiBpZD0iYnRuLWhpc3RvcnkiIGNsYXNzPSJsZzpoaWRkZW4gZml4ZWQgYm90dG9tLTQgcmlnaHQtNCB6LTMwIGJ0biBidG4tYmx1ZSBoLTExIHB4LTQiPjxpIGRhdGEtaWNvbj0iY2xvY2stY291bnRlci1jbG9ja3dpc2UiIGNsYXNzPSJ3LTQgaC00Ij48L2k+IFJpd2F5YXQ8L2J1dHRvbj4NCg0KPCEtLSA9PT09PT09PT09PT0gUFJPR1JFU1MgT1ZFUkxBWSA9PT09PT09PT09PT0gLS0+DQo8ZGl2IGlkPSJwcm9nb3ZlcmxheSIgY2xhc3M9ImhpZGRlbiBmaXhlZCBpbnNldC0wIHotMzAgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgYmctYmxhY2svNTAgcC00IiBzdHlsZT0idG9wOjU2cHgiPg0KICA8ZGl2IGNsYXNzPSJ3LWZ1bGwgbWF4LXctc20gYmctWyMyMjJdIGJvcmRlciBiZCByb3VuZGVkLTJ4bCBwLTUgc3BhY2UteS0zIj4NCiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4iPg0KICAgICAgPHNwYW4gaWQ9InByb2ctdGl0bGUiIGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPkdlbmVyYXRpbmcuLi48L3NwYW4+DQogICAgICA8YnV0dG9uIGlkPSJwcm9nLWNhbmNlbCIgY2xhc3M9InRleHQtbmV1dHJhbC01MDAgaG92ZXI6dGV4dC13aGl0ZSB0ZXh0LWxnIGxlYWRpbmctbm9uZSIgdGl0bGU9IkJhdGFsIj7inJU8L2J1dHRvbj4NCiAgICA8L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJyZWxhdGl2ZSBoLTIgYmctWyMyYTJhMmFdIHJvdW5kZWQtZnVsbCBvdmVyZmxvdy1oaWRkZW4iPg0KICAgICAgPGRpdiBpZD0icHJvZy1iYXIiIGNsYXNzPSJhYnNvbHV0ZSBpbnNldC15LTAgbGVmdC0wIHctMCByb3VuZGVkLWZ1bGwiIHN0eWxlPSJiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5NWRlZywjNkY1REZGLCMyN0Q0Q0QpO3RyYW5zaXRpb246d2lkdGggLjRzIj48L2Rpdj4NCiAgICA8L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gdGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIj4NCiAgICAgIDxzcGFuIGlkPSJwcm9nLXN0YXR1cyI+TWVuZ2lyaW0gdGFzay4uLjwvc3Bhbj4NCiAgICAgIDxzcGFuIGlkPSJwcm9nLXBjdCI+MCU8L3NwYW4+DQogICAgPC9kaXY+DQogIDwvZGl2Pg0KPC9kaXY+DQoNCjwhLS0gPT09PT09PT09PT09IExJR0hUQk9YID09PT09PT09PT09PSAtLT4NCjxkaXYgaWQ9ImxpZ2h0Ym94IiBjbGFzcz0iZml4ZWQgaW5zZXQtMCB6LTUwIGhpZGRlbiBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcC00IGJnLWJsYWNrLzgwIj4NCiAgPGRpdiBjbGFzcz0icmVsYXRpdmUgbWF4LXctM3hsIHctZnVsbCBiZy1bIzIyMl0gYm9yZGVyIGJkIHJvdW5kZWQtMnhsIG92ZXJmbG93LWhpZGRlbiI+DQogICAgPGJ1dHRvbiBpZD0ibGItY2xvc2UiIGNsYXNzPSJhYnNvbHV0ZSB0b3AtMiByaWdodC0yIHotMTAgdy05IGgtOSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB0ZXh0LXdoaXRlIGhvdmVyOmJnLXdoaXRlLzEwIHJvdW5kZWQtbGcgdGV4dC14bCI+4pyVPC9idXR0b24+DQogICAgPGltZyBpZD0ibGItaW1nIiBjbGFzcz0idy1mdWxsIG1heC1oLVs2MHZoXSBvYmplY3QtY29udGFpbiBiZy1ibGFjayIgYWx0PSIiLz4NCiAgICA8ZGl2IGlkPSJsYi1tZXRhIiBjbGFzcz0icC00IHNwYWNlLXktMS41IHRleHQteHMgdGV4dC1uZXV0cmFsLTQwMCBvdmVyZmxvdy15LWF1dG8gbWF4LWgtWzMwdmhdIj48L2Rpdj4NCiAgPC9kaXY+DQo8L2Rpdj4NCg0KPCEtLSA9PT09PT09PT09PT0gVE9BU1QgPT09PT09PT09PT09IC0tPg0KPGRpdiBpZD0idG9hc3QiIGNsYXNzPSJmaXhlZCBib3R0b20tMjAgbGVmdC0xLzIgLXRyYW5zbGF0ZS14LTEvMiB6LTUwIGhpZGRlbiBiZy1bIzJhMmEyYV0gYm9yZGVyIGJkIHJvdW5kZWQteGwgcHgtNCBweS0yLjUgdGV4dC1zbSBzaGFkb3ctbGcgbWF4LXctWzg1dnddIj48L2Rpdj4NCg0KPCEtLSA9PT09PT09PT09PT0gU0VMRUNUT1IgTU9EQUwgPT09PT09PT09PT09IC0tPg0KPGRpdiBpZD0ibW9kYWwiIGNsYXNzPSJmaXhlZCBpbnNldC0wIGJnLWJsYWNrLzYwIHotNTAgaGlkZGVuIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBwLTQiPg0KICA8ZGl2IGNsYXNzPSJ3LWZ1bGwgbWF4LXctNXhsIGJnLVsjMjIyXSBib3JkZXIgYmQgcm91bmRlZC0yeGwgb3ZlcmZsb3ctaGlkZGVuIj4NCiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gcHgtNCBwdC0zIHBiLTIgYm9yZGVyLWIgYmQiPg0KICAgICAgPGRpdiBpZD0ibW9kYWwtdGFicyIgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xIj4NCiAgICAgICAgPGJ1dHRvbiBjbGFzcz0ibXRhYiBzZWwiIGRhdGEtbXRhYj0iYmFzaWMiPkJhc2ljIE1vZGVsPC9idXR0b24+DQogICAgICAgIDxidXR0b24gY2xhc3M9Im10YWIiIGRhdGEtbXRhYj0ic3RhcnJlZCI+TXkgU3RhcnJlZDwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIGNsYXNzPSJtdGFiIiBkYXRhLW10YWI9Im15bW9kZWxzIj5NeSBNb2RlbHM8L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTIiPg0KICAgICAgICA8ZGl2IGNsYXNzPSJyZWxhdGl2ZSI+DQogICAgICAgICAgPGkgZGF0YS1pY29uPSJtYWduaWZ5aW5nLWdsYXNzIiBjbGFzcz0idy00IGgtNCBhYnNvbHV0ZSBsZWZ0LTMgdG9wLTEvMiAtdHJhbnNsYXRlLXktMS8yIHRleHQtbmV1dHJhbC01MDAiPjwvaT4NCiAgICAgICAgICA8aW5wdXQgaWQ9Im1zZWFyY2giIGNsYXNzPSJpbnAgcGwtOSB3LTU2IGgtOSIgcGxhY2Vob2xkZXI9IlNlYXJjaC4uLiIvPg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgPGJ1dHRvbiBpZD0ibWZpbHRlcnMiIGNsYXNzPSJidG4gYnRuLWdob3N0IGgtOSBweC0zIGJvcmRlciBiZCB0ZXh0LXhzIHNocmluay0wIj48aSBkYXRhLWljb249InNsaWRlcnMtaG9yaXpvbnRhbCIgY2xhc3M9InctNCBoLTQiPjwvaT5GaWx0ZXJzPC9idXR0b24+DQogICAgICAgIDxidXR0b24gaWQ9Im1vZGFsLWNsb3NlIiBjbGFzcz0idy05IGgtOSBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB0ZXh0LXdoaXRlIGhvdmVyOmJnLVsjMmEyYTJhXSByb3VuZGVkLWxnIHRleHQteGwgbGVhZGluZy1ub25lIiB0aXRsZT0iVHV0dXAiPuKclTwvYnV0dG9uPg0KICAgICAgICA8aDMgaWQ9Im1vZGFsLXRpdGxlIiBjbGFzcz0iaGlkZGVuIGZvbnQtc2VtaWJvbGQgdGV4dC1zbSI+UGlsaWggTW9kZWw8L2gzPg0KICAgICAgPC9kaXY+DQogICAgPC9kaXY+DQogICAgPGRpdiBpZD0ibWNhdCIgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUgcHgtNCBweS0yIGhpZGViYXIgb3ZlcmZsb3cteC1hdXRvIj48L2Rpdj4NCiAgICA8ZGl2IGlkPSJtb2RhbC1ib2R5IiBjbGFzcz0ibWF4LWgtWzU1dmhdIG92ZXJmbG93LXktYXV0byBwLTQiPjwvZGl2Pg0KICA8L2Rpdj4NCjwvZGl2Pg0KDQoNCjxzY3JpcHQ+DQpjb25zdCAkID0gaWQgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOw0KY29uc3QgUyA9ICdodHRwczovL3BpY3N1bS5waG90b3Mvc2VlZC8nOw0KY29uc3Qgc3RhdGUgPSB7IHJlc3VsdHM6W10sIHBhZ2U6J3RleHQnLCBhc3BlY3Q6J3BvcnRyYWl0JywgbmNvbDoyLCBtb2RlbDpudWxsIH07DQoNCi8qID09PT09IExvUkEg4oCUIGRhZnRhciBhc2xpIHBlciBwcm92aWRlciA9PT09PSAqLw0KdmFyIExPUkFfTElCUyA9IHsNCiAgdGFtczogWw0KICAgIHsgbmFtZTonWi1JbWFnZSBMb1JBIHwgRGV0YWlsJywgdGFnczpbJ2RldGFpbGVkJywnc2hhcnAnXSwgdGh1bWI6J2Fmcm8nLCBiYWRnZTonWi1JTUFHRScsIHZpZXdzOicxMksnLCB2ZXI6J1YxJywgYmFzZTonWiBJbWFnZScgfSwNCiAgICB7IG5hbWU6J1otSW1hZ2UgVHVyYm8nLCB0YWdzOlsndHVyYm8nLCdmYXN0J10sIHRodW1iOidyZXRybycsIGJhZGdlOidaLUlNQUdFLVRVUkJPJywgdmlld3M6JzhLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sDQogICAgeyBuYW1lOidaLUltYWdlIEhEUicsIHRhZ3M6WydoZHInLCd2aXZpZCddLCB0aHVtYjonaGRyJywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMTVLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sDQogICAgeyBuYW1lOidaLUltYWdlIFBvcnRyYWl0JywgdGFnczpbJ3BvcnRyYWl0JywnYm9rZWgnXSwgdGh1bWI6J3B0cnQnLCBiYWRnZTonWi1JTUFHRScsIHZpZXdzOicyMksnLCB2ZXI6J1YxJywgYmFzZTonWiBJbWFnZScgfSwNCiAgICB7IG5hbWU6J1otSW1hZ2UgQXJ0aXN0aWMnLCB0YWdzOlsnYXJ0aXN0aWMnLCdwYWludCddLCB0aHVtYjonYXJ0JywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMThLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sDQogICAgeyBuYW1lOidGbHV4IFJlYWxpc20gTG9SQScsIHRhZ3M6WydyZWFsaXN0aWMnLCdwaG90byddLCB0aHVtYjonZmx1eGwnLCBiYWRnZTonRkxVWCcsIHZpZXdzOic0NUsnLCB2ZXI6J1YxJywgYmFzZTonRkxVWC4xJyB9LA0KICAgIHsgbmFtZTonRmx1eCBDaW5lbWF0aWMgTG9SQScsIHRhZ3M6WydjaW5lbWF0aWMnLCdtb29keSddLCB0aHVtYjonZmx1eGMnLCBiYWRnZTonRkxVWCcsIHZpZXdzOiczM0snLCB2ZXI6J1YxJywgYmFzZTonRkxVWC4xJyB9LA0KICAgIHsgbmFtZTonU0RYTCBGaW5lIERldGFpbCcsIHRhZ3M6WydkZXRhaWxlZCcsJ3NoYXJwJ10sIHRodW1iOidkZXRhaWwnLCBiYWRnZTonU0RYTCcsIHZpZXdzOic1MDBLJywgdmVyOidWMScsIGJhc2U6J1NEWEwnIH0sDQogICAgeyBuYW1lOidTRFhMIEFuaW1lIFN0eWxlJywgdGFnczpbJ2FuaW1lJywnY2VsJ10sIHRodW1iOidhbmltZXNsJywgYmFkZ2U6J1NEWEwnLCB2aWV3czonMjgwSycsIHZlcjonVjEnLCBiYXNlOidTRFhMJyB9LA0KICAgIHsgbmFtZTonUG9ueSBFcXVlc3RyaWFuIEFydCcsIHRhZ3M6Wydwb255JywnZmFudGFzeSddLCB0aHVtYjoncG9ueWwnLCBiYWRnZTonUE9OWScsIHZpZXdzOicxNTBLJywgdmVyOidWMScsIGJhc2U6J1BvbnknIH0sDQogICAgeyBuYW1lOidOaXBwb24tQ29yZSBSZXRybyAtIHYwLjEnLCB0YWdzOlsnamFwcmV0cjdjb21tJywncmV0cm8gbWFnYXppbmUnXSwgdGh1bWI6J2JpbGliaW4nLCBiYWRnZTonU1RZTEUnLCB2aWV3czonOTZLJywgdmVyOidWLjEnLCBiYXNlOidTRFhMJyB9LA0KICAgIHsgbmFtZTonSXZhbiBCaWxpYmluIC0gdjAuNycsIHRhZ3M6WydpdmFuYmlsaWJpbjV6JywnaWxsdXN0cmF0aW9uJywnYXJ0IGRlY28nXSwgdGh1bWI6J2RldGFpbCcsIGJhZGdlOidJTExVU1RSQVRJT04nLCB2aWV3czonMTU0SycsIHZlcjonVi4xJywgYmFzZTonU0RYTCcgfSwNCiAgICB7IG5hbWU6J0RldGFpbCBUd2Vha2VyIC0gdjEuMCcsIHRhZ3M6WydkZXRhaWxlZCddLCB0aHVtYjonZ3JhaW4nLCBiYWRnZTonVVRJTElUWScsIHZpZXdzOicxLjJNJywgdmVyOidWLjEnLCBiYXNlOidTRFhMJyB9LA0KICAgIHsgbmFtZTonRmlsbSBHcmFpbiAtIHYwLjUnLCB0YWdzOlsnZmlsbSBncmFpbicsJ2FuYWxvZyddLCB0aHVtYjonZ3JhaW4nLCBiYWRnZTonVVRJTElUWScsIHZpZXdzOic2N0snLCB2ZXI6J1YuMScsIGJhc2U6J1NEWEwnIH0sDQogIF0sDQogIHJlcGxpY2F0ZTogWw0KICAgIHsgbmFtZTonRkxVWC4xIFtzY2huZWxsXSBMb1JBJywgYmFzZTonRkxVWCcsIG1vZGVsOidibGFjay1mb3Jlc3QtbGFicy9mbHV4LXNjaG5lbGwtbG9yYScsIHRhZ3M6WydmbHV4LWxvcmEnXSwgdGh1bWI6J2ZsdXhsJywgYmFkZ2U6J0ZMVVgtTE9SQScsIHZpZXdzOicxMjBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LA0KICAgIHsgbmFtZTonRkxVWC4xIFtkZXZdIExvUkEnLCBiYXNlOidGTFVYJywgbW9kZWw6J2JsYWNrLWZvcmVzdC1sYWJzL2ZsdXgtZGV2LWxvcmEnLCB0YWdzOlsnZmx1eC1sb3JhJ10sIHRodW1iOidmbHV4ZGwnLCBiYWRnZTonRkxVWC1MT1JBJywgdmlld3M6JzkwSycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwNCiAgICB7IG5hbWU6J1NEWEwgKyBMb1JBIFVSTCAoY3VzdG9tKScsIGJhc2U6J1NEWEwnLCBtb2RlbDonenlsaW0wNzAyL3NkeGwtbG9yYS1jdXN0b21pemUtbW9kZWwnLCB0YWdzOlsnbG9yYSddLCB0aHVtYjonc2R4bGwnLCBiYWRnZTonU0RYTC1MT1JBJywgdmlld3M6JzMxMEsnLCB2ZXI6J1YxJywgbmVlZFVybDp0cnVlIH0sDQogICAgeyBuYW1lOidJS0VBIEluc3RydWN0aW9ucyAoU0RYTCwgYmF3YWFuKScsIGJhc2U6J1NEWEwnLCBtb2RlbDonb3N0cmlzL2lrZWEtaW5zdHJ1Y3Rpb25zLWxvcmEtc2R4bCcsIHRhZ3M6Wydpa2VhIGluc3RydWN0aW9ucyddLCB0aHVtYjonaWtlYScsIGJhZGdlOidTVFlMRScsIHZpZXdzOicyMTBLJywgdmVyOidWMScgfSwNCiAgXSwNCiAgZmFsOiBbDQogICAgeyBuYW1lOidGTFVYIExvUkEnLCBiYXNlOidGTFVYJywgbW9kZWw6J2ZhbC1haS9mbHV4LWxvcmEnLCB0YWdzOlsnZmx1eC1sb3JhJ10sIHRodW1iOidmbHV4bCcsIGJhZGdlOidGTFVYLUxPUkEnLCB2aWV3czonMTUwSycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwNCiAgICB7IG5hbWU6J1NEWEwgKyBMb1JBIFVSTCAoZmFzdC1zZHhsKScsIGJhc2U6J1NEWEwnLCBtb2RlbDonZmFsLWFpL2Zhc3Qtc2R4bCcsIHRhZ3M6Wydsb3JhJ10sIHRodW1iOidzZHhsbCcsIGJhZGdlOidTRFhMLUxPUkEnLCB2aWV3czonMTIwSycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwNCiAgICB7IG5hbWU6J0tyZWEgMiBMb1JBICh0dXJibyknLCBiYXNlOidLcmVhIDInLCBtb2RlbDonZmFsLWFpL2tyZWEtMi90dXJiby9sb3JhJywgdGFnczpbJ2tyZWEyJ10sIHRodW1iOidrcmVhJywgYmFkZ2U6J0tSRUEyLUxPUkEnLCB2aWV3czonNjZLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LA0KICBdLA0KICBwb2xsaW5hdGlvbnM6IFtdLCAvLyBMb1JBIHRpZGFrIGRpZHVrdW5nIOKAlCBncmF0aXMsIG1vZGVsIGJhd2FhbiBzYWphDQp9Ow0KdmFyIExPUkFfTElCID0gTE9SQV9MSUJTLnRhbXM7IC8vIGRhZnRhciBha3RpZiBtZW5naWt1dGkgcHJvdmlkZXINCmNvbnN0IExPUkEgPSBbXTsNCi8qID09PT09IE1vZGVsIG1vZGFsIOKAlCBkYWZ0YXIgbW9kZWwgYXNsaSBwZXIgcHJvdmlkZXIgPT09PT0gKi8NCnZhciBNT0RFTF9MSUJTID0gew0KICB0YW1zOiBbDQogICAgeyBuYW1lOidaIEltYWdlIC0gYmFzZS1iZjE2JywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidaIEltYWdlJywgdGh1bWI6J3ppbWFnZScsIGJhZGdlOidaJywgdmlld3M6JzQ0SycsIHZlcjonVi4xJywgbW9kZWxJZDonMTAyNzkwNjI1MzI2MDYwMzgwNScsIG1vZGVsRmlsZUlkOicxMDI3OTA2MjU0MzM0MzY2MjQ1JyB9LA0KICAgIHsgbmFtZTonRkxVWC4xIFtkZXZdJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidGTFVYLjEnLCB0aHVtYjonZmx1eCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzE1NEsnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYyODI2NDQ1MjUwNTYnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjI4MjY0NDUyNTA1NycgfSwNCiAgICB7IG5hbWU6J1N0YWJsZSBEaWZmdXNpb24gWEwnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonc2R4bCcsIGJhZGdlOidTRFhMIDEuMCcsIHZpZXdzOic4OTJLJywgdmVyOidWLjEnLCBtb2RlbElkOicxMDI3OTA2MzA5MDMyMTM2NzA0JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzMDkwMzIxMzY3MDUnIH0sDQogICAgeyBuYW1lOidTdGFibGUgRGlmZnVzaW9uIDMuNSBNZWRpdW0nLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEIDMuNScsIHRodW1iOidzZDM1JywgYmFkZ2U6J1NEIDMuNScsIHZpZXdzOiczMTJLJywgdmVyOidWLjEnLCBtb2RlbElkOicxMDI3OTA2MzE3NDUyODA4MTkyJywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzMTc0NTI4MDgxOTMnIH0sDQogICAgeyBuYW1lOidQb255IERpZmZ1c2lvbiBWNicsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonUG9ueScsIHRodW1iOidwb255JywgYmFkZ2U6J1BPTlknLCB2aWV3czonMi4xTScsIHZlcjonVjYnLCBtb2RlbElkOicxMDI3OTA2MzI2ODc0MjcxNzQ0JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzMjY4NzQyNzE3NDUnIH0sDQogICAgeyBuYW1lOidJbGx1c3RyaW91cyBYTCcsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonSWxsdXN0cmlvdXMnLCB0aHVtYjonaWxsdXN0JywgYmFkZ2U6J0lMTFVTVFJJT1VTJywgdmlld3M6JzY3SycsIHZlcjonVi4xJywgbW9kZWxJZDonMTAyNzkwNjMzNTc4MjQxNDMzNicsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzM1NzgyNDE0MzM3JyB9LA0KICAgIHsgbmFtZTonQW5pbWEnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J0FuaW1hJywgdGh1bWI6J2FuaW1hJywgYmFkZ2U6J0FOSU1BJywgdmlld3M6JzUySycsIHZlcjonVi4xJywgbW9kZWxJZDonMTAyNzkwNjM0NDcxNjc3MTg0MCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzQ0NzE2NzcxODQxJyB9LA0KICAgIHsgbmFtZTonRHJlYW1TaGFwZXInLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonZHJlYW0nLCBiYWRnZTonRFMnLCB2aWV3czonODEySycsIHZlcjonVi41JywgbW9kZWxJZDonMTAyNzkwNjM1MzQ5OTQyOTg4OCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzUzNDk5NDI5ODg5JyB9LA0KICAgIHsgbmFtZTonUmVhbGlzdGljIFZpc2lvbicsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonU0RYTCcsIHRodW1iOidyZWFsJywgYmFkZ2U6J1JWJywgdmlld3M6JzY0NUsnLCB2ZXI6J1YuNi4wJywgbW9kZWxJZDonMTAyNzkwNjM2MjQxMjUzMTcxMicsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzYyNDEyNTMxNzEzJyB9LA0KICAgIHsgbmFtZTonQ291bnRlcmZlaXQnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonY291bnRlcicsIGJhZGdlOidDT1VOVEVSRkVJVCcsIHZpZXdzOic0MjBLJywgdmVyOidWLjUnLCBtb2RlbElkOicxMDI3OTA2MzcxMzM0NzI3NjgwJywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzNzEzMzQ3Mjc2ODEnIH0sDQogICAgeyBuYW1lOidMeXJpZWwnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonbHlyaWVsJywgYmFkZ2U6J0xZUklFTCcsIHZpZXdzOiczMjBLJywgdmVyOidWLjEuNicsIG1vZGVsSWQ6JzEwMjc5MDYzNzk5OTYwMTM1NjgnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM3OTk5NjAxMzU2OScgfSwNCiAgICB7IG5hbWU6J0p1Z2dlcm5hdXQnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonanVnJywgYmFkZ2U6J0pVR0cnLCB2aWV3czonMjEwSycsIHZlcjonVi45JywgbW9kZWxJZDonMTAyNzkwNjM4ODQyMTA5OTUyMCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2Mzg4NDIxMDk5NTIxJyB9LA0KICBdLA0KICByZXBsaWNhdGU6IFsNCiAgICB7IG5hbWU6J0ZMVVguMSBbc2NobmVsbF0nLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidGTFVYJywgdGh1bWI6J2ZsdXgnLCBiYWRnZTonRkxVWCcsIHZpZXdzOic0TScsIHZlcjonVjEnLCBtb2RlbDonYmxhY2stZm9yZXN0LWxhYnMvZmx1eC1zY2huZWxsJyB9LA0KICAgIHsgbmFtZTonRkxVWC4xIFtkZXZdJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonRkxVWCcsIHRodW1iOidmbHV4ZCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzIuMU0nLCB2ZXI6J1YxJywgbW9kZWw6J2JsYWNrLWZvcmVzdC1sYWJzL2ZsdXgtZGV2JyB9LA0KICAgIHsgbmFtZTonU0RYTCAxLjAnLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J3NkeGwnLCBiYWRnZTonU0RYTCAxLjAnLCB2aWV3czonMS4yTScsIHZlcjonVjEnLCBtb2RlbDonc3RhYmlsaXR5LWFpL3NkeGwnIH0sDQogICAgeyBuYW1lOidTdGFibGUgRGlmZnVzaW9uIDMuNSBMYXJnZScsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J1NEIDMuNScsIHRodW1iOidzZDM1JywgYmFkZ2U6J1NEIDMuNScsIHZpZXdzOicxLjVNJywgdmVyOidWMScsIG1vZGVsOidzdGFiaWxpdHktYWkvc3RhYmxlLWRpZmZ1c2lvbi0zLjUtbGFyZ2UnIH0sDQogICAgeyBuYW1lOidTRFhMIExpZ2h0bmluZyA0LVN0ZXAnLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J2xpZ2h0bmluZycsIGJhZGdlOidMSUdIVE5JTkcnLCB2aWV3czonMS44TScsIHZlcjonVjEnLCBtb2RlbDonYnl0ZWRhbmNlL3NkeGwtbGlnaHRuaW5nLTRzdGVwJyB9LA0KICAgIHsgbmFtZTonUmVhbFZpc1hMIFY0LjAnLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J3JlYWwnLCBiYWRnZTonUkVBTElTVElDJywgdmlld3M6JzkwMEsnLCB2ZXI6J1Y0LjAnLCBtb2RlbDonbHVjYXRhY28vcmVhbHZpc3hsLXY0LjAnIH0sDQogICAgeyBuYW1lOidKdWdnZXJuYXV0IFhMIFY5JywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0RYTCcsIHRodW1iOidqdWcnLCBiYWRnZTonSlVHRycsIHZpZXdzOic3NTBLJywgdmVyOidWOScsIG1vZGVsOidkaWdpcGxheS9KdWdnZXJuYXV0X1hMX3Y5JyB9LA0KICAgIHsgbmFtZTonU0RYTCBFbW9qaScsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J1NEWEwnLCB0aHVtYjonZW1vamknLCBiYWRnZTonRU1PSkknLCB2aWV3czonNjAwSycsIHZlcjonVjEnLCBtb2RlbDonZm9mci9zZHhsLWVtb2ppJyB9LA0KICBdLA0KICBmYWw6IFsNCiAgICB7IG5hbWU6J0ZMVVguMSBbc2NobmVsbF0nLCBiYXNlOidmYWwuYWknLCBhcmNoOidGTFVYJywgdGh1bWI6J2ZsdXgnLCBiYWRnZTonRkxVWCcsIHZpZXdzOic1TScsIHZlcjonVjEnLCBtb2RlbDonZmFsLWFpL2ZsdXgvc2NobmVsbCcgfSwNCiAgICB7IG5hbWU6J0ZMVVguMSBbZGV2XScsIGJhc2U6J2ZhbC5haScsIGFyY2g6J0ZMVVgnLCB0aHVtYjonZmx1eGQnLCBiYWRnZTonRkxVWCcsIHZpZXdzOiczTScsIHZlcjonVjEnLCBtb2RlbDonZmFsLWFpL2ZsdXgvZGV2JyB9LA0KICAgIHsgbmFtZTonRmFzdCBTRFhMJywgYmFzZTonZmFsLmFpJywgYXJjaDonU0RYTCcsIHRodW1iOidmYXN0c2R4bCcsIGJhZGdlOidGQUwnLCB2aWV3czonMi41TScsIHZlcjonVjEnLCBtb2RlbDonZmFsLWFpL2Zhc3Qtc2R4bCcgfSwNCiAgICB7IG5hbWU6J1NEWEwnLCBiYXNlOidmYWwuYWknLCBhcmNoOidTRFhMJywgdGh1bWI6J3NkeGwnLCBiYWRnZTonU0RYTCAxLjAnLCB2aWV3czonMS4xTScsIHZlcjonVjEnLCBtb2RlbDonZmFsLWFpL3NkeGwnIH0sDQogICAgeyBuYW1lOidTdGFibGUgRGlmZnVzaW9uIDMuNSBMYXJnZScsIGJhc2U6J2ZhbC5haScsIGFyY2g6J1NEIDMuNScsIHRodW1iOidzZDM1JywgYmFkZ2U6J1NEIDMuNScsIHZpZXdzOic5MDBLJywgdmVyOidWMScsIG1vZGVsOidmYWwtYWkvc3RhYmxlLWRpZmZ1c2lvbi12MzUtbGFyZ2UnIH0sDQogICAgeyBuYW1lOidQbGF5Z3JvdW5kIHYyLjUnLCBiYXNlOidmYWwuYWknLCBhcmNoOidTRFhMJywgdGh1bWI6J3BsYXknLCBiYWRnZTonUExBWScsIHZpZXdzOic3MDBLJywgdmVyOidWMi41JywgbW9kZWw6J2ZhbC1haS9wbGF5Z3JvdW5kL3YyLjUnIH0sDQogICAgeyBuYW1lOidLcmVhIDIgVHVyYm8nLCBiYXNlOidmYWwuYWknLCBhcmNoOidLcmVhIDInLCB0aHVtYjona3JlYScsIGJhZGdlOidLUkVBMicsIHZpZXdzOicxLjFNJywgdmVyOidWMicsIG1vZGVsOidmYWwtYWkva3JlYS0yL3R1cmJvJyB9LA0KICBdLA0KICBwb2xsaW5hdGlvbnM6IFsNCiAgICB7IG5hbWU6J1otSW1hZ2UgVHVyYm8nLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidBbGliYWJhJywgdGh1bWI6J3ppbWFnZScsIGJhZGdlOidGUkVFJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDonemltYWdlJyB9LA0KICAgIHsgbmFtZTonR1BUIEltYWdlIDInLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidPcGVuQUknLCB0aHVtYjonZ3B0JywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidncHQtaW1hZ2UtMicgfSwNCiAgICB7IG5hbWU6J0ZMVVguMSBTY2huZWxsJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonQmxhY2sgRm9yZXN0IExhYnMnLCB0aHVtYjonZmx1eCcsIGJhZGdlOidGUkVFJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDonZmx1eCcgfSwNCiAgICB7IG5hbWU6J0RyZWFtU2hhcGVyIDggTENNJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonTHlrb24nLCB0aHVtYjonZHJlYW0nLCBiYWRnZTonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J2RyZWFtc2hhcGVyJyB9LA0KICAgIHsgbmFtZTonRkxVWC4yIEtsZWluIDRCJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonQmxhY2sgRm9yZXN0IExhYnMnLCB0aHVtYjona2xlaW4nLCBiYWRnZTonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J2tsZWluJyB9LA0KICAgIHsgbmFtZTonS3JlYSAyIE1lZGl1bScsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0tyZWEnLCB0aHVtYjona3JlYScsIGJhZGdlOidQQUlEJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDona3JlYScgfSwNCiAgICB7IG5hbWU6J1NlZWRyZWFtIDUuMCBMaXRlJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonQnl0ZURhbmNlJywgdGh1bWI6J3NlZWQnLCBiYWRnZTonUEFJRCcsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J3NlZWRyZWFtNScgfSwNCiAgICB7IG5hbWU6J1F3ZW4gSW1hZ2UgMycsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J1F3ZW4nLCB0aHVtYjoncXdlbicsIGJhZGdlOidQQUlEJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDoncXdlbi1pbWFnZS0zJyB9LA0KICAgIHsgbmFtZTonTmFubyBCYW5hbmEgMicsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0dvb2dsZScsIHRodW1iOiduYW5vJywgYmFkZ2U6J1BBSUQnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOiduYW5vYmFuYW5hLTInIH0sDQogIF0sDQp9Ow0KdmFyIE1PREVMUyA9IE1PREVMX0xJQlMudGFtczsgLy8gZGFmdGFyIGFrdGlmIG1lbmdpa3V0aSBwcm92aWRlcg0KdmFyIE1DQVQgPSBbJ1RyeSBOb3cnLCdBTEwnLCdPRkZJQ0lBTCBNT0RFTCcsJ01FTUUnLCdFWENMVVNJVkUnLCdCRUFVVFknLCczRCcsJzIuNUQnLCdNQUxFJywnQU5JTUUnLCdSRUFMSVNUSUMnLCdTVFlMRScsJ0dBTUUnLCdERVNJR04nLCdTQ0VORVJZJywnQlVJTERJTkdTJywnTUVDSEEnXTsNCnZhciBfY3VyTGlzdD1bXSwgX2N1ck9uU2VsPWZ1bmN0aW9uKCl7fTsNCmZ1bmN0aW9uIHJlbmRlckNhcmRzKGxpc3QsIG9uU2VsKXsNCiAgX2N1ckxpc3Q9bGlzdDsgX2N1ck9uU2VsPW9uU2VsOw0KICB2YXIgYj0kKCdtb2RhbC1ib2R5Jyk7IGIuaW5uZXJIVE1MPScnOw0KICBpZighbGlzdC5sZW5ndGgpeyBiLmlubmVySFRNTD0nPHAgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBwLTMgdGV4dC1jZW50ZXIiPlRpZGFrIGFkYSBoYXNpbC48L3A+JzsgcmV0dXJuOyB9DQogIHZhciBncmlkPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOw0KICBncmlkLmNsYXNzTmFtZT0nZ3JpZCBncmlkLWNvbHMtMyBzbTpncmlkLWNvbHMtNCBtZDpncmlkLWNvbHMtNSBnYXAtMyc7DQogIGxpc3QuZm9yRWFjaChmdW5jdGlvbihtKXsNCiAgICB2YXIgZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsNCiAgICBkLmNsYXNzTmFtZT0nbWNhcmQnOw0KICAgIGQuaW5uZXJIVE1MID0nPGRpdiBjbGFzcz0ibWNhcmQtaW1nIj4nDQogICAgICArJzxpbWcgc3JjPSInK1MrbS50aHVtYisnLzMwMCIvPicNCiAgICAgICsnPHNwYW4gY2xhc3M9Im1jYXJkLWJhZGdlIj4nK20uYmFkZ2UrJzwvc3Bhbj4nDQogICAgICArJzxkaXYgY2xhc3M9Im1jYXJkLXN0YXIiPjxpIGRhdGEtaWNvbj0ic3RhciIgY2xhc3M9InctNCBoLTQiPjwvaT48L2Rpdj4nDQogICAgICArJzxkaXYgY2xhc3M9Im1jYXJkLXZpZXdzIj48aSBkYXRhLWljb249InBsYXktZmlsbCIgY2xhc3M9InctMyBoLTMiPjwvaT4nK20udmlld3MrJzwvZGl2PicNCiAgICAgICsnPC9kaXY+Jw0KICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC1pbmZvIj4nDQogICAgICArJzxkaXYgY2xhc3M9Im1jYXJkLW5hbWUiIHRpdGxlPSInK20ubmFtZSsnIj4nK20ubmFtZSsnPC9kaXY+Jw0KICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC1tZXRhIj4nDQogICAgICArJzxzZWxlY3QgY2xhc3M9Im1jYXJkLXZlciI+PG9wdGlvbj4nK20udmVyKyc8L29wdGlvbj48b3B0aW9uPlYuMjwvb3B0aW9uPjxvcHRpb24+Vi4zPC9vcHRpb24+PC9zZWxlY3Q+Jw0KICAgICAgKyc8YnV0dG9uIGNsYXNzPSJtY2FyZC1zZWwiPlNlbGVjdDwvYnV0dG9uPicNCiAgICAgICsnPC9kaXY+PC9kaXY+JzsNCiAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5tY2FyZC1zdGFyJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKGUpeyBlLnRhcmdldC5jbG9zZXN0KCcubWNhcmQtc3RhcicpLmNsYXNzTGlzdC50b2dnbGUoJ29uJyk7IH0pOw0KICAgIGQucXVlcnlTZWxlY3RvcignLm1jYXJkLXNlbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBfY3VyT25TZWwobSk7IH0pOw0KICAgIGdyaWQuYXBwZW5kQ2hpbGQoZCk7DQogIH0pOw0KICBiLmFwcGVuZENoaWxkKGdyaWQpOw0KfQ0KZnVuY3Rpb24gYXBwbHlTZWFyY2goKXsNCiAgdmFyIHE9KCQoJ21zZWFyY2gnKS52YWx1ZXx8JycpLnRvTG93ZXJDYXNlKCk7DQogIHJlbmRlckNhcmRzKF9jdXJMaXN0LmZpbHRlcihmdW5jdGlvbihtKXtyZXR1cm4gIXF8fG0ubmFtZS50b0xvd2VyQ2FzZSgpLmluZGV4T2YocSk+PTB9KSwgX2N1ck9uU2VsKTsNCn0NCiQoJ21zZWFyY2gnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsYXBwbHlTZWFyY2gpOw0KJCgnbWZpbHRlcnMnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgnbWNhdCcpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicpOyAkKCdtZmlsdGVycycpLmNsYXNzTGlzdC50b2dnbGUoJ29uJyk7IH0pOw0KZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLm10YWInKS5mb3JFYWNoKGZ1bmN0aW9uKHQpew0KICB0LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpew0KICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tdGFiJykuZm9yRWFjaChmdW5jdGlvbih4KXt4LmNsYXNzTGlzdC5yZW1vdmUoJ3NlbCcpfSk7DQogICAgdC5jbGFzc0xpc3QuYWRkKCdzZWwnKTsNCiAgICBpZih0LmRhdGFzZXQubXRhYj09PSdiYXNpYycpIHJlbmRlckNhcmRzKE1PREVMUywgZnVuY3Rpb24obSl7IHNldE1vZGVsKG0pOyBjbG9zZU1vZGFsKCk7IH0pOw0KICAgIGVsc2UgcmVuZGVyQ2FyZHMoW10sIG51bGwpOw0KICB9KTsNCn0pOw0KZnVuY3Rpb24gcmVuZGVyTUNhdChvblBpY2spew0KICB2YXIgYz0kKCdtY2F0Jyk7DQogIGlmKCFvblBpY2spIG9uUGljaz1mdW5jdGlvbigpe307DQogIHZhciBodG1sPScnOw0KICBNQ0FULmZvckVhY2goZnVuY3Rpb24oY2F0LGkpew0KICAgIGh0bWwrPSc8YnV0dG9uIGNsYXNzPSJtY2hpcCIgZGF0YS1tY2F0PSInK2NhdCsnIj4nK2NhdCsnPC9idXR0b24+JzsNCiAgfSk7DQogIGMuaW5uZXJIVE1MPWh0bWw7DQogIGMucXVlcnlTZWxlY3RvcignLm1jaGlwJykuY2xhc3NMaXN0LmFkZCgnb24nKTsNCiAgYy5xdWVyeVNlbGVjdG9yQWxsKCcubWNoaXAnKS5mb3JFYWNoKGZ1bmN0aW9uKGNoKXsNCiAgICBjaC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsNCiAgICAgIGMucXVlcnlTZWxlY3RvckFsbCgnLm1jaGlwJykuZm9yRWFjaChmdW5jdGlvbih4KXt4LmNsYXNzTGlzdC5yZW1vdmUoJ29uJyl9KTsNCiAgICAgIGNoLmNsYXNzTGlzdC5hZGQoJ29uJyk7DQogICAgICBvblBpY2soY2guZGF0YXNldC5tY2F0KTsNCiAgICB9KTsNCiAgfSk7DQp9DQpmdW5jdGlvbiBzZXRNb2RlbChtKXsNCiAgc3RhdGUubW9kZWw9bTsNCiAgJCgnbW9kZWwtbmFtZScpLnRleHRDb250ZW50PW0ubmFtZTsNCiAgJCgnbW9kZWwtdGh1bWInKS5zcmM9J2h0dHBzOi8vcGljc3VtLnBob3Rvcy9zZWVkLycrbS50aHVtYisnLzY0JzsNCiAgdmFyIGI9JCgnbW9kZWwtYmFkZ2UnKTsgaWYoYikgYi50ZXh0Q29udGVudD0obS5iYXNlfHwnTW9kZWwnKSsnIC0gJysobS5hcmNofHwnJyk7DQp9DQpmdW5jdGlvbiBvcGVuTW9kZWxTZWxlY3Rvcigpew0KICAkKCdtb2RhbC10aXRsZScpLnRleHRDb250ZW50PSdQaWxpaCBNb2RlbCc7DQogIHJlbmRlck1DYXQoZnVuY3Rpb24oKXsgcmVuZGVyQ2FyZHMoTU9ERUxTLCBmdW5jdGlvbihtKXsgc2V0TW9kZWwobSk7IGNsb3NlTW9kYWwoKTsgfSk7IH0pOw0KICByZW5kZXJDYXJkcyhNT0RFTFMsIGZ1bmN0aW9uKG0peyBzZXRNb2RlbChtKTsgY2xvc2VNb2RhbCgpOyB9KTsNCiAgb3Blbk1vZGFsKCk7DQp9DQokKCdtb2RlbC1jYXJkJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLG9wZW5Nb2RlbFNlbGVjdG9yKTsNCmZ1bmN0aW9uIG9wZW5Mb3JhTW9kYWwoKXsNCiAgJCgnbW9kYWwtdGl0bGUnKS50ZXh0Q29udGVudD0nUGlsaWggTG9SQSc7DQogIHZhciBhcmNoPXN0YXRlLm1vZGVsP3N0YXRlLm1vZGVsLmFyY2g6Jyc7DQogIHZhciBhdmFpbD1mdW5jdGlvbigpeyByZXR1cm4gTE9SQV9MSUIuZmlsdGVyKGZ1bmN0aW9uKGwpew0KICAgIHJldHVybiAoIUxPUkEuc29tZShmdW5jdGlvbih4KXtyZXR1cm4geC5uYW1lPT09bC5uYW1lfSkpICYmICghYXJjaCB8fCAhbC5iYXNlIHx8IGwuYmFzZT09PWFyY2gpOw0KICB9KTsgfTsNCiAgdmFyIG9uU2VsPWZ1bmN0aW9uKGwpew0KICAgIExPUkEucHVzaCh7IG5hbWU6bC5uYW1lLCB3OjAuOCwgdGFnczpsLnRhZ3MsIHRodW1iOmwudGh1bWIsIGJhc2U6bC5iYXNlLCBsb3JhTW9kZWw6bC5tb2RlbHx8JycsIG5lZWRVcmw6bC5uZWVkVXJsLCBsb3JhVXJsOicnIH0pOw0KICAgIHJlbmRlckxvcmEoKTsgY2xvc2VNb2RhbCgpOw0KICB9Ow0KICByZW5kZXJNQ2F0KGZ1bmN0aW9uKCl7IHJlbmRlckNhcmRzKGF2YWlsKCksIG9uU2VsKTsgfSk7DQogIHJlbmRlckNhcmRzKGF2YWlsKCksIG9uU2VsKTsNCiAgaWYoIWF2YWlsKCkubGVuZ3RoKXsgJCgnbW9kYWwtdGl0bGUnKS50ZXh0Q29udGVudD0nVGlkYWsgYWRhIExvUkEgdW50dWsgJythcmNoOyB9DQogIG9wZW5Nb2RhbCgpOw0KfQ0KZnVuY3Rpb24gb3Blbk1vZGFsKCl7ICQoJ21vZGFsJykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ21vZGFsJykuY2xhc3NMaXN0LmFkZCgnZmxleCcpOyB9DQpmdW5jdGlvbiBjbG9zZU1vZGFsKCl7ICQoJ21vZGFsJykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ21vZGFsJykuY2xhc3NMaXN0LnJlbW92ZSgnZmxleCcpOyB9DQpmdW5jdGlvbiBvcGVuTG9yYUluZm8obCl7DQogICQoJ21vZGFsLXRpdGxlJykudGV4dENvbnRlbnQ9J0RldGFpbCBMb1JBJzsNCiAgJCgnbWNhdCcpLmlubmVySFRNTD0nJzsNCiAgdmFyIGI9JCgnbW9kYWwtYm9keScpOw0KICBiLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZmxleCBnYXAtMyBwLTIiPicNCiAgICArJzxpbWcgc3JjPSInK1MrbC50aHVtYisnLzE0MCIgY2xhc3M9InctMjggaC0yOCByb3VuZGVkLWxnIG9iamVjdC1jb3ZlciBzaHJpbmstMCIvPicNCiAgICArJzxkaXYgY2xhc3M9ImZsZXgtMSBtaW4tdy0wIj4nDQogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGZsZXgtd3JhcCBnYXAtMS41IG1iLTEiPicNCiAgICArJzxzcGFuIGNsYXNzPSJ0ZXh0LVsxMHB4XSBmb250LXNlbWlib2xkIGJnLVsjMmEyYTJhXSBib3JkZXIgYmQgcHgtMS41IHB5LTAuNSByb3VuZGVkIHRleHQtbmV1dHJhbC00MDAiPkxPUkE8L3NwYW4+Jw0KICAgICsnPHNwYW4gY2xhc3M9InRleHQtWzEwcHhdIGZvbnQtc2VtaWJvbGQgYmctW3JnYmEoMTExLDkzLDI1NSwuMTUpXSBib3JkZXIgYm9yZGVyLVsjNkY1REZGXSBweC0xLjUgcHktMC41IHJvdW5kZWQgdGV4dC1bIzZGNURGRl0iPicrbC5iYWRnZSsnPC9zcGFuPicNCiAgICArJzxzcGFuIGNsYXNzPSJ0ZXh0LVsxMHB4XSBmb250LXNlbWlib2xkIGJnLVsjMmEyYTJhXSBib3JkZXIgYmQgcHgtMS41IHB5LTAuNSByb3VuZGVkIHRleHQtbmV1dHJhbC00MDAiPk9yaWdpbmFsPC9zcGFuPicNCiAgICArJzwvZGl2PicNCiAgICArJzxkaXYgY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+JytsLm5hbWUrJzwvZGl2PicNCiAgICArJzxkaXYgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBtdC0wLjUiPlJla3R5IEFJPC9kaXY+Jw0KICAgICsnPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEgbXQtMSB0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAiPjxpIGRhdGEtaWNvbj0iZG93bmxvYWQtc2ltcGxlIiBjbGFzcz0idy0zLjUgaC0zLjUiPjwvaT4nKyhsLnZpZXdzP2wudmlld3M6JzEySycpKycgZG93bmxvYWRzPC9kaXY+Jw0KICAgICsnPC9kaXY+PC9kaXY+Jw0KICAgICsnPGRpdiBjbGFzcz0iYm9yZGVyLXQgYmQgbXQtMiBwdC0zIj4nDQogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQgbWItMiBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSI+PGkgZGF0YS1pY29uPSJ0YWciIGNsYXNzPSJ3LTQgaC00Ij48L2k+VmVyc2lvbiBEZXRhaWw8L2Rpdj4nDQogICAgKyc8ZGl2IGNsYXNzPSJncmlkIGdyaWQtY29scy0yIGdhcC0yIHRleHQteHMiPicNCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGJvcmRlciBiZCByb3VuZGVkLWxnIHB4LTIgcHktMS41Ij48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+QmFzZSBNb2RlbDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+WiBJbWFnZTwvc3Bhbj48L2Rpdj4nDQogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiBib3JkZXIgYmQgcm91bmRlZC1sZyBweC0yIHB5LTEuNSI+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPlN0ZXBzPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4yNTAwPC9zcGFuPjwvZGl2PicNCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGJvcmRlciBiZCByb3VuZGVkLWxnIHB4LTIgcHktMS41Ij48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+RXBvY2g8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPjEyPC9zcGFuPjwvZGl2PicNCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGJvcmRlciBiZCByb3VuZGVkLWxnIHB4LTIgcHktMS41Ij48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+VHJpZ2dlciBXb3Jkczwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1bIzI3RDRDRF0iPicrbC50YWdzLnNsaWNlKDAsMikuam9pbignLCAnKSsnPC9zcGFuPjwvZGl2PicNCiAgICArJzwvZGl2PicNCiAgICArJzxkaXYgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBtdC0zIG1iLTEiPkRlc2NyaXB0aW9uPC9kaXY+Jw0KICAgICsnPGRpdiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNDAwIGxlYWRpbmctcmVsYXhlZCI+JytsLnRhZ3Muam9pbignLCAnKSsnIOKAlCBMb1JBIHVudHVrIGdheWEgZGFuIGRldGFpbCB0YW1iYWhhbiBkaSBaIEltYWdlLjwvZGl2Pic7DQogIG9wZW5Nb2RhbCgpOw0KfQ0KJCgnbW9kZWwtaW5mbycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgZS5zdG9wUHJvcGFnYXRpb24oKTsgb3BlbkxvcmFJbmZvKHtuYW1lOiQoJ21vZGVsLW5hbWUnKS50ZXh0Q29udGVudCxiYWRnZTonWiBJbWFnZScsdGh1bWI6J3ppbWFnZScsdGFnczpbJ2RldGFpbCcsJ3NoYXJwJ119KTsgfSk7DQokKCdtb2RhbC1jbG9zZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxjbG9zZU1vZGFsKTsNCiQoJ21vZGFsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKGUpeyBpZihlLnRhcmdldD09PSQoJ21vZGFsJykpIGNsb3NlTW9kYWwoKTsgfSk7DQokKCdidG4tYWRkbG9yYScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxvcGVuTG9yYU1vZGFsKTsNCmRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLGZ1bmN0aW9uKGUpeyBpZihlLmtleT09PSdFc2NhcGUnKSBjbG9zZU1vZGFsKCk7IH0pOw0KZnVuY3Rpb24gcmVuZGVyTG9yYSgpew0KICB2YXIgbGlzdCA9ICQoJ2xvcmEtbGlzdCcpOyBsaXN0LmlubmVySFRNTD0nJzsNCiAgaWYoIUxPUkEubGVuZ3RoKXsgbGlzdC5pbm5lckhUTUw9JzxkaXYgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTYwMCBib3JkZXIgYm9yZGVyLWRhc2hlZCBib3JkZXItW3JnYmEoMjU1LDI1NSwyNTUsLjE2KV0gcm91bmRlZC1sZyBwLTMgdGV4dC1jZW50ZXIiPkJlbHVtIGFkYSBMb1JBLiBLbGlrICJBZGQgTG9SQSIuPC9kaXY+JzsgcmVuZGVyVHJpZ2dlcnMoKTsgcmV0dXJuOyB9DQogIExPUkEuZm9yRWFjaChmdW5jdGlvbihsLHJpKXsNCiAgICB2YXIgZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsNCiAgICBkLmNsYXNzTmFtZT0nbG9yYS1jYXJkJzsNCiAgICBkLmlubmVySFRNTD0nJw0KICAgICAgKyc8c3BhbiBjbGFzcz0ibG9yYS1sYWJlbCI+TG9SQSAtICcrKGwuYmFzZXx8J1ogSW1hZ2UnKSsnPC9zcGFuPicNCiAgICAgICsnPGRpdiBjbGFzcz0ibG9yYS10b3AiPicNCiAgICAgICsnPGltZyBzcmM9IicrUytsLnRodW1iKycvNDAiIGNsYXNzPSJsb3JhLXRodW1iIiBhbHQ9IiIvPicNCiAgICAgICsnPHNwYW4gY2xhc3M9ImxvcmEtbmFtZSI+JytsLm5hbWUrJzwvc3Bhbj4nDQogICAgICArJzxkaXYgY2xhc3M9ImxvcmEtaWNvbnMiPicNCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibG9yYS1pY29uIiBkYXRhLWluZm89IicrcmkrJyIgdGl0bGU9IkluZm8iPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIi8+PGxpbmUgeDE9IjEyIiB5MT0iMTYiIHgyPSIxMiIgeTI9IjEyIi8+PGxpbmUgeDE9IjEyIiB5MT0iOCIgeDI9IjEyLjAxIiB5Mj0iOCIvPjwvc3ZnPjwvYnV0dG9uPicNCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibG9yYS1pY29uIGRlbCIgZGF0YS1kZWw9IicrcmkrJyIgdGl0bGU9IkhhcHVzIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cG9seWxpbmUgcG9pbnRzPSIzIDYgNSA2IDIxIDYiLz48cGF0aCBkPSJNMTkgNnYxNGEyIDIgMCAwIDEtMiAySDdhMiAyIDAgMCAxLTItMlY2bTMgMFY0YTIgMiAwIDAgMSAyLTJoNGEyIDIgMCAwIDEgMiAydjIiLz48bGluZSB4MT0iMTAiIHkxPSIxMSIgeDI9IjEwIiB5Mj0iMTciLz48bGluZSB4MT0iMTQiIHkxPSIxMSIgeDI9IjE0IiB5Mj0iMTciLz48L3N2Zz48L2J1dHRvbj4nDQogICAgICArJzwvZGl2PicNCiAgICAgICsnPC9kaXY+Jw0KICAgICAgKyc8ZGl2IGNsYXNzPSJsb3JhLXNsaWRlci1yb3ciPicNCiAgICAgICsnPGRpdiBjbGFzcz0ibC1zbGlkZXIiPjxkaXYgY2xhc3M9ImwtdHJhY2siPjwvZGl2PjxkaXYgY2xhc3M9ImwtZmlsbCIgc3R5bGU9IndpZHRoOicrKGwudy8yKjEwMCkrJyUiPjwvZGl2PjxkaXYgY2xhc3M9ImwtaGFuZGxlIiBzdHlsZT0ibGVmdDonKyhsLncvMioxMDApKyclIj48L2Rpdj48aW5wdXQgdHlwZT0icmFuZ2UiIG1pbj0iMCIgbWF4PSIyIiBzdGVwPSIwLjEiIHZhbHVlPSInK2wudysnIiBkYXRhLXJpPSInK3JpKyciIGNsYXNzPSJsb3JhLXNsIi8+PC9kaXY+Jw0KICAgICAgKyc8ZGl2IGNsYXNzPSJsLW51bSI+Jw0KICAgICAgKyc8YnV0dG9uIGNsYXNzPSJsb3JhLWJ0biIgZGF0YS1kZWM9IicrcmkrJyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGxpbmUgeDE9IjUiIHkxPSIxMiIgeDI9IjE5IiB5Mj0iMTIiLz48L3N2Zz48L2J1dHRvbj4nDQogICAgICArJzxpbnB1dCB0eXBlPSJ0ZXh0IiB2YWx1ZT0iJytsLncudG9GaXhlZCgxKSsnIiBjbGFzcz0ibG9yYS1pbnB1dCIgZGF0YS1yaT0iJytyaSsnIiBpbnB1dG1vZGU9ImRlY2ltYWwiLz4nDQogICAgICArJzxidXR0b24gY2xhc3M9ImxvcmEtYnRuIiBkYXRhLWluYz0iJytyaSsnIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48bGluZSB4MT0iMTIiIHkxPSI1IiB4Mj0iMTIiIHkyPSIxOSIvPjxsaW5lIHgxPSI1IiB5MT0iMTIiIHgyPSIxOSIgeTI9IjEyIi8+PC9zdmc+PC9idXR0b24+Jw0KICAgICAgKyc8L2Rpdj4nDQogICAgICArKGwubmVlZFVybD8nPGRpdiBjbGFzcz0ibXQtMiI+PGlucHV0IHR5cGU9InRleHQiIGNsYXNzPSJpbnAgbG9yYS11cmwtaW5wIiB2YWx1ZT0iJysobC5sb3JhVXJsfHwnJykrJyIgZGF0YS11cmw9IicrcmkrJyIgcGxhY2Vob2xkZXI9Imh0dHBzOi8vaHVnZ2luZ2ZhY2UuY28vdXNlci9yZXBvL3Jlc29sdmUvbWFpbi9sb3JhLnNhZmV0ZW5zb3JzIi8+PGRpdiBjbGFzcz0ibXQtMSB0ZXh0LVsxMHB4XSBsZWFkaW5nLXNudWcgdGV4dC1uZXV0cmFsLTUwMCI+VVJMIHB1YmxpayBsYW5nc3VuZyAoLnNhZmV0ZW5zb3JzKSDigJQgY29udG9oIEh1Z2dpbmdGYWNlIHJlc29sdmUuIEthZ2dsZSB0aWRhayBiaXNhIChidXR1aCBsb2dpbikuPC9kaXY+PC9kaXY+JzonJykNCiAgICAgICsnPC9kaXY+JzsNCiAgICB2YXIgc2w9ZC5xdWVyeVNlbGVjdG9yKCcubC1zbGlkZXIgW2RhdGEtcmk9IicrcmkrJyJdJyk7DQogICAgdmFyIHVJbnA9ZC5xdWVyeVNlbGVjdG9yKCdbZGF0YS11cmw9IicrcmkrJyJdJyk7DQogICAgaWYodUlucCl7IHVJbnAuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpeyBMT1JBW3JpXS5sb3JhVXJsPWUudGFyZ2V0LnZhbHVlLnRyaW0oKTsgfSk7IH0NCiAgICBzbC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7DQogICAgICB2YXIgdj1wYXJzZUZsb2F0KGUudGFyZ2V0LnZhbHVlKTsgaWYoaXNOYU4odikpcmV0dXJuOw0KICAgICAgTE9SQVtyaV0udz12Ow0KICAgICAgdmFyIHBjdD0odi8yKjEwMCk7DQogICAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5sLWZpbGwnKS5zdHlsZS53aWR0aD1wY3QrJyUnOw0KICAgICAgZC5xdWVyeVNlbGVjdG9yKCcubC1oYW5kbGUnKS5zdHlsZS5sZWZ0PXBjdCsnJSc7DQogICAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5sb3JhLWlucHV0JykudmFsdWU9di50b0ZpeGVkKDEpOw0KICAgICAgcmVuZGVyVHJpZ2dlcnMoKTsNCiAgICB9KTsNCiAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5sLW51bSBbZGF0YS1pbmM9IicrcmkrJyJdJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IHNldExXKHJpLCsoTE9SQVtyaV0udyswLjEpLnRvRml4ZWQoMSkpOyByZW5kZXJMb3JhKCk7IH0pOw0KICAgIGQucXVlcnlTZWxlY3RvcignLmwtbnVtIFtkYXRhLWRlYz0iJytyaSsnIl0nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgc2V0TFcocmksKyhMT1JBW3JpXS53LTAuMSkudG9GaXhlZCgxKSk7IHJlbmRlckxvcmEoKTsgfSk7DQogICAgZC5xdWVyeVNlbGVjdG9yKCdbZGF0YS1kZWw9IicrcmkrJyJdJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IExPUkEuc3BsaWNlKHJpLDEpOyByZW5kZXJMb3JhKCk7IHJlbmRlclRyaWdnZXJzKCk7IH0pOw0KICAgIGQucXVlcnlTZWxlY3RvcignW2RhdGEtaW5mbz0iJytyaSsnIl0nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgb3BlbkxvcmFJbmZvKGwpOyB9KTsNCiAgICBsaXN0LmFwcGVuZENoaWxkKGQpOw0KICB9KTsNCiAgcmVuZGVyVHJpZ2dlcnMoKTsNCn0NCmZ1bmN0aW9uIHNldExXKGksdil7IExPUkFbaV0udz1NYXRoLm1heCgwLE1hdGgubWluKDIsdikpOyB9DQp2YXIgX3BlbmRpbmdUcmlnID0gW107DQpmdW5jdGlvbiByZW5kZXJUcmlnZ2Vycygpew0KICB2YXIgcD0oJCgncHJvbXB0JykudmFsdWV8fCcnKS50b0xvd2VyQ2FzZSgpOw0KICB2YXIgdD0kKCd0cmlnZ2VycycpOyB0LmlubmVySFRNTD0nJzsNCiAgX3BlbmRpbmdUcmlnPVtdOw0KICBMT1JBLmZpbHRlcihmdW5jdGlvbihsKXtyZXR1cm4gbC53PjB9KS5mb3JFYWNoKGZ1bmN0aW9uKGwpew0KICAgIGwudGFncy5mb3JFYWNoKGZ1bmN0aW9uKHcpeyBpZihwLmluZGV4T2Yody50b0xvd2VyQ2FzZSgpKTwwKSBfcGVuZGluZ1RyaWcucHVzaCh7d29yZDp3LGxvcmE6bC5uYW1lfSk7IH0pOw0KICB9KTsNCiAgJCgndHItY291bnQnKS50ZXh0Q29udGVudD1fcGVuZGluZ1RyaWcubGVuZ3RoOw0KICBpZighX3BlbmRpbmdUcmlnLmxlbmd0aCl7IHQuaW5uZXJIVE1MPSc8c3BhbiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNjAwIj5UaWRhayBhZGEgdHJpZ2dlciB3b3JkIHRlcnNpc2E8L3NwYW4+JzsgcmV0dXJuOyB9DQogIF9wZW5kaW5nVHJpZy5mb3JFYWNoKGZ1bmN0aW9uKGl0ZW0pew0KICAgIHZhciBiPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOw0KICAgIGIuY2xhc3NOYW1lPSd0YWcgY3Vyc29yLXBvaW50ZXIgaG92ZXI6Ym9yZGVyLVsjMjdENENEXSBob3Zlcjp0ZXh0LVsjMjdENENEXSB0cmFuc2l0aW9uJzsNCiAgICBiLmlubmVySFRNTD0nPGkgZGF0YS1pY29uPSJzcGFya2xlIiBjbGFzcz0idy0zIGgtMyB0ZXh0LVsjMjdENENEXSI+PC9pPicraXRlbS53b3JkOw0KICAgIGIudGl0bGU9J1RhbWJhaGthbiBrZSBwcm9tcHQgKCcraXRlbS5sb3JhKycpJzsNCiAgICBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpew0KICAgICAgYWRkV29yZChpdGVtLndvcmQpOw0KICAgICAgcmVuZGVyVHJpZ2dlcnMoKTsNCiAgICB9KTsNCiAgICB0LmFwcGVuZENoaWxkKGIpOw0KICB9KTsNCn0NCmZ1bmN0aW9uIGFkZFdvcmQodyl7DQogIHZhciBwcj0kKCdwcm9tcHQnKSwgY3Y9cHIudmFsdWUudHJpbSgpOw0KICBpZihjdiAmJiAhY3YuZW5kc1dpdGgoJywnKSkgY3YrPScsJzsNCiAgcHIudmFsdWU9Y3YrdysnLCc7DQogIHByLmZvY3VzKCk7DQp9DQpmdW5jdGlvbiBhZGRBbGxUcmlnKCl7DQogIHZhciBhbGw9X3BlbmRpbmdUcmlnLm1hcChmdW5jdGlvbih4KXtyZXR1cm4geC53b3JkfSk7DQogIGFsbC5mb3JFYWNoKGFkZFdvcmQpOw0KICByZW5kZXJUcmlnZ2VycygpOw0KfQ0KJCgnYWRkYWxsLXRyaWcnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsYWRkQWxsVHJpZyk7DQoNCi8qID09PT09IGFzcGVjdCByYXRpbyA9PT09PSAqLw0KdmFyIEFSX01BUCA9IHsNCiAgcG9ydHJhaXQ6WydQb3J0cmFpdCcsNzY4LDExNTJdLA0KICBsYW5kc2NhcGU6WydMYW5kc2NhcGUnLDExNTIsNzY4XSwNCiAgc3F1YXJlOlsnU3F1YXJlJywxMDI0LDEwMjRdLA0KICBjdXN0b206WydjdXN0b20nLG51bGwsbnVsbF0NCn07DQpkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXInKS5mb3JFYWNoKGZ1bmN0aW9uKGIpew0KICBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpew0KICAgIHZhciBhcj1iLmRhdGFzZXQuYXI7IHN0YXRlLmFzcGVjdD1hcjsNCiAgICBzZXRBckFjdGl2ZShhcik7DQogICAgaWYoYXIhPT0nY3VzdG9tJyl7ICQoJ3dpZHRoJykudmFsdWU9QVJfTUFQW2FyXVsxXTsgJCgnaGVpZ2h0JykudmFsdWU9QVJfTUFQW2FyXVsyXTsgfQ0KICAgIHVwZFdIKCk7DQogIH0pOw0KfSk7DQpmdW5jdGlvbiB1cGRXSCgpeyAkKCd3dicpLnZhbHVlPSQoJ3dpZHRoJykudmFsdWU7ICQoJ2h2JykudmFsdWU9JCgnaGVpZ2h0JykudmFsdWU7IH0NCiQoJ3dpZHRoJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKCl7ICQoJ3d2JykudmFsdWU9JCgnd2lkdGgnKS52YWx1ZTsgc3RhdGUuYXNwZWN0PSdjdXN0b20nOyBzZXRBckFjdGl2ZSgnY3VzdG9tJyk7IH0pOw0KJCgnaGVpZ2h0JykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKCl7ICQoJ2h2JykudmFsdWU9JCgnaGVpZ2h0JykudmFsdWU7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsNCiQoJ3d2JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbigpeyB2YXIgdj1NYXRoLm1heCgyNTYsTWF0aC5taW4oMTUzNixwYXJzZUludCgkKCd3dicpLnZhbHVlKXx8NzY4KSk7IHY9TWF0aC5yb3VuZCh2LzY0KSo2NDsgJCgnd3YnKS52YWx1ZT12OyAkKCd3aWR0aCcpLnZhbHVlPXY7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsNCiQoJ2h2JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbigpeyB2YXIgdj1NYXRoLm1heCgyNTYsTWF0aC5taW4oMTUzNixwYXJzZUludCgkKCdodicpLnZhbHVlKXx8MTE1MikpOyB2PU1hdGgucm91bmQodi82NCkqNjQ7ICQoJ2h2JykudmFsdWU9djsgJCgnaGVpZ2h0JykudmFsdWU9djsgc3RhdGUuYXNwZWN0PSdjdXN0b20nOyBzZXRBckFjdGl2ZSgnY3VzdG9tJyk7IH0pOw0KZnVuY3Rpb24gc2V0QXJBY3RpdmUoYXIpew0KICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXInKS5mb3JFYWNoKGZ1bmN0aW9uKHgpe3guY2xhc3NMaXN0LnRvZ2dsZSgnc2VsJywgeC5kYXRhc2V0LmFyPT09YXIpfSk7DQogICQoJ2FyLWxhYmVsJykudGV4dENvbnRlbnQ9QVJfTUFQW2FyXVswXTsNCn0NCiQoJ3N0ZXBzJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpeyQoJ3N2JykudGV4dENvbnRlbnQ9ZS50YXJnZXQudmFsdWV9KTsNCiQoJ2NmZycpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbihlKXskKCdjZnYnKS50ZXh0Q29udGVudD1lLnRhcmdldC52YWx1ZX0pOw0KJCgnY2xpcHNraXAnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7JCgnY3N2JykudGV4dENvbnRlbnQ9ZS50YXJnZXQudmFsdWV9KTsNCiQoJ2V0YW5zZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbihlKXskKCdlbnNkJykudGV4dENvbnRlbnQ9ZS50YXJnZXQudmFsdWV9KTsNCiQoJ2Fkdi10b2dnbGUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXskKCdhZHYtZmllbGRzJykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJyl9KTsNCiQoJ2RpY2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXskKCdzZWVkJykudmFsdWU9U3RyaW5nKE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSo5OTk5OTk5OTk5OTk5OTk5KSl9KTsNCiQoJ25lZ2NoZWNrJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbihlKXskKCduZWd3cmFwJykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJywhZS50YXJnZXQuY2hlY2tlZCl9KTsNCiQoJ3Byb21wdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxyZW5kZXJUcmlnZ2Vycyk7DQokKCdidG4tZW5oYW5jZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpew0KICB2YXIgcD0oJCgncHJvbXB0JykudmFsdWV8fCcnKS50cmltKCk7DQogIGlmKCFwKXsgJCgncHJvbXB0JykuZm9jdXMoKTsgcmV0dXJuOyB9DQogIHZhciBiPSQoJ2J0bi1lbmhhbmNlJyk7DQogIGIuaW5uZXJIVE1MPSc8aSBkYXRhLWljb249ImNpcmNsZS1ub3RjaCIgY2xhc3M9InctMy41IGgtMy41IGFuaW1hdGUtc3BpbiI+PC9pPkVuaGFuY2luZy4uLic7DQogIHNldFRpbWVvdXQoZnVuY3Rpb24oKXsNCiAgICAkKCdwcm9tcHQnKS52YWx1ZT1wDQogICAgICArJ1xuXG5FbmhhbmNlIGRldGFpbCwgbGlnaHRpbmcsIGNvbXBvc2l0aW9uLCBhbmQgYXRtb3NwaGVyZS4gJw0KICAgICAgKydVbHRyYS1kZXRhaWxlZCwgcHJvZmVzc2lvbmFsIHBob3RvZ3JhcGh5LCBzaGFycCBmb2N1cywgY2luZW1hdGljIGxpZ2h0aW5nLic7DQogICAgcmVuZGVyVHJpZ2dlcnMoKTsNCiAgICBiLmlubmVySFRNTD0nPGkgZGF0YS1pY29uPSJzcGFya2xlIiBjbGFzcz0idy0zLjUgaC0zLjUiPjwvaT5FbmhhbmNlJzsNCiAgfSw5MDApOw0KfSk7DQpkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuY2hpcCcpLmZvckVhY2goZnVuY3Rpb24oYyl7DQogIGMuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7Yy5jbGFzc0xpc3QudG9nZ2xlKCdvbicpfSk7DQp9KTsNCg0KLyogPT09PT0gdGFicyA9PT09PSAqLw0KZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRhYicpLmZvckVhY2goZnVuY3Rpb24odCl7DQogIHQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7DQogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRhYicpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QucmVtb3ZlKCdzZWwnKX0pOw0KICAgIHQuY2xhc3NMaXN0LmFkZCgnc2VsJyk7IHN0YXRlLnBhZ2U9dC5kYXRhc2V0LnRhYjsNCiAgICByZW5kZXJDYW52YXMoKTsNCiAgfSk7DQp9KTsNCmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5ydGFiJykuZm9yRWFjaChmdW5jdGlvbih0KXsNCiAgdC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsNCiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucnRhYicpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QucmVtb3ZlKCdzZWwnKX0pOw0KICAgIHQuY2xhc3NMaXN0LmFkZCgnc2VsJyk7DQogIH0pOw0KfSk7DQoNCi8qID09PT09IG1vYmlsZSBkcmF3ZXIgPT09PT0gKi8NCiQoJ21tZW51JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IG9wZW5MZWZ0KCk7IH0pOw0KJCgnb3ZlcmxheScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBjbG9zZUxlZnQoKTsgfSk7DQpmdW5jdGlvbiBvcGVuTGVmdCgpeyAkKCdvdmVybGF5JykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ2xlZnRwYW4nKS5jbGFzc0xpc3QucmVtb3ZlKCctdHJhbnNsYXRlLXgtZnVsbCcpOyB9DQpmdW5jdGlvbiBjbG9zZUxlZnQoKXsgJCgnb3ZlcmxheScpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyBpZih3aW5kb3cuaW5uZXJXaWR0aDwxMDI0KSAkKCdsZWZ0cGFuJykuY2xhc3NMaXN0LmFkZCgnLXRyYW5zbGF0ZS14LWZ1bGwnKTsgfQ0KDQovKiA9PT09PSBpbWFnZSBjb3VudCA9PT09PSAqLw0KJCgnbmNvbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpew0KICBzdGF0ZS5uY29sID0gc3RhdGUubmNvbD09PTI/MToyOw0KICAkKCdncmlkJykuY2xhc3NOYW1lPSdncmlkIGdyaWQtY29scy0nK3N0YXRlLm5jb2wrJyBnYXAtMyc7DQogICQoJ25jb2xsYmwnKS50ZXh0Q29udGVudD1zdGF0ZS5uY29sOw0KfSk7DQoNCi8qID09PT09IGdlbmVyYXRlIChyZWFsIEFQSSAvIGRlbW8gZmFsbGJhY2spID09PT09ICovDQokKCdidG4tZ28nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZG9HZW5lcmF0ZSk7DQpmdW5jdGlvbiBzZXRCdXN5KGIpew0KICAkKCdidG4tZ28nKS5kaXNhYmxlZD1iOyAkKCdidG4tZ28nKS5zdHlsZS5vcGFjaXR5PWI/JzAuNSc6JzEnOw0KICAkKCdidG4tZ28nKS5pbm5lckhUTUw9Yj8nPGkgZGF0YS1pY29uPSJjaXJjbGUtbm90Y2giIGNsYXNzPSJ3LTQgaC00IGFuaW1hdGUtc3BpbiI+PC9pPkdlbmVyYXRpbmcuLi4nDQogICAgOic8aSBkYXRhLWljb249InBsYXkiIGNsYXNzPSJ3LTQgaC00Ij48L2k+R2VuZXJhdGUgPHNwYW4gY2xhc3M9InRleHQteHMgb3BhY2l0eS05MCBmb250LW5vcm1hbCI+KyQwLjMzPC9zcGFuPic7DQp9DQpmdW5jdGlvbiBleHRyYWN0SW1hZ2VzKGRhdGEpew0KICBpZighZGF0YSkgcmV0dXJuIFtdOw0KICBpZihBcnJheS5pc0FycmF5KGRhdGEpKSBkYXRhPXtpbWFnZXM6ZGF0YX07DQogIHZhciBpbWdzPWRhdGEuaW1hZ2VzfHxkYXRhLmRhdGEmJmRhdGEuZGF0YS5pbWFnZXN8fGRhdGEucmVzdWx0JiZkYXRhLnJlc3VsdC5pbWFnZXN8fGRhdGEudXJsc3x8W107DQogIHJldHVybiBpbWdzLm1hcChmdW5jdGlvbihpKXsgcmV0dXJuIHR5cGVvZiBpPT09J3N0cmluZyc/aTooaS51cmx8fGkuc3JjfHxpLmltYWdlfHxpLnBhdGgpOyB9KS5maWx0ZXIoQm9vbGVhbik7DQp9DQovKiA9PT09PSBoYXNpbCArIHJpd2F5YXQgKHBlcnNpc3QgbG9jYWxTdG9yYWdlKSA9PT09PSAqLw0KZnVuY3Rpb24gcGVyc2lzdFJlc3VsdHMoKXsNCiAgdHJ5eyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShSRVNVTFRTX0tFWSxKU09OLnN0cmluZ2lmeShzdGF0ZS5yZXN1bHRzLnNsaWNlKDAsNjApKSk7IH1jYXRjaChlKXt9DQp9DQpmdW5jdGlvbiBtYWtlR3JpZENhcmQocil7DQogIHZhciBnPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOw0KICBnLmNsYXNzTmFtZT0ncmVsYXRpdmUgcm91bmRlZC14bCBvdmVyZmxvdy1oaWRkZW4gYm9yZGVyIGJkIGFzcGVjdC1bNC81XSBiZy1bIzJhMmEyYV0gY3Vyc29yLXBvaW50ZXIgaG92ZXI6Ym9yZGVyLVtyZ2JhKDI1NSwyNTUsMjU1LC4yNCldJzsNCiAgZy5pbm5lckhUTUw9JzxpbWcgc3JjPSInK3Iuc3JjKyciIGNsYXNzPSJ3LWZ1bGwgaC1mdWxsIG9iamVjdC1jb3ZlciIvPicNCiAgICArKHIuZGVtbz8nPHNwYW4gY2xhc3M9ImFic29sdXRlIHRvcC0xLjUgbGVmdC0xLjUgdGV4dC1bOXB4XSBiZy1ibGFjay82MCBweC0xLjUgcHktMC41IHJvdW5kZWQgdGV4dC1uZXV0cmFsLTMwMCI+REVNTzwvc3Bhbj4nOicnKTsNCiAgZy5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgb3BlbkxpZ2h0Ym94KHIpOyB9KTsNCiAgcmV0dXJuIGc7DQp9DQpmdW5jdGlvbiByZW5kZXJHcmlkKCl7DQogIHZhciBncmlkPSQoJ2dyaWQnKTsgZ3JpZC5pbm5lckhUTUw9Jyc7DQogIHZhciBhcnI9c3RhdGUucmVzdWx0cy5zbGljZSgpLnJldmVyc2UoKTsgLy8gaGFzaWwgdGVyYmFydSB0YW1waWwgZHVsdWFuDQogIGFyci5mb3JFYWNoKGZ1bmN0aW9uKHIpeyBncmlkLmFwcGVuZENoaWxkKG1ha2VHcmlkQ2FyZChyKSk7IH0pOw0KICAkKCdlbXB0eScpLnN0eWxlLmRpc3BsYXkgPSBzdGF0ZS5yZXN1bHRzLmxlbmd0aD4wID8gJ25vbmUnIDogJyc7DQp9DQpmdW5jdGlvbiBhZGRSZXN1bHQocil7DQogIHN0YXRlLnJlc3VsdHMudW5zaGlmdChyKTsNCiAgaWYoc3RhdGUucmVzdWx0cy5sZW5ndGg+NjApIHN0YXRlLnJlc3VsdHMubGVuZ3RoPTYwOw0KICBwZXJzaXN0UmVzdWx0cygpOw0KICByZW5kZXJHcmlkKCk7DQogIHJlbmRlclJpZ2h0KCk7DQp9DQoNCi8qID09PT09IHJpZ2h0IGhpc3RvcnkgPT09PT0gKi8NCmZ1bmN0aW9uIGZtdERhdGUodHMpeyB0cnl7IHJldHVybiBuZXcgRGF0ZSh0cykudG9Mb2NhbGVEYXRlU3RyaW5nKCdpZC1JRCcpOyB9Y2F0Y2goZSl7IHJldHVybiAnJzsgfSB9DQpmdW5jdGlvbiByZW5kZXJSaWdodCgpew0KICB2YXIgbGlzdD0kKCdybGlzdCcpOyBsaXN0LmlubmVySFRNTD0nJzsNCiAgaWYoIXN0YXRlLnJlc3VsdHMubGVuZ3RoKXsgbGlzdC5pbm5lckhUTUw9JzxwIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgcC00IHRleHQtY2VudGVyIj5CZWx1bSBhZGEgaGFzaWwuPC9wPic7ICQoJ3Jjb3VudCcpLnRleHRDb250ZW50PScwIGhhc2lsJzsgcmV0dXJuOyB9DQogICQoJ3Jjb3VudCcpLnRleHRDb250ZW50PXN0YXRlLnJlc3VsdHMubGVuZ3RoKycgaGFzaWwnOw0KICBzdGF0ZS5yZXN1bHRzLmZvckVhY2goZnVuY3Rpb24ocixpKXsNCiAgICB2YXIgZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsgZC5jbGFzc05hbWU9J3JjYXJkJzsNCiAgICB2YXIgbGJsPXIuZGVtbz8nRGVtbyAoc2ltdWxhc2kpJzooci5wYWdlPT09J2ltZyc/J0ltYWdlIHRvIEltYWdlJzonVGV4dCB0byBJbWFnZScpOw0KICAgIGQuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJyZWxhdGl2ZSI+Jw0KICAgICAgKyc8aW1nIHNyYz0iJytyLnNyYysnIiBjbGFzcz0idy1mdWxsIGFzcGVjdC1bNC8zXSBvYmplY3QtY292ZXIgY3Vyc29yLXBvaW50ZXIiLz4nDQogICAgICArJzxidXR0b24gY2xhc3M9ImFic29sdXRlIHRvcC0xLjUgcmlnaHQtMS41IHctNiBoLTYgcm91bmRlZC1tZCBiZy1ibGFjay81MCBob3ZlcjpiZy1yZWQtNTAwLzgwIHRleHQtd2hpdGUgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC14cyIgdGl0bGU9IkhhcHVzIj7inJU8L2J1dHRvbj4nDQogICAgICArJzwvZGl2PicNCiAgICAgICsnPGRpdiBjbGFzcz0icC0yLjUgc3BhY2UteS0xLjUgdGV4dC14cyI+Jw0KICAgICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41Ij48aSBkYXRhLWljb249InNwYXJrbGUiIGNsYXNzPSJ3LTMgaC0zIHRleHQtdmlvbGV0LTQwMCI+PC9pPjxzcGFuIGNsYXNzPSJiZy12aW9sZXQtNTAwLzEwIHRleHQtdmlvbGV0LTMwMCBweC0xLjUgcHktcHggcm91bmRlZCB0ZXh0LVsxMHB4XSI+JytsYmwrJzwvc3Bhbj48L2Rpdj4nDQogICAgICArJzxkaXYgY2xhc3M9ImJnLWJsYWNrLzQwIHJvdW5kZWQgcC0xLjUgdGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTMwMCBsZWFkaW5nLXNudWcgY3Vyc29yLXBvaW50ZXIgaG92ZXI6dGV4dC13aGl0ZSIgdGl0bGU9IkxpaGF0IGRldGFpbCI+Jysoci5wcm9tcHR8fCcnKS5zbGljZSgwLDkwKSsnPC9kaXY+Jw0KICAgICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSB0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNTAwIj48aSBkYXRhLWljb249ImxheWVycyIgY2xhc3M9InctMyBoLTMiPjwvaT4nK0xPUkEuZmlsdGVyKGZ1bmN0aW9uKGwpe3JldHVybiBsLnc+MH0pLmxlbmd0aCsnIExvUkE8L2Rpdj4nDQogICAgICArJzxkaXYgY2xhc3M9InNwYWNlLXktMSB0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNTAwIj4nDQogICAgICArKHIudGFza0lkPyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+VGFzayBJRDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCB0cnVuY2F0ZSBtYXgtdy1bNjAlXSIgdGl0bGU9Iicrci50YXNrSWQrJyI+JytyLnRhc2tJZCsnPC9zcGFuPjwvZGl2Pic6JycpDQogICAgICArKHIuY3JlZGl0cz8nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNyZWRpdHM8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrci5jcmVkaXRzKyc8L3NwYW4+PC9kaXY+JzonJykNCiAgICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNyZWF0ZWQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrZm10RGF0ZShyLnRzKSsnPC9zcGFuPjwvZGl2PicNCiAgICAgICsoci5uZWc/JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5OZWdhdGl2ZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCB0cnVuY2F0ZSBtYXgtdy1bNjAlXSIgdGl0bGU9Iicrci5uZWcrJyI+JytyLm5lZysnPC9zcGFuPjwvZGl2Pic6JycpDQogICAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TaXplPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK3Iuc2l6ZSsnPC9zcGFuPjwvZGl2PicNCiAgICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNlZWQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrci5zZWVkKyc8L3NwYW4+PC9kaXY+Jw0KICAgICAgKyc8L2Rpdj48L2Rpdj4nOw0KICAgIGQucXVlcnlTZWxlY3RvcignaW1nJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IG9wZW5MaWdodGJveChyKTsgfSk7DQogICAgZC5xdWVyeVNlbGVjdG9yKCcuYmctYmxhY2tcXC80MCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBvcGVuTGlnaHRib3gocik7IH0pOw0KICAgIGQucXVlcnlTZWxlY3RvcignYnV0dG9uJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7DQogICAgICBzdGF0ZS5yZXN1bHRzLnNwbGljZShpLDEpOyBwZXJzaXN0UmVzdWx0cygpOyByZW5kZXJSaWdodCgpOw0KICAgIH0pOw0KICAgIGxpc3QuYXBwZW5kQ2hpbGQoZCk7DQogIH0pOw0KfQ0KDQovKiA9PT09PSBsaWdodGJveCA9PT09PSAqLw0KZnVuY3Rpb24gb3BlbkxpZ2h0Ym94KHIpew0KICAkKCdsYi1pbWcnKS5zcmM9ci5zcmM7DQogIHZhciBoPScnOw0KICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPk1vZGVsPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nKyhyLm1vZGVsfHwnLScpKyc8L3NwYW4+PC9kaXY+JzsNCiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5Qcm9tcHQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrKHIucHJvbXB0fHwnLScpKyc8L3NwYW4+PC9kaXY+JzsNCiAgaWYoci5uZWcpIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+TmVnYXRpdmU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrci5uZWcrJzwvc3Bhbj48L2Rpdj4nOw0KICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNpemU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrKHIuc2l6ZXx8Jy0nKSsnPC9zcGFuPjwvZGl2Pic7DQogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2VlZDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+Jysoci5zZWVkfHwnLScpKyc8L3NwYW4+PC9kaXY+JzsNCiAgaWYoci50YXNrSWQpIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+VGFzayBJRDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+JytyLnRhc2tJZCsnPC9zcGFuPjwvZGl2Pic7DQogIGlmKHIuY3JlZGl0cykgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DcmVkaXRzPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nK3IuY3JlZGl0cysnPC9zcGFuPjwvZGl2Pic7DQogIGgrPSc8ZGl2IGNsYXNzPSJtdC0yIj48YSBocmVmPSInK3Iuc3JjKyciIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIiBjbGFzcz0idGV4dC1bIzZGNURGRl0gaG92ZXI6dW5kZXJsaW5lIHRleHQteHMiPkJ1a2EgZ2FtYmFyIGFzbGkgJm5lYXJyOzwvYT48L2Rpdj4nOw0KICAkKCdsYi1tZXRhJykuaW5uZXJIVE1MPWg7DQogICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LmFkZCgnZmxleCcpOw0KfQ0KJCgnbGItY2xvc2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgnbGlnaHRib3gnKS5jbGFzc0xpc3QucmVtb3ZlKCdmbGV4Jyk7IH0pOw0KJCgnbGlnaHRib3gnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oZSl7IGlmKGUudGFyZ2V0PT09JCgnbGlnaHRib3gnKSl7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LnJlbW92ZSgnZmxleCcpOyB9IH0pOw0KDQovKiA9PT09PSBwYXlsb2FkIChzdHJ1a3R1ciBueWF0YSBUZW5zb3IuQXJ0KSA9PT09PSAqLw0KZnVuY3Rpb24gYnVpbGRQYXlsb2FkKCl7DQogIHZhciBuZWc9JCgnbmVnY2hlY2snKS5jaGVja2VkPyQoJ25lZ3Byb21wdCcpLnZhbHVlOicnOw0KICB2YXIgbT1zdGF0ZS5tb2RlbDsNCiAgcmV0dXJuIHsNCiAgICBwYXJhbXM6ew0KICAgICAgYmFzZU1vZGVsOnsgbW9kZWxJZDptLm1vZGVsSWQsIG1vZGVsRmlsZUlkOm0ubW9kZWxGaWxlSWQgfSwNCiAgICAgIG1vZGVsOnNldHRpbmdzLnByb3ZpZGVyPT09J3RhbXMnPycnOihtJiZtLm1vZGVsP20ubW9kZWw6JycpLA0KICAgICAgc2R4bDp7IHJlZmluZXI6ZmFsc2UgfSwNCiAgICAgIG1vZGVsczpMT1JBLmZpbHRlcihmdW5jdGlvbihsKXtyZXR1cm4gbC53PjB9KS5tYXAoZnVuY3Rpb24obCl7cmV0dXJuIHsgbmFtZTpsLm5hbWUsIHdlaWdodDpsLncsIHRyaWdnZXJXb3JkczpsLnRhZ3MsIGxvcmFNb2RlbDpsLmxvcmFNb2RlbHx8JycsIGxvcmFVcmw6bC5sb3JhVXJsfHwnJyB9IH0pLA0KICAgICAgZW1iZWRkaW5nTW9kZWxzOltdLA0KICAgICAgc2RWYWU6JCgndmFlJykudmFsdWU9PT0nYXV0b21hdGljJz8nQXV0b21hdGljJzokKCd2YWUnKS52YWx1ZSwNCiAgICAgIHByb21wdDokKCdwcm9tcHQnKS52YWx1ZSwNCiAgICAgIG5lZ2F0aXZlUHJvbXB0Om5lZywNCiAgICAgIGhlaWdodDpwYXJzZUludCgkKCdoZWlnaHQnKS52YWx1ZSksDQogICAgICB3aWR0aDpwYXJzZUludCgkKCd3aWR0aCcpLnZhbHVlKSwNCiAgICAgIGltYWdlQ291bnQ6c3RhdGUubmNvbCwNCiAgICAgIHN0ZXBzOnBhcnNlSW50KCQoJ3N0ZXBzJykudmFsdWUpLA0KICAgICAgaW1hZ2VzOmkyaURhdGFVcmw/W2kyaURhdGFVcmxdOltdLA0KICAgICAgZGVub2lzaW5nU3RyZW5ndGg6cGFyc2VGbG9hdCgkKCdpMmktZHMnKS52YWx1ZSl8fDAuNSwNCiAgICAgIGNmZ1NjYWxlOnBhcnNlRmxvYXQoJCgnY2ZnJykudmFsdWUpLA0KICAgICAgc2VlZDooJCgnc2VlZCcpLnZhbHVlfHwnJykudHJpbSgpfHxTdHJpbmcoTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKjk5OTk5OTk5OTkpKSwNCiAgICAgIGNsaXBTa2lwOnBhcnNlSW50KCQoJ2NsaXBza2lwJykudmFsdWUpLA0KICAgICAgZXRhTm9pc2VTZWVkRGVsdGE6cGFyc2VJbnQoJCgnZXRhbnNkJykudmFsdWUpLA0KICAgICAgdjFDbGlwOmZhbHNlLA0KICAgICAgZW5hYmxlUGl4MnBpeDpzdGF0ZS5wYWdlPT09J2ltZycmJiEhaTJpRGF0YVVybCwNCiAgICAgIGd1aWRhbmNlOjMuNSwNCiAgICAgIHVzZUZpcnN0TGFzdEZyYW1lOmZhbHNlLA0KICAgICAga3NhbXBsZXJOYW1lOiQoJ3NhbXBsZXInKS52YWx1ZSwNCiAgICAgIHNjaGVkdWxlOiQoJ3NjaGVkJykudmFsdWUNCiAgICB9LA0KICAgIHByb3ZpZGVyOnNldHRpbmdzLnByb3ZpZGVyfHwndGFtcycsDQogICAgY3JlZGl0czoxLjIyLA0KICAgIHRhc2tUeXBlOnN0YXRlLnBhZ2U9PT0naW1nJyYmaTJpRGF0YVVybD8nSU1HMklNRyc6J1RYVDJJTUcnLA0KICAgIGlzUmVtaXg6ZmFsc2UsDQogICAgY2FwdGNoYVR5cGU6J0NMT1VERkxBUkVfVFVSTlNUSUxFJw0KICB9Ow0KfQ0KLyogPT09PT09PT09PT09IFJFS1RZIEdFTkVSQVRPUiDigJQgdmVyc2kgd2ViIGZ1bGwgPT09PT09PT09PT09DQogKiBHZW5lcmF0ZSBhc2xpIHZpYSBiYWNrZW5kICgvYXBpIC0+IFRlbnNvci5BcnQgTW9kZWwgU2VydmljZSkNCiAqIGF0YXUgbW9kZSBkZW1vIChwaWNzdW0pIGthbGF1IGJhY2tlbmQvQVBJIGtleSBiZWx1bSBha3RpZi4NCiAqID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8NCnZhciBTRVRUSU5HU19LRVk9J3Jla3R5LnNldHRpbmdzJywgUkVTVUxUU19LRVk9J3Jla3R5LnJlc3VsdHMnOw0KdmFyIHNldHRpbmdzPXsgbW9kZTonYXV0bycsIHByb3ZpZGVyOid0YW1zJywgYXBpS2V5OicnLCBwb2xsU2Vzc2lvbjonJyB9Ow0KdmFyIFBST1ZJREVSX0lORk89ew0KICB0YW1zOnsgbGFiZWw6J0FQSSBLZXkgVEFNUyAodGFtcy50ZW5zb3IuYXJ0KScsIGhpbnQ6J0dyYXRpcyBkaSB0YW1zLnRlbnNvci5hcnQg4oCUIHBha2FpIGRhZnRhciBNb2RlbCBkaSBVSS4nIH0sDQogIHJlcGxpY2F0ZTp7IGxhYmVsOidBUEkgVG9rZW4gUmVwbGljYXRlIChyZXBsaWNhdGUuY29tKScsIGhpbnQ6J1BpbGloIG1vZGVsIGRpIGthcnR1IE1vZGVsIChGTFVYLCBTRFhMLCBkc3QpLiBJbWcySW1nIGJlbHVtIGRpZHVrdW5nLicgfSwNCiAgZmFsOnsgbGFiZWw6J0FQSSBLZXkgZmFsLmFpIChmYWwuYWkpJywgaGludDonUGlsaWggbW9kZWwgZGkga2FydHUgTW9kZWwgKEZMVVgsIFNEWEwsIGRzdCkuIEltZzJJbWcgYmVsdW0gZGlkdWt1bmcuJyB9LA0KICBwb2xsaW5hdGlvbnM6eyBsYWJlbDonQVBJIEtleSBQb2xsaW5hdGlvbnMgKG9wc2lvbmFsIOKAlCBza18qKScsIGhpbnQ6J0dyYXRpcyB0YW5wYSBrZXkgKG1vZGVsIG90b21hdGlzKS4gSXNpIGtleSBza18qIGRhcmkgZW50ZXIucG9sbGluYXRpb25zLmFpL2tleXMgdW50dWsgZGFmdGFyIG1vZGVsIGxlbmdrYXAuIEhhc2lsIG90b21hdGlzIGRpYXJzaXAgcGVybWFuZW4uJyB9DQp9Ow0KDQpmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKXsNCiAgdHJ5ew0KICAgIHZhciBzPUpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oU0VUVElOR1NfS0VZKXx8J3t9Jyk7DQogICAgaWYocyYmdHlwZW9mIHM9PT0nb2JqZWN0Jyl7DQogICAgICBzZXR0aW5ncy5tb2RlPXMubW9kZXx8J2F1dG8nOyBzZXR0aW5ncy5wcm92aWRlcj1zLnByb3ZpZGVyfHwndGFtcyc7IHNldHRpbmdzLmFwaUtleT1zLmFwaUtleXx8Jyc7DQogICAgICBzZXR0aW5ncy5wb2xsU2Vzc2lvbj1zLnBvbGxTZXNzaW9ufHwnJzsNCiAgICB9DQogIH1jYXRjaChlKXt9DQp9DQpmdW5jdGlvbiBzYXZlU2V0dGluZ3MoKXsgdHJ5eyBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShTRVRUSU5HU19LRVksSlNPTi5zdHJpbmdpZnkoc2V0dGluZ3MpKTsgfWNhdGNoKGUpe30gfQ0KZnVuY3Rpb24gYXBwbHlTZXR0aW5nc1VJKCl7DQogICQoJ2FwaW1vZGUnKS52YWx1ZT1zZXR0aW5ncy5tb2RlOyAkKCdhcGlrZXknKS52YWx1ZT1zZXR0aW5ncy5hcGlLZXk7DQogIHVwZGF0ZVByb3ZpZGVyVUkoKTsNCn0NCmZ1bmN0aW9uIHVwZGF0ZVByb3ZpZGVyVUkoKXsNCiAgdmFyIGluZm89UFJPVklERVJfSU5GT1tzZXR0aW5ncy5wcm92aWRlcl18fFBST1ZJREVSX0lORk8udGFtczsNCiAgJCgnYXBpcHJvdmlkZXInKS52YWx1ZT1zZXR0aW5ncy5wcm92aWRlcjsNCiAgJCgnYXBpa2V5LWxhYmVsJykudGV4dENvbnRlbnQ9aW5mby5sYWJlbDsNCiAgJCgnYXBpLWhpbnQnKS50ZXh0Q29udGVudD1pbmZvLmhpbnQ7DQogIHZhciBpc1BvbGw9c2V0dGluZ3MucHJvdmlkZXI9PT0ncG9sbGluYXRpb25zJzsNCiAgJCgnYXBpa2V5LWZpZWxkJykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJyxpc1BvbGwpOw0KICAkKCdieW9wLXJvdycpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicsIWlzUG9sbCk7DQogIGlmKGlzUG9sbCkgcmVmcmVzaE9BdXRoU3RhdHVzKCk7DQogIHVwZGF0ZUFwaVN0YXR1cygpOw0KICAvLyBHYW50aSBkYWZ0YXIgbW9kZWwgc2VzdWFpIHByb3ZpZGVyIGFrdGlmLg0KICB2YXIgbGliPU1PREVMX0xJQlNbc2V0dGluZ3MucHJvdmlkZXJdfHxNT0RFTF9MSUJTLnRhbXM7DQogIGlmKE1PREVMUyE9PWxpYil7DQogICAgTU9ERUxTPWxpYjsNCiAgICBpZihNT0RFTFMubGVuZ3RoKSBzZXRNb2RlbChNT0RFTFNbMF0pOw0KICB9DQogIC8vIEdhbnRpIGRhZnRhciBMb1JBIHNlc3VhaSBwcm92aWRlciAoTG9SQSBsYW1hIGRpYmVyc2loa2FuKS4NCiAgTE9SQV9MSUI9TE9SQV9MSUJTW3NldHRpbmdzLnByb3ZpZGVyXXx8TE9SQV9MSUJTLnRhbXM7DQogIExPUkEubGVuZ3RoPTA7DQogIHJlbmRlckxvcmEoKTsNCiAgLy8gUG9sbGluYXRpb25zOiBhbWJpbCBkYWZ0YXIgbW9kZWwgYXNsaSBkYXJpIEFQSSAoZmFsbGJhY2sga2UgZGFmdGFyIHN0YXRpcykuDQogIGlmKHNldHRpbmdzLnByb3ZpZGVyPT09J3BvbGxpbmF0aW9ucycpIHJlZnJlc2hQb2xsaW5hdGlvbnNNb2RlbHMoKTsNCn0NCmZ1bmN0aW9uIHJlZnJlc2hQb2xsaW5hdGlvbnNNb2RlbHMoKXsNCiAgZmV0Y2goJy9hcGkvcG9sbGluYXRpb25zLW1vZGVscycpLnRoZW4oZnVuY3Rpb24ocil7IHJldHVybiByLmpzb24oKTsgfSkudGhlbihmdW5jdGlvbihkKXsNCiAgICBpZighZHx8IUFycmF5LmlzQXJyYXkoZC5tb2RlbHMpfHwhZC5tb2RlbHMubGVuZ3RoKSByZXR1cm47DQogICAgdmFyIGxpYj1kLm1vZGVscw0KICAgICAgLmZpbHRlcihmdW5jdGlvbihtKXsgcmV0dXJuIG0uY2F0ZWdvcnk9PT0naW1hZ2UnJiZtLm5hbWUmJm0ubmFtZS5pbmRleE9mKCdieW9wLycpIT09MDsgfSkNCiAgICAgIC5zbGljZSgwLDgwKQ0KICAgICAgLm1hcChmdW5jdGlvbihtKXsgcmV0dXJuIHsgbmFtZTptLnRpdGxlfHxtLm5hbWUsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6bS5icmFuZHx8JycsIHRodW1iOlN0cmluZyhtLm5hbWUpLnJlcGxhY2UoL1teYS16MC05XS9naSwnJyksIGJhZGdlOm0ucGFpZF9vbmx5PydQQUlEJzonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6bS5uYW1lIH07IH0pDQogICAgICAuc29ydChmdW5jdGlvbihhLGIpeyByZXR1cm4gKGEuYmFkZ2U9PT0nUEFJRCc/MTowKS0oYi5iYWRnZT09PSdQQUlEJz8xOjApOyB9KTsNCiAgICBpZighbGliLmxlbmd0aCkgcmV0dXJuOw0KICAgIE1PREVMX0xJQlMucG9sbGluYXRpb25zPWxpYjsNCiAgICBpZihNT0RFTFM9PT1NT0RFTF9MSUJTLnBvbGxpbmF0aW9ucyl7IHNldE1vZGVsKE1PREVMU1swXSk7IH0NCiAgfSkuY2F0Y2goZnVuY3Rpb24oKXt9KTsNCn0NCmZ1bmN0aW9uIHVwZGF0ZUFwaVN0YXR1cygpew0KICB2YXIgZWw9JCgnYXBpLXN0YXR1cycpOyBpZighZWwpIHJldHVybjsNCiAgaWYoc2V0dGluZ3MucHJvdmlkZXI9PT0ncG9sbGluYXRpb25zJyl7DQogICAgZWwudGV4dENvbnRlbnQ9c2V0dGluZ3MucG9sbFNlc3Npb24/J1BvbGxpbmF0aW9ucyDCtyBCWU9QJzonUG9sbGluYXRpb25zIMK3IGdyYXRpcyc7DQogICAgZWwuc3R5bGUuY29sb3I9c2V0dGluZ3MucG9sbFNlc3Npb24/JyMyN0Q0Q0QnOicjOWE5YWEyJzsNCiAgICByZXR1cm47DQogIH0NCiAgdmFyIG5hbWU9c2V0dGluZ3MucHJvdmlkZXI9PT0ndGFtcyc/J1RBTVMnOihzZXR0aW5ncy5wcm92aWRlcj09PSdyZXBsaWNhdGUnPydSZXBsaWNhdGUnOidmYWwuYWknKTsNCiAgZWwudGV4dENvbnRlbnQ9bmFtZSsoc2V0dGluZ3MuYXBpS2V5Pycgwrcga2V5JzonIMK3IHRhbnBhIGtleScpOw0KICBlbC5zdHlsZS5jb2xvcj1zZXR0aW5ncy5hcGlLZXk/JyMyN0Q0Q0QnOicjOWE5YWEyJzsNCn0NCiQoJ2FwaXByb3ZpZGVyJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbigpew0KICBzZXR0aW5ncy5wcm92aWRlcj0kKCdhcGlwcm92aWRlcicpLnZhbHVlOyBzYXZlU2V0dGluZ3MoKTsgdXBkYXRlUHJvdmlkZXJVSSgpOw0KfSk7DQokKCdhcGktc2F2ZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpew0KICBzZXR0aW5ncy5tb2RlPSQoJ2FwaW1vZGUnKS52YWx1ZTsgc2V0dGluZ3MuYXBpS2V5PSQoJ2FwaWtleScpLnZhbHVlLnRyaW0oKTsNCiAgc2F2ZVNldHRpbmdzKCk7IHVwZGF0ZVByb3ZpZGVyVUkoKTsgdG9hc3QoJ1BlbmdhdHVyYW4gQVBJIGRpc2ltcGFuJyk7DQp9KTsNCiQoJ2FwaS10ZXN0JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGFzeW5jIGZ1bmN0aW9uKCl7DQogIHZhciBiPSQoJ2FwaS10ZXN0Jyk7IGIuZGlzYWJsZWQ9dHJ1ZTsgYi50ZXh0Q29udGVudD0nVGVzLi4uJzsNCiAgaWYoc2V0dGluZ3MucHJvdmlkZXI9PT0ncG9sbGluYXRpb25zJyl7DQogICAgdHJ5ew0KICAgICAgdmFyIHI9YXdhaXQgZmV0Y2goJy9hcGkvaGVhbHRoJyk7DQogICAgICB2YXIgZD1hd2FpdCByLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsO30pOw0KICAgICAgaWYoIXIub2spIHRocm93IG5ldyBFcnJvcignSFRUUCAnK3Iuc3RhdHVzKTsNCiAgICAgIHRvYXN0KCdCYWNrZW5kIE9LIMK3IEJZT1AgJysoZCYmZC5ieW9wPydzaWFwIChBcHAgS2V5IHRlcnBhc2FuZyknOidiZWx1bSBkaWtvbmZpZ3VyYXNpIChBcHAgS2V5KScpKycgwrcgJysoc2V0dGluZ3MucG9sbFNlc3Npb24/J3Nlc2kgYWt0aWYnOidiZWx1bSBsb2dpbicpKTsNCiAgICAgIHJlZnJlc2hPQXV0aFN0YXR1cygpOw0KICAgIH1jYXRjaChlKXsgdG9hc3QoJ0JhY2tlbmQgdGlkYWsgYWt0aWYg4oCUIGRlcGxveSBkZW5nYW4gRnVuY3Rpb25zIGF0YXUgcGFrYWkgbW9kZSBkZW1vJyk7IH0NCiAgICBiLmRpc2FibGVkPWZhbHNlOyBiLnRleHRDb250ZW50PSdUZXMnOw0KICAgIHJldHVybjsNCiAgfQ0KICB0cnl7DQogICAgdmFyIHI9YXdhaXQgZmV0Y2goJy9hcGkvaGVhbHRoJyx7aGVhZGVyczp7J3gtYXBpLWtleSc6JCgnYXBpa2V5JykudmFsdWUudHJpbSgpfHxzZXR0aW5ncy5hcGlLZXl9fSk7DQogICAgdmFyIGQ9YXdhaXQgci5qc29uKCkuY2F0Y2goZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH0pOw0KICAgIGlmKCFyLm9rKSB0aHJvdyBuZXcgRXJyb3IoJ0hUVFAgJytyLnN0YXR1cyk7DQogICAgdmFyIHBhcnRzPVtdOw0KICAgIGlmKGQmJmQuaGFzS2V5cyl7IFsndGFtcycsJ3JlcGxpY2F0ZScsJ2ZhbCddLmZvckVhY2goZnVuY3Rpb24ocCl7IGlmKGQuaGFzS2V5c1twXSkgcGFydHMucHVzaChwKTsgfSk7IH0NCiAgICB0b2FzdCgnQmFja2VuZCBPSy4gS2V5IGRpIGVudjogJysocGFydHMubGVuZ3RoP3BhcnRzLmpvaW4oJywgJyk6J3RpZGFrIGFkYScpKycuIEtleSBkaSBicm93c2VyOiAnKyhzZXR0aW5ncy5hcGlLZXk/J2FkYSc6J3RpZGFrJykpOw0KICB9Y2F0Y2goZSl7IHRvYXN0KCdCYWNrZW5kIHRpZGFrIGFrdGlmIOKAlCBkZXBsb3kgZGVuZ2FuIEZ1bmN0aW9ucyBhdGF1IHBha2FpIG1vZGUgZGVtbycpOyB9DQogIGIuZGlzYWJsZWQ9ZmFsc2U7IGIudGV4dENvbnRlbnQ9J1Rlcyc7DQp9KTsNCg0KLyogLS0tIEJZT1AgT0F1dGggKEJyaW5nIFlvdXIgT3duIFBvbGxlbikgLS0tDQogKiBMb2dpbiB2aWEgZW50ZXIucG9sbGluYXRpb25zLmFpIChQS0NFIGNvZGUgZmxvdykg4oaSIGJhY2tlbmQgdHVrYXIga29kZSDihpINCiAqIHRva2VuIHNrXyBzY29wZWQgdXNlciBkaXNpbXBhbiBkaSBLViBiYWNrZW5kOyBicm93c2VyIGN1bWEgcGVnYW5nIHNlc3Npb24uDQogKi8NCnZhciBfb2F1dGhWZXJpZmllcktleT0ncmVrdHkub2F1dGgudmVyaWZpZXInLCBfb2F1dGhTdGF0ZUtleT0ncmVrdHkub2F1dGguc3RhdGUnOw0KZnVuY3Rpb24gX2I2NHVybChidWYpew0KICB2YXIgcz1idG9hKFN0cmluZy5mcm9tQ2hhckNvZGUuYXBwbHkobnVsbCxuZXcgVWludDhBcnJheShidWYpKSk7DQogIHJldHVybiBzLnJlcGxhY2UoL1wrL2csJy0nKS5yZXBsYWNlKC9cLy9nLCdfJykucmVwbGFjZSgvPSskLywnJyk7DQp9DQpmdW5jdGlvbiBfcmFuZEI2NChsZW4peyB2YXIgYT1uZXcgVWludDhBcnJheShsZW4pOyBjcnlwdG8uZ2V0UmFuZG9tVmFsdWVzKGEpOyByZXR1cm4gX2I2NHVybChhKTsgfQ0KYXN5bmMgZnVuY3Rpb24gX3NoYTI1NkI2NHVybCh0ZXh0KXsNCiAgdmFyIGJ1Zj1hd2FpdCBjcnlwdG8uc3VidGxlLmRpZ2VzdCgnU0hBLTI1NicsbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHRleHQpKTsNCiAgcmV0dXJuIF9iNjR1cmwoYnVmKTsNCn0NCmZ1bmN0aW9uIHN0YXJ0UG9sbE9BdXRoKCl7DQogIHZhciB2ZXJpZmllcj1fcmFuZEI2NCg0OCk7DQogIGxvY2FsU3RvcmFnZS5zZXRJdGVtKF9vYXV0aFZlcmlmaWVyS2V5LHZlcmlmaWVyKTsNCiAgdmFyIHN0YXRlPV9yYW5kQjY0KDE2KTsNCiAgbG9jYWxTdG9yYWdlLnNldEl0ZW0oX29hdXRoU3RhdGVLZXksc3RhdGUpOw0KICBmZXRjaCgnL2FwaS9vYXV0aC9jb25maWcnKS50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiByLmpzb24oKTt9KS50aGVuKGFzeW5jIGZ1bmN0aW9uKGNmZyl7DQogICAgaWYoIWNmZ3x8IWNmZy5jbGllbnRJZCkgdGhyb3cgbmV3IEVycm9yKCdiYWNrZW5kIGJlbHVtIHB1bnlhIEFwcCBLZXkgUG9sbGluYXRpb25zJyk7DQogICAgdmFyIGNoYWxsZW5nZT1hd2FpdCBfc2hhMjU2QjY0dXJsKHZlcmlmaWVyKTsNCiAgICB2YXIgcD1uZXcgVVJMU2VhcmNoUGFyYW1zKHsNCiAgICAgIHJlc3BvbnNlX3R5cGU6J2NvZGUnLCBjbGllbnRfaWQ6Y2ZnLmNsaWVudElkLCByZWRpcmVjdF91cmk6Y2ZnLnJlZGlyZWN0VXJpLA0KICAgICAgc2NvcGU6J3VzYWdlJywgc3RhdGU6c3RhdGUsDQogICAgICBjb2RlX2NoYWxsZW5nZTpjaGFsbGVuZ2UsIGNvZGVfY2hhbGxlbmdlX21ldGhvZDonUzI1NicNCiAgICB9KTsNCiAgICB3aW5kb3cubG9jYXRpb24uaHJlZj1jZmcuYXV0aG9yaXplQmFzZSsnPycrcC50b1N0cmluZygpOw0KICB9KS5jYXRjaChmdW5jdGlvbihlKXsgdG9hc3QoJ0dhZ2FsIG11bGFpIGxvZ2luOiAnKyhlJiZlLm1lc3NhZ2V8fGUpKTsgfSk7DQp9DQpmdW5jdGlvbiByZWZyZXNoT0F1dGhTdGF0dXMoKXsNCiAgdmFyIGVsPSQoJ2J5b3Atc3RhdHVzJyksIGJ0bj0kKCdieW9wLWxvZ2luJyksIG91dD0kKCdieW9wLWxvZ291dCcpOw0KICBpZighc2V0dGluZ3MucG9sbFNlc3Npb24peyBpZihlbCllbC5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgaWYob3V0KW91dC5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgcmV0dXJuOyB9DQogIGZldGNoKCcvYXBpL29hdXRoL3N0YXR1cz9zZXNzaW9uPScrZW5jb2RlVVJJQ29tcG9uZW50KHNldHRpbmdzLnBvbGxTZXNzaW9uKSkudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gci5qc29uKCk7fSkudGhlbihmdW5jdGlvbihkKXsNCiAgICBpZihkJiZkLmNvbm5lY3RlZCl7DQogICAgICB2YXIgYmFsVHh0PScnOw0KICAgICAgaWYoZC5iYWxhbmNlJiZ0eXBlb2YgZC5iYWxhbmNlPT09J29iamVjdCcpew0KICAgICAgICB2YXIgYnY9ZC5iYWxhbmNlLnBvbGxlbkJhbGFuY2UhPW51bGw/ZC5iYWxhbmNlLnBvbGxlbkJhbGFuY2U6KGQuYmFsYW5jZS5iYWxhbmNlIT1udWxsP2QuYmFsYW5jZS5iYWxhbmNlOm51bGwpOw0KICAgICAgICBpZihidiE9bnVsbCkgYmFsVHh0PScgwrcgc2FsZG8gJytidisnIHBvbGxlbic7DQogICAgICB9DQogICAgICBlbC50ZXh0Q29udGVudD0nVGVyaHVidW5nIOKckycrKGQuZXhwaXJlc0luPygnIMK3IHNpc2EgJytNYXRoLmNlaWwoZC5leHBpcmVzSW4vODY0MDApKycgaGFyaScpOicnKStiYWxUeHQ7DQogICAgICBlbC5zdHlsZS5jb2xvcj0nIzI3RDRDRCc7IGVsLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOw0KICAgICAgYnRuLnRleHRDb250ZW50PSdMb2dpbiB1bGFuZyAoZ2FudGkgYWt1biknOyBvdXQuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7DQogICAgfWVsc2V7DQogICAgICBlbC50ZXh0Q29udGVudD0nU2VzaSBiZXJha2hpciDigJQgbG9naW4gdWxhbmcnOyBlbC5zdHlsZS5jb2xvcj0nI2U1YTUwYSc7DQogICAgICBlbC5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgb3V0LmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOw0KICAgICAgc2V0dGluZ3MucG9sbFNlc3Npb249Jyc7IHNhdmVTZXR0aW5ncygpOyB1cGRhdGVBcGlTdGF0dXMoKTsNCiAgICB9DQogIH0pLmNhdGNoKGZ1bmN0aW9uKCl7fSk7DQp9DQpmdW5jdGlvbiBwb2xsTG9nb3V0KCl7DQogIGZldGNoKCcvYXBpL29hdXRoL2xvZ291dCcse21ldGhvZDonUE9TVCcsaGVhZGVyczp7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nfSxib2R5OkpTT04uc3RyaW5naWZ5KHtzZXNzaW9uOnNldHRpbmdzLnBvbGxTZXNzaW9ufSl9KS5jYXRjaChmdW5jdGlvbigpe30pOw0KICBzZXR0aW5ncy5wb2xsU2Vzc2lvbj0nJzsgc2F2ZVNldHRpbmdzKCk7IHVwZGF0ZUFwaVN0YXR1cygpOyByZWZyZXNoT0F1dGhTdGF0dXMoKTsNCiAgdG9hc3QoJ1Nlc2kgUG9sbGluYXRpb25zIGRpY2FidXQnKTsNCn0NCmFzeW5jIGZ1bmN0aW9uIGhhbmRsZU9BdXRoQ2FsbGJhY2soKXsNCiAgaWYobG9jYXRpb24ucGF0aG5hbWUhPT0nL2NhbGxiYWNrJykgcmV0dXJuOw0KICB2YXIgcT1uZXcgVVJMU2VhcmNoUGFyYW1zKGxvY2F0aW9uLnNlYXJjaCk7DQogIHZhciBoPW5ldyBVUkxTZWFyY2hQYXJhbXMobG9jYXRpb24uaGFzaC5zbGljZSgxKSk7DQogIHZhciBlcnI9cS5nZXQoJ2Vycm9yJyl8fGguZ2V0KCdlcnJvcicpOw0KICBpZihlcnIpeyB0b2FzdCgnTG9naW4gZGliYXRhbGthbjogJytlcnIpOyBoaXN0b3J5LnJlcGxhY2VTdGF0ZShudWxsLCcnLCcvJyk7IHJldHVybjsgfQ0KICB2YXIgY29kZT1xLmdldCgnY29kZScpOw0KICB2YXIgc3RhdGU9cS5nZXQoJ3N0YXRlJyk7DQogIHZhciBzYXZlZFN0YXRlPWxvY2FsU3RvcmFnZS5nZXRJdGVtKF9vYXV0aFN0YXRlS2V5KTsNCiAgdmFyIHZlcmlmaWVyPWxvY2FsU3RvcmFnZS5nZXRJdGVtKF9vYXV0aFZlcmlmaWVyS2V5KTsNCiAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oX29hdXRoU3RhdGVLZXkpOyBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShfb2F1dGhWZXJpZmllcktleSk7DQogIGlmKCFjb2RlfHwhc3RhdGV8fHN0YXRlIT09c2F2ZWRTdGF0ZXx8IXZlcmlmaWVyKXsNCiAgICB0b2FzdCgnQ2FsbGJhY2sgT0F1dGggdGlkYWsgdmFsaWQnKTsgaGlzdG9yeS5yZXBsYWNlU3RhdGUobnVsbCwnJywnLycpOyByZXR1cm47DQogIH0NCiAgdmFyIGNmZz1hd2FpdCBmZXRjaCgnL2FwaS9vYXV0aC9jb25maWcnKS50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiByLmpzb24oKTt9KS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsO30pOw0KICB0cnl7DQogICAgdmFyIHI9YXdhaXQgZmV0Y2goJy9hcGkvb2F1dGgvdG9rZW4nLHttZXRob2Q6J1BPU1QnLGhlYWRlcnM6eydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJ30sDQogICAgICBib2R5OkpTT04uc3RyaW5naWZ5KHtjb2RlOmNvZGUsY29kZV92ZXJpZmllcjp2ZXJpZmllcixyZWRpcmVjdF91cmk6KGNmZyYmY2ZnLnJlZGlyZWN0VXJpKXx8Jyd9KX0pOw0KICAgIHZhciBkPWF3YWl0IHIuanNvbigpLmNhdGNoKGZ1bmN0aW9uKCl7cmV0dXJuIG51bGw7fSk7DQogICAgaWYoIXIub2t8fCFkLnNlc3Npb24pIHRocm93IG5ldyBFcnJvcigoZCYmZC5lcnJvcil8fCgnSFRUUCAnK3Iuc3RhdHVzKSk7DQogICAgc2V0dGluZ3MucG9sbFNlc3Npb249ZC5zZXNzaW9uOyBzYXZlU2V0dGluZ3MoKTsgdXBkYXRlUHJvdmlkZXJVSSgpOw0KICAgIHRvYXN0KCdMb2dpbiBQb2xsaW5hdGlvbnMgYmVyaGFzaWwhJyk7DQogIH1jYXRjaChlKXsgdG9hc3QoJ0dhZ2FsIHR1a2FyIGtvZGU6ICcrKGUmJmUubWVzc2FnZXx8ZSkpOyB9DQogIGhpc3RvcnkucmVwbGFjZVN0YXRlKG51bGwsJycsJy8nKTsNCn0NCiQoJ2J5b3AtbG9naW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsc3RhcnRQb2xsT0F1dGgpOw0KJCgnYnlvcC1sb2dvdXQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycscG9sbExvZ291dCk7DQoNCi8qIC0tLSB0b2FzdCAtLS0gKi8NCnZhciBfdG9hc3RUaW1lcj1udWxsOw0KZnVuY3Rpb24gdG9hc3QobXNnKXsNCiAgdmFyIHQ9JCgndG9hc3QnKTsgaWYoIXQpIHJldHVybjsNCiAgdC50ZXh0Q29udGVudD1tc2c7IHQuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7DQogIGNsZWFyVGltZW91dChfdG9hc3RUaW1lcik7DQogIF90b2FzdFRpbWVyPXNldFRpbWVvdXQoZnVuY3Rpb24oKXsgdC5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgfSwzNTAwKTsNCn0NCg0KLyogLS0tIHByb2dyZXNzIG92ZXJsYXkgLS0tICovDQp2YXIgX3BvbGxTdG9wPWZhbHNlOw0KZnVuY3Rpb24gc2hvd1Byb2dyZXNzKHRpdGxlLHN0YXR1cyxwY3Qpew0KICAkKCdwcm9nLXRpdGxlJykudGV4dENvbnRlbnQ9dGl0bGU7DQogICQoJ3Byb2ctc3RhdHVzJykudGV4dENvbnRlbnQ9c3RhdHVzfHwnJzsNCiAgJCgncHJvZy1iYXInKS5zdHlsZS53aWR0aD1NYXRoLm1heCgwLE1hdGgubWluKDEwMCxwY3R8fDApKSsnJSc7DQogICQoJ3Byb2ctcGN0JykudGV4dENvbnRlbnQ9TWF0aC5yb3VuZChwY3R8fDApKyclJzsNCiAgJCgncHJvZ292ZXJsYXknKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgJCgncHJvZ292ZXJsYXknKS5jbGFzc0xpc3QuYWRkKCdmbGV4Jyk7DQp9DQpmdW5jdGlvbiBoaWRlUHJvZ3Jlc3MoKXsgJCgncHJvZ292ZXJsYXknKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgncHJvZ292ZXJsYXknKS5jbGFzc0xpc3QucmVtb3ZlKCdmbGV4Jyk7IH0NCiQoJ3Byb2ctY2FuY2VsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IF9wb2xsU3RvcD10cnVlOyB0b2FzdCgnTWVtYmF0YWxrYW4uLi4nKTsgfSk7DQoNCi8qIC0tLSBBUEkgY2xpZW50IC0tLSAqLw0KZnVuY3Rpb24gYnVpbGRBcGlLZXkoKXsgcmV0dXJuIHNldHRpbmdzLmFwaUtleXx8JCgnYXBpa2V5JykudmFsdWUudHJpbSgpOyB9DQoNCmZ1bmN0aW9uIF9hcGlIZWFkZXJzKGV4dHJhKXsNCiAgdmFyIGg9eyd4LWFwaS1rZXknOmJ1aWxkQXBpS2V5KCl9Ow0KICBpZihzZXR0aW5ncy5wcm92aWRlcj09PSdwb2xsaW5hdGlvbnMnJiZzZXR0aW5ncy5wb2xsU2Vzc2lvbikgaFsneC1zZXNzaW9uJ109c2V0dGluZ3MucG9sbFNlc3Npb247DQogIGlmKGV4dHJhKSBmb3IodmFyIGsgaW4gZXh0cmEpIGhba109ZXh0cmFba107DQogIHJldHVybiBoOw0KfQ0KYXN5bmMgZnVuY3Rpb24gYXBpR2VuZXJhdGUocGF5bG9hZCl7DQogIHZhciByZXM9YXdhaXQgZmV0Y2goJy9hcGkvZ2VuZXJhdGUnLHttZXRob2Q6J1BPU1QnLGhlYWRlcnM6X2FwaUhlYWRlcnMoeydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJ30pLGJvZHk6SlNPTi5zdHJpbmdpZnkocGF5bG9hZCl9KTsNCiAgdmFyIGQ9YXdhaXQgcmVzLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsfSk7DQogIGlmKCFyZXMub2spIHRocm93IG5ldyBFcnJvcigoZCYmZC5lcnJvcil8fCgnSFRUUCAnK3Jlcy5zdGF0dXMpKTsNCiAgcmV0dXJuIGR8fHt9Ow0KfQ0KYXN5bmMgZnVuY3Rpb24gYXBpVGFzayh0YXNrSWQpew0KICB2YXIgcmVzPWF3YWl0IGZldGNoKCcvYXBpL3Rhc2s/aWQ9JytlbmNvZGVVUklDb21wb25lbnQodGFza0lkKSx7aGVhZGVyczpfYXBpSGVhZGVycyh7fSl9KTsNCiAgdmFyIGQ9YXdhaXQgcmVzLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsfSk7DQogIGlmKCFyZXMub2spIHRocm93IG5ldyBFcnJvcigoZCYmZC5lcnJvcil8fCgnSFRUUCAnK3Jlcy5zdGF0dXMpKTsNCiAgcmV0dXJuIGR8fHt9Ow0KfQ0KDQphc3luYyBmdW5jdGlvbiBwb2xsVGFzayh0YXNrSWQsb25Qcm9nKXsNCiAgdmFyIHN0YXJ0PURhdGUubm93KCksIG1heE1zPTYqNjAqMTAwMDsNCiAgd2hpbGUoRGF0ZS5ub3coKS1zdGFydDxtYXhNcyl7DQogICAgaWYoX3BvbGxTdG9wKSB0aHJvdyBuZXcgRXJyb3IoJ2RpYmF0YWxrYW4gcGVuZ2d1bmEnKTsNCiAgICB2YXIgZD1hd2FpdCBhcGlUYXNrKHRhc2tJZCk7DQogICAgaWYoZC5zdGF0dXM9PT0nU1VDQ0VTUycpIHJldHVybiBkLmltYWdlc3x8W107DQogICAgaWYoZC5zdGF0dXM9PT0nRkFJTEVEJykgdGhyb3cgbmV3IEVycm9yKGQuZXJyb3J8fCdUYXNrIGdhZ2FsJyk7DQogICAgaWYoZC5zdGF0dXM9PT0nQ0FOQ0VMRUQnKSB0aHJvdyBuZXcgRXJyb3IoJ1Rhc2sgZGliYXRhbGthbicpOw0KICAgIHZhciBzdD0oZC5zdGF0dXM9PT0nV0FJVElORycpPygnQW50cmUgJysoZC5xdWV1ZXx8JycpKTooZC5zdGF0dXM9PT0nUlVOTklORyc/J0dlbmVyYXRpbmcuLi4nOidNZW51bmdndS4uLicpOw0KICAgIG9uUHJvZyhzdCxkLnByb2dyZXNzfHwwKTsNCiAgICBhd2FpdCBuZXcgUHJvbWlzZShmdW5jdGlvbihyKXsgc2V0VGltZW91dChyLCBkLnN0YXR1cz09PSdXQUlUSU5HJz80MDAwOjIwMDApOyB9KTsNCiAgfQ0KICB0aHJvdyBuZXcgRXJyb3IoJ1RpbWVvdXQgbWVudW5nZ3UgaGFzaWwgZ2VuZXJhdGUnKTsNCn0NCg0KLyogLS0tIGhhc2lsIC0tLSAqLw0KZnVuY3Rpb24gbWtSZXN1bHQoc3JjLHBhcix0YXNrSWQsY3JlZGl0cyl7DQogIHJldHVybiB7DQogICAgc3JjOnNyYywgcHJvbXB0OnBhci5wYXJhbXMucHJvbXB0LCBuZWc6cGFyLnBhcmFtcy5uZWdhdGl2ZVByb21wdCwNCiAgICBtb2RlbDpzdGF0ZS5tb2RlbD9zdGF0ZS5tb2RlbC5uYW1lOicnLA0KICAgIHNpemU6cGFyLnBhcmFtcy53aWR0aCsneCcrcGFyLnBhcmFtcy5oZWlnaHQsIHNlZWQ6cGFyLnBhcmFtcy5zZWVkLA0KICAgIHRhc2tJZDp0YXNrSWR8fCcnLCBjcmVkaXRzOmNyZWRpdHMhPW51bGw/Y3JlZGl0czonJywNCiAgICB0czpEYXRlLm5vdygpLCBkZW1vOmZhbHNlLCBwYWdlOnN0YXRlLnBhZ2UNCiAgfTsNCn0NCmZ1bmN0aW9uIGRlbW9SZXN1bHRzKHBhcil7DQogIHNob3dQcm9ncmVzcygnTW9kZSBkZW1vJywnTWVueWlhcGthbiBnYW1iYXIgc2ltdWxhc2kuLi4nLDE1KTsNCiAgc2V0VGltZW91dChmdW5jdGlvbigpew0KICAgIGZvcih2YXIgaT0wO2k8c3RhdGUubmNvbDtpKyspew0KICAgICAgdmFyIHNyYz1TK01hdGguZmxvb3IoTWF0aC5yYW5kb20oKSoxZTkpKycvNTEyJzsNCiAgICAgIGFkZFJlc3VsdCh7c3JjOnNyYywgcHJvbXB0OnBhci5wYXJhbXMucHJvbXB0LCBuZWc6cGFyLnBhcmFtcy5uZWdhdGl2ZVByb21wdCwNCiAgICAgICAgbW9kZWw6c3RhdGUubW9kZWw/c3RhdGUubW9kZWwubmFtZTonJywgc2l6ZTpwYXIucGFyYW1zLndpZHRoKyd4JytwYXIucGFyYW1zLmhlaWdodCwNCiAgICAgICAgc2VlZDpwYXIucGFyYW1zLnNlZWQsIHRhc2tJZDonJywgY3JlZGl0czonJywgdHM6RGF0ZS5ub3coKSwgZGVtbzp0cnVlLCBwYWdlOnN0YXRlLnBhZ2V9KTsNCiAgICB9DQogICAgaGlkZVByb2dyZXNzKCk7DQogIH0sNzAwKTsNCn0NCg0KYXN5bmMgZnVuY3Rpb24gZG9HZW5lcmF0ZSgpew0KICBpZihzdGF0ZS5idXN5KSByZXR1cm47DQogIHZhciBwPSQoJ3Byb21wdCcpLnZhbHVlLnRyaW0oKTsNCiAgaWYoIXApeyBvcGVuTGVmdCgpOyAkKCdwcm9tcHQnKS5mb2N1cygpOyB0b2FzdCgnSXNpIHByb21wdCBkdWx1Jyk7IHJldHVybjsgfQ0KICB2YXIgcGFyPWJ1aWxkUGF5bG9hZCgpOw0KICBzdGF0ZS5idXN5PXRydWU7IHNldEJ1c3kodHJ1ZSk7IF9wb2xsU3RvcD1mYWxzZTsNCiAgdHJ5ew0KICAgIGlmKHNldHRpbmdzLm1vZGU9PT0nZGVtbyd8fCghYnVpbGRBcGlLZXkoKSYmc2V0dGluZ3MucHJvdmlkZXIhPT0ncG9sbGluYXRpb25zJykpew0KICAgICAgYXdhaXQgbmV3IFByb21pc2UoZnVuY3Rpb24ocil7IHNldFRpbWVvdXQociwzMDApOyB9KTsNCiAgICAgIGRlbW9SZXN1bHRzKHBhcik7DQogICAgICBpZighYnVpbGRBcGlLZXkoKSkgdG9hc3QoJ0JlbHVtIGFkYSBBUEkga2V5IOKAlCBoYXNpbCBzaW11bGFzaS4gSXNpIEFQSSBLZXkgVEFNUyBkaSBwYW5lbCBraXJpIHVudHVrIGdlbmVyYXRlIGFzbGkuJyk7DQogICAgICBlbHNlIHRvYXN0KCdNb2RlIGRlbW8gYWt0aWYg4oCUIGhhc2lsIHNpbXVsYXNpLicpOw0KICAgIH1lbHNlew0KICAgICAgc2hvd1Byb2dyZXNzKCdNZW5naXJpbSBrZSBUQU1TLi4uJywnTWVueWlhcGthbiB0YXNrLi4uJyw1KTsNCiAgICAgIHZhciByPWF3YWl0IGFwaUdlbmVyYXRlKHBhcik7DQogICAgICB2YXIgdGFza0lkPXIudGFza0lkfHxyLmpvYklkOw0KICAgICAgaWYodGFza0lkKXsNCiAgICAgICAgdmFyIGltZ3M9YXdhaXQgcG9sbFRhc2sodGFza0lkLGZ1bmN0aW9uKHN0LHBjdCl7IHNob3dQcm9ncmVzcygnR2VuZXJhdGluZy4uLicsc3QscGN0KTsgfSk7DQogICAgICAgIGltZ3MuZm9yRWFjaChmdW5jdGlvbihzcmMpeyBhZGRSZXN1bHQobWtSZXN1bHQoc3JjLHBhcix0YXNrSWQsci5jcmVkaXRzKSk7IH0pOw0KICAgICAgfWVsc2V7DQogICAgICAgIHZhciBpbWdzMj1leHRyYWN0SW1hZ2VzKHIpOw0KICAgICAgICBpZighaW1nczIubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ1Jlc3BvbnNlIHRhbnBhIGdhbWJhcicpOw0KICAgICAgICBpbWdzMi5mb3JFYWNoKGZ1bmN0aW9uKHNyYyl7IGFkZFJlc3VsdChta1Jlc3VsdChzcmMscGFyLCcnLHIuY3JlZGl0cykpOyB9KTsNCiAgICAgIH0NCiAgICB9DQogIH1jYXRjaChlKXsNCiAgICBpZihzZXR0aW5ncy5tb2RlPT09J2F1dG8nKXsNCiAgICAgIHRvYXN0KCdCYWNrZW5kL0FQSSBiZWx1bSBha3RpZiAoJytlLm1lc3NhZ2UrJykg4oCUIHBha2FpIHNpbXVsYXNpIGRlbW8nKTsNCiAgICAgIGRlbW9SZXN1bHRzKHBhcik7DQogICAgfWVsc2V7DQogICAgICB0b2FzdCgnR2FnYWw6ICcrZS5tZXNzYWdlKTsNCiAgICB9DQogIH1maW5hbGx5ew0KICAgIGhpZGVQcm9ncmVzcygpOyBzdGF0ZS5idXN5PWZhbHNlOyBzZXRCdXN5KGZhbHNlKTsNCiAgfQ0KfQ0KDQovKiAtLS0gSW1nMkltZyAtLS0gKi8NCnZhciBpMmlEYXRhVXJsPW51bGw7DQokKCdpMmktZHJvcCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyAkKCdpMmktZmlsZScpLmNsaWNrKCk7IH0pOw0KJCgnaTJpLWZpbGUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLGZ1bmN0aW9uKGUpeyBoYW5kbGVJMmlGaWxlKGUudGFyZ2V0LmZpbGVzJiZlLnRhcmdldC5maWxlc1swXSk7IH0pOw0KJCgnaTJpLWRyb3AnKS5hZGRFdmVudExpc3RlbmVyKCdkcmFnb3ZlcicsZnVuY3Rpb24oZSl7IGUucHJldmVudERlZmF1bHQoKTsgfSk7DQokKCdpMmktZHJvcCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLGZ1bmN0aW9uKGUpeyBlLnByZXZlbnREZWZhdWx0KCk7IGhhbmRsZUkyaUZpbGUoZS5kYXRhVHJhbnNmZXIuZmlsZXMmJmUuZGF0YVRyYW5zZmVyLmZpbGVzWzBdKTsgfSk7DQokKCdpMmktZHMnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7ICQoJ2kyaS1kc3YnKS50ZXh0Q29udGVudD1wYXJzZUZsb2F0KGUudGFyZ2V0LnZhbHVlKS50b0ZpeGVkKDIpOyB9KTsNCiQoJ2kyaS1jbGVhcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpew0KICBpMmlEYXRhVXJsPW51bGw7ICQoJ2kyaS1wcmV2aWV3JykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ2kyaS1pbWcnKS5zcmM9Jyc7ICQoJ2kyaS1kcm9wJykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7DQp9KTsNCmZ1bmN0aW9uIGhhbmRsZUkyaUZpbGUoZil7DQogIGlmKCFmKSByZXR1cm47DQogIHZhciByZD1uZXcgRmlsZVJlYWRlcigpOw0KICByZC5vbmxvYWQ9ZnVuY3Rpb24oKXsNCiAgICBpMmlEYXRhVXJsPXJkLnJlc3VsdDsNCiAgICAkKCdpMmktaW1nJykuc3JjPXJkLnJlc3VsdDsgJCgnaTJpLXByZXZpZXcnKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgJCgnaTJpLWRyb3AnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsNCiAgfTsNCiAgcmQucmVhZEFzRGF0YVVSTChmKTsNCn0NCg0KLyogLS0tIHJlbmRlciBwZXIgdGFiIC0tLSAqLw0KZnVuY3Rpb24gcmVuZGVyQ2FudmFzKCl7DQogIHZhciBwYWdlPXN0YXRlLnBhZ2U7DQogIHZhciBoaWRlTWFpbiA9ICEocGFnZT09PSd0ZXh0J3x8cGFnZT09PSdpbWcnKTsNCiAgJCgnaW1nMmltZy1jYXJkJykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJywgcGFnZSE9PSdpbWcnKTsNCiAgJCgnZW1wdHknKS5zdHlsZS5kaXNwbGF5ID0gKGhpZGVNYWluIHx8IHN0YXRlLnJlc3VsdHMubGVuZ3RoPjApID8gJ25vbmUnIDogJyc7DQogICQoJ2dyaWQnKS5zdHlsZS5kaXNwbGF5ID0gaGlkZU1haW4/J25vbmUnOicnOw0KICAkKCd0YWItcGxhY2Vob2xkZXInKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLCAhaGlkZU1haW4pOw0KICAkKCd0YWItcGxhY2Vob2xkZXInKS5jbGFzc0xpc3QudG9nZ2xlKCdmbGV4JywgaGlkZU1haW4pOw0KICBpZihwYWdlPT09J2VkaXQnKSAkKCd0YWItcGxhY2Vob2xkZXItdGV4dCcpLnRleHRDb250ZW50PSdFZGl0IC8gSW5wYWludGluZyDigJQgc2VnZXJhIGhhZGlyJzsNCiAgZWxzZSBpZihwYWdlPT09J3ZpZGVvJykgJCgndGFiLXBsYWNlaG9sZGVyLXRleHQnKS50ZXh0Q29udGVudD0nVGV4dCAvIEltYWdlIHRvIFZpZGVvIOKAlCBzZWdlcmEgaGFkaXInOw0KICBlbHNlIGlmKHBhZ2U9PT0ncHJpbWUnKSAkKCd0YWItcGxhY2Vob2xkZXItdGV4dCcpLnRleHRDb250ZW50PSdQcmltZSDigJQgc2VnZXJhIGhhZGlyJzsNCn0NCg0KLyogLS0tIHJpd2F5YXQgZGkgbW9iaWxlIC0tLSAqLw0KJCgnYnRuLWhpc3RvcnknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgncmlnaHRQYW4nKS5jbGFzc0xpc3QudG9nZ2xlKCdtb2JpbGUtb3BlbicpOyB9KTsNCiQoJ292ZXJsYXknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgncmlnaHRQYW4nKS5jbGFzc0xpc3QucmVtb3ZlKCdtb2JpbGUtb3BlbicpOyB9KTsNCg0KcmVuZGVyTG9yYSgpOw0Kc2V0TW9kZWwoTU9ERUxTWzBdKTsNCnVwZFdIKCk7DQpsb2FkU2V0dGluZ3MoKTsgYXBwbHlTZXR0aW5nc1VJKCk7DQpoYW5kbGVPQXV0aENhbGxiYWNrKCk7DQp0cnl7DQogIHZhciBzYXZlZD1KU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFJFU1VMVFNfS0VZKXx8J1tdJyk7DQogIGlmKEFycmF5LmlzQXJyYXkoc2F2ZWQpKSBzdGF0ZS5yZXN1bHRzPXNhdmVkOw0KfWNhdGNoKGUpe30NCnJlbmRlckNhbnZhcygpOw0KcmVuZGVyR3JpZCgpOw0KcmVuZGVyUmlnaHQoKTsNCjwvc2NyaXB0Pg0KPC9ib2R5Pg0KPC9odG1sPg0KDQoNCg==';
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
