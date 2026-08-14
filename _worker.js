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
const HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImlkIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04IiAvPgo8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLGluaXRpYWwtc2NhbGU9MSIgLz4KPHRpdGxlPlJla3R5IEFJIOKAlCBUZXh0IHRvIEltYWdlPC90aXRsZT4KPHNjcmlwdD53aW5kb3cuX190YV9zdHlsZV9fPXRydWU8L3NjcmlwdD4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuLnRhaWx3aW5kY3NzLmNvbSI+PC9zY3JpcHQ+CjxzY3JpcHQgc3JjPSJodHRwczovL3VucGtnLmNvbS9AcGhvc3Bob3ItaWNvbnMvd2ViL3Bob3NwaG9yLWljb24uanMiPjwvc2NyaXB0Pgo8bGluayByZWw9InByZWNvbm5lY3QiIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20iPgo8bGluayBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tL2NzczI/ZmFtaWx5PUludGVyOndnaHRANDAwOzUwMDs2MDA7NzAwJmRpc3BsYXk9c3dhcCIgcmVsPSJzdHlsZXNoZWV0Ij4KPHN0eWxlPgpodG1sLGJvZHl7bWFyZ2luOjA7cGFkZGluZzowO2ZvbnQtZmFtaWx5Oi1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LCdTZWdvZSBVSScsUm9ib3RvLCdIZWx2ZXRpY2EgTmV1ZScsQXJpYWwsJ05vdG8gU2Fucycsc2Fucy1zZXJpZjtiYWNrZ3JvdW5kOiMwZDExMTc7Y29sb3I6I2U4ZThlODttaW4taGVpZ2h0OjEwMHZofQouaGlkZWJhcjo6LXdlYmtpdC1zY3JvbGxiYXJ7ZGlzcGxheTpub25lfS5oaWRlYmFye3Njcm9sbGJhci13aWR0aDpub25lfQo6Oi13ZWJraXQtc2Nyb2xsYmFye3dpZHRoOjZweDtoZWlnaHQ6NnB4fQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1ie2JhY2tncm91bmQ6IzMwMzYzZDtib3JkZXItcmFkaXVzOjRweH0KLmJke2JvcmRlci1jb2xvcjojMzAzNjNkfQouaW5we2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjhweDtiYWNrZ3JvdW5kOiMxYzIxMjg7Y29sb3I6I2U4ZThlODtwYWRkaW5nOjhweCAxMXB4O291dGxpbmU6bm9uZTtmb250LXNpemU6MTNweDt3aWR0aDoxMDAlfQouaW5wOmZvY3Vze2JvcmRlci1jb2xvcjojNkY1REZGfQouYnRue2JvcmRlci1yYWRpdXM6MTBweDtmb250LXdlaWdodDo2MDA7dHJhbnNpdGlvbjouMTVzO2N1cnNvcjpwb2ludGVyO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjZweDtmb250LXNpemU6MTNweH0KLmJ0bi1ibHVle2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDk1ZGVnLCM2RjVERkYgMCUsIzI3RDRDRCA1OS43JSwjNzRGRjdFIDEwMCUpO2JvcmRlcjpub25lO2NvbG9yOiNmZmY7Ym94LXNoYWRvdzowIDAgMThweCByZ2JhKDExMSw5MywyNTUsLjM1KTtwYWRkaW5nOjAgMThweH0KLmJ0bi1ibHVlOmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMSk7Ym94LXNoYWRvdzowIDAgMjRweCByZ2JhKDExMSw5MywyNTUsLjUpfQouYnRuLWJsdWU6YWN0aXZle3RyYW5zZm9ybTpzY2FsZSguOTgpfQouYnRuLWdlbntiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5NWRlZywjMjJjNTVlLCMxNmEzNGEpO2JvcmRlcjpub25lO2NvbG9yOiNmZmY7Ym94LXNoYWRvdzowIDAgMThweCByZ2JhKDM0LDE5Nyw5NCwuMzUpfQouYnRuLWdlbjpob3ZlcntmaWx0ZXI6YnJpZ2h0bmVzcygxLjA4KTtib3gtc2hhZG93OjAgMCAyNHB4IHJnYmEoMzQsMTk3LDk0LC41KX0KLmJ0bi1nZW46YWN0aXZle3RyYW5zZm9ybTpzY2FsZSguOTgpfQouYnRuLWdob3N0e2NvbG9yOiNhMWExYWE7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHRyYW5zcGFyZW50fS5idG4tZ2hvc3Q6aG92ZXJ7YmFja2dyb3VuZDojMWMyMTI4O2NvbG9yOiNlOGU4ZTh9Ci50YWJ7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtwYWRkaW5nOjZweCAxMnB4O2JvcmRlci1yYWRpdXM6OHB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7Zm9udC13ZWlnaHQ6NTAwO3doaXRlLXNwYWNlOm5vd3JhcDt0cmFuc2l0aW9uOi4xMnN9Ci50YWI6aG92ZXJ7Y29sb3I6I2ZmZjtiYWNrZ3JvdW5kOiMxYzIxMjh9LnRhYi5zZWx7Y29sb3I6I2ZmZjtiYWNrZ3JvdW5kOiMxYzIxMjh9Ci50YWIgLmRvdHt3aWR0aDo2cHg7aGVpZ2h0OjZweDtib3JkZXItcmFkaXVzOjUwJTtkaXNwbGF5OmlubGluZS1ibG9ja30KLnRhYi5zZWwgLmRvdHtkaXNwbGF5Om5vbmV9Ci50YWIuc2VsOjphZnRlcntjb250ZW50OiIiO3Bvc2l0aW9uOmFic29sdXRlO2JvdHRvbTotMXB4O2xlZnQ6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGVYKC01MCUpO3dpZHRoOjIwcHg7aGVpZ2h0OjJweDtib3JkZXItcmFkaXVzOjJweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5NWRlZywjNkY1REZGLCMyN0Q0Q0QpO3Bvc2l0aW9uOmFic29sdXRlfQoudGFie3Bvc2l0aW9uOnJlbGF0aXZlfQouc2xpZGVyey13ZWJraXQtYXBwZWFyYW5jZTpub25lO2FwcGVhcmFuY2U6bm9uZTtoZWlnaHQ6NHB4O2JvcmRlci1yYWRpdXM6NHB4O2JhY2tncm91bmQ6IzMwMzYzZDtvdXRsaW5lOm5vbmU7d2lkdGg6MTAwJX0KLnNsaWRlcjo6LXdlYmtpdC1zbGlkZXItdGh1bWJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7YXBwZWFyYW5jZTpub25lO3dpZHRoOjE1cHg7aGVpZ2h0OjE1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDojZmZmO2JvcmRlcjozcHggc29saWQgIzZGNURGRjtjdXJzb3I6cG9pbnRlcjtib3gtc2hhZG93OjAgMCA2cHggcmdiYSgxMTEsOTMsMjU1LC40KTt0cmFuc2l0aW9uOi4xMnN9Ci5zbGlkZXI6Oi13ZWJraXQtc2xpZGVyLXRodW1iOmhvdmVye3RyYW5zZm9ybTpzY2FsZSgxLjEpfQoubG9yYS1zbHstd2Via2l0LWFwcGVhcmFuY2U6bm9uZTthcHBlYXJhbmNlOm5vbmU7aGVpZ2h0OjRweDtib3JkZXItcmFkaXVzOjRweDtiYWNrZ3JvdW5kOiMzMDM2M2Q7b3V0bGluZTpub25lfQoubG9yYS1zbDo6LXdlYmtpdC1zbGlkZXItdGh1bWJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7d2lkdGg6MTRweDtoZWlnaHQ6MTRweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjJweCBzb2xpZCAjNkY1REZGO2N1cnNvcjpwb2ludGVyfQoubG9yYS1jYXJke3Bvc2l0aW9uOnJlbGF0aXZlO2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjEwcHg7YmFja2dyb3VuZDojMWMyMTI4O3RyYW5zaXRpb246LjEycztwYWRkaW5nOjhweCAxMHB4IDEwcHh9Ci5sb3JhLWNhcmQ6aG92ZXJ7Ym9yZGVyLWNvbG9yOiMzZDQ0NGR9Ci5sb3JhLWxhYmVse3Bvc2l0aW9uOmFic29sdXRlO3RvcDowO2xlZnQ6MDtmb250LXNpemU6OXB4O2NvbG9yOiM5YTlhYTI7YmFja2dyb3VuZDojMjEyNjJkO2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMSk7cGFkZGluZzoycHggNnB4O2JvcmRlci1yYWRpdXM6NnB4O2JvcmRlci10b3AtbGVmdC1yYWRpdXM6MTBweDtib3JkZXItYm90dG9tLXJpZ2h0LXJhZGl1czo2cHg7ei1pbmRleDoyfQoubG9yYS10b3B7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4O21hcmdpbi10b3A6OHB4fQoubG9yYS10aHVtYnt3aWR0aDozNHB4O2hlaWdodDozNHB4O2JvcmRlci1yYWRpdXM6NnB4O2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtvYmplY3QtZml0OmNvdmVyO2ZsZXgtc2hyaW5rOjB9Ci5sb3JhLW5hbWV7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOiNlOGU4ZTg7ZmxleDoxO21pbi13aWR0aDowO3doaXRlLXNwYWNlOm5vd3JhcDtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpc30KLmxvcmEtaWNvbnN7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MnB4O2ZsZXgtc2hyaW5rOjB9Ci5sb3JhLWljb257d2lkdGg6MjJweDtoZWlnaHQ6MjJweDtib3JkZXItcmFkaXVzOjRweDtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y29sb3I6IzcxNzE3YTtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O3RyYW5zaXRpb246LjEyc30KLmxvcmEtaWNvbjpob3ZlcntiYWNrZ3JvdW5kOiMyMTI2MmQ7Y29sb3I6I2ZmZn0KLmxvcmEtaWNvbi5kZWw6aG92ZXJ7YmFja2dyb3VuZDpyZ2JhKDIzOSw2OCw2OCwuMTUpO2NvbG9yOiNlZjQ0NDR9Ci5sb3JhLWljb24gc3Zne3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7c3Ryb2tlOmN1cnJlbnRDb2xvcjtmaWxsOm5vbmU7c3Ryb2tlLXdpZHRoOjJ9Ci5sb3JhLXNsaWRlci1yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6NHB4O21hcmdpbi10b3A6NnB4fQoubC1zbGlkZXJ7cG9zaXRpb246cmVsYXRpdmU7ZmxleDoxO2hlaWdodDoxNnB4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5sLXRyYWNre3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDtyaWdodDowO2hlaWdodDo0cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDojMzAzNjNkfQoubC1maWxse3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDt0b3A6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpO2hlaWdodDo0cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiwjMjdENENEKX0KLmwtaGFuZGxle3Bvc2l0aW9uOmFic29sdXRlO3RvcDo1MCU7dHJhbnNmb3JtOnRyYW5zbGF0ZSgtNTAlLC01MCUpO3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoycHggc29saWQgIzZGNURGRjtib3gtc2hhZG93OjAgMXB4IDNweCByZ2JhKDAsMCwwLC40KTtwb2ludGVyLWV2ZW50czpub25lfQoubG9yYS1zbHtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7b3BhY2l0eTowO2N1cnNvcjpwb2ludGVyfQoubC1udW17ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MnB4O2ZsZXgtc2hyaW5rOjB9Ci5sb3JhLWlucHV0e3dpZHRoOjMwcHg7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xNSk7Ym9yZGVyLXJhZGl1czo2cHg7YmFja2dyb3VuZDojMGQxMTE3O2NvbG9yOiNlOGU4ZTg7Zm9udC1zaXplOjEycHg7dGV4dC1hbGlnbjpjZW50ZXI7b3V0bGluZTpub25lO3BhZGRpbmc6NHB4IDB9Ci5sb3JhLWlucHV0OmZvY3Vze2JvcmRlci1jb2xvcjojNkY1REZGfQoubG9yYS11cmwtaW5we2ZvbnQtc2l6ZToxMXB4O3BhZGRpbmc6NnB4IDlweDttYXJnaW4tdG9wOjJweH0KLmxvcmEtYnRue3dpZHRoOjIycHg7aGVpZ2h0OjIycHg7Ym9yZGVyLXJhZGl1czo1MCU7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOiM5YTlhYTI7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTt0cmFuc2l0aW9uOi4xMnN9Ci5sb3JhLWJ0bjpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjEpO2NvbG9yOiNmZmZ9Ci5sb3JhLWJ0biBzdmd7d2lkdGg6MTRweDtoZWlnaHQ6MTRweDtzdHJva2U6Y3VycmVudENvbG9yO2ZpbGw6bm9uZTtzdHJva2Utd2lkdGg6MjtzdHJva2UtbGluZWNhcDpyb3VuZH0KLnRhZ3tiYWNrZ3JvdW5kOiMxYzIxMjg7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2NvbG9yOiNlMGUwZTA7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjRweDtmb250LXNpemU6MTJweDtwYWRkaW5nOjRweCA4cHg7Ym9yZGVyLXJhZGl1czo2cHh9Ci5hcntib3JkZXI6MXB4IHNvbGlkICMzMDM2M2Q7Ym9yZGVyLXJhZGl1czoxMHB4O2JhY2tncm91bmQ6IzFjMjEyODtjb2xvcjojZmZmO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjJweDtwYWRkaW5nOjhweCAycHg7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjouMTJzO21pbi13aWR0aDowfQouYXI6aG92ZXJ7Ym9yZGVyLWNvbG9yOiMzZDQ0NGR9Ci5hci5zZWx7Ym9yZGVyLWNvbG9yOiMyN0Q0Q0Q7YmFja2dyb3VuZDojMTYxYjIyfQouYXIuc2VsIC5hci1kZXNje2NvbG9yOiMyN0Q0Q0R9Ci5hci1pY297d2lkdGg6MjRweDtoZWlnaHQ6MjRweDtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXJ9Ci5hci1pY28gc3Zne3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCV9Ci5hci1uYW1le2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiNlOGU4ZTg7d2hpdGUtc3BhY2U6bm93cmFwfQouYXItZGVzY3tmb250LXNpemU6OXB4O2NvbG9yOiM5YTlhYTI7d2hpdGUtc3BhY2U6bm93cmFwfQouZmllbGR7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6M3B4fQoucnRhYntib3JkZXI6MXB4IHNvbGlkIHRyYW5zcGFyZW50O2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50fQoucnRhYjpob3Zlcntjb2xvcjojZmZmfS5ydGFiLnNlbHtiYWNrZ3JvdW5kOiMxYzIxMjg7Y29sb3I6I2ZmZn0KLnJjYXJke2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjEwcHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6IzE2MWIyMn0KLmNoaXB7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOiMxYzIxMjg7dHJhbnNpdGlvbjouMTJzfQouY2hpcDpob3Zlcntjb2xvcjojZmZmfS5jaGlwLm9ue2JvcmRlci1jb2xvcjojNkY1REZGO2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMTYxYjIyfQojdG9hc3R7Ym94LXNoYWRvdzowIDhweCAzMHB4IHJnYmEoMCwwLDAsLjUpfQpAbWVkaWEgKG1heC13aWR0aDoxMDIzcHgpeyNyaWdodFBhbi5tb2JpbGUtb3Blbntwb3NpdGlvbjpmaXhlZDt0b3A6NTZweDtyaWdodDowO2JvdHRvbTowO2xlZnQ6YXV0bzt6LWluZGV4OjQwO2Rpc3BsYXk6ZmxleDt3aWR0aDptaW4oMjFyZW0sOTJ2dyk7Ym94LXNoYWRvdzotOHB4IDAgMzBweCByZ2JhKDAsMCwwLC41KX19CnRleHRhcmVhe2NhcmV0LWNvbG9yOiM2RjVERkZ9CmlucHV0W3R5cGU9Y2hlY2tib3hde3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7Y3Vyc29yOnBvaW50ZXJ9CmlucHV0W3R5cGU9cmFuZ2Vde2N1cnNvcjpwb2ludGVyfQo6Zm9jdXMtdmlzaWJsZXtvdXRsaW5lOjJweCBzb2xpZCAjNkY1REZGO291dGxpbmUtb2Zmc2V0OjJweH0KLnd2bnVte2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOiMxYzIxMjg7Y29sb3I6I2U4ZThlODtwYWRkaW5nOjNweCA2cHg7d2lkdGg6NjRweDtmb250LXNpemU6MTJweDt0ZXh0LWFsaWduOnJpZ2h0O291dGxpbmU6bm9uZX0KLnd2bnVtOmZvY3Vze2JvcmRlci1jb2xvcjojMjdENENEfQoubXRhYntwYWRkaW5nOjhweCAxNHB4O2JvcmRlci1yYWRpdXM6OHB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7Zm9udC13ZWlnaHQ6NTAwO3doaXRlLXNwYWNlOm5vd3JhcDt0cmFuc2l0aW9uOi4xMnN9Ci5tdGFiOmhvdmVye2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMWMyMTI4fS5tdGFiLnNlbHtjb2xvcjojZmZmO2JhY2tncm91bmQ6IzFjMjEyODtib3JkZXItYm90dG9tOjJweCBzb2xpZCAjNkY1REZGfQoubWNoaXB7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOiMxYzIxMjg7dHJhbnNpdGlvbjouMTJzO3doaXRlLXNwYWNlOm5vd3JhcH0KLm1jaGlwOmhvdmVye2NvbG9yOiNmZmZ9Lm1jaGlwLm9ue2JvcmRlci1jb2xvcjojNkY1REZGO2NvbG9yOiNmZmY7YmFja2dyb3VuZDpyZ2JhKDExMSw5MywyNTUsLjE1KX0KLm1jYXJke2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjEwcHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6IzFjMjEyODt0cmFuc2l0aW9uOi4xNXN9Ci5tY2FyZDpob3Zlcntib3JkZXItY29sb3I6cmdiYSgxMTEsOTMsMjU1LC41NSk7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTJweCk7Ym94LXNoYWRvdzowIDZweCAxOHB4IHJnYmEoMCwwLDAsLjM1KX0KLm1jYXJkLWltZ3twb3NpdGlvbjpyZWxhdGl2ZTthc3BlY3QtcmF0aW86My80O292ZXJmbG93OmhpZGRlbn0KLm1jYXJkLWltZyBpbWd7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtvYmplY3QtZml0OmNvdmVyO3RyYW5zaXRpb246LjNzfQoubWNhcmQ6aG92ZXIgLm1jYXJkLWltZyBpbWd7dHJhbnNmb3JtOnNjYWxlKDEuMDUpfQoubWNhcmQtYmFkZ2V7cG9zaXRpb246YWJzb2x1dGU7dG9wOjZweDtsZWZ0OjZweDtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjY1KTtiYWNrZHJvcC1maWx0ZXI6Ymx1cig0cHgpO2ZvbnQtc2l6ZToxMHB4O3BhZGRpbmc6MnB4IDZweDtib3JkZXItcmFkaXVzOjRweDtjb2xvcjojZThlOGU4O2ZvbnQtd2VpZ2h0OjUwMH0KLm1jYXJkLXN0YXJ7cG9zaXRpb246YWJzb2x1dGU7dG9wOjZweDtyaWdodDo2cHg7d2lkdGg6MjZweDtoZWlnaHQ6MjZweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjUpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDRweCk7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2N1cnNvcjpwb2ludGVyO2NvbG9yOiM5YTlhYTI7dHJhbnNpdGlvbjouMTJzfQoubWNhcmQtc3Rhcjpob3Zlcntjb2xvcjojZWFiMzA4fS5tY2FyZC1zdGFyLm9ue2NvbG9yOiNlYWIzMDh9Ci5tY2FyZC12aWV3c3twb3NpdGlvbjphYnNvbHV0ZTtib3R0b206NnB4O2xlZnQ6NnB4O2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNik7YmFja2Ryb3AtZmlsdGVyOmJsdXIoNHB4KTtmb250LXNpemU6MTBweDtwYWRkaW5nOjJweCA2cHg7Ym9yZGVyLXJhZGl1czo0cHg7Y29sb3I6I2U4ZThlODtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDozcHh9Ci5tY2FyZC1pbmZve3BhZGRpbmc6OHB4fQoubWNhcmQtbmFtZXtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo2MDA7Y29sb3I6I2U4ZThlODt3aGl0ZS1zcGFjZTpub3dyYXA7b3ZlcmZsb3c6aGlkZGVuO3RleHQtb3ZlcmZsb3c6ZWxsaXBzaXN9Ci5tY2FyZC1tZXRhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47bWFyZ2luLXRvcDo2cHh9Ci5tY2FyZC12ZXJ7Zm9udC1zaXplOjExcHg7Y29sb3I6IzlhOWFhMjtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjRweDtwYWRkaW5nOjJweCA2cHh9Ci5tY2FyZC1zZWx7Zm9udC1zaXplOjExcHg7Ym9yZGVyOjFweCBzb2xpZCAjNkY1REZGO2NvbG9yOiM2RjVERkY7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXItcmFkaXVzOjRweDtwYWRkaW5nOjJweCAxMHB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcjt0cmFuc2l0aW9uOi4xMnN9Ci5tY2FyZC1zZWw6aG92ZXJ7YmFja2dyb3VuZDojNkY1REZGO2NvbG9yOiNmZmZ9Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+Cgo8aGVhZGVyIGNsYXNzPSJmaXhlZCB0b3AtMCBsZWZ0LTAgcmlnaHQtMCB6LTQwIGgtMTQgYmctWyMwZDExMTddLzg1IGJhY2tkcm9wLWJsdXIgYm9yZGVyLWIgYmQgZmxleCBpdGVtcy1jZW50ZXIgcHgtMiBzbTpweC0zIGdhcC0yIj4KICA8YnV0dG9uIGlkPSJtbWVudSIgY2xhc3M9ImxnOmhpZGRlbiB0ZXh0LW5ldXRyYWwtNDAwIHAtMSI+PGkgZGF0YS1pY29uPSJsaXN0IiBjbGFzcz0idy01IGgtNSI+PC9pPjwvYnV0dG9uPgogIDxkaXYgY2xhc3M9InctNiBoLTYgc2hyaW5rLTAgaGlkZGVuIHNtOmZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIj4KICAgIDxzdmcgd2lkdGg9IjIyIiBoZWlnaHQ9IjIyIiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgcng9IjUiIGZpbGw9InVybCgjZykiLz48cGF0aCBkPSJNNyAxMi41bDMgMyA3LTciIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjI0IiB5Mj0iMjQiPjxzdG9wIHN0b3AtY29sb3I9IiM2RjVERkYiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM2RjVERkYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48L3N2Zz4KICA8L2Rpdj4KICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMC41IGhpZGViYXIgb3ZlcmZsb3cteC1hdXRvIGZsZXgtMSI+CiAgICA8ZGl2IGNsYXNzPSJ0YWIgc2VsIiBkYXRhLXRhYj0idGV4dCI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6IzZGNURGRiI+PC9zcGFuPlRleHQySW1nPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJ0YWIiIGRhdGEtdGFiPSJpbWciPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiMyMmM1NWUiPjwvc3Bhbj5JbWcySW1nPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJ0YWIiIGRhdGEtdGFiPSJlZGl0Ij48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDojZWFiMzA4Ij48L3NwYW4+RWRpdDwvZGl2PgogICAgPGRpdiBjbGFzcz0idGFiIiBkYXRhLXRhYj0idmlkZW8iPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiNlZjQ0NDQiPjwvc3Bhbj5WaWRlbzwvZGl2PgogICAgPGRpdiBjbGFzcz0idGFiIiBkYXRhLXRhYj0icHJpbWUiPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiMzYjgyZjYiPjwvc3Bhbj5QcmltZTwvZGl2PgogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUgc206Z2FwLTIgbWwtYXV0byBzaHJpbmstMCI+CiAgICA8YnV0dG9uIGlkPSJuY29sIiBjbGFzcz0idGV4dC1uZXV0cmFsLTQwMCBob3Zlcjp0ZXh0LXdoaXRlIHAtMS41IGhpZGRlbiBzbTpmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSB0ZXh0LXhzIiB0aXRsZT0iSnVtbGFoIGtvbG9tIj48aSBkYXRhLWljb249InNxdWFyZXMtZm91ciIgY2xhc3M9InctNCBoLTQiPjwvaT48c3BhbiBpZD0ibmNvbGxibCI+Mjwvc3Bhbj48L2J1dHRvbj4KICAgIDxidXR0b24gaWQ9ImJ0bi1nbyIgY2xhc3M9ImJ0biBidG4tYmx1ZSBoLTEwIHB4LTQgc206cHgtNSB3aGl0ZXNwYWNlLW5vd3JhcCI+CiAgICAgIDxpIGRhdGEtaWNvbj0icGxheSIgY2xhc3M9InctNCBoLTQiPjwvaT5HZW5lcmF0ZQogICAgICA8c3BhbiBjbGFzcz0idGV4dC14cyBvcGFjaXR5LTkwIGZvbnQtbm9ybWFsIiBpZD0icHJpY2UiPiskMC4zMzwvc3Bhbj4KICAgIDwvYnV0dG9uPgogIDwvZGl2Pgo8L2hlYWRlcj4KCjxkaXYgaWQ9Im92ZXJsYXkiIGNsYXNzPSJmaXhlZCBpbnNldC0wIGJnLWJsYWNrLzYwIHotMzAgaGlkZGVuIGxnOmhpZGRlbiI+PC9kaXY+Cgo8ZGl2IGNsYXNzPSJwdC0xNCBmbGV4IGgtW2NhbGMoMTAwdmgtNTZweCldIG92ZXJmbG93LWhpZGRlbiI+CgogIDwhLS0gTEVGVCBQQU5FTCAtLT4KICA8YXNpZGUgaWQ9ImxlZnRwYW4iIGNsYXNzPSJmaXhlZCBsZzpzdGF0aWMgei00MCBpbnNldC15LTAgbGVmdC0wIHB0LTE0IGxnOnB0LTAgdy1bMjJyZW1dIG1heC13LVs4OHZ3XSAtdHJhbnNsYXRlLXgtZnVsbCBsZzp0cmFuc2xhdGUteC0wIHRyYW5zaXRpb24tdHJhbnNmb3JtIGR1cmF0aW9uLTIwMCBzaHJpbmstMCBib3JkZXItciBiZCBvdmVyZmxvdy15LWF1dG8gaGlkZWJhciBiZy1bIzE2MWIyMl0iPgogICAgPGRpdiBjbGFzcz0icC00IHNwYWNlLXktNCI+CgogICAgICA8IS0tIE1vZGVscyAodXJ1dGFuIHNlcGVydGkgVGVuc29yLkFydDogTW9kZWxzIC0+IFZBRSAtPiBTZXR0aW5ncykgLS0+CiAgICAgIDxkaXYgY2xhc3M9InNwYWNlLXktMyI+CiAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+TW9kZWxzPC9zcGFuPgogICAgICAgIDxkaXYgaWQ9Im1vZGVsLWNhcmQiIGNsYXNzPSJyZWxhdGl2ZSBib3JkZXIgYmQgcm91bmRlZC14bCBiZy1bIzFjMjEyOF0gaG92ZXI6Ym9yZGVyLVsjM2Q0NDRkXSBjdXJzb3ItcG9pbnRlciBwLTMiPgogICAgICAgICAgPHNwYW4gaWQ9Im1vZGVsLWJhZGdlIiBjbGFzcz0iYWJzb2x1dGUgdG9wLTAgbGVmdC0wIHRleHQtWzlweF0gdGV4dC1uZXV0cmFsLTQwMCBiZy1bIzIxMjYyZF0gYm9yZGVyIGJkIHB4LTIgcHktMC41IHJvdW5kZWQtdGwteGwgcm91bmRlZC1ici1tZCB6LTEwIj5CYXNpYyBNb2RlbCAtIFogSW1hZ2U8L3NwYW4+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMyBtdC0yIj4KICAgICAgICAgICAgPGltZyBpZD0ibW9kZWwtdGh1bWIiIHNyYz0iaHR0cHM6Ly9waWNzdW0ucGhvdG9zL3NlZWQvemltYWdlLzY0IiBjbGFzcz0idy0xNiBoLTE2IHJvdW5kZWQtbGcgb2JqZWN0LWNvdmVyIHNocmluay0wIGJvcmRlciBiZCIgYWx0PSJtb2RlbCIvPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4LTEgbWluLXctMCI+CiAgICAgICAgICAgICAgPGRpdiBpZD0ibW9kZWwtbmFtZSIgY2xhc3M9ImZvbnQtc2VtaWJvbGQgdGV4dC1zbSB0cnVuY2F0ZSI+WiBJbWFnZSAtIGJhc2UtYmYxNjwvZGl2PgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0ibW9kZWwtaW5mbyIgY2xhc3M9InctNiBoLTYgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcm91bmRlZCB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgaG92ZXI6YmctWyMyMTI2MmRdIHRyYW5zaXRpb24iIHRpdGxlPSJJbmZvIj4KICAgICAgICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBjbGFzcz0idy00IGgtNCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48bGluZSB4MT0iMTIiIHkxPSIxNiIgeDI9IjEyIiB5Mj0iMTIiLz48bGluZSB4MT0iMTIiIHkxPSI4IiB4Mj0iMTIuMDEiIHkyPSI4Ii8+PC9zdmc+CiAgICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIiBjbGFzcz0idy00IGgtNCB0ZXh0LW5ldXRyYWwtNTAwIHNocmluay0wIj48cG9seWxpbmUgcG9pbnRzPSI5IDE4IDE1IDEyIDkgNiIvPjwvc3ZnPgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBnYXAtMiI+CiAgICAgICAgICA8YnV0dG9uIGlkPSJidG4tYWRkbG9yYSIgY2xhc3M9ImJ0biBidG4tZ2hvc3QgZmxleC0xIGgtOSBib3JkZXIgYmQgdGV4dC14cyI+QWRkIExvUkE8L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3QgZmxleC0xIGgtOSBib3JkZXIgYmQgdGV4dC14cyI+QWRkIEVtYmVkZGluZzwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOSBib3JkZXIgYmQgdGV4dC14cyI+QWRkIENvbnRyb2xOZXQ8L2J1dHRvbj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIExvUkEgLS0+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIG1iLTIiPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+TG9SQTwvc3Bhbj4KICAgICAgICAgIDxpIGRhdGEtaWNvbj0iY2FyZXQtZG93biIgY2xhc3M9InctNCBoLTQgdGV4dC1uZXV0cmFsLTUwMCI+PC9pPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgaWQ9ImxvcmEtbGlzdCIgY2xhc3M9InNwYWNlLXktMiI+PC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBUcmlnZ2VyIFdvcmRzIC0tPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5UcmlnZ2VyIFdvcmRzPC9zcGFuPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCI+KDxzcGFuIGlkPSJ0ci1jb3VudCI+MDwvc3Bhbj4pPC9zcGFuPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBtdC0xIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAiPkFkZCBUcmlnZ2VyIFdvcmRzIHRvIFByb21wdHM8L3NwYW4+CiAgICAgICAgICA8YnV0dG9uIGlkPSJhZGRhbGwtdHJpZyIgY2xhc3M9InRleHQteHMgdGV4dC1bIzZGNURGRl0gaG92ZXI6dW5kZXJsaW5lIGZvbnQtbWVkaXVtIj5BZGQgQWxsPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBmbGV4LXdyYXAgZ2FwLTEuNSBtdC0yIiBpZD0idHJpZ2dlcnMiPjwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDwhLS0gVkFFIC0tPgogICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20iPlZBRTwvc3Bhbj4KICAgICAgICA8c2VsZWN0IGlkPSJ2YWUiIGNsYXNzPSJpbnAiPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYXV0b21hdGljIj5BdXRvbWF0aWM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Im5vbmUiPk5vbmU8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InZhZS1mdC1tc2UtODQwMDAwLWVtYS1wcnVuZWQuY2twdCI+dmFlLWZ0LW1zZS04NDAwMDAtZW1hLXBydW5lZC5ja3B0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJrbC1mOC1hbmltZS5ja3B0Ij5rbC1mOC1hbmltZS5ja3B0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJrbC1mOC1hbmltZTIuY2twdCI+a2wtZjgtYW5pbWUyLmNrcHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9IllPWk9SQS52YWUucHQiPllPWk9SQS52YWUucHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Im9yYW5nZW1peC52YWUucHQiPm9yYW5nZW1peC52YWUucHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImJsZXNzZWQyLnZhZS5wdCI+Ymxlc3NlZDIudmFlLnB0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhbmltZXZhZS5wdCI+YW5pbWV2YWUucHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9IkNsZWFyVkFFLnNhZmV0ZW5zb3JzIj5DbGVhclZBRS5zYWZldGVuc29yczwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icGFzdGVsLXdhaWZ1LWRpZmZ1c2lvbi52YWUucHQiPnBhc3RlbC13YWlmdS1kaWZmdXNpb24udmFlLnB0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJjdXRlX3ZhZS5zYWZldGVuc29ycyI+Y3V0ZV92YWUuc2FmZXRlbnNvcnM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InNkeGxfdmFlLnNhZmV0ZW5zb3JzIj5zZHhsX3ZhZS5zYWZldGVuc29yczwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2R4bC12YWUtZnAxNi1maXguc2FmZXRlbnNvcnMiPnNkeGwtdmFlLWZwMTYtZml4LnNhZmV0ZW5zb3JzPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJ4bFZBRUNfYzkxLnNhZmV0ZW5zb3JzIj54bFZBRUNfYzkxLnNhZmV0ZW5zb3JzPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJsYXN0cGllY2VYTFZBRV9iYXNlb25BMDg5Ny5zYWZldGVuc29ycyI+bGFzdHBpZWNlWExWQUVfYmFzZW9uQTA4OTcuc2FmZXRlbnNvcnM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InBsYXlncm91bmQtdjIuNS1mcDE2LXZhZS5zYWZldGVuc29ycyI+cGxheWdyb3VuZC12Mi41LWZwMTYtdmFlLnNhZmV0ZW5zb3JzPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhZS5zZnQiPmFlLnNmdDwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icGl4ZWxfc3BhY2UiPnBpeGVsX3NwYWNlPC9vcHRpb24+CiAgICAgICAgPC9zZWxlY3Q+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBTZXR0aW5ncyAtLT4KICAgICAgPGRpdiBjbGFzcz0ic3BhY2UteS00Ij4KICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5TZXR0aW5nczwvc3Bhbj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBncmlkLWNvbHMtNCBnYXAtMiI+CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9ImFyIiBkYXRhLWFyPSJwb3J0cmFpdCI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHg9IjYiIHk9IjIuNSIgd2lkdGg9IjEyIiBoZWlnaHQ9IjE5IiByeD0iMi41IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiLz48L3N2Zz48L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLW5hbWUiPlBvcnRyYWl0PC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1kZXNjIj43Njh4MTE1Mjwvc3Bhbj4KICAgICAgICAgICAgPC9idXR0b24+CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9ImFyIiBkYXRhLWFyPSJsYW5kc2NhcGUiPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1pY28iPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj48cmVjdCB4PSIyLjUiIHk9IjYiIHdpZHRoPSIxOSIgaGVpZ2h0PSIxMiIgcng9IjIuNSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMS42Ii8+PC9zdmc+PC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5MYW5kc2NhcGU8L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWRlc2MiPjExNTJ4NzY4PC9zcGFuPgogICAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYXIiIGRhdGEtYXI9InNxdWFyZSI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHg9IjIuNSIgeT0iMi41IiB3aWR0aD0iMTkiIGhlaWdodD0iMTkiIHJ4PSIyLjUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjEuNiIvPjwvc3ZnPjwvc3Bhbj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItbmFtZSI+U3F1YXJlPC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1kZXNjIj4xMDI0eDEwMjQ8L3NwYW4+CiAgICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJhciBzZWwiIGRhdGEtYXI9ImN1c3RvbSI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxwYXRoIGQ9Ik00IDhoNU0xMyA4aDdNNCAxNmg5TTE3IDE2aDNNOSA1LjV2NU0xNyAxMy41djUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+PC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5jdXN0b208L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWRlc2MiPmN1c3RvbTwvc3Bhbj4KICAgICAgICAgICAgPC9idXR0b24+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBtdC0xLjUiIGlkPSJhci1sYWJlbCI+Y3VzdG9tPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiBpdGVtcy1jZW50ZXIiPjxzcGFuPldpZHRoPC9zcGFuPgogICAgICAgICAgICA8aW5wdXQgaWQ9Ind2IiB0eXBlPSJudW1iZXIiIG1pbj0iMjU2IiBtYXg9IjE1MzYiIHN0ZXA9IjY0IiB2YWx1ZT0iNzY4IiBjbGFzcz0id3ZudW0iLz48L2xhYmVsPgogICAgICAgICAgPGlucHV0IGlkPSJ3aWR0aCIgdHlwZT0icmFuZ2UiIG1pbj0iMjU2IiBtYXg9IjE1MzYiIHN0ZXA9IjY0IiB2YWx1ZT0iNzY4IiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIGl0ZW1zLWNlbnRlciI+PHNwYW4+SGVpZ2h0PC9zcGFuPgogICAgICAgICAgICA8aW5wdXQgaWQ9Imh2IiB0eXBlPSJudW1iZXIiIG1pbj0iMjU2IiBtYXg9IjE1MzYiIHN0ZXA9IjY0IiB2YWx1ZT0iMTE1MiIgY2xhc3M9Ind2bnVtIi8+PC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCBpZD0iaGVpZ2h0IiB0eXBlPSJyYW5nZSIgbWluPSIyNTYiIG1heD0iMTUzNiIgc3RlcD0iNjQiIHZhbHVlPSIxMTUyIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIj4KICAgICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQteHMiPlNhbXBsaW5nIE1ldGhvZDwvc3Bhbj4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0iYWR2LXRvZ2dsZSIgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBob3Zlcjp0ZXh0LXdoaXRlIGZsZXggaXRlbXMtY2VudGVyIGdhcC0xIj48aSBkYXRhLWljb249ImNhcmV0LWRvd24iIGNsYXNzPSJ3LTMuNSBoLTMuNSI+PC9pPkFkdmFuY2VkPC9idXR0b24+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZ3JpZC1jb2xzLTIgZ2FwLTIgbXQtMSI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj48bGFiZWwgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAiPlNhbXBsZXI8L2xhYmVsPgogICAgICAgICAgICAgIDxzZWxlY3QgaWQ9InNhbXBsZXIiIGNsYXNzPSJpbnAgdGV4dC14cyI+CiAgICAgICAgICAgICAgICA8b3B0aW9uPkV1bGVyIGE8L29wdGlvbj48b3B0aW9uPkV1bGVyPC9vcHRpb24+PG9wdGlvbj5MTVM8L29wdGlvbj48b3B0aW9uPkxNUyBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRESU08L29wdGlvbj48b3B0aW9uPkxDTTwvb3B0aW9uPjxvcHRpb24+SGV1bjwvb3B0aW9uPjxvcHRpb24+RFBNIGZhc3Q8L29wdGlvbj48b3B0aW9uPkRQTTI8L29wdGlvbj48b3B0aW9uPkRQTTIgYTwvb3B0aW9uPjxvcHRpb24+RFBNMiBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTTIgYSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJTIGE8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNPC9vcHRpb24+PG9wdGlvbj5EUE0rKyBTREU8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJTIGEgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIFNERSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNERSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPlJlc3RhcnQ8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNERSBFeHBvbmVudGlhbDwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0RFIEhldW48L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNERSBIZXVuIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0RFIEhldW4gRXhwb25lbnRpYWw8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNHTSBVbmlmb3JtPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAzTSBTREU8L29wdGlvbj48b3B0aW9uPkRQTSsrIDNNIFNERSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIDNNIFNERSBFeHBvbmVudGlhbDwvb3B0aW9uPjxvcHRpb24+ZXVsZXJfZHk8L29wdGlvbj48b3B0aW9uPmV1bGVyX3NtZWFfZHk8L29wdGlvbj4KICAgICAgICAgICAgICA8L3NlbGVjdD48L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+U2NoZWR1bGVyPC9sYWJlbD4KICAgICAgICAgICAgICA8c2VsZWN0IGlkPSJzY2hlZCIgY2xhc3M9ImlucCB0ZXh0LXhzIj48b3B0aW9uPm5vcm1hbDwvb3B0aW9uPjxvcHRpb24+c2ltcGxlPC9vcHRpb24+PG9wdGlvbj5rYXJyYXM8L29wdGlvbj48b3B0aW9uPmV4cG9uZW50aWFsPC9vcHRpb24+PG9wdGlvbj5zZ21fdW5pZm9ybTwvb3B0aW9uPjxvcHRpb24+ZGRpbV91bmlmb3JtPC9vcHRpb24+PG9wdGlvbj5iZXRhPC9vcHRpb24+PG9wdGlvbj5saW5lYXJfcXVhZHJhdGljPC9vcHRpb24+PC9zZWxlY3Q+PC9kaXY+CiAgICAgICAgICA8L2Rpdj4KPGRpdiBjbGFzcz0ic3BhY2UteS0zIG10LTMiPgogICAgICAgICAgICA8ZGl2PgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2FtcGxpbmcgU3RlcHM8L3NwYW4+PHNwYW4gaWQ9InN2IiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MTA8L3NwYW4+PC9sYWJlbD4KICAgICAgICAgICAgICA8aW5wdXQgaWQ9InN0ZXBzIiB0eXBlPSJyYW5nZSIgbWluPSIxIiBtYXg9IjUwIiB2YWx1ZT0iMTAiIGNsYXNzPSJzbGlkZXIgbXQtMSIvPgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgPGRpdj4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNGRyBTY2FsZTwvc3Bhbj48c3BhbiBpZD0iY2Z2IiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MTwvc3Bhbj48L2xhYmVsPgogICAgICAgICAgICAgIDxpbnB1dCBpZD0iY2ZnIiB0eXBlPSJyYW5nZSIgbWluPSIxIiBtYXg9IjEwIiBzdGVwPSIwLjUiIHZhbHVlPSIxIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TZWVkPC9zcGFuPjxidXR0b24gaWQ9ImRpY2UiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUiPjxpIGRhdGEtaWNvbj0iZGljZS1maXZlIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGlucHV0IGlkPSJzZWVkIiBjbGFzcz0iaW5wIHRleHQteHMgbXQtMSIgdmFsdWU9IjEwMTA5MzMzNDc5NDM0NjIiLz4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgaWQ9ImFkdi1maWVsZHMiIGNsYXNzPSJoaWRkZW4gc3BhY2UteS0zIG10LTQgYm9yZGVyLXQgYmQgcHQtMyI+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DbGlwIFNraXA8L3NwYW4+PHNwYW4gaWQ9ImNzdiIgY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPjI8L3NwYW4+PC9sYWJlbD4KICAgICAgICAgICAgICA8aW5wdXQgaWQ9ImNsaXBza2lwIiB0eXBlPSJyYW5nZSIgbWluPSIxIiBtYXg9IjEyIiB2YWx1ZT0iMiIgY2xhc3M9InNsaWRlciBtdC0xIi8+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8ZGl2PgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+RU5TRDwvc3Bhbj48c3BhbiBpZD0iZW5zZCIgY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPjMxMzM3PC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGlucHV0IGlkPSJldGFuc2QiIHR5cGU9InJhbmdlIiBtaW49IjAiIG1heD0iMzEzMzciIHZhbHVlPSIzMTMzNyIgY2xhc3M9InNsaWRlciBtdC0xIi8+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CgogICAgICAgIDwhLS0gVXBzY2FsZSAoc2VwYXJhdGUsIGRpIGJhd2FoKSAtLT4KICAgICAgICA8ZGl2IGNsYXNzPSJtdC00Ij4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiBpdGVtcy1jZW50ZXIiPjxzcGFuPlVwc2NhbGU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPjJ4PC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgaWQ9InVwc2NhbGUiIHR5cGU9InJhbmdlIiBtaW49IjEiIG1heD0iNCIgc3RlcD0iMC41IiB2YWx1ZT0iMiIgY2xhc3M9InNsaWRlciBtdC0xIi8+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBBUEkgU2V0dGluZ3MgLS0+CiAgICAgIDxkaXYgY2xhc3M9ImJvcmRlciBiZCByb3VuZGVkLXhsIGJnLVsjMWMyMTI4XSBwLTMgc3BhY2UteS0yIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4iPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+QVBJPC9zcGFuPgogICAgICAgICAgPHNwYW4gaWQ9ImFwaS1zdGF0dXMiIGNsYXNzPSJ0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNTAwIj48L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIj5Qcm92aWRlcjwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJhcGlwcm92aWRlciIgY2xhc3M9ImlucCB0ZXh0LXhzIj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0idGFtcyI+VGVuc29yLkFydCAoVEFNUyk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icmVwbGljYXRlIj5SZXBsaWNhdGUgKFNEWEwpPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImZhbCI+ZmFsLmFpIChmYXN0LXNkeGwpPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9InBvbGxpbmF0aW9ucyI+UG9sbGluYXRpb25zIChHUkFUSVMsIHRhbnBhIGtleSk8L29wdGlvbj4KICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIiBpZD0iYXBpa2V5LWZpZWxkIj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCIgaWQ9ImFwaWtleS1sYWJlbCI+QVBJIEtleSBUQU1TICh0YW1zLnRlbnNvci5hcnQpPC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCBpZD0iYXBpa2V5IiB0eXBlPSJwYXNzd29yZCIgY2xhc3M9ImlucCIgcGxhY2Vob2xkZXI9IkJlYXJlciB0b2tlbi4uLiIgYXV0b2NvbXBsZXRlPSJvZmYiLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8IS0tIEJZT1AgUG9sbGluYXRpb25zOiBsb2dpbiBPQXV0aCAoYnVrYW4ga29sb20gQVBJIGtleSkgLS0+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQgaGlkZGVuIiBpZD0iYnlvcC1yb3ciPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIj5Mb2dpbiBQb2xsaW5hdGlvbnM8L2xhYmVsPgogICAgICAgICAgPGJ1dHRvbiBpZD0iYnlvcC1sb2dpbiIgY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOCBib3JkZXIgYmQgdGV4dC14cyBqdXN0aWZ5LWNlbnRlciI+TG9naW4gZGVuZ2FuIFBvbGxpbmF0aW9ucyAoQllPUCk8L2J1dHRvbj4KICAgICAgICAgIDxkaXYgaWQ9ImJ5b3Atc3RhdHVzIiBjbGFzcz0iaGlkZGVuIHRleHQtWzEwcHhdIHRleHQtbmV1dHJhbC01MDAgbXQtMSI+PC9kaXY+CiAgICAgICAgICA8YnV0dG9uIGlkPSJieW9wLWxvZ291dCIgY2xhc3M9ImhpZGRlbiBidG4gYnRuLWdob3N0IHctZnVsbCBoLTggYm9yZGVyIGJkIHRleHQteHMganVzdGlmeS1jZW50ZXIgbXQtMSI+TG9nb3V0PC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBpZD0iYXBpLWhpbnQiIGNsYXNzPSJ0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNjAwIj48L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAiPk1vZGU8L2xhYmVsPgogICAgICAgICAgPHNlbGVjdCBpZD0iYXBpbW9kZSIgY2xhc3M9ImlucCB0ZXh0LXhzIj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYXV0byI+QXV0byAoYmFja2VuZCAmcmFycjsgZGVtbyk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icmVhbCI+UmVhbCBBUEkgKHdhamliIGJhY2tlbmQpPC9vcHRpb24+CiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImRlbW8iPkRlbW8gKHNpbXVsYXNpIHNhamEpPC9vcHRpb24+CiAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGdhcC0yIj4KICAgICAgICAgIDxidXR0b24gaWQ9ImFwaS1zYXZlIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBmbGV4LTEgaC04IGJvcmRlciBiZCB0ZXh0LXhzIj5TaW1wYW48L2J1dHRvbj4KICAgICAgICAgIDxidXR0b24gaWQ9ImFwaS10ZXN0IiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBmbGV4LTEgaC04IGJvcmRlciBiZCB0ZXh0LXhzIj5UZXM8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIEJvdHRvbSAtLT4KICAgICAgPGRpdiBjbGFzcz0icHQtMSBib3JkZXItdCBiZCBzcGFjZS15LTIiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOSBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlBhc3RlIEdlbmVyYXRpb24gRGF0YTwvc3Bhbj48aSBkYXRhLWljb249ImNsaXBib2FyZCIgY2xhc3M9InctNCBoLTQiPjwvaT48L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IHctZnVsbCBoLTkganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5QcmVzZXRzPC9zcGFuPjxpIGRhdGEtaWNvbj0iYm9va21hcmstc2ltcGxlIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOSBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlJlc2V0PC9zcGFuPjxpIGRhdGEtaWNvbj0ia2V5IiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIDwvYXNpZGU+CgogIDwhLS0gQ0VOVEVSOiBpbWFnZSBncmlkIG9ubHkgLS0+CiAgPG1haW4gaWQ9ImNhbnZhcyIgY2xhc3M9ImZsZXgtMSBvdmVyZmxvdy15LWF1dG8gaGlkZWJhciBiZy1bIzBkMTExN10iPgogICAgPGRpdiBjbGFzcz0icC00IG1heC13LTN4bCBteC1hdXRvIj4KCiAgICAgIDwhLS0gUHJvbXB0IGJhciAoVGVuc29yLkFydDogZGkgdGVuZ2FoIGF0YXMsIGRpIGF0YXMgZ3JpZCBnYW1iYXIpIC0tPgogICAgICA8ZGl2IGlkPSJwcm9tcHRiYXIiIGNsYXNzPSJtYi00IHJvdW5kZWQtMnhsIGJvcmRlciBiZCBiZy1bIzE2MWIyMl0gb3ZlcmZsb3ctaGlkZGVuIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLXN0YXJ0IGdhcC0yIHB4LTQgcHQtMyI+CiAgICAgICAgICA8dGV4dGFyZWEgaWQ9InByb21wdCIgcm93cz0iMyIgY2xhc3M9InctZnVsbCBiZy10cmFuc3BhcmVudCBib3JkZXItMCBvdXRsaW5lLW5vbmUgcmVzaXplLW5vbmUgdGV4dC1bMTVweF0gdGV4dC1uZXV0cmFsLTEwMCBwbGFjZWhvbGRlci1uZXV0cmFsLTYwMCBsZWFkaW5nLXJlbGF4ZWQiIHBsYWNlaG9sZGVyPSJKZWxhc2thbiBhcGEgeWFuZyBpbmdpbiBrYW11IGJ1YXQuLi4iPjwvdGV4dGFyZWE+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIGdhcC0yIGZsZXgtd3JhcCBweC0zIHB5LTIgYm9yZGVyLXQgYmQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41IGN1cnNvci1wb2ludGVyIHNlbGVjdC1ub25lIj4KICAgICAgICAgICAgPGlucHV0IGlkPSJuZWdjaGVjayIgdHlwZT0iY2hlY2tib3giIGNsYXNzPSJhY2NlbnQtWyM2RjVERkZdIi8+CiAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAiPk5lZ2F0aXZlPC9zcGFuPgogICAgICAgICAgPC9sYWJlbD4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0yIGZsZXgtd3JhcCBqdXN0aWZ5LWVuZCI+CiAgICAgICAgICAgIDxidXR0b24gaWQ9ImJ0bi1lbmhhbmNlIiBjbGFzcz0idGV4dC14cyB0ZXh0LVsjNkY1REZGXSBob3Zlcjp1bmRlcmxpbmUgZm9udC1tZWRpdW0gZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEiPjxpIGRhdGEtaWNvbj0ic3BhcmtsZSIgY2xhc3M9InctMy41IGgtMy41Ij48L2k+RW5oYW5jZTwvYnV0dG9uPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0iY2hpcCIgaWQ9ImNoaXAtYTExMTEiPkExMTExPC9zcGFuPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0iY2hpcCIgaWQ9ImNoaXAtZWxsYSI+RWxsYTwvc3Bhbj4KICAgICAgICAgICAgPHNlbGVjdCBpZD0ibmNvdW50IiBjbGFzcz0iaW5wIHctWzUuNHJlbV0gdGV4dC14cyBoLTgiIHRpdGxlPSJKdW1sYWggZ2FtYmFyIj4KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIxIiBzZWxlY3RlZD4xIGltYWdlPC9vcHRpb24+CiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iMiI+MiBpbWFnZXM8L29wdGlvbj4KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSI0Ij40IGltYWdlczwvb3B0aW9uPgogICAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0iYnRuLWdvMiIgY2xhc3M9ImJ0biBidG4tZ2VuIGgtOSBweC00IHdoaXRlc3BhY2Utbm93cmFwIj48aSBkYXRhLWljb249ImxpZ2h0bmluZyIgY2xhc3M9InctNCBoLTQiPjwvaT5HZW5lcmF0ZSA8c3BhbiBjbGFzcz0idGV4dC14cyBvcGFjaXR5LTkwIGZvbnQtbm9ybWFsIj4tIDEuMjI8L3NwYW4+PC9idXR0b24+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJuZWd3cmFwIiBjbGFzcz0iaGlkZGVuIGJvcmRlci10IGJkIHB4LTQgcHktMyI+CiAgICAgICAgICA8dGV4dGFyZWEgaWQ9Im5lZ3Byb21wdCIgcm93cz0iMiIgY2xhc3M9InctZnVsbCBiZy10cmFuc3BhcmVudCBib3JkZXItMCBvdXRsaW5lLW5vbmUgcmVzaXplLW5vbmUgdGV4dC1bMTNweF0gdGV4dC1uZXV0cmFsLTEwMCBwbGFjZWhvbGRlci1uZXV0cmFsLTYwMCIgcGxhY2Vob2xkZXI9Ik5lZ2F0aXZlIHByb21wdC4uLiI+PC90ZXh0YXJlYT4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIEltZzJJbWcgdXBsb2FkIC0tPgogICAgICA8ZGl2IGlkPSJpbWcyaW1nLWNhcmQiIGNsYXNzPSJoaWRkZW4gbWItNCBib3JkZXIgYmQgcm91bmRlZC14bCBiZy1bIzE2MWIyMl0gcC00Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gbWItMiI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5JbWcySW1nIOKAlCBnYW1iYXIgYXdhbDwvc3Bhbj4KICAgICAgICAgIDxzcGFuIGlkPSJpMmktY2xlYXIiIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgaG92ZXI6dGV4dC13aGl0ZSBjdXJzb3ItcG9pbnRlciI+SGFwdXM8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBpZD0iaTJpLWRyb3AiIGNsYXNzPSJib3JkZXItMiBib3JkZXItZGFzaGVkIGJkIHJvdW5kZWQteGwgcC02IHRleHQtY2VudGVyIGN1cnNvci1wb2ludGVyIHRleHQtbmV1dHJhbC01MDAgaG92ZXI6Ym9yZGVyLVsjNkY1REZGXSB0ZXh0LXhzIj4KICAgICAgICAgIEtsaWsgYXRhdSBzZXJldCBnYW1iYXIga2Ugc2luaQogICAgICAgIDwvZGl2PgogICAgICAgIDxpbnB1dCBpZD0iaTJpLWZpbGUiIHR5cGU9ImZpbGUiIGFjY2VwdD0iaW1hZ2UvKiIgY2xhc3M9ImhpZGRlbiIvPgogICAgICAgIDxkaXYgaWQ9ImkyaS1wcmV2aWV3IiBjbGFzcz0iaGlkZGVuIG10LTMiPgogICAgICAgICAgPGltZyBpZD0iaTJpLWltZyIgY2xhc3M9InctNDAgaC00MCBvYmplY3QtY292ZXIgcm91bmRlZC1sZyBib3JkZXIgYmQiIGFsdD0iIi8+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0ibXQtMyI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkRlbm9pc2luZyBTdHJlbmd0aDwvc3Bhbj48c3BhbiBpZD0iaTJpLWRzdiIgY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPjAuNTA8L3NwYW4+PC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCBpZD0iaTJpLWRzIiB0eXBlPSJyYW5nZSIgbWluPSIwIiBtYXg9IjEiIHN0ZXA9IjAuMDUiIHZhbHVlPSIwLjUiIGNsYXNzPSJzbGlkZXIgbXQtMSIvPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDwhLS0gVGFiIHBsYWNlaG9sZGVyIChFZGl0L1ZpZGVvL1ByaW1lKSAtLT4KICAgICAgPGRpdiBpZD0idGFiLXBsYWNlaG9sZGVyIiBjbGFzcz0iaGlkZGVuIGZsZXgtY29sIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBoLVs1MHZoXSB0ZXh0LW5ldXRyYWwtNjAwIj4KICAgICAgICA8aSBkYXRhLWljb249ImhvdXJnbGFzcy1tZWRpdW0iIGNsYXNzPSJ3LTEyIGgtMTIgbWItMyI+PC9pPgogICAgICAgIDxwIGNsYXNzPSJ0ZXh0LXNtIiBpZD0idGFiLXBsYWNlaG9sZGVyLXRleHQiPlRhYiBpbmkgc2VnZXJhIGhhZGlyPC9wPgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgaWQ9ImVtcHR5IiBjbGFzcz0iZmxleCBmbGV4LWNvbCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgaC1bNjB2aF0gdGV4dC1uZXV0cmFsLTYwMCI+CiAgICAgICAgPGkgZGF0YS1pY29uPSJpbWFnZS1zcXVhcmUiIGNsYXNzPSJ3LTE0IGgtMTQgbWItMyI+PC9pPgogICAgICAgIDxwIGNsYXNzPSJ0ZXh0LXNtIj5IYXNpbCBnZW5lcmF0ZSBha2FuIHRhbXBpbCBkaSBzaW5pPC9wPgogICAgICAgIDxwIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC03MDAgbXQtMSI+SXNpIHByb21wdCBsYWx1IHRla2FuIEdlbmVyYXRlPC9wPgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBpZD0iZ3JpZCIgY2xhc3M9ImdyaWQgZ3JpZC1jb2xzLTEgZ2FwLTMiPjwvZGl2PgogICAgPC9kaXY+CiAgPC9tYWluPgoKICA8IS0tIFJJR0hUIFBBTkVMIC0tPgogIDxhc2lkZSBpZD0icmlnaHRQYW4iIGNsYXNzPSJ3LVsyMXJlbV0gc2hyaW5rLTAgYm9yZGVyLWwgYmQgYmctWyMxNjFiMjJdIGhpZGRlbiBsZzpmbGV4IGZsZXgtY29sIj4KICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBweC0zIHB5LTIgYm9yZGVyLWIgYmQiPgogICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5HZW5lcmF0aW9uIEhpc3Rvcnk8L3NwYW4+CiAgICAgIDxkaXYgY2xhc3M9ImZsZXggZ2FwLTEiPgogICAgICAgIDxidXR0b24gY2xhc3M9InJ0YWIgc2VsIiBkYXRhLWY9ImFsbCI+QWxsPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0icnRhYiIgZGF0YS1mPSJpbWFnZSI+SW1hZ2U8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJydGFiIiBkYXRhLWY9InZpZGVvIj5WaWRlbzwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9InJ0YWIiIGRhdGEtZj0iYXVkaW8iPkF1ZGlvPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBweC0zIHB5LTEuNSBib3JkZXItYiBiZCB0ZXh0LW5ldXRyYWwtNTAwIj4KICAgICAgPGJ1dHRvbiBjbGFzcz0iaC03IHctNyBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUiIHRpdGxlPSJLZWxvbGEiPjxpIGRhdGEtaWNvbj0ic2xpZGVycy1ob3Jpem9udGFsIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgICA8c3BhbiBjbGFzcz0ibXgtYXV0byB0ZXh0LXhzIiBpZD0icmNvdW50Ij4wIGhhc2lsPC9zcGFuPgogICAgICA8YnV0dG9uIGNsYXNzPSJoLTcgdy03IGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHRleHQtbmV1dHJhbC01MDAgaG92ZXI6dGV4dC13aGl0ZSIgdGl0bGU9IlJlbG9hZCI+PGkgZGF0YS1pY29uPSJhcnJvd3MtY2xvY2t3aXNlIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8ZGl2IGlkPSJybGlzdCIgY2xhc3M9ImZsZXgtMSBvdmVyZmxvdy15LWF1dG8gaGlkZWJhciBwLTIgc3BhY2UteS0zIj48L2Rpdj4KICA8L2FzaWRlPgo8L2Rpdj4KCjwhLS0gTW9iaWxlIGhpc3RvcnkgdG9nZ2xlIC0tPgo8YnV0dG9uIGlkPSJidG4taGlzdG9yeSIgY2xhc3M9ImxnOmhpZGRlbiBmaXhlZCBib3R0b20tNCByaWdodC00IHotMzAgYnRuIGJ0bi1ibHVlIGgtMTEgcHgtNCI+PGkgZGF0YS1pY29uPSJjbG9jay1jb3VudGVyLWNsb2Nrd2lzZSIgY2xhc3M9InctNCBoLTQiPjwvaT4gUml3YXlhdDwvYnV0dG9uPgoKPCEtLSA9PT09PT09PT09PT0gUFJPR1JFU1MgT1ZFUkxBWSA9PT09PT09PT09PT0gLS0+CjxkaXYgaWQ9InByb2dvdmVybGF5IiBjbGFzcz0iaGlkZGVuIGZpeGVkIGluc2V0LTAgei0zMCBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBiZy1ibGFjay81MCBwLTQiIHN0eWxlPSJ0b3A6NTZweCI+CiAgPGRpdiBjbGFzcz0idy1mdWxsIG1heC13LXNtIGJnLVsjMTYxYjIyXSBib3JkZXIgYmQgcm91bmRlZC0yeGwgcC01IHNwYWNlLXktMyI+CiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4iPgogICAgICA8c3BhbiBpZD0icHJvZy10aXRsZSIgY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+R2VuZXJhdGluZy4uLjwvc3Bhbj4KICAgICAgPGJ1dHRvbiBpZD0icHJvZy1jYW5jZWwiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgdGV4dC1sZyBsZWFkaW5nLW5vbmUiIHRpdGxlPSJCYXRhbCI+4pyVPC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InJlbGF0aXZlIGgtMiBiZy1bIzFjMjEyOF0gcm91bmRlZC1mdWxsIG92ZXJmbG93LWhpZGRlbiI+CiAgICAgIDxkaXYgaWQ9InByb2ctYmFyIiBjbGFzcz0iYWJzb2x1dGUgaW5zZXQteS0wIGxlZnQtMCB3LTAgcm91bmRlZC1mdWxsIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiwjMjdENENEKTt0cmFuc2l0aW9uOndpZHRoIC40cyI+PC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiB0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAiPgogICAgICA8c3BhbiBpZD0icHJvZy1zdGF0dXMiPk1lbmdpcmltIHRhc2suLi48L3NwYW4+CiAgICAgIDxzcGFuIGlkPSJwcm9nLXBjdCI+MCU8L3NwYW4+CiAgICA8L2Rpdj4KICA8L2Rpdj4KPC9kaXY+Cgo8IS0tID09PT09PT09PT09PSBMSUdIVEJPWCA9PT09PT09PT09PT0gLS0+CjxkaXYgaWQ9ImxpZ2h0Ym94IiBjbGFzcz0iZml4ZWQgaW5zZXQtMCB6LTUwIGhpZGRlbiBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcC00IGJnLWJsYWNrLzgwIj4KICA8ZGl2IGNsYXNzPSJyZWxhdGl2ZSBtYXgtdy0zeGwgdy1mdWxsIGJnLVsjMTYxYjIyXSBib3JkZXIgYmQgcm91bmRlZC0yeGwgb3ZlcmZsb3ctaGlkZGVuIj4KICAgIDxidXR0b24gaWQ9ImxiLWNsb3NlIiBjbGFzcz0iYWJzb2x1dGUgdG9wLTIgcmlnaHQtMiB6LTEwIHctOSBoLTkgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC13aGl0ZSBob3ZlcjpiZy13aGl0ZS8xMCByb3VuZGVkLWxnIHRleHQteGwiPuKclTwvYnV0dG9uPgogICAgPGltZyBpZD0ibGItaW1nIiBjbGFzcz0idy1mdWxsIG1heC1oLVs2MHZoXSBvYmplY3QtY29udGFpbiBiZy1ibGFjayIgYWx0PSIiLz4KICAgIDxkaXYgaWQ9ImxiLW1ldGEiIGNsYXNzPSJwLTQgc3BhY2UteS0xLjUgdGV4dC14cyB0ZXh0LW5ldXRyYWwtNDAwIG92ZXJmbG93LXktYXV0byBtYXgtaC1bMzB2aF0iPjwvZGl2PgogIDwvZGl2Pgo8L2Rpdj4KCjwhLS0gPT09PT09PT09PT09IFRPQVNUID09PT09PT09PT09PSAtLT4KPGRpdiBpZD0idG9hc3QiIGNsYXNzPSJmaXhlZCBib3R0b20tMjAgbGVmdC0xLzIgLXRyYW5zbGF0ZS14LTEvMiB6LTUwIGhpZGRlbiBiZy1bIzFjMjEyOF0gYm9yZGVyIGJkIHJvdW5kZWQteGwgcHgtNCBweS0yLjUgdGV4dC1zbSBzaGFkb3ctbGcgbWF4LXctWzg1dnddIj48L2Rpdj4KCjwhLS0gPT09PT09PT09PT09IFNFTEVDVE9SIE1PREFMID09PT09PT09PT09PSAtLT4KPGRpdiBpZD0ibW9kYWwiIGNsYXNzPSJmaXhlZCBpbnNldC0wIGJnLWJsYWNrLzYwIHotNTAgaGlkZGVuIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBwLTQiPgogIDxkaXYgY2xhc3M9InctZnVsbCBtYXgtdy01eGwgYmctWyMxNjFiMjJdIGJvcmRlciBiZCByb3VuZGVkLTJ4bCBvdmVyZmxvdy1oaWRkZW4iPgogICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIHB4LTQgcHQtMyBwYi0yIGJvcmRlci1iIGJkIj4KICAgICAgPGRpdiBpZD0ibW9kYWwtdGFicyIgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xIj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJtdGFiIHNlbCIgZGF0YS1tdGFiPSJiYXNpYyI+QmFzaWMgTW9kZWw8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJtdGFiIiBkYXRhLW10YWI9InN0YXJyZWQiPk15IFN0YXJyZWQ8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJtdGFiIiBkYXRhLW10YWI9Im15bW9kZWxzIj5NeSBNb2RlbHM8L2J1dHRvbj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0yIj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZWxhdGl2ZSI+CiAgICAgICAgICA8aSBkYXRhLWljb249Im1hZ25pZnlpbmctZ2xhc3MiIGNsYXNzPSJ3LTQgaC00IGFic29sdXRlIGxlZnQtMyB0b3AtMS8yIC10cmFuc2xhdGUteS0xLzIgdGV4dC1uZXV0cmFsLTUwMCI+PC9pPgogICAgICAgICAgPGlucHV0IGlkPSJtc2VhcmNoIiBjbGFzcz0iaW5wIHBsLTkgdy01NiBoLTkiIHBsYWNlaG9sZGVyPSJTZWFyY2guLi4iLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8YnV0dG9uIGlkPSJtZmlsdGVycyIgY2xhc3M9ImJ0biBidG4tZ2hvc3QgaC05IHB4LTMgYm9yZGVyIGJkIHRleHQteHMgc2hyaW5rLTAiPjxpIGRhdGEtaWNvbj0ic2xpZGVycy1ob3Jpem9udGFsIiBjbGFzcz0idy00IGgtNCI+PC9pPkZpbHRlcnM8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGlkPSJtb2RhbC1jbG9zZSIgY2xhc3M9InctOSBoLTkgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC13aGl0ZSBob3ZlcjpiZy1bIzFjMjEyOF0gcm91bmRlZC1sZyB0ZXh0LXhsIGxlYWRpbmctbm9uZSIgdGl0bGU9IlR1dHVwIj7inJU8L2J1dHRvbj4KICAgICAgICA8aDMgaWQ9Im1vZGFsLXRpdGxlIiBjbGFzcz0iaGlkZGVuIGZvbnQtc2VtaWJvbGQgdGV4dC1zbSI+UGlsaWggTW9kZWw8L2gzPgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0ibWNhdCIgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUgcHgtNCBweS0yIGhpZGViYXIgb3ZlcmZsb3cteC1hdXRvIj48L2Rpdj4KICAgIDxkaXYgaWQ9Im1vZGFsLWJvZHkiIGNsYXNzPSJtYXgtaC1bNTV2aF0gb3ZlcmZsb3cteS1hdXRvIHAtNCI+PC9kaXY+CiAgPC9kaXY+CjwvZGl2PgoKCjxzY3JpcHQ+CmNvbnN0ICQgPSBpZCA9PiBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CmNvbnN0IFMgPSAnaHR0cHM6Ly9waWNzdW0ucGhvdG9zL3NlZWQvJzsKY29uc3Qgc3RhdGUgPSB7IHJlc3VsdHM6W10sIHBhZ2U6J3RleHQnLCBhc3BlY3Q6J3BvcnRyYWl0JywgbmNvbDoxLCBtb2RlbDpudWxsIH07CgovKiA9PT09PSBMb1JBIOKAlCBkYWZ0YXIgYXNsaSBwZXIgcHJvdmlkZXIgPT09PT0gKi8KdmFyIExPUkFfTElCUyA9IHsKICB0YW1zOiBbCiAgICB7IG5hbWU6J1otSW1hZ2UgTG9SQSB8IERldGFpbCcsIHRhZ3M6WydkZXRhaWxlZCcsJ3NoYXJwJ10sIHRodW1iOidhZnJvJywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMTJLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sCiAgICB7IG5hbWU6J1otSW1hZ2UgVHVyYm8nLCB0YWdzOlsndHVyYm8nLCdmYXN0J10sIHRodW1iOidyZXRybycsIGJhZGdlOidaLUlNQUdFLVRVUkJPJywgdmlld3M6JzhLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sCiAgICB7IG5hbWU6J1otSW1hZ2UgSERSJywgdGFnczpbJ2hkcicsJ3ZpdmlkJ10sIHRodW1iOidoZHInLCBiYWRnZTonWi1JTUFHRScsIHZpZXdzOicxNUsnLCB2ZXI6J1YxJywgYmFzZTonWiBJbWFnZScgfSwKICAgIHsgbmFtZTonWi1JbWFnZSBQb3J0cmFpdCcsIHRhZ3M6Wydwb3J0cmFpdCcsJ2Jva2VoJ10sIHRodW1iOidwdHJ0JywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMjJLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sCiAgICB7IG5hbWU6J1otSW1hZ2UgQXJ0aXN0aWMnLCB0YWdzOlsnYXJ0aXN0aWMnLCdwYWludCddLCB0aHVtYjonYXJ0JywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMThLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sCiAgICB7IG5hbWU6J0ZsdXggUmVhbGlzbSBMb1JBJywgdGFnczpbJ3JlYWxpc3RpYycsJ3Bob3RvJ10sIHRodW1iOidmbHV4bCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzQ1SycsIHZlcjonVjEnLCBiYXNlOidGTFVYLjEnIH0sCiAgICB7IG5hbWU6J0ZsdXggQ2luZW1hdGljIExvUkEnLCB0YWdzOlsnY2luZW1hdGljJywnbW9vZHknXSwgdGh1bWI6J2ZsdXhjJywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonMzNLJywgdmVyOidWMScsIGJhc2U6J0ZMVVguMScgfSwKICAgIHsgbmFtZTonU0RYTCBGaW5lIERldGFpbCcsIHRhZ3M6WydkZXRhaWxlZCcsJ3NoYXJwJ10sIHRodW1iOidkZXRhaWwnLCBiYWRnZTonU0RYTCcsIHZpZXdzOic1MDBLJywgdmVyOidWMScsIGJhc2U6J1NEWEwnIH0sCiAgICB7IG5hbWU6J1NEWEwgQW5pbWUgU3R5bGUnLCB0YWdzOlsnYW5pbWUnLCdjZWwnXSwgdGh1bWI6J2FuaW1lc2wnLCBiYWRnZTonU0RYTCcsIHZpZXdzOicyODBLJywgdmVyOidWMScsIGJhc2U6J1NEWEwnIH0sCiAgICB7IG5hbWU6J1BvbnkgRXF1ZXN0cmlhbiBBcnQnLCB0YWdzOlsncG9ueScsJ2ZhbnRhc3knXSwgdGh1bWI6J3BvbnlsJywgYmFkZ2U6J1BPTlknLCB2aWV3czonMTUwSycsIHZlcjonVjEnLCBiYXNlOidQb255JyB9LAogICAgeyBuYW1lOidOaXBwb24tQ29yZSBSZXRybyAtIHYwLjEnLCB0YWdzOlsnamFwcmV0cjdjb21tJywncmV0cm8gbWFnYXppbmUnXSwgdGh1bWI6J2JpbGliaW4nLCBiYWRnZTonU1RZTEUnLCB2aWV3czonOTZLJywgdmVyOidWLjEnLCBiYXNlOidTRFhMJyB9LAogICAgeyBuYW1lOidJdmFuIEJpbGliaW4gLSB2MC43JywgdGFnczpbJ2l2YW5iaWxpYmluNXonLCdpbGx1c3RyYXRpb24nLCdhcnQgZGVjbyddLCB0aHVtYjonZGV0YWlsJywgYmFkZ2U6J0lMTFVTVFJBVElPTicsIHZpZXdzOicxNTRLJywgdmVyOidWLjEnLCBiYXNlOidTRFhMJyB9LAogICAgeyBuYW1lOidEZXRhaWwgVHdlYWtlciAtIHYxLjAnLCB0YWdzOlsnZGV0YWlsZWQnXSwgdGh1bWI6J2dyYWluJywgYmFkZ2U6J1VUSUxJVFknLCB2aWV3czonMS4yTScsIHZlcjonVi4xJywgYmFzZTonU0RYTCcgfSwKICAgIHsgbmFtZTonRmlsbSBHcmFpbiAtIHYwLjUnLCB0YWdzOlsnZmlsbSBncmFpbicsJ2FuYWxvZyddLCB0aHVtYjonZ3JhaW4nLCBiYWRnZTonVVRJTElUWScsIHZpZXdzOic2N0snLCB2ZXI6J1YuMScsIGJhc2U6J1NEWEwnIH0sCiAgXSwKICByZXBsaWNhdGU6IFsKICAgIHsgbmFtZTonRkxVWC4xIFtzY2huZWxsXSBMb1JBJywgYmFzZTonRkxVWCcsIG1vZGVsOidibGFjay1mb3Jlc3QtbGFicy9mbHV4LXNjaG5lbGwtbG9yYScsIHRhZ3M6WydmbHV4LWxvcmEnXSwgdGh1bWI6J2ZsdXhsJywgYmFkZ2U6J0ZMVVgtTE9SQScsIHZpZXdzOicxMjBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogICAgeyBuYW1lOidGTFVYLjEgW2Rldl0gTG9SQScsIGJhc2U6J0ZMVVgnLCBtb2RlbDonYmxhY2stZm9yZXN0LWxhYnMvZmx1eC1kZXYtbG9yYScsIHRhZ3M6WydmbHV4LWxvcmEnXSwgdGh1bWI6J2ZsdXhkbCcsIGJhZGdlOidGTFVYLUxPUkEnLCB2aWV3czonOTBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogICAgeyBuYW1lOidTRFhMICsgTG9SQSBVUkwgKGN1c3RvbSknLCBiYXNlOidTRFhMJywgbW9kZWw6J3p5bGltMDcwMi9zZHhsLWxvcmEtY3VzdG9taXplLW1vZGVsJywgdGFnczpbJ2xvcmEnXSwgdGh1bWI6J3NkeGxsJywgYmFkZ2U6J1NEWEwtTE9SQScsIHZpZXdzOiczMTBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogICAgeyBuYW1lOidJS0VBIEluc3RydWN0aW9ucyAoU0RYTCwgYmF3YWFuKScsIGJhc2U6J1NEWEwnLCBtb2RlbDonb3N0cmlzL2lrZWEtaW5zdHJ1Y3Rpb25zLWxvcmEtc2R4bCcsIHRhZ3M6Wydpa2VhIGluc3RydWN0aW9ucyddLCB0aHVtYjonaWtlYScsIGJhZGdlOidTVFlMRScsIHZpZXdzOicyMTBLJywgdmVyOidWMScgfSwKICBdLAogIGZhbDogWwogICAgeyBuYW1lOidGTFVYIExvUkEnLCBiYXNlOidGTFVYJywgbW9kZWw6J2ZhbC1haS9mbHV4LWxvcmEnLCB0YWdzOlsnZmx1eC1sb3JhJ10sIHRodW1iOidmbHV4bCcsIGJhZGdlOidGTFVYLUxPUkEnLCB2aWV3czonMTUwSycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwKICAgIHsgbmFtZTonU0RYTCArIExvUkEgVVJMIChmYXN0LXNkeGwpJywgYmFzZTonU0RYTCcsIG1vZGVsOidmYWwtYWkvZmFzdC1zZHhsJywgdGFnczpbJ2xvcmEnXSwgdGh1bWI6J3NkeGxsJywgYmFkZ2U6J1NEWEwtTE9SQScsIHZpZXdzOicxMjBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LAogICAgeyBuYW1lOidLcmVhIDIgTG9SQSAodHVyYm8pJywgYmFzZTonS3JlYSAyJywgbW9kZWw6J2ZhbC1haS9rcmVhLTIvdHVyYm8vbG9yYScsIHRhZ3M6WydrcmVhMiddLCB0aHVtYjona3JlYScsIGJhZGdlOidLUkVBMi1MT1JBJywgdmlld3M6JzY2SycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwKICBdLAogIHBvbGxpbmF0aW9uczogW10sIC8vIExvUkEgdGlkYWsgZGlkdWt1bmcg4oCUIGdyYXRpcywgbW9kZWwgYmF3YWFuIHNhamEKfTsKdmFyIExPUkFfTElCID0gTE9SQV9MSUJTLnRhbXM7IC8vIGRhZnRhciBha3RpZiBtZW5naWt1dGkgcHJvdmlkZXIKY29uc3QgTE9SQSA9IFtdOwovKiA9PT09PSBNb2RlbCBtb2RhbCDigJQgZGFmdGFyIG1vZGVsIGFzbGkgcGVyIHByb3ZpZGVyID09PT09ICovCnZhciBNT0RFTF9MSUJTID0gewogIHRhbXM6IFsKICAgIHsgbmFtZTonWiBJbWFnZSAtIGJhc2UtYmYxNicsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonWiBJbWFnZScsIHRodW1iOid6aW1hZ2UnLCBiYWRnZTonWicsIHZpZXdzOic0NEsnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYyNTMyNjA2MDM4MDUnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjI1NDMzNDM2NjI0NScgfSwKICAgIHsgbmFtZTonRkxVWC4xIFtkZXZdJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidGTFVYLjEnLCB0aHVtYjonZmx1eCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzE1NEsnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYyODI2NDQ1MjUwNTYnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjI4MjY0NDUyNTA1NycgfSwKICAgIHsgbmFtZTonU3RhYmxlIERpZmZ1c2lvbiBYTCcsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonU0RYTCcsIHRodW1iOidzZHhsJywgYmFkZ2U6J1NEWEwgMS4wJywgdmlld3M6Jzg5MksnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYzMDkwMzIxMzY3MDQnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjMwOTAzMjEzNjcwNScgfSwKICAgIHsgbmFtZTonU3RhYmxlIERpZmZ1c2lvbiAzLjUgTWVkaXVtJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRCAzLjUnLCB0aHVtYjonc2QzNScsIGJhZGdlOidTRCAzLjUnLCB2aWV3czonMzEySycsIHZlcjonVi4xJywgbW9kZWxJZDonMTAyNzkwNjMxNzQ1MjgwODE5MicsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzE3NDUyODA4MTkzJyB9LAogICAgeyBuYW1lOidQb255IERpZmZ1c2lvbiBWNicsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonUG9ueScsIHRodW1iOidwb255JywgYmFkZ2U6J1BPTlknLCB2aWV3czonMi4xTScsIHZlcjonVjYnLCBtb2RlbElkOicxMDI3OTA2MzI2ODc0MjcxNzQ0JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzMjY4NzQyNzE3NDUnIH0sCiAgICB7IG5hbWU6J0lsbHVzdHJpb3VzIFhMJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidJbGx1c3RyaW91cycsIHRodW1iOidpbGx1c3QnLCBiYWRnZTonSUxMVVNUUklPVVMnLCB2aWV3czonNjdLJywgdmVyOidWLjEnLCBtb2RlbElkOicxMDI3OTA2MzM1NzgyNDE0MzM2JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzMzU3ODI0MTQzMzcnIH0sCiAgICB7IG5hbWU6J0FuaW1hJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidBbmltYScsIHRodW1iOidhbmltYScsIGJhZGdlOidBTklNQScsIHZpZXdzOic1MksnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYzNDQ3MTY3NzE4NDAnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM0NDcxNjc3MTg0MScgfSwKICAgIHsgbmFtZTonRHJlYW1TaGFwZXInLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonZHJlYW0nLCBiYWRnZTonRFMnLCB2aWV3czonODEySycsIHZlcjonVi41JywgbW9kZWxJZDonMTAyNzkwNjM1MzQ5OTQyOTg4OCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzUzNDk5NDI5ODg5JyB9LAogICAgeyBuYW1lOidSZWFsaXN0aWMgVmlzaW9uJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J3JlYWwnLCBiYWRnZTonUlYnLCB2aWV3czonNjQ1SycsIHZlcjonVi42LjAnLCBtb2RlbElkOicxMDI3OTA2MzYyNDEyNTMxNzEyJywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzNjI0MTI1MzE3MTMnIH0sCiAgICB7IG5hbWU6J0NvdW50ZXJmZWl0JywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J2NvdW50ZXInLCBiYWRnZTonQ09VTlRFUkZFSVQnLCB2aWV3czonNDIwSycsIHZlcjonVi41JywgbW9kZWxJZDonMTAyNzkwNjM3MTMzNDcyNzY4MCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzcxMzM0NzI3NjgxJyB9LAogICAgeyBuYW1lOidMeXJpZWwnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonbHlyaWVsJywgYmFkZ2U6J0xZUklFTCcsIHZpZXdzOiczMjBLJywgdmVyOidWLjEuNicsIG1vZGVsSWQ6JzEwMjc5MDYzNzk5OTYwMTM1NjgnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM3OTk5NjAxMzU2OScgfSwKICAgIHsgbmFtZTonSnVnZ2VybmF1dCcsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonU0RYTCcsIHRodW1iOidqdWcnLCBiYWRnZTonSlVHRycsIHZpZXdzOicyMTBLJywgdmVyOidWLjknLCBtb2RlbElkOicxMDI3OTA2Mzg4NDIxMDk5NTIwJywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzODg0MjEwOTk1MjEnIH0sCiAgXSwKICByZXBsaWNhdGU6IFsKICAgIHsgbmFtZTonRkxVWC4xIFtzY2huZWxsXScsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J0ZMVVgnLCB0aHVtYjonZmx1eCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzRNJywgdmVyOidWMScsIG1vZGVsOidibGFjay1mb3Jlc3QtbGFicy9mbHV4LXNjaG5lbGwnIH0sCiAgICB7IG5hbWU6J0ZMVVguMSBbZGV2XScsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J0ZMVVgnLCB0aHVtYjonZmx1eGQnLCBiYWRnZTonRkxVWCcsIHZpZXdzOicyLjFNJywgdmVyOidWMScsIG1vZGVsOidibGFjay1mb3Jlc3QtbGFicy9mbHV4LWRldicgfSwKICAgIHsgbmFtZTonU0RYTCAxLjAnLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J3NkeGwnLCBiYWRnZTonU0RYTCAxLjAnLCB2aWV3czonMS4yTScsIHZlcjonVjEnLCBtb2RlbDonc3RhYmlsaXR5LWFpL3NkeGwnIH0sCiAgICB7IG5hbWU6J1N0YWJsZSBEaWZmdXNpb24gMy41IExhcmdlJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0QgMy41JywgdGh1bWI6J3NkMzUnLCBiYWRnZTonU0QgMy41Jywgdmlld3M6JzEuNU0nLCB2ZXI6J1YxJywgbW9kZWw6J3N0YWJpbGl0eS1haS9zdGFibGUtZGlmZnVzaW9uLTMuNS1sYXJnZScgfSwKICAgIHsgbmFtZTonU0RYTCBMaWdodG5pbmcgNC1TdGVwJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0RYTCcsIHRodW1iOidsaWdodG5pbmcnLCBiYWRnZTonTElHSFROSU5HJywgdmlld3M6JzEuOE0nLCB2ZXI6J1YxJywgbW9kZWw6J2J5dGVkYW5jZS9zZHhsLWxpZ2h0bmluZy00c3RlcCcgfSwKICAgIHsgbmFtZTonUmVhbFZpc1hMIFY0LjAnLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J3JlYWwnLCBiYWRnZTonUkVBTElTVElDJywgdmlld3M6JzkwMEsnLCB2ZXI6J1Y0LjAnLCBtb2RlbDonbHVjYXRhY28vcmVhbHZpc3hsLXY0LjAnIH0sCiAgICB7IG5hbWU6J0p1Z2dlcm5hdXQgWEwgVjknLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J2p1ZycsIGJhZGdlOidKVUdHJywgdmlld3M6Jzc1MEsnLCB2ZXI6J1Y5JywgbW9kZWw6J2RpZ2lwbGF5L0p1Z2dlcm5hdXRfWExfdjknIH0sCiAgICB7IG5hbWU6J1NEWEwgRW1vamknLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J2Vtb2ppJywgYmFkZ2U6J0VNT0pJJywgdmlld3M6JzYwMEsnLCB2ZXI6J1YxJywgbW9kZWw6J2ZvZnIvc2R4bC1lbW9qaScgfSwKICBdLAogIGZhbDogWwogICAgeyBuYW1lOidGTFVYLjEgW3NjaG5lbGxdJywgYmFzZTonZmFsLmFpJywgYXJjaDonRkxVWCcsIHRodW1iOidmbHV4JywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonNU0nLCB2ZXI6J1YxJywgbW9kZWw6J2ZhbC1haS9mbHV4L3NjaG5lbGwnIH0sCiAgICB7IG5hbWU6J0ZMVVguMSBbZGV2XScsIGJhc2U6J2ZhbC5haScsIGFyY2g6J0ZMVVgnLCB0aHVtYjonZmx1eGQnLCBiYWRnZTonRkxVWCcsIHZpZXdzOiczTScsIHZlcjonVjEnLCBtb2RlbDonZmFsLWFpL2ZsdXgvZGV2JyB9LAogICAgeyBuYW1lOidGYXN0IFNEWEwnLCBiYXNlOidmYWwuYWknLCBhcmNoOidTRFhMJywgdGh1bWI6J2Zhc3RzZHhsJywgYmFkZ2U6J0ZBTCcsIHZpZXdzOicyLjVNJywgdmVyOidWMScsIG1vZGVsOidmYWwtYWkvZmFzdC1zZHhsJyB9LAogICAgeyBuYW1lOidTRFhMJywgYmFzZTonZmFsLmFpJywgYXJjaDonU0RYTCcsIHRodW1iOidzZHhsJywgYmFkZ2U6J1NEWEwgMS4wJywgdmlld3M6JzEuMU0nLCB2ZXI6J1YxJywgbW9kZWw6J2ZhbC1haS9zZHhsJyB9LAogICAgeyBuYW1lOidTdGFibGUgRGlmZnVzaW9uIDMuNSBMYXJnZScsIGJhc2U6J2ZhbC5haScsIGFyY2g6J1NEIDMuNScsIHRodW1iOidzZDM1JywgYmFkZ2U6J1NEIDMuNScsIHZpZXdzOic5MDBLJywgdmVyOidWMScsIG1vZGVsOidmYWwtYWkvc3RhYmxlLWRpZmZ1c2lvbi12MzUtbGFyZ2UnIH0sCiAgICB7IG5hbWU6J1BsYXlncm91bmQgdjIuNScsIGJhc2U6J2ZhbC5haScsIGFyY2g6J1NEWEwnLCB0aHVtYjoncGxheScsIGJhZGdlOidQTEFZJywgdmlld3M6JzcwMEsnLCB2ZXI6J1YyLjUnLCBtb2RlbDonZmFsLWFpL3BsYXlncm91bmQvdjIuNScgfSwKICAgIHsgbmFtZTonS3JlYSAyIFR1cmJvJywgYmFzZTonZmFsLmFpJywgYXJjaDonS3JlYSAyJywgdGh1bWI6J2tyZWEnLCBiYWRnZTonS1JFQTInLCB2aWV3czonMS4xTScsIHZlcjonVjInLCBtb2RlbDonZmFsLWFpL2tyZWEtMi90dXJibycgfSwKICBdLAogIHBvbGxpbmF0aW9uczogWwogICAgeyBuYW1lOidaLUltYWdlIFR1cmJvJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonQWxpYmFiYScsIHRodW1iOid6aW1hZ2UnLCBiYWRnZTonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J3ppbWFnZScgfSwKICAgIHsgbmFtZTonR1BUIEltYWdlIDInLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidPcGVuQUknLCB0aHVtYjonZ3B0JywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidncHQtaW1hZ2UtMicgfSwKICAgIHsgbmFtZTonRkxVWC4xIFNjaG5lbGwnLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidCbGFjayBGb3Jlc3QgTGFicycsIHRodW1iOidmbHV4JywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidmbHV4JyB9LAogICAgeyBuYW1lOidEcmVhbVNoYXBlciA4IExDTScsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0x5a29uJywgdGh1bWI6J2RyZWFtJywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidkcmVhbXNoYXBlcicgfSwKICAgIHsgbmFtZTonRkxVWC4yIEtsZWluIDRCJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonQmxhY2sgRm9yZXN0IExhYnMnLCB0aHVtYjona2xlaW4nLCBiYWRnZTonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J2tsZWluJyB9LAogICAgeyBuYW1lOidLcmVhIDIgTWVkaXVtJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonS3JlYScsIHRodW1iOidrcmVhJywgYmFkZ2U6J1BBSUQnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidrcmVhJyB9LAogICAgeyBuYW1lOidTZWVkcmVhbSA1LjAgTGl0ZScsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0J5dGVEYW5jZScsIHRodW1iOidzZWVkJywgYmFkZ2U6J1BBSUQnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidzZWVkcmVhbTUnIH0sCiAgICB7IG5hbWU6J1F3ZW4gSW1hZ2UgMycsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J1F3ZW4nLCB0aHVtYjoncXdlbicsIGJhZGdlOidQQUlEJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDoncXdlbi1pbWFnZS0zJyB9LAogICAgeyBuYW1lOidOYW5vIEJhbmFuYSAyJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonR29vZ2xlJywgdGh1bWI6J25hbm8nLCBiYWRnZTonUEFJRCcsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J25hbm9iYW5hbmEtMicgfSwKICBdLAp9Owp2YXIgTU9ERUxTID0gTU9ERUxfTElCUy50YW1zOyAvLyBkYWZ0YXIgYWt0aWYgbWVuZ2lrdXRpIHByb3ZpZGVyCnZhciBNQ0FUID0gWydUcnkgTm93JywnQUxMJywnT0ZGSUNJQUwgTU9ERUwnLCdNRU1FJywnRVhDTFVTSVZFJywnQkVBVVRZJywnM0QnLCcyLjVEJywnTUFMRScsJ0FOSU1FJywnUkVBTElTVElDJywnU1RZTEUnLCdHQU1FJywnREVTSUdOJywnU0NFTkVSWScsJ0JVSUxESU5HUycsJ01FQ0hBJ107CnZhciBfY3VyTGlzdD1bXSwgX2N1ck9uU2VsPWZ1bmN0aW9uKCl7fTsKZnVuY3Rpb24gcmVuZGVyQ2FyZHMobGlzdCwgb25TZWwpewogIF9jdXJMaXN0PWxpc3Q7IF9jdXJPblNlbD1vblNlbDsKICB2YXIgYj0kKCdtb2RhbC1ib2R5Jyk7IGIuaW5uZXJIVE1MPScnOwogIGlmKCFsaXN0Lmxlbmd0aCl7IGIuaW5uZXJIVE1MPSc8cCBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIHAtMyB0ZXh0LWNlbnRlciI+VGlkYWsgYWRhIGhhc2lsLjwvcD4nOyByZXR1cm47IH0KICB2YXIgZ3JpZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICBncmlkLmNsYXNzTmFtZT0nZ3JpZCBncmlkLWNvbHMtMyBzbTpncmlkLWNvbHMtNCBtZDpncmlkLWNvbHMtNSBnYXAtMyc7CiAgbGlzdC5mb3JFYWNoKGZ1bmN0aW9uKG0pewogICAgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBkLmNsYXNzTmFtZT0nbWNhcmQnOwogICAgZC5pbm5lckhUTUwgPSc8ZGl2IGNsYXNzPSJtY2FyZC1pbWciPicKICAgICAgKyc8aW1nIHNyYz0iJytTK20udGh1bWIrJy8zMDAiLz4nCiAgICAgICsnPHNwYW4gY2xhc3M9Im1jYXJkLWJhZGdlIj4nK20uYmFkZ2UrJzwvc3Bhbj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibWNhcmQtc3RhciI+PGkgZGF0YS1pY29uPSJzdGFyIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC12aWV3cyI+PGkgZGF0YS1pY29uPSJwbGF5LWZpbGwiIGNsYXNzPSJ3LTMgaC0zIj48L2k+JyttLnZpZXdzKyc8L2Rpdj4nCiAgICAgICsnPC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9Im1jYXJkLWluZm8iPicKICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC1uYW1lIiB0aXRsZT0iJyttLm5hbWUrJyI+JyttLm5hbWUrJzwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC1tZXRhIj4nCiAgICAgICsnPHNlbGVjdCBjbGFzcz0ibWNhcmQtdmVyIj48b3B0aW9uPicrbS52ZXIrJzwvb3B0aW9uPjxvcHRpb24+Vi4yPC9vcHRpb24+PG9wdGlvbj5WLjM8L29wdGlvbj48L3NlbGVjdD4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibWNhcmQtc2VsIj5TZWxlY3Q8L2J1dHRvbj4nCiAgICAgICsnPC9kaXY+PC9kaXY+JzsKICAgIGQucXVlcnlTZWxlY3RvcignLm1jYXJkLXN0YXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oZSl7IGUudGFyZ2V0LmNsb3Nlc3QoJy5tY2FyZC1zdGFyJykuY2xhc3NMaXN0LnRvZ2dsZSgnb24nKTsgfSk7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5tY2FyZC1zZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgX2N1ck9uU2VsKG0pOyB9KTsKICAgIGdyaWQuYXBwZW5kQ2hpbGQoZCk7CiAgfSk7CiAgYi5hcHBlbmRDaGlsZChncmlkKTsKfQpmdW5jdGlvbiBhcHBseVNlYXJjaCgpewogIHZhciBxPSgkKCdtc2VhcmNoJykudmFsdWV8fCcnKS50b0xvd2VyQ2FzZSgpOwogIHJlbmRlckNhcmRzKF9jdXJMaXN0LmZpbHRlcihmdW5jdGlvbihtKXtyZXR1cm4gIXF8fG0ubmFtZS50b0xvd2VyQ2FzZSgpLmluZGV4T2YocSk+PTB9KSwgX2N1ck9uU2VsKTsKfQokKCdtc2VhcmNoJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGFwcGx5U2VhcmNoKTsKJCgnbWZpbHRlcnMnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgnbWNhdCcpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicpOyAkKCdtZmlsdGVycycpLmNsYXNzTGlzdC50b2dnbGUoJ29uJyk7IH0pOwpkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubXRhYicpLmZvckVhY2goZnVuY3Rpb24odCl7CiAgdC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tdGFiJykuZm9yRWFjaChmdW5jdGlvbih4KXt4LmNsYXNzTGlzdC5yZW1vdmUoJ3NlbCcpfSk7CiAgICB0LmNsYXNzTGlzdC5hZGQoJ3NlbCcpOwogICAgaWYodC5kYXRhc2V0Lm10YWI9PT0nYmFzaWMnKSByZW5kZXJDYXJkcyhNT0RFTFMsIGZ1bmN0aW9uKG0peyBzZXRNb2RlbChtKTsgY2xvc2VNb2RhbCgpOyB9KTsKICAgIGVsc2UgcmVuZGVyQ2FyZHMoW10sIG51bGwpOwogIH0pOwp9KTsKZnVuY3Rpb24gcmVuZGVyTUNhdChvblBpY2spewogIHZhciBjPSQoJ21jYXQnKTsKICBpZighb25QaWNrKSBvblBpY2s9ZnVuY3Rpb24oKXt9OwogIHZhciBodG1sPScnOwogIE1DQVQuZm9yRWFjaChmdW5jdGlvbihjYXQsaSl7CiAgICBodG1sKz0nPGJ1dHRvbiBjbGFzcz0ibWNoaXAiIGRhdGEtbWNhdD0iJytjYXQrJyI+JytjYXQrJzwvYnV0dG9uPic7CiAgfSk7CiAgYy5pbm5lckhUTUw9aHRtbDsKICBjLnF1ZXJ5U2VsZWN0b3IoJy5tY2hpcCcpLmNsYXNzTGlzdC5hZGQoJ29uJyk7CiAgYy5xdWVyeVNlbGVjdG9yQWxsKCcubWNoaXAnKS5mb3JFYWNoKGZ1bmN0aW9uKGNoKXsKICAgIGNoLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICAgICBjLnF1ZXJ5U2VsZWN0b3JBbGwoJy5tY2hpcCcpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QucmVtb3ZlKCdvbicpfSk7CiAgICAgIGNoLmNsYXNzTGlzdC5hZGQoJ29uJyk7CiAgICAgIG9uUGljayhjaC5kYXRhc2V0Lm1jYXQpOwogICAgfSk7CiAgfSk7Cn0KZnVuY3Rpb24gc2V0TW9kZWwobSl7CiAgc3RhdGUubW9kZWw9bTsKICAkKCdtb2RlbC1uYW1lJykudGV4dENvbnRlbnQ9bS5uYW1lOwogICQoJ21vZGVsLXRodW1iJykuc3JjPSdodHRwczovL3BpY3N1bS5waG90b3Mvc2VlZC8nK20udGh1bWIrJy82NCc7CiAgdmFyIGI9JCgnbW9kZWwtYmFkZ2UnKTsgaWYoYikgYi50ZXh0Q29udGVudD0obS5iYXNlfHwnTW9kZWwnKSsnIC0gJysobS5hcmNofHwnJyk7Cn0KZnVuY3Rpb24gb3Blbk1vZGVsU2VsZWN0b3IoKXsKICAkKCdtb2RhbC10aXRsZScpLnRleHRDb250ZW50PSdQaWxpaCBNb2RlbCc7CiAgcmVuZGVyTUNhdChmdW5jdGlvbigpeyByZW5kZXJDYXJkcyhNT0RFTFMsIGZ1bmN0aW9uKG0peyBzZXRNb2RlbChtKTsgY2xvc2VNb2RhbCgpOyB9KTsgfSk7CiAgcmVuZGVyQ2FyZHMoTU9ERUxTLCBmdW5jdGlvbihtKXsgc2V0TW9kZWwobSk7IGNsb3NlTW9kYWwoKTsgfSk7CiAgb3Blbk1vZGFsKCk7Cn0KJCgnbW9kZWwtY2FyZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxvcGVuTW9kZWxTZWxlY3Rvcik7CmZ1bmN0aW9uIG9wZW5Mb3JhTW9kYWwoKXsKICAkKCdtb2RhbC10aXRsZScpLnRleHRDb250ZW50PSdQaWxpaCBMb1JBJzsKICB2YXIgYXJjaD1zdGF0ZS5tb2RlbD9zdGF0ZS5tb2RlbC5hcmNoOicnOwogIHZhciBhdmFpbD1mdW5jdGlvbigpeyByZXR1cm4gTE9SQV9MSUIuZmlsdGVyKGZ1bmN0aW9uKGwpewogICAgcmV0dXJuICghTE9SQS5zb21lKGZ1bmN0aW9uKHgpe3JldHVybiB4Lm5hbWU9PT1sLm5hbWV9KSkgJiYgKCFhcmNoIHx8ICFsLmJhc2UgfHwgbC5iYXNlPT09YXJjaCk7CiAgfSk7IH07CiAgdmFyIG9uU2VsPWZ1bmN0aW9uKGwpewogICAgTE9SQS5wdXNoKHsgbmFtZTpsLm5hbWUsIHc6MC44LCB0YWdzOmwudGFncywgdGh1bWI6bC50aHVtYiwgYmFzZTpsLmJhc2UsIGxvcmFNb2RlbDpsLm1vZGVsfHwnJywgbmVlZFVybDpsLm5lZWRVcmwsIGxvcmFVcmw6JycgfSk7CiAgICByZW5kZXJMb3JhKCk7IGNsb3NlTW9kYWwoKTsKICB9OwogIHJlbmRlck1DYXQoZnVuY3Rpb24oKXsgcmVuZGVyQ2FyZHMoYXZhaWwoKSwgb25TZWwpOyB9KTsKICByZW5kZXJDYXJkcyhhdmFpbCgpLCBvblNlbCk7CiAgaWYoIWF2YWlsKCkubGVuZ3RoKXsgJCgnbW9kYWwtdGl0bGUnKS50ZXh0Q29udGVudD0nVGlkYWsgYWRhIExvUkEgdW50dWsgJythcmNoOyB9CiAgb3Blbk1vZGFsKCk7Cn0KZnVuY3Rpb24gb3Blbk1vZGFsKCl7ICQoJ21vZGFsJykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ21vZGFsJykuY2xhc3NMaXN0LmFkZCgnZmxleCcpOyB9CmZ1bmN0aW9uIGNsb3NlTW9kYWwoKXsgJCgnbW9kYWwnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgnbW9kYWwnKS5jbGFzc0xpc3QucmVtb3ZlKCdmbGV4Jyk7IH0KZnVuY3Rpb24gb3BlbkxvcmFJbmZvKGwpewogICQoJ21vZGFsLXRpdGxlJykudGV4dENvbnRlbnQ9J0RldGFpbCBMb1JBJzsKICAkKCdtY2F0JykuaW5uZXJIVE1MPScnOwogIHZhciBiPSQoJ21vZGFsLWJvZHknKTsKICBiLmlubmVySFRNTD0nPGRpdiBjbGFzcz0iZmxleCBnYXAtMyBwLTIiPicKICAgICsnPGltZyBzcmM9IicrUytsLnRodW1iKycvMTQwIiBjbGFzcz0idy0yOCBoLTI4IHJvdW5kZWQtbGcgb2JqZWN0LWNvdmVyIHNocmluay0wIi8+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4LTEgbWluLXctMCI+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGZsZXgtd3JhcCBnYXAtMS41IG1iLTEiPicKICAgICsnPHNwYW4gY2xhc3M9InRleHQtWzEwcHhdIGZvbnQtc2VtaWJvbGQgYmctWyMxYzIxMjhdIGJvcmRlciBiZCBweC0xLjUgcHktMC41IHJvdW5kZWQgdGV4dC1uZXV0cmFsLTQwMCI+TE9SQTwvc3Bhbj4nCiAgICArJzxzcGFuIGNsYXNzPSJ0ZXh0LVsxMHB4XSBmb250LXNlbWlib2xkIGJnLVtyZ2JhKDExMSw5MywyNTUsLjE1KV0gYm9yZGVyIGJvcmRlci1bIzZGNURGRl0gcHgtMS41IHB5LTAuNSByb3VuZGVkIHRleHQtWyM2RjVERkZdIj4nK2wuYmFkZ2UrJzwvc3Bhbj4nCiAgICArJzxzcGFuIGNsYXNzPSJ0ZXh0LVsxMHB4XSBmb250LXNlbWlib2xkIGJnLVsjMWMyMTI4XSBib3JkZXIgYmQgcHgtMS41IHB5LTAuNSByb3VuZGVkIHRleHQtbmV1dHJhbC00MDAiPk9yaWdpbmFsPC9zcGFuPicKICAgICsnPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPicrbC5uYW1lKyc8L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBtdC0wLjUiPlJla3R5IEFJPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSBtdC0xIHRleHQteHMgdGV4dC1uZXV0cmFsLTQwMCI+PGkgZGF0YS1pY29uPSJkb3dubG9hZC1zaW1wbGUiIGNsYXNzPSJ3LTMuNSBoLTMuNSI+PC9pPicrKGwudmlld3M/bC52aWV3czonMTJLJykrJyBkb3dubG9hZHM8L2Rpdj4nCiAgICArJzwvZGl2PjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iYm9yZGVyLXQgYmQgbXQtMiBwdC0zIj4nCiAgICArJzxkaXYgY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCBtYi0yIGZsZXggaXRlbXMtY2VudGVyIGdhcC0xIj48aSBkYXRhLWljb249InRhZyIgY2xhc3M9InctNCBoLTQiPjwvaT5WZXJzaW9uIERldGFpbDwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZ3JpZCBncmlkLWNvbHMtMiBnYXAtMiB0ZXh0LXhzIj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGJvcmRlciBiZCByb3VuZGVkLWxnIHB4LTIgcHktMS41Ij48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+QmFzZSBNb2RlbDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+WiBJbWFnZTwvc3Bhbj48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGJvcmRlciBiZCByb3VuZGVkLWxnIHB4LTIgcHktMS41Ij48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+U3RlcHM8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPjI1MDA8L3NwYW4+PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiBib3JkZXIgYmQgcm91bmRlZC1sZyBweC0yIHB5LTEuNSI+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPkVwb2NoPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4xMjwvc3Bhbj48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIGJvcmRlciBiZCByb3VuZGVkLWxnIHB4LTIgcHktMS41Ij48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+VHJpZ2dlciBXb3Jkczwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1bIzI3RDRDRF0iPicrbC50YWdzLnNsaWNlKDAsMikuam9pbignLCAnKSsnPC9zcGFuPjwvZGl2PicKICAgICsnPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgbXQtMyBtYi0xIj5EZXNjcmlwdGlvbjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNDAwIGxlYWRpbmctcmVsYXhlZCI+JytsLnRhZ3Muam9pbignLCAnKSsnIOKAlCBMb1JBIHVudHVrIGdheWEgZGFuIGRldGFpbCB0YW1iYWhhbiBkaSBaIEltYWdlLjwvZGl2Pic7CiAgb3Blbk1vZGFsKCk7Cn0KJCgnbW9kZWwtaW5mbycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgZS5zdG9wUHJvcGFnYXRpb24oKTsgb3BlbkxvcmFJbmZvKHtuYW1lOiQoJ21vZGVsLW5hbWUnKS50ZXh0Q29udGVudCxiYWRnZTonWiBJbWFnZScsdGh1bWI6J3ppbWFnZScsdGFnczpbJ2RldGFpbCcsJ3NoYXJwJ119KTsgfSk7CiQoJ21vZGFsLWNsb3NlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGNsb3NlTW9kYWwpOwokKCdtb2RhbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgaWYoZS50YXJnZXQ9PT0kKCdtb2RhbCcpKSBjbG9zZU1vZGFsKCk7IH0pOwokKCdidG4tYWRkbG9yYScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxvcGVuTG9yYU1vZGFsKTsKZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigna2V5ZG93bicsZnVuY3Rpb24oZSl7IGlmKGUua2V5PT09J0VzY2FwZScpIGNsb3NlTW9kYWwoKTsgfSk7CmZ1bmN0aW9uIHJlbmRlckxvcmEoKXsKICB2YXIgbGlzdCA9ICQoJ2xvcmEtbGlzdCcpOyBsaXN0LmlubmVySFRNTD0nJzsKICBpZighTE9SQS5sZW5ndGgpeyBsaXN0LmlubmVySFRNTD0nPGRpdiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNjAwIGJvcmRlciBib3JkZXItZGFzaGVkIGJvcmRlci1bIzMwMzYzZF0gcm91bmRlZC1sZyBwLTMgdGV4dC1jZW50ZXIiPkJlbHVtIGFkYSBMb1JBLiBLbGlrICJBZGQgTG9SQSIuPC9kaXY+JzsgcmVuZGVyVHJpZ2dlcnMoKTsgcmV0dXJuOyB9CiAgTE9SQS5mb3JFYWNoKGZ1bmN0aW9uKGwscmkpewogICAgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgICBkLmNsYXNzTmFtZT0nbG9yYS1jYXJkJzsKICAgIGQuaW5uZXJIVE1MPScnCiAgICAgICsnPHNwYW4gY2xhc3M9ImxvcmEtbGFiZWwiPkxvUkEgLSAnKyhsLmJhc2V8fCdaIEltYWdlJykrJzwvc3Bhbj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibG9yYS10b3AiPicKICAgICAgKyc8aW1nIHNyYz0iJytTK2wudGh1bWIrJy80MCIgY2xhc3M9ImxvcmEtdGh1bWIiIGFsdD0iIi8+JwogICAgICArJzxzcGFuIGNsYXNzPSJsb3JhLW5hbWUiPicrbC5uYW1lKyc8L3NwYW4+JwogICAgICArJzxkaXYgY2xhc3M9ImxvcmEtaWNvbnMiPicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJsb3JhLWljb24iIGRhdGEtaW5mbz0iJytyaSsnIiB0aXRsZT0iSW5mbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTAiLz48bGluZSB4MT0iMTIiIHkxPSIxNiIgeDI9IjEyIiB5Mj0iMTIiLz48bGluZSB4MT0iMTIiIHkxPSI4IiB4Mj0iMTIuMDEiIHkyPSI4Ii8+PC9zdmc+PC9idXR0b24+JwogICAgICArJzxidXR0b24gY2xhc3M9ImxvcmEtaWNvbiBkZWwiIGRhdGEtZGVsPSInK3JpKyciIHRpdGxlPSJIYXB1cyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBvbHlsaW5lIHBvaW50cz0iMyA2IDUgNiAyMSA2Ii8+PHBhdGggZD0iTTE5IDZ2MTRhMiAyIDAgMCAxLTIgMkg3YTIgMiAwIDAgMS0yLTJWNm0zIDBWNGEyIDIgMCAwIDEgMi0yaDRhMiAyIDAgMCAxIDIgMnYyIi8+PGxpbmUgeDE9IjEwIiB5MT0iMTEiIHgyPSIxMCIgeTI9IjE3Ii8+PGxpbmUgeDE9IjE0IiB5MT0iMTEiIHgyPSIxNCIgeTI9IjE3Ii8+PC9zdmc+PC9idXR0b24+JwogICAgICArJzwvZGl2PicKICAgICAgKyc8L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibG9yYS1zbGlkZXItcm93Ij4nCiAgICAgICsnPGRpdiBjbGFzcz0ibC1zbGlkZXIiPjxkaXYgY2xhc3M9ImwtdHJhY2siPjwvZGl2PjxkaXYgY2xhc3M9ImwtZmlsbCIgc3R5bGU9IndpZHRoOicrKGwudy8yKjEwMCkrJyUiPjwvZGl2PjxkaXYgY2xhc3M9ImwtaGFuZGxlIiBzdHlsZT0ibGVmdDonKyhsLncvMioxMDApKyclIj48L2Rpdj48aW5wdXQgdHlwZT0icmFuZ2UiIG1pbj0iMCIgbWF4PSIyIiBzdGVwPSIwLjEiIHZhbHVlPSInK2wudysnIiBkYXRhLXJpPSInK3JpKyciIGNsYXNzPSJsb3JhLXNsIi8+PC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9ImwtbnVtIj4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibG9yYS1idG4iIGRhdGEtZGVjPSInK3JpKyciPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxsaW5lIHgxPSI1IiB5MT0iMTIiIHgyPSIxOSIgeTI9IjEyIi8+PC9zdmc+PC9idXR0b24+JwogICAgICArJzxpbnB1dCB0eXBlPSJ0ZXh0IiB2YWx1ZT0iJytsLncudG9GaXhlZCgxKSsnIiBjbGFzcz0ibG9yYS1pbnB1dCIgZGF0YS1yaT0iJytyaSsnIiBpbnB1dG1vZGU9ImRlY2ltYWwiLz4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibG9yYS1idG4iIGRhdGEtaW5jPSInK3JpKyciPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxsaW5lIHgxPSIxMiIgeTE9IjUiIHgyPSIxMiIgeTI9IjE5Ii8+PGxpbmUgeDE9IjUiIHkxPSIxMiIgeDI9IjE5IiB5Mj0iMTIiLz48L3N2Zz48L2J1dHRvbj4nCiAgICAgICsnPC9kaXY+JwogICAgICArKGwubmVlZFVybD8nPGRpdiBjbGFzcz0ibXQtMiI+PGlucHV0IHR5cGU9InRleHQiIGNsYXNzPSJpbnAgbG9yYS11cmwtaW5wIiB2YWx1ZT0iJysobC5sb3JhVXJsfHwnJykrJyIgZGF0YS11cmw9IicrcmkrJyIgcGxhY2Vob2xkZXI9Imh0dHBzOi8vaHVnZ2luZ2ZhY2UuY28vdXNlci9yZXBvL3Jlc29sdmUvbWFpbi9sb3JhLnNhZmV0ZW5zb3JzIi8+PGRpdiBjbGFzcz0ibXQtMSB0ZXh0LVsxMHB4XSBsZWFkaW5nLXNudWcgdGV4dC1uZXV0cmFsLTUwMCI+VVJMIHB1YmxpayBsYW5nc3VuZyAoLnNhZmV0ZW5zb3JzKSDigJQgY29udG9oIEh1Z2dpbmdGYWNlIHJlc29sdmUuIEthZ2dsZSB0aWRhayBiaXNhIChidXR1aCBsb2dpbikuPC9kaXY+PC9kaXY+JzonJykKICAgICAgKyc8L2Rpdj4nOwogICAgdmFyIHNsPWQucXVlcnlTZWxlY3RvcignLmwtc2xpZGVyIFtkYXRhLXJpPSInK3JpKyciXScpOwogICAgdmFyIHVJbnA9ZC5xdWVyeVNlbGVjdG9yKCdbZGF0YS11cmw9IicrcmkrJyJdJyk7CiAgICBpZih1SW5wKXsgdUlucC5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7IExPUkFbcmldLmxvcmFVcmw9ZS50YXJnZXQudmFsdWUudHJpbSgpOyB9KTsgfQogICAgc2wuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpewogICAgICB2YXIgdj1wYXJzZUZsb2F0KGUudGFyZ2V0LnZhbHVlKTsgaWYoaXNOYU4odikpcmV0dXJuOwogICAgICBMT1JBW3JpXS53PXY7CiAgICAgIHZhciBwY3Q9KHYvMioxMDApOwogICAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5sLWZpbGwnKS5zdHlsZS53aWR0aD1wY3QrJyUnOwogICAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5sLWhhbmRsZScpLnN0eWxlLmxlZnQ9cGN0KyclJzsKICAgICAgZC5xdWVyeVNlbGVjdG9yKCcubG9yYS1pbnB1dCcpLnZhbHVlPXYudG9GaXhlZCgxKTsKICAgICAgcmVuZGVyVHJpZ2dlcnMoKTsKICAgIH0pOwogICAgZC5xdWVyeVNlbGVjdG9yKCcubC1udW0gW2RhdGEtaW5jPSInK3JpKyciXScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBzZXRMVyhyaSwrKExPUkFbcmldLncrMC4xKS50b0ZpeGVkKDEpKTsgcmVuZGVyTG9yYSgpOyB9KTsKICAgIGQucXVlcnlTZWxlY3RvcignLmwtbnVtIFtkYXRhLWRlYz0iJytyaSsnIl0nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgc2V0TFcocmksKyhMT1JBW3JpXS53LTAuMSkudG9GaXhlZCgxKSk7IHJlbmRlckxvcmEoKTsgfSk7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWRlbD0iJytyaSsnIl0nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgTE9SQS5zcGxpY2UocmksMSk7IHJlbmRlckxvcmEoKTsgcmVuZGVyVHJpZ2dlcnMoKTsgfSk7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWluZm89IicrcmkrJyJdJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IG9wZW5Mb3JhSW5mbyhsKTsgfSk7CiAgICBsaXN0LmFwcGVuZENoaWxkKGQpOwogIH0pOwogIHJlbmRlclRyaWdnZXJzKCk7Cn0KZnVuY3Rpb24gc2V0TFcoaSx2KXsgTE9SQVtpXS53PU1hdGgubWF4KDAsTWF0aC5taW4oMix2KSk7IH0KdmFyIF9wZW5kaW5nVHJpZyA9IFtdOwpmdW5jdGlvbiByZW5kZXJUcmlnZ2VycygpewogIHZhciBwPSgkKCdwcm9tcHQnKS52YWx1ZXx8JycpLnRvTG93ZXJDYXNlKCk7CiAgdmFyIHQ9JCgndHJpZ2dlcnMnKTsgdC5pbm5lckhUTUw9Jyc7CiAgX3BlbmRpbmdUcmlnPVtdOwogIExPUkEuZmlsdGVyKGZ1bmN0aW9uKGwpe3JldHVybiBsLnc+MH0pLmZvckVhY2goZnVuY3Rpb24obCl7CiAgICBsLnRhZ3MuZm9yRWFjaChmdW5jdGlvbih3KXsgaWYocC5pbmRleE9mKHcudG9Mb3dlckNhc2UoKSk8MCkgX3BlbmRpbmdUcmlnLnB1c2goe3dvcmQ6dyxsb3JhOmwubmFtZX0pOyB9KTsKICB9KTsKICAkKCd0ci1jb3VudCcpLnRleHRDb250ZW50PV9wZW5kaW5nVHJpZy5sZW5ndGg7CiAgaWYoIV9wZW5kaW5nVHJpZy5sZW5ndGgpeyB0LmlubmVySFRNTD0nPHNwYW4gY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTYwMCI+VGlkYWsgYWRhIHRyaWdnZXIgd29yZCB0ZXJzaXNhPC9zcGFuPic7IHJldHVybjsgfQogIF9wZW5kaW5nVHJpZy5mb3JFYWNoKGZ1bmN0aW9uKGl0ZW0pewogICAgdmFyIGI9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnYnV0dG9uJyk7CiAgICBiLmNsYXNzTmFtZT0ndGFnIGN1cnNvci1wb2ludGVyIGhvdmVyOmJvcmRlci1bIzI3RDRDRF0gaG92ZXI6dGV4dC1bIzI3RDRDRF0gdHJhbnNpdGlvbic7CiAgICBiLmlubmVySFRNTD0nPGkgZGF0YS1pY29uPSJzcGFya2xlIiBjbGFzcz0idy0zIGgtMyB0ZXh0LVsjMjdENENEXSI+PC9pPicraXRlbS53b3JkOwogICAgYi50aXRsZT0nVGFtYmFoa2FuIGtlIHByb21wdCAoJytpdGVtLmxvcmErJyknOwogICAgYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgICAgYWRkV29yZChpdGVtLndvcmQpOwogICAgICByZW5kZXJUcmlnZ2VycygpOwogICAgfSk7CiAgICB0LmFwcGVuZENoaWxkKGIpOwogIH0pOwp9CmZ1bmN0aW9uIGFkZFdvcmQodyl7CiAgdmFyIHByPSQoJ3Byb21wdCcpLCBjdj1wci52YWx1ZS50cmltKCk7CiAgaWYoY3YgJiYgIWN2LmVuZHNXaXRoKCcsJykpIGN2Kz0nLCc7CiAgcHIudmFsdWU9Y3YrdysnLCc7CiAgcHIuZm9jdXMoKTsKfQpmdW5jdGlvbiBhZGRBbGxUcmlnKCl7CiAgdmFyIGFsbD1fcGVuZGluZ1RyaWcubWFwKGZ1bmN0aW9uKHgpe3JldHVybiB4LndvcmR9KTsKICBhbGwuZm9yRWFjaChhZGRXb3JkKTsKICByZW5kZXJUcmlnZ2VycygpOwp9CiQoJ2FkZGFsbC10cmlnJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGFkZEFsbFRyaWcpOwoKLyogPT09PT0gYXNwZWN0IHJhdGlvID09PT09ICovCnZhciBBUl9NQVAgPSB7CiAgcG9ydHJhaXQ6WydQb3J0cmFpdCcsNzY4LDExNTJdLAogIGxhbmRzY2FwZTpbJ0xhbmRzY2FwZScsMTE1Miw3NjhdLAogIHNxdWFyZTpbJ1NxdWFyZScsMTAyNCwxMDI0XSwKICBjdXN0b206WydjdXN0b20nLG51bGwsbnVsbF0KfTsKZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmFyJykuZm9yRWFjaChmdW5jdGlvbihiKXsKICBiLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICAgdmFyIGFyPWIuZGF0YXNldC5hcjsgc3RhdGUuYXNwZWN0PWFyOwogICAgc2V0QXJBY3RpdmUoYXIpOwogICAgaWYoYXIhPT0nY3VzdG9tJyl7ICQoJ3dpZHRoJykudmFsdWU9QVJfTUFQW2FyXVsxXTsgJCgnaGVpZ2h0JykudmFsdWU9QVJfTUFQW2FyXVsyXTsgfQogICAgdXBkV0goKTsKICB9KTsKfSk7CmZ1bmN0aW9uIHVwZFdIKCl7ICQoJ3d2JykudmFsdWU9JCgnd2lkdGgnKS52YWx1ZTsgJCgnaHYnKS52YWx1ZT0kKCdoZWlnaHQnKS52YWx1ZTsgfQokKCd3aWR0aCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbigpeyAkKCd3dicpLnZhbHVlPSQoJ3dpZHRoJykudmFsdWU7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsKJCgnaGVpZ2h0JykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKCl7ICQoJ2h2JykudmFsdWU9JCgnaGVpZ2h0JykudmFsdWU7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsKJCgnd3YnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLGZ1bmN0aW9uKCl7IHZhciB2PU1hdGgubWF4KDI1NixNYXRoLm1pbigxNTM2LHBhcnNlSW50KCQoJ3d2JykudmFsdWUpfHw3NjgpKTsgdj1NYXRoLnJvdW5kKHYvNjQpKjY0OyAkKCd3dicpLnZhbHVlPXY7ICQoJ3dpZHRoJykudmFsdWU9djsgc3RhdGUuYXNwZWN0PSdjdXN0b20nOyBzZXRBckFjdGl2ZSgnY3VzdG9tJyk7IH0pOwokKCdodicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsZnVuY3Rpb24oKXsgdmFyIHY9TWF0aC5tYXgoMjU2LE1hdGgubWluKDE1MzYscGFyc2VJbnQoJCgnaHYnKS52YWx1ZSl8fDExNTIpKTsgdj1NYXRoLnJvdW5kKHYvNjQpKjY0OyAkKCdodicpLnZhbHVlPXY7ICQoJ2hlaWdodCcpLnZhbHVlPXY7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsKZnVuY3Rpb24gc2V0QXJBY3RpdmUoYXIpewogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hcicpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QudG9nZ2xlKCdzZWwnLCB4LmRhdGFzZXQuYXI9PT1hcil9KTsKICAkKCdhci1sYWJlbCcpLnRleHRDb250ZW50PUFSX01BUFthcl1bMF07Cn0KJCgnc3RlcHMnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7JCgnc3YnKS50ZXh0Q29udGVudD1lLnRhcmdldC52YWx1ZX0pOwokKCdjZmcnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7JCgnY2Z2JykudGV4dENvbnRlbnQ9ZS50YXJnZXQudmFsdWV9KTsKJCgnY2xpcHNraXAnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7JCgnY3N2JykudGV4dENvbnRlbnQ9ZS50YXJnZXQudmFsdWV9KTsKJCgnZXRhbnNkJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpeyQoJ2Vuc2QnKS50ZXh0Q29udGVudD1lLnRhcmdldC52YWx1ZX0pOwokKCdhZHYtdG9nZ2xlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7JCgnYWR2LWZpZWxkcycpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicpfSk7CiQoJ2RpY2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXskKCdzZWVkJykudmFsdWU9U3RyaW5nKE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSo5OTk5OTk5OTk5OTk5OTk5KSl9KTsKJCgnbmVnY2hlY2snKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLGZ1bmN0aW9uKGUpeyQoJ25lZ3dyYXAnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLCFlLnRhcmdldC5jaGVja2VkKX0pOwokKCdwcm9tcHQnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcscmVuZGVyVHJpZ2dlcnMpOwokKCdidG4tZW5oYW5jZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogIHZhciBwPSgkKCdwcm9tcHQnKS52YWx1ZXx8JycpLnRyaW0oKTsKICBpZighcCl7ICQoJ3Byb21wdCcpLmZvY3VzKCk7IHJldHVybjsgfQogIHZhciBiPSQoJ2J0bi1lbmhhbmNlJyk7CiAgYi5pbm5lckhUTUw9JzxpIGRhdGEtaWNvbj0iY2lyY2xlLW5vdGNoIiBjbGFzcz0idy0zLjUgaC0zLjUgYW5pbWF0ZS1zcGluIj48L2k+RW5oYW5jaW5nLi4uJzsKICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7CiAgICAkKCdwcm9tcHQnKS52YWx1ZT1wCiAgICAgICsnXG5cbkVuaGFuY2UgZGV0YWlsLCBsaWdodGluZywgY29tcG9zaXRpb24sIGFuZCBhdG1vc3BoZXJlLiAnCiAgICAgICsnVWx0cmEtZGV0YWlsZWQsIHByb2Zlc3Npb25hbCBwaG90b2dyYXBoeSwgc2hhcnAgZm9jdXMsIGNpbmVtYXRpYyBsaWdodGluZy4nOwogICAgcmVuZGVyVHJpZ2dlcnMoKTsKICAgIGIuaW5uZXJIVE1MPSc8aSBkYXRhLWljb249InNwYXJrbGUiIGNsYXNzPSJ3LTMuNSBoLTMuNSI+PC9pPkVuaGFuY2UnOwogIH0sOTAwKTsKfSk7CmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jaGlwJykuZm9yRWFjaChmdW5jdGlvbihjKXsKICBjLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpe2MuY2xhc3NMaXN0LnRvZ2dsZSgnb24nKX0pOwp9KTsKCi8qID09PT09IHRhYnMgPT09PT0gKi8KZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRhYicpLmZvckVhY2goZnVuY3Rpb24odCl7CiAgdC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50YWInKS5mb3JFYWNoKGZ1bmN0aW9uKHgpe3guY2xhc3NMaXN0LnJlbW92ZSgnc2VsJyl9KTsKICAgIHQuY2xhc3NMaXN0LmFkZCgnc2VsJyk7IHN0YXRlLnBhZ2U9dC5kYXRhc2V0LnRhYjsKICAgIHJlbmRlckNhbnZhcygpOwogIH0pOwp9KTsKZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnJ0YWInKS5mb3JFYWNoKGZ1bmN0aW9uKHQpewogIHQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucnRhYicpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QucmVtb3ZlKCdzZWwnKX0pOwogICAgdC5jbGFzc0xpc3QuYWRkKCdzZWwnKTsKICB9KTsKfSk7CgovKiA9PT09PSBtb2JpbGUgZHJhd2VyID09PT09ICovCiQoJ21tZW51JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IG9wZW5MZWZ0KCk7IH0pOwokKCdvdmVybGF5JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IGNsb3NlTGVmdCgpOyB9KTsKZnVuY3Rpb24gb3BlbkxlZnQoKXsgJCgnb3ZlcmxheScpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyAkKCdsZWZ0cGFuJykuY2xhc3NMaXN0LnJlbW92ZSgnLXRyYW5zbGF0ZS14LWZ1bGwnKTsgfQpmdW5jdGlvbiBjbG9zZUxlZnQoKXsgJCgnb3ZlcmxheScpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyBpZih3aW5kb3cuaW5uZXJXaWR0aDwxMDI0KSAkKCdsZWZ0cGFuJykuY2xhc3NMaXN0LmFkZCgnLXRyYW5zbGF0ZS14LWZ1bGwnKTsgfQoKLyogPT09PT0gaW1hZ2UgY291bnQgKGRyb3Bkb3duIGRpIHByb21wdCBiYXIgKyB0b21ib2wgbmF2YmFyKSA9PT09PSAqLwpmdW5jdGlvbiBhcHBseU5jb2woKXsKICB2YXIgc2VsPSQoJ25jb3VudCcpOyBpZihzZWwpIHNlbC52YWx1ZT1TdHJpbmcoc3RhdGUubmNvbCk7CiAgaWYoc3RhdGUubmNvbD4xKXsKICAgIC8vIGdyaWQgMiBrb2xvbSBiaWFzYQogICAgJCgnZ3JpZCcpLmNsYXNzTmFtZT0nZ3JpZCBncmlkLWNvbHMtMiBnYXAtMyc7CiAgICAkKCdncmlkJykuc3R5bGUubWF4V2lkdGg9Jyc7ICQoJ2dyaWQnKS5zdHlsZS5tYXJnaW49Jyc7CiAgfWVsc2V7CiAgICAvLyAxIGdhbWJhciBiZXNhciBkaSB0ZW5nYWggKHNlcGVydGkgVGVuc29yLkFydCkKICAgICQoJ2dyaWQnKS5jbGFzc05hbWU9J2dyaWQgZ3JpZC1jb2xzLTEgZ2FwLTMnOwogICAgJCgnZ3JpZCcpLnN0eWxlLm1heFdpZHRoPScyNnJlbSc7ICQoJ2dyaWQnKS5zdHlsZS5tYXJnaW49JzAgYXV0byc7CiAgfQogICQoJ25jb2xsYmwnKS50ZXh0Q29udGVudD1zdGF0ZS5uY29sPjE/MjoxOwp9CiQoJ25jb2wnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICBzdGF0ZS5uY29sID0gc3RhdGUubmNvbD09PTI/MToyOwogIGFwcGx5TmNvbCgpOwp9KTsKJCgnbmNvdW50JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbigpewogIHN0YXRlLm5jb2w9cGFyc2VJbnQoJCgnbmNvdW50JykudmFsdWUpfHwxOwogIGFwcGx5TmNvbCgpOwp9KTsKCi8qID09PT09IGdlbmVyYXRlIChyZWFsIEFQSSAvIGRlbW8gZmFsbGJhY2spID09PT09ICovCiQoJ2J0bi1nbycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxkb0dlbmVyYXRlKTsKJCgnYnRuLWdvMicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxkb0dlbmVyYXRlKTsKZnVuY3Rpb24gc2V0QnVzeShiKXsKICBbJ2J0bi1nbycsJ2J0bi1nbzInXS5mb3JFYWNoKGZ1bmN0aW9uKGlkKXsKICAgIHZhciBlbD0kKGlkKTsgaWYoIWVsKSByZXR1cm47CiAgICBlbC5kaXNhYmxlZD1iOyBlbC5zdHlsZS5vcGFjaXR5PWI/JzAuNSc6JzEnOwogICAgZWwuaW5uZXJIVE1MPWI/JzxpIGRhdGEtaWNvbj0iY2lyY2xlLW5vdGNoIiBjbGFzcz0idy00IGgtNCBhbmltYXRlLXNwaW4iPjwvaT5HZW5lcmF0aW5nLi4uJwogICAgICA6JzxpIGRhdGEtaWNvbj0icGxheSIgY2xhc3M9InctNCBoLTQiPjwvaT5HZW5lcmF0ZSA8c3BhbiBjbGFzcz0idGV4dC14cyBvcGFjaXR5LTkwIGZvbnQtbm9ybWFsIj4rJDAuMzM8L3NwYW4+JzsKICB9KTsKfQpmdW5jdGlvbiBleHRyYWN0SW1hZ2VzKGRhdGEpewogIGlmKCFkYXRhKSByZXR1cm4gW107CiAgaWYoQXJyYXkuaXNBcnJheShkYXRhKSkgZGF0YT17aW1hZ2VzOmRhdGF9OwogIHZhciBpbWdzPWRhdGEuaW1hZ2VzfHxkYXRhLmRhdGEmJmRhdGEuZGF0YS5pbWFnZXN8fGRhdGEucmVzdWx0JiZkYXRhLnJlc3VsdC5pbWFnZXN8fGRhdGEudXJsc3x8W107CiAgcmV0dXJuIGltZ3MubWFwKGZ1bmN0aW9uKGkpeyByZXR1cm4gdHlwZW9mIGk9PT0nc3RyaW5nJz9pOihpLnVybHx8aS5zcmN8fGkuaW1hZ2V8fGkucGF0aCk7IH0pLmZpbHRlcihCb29sZWFuKTsKfQovKiA9PT09PSBoYXNpbCArIHJpd2F5YXQgKHBlcnNpc3QgbG9jYWxTdG9yYWdlKSA9PT09PSAqLwpmdW5jdGlvbiBwZXJzaXN0UmVzdWx0cygpewogIHRyeXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oUkVTVUxUU19LRVksSlNPTi5zdHJpbmdpZnkoc3RhdGUucmVzdWx0cy5zbGljZSgwLDYwKSkpOyB9Y2F0Y2goZSl7fQp9CmZ1bmN0aW9uIG1ha2VHcmlkQ2FyZChyKXsKICB2YXIgZz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICBnLmNsYXNzTmFtZT0ncmVsYXRpdmUgcm91bmRlZC14bCBvdmVyZmxvdy1oaWRkZW4gYm9yZGVyIGJkIGFzcGVjdC1bNC81XSBiZy1bIzFjMjEyOF0gY3Vyc29yLXBvaW50ZXIgaG92ZXI6Ym9yZGVyLVsjM2Q0NDRkXSc7CiAgZy5pbm5lckhUTUw9JzxpbWcgc3JjPSInK3Iuc3JjKyciIGNsYXNzPSJ3LWZ1bGwgaC1mdWxsIG9iamVjdC1jb3ZlciIvPicKICAgICsoci5kZW1vPyc8c3BhbiBjbGFzcz0iYWJzb2x1dGUgdG9wLTEuNSBsZWZ0LTEuNSB0ZXh0LVs5cHhdIGJnLWJsYWNrLzYwIHB4LTEuNSBweS0wLjUgcm91bmRlZCB0ZXh0LW5ldXRyYWwtMzAwIj5ERU1PPC9zcGFuPic6JycpOwogIGcuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IG9wZW5MaWdodGJveChyKTsgfSk7CiAgcmV0dXJuIGc7Cn0KZnVuY3Rpb24gcmVuZGVyR3JpZCgpewogIHZhciBncmlkPSQoJ2dyaWQnKTsgZ3JpZC5pbm5lckhUTUw9Jyc7CiAgdmFyIGFycj1zdGF0ZS5yZXN1bHRzLnNsaWNlKCkucmV2ZXJzZSgpOyAvLyBoYXNpbCB0ZXJiYXJ1IHRhbXBpbCBkdWx1YW4KICBhcnIuZm9yRWFjaChmdW5jdGlvbihyKXsgZ3JpZC5hcHBlbmRDaGlsZChtYWtlR3JpZENhcmQocikpOyB9KTsKICAkKCdlbXB0eScpLnN0eWxlLmRpc3BsYXkgPSBzdGF0ZS5yZXN1bHRzLmxlbmd0aD4wID8gJ25vbmUnIDogJyc7Cn0KZnVuY3Rpb24gYWRkUmVzdWx0KHIpewogIHN0YXRlLnJlc3VsdHMudW5zaGlmdChyKTsKICBpZihzdGF0ZS5yZXN1bHRzLmxlbmd0aD42MCkgc3RhdGUucmVzdWx0cy5sZW5ndGg9NjA7CiAgcGVyc2lzdFJlc3VsdHMoKTsKICByZW5kZXJHcmlkKCk7CiAgcmVuZGVyUmlnaHQoKTsKfQoKLyogPT09PT0gcmlnaHQgaGlzdG9yeSA9PT09PSAqLwpmdW5jdGlvbiBmbXREYXRlKHRzKXsgdHJ5eyByZXR1cm4gbmV3IERhdGUodHMpLnRvTG9jYWxlRGF0ZVN0cmluZygnaWQtSUQnKTsgfWNhdGNoKGUpeyByZXR1cm4gJyc7IH0gfQpmdW5jdGlvbiByZW5kZXJSaWdodCgpewogIHZhciBsaXN0PSQoJ3JsaXN0Jyk7IGxpc3QuaW5uZXJIVE1MPScnOwogIGlmKCFzdGF0ZS5yZXN1bHRzLmxlbmd0aCl7IGxpc3QuaW5uZXJIVE1MPSc8cCBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIHAtNCB0ZXh0LWNlbnRlciI+QmVsdW0gYWRhIGhhc2lsLjwvcD4nOyAkKCdyY291bnQnKS50ZXh0Q29udGVudD0nMCBoYXNpbCc7IHJldHVybjsgfQogICQoJ3Jjb3VudCcpLnRleHRDb250ZW50PXN0YXRlLnJlc3VsdHMubGVuZ3RoKycgaGFzaWwnOwogIHN0YXRlLnJlc3VsdHMuZm9yRWFjaChmdW5jdGlvbihyLGkpewogICAgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7IGQuY2xhc3NOYW1lPSdyY2FyZCc7CiAgICB2YXIgbGJsPXIuZGVtbz8nRGVtbyAoc2ltdWxhc2kpJzooci5wYWdlPT09J2ltZyc/J0ltYWdlIHRvIEltYWdlJzonVGV4dCB0byBJbWFnZScpOwogICAgZC5pbm5lckhUTUw9JzxkaXYgY2xhc3M9InJlbGF0aXZlIj4nCiAgICAgICsnPGltZyBzcmM9Iicrci5zcmMrJyIgY2xhc3M9InctZnVsbCBhc3BlY3QtWzQvM10gb2JqZWN0LWNvdmVyIGN1cnNvci1wb2ludGVyIi8+JwogICAgICArJzxidXR0b24gY2xhc3M9ImFic29sdXRlIHRvcC0xLjUgcmlnaHQtMS41IHctNiBoLTYgcm91bmRlZC1tZCBiZy1ibGFjay81MCBob3ZlcjpiZy1yZWQtNTAwLzgwIHRleHQtd2hpdGUgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC14cyIgdGl0bGU9IkhhcHVzIj7inJU8L2J1dHRvbj4nCiAgICAgICsnPC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9InAtMi41IHNwYWNlLXktMS41IHRleHQteHMiPicKICAgICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41Ij48aSBkYXRhLWljb249InNwYXJrbGUiIGNsYXNzPSJ3LTMgaC0zIHRleHQtdmlvbGV0LTQwMCI+PC9pPjxzcGFuIGNsYXNzPSJiZy12aW9sZXQtNTAwLzEwIHRleHQtdmlvbGV0LTMwMCBweC0xLjUgcHktcHggcm91bmRlZCB0ZXh0LVsxMHB4XSI+JytsYmwrJzwvc3Bhbj48L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0iYmctYmxhY2svNDAgcm91bmRlZCBwLTEuNSB0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtMzAwIGxlYWRpbmctc251ZyBjdXJzb3ItcG9pbnRlciBob3Zlcjp0ZXh0LXdoaXRlIiB0aXRsZT0iTGloYXQgZGV0YWlsIj4nKyhyLnByb21wdHx8JycpLnNsaWNlKDAsOTApKyc8L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEgdGV4dC1bMTBweF0gdGV4dC1uZXV0cmFsLTUwMCI+PGkgZGF0YS1pY29uPSJsYXllcnMiIGNsYXNzPSJ3LTMgaC0zIj48L2k+JytMT1JBLmZpbHRlcihmdW5jdGlvbihsKXtyZXR1cm4gbC53PjB9KS5sZW5ndGgrJyBMb1JBPC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9InNwYWNlLXktMSB0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNTAwIj4nCiAgICAgICsoci50YXNrSWQ/JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5UYXNrIElEPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIHRydW5jYXRlIG1heC13LVs2MCVdIiB0aXRsZT0iJytyLnRhc2tJZCsnIj4nK3IudGFza0lkKyc8L3NwYW4+PC9kaXY+JzonJykKICAgICAgKyhyLmNyZWRpdHM/JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DcmVkaXRzPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK3IuY3JlZGl0cysnPC9zcGFuPjwvZGl2Pic6JycpCiAgICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNyZWF0ZWQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrZm10RGF0ZShyLnRzKSsnPC9zcGFuPjwvZGl2PicKICAgICAgKyhyLm5lZz8nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPk5lZ2F0aXZlPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIHRydW5jYXRlIG1heC13LVs2MCVdIiB0aXRsZT0iJytyLm5lZysnIj4nK3IubmVnKyc8L3NwYW4+PC9kaXY+JzonJykKICAgICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2l6ZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+JytyLnNpemUrJzwvc3Bhbj48L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNlZWQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrci5zZWVkKyc8L3NwYW4+PC9kaXY+JwogICAgICArJzwvZGl2PjwvZGl2Pic7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJ2ltZycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBvcGVuTGlnaHRib3gocik7IH0pOwogICAgZC5xdWVyeVNlbGVjdG9yKCcuYmctYmxhY2tcXC80MCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBvcGVuTGlnaHRib3gocik7IH0pOwogICAgZC5xdWVyeVNlbGVjdG9yKCdidXR0b24nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgICAgc3RhdGUucmVzdWx0cy5zcGxpY2UoaSwxKTsgcGVyc2lzdFJlc3VsdHMoKTsgcmVuZGVyUmlnaHQoKTsKICAgIH0pOwogICAgbGlzdC5hcHBlbmRDaGlsZChkKTsKICB9KTsKfQoKLyogPT09PT0gbGlnaHRib3ggPT09PT0gKi8KZnVuY3Rpb24gb3BlbkxpZ2h0Ym94KHIpewogICQoJ2xiLWltZycpLnNyYz1yLnNyYzsKICB2YXIgaD0nJzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPk1vZGVsPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nKyhyLm1vZGVsfHwnLScpKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlByb21wdDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+Jysoci5wcm9tcHR8fCctJykrJzwvc3Bhbj48L2Rpdj4nOwogIGlmKHIubmVnKSBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPk5lZ2F0aXZlPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nK3IubmVnKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNpemU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrKHIuc2l6ZXx8Jy0nKSsnPC9zcGFuPjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TZWVkPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nKyhyLnNlZWR8fCctJykrJzwvc3Bhbj48L2Rpdj4nOwogIGlmKHIudGFza0lkKSBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlRhc2sgSUQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrci50YXNrSWQrJzwvc3Bhbj48L2Rpdj4nOwogIGlmKHIuY3JlZGl0cykgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DcmVkaXRzPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nK3IuY3JlZGl0cysnPC9zcGFuPjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9Im10LTIiPjxhIGhyZWY9Iicrci5zcmMrJyIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiIGNsYXNzPSJ0ZXh0LVsjNkY1REZGXSBob3Zlcjp1bmRlcmxpbmUgdGV4dC14cyI+QnVrYSBnYW1iYXIgYXNsaSAmbmVhcnI7PC9hPjwvZGl2Pic7CiAgJCgnbGItbWV0YScpLmlubmVySFRNTD1oOwogICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LmFkZCgnZmxleCcpOwp9CiQoJ2xiLWNsb3NlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LnJlbW92ZSgnZmxleCcpOyB9KTsKJCgnbGlnaHRib3gnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oZSl7IGlmKGUudGFyZ2V0PT09JCgnbGlnaHRib3gnKSl7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LnJlbW92ZSgnZmxleCcpOyB9IH0pOwoKLyogPT09PT0gcGF5bG9hZCAoc3RydWt0dXIgbnlhdGEgVGVuc29yLkFydCkgPT09PT0gKi8KZnVuY3Rpb24gYnVpbGRQYXlsb2FkKCl7CiAgdmFyIG5lZz0kKCduZWdjaGVjaycpLmNoZWNrZWQ/JCgnbmVncHJvbXB0JykudmFsdWU6Jyc7CiAgdmFyIG09c3RhdGUubW9kZWw7CiAgcmV0dXJuIHsKICAgIHBhcmFtczp7CiAgICAgIGJhc2VNb2RlbDp7IG1vZGVsSWQ6bS5tb2RlbElkLCBtb2RlbEZpbGVJZDptLm1vZGVsRmlsZUlkIH0sCiAgICAgIG1vZGVsOnNldHRpbmdzLnByb3ZpZGVyPT09J3RhbXMnPycnOihtJiZtLm1vZGVsP20ubW9kZWw6JycpLAogICAgICBzZHhsOnsgcmVmaW5lcjpmYWxzZSB9LAogICAgICBtb2RlbHM6TE9SQS5maWx0ZXIoZnVuY3Rpb24obCl7cmV0dXJuIGwudz4wfSkubWFwKGZ1bmN0aW9uKGwpe3JldHVybiB7IG5hbWU6bC5uYW1lLCB3ZWlnaHQ6bC53LCB0cmlnZ2VyV29yZHM6bC50YWdzLCBsb3JhTW9kZWw6bC5sb3JhTW9kZWx8fCcnLCBsb3JhVXJsOmwubG9yYVVybHx8JycgfSB9KSwKICAgICAgZW1iZWRkaW5nTW9kZWxzOltdLAogICAgICBzZFZhZTokKCd2YWUnKS52YWx1ZT09PSdhdXRvbWF0aWMnPydBdXRvbWF0aWMnOiQoJ3ZhZScpLnZhbHVlLAogICAgICBwcm9tcHQ6JCgncHJvbXB0JykudmFsdWUsCiAgICAgIG5lZ2F0aXZlUHJvbXB0Om5lZywKICAgICAgaGVpZ2h0OnBhcnNlSW50KCQoJ2hlaWdodCcpLnZhbHVlKSwKICAgICAgd2lkdGg6cGFyc2VJbnQoJCgnd2lkdGgnKS52YWx1ZSksCiAgICAgIGltYWdlQ291bnQ6c3RhdGUubmNvbCwKICAgICAgc3RlcHM6cGFyc2VJbnQoJCgnc3RlcHMnKS52YWx1ZSksCiAgICAgIGltYWdlczppMmlEYXRhVXJsP1tpMmlEYXRhVXJsXTpbXSwKICAgICAgZGVub2lzaW5nU3RyZW5ndGg6cGFyc2VGbG9hdCgkKCdpMmktZHMnKS52YWx1ZSl8fDAuNSwKICAgICAgY2ZnU2NhbGU6cGFyc2VGbG9hdCgkKCdjZmcnKS52YWx1ZSksCiAgICAgIHNlZWQ6KCQoJ3NlZWQnKS52YWx1ZXx8JycpLnRyaW0oKXx8U3RyaW5nKE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSo5OTk5OTk5OTk5KSksCiAgICAgIGNsaXBTa2lwOnBhcnNlSW50KCQoJ2NsaXBza2lwJykudmFsdWUpLAogICAgICBldGFOb2lzZVNlZWREZWx0YTpwYXJzZUludCgkKCdldGFuc2QnKS52YWx1ZSksCiAgICAgIHYxQ2xpcDpmYWxzZSwKICAgICAgZW5hYmxlUGl4MnBpeDpzdGF0ZS5wYWdlPT09J2ltZycmJiEhaTJpRGF0YVVybCwKICAgICAgZ3VpZGFuY2U6My41LAogICAgICB1c2VGaXJzdExhc3RGcmFtZTpmYWxzZSwKICAgICAga3NhbXBsZXJOYW1lOiQoJ3NhbXBsZXInKS52YWx1ZSwKICAgICAgc2NoZWR1bGU6JCgnc2NoZWQnKS52YWx1ZQogICAgfSwKICAgIHByb3ZpZGVyOnNldHRpbmdzLnByb3ZpZGVyfHwndGFtcycsCiAgICBjcmVkaXRzOjEuMjIsCiAgICB0YXNrVHlwZTpzdGF0ZS5wYWdlPT09J2ltZycmJmkyaURhdGFVcmw/J0lNRzJJTUcnOidUWFQySU1HJywKICAgIGlzUmVtaXg6ZmFsc2UsCiAgICBjYXB0Y2hhVHlwZTonQ0xPVURGTEFSRV9UVVJOU1RJTEUnCiAgfTsKfQovKiA9PT09PT09PT09PT0gUkVLVFkgR0VORVJBVE9SIOKAlCB2ZXJzaSB3ZWIgZnVsbCA9PT09PT09PT09PT0KICogR2VuZXJhdGUgYXNsaSB2aWEgYmFja2VuZCAoL2FwaSAtPiBUZW5zb3IuQXJ0IE1vZGVsIFNlcnZpY2UpCiAqIGF0YXUgbW9kZSBkZW1vIChwaWNzdW0pIGthbGF1IGJhY2tlbmQvQVBJIGtleSBiZWx1bSBha3RpZi4KICogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwp2YXIgU0VUVElOR1NfS0VZPSdyZWt0eS5zZXR0aW5ncycsIFJFU1VMVFNfS0VZPSdyZWt0eS5yZXN1bHRzJzsKdmFyIHNldHRpbmdzPXsgbW9kZTonYXV0bycsIHByb3ZpZGVyOid0YW1zJywgYXBpS2V5OicnLCBwb2xsU2Vzc2lvbjonJyB9Owp2YXIgUFJPVklERVJfSU5GTz17CiAgdGFtczp7IGxhYmVsOidBUEkgS2V5IFRBTVMgKHRhbXMudGVuc29yLmFydCknLCBoaW50OidHcmF0aXMgZGkgdGFtcy50ZW5zb3IuYXJ0IOKAlCBwYWthaSBkYWZ0YXIgTW9kZWwgZGkgVUkuJyB9LAogIHJlcGxpY2F0ZTp7IGxhYmVsOidBUEkgVG9rZW4gUmVwbGljYXRlIChyZXBsaWNhdGUuY29tKScsIGhpbnQ6J1BpbGloIG1vZGVsIGRpIGthcnR1IE1vZGVsIChGTFVYLCBTRFhMLCBkc3QpLiBJbWcySW1nIGJlbHVtIGRpZHVrdW5nLicgfSwKICBmYWw6eyBsYWJlbDonQVBJIEtleSBmYWwuYWkgKGZhbC5haSknLCBoaW50OidQaWxpaCBtb2RlbCBkaSBrYXJ0dSBNb2RlbCAoRkxVWCwgU0RYTCwgZHN0KS4gSW1nMkltZyBiZWx1bSBkaWR1a3VuZy4nIH0sCiAgcG9sbGluYXRpb25zOnsgbGFiZWw6J0FQSSBLZXkgUG9sbGluYXRpb25zIChvcHNpb25hbCDigJQgc2tfKiknLCBoaW50OidHcmF0aXMgdGFucGEga2V5IChtb2RlbCBvdG9tYXRpcykuIElzaSBrZXkgc2tfKiBkYXJpIGVudGVyLnBvbGxpbmF0aW9ucy5haS9rZXlzIHVudHVrIGRhZnRhciBtb2RlbCBsZW5na2FwLiBIYXNpbCBvdG9tYXRpcyBkaWFyc2lwIHBlcm1hbmVuLicgfQp9OwoKZnVuY3Rpb24gbG9hZFNldHRpbmdzKCl7CiAgdHJ5ewogICAgdmFyIHM9SlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTRVRUSU5HU19LRVkpfHwne30nKTsKICAgIGlmKHMmJnR5cGVvZiBzPT09J29iamVjdCcpewogICAgICBzZXR0aW5ncy5tb2RlPXMubW9kZXx8J2F1dG8nOyBzZXR0aW5ncy5wcm92aWRlcj1zLnByb3ZpZGVyfHwndGFtcyc7IHNldHRpbmdzLmFwaUtleT1zLmFwaUtleXx8Jyc7CiAgICAgIHNldHRpbmdzLnBvbGxTZXNzaW9uPXMucG9sbFNlc3Npb258fCcnOwogICAgfQogIH1jYXRjaChlKXt9Cn0KZnVuY3Rpb24gc2F2ZVNldHRpbmdzKCl7IHRyeXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU0VUVElOR1NfS0VZLEpTT04uc3RyaW5naWZ5KHNldHRpbmdzKSk7IH1jYXRjaChlKXt9IH0KZnVuY3Rpb24gYXBwbHlTZXR0aW5nc1VJKCl7CiAgJCgnYXBpbW9kZScpLnZhbHVlPXNldHRpbmdzLm1vZGU7ICQoJ2FwaWtleScpLnZhbHVlPXNldHRpbmdzLmFwaUtleTsKICB1cGRhdGVQcm92aWRlclVJKCk7Cn0KZnVuY3Rpb24gdXBkYXRlUHJvdmlkZXJVSSgpewogIHZhciBpbmZvPVBST1ZJREVSX0lORk9bc2V0dGluZ3MucHJvdmlkZXJdfHxQUk9WSURFUl9JTkZPLnRhbXM7CiAgJCgnYXBpcHJvdmlkZXInKS52YWx1ZT1zZXR0aW5ncy5wcm92aWRlcjsKICAkKCdhcGlrZXktbGFiZWwnKS50ZXh0Q29udGVudD1pbmZvLmxhYmVsOwogICQoJ2FwaS1oaW50JykudGV4dENvbnRlbnQ9aW5mby5oaW50OwogIHZhciBpc1BvbGw9c2V0dGluZ3MucHJvdmlkZXI9PT0ncG9sbGluYXRpb25zJzsKICAkKCdhcGlrZXktZmllbGQnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLGlzUG9sbCk7CiAgJCgnYnlvcC1yb3cnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLCFpc1BvbGwpOwogIGlmKGlzUG9sbCkgcmVmcmVzaE9BdXRoU3RhdHVzKCk7CiAgdXBkYXRlQXBpU3RhdHVzKCk7CiAgLy8gR2FudGkgZGFmdGFyIG1vZGVsIHNlc3VhaSBwcm92aWRlciBha3RpZi4KICB2YXIgbGliPU1PREVMX0xJQlNbc2V0dGluZ3MucHJvdmlkZXJdfHxNT0RFTF9MSUJTLnRhbXM7CiAgaWYoTU9ERUxTIT09bGliKXsKICAgIE1PREVMUz1saWI7CiAgICBpZihNT0RFTFMubGVuZ3RoKSBzZXRNb2RlbChNT0RFTFNbMF0pOwogIH0KICAvLyBHYW50aSBkYWZ0YXIgTG9SQSBzZXN1YWkgcHJvdmlkZXIgKExvUkEgbGFtYSBkaWJlcnNpaGthbikuCiAgTE9SQV9MSUI9TE9SQV9MSUJTW3NldHRpbmdzLnByb3ZpZGVyXXx8TE9SQV9MSUJTLnRhbXM7CiAgTE9SQS5sZW5ndGg9MDsKICByZW5kZXJMb3JhKCk7CiAgLy8gUG9sbGluYXRpb25zOiBhbWJpbCBkYWZ0YXIgbW9kZWwgYXNsaSBkYXJpIEFQSSAoZmFsbGJhY2sga2UgZGFmdGFyIHN0YXRpcykuCiAgaWYoc2V0dGluZ3MucHJvdmlkZXI9PT0ncG9sbGluYXRpb25zJykgcmVmcmVzaFBvbGxpbmF0aW9uc01vZGVscygpOwp9CmZ1bmN0aW9uIHJlZnJlc2hQb2xsaW5hdGlvbnNNb2RlbHMoKXsKICBmZXRjaCgnL2FwaS9wb2xsaW5hdGlvbnMtbW9kZWxzJykudGhlbihmdW5jdGlvbihyKXsgcmV0dXJuIHIuanNvbigpOyB9KS50aGVuKGZ1bmN0aW9uKGQpewogICAgaWYoIWR8fCFBcnJheS5pc0FycmF5KGQubW9kZWxzKXx8IWQubW9kZWxzLmxlbmd0aCkgcmV0dXJuOwogICAgdmFyIGxpYj1kLm1vZGVscwogICAgICAuZmlsdGVyKGZ1bmN0aW9uKG0peyByZXR1cm4gbS5jYXRlZ29yeT09PSdpbWFnZScmJm0ubmFtZSYmbS5uYW1lLmluZGV4T2YoJ2J5b3AvJykhPT0wOyB9KQogICAgICAuc2xpY2UoMCw4MCkKICAgICAgLm1hcChmdW5jdGlvbihtKXsgcmV0dXJuIHsgbmFtZTptLnRpdGxlfHxtLm5hbWUsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6bS5icmFuZHx8JycsIHRodW1iOlN0cmluZyhtLm5hbWUpLnJlcGxhY2UoL1teYS16MC05XS9naSwnJyksIGJhZGdlOm0ucGFpZF9vbmx5PydQQUlEJzonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6bS5uYW1lIH07IH0pCiAgICAgIC5zb3J0KGZ1bmN0aW9uKGEsYil7IHJldHVybiAoYS5iYWRnZT09PSdQQUlEJz8xOjApLShiLmJhZGdlPT09J1BBSUQnPzE6MCk7IH0pOwogICAgaWYoIWxpYi5sZW5ndGgpIHJldHVybjsKICAgIE1PREVMX0xJQlMucG9sbGluYXRpb25zPWxpYjsKICAgIGlmKE1PREVMUz09PU1PREVMX0xJQlMucG9sbGluYXRpb25zKXsgc2V0TW9kZWwoTU9ERUxTWzBdKTsgfQogIH0pLmNhdGNoKGZ1bmN0aW9uKCl7fSk7Cn0KZnVuY3Rpb24gdXBkYXRlQXBpU3RhdHVzKCl7CiAgdmFyIGVsPSQoJ2FwaS1zdGF0dXMnKTsgaWYoIWVsKSByZXR1cm47CiAgaWYoc2V0dGluZ3MucHJvdmlkZXI9PT0ncG9sbGluYXRpb25zJyl7CiAgICBlbC50ZXh0Q29udGVudD1zZXR0aW5ncy5wb2xsU2Vzc2lvbj8nUG9sbGluYXRpb25zIMK3IEJZT1AnOidQb2xsaW5hdGlvbnMgwrcgZ3JhdGlzJzsKICAgIGVsLnN0eWxlLmNvbG9yPXNldHRpbmdzLnBvbGxTZXNzaW9uPycjMjdENENEJzonIzlhOWFhMic7CiAgICByZXR1cm47CiAgfQogIHZhciBuYW1lPXNldHRpbmdzLnByb3ZpZGVyPT09J3RhbXMnPydUQU1TJzooc2V0dGluZ3MucHJvdmlkZXI9PT0ncmVwbGljYXRlJz8nUmVwbGljYXRlJzonZmFsLmFpJyk7CiAgZWwudGV4dENvbnRlbnQ9bmFtZSsoc2V0dGluZ3MuYXBpS2V5Pycgwrcga2V5JzonIMK3IHRhbnBhIGtleScpOwogIGVsLnN0eWxlLmNvbG9yPXNldHRpbmdzLmFwaUtleT8nIzI3RDRDRCc6JyM5YTlhYTInOwp9CiQoJ2FwaXByb3ZpZGVyJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbigpewogIHNldHRpbmdzLnByb3ZpZGVyPSQoJ2FwaXByb3ZpZGVyJykudmFsdWU7IHNhdmVTZXR0aW5ncygpOyB1cGRhdGVQcm92aWRlclVJKCk7Cn0pOwokKCdhcGktc2F2ZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogIHNldHRpbmdzLm1vZGU9JCgnYXBpbW9kZScpLnZhbHVlOyBzZXR0aW5ncy5hcGlLZXk9JCgnYXBpa2V5JykudmFsdWUudHJpbSgpOwogIHNhdmVTZXR0aW5ncygpOyB1cGRhdGVQcm92aWRlclVJKCk7IHRvYXN0KCdQZW5nYXR1cmFuIEFQSSBkaXNpbXBhbicpOwp9KTsKJCgnYXBpLXRlc3QnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsYXN5bmMgZnVuY3Rpb24oKXsKICB2YXIgYj0kKCdhcGktdGVzdCcpOyBiLmRpc2FibGVkPXRydWU7IGIudGV4dENvbnRlbnQ9J1Rlcy4uLic7CiAgaWYoc2V0dGluZ3MucHJvdmlkZXI9PT0ncG9sbGluYXRpb25zJyl7CiAgICB0cnl7CiAgICAgIHZhciByPWF3YWl0IGZldGNoKCcvYXBpL2hlYWx0aCcpOwogICAgICB2YXIgZD1hd2FpdCByLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsO30pOwogICAgICBpZighci5vaykgdGhyb3cgbmV3IEVycm9yKCdIVFRQICcrci5zdGF0dXMpOwogICAgICB0b2FzdCgnQmFja2VuZCBPSyDCtyBCWU9QICcrKGQmJmQuYnlvcD8nc2lhcCAoQXBwIEtleSB0ZXJwYXNhbmcpJzonYmVsdW0gZGlrb25maWd1cmFzaSAoQXBwIEtleSknKSsnIMK3ICcrKHNldHRpbmdzLnBvbGxTZXNzaW9uPydzZXNpIGFrdGlmJzonYmVsdW0gbG9naW4nKSk7CiAgICAgIHJlZnJlc2hPQXV0aFN0YXR1cygpOwogICAgfWNhdGNoKGUpeyB0b2FzdCgnQmFja2VuZCB0aWRhayBha3RpZiDigJQgZGVwbG95IGRlbmdhbiBGdW5jdGlvbnMgYXRhdSBwYWthaSBtb2RlIGRlbW8nKTsgfQogICAgYi5kaXNhYmxlZD1mYWxzZTsgYi50ZXh0Q29udGVudD0nVGVzJzsKICAgIHJldHVybjsKICB9CiAgdHJ5ewogICAgdmFyIHI9YXdhaXQgZmV0Y2goJy9hcGkvaGVhbHRoJyx7aGVhZGVyczp7J3gtYXBpLWtleSc6JCgnYXBpa2V5JykudmFsdWUudHJpbSgpfHxzZXR0aW5ncy5hcGlLZXl9fSk7CiAgICB2YXIgZD1hd2FpdCByLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsfSk7CiAgICBpZighci5vaykgdGhyb3cgbmV3IEVycm9yKCdIVFRQICcrci5zdGF0dXMpOwogICAgdmFyIHBhcnRzPVtdOwogICAgaWYoZCYmZC5oYXNLZXlzKXsgWyd0YW1zJywncmVwbGljYXRlJywnZmFsJ10uZm9yRWFjaChmdW5jdGlvbihwKXsgaWYoZC5oYXNLZXlzW3BdKSBwYXJ0cy5wdXNoKHApOyB9KTsgfQogICAgdG9hc3QoJ0JhY2tlbmQgT0suIEtleSBkaSBlbnY6ICcrKHBhcnRzLmxlbmd0aD9wYXJ0cy5qb2luKCcsICcpOid0aWRhayBhZGEnKSsnLiBLZXkgZGkgYnJvd3NlcjogJysoc2V0dGluZ3MuYXBpS2V5PydhZGEnOid0aWRhaycpKTsKICB9Y2F0Y2goZSl7IHRvYXN0KCdCYWNrZW5kIHRpZGFrIGFrdGlmIOKAlCBkZXBsb3kgZGVuZ2FuIEZ1bmN0aW9ucyBhdGF1IHBha2FpIG1vZGUgZGVtbycpOyB9CiAgYi5kaXNhYmxlZD1mYWxzZTsgYi50ZXh0Q29udGVudD0nVGVzJzsKfSk7CgovKiAtLS0gQllPUCBPQXV0aCAoQnJpbmcgWW91ciBPd24gUG9sbGVuKSAtLS0KICogTG9naW4gdmlhIGVudGVyLnBvbGxpbmF0aW9ucy5haSAoUEtDRSBjb2RlIGZsb3cpIOKGkiBiYWNrZW5kIHR1a2FyIGtvZGUg4oaSCiAqIHRva2VuIHNrXyBzY29wZWQgdXNlciBkaXNpbXBhbiBkaSBLViBiYWNrZW5kOyBicm93c2VyIGN1bWEgcGVnYW5nIHNlc3Npb24uCiAqLwp2YXIgX29hdXRoVmVyaWZpZXJLZXk9J3Jla3R5Lm9hdXRoLnZlcmlmaWVyJywgX29hdXRoU3RhdGVLZXk9J3Jla3R5Lm9hdXRoLnN0YXRlJzsKZnVuY3Rpb24gX2I2NHVybChidWYpewogIHZhciBzPWJ0b2EoU3RyaW5nLmZyb21DaGFyQ29kZS5hcHBseShudWxsLG5ldyBVaW50OEFycmF5KGJ1ZikpKTsKICByZXR1cm4gcy5yZXBsYWNlKC9cKy9nLCctJykucmVwbGFjZSgvXC8vZywnXycpLnJlcGxhY2UoLz0rJC8sJycpOwp9CmZ1bmN0aW9uIF9yYW5kQjY0KGxlbil7IHZhciBhPW5ldyBVaW50OEFycmF5KGxlbik7IGNyeXB0by5nZXRSYW5kb21WYWx1ZXMoYSk7IHJldHVybiBfYjY0dXJsKGEpOyB9CmFzeW5jIGZ1bmN0aW9uIF9zaGEyNTZCNjR1cmwodGV4dCl7CiAgdmFyIGJ1Zj1hd2FpdCBjcnlwdG8uc3VidGxlLmRpZ2VzdCgnU0hBLTI1NicsbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHRleHQpKTsKICByZXR1cm4gX2I2NHVybChidWYpOwp9CmZ1bmN0aW9uIHN0YXJ0UG9sbE9BdXRoKCl7CiAgdmFyIHZlcmlmaWVyPV9yYW5kQjY0KDQ4KTsKICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShfb2F1dGhWZXJpZmllcktleSx2ZXJpZmllcik7CiAgdmFyIHN0YXRlPV9yYW5kQjY0KDE2KTsKICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShfb2F1dGhTdGF0ZUtleSxzdGF0ZSk7CiAgZmV0Y2goJy9hcGkvb2F1dGgvY29uZmlnJykudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gci5qc29uKCk7fSkudGhlbihhc3luYyBmdW5jdGlvbihjZmcpewogICAgaWYoIWNmZ3x8IWNmZy5jbGllbnRJZCkgdGhyb3cgbmV3IEVycm9yKCdiYWNrZW5kIGJlbHVtIHB1bnlhIEFwcCBLZXkgUG9sbGluYXRpb25zJyk7CiAgICB2YXIgY2hhbGxlbmdlPWF3YWl0IF9zaGEyNTZCNjR1cmwodmVyaWZpZXIpOwogICAgdmFyIHA9bmV3IFVSTFNlYXJjaFBhcmFtcyh7CiAgICAgIHJlc3BvbnNlX3R5cGU6J2NvZGUnLCBjbGllbnRfaWQ6Y2ZnLmNsaWVudElkLCByZWRpcmVjdF91cmk6Y2ZnLnJlZGlyZWN0VXJpLAogICAgICBzY29wZTondXNhZ2UnLCBzdGF0ZTpzdGF0ZSwKICAgICAgY29kZV9jaGFsbGVuZ2U6Y2hhbGxlbmdlLCBjb2RlX2NoYWxsZW5nZV9tZXRob2Q6J1MyNTYnCiAgICB9KTsKICAgIHdpbmRvdy5sb2NhdGlvbi5ocmVmPWNmZy5hdXRob3JpemVCYXNlKyc/JytwLnRvU3RyaW5nKCk7CiAgfSkuY2F0Y2goZnVuY3Rpb24oZSl7IHRvYXN0KCdHYWdhbCBtdWxhaSBsb2dpbjogJysoZSYmZS5tZXNzYWdlfHxlKSk7IH0pOwp9CmZ1bmN0aW9uIHJlZnJlc2hPQXV0aFN0YXR1cygpewogIHZhciBlbD0kKCdieW9wLXN0YXR1cycpLCBidG49JCgnYnlvcC1sb2dpbicpLCBvdXQ9JCgnYnlvcC1sb2dvdXQnKTsKICBpZighc2V0dGluZ3MucG9sbFNlc3Npb24peyBpZihlbCllbC5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgaWYob3V0KW91dC5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgcmV0dXJuOyB9CiAgZmV0Y2goJy9hcGkvb2F1dGgvc3RhdHVzP3Nlc3Npb249JytlbmNvZGVVUklDb21wb25lbnQoc2V0dGluZ3MucG9sbFNlc3Npb24pKS50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiByLmpzb24oKTt9KS50aGVuKGZ1bmN0aW9uKGQpewogICAgaWYoZCYmZC5jb25uZWN0ZWQpewogICAgICB2YXIgYmFsVHh0PScnOwogICAgICBpZihkLmJhbGFuY2UmJnR5cGVvZiBkLmJhbGFuY2U9PT0nb2JqZWN0Jyl7CiAgICAgICAgdmFyIGJ2PWQuYmFsYW5jZS5wb2xsZW5CYWxhbmNlIT1udWxsP2QuYmFsYW5jZS5wb2xsZW5CYWxhbmNlOihkLmJhbGFuY2UuYmFsYW5jZSE9bnVsbD9kLmJhbGFuY2UuYmFsYW5jZTpudWxsKTsKICAgICAgICBpZihidiE9bnVsbCkgYmFsVHh0PScgwrcgc2FsZG8gJytidisnIHBvbGxlbic7CiAgICAgIH0KICAgICAgZWwudGV4dENvbnRlbnQ9J1Rlcmh1YnVuZyDinJMnKyhkLmV4cGlyZXNJbj8oJyDCtyBzaXNhICcrTWF0aC5jZWlsKGQuZXhwaXJlc0luLzg2NDAwKSsnIGhhcmknKTonJykrYmFsVHh0OwogICAgICBlbC5zdHlsZS5jb2xvcj0nIzI3RDRDRCc7IGVsLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOwogICAgICBidG4udGV4dENvbnRlbnQ9J0xvZ2luIHVsYW5nIChnYW50aSBha3VuKSc7IG91dC5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsKICAgIH1lbHNlewogICAgICBlbC50ZXh0Q29udGVudD0nU2VzaSBiZXJha2hpciDigJQgbG9naW4gdWxhbmcnOyBlbC5zdHlsZS5jb2xvcj0nI2U1YTUwYSc7CiAgICAgIGVsLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyBvdXQuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7CiAgICAgIHNldHRpbmdzLnBvbGxTZXNzaW9uPScnOyBzYXZlU2V0dGluZ3MoKTsgdXBkYXRlQXBpU3RhdHVzKCk7CiAgICB9CiAgfSkuY2F0Y2goZnVuY3Rpb24oKXt9KTsKfQpmdW5jdGlvbiBwb2xsTG9nb3V0KCl7CiAgZmV0Y2goJy9hcGkvb2F1dGgvbG9nb3V0Jyx7bWV0aG9kOidQT1NUJyxoZWFkZXJzOnsnQ29udGVudC1UeXBlJzonYXBwbGljYXRpb24vanNvbid9LGJvZHk6SlNPTi5zdHJpbmdpZnkoe3Nlc3Npb246c2V0dGluZ3MucG9sbFNlc3Npb259KX0pLmNhdGNoKGZ1bmN0aW9uKCl7fSk7CiAgc2V0dGluZ3MucG9sbFNlc3Npb249Jyc7IHNhdmVTZXR0aW5ncygpOyB1cGRhdGVBcGlTdGF0dXMoKTsgcmVmcmVzaE9BdXRoU3RhdHVzKCk7CiAgdG9hc3QoJ1Nlc2kgUG9sbGluYXRpb25zIGRpY2FidXQnKTsKfQphc3luYyBmdW5jdGlvbiBoYW5kbGVPQXV0aENhbGxiYWNrKCl7CiAgaWYobG9jYXRpb24ucGF0aG5hbWUhPT0nL2NhbGxiYWNrJykgcmV0dXJuOwogIHZhciBxPW5ldyBVUkxTZWFyY2hQYXJhbXMobG9jYXRpb24uc2VhcmNoKTsKICB2YXIgaD1uZXcgVVJMU2VhcmNoUGFyYW1zKGxvY2F0aW9uLmhhc2guc2xpY2UoMSkpOwogIHZhciBlcnI9cS5nZXQoJ2Vycm9yJyl8fGguZ2V0KCdlcnJvcicpOwogIGlmKGVycil7IHRvYXN0KCdMb2dpbiBkaWJhdGFsa2FuOiAnK2Vycik7IGhpc3RvcnkucmVwbGFjZVN0YXRlKG51bGwsJycsJy8nKTsgcmV0dXJuOyB9CiAgdmFyIGNvZGU9cS5nZXQoJ2NvZGUnKTsKICB2YXIgc3RhdGU9cS5nZXQoJ3N0YXRlJyk7CiAgdmFyIHNhdmVkU3RhdGU9bG9jYWxTdG9yYWdlLmdldEl0ZW0oX29hdXRoU3RhdGVLZXkpOwogIHZhciB2ZXJpZmllcj1sb2NhbFN0b3JhZ2UuZ2V0SXRlbShfb2F1dGhWZXJpZmllcktleSk7CiAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oX29hdXRoU3RhdGVLZXkpOyBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShfb2F1dGhWZXJpZmllcktleSk7CiAgaWYoIWNvZGV8fCFzdGF0ZXx8c3RhdGUhPT1zYXZlZFN0YXRlfHwhdmVyaWZpZXIpewogICAgdG9hc3QoJ0NhbGxiYWNrIE9BdXRoIHRpZGFrIHZhbGlkJyk7IGhpc3RvcnkucmVwbGFjZVN0YXRlKG51bGwsJycsJy8nKTsgcmV0dXJuOwogIH0KICB2YXIgY2ZnPWF3YWl0IGZldGNoKCcvYXBpL29hdXRoL2NvbmZpZycpLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIHIuanNvbigpO30pLmNhdGNoKGZ1bmN0aW9uKCl7cmV0dXJuIG51bGw7fSk7CiAgdHJ5ewogICAgdmFyIHI9YXdhaXQgZmV0Y2goJy9hcGkvb2F1dGgvdG9rZW4nLHttZXRob2Q6J1BPU1QnLGhlYWRlcnM6eydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJ30sCiAgICAgIGJvZHk6SlNPTi5zdHJpbmdpZnkoe2NvZGU6Y29kZSxjb2RlX3ZlcmlmaWVyOnZlcmlmaWVyLHJlZGlyZWN0X3VyaTooY2ZnJiZjZmcucmVkaXJlY3RVcmkpfHwnJ30pfSk7CiAgICB2YXIgZD1hd2FpdCByLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsO30pOwogICAgaWYoIXIub2t8fCFkLnNlc3Npb24pIHRocm93IG5ldyBFcnJvcigoZCYmZC5lcnJvcil8fCgnSFRUUCAnK3Iuc3RhdHVzKSk7CiAgICBzZXR0aW5ncy5wb2xsU2Vzc2lvbj1kLnNlc3Npb247IHNhdmVTZXR0aW5ncygpOyB1cGRhdGVQcm92aWRlclVJKCk7CiAgICB0b2FzdCgnTG9naW4gUG9sbGluYXRpb25zIGJlcmhhc2lsIScpOwogIH1jYXRjaChlKXsgdG9hc3QoJ0dhZ2FsIHR1a2FyIGtvZGU6ICcrKGUmJmUubWVzc2FnZXx8ZSkpOyB9CiAgaGlzdG9yeS5yZXBsYWNlU3RhdGUobnVsbCwnJywnLycpOwp9CiQoJ2J5b3AtbG9naW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsc3RhcnRQb2xsT0F1dGgpOwokKCdieW9wLWxvZ291dCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxwb2xsTG9nb3V0KTsKCi8qIC0tLSB0b2FzdCAtLS0gKi8KdmFyIF90b2FzdFRpbWVyPW51bGw7CmZ1bmN0aW9uIHRvYXN0KG1zZyl7CiAgdmFyIHQ9JCgndG9hc3QnKTsgaWYoIXQpIHJldHVybjsKICB0LnRleHRDb250ZW50PW1zZzsgdC5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsKICBjbGVhclRpbWVvdXQoX3RvYXN0VGltZXIpOwogIF90b2FzdFRpbWVyPXNldFRpbWVvdXQoZnVuY3Rpb24oKXsgdC5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgfSwzNTAwKTsKfQoKLyogLS0tIHByb2dyZXNzIG92ZXJsYXkgLS0tICovCnZhciBfcG9sbFN0b3A9ZmFsc2U7CmZ1bmN0aW9uIHNob3dQcm9ncmVzcyh0aXRsZSxzdGF0dXMscGN0KXsKICAkKCdwcm9nLXRpdGxlJykudGV4dENvbnRlbnQ9dGl0bGU7CiAgJCgncHJvZy1zdGF0dXMnKS50ZXh0Q29udGVudD1zdGF0dXN8fCcnOwogICQoJ3Byb2ctYmFyJykuc3R5bGUud2lkdGg9TWF0aC5tYXgoMCxNYXRoLm1pbigxMDAscGN0fHwwKSkrJyUnOwogICQoJ3Byb2ctcGN0JykudGV4dENvbnRlbnQ9TWF0aC5yb3VuZChwY3R8fDApKyclJzsKICAkKCdwcm9nb3ZlcmxheScpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyAkKCdwcm9nb3ZlcmxheScpLmNsYXNzTGlzdC5hZGQoJ2ZsZXgnKTsKfQpmdW5jdGlvbiBoaWRlUHJvZ3Jlc3MoKXsgJCgncHJvZ292ZXJsYXknKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgncHJvZ292ZXJsYXknKS5jbGFzc0xpc3QucmVtb3ZlKCdmbGV4Jyk7IH0KJCgncHJvZy1jYW5jZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgX3BvbGxTdG9wPXRydWU7IHRvYXN0KCdNZW1iYXRhbGthbi4uLicpOyB9KTsKCi8qIC0tLSBBUEkgY2xpZW50IC0tLSAqLwpmdW5jdGlvbiBidWlsZEFwaUtleSgpeyByZXR1cm4gc2V0dGluZ3MuYXBpS2V5fHwkKCdhcGlrZXknKS52YWx1ZS50cmltKCk7IH0KCmZ1bmN0aW9uIF9hcGlIZWFkZXJzKGV4dHJhKXsKICB2YXIgaD17J3gtYXBpLWtleSc6YnVpbGRBcGlLZXkoKX07CiAgaWYoc2V0dGluZ3MucHJvdmlkZXI9PT0ncG9sbGluYXRpb25zJyYmc2V0dGluZ3MucG9sbFNlc3Npb24pIGhbJ3gtc2Vzc2lvbiddPXNldHRpbmdzLnBvbGxTZXNzaW9uOwogIGlmKGV4dHJhKSBmb3IodmFyIGsgaW4gZXh0cmEpIGhba109ZXh0cmFba107CiAgcmV0dXJuIGg7Cn0KYXN5bmMgZnVuY3Rpb24gYXBpR2VuZXJhdGUocGF5bG9hZCl7CiAgdmFyIHJlcz1hd2FpdCBmZXRjaCgnL2FwaS9nZW5lcmF0ZScse21ldGhvZDonUE9TVCcsaGVhZGVyczpfYXBpSGVhZGVycyh7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nfSksYm9keTpKU09OLnN0cmluZ2lmeShwYXlsb2FkKX0pOwogIHZhciBkPWF3YWl0IHJlcy5qc29uKCkuY2F0Y2goZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH0pOwogIGlmKCFyZXMub2spIHRocm93IG5ldyBFcnJvcigoZCYmZC5lcnJvcil8fCgnSFRUUCAnK3Jlcy5zdGF0dXMpKTsKICByZXR1cm4gZHx8e307Cn0KYXN5bmMgZnVuY3Rpb24gYXBpVGFzayh0YXNrSWQpewogIHZhciByZXM9YXdhaXQgZmV0Y2goJy9hcGkvdGFzaz9pZD0nK2VuY29kZVVSSUNvbXBvbmVudCh0YXNrSWQpLHtoZWFkZXJzOl9hcGlIZWFkZXJzKHt9KX0pOwogIHZhciBkPWF3YWl0IHJlcy5qc29uKCkuY2F0Y2goZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH0pOwogIGlmKCFyZXMub2spIHRocm93IG5ldyBFcnJvcigoZCYmZC5lcnJvcil8fCgnSFRUUCAnK3Jlcy5zdGF0dXMpKTsKICByZXR1cm4gZHx8e307Cn0KCmFzeW5jIGZ1bmN0aW9uIHBvbGxUYXNrKHRhc2tJZCxvblByb2cpewogIHZhciBzdGFydD1EYXRlLm5vdygpLCBtYXhNcz02KjYwKjEwMDA7CiAgd2hpbGUoRGF0ZS5ub3coKS1zdGFydDxtYXhNcyl7CiAgICBpZihfcG9sbFN0b3ApIHRocm93IG5ldyBFcnJvcignZGliYXRhbGthbiBwZW5nZ3VuYScpOwogICAgdmFyIGQ9YXdhaXQgYXBpVGFzayh0YXNrSWQpOwogICAgaWYoZC5zdGF0dXM9PT0nU1VDQ0VTUycpIHJldHVybiBkLmltYWdlc3x8W107CiAgICBpZihkLnN0YXR1cz09PSdGQUlMRUQnKSB0aHJvdyBuZXcgRXJyb3IoZC5lcnJvcnx8J1Rhc2sgZ2FnYWwnKTsKICAgIGlmKGQuc3RhdHVzPT09J0NBTkNFTEVEJykgdGhyb3cgbmV3IEVycm9yKCdUYXNrIGRpYmF0YWxrYW4nKTsKICAgIHZhciBzdD0oZC5zdGF0dXM9PT0nV0FJVElORycpPygnQW50cmUgJysoZC5xdWV1ZXx8JycpKTooZC5zdGF0dXM9PT0nUlVOTklORyc/J0dlbmVyYXRpbmcuLi4nOidNZW51bmdndS4uLicpOwogICAgb25Qcm9nKHN0LGQucHJvZ3Jlc3N8fDApOwogICAgYXdhaXQgbmV3IFByb21pc2UoZnVuY3Rpb24ocil7IHNldFRpbWVvdXQociwgZC5zdGF0dXM9PT0nV0FJVElORyc/NDAwMDoyMDAwKTsgfSk7CiAgfQogIHRocm93IG5ldyBFcnJvcignVGltZW91dCBtZW51bmdndSBoYXNpbCBnZW5lcmF0ZScpOwp9CgovKiAtLS0gaGFzaWwgLS0tICovCmZ1bmN0aW9uIG1rUmVzdWx0KHNyYyxwYXIsdGFza0lkLGNyZWRpdHMpewogIHJldHVybiB7CiAgICBzcmM6c3JjLCBwcm9tcHQ6cGFyLnBhcmFtcy5wcm9tcHQsIG5lZzpwYXIucGFyYW1zLm5lZ2F0aXZlUHJvbXB0LAogICAgbW9kZWw6c3RhdGUubW9kZWw/c3RhdGUubW9kZWwubmFtZTonJywKICAgIHNpemU6cGFyLnBhcmFtcy53aWR0aCsneCcrcGFyLnBhcmFtcy5oZWlnaHQsIHNlZWQ6cGFyLnBhcmFtcy5zZWVkLAogICAgdGFza0lkOnRhc2tJZHx8JycsIGNyZWRpdHM6Y3JlZGl0cyE9bnVsbD9jcmVkaXRzOicnLAogICAgdHM6RGF0ZS5ub3coKSwgZGVtbzpmYWxzZSwgcGFnZTpzdGF0ZS5wYWdlCiAgfTsKfQpmdW5jdGlvbiBkZW1vUmVzdWx0cyhwYXIpewogIHNob3dQcm9ncmVzcygnTW9kZSBkZW1vJywnTWVueWlhcGthbiBnYW1iYXIgc2ltdWxhc2kuLi4nLDE1KTsKICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7CiAgICBmb3IodmFyIGk9MDtpPHN0YXRlLm5jb2w7aSsrKXsKICAgICAgdmFyIHNyYz1TK01hdGguZmxvb3IoTWF0aC5yYW5kb20oKSoxZTkpKycvNTEyJzsKICAgICAgYWRkUmVzdWx0KHtzcmM6c3JjLCBwcm9tcHQ6cGFyLnBhcmFtcy5wcm9tcHQsIG5lZzpwYXIucGFyYW1zLm5lZ2F0aXZlUHJvbXB0LAogICAgICAgIG1vZGVsOnN0YXRlLm1vZGVsP3N0YXRlLm1vZGVsLm5hbWU6JycsIHNpemU6cGFyLnBhcmFtcy53aWR0aCsneCcrcGFyLnBhcmFtcy5oZWlnaHQsCiAgICAgICAgc2VlZDpwYXIucGFyYW1zLnNlZWQsIHRhc2tJZDonJywgY3JlZGl0czonJywgdHM6RGF0ZS5ub3coKSwgZGVtbzp0cnVlLCBwYWdlOnN0YXRlLnBhZ2V9KTsKICAgIH0KICAgIGhpZGVQcm9ncmVzcygpOwogIH0sNzAwKTsKfQoKYXN5bmMgZnVuY3Rpb24gZG9HZW5lcmF0ZSgpewogIGlmKHN0YXRlLmJ1c3kpIHJldHVybjsKICB2YXIgcD0kKCdwcm9tcHQnKS52YWx1ZS50cmltKCk7CiAgaWYoIXApeyBvcGVuTGVmdCgpOyAkKCdwcm9tcHQnKS5mb2N1cygpOyB0b2FzdCgnSXNpIHByb21wdCBkdWx1Jyk7IHJldHVybjsgfQogIHZhciBwYXI9YnVpbGRQYXlsb2FkKCk7CiAgc3RhdGUuYnVzeT10cnVlOyBzZXRCdXN5KHRydWUpOyBfcG9sbFN0b3A9ZmFsc2U7CiAgdHJ5ewogICAgaWYoc2V0dGluZ3MubW9kZT09PSdkZW1vJ3x8KCFidWlsZEFwaUtleSgpJiZzZXR0aW5ncy5wcm92aWRlciE9PSdwb2xsaW5hdGlvbnMnKSl7CiAgICAgIGF3YWl0IG5ldyBQcm9taXNlKGZ1bmN0aW9uKHIpeyBzZXRUaW1lb3V0KHIsMzAwKTsgfSk7CiAgICAgIGRlbW9SZXN1bHRzKHBhcik7CiAgICAgIGlmKCFidWlsZEFwaUtleSgpKSB0b2FzdCgnQmVsdW0gYWRhIEFQSSBrZXkg4oCUIGhhc2lsIHNpbXVsYXNpLiBJc2kgQVBJIEtleSBUQU1TIGRpIHBhbmVsIGtpcmkgdW50dWsgZ2VuZXJhdGUgYXNsaS4nKTsKICAgICAgZWxzZSB0b2FzdCgnTW9kZSBkZW1vIGFrdGlmIOKAlCBoYXNpbCBzaW11bGFzaS4nKTsKICAgIH1lbHNlewogICAgICBzaG93UHJvZ3Jlc3MoJ01lbmdpcmltIGtlIFRBTVMuLi4nLCdNZW55aWFwa2FuIHRhc2suLi4nLDUpOwogICAgICB2YXIgcj1hd2FpdCBhcGlHZW5lcmF0ZShwYXIpOwogICAgICB2YXIgdGFza0lkPXIudGFza0lkfHxyLmpvYklkOwogICAgICBpZih0YXNrSWQpewogICAgICAgIHZhciBpbWdzPWF3YWl0IHBvbGxUYXNrKHRhc2tJZCxmdW5jdGlvbihzdCxwY3QpeyBzaG93UHJvZ3Jlc3MoJ0dlbmVyYXRpbmcuLi4nLHN0LHBjdCk7IH0pOwogICAgICAgIGltZ3MuZm9yRWFjaChmdW5jdGlvbihzcmMpeyBhZGRSZXN1bHQobWtSZXN1bHQoc3JjLHBhcix0YXNrSWQsci5jcmVkaXRzKSk7IH0pOwogICAgICB9ZWxzZXsKICAgICAgICB2YXIgaW1nczI9ZXh0cmFjdEltYWdlcyhyKTsKICAgICAgICBpZighaW1nczIubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ1Jlc3BvbnNlIHRhbnBhIGdhbWJhcicpOwogICAgICAgIGltZ3MyLmZvckVhY2goZnVuY3Rpb24oc3JjKXsgYWRkUmVzdWx0KG1rUmVzdWx0KHNyYyxwYXIsJycsci5jcmVkaXRzKSk7IH0pOwogICAgICB9CiAgICB9CiAgfWNhdGNoKGUpewogICAgaWYoc2V0dGluZ3MubW9kZT09PSdhdXRvJyl7CiAgICAgIHRvYXN0KCdCYWNrZW5kL0FQSSBiZWx1bSBha3RpZiAoJytlLm1lc3NhZ2UrJykg4oCUIHBha2FpIHNpbXVsYXNpIGRlbW8nKTsKICAgICAgZGVtb1Jlc3VsdHMocGFyKTsKICAgIH1lbHNlewogICAgICB0b2FzdCgnR2FnYWw6ICcrZS5tZXNzYWdlKTsKICAgIH0KICB9ZmluYWxseXsKICAgIGhpZGVQcm9ncmVzcygpOyBzdGF0ZS5idXN5PWZhbHNlOyBzZXRCdXN5KGZhbHNlKTsKICB9Cn0KCi8qIC0tLSBJbWcySW1nIC0tLSAqLwp2YXIgaTJpRGF0YVVybD1udWxsOwokKCdpMmktZHJvcCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyAkKCdpMmktZmlsZScpLmNsaWNrKCk7IH0pOwokKCdpMmktZmlsZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsZnVuY3Rpb24oZSl7IGhhbmRsZUkyaUZpbGUoZS50YXJnZXQuZmlsZXMmJmUudGFyZ2V0LmZpbGVzWzBdKTsgfSk7CiQoJ2kyaS1kcm9wJykuYWRkRXZlbnRMaXN0ZW5lcignZHJhZ292ZXInLGZ1bmN0aW9uKGUpeyBlLnByZXZlbnREZWZhdWx0KCk7IH0pOwokKCdpMmktZHJvcCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLGZ1bmN0aW9uKGUpeyBlLnByZXZlbnREZWZhdWx0KCk7IGhhbmRsZUkyaUZpbGUoZS5kYXRhVHJhbnNmZXIuZmlsZXMmJmUuZGF0YVRyYW5zZmVyLmZpbGVzWzBdKTsgfSk7CiQoJ2kyaS1kcycpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbihlKXsgJCgnaTJpLWRzdicpLnRleHRDb250ZW50PXBhcnNlRmxvYXQoZS50YXJnZXQudmFsdWUpLnRvRml4ZWQoMik7IH0pOwokKCdpMmktY2xlYXInKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICBpMmlEYXRhVXJsPW51bGw7ICQoJ2kyaS1wcmV2aWV3JykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ2kyaS1pbWcnKS5zcmM9Jyc7ICQoJ2kyaS1kcm9wJykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7Cn0pOwpmdW5jdGlvbiBoYW5kbGVJMmlGaWxlKGYpewogIGlmKCFmKSByZXR1cm47CiAgdmFyIHJkPW5ldyBGaWxlUmVhZGVyKCk7CiAgcmQub25sb2FkPWZ1bmN0aW9uKCl7CiAgICBpMmlEYXRhVXJsPXJkLnJlc3VsdDsKICAgICQoJ2kyaS1pbWcnKS5zcmM9cmQucmVzdWx0OyAkKCdpMmktcHJldmlldycpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyAkKCdpMmktZHJvcCcpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOwogIH07CiAgcmQucmVhZEFzRGF0YVVSTChmKTsKfQoKLyogLS0tIHJlbmRlciBwZXIgdGFiIC0tLSAqLwpmdW5jdGlvbiByZW5kZXJDYW52YXMoKXsKICB2YXIgcGFnZT1zdGF0ZS5wYWdlOwogIHZhciBoaWRlTWFpbiA9ICEocGFnZT09PSd0ZXh0J3x8cGFnZT09PSdpbWcnKTsKICAkKCdpbWcyaW1nLWNhcmQnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLCBwYWdlIT09J2ltZycpOwogICQoJ2VtcHR5Jykuc3R5bGUuZGlzcGxheSA9IChoaWRlTWFpbiB8fCBzdGF0ZS5yZXN1bHRzLmxlbmd0aD4wKSA/ICdub25lJyA6ICcnOwogICQoJ2dyaWQnKS5zdHlsZS5kaXNwbGF5ID0gaGlkZU1haW4/J25vbmUnOicnOwogICQoJ3RhYi1wbGFjZWhvbGRlcicpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicsICFoaWRlTWFpbik7CiAgJCgndGFiLXBsYWNlaG9sZGVyJykuY2xhc3NMaXN0LnRvZ2dsZSgnZmxleCcsIGhpZGVNYWluKTsKICBpZihwYWdlPT09J2VkaXQnKSAkKCd0YWItcGxhY2Vob2xkZXItdGV4dCcpLnRleHRDb250ZW50PSdFZGl0IC8gSW5wYWludGluZyDigJQgc2VnZXJhIGhhZGlyJzsKICBlbHNlIGlmKHBhZ2U9PT0ndmlkZW8nKSAkKCd0YWItcGxhY2Vob2xkZXItdGV4dCcpLnRleHRDb250ZW50PSdUZXh0IC8gSW1hZ2UgdG8gVmlkZW8g4oCUIHNlZ2VyYSBoYWRpcic7CiAgZWxzZSBpZihwYWdlPT09J3ByaW1lJykgJCgndGFiLXBsYWNlaG9sZGVyLXRleHQnKS50ZXh0Q29udGVudD0nUHJpbWUg4oCUIHNlZ2VyYSBoYWRpcic7Cn0KCi8qIC0tLSByaXdheWF0IGRpIG1vYmlsZSAtLS0gKi8KJCgnYnRuLWhpc3RvcnknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgncmlnaHRQYW4nKS5jbGFzc0xpc3QudG9nZ2xlKCdtb2JpbGUtb3BlbicpOyB9KTsKJCgnb3ZlcmxheScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyAkKCdyaWdodFBhbicpLmNsYXNzTGlzdC5yZW1vdmUoJ21vYmlsZS1vcGVuJyk7IH0pOwoKcmVuZGVyTG9yYSgpOwpzZXRNb2RlbChNT0RFTFNbMF0pOwp1cGRXSCgpOwphcHBseU5jb2woKTsKbG9hZFNldHRpbmdzKCk7IGFwcGx5U2V0dGluZ3NVSSgpOwpoYW5kbGVPQXV0aENhbGxiYWNrKCk7CnRyeXsKICB2YXIgc2F2ZWQ9SlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShSRVNVTFRTX0tFWSl8fCdbXScpOwogIGlmKEFycmF5LmlzQXJyYXkoc2F2ZWQpKSBzdGF0ZS5yZXN1bHRzPXNhdmVkOwp9Y2F0Y2goZSl7fQpyZW5kZXJDYW52YXMoKTsKcmVuZGVyR3JpZCgpOwpyZW5kZXJSaWdodCgpOwo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+CgoK';
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
