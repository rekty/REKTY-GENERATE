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
const HTML_B64 = 'PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImlkIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04IiAvPgo8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLGluaXRpYWwtc2NhbGU9MSIgLz4KPHRpdGxlPlJla3R5IEFJIOKAlCBUZXh0IHRvIEltYWdlPC90aXRsZT4KPHNjcmlwdD53aW5kb3cuX190YV9zdHlsZV9fPXRydWU8L3NjcmlwdD4KPHNjcmlwdCBzcmM9Imh0dHBzOi8vY2RuLnRhaWx3aW5kY3NzLmNvbSI+PC9zY3JpcHQ+CjxzY3JpcHQgc3JjPSJodHRwczovL3VucGtnLmNvbS9AcGhvc3Bob3ItaWNvbnMvd2ViL3Bob3NwaG9yLWljb24uanMiPjwvc2NyaXB0Pgo8bGluayByZWw9InByZWNvbm5lY3QiIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20iPgo8bGluayBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tL2NzczI/ZmFtaWx5PUludGVyOndnaHRANDAwOzUwMDs2MDA7NzAwJmRpc3BsYXk9c3dhcCIgcmVsPSJzdHlsZXNoZWV0Ij4KPHN0eWxlPgpodG1sLGJvZHl7bWFyZ2luOjA7cGFkZGluZzowO2ZvbnQtZmFtaWx5Oi1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LCdTZWdvZSBVSScsUm9ib3RvLCdIZWx2ZXRpY2EgTmV1ZScsQXJpYWwsJ05vdG8gU2Fucycsc2Fucy1zZXJpZjtiYWNrZ3JvdW5kOiMwZDExMTc7Y29sb3I6I2U4ZThlODttaW4taGVpZ2h0OjEwMHZofQouaGlkZWJhcjo6LXdlYmtpdC1zY3JvbGxiYXJ7ZGlzcGxheTpub25lfS5oaWRlYmFye3Njcm9sbGJhci13aWR0aDpub25lfQo6Oi13ZWJraXQtc2Nyb2xsYmFye3dpZHRoOjhweDtoZWlnaHQ6OHB4fQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1ie2JhY2tncm91bmQ6IzMwMzYzZDtib3JkZXItcmFkaXVzOjRweH0KOjotd2Via2l0LXNjcm9sbGJhci10aHVtYjpob3ZlcntiYWNrZ3JvdW5kOiMzZDQ0NGR9Cjo6LXdlYmtpdC1zY3JvbGxiYXItdHJhY2t7YmFja2dyb3VuZDp0cmFuc3BhcmVudH0KLmdmaWx7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjExcHg7Y29sb3I6IzljYTNhZjtiYWNrZ3JvdW5kOiMxYzIxMjg7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjouMTJzfQouZ2ZpbDpob3Zlcntjb2xvcjojZmZmO2JvcmRlci1jb2xvcjojM2Q0NDRkfQouZ2ZpbC5zZWx7YmFja2dyb3VuZDojZmZmO2NvbG9yOiMwZDExMTc7Ym9yZGVyLWNvbG9yOiNmZmY7Zm9udC13ZWlnaHQ6NjAwfQouYmR7Ym9yZGVyLWNvbG9yOiMzMDM2M2R9Ci5pbnB7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2JvcmRlci1yYWRpdXM6OHB4O2JhY2tncm91bmQ6IzFjMjEyODtjb2xvcjojZThlOGU4O3BhZGRpbmc6OHB4IDExcHg7b3V0bGluZTpub25lO2ZvbnQtc2l6ZToxM3B4O3dpZHRoOjEwMCV9Ci5pbnA6Zm9jdXN7Ym9yZGVyLWNvbG9yOiM2RjVERkZ9Ci5idG57Ym9yZGVyLXJhZGl1czoxMHB4O2ZvbnQtd2VpZ2h0OjYwMDt0cmFuc2l0aW9uOi4xNXM7Y3Vyc29yOnBvaW50ZXI7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtnYXA6NnB4O2ZvbnQtc2l6ZToxM3B4fQouYnRuLWJsdWV7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiAwJSwjMjdENENEIDU5LjclLCM3NEZGN0UgMTAwJSk7Ym9yZGVyOm5vbmU7Y29sb3I6I2ZmZjtib3gtc2hhZG93OjAgMCAxOHB4IHJnYmEoMTExLDkzLDI1NSwuMzUpO3BhZGRpbmc6MCAxOHB4fQouYnRuLWJsdWU6aG92ZXJ7ZmlsdGVyOmJyaWdodG5lc3MoMS4xKTtib3gtc2hhZG93OjAgMCAyNHB4IHJnYmEoMTExLDkzLDI1NSwuNSl9Ci5idG4tYmx1ZTphY3RpdmV7dHJhbnNmb3JtOnNjYWxlKC45OCl9Ci8qIFRvbWJvbCBHZW5lcmF0ZSBzZXBlcnRpIFRlbnNvci5BcnQ6IHR1cnF1b2lzZS1ibHVlICovCi5idG4tdHVycXtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsIzFGQzdDRSAwJSwjMkU3Q0YwIDEwMCUpO2JvcmRlcjpub25lO2NvbG9yOiNmZmY7Ym94LXNoYWRvdzowIDAgMTZweCByZ2JhKDMxLDE5OSwyMDYsLjM1KTtwYWRkaW5nOjAgMTZweH0KLmJ0bi10dXJxOmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMSk7Ym94LXNoYWRvdzowIDAgMjJweCByZ2JhKDMxLDE5OSwyMDYsLjUpfQouYnRuLXR1cnE6YWN0aXZle3RyYW5zZm9ybTpzY2FsZSguOTgpfQouYnRuLWdob3N0e2NvbG9yOiNhMWExYWE7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHRyYW5zcGFyZW50fS5idG4tZ2hvc3Q6aG92ZXJ7YmFja2dyb3VuZDojMWMyMTI4O2NvbG9yOiNlOGU4ZTh9Ci50YWJ7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtwYWRkaW5nOjZweCAxMnB4O2JvcmRlci1yYWRpdXM6OHB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7Zm9udC13ZWlnaHQ6NTAwO3doaXRlLXNwYWNlOm5vd3JhcDt0cmFuc2l0aW9uOi4xMnN9Ci50YWI6aG92ZXJ7Y29sb3I6I2ZmZjtiYWNrZ3JvdW5kOiMxYzIxMjh9LnRhYi5zZWx7Y29sb3I6I2ZmZjtiYWNrZ3JvdW5kOiMxYzIxMjh9Ci50YWIgLmRvdHt3aWR0aDo2cHg7aGVpZ2h0OjZweDtib3JkZXItcmFkaXVzOjUwJTtkaXNwbGF5OmlubGluZS1ibG9ja30KLnRhYi5zZWwgLmRvdHtkaXNwbGF5Om5vbmV9Ci50YWIuc2VsOjphZnRlcntjb250ZW50OiIiO3Bvc2l0aW9uOmFic29sdXRlO2JvdHRvbTotMXB4O2xlZnQ6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGVYKC01MCUpO3dpZHRoOjIwcHg7aGVpZ2h0OjJweDtib3JkZXItcmFkaXVzOjJweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5NWRlZywjNkY1REZGLCMyN0Q0Q0QpO3Bvc2l0aW9uOmFic29sdXRlfQoudGFie3Bvc2l0aW9uOnJlbGF0aXZlfQouc2xpZGVyey13ZWJraXQtYXBwZWFyYW5jZTpub25lO2FwcGVhcmFuY2U6bm9uZTtoZWlnaHQ6NHB4O2JvcmRlci1yYWRpdXM6NHB4O2JhY2tncm91bmQ6IzMwMzYzZDtvdXRsaW5lOm5vbmU7d2lkdGg6MTAwJX0KLnNsaWRlcjo6LXdlYmtpdC1zbGlkZXItdGh1bWJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7YXBwZWFyYW5jZTpub25lO3dpZHRoOjE1cHg7aGVpZ2h0OjE1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDojZmZmO2JvcmRlcjozcHggc29saWQgIzZGNURGRjtjdXJzb3I6cG9pbnRlcjtib3gtc2hhZG93OjAgMCA2cHggcmdiYSgxMTEsOTMsMjU1LC40KTt0cmFuc2l0aW9uOi4xMnN9Ci5zbGlkZXI6Oi13ZWJraXQtc2xpZGVyLXRodW1iOmhvdmVye3RyYW5zZm9ybTpzY2FsZSgxLjEpfQoubG9yYS1zbHstd2Via2l0LWFwcGVhcmFuY2U6bm9uZTthcHBlYXJhbmNlOm5vbmU7aGVpZ2h0OjRweDtib3JkZXItcmFkaXVzOjRweDtiYWNrZ3JvdW5kOiMzMDM2M2Q7b3V0bGluZTpub25lfQoubG9yYS1zbDo6LXdlYmtpdC1zbGlkZXItdGh1bWJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7d2lkdGg6MTRweDtoZWlnaHQ6MTRweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOiNmZmY7Ym9yZGVyOjJweCBzb2xpZCAjNkY1REZGO2N1cnNvcjpwb2ludGVyfQoubG9yYS1jYXJke3Bvc2l0aW9uOnJlbGF0aXZlO2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjEwcHg7YmFja2dyb3VuZDojMWMyMTI4O3RyYW5zaXRpb246LjEycztwYWRkaW5nOjhweCAxMHB4IDEwcHh9Ci5sb3JhLWNhcmQ6aG92ZXJ7Ym9yZGVyLWNvbG9yOiMzZDQ0NGR9Ci5sb3JhLWxhYmVse3Bvc2l0aW9uOmFic29sdXRlO3RvcDowO2xlZnQ6MDtmb250LXNpemU6OXB4O2NvbG9yOiM5YTlhYTI7YmFja2dyb3VuZDojMjEyNjJkO2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMSk7cGFkZGluZzoycHggNnB4O2JvcmRlci1yYWRpdXM6NnB4O2JvcmRlci10b3AtbGVmdC1yYWRpdXM6MTBweDtib3JkZXItYm90dG9tLXJpZ2h0LXJhZGl1czo2cHg7ei1pbmRleDoyfQoubG9yYS10b3B7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4O21hcmdpbi10b3A6OHB4fQoubG9yYS10aHVtYnt3aWR0aDozNHB4O2hlaWdodDozNHB4O2JvcmRlci1yYWRpdXM6NnB4O2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtvYmplY3QtZml0OmNvdmVyO2ZsZXgtc2hyaW5rOjB9Ci5sb3JhLW5hbWV7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOiNlOGU4ZTg7ZmxleDoxO21pbi13aWR0aDowO3doaXRlLXNwYWNlOm5vd3JhcDtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpc30KLmxvcmEtaWNvbnN7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MnB4O2ZsZXgtc2hyaW5rOjB9Ci5sb3JhLWljb257d2lkdGg6MjJweDtoZWlnaHQ6MjJweDtib3JkZXItcmFkaXVzOjRweDtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y29sb3I6IzcxNzE3YTtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O3RyYW5zaXRpb246LjEyc30KLmxvcmEtaWNvbjpob3ZlcntiYWNrZ3JvdW5kOiMyMTI2MmQ7Y29sb3I6I2ZmZn0KLmxvcmEtaWNvbi5kZWw6aG92ZXJ7YmFja2dyb3VuZDpyZ2JhKDIzOSw2OCw2OCwuMTUpO2NvbG9yOiNlZjQ0NDR9Ci5sb3JhLWljb24gc3Zne3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7c3Ryb2tlOmN1cnJlbnRDb2xvcjtmaWxsOm5vbmU7c3Ryb2tlLXdpZHRoOjJ9Ci5sb3JhLXNsaWRlci1yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6NHB4O21hcmdpbi10b3A6NnB4fQoubC1zbGlkZXJ7cG9zaXRpb246cmVsYXRpdmU7ZmxleDoxO2hlaWdodDoxNnB4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXJ9Ci5sLXRyYWNre3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDtyaWdodDowO2hlaWdodDo0cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDojMzAzNjNkfQoubC1maWxse3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDt0b3A6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpO2hlaWdodDo0cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiwjMjdENENEKX0KLmwtaGFuZGxle3Bvc2l0aW9uOmFic29sdXRlO3RvcDo1MCU7dHJhbnNmb3JtOnRyYW5zbGF0ZSgtNTAlLC01MCUpO3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDojZmZmO2JvcmRlcjoycHggc29saWQgIzZGNURGRjtib3gtc2hhZG93OjAgMXB4IDNweCByZ2JhKDAsMCwwLC40KTtwb2ludGVyLWV2ZW50czpub25lfQoubG9yYS1zbHtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7b3BhY2l0eTowO2N1cnNvcjpwb2ludGVyfQoubC1udW17ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MnB4O2ZsZXgtc2hyaW5rOjB9Ci5sb3JhLWlucHV0e3dpZHRoOjMwcHg7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xNSk7Ym9yZGVyLXJhZGl1czo2cHg7YmFja2dyb3VuZDojMGQxMTE3O2NvbG9yOiNlOGU4ZTg7Zm9udC1zaXplOjEycHg7dGV4dC1hbGlnbjpjZW50ZXI7b3V0bGluZTpub25lO3BhZGRpbmc6NHB4IDB9Ci5sb3JhLWlucHV0OmZvY3Vze2JvcmRlci1jb2xvcjojNkY1REZGfQoubG9yYS11cmwtaW5we2ZvbnQtc2l6ZToxMXB4O3BhZGRpbmc6NnB4IDlweDttYXJnaW4tdG9wOjJweH0KLmxvcmEtYnRue3dpZHRoOjIycHg7aGVpZ2h0OjIycHg7Ym9yZGVyLXJhZGl1czo1MCU7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOiM5YTlhYTI7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTt0cmFuc2l0aW9uOi4xMnN9Ci5sb3JhLWJ0bjpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoMjU1LDI1NSwyNTUsLjEpO2NvbG9yOiNmZmZ9Ci5sb3JhLWJ0biBzdmd7d2lkdGg6MTRweDtoZWlnaHQ6MTRweDtzdHJva2U6Y3VycmVudENvbG9yO2ZpbGw6bm9uZTtzdHJva2Utd2lkdGg6MjtzdHJva2UtbGluZWNhcDpyb3VuZH0KLnRhZ3tiYWNrZ3JvdW5kOiMxYzIxMjg7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2NvbG9yOiNlMGUwZTA7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjRweDtmb250LXNpemU6MTJweDtwYWRkaW5nOjRweCA4cHg7Ym9yZGVyLXJhZGl1czo2cHh9Ci5hcntib3JkZXI6MXB4IHNvbGlkICMzMDM2M2Q7Ym9yZGVyLXJhZGl1czoxMHB4O2JhY2tncm91bmQ6IzFjMjEyODtjb2xvcjojZmZmO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjJweDtwYWRkaW5nOjhweCAycHg7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjouMTJzO21pbi13aWR0aDowfQouYXI6aG92ZXJ7Ym9yZGVyLWNvbG9yOiMzZDQ0NGR9Ci5hci5zZWx7Ym9yZGVyLWNvbG9yOiMyN0Q0Q0Q7YmFja2dyb3VuZDojMTYxYjIyfQouYXIuc2VsIC5hci1kZXNje2NvbG9yOiMyN0Q0Q0R9Ci5hci1pY297d2lkdGg6MjRweDtoZWlnaHQ6MjRweDtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXJ9Ci5hci1pY28gc3Zne3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCV9Ci5hci1uYW1le2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiNlOGU4ZTg7d2hpdGUtc3BhY2U6bm93cmFwfQouYXItZGVzY3tmb250LXNpemU6OXB4O2NvbG9yOiM5YTlhYTI7d2hpdGUtc3BhY2U6bm93cmFwfQouZmllbGR7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6M3B4fQoucnRhYntib3JkZXI6MXB4IHNvbGlkIHRyYW5zcGFyZW50O2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50fQoucnRhYjpob3Zlcntjb2xvcjojZmZmfS5ydGFiLnNlbHtiYWNrZ3JvdW5kOiMxYzIxMjg7Y29sb3I6I2ZmZn0KLnJjYXJke2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjEwcHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6IzE2MWIyMn0KLmNoaXB7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOiMxYzIxMjg7dHJhbnNpdGlvbjouMTJzfQouY2hpcDpob3Zlcntjb2xvcjojZmZmfS5jaGlwLm9ue2JvcmRlci1jb2xvcjojNkY1REZGO2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMTYxYjIyfQojdG9hc3R7Ym94LXNoYWRvdzowIDhweCAzMHB4IHJnYmEoMCwwLDAsLjUpfQpAbWVkaWEgKG1heC13aWR0aDoxMDIzcHgpeyNyaWdodFBhbi5tb2JpbGUtb3Blbntwb3NpdGlvbjpmaXhlZDt0b3A6NTZweDtyaWdodDowO2JvdHRvbTowO2xlZnQ6YXV0bzt6LWluZGV4OjQwO2Rpc3BsYXk6ZmxleDt3aWR0aDptaW4oMjFyZW0sOTJ2dyk7Ym94LXNoYWRvdzotOHB4IDAgMzBweCByZ2JhKDAsMCwwLC41KX19CnRleHRhcmVhe2NhcmV0LWNvbG9yOiM2RjVERkZ9CmlucHV0W3R5cGU9Y2hlY2tib3hde3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7Y3Vyc29yOnBvaW50ZXJ9CmlucHV0W3R5cGU9cmFuZ2Vde2N1cnNvcjpwb2ludGVyfQo6Zm9jdXMtdmlzaWJsZXtvdXRsaW5lOjJweCBzb2xpZCAjNkY1REZGO291dGxpbmUtb2Zmc2V0OjJweH0KLnd2bnVte2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOiMxYzIxMjg7Y29sb3I6I2U4ZThlODtwYWRkaW5nOjNweCA2cHg7d2lkdGg6NjRweDtmb250LXNpemU6MTJweDt0ZXh0LWFsaWduOnJpZ2h0O291dGxpbmU6bm9uZX0KLnd2bnVtOmZvY3Vze2JvcmRlci1jb2xvcjojMjdENENEfQoubXRhYntwYWRkaW5nOjhweCAxNHB4O2JvcmRlci1yYWRpdXM6OHB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7Zm9udC13ZWlnaHQ6NTAwO3doaXRlLXNwYWNlOm5vd3JhcDt0cmFuc2l0aW9uOi4xMnN9Ci5tdGFiOmhvdmVye2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMWMyMTI4fS5tdGFiLnNlbHtjb2xvcjojZmZmO2JhY2tncm91bmQ6IzFjMjEyODtib3JkZXItYm90dG9tOjJweCBzb2xpZCAjNkY1REZGfQoubWNoaXB7Ym9yZGVyOjFweCBzb2xpZCAjMzAzNjNkO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOiMxYzIxMjg7dHJhbnNpdGlvbjouMTJzO3doaXRlLXNwYWNlOm5vd3JhcH0KLm1jaGlwOmhvdmVye2NvbG9yOiNmZmZ9Lm1jaGlwLm9ue2JvcmRlci1jb2xvcjojNkY1REZGO2NvbG9yOiNmZmY7YmFja2dyb3VuZDpyZ2JhKDExMSw5MywyNTUsLjE1KX0KLm1jYXJke2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjEwcHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6IzFjMjEyODt0cmFuc2l0aW9uOi4xNXN9Ci5tY2FyZDpob3Zlcntib3JkZXItY29sb3I6cmdiYSgxMTEsOTMsMjU1LC41NSk7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTJweCk7Ym94LXNoYWRvdzowIDZweCAxOHB4IHJnYmEoMCwwLDAsLjM1KX0KLm1jYXJkLWltZ3twb3NpdGlvbjpyZWxhdGl2ZTthc3BlY3QtcmF0aW86My80O292ZXJmbG93OmhpZGRlbn0KLm1jYXJkLWltZyBpbWd7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtvYmplY3QtZml0OmNvdmVyO3RyYW5zaXRpb246LjNzfQoubWNhcmQ6aG92ZXIgLm1jYXJkLWltZyBpbWd7dHJhbnNmb3JtOnNjYWxlKDEuMDUpfQoubWNhcmQtYmFkZ2V7cG9zaXRpb246YWJzb2x1dGU7dG9wOjZweDtsZWZ0OjZweDtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjY1KTtiYWNrZHJvcC1maWx0ZXI6Ymx1cig0cHgpO2ZvbnQtc2l6ZToxMHB4O3BhZGRpbmc6MnB4IDZweDtib3JkZXItcmFkaXVzOjRweDtjb2xvcjojZThlOGU4O2ZvbnQtd2VpZ2h0OjUwMH0KLm1jYXJkLXN0YXJ7cG9zaXRpb246YWJzb2x1dGU7dG9wOjZweDtyaWdodDo2cHg7d2lkdGg6MjZweDtoZWlnaHQ6MjZweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjUpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDRweCk7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2N1cnNvcjpwb2ludGVyO2NvbG9yOiM5YTlhYTI7dHJhbnNpdGlvbjouMTJzfQoubWNhcmQtc3Rhcjpob3Zlcntjb2xvcjojZWFiMzA4fS5tY2FyZC1zdGFyLm9ue2NvbG9yOiNlYWIzMDh9Ci5tY2FyZC12aWV3c3twb3NpdGlvbjphYnNvbHV0ZTtib3R0b206NnB4O2xlZnQ6NnB4O2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNik7YmFja2Ryb3AtZmlsdGVyOmJsdXIoNHB4KTtmb250LXNpemU6MTBweDtwYWRkaW5nOjJweCA2cHg7Ym9yZGVyLXJhZGl1czo0cHg7Y29sb3I6I2U4ZThlODtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDozcHh9Ci5tY2FyZC1pbmZve3BhZGRpbmc6OHB4fQoubWNhcmQtbmFtZXtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo2MDA7Y29sb3I6I2U4ZThlODt3aGl0ZS1zcGFjZTpub3dyYXA7b3ZlcmZsb3c6aGlkZGVuO3RleHQtb3ZlcmZsb3c6ZWxsaXBzaXN9Ci5tY2FyZC1tZXRhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47bWFyZ2luLXRvcDo2cHh9Ci5tY2FyZC12ZXJ7Zm9udC1zaXplOjExcHg7Y29sb3I6IzlhOWFhMjtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxcHggc29saWQgIzMwMzYzZDtib3JkZXItcmFkaXVzOjRweDtwYWRkaW5nOjJweCA2cHh9Ci5tY2FyZC1zZWx7Zm9udC1zaXplOjExcHg7Ym9yZGVyOjFweCBzb2xpZCAjNkY1REZGO2NvbG9yOiM2RjVERkY7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXItcmFkaXVzOjRweDtwYWRkaW5nOjJweCAxMHB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcjt0cmFuc2l0aW9uOi4xMnN9Ci5tY2FyZC1zZWw6aG92ZXJ7YmFja2dyb3VuZDojNkY1REZGO2NvbG9yOiNmZmZ9Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+Cgo8aGVhZGVyIGNsYXNzPSJmaXhlZCB0b3AtMCBsZWZ0LTAgcmlnaHQtMCB6LTQwIGgtMTQgYmctWyMwZDExMTddLzg1IGJhY2tkcm9wLWJsdXIgYm9yZGVyLWIgYmQgZmxleCBpdGVtcy1jZW50ZXIgcHgtMiBzbTpweC0zIGdhcC0yIj4KICA8YnV0dG9uIGlkPSJtbWVudSIgY2xhc3M9ImxnOmhpZGRlbiB0ZXh0LW5ldXRyYWwtNDAwIHAtMSI+PGkgZGF0YS1pY29uPSJsaXN0IiBjbGFzcz0idy01IGgtNSI+PC9pPjwvYnV0dG9uPgogIDxkaXYgY2xhc3M9InctNiBoLTYgc2hyaW5rLTAgaGlkZGVuIHNtOmZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIj4KICAgIDxzdmcgd2lkdGg9IjIyIiBoZWlnaHQ9IjIyIiB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgcng9IjUiIGZpbGw9InVybCgjZykiLz48cGF0aCBkPSJNNyAxMi41bDMgMyA3LTciIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9ImciIHgxPSIwIiB5MT0iMCIgeDI9IjI0IiB5Mj0iMjQiPjxzdG9wIHN0b3AtY29sb3I9IiM2RjVERkYiLz48c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM2RjVERkYiLz48L2xpbmVhckdyYWRpZW50PjwvZGVmcz48L3N2Zz4KICA8L2Rpdj4KICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMC41IGhpZGViYXIgb3ZlcmZsb3cteC1hdXRvIGZsZXgtMSI+CiAgICA8ZGl2IGNsYXNzPSJ0YWIgc2VsIiBkYXRhLXRhYj0idGV4dCI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6IzZGNURGRiI+PC9zcGFuPlRleHQySW1nPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJ0YWIiIGRhdGEtdGFiPSJpbWciPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiMyMmM1NWUiPjwvc3Bhbj5JbWcySW1nPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJ0YWIiIGRhdGEtdGFiPSJlZGl0Ij48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDojZWFiMzA4Ij48L3NwYW4+RWRpdDwvZGl2PgogICAgPGRpdiBjbGFzcz0idGFiIiBkYXRhLXRhYj0idmlkZW8iPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiNlZjQ0NDQiPjwvc3Bhbj5WaWRlbzwvZGl2PgogICAgPGRpdiBjbGFzcz0idGFiIiBkYXRhLXRhYj0icHJpbWUiPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiMzYjgyZjYiPjwvc3Bhbj5QcmltZTwvZGl2PgogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xLjUgc206Z2FwLTIgbWwtYXV0byBzaHJpbmstMCI+CiAgICA8YnV0dG9uIGlkPSJuY29sIiBjbGFzcz0idGV4dC1uZXV0cmFsLTQwMCBob3Zlcjp0ZXh0LXdoaXRlIHAtMS41IGhpZGRlbiBzbTpmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSB0ZXh0LXhzIiB0aXRsZT0iSnVtbGFoIGtvbG9tIj48aSBkYXRhLWljb249InNxdWFyZXMtZm91ciIgY2xhc3M9InctNCBoLTQiPjwvaT48c3BhbiBpZD0ibmNvbGxibCI+Mjwvc3Bhbj48L2J1dHRvbj4KICA8L2Rpdj4KPC9oZWFkZXI+Cgo8ZGl2IGlkPSJvdmVybGF5IiBjbGFzcz0iZml4ZWQgaW5zZXQtMCBiZy1ibGFjay82MCB6LTMwIGhpZGRlbiBsZzpoaWRkZW4iPjwvZGl2PgoKPGRpdiBjbGFzcz0icHQtMTQgZmxleCBoLVtjYWxjKDEwMHZoLTU2cHgpXSBvdmVyZmxvdy1oaWRkZW4iPgoKICA8IS0tIExFRlQgUEFORUwgLS0+CiAgPGFzaWRlIGlkPSJsZWZ0cGFuIiBjbGFzcz0iZml4ZWQgbGc6c3RhdGljIHotNDAgaW5zZXQteS0wIGxlZnQtMCBwdC0xNCBsZzpwdC0wIHctWzIycmVtXSBtYXgtdy1bODh2d10gLXRyYW5zbGF0ZS14LWZ1bGwgbGc6dHJhbnNsYXRlLXgtMCB0cmFuc2l0aW9uLXRyYW5zZm9ybSBkdXJhdGlvbi0yMDAgc2hyaW5rLTAgYm9yZGVyLXIgYmQgb3ZlcmZsb3cteS1hdXRvIGJnLVsjMTYxYjIyXSI+CiAgICA8ZGl2IGNsYXNzPSJwLTQgc3BhY2UteS00Ij4KCiAgICAgIDwhLS0gTW9kZWxzICh1cnV0YW4gc2VwZXJ0aSBUZW5zb3IuQXJ0OiBNb2RlbHMgLT4gVkFFIC0+IFNldHRpbmdzKSAtLT4KICAgICAgPGRpdiBjbGFzcz0ic3BhY2UteS0zIj4KICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5Nb2RlbHM8L3NwYW4+CiAgICAgICAgPGRpdiBpZD0ibW9kZWwtY2FyZCIgY2xhc3M9InJlbGF0aXZlIGJvcmRlciBiZCByb3VuZGVkLXhsIGJnLVsjMWMyMTI4XSBob3Zlcjpib3JkZXItWyMzZDQ0NGRdIGN1cnNvci1wb2ludGVyIHAtMyI+CiAgICAgICAgICA8c3BhbiBpZD0ibW9kZWwtYmFkZ2UiIGNsYXNzPSJhYnNvbHV0ZSB0b3AtMCBsZWZ0LTAgdGV4dC1bOXB4XSB0ZXh0LW5ldXRyYWwtNDAwIGJnLVsjMjEyNjJkXSBib3JkZXIgYmQgcHgtMiBweS0wLjUgcm91bmRlZC10bC14bCByb3VuZGVkLWJyLW1kIHotMTAiPkJhc2ljIE1vZGVsIC0gWiBJbWFnZTwvc3Bhbj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0zIG10LTIiPgogICAgICAgICAgICA8aW1nIGlkPSJtb2RlbC10aHVtYiIgc3JjPSJodHRwczovL3BpY3N1bS5waG90b3Mvc2VlZC96aW1hZ2UvNjQiIGNsYXNzPSJ3LTE2IGgtMTYgcm91bmRlZC1sZyBvYmplY3QtY292ZXIgc2hyaW5rLTAgYm9yZGVyIGJkIiBhbHQ9Im1vZGVsIi8+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImZsZXgtMSBtaW4tdy0wIj4KICAgICAgICAgICAgICA8ZGl2IGlkPSJtb2RlbC1uYW1lIiBjbGFzcz0iZm9udC1zZW1pYm9sZCB0ZXh0LXNtIHRydW5jYXRlIj5aIEltYWdlIC0gYmFzZS1iZjE2PC9kaXY+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8YnV0dG9uIGlkPSJtb2RlbC1pbmZvIiBjbGFzcz0idy02IGgtNiBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciByb3VuZGVkIHRleHQtbmV1dHJhbC01MDAgaG92ZXI6dGV4dC13aGl0ZSBob3ZlcjpiZy1bIzIxMjYyZF0gdHJhbnNpdGlvbiIgdGl0bGU9IkluZm8iPgogICAgICAgICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGNsYXNzPSJ3LTQgaC00Ij48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIvPjxsaW5lIHgxPSIxMiIgeTE9IjE2IiB4Mj0iMTIiIHkyPSIxMiIvPjxsaW5lIHgxPSIxMiIgeTE9IjgiIHgyPSIxMi4wMSIgeTI9IjgiLz48L3N2Zz4KICAgICAgICAgICAgPC9idXR0b24+CiAgICAgICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGNsYXNzPSJ3LTQgaC00IHRleHQtbmV1dHJhbC01MDAgc2hyaW5rLTAiPjxwb2x5bGluZSBwb2ludHM9IjkgMTggMTUgMTIgOSA2Ii8+PC9zdmc+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGdhcC0yIj4KICAgICAgICAgIDxidXR0b24gaWQ9ImJ0bi1hZGRsb3JhIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBmbGV4LTEgaC05IGJvcmRlciBiZCB0ZXh0LXhzIj5BZGQgTG9SQTwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBmbGV4LTEgaC05IGJvcmRlciBiZCB0ZXh0LXhzIj5BZGQgRW1iZWRkaW5nPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1naG9zdCB3LWZ1bGwgaC05IGJvcmRlciBiZCB0ZXh0LXhzIj5BZGQgQ29udHJvbE5ldDwvYnV0dG9uPgogICAgICA8L2Rpdj4KCiAgICAgIDwhLS0gTG9SQSAtLT4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gbWItMiI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5Mb1JBPC9zcGFuPgogICAgICAgICAgPGkgZGF0YS1pY29uPSJjYXJldC1kb3duIiBjbGFzcz0idy00IGgtNCB0ZXh0LW5ldXRyYWwtNTAwIj48L2k+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBpZD0ibG9yYS1saXN0IiBjbGFzcz0ic3BhY2UteS0yIj48L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIFRyaWdnZXIgV29yZHMgLS0+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPlRyaWdnZXIgV29yZHM8L3NwYW4+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIj4oPHNwYW4gaWQ9InRyLWNvdW50Ij4wPC9zcGFuPik8L3NwYW4+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIG10LTEiPgogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTQwMCI+QWRkIFRyaWdnZXIgV29yZHMgdG8gUHJvbXB0czwvc3Bhbj4KICAgICAgICAgIDxidXR0b24gaWQ9ImFkZGFsbC10cmlnIiBjbGFzcz0idGV4dC14cyB0ZXh0LVsjNkY1REZGXSBob3Zlcjp1bmRlcmxpbmUgZm9udC1tZWRpdW0iPkFkZCBBbGw8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGZsZXgtd3JhcCBnYXAtMS41IG10LTIiIGlkPSJ0cmlnZ2VycyI+PC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBWQUUgLS0+CiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4KICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSI+VkFFPC9zcGFuPgogICAgICAgIDxzZWxlY3QgaWQ9InZhZSIgY2xhc3M9ImlucCI+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhdXRvbWF0aWMiPkF1dG9tYXRpYzwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ibm9uZSI+Tm9uZTwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0idmFlLWZ0LW1zZS04NDAwMDAtZW1hLXBydW5lZC5ja3B0Ij52YWUtZnQtbXNlLTg0MDAwMC1lbWEtcHJ1bmVkLmNrcHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImtsLWY4LWFuaW1lLmNrcHQiPmtsLWY4LWFuaW1lLmNrcHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImtsLWY4LWFuaW1lMi5ja3B0Ij5rbC1mOC1hbmltZTIuY2twdDwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iWU9aT1JBLnZhZS5wdCI+WU9aT1JBLnZhZS5wdDwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ib3JhbmdlbWl4LnZhZS5wdCI+b3JhbmdlbWl4LnZhZS5wdDwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYmxlc3NlZDIudmFlLnB0Ij5ibGVzc2VkMi52YWUucHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImFuaW1ldmFlLnB0Ij5hbmltZXZhZS5wdDwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iQ2xlYXJWQUUuc2FmZXRlbnNvcnMiPkNsZWFyVkFFLnNhZmV0ZW5zb3JzPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJwYXN0ZWwtd2FpZnUtZGlmZnVzaW9uLnZhZS5wdCI+cGFzdGVsLXdhaWZ1LWRpZmZ1c2lvbi52YWUucHQ8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImN1dGVfdmFlLnNhZmV0ZW5zb3JzIj5jdXRlX3ZhZS5zYWZldGVuc29yczwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2R4bF92YWUuc2FmZXRlbnNvcnMiPnNkeGxfdmFlLnNhZmV0ZW5zb3JzPC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJzZHhsLXZhZS1mcDE2LWZpeC5zYWZldGVuc29ycyI+c2R4bC12YWUtZnAxNi1maXguc2FmZXRlbnNvcnM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InhsVkFFQ19jOTEuc2FmZXRlbnNvcnMiPnhsVkFFQ19jOTEuc2FmZXRlbnNvcnM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Imxhc3RwaWVjZVhMVkFFX2Jhc2VvbkEwODk3LnNhZmV0ZW5zb3JzIj5sYXN0cGllY2VYTFZBRV9iYXNlb25BMDg5Ny5zYWZldGVuc29yczwvb3B0aW9uPgogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icGxheWdyb3VuZC12Mi41LWZwMTYtdmFlLnNhZmV0ZW5zb3JzIj5wbGF5Z3JvdW5kLXYyLjUtZnAxNi12YWUuc2FmZXRlbnNvcnM8L29wdGlvbj4KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImFlLnNmdCI+YWUuc2Z0PC9vcHRpb24+CiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJwaXhlbF9zcGFjZSI+cGl4ZWxfc3BhY2U8L29wdGlvbj4KICAgICAgICA8L3NlbGVjdD4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIFNldHRpbmdzIC0tPgogICAgICA8ZGl2IGNsYXNzPSJzcGFjZS15LTQiPgogICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPlNldHRpbmdzPC9zcGFuPgogICAgICAgIDxkaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJncmlkIGdyaWQtY29scy00IGdhcC0yIj4KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYXIiIGRhdGEtYXI9InBvcnRyYWl0Ij4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItaWNvIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PHJlY3QgeD0iNiIgeT0iMi41IiB3aWR0aD0iMTIiIGhlaWdodD0iMTkiIHJ4PSIyLjUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjEuNiIvPjwvc3ZnPjwvc3Bhbj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItbmFtZSI+UG9ydHJhaXQ8L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWRlc2MiPjc2OHgxMTUyPC9zcGFuPgogICAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYXIiIGRhdGEtYXI9ImxhbmRzY2FwZSI+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHg9IjIuNSIgeT0iNiIgd2lkdGg9IjE5IiBoZWlnaHQ9IjEyIiByeD0iMi41IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiLz48L3N2Zz48L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLW5hbWUiPkxhbmRzY2FwZTwvc3Bhbj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItZGVzYyI+MTE1Mng3Njg8L3NwYW4+CiAgICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJhciIgZGF0YS1hcj0ic3F1YXJlIj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItaWNvIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PHJlY3QgeD0iMi41IiB5PSIyLjUiIHdpZHRoPSIxOSIgaGVpZ2h0PSIxOSIgcng9IjIuNSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMS42Ii8+PC9zdmc+PC9zcGFuPgogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5TcXVhcmU8L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWRlc2MiPjEwMjR4MTAyNDwvc3Bhbj4KICAgICAgICAgICAgPC9idXR0b24+CiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9ImFyIHNlbCIgZGF0YS1hcj0iY3VzdG9tIj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItaWNvIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSI+PHBhdGggZD0iTTQgOGg1TTEzIDhoN000IDE2aDlNMTcgMTZoM005IDUuNXY1TTE3IDEzLjV2NSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMS44IiBzdHJva2UtbGluZWNhcD0icm91bmQiLz48L3N2Zz48L3NwYW4+CiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLW5hbWUiPmN1c3RvbTwvc3Bhbj4KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItZGVzYyI+Y3VzdG9tPC9zcGFuPgogICAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIG10LTEuNSIgaWQ9ImFyLWxhYmVsIj5jdXN0b208L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIGl0ZW1zLWNlbnRlciI+PHNwYW4+V2lkdGg8L3NwYW4+CiAgICAgICAgICAgIDxpbnB1dCBpZD0id3YiIHR5cGU9Im51bWJlciIgbWluPSIyNTYiIG1heD0iMTUzNiIgc3RlcD0iNjQiIHZhbHVlPSI3NjgiIGNsYXNzPSJ3dm51bSIvPjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgaWQ9IndpZHRoIiB0eXBlPSJyYW5nZSIgbWluPSIyNTYiIG1heD0iMTUzNiIgc3RlcD0iNjQiIHZhbHVlPSI3NjgiIGNsYXNzPSJzbGlkZXIgbXQtMSIvPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXY+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4gaXRlbXMtY2VudGVyIj48c3Bhbj5IZWlnaHQ8L3NwYW4+CiAgICAgICAgICAgIDxpbnB1dCBpZD0iaHYiIHR5cGU9Im51bWJlciIgbWluPSIyNTYiIG1heD0iMTUzNiIgc3RlcD0iNjQiIHZhbHVlPSIxMTUyIiBjbGFzcz0id3ZudW0iLz48L2xhYmVsPgogICAgICAgICAgPGlucHV0IGlkPSJoZWlnaHQiIHR5cGU9InJhbmdlIiBtaW49IjI1NiIgbWF4PSIxNTM2IiBzdGVwPSI2NCIgdmFsdWU9IjExNTIiIGNsYXNzPSJzbGlkZXIgbXQtMSIvPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4iPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC14cyI+U2FtcGxpbmcgTWV0aG9kPC9zcGFuPgogICAgICAgICAgICA8YnV0dG9uIGlkPSJhZHYtdG9nZ2xlIiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEiPjxpIGRhdGEtaWNvbj0iY2FyZXQtZG93biIgY2xhc3M9InctMy41IGgtMy41Ij48L2k+QWR2YW5jZWQ8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iZ3JpZCBncmlkLWNvbHMtMiBnYXAtMiBtdC0xIj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+U2FtcGxlcjwvbGFiZWw+CiAgICAgICAgICAgICAgPHNlbGVjdCBpZD0ic2FtcGxlciIgY2xhc3M9ImlucCB0ZXh0LXhzIj4KICAgICAgICAgICAgICAgIDxvcHRpb24+RXVsZXIgYTwvb3B0aW9uPjxvcHRpb24+RXVsZXI8L29wdGlvbj48b3B0aW9uPkxNUzwvb3B0aW9uPjxvcHRpb24+TE1TIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RERJTTwvb3B0aW9uPjxvcHRpb24+TENNPC9vcHRpb24+PG9wdGlvbj5IZXVuPC9vcHRpb24+PG9wdGlvbj5EUE0gZmFzdDwvb3B0aW9uPjxvcHRpb24+RFBNMjwvb3B0aW9uPjxvcHRpb24+RFBNMiBhPC9vcHRpb24+PG9wdGlvbj5EUE0yIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNMiBhIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNKysgMlMgYTwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk08L29wdGlvbj48b3B0aW9uPkRQTSsrIFNERTwvb3B0aW9uPjxvcHRpb24+RFBNKysgMlMgYSBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNKysgU0RFIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0RFIEthcnJhczwvb3B0aW9uPjxvcHRpb24+UmVzdGFydDwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0RFIEV4cG9uZW50aWFsPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBTREUgSGV1bjwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0RFIEhldW4gS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBTREUgSGV1biBFeHBvbmVudGlhbDwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gU0dNIFVuaWZvcm08L29wdGlvbj48b3B0aW9uPkRQTSsrIDNNIFNERTwvb3B0aW9uPjxvcHRpb24+RFBNKysgM00gU0RFIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNKysgM00gU0RFIEV4cG9uZW50aWFsPC9vcHRpb24+PG9wdGlvbj5ldWxlcl9keTwvb3B0aW9uPjxvcHRpb24+ZXVsZXJfc21lYV9keTwvb3B0aW9uPgogICAgICAgICAgICAgIDwvc2VsZWN0PjwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+PGxhYmVsIGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIj5TY2hlZHVsZXI8L2xhYmVsPgogICAgICAgICAgICAgIDxzZWxlY3QgaWQ9InNjaGVkIiBjbGFzcz0iaW5wIHRleHQteHMiPjxvcHRpb24+bm9ybWFsPC9vcHRpb24+PG9wdGlvbj5zaW1wbGU8L29wdGlvbj48b3B0aW9uPmthcnJhczwvb3B0aW9uPjxvcHRpb24+ZXhwb25lbnRpYWw8L29wdGlvbj48b3B0aW9uPnNnbV91bmlmb3JtPC9vcHRpb24+PG9wdGlvbj5kZGltX3VuaWZvcm08L29wdGlvbj48b3B0aW9uPmJldGE8L29wdGlvbj48b3B0aW9uPmxpbmVhcl9xdWFkcmF0aWM8L29wdGlvbj48L3NlbGVjdD48L2Rpdj4KICAgICAgICAgIDwvZGl2Pgo8ZGl2IGNsYXNzPSJzcGFjZS15LTMgbXQtMyI+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TYW1wbGluZyBTdGVwczwvc3Bhbj48c3BhbiBpZD0ic3YiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj4xMDwvc3Bhbj48L2xhYmVsPgogICAgICAgICAgICAgIDxpbnB1dCBpZD0ic3RlcHMiIHR5cGU9InJhbmdlIiBtaW49IjEiIG1heD0iNTAiIHZhbHVlPSIxMCIgY2xhc3M9InNsaWRlciBtdC0xIi8+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8ZGl2PgogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q0ZHIFNjYWxlPC9zcGFuPjxzcGFuIGlkPSJjZnYiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj4xPC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICAgICAgPGlucHV0IGlkPSJjZmciIHR5cGU9InJhbmdlIiBtaW49IjEiIG1heD0iMTAiIHN0ZXA9IjAuNSIgdmFsdWU9IjEiIGNsYXNzPSJzbGlkZXIgbXQtMSIvPgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgICAgPGRpdj4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4gaXRlbXMtY2VudGVyIj48c3Bhbj5TZWVkPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNjAwIj5SYW5kb208L3NwYW4+PC9sYWJlbD4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGdhcC0xLjUgbXQtMSI+CiAgICAgICAgICAgICAgICA8aW5wdXQgaWQ9InNlZWQiIGNsYXNzPSJpbnAgdGV4dC14cyBmbGV4LTEiIHZhbHVlPSIxMDEwOTMzMzQ3OTQzNDYyIi8+CiAgICAgICAgICAgICAgICA8YnV0dG9uIGlkPSJkaWNlIiBjbGFzcz0idy04IGgtOCByb3VuZGVkLWxnIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHNocmluay0wIGJvcmRlciBiZCBiZy1bIzFjMjEyOF0gdGV4dC1uZXV0cmFsLTMwMCBob3Zlcjp0ZXh0LXdoaXRlIGhvdmVyOmJvcmRlci1bIzZGNURGRl0iIHRpdGxlPSJBY2FrIHNlZWQiPjxpIGRhdGEtaWNvbj0iZGljZS1maXZlIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPGRpdiBpZD0iYWR2LWZpZWxkcyIgY2xhc3M9ImhpZGRlbiBzcGFjZS15LTMgbXQtNCBib3JkZXItdCBiZCBwdC0zIj4KICAgICAgICAgICAgPGRpdj4KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNsaXAgU2tpcDwvc3Bhbj48c3BhbiBpZD0iY3N2IiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+Mjwvc3Bhbj48L2xhYmVsPgogICAgICAgICAgICAgIDxpbnB1dCBpZD0iY2xpcHNraXAiIHR5cGU9InJhbmdlIiBtaW49IjEiIG1heD0iMTIiIHZhbHVlPSIyIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5FTlNEPC9zcGFuPjxzcGFuIGlkPSJlbnNkIiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MzEzMzc8L3NwYW4+PC9sYWJlbD4KICAgICAgICAgICAgICA8aW5wdXQgaWQ9ImV0YW5zZCIgdHlwZT0icmFuZ2UiIG1pbj0iMCIgbWF4PSIzMTMzNyIgdmFsdWU9IjMxMzM3IiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KCiAgICAgICAgPCEtLSBVcHNjYWxlIChzZXBhcmF0ZSwgZGkgYmF3YWgpIC0tPgogICAgICAgIDxkaXYgY2xhc3M9Im10LTQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIGl0ZW1zLWNlbnRlciI+PHNwYW4+VXBzY2FsZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+Mng8L3NwYW4+PC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCBpZD0idXBzY2FsZSIgdHlwZT0icmFuZ2UiIG1pbj0iMSIgbWF4PSI0IiBzdGVwPSIwLjUiIHZhbHVlPSIyIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8IS0tIEFQSSBTZXR0aW5ncyAtLT4KICAgICAgPGRpdiBjbGFzcz0iYm9yZGVyIGJkIHJvdW5kZWQteGwgYmctWyMxYzIxMjhdIHAtMyBzcGFjZS15LTIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiI+CiAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5BUEk8L3NwYW4+CiAgICAgICAgICA8c3BhbiBpZD0iYXBpLXN0YXR1cyIgY2xhc3M9InRleHQtWzEwcHhdIHRleHQtbmV1dHJhbC01MDAiPjwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAiPlByb3ZpZGVyPC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9ImFwaXByb3ZpZGVyIiBjbGFzcz0iaW5wIHRleHQteHMiPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJ0YW1zIj5UZW5zb3IuQXJ0IChUQU1TKTwvb3B0aW9uPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJyZXBsaWNhdGUiPlJlcGxpY2F0ZSAoU0RYTCk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iZmFsIj5mYWwuYWkgKGZhc3Qtc2R4bCk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icG9sbGluYXRpb25zIj5Qb2xsaW5hdGlvbnMgKEdSQVRJUywgdGFucGEga2V5KTwvb3B0aW9uPgogICAgICAgICAgPC9zZWxlY3Q+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiIGlkPSJhcGlrZXktZmllbGQiPgogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIiBpZD0iYXBpa2V5LWxhYmVsIj5BUEkgS2V5IFRBTVMgKHRhbXMudGVuc29yLmFydCk8L2xhYmVsPgogICAgICAgICAgPGlucHV0IGlkPSJhcGlrZXkiIHR5cGU9InBhc3N3b3JkIiBjbGFzcz0iaW5wIiBwbGFjZWhvbGRlcj0iQmVhcmVyIHRva2VuLi4uIiBhdXRvY29tcGxldGU9Im9mZiIvPgogICAgICAgIDwvZGl2PgogICAgICAgIDwhLS0gQllPUCBQb2xsaW5hdGlvbnM6IGxvZ2luIE9BdXRoIChidWthbiBrb2xvbSBBUEkga2V5KSAtLT4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWVsZCBoaWRkZW4iIGlkPSJieW9wLXJvdyI+CiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAiPkxvZ2luIFBvbGxpbmF0aW9uczwvbGFiZWw+CiAgICAgICAgICA8YnV0dG9uIGlkPSJieW9wLWxvZ2luIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCB3LWZ1bGwgaC04IGJvcmRlciBiZCB0ZXh0LXhzIGp1c3RpZnktY2VudGVyIj5Mb2dpbiBkZW5nYW4gUG9sbGluYXRpb25zIChCWU9QKTwvYnV0dG9uPgogICAgICAgICAgPGRpdiBpZD0iYnlvcC1zdGF0dXMiIGNsYXNzPSJoaWRkZW4gdGV4dC1bMTBweF0gdGV4dC1uZXV0cmFsLTUwMCBtdC0xIj48L2Rpdj4KICAgICAgICAgIDxidXR0b24gaWQ9ImJ5b3AtbG9nb3V0IiBjbGFzcz0iaGlkZGVuIGJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOCBib3JkZXIgYmQgdGV4dC14cyBqdXN0aWZ5LWNlbnRlciBtdC0xIj5Mb2dvdXQ8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJhcGktaGludCIgY2xhc3M9InRleHQtWzEwcHhdIHRleHQtbmV1dHJhbC02MDAiPjwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+TW9kZTwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJhcGltb2RlIiBjbGFzcz0iaW5wIHRleHQteHMiPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhdXRvIj5BdXRvIChiYWNrZW5kICZyYXJyOyBkZW1vKTwvb3B0aW9uPgogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJyZWFsIj5SZWFsIEFQSSAod2FqaWIgYmFja2VuZCk8L29wdGlvbj4KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iZGVtbyI+RGVtbyAoc2ltdWxhc2kgc2FqYSk8L29wdGlvbj4KICAgICAgICAgIDwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggZ2FwLTIiPgogICAgICAgICAgPGJ1dHRvbiBpZD0iYXBpLXNhdmUiIGNsYXNzPSJidG4gYnRuLWdob3N0IGZsZXgtMSBoLTggYm9yZGVyIGJkIHRleHQteHMiPlNpbXBhbjwvYnV0dG9uPgogICAgICAgICAgPGJ1dHRvbiBpZD0iYXBpLXRlc3QiIGNsYXNzPSJidG4gYnRuLWdob3N0IGZsZXgtMSBoLTggYm9yZGVyIGJkIHRleHQteHMiPlRlczwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDwhLS0gQm90dG9tIC0tPgogICAgICA8ZGl2IGNsYXNzPSJwdC0xIGJvcmRlci10IGJkIHNwYWNlLXktMiI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1naG9zdCB3LWZ1bGwgaC05IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+UGFzdGUgR2VuZXJhdGlvbiBEYXRhPC9zcGFuPjxpIGRhdGEtaWNvbj0iY2xpcGJvYXJkIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3Qgdy1mdWxsIGgtOSBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlByZXNldHM8L3NwYW4+PGkgZGF0YS1pY29uPSJib29rbWFyay1zaW1wbGUiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1naG9zdCB3LWZ1bGwgaC05IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+UmVzZXQ8L3NwYW4+PGkgZGF0YS1pY29uPSJrZXkiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgPC9hc2lkZT4KCiAgPCEtLSBDRU5URVIgKyBSSUdIVDogc2F0dSBzY3JvbGwgYXJlYSAoc2Nyb2xsYmFyIHBvam9rIGthbmFuIG1lbmdnZXJha2thbiBrZWR1YW55YSBiZXJzYW1hYW4pIC0tPgogIDxkaXYgaWQ9Im1haW53cmFwIiBjbGFzcz0iZmxleC0xIGZsZXggb3ZlcmZsb3cteS1hdXRvIG92ZXJmbG93LXgtaGlkZGVuIj4KICA8bWFpbiBpZD0iY2FudmFzIiBjbGFzcz0iZmxleC0xIG1pbi13LTAgYmctWyMwZDExMTddIj4KICAgIDxkaXYgY2xhc3M9InAtNCBtYXgtdy0zeGwgbXgtYXV0byI+CgogICAgICA8IS0tIFByb21wdCBiYXIgKFRlbnNvci5BcnQ6IGRpIHRlbmdhaCBhdGFzLCBkaSBhdGFzIGdyaWQgZ2FtYmFyKSAtLT4KICAgICAgPGRpdiBpZD0icHJvbXB0YmFyIiBjbGFzcz0ibWItNCByb3VuZGVkLTJ4bCBib3JkZXIgYmQgYmctWyMxNjFiMjJdIG92ZXJmbG93LWhpZGRlbiI+CiAgICAgICAgPGRpdiBjbGFzcz0icmVsYXRpdmUgcHgtNCBwdC0zIj4KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0icHJvbXB0IiByb3dzPSIzIiBjbGFzcz0idy1mdWxsIGJnLXRyYW5zcGFyZW50IGJvcmRlci0wIG91dGxpbmUtbm9uZSByZXNpemUteSB0ZXh0LVsxNXB4XSB0ZXh0LW5ldXRyYWwtMTAwIHBsYWNlaG9sZGVyLW5ldXRyYWwtNjAwIGxlYWRpbmctcmVsYXhlZCBwci0xMiBtaW4taC1bNC41cmVtXSIgcGxhY2Vob2xkZXI9IkplbGFza2FuIGFwYSB5YW5nIGluZ2luIGthbXUgYnVhdC4uLiI+PC90ZXh0YXJlYT4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFic29sdXRlIHRvcC0zIHJpZ2h0LTMgZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTAuNSI+CiAgICAgICAgICAgIDxidXR0b24gaWQ9ImJ0bi10cmFuc2xhdGUiIGNsYXNzPSJ3LTcgaC03IHJvdW5kZWQtbGcgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC1uZXV0cmFsLTQwMCBob3Zlcjp0ZXh0LXdoaXRlIGhvdmVyOmJnLVsjMjEyNjJkXSB0cmFuc2l0aW9uLWNvbG9ycyIgdGl0bGU9IlRlcmplbWFoa2FuIHByb21wdCBrZSBiYWhhc2EgSW5nZ3JpcyAoc2VtdWEgYmFoYXNhKSI+PGkgZGF0YS1pY29uPSJ0cmFuc2xhdGUiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9idXR0b24+CiAgICAgICAgICAgIDxidXR0b24gaWQ9ImJ0bi1lbmhhbmNlIiBjbGFzcz0idy03IGgtNyByb3VuZGVkLWxnIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHRleHQtbmV1dHJhbC00MDAgaG92ZXI6dGV4dC13aGl0ZSBob3ZlcjpiZy1bIzIxMjYyZF0gdHJhbnNpdGlvbi1jb2xvcnMiIHRpdGxlPSJQcm9tcHQgRW5oYW5jZSDigJQgcGVybHVhcyAmIHBlcmJhaWtpIHByb21wdCBkZW5nYW4gQUkiPjxpIGRhdGEtaWNvbj0ibWFnaWMtd2FuZCIgY2xhc3M9InctNCBoLTQiPjwvaT48L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMiBmbGV4LXdyYXAgcHgtMyBweS0yIGJvcmRlci10IGJkIj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSBjdXJzb3ItcG9pbnRlciBzZWxlY3Qtbm9uZSI+CiAgICAgICAgICAgIDxpbnB1dCBpZD0ibmVnY2hlY2siIHR5cGU9ImNoZWNrYm94IiBjbGFzcz0iYWNjZW50LVsjNkY1REZGXSIvPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNDAwIj5OZWdhdGl2ZTwvc3Bhbj4KICAgICAgICAgIDwvbGFiZWw+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMiBmbGV4LXdyYXAganVzdGlmeS1lbmQiPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0iY2hpcCIgaWQ9ImNoaXAtYTExMTEiPkExMTExPC9zcGFuPgogICAgICAgICAgICA8c3BhbiBjbGFzcz0iY2hpcCIgaWQ9ImNoaXAtZWxsYSI+RWxsYTwvc3Bhbj4KICAgICAgICAgICAgPHNlbGVjdCBpZD0ibmNvdW50IiBjbGFzcz0iaW5wIHctWzUuNHJlbV0gdGV4dC14cyBoLTgiIHRpdGxlPSJKdW1sYWggZ2FtYmFyIj4KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSIxIiBzZWxlY3RlZD4xIGltYWdlPC9vcHRpb24+CiAgICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iMiI+MiBpbWFnZXM8L29wdGlvbj4KICAgICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSI0Ij40IGltYWdlczwvb3B0aW9uPgogICAgICAgICAgICA8L3NlbGVjdD4KICAgICAgICAgICAgPGJ1dHRvbiBpZD0iYnRuLWdvIiBjbGFzcz0iYnRuIGJ0bi10dXJxIGgtOSBweC00IHdoaXRlc3BhY2Utbm93cmFwIj4KICAgICAgICAgICAgICA8aSBkYXRhLWljb249ImxpZ2h0bmluZyIgY2xhc3M9InctNCBoLTQiPjwvaT5HZW5lcmF0ZQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIG9wYWNpdHktOTAgZm9udC1ub3JtYWwiIGlkPSJwcmljZSI+LSAxLjIyPC9zcGFuPgogICAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgaWQ9Im5lZ3dyYXAiIGNsYXNzPSJoaWRkZW4gYm9yZGVyLXQgYmQgcHgtNCBweS0zIj4KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0ibmVncHJvbXB0IiByb3dzPSIyIiBjbGFzcz0idy1mdWxsIGJnLXRyYW5zcGFyZW50IGJvcmRlci0wIG91dGxpbmUtbm9uZSByZXNpemUtbm9uZSB0ZXh0LVsxM3B4XSB0ZXh0LW5ldXRyYWwtMTAwIHBsYWNlaG9sZGVyLW5ldXRyYWwtNjAwIiBwbGFjZWhvbGRlcj0iTmVnYXRpdmUgcHJvbXB0Li4uIj48L3RleHRhcmVhPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDwhLS0gSW1nMkltZyB1cGxvYWQgLS0+CiAgICAgIDxkaXYgaWQ9ImltZzJpbWctY2FyZCIgY2xhc3M9ImhpZGRlbiBtYi00IGJvcmRlciBiZCByb3VuZGVkLXhsIGJnLVsjMTYxYjIyXSBwLTQiPgogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBtYi0yIj4KICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPkltZzJJbWcg4oCUIGdhbWJhciBhd2FsPC9zcGFuPgogICAgICAgICAgPHNwYW4gaWQ9ImkyaS1jbGVhciIgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBob3Zlcjp0ZXh0LXdoaXRlIGN1cnNvci1wb2ludGVyIj5IYXB1czwvc3Bhbj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGlkPSJpMmktZHJvcCIgY2xhc3M9ImJvcmRlci0yIGJvcmRlci1kYXNoZWQgYmQgcm91bmRlZC14bCBwLTYgdGV4dC1jZW50ZXIgY3Vyc29yLXBvaW50ZXIgdGV4dC1uZXV0cmFsLTUwMCBob3Zlcjpib3JkZXItWyM2RjVERkZdIHRleHQteHMiPgogICAgICAgICAgS2xpayBhdGF1IHNlcmV0IGdhbWJhciBrZSBzaW5pCiAgICAgICAgPC9kaXY+CiAgICAgICAgPGlucHV0IGlkPSJpMmktZmlsZSIgdHlwZT0iZmlsZSIgYWNjZXB0PSJpbWFnZS8qIiBjbGFzcz0iaGlkZGVuIi8+CiAgICAgICAgPGRpdiBpZD0iaTJpLXByZXZpZXciIGNsYXNzPSJoaWRkZW4gbXQtMyI+CiAgICAgICAgICA8aW1nIGlkPSJpMmktaW1nIiBjbGFzcz0idy00MCBoLTQwIG9iamVjdC1jb3ZlciByb3VuZGVkLWxnIGJvcmRlciBiZCIgYWx0PSIiLz4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJtdC0zIj4KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+RGVub2lzaW5nIFN0cmVuZ3RoPC9zcGFuPjxzcGFuIGlkPSJpMmktZHN2IiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MC41MDwvc3Bhbj48L2xhYmVsPgogICAgICAgICAgPGlucHV0IGlkPSJpMmktZHMiIHR5cGU9InJhbmdlIiBtaW49IjAiIG1heD0iMSIgc3RlcD0iMC4wNSIgdmFsdWU9IjAuNSIgY2xhc3M9InNsaWRlciBtdC0xIi8+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPCEtLSBUYWIgcGxhY2Vob2xkZXIgKEVkaXQvVmlkZW8vUHJpbWUpIC0tPgogICAgICA8ZGl2IGlkPSJ0YWItcGxhY2Vob2xkZXIiIGNsYXNzPSJoaWRkZW4gZmxleC1jb2wgaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGgtWzUwdmhdIHRleHQtbmV1dHJhbC02MDAiPgogICAgICAgIDxpIGRhdGEtaWNvbj0iaG91cmdsYXNzLW1lZGl1bSIgY2xhc3M9InctMTIgaC0xMiBtYi0zIj48L2k+CiAgICAgICAgPHAgY2xhc3M9InRleHQtc20iIGlkPSJ0YWItcGxhY2Vob2xkZXItdGV4dCI+VGFiIGluaSBzZWdlcmEgaGFkaXI8L3A+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBpZD0iZW1wdHkiIGNsYXNzPSJmbGV4IGZsZXgtY29sIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBoLVs2MHZoXSB0ZXh0LW5ldXRyYWwtNjAwIj4KICAgICAgICA8aSBkYXRhLWljb249ImltYWdlLXNxdWFyZSIgY2xhc3M9InctMTQgaC0xNCBtYi0zIj48L2k+CiAgICAgICAgPHAgY2xhc3M9InRleHQtc20iPkhhc2lsIGdlbmVyYXRlIGFrYW4gdGFtcGlsIGRpIHNpbmk8L3A+CiAgICAgICAgPHAgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTcwMCBtdC0xIj5Jc2kgcHJvbXB0IGxhbHUgdGVrYW4gR2VuZXJhdGU8L3A+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGlkPSJnZmlsdGVyIiBjbGFzcz0iaGlkZGVuIGZsZXggaXRlbXMtY2VudGVyIGdhcC0xIG1iLTMgdGV4dC14cyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iZ2ZpbCBzZWwiIGRhdGEtZj0iYWxsIj5BbGw8L2J1dHRvbj4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJnZmlsIiBkYXRhLWY9InZpZGVvIj5WaWRlbzwvYnV0dG9uPgogICAgICAgIDxidXR0b24gY2xhc3M9ImdmaWwiIGRhdGEtZj0iaW1hZ2UiPkltYWdlPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iZ2ZpbCIgZGF0YS1mPSJhdWRpbyI+QXVkaW88L2J1dHRvbj4KICAgICAgICA8c3BhbiBjbGFzcz0iZmxleC0xIj48L3NwYW4+CiAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC02MDAgcC0xIiB0aXRsZT0iTGlzdCI+PGkgZGF0YS1pY29uPSJsaXN0IiBjbGFzcz0idy00IGgtNCI+PC9pPjwvc3Bhbj4KICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTYwMCBwLTEiIHRpdGxlPSJHcmlkIj48aSBkYXRhLWljb249InNxdWFyZXMtZm91ciIgY2xhc3M9InctNCBoLTQiPjwvaT48L3NwYW4+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGlkPSJncmlkIiBjbGFzcz0ic3BhY2UteS0zIj48L2Rpdj4KICAgIDwvZGl2PgogIDwvbWFpbj4KCiAgPCEtLSBSSUdIVCBQQU5FTCAtLT4KICA8YXNpZGUgaWQ9InJpZ2h0UGFuIiBjbGFzcz0idy1bMjFyZW1dIHNocmluay0wIGJvcmRlci1sIGJkIGJnLVsjMTYxYjIyXSBoaWRkZW4gbGc6ZmxleCBmbGV4LWNvbCI+CiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gcHgtMyBweS0yIGJvcmRlci1iIGJkIj4KICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCIgaWQ9InJwdGl0bGUiPlRleHQgdG8gSW1hZ2U8L3NwYW4+CiAgICAgIDxkaXYgY2xhc3M9ImZsZXggZ2FwLTEiPgogICAgICAgIDxidXR0b24gY2xhc3M9InJ0YWIgc2VsIiBkYXRhLXA9ImRldGFpbCI+RGV0YWlsPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0icnRhYiIgZGF0YS1wPSJoaXN0b3J5Ij5SaXdheWF0PC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8IS0tIERldGFpbCBoYXNpbCBha3RpZiAoc2VwZXJ0aSBUZW5zb3IuQXJ0OiBJbnB1dCArIERldGFpbHMgKyBwYXJhbXMpIC0tPgogICAgPGRpdiBpZD0icmRldGFpbCIgY2xhc3M9ImZsZXgtMSBwLTMgc3BhY2UteS0zIj48L2Rpdj4KICAgIDwhLS0gUml3YXlhdCBnZW5lcmF0ZSAoa2FydHUpIC0tPgogICAgPGRpdiBpZD0icmhpc3RvcnkiIGNsYXNzPSJoaWRkZW4gZmxleC0xIHAtMiBzcGFjZS15LTMiPgogICAgICA8cCBpZD0icmNvdW50IiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIHB4LTEgcHQtMSI+MCBoYXNpbDwvcD4KICAgICAgPGRpdiBpZD0icmxpc3QiIGNsYXNzPSJzcGFjZS15LTMiPjwvZGl2PgogICAgPC9kaXY+CiAgPC9hc2lkZT4KICA8L2Rpdj4KPC9kaXY+Cgo8IS0tIE1vYmlsZSBoaXN0b3J5IHRvZ2dsZSAtLT4KPGJ1dHRvbiBpZD0iYnRuLWhpc3RvcnkiIGNsYXNzPSJsZzpoaWRkZW4gZml4ZWQgYm90dG9tLTQgcmlnaHQtNCB6LTMwIGJ0biBidG4tYmx1ZSBoLTExIHB4LTQiPjxpIGRhdGEtaWNvbj0iY2xvY2stY291bnRlci1jbG9ja3dpc2UiIGNsYXNzPSJ3LTQgaC00Ij48L2k+IFJpd2F5YXQ8L2J1dHRvbj4KCjwhLS0gPT09PT09PT09PT09IFBST0dSRVNTIE9WRVJMQVkgPT09PT09PT09PT09IC0tPgo8ZGl2IGlkPSJwcm9nb3ZlcmxheSIgY2xhc3M9ImhpZGRlbiBmaXhlZCBpbnNldC0wIHotMzAgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgYmctYmxhY2svNTAgcC00IiBzdHlsZT0idG9wOjU2cHgiPgogIDxkaXYgY2xhc3M9InctZnVsbCBtYXgtdy1zbSBiZy1bIzE2MWIyMl0gYm9yZGVyIGJkIHJvdW5kZWQtMnhsIHAtNSBzcGFjZS15LTMiPgogICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIj4KICAgICAgPHNwYW4gaWQ9InByb2ctdGl0bGUiIGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPkdlbmVyYXRpbmcuLi48L3NwYW4+CiAgICAgIDxidXR0b24gaWQ9InByb2ctY2FuY2VsIiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCBob3Zlcjp0ZXh0LXdoaXRlIHRleHQtbGcgbGVhZGluZy1ub25lIiB0aXRsZT0iQmF0YWwiPuKclTwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJyZWxhdGl2ZSBoLTIgYmctWyMxYzIxMjhdIHJvdW5kZWQtZnVsbCBvdmVyZmxvdy1oaWRkZW4iPgogICAgICA8ZGl2IGlkPSJwcm9nLWJhciIgY2xhc3M9ImFic29sdXRlIGluc2V0LXktMCBsZWZ0LTAgdy0wIHJvdW5kZWQtZnVsbCIgc3R5bGU9ImJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDk1ZGVnLCM2RjVERkYsIzI3RDRDRCk7dHJhbnNpdGlvbjp3aWR0aCAuNHMiPjwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gdGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIj4KICAgICAgPHNwYW4gaWQ9InByb2ctc3RhdHVzIj5NZW5naXJpbSB0YXNrLi4uPC9zcGFuPgogICAgICA8c3BhbiBpZD0icHJvZy1wY3QiPjAlPC9zcGFuPgogICAgPC9kaXY+CiAgPC9kaXY+CjwvZGl2PgoKPCEtLSA9PT09PT09PT09PT0gTElHSFRCT1ggPT09PT09PT09PT09IC0tPgo8ZGl2IGlkPSJsaWdodGJveCIgY2xhc3M9ImZpeGVkIGluc2V0LTAgei01MCBoaWRkZW4gaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHAtNCBiZy1ibGFjay84MCI+CiAgPGRpdiBjbGFzcz0icmVsYXRpdmUgbWF4LXctM3hsIHctZnVsbCBiZy1bIzE2MWIyMl0gYm9yZGVyIGJkIHJvdW5kZWQtMnhsIG92ZXJmbG93LWhpZGRlbiI+CiAgICA8YnV0dG9uIGlkPSJsYi1jbG9zZSIgY2xhc3M9ImFic29sdXRlIHRvcC0yIHJpZ2h0LTIgei0xMCB3LTkgaC05IGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHRleHQtd2hpdGUgaG92ZXI6Ymctd2hpdGUvMTAgcm91bmRlZC1sZyB0ZXh0LXhsIj7inJU8L2J1dHRvbj4KICAgIDxpbWcgaWQ9ImxiLWltZyIgY2xhc3M9InctZnVsbCBtYXgtaC1bNjB2aF0gb2JqZWN0LWNvbnRhaW4gYmctYmxhY2siIGFsdD0iIi8+CiAgICA8ZGl2IGlkPSJsYi1tZXRhIiBjbGFzcz0icC00IHNwYWNlLXktMS41IHRleHQteHMgdGV4dC1uZXV0cmFsLTQwMCBvdmVyZmxvdy15LWF1dG8gbWF4LWgtWzMwdmhdIj48L2Rpdj4KICA8L2Rpdj4KPC9kaXY+Cgo8IS0tID09PT09PT09PT09PSBQUk9NUFQgRU5IQU5DRSAoaGFzaWwgcmVmaW5lLCBrb25maXJtYXNpIGR1bHUpID09PT09PT09PT09PSAtLT4KPGRpdiBpZD0iZW5oLW1vZGFsIiBjbGFzcz0iZml4ZWQgaW5zZXQtMCB6LTUwIGhpZGRlbiBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcC00IGJnLWJsYWNrLzcwIj4KICA8ZGl2IGNsYXNzPSJ3LWZ1bGwgbWF4LXcteGwgYmctWyMxNjFiMjJdIGJvcmRlciBiZCByb3VuZGVkLTJ4bCBvdmVyZmxvdy1oaWRkZW4iPgogICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIHB4LTQgcHktMyBib3JkZXItYiBiZCI+CiAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQgZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSI+PGkgZGF0YS1pY29uPSJtYWdpYy13YW5kIiBjbGFzcz0idy00IGgtNCB0ZXh0LVsjNkY1REZGXSI+PC9pPlByb21wdCBFbmhhbmNlPC9zcGFuPgogICAgICA8YnV0dG9uIGlkPSJlbmgtY2xvc2UiIGNsYXNzPSJ3LTggaC04IGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHRleHQtbmV1dHJhbC00MDAgaG92ZXI6dGV4dC13aGl0ZSBob3ZlcjpiZy13aGl0ZS81IHJvdW5kZWQtbGciPuKclTwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJwLTQgc3BhY2UteS0zIj4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIG1iLTEiPlByb21wdCBhc2xpPC9kaXY+CiAgICAgICAgPGRpdiBpZD0iZW5oLW9yaWciIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAgYmctYmxhY2svNDAgYm9yZGVyIGJkIHJvdW5kZWQtbGcgcC0zIG1heC1oLTI0IG92ZXJmbG93LXktYXV0byBsZWFkaW5nLXJlbGF4ZWQiPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIG1iLTEiPkhhc2lsIEVuaGFuY2UgPHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC02MDAiPihiaXNhIGRpZWRpdCk8L3NwYW4+PC9kaXY+CiAgICAgICAgPHRleHRhcmVhIGlkPSJlbmgtdGV4dCIgcm93cz0iNSIgY2xhc3M9InctZnVsbCBiZy1ibGFjay80MCBib3JkZXIgYmQgcm91bmRlZC1sZyBwLTMgdGV4dC14cyB0ZXh0LW5ldXRyYWwtMTAwIG91dGxpbmUtbm9uZSByZXNpemUtbm9uZSBmb2N1czpib3JkZXItWyM2RjVERkZdIGxlYWRpbmctcmVsYXhlZCI+PC90ZXh0YXJlYT4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBnYXAtMiI+CiAgICAgICAgPGJ1dHRvbiBpZD0iZW5oLXJlZ2VuIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBoLTkgcHgtMyB0ZXh0LXhzIj48aSBkYXRhLWljb249ImFycm93cy1jbG9ja3dpc2UiIGNsYXNzPSJ3LTMuNSBoLTMuNSI+PC9pPkdlbmVyYXRlIGxhZ2k8L2J1dHRvbj4KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGdhcC0yIj4KICAgICAgICAgIDxidXR0b24gaWQ9ImVuaC1jYW5jZWwiIGNsYXNzPSJidG4gYnRuLWdob3N0IGgtOSBweC00IHRleHQteHMiPkJhdGFsPC9idXR0b24+CiAgICAgICAgICA8YnV0dG9uIGlkPSJlbmgtdXNlIiBjbGFzcz0iYnRuIGJ0bi1ibHVlIGgtOSBweC00IHRleHQteHMiPlBha2FpIHByb21wdCBpbmk8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICA8L2Rpdj4KPC9kaXY+Cgo8IS0tID09PT09PT09PT09PSBUT0FTVCA9PT09PT09PT09PT0gLS0+CjxkaXYgaWQ9InRvYXN0IiBjbGFzcz0iZml4ZWQgYm90dG9tLTIwIGxlZnQtMS8yIC10cmFuc2xhdGUteC0xLzIgei01MCBoaWRkZW4gYmctWyMxYzIxMjhdIGJvcmRlciBiZCByb3VuZGVkLXhsIHB4LTQgcHktMi41IHRleHQtc20gc2hhZG93LWxnIG1heC13LVs4NXZ3XSI+PC9kaXY+Cgo8IS0tID09PT09PT09PT09PSBTRUxFQ1RPUiBNT0RBTCA9PT09PT09PT09PT0gLS0+CjxkaXYgaWQ9Im1vZGFsIiBjbGFzcz0iZml4ZWQgaW5zZXQtMCBiZy1ibGFjay82MCB6LTUwIGhpZGRlbiBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcC00Ij4KICA8ZGl2IGNsYXNzPSJ3LWZ1bGwgbWF4LXctNXhsIGJnLVsjMTYxYjIyXSBib3JkZXIgYmQgcm91bmRlZC0yeGwgb3ZlcmZsb3ctaGlkZGVuIj4KICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBweC00IHB0LTMgcGItMiBib3JkZXItYiBiZCI+CiAgICAgIDxkaXYgaWQ9Im1vZGFsLXRhYnMiIGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0ibXRhYiBzZWwiIGRhdGEtbXRhYj0iYmFzaWMiPkJhc2ljIE1vZGVsPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0ibXRhYiIgZGF0YS1tdGFiPSJzdGFycmVkIj5NeSBTdGFycmVkPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0ibXRhYiIgZGF0YS1tdGFiPSJteW1vZGVscyI+TXkgTW9kZWxzPC9idXR0b24+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMiI+CiAgICAgICAgPGRpdiBjbGFzcz0icmVsYXRpdmUiPgogICAgICAgICAgPGkgZGF0YS1pY29uPSJtYWduaWZ5aW5nLWdsYXNzIiBjbGFzcz0idy00IGgtNCBhYnNvbHV0ZSBsZWZ0LTMgdG9wLTEvMiAtdHJhbnNsYXRlLXktMS8yIHRleHQtbmV1dHJhbC01MDAiPjwvaT4KICAgICAgICAgIDxpbnB1dCBpZD0ibXNlYXJjaCIgY2xhc3M9ImlucCBwbC05IHctNTYgaC05IiBwbGFjZWhvbGRlcj0iU2VhcmNoLi4uIi8+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGJ1dHRvbiBpZD0ibWZpbHRlcnMiIGNsYXNzPSJidG4gYnRuLWdob3N0IGgtOSBweC0zIGJvcmRlciBiZCB0ZXh0LXhzIHNocmluay0wIj48aSBkYXRhLWljb249InNsaWRlcnMtaG9yaXpvbnRhbCIgY2xhc3M9InctNCBoLTQiPjwvaT5GaWx0ZXJzPC9idXR0b24+CiAgICAgICAgPGJ1dHRvbiBpZD0ibW9kYWwtY2xvc2UiIGNsYXNzPSJ3LTkgaC05IGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHRleHQtd2hpdGUgaG92ZXI6YmctWyMxYzIxMjhdIHJvdW5kZWQtbGcgdGV4dC14bCBsZWFkaW5nLW5vbmUiIHRpdGxlPSJUdXR1cCI+4pyVPC9idXR0b24+CiAgICAgICAgPGgzIGlkPSJtb2RhbC10aXRsZSIgY2xhc3M9ImhpZGRlbiBmb250LXNlbWlib2xkIHRleHQtc20iPlBpbGloIE1vZGVsPC9oMz4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgaWQ9Im1jYXQiIGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41IHB4LTQgcHktMiBoaWRlYmFyIG92ZXJmbG93LXgtYXV0byI+PC9kaXY+CiAgICA8ZGl2IGlkPSJtb2RhbC1ib2R5IiBjbGFzcz0ibWF4LWgtWzU1dmhdIG92ZXJmbG93LXktYXV0byBwLTQiPjwvZGl2PgogIDwvZGl2Pgo8L2Rpdj4KCgo8c2NyaXB0Pgpjb25zdCAkID0gaWQgPT4gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwpjb25zdCBTID0gJ2h0dHBzOi8vcGljc3VtLnBob3Rvcy9zZWVkLyc7CmNvbnN0IHN0YXRlID0geyByZXN1bHRzOltdLCBwYWdlOid0ZXh0JywgYXNwZWN0Oidwb3J0cmFpdCcsIG5jb2w6MSwgbW9kZWw6bnVsbCB9OwoKLyogPT09PT0gTG9SQSDigJQgZGFmdGFyIGFzbGkgcGVyIHByb3ZpZGVyID09PT09ICovCnZhciBMT1JBX0xJQlMgPSB7CiAgdGFtczogWwogICAgeyBuYW1lOidaLUltYWdlIExvUkEgfCBEZXRhaWwnLCB0YWdzOlsnZGV0YWlsZWQnLCdzaGFycCddLCB0aHVtYjonYWZybycsIGJhZGdlOidaLUlNQUdFJywgdmlld3M6JzEySycsIHZlcjonVjEnLCBiYXNlOidaIEltYWdlJyB9LAogICAgeyBuYW1lOidaLUltYWdlIFR1cmJvJywgdGFnczpbJ3R1cmJvJywnZmFzdCddLCB0aHVtYjoncmV0cm8nLCBiYWRnZTonWi1JTUFHRS1UVVJCTycsIHZpZXdzOic4SycsIHZlcjonVjEnLCBiYXNlOidaIEltYWdlJyB9LAogICAgeyBuYW1lOidaLUltYWdlIEhEUicsIHRhZ3M6WydoZHInLCd2aXZpZCddLCB0aHVtYjonaGRyJywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMTVLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sCiAgICB7IG5hbWU6J1otSW1hZ2UgUG9ydHJhaXQnLCB0YWdzOlsncG9ydHJhaXQnLCdib2tlaCddLCB0aHVtYjoncHRydCcsIGJhZGdlOidaLUlNQUdFJywgdmlld3M6JzIySycsIHZlcjonVjEnLCBiYXNlOidaIEltYWdlJyB9LAogICAgeyBuYW1lOidaLUltYWdlIEFydGlzdGljJywgdGFnczpbJ2FydGlzdGljJywncGFpbnQnXSwgdGh1bWI6J2FydCcsIGJhZGdlOidaLUlNQUdFJywgdmlld3M6JzE4SycsIHZlcjonVjEnLCBiYXNlOidaIEltYWdlJyB9LAogICAgeyBuYW1lOidGbHV4IFJlYWxpc20gTG9SQScsIHRhZ3M6WydyZWFsaXN0aWMnLCdwaG90byddLCB0aHVtYjonZmx1eGwnLCBiYWRnZTonRkxVWCcsIHZpZXdzOic0NUsnLCB2ZXI6J1YxJywgYmFzZTonRkxVWC4xJyB9LAogICAgeyBuYW1lOidGbHV4IENpbmVtYXRpYyBMb1JBJywgdGFnczpbJ2NpbmVtYXRpYycsJ21vb2R5J10sIHRodW1iOidmbHV4YycsIGJhZGdlOidGTFVYJywgdmlld3M6JzMzSycsIHZlcjonVjEnLCBiYXNlOidGTFVYLjEnIH0sCiAgICB7IG5hbWU6J1NEWEwgRmluZSBEZXRhaWwnLCB0YWdzOlsnZGV0YWlsZWQnLCdzaGFycCddLCB0aHVtYjonZGV0YWlsJywgYmFkZ2U6J1NEWEwnLCB2aWV3czonNTAwSycsIHZlcjonVjEnLCBiYXNlOidTRFhMJyB9LAogICAgeyBuYW1lOidTRFhMIEFuaW1lIFN0eWxlJywgdGFnczpbJ2FuaW1lJywnY2VsJ10sIHRodW1iOidhbmltZXNsJywgYmFkZ2U6J1NEWEwnLCB2aWV3czonMjgwSycsIHZlcjonVjEnLCBiYXNlOidTRFhMJyB9LAogICAgeyBuYW1lOidQb255IEVxdWVzdHJpYW4gQXJ0JywgdGFnczpbJ3BvbnknLCdmYW50YXN5J10sIHRodW1iOidwb255bCcsIGJhZGdlOidQT05ZJywgdmlld3M6JzE1MEsnLCB2ZXI6J1YxJywgYmFzZTonUG9ueScgfSwKICAgIHsgbmFtZTonTmlwcG9uLUNvcmUgUmV0cm8gLSB2MC4xJywgdGFnczpbJ2phcHJldHI3Y29tbScsJ3JldHJvIG1hZ2F6aW5lJ10sIHRodW1iOidiaWxpYmluJywgYmFkZ2U6J1NUWUxFJywgdmlld3M6Jzk2SycsIHZlcjonVi4xJywgYmFzZTonU0RYTCcgfSwKICAgIHsgbmFtZTonSXZhbiBCaWxpYmluIC0gdjAuNycsIHRhZ3M6WydpdmFuYmlsaWJpbjV6JywnaWxsdXN0cmF0aW9uJywnYXJ0IGRlY28nXSwgdGh1bWI6J2RldGFpbCcsIGJhZGdlOidJTExVU1RSQVRJT04nLCB2aWV3czonMTU0SycsIHZlcjonVi4xJywgYmFzZTonU0RYTCcgfSwKICAgIHsgbmFtZTonRGV0YWlsIFR3ZWFrZXIgLSB2MS4wJywgdGFnczpbJ2RldGFpbGVkJ10sIHRodW1iOidncmFpbicsIGJhZGdlOidVVElMSVRZJywgdmlld3M6JzEuMk0nLCB2ZXI6J1YuMScsIGJhc2U6J1NEWEwnIH0sCiAgICB7IG5hbWU6J0ZpbG0gR3JhaW4gLSB2MC41JywgdGFnczpbJ2ZpbG0gZ3JhaW4nLCdhbmFsb2cnXSwgdGh1bWI6J2dyYWluJywgYmFkZ2U6J1VUSUxJVFknLCB2aWV3czonNjdLJywgdmVyOidWLjEnLCBiYXNlOidTRFhMJyB9LAogIF0sCiAgcmVwbGljYXRlOiBbCiAgICB7IG5hbWU6J0ZMVVguMSBbc2NobmVsbF0gTG9SQScsIGJhc2U6J0ZMVVgnLCBtb2RlbDonYmxhY2stZm9yZXN0LWxhYnMvZmx1eC1zY2huZWxsLWxvcmEnLCB0YWdzOlsnZmx1eC1sb3JhJ10sIHRodW1iOidmbHV4bCcsIGJhZGdlOidGTFVYLUxPUkEnLCB2aWV3czonMTIwSycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwKICAgIHsgbmFtZTonRkxVWC4xIFtkZXZdIExvUkEnLCBiYXNlOidGTFVYJywgbW9kZWw6J2JsYWNrLWZvcmVzdC1sYWJzL2ZsdXgtZGV2LWxvcmEnLCB0YWdzOlsnZmx1eC1sb3JhJ10sIHRodW1iOidmbHV4ZGwnLCBiYWRnZTonRkxVWC1MT1JBJywgdmlld3M6JzkwSycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwKICAgIHsgbmFtZTonU0RYTCArIExvUkEgVVJMIChjdXN0b20pJywgYmFzZTonU0RYTCcsIG1vZGVsOid6eWxpbTA3MDIvc2R4bC1sb3JhLWN1c3RvbWl6ZS1tb2RlbCcsIHRhZ3M6Wydsb3JhJ10sIHRodW1iOidzZHhsbCcsIGJhZGdlOidTRFhMLUxPUkEnLCB2aWV3czonMzEwSycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwKICAgIHsgbmFtZTonSUtFQSBJbnN0cnVjdGlvbnMgKFNEWEwsIGJhd2FhbiknLCBiYXNlOidTRFhMJywgbW9kZWw6J29zdHJpcy9pa2VhLWluc3RydWN0aW9ucy1sb3JhLXNkeGwnLCB0YWdzOlsnaWtlYSBpbnN0cnVjdGlvbnMnXSwgdGh1bWI6J2lrZWEnLCBiYWRnZTonU1RZTEUnLCB2aWV3czonMjEwSycsIHZlcjonVjEnIH0sCiAgXSwKICBmYWw6IFsKICAgIHsgbmFtZTonRkxVWCBMb1JBJywgYmFzZTonRkxVWCcsIG1vZGVsOidmYWwtYWkvZmx1eC1sb3JhJywgdGFnczpbJ2ZsdXgtbG9yYSddLCB0aHVtYjonZmx1eGwnLCBiYWRnZTonRkxVWC1MT1JBJywgdmlld3M6JzE1MEsnLCB2ZXI6J1YxJywgbmVlZFVybDp0cnVlIH0sCiAgICB7IG5hbWU6J1NEWEwgKyBMb1JBIFVSTCAoZmFzdC1zZHhsKScsIGJhc2U6J1NEWEwnLCBtb2RlbDonZmFsLWFpL2Zhc3Qtc2R4bCcsIHRhZ3M6Wydsb3JhJ10sIHRodW1iOidzZHhsbCcsIGJhZGdlOidTRFhMLUxPUkEnLCB2aWV3czonMTIwSycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwKICAgIHsgbmFtZTonS3JlYSAyIExvUkEgKHR1cmJvKScsIGJhc2U6J0tyZWEgMicsIG1vZGVsOidmYWwtYWkva3JlYS0yL3R1cmJvL2xvcmEnLCB0YWdzOlsna3JlYTInXSwgdGh1bWI6J2tyZWEnLCBiYWRnZTonS1JFQTItTE9SQScsIHZpZXdzOic2NksnLCB2ZXI6J1YxJywgbmVlZFVybDp0cnVlIH0sCiAgXSwKICBwb2xsaW5hdGlvbnM6IFtdLCAvLyBMb1JBIHRpZGFrIGRpZHVrdW5nIOKAlCBncmF0aXMsIG1vZGVsIGJhd2FhbiBzYWphCn07CnZhciBMT1JBX0xJQiA9IExPUkFfTElCUy50YW1zOyAvLyBkYWZ0YXIgYWt0aWYgbWVuZ2lrdXRpIHByb3ZpZGVyCmNvbnN0IExPUkEgPSBbXTsKLyogPT09PT0gTW9kZWwgbW9kYWwg4oCUIGRhZnRhciBtb2RlbCBhc2xpIHBlciBwcm92aWRlciA9PT09PSAqLwp2YXIgTU9ERUxfTElCUyA9IHsKICB0YW1zOiBbCiAgICB7IG5hbWU6J1ogSW1hZ2UgLSBiYXNlLWJmMTYnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1ogSW1hZ2UnLCB0aHVtYjonemltYWdlJywgYmFkZ2U6J1onLCB2aWV3czonNDRLJywgdmVyOidWLjEnLCBtb2RlbElkOicxMDI3OTA2MjUzMjYwNjAzODA1JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYyNTQzMzQzNjYyNDUnIH0sCiAgICB7IG5hbWU6J0ZMVVguMSBbZGV2XScsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonRkxVWC4xJywgdGh1bWI6J2ZsdXgnLCBiYWRnZTonRkxVWCcsIHZpZXdzOicxNTRLJywgdmVyOidWLjEnLCBtb2RlbElkOicxMDI3OTA2MjgyNjQ0NTI1MDU2JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYyODI2NDQ1MjUwNTcnIH0sCiAgICB7IG5hbWU6J1N0YWJsZSBEaWZmdXNpb24gWEwnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonc2R4bCcsIGJhZGdlOidTRFhMIDEuMCcsIHZpZXdzOic4OTJLJywgdmVyOidWLjEnLCBtb2RlbElkOicxMDI3OTA2MzA5MDMyMTM2NzA0JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzMDkwMzIxMzY3MDUnIH0sCiAgICB7IG5hbWU6J1N0YWJsZSBEaWZmdXNpb24gMy41IE1lZGl1bScsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonU0QgMy41JywgdGh1bWI6J3NkMzUnLCBiYWRnZTonU0QgMy41Jywgdmlld3M6JzMxMksnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYzMTc0NTI4MDgxOTInLCBtb2RlbEZpbGVJZDonMTAyNzkwNjMxNzQ1MjgwODE5MycgfSwKICAgIHsgbmFtZTonUG9ueSBEaWZmdXNpb24gVjYnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1BvbnknLCB0aHVtYjoncG9ueScsIGJhZGdlOidQT05ZJywgdmlld3M6JzIuMU0nLCB2ZXI6J1Y2JywgbW9kZWxJZDonMTAyNzkwNjMyNjg3NDI3MTc0NCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzI2ODc0MjcxNzQ1JyB9LAogICAgeyBuYW1lOidJbGx1c3RyaW91cyBYTCcsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonSWxsdXN0cmlvdXMnLCB0aHVtYjonaWxsdXN0JywgYmFkZ2U6J0lMTFVTVFJJT1VTJywgdmlld3M6JzY3SycsIHZlcjonVi4xJywgbW9kZWxJZDonMTAyNzkwNjMzNTc4MjQxNDMzNicsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzM1NzgyNDE0MzM3JyB9LAogICAgeyBuYW1lOidBbmltYScsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonQW5pbWEnLCB0aHVtYjonYW5pbWEnLCBiYWRnZTonQU5JTUEnLCB2aWV3czonNTJLJywgdmVyOidWLjEnLCBtb2RlbElkOicxMDI3OTA2MzQ0NzE2NzcxODQwJywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzNDQ3MTY3NzE4NDEnIH0sCiAgICB7IG5hbWU6J0RyZWFtU2hhcGVyJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J2RyZWFtJywgYmFkZ2U6J0RTJywgdmlld3M6JzgxMksnLCB2ZXI6J1YuNScsIG1vZGVsSWQ6JzEwMjc5MDYzNTM0OTk0Mjk4ODgnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM1MzQ5OTQyOTg4OScgfSwKICAgIHsgbmFtZTonUmVhbGlzdGljIFZpc2lvbicsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonU0RYTCcsIHRodW1iOidyZWFsJywgYmFkZ2U6J1JWJywgdmlld3M6JzY0NUsnLCB2ZXI6J1YuNi4wJywgbW9kZWxJZDonMTAyNzkwNjM2MjQxMjUzMTcxMicsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzYyNDEyNTMxNzEzJyB9LAogICAgeyBuYW1lOidDb3VudGVyZmVpdCcsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonU0RYTCcsIHRodW1iOidjb3VudGVyJywgYmFkZ2U6J0NPVU5URVJGRUlUJywgdmlld3M6JzQyMEsnLCB2ZXI6J1YuNScsIG1vZGVsSWQ6JzEwMjc5MDYzNzEzMzQ3Mjc2ODAnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM3MTMzNDcyNzY4MScgfSwKICAgIHsgbmFtZTonTHlyaWVsJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J2x5cmllbCcsIGJhZGdlOidMWVJJRUwnLCB2aWV3czonMzIwSycsIHZlcjonVi4xLjYnLCBtb2RlbElkOicxMDI3OTA2Mzc5OTk2MDEzNTY4JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzNzk5OTYwMTM1NjknIH0sCiAgICB7IG5hbWU6J0p1Z2dlcm5hdXQnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjonanVnJywgYmFkZ2U6J0pVR0cnLCB2aWV3czonMjEwSycsIHZlcjonVi45JywgbW9kZWxJZDonMTAyNzkwNjM4ODQyMTA5OTUyMCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2Mzg4NDIxMDk5NTIxJyB9LAogIF0sCiAgcmVwbGljYXRlOiBbCiAgICB7IG5hbWU6J0ZMVVguMSBbc2NobmVsbF0nLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidGTFVYJywgdGh1bWI6J2ZsdXgnLCBiYWRnZTonRkxVWCcsIHZpZXdzOic0TScsIHZlcjonVjEnLCBtb2RlbDonYmxhY2stZm9yZXN0LWxhYnMvZmx1eC1zY2huZWxsJyB9LAogICAgeyBuYW1lOidGTFVYLjEgW2Rldl0nLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidGTFVYJywgdGh1bWI6J2ZsdXhkJywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonMi4xTScsIHZlcjonVjEnLCBtb2RlbDonYmxhY2stZm9yZXN0LWxhYnMvZmx1eC1kZXYnIH0sCiAgICB7IG5hbWU6J1NEWEwgMS4wJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0RYTCcsIHRodW1iOidzZHhsJywgYmFkZ2U6J1NEWEwgMS4wJywgdmlld3M6JzEuMk0nLCB2ZXI6J1YxJywgbW9kZWw6J3N0YWJpbGl0eS1haS9zZHhsJyB9LAogICAgeyBuYW1lOidTdGFibGUgRGlmZnVzaW9uIDMuNSBMYXJnZScsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J1NEIDMuNScsIHRodW1iOidzZDM1JywgYmFkZ2U6J1NEIDMuNScsIHZpZXdzOicxLjVNJywgdmVyOidWMScsIG1vZGVsOidzdGFiaWxpdHktYWkvc3RhYmxlLWRpZmZ1c2lvbi0zLjUtbGFyZ2UnIH0sCiAgICB7IG5hbWU6J1NEWEwgTGlnaHRuaW5nIDQtU3RlcCcsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J1NEWEwnLCB0aHVtYjonbGlnaHRuaW5nJywgYmFkZ2U6J0xJR0hUTklORycsIHZpZXdzOicxLjhNJywgdmVyOidWMScsIG1vZGVsOidieXRlZGFuY2Uvc2R4bC1saWdodG5pbmctNHN0ZXAnIH0sCiAgICB7IG5hbWU6J1JlYWxWaXNYTCBWNC4wJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0RYTCcsIHRodW1iOidyZWFsJywgYmFkZ2U6J1JFQUxJU1RJQycsIHZpZXdzOic5MDBLJywgdmVyOidWNC4wJywgbW9kZWw6J2x1Y2F0YWNvL3JlYWx2aXN4bC12NC4wJyB9LAogICAgeyBuYW1lOidKdWdnZXJuYXV0IFhMIFY5JywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0RYTCcsIHRodW1iOidqdWcnLCBiYWRnZTonSlVHRycsIHZpZXdzOic3NTBLJywgdmVyOidWOScsIG1vZGVsOidkaWdpcGxheS9KdWdnZXJuYXV0X1hMX3Y5JyB9LAogICAgeyBuYW1lOidTRFhMIEVtb2ppJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0RYTCcsIHRodW1iOidlbW9qaScsIGJhZGdlOidFTU9KSScsIHZpZXdzOic2MDBLJywgdmVyOidWMScsIG1vZGVsOidmb2ZyL3NkeGwtZW1vamknIH0sCiAgXSwKICBmYWw6IFsKICAgIHsgbmFtZTonRkxVWC4xIFtzY2huZWxsXScsIGJhc2U6J2ZhbC5haScsIGFyY2g6J0ZMVVgnLCB0aHVtYjonZmx1eCcsIGJhZGdlOidGTFVYJywgdmlld3M6JzVNJywgdmVyOidWMScsIG1vZGVsOidmYWwtYWkvZmx1eC9zY2huZWxsJyB9LAogICAgeyBuYW1lOidGTFVYLjEgW2Rldl0nLCBiYXNlOidmYWwuYWknLCBhcmNoOidGTFVYJywgdGh1bWI6J2ZsdXhkJywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonM00nLCB2ZXI6J1YxJywgbW9kZWw6J2ZhbC1haS9mbHV4L2RldicgfSwKICAgIHsgbmFtZTonRmFzdCBTRFhMJywgYmFzZTonZmFsLmFpJywgYXJjaDonU0RYTCcsIHRodW1iOidmYXN0c2R4bCcsIGJhZGdlOidGQUwnLCB2aWV3czonMi41TScsIHZlcjonVjEnLCBtb2RlbDonZmFsLWFpL2Zhc3Qtc2R4bCcgfSwKICAgIHsgbmFtZTonU0RYTCcsIGJhc2U6J2ZhbC5haScsIGFyY2g6J1NEWEwnLCB0aHVtYjonc2R4bCcsIGJhZGdlOidTRFhMIDEuMCcsIHZpZXdzOicxLjFNJywgdmVyOidWMScsIG1vZGVsOidmYWwtYWkvc2R4bCcgfSwKICAgIHsgbmFtZTonU3RhYmxlIERpZmZ1c2lvbiAzLjUgTGFyZ2UnLCBiYXNlOidmYWwuYWknLCBhcmNoOidTRCAzLjUnLCB0aHVtYjonc2QzNScsIGJhZGdlOidTRCAzLjUnLCB2aWV3czonOTAwSycsIHZlcjonVjEnLCBtb2RlbDonZmFsLWFpL3N0YWJsZS1kaWZmdXNpb24tdjM1LWxhcmdlJyB9LAogICAgeyBuYW1lOidQbGF5Z3JvdW5kIHYyLjUnLCBiYXNlOidmYWwuYWknLCBhcmNoOidTRFhMJywgdGh1bWI6J3BsYXknLCBiYWRnZTonUExBWScsIHZpZXdzOic3MDBLJywgdmVyOidWMi41JywgbW9kZWw6J2ZhbC1haS9wbGF5Z3JvdW5kL3YyLjUnIH0sCiAgICB7IG5hbWU6J0tyZWEgMiBUdXJibycsIGJhc2U6J2ZhbC5haScsIGFyY2g6J0tyZWEgMicsIHRodW1iOidrcmVhJywgYmFkZ2U6J0tSRUEyJywgdmlld3M6JzEuMU0nLCB2ZXI6J1YyJywgbW9kZWw6J2ZhbC1haS9rcmVhLTIvdHVyYm8nIH0sCiAgXSwKICBwb2xsaW5hdGlvbnM6IFsKICAgIHsgbmFtZTonWi1JbWFnZSBUdXJibycsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0FsaWJhYmEnLCB0aHVtYjonemltYWdlJywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOid6aW1hZ2UnIH0sCiAgICB7IG5hbWU6J0dQVCBJbWFnZSAyJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonT3BlbkFJJywgdGh1bWI6J2dwdCcsIGJhZGdlOidGUkVFJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDonZ3B0LWltYWdlLTInIH0sCiAgICB7IG5hbWU6J0ZMVVguMSBTY2huZWxsJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonQmxhY2sgRm9yZXN0IExhYnMnLCB0aHVtYjonZmx1eCcsIGJhZGdlOidGUkVFJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDonZmx1eCcgfSwKICAgIHsgbmFtZTonRHJlYW1TaGFwZXIgOCBMQ00nLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidMeWtvbicsIHRodW1iOidkcmVhbScsIGJhZGdlOidGUkVFJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDonZHJlYW1zaGFwZXInIH0sCiAgICB7IG5hbWU6J0ZMVVguMiBLbGVpbiA0QicsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0JsYWNrIEZvcmVzdCBMYWJzJywgdGh1bWI6J2tsZWluJywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidrbGVpbicgfSwKICAgIHsgbmFtZTonS3JlYSAyIE1lZGl1bScsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0tyZWEnLCB0aHVtYjona3JlYScsIGJhZGdlOidQQUlEJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDona3JlYScgfSwKICAgIHsgbmFtZTonU2VlZHJlYW0gNS4wIExpdGUnLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidCeXRlRGFuY2UnLCB0aHVtYjonc2VlZCcsIGJhZGdlOidQQUlEJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDonc2VlZHJlYW01JyB9LAogICAgeyBuYW1lOidRd2VuIEltYWdlIDMnLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidRd2VuJywgdGh1bWI6J3F3ZW4nLCBiYWRnZTonUEFJRCcsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J3F3ZW4taW1hZ2UtMycgfSwKICAgIHsgbmFtZTonTmFubyBCYW5hbmEgMicsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0dvb2dsZScsIHRodW1iOiduYW5vJywgYmFkZ2U6J1BBSUQnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOiduYW5vYmFuYW5hLTInIH0sCiAgXSwKfTsKdmFyIE1PREVMUyA9IE1PREVMX0xJQlMudGFtczsgLy8gZGFmdGFyIGFrdGlmIG1lbmdpa3V0aSBwcm92aWRlcgp2YXIgTUNBVCA9IFsnVHJ5IE5vdycsJ0FMTCcsJ09GRklDSUFMIE1PREVMJywnTUVNRScsJ0VYQ0xVU0lWRScsJ0JFQVVUWScsJzNEJywnMi41RCcsJ01BTEUnLCdBTklNRScsJ1JFQUxJU1RJQycsJ1NUWUxFJywnR0FNRScsJ0RFU0lHTicsJ1NDRU5FUlknLCdCVUlMRElOR1MnLCdNRUNIQSddOwp2YXIgX2N1ckxpc3Q9W10sIF9jdXJPblNlbD1mdW5jdGlvbigpe307CmZ1bmN0aW9uIHJlbmRlckNhcmRzKGxpc3QsIG9uU2VsKXsKICBfY3VyTGlzdD1saXN0OyBfY3VyT25TZWw9b25TZWw7CiAgdmFyIGI9JCgnbW9kYWwtYm9keScpOyBiLmlubmVySFRNTD0nJzsKICBpZighbGlzdC5sZW5ndGgpeyBiLmlubmVySFRNTD0nPHAgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBwLTMgdGV4dC1jZW50ZXIiPlRpZGFrIGFkYSBoYXNpbC48L3A+JzsgcmV0dXJuOyB9CiAgdmFyIGdyaWQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgZ3JpZC5jbGFzc05hbWU9J2dyaWQgZ3JpZC1jb2xzLTMgc206Z3JpZC1jb2xzLTQgbWQ6Z3JpZC1jb2xzLTUgZ2FwLTMnOwogIGxpc3QuZm9yRWFjaChmdW5jdGlvbihtKXsKICAgIHZhciBkPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogICAgZC5jbGFzc05hbWU9J21jYXJkJzsKICAgIGQuaW5uZXJIVE1MID0nPGRpdiBjbGFzcz0ibWNhcmQtaW1nIj4nCiAgICAgICsnPGltZyBzcmM9IicrUyttLnRodW1iKycvMzAwIi8+JwogICAgICArJzxzcGFuIGNsYXNzPSJtY2FyZC1iYWRnZSI+JyttLmJhZGdlKyc8L3NwYW4+JwogICAgICArJzxkaXYgY2xhc3M9Im1jYXJkLXN0YXIiPjxpIGRhdGEtaWNvbj0ic3RhciIgY2xhc3M9InctNCBoLTQiPjwvaT48L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibWNhcmQtdmlld3MiPjxpIGRhdGEtaWNvbj0icGxheS1maWxsIiBjbGFzcz0idy0zIGgtMyI+PC9pPicrbS52aWV3cysnPC9kaXY+JwogICAgICArJzwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC1pbmZvIj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibWNhcmQtbmFtZSIgdGl0bGU9IicrbS5uYW1lKyciPicrbS5uYW1lKyc8L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0ibWNhcmQtbWV0YSI+JwogICAgICArJzxzZWxlY3QgY2xhc3M9Im1jYXJkLXZlciI+PG9wdGlvbj4nK20udmVyKyc8L29wdGlvbj48b3B0aW9uPlYuMjwvb3B0aW9uPjxvcHRpb24+Vi4zPC9vcHRpb24+PC9zZWxlY3Q+JwogICAgICArJzxidXR0b24gY2xhc3M9Im1jYXJkLXNlbCI+U2VsZWN0PC9idXR0b24+JwogICAgICArJzwvZGl2PjwvZGl2Pic7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5tY2FyZC1zdGFyJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKGUpeyBlLnRhcmdldC5jbG9zZXN0KCcubWNhcmQtc3RhcicpLmNsYXNzTGlzdC50b2dnbGUoJ29uJyk7IH0pOwogICAgZC5xdWVyeVNlbGVjdG9yKCcubWNhcmQtc2VsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IF9jdXJPblNlbChtKTsgfSk7CiAgICBncmlkLmFwcGVuZENoaWxkKGQpOwogIH0pOwogIGIuYXBwZW5kQ2hpbGQoZ3JpZCk7Cn0KZnVuY3Rpb24gYXBwbHlTZWFyY2goKXsKICB2YXIgcT0oJCgnbXNlYXJjaCcpLnZhbHVlfHwnJykudG9Mb3dlckNhc2UoKTsKICByZW5kZXJDYXJkcyhfY3VyTGlzdC5maWx0ZXIoZnVuY3Rpb24obSl7cmV0dXJuICFxfHxtLm5hbWUudG9Mb3dlckNhc2UoKS5pbmRleE9mKHEpPj0wfSksIF9jdXJPblNlbCk7Cn0KJCgnbXNlYXJjaCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxhcHBseVNlYXJjaCk7CiQoJ21maWx0ZXJzJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7ICQoJ21jYXQnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nKTsgJCgnbWZpbHRlcnMnKS5jbGFzc0xpc3QudG9nZ2xlKCdvbicpOyB9KTsKZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLm10YWInKS5mb3JFYWNoKGZ1bmN0aW9uKHQpewogIHQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubXRhYicpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QucmVtb3ZlKCdzZWwnKX0pOwogICAgdC5jbGFzc0xpc3QuYWRkKCdzZWwnKTsKICAgIGlmKHQuZGF0YXNldC5tdGFiPT09J2Jhc2ljJykgcmVuZGVyQ2FyZHMoTU9ERUxTLCBmdW5jdGlvbihtKXsgc2V0TW9kZWwobSk7IGNsb3NlTW9kYWwoKTsgfSk7CiAgICBlbHNlIHJlbmRlckNhcmRzKFtdLCBudWxsKTsKICB9KTsKfSk7CmZ1bmN0aW9uIHJlbmRlck1DYXQob25QaWNrKXsKICB2YXIgYz0kKCdtY2F0Jyk7CiAgaWYoIW9uUGljaykgb25QaWNrPWZ1bmN0aW9uKCl7fTsKICB2YXIgaHRtbD0nJzsKICBNQ0FULmZvckVhY2goZnVuY3Rpb24oY2F0LGkpewogICAgaHRtbCs9JzxidXR0b24gY2xhc3M9Im1jaGlwIiBkYXRhLW1jYXQ9IicrY2F0KyciPicrY2F0Kyc8L2J1dHRvbj4nOwogIH0pOwogIGMuaW5uZXJIVE1MPWh0bWw7CiAgYy5xdWVyeVNlbGVjdG9yKCcubWNoaXAnKS5jbGFzc0xpc3QuYWRkKCdvbicpOwogIGMucXVlcnlTZWxlY3RvckFsbCgnLm1jaGlwJykuZm9yRWFjaChmdW5jdGlvbihjaCl7CiAgICBjaC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgICAgYy5xdWVyeVNlbGVjdG9yQWxsKCcubWNoaXAnKS5mb3JFYWNoKGZ1bmN0aW9uKHgpe3guY2xhc3NMaXN0LnJlbW92ZSgnb24nKX0pOwogICAgICBjaC5jbGFzc0xpc3QuYWRkKCdvbicpOwogICAgICBvblBpY2soY2guZGF0YXNldC5tY2F0KTsKICAgIH0pOwogIH0pOwp9CmZ1bmN0aW9uIHNldE1vZGVsKG0pewogIHN0YXRlLm1vZGVsPW07CiAgJCgnbW9kZWwtbmFtZScpLnRleHRDb250ZW50PW0ubmFtZTsKICAkKCdtb2RlbC10aHVtYicpLnNyYz0naHR0cHM6Ly9waWNzdW0ucGhvdG9zL3NlZWQvJyttLnRodW1iKycvNjQnOwogIHZhciBiPSQoJ21vZGVsLWJhZGdlJyk7IGlmKGIpIGIudGV4dENvbnRlbnQ9KG0uYmFzZXx8J01vZGVsJykrJyAtICcrKG0uYXJjaHx8JycpOwp9CmZ1bmN0aW9uIG9wZW5Nb2RlbFNlbGVjdG9yKCl7CiAgJCgnbW9kYWwtdGl0bGUnKS50ZXh0Q29udGVudD0nUGlsaWggTW9kZWwnOwogIHJlbmRlck1DYXQoZnVuY3Rpb24oKXsgcmVuZGVyQ2FyZHMoTU9ERUxTLCBmdW5jdGlvbihtKXsgc2V0TW9kZWwobSk7IGNsb3NlTW9kYWwoKTsgfSk7IH0pOwogIHJlbmRlckNhcmRzKE1PREVMUywgZnVuY3Rpb24obSl7IHNldE1vZGVsKG0pOyBjbG9zZU1vZGFsKCk7IH0pOwogIG9wZW5Nb2RhbCgpOwp9CiQoJ21vZGVsLWNhcmQnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsb3Blbk1vZGVsU2VsZWN0b3IpOwpmdW5jdGlvbiBvcGVuTG9yYU1vZGFsKCl7CiAgJCgnbW9kYWwtdGl0bGUnKS50ZXh0Q29udGVudD0nUGlsaWggTG9SQSc7CiAgdmFyIGFyY2g9c3RhdGUubW9kZWw/c3RhdGUubW9kZWwuYXJjaDonJzsKICB2YXIgYXZhaWw9ZnVuY3Rpb24oKXsgcmV0dXJuIExPUkFfTElCLmZpbHRlcihmdW5jdGlvbihsKXsKICAgIHJldHVybiAoIUxPUkEuc29tZShmdW5jdGlvbih4KXtyZXR1cm4geC5uYW1lPT09bC5uYW1lfSkpICYmICghYXJjaCB8fCAhbC5iYXNlIHx8IGwuYmFzZT09PWFyY2gpOwogIH0pOyB9OwogIHZhciBvblNlbD1mdW5jdGlvbihsKXsKICAgIExPUkEucHVzaCh7IG5hbWU6bC5uYW1lLCB3OjAuOCwgdGFnczpsLnRhZ3MsIHRodW1iOmwudGh1bWIsIGJhc2U6bC5iYXNlLCBsb3JhTW9kZWw6bC5tb2RlbHx8JycsIG5lZWRVcmw6bC5uZWVkVXJsLCBsb3JhVXJsOicnIH0pOwogICAgcmVuZGVyTG9yYSgpOyBjbG9zZU1vZGFsKCk7CiAgfTsKICByZW5kZXJNQ2F0KGZ1bmN0aW9uKCl7IHJlbmRlckNhcmRzKGF2YWlsKCksIG9uU2VsKTsgfSk7CiAgcmVuZGVyQ2FyZHMoYXZhaWwoKSwgb25TZWwpOwogIGlmKCFhdmFpbCgpLmxlbmd0aCl7ICQoJ21vZGFsLXRpdGxlJykudGV4dENvbnRlbnQ9J1RpZGFrIGFkYSBMb1JBIHVudHVrICcrYXJjaDsgfQogIG9wZW5Nb2RhbCgpOwp9CmZ1bmN0aW9uIG9wZW5Nb2RhbCgpeyAkKCdtb2RhbCcpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyAkKCdtb2RhbCcpLmNsYXNzTGlzdC5hZGQoJ2ZsZXgnKTsgfQpmdW5jdGlvbiBjbG9zZU1vZGFsKCl7ICQoJ21vZGFsJykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ21vZGFsJykuY2xhc3NMaXN0LnJlbW92ZSgnZmxleCcpOyB9CmZ1bmN0aW9uIG9wZW5Mb3JhSW5mbyhsKXsKICAkKCdtb2RhbC10aXRsZScpLnRleHRDb250ZW50PSdEZXRhaWwgTG9SQSc7CiAgJCgnbWNhdCcpLmlubmVySFRNTD0nJzsKICB2YXIgYj0kKCdtb2RhbC1ib2R5Jyk7CiAgYi5pbm5lckhUTUw9JzxkaXYgY2xhc3M9ImZsZXggZ2FwLTMgcC0yIj4nCiAgICArJzxpbWcgc3JjPSInK1MrbC50aHVtYisnLzE0MCIgY2xhc3M9InctMjggaC0yOCByb3VuZGVkLWxnIG9iamVjdC1jb3ZlciBzaHJpbmstMCIvPicKICAgICsnPGRpdiBjbGFzcz0iZmxleC0xIG1pbi13LTAiPicKICAgICsnPGRpdiBjbGFzcz0iZmxleCBmbGV4LXdyYXAgZ2FwLTEuNSBtYi0xIj4nCiAgICArJzxzcGFuIGNsYXNzPSJ0ZXh0LVsxMHB4XSBmb250LXNlbWlib2xkIGJnLVsjMWMyMTI4XSBib3JkZXIgYmQgcHgtMS41IHB5LTAuNSByb3VuZGVkIHRleHQtbmV1dHJhbC00MDAiPkxPUkE8L3NwYW4+JwogICAgKyc8c3BhbiBjbGFzcz0idGV4dC1bMTBweF0gZm9udC1zZW1pYm9sZCBiZy1bcmdiYSgxMTEsOTMsMjU1LC4xNSldIGJvcmRlciBib3JkZXItWyM2RjVERkZdIHB4LTEuNSBweS0wLjUgcm91bmRlZCB0ZXh0LVsjNkY1REZGXSI+JytsLmJhZGdlKyc8L3NwYW4+JwogICAgKyc8c3BhbiBjbGFzcz0idGV4dC1bMTBweF0gZm9udC1zZW1pYm9sZCBiZy1bIzFjMjEyOF0gYm9yZGVyIGJkIHB4LTEuNSBweS0wLjUgcm91bmRlZCB0ZXh0LW5ldXRyYWwtNDAwIj5PcmlnaW5hbDwvc3Bhbj4nCiAgICArJzwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj4nK2wubmFtZSsnPC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgbXQtMC41Ij5SZWt0eSBBSTwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEgbXQtMSB0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAiPjxpIGRhdGEtaWNvbj0iZG93bmxvYWQtc2ltcGxlIiBjbGFzcz0idy0zLjUgaC0zLjUiPjwvaT4nKyhsLnZpZXdzP2wudmlld3M6JzEySycpKycgZG93bmxvYWRzPC9kaXY+JwogICAgKyc8L2Rpdj48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImJvcmRlci10IGJkIG10LTIgcHQtMyI+JwogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQgbWItMiBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSI+PGkgZGF0YS1pY29uPSJ0YWciIGNsYXNzPSJ3LTQgaC00Ij48L2k+VmVyc2lvbiBEZXRhaWw8L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImdyaWQgZ3JpZC1jb2xzLTIgZ2FwLTIgdGV4dC14cyI+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiBib3JkZXIgYmQgcm91bmRlZC1sZyBweC0yIHB5LTEuNSI+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPkJhc2UgTW9kZWw8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPlogSW1hZ2U8L3NwYW4+PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiBib3JkZXIgYmQgcm91bmRlZC1sZyBweC0yIHB5LTEuNSI+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPlN0ZXBzPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4yNTAwPC9zcGFuPjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4gYm9yZGVyIGJkIHJvdW5kZWQtbGcgcHgtMiBweS0xLjUiPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj5FcG9jaDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+MTI8L3NwYW4+PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiBib3JkZXIgYmQgcm91bmRlZC1sZyBweC0yIHB5LTEuNSI+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPlRyaWdnZXIgV29yZHM8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtWyMyN0Q0Q0RdIj4nK2wudGFncy5zbGljZSgwLDIpLmpvaW4oJywgJykrJzwvc3Bhbj48L2Rpdj4nCiAgICArJzwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIG10LTMgbWItMSI+RGVzY3JpcHRpb248L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTQwMCBsZWFkaW5nLXJlbGF4ZWQiPicrbC50YWdzLmpvaW4oJywgJykrJyDigJQgTG9SQSB1bnR1ayBnYXlhIGRhbiBkZXRhaWwgdGFtYmFoYW4gZGkgWiBJbWFnZS48L2Rpdj4nOwogIG9wZW5Nb2RhbCgpOwp9CiQoJ21vZGVsLWluZm8nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oZSl7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IG9wZW5Mb3JhSW5mbyh7bmFtZTokKCdtb2RlbC1uYW1lJykudGV4dENvbnRlbnQsYmFkZ2U6J1ogSW1hZ2UnLHRodW1iOid6aW1hZ2UnLHRhZ3M6WydkZXRhaWwnLCdzaGFycCddfSk7IH0pOwokKCdtb2RhbC1jbG9zZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxjbG9zZU1vZGFsKTsKJCgnbW9kYWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oZSl7IGlmKGUudGFyZ2V0PT09JCgnbW9kYWwnKSkgY2xvc2VNb2RhbCgpOyB9KTsKJCgnYnRuLWFkZGxvcmEnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsb3BlbkxvcmFNb2RhbCk7CmRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2tleWRvd24nLGZ1bmN0aW9uKGUpeyBpZihlLmtleT09PSdFc2NhcGUnKSBjbG9zZU1vZGFsKCk7IH0pOwpmdW5jdGlvbiByZW5kZXJMb3JhKCl7CiAgdmFyIGxpc3QgPSAkKCdsb3JhLWxpc3QnKTsgbGlzdC5pbm5lckhUTUw9Jyc7CiAgaWYoIUxPUkEubGVuZ3RoKXsgbGlzdC5pbm5lckhUTUw9JzxkaXYgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTYwMCBib3JkZXIgYm9yZGVyLWRhc2hlZCBib3JkZXItWyMzMDM2M2RdIHJvdW5kZWQtbGcgcC0zIHRleHQtY2VudGVyIj5CZWx1bSBhZGEgTG9SQS4gS2xpayAiQWRkIExvUkEiLjwvZGl2Pic7IHJlbmRlclRyaWdnZXJzKCk7IHJldHVybjsgfQogIExPUkEuZm9yRWFjaChmdW5jdGlvbihsLHJpKXsKICAgIHZhciBkPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOwogICAgZC5jbGFzc05hbWU9J2xvcmEtY2FyZCc7CiAgICBkLmlubmVySFRNTD0nJwogICAgICArJzxzcGFuIGNsYXNzPSJsb3JhLWxhYmVsIj5Mb1JBIC0gJysobC5iYXNlfHwnWiBJbWFnZScpKyc8L3NwYW4+JwogICAgICArJzxkaXYgY2xhc3M9ImxvcmEtdG9wIj4nCiAgICAgICsnPGltZyBzcmM9IicrUytsLnRodW1iKycvNDAiIGNsYXNzPSJsb3JhLXRodW1iIiBhbHQ9IiIvPicKICAgICAgKyc8c3BhbiBjbGFzcz0ibG9yYS1uYW1lIj4nK2wubmFtZSsnPC9zcGFuPicKICAgICAgKyc8ZGl2IGNsYXNzPSJsb3JhLWljb25zIj4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibG9yYS1pY29uIiBkYXRhLWluZm89IicrcmkrJyIgdGl0bGU9IkluZm8iPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIi8+PGxpbmUgeDE9IjEyIiB5MT0iMTYiIHgyPSIxMiIgeTI9IjEyIi8+PGxpbmUgeDE9IjEyIiB5MT0iOCIgeDI9IjEyLjAxIiB5Mj0iOCIvPjwvc3ZnPjwvYnV0dG9uPicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJsb3JhLWljb24gZGVsIiBkYXRhLWRlbD0iJytyaSsnIiB0aXRsZT0iSGFwdXMiPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwb2x5bGluZSBwb2ludHM9IjMgNiA1IDYgMjEgNiIvPjxwYXRoIGQ9Ik0xOSA2djE0YTIgMiAwIDAgMS0yIDJIN2EyIDIgMCAwIDEtMi0yVjZtMyAwVjRhMiAyIDAgMCAxIDItMmg0YTIgMiAwIDAgMSAyIDJ2MiIvPjxsaW5lIHgxPSIxMCIgeTE9IjExIiB4Mj0iMTAiIHkyPSIxNyIvPjxsaW5lIHgxPSIxNCIgeTE9IjExIiB4Mj0iMTQiIHkyPSIxNyIvPjwvc3ZnPjwvYnV0dG9uPicKICAgICAgKyc8L2Rpdj4nCiAgICAgICsnPC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9ImxvcmEtc2xpZGVyLXJvdyI+JwogICAgICArJzxkaXYgY2xhc3M9Imwtc2xpZGVyIj48ZGl2IGNsYXNzPSJsLXRyYWNrIj48L2Rpdj48ZGl2IGNsYXNzPSJsLWZpbGwiIHN0eWxlPSJ3aWR0aDonKyhsLncvMioxMDApKyclIj48L2Rpdj48ZGl2IGNsYXNzPSJsLWhhbmRsZSIgc3R5bGU9ImxlZnQ6JysobC53LzIqMTAwKSsnJSI+PC9kaXY+PGlucHV0IHR5cGU9InJhbmdlIiBtaW49IjAiIG1heD0iMiIgc3RlcD0iMC4xIiB2YWx1ZT0iJytsLncrJyIgZGF0YS1yaT0iJytyaSsnIiBjbGFzcz0ibG9yYS1zbCIvPjwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJsLW51bSI+JwogICAgICArJzxidXR0b24gY2xhc3M9ImxvcmEtYnRuIiBkYXRhLWRlYz0iJytyaSsnIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48bGluZSB4MT0iNSIgeTE9IjEyIiB4Mj0iMTkiIHkyPSIxMiIvPjwvc3ZnPjwvYnV0dG9uPicKICAgICAgKyc8aW5wdXQgdHlwZT0idGV4dCIgdmFsdWU9IicrbC53LnRvRml4ZWQoMSkrJyIgY2xhc3M9ImxvcmEtaW5wdXQiIGRhdGEtcmk9IicrcmkrJyIgaW5wdXRtb2RlPSJkZWNpbWFsIi8+JwogICAgICArJzxidXR0b24gY2xhc3M9ImxvcmEtYnRuIiBkYXRhLWluYz0iJytyaSsnIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48bGluZSB4MT0iMTIiIHkxPSI1IiB4Mj0iMTIiIHkyPSIxOSIvPjxsaW5lIHgxPSI1IiB5MT0iMTIiIHgyPSIxOSIgeTI9IjEyIi8+PC9zdmc+PC9idXR0b24+JwogICAgICArJzwvZGl2PicKICAgICAgKyhsLm5lZWRVcmw/JzxkaXYgY2xhc3M9Im10LTIiPjxpbnB1dCB0eXBlPSJ0ZXh0IiBjbGFzcz0iaW5wIGxvcmEtdXJsLWlucCIgdmFsdWU9IicrKGwubG9yYVVybHx8JycpKyciIGRhdGEtdXJsPSInK3JpKyciIHBsYWNlaG9sZGVyPSJodHRwczovL2h1Z2dpbmdmYWNlLmNvL3VzZXIvcmVwby9yZXNvbHZlL21haW4vbG9yYS5zYWZldGVuc29ycyIvPjxkaXYgY2xhc3M9Im10LTEgdGV4dC1bMTBweF0gbGVhZGluZy1zbnVnIHRleHQtbmV1dHJhbC01MDAiPlVSTCBwdWJsaWsgbGFuZ3N1bmcgKC5zYWZldGVuc29ycykg4oCUIGNvbnRvaCBIdWdnaW5nRmFjZSByZXNvbHZlLiBLYWdnbGUgdGlkYWsgYmlzYSAoYnV0dWggbG9naW4pLjwvZGl2PjwvZGl2Pic6JycpCiAgICAgICsnPC9kaXY+JzsKICAgIHZhciBzbD1kLnF1ZXJ5U2VsZWN0b3IoJy5sLXNsaWRlciBbZGF0YS1yaT0iJytyaSsnIl0nKTsKICAgIHZhciB1SW5wPWQucXVlcnlTZWxlY3RvcignW2RhdGEtdXJsPSInK3JpKyciXScpOwogICAgaWYodUlucCl7IHVJbnAuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpeyBMT1JBW3JpXS5sb3JhVXJsPWUudGFyZ2V0LnZhbHVlLnRyaW0oKTsgfSk7IH0KICAgIHNsLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbihlKXsKICAgICAgdmFyIHY9cGFyc2VGbG9hdChlLnRhcmdldC52YWx1ZSk7IGlmKGlzTmFOKHYpKXJldHVybjsKICAgICAgTE9SQVtyaV0udz12OwogICAgICB2YXIgcGN0PSh2LzIqMTAwKTsKICAgICAgZC5xdWVyeVNlbGVjdG9yKCcubC1maWxsJykuc3R5bGUud2lkdGg9cGN0KyclJzsKICAgICAgZC5xdWVyeVNlbGVjdG9yKCcubC1oYW5kbGUnKS5zdHlsZS5sZWZ0PXBjdCsnJSc7CiAgICAgIGQucXVlcnlTZWxlY3RvcignLmxvcmEtaW5wdXQnKS52YWx1ZT12LnRvRml4ZWQoMSk7CiAgICAgIHJlbmRlclRyaWdnZXJzKCk7CiAgICB9KTsKICAgIGQucXVlcnlTZWxlY3RvcignLmwtbnVtIFtkYXRhLWluYz0iJytyaSsnIl0nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgc2V0TFcocmksKyhMT1JBW3JpXS53KzAuMSkudG9GaXhlZCgxKSk7IHJlbmRlckxvcmEoKTsgfSk7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5sLW51bSBbZGF0YS1kZWM9IicrcmkrJyJdJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IHNldExXKHJpLCsoTE9SQVtyaV0udy0wLjEpLnRvRml4ZWQoMSkpOyByZW5kZXJMb3JhKCk7IH0pOwogICAgZC5xdWVyeVNlbGVjdG9yKCdbZGF0YS1kZWw9IicrcmkrJyJdJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IExPUkEuc3BsaWNlKHJpLDEpOyByZW5kZXJMb3JhKCk7IHJlbmRlclRyaWdnZXJzKCk7IH0pOwogICAgZC5xdWVyeVNlbGVjdG9yKCdbZGF0YS1pbmZvPSInK3JpKyciXScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBvcGVuTG9yYUluZm8obCk7IH0pOwogICAgbGlzdC5hcHBlbmRDaGlsZChkKTsKICB9KTsKICByZW5kZXJUcmlnZ2VycygpOwp9CmZ1bmN0aW9uIHNldExXKGksdil7IExPUkFbaV0udz1NYXRoLm1heCgwLE1hdGgubWluKDIsdikpOyB9CnZhciBfcGVuZGluZ1RyaWcgPSBbXTsKZnVuY3Rpb24gcmVuZGVyVHJpZ2dlcnMoKXsKICB2YXIgcD0oJCgncHJvbXB0JykudmFsdWV8fCcnKS50b0xvd2VyQ2FzZSgpOwogIHZhciB0PSQoJ3RyaWdnZXJzJyk7IHQuaW5uZXJIVE1MPScnOwogIF9wZW5kaW5nVHJpZz1bXTsKICBMT1JBLmZpbHRlcihmdW5jdGlvbihsKXtyZXR1cm4gbC53PjB9KS5mb3JFYWNoKGZ1bmN0aW9uKGwpewogICAgbC50YWdzLmZvckVhY2goZnVuY3Rpb24odyl7IGlmKHAuaW5kZXhPZih3LnRvTG93ZXJDYXNlKCkpPDApIF9wZW5kaW5nVHJpZy5wdXNoKHt3b3JkOncsbG9yYTpsLm5hbWV9KTsgfSk7CiAgfSk7CiAgJCgndHItY291bnQnKS50ZXh0Q29udGVudD1fcGVuZGluZ1RyaWcubGVuZ3RoOwogIGlmKCFfcGVuZGluZ1RyaWcubGVuZ3RoKXsgdC5pbm5lckhUTUw9JzxzcGFuIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC02MDAiPlRpZGFrIGFkYSB0cmlnZ2VyIHdvcmQgdGVyc2lzYTwvc3Bhbj4nOyByZXR1cm47IH0KICBfcGVuZGluZ1RyaWcuZm9yRWFjaChmdW5jdGlvbihpdGVtKXsKICAgIHZhciBiPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2J1dHRvbicpOwogICAgYi5jbGFzc05hbWU9J3RhZyBjdXJzb3ItcG9pbnRlciBob3Zlcjpib3JkZXItWyMyN0Q0Q0RdIGhvdmVyOnRleHQtWyMyN0Q0Q0RdIHRyYW5zaXRpb24nOwogICAgYi5pbm5lckhUTUw9JzxpIGRhdGEtaWNvbj0ic3BhcmtsZSIgY2xhc3M9InctMyBoLTMgdGV4dC1bIzI3RDRDRF0iPjwvaT4nK2l0ZW0ud29yZDsKICAgIGIudGl0bGU9J1RhbWJhaGthbiBrZSBwcm9tcHQgKCcraXRlbS5sb3JhKycpJzsKICAgIGIuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgICAgIGFkZFdvcmQoaXRlbS53b3JkKTsKICAgICAgcmVuZGVyVHJpZ2dlcnMoKTsKICAgIH0pOwogICAgdC5hcHBlbmRDaGlsZChiKTsKICB9KTsKfQpmdW5jdGlvbiBhZGRXb3JkKHcpewogIHZhciBwcj0kKCdwcm9tcHQnKSwgY3Y9cHIudmFsdWUudHJpbSgpOwogIGlmKGN2ICYmICFjdi5lbmRzV2l0aCgnLCcpKSBjdis9JywnOwogIHByLnZhbHVlPWN2K3crJywnOwogIHByLmZvY3VzKCk7Cn0KZnVuY3Rpb24gYWRkQWxsVHJpZygpewogIHZhciBhbGw9X3BlbmRpbmdUcmlnLm1hcChmdW5jdGlvbih4KXtyZXR1cm4geC53b3JkfSk7CiAgYWxsLmZvckVhY2goYWRkV29yZCk7CiAgcmVuZGVyVHJpZ2dlcnMoKTsKfQokKCdhZGRhbGwtdHJpZycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxhZGRBbGxUcmlnKTsKCi8qID09PT09IGFzcGVjdCByYXRpbyA9PT09PSAqLwp2YXIgQVJfTUFQID0gewogIHBvcnRyYWl0OlsnUG9ydHJhaXQnLDc2OCwxMTUyXSwKICBsYW5kc2NhcGU6WydMYW5kc2NhcGUnLDExNTIsNzY4XSwKICBzcXVhcmU6WydTcXVhcmUnLDEwMjQsMTAyNF0sCiAgY3VzdG9tOlsnY3VzdG9tJyxudWxsLG51bGxdCn07CmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5hcicpLmZvckVhY2goZnVuY3Rpb24oYil7CiAgYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgIHZhciBhcj1iLmRhdGFzZXQuYXI7IHN0YXRlLmFzcGVjdD1hcjsKICAgIHNldEFyQWN0aXZlKGFyKTsKICAgIGlmKGFyIT09J2N1c3RvbScpeyAkKCd3aWR0aCcpLnZhbHVlPUFSX01BUFthcl1bMV07ICQoJ2hlaWdodCcpLnZhbHVlPUFSX01BUFthcl1bMl07IH0KICAgIHVwZFdIKCk7CiAgfSk7Cn0pOwpmdW5jdGlvbiB1cGRXSCgpeyAkKCd3dicpLnZhbHVlPSQoJ3dpZHRoJykudmFsdWU7ICQoJ2h2JykudmFsdWU9JCgnaGVpZ2h0JykudmFsdWU7IH0KJCgnd2lkdGgnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oKXsgJCgnd3YnKS52YWx1ZT0kKCd3aWR0aCcpLnZhbHVlOyBzdGF0ZS5hc3BlY3Q9J2N1c3RvbSc7IHNldEFyQWN0aXZlKCdjdXN0b20nKTsgfSk7CiQoJ2hlaWdodCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbigpeyAkKCdodicpLnZhbHVlPSQoJ2hlaWdodCcpLnZhbHVlOyBzdGF0ZS5hc3BlY3Q9J2N1c3RvbSc7IHNldEFyQWN0aXZlKCdjdXN0b20nKTsgfSk7CiQoJ3d2JykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbigpeyB2YXIgdj1NYXRoLm1heCgyNTYsTWF0aC5taW4oMTUzNixwYXJzZUludCgkKCd3dicpLnZhbHVlKXx8NzY4KSk7IHY9TWF0aC5yb3VuZCh2LzY0KSo2NDsgJCgnd3YnKS52YWx1ZT12OyAkKCd3aWR0aCcpLnZhbHVlPXY7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsKJCgnaHYnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLGZ1bmN0aW9uKCl7IHZhciB2PU1hdGgubWF4KDI1NixNYXRoLm1pbigxNTM2LHBhcnNlSW50KCQoJ2h2JykudmFsdWUpfHwxMTUyKSk7IHY9TWF0aC5yb3VuZCh2LzY0KSo2NDsgJCgnaHYnKS52YWx1ZT12OyAkKCdoZWlnaHQnKS52YWx1ZT12OyBzdGF0ZS5hc3BlY3Q9J2N1c3RvbSc7IHNldEFyQWN0aXZlKCdjdXN0b20nKTsgfSk7CmZ1bmN0aW9uIHNldEFyQWN0aXZlKGFyKXsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcuYXInKS5mb3JFYWNoKGZ1bmN0aW9uKHgpe3guY2xhc3NMaXN0LnRvZ2dsZSgnc2VsJywgeC5kYXRhc2V0LmFyPT09YXIpfSk7CiAgJCgnYXItbGFiZWwnKS50ZXh0Q29udGVudD1BUl9NQVBbYXJdWzBdOwp9CiQoJ3N0ZXBzJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpeyQoJ3N2JykudGV4dENvbnRlbnQ9ZS50YXJnZXQudmFsdWV9KTsKJCgnY2ZnJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpeyQoJ2NmdicpLnRleHRDb250ZW50PWUudGFyZ2V0LnZhbHVlfSk7CiQoJ2NsaXBza2lwJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpeyQoJ2NzdicpLnRleHRDb250ZW50PWUudGFyZ2V0LnZhbHVlfSk7CiQoJ2V0YW5zZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbihlKXskKCdlbnNkJykudGV4dENvbnRlbnQ9ZS50YXJnZXQudmFsdWV9KTsKJCgnYWR2LXRvZ2dsZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyQoJ2Fkdi1maWVsZHMnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nKX0pOwokKCdkaWNlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7JCgnc2VlZCcpLnZhbHVlPVN0cmluZyhNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkqOTk5OTk5OTk5OTk5OTk5OSkpfSk7CiQoJ25lZ2NoZWNrJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbihlKXskKCduZWd3cmFwJykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJywhZS50YXJnZXQuY2hlY2tlZCl9KTsKJCgncHJvbXB0JykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLHJlbmRlclRyaWdnZXJzKTsKLyogVHJhbnNsYXRlOiBzZW11YSBiYWhhc2EgLT4gSW5nZ3JpcyAoYmFja2VuZCAvYXBpL3RyYW5zbGF0ZSwgZ3JhdGlzKSAqLwpmdW5jdGlvbiBzZXRUcmFuc2xhdGVCdXN5KGIpewogIHZhciBlbD0kKCdidG4tdHJhbnNsYXRlJyk7CiAgZWwuaW5uZXJIVE1MPWI/JzxpIGRhdGEtaWNvbj0iY2lyY2xlLW5vdGNoIiBjbGFzcz0idy00IGgtNCBhbmltYXRlLXNwaW4iPjwvaT4nOic8aSBkYXRhLWljb249InRyYW5zbGF0ZSIgY2xhc3M9InctNCBoLTQiPjwvaT4nOwp9CiQoJ2J0bi10cmFuc2xhdGUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICB2YXIgcD0oJCgncHJvbXB0JykudmFsdWV8fCcnKS50cmltKCk7CiAgaWYoIXApeyAkKCdwcm9tcHQnKS5mb2N1cygpOyByZXR1cm47IH0KICBzZXRUcmFuc2xhdGVCdXN5KHRydWUpOwogIGZldGNoKCcvYXBpL3RyYW5zbGF0ZT9xPScrZW5jb2RlVVJJQ29tcG9uZW50KHApKS50aGVuKGZ1bmN0aW9uKHIpeyByZXR1cm4gci5qc29uKCk7IH0pLnRoZW4oZnVuY3Rpb24oZCl7CiAgICBpZihkLm9rJiZkLnRleHQpeyAkKCdwcm9tcHQnKS52YWx1ZT1kLnRleHQ7IHJlbmRlclRyaWdnZXJzKCk7IHRvYXN0KCdEaXRlcmplbWFoa2FuIGtlIEluZ2dyaXMg4pyTJyk7IH0KICAgIGVsc2UgdG9hc3QoZC5lcnJvcnx8J0dhZ2FsIG1lbmVyamVtYWhrYW4nKTsKICB9KS5jYXRjaChmdW5jdGlvbigpeyB0b2FzdCgnR2FnYWwgbWVuZXJqZW1haGthbicpOyB9KS5maW5hbGx5KGZ1bmN0aW9uKCl7IHNldFRyYW5zbGF0ZUJ1c3koZmFsc2UpOyB9KTsKfSk7Ci8qIFByb21wdCBFbmhhbmNlIChzZXBlcnRpIFRlbnNvci5BcnQpOiBoYXNpbCByZWZpbmUgdGFtcGlsIGRpIHBvcHVwIHVudHVrCiAgIGRpa29uZmlybWFzaS9kaWVkaXQgc2ViZWx1bSBkaXBha2FpLiBCYWNrZW5kIC9hcGkvcmVmaW5lIChMTE0gUG9sbGluYXRpb25zKSwKICAgZmFsbGJhY2sgdGVtcGxhdGUgbG9rYWwga2FsYXUgdGFucGEga2V5LiAqLwp2YXIgX2VuaE9yaWc9Jyc7CmZ1bmN0aW9uIGZhbGxiYWNrRW5oYW5jZShwKXsKICByZXR1cm4gcAogICAgKydcblxuRW5oYW5jZSBkZXRhaWwsIGxpZ2h0aW5nLCBjb21wb3NpdGlvbiwgYW5kIGF0bW9zcGhlcmUuICcKICAgICsnVWx0cmEtZGV0YWlsZWQsIHByb2Zlc3Npb25hbCBwaG90b2dyYXBoeSwgc2hhcnAgZm9jdXMsIGNpbmVtYXRpYyBsaWdodGluZy4nOwp9CmZ1bmN0aW9uIG9wZW5FbmhNb2RhbChwKXsKICBfZW5oT3JpZz1wOwogICQoJ2VuaC1vcmlnJykudGV4dENvbnRlbnQ9cDsKICAkKCdlbmgtdGV4dCcpLnZhbHVlPScnOwogICQoJ2VuaC1tb2RhbCcpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyAkKCdlbmgtbW9kYWwnKS5jbGFzc0xpc3QuYWRkKCdmbGV4Jyk7Cn0KZnVuY3Rpb24gY2xvc2VFbmhNb2RhbCgpeyAkKCdlbmgtbW9kYWwnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgnZW5oLW1vZGFsJykuY2xhc3NMaXN0LnJlbW92ZSgnZmxleCcpOyB9CmZ1bmN0aW9uIGRvRW5oYW5jZSgpewogIHZhciBwPSgkKCdwcm9tcHQnKS52YWx1ZXx8JycpLnRyaW0oKTsKICBpZighcCl7ICQoJ3Byb21wdCcpLmZvY3VzKCk7IHJldHVybjsgfQogIG9wZW5FbmhNb2RhbChwKTsKICAkKCdlbmgtdGV4dCcpLnZhbHVlPSdNZW5naGFzaWxrYW4gcHJvbXB0IHlhbmcgbGViaWggYmFpay4uLic7CiAgdmFyIGI9JCgnZW5oLXJlZ2VuJyk7IGIuZGlzYWJsZWQ9dHJ1ZTsgYi5zdHlsZS5vcGFjaXR5PScwLjUnOwogIGZldGNoKCcvYXBpL3JlZmluZScse21ldGhvZDonUE9TVCcsaGVhZGVyczpfYXBpSGVhZGVycyh7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nfSksYm9keTpKU09OLnN0cmluZ2lmeSh7cHJvbXB0OnB9KX0pCiAgICAudGhlbihmdW5jdGlvbihyKXsgcmV0dXJuIHIuanNvbigpOyB9KQogICAgLnRoZW4oZnVuY3Rpb24oZCl7CiAgICAgICQoJ2VuaC10ZXh0JykudmFsdWU9KGQub2smJmQudGV4dCk/ZC50ZXh0OmZhbGxiYWNrRW5oYW5jZShwKTsKICAgICAgaWYoIWQub2spIHRvYXN0KCdSZWZpbmUgb2ZmbGluZSDigJQgcGFrYWkgdGVtcGxhdGUgbG9rYWwnKTsKICAgIH0pCiAgICAuY2F0Y2goZnVuY3Rpb24oKXsgJCgnZW5oLXRleHQnKS52YWx1ZT1mYWxsYmFja0VuaGFuY2UocCk7IHRvYXN0KCdSZWZpbmUgb2ZmbGluZSDigJQgcGFrYWkgdGVtcGxhdGUgbG9rYWwnKTsgfSkKICAgIC5maW5hbGx5KGZ1bmN0aW9uKCl7IGIuZGlzYWJsZWQ9ZmFsc2U7IGIuc3R5bGUub3BhY2l0eT0nJzsgfSk7Cn0KJCgnYnRuLWVuaGFuY2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZG9FbmhhbmNlKTsKJCgnZW5oLWNsb3NlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGNsb3NlRW5oTW9kYWwpOwokKCdlbmgtY2FuY2VsJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGNsb3NlRW5oTW9kYWwpOwokKCdlbmgtbW9kYWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oZSl7IGlmKGUudGFyZ2V0PT09JCgnZW5oLW1vZGFsJykpIGNsb3NlRW5oTW9kYWwoKTsgfSk7CiQoJ2VuaC1yZWdlbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICQoJ3Byb21wdCcpLnZhbHVlPSgkKCdlbmgtdGV4dCcpLnZhbHVlfHwnJykudHJpbSgpfHxfZW5oT3JpZzsKICByZW5kZXJUcmlnZ2VycygpOwogIGRvRW5oYW5jZSgpOwp9KTsKJCgnZW5oLXVzZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogIHZhciB2PSgkKCdlbmgtdGV4dCcpLnZhbHVlfHwnJykudHJpbSgpOwogIGlmKCF2KSByZXR1cm47CiAgJCgncHJvbXB0JykudmFsdWU9djsgcmVuZGVyVHJpZ2dlcnMoKTsgY2xvc2VFbmhNb2RhbCgpOyB0b2FzdCgnUHJvbXB0IEVuaGFuY2UgZGl0ZXJhcGthbiDinJMnKTsKfSk7CmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5jaGlwJykuZm9yRWFjaChmdW5jdGlvbihjKXsKICBjLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpe2MuY2xhc3NMaXN0LnRvZ2dsZSgnb24nKX0pOwp9KTsKCi8qID09PT09IHRhYnMgPT09PT0gKi8KZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnRhYicpLmZvckVhY2goZnVuY3Rpb24odCl7CiAgdC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50YWInKS5mb3JFYWNoKGZ1bmN0aW9uKHgpe3guY2xhc3NMaXN0LnJlbW92ZSgnc2VsJyl9KTsKICAgIHQuY2xhc3NMaXN0LmFkZCgnc2VsJyk7IHN0YXRlLnBhZ2U9dC5kYXRhc2V0LnRhYjsKICAgIHJlbmRlckNhbnZhcygpOwogIH0pOwp9KTsKZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnJ0YWInKS5mb3JFYWNoKGZ1bmN0aW9uKHQpewogIHQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucnRhYicpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QucmVtb3ZlKCdzZWwnKX0pOwogICAgdC5jbGFzc0xpc3QuYWRkKCdzZWwnKTsKICAgIHZhciBwPXQuZGF0YXNldC5wOyAvLyBkZXRhaWwgfCBoaXN0b3J5CiAgICAkKCdyZGV0YWlsJykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJyxwIT09J2RldGFpbCcpOwogICAgJCgncmhpc3RvcnknKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLHAhPT0naGlzdG9yeScpOwogIH0pOwp9KTsKLyogRmlsdGVyIGdhbGVyaSAoQWxsL1ZpZGVvL0ltYWdlL0F1ZGlvKSDigJQgc2VwZXJ0aSBUZW5zb3IuQXJ0ICovCmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5nZmlsJykuZm9yRWFjaChmdW5jdGlvbihmKXsKICBmLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmdmaWwnKS5mb3JFYWNoKGZ1bmN0aW9uKHgpe3guY2xhc3NMaXN0LnJlbW92ZSgnc2VsJyl9KTsKICAgIGYuY2xhc3NMaXN0LmFkZCgnc2VsJyk7CiAgICB2YXIgdD1mLmRhdGFzZXQuZjsgLy8gYWxsIHwgdmlkZW8gfCBpbWFnZSB8IGF1ZGlvCiAgICBBcnJheS5wcm90b3R5cGUuZm9yRWFjaC5jYWxsKGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJyNncmlkID4gZGl2JyksZnVuY3Rpb24ocm93KXsKICAgICAgcm93LnN0eWxlLmRpc3BsYXk9KHQ9PT0nYWxsJ3x8dD09PSdpbWFnZScpPycnOidub25lJzsKICAgIH0pOwogIH0pOwp9KTsKCi8qID09PT09IG1vYmlsZSBkcmF3ZXIgPT09PT0gKi8KJCgnbW1lbnUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgb3BlbkxlZnQoKTsgfSk7CiQoJ292ZXJsYXknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgY2xvc2VMZWZ0KCk7IH0pOwpmdW5jdGlvbiBvcGVuTGVmdCgpeyAkKCdvdmVybGF5JykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ2xlZnRwYW4nKS5jbGFzc0xpc3QucmVtb3ZlKCctdHJhbnNsYXRlLXgtZnVsbCcpOyB9CmZ1bmN0aW9uIGNsb3NlTGVmdCgpeyAkKCdvdmVybGF5JykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7IGlmKHdpbmRvdy5pbm5lcldpZHRoPDEwMjQpICQoJ2xlZnRwYW4nKS5jbGFzc0xpc3QuYWRkKCctdHJhbnNsYXRlLXgtZnVsbCcpOyB9CgovKiA9PT09PSBpbWFnZSBjb3VudCAoZHJvcGRvd24gZGkgcHJvbXB0IGJhciArIHRvbWJvbCBuYXZiYXIpID09PT09ICovCmZ1bmN0aW9uIGFwcGx5TmNvbCgpewogIHZhciBzZWw9JCgnbmNvdW50Jyk7IGlmKHNlbCkgc2VsLnZhbHVlPVN0cmluZyhzdGF0ZS5uY29sKTsKICAvLyBUYW1waWxhbiB0ZW5nYWggc2VsYWx1IDEgZ2FtYmFyIHNlc3VhaSBhc3BlY3QgcmF0aW8gKHNlcGVydGkgVGVuc29yLkFydCkuCiAgLy8gbmNvbCBoYW55YSBtZW5lbnR1a2FuIGp1bWxhaCBnYW1iYXIgcGVyIGdlbmVyYXRlIChpbWFnZUNvdW50KS4KICAkKCduY29sbGJsJykudGV4dENvbnRlbnQ9U3RyaW5nKHN0YXRlLm5jb2wpOwogIHJlbmRlckdyaWQoKTsKfQokKCduY29sJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgc3RhdGUubmNvbCA9IHN0YXRlLm5jb2w9PT0yPzE6MjsKICBhcHBseU5jb2woKTsKfSk7CiQoJ25jb3VudCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsZnVuY3Rpb24oKXsKICBzdGF0ZS5uY29sPXBhcnNlSW50KCQoJ25jb3VudCcpLnZhbHVlKXx8MTsKICBhcHBseU5jb2woKTsKfSk7CgovKiA9PT09PSBnZW5lcmF0ZSAocmVhbCBBUEkgLyBkZW1vIGZhbGxiYWNrKSA9PT09PSAqLwokKCdidG4tZ28nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZG9HZW5lcmF0ZSk7CmZ1bmN0aW9uIHNldEJ1c3koYil7CiAgdmFyIGVsPSQoJ2J0bi1nbycpOyBpZighZWwpIHJldHVybjsKICBlbC5kaXNhYmxlZD1iOyBlbC5zdHlsZS5vcGFjaXR5PWI/JzAuNSc6JzEnOwogIGVsLmlubmVySFRNTD1iPyc8aSBkYXRhLWljb249ImNpcmNsZS1ub3RjaCIgY2xhc3M9InctNCBoLTQgYW5pbWF0ZS1zcGluIj48L2k+R2VuZXJhdGluZy4uLicKICAgIDonPGkgZGF0YS1pY29uPSJsaWdodG5pbmciIGNsYXNzPSJ3LTQgaC00Ij48L2k+R2VuZXJhdGUgPHNwYW4gY2xhc3M9InRleHQteHMgb3BhY2l0eS05MCBmb250LW5vcm1hbCIgaWQ9InByaWNlIj4tIDEuMjI8L3NwYW4+JzsKfQpmdW5jdGlvbiBleHRyYWN0SW1hZ2VzKGRhdGEpewogIGlmKCFkYXRhKSByZXR1cm4gW107CiAgaWYoQXJyYXkuaXNBcnJheShkYXRhKSkgZGF0YT17aW1hZ2VzOmRhdGF9OwogIHZhciBpbWdzPWRhdGEuaW1hZ2VzfHxkYXRhLmRhdGEmJmRhdGEuZGF0YS5pbWFnZXN8fGRhdGEucmVzdWx0JiZkYXRhLnJlc3VsdC5pbWFnZXN8fGRhdGEudXJsc3x8W107CiAgcmV0dXJuIGltZ3MubWFwKGZ1bmN0aW9uKGkpeyByZXR1cm4gdHlwZW9mIGk9PT0nc3RyaW5nJz9pOihpLnVybHx8aS5zcmN8fGkuaW1hZ2V8fGkucGF0aCk7IH0pLmZpbHRlcihCb29sZWFuKTsKfQovKiA9PT09PSBoYXNpbCArIHJpd2F5YXQgKHBlcnNpc3QgbG9jYWxTdG9yYWdlKSA9PT09PSAqLwpmdW5jdGlvbiBwZXJzaXN0UmVzdWx0cygpewogIHRyeXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oUkVTVUxUU19LRVksSlNPTi5zdHJpbmdpZnkoc3RhdGUucmVzdWx0cy5zbGljZSgwLDYwKSkpOyB9Y2F0Y2goZSl7fQp9Ci8qIFRhbXBpbGFuIHRlbmdhaDogZ2FsZXJpIHNlbXVhIGhhc2lsIG1lbnVtcHVrIGtlIGJhd2FoIChzZXBlcnRpIFRlbnNvci5BcnQpLAogICB0aWFwIGJhcmlzID0gZ2FtYmFyICsgZGV0YWlsIGRpIGthbmFubnlhLiBTY3JvbGwga2UgYmF3YWggbXVuY3VsIHNlbXVhLiAqLwp2YXIgX3ZpZXdJZHg9MDsgLy8gaW5kZXgga2Ugc3RhdGUucmVzdWx0cyAoMCA9IHRlcmJhcnUpCmZ1bmN0aW9uIG1ha2VHYWxsZXJ5Um93KHIsaSl7CiAgdmFyIHJvdz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICByb3cuY2xhc3NOYW1lPSdmbGV4IGdhcC00IGJvcmRlciBiZCByb3VuZGVkLTJ4bCBiZy1bIzE2MWIyMl0gcC0zJzsKICB2YXIgaW1nV3JhcD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsKICBpbWdXcmFwLmNsYXNzTmFtZT0nc2hyaW5rLTAgdy1bNDIlXSBzbTp3LVszNCVdIHNlbGYtc3RyZXRjaCBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBiZy1ibGFjay8zMCByb3VuZGVkLXhsIG92ZXJmbG93LWhpZGRlbic7CiAgdmFyIGltZz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdpbWcnKTsKICBpbWcuc3JjPXIuc3JjOwogIGltZy5jbGFzc05hbWU9J3ctZnVsbCBoLWZ1bGwgbWF4LWgtWzc1dmhdIG9iamVjdC1jb250YWluIGN1cnNvci16b29tLWluJzsKICBpbWcuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IG9wZW5MaWdodGJveChyKTsgfSk7CiAgaW1nV3JhcC5hcHBlbmRDaGlsZChpbWcpOwogIGlmKHIuZGVtbyl7CiAgICB2YXIgYmQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc3BhbicpOwogICAgYmQuY2xhc3NOYW1lPSdhYnNvbHV0ZSB0b3AtMiBsZWZ0LTIgdGV4dC1bOXB4XSBiZy1ibGFjay82MCBweC0xLjUgcHktMC41IHJvdW5kZWQgdGV4dC1uZXV0cmFsLTMwMCc7CiAgICBiZC50ZXh0Q29udGVudD0nREVNTyc7IGltZ1dyYXAuYXBwZW5kQ2hpbGQoYmQpOwogIH0KICByb3cuYXBwZW5kQ2hpbGQoaW1nV3JhcCk7CiAgdmFyIG1ldGE9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7CiAgbWV0YS5jbGFzc05hbWU9J2ZsZXgtMSBtaW4tdy0wIHNlbGYtc3RyZXRjaCB0ZXh0LXhzIHNwYWNlLXktMS41IHRleHQtbmV1dHJhbC00MDAnOwogIHZhciBsYmw9ci5kZW1vPydEZW1vIChzaW11bGFzaSknOihyLnBhZ2U9PT0naW1nJz8nSW1hZ2UgdG8gSW1hZ2UnOidUZXh0IHRvIEltYWdlJyk7CiAgdmFyIGV4cGlyZXM9ci50cz9uZXcgRGF0ZShyLnRzKzcqMjQqMzYwMCoxMDAwKS50b0xvY2FsZVN0cmluZygnaWQtSUQnKTonJzsKICB2YXIgaD0nJzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSI+PGkgZGF0YS1pY29uPSJzcGFya2xlIiBjbGFzcz0idy0zIGgtMyB0ZXh0LXZpb2xldC00MDAiPjwvaT48c3BhbiBjbGFzcz0iYmctdmlvbGV0LTUwMC8xMCB0ZXh0LXZpb2xldC0zMDAgcHgtMS41IHB5LXB4IHJvdW5kZWQgdGV4dC1bMTBweF0iPicrbGJsKyc8L3NwYW4+JzsKICBoKz0nPHNwYW4gY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAgdHJ1bmNhdGUiPicrKHIubW9kZWx8fCcnKSsnPC9zcGFuPjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9ImJnLWJsYWNrLzQwIHJvdW5kZWQtbGcgcC0yIHRleHQtWzExcHhdIHRleHQtbmV1dHJhbC0zMDAgbGVhZGluZy1zbnVnIGN1cnNvci1wb2ludGVyIGhvdmVyOnRleHQtd2hpdGUiIHRpdGxlPSJMaWhhdCBkZXRhaWwiPicrKHIucHJvbXB0fHwnJykuc2xpY2UoMCwxNjApKyc8L2Rpdj4nOwogIGgrPSc8ZGl2IGNsYXNzPSJzcGFjZS15LTEgdGV4dC1bMTBweF0iPic7CiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5UYXNrIElEPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIHRydW5jYXRlIG1heC13LVs2NSVdIiB0aXRsZT0iJytlc2Moci50YXNrSWQpKyciPicrZXNjKHIudGFza0lkfHwnLScpKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNyZWRpdHM8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrKHIuY3JlZGl0c3x8Jy0nKSsnPC9zcGFuPjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DcmVhdGVkPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK2ZtdERhdGVUaW1lKHIudHMpKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkV4cGlyZXM8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrZXhwaXJlcysnPC9zcGFuPjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TaXplPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK3Iuc2l6ZSsnPC9zcGFuPjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TZWVkPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK3Iuc2VlZCsnPC9zcGFuPjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TdGVwczwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+Jysoci5zdGVwcyE9bnVsbCYmci5zdGVwcyE9PScnP3Iuc3RlcHM6Jy0nKSsnPC9zcGFuPjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DRkc8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrKHIuY2ZnIT1udWxsJiZyLmNmZyE9PScnP3IuY2ZnOictJykrJzwvc3Bhbj48L2Rpdj4nOwogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2FtcGxlcjwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+Jysoci5zYW1wbGVyfHwnLScpKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPC9kaXY+JzsKICBtZXRhLmlubmVySFRNTD1oOwogIG1ldGEucXVlcnlTZWxlY3RvcignZGl2W3RpdGxlPSJMaWhhdCBkZXRhaWwiXScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBfdmlld0lkeD1pOyByZW5kZXJHcmlkKCk7IHJlbmRlckRldGFpbCgpOyB9KTsKICByb3cuYXBwZW5kQ2hpbGQobWV0YSk7CiAgcmV0dXJuIHJvdzsKfQpmdW5jdGlvbiByZW5kZXJHcmlkKCl7CiAgdmFyIGdyaWQ9JCgnZ3JpZCcpOyBncmlkLmlubmVySFRNTD0nJzsKICB2YXIgZmlsPSQoJ2dmaWx0ZXInKTsKICBpZighc3RhdGUucmVzdWx0cy5sZW5ndGgpeyAkKCdlbXB0eScpLnN0eWxlLmRpc3BsYXk9Jyc7IGlmKGZpbCkgZmlsLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyByZXR1cm47IH0KICAkKCdlbXB0eScpLnN0eWxlLmRpc3BsYXk9J25vbmUnOwogIGlmKGZpbCkgZmlsLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOwogIGlmKF92aWV3SWR4Pj1zdGF0ZS5yZXN1bHRzLmxlbmd0aCkgX3ZpZXdJZHg9c3RhdGUucmVzdWx0cy5sZW5ndGgtMTsKICB2YXIgYXJyPXN0YXRlLnJlc3VsdHMuc2xpY2UoKTsgLy8gdGVyYmFydSBkdWx1YW4gKGluZGV4IDApCiAgYXJyLmZvckVhY2goZnVuY3Rpb24ocixpKXsgZ3JpZC5hcHBlbmRDaGlsZChtYWtlR2FsbGVyeVJvdyhyLGkpKTsgfSk7Cn0KZnVuY3Rpb24gYWRkUmVzdWx0KHIpewogIHN0YXRlLnJlc3VsdHMudW5zaGlmdChyKTsKICBpZihzdGF0ZS5yZXN1bHRzLmxlbmd0aD42MCkgc3RhdGUucmVzdWx0cy5sZW5ndGg9NjA7CiAgX3ZpZXdJZHg9MDsgLy8gdGFtcGlsa2FuIGhhc2lsIHRlcmJhcnUKICBwZXJzaXN0UmVzdWx0cygpOwogIHJlbmRlckdyaWQoKTsKICByZW5kZXJEZXRhaWwoKTsKICByZW5kZXJSaWdodCgpOwp9CgovKiA9PT09PSBwYW5lbCBrYW5hbjogRGV0YWlsIGhhc2lsIGFrdGlmIChzZXBlcnRpIFRlbnNvci5BcnQpID09PT09ICovCmZ1bmN0aW9uIGZtdERhdGUodHMpeyB0cnl7IHJldHVybiBuZXcgRGF0ZSh0cykudG9Mb2NhbGVEYXRlU3RyaW5nKCdpZC1JRCcpOyB9Y2F0Y2goZSl7IHJldHVybiAnJzsgfSB9CmZ1bmN0aW9uIGZtdERhdGVUaW1lKHRzKXsgdHJ5eyByZXR1cm4gbmV3IERhdGUodHMpLnRvTG9jYWxlU3RyaW5nKCdpZC1JRCcpOyB9Y2F0Y2goZSl7IHJldHVybiAnJzsgfSB9CmZ1bmN0aW9uIGNvcHlUZXh0KHYpewogIGlmKCF2KSByZXR1cm47CiAgaWYobmF2aWdhdG9yLmNsaXBib2FyZCYmbmF2aWdhdG9yLmNsaXBib2FyZC53cml0ZVRleHQpeyBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dCh2KS50aGVuKGZ1bmN0aW9uKCl7IHRvYXN0KCdUZXJzYWxpbiDinJMnKTsgfSk7IH0KICBlbHNlIHRvYXN0KCdUYXNrIElEOiAnK3YpOwp9CmZ1bmN0aW9uIHJlbmRlckRldGFpbCgpewogIHZhciBlbD0kKCdyZGV0YWlsJyk7IGlmKCFlbCkgcmV0dXJuOwogIGlmKCFzdGF0ZS5yZXN1bHRzLmxlbmd0aCl7IGVsLmlubmVySFRNTD0nPHAgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBwLTQgdGV4dC1jZW50ZXIiPkJlbHVtIGFkYSBoYXNpbC48L3A+JzsgcmV0dXJuOyB9CiAgaWYoX3ZpZXdJZHg+PXN0YXRlLnJlc3VsdHMubGVuZ3RoKSBfdmlld0lkeD1zdGF0ZS5yZXN1bHRzLmxlbmd0aC0xOwogIHZhciByPXN0YXRlLnJlc3VsdHNbX3ZpZXdJZHhdOwogIHZhciBsYmw9ci5kZW1vPydEZW1vIChzaW11bGFzaSknOihyLnBhZ2U9PT0naW1nJz8nSW1hZ2UgdG8gSW1hZ2UnOidUZXh0IHRvIEltYWdlJyk7CiAgdmFyIGV4cGlyZXM9ci50cz9uZXcgRGF0ZShyLnRzKzcqMjQqMzYwMCoxMDAwKS50b0xvY2FsZVN0cmluZygnaWQtSUQnKTonJzsKICB2YXIgaD0nJzsKICAvLyBtb2RlbCBiYWRnZQogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMi41IGJvcmRlciBiZCByb3VuZGVkLXhsIHAtMi41IGJnLVsjMWMyMTI4XSI+JwogICAgKyc8aW1nIHNyYz0iJysoci5zcmN8fCcnKSsnIiBjbGFzcz0idy0xMCBoLTEwIHJvdW5kZWQtbGcgb2JqZWN0LWNvdmVyIGJvcmRlciBiZCIvPicKICAgICsnPGRpdiBjbGFzcz0ibWluLXctMCI+PGRpdiBjbGFzcz0idGV4dC14cyBmb250LW1lZGl1bSB0cnVuY2F0ZSI+Jysoci5tb2RlbHx8J01vZGVsJykrJzwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0idGV4dC1bMTBweF0gdGV4dC1uZXV0cmFsLTUwMCI+JytsYmwrJzwvZGl2PjwvZGl2PicKICAgICsnPGJ1dHRvbiBjbGFzcz0ibWwtYXV0byB3LTcgaC03IGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHRleHQtbmV1dHJhbC01MDAgaG92ZXI6dGV4dC13aGl0ZSIgdGl0bGU9IlR1dHVwIGRldGFpbCI+PGkgZGF0YS1pY29uPSJ4IiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPicKICAgICsnPC9kaXY+JzsKICAvLyBpbnB1dCBwcm9tcHQKICBoKz0nPGRpdj48ZGl2IGNsYXNzPSJ0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNTAwIG1iLTEiPklucHV0PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJiZy1ibGFjay80MCBib3JkZXIgYmQgcm91bmRlZC1sZyBwLTIuNSB0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtMzAwIGxlYWRpbmctcmVsYXhlZCBtYXgtaC0yOCBvdmVyZmxvdy15LWF1dG8gaGlkZWJhciI+Jysoci5wcm9tcHR8fCctJykrJzwvZGl2PjwvZGl2Pic7CiAgLy8gZGV0YWlscwogIGgrPSc8ZGl2PjxkaXYgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAgbWItMSI+RGV0YWlsczwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0ic3BhY2UteS0xLjUgdGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTQwMCI+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiBnYXAtMiI+PHNwYW4+VGFzayBJRDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCBmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSBtaW4tdy0wIj48c3BhbiBjbGFzcz0idHJ1bmNhdGUiIHRpdGxlPSInK2VzYyhyLnRhc2tJZCkrJyI+Jysoci50YXNrSWR8fCctJykrJzwvc3Bhbj4nCiAgICArKHIudGFza0lkPyc8YnV0dG9uIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgc2hyaW5rLTAiIHRpdGxlPSJTYWxpbiI+PGkgZGF0YS1pY29uPSJjb3B5IiBjbGFzcz0idy0zLjUgaC0zLjUiPjwvaT48L2J1dHRvbj4nOicnKSsnPC9zcGFuPjwvZGl2PicKICAgICsoci5jcmVkaXRzPyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q3JlZGl0czwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+JytyLmNyZWRpdHMrJzwvc3Bhbj48L2Rpdj4nOicnKQogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q3JlYXRlZCBkYXRlPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK2ZtdERhdGVUaW1lKHIudHMpKyc8L3NwYW4+PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+RXhwaXJlcyBkYXRlPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK2V4cGlyZXMrJzwvc3Bhbj48L2Rpdj4nCiAgICArJzwvZGl2PjwvZGl2Pic7CiAgLy8gbmVnYXRpdmUgcHJvbXB0CiAgaCs9JzxkaXY+PGRpdiBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCBtYi0xIj5OZWdhdGl2ZSBwcm9tcHQ8L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImJnLWJsYWNrLzQwIGJvcmRlciBiZCByb3VuZGVkLWxnIHAtMi41IHRleHQtWzExcHhdIHRleHQtbmV1dHJhbC0zMDAgbGVhZGluZy1yZWxheGVkIG1heC1oLTIwIG92ZXJmbG93LXktYXV0byBoaWRlYmFyIj4nKyhyLm5lZ3x8Jy0nKSsnPC9kaXY+PC9kaXY+JzsKICAvLyBwYXJhbXMKICBoKz0nPGRpdiBjbGFzcz0iZ3JpZCBncmlkLWNvbHMtMiBnYXAteC0zIGdhcC15LTEuNSB0ZXh0LVsxMXB4XSB0ZXh0LW5ldXRyYWwtNDAwIGJvcmRlci10IGJkIHB0LTIuNSI+JwogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2l6ZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+JytyLnNpemUrJzwvc3Bhbj48L2Rpdj4nCiAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TZWVkPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIHRydW5jYXRlIj4nK3Iuc2VlZCsnPC9zcGFuPjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlN0ZXBzPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nKyhyLnN0ZXBzIT1udWxsP3Iuc3RlcHM6Jy0nKSsnPC9zcGFuPjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNGRyBzY2FsZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+Jysoci5jZmchPW51bGw/ci5jZmc6Jy0nKSsnPC9zcGFuPjwvZGl2PicKICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNhbXBsZXI8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrKHIuc2FtcGxlcnx8Jy0nKSsnPC9zcGFuPjwvZGl2PicKICAgICsnPC9kaXY+JzsKICBlbC5pbm5lckhUTUw9aDsKICB2YXIgY29weUJ0bj1lbC5xdWVyeVNlbGVjdG9yKCdidXR0b25bdGl0bGU9IlNhbGluIl0nKTsKICBpZihjb3B5QnRuKSBjb3B5QnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBjb3B5VGV4dChyLnRhc2tJZCk7IH0pOwogIHZhciBjbG9zZUJ0bj1lbC5xdWVyeVNlbGVjdG9yKCdidXR0b25bdGl0bGU9IlR1dHVwIGRldGFpbCJdJyk7CiAgaWYoY2xvc2VCdG4pIGNsb3NlQnRuLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyAkKCdyaWdodFBhbicpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyB9KTsKICAvLyBUaW5nZ2kgcGFuZWwgRGV0YWlsIGthbmFuIG1lbmdpa3V0aSB0aW5nZ2kga2FydHUgZ2FsZXJpIHlhbmcgYWt0aWYgKHNlamFqYXIgcGVudWgpCiAgdmFyIGdyaWQ9JCgnZ3JpZCcpOwogIHZhciBjYXJkPWdyaWQmJmdyaWQuY2hpbGRyZW5bX3ZpZXdJZHhdP2dyaWQuY2hpbGRyZW5bX3ZpZXdJZHhdOm51bGw7CiAgaWYoY2FyZCkgZWwuc3R5bGUubWluSGVpZ2h0PWNhcmQub2Zmc2V0SGVpZ2h0KydweCc7CiAgZWxzZSBlbC5zdHlsZS5taW5IZWlnaHQ9Jyc7Cn0KZnVuY3Rpb24gZXNjKHMpeyByZXR1cm4gU3RyaW5nKHM9PW51bGw/Jyc6cykucmVwbGFjZSgvJi9nLCcmYW1wOycpLnJlcGxhY2UoLzwvZywnJmx0OycpLnJlcGxhY2UoLz4vZywnJmd0OycpLnJlcGxhY2UoLyIvZywnJnF1b3Q7Jyk7IH0KCi8qID09PT09IHJpZ2h0IGhpc3RvcnkgPT09PT0gKi8KZnVuY3Rpb24gcmVuZGVyUmlnaHQoKXsKICB2YXIgbGlzdD0kKCdybGlzdCcpOyBsaXN0LmlubmVySFRNTD0nJzsKICBpZighc3RhdGUucmVzdWx0cy5sZW5ndGgpeyBsaXN0LmlubmVySFRNTD0nPHAgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBwLTQgdGV4dC1jZW50ZXIiPkJlbHVtIGFkYSBoYXNpbC48L3A+JzsgJCgncmNvdW50JykudGV4dENvbnRlbnQ9JzAgaGFzaWwnOyByZXR1cm47IH0KICAkKCdyY291bnQnKS50ZXh0Q29udGVudD1zdGF0ZS5yZXN1bHRzLmxlbmd0aCsnIGhhc2lsJzsKICBzdGF0ZS5yZXN1bHRzLmZvckVhY2goZnVuY3Rpb24ocixpKXsKICAgIHZhciBkPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2RpdicpOyBkLmNsYXNzTmFtZT0ncmNhcmQnOwogICAgdmFyIGxibD1yLmRlbW8/J0RlbW8gKHNpbXVsYXNpKSc6KHIucGFnZT09PSdpbWcnPydJbWFnZSB0byBJbWFnZSc6J1RleHQgdG8gSW1hZ2UnKTsKICAgIGQuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJyZWxhdGl2ZSI+JwogICAgICArJzxpbWcgc3JjPSInK3Iuc3JjKyciIGNsYXNzPSJ3LWZ1bGwgYXNwZWN0LVs0LzNdIG9iamVjdC1jb3ZlciBjdXJzb3ItcG9pbnRlciIvPicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJhYnNvbHV0ZSB0b3AtMS41IHJpZ2h0LTEuNSB3LTYgaC02IHJvdW5kZWQtbWQgYmctYmxhY2svNTAgaG92ZXI6YmctcmVkLTUwMC84MCB0ZXh0LXdoaXRlIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHRleHQteHMiIHRpdGxlPSJIYXB1cyI+4pyVPC9idXR0b24+JwogICAgICArJzwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJwLTIuNSBzcGFjZS15LTEuNSB0ZXh0LXhzIj4nCiAgICAgICsnPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSI+PGkgZGF0YS1pY29uPSJzcGFya2xlIiBjbGFzcz0idy0zIGgtMyB0ZXh0LXZpb2xldC00MDAiPjwvaT48c3BhbiBjbGFzcz0iYmctdmlvbGV0LTUwMC8xMCB0ZXh0LXZpb2xldC0zMDAgcHgtMS41IHB5LXB4IHJvdW5kZWQgdGV4dC1bMTBweF0iPicrbGJsKyc8L3NwYW4+PC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9ImJnLWJsYWNrLzQwIHJvdW5kZWQgcC0xLjUgdGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTMwMCBsZWFkaW5nLXNudWcgY3Vyc29yLXBvaW50ZXIgaG92ZXI6dGV4dC13aGl0ZSIgdGl0bGU9IkxpaGF0IGRldGFpbCI+Jysoci5wcm9tcHR8fCcnKS5zbGljZSgwLDkwKSsnPC9kaXY+JwogICAgICArJzxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xIHRleHQtWzEwcHhdIHRleHQtbmV1dHJhbC01MDAiPjxpIGRhdGEtaWNvbj0ibGF5ZXJzIiBjbGFzcz0idy0zIGgtMyI+PC9pPicrTE9SQS5maWx0ZXIoZnVuY3Rpb24obCl7cmV0dXJuIGwudz4wfSkubGVuZ3RoKycgTG9SQTwvZGl2PicKICAgICAgKyc8ZGl2IGNsYXNzPSJzcGFjZS15LTEgdGV4dC1bMTBweF0gdGV4dC1uZXV0cmFsLTUwMCI+JwogICAgICArKHIudGFza0lkPyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+VGFzayBJRDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCB0cnVuY2F0ZSBtYXgtdy1bNjAlXSIgdGl0bGU9IicrZXNjKHIudGFza0lkKSsnIj4nK2VzYyhyLnRhc2tJZCkrJzwvc3Bhbj48L2Rpdj4nOicnKQogICAgICArKHIuY3JlZGl0cz8nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNyZWRpdHM8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrci5jcmVkaXRzKyc8L3NwYW4+PC9kaXY+JzonJykKICAgICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q3JlYXRlZDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+JytmbXREYXRlKHIudHMpKyc8L3NwYW4+PC9kaXY+JwogICAgICArKHIubmVnPyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+TmVnYXRpdmU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAgdHJ1bmNhdGUgbWF4LXctWzYwJV0iIHRpdGxlPSInK2VzYyhyLm5lZykrJyI+Jytlc2Moci5uZWcpKyc8L3NwYW4+PC9kaXY+JzonJykKICAgICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2l6ZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+JytyLnNpemUrJzwvc3Bhbj48L2Rpdj4nCiAgICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNlZWQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAiPicrci5zZWVkKyc8L3NwYW4+PC9kaXY+JwogICAgICArJzwvZGl2PjwvZGl2Pic7CiAgICBkLnF1ZXJ5U2VsZWN0b3IoJ2ltZycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBfdmlld0lkeD1pOyByZW5kZXJHcmlkKCk7IHJlbmRlckRldGFpbCgpOyBvcGVuTGlnaHRib3gocik7IH0pOwogICAgZC5xdWVyeVNlbGVjdG9yKCcuYmctYmxhY2tcXC80MCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBfdmlld0lkeD1pOyByZW5kZXJHcmlkKCk7IHJlbmRlckRldGFpbCgpOyBvcGVuTGlnaHRib3gocik7IH0pOwogICAgZC5xdWVyeVNlbGVjdG9yKCdidXR0b24nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsKICAgICAgc3RhdGUucmVzdWx0cy5zcGxpY2UoaSwxKTsgcGVyc2lzdFJlc3VsdHMoKTsgcmVuZGVyR3JpZCgpOyByZW5kZXJEZXRhaWwoKTsgcmVuZGVyUmlnaHQoKTsKICAgIH0pOwogICAgbGlzdC5hcHBlbmRDaGlsZChkKTsKICB9KTsKfQoKLyogPT09PT0gbGlnaHRib3ggPT09PT0gKi8KZnVuY3Rpb24gb3BlbkxpZ2h0Ym94KHIpewogICQoJ2xiLWltZycpLnNyYz1yLnNyYzsKICB2YXIgaD0nJzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPk1vZGVsPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nKyhyLm1vZGVsfHwnLScpKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlByb21wdDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+Jysoci5wcm9tcHR8fCctJykrJzwvc3Bhbj48L2Rpdj4nOwogIGlmKHIubmVnKSBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPk5lZ2F0aXZlPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nK3IubmVnKyc8L3NwYW4+PC9kaXY+JzsKICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNpemU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrKHIuc2l6ZXx8Jy0nKSsnPC9zcGFuPjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TZWVkPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nKyhyLnNlZWR8fCctJykrJzwvc3Bhbj48L2Rpdj4nOwogIGlmKHIudGFza0lkKSBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlRhc2sgSUQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrci50YXNrSWQrJzwvc3Bhbj48L2Rpdj4nOwogIGlmKHIuY3JlZGl0cykgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DcmVkaXRzPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nK3IuY3JlZGl0cysnPC9zcGFuPjwvZGl2Pic7CiAgaCs9JzxkaXYgY2xhc3M9Im10LTIiPjxhIGhyZWY9Iicrci5zcmMrJyIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiIGNsYXNzPSJ0ZXh0LVsjNkY1REZGXSBob3Zlcjp1bmRlcmxpbmUgdGV4dC14cyI+QnVrYSBnYW1iYXIgYXNsaSAmbmVhcnI7PC9hPjwvZGl2Pic7CiAgJCgnbGItbWV0YScpLmlubmVySFRNTD1oOwogICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LmFkZCgnZmxleCcpOwp9CiQoJ2xiLWNsb3NlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LnJlbW92ZSgnZmxleCcpOyB9KTsKJCgnbGlnaHRib3gnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oZSl7IGlmKGUudGFyZ2V0PT09JCgnbGlnaHRib3gnKSl7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LnJlbW92ZSgnZmxleCcpOyB9IH0pOwoKLyogPT09PT0gcGF5bG9hZCAoc3RydWt0dXIgbnlhdGEgVGVuc29yLkFydCkgPT09PT0gKi8KZnVuY3Rpb24gYnVpbGRQYXlsb2FkKCl7CiAgdmFyIG5lZz0kKCduZWdjaGVjaycpLmNoZWNrZWQ/JCgnbmVncHJvbXB0JykudmFsdWU6Jyc7CiAgdmFyIG09c3RhdGUubW9kZWw7CiAgcmV0dXJuIHsKICAgIHBhcmFtczp7CiAgICAgIGJhc2VNb2RlbDp7IG1vZGVsSWQ6bS5tb2RlbElkLCBtb2RlbEZpbGVJZDptLm1vZGVsRmlsZUlkIH0sCiAgICAgIG1vZGVsOnNldHRpbmdzLnByb3ZpZGVyPT09J3RhbXMnPycnOihtJiZtLm1vZGVsP20ubW9kZWw6JycpLAogICAgICBzZHhsOnsgcmVmaW5lcjpmYWxzZSB9LAogICAgICBtb2RlbHM6TE9SQS5maWx0ZXIoZnVuY3Rpb24obCl7cmV0dXJuIGwudz4wfSkubWFwKGZ1bmN0aW9uKGwpe3JldHVybiB7IG5hbWU6bC5uYW1lLCB3ZWlnaHQ6bC53LCB0cmlnZ2VyV29yZHM6bC50YWdzLCBsb3JhTW9kZWw6bC5sb3JhTW9kZWx8fCcnLCBsb3JhVXJsOmwubG9yYVVybHx8JycgfSB9KSwKICAgICAgZW1iZWRkaW5nTW9kZWxzOltdLAogICAgICBzZFZhZTokKCd2YWUnKS52YWx1ZT09PSdhdXRvbWF0aWMnPydBdXRvbWF0aWMnOiQoJ3ZhZScpLnZhbHVlLAogICAgICBwcm9tcHQ6JCgncHJvbXB0JykudmFsdWUsCiAgICAgIG5lZ2F0aXZlUHJvbXB0Om5lZywKICAgICAgaGVpZ2h0OnBhcnNlSW50KCQoJ2hlaWdodCcpLnZhbHVlKSwKICAgICAgd2lkdGg6cGFyc2VJbnQoJCgnd2lkdGgnKS52YWx1ZSksCiAgICAgIGltYWdlQ291bnQ6c3RhdGUubmNvbCwKICAgICAgc3RlcHM6cGFyc2VJbnQoJCgnc3RlcHMnKS52YWx1ZSksCiAgICAgIGltYWdlczppMmlEYXRhVXJsP1tpMmlEYXRhVXJsXTpbXSwKICAgICAgZGVub2lzaW5nU3RyZW5ndGg6cGFyc2VGbG9hdCgkKCdpMmktZHMnKS52YWx1ZSl8fDAuNSwKICAgICAgY2ZnU2NhbGU6cGFyc2VGbG9hdCgkKCdjZmcnKS52YWx1ZSksCiAgICAgIHNlZWQ6KCQoJ3NlZWQnKS52YWx1ZXx8JycpLnRyaW0oKXx8U3RyaW5nKE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSo5OTk5OTk5OTk5KSksCiAgICAgIGNsaXBTa2lwOnBhcnNlSW50KCQoJ2NsaXBza2lwJykudmFsdWUpLAogICAgICBldGFOb2lzZVNlZWREZWx0YTpwYXJzZUludCgkKCdldGFuc2QnKS52YWx1ZSksCiAgICAgIHYxQ2xpcDpmYWxzZSwKICAgICAgZW5hYmxlUGl4MnBpeDpzdGF0ZS5wYWdlPT09J2ltZycmJiEhaTJpRGF0YVVybCwKICAgICAgZ3VpZGFuY2U6My41LAogICAgICB1c2VGaXJzdExhc3RGcmFtZTpmYWxzZSwKICAgICAga3NhbXBsZXJOYW1lOiQoJ3NhbXBsZXInKS52YWx1ZSwKICAgICAgc2NoZWR1bGU6JCgnc2NoZWQnKS52YWx1ZQogICAgfSwKICAgIHByb3ZpZGVyOnNldHRpbmdzLnByb3ZpZGVyfHwndGFtcycsCiAgICBjcmVkaXRzOjEuMjIsCiAgICB0YXNrVHlwZTpzdGF0ZS5wYWdlPT09J2ltZycmJmkyaURhdGFVcmw/J0lNRzJJTUcnOidUWFQySU1HJywKICAgIGlzUmVtaXg6ZmFsc2UsCiAgICBjYXB0Y2hhVHlwZTonQ0xPVURGTEFSRV9UVVJOU1RJTEUnCiAgfTsKfQovKiA9PT09PT09PT09PT0gUkVLVFkgR0VORVJBVE9SIOKAlCB2ZXJzaSB3ZWIgZnVsbCA9PT09PT09PT09PT0KICogR2VuZXJhdGUgYXNsaSB2aWEgYmFja2VuZCAoL2FwaSAtPiBUZW5zb3IuQXJ0IE1vZGVsIFNlcnZpY2UpCiAqIGF0YXUgbW9kZSBkZW1vIChwaWNzdW0pIGthbGF1IGJhY2tlbmQvQVBJIGtleSBiZWx1bSBha3RpZi4KICogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwp2YXIgU0VUVElOR1NfS0VZPSdyZWt0eS5zZXR0aW5ncycsIFJFU1VMVFNfS0VZPSdyZWt0eS5yZXN1bHRzJzsKdmFyIHNldHRpbmdzPXsgbW9kZTonYXV0bycsIHByb3ZpZGVyOid0YW1zJywgYXBpS2V5OicnLCBwb2xsU2Vzc2lvbjonJyB9Owp2YXIgUFJPVklERVJfSU5GTz17CiAgdGFtczp7IGxhYmVsOidBUEkgS2V5IFRBTVMgKHRhbXMudGVuc29yLmFydCknLCBoaW50OidHcmF0aXMgZGkgdGFtcy50ZW5zb3IuYXJ0IOKAlCBwYWthaSBkYWZ0YXIgTW9kZWwgZGkgVUkuJyB9LAogIHJlcGxpY2F0ZTp7IGxhYmVsOidBUEkgVG9rZW4gUmVwbGljYXRlIChyZXBsaWNhdGUuY29tKScsIGhpbnQ6J1BpbGloIG1vZGVsIGRpIGthcnR1IE1vZGVsIChGTFVYLCBTRFhMLCBkc3QpLiBJbWcySW1nIGJlbHVtIGRpZHVrdW5nLicgfSwKICBmYWw6eyBsYWJlbDonQVBJIEtleSBmYWwuYWkgKGZhbC5haSknLCBoaW50OidQaWxpaCBtb2RlbCBkaSBrYXJ0dSBNb2RlbCAoRkxVWCwgU0RYTCwgZHN0KS4gSW1nMkltZyBiZWx1bSBkaWR1a3VuZy4nIH0sCiAgcG9sbGluYXRpb25zOnsgbGFiZWw6J0FQSSBLZXkgUG9sbGluYXRpb25zIChvcHNpb25hbCDigJQgc2tfKiknLCBoaW50OidHcmF0aXMgdGFucGEga2V5IChtb2RlbCBvdG9tYXRpcykuIElzaSBrZXkgc2tfKiBkYXJpIGVudGVyLnBvbGxpbmF0aW9ucy5haS9rZXlzIHVudHVrIGRhZnRhciBtb2RlbCBsZW5na2FwLiBIYXNpbCBvdG9tYXRpcyBkaWFyc2lwIHBlcm1hbmVuLicgfQp9OwoKZnVuY3Rpb24gbG9hZFNldHRpbmdzKCl7CiAgdHJ5ewogICAgdmFyIHM9SlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShTRVRUSU5HU19LRVkpfHwne30nKTsKICAgIGlmKHMmJnR5cGVvZiBzPT09J29iamVjdCcpewogICAgICBzZXR0aW5ncy5tb2RlPXMubW9kZXx8J2F1dG8nOyBzZXR0aW5ncy5wcm92aWRlcj1zLnByb3ZpZGVyfHwndGFtcyc7IHNldHRpbmdzLmFwaUtleT1zLmFwaUtleXx8Jyc7CiAgICAgIHNldHRpbmdzLnBvbGxTZXNzaW9uPXMucG9sbFNlc3Npb258fCcnOwogICAgfQogIH1jYXRjaChlKXt9Cn0KZnVuY3Rpb24gc2F2ZVNldHRpbmdzKCl7IHRyeXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU0VUVElOR1NfS0VZLEpTT04uc3RyaW5naWZ5KHNldHRpbmdzKSk7IH1jYXRjaChlKXt9IH0KZnVuY3Rpb24gYXBwbHlTZXR0aW5nc1VJKCl7CiAgJCgnYXBpbW9kZScpLnZhbHVlPXNldHRpbmdzLm1vZGU7ICQoJ2FwaWtleScpLnZhbHVlPXNldHRpbmdzLmFwaUtleTsKICB1cGRhdGVQcm92aWRlclVJKCk7Cn0KZnVuY3Rpb24gdXBkYXRlUHJvdmlkZXJVSSgpewogIHZhciBpbmZvPVBST1ZJREVSX0lORk9bc2V0dGluZ3MucHJvdmlkZXJdfHxQUk9WSURFUl9JTkZPLnRhbXM7CiAgJCgnYXBpcHJvdmlkZXInKS52YWx1ZT1zZXR0aW5ncy5wcm92aWRlcjsKICAkKCdhcGlrZXktbGFiZWwnKS50ZXh0Q29udGVudD1pbmZvLmxhYmVsOwogICQoJ2FwaS1oaW50JykudGV4dENvbnRlbnQ9aW5mby5oaW50OwogIHZhciBpc1BvbGw9c2V0dGluZ3MucHJvdmlkZXI9PT0ncG9sbGluYXRpb25zJzsKICAkKCdhcGlrZXktZmllbGQnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLGlzUG9sbCk7CiAgJCgnYnlvcC1yb3cnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLCFpc1BvbGwpOwogIGlmKGlzUG9sbCkgcmVmcmVzaE9BdXRoU3RhdHVzKCk7CiAgdXBkYXRlQXBpU3RhdHVzKCk7CiAgLy8gR2FudGkgZGFmdGFyIG1vZGVsIHNlc3VhaSBwcm92aWRlciBha3RpZi4KICB2YXIgbGliPU1PREVMX0xJQlNbc2V0dGluZ3MucHJvdmlkZXJdfHxNT0RFTF9MSUJTLnRhbXM7CiAgaWYoTU9ERUxTIT09bGliKXsKICAgIE1PREVMUz1saWI7CiAgICBpZihNT0RFTFMubGVuZ3RoKSBzZXRNb2RlbChNT0RFTFNbMF0pOwogIH0KICAvLyBHYW50aSBkYWZ0YXIgTG9SQSBzZXN1YWkgcHJvdmlkZXIgKExvUkEgbGFtYSBkaWJlcnNpaGthbikuCiAgTE9SQV9MSUI9TE9SQV9MSUJTW3NldHRpbmdzLnByb3ZpZGVyXXx8TE9SQV9MSUJTLnRhbXM7CiAgTE9SQS5sZW5ndGg9MDsKICByZW5kZXJMb3JhKCk7CiAgLy8gUG9sbGluYXRpb25zOiBhbWJpbCBkYWZ0YXIgbW9kZWwgYXNsaSBkYXJpIEFQSSAoZmFsbGJhY2sga2UgZGFmdGFyIHN0YXRpcykuCiAgaWYoc2V0dGluZ3MucHJvdmlkZXI9PT0ncG9sbGluYXRpb25zJykgcmVmcmVzaFBvbGxpbmF0aW9uc01vZGVscygpOwp9CmZ1bmN0aW9uIHJlZnJlc2hQb2xsaW5hdGlvbnNNb2RlbHMoKXsKICBmZXRjaCgnL2FwaS9wb2xsaW5hdGlvbnMtbW9kZWxzJykudGhlbihmdW5jdGlvbihyKXsgcmV0dXJuIHIuanNvbigpOyB9KS50aGVuKGZ1bmN0aW9uKGQpewogICAgaWYoIWR8fCFBcnJheS5pc0FycmF5KGQubW9kZWxzKXx8IWQubW9kZWxzLmxlbmd0aCkgcmV0dXJuOwogICAgdmFyIGxpYj1kLm1vZGVscwogICAgICAuZmlsdGVyKGZ1bmN0aW9uKG0peyByZXR1cm4gbS5jYXRlZ29yeT09PSdpbWFnZScmJm0ubmFtZSYmbS5uYW1lLmluZGV4T2YoJ2J5b3AvJykhPT0wOyB9KQogICAgICAuc2xpY2UoMCw4MCkKICAgICAgLm1hcChmdW5jdGlvbihtKXsgcmV0dXJuIHsgbmFtZTptLnRpdGxlfHxtLm5hbWUsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6bS5icmFuZHx8JycsIHRodW1iOlN0cmluZyhtLm5hbWUpLnJlcGxhY2UoL1teYS16MC05XS9naSwnJyksIGJhZGdlOm0ucGFpZF9vbmx5PydQQUlEJzonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6bS5uYW1lIH07IH0pCiAgICAgIC5zb3J0KGZ1bmN0aW9uKGEsYil7IHJldHVybiAoYS5iYWRnZT09PSdQQUlEJz8xOjApLShiLmJhZGdlPT09J1BBSUQnPzE6MCk7IH0pOwogICAgaWYoIWxpYi5sZW5ndGgpIHJldHVybjsKICAgIE1PREVMX0xJQlMucG9sbGluYXRpb25zPWxpYjsKICAgIGlmKE1PREVMUz09PU1PREVMX0xJQlMucG9sbGluYXRpb25zKXsgc2V0TW9kZWwoTU9ERUxTWzBdKTsgfQogIH0pLmNhdGNoKGZ1bmN0aW9uKCl7fSk7Cn0KZnVuY3Rpb24gdXBkYXRlQXBpU3RhdHVzKCl7CiAgdmFyIGVsPSQoJ2FwaS1zdGF0dXMnKTsgaWYoIWVsKSByZXR1cm47CiAgaWYoc2V0dGluZ3MucHJvdmlkZXI9PT0ncG9sbGluYXRpb25zJyl7CiAgICBlbC50ZXh0Q29udGVudD1zZXR0aW5ncy5wb2xsU2Vzc2lvbj8nUG9sbGluYXRpb25zIMK3IEJZT1AnOidQb2xsaW5hdGlvbnMgwrcgZ3JhdGlzJzsKICAgIGVsLnN0eWxlLmNvbG9yPXNldHRpbmdzLnBvbGxTZXNzaW9uPycjMjdENENEJzonIzlhOWFhMic7CiAgICByZXR1cm47CiAgfQogIHZhciBuYW1lPXNldHRpbmdzLnByb3ZpZGVyPT09J3RhbXMnPydUQU1TJzooc2V0dGluZ3MucHJvdmlkZXI9PT0ncmVwbGljYXRlJz8nUmVwbGljYXRlJzonZmFsLmFpJyk7CiAgZWwudGV4dENvbnRlbnQ9bmFtZSsoc2V0dGluZ3MuYXBpS2V5Pycgwrcga2V5JzonIMK3IHRhbnBhIGtleScpOwogIGVsLnN0eWxlLmNvbG9yPXNldHRpbmdzLmFwaUtleT8nIzI3RDRDRCc6JyM5YTlhYTInOwp9CiQoJ2FwaXByb3ZpZGVyJykuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJyxmdW5jdGlvbigpewogIHNldHRpbmdzLnByb3ZpZGVyPSQoJ2FwaXByb3ZpZGVyJykudmFsdWU7IHNhdmVTZXR0aW5ncygpOyB1cGRhdGVQcm92aWRlclVJKCk7Cn0pOwokKCdhcGktc2F2ZScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpewogIHNldHRpbmdzLm1vZGU9JCgnYXBpbW9kZScpLnZhbHVlOyBzZXR0aW5ncy5hcGlLZXk9JCgnYXBpa2V5JykudmFsdWUudHJpbSgpOwogIHNhdmVTZXR0aW5ncygpOyB1cGRhdGVQcm92aWRlclVJKCk7IHRvYXN0KCdQZW5nYXR1cmFuIEFQSSBkaXNpbXBhbicpOwp9KTsKJCgnYXBpLXRlc3QnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsYXN5bmMgZnVuY3Rpb24oKXsKICB2YXIgYj0kKCdhcGktdGVzdCcpOyBiLmRpc2FibGVkPXRydWU7IGIudGV4dENvbnRlbnQ9J1Rlcy4uLic7CiAgaWYoc2V0dGluZ3MucHJvdmlkZXI9PT0ncG9sbGluYXRpb25zJyl7CiAgICB0cnl7CiAgICAgIHZhciByPWF3YWl0IGZldGNoKCcvYXBpL2hlYWx0aCcpOwogICAgICB2YXIgZD1hd2FpdCByLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsO30pOwogICAgICBpZighci5vaykgdGhyb3cgbmV3IEVycm9yKCdIVFRQICcrci5zdGF0dXMpOwogICAgICB0b2FzdCgnQmFja2VuZCBPSyDCtyBCWU9QICcrKGQmJmQuYnlvcD8nc2lhcCAoQXBwIEtleSB0ZXJwYXNhbmcpJzonYmVsdW0gZGlrb25maWd1cmFzaSAoQXBwIEtleSknKSsnIMK3ICcrKHNldHRpbmdzLnBvbGxTZXNzaW9uPydzZXNpIGFrdGlmJzonYmVsdW0gbG9naW4nKSk7CiAgICAgIHJlZnJlc2hPQXV0aFN0YXR1cygpOwogICAgfWNhdGNoKGUpeyB0b2FzdCgnQmFja2VuZCB0aWRhayBha3RpZiDigJQgZGVwbG95IGRlbmdhbiBGdW5jdGlvbnMgYXRhdSBwYWthaSBtb2RlIGRlbW8nKTsgfQogICAgYi5kaXNhYmxlZD1mYWxzZTsgYi50ZXh0Q29udGVudD0nVGVzJzsKICAgIHJldHVybjsKICB9CiAgdHJ5ewogICAgdmFyIHI9YXdhaXQgZmV0Y2goJy9hcGkvaGVhbHRoJyx7aGVhZGVyczp7J3gtYXBpLWtleSc6JCgnYXBpa2V5JykudmFsdWUudHJpbSgpfHxzZXR0aW5ncy5hcGlLZXl9fSk7CiAgICB2YXIgZD1hd2FpdCByLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsfSk7CiAgICBpZighci5vaykgdGhyb3cgbmV3IEVycm9yKCdIVFRQICcrci5zdGF0dXMpOwogICAgdmFyIHBhcnRzPVtdOwogICAgaWYoZCYmZC5oYXNLZXlzKXsgWyd0YW1zJywncmVwbGljYXRlJywnZmFsJ10uZm9yRWFjaChmdW5jdGlvbihwKXsgaWYoZC5oYXNLZXlzW3BdKSBwYXJ0cy5wdXNoKHApOyB9KTsgfQogICAgdG9hc3QoJ0JhY2tlbmQgT0suIEtleSBkaSBlbnY6ICcrKHBhcnRzLmxlbmd0aD9wYXJ0cy5qb2luKCcsICcpOid0aWRhayBhZGEnKSsnLiBLZXkgZGkgYnJvd3NlcjogJysoc2V0dGluZ3MuYXBpS2V5PydhZGEnOid0aWRhaycpKTsKICB9Y2F0Y2goZSl7IHRvYXN0KCdCYWNrZW5kIHRpZGFrIGFrdGlmIOKAlCBkZXBsb3kgZGVuZ2FuIEZ1bmN0aW9ucyBhdGF1IHBha2FpIG1vZGUgZGVtbycpOyB9CiAgYi5kaXNhYmxlZD1mYWxzZTsgYi50ZXh0Q29udGVudD0nVGVzJzsKfSk7CgovKiAtLS0gQllPUCBPQXV0aCAoQnJpbmcgWW91ciBPd24gUG9sbGVuKSAtLS0KICogTG9naW4gdmlhIGVudGVyLnBvbGxpbmF0aW9ucy5haSAoUEtDRSBjb2RlIGZsb3cpIOKGkiBiYWNrZW5kIHR1a2FyIGtvZGUg4oaSCiAqIHRva2VuIHNrXyBzY29wZWQgdXNlciBkaXNpbXBhbiBkaSBLViBiYWNrZW5kOyBicm93c2VyIGN1bWEgcGVnYW5nIHNlc3Npb24uCiAqLwp2YXIgX29hdXRoVmVyaWZpZXJLZXk9J3Jla3R5Lm9hdXRoLnZlcmlmaWVyJywgX29hdXRoU3RhdGVLZXk9J3Jla3R5Lm9hdXRoLnN0YXRlJzsKZnVuY3Rpb24gX2I2NHVybChidWYpewogIHZhciBzPWJ0b2EoU3RyaW5nLmZyb21DaGFyQ29kZS5hcHBseShudWxsLG5ldyBVaW50OEFycmF5KGJ1ZikpKTsKICByZXR1cm4gcy5yZXBsYWNlKC9cKy9nLCctJykucmVwbGFjZSgvXC8vZywnXycpLnJlcGxhY2UoLz0rJC8sJycpOwp9CmZ1bmN0aW9uIF9yYW5kQjY0KGxlbil7IHZhciBhPW5ldyBVaW50OEFycmF5KGxlbik7IGNyeXB0by5nZXRSYW5kb21WYWx1ZXMoYSk7IHJldHVybiBfYjY0dXJsKGEpOyB9CmFzeW5jIGZ1bmN0aW9uIF9zaGEyNTZCNjR1cmwodGV4dCl7CiAgdmFyIGJ1Zj1hd2FpdCBjcnlwdG8uc3VidGxlLmRpZ2VzdCgnU0hBLTI1NicsbmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHRleHQpKTsKICByZXR1cm4gX2I2NHVybChidWYpOwp9CmZ1bmN0aW9uIHN0YXJ0UG9sbE9BdXRoKCl7CiAgdmFyIHZlcmlmaWVyPV9yYW5kQjY0KDQ4KTsKICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShfb2F1dGhWZXJpZmllcktleSx2ZXJpZmllcik7CiAgdmFyIHN0YXRlPV9yYW5kQjY0KDE2KTsKICBsb2NhbFN0b3JhZ2Uuc2V0SXRlbShfb2F1dGhTdGF0ZUtleSxzdGF0ZSk7CiAgZmV0Y2goJy9hcGkvb2F1dGgvY29uZmlnJykudGhlbihmdW5jdGlvbihyKXtyZXR1cm4gci5qc29uKCk7fSkudGhlbihhc3luYyBmdW5jdGlvbihjZmcpewogICAgaWYoIWNmZ3x8IWNmZy5jbGllbnRJZCkgdGhyb3cgbmV3IEVycm9yKCdiYWNrZW5kIGJlbHVtIHB1bnlhIEFwcCBLZXkgUG9sbGluYXRpb25zJyk7CiAgICB2YXIgY2hhbGxlbmdlPWF3YWl0IF9zaGEyNTZCNjR1cmwodmVyaWZpZXIpOwogICAgdmFyIHA9bmV3IFVSTFNlYXJjaFBhcmFtcyh7CiAgICAgIHJlc3BvbnNlX3R5cGU6J2NvZGUnLCBjbGllbnRfaWQ6Y2ZnLmNsaWVudElkLCByZWRpcmVjdF91cmk6Y2ZnLnJlZGlyZWN0VXJpLAogICAgICBzY29wZTondXNhZ2UnLCBzdGF0ZTpzdGF0ZSwKICAgICAgY29kZV9jaGFsbGVuZ2U6Y2hhbGxlbmdlLCBjb2RlX2NoYWxsZW5nZV9tZXRob2Q6J1MyNTYnCiAgICB9KTsKICAgIHdpbmRvdy5sb2NhdGlvbi5ocmVmPWNmZy5hdXRob3JpemVCYXNlKyc/JytwLnRvU3RyaW5nKCk7CiAgfSkuY2F0Y2goZnVuY3Rpb24oZSl7IHRvYXN0KCdHYWdhbCBtdWxhaSBsb2dpbjogJysoZSYmZS5tZXNzYWdlfHxlKSk7IH0pOwp9CmZ1bmN0aW9uIHJlZnJlc2hPQXV0aFN0YXR1cygpewogIHZhciBlbD0kKCdieW9wLXN0YXR1cycpLCBidG49JCgnYnlvcC1sb2dpbicpLCBvdXQ9JCgnYnlvcC1sb2dvdXQnKTsKICBpZighc2V0dGluZ3MucG9sbFNlc3Npb24peyBpZihlbCllbC5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgaWYob3V0KW91dC5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgcmV0dXJuOyB9CiAgZmV0Y2goJy9hcGkvb2F1dGgvc3RhdHVzP3Nlc3Npb249JytlbmNvZGVVUklDb21wb25lbnQoc2V0dGluZ3MucG9sbFNlc3Npb24pKS50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiByLmpzb24oKTt9KS50aGVuKGZ1bmN0aW9uKGQpewogICAgaWYoZCYmZC5jb25uZWN0ZWQpewogICAgICB2YXIgYmFsVHh0PScnOwogICAgICBpZihkLmJhbGFuY2UmJnR5cGVvZiBkLmJhbGFuY2U9PT0nb2JqZWN0Jyl7CiAgICAgICAgdmFyIGJ2PWQuYmFsYW5jZS5wb2xsZW5CYWxhbmNlIT1udWxsP2QuYmFsYW5jZS5wb2xsZW5CYWxhbmNlOihkLmJhbGFuY2UuYmFsYW5jZSE9bnVsbD9kLmJhbGFuY2UuYmFsYW5jZTpudWxsKTsKICAgICAgICBpZihidiE9bnVsbCkgYmFsVHh0PScgwrcgc2FsZG8gJytidisnIHBvbGxlbic7CiAgICAgIH0KICAgICAgZWwudGV4dENvbnRlbnQ9J1Rlcmh1YnVuZyDinJMnKyhkLmV4cGlyZXNJbj8oJyDCtyBzaXNhICcrTWF0aC5jZWlsKGQuZXhwaXJlc0luLzg2NDAwKSsnIGhhcmknKTonJykrYmFsVHh0OwogICAgICBlbC5zdHlsZS5jb2xvcj0nIzI3RDRDRCc7IGVsLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOwogICAgICBidG4udGV4dENvbnRlbnQ9J0xvZ2luIHVsYW5nIChnYW50aSBha3VuKSc7IG91dC5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsKICAgIH1lbHNlewogICAgICBlbC50ZXh0Q29udGVudD0nU2VzaSBiZXJha2hpciDigJQgbG9naW4gdWxhbmcnOyBlbC5zdHlsZS5jb2xvcj0nI2U1YTUwYSc7CiAgICAgIGVsLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyBvdXQuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7CiAgICAgIHNldHRpbmdzLnBvbGxTZXNzaW9uPScnOyBzYXZlU2V0dGluZ3MoKTsgdXBkYXRlQXBpU3RhdHVzKCk7CiAgICB9CiAgfSkuY2F0Y2goZnVuY3Rpb24oKXt9KTsKfQpmdW5jdGlvbiBwb2xsTG9nb3V0KCl7CiAgZmV0Y2goJy9hcGkvb2F1dGgvbG9nb3V0Jyx7bWV0aG9kOidQT1NUJyxoZWFkZXJzOnsnQ29udGVudC1UeXBlJzonYXBwbGljYXRpb24vanNvbid9LGJvZHk6SlNPTi5zdHJpbmdpZnkoe3Nlc3Npb246c2V0dGluZ3MucG9sbFNlc3Npb259KX0pLmNhdGNoKGZ1bmN0aW9uKCl7fSk7CiAgc2V0dGluZ3MucG9sbFNlc3Npb249Jyc7IHNhdmVTZXR0aW5ncygpOyB1cGRhdGVBcGlTdGF0dXMoKTsgcmVmcmVzaE9BdXRoU3RhdHVzKCk7CiAgdG9hc3QoJ1Nlc2kgUG9sbGluYXRpb25zIGRpY2FidXQnKTsKfQphc3luYyBmdW5jdGlvbiBoYW5kbGVPQXV0aENhbGxiYWNrKCl7CiAgaWYobG9jYXRpb24ucGF0aG5hbWUhPT0nL2NhbGxiYWNrJykgcmV0dXJuOwogIHZhciBxPW5ldyBVUkxTZWFyY2hQYXJhbXMobG9jYXRpb24uc2VhcmNoKTsKICB2YXIgaD1uZXcgVVJMU2VhcmNoUGFyYW1zKGxvY2F0aW9uLmhhc2guc2xpY2UoMSkpOwogIHZhciBlcnI9cS5nZXQoJ2Vycm9yJyl8fGguZ2V0KCdlcnJvcicpOwogIGlmKGVycil7IHRvYXN0KCdMb2dpbiBkaWJhdGFsa2FuOiAnK2Vycik7IGhpc3RvcnkucmVwbGFjZVN0YXRlKG51bGwsJycsJy8nKTsgcmV0dXJuOyB9CiAgdmFyIGNvZGU9cS5nZXQoJ2NvZGUnKTsKICB2YXIgc3RhdGU9cS5nZXQoJ3N0YXRlJyk7CiAgdmFyIHNhdmVkU3RhdGU9bG9jYWxTdG9yYWdlLmdldEl0ZW0oX29hdXRoU3RhdGVLZXkpOwogIHZhciB2ZXJpZmllcj1sb2NhbFN0b3JhZ2UuZ2V0SXRlbShfb2F1dGhWZXJpZmllcktleSk7CiAgbG9jYWxTdG9yYWdlLnJlbW92ZUl0ZW0oX29hdXRoU3RhdGVLZXkpOyBsb2NhbFN0b3JhZ2UucmVtb3ZlSXRlbShfb2F1dGhWZXJpZmllcktleSk7CiAgaWYoIWNvZGV8fCFzdGF0ZXx8c3RhdGUhPT1zYXZlZFN0YXRlfHwhdmVyaWZpZXIpewogICAgdG9hc3QoJ0NhbGxiYWNrIE9BdXRoIHRpZGFrIHZhbGlkJyk7IGhpc3RvcnkucmVwbGFjZVN0YXRlKG51bGwsJycsJy8nKTsgcmV0dXJuOwogIH0KICB2YXIgY2ZnPWF3YWl0IGZldGNoKCcvYXBpL29hdXRoL2NvbmZpZycpLnRoZW4oZnVuY3Rpb24ocil7cmV0dXJuIHIuanNvbigpO30pLmNhdGNoKGZ1bmN0aW9uKCl7cmV0dXJuIG51bGw7fSk7CiAgdHJ5ewogICAgdmFyIHI9YXdhaXQgZmV0Y2goJy9hcGkvb2F1dGgvdG9rZW4nLHttZXRob2Q6J1BPU1QnLGhlYWRlcnM6eydDb250ZW50LVR5cGUnOidhcHBsaWNhdGlvbi9qc29uJ30sCiAgICAgIGJvZHk6SlNPTi5zdHJpbmdpZnkoe2NvZGU6Y29kZSxjb2RlX3ZlcmlmaWVyOnZlcmlmaWVyLHJlZGlyZWN0X3VyaTooY2ZnJiZjZmcucmVkaXJlY3RVcmkpfHwnJ30pfSk7CiAgICB2YXIgZD1hd2FpdCByLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsO30pOwogICAgaWYoIXIub2t8fCFkLnNlc3Npb24pIHRocm93IG5ldyBFcnJvcigoZCYmZC5lcnJvcil8fCgnSFRUUCAnK3Iuc3RhdHVzKSk7CiAgICBzZXR0aW5ncy5wb2xsU2Vzc2lvbj1kLnNlc3Npb247IHNhdmVTZXR0aW5ncygpOyB1cGRhdGVQcm92aWRlclVJKCk7CiAgICB0b2FzdCgnTG9naW4gUG9sbGluYXRpb25zIGJlcmhhc2lsIScpOwogIH1jYXRjaChlKXsgdG9hc3QoJ0dhZ2FsIHR1a2FyIGtvZGU6ICcrKGUmJmUubWVzc2FnZXx8ZSkpOyB9CiAgaGlzdG9yeS5yZXBsYWNlU3RhdGUobnVsbCwnJywnLycpOwp9CiQoJ2J5b3AtbG9naW4nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsc3RhcnRQb2xsT0F1dGgpOwokKCdieW9wLWxvZ291dCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxwb2xsTG9nb3V0KTsKCi8qIC0tLSB0b2FzdCAtLS0gKi8KdmFyIF90b2FzdFRpbWVyPW51bGw7CmZ1bmN0aW9uIHRvYXN0KG1zZyl7CiAgdmFyIHQ9JCgndG9hc3QnKTsgaWYoIXQpIHJldHVybjsKICB0LnRleHRDb250ZW50PW1zZzsgdC5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsKICBjbGVhclRpbWVvdXQoX3RvYXN0VGltZXIpOwogIF90b2FzdFRpbWVyPXNldFRpbWVvdXQoZnVuY3Rpb24oKXsgdC5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgfSwzNTAwKTsKfQoKLyogLS0tIHByb2dyZXNzIG92ZXJsYXkgLS0tICovCnZhciBfcG9sbFN0b3A9ZmFsc2U7CmZ1bmN0aW9uIHNob3dQcm9ncmVzcyh0aXRsZSxzdGF0dXMscGN0KXsKICAkKCdwcm9nLXRpdGxlJykudGV4dENvbnRlbnQ9dGl0bGU7CiAgJCgncHJvZy1zdGF0dXMnKS50ZXh0Q29udGVudD1zdGF0dXN8fCcnOwogICQoJ3Byb2ctYmFyJykuc3R5bGUud2lkdGg9TWF0aC5tYXgoMCxNYXRoLm1pbigxMDAscGN0fHwwKSkrJyUnOwogICQoJ3Byb2ctcGN0JykudGV4dENvbnRlbnQ9TWF0aC5yb3VuZChwY3R8fDApKyclJzsKICAkKCdwcm9nb3ZlcmxheScpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyAkKCdwcm9nb3ZlcmxheScpLmNsYXNzTGlzdC5hZGQoJ2ZsZXgnKTsKfQpmdW5jdGlvbiBoaWRlUHJvZ3Jlc3MoKXsgJCgncHJvZ292ZXJsYXknKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgJCgncHJvZ292ZXJsYXknKS5jbGFzc0xpc3QucmVtb3ZlKCdmbGV4Jyk7IH0KJCgncHJvZy1jYW5jZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgX3BvbGxTdG9wPXRydWU7IHRvYXN0KCdNZW1iYXRhbGthbi4uLicpOyB9KTsKCi8qIC0tLSBBUEkgY2xpZW50IC0tLSAqLwpmdW5jdGlvbiBidWlsZEFwaUtleSgpeyByZXR1cm4gc2V0dGluZ3MuYXBpS2V5fHwkKCdhcGlrZXknKS52YWx1ZS50cmltKCk7IH0KCmZ1bmN0aW9uIF9hcGlIZWFkZXJzKGV4dHJhKXsKICB2YXIgaD17J3gtYXBpLWtleSc6YnVpbGRBcGlLZXkoKX07CiAgaWYoc2V0dGluZ3MucHJvdmlkZXI9PT0ncG9sbGluYXRpb25zJyYmc2V0dGluZ3MucG9sbFNlc3Npb24pIGhbJ3gtc2Vzc2lvbiddPXNldHRpbmdzLnBvbGxTZXNzaW9uOwogIGlmKGV4dHJhKSBmb3IodmFyIGsgaW4gZXh0cmEpIGhba109ZXh0cmFba107CiAgcmV0dXJuIGg7Cn0KYXN5bmMgZnVuY3Rpb24gYXBpR2VuZXJhdGUocGF5bG9hZCl7CiAgdmFyIHJlcz1hd2FpdCBmZXRjaCgnL2FwaS9nZW5lcmF0ZScse21ldGhvZDonUE9TVCcsaGVhZGVyczpfYXBpSGVhZGVycyh7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nfSksYm9keTpKU09OLnN0cmluZ2lmeShwYXlsb2FkKX0pOwogIHZhciBkPWF3YWl0IHJlcy5qc29uKCkuY2F0Y2goZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH0pOwogIGlmKCFyZXMub2spIHRocm93IG5ldyBFcnJvcigoZCYmZC5lcnJvcil8fCgnSFRUUCAnK3Jlcy5zdGF0dXMpKTsKICByZXR1cm4gZHx8e307Cn0KYXN5bmMgZnVuY3Rpb24gYXBpVGFzayh0YXNrSWQpewogIHZhciByZXM9YXdhaXQgZmV0Y2goJy9hcGkvdGFzaz9pZD0nK2VuY29kZVVSSUNvbXBvbmVudCh0YXNrSWQpLHtoZWFkZXJzOl9hcGlIZWFkZXJzKHt9KX0pOwogIHZhciBkPWF3YWl0IHJlcy5qc29uKCkuY2F0Y2goZnVuY3Rpb24oKXtyZXR1cm4gbnVsbH0pOwogIGlmKCFyZXMub2spIHRocm93IG5ldyBFcnJvcigoZCYmZC5lcnJvcil8fCgnSFRUUCAnK3Jlcy5zdGF0dXMpKTsKICByZXR1cm4gZHx8e307Cn0KCmFzeW5jIGZ1bmN0aW9uIHBvbGxUYXNrKHRhc2tJZCxvblByb2cpewogIHZhciBzdGFydD1EYXRlLm5vdygpLCBtYXhNcz02KjYwKjEwMDA7CiAgd2hpbGUoRGF0ZS5ub3coKS1zdGFydDxtYXhNcyl7CiAgICBpZihfcG9sbFN0b3ApIHRocm93IG5ldyBFcnJvcignZGliYXRhbGthbiBwZW5nZ3VuYScpOwogICAgdmFyIGQ9YXdhaXQgYXBpVGFzayh0YXNrSWQpOwogICAgaWYoZC5zdGF0dXM9PT0nU1VDQ0VTUycpIHJldHVybiBkLmltYWdlc3x8W107CiAgICBpZihkLnN0YXR1cz09PSdGQUlMRUQnKSB0aHJvdyBuZXcgRXJyb3IoZC5lcnJvcnx8J1Rhc2sgZ2FnYWwnKTsKICAgIGlmKGQuc3RhdHVzPT09J0NBTkNFTEVEJykgdGhyb3cgbmV3IEVycm9yKCdUYXNrIGRpYmF0YWxrYW4nKTsKICAgIHZhciBzdD0oZC5zdGF0dXM9PT0nV0FJVElORycpPygnQW50cmUgJysoZC5xdWV1ZXx8JycpKTooZC5zdGF0dXM9PT0nUlVOTklORyc/J0dlbmVyYXRpbmcuLi4nOidNZW51bmdndS4uLicpOwogICAgb25Qcm9nKHN0LGQucHJvZ3Jlc3N8fDApOwogICAgYXdhaXQgbmV3IFByb21pc2UoZnVuY3Rpb24ocil7IHNldFRpbWVvdXQociwgZC5zdGF0dXM9PT0nV0FJVElORyc/NDAwMDoyMDAwKTsgfSk7CiAgfQogIHRocm93IG5ldyBFcnJvcignVGltZW91dCBtZW51bmdndSBoYXNpbCBnZW5lcmF0ZScpOwp9CgovKiAtLS0gaGFzaWwgLS0tICovCmZ1bmN0aW9uIG1rUmVzdWx0KHNyYyxwYXIsdGFza0lkLGNyZWRpdHMpewogIHJldHVybiB7CiAgICBzcmM6c3JjLCBwcm9tcHQ6cGFyLnBhcmFtcy5wcm9tcHQsIG5lZzpwYXIucGFyYW1zLm5lZ2F0aXZlUHJvbXB0LAogICAgbW9kZWw6c3RhdGUubW9kZWw/c3RhdGUubW9kZWwubmFtZTonJywKICAgIHNpemU6cGFyLnBhcmFtcy53aWR0aCsneCcrcGFyLnBhcmFtcy5oZWlnaHQsIHNlZWQ6cGFyLnBhcmFtcy5zZWVkLAogICAgdGFza0lkOnRhc2tJZHx8JycsIGNyZWRpdHM6Y3JlZGl0cyE9bnVsbD9jcmVkaXRzOicnLAogICAgc3RlcHM6cGFyLnBhcmFtcy5zdGVwcyE9bnVsbD9wYXIucGFyYW1zLnN0ZXBzOicnLAogICAgY2ZnOnBhci5wYXJhbXMuY2ZnU2NhbGUhPW51bGw/cGFyLnBhcmFtcy5jZmdTY2FsZTonJywKICAgIHNhbXBsZXI6cGFyLnBhcmFtcy5rc2FtcGxlck5hbWV8fHBhci5wYXJhbXMuc2FtcGxlcnx8JycsCiAgICB0czpEYXRlLm5vdygpLCBkZW1vOmZhbHNlLCBwYWdlOnN0YXRlLnBhZ2UKICB9Owp9CmZ1bmN0aW9uIGRlbW9SZXN1bHRzKHBhcil7CiAgc2hvd1Byb2dyZXNzKCdNb2RlIGRlbW8nLCdNZW55aWFwa2FuIGdhbWJhciBzaW11bGFzaS4uLicsMTUpOwogIHNldFRpbWVvdXQoZnVuY3Rpb24oKXsKICAgIGZvcih2YXIgaT0wO2k8c3RhdGUubmNvbDtpKyspewogICAgICB2YXIgc3JjPVMrTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKjFlOSkrJy81MTInOwogICAgICBhZGRSZXN1bHQoe3NyYzpzcmMsIHByb21wdDpwYXIucGFyYW1zLnByb21wdCwgbmVnOnBhci5wYXJhbXMubmVnYXRpdmVQcm9tcHQsCiAgICAgICAgbW9kZWw6c3RhdGUubW9kZWw/c3RhdGUubW9kZWwubmFtZTonJywgc2l6ZTpwYXIucGFyYW1zLndpZHRoKyd4JytwYXIucGFyYW1zLmhlaWdodCwKICAgICAgICBzZWVkOnBhci5wYXJhbXMuc2VlZCwgdGFza0lkOicnLCBjcmVkaXRzOicnLCB0czpEYXRlLm5vdygpLCBkZW1vOnRydWUsIHBhZ2U6c3RhdGUucGFnZSwKICAgICAgICBzdGVwczpwYXIucGFyYW1zLnN0ZXBzIT1udWxsP3Bhci5wYXJhbXMuc3RlcHM6JycsCiAgICAgICAgY2ZnOnBhci5wYXJhbXMuY2ZnU2NhbGUhPW51bGw/cGFyLnBhcmFtcy5jZmdTY2FsZTonJywKICAgICAgICBzYW1wbGVyOnBhci5wYXJhbXMua3NhbXBsZXJOYW1lfHxwYXIucGFyYW1zLnNhbXBsZXJ8fCcnfSk7CiAgICB9CiAgICBoaWRlUHJvZ3Jlc3MoKTsKICB9LDcwMCk7Cn0KCmFzeW5jIGZ1bmN0aW9uIGRvR2VuZXJhdGUoKXsKICBpZihzdGF0ZS5idXN5KSByZXR1cm47CiAgdmFyIHA9JCgncHJvbXB0JykudmFsdWUudHJpbSgpOwogIGlmKCFwKXsgb3BlbkxlZnQoKTsgJCgncHJvbXB0JykuZm9jdXMoKTsgdG9hc3QoJ0lzaSBwcm9tcHQgZHVsdScpOyByZXR1cm47IH0KICB2YXIgcGFyPWJ1aWxkUGF5bG9hZCgpOwogIHN0YXRlLmJ1c3k9dHJ1ZTsgc2V0QnVzeSh0cnVlKTsgX3BvbGxTdG9wPWZhbHNlOwogIHRyeXsKICAgIGlmKHNldHRpbmdzLm1vZGU9PT0nZGVtbyd8fCghYnVpbGRBcGlLZXkoKSYmc2V0dGluZ3MucHJvdmlkZXIhPT0ncG9sbGluYXRpb25zJykpewogICAgICBhd2FpdCBuZXcgUHJvbWlzZShmdW5jdGlvbihyKXsgc2V0VGltZW91dChyLDMwMCk7IH0pOwogICAgICBkZW1vUmVzdWx0cyhwYXIpOwogICAgICBpZighYnVpbGRBcGlLZXkoKSkgdG9hc3QoJ0JlbHVtIGFkYSBBUEkga2V5IOKAlCBoYXNpbCBzaW11bGFzaS4gSXNpIEFQSSBLZXkgVEFNUyBkaSBwYW5lbCBraXJpIHVudHVrIGdlbmVyYXRlIGFzbGkuJyk7CiAgICAgIGVsc2UgdG9hc3QoJ01vZGUgZGVtbyBha3RpZiDigJQgaGFzaWwgc2ltdWxhc2kuJyk7CiAgICB9ZWxzZXsKICAgICAgc2hvd1Byb2dyZXNzKCdNZW5naXJpbSBrZSBUQU1TLi4uJywnTWVueWlhcGthbiB0YXNrLi4uJyw1KTsKICAgICAgdmFyIHI9YXdhaXQgYXBpR2VuZXJhdGUocGFyKTsKICAgICAgdmFyIHRhc2tJZD1yLnRhc2tJZHx8ci5qb2JJZDsKICAgICAgaWYodGFza0lkKXsKICAgICAgICB2YXIgaW1ncz1hd2FpdCBwb2xsVGFzayh0YXNrSWQsZnVuY3Rpb24oc3QscGN0KXsgc2hvd1Byb2dyZXNzKCdHZW5lcmF0aW5nLi4uJyxzdCxwY3QpOyB9KTsKICAgICAgICBpbWdzLmZvckVhY2goZnVuY3Rpb24oc3JjKXsgYWRkUmVzdWx0KG1rUmVzdWx0KHNyYyxwYXIsdGFza0lkLHIuY3JlZGl0cykpOyB9KTsKICAgICAgfWVsc2V7CiAgICAgICAgdmFyIGltZ3MyPWV4dHJhY3RJbWFnZXMocik7CiAgICAgICAgaWYoIWltZ3MyLmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKCdSZXNwb25zZSB0YW5wYSBnYW1iYXInKTsKICAgICAgICBpbWdzMi5mb3JFYWNoKGZ1bmN0aW9uKHNyYyl7IGFkZFJlc3VsdChta1Jlc3VsdChzcmMscGFyLCcnLHIuY3JlZGl0cykpOyB9KTsKICAgICAgfQogICAgfQogIH1jYXRjaChlKXsKICAgIGlmKHNldHRpbmdzLm1vZGU9PT0nYXV0bycpewogICAgICB0b2FzdCgnQmFja2VuZC9BUEkgYmVsdW0gYWt0aWYgKCcrZS5tZXNzYWdlKycpIOKAlCBwYWthaSBzaW11bGFzaSBkZW1vJyk7CiAgICAgIGRlbW9SZXN1bHRzKHBhcik7CiAgICB9ZWxzZXsKICAgICAgdG9hc3QoJ0dhZ2FsOiAnK2UubWVzc2FnZSk7CiAgICB9CiAgfWZpbmFsbHl7CiAgICBoaWRlUHJvZ3Jlc3MoKTsgc3RhdGUuYnVzeT1mYWxzZTsgc2V0QnVzeShmYWxzZSk7CiAgfQp9CgovKiAtLS0gSW1nMkltZyAtLS0gKi8KdmFyIGkyaURhdGFVcmw9bnVsbDsKJCgnaTJpLWRyb3AnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgnaTJpLWZpbGUnKS5jbGljaygpOyB9KTsKJCgnaTJpLWZpbGUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLGZ1bmN0aW9uKGUpeyBoYW5kbGVJMmlGaWxlKGUudGFyZ2V0LmZpbGVzJiZlLnRhcmdldC5maWxlc1swXSk7IH0pOwokKCdpMmktZHJvcCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2RyYWdvdmVyJyxmdW5jdGlvbihlKXsgZS5wcmV2ZW50RGVmYXVsdCgpOyB9KTsKJCgnaTJpLWRyb3AnKS5hZGRFdmVudExpc3RlbmVyKCdkcm9wJyxmdW5jdGlvbihlKXsgZS5wcmV2ZW50RGVmYXVsdCgpOyBoYW5kbGVJMmlGaWxlKGUuZGF0YVRyYW5zZmVyLmZpbGVzJiZlLmRhdGFUcmFuc2Zlci5maWxlc1swXSk7IH0pOwokKCdpMmktZHMnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7ICQoJ2kyaS1kc3YnKS50ZXh0Q29udGVudD1wYXJzZUZsb2F0KGUudGFyZ2V0LnZhbHVlKS50b0ZpeGVkKDIpOyB9KTsKJCgnaTJpLWNsZWFyJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7CiAgaTJpRGF0YVVybD1udWxsOyAkKCdpMmktcHJldmlldycpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyAkKCdpMmktaW1nJykuc3JjPScnOyAkKCdpMmktZHJvcCcpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOwp9KTsKZnVuY3Rpb24gaGFuZGxlSTJpRmlsZShmKXsKICBpZighZikgcmV0dXJuOwogIHZhciByZD1uZXcgRmlsZVJlYWRlcigpOwogIHJkLm9ubG9hZD1mdW5jdGlvbigpewogICAgaTJpRGF0YVVybD1yZC5yZXN1bHQ7CiAgICAkKCdpMmktaW1nJykuc3JjPXJkLnJlc3VsdDsgJCgnaTJpLXByZXZpZXcnKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgJCgnaTJpLWRyb3AnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsKICB9OwogIHJkLnJlYWRBc0RhdGFVUkwoZik7Cn0KCi8qIC0tLSByZW5kZXIgcGVyIHRhYiAtLS0gKi8KZnVuY3Rpb24gcmVuZGVyQ2FudmFzKCl7CiAgdmFyIHBhZ2U9c3RhdGUucGFnZTsKICB2YXIgaGlkZU1haW4gPSAhKHBhZ2U9PT0ndGV4dCd8fHBhZ2U9PT0naW1nJyk7CiAgJCgnaW1nMmltZy1jYXJkJykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJywgcGFnZSE9PSdpbWcnKTsKICAkKCdlbXB0eScpLnN0eWxlLmRpc3BsYXkgPSAoaGlkZU1haW4gfHwgc3RhdGUucmVzdWx0cy5sZW5ndGg+MCkgPyAnbm9uZScgOiAnJzsKICAkKCdncmlkJykuc3R5bGUuZGlzcGxheSA9IGhpZGVNYWluPydub25lJzonJzsKICAkKCd0YWItcGxhY2Vob2xkZXInKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLCAhaGlkZU1haW4pOwogICQoJ3RhYi1wbGFjZWhvbGRlcicpLmNsYXNzTGlzdC50b2dnbGUoJ2ZsZXgnLCBoaWRlTWFpbik7CiAgaWYocGFnZT09PSdlZGl0JykgJCgndGFiLXBsYWNlaG9sZGVyLXRleHQnKS50ZXh0Q29udGVudD0nRWRpdCAvIElucGFpbnRpbmcg4oCUIHNlZ2VyYSBoYWRpcic7CiAgZWxzZSBpZihwYWdlPT09J3ZpZGVvJykgJCgndGFiLXBsYWNlaG9sZGVyLXRleHQnKS50ZXh0Q29udGVudD0nVGV4dCAvIEltYWdlIHRvIFZpZGVvIOKAlCBzZWdlcmEgaGFkaXInOwogIGVsc2UgaWYocGFnZT09PSdwcmltZScpICQoJ3RhYi1wbGFjZWhvbGRlci10ZXh0JykudGV4dENvbnRlbnQ9J1ByaW1lIOKAlCBzZWdlcmEgaGFkaXInOwp9CgovKiAtLS0gcml3YXlhdCBkaSBtb2JpbGUgLS0tICovCiQoJ2J0bi1oaXN0b3J5JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7ICQoJ3JpZ2h0UGFuJykuY2xhc3NMaXN0LnRvZ2dsZSgnbW9iaWxlLW9wZW4nKTsgfSk7CndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCdyZXNpemUnLGZ1bmN0aW9uKCl7IGlmKCQoJ3JkZXRhaWwnKS5pbm5lckhUTUwpIHJlbmRlckRldGFpbCgpOyB9KTsKJCgnb3ZlcmxheScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyAkKCdyaWdodFBhbicpLmNsYXNzTGlzdC5yZW1vdmUoJ21vYmlsZS1vcGVuJyk7IH0pOwoKcmVuZGVyTG9yYSgpOwpzZXRNb2RlbChNT0RFTFNbMF0pOwp1cGRXSCgpOwphcHBseU5jb2woKTsKbG9hZFNldHRpbmdzKCk7IGFwcGx5U2V0dGluZ3NVSSgpOwpoYW5kbGVPQXV0aENhbGxiYWNrKCk7CnRyeXsKICB2YXIgc2F2ZWQ9SlNPTi5wYXJzZShsb2NhbFN0b3JhZ2UuZ2V0SXRlbShSRVNVTFRTX0tFWSl8fCdbXScpOwogIGlmKEFycmF5LmlzQXJyYXkoc2F2ZWQpKSBzdGF0ZS5yZXN1bHRzPXNhdmVkOwp9Y2F0Y2goZSl7fQpyZW5kZXJDYW52YXMoKTsKcmVuZGVyR3JpZCgpOwpyZW5kZXJEZXRhaWwoKTsKcmVuZGVyUmlnaHQoKTsKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgoKCg==';
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
