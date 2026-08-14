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
        tams: TAMS_BASE,
      });
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
      const apiKey = pickApiKey(env, request, body, provider);
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

      const apiKey = pickApiKey(env, request, {}, provider);
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
const HTML_B64 = 'PCFET0NUWVBFIGh0bWw+DQo8aHRtbCBsYW5nPSJpZCI+DQo8aGVhZD4NCjxtZXRhIGNoYXJzZXQ9IlVURi04IiAvPg0KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCxpbml0aWFsLXNjYWxlPTEiIC8+DQo8dGl0bGU+UmVrdHkgQUkg4oCUIFRleHQgdG8gSW1hZ2U8L3RpdGxlPg0KPHNjcmlwdD53aW5kb3cuX190YV9zdHlsZV9fPXRydWU8L3NjcmlwdD4NCjxzY3JpcHQgc3JjPSJodHRwczovL2Nkbi50YWlsd2luZGNzcy5jb20iPjwvc2NyaXB0Pg0KPHNjcmlwdCBzcmM9Imh0dHBzOi8vdW5wa2cuY29tL0BwaG9zcGhvci1pY29ucy93ZWIvcGhvc3Bob3ItaWNvbi5qcyI+PC9zY3JpcHQ+DQo8bGluayByZWw9InByZWNvbm5lY3QiIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20iPg0KPGxpbmsgaHJlZj0iaHR0cHM6Ly9mb250cy5nb29nbGVhcGlzLmNvbS9jc3MyP2ZhbWlseT1JbnRlcjp3Z2h0QDQwMDs1MDA7NjAwOzcwMCZkaXNwbGF5PXN3YXAiIHJlbD0ic3R5bGVzaGVldCI+DQo8c3R5bGU+DQpodG1sLGJvZHl7bWFyZ2luOjA7cGFkZGluZzowO2ZvbnQtZmFtaWx5Oi1hcHBsZS1zeXN0ZW0sQmxpbmtNYWNTeXN0ZW1Gb250LCdTZWdvZSBVSScsUm9ib3RvLCdIZWx2ZXRpY2EgTmV1ZScsQXJpYWwsJ05vdG8gU2Fucycsc2Fucy1zZXJpZjtiYWNrZ3JvdW5kOiMxODE4MTg7Y29sb3I6I2U4ZThlODttaW4taGVpZ2h0OjEwMHZofQ0KLmhpZGViYXI6Oi13ZWJraXQtc2Nyb2xsYmFye2Rpc3BsYXk6bm9uZX0uaGlkZWJhcntzY3JvbGxiYXItd2lkdGg6bm9uZX0NCjo6LXdlYmtpdC1zY3JvbGxiYXJ7d2lkdGg6NnB4O2hlaWdodDo2cHh9DQo6Oi13ZWJraXQtc2Nyb2xsYmFyLXRodW1ie2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMTIpO2JvcmRlci1yYWRpdXM6NHB4fQ0KLmJke2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwyNTUsMjU1LC4xMil9DQouaW5we2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTYpO2JvcmRlci1yYWRpdXM6OHB4O2JhY2tncm91bmQ6IzJhMmEyYTtjb2xvcjojZThlOGU4O3BhZGRpbmc6OHB4IDExcHg7b3V0bGluZTpub25lO2ZvbnQtc2l6ZToxM3B4O3dpZHRoOjEwMCV9DQouaW5wOmZvY3Vze2JvcmRlci1jb2xvcjojNkY1REZGfQ0KLmJ0bntib3JkZXItcmFkaXVzOjEwcHg7Zm9udC13ZWlnaHQ6NjAwO3RyYW5zaXRpb246LjE1cztjdXJzb3I6cG9pbnRlcjtkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2dhcDo2cHg7Zm9udC1zaXplOjEzcHh9DQouYnRuLWJsdWV7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiAwJSwjMjdENENEIDU5LjclLCM3NEZGN0UgMTAwJSk7Ym9yZGVyOm5vbmU7Y29sb3I6I2ZmZjtib3gtc2hhZG93OjAgMCAxOHB4IHJnYmEoMTExLDkzLDI1NSwuMzUpO3BhZGRpbmc6MCAxOHB4fQ0KLmJ0bi1ibHVlOmhvdmVye2ZpbHRlcjpicmlnaHRuZXNzKDEuMSk7Ym94LXNoYWRvdzowIDAgMjRweCByZ2JhKDExMSw5MywyNTUsLjUpfQ0KLmJ0bi1ibHVlOmFjdGl2ZXt0cmFuc2Zvcm06c2NhbGUoLjk4KX0NCi5idG4tZ2hvc3R7Y29sb3I6I2ExYTFhYTtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxcHggc29saWQgdHJhbnNwYXJlbnR9LmJ0bi1naG9zdDpob3ZlcntiYWNrZ3JvdW5kOiMyYTJhMmE7Y29sb3I6I2U4ZThlOH0NCi50YWJ7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtwYWRkaW5nOjZweCAxMnB4O2JvcmRlci1yYWRpdXM6OHB4O2ZvbnQtc2l6ZToxM3B4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7Zm9udC13ZWlnaHQ6NTAwO3doaXRlLXNwYWNlOm5vd3JhcDt0cmFuc2l0aW9uOi4xMnN9DQoudGFiOmhvdmVye2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMmEyYTJhfS50YWIuc2Vse2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMmEyYTJhfQ0KLnRhYiAuZG90e3dpZHRoOjZweDtoZWlnaHQ6NnB4O2JvcmRlci1yYWRpdXM6NTAlO2Rpc3BsYXk6aW5saW5lLWJsb2NrfQ0KLnRhYi5zZWwgLmRvdHtkaXNwbGF5Om5vbmV9DQoudGFiLnNlbDo6YWZ0ZXJ7Y29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtib3R0b206LTFweDtsZWZ0OjUwJTt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNTAlKTt3aWR0aDoyMHB4O2hlaWdodDoycHg7Ym9yZGVyLXJhZGl1czoycHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiwjMjdENENEKTtwb3NpdGlvbjphYnNvbHV0ZX0NCi50YWJ7cG9zaXRpb246cmVsYXRpdmV9DQouc2xpZGVyey13ZWJraXQtYXBwZWFyYW5jZTpub25lO2FwcGVhcmFuY2U6bm9uZTtoZWlnaHQ6NHB4O2JvcmRlci1yYWRpdXM6NHB4O2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMTQpO291dGxpbmU6bm9uZTt3aWR0aDoxMDAlfQ0KLnNsaWRlcjo6LXdlYmtpdC1zbGlkZXItdGh1bWJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7YXBwZWFyYW5jZTpub25lO3dpZHRoOjE1cHg7aGVpZ2h0OjE1cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDojZmZmO2JvcmRlcjozcHggc29saWQgIzZGNURGRjtjdXJzb3I6cG9pbnRlcjtib3gtc2hhZG93OjAgMCA2cHggcmdiYSgxMTEsOTMsMjU1LC40KTt0cmFuc2l0aW9uOi4xMnN9DQouc2xpZGVyOjotd2Via2l0LXNsaWRlci10aHVtYjpob3Zlcnt0cmFuc2Zvcm06c2NhbGUoMS4xKX0NCi5sb3JhLXNsey13ZWJraXQtYXBwZWFyYW5jZTpub25lO2FwcGVhcmFuY2U6bm9uZTtoZWlnaHQ6NHB4O2JvcmRlci1yYWRpdXM6NHB4O2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMTIpO291dGxpbmU6bm9uZX0NCi5sb3JhLXNsOjotd2Via2l0LXNsaWRlci10aHVtYnstd2Via2l0LWFwcGVhcmFuY2U6bm9uZTt3aWR0aDoxNHB4O2hlaWdodDoxNHB4O2JvcmRlci1yYWRpdXM6NTAlO2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MnB4IHNvbGlkICM2RjVERkY7Y3Vyc29yOnBvaW50ZXJ9DQoubG9yYS1jYXJke3Bvc2l0aW9uOnJlbGF0aXZlO2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTIpO2JvcmRlci1yYWRpdXM6MTBweDtiYWNrZ3JvdW5kOiMyYTJhMmE7dHJhbnNpdGlvbjouMTJzO3BhZGRpbmc6OHB4IDEwcHggMTBweH0NCi5sb3JhLWNhcmQ6aG92ZXJ7Ym9yZGVyLWNvbG9yOnJnYmEoMjU1LDI1NSwyNTUsLjI0KX0NCi5sb3JhLWxhYmVse3Bvc2l0aW9uOmFic29sdXRlO3RvcDowO2xlZnQ6MDtmb250LXNpemU6OXB4O2NvbG9yOiM5YTlhYTI7YmFja2dyb3VuZDojMzMzO2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMSk7cGFkZGluZzoycHggNnB4O2JvcmRlci1yYWRpdXM6NnB4O2JvcmRlci10b3AtbGVmdC1yYWRpdXM6MTBweDtib3JkZXItYm90dG9tLXJpZ2h0LXJhZGl1czo2cHg7ei1pbmRleDoyfQ0KLmxvcmEtdG9we2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDttYXJnaW4tdG9wOjhweH0NCi5sb3JhLXRodW1ie3dpZHRoOjM0cHg7aGVpZ2h0OjM0cHg7Ym9yZGVyLXJhZGl1czo2cHg7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xMik7b2JqZWN0LWZpdDpjb3ZlcjtmbGV4LXNocmluazowfQ0KLmxvcmEtbmFtZXtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo2MDA7Y29sb3I6I2U4ZThlODtmbGV4OjE7bWluLXdpZHRoOjA7d2hpdGUtc3BhY2U6bm93cmFwO292ZXJmbG93OmhpZGRlbjt0ZXh0LW92ZXJmbG93OmVsbGlwc2lzfQ0KLmxvcmEtaWNvbnN7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MnB4O2ZsZXgtc2hyaW5rOjB9DQoubG9yYS1pY29ue3dpZHRoOjIycHg7aGVpZ2h0OjIycHg7Ym9yZGVyLXJhZGl1czo0cHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOiM3MTcxN2E7YmFja2dyb3VuZDp0cmFuc3BhcmVudDt0cmFuc2l0aW9uOi4xMnN9DQoubG9yYS1pY29uOmhvdmVye2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMDgpO2NvbG9yOiNmZmZ9DQoubG9yYS1pY29uLmRlbDpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoMjM5LDY4LDY4LC4xNSk7Y29sb3I6I2VmNDQ0NH0NCi5sb3JhLWljb24gc3Zne3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7c3Ryb2tlOmN1cnJlbnRDb2xvcjtmaWxsOm5vbmU7c3Ryb2tlLXdpZHRoOjJ9DQoubG9yYS1zbGlkZXItcm93e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjRweDttYXJnaW4tdG9wOjZweH0NCi5sLXNsaWRlcntwb3NpdGlvbjpyZWxhdGl2ZTtmbGV4OjE7aGVpZ2h0OjE2cHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcn0NCi5sLXRyYWNre3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDtyaWdodDowO2hlaWdodDo0cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDpyZ2JhKDI1NSwyNTUsMjU1LC4xMyl9DQoubC1maWxse3Bvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDt0b3A6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC01MCUpO2hlaWdodDo0cHg7Ym9yZGVyLXJhZGl1czo0cHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiwjMjdENENEKX0NCi5sLWhhbmRsZXtwb3NpdGlvbjphYnNvbHV0ZTt0b3A6NTAlO3RyYW5zZm9ybTp0cmFuc2xhdGUoLTUwJSwtNTAlKTt3aWR0aDoxNHB4O2hlaWdodDoxNHB4O2JvcmRlci1yYWRpdXM6NTAlO2JhY2tncm91bmQ6I2ZmZjtib3JkZXI6MnB4IHNvbGlkICM2RjVERkY7Ym94LXNoYWRvdzowIDFweCAzcHggcmdiYSgwLDAsMCwuNCk7cG9pbnRlci1ldmVudHM6bm9uZX0NCi5sb3JhLXNse3Bvc2l0aW9uOmFic29sdXRlO2luc2V0OjA7d2lkdGg6MTAwJTtoZWlnaHQ6MTAwJTtvcGFjaXR5OjA7Y3Vyc29yOnBvaW50ZXJ9DQoubC1udW17ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MnB4O2ZsZXgtc2hyaW5rOjB9DQoubG9yYS1pbnB1dHt3aWR0aDozMHB4O2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTUpO2JvcmRlci1yYWRpdXM6NnB4O2JhY2tncm91bmQ6IzE4MTgxODtjb2xvcjojZThlOGU4O2ZvbnQtc2l6ZToxMnB4O3RleHQtYWxpZ246Y2VudGVyO291dGxpbmU6bm9uZTtwYWRkaW5nOjRweCAwfQ0KLmxvcmEtaW5wdXQ6Zm9jdXN7Ym9yZGVyLWNvbG9yOiM2RjVERkZ9DQoubG9yYS11cmwtaW5we2ZvbnQtc2l6ZToxMXB4O3BhZGRpbmc6NnB4IDlweDttYXJnaW4tdG9wOjJweH0NCi5sb3JhLWJ0bnt3aWR0aDoyMnB4O2hlaWdodDoyMnB4O2JvcmRlci1yYWRpdXM6NTAlO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjb2xvcjojOWE5YWEyO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOm5vbmU7dHJhbnNpdGlvbjouMTJzfQ0KLmxvcmEtYnRuOmhvdmVye2JhY2tncm91bmQ6cmdiYSgyNTUsMjU1LDI1NSwuMSk7Y29sb3I6I2ZmZn0NCi5sb3JhLWJ0biBzdmd7d2lkdGg6MTRweDtoZWlnaHQ6MTRweDtzdHJva2U6Y3VycmVudENvbG9yO2ZpbGw6bm9uZTtzdHJva2Utd2lkdGg6MjtzdHJva2UtbGluZWNhcDpyb3VuZH0NCi50YWd7YmFja2dyb3VuZDojMmEyYTJhO2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTIpO2NvbG9yOiNlMGUwZTA7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjRweDtmb250LXNpemU6MTJweDtwYWRkaW5nOjRweCA4cHg7Ym9yZGVyLXJhZGl1czo2cHh9DQouYXJ7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xMik7Ym9yZGVyLXJhZGl1czoxMHB4O2JhY2tncm91bmQ6IzJhMmEyYTtjb2xvcjojZmZmO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Z2FwOjJweDtwYWRkaW5nOjhweCAycHg7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjouMTJzO21pbi13aWR0aDowfQ0KLmFyOmhvdmVye2JvcmRlci1jb2xvcjpyZ2JhKDI1NSwyNTUsMjU1LC4zKX0NCi5hci5zZWx7Ym9yZGVyLWNvbG9yOiMyN0Q0Q0Q7YmFja2dyb3VuZDojMjIyfQ0KLmFyLnNlbCAuYXItZGVzY3tjb2xvcjojMjdENENEfQ0KLmFyLWljb3t3aWR0aDoyNHB4O2hlaWdodDoyNHB4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcn0NCi5hci1pY28gc3Zne3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCV9DQouYXItbmFtZXtmb250LXNpemU6MTFweDtjb2xvcjojZThlOGU4O3doaXRlLXNwYWNlOm5vd3JhcH0NCi5hci1kZXNje2ZvbnQtc2l6ZTo5cHg7Y29sb3I6IzlhOWFhMjt3aGl0ZS1zcGFjZTpub3dyYXB9DQouZmllbGR7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6M3B4fQ0KLnJ0YWJ7Ym9yZGVyOjFweCBzb2xpZCB0cmFuc3BhcmVudDtib3JkZXItcmFkaXVzOjZweDtwYWRkaW5nOjRweCAxMHB4O2ZvbnQtc2l6ZToxMnB4O2NvbG9yOiM5YTlhYTI7Y3Vyc29yOnBvaW50ZXI7YmFja2dyb3VuZDp0cmFuc3BhcmVudH0NCi5ydGFiOmhvdmVye2NvbG9yOiNmZmZ9LnJ0YWIuc2Vse2JhY2tncm91bmQ6IzJhMmEyYTtjb2xvcjojZmZmfQ0KLnJjYXJke2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTIpO2JvcmRlci1yYWRpdXM6MTBweDtvdmVyZmxvdzpoaWRkZW47YmFja2dyb3VuZDojMjIyfQ0KLmNoaXB7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xMik7Ym9yZGVyLXJhZGl1czo2cHg7cGFkZGluZzo0cHggMTBweDtmb250LXNpemU6MTJweDtjb2xvcjojOWE5YWEyO2N1cnNvcjpwb2ludGVyO2JhY2tncm91bmQ6IzJhMmEyYTt0cmFuc2l0aW9uOi4xMnN9DQouY2hpcDpob3Zlcntjb2xvcjojZmZmfS5jaGlwLm9ue2JvcmRlci1jb2xvcjojNkY1REZGO2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMjIyfQ0KI3RvYXN0e2JveC1zaGFkb3c6MCA4cHggMzBweCByZ2JhKDAsMCwwLC41KX0NCkBtZWRpYSAobWF4LXdpZHRoOjEwMjNweCl7I3JpZ2h0UGFuLm1vYmlsZS1vcGVue3Bvc2l0aW9uOmZpeGVkO3RvcDo1NnB4O3JpZ2h0OjA7Ym90dG9tOjA7bGVmdDphdXRvO3otaW5kZXg6NDA7ZGlzcGxheTpmbGV4O3dpZHRoOm1pbigyMXJlbSw5MnZ3KTtib3gtc2hhZG93Oi04cHggMCAzMHB4IHJnYmEoMCwwLDAsLjUpfX0NCnRleHRhcmVhe2NhcmV0LWNvbG9yOiM2RjVERkZ9DQppbnB1dFt0eXBlPWNoZWNrYm94XXt3aWR0aDoxNHB4O2hlaWdodDoxNHB4O2N1cnNvcjpwb2ludGVyfQ0KaW5wdXRbdHlwZT1yYW5nZV17Y3Vyc29yOnBvaW50ZXJ9DQo6Zm9jdXMtdmlzaWJsZXtvdXRsaW5lOjJweCBzb2xpZCAjNkY1REZGO291dGxpbmUtb2Zmc2V0OjJweH0NCi53dm51bXtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsLjE2KTtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOiMyYTJhMmE7Y29sb3I6I2U4ZThlODtwYWRkaW5nOjNweCA2cHg7d2lkdGg6NjRweDtmb250LXNpemU6MTJweDt0ZXh0LWFsaWduOnJpZ2h0O291dGxpbmU6bm9uZX0NCi53dm51bTpmb2N1c3tib3JkZXItY29sb3I6IzI3RDRDRH0NCi5tdGFie3BhZGRpbmc6OHB4IDE0cHg7Ym9yZGVyLXJhZGl1czo4cHg7Zm9udC1zaXplOjEzcHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtmb250LXdlaWdodDo1MDA7d2hpdGUtc3BhY2U6bm93cmFwO3RyYW5zaXRpb246LjEyc30NCi5tdGFiOmhvdmVye2NvbG9yOiNmZmY7YmFja2dyb3VuZDojMmEyYTJhfS5tdGFiLnNlbHtjb2xvcjojZmZmO2JhY2tncm91bmQ6IzJhMmEyYTtib3JkZXItYm90dG9tOjJweCBzb2xpZCAjNkY1REZGfQ0KLm1jaGlwe2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTUsMjU1LDI1NSwuMTIpO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NHB4IDEwcHg7Zm9udC1zaXplOjEycHg7Y29sb3I6IzlhOWFhMjtjdXJzb3I6cG9pbnRlcjtiYWNrZ3JvdW5kOiMyYTJhMmE7dHJhbnNpdGlvbjouMTJzO3doaXRlLXNwYWNlOm5vd3JhcH0NCi5tY2hpcDpob3Zlcntjb2xvcjojZmZmfS5tY2hpcC5vbntib3JkZXItY29sb3I6IzZGNURGRjtjb2xvcjojZmZmO2JhY2tncm91bmQ6cmdiYSgxMTEsOTMsMjU1LC4xNSl9DQoubWNhcmR7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDI1NSwyNTUsMjU1LC4xMik7Ym9yZGVyLXJhZGl1czoxMHB4O292ZXJmbG93OmhpZGRlbjtiYWNrZ3JvdW5kOiMyYTJhMmE7dHJhbnNpdGlvbjouMTVzfQ0KLm1jYXJkOmhvdmVye2JvcmRlci1jb2xvcjpyZ2JhKDExMSw5MywyNTUsLjU1KTt0cmFuc2Zvcm06dHJhbnNsYXRlWSgtMnB4KTtib3gtc2hhZG93OjAgNnB4IDE4cHggcmdiYSgwLDAsMCwuMzUpfQ0KLm1jYXJkLWltZ3twb3NpdGlvbjpyZWxhdGl2ZTthc3BlY3QtcmF0aW86My80O292ZXJmbG93OmhpZGRlbn0NCi5tY2FyZC1pbWcgaW1ne3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7b2JqZWN0LWZpdDpjb3Zlcjt0cmFuc2l0aW9uOi4zc30NCi5tY2FyZDpob3ZlciAubWNhcmQtaW1nIGltZ3t0cmFuc2Zvcm06c2NhbGUoMS4wNSl9DQoubWNhcmQtYmFkZ2V7cG9zaXRpb246YWJzb2x1dGU7dG9wOjZweDtsZWZ0OjZweDtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjY1KTtiYWNrZHJvcC1maWx0ZXI6Ymx1cig0cHgpO2ZvbnQtc2l6ZToxMHB4O3BhZGRpbmc6MnB4IDZweDtib3JkZXItcmFkaXVzOjRweDtjb2xvcjojZThlOGU4O2ZvbnQtd2VpZ2h0OjUwMH0NCi5tY2FyZC1zdGFye3Bvc2l0aW9uOmFic29sdXRlO3RvcDo2cHg7cmlnaHQ6NnB4O3dpZHRoOjI2cHg7aGVpZ2h0OjI2cHg7Ym9yZGVyLXJhZGl1czo1MCU7YmFja2dyb3VuZDpyZ2JhKDAsMCwwLC41KTtiYWNrZHJvcC1maWx0ZXI6Ymx1cig0cHgpO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjdXJzb3I6cG9pbnRlcjtjb2xvcjojOWE5YWEyO3RyYW5zaXRpb246LjEyc30NCi5tY2FyZC1zdGFyOmhvdmVye2NvbG9yOiNlYWIzMDh9Lm1jYXJkLXN0YXIub257Y29sb3I6I2VhYjMwOH0NCi5tY2FyZC12aWV3c3twb3NpdGlvbjphYnNvbHV0ZTtib3R0b206NnB4O2xlZnQ6NnB4O2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuNik7YmFja2Ryb3AtZmlsdGVyOmJsdXIoNHB4KTtmb250LXNpemU6MTBweDtwYWRkaW5nOjJweCA2cHg7Ym9yZGVyLXJhZGl1czo0cHg7Y29sb3I6I2U4ZThlODtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDozcHh9DQoubWNhcmQtaW5mb3twYWRkaW5nOjhweH0NCi5tY2FyZC1uYW1le2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjojZThlOGU4O3doaXRlLXNwYWNlOm5vd3JhcDtvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpc30NCi5tY2FyZC1tZXRhe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47bWFyZ2luLXRvcDo2cHh9DQoubWNhcmQtdmVye2ZvbnQtc2l6ZToxMXB4O2NvbG9yOiM5YTlhYTI7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjU1LDI1NSwyNTUsLjEyKTtib3JkZXItcmFkaXVzOjRweDtwYWRkaW5nOjJweCA2cHh9DQoubWNhcmQtc2Vse2ZvbnQtc2l6ZToxMXB4O2JvcmRlcjoxcHggc29saWQgIzZGNURGRjtjb2xvcjojNkY1REZGO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyLXJhZGl1czo0cHg7cGFkZGluZzoycHggMTBweDtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjouMTJzfQ0KLm1jYXJkLXNlbDpob3ZlcntiYWNrZ3JvdW5kOiM2RjVERkY7Y29sb3I6I2ZmZn0NCjwvc3R5bGU+DQo8L2hlYWQ+DQo8Ym9keT4NCg0KPGhlYWRlciBjbGFzcz0iZml4ZWQgdG9wLTAgbGVmdC0wIHJpZ2h0LTAgei00MCBoLTE0IGJnLVsjMTgxODE4XS84NSBiYWNrZHJvcC1ibHVyIGJvcmRlci1iIGJkIGZsZXggaXRlbXMtY2VudGVyIHB4LTIgc206cHgtMyBnYXAtMiI+DQogIDxidXR0b24gaWQ9Im1tZW51IiBjbGFzcz0ibGc6aGlkZGVuIHRleHQtbmV1dHJhbC00MDAgcC0xIj48aSBkYXRhLWljb249Imxpc3QiIGNsYXNzPSJ3LTUgaC01Ij48L2k+PC9idXR0b24+DQogIDxkaXYgY2xhc3M9InctNiBoLTYgc2hyaW5rLTAgaGlkZGVuIHNtOmZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIj4NCiAgICA8c3ZnIHdpZHRoPSIyMiIgaGVpZ2h0PSIyMiIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj48cmVjdCB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHJ4PSI1IiBmaWxsPSJ1cmwoI2cpIi8+PHBhdGggZD0iTTcgMTIuNWwzIDMgNy03IiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+PGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIyNCIgeTI9IjI0Ij48c3RvcCBzdG9wLWNvbG9yPSIjNkY1REZGIi8+PHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNkY1REZGIi8+PC9saW5lYXJHcmFkaWVudD48L2RlZnM+PC9zdmc+DQogIDwvZGl2Pg0KICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMC41IGhpZGViYXIgb3ZlcmZsb3cteC1hdXRvIGZsZXgtMSI+DQogICAgPGRpdiBjbGFzcz0idGFiIHNlbCIgZGF0YS10YWI9InRleHQiPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOiM2RjVERkYiPjwvc3Bhbj5UZXh0MkltZzwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9InRhYiIgZGF0YS10YWI9ImltZyI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6IzIyYzU1ZSI+PC9zcGFuPkltZzJJbWc8L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJ0YWIiIGRhdGEtdGFiPSJlZGl0Ij48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDojZWFiMzA4Ij48L3NwYW4+RWRpdDwvZGl2Pg0KICAgIDxkaXYgY2xhc3M9InRhYiIgZGF0YS10YWI9InZpZGVvIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDojZWY0NDQ0Ij48L3NwYW4+VmlkZW88L2Rpdj4NCiAgICA8ZGl2IGNsYXNzPSJ0YWIiIGRhdGEtdGFiPSJwcmltZSI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6IzNiODJmNiI+PC9zcGFuPlByaW1lPC9kaXY+DQogIDwvZGl2Pg0KICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41IHNtOmdhcC0yIG1sLWF1dG8gc2hyaW5rLTAiPg0KICAgIDxidXR0b24gaWQ9Im5jb2wiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNDAwIGhvdmVyOnRleHQtd2hpdGUgcC0xLjUgaGlkZGVuIHNtOmZsZXggaXRlbXMtY2VudGVyIGdhcC0xIHRleHQteHMiIHRpdGxlPSJKdW1sYWgga29sb20iPjxpIGRhdGEtaWNvbj0ic3F1YXJlcy1mb3VyIiBjbGFzcz0idy00IGgtNCI+PC9pPjxzcGFuIGlkPSJuY29sbGJsIj4yPC9zcGFuPjwvYnV0dG9uPg0KICAgIDxidXR0b24gaWQ9ImJ0bi1nbyIgY2xhc3M9ImJ0biBidG4tYmx1ZSBoLTEwIHB4LTQgc206cHgtNSB3aGl0ZXNwYWNlLW5vd3JhcCI+DQogICAgICA8aSBkYXRhLWljb249InBsYXkiIGNsYXNzPSJ3LTQgaC00Ij48L2k+R2VuZXJhdGUNCiAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIG9wYWNpdHktOTAgZm9udC1ub3JtYWwiIGlkPSJwcmljZSI+KyQwLjMzPC9zcGFuPg0KICAgIDwvYnV0dG9uPg0KICA8L2Rpdj4NCjwvaGVhZGVyPg0KDQo8ZGl2IGlkPSJvdmVybGF5IiBjbGFzcz0iZml4ZWQgaW5zZXQtMCBiZy1ibGFjay82MCB6LTMwIGhpZGRlbiBsZzpoaWRkZW4iPjwvZGl2Pg0KDQo8ZGl2IGNsYXNzPSJwdC0xNCBmbGV4IGgtW2NhbGMoMTAwdmgtNTZweCldIG92ZXJmbG93LWhpZGRlbiI+DQoNCiAgPCEtLSBMRUZUIFBBTkVMIC0tPg0KICA8YXNpZGUgaWQ9ImxlZnRwYW4iIGNsYXNzPSJmaXhlZCBsZzpzdGF0aWMgei00MCBpbnNldC15LTAgbGVmdC0wIHB0LTE0IGxnOnB0LTAgdy1bMjJyZW1dIG1heC13LVs4OHZ3XSAtdHJhbnNsYXRlLXgtZnVsbCBsZzp0cmFuc2xhdGUteC0wIHRyYW5zaXRpb24tdHJhbnNmb3JtIGR1cmF0aW9uLTIwMCBzaHJpbmstMCBib3JkZXItciBiZCBvdmVyZmxvdy15LWF1dG8gaGlkZWJhciBiZy1bIzIyMl0iPg0KICAgIDxkaXYgY2xhc3M9InAtNCBzcGFjZS15LTQiPg0KDQogICAgICA8IS0tIFByb21wdCBibG9jayAodG9wIG9mIGxlZnQgcGFuZWwsIGxpa2UgVGVuc29yQXJ0KSAtLT4NCiAgICAgIDxkaXYgY2xhc3M9InJvdW5kZWQteGwgYmctWyMyYTJhMmFdIGJvcmRlciBiZCBvdmVyZmxvdy1oaWRkZW4iPg0KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLXN0YXJ0IGdhcC0yIHB4LTMgcHQtMiI+DQogICAgICAgICAgPHRleHRhcmVhIGlkPSJwcm9tcHQiIHJvd3M9IjMiIGNsYXNzPSJ3LWZ1bGwgYmctdHJhbnNwYXJlbnQgYm9yZGVyLTAgb3V0bGluZS1ub25lIHJlc2l6ZS1ub25lIHRleHQtWzE1cHhdIHRleHQtbmV1dHJhbC0xMDAgcGxhY2Vob2xkZXItbmV1dHJhbC02MDAgbGVhZGluZy1yZWxheGVkIiBwbGFjZWhvbGRlcj0iSmVsYXNrYW4gYXBhIHlhbmcgaW5naW4ga2FtdSBidWF0Li4uIj48L3RleHRhcmVhPg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIHB4LTMgcHktMiI+DQogICAgICAgICAgPGxhYmVsIGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41IGN1cnNvci1wb2ludGVyIHNlbGVjdC1ub25lIj4NCiAgICAgICAgICAgIDxpbnB1dCBpZD0ibmVnY2hlY2siIHR5cGU9ImNoZWNrYm94IiBjbGFzcz0iYWNjZW50LVsjNkY1REZGXSIvPg0KICAgICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTQwMCI+TmVnYXRpdmU8L3NwYW4+DQogICAgICAgICAgPC9sYWJlbD4NCiAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41Ij4NCiAgICAgICAgICAgIDxidXR0b24gaWQ9ImJ0bi1lbmhhbmNlIiBjbGFzcz0idGV4dC14cyB0ZXh0LVsjNkY1REZGXSBob3Zlcjp1bmRlcmxpbmUgZm9udC1tZWRpdW0gZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEiPjxpIGRhdGEtaWNvbj0ic3BhcmtsZSIgY2xhc3M9InctMy41IGgtMy41Ij48L2k+RW5oYW5jZTwvYnV0dG9uPg0KICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImNoaXAiIGlkPSJjaGlwLWExMTExIj5BMTExMTwvc3Bhbj4NCiAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJjaGlwIiBpZD0iY2hpcC1lbGxhIj5FbGxhPC9zcGFuPg0KICAgICAgICAgIDwvZGl2Pg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgPGRpdiBpZD0ibmVnd3JhcCIgY2xhc3M9ImhpZGRlbiBib3JkZXItdCBiZCBweC00IHB5LTMiPg0KICAgICAgICAgIDx0ZXh0YXJlYSBpZD0ibmVncHJvbXB0IiByb3dzPSIyIiBjbGFzcz0idy1mdWxsIGJnLXRyYW5zcGFyZW50IGJvcmRlci0wIG91dGxpbmUtbm9uZSByZXNpemUtbm9uZSB0ZXh0LVsxM3B4XSB0ZXh0LW5ldXRyYWwtMTAwIHBsYWNlaG9sZGVyLW5ldXRyYWwtNjAwIiBwbGFjZWhvbGRlcj0iTmVnYXRpdmUgcHJvbXB0Li4uIj48L3RleHRhcmVhPg0KICAgICAgICA8L2Rpdj4NCiAgICAgIDwvZGl2Pg0KDQogICAgICA8IS0tIE1vZGVsIC0tPg0KICAgICAgPGRpdiBpZD0ibW9kZWwtY2FyZCIgY2xhc3M9InJlbGF0aXZlIGJvcmRlciBiZCByb3VuZGVkLXhsIGJnLVsjMmEyYTJhXSBob3Zlcjpib3JkZXItW3JnYmEoMjU1LDI1NSwyNTUsLjI0KV0gY3Vyc29yLXBvaW50ZXIgcC0zIj4NCiAgICAgICAgPHNwYW4gaWQ9Im1vZGVsLWJhZGdlIiBjbGFzcz0iYWJzb2x1dGUgdG9wLTAgbGVmdC0wIHRleHQtWzlweF0gdGV4dC1uZXV0cmFsLTQwMCBiZy1bIzMzM10gYm9yZGVyIGJkIHB4LTIgcHktMC41IHJvdW5kZWQtdGwteGwgcm91bmRlZC1ici1tZCB6LTEwIj5CYXNpYyBNb2RlbCAtIFogSW1hZ2U8L3NwYW4+DQogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0zIG10LTIiPg0KICAgICAgICAgIDxpbWcgaWQ9Im1vZGVsLXRodW1iIiBzcmM9Imh0dHBzOi8vcGljc3VtLnBob3Rvcy9zZWVkL3ppbWFnZS82NCIgY2xhc3M9InctMTYgaC0xNiByb3VuZGVkLWxnIG9iamVjdC1jb3ZlciBzaHJpbmstMCBib3JkZXIgYmQiIGFsdD0ibW9kZWwiLz4NCiAgICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4LTEgbWluLXctMCI+DQogICAgICAgICAgICA8ZGl2IGlkPSJtb2RlbC1uYW1lIiBjbGFzcz0iZm9udC1zZW1pYm9sZCB0ZXh0LXNtIHRydW5jYXRlIj5aIEltYWdlIC0gYmFzZS1iZjE2PC9kaXY+DQogICAgICAgICAgPC9kaXY+DQogICAgICAgICAgPGJ1dHRvbiBpZD0ibW9kZWwtaW5mbyIgY2xhc3M9InctNiBoLTYgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcm91bmRlZCB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgaG92ZXI6YmctW3JnYmEoMjU1LDI1NSwyNTUsLjA4KV0gdHJhbnNpdGlvbiIgdGl0bGU9IkluZm8iPg0KICAgICAgICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIgY2xhc3M9InctNCBoLTQiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjEwIi8+PGxpbmUgeDE9IjEyIiB5MT0iMTYiIHgyPSIxMiIgeTI9IjEyIi8+PGxpbmUgeDE9IjEyIiB5MT0iOCIgeDI9IjEyLjAxIiB5Mj0iOCIvPjwvc3ZnPg0KICAgICAgICAgIDwvYnV0dG9uPg0KICAgICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiIGNsYXNzPSJ3LTQgaC00IHRleHQtbmV1dHJhbC01MDAgc2hyaW5rLTAiPjxwb2x5bGluZSBwb2ludHM9IjkgMTggMTUgMTIgOSA2Ii8+PC9zdmc+DQogICAgICAgIDwvZGl2Pg0KICAgICAgPC9kaXY+DQoNCiAgICAgIDwhLS0gTG9SQSAtLT4NCiAgICAgIDxkaXY+DQogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiBtYi0yIj4NCiAgICAgICAgICA8c3BhbiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5Mb1JBPC9zcGFuPg0KICAgICAgICAgIDxpIGRhdGEtaWNvbj0iY2FyZXQtZG93biIgY2xhc3M9InctNCBoLTQgdGV4dC1uZXV0cmFsLTUwMCI+PC9pPg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgIDxkaXYgaWQ9ImxvcmEtbGlzdCIgY2xhc3M9InNwYWNlLXktMiI+PC9kaXY+DQogICAgICAgPC9kaXY+DQoNCiAgICAgICA8ZGl2Pg0KICAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIj4NCiAgICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+VHJpZ2dlciBXb3Jkczwvc3Bhbj4NCiAgICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCI+KDxzcGFuIGlkPSJ0ci1jb3VudCI+MDwvc3Bhbj4pPC9zcGFuPg0KICAgICAgICAgPC9kaXY+DQogICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gbXQtMSI+DQogICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAiPkFkZCBUcmlnZ2VyIFdvcmRzIHRvIFByb21wdHM8L3NwYW4+DQogICAgICAgICAgIDxidXR0b24gaWQ9ImFkZGFsbC10cmlnIiBjbGFzcz0idGV4dC14cyB0ZXh0LVsjNkY1REZGXSBob3Zlcjp1bmRlcmxpbmUgZm9udC1tZWRpdW0iPkFkZCBBbGw8L2J1dHRvbj4NCiAgICAgICAgIDwvZGl2Pg0KICAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBmbGV4LXdyYXAgZ2FwLTEuNSBtdC0yIiBpZD0idHJpZ2dlcnMiPjwvZGl2Pg0KICAgICAgIDwvZGl2Pg0KDQogICAgICA8IS0tIEFkZCBidXR0b25zIC0tPg0KICAgICAgPGRpdiBjbGFzcz0iZmxleCBnYXAtMiI+DQogICAgICAgIDxidXR0b24gaWQ9ImJ0bi1hZGRsb3JhIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBmbGV4LTEgaC05IGJvcmRlciBiZCB0ZXh0LXhzIj5BZGQgTG9SQTwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IGZsZXgtMSBoLTkgYm9yZGVyIGJkIHRleHQteHMiPkFkZCBFbWJlZGRpbmc8L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KICAgICAgPGRpdiBjbGFzcz0iZmxleCBnYXAtMiI+DQogICAgICAgIDxidXR0b24gY2xhc3M9ImJ0biBidG4tZ2hvc3QgZmxleC0xIGgtOSBib3JkZXIgYmQgdGV4dC14cyI+QWRkIENvbnRyb2xOZXQ8L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KDQogICAgICA8IS0tIFZBRSAtLT4NCiAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4NCiAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20iPlZBRTwvc3Bhbj4NCiAgICAgICAgPHNlbGVjdCBpZD0idmFlIiBjbGFzcz0iaW5wIj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJhdXRvbWF0aWMiPkF1dG9tYXRpYzwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Im5vbmUiPk5vbmU8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJ2YWUtZnQtbXNlLTg0MDAwMC1lbWEtcHJ1bmVkLmNrcHQiPnZhZS1mdC1tc2UtODQwMDAwLWVtYS1wcnVuZWQuY2twdDwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImtsLWY4LWFuaW1lLmNrcHQiPmtsLWY4LWFuaW1lLmNrcHQ8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJrbC1mOC1hbmltZTIuY2twdCI+a2wtZjgtYW5pbWUyLmNrcHQ8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJZT1pPUkEudmFlLnB0Ij5ZT1pPUkEudmFlLnB0PC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ib3JhbmdlbWl4LnZhZS5wdCI+b3JhbmdlbWl4LnZhZS5wdDwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImJsZXNzZWQyLnZhZS5wdCI+Ymxlc3NlZDIudmFlLnB0PC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYW5pbWV2YWUucHQiPmFuaW1ldmFlLnB0PC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iQ2xlYXJWQUUuc2FmZXRlbnNvcnMiPkNsZWFyVkFFLnNhZmV0ZW5zb3JzPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0icGFzdGVsLXdhaWZ1LWRpZmZ1c2lvbi52YWUucHQiPnBhc3RlbC13YWlmdS1kaWZmdXNpb24udmFlLnB0PC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iY3V0ZV92YWUuc2FmZXRlbnNvcnMiPmN1dGVfdmFlLnNhZmV0ZW5zb3JzPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2R4bF92YWUuc2FmZXRlbnNvcnMiPnNkeGxfdmFlLnNhZmV0ZW5zb3JzPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ic2R4bC12YWUtZnAxNi1maXguc2FmZXRlbnNvcnMiPnNkeGwtdmFlLWZwMTYtZml4LnNhZmV0ZW5zb3JzPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0ieGxWQUVDX2M5MS5zYWZldGVuc29ycyI+eGxWQUVDX2M5MS5zYWZldGVuc29yczwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9Imxhc3RwaWVjZVhMVkFFX2Jhc2VvbkEwODk3LnNhZmV0ZW5zb3JzIj5sYXN0cGllY2VYTFZBRV9iYXNlb25BMDg5Ny5zYWZldGVuc29yczwvb3B0aW9uPg0KICAgICAgICAgIDxvcHRpb24gdmFsdWU9InBsYXlncm91bmQtdjIuNS1mcDE2LXZhZS5zYWZldGVuc29ycyI+cGxheWdyb3VuZC12Mi41LWZwMTYtdmFlLnNhZmV0ZW5zb3JzPC9vcHRpb24+DQogICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iYWUuc2Z0Ij5hZS5zZnQ8L29wdGlvbj4NCiAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJwaXhlbF9zcGFjZSI+cGl4ZWxfc3BhY2U8L29wdGlvbj4NCiAgICAgICAgPC9zZWxlY3Q+DQogICAgICA8L2Rpdj4NCg0KICAgICAgPCEtLSBTZXR0aW5ncyAtLT4NCiAgICAgIDxkaXYgY2xhc3M9InNwYWNlLXktNCI+DQogICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPlNldHRpbmdzPC9zcGFuPg0KICAgICAgICA8ZGl2Pg0KICAgICAgICAgIDxkaXYgY2xhc3M9ImdyaWQgZ3JpZC1jb2xzLTQgZ2FwLTIiPg0KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYXIiIGRhdGEtYXI9InBvcnRyYWl0Ij4NCiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHg9IjYiIHk9IjIuNSIgd2lkdGg9IjEyIiBoZWlnaHQ9IjE5IiByeD0iMi41IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiLz48L3N2Zz48L3NwYW4+DQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5Qb3J0cmFpdDwvc3Bhbj4NCiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWRlc2MiPjc2OHgxMTUyPC9zcGFuPg0KICAgICAgICAgICAgPC9idXR0b24+DQogICAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJhciIgZGF0YS1hcj0ibGFuZHNjYXBlIj4NCiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxyZWN0IHg9IjIuNSIgeT0iNiIgd2lkdGg9IjE5IiBoZWlnaHQ9IjEyIiByeD0iMi41IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiLz48L3N2Zz48L3NwYW4+DQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5MYW5kc2NhcGU8L3NwYW4+DQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1kZXNjIj4xMTUyeDc2ODwvc3Bhbj4NCiAgICAgICAgICAgIDwvYnV0dG9uPg0KICAgICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYXIiIGRhdGEtYXI9InNxdWFyZSI+DQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1pY28iPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj48cmVjdCB4PSIyLjUiIHk9IjIuNSIgd2lkdGg9IjE5IiBoZWlnaHQ9IjE5IiByeD0iMi41IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIxLjYiLz48L3N2Zz48L3NwYW4+DQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1uYW1lIj5TcXVhcmU8L3NwYW4+DQogICAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJhci1kZXNjIj4xMDI0eDEwMjQ8L3NwYW4+DQogICAgICAgICAgICA8L2J1dHRvbj4NCiAgICAgICAgICAgIDxidXR0b24gY2xhc3M9ImFyIHNlbCIgZGF0YS1hcj0iY3VzdG9tIj4NCiAgICAgICAgICAgICAgPHNwYW4gY2xhc3M9ImFyLWljbyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPjxwYXRoIGQ9Ik00IDhoNU0xMyA4aDdNNCAxNmg5TTE3IDE2aDNNOSA1LjV2NU0xNyAxMy41djUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjEuOCIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIi8+PC9zdmc+PC9zcGFuPg0KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItbmFtZSI+Y3VzdG9tPC9zcGFuPg0KICAgICAgICAgICAgICA8c3BhbiBjbGFzcz0iYXItZGVzYyI+Y3VzdG9tPC9zcGFuPg0KICAgICAgICAgICAgPC9idXR0b24+DQogICAgICAgICAgPC9kaXY+DQogICAgICAgICAgPGRpdiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIG10LTEuNSIgaWQ9ImFyLWxhYmVsIj5jdXN0b208L2Rpdj4NCiAgICAgICAgPC9kaXY+DQogICAgICAgIDxkaXY+DQogICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIGl0ZW1zLWNlbnRlciI+PHNwYW4+V2lkdGg8L3NwYW4+DQogICAgICAgICAgICA8aW5wdXQgaWQ9Ind2IiB0eXBlPSJudW1iZXIiIG1pbj0iMjU2IiBtYXg9IjE1MzYiIHN0ZXA9IjY0IiB2YWx1ZT0iNzY4IiBjbGFzcz0id3ZudW0iLz48L2xhYmVsPg0KICAgICAgICAgIDxpbnB1dCBpZD0id2lkdGgiIHR5cGU9InJhbmdlIiBtaW49IjI1NiIgbWF4PSIxNTM2IiBzdGVwPSI2NCIgdmFsdWU9Ijc2OCIgY2xhc3M9InNsaWRlciBtdC0xIi8+DQogICAgICAgIDwvZGl2Pg0KICAgICAgICA8ZGl2Pg0KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiBpdGVtcy1jZW50ZXIiPjxzcGFuPkhlaWdodDwvc3Bhbj4NCiAgICAgICAgICAgIDxpbnB1dCBpZD0iaHYiIHR5cGU9Im51bWJlciIgbWluPSIyNTYiIG1heD0iMTUzNiIgc3RlcD0iNjQiIHZhbHVlPSIxMTUyIiBjbGFzcz0id3ZudW0iLz48L2xhYmVsPg0KICAgICAgICAgIDxpbnB1dCBpZD0iaGVpZ2h0IiB0eXBlPSJyYW5nZSIgbWluPSIyNTYiIG1heD0iMTUzNiIgc3RlcD0iNjQiIHZhbHVlPSIxMTUyIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4NCiAgICAgICAgPC9kaXY+DQogICAgICAgIDxkaXY+DQogICAgICAgICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIj4NCiAgICAgICAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIj5TYW1wbGluZyBNZXRob2Q8L3NwYW4+DQogICAgICAgICAgICA8YnV0dG9uIGlkPSJhZHYtdG9nZ2xlIiBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEiPjxpIGRhdGEtaWNvbj0iY2FyZXQtZG93biIgY2xhc3M9InctMy41IGgtMy41Ij48L2k+QWR2YW5jZWQ8L2J1dHRvbj4NCiAgICAgICAgICA8L2Rpdj4NCiAgICAgICAgICA8ZGl2IGNsYXNzPSJncmlkIGdyaWQtY29scy0yIGdhcC0yIG10LTEiPg0KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+U2FtcGxlcjwvbGFiZWw+DQogICAgICAgICAgICAgIDxzZWxlY3QgaWQ9InNhbXBsZXIiIGNsYXNzPSJpbnAgdGV4dC14cyI+DQogICAgICAgICAgICAgICAgPG9wdGlvbj5FdWxlciBhPC9vcHRpb24+PG9wdGlvbj5FdWxlcjwvb3B0aW9uPjxvcHRpb24+TE1TPC9vcHRpb24+PG9wdGlvbj5MTVMgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5ERElNPC9vcHRpb24+PG9wdGlvbj5MQ008L29wdGlvbj48b3B0aW9uPkhldW48L29wdGlvbj48b3B0aW9uPkRQTSBmYXN0PC9vcHRpb24+PG9wdGlvbj5EUE0yPC9vcHRpb24+PG9wdGlvbj5EUE0yIGE8L29wdGlvbj48b3B0aW9uPkRQTTIgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0yIGEgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyUyBhPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTTwvb3B0aW9uPjxvcHRpb24+RFBNKysgU0RFPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyUyBhIEthcnJhczwvb3B0aW9uPjxvcHRpb24+RFBNKysgMk0gS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0rKyBTREUgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBTREUgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5SZXN0YXJ0PC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBTREUgRXhwb25lbnRpYWw8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNERSBIZXVuPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBTREUgSGV1biBLYXJyYXM8L29wdGlvbj48b3B0aW9uPkRQTSsrIDJNIFNERSBIZXVuIEV4cG9uZW50aWFsPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAyTSBTR00gVW5pZm9ybTwvb3B0aW9uPjxvcHRpb24+RFBNKysgM00gU0RFPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAzTSBTREUgS2FycmFzPC9vcHRpb24+PG9wdGlvbj5EUE0rKyAzTSBTREUgRXhwb25lbnRpYWw8L29wdGlvbj48b3B0aW9uPmV1bGVyX2R5PC9vcHRpb24+PG9wdGlvbj5ldWxlcl9zbWVhX2R5PC9vcHRpb24+DQogICAgICAgICAgICAgIDwvc2VsZWN0PjwvZGl2Pg0KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPjxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+U2NoZWR1bGVyPC9sYWJlbD4NCiAgICAgICAgICAgICAgPHNlbGVjdCBpZD0ic2NoZWQiIGNsYXNzPSJpbnAgdGV4dC14cyI+PG9wdGlvbj5ub3JtYWw8L29wdGlvbj48b3B0aW9uPnNpbXBsZTwvb3B0aW9uPjxvcHRpb24+a2FycmFzPC9vcHRpb24+PG9wdGlvbj5leHBvbmVudGlhbDwvb3B0aW9uPjxvcHRpb24+c2dtX3VuaWZvcm08L29wdGlvbj48b3B0aW9uPmRkaW1fdW5pZm9ybTwvb3B0aW9uPjxvcHRpb24+YmV0YTwvb3B0aW9uPjxvcHRpb24+bGluZWFyX3F1YWRyYXRpYzwvb3B0aW9uPjwvc2VsZWN0PjwvZGl2Pg0KICAgICAgICAgIDwvZGl2Pg0KPGRpdiBjbGFzcz0ic3BhY2UteS0zIG10LTMiPg0KICAgICAgICAgICAgPGRpdj4NCiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TYW1wbGluZyBTdGVwczwvc3Bhbj48c3BhbiBpZD0ic3YiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj4xMDwvc3Bhbj48L2xhYmVsPg0KICAgICAgICAgICAgICA8aW5wdXQgaWQ9InN0ZXBzIiB0eXBlPSJyYW5nZSIgbWluPSIxIiBtYXg9IjUwIiB2YWx1ZT0iMTAiIGNsYXNzPSJzbGlkZXIgbXQtMSIvPg0KICAgICAgICAgICAgPC9kaXY+DQogICAgICAgICAgICA8ZGl2Pg0KICAgICAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkNGRyBTY2FsZTwvc3Bhbj48c3BhbiBpZD0iY2Z2IiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MTwvc3Bhbj48L2xhYmVsPg0KICAgICAgICAgICAgICA8aW5wdXQgaWQ9ImNmZyIgdHlwZT0icmFuZ2UiIG1pbj0iMSIgbWF4PSIxMCIgc3RlcD0iMC41IiB2YWx1ZT0iMSIgY2xhc3M9InNsaWRlciBtdC0xIi8+DQogICAgICAgICAgICA8L2Rpdj4NCiAgICAgICAgICAgIDxkaXY+DQogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2VlZDwvc3Bhbj48YnV0dG9uIGlkPSJkaWNlIiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCBob3Zlcjp0ZXh0LXdoaXRlIj48aSBkYXRhLWljb249ImRpY2UtZml2ZSIgY2xhc3M9InctNCBoLTQiPjwvaT48L2J1dHRvbj48L2xhYmVsPg0KICAgICAgICAgICAgICA8aW5wdXQgaWQ9InNlZWQiIGNsYXNzPSJpbnAgdGV4dC14cyBtdC0xIiB2YWx1ZT0iMTAxMDkzMzM0Nzk0MzQ2MiIvPg0KICAgICAgICAgICAgPC9kaXY+DQogICAgICAgICAgPC9kaXY+DQogICAgICAgICAgPGRpdiBpZD0iYWR2LWZpZWxkcyIgY2xhc3M9ImhpZGRlbiBzcGFjZS15LTMgbXQtNCBib3JkZXItdCBiZCBwdC0zIj4NCiAgICAgICAgICAgIDxkaXY+DQogICAgICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC14cyBmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q2xpcCBTa2lwPC9zcGFuPjxzcGFuIGlkPSJjc3YiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj4yPC9zcGFuPjwvbGFiZWw+DQogICAgICAgICAgICAgIDxpbnB1dCBpZD0iY2xpcHNraXAiIHR5cGU9InJhbmdlIiBtaW49IjEiIG1heD0iMTIiIHZhbHVlPSIyIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4NCiAgICAgICAgICAgIDwvZGl2Pg0KICAgICAgICAgICAgPGRpdj4NCiAgICAgICAgICAgICAgPGxhYmVsIGNsYXNzPSJ0ZXh0LXhzIGZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5FTlNEPC9zcGFuPjxzcGFuIGlkPSJlbnNkIiBjbGFzcz0idGV4dC1uZXV0cmFsLTUwMCI+MzEzMzc8L3NwYW4+PC9sYWJlbD4NCiAgICAgICAgICAgICAgPGlucHV0IGlkPSJldGFuc2QiIHR5cGU9InJhbmdlIiBtaW49IjAiIG1heD0iMzEzMzciIHZhbHVlPSIzMTMzNyIgY2xhc3M9InNsaWRlciBtdC0xIi8+DQogICAgICAgICAgICA8L2Rpdj4NCiAgICAgICAgICA8L2Rpdj4NCiAgICAgICAgPC9kaXY+DQoNCiAgICAgICAgPCEtLSBVcHNjYWxlIChzZXBhcmF0ZSwgZGkgYmF3YWgpIC0tPg0KICAgICAgICA8ZGl2IGNsYXNzPSJtdC00Ij4NCiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4gaXRlbXMtY2VudGVyIj48c3Bhbj5VcHNjYWxlPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj4yeDwvc3Bhbj48L2xhYmVsPg0KICAgICAgICAgIDxpbnB1dCBpZD0idXBzY2FsZSIgdHlwZT0icmFuZ2UiIG1pbj0iMSIgbWF4PSI0IiBzdGVwPSIwLjUiIHZhbHVlPSIyIiBjbGFzcz0ic2xpZGVyIG10LTEiLz4NCiAgICAgICAgPC9kaXY+DQogICAgICA8L2Rpdj4NCg0KICAgICAgPCEtLSBBUEkgU2V0dGluZ3MgLS0+DQogICAgICA8ZGl2IGNsYXNzPSJib3JkZXIgYmQgcm91bmRlZC14bCBiZy1bIzJhMmEyYV0gcC0zIHNwYWNlLXktMiI+DQogICAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktYmV0d2VlbiI+DQogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+QVBJPC9zcGFuPg0KICAgICAgICAgIDxzcGFuIGlkPSJhcGktc3RhdHVzIiBjbGFzcz0idGV4dC1bMTBweF0gdGV4dC1uZXV0cmFsLTUwMCI+PC9zcGFuPg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPg0KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+UHJvdmlkZXI8L2xhYmVsPg0KICAgICAgICAgIDxzZWxlY3QgaWQ9ImFwaXByb3ZpZGVyIiBjbGFzcz0iaW5wIHRleHQteHMiPg0KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0idGFtcyI+VGVuc29yLkFydCAoVEFNUyk8L29wdGlvbj4NCiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9InJlcGxpY2F0ZSI+UmVwbGljYXRlIChTRFhMKTwvb3B0aW9uPg0KICAgICAgICAgICAgPG9wdGlvbiB2YWx1ZT0iZmFsIj5mYWwuYWkgKGZhc3Qtc2R4bCk8L29wdGlvbj4NCiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9InBvbGxpbmF0aW9ucyI+UG9sbGluYXRpb25zIChHUkFUSVMsIHRhbnBhIGtleSk8L29wdGlvbj4NCiAgICAgICAgICA8L3NlbGVjdD4NCiAgICAgICAgPC9kaXY+DQogICAgICAgIDxkaXYgY2xhc3M9ImZpZWxkIj4NCiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQtWzExcHhdIHRleHQtbmV1dHJhbC01MDAiIGlkPSJhcGlrZXktbGFiZWwiPkFQSSBLZXkgVEFNUyAodGFtcy50ZW5zb3IuYXJ0KTwvbGFiZWw+DQogICAgICAgICAgPGlucHV0IGlkPSJhcGlrZXkiIHR5cGU9InBhc3N3b3JkIiBjbGFzcz0iaW5wIiBwbGFjZWhvbGRlcj0iQmVhcmVyIHRva2VuLi4uIiBhdXRvY29tcGxldGU9Im9mZiIvPg0KICAgICAgICA8L2Rpdj4NCiAgICAgICAgPGRpdiBpZD0iYXBpLWhpbnQiIGNsYXNzPSJ0ZXh0LVsxMHB4XSB0ZXh0LW5ldXRyYWwtNjAwIj48L2Rpdj4NCiAgICAgICAgPGRpdiBjbGFzcz0iZmllbGQiPg0KICAgICAgICAgIDxsYWJlbCBjbGFzcz0idGV4dC1bMTFweF0gdGV4dC1uZXV0cmFsLTUwMCI+TW9kZTwvbGFiZWw+DQogICAgICAgICAgPHNlbGVjdCBpZD0iYXBpbW9kZSIgY2xhc3M9ImlucCB0ZXh0LXhzIj4NCiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImF1dG8iPkF1dG8gKGJhY2tlbmQgJnJhcnI7IGRlbW8pPC9vcHRpb24+DQogICAgICAgICAgICA8b3B0aW9uIHZhbHVlPSJyZWFsIj5SZWFsIEFQSSAod2FqaWIgYmFja2VuZCk8L29wdGlvbj4NCiAgICAgICAgICAgIDxvcHRpb24gdmFsdWU9ImRlbW8iPkRlbW8gKHNpbXVsYXNpIHNhamEpPC9vcHRpb24+DQogICAgICAgICAgPC9zZWxlY3Q+DQogICAgICAgIDwvZGl2Pg0KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGdhcC0yIj4NCiAgICAgICAgICA8YnV0dG9uIGlkPSJhcGktc2F2ZSIgY2xhc3M9ImJ0biBidG4tZ2hvc3QgZmxleC0xIGgtOCBib3JkZXIgYmQgdGV4dC14cyI+U2ltcGFuPC9idXR0b24+DQogICAgICAgICAgPGJ1dHRvbiBpZD0iYXBpLXRlc3QiIGNsYXNzPSJidG4gYnRuLWdob3N0IGZsZXgtMSBoLTggYm9yZGVyIGJkIHRleHQteHMiPlRlczwvYnV0dG9uPg0KICAgICAgICA8L2Rpdj4NCiAgICAgIDwvZGl2Pg0KDQogICAgICA8IS0tIEJvdHRvbSAtLT4NCiAgICAgIDxkaXYgY2xhc3M9InB0LTEgYm9yZGVyLXQgYmQgc3BhY2UteS0yIj4NCiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYnRuIGJ0bi1naG9zdCB3LWZ1bGwgaC05IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+UGFzdGUgR2VuZXJhdGlvbiBEYXRhPC9zcGFuPjxpIGRhdGEtaWNvbj0iY2xpcGJvYXJkIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IHctZnVsbCBoLTkganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5QcmVzZXRzPC9zcGFuPjxpIGRhdGEtaWNvbj0iYm9va21hcmstc2ltcGxlIiBjbGFzcz0idy00IGgtNCI+PC9pPjwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIGNsYXNzPSJidG4gYnRuLWdob3N0IHctZnVsbCBoLTkganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5SZXNldDwvc3Bhbj48aSBkYXRhLWljb249ImtleSIgY2xhc3M9InctNCBoLTQiPjwvaT48L2J1dHRvbj4NCiAgICAgIDwvZGl2Pg0KICAgIDwvZGl2Pg0KICA8L2FzaWRlPg0KDQogIDwhLS0gQ0VOVEVSOiBpbWFnZSBncmlkIG9ubHkgLS0+DQogIDxtYWluIGlkPSJjYW52YXMiIGNsYXNzPSJmbGV4LTEgb3ZlcmZsb3cteS1hdXRvIGhpZGViYXIgYmctWyMxODE4MThdIj4NCiAgICA8ZGl2IGNsYXNzPSJwLTQgbWF4LXctM3hsIG14LWF1dG8iPg0KICAgICAgPCEtLSBJbWcySW1nIHVwbG9hZCAtLT4NCiAgICAgIDxkaXYgaWQ9ImltZzJpbWctY2FyZCIgY2xhc3M9ImhpZGRlbiBtYi00IGJvcmRlciBiZCByb3VuZGVkLXhsIGJnLVsjMjIyXSBwLTQiPg0KICAgICAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gbWItMiI+DQogICAgICAgICAgPHNwYW4gY2xhc3M9InRleHQtc20gZm9udC1zZW1pYm9sZCI+SW1nMkltZyDigJQgZ2FtYmFyIGF3YWw8L3NwYW4+DQogICAgICAgICAgPHNwYW4gaWQ9ImkyaS1jbGVhciIgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCBob3Zlcjp0ZXh0LXdoaXRlIGN1cnNvci1wb2ludGVyIj5IYXB1czwvc3Bhbj4NCiAgICAgICAgPC9kaXY+DQogICAgICAgIDxkaXYgaWQ9ImkyaS1kcm9wIiBjbGFzcz0iYm9yZGVyLTIgYm9yZGVyLWRhc2hlZCBiZCByb3VuZGVkLXhsIHAtNiB0ZXh0LWNlbnRlciBjdXJzb3ItcG9pbnRlciB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOmJvcmRlci1bIzZGNURGRl0gdGV4dC14cyI+DQogICAgICAgICAgS2xpayBhdGF1IHNlcmV0IGdhbWJhciBrZSBzaW5pDQogICAgICAgIDwvZGl2Pg0KICAgICAgICA8aW5wdXQgaWQ9ImkyaS1maWxlIiB0eXBlPSJmaWxlIiBhY2NlcHQ9ImltYWdlLyoiIGNsYXNzPSJoaWRkZW4iLz4NCiAgICAgICAgPGRpdiBpZD0iaTJpLXByZXZpZXciIGNsYXNzPSJoaWRkZW4gbXQtMyI+DQogICAgICAgICAgPGltZyBpZD0iaTJpLWltZyIgY2xhc3M9InctNDAgaC00MCBvYmplY3QtY292ZXIgcm91bmRlZC1sZyBib3JkZXIgYmQiIGFsdD0iIi8+DQogICAgICAgIDwvZGl2Pg0KICAgICAgICA8ZGl2IGNsYXNzPSJtdC0zIj4NCiAgICAgICAgICA8bGFiZWwgY2xhc3M9InRleHQteHMgZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPkRlbm9pc2luZyBTdHJlbmd0aDwvc3Bhbj48c3BhbiBpZD0iaTJpLWRzdiIgY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPjAuNTA8L3NwYW4+PC9sYWJlbD4NCiAgICAgICAgICA8aW5wdXQgaWQ9ImkyaS1kcyIgdHlwZT0icmFuZ2UiIG1pbj0iMCIgbWF4PSIxIiBzdGVwPSIwLjA1IiB2YWx1ZT0iMC41IiBjbGFzcz0ic2xpZGVyIG10LTEiLz4NCiAgICAgICAgPC9kaXY+DQogICAgICA8L2Rpdj4NCg0KICAgICAgPCEtLSBUYWIgcGxhY2Vob2xkZXIgKEVkaXQvVmlkZW8vUHJpbWUpIC0tPg0KICAgICAgPGRpdiBpZD0idGFiLXBsYWNlaG9sZGVyIiBjbGFzcz0iaGlkZGVuIGZsZXgtY29sIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBoLVs1MHZoXSB0ZXh0LW5ldXRyYWwtNjAwIj4NCiAgICAgICAgPGkgZGF0YS1pY29uPSJob3VyZ2xhc3MtbWVkaXVtIiBjbGFzcz0idy0xMiBoLTEyIG1iLTMiPjwvaT4NCiAgICAgICAgPHAgY2xhc3M9InRleHQtc20iIGlkPSJ0YWItcGxhY2Vob2xkZXItdGV4dCI+VGFiIGluaSBzZWdlcmEgaGFkaXI8L3A+DQogICAgICA8L2Rpdj4NCg0KICAgICAgPGRpdiBpZD0iZW1wdHkiIGNsYXNzPSJmbGV4IGZsZXgtY29sIGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciBoLVs2MHZoXSB0ZXh0LW5ldXRyYWwtNjAwIj4NCiAgICAgICAgPGkgZGF0YS1pY29uPSJpbWFnZS1zcXVhcmUiIGNsYXNzPSJ3LTE0IGgtMTQgbWItMyI+PC9pPg0KICAgICAgICA8cCBjbGFzcz0idGV4dC1zbSI+SGFzaWwgZ2VuZXJhdGUgYWthbiB0YW1waWwgZGkgc2luaTwvcD4NCiAgICAgICAgPHAgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTcwMCBtdC0xIj5Jc2kgcHJvbXB0IGxhbHUgdGVrYW4gR2VuZXJhdGU8L3A+DQogICAgICA8L2Rpdj4NCiAgICAgIDxkaXYgaWQ9ImdyaWQiIGNsYXNzPSJncmlkIGdyaWQtY29scy0yIGdhcC0zIj48L2Rpdj4NCiAgICA8L2Rpdj4NCiAgPC9tYWluPg0KDQogIDwhLS0gUklHSFQgUEFORUwgLS0+DQogIDxhc2lkZSBpZD0icmlnaHRQYW4iIGNsYXNzPSJ3LVsyMXJlbV0gc2hyaW5rLTAgYm9yZGVyLWwgYmQgYmctWyMyMjJdIGhpZGRlbiBsZzpmbGV4IGZsZXgtY29sIj4NCiAgICA8ZGl2IGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWJldHdlZW4gcHgtMyBweS0yIGJvcmRlci1iIGJkIj4NCiAgICAgIDxzcGFuIGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPkdlbmVyYXRpb24gSGlzdG9yeTwvc3Bhbj4NCiAgICAgIDxkaXYgY2xhc3M9ImZsZXggZ2FwLTEiPg0KICAgICAgICA8YnV0dG9uIGNsYXNzPSJydGFiIHNlbCIgZGF0YS1mPSJhbGwiPkFsbDwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIGNsYXNzPSJydGFiIiBkYXRhLWY9ImltYWdlIj5JbWFnZTwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIGNsYXNzPSJydGFiIiBkYXRhLWY9InZpZGVvIj5WaWRlbzwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIGNsYXNzPSJydGFiIiBkYXRhLWY9ImF1ZGlvIj5BdWRpbzwvYnV0dG9uPg0KICAgICAgPC9kaXY+DQogICAgPC9kaXY+DQogICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgcHgtMyBweS0xLjUgYm9yZGVyLWIgYmQgdGV4dC1uZXV0cmFsLTUwMCI+DQogICAgICA8YnV0dG9uIGNsYXNzPSJoLTcgdy03IGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHRleHQtbmV1dHJhbC01MDAgaG92ZXI6dGV4dC13aGl0ZSIgdGl0bGU9IktlbG9sYSI+PGkgZGF0YS1pY29uPSJzbGlkZXJzLWhvcml6b250YWwiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9idXR0b24+DQogICAgICA8c3BhbiBjbGFzcz0ibXgtYXV0byB0ZXh0LXhzIiBpZD0icmNvdW50Ij4wIGhhc2lsPC9zcGFuPg0KICAgICAgPGJ1dHRvbiBjbGFzcz0iaC03IHctNyBmbGV4IGl0ZW1zLWNlbnRlciBqdXN0aWZ5LWNlbnRlciB0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUiIHRpdGxlPSJSZWxvYWQiPjxpIGRhdGEtaWNvbj0iYXJyb3dzLWNsb2Nrd2lzZSIgY2xhc3M9InctNCBoLTQiPjwvaT48L2J1dHRvbj4NCiAgICA8L2Rpdj4NCiAgICA8ZGl2IGlkPSJybGlzdCIgY2xhc3M9ImZsZXgtMSBvdmVyZmxvdy15LWF1dG8gaGlkZWJhciBwLTIgc3BhY2UteS0zIj48L2Rpdj4NCiAgPC9hc2lkZT4NCjwvZGl2Pg0KDQo8IS0tIE1vYmlsZSBoaXN0b3J5IHRvZ2dsZSAtLT4NCjxidXR0b24gaWQ9ImJ0bi1oaXN0b3J5IiBjbGFzcz0ibGc6aGlkZGVuIGZpeGVkIGJvdHRvbS00IHJpZ2h0LTQgei0zMCBidG4gYnRuLWJsdWUgaC0xMSBweC00Ij48aSBkYXRhLWljb249ImNsb2NrLWNvdW50ZXItY2xvY2t3aXNlIiBjbGFzcz0idy00IGgtNCI+PC9pPiBSaXdheWF0PC9idXR0b24+DQoNCjwhLS0gPT09PT09PT09PT09IFBST0dSRVNTIE9WRVJMQVkgPT09PT09PT09PT09IC0tPg0KPGRpdiBpZD0icHJvZ292ZXJsYXkiIGNsYXNzPSJoaWRkZW4gZml4ZWQgaW5zZXQtMCB6LTMwIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIGJnLWJsYWNrLzUwIHAtNCIgc3R5bGU9InRvcDo1NnB4Ij4NCiAgPGRpdiBjbGFzcz0idy1mdWxsIG1heC13LXNtIGJnLVsjMjIyXSBib3JkZXIgYmQgcm91bmRlZC0yeGwgcC01IHNwYWNlLXktMyI+DQogICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIj4NCiAgICAgIDxzcGFuIGlkPSJwcm9nLXRpdGxlIiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIj5HZW5lcmF0aW5nLi4uPC9zcGFuPg0KICAgICAgPGJ1dHRvbiBpZD0icHJvZy1jYW5jZWwiIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIGhvdmVyOnRleHQtd2hpdGUgdGV4dC1sZyBsZWFkaW5nLW5vbmUiIHRpdGxlPSJCYXRhbCI+4pyVPC9idXR0b24+DQogICAgPC9kaXY+DQogICAgPGRpdiBjbGFzcz0icmVsYXRpdmUgaC0yIGJnLVsjMmEyYTJhXSByb3VuZGVkLWZ1bGwgb3ZlcmZsb3ctaGlkZGVuIj4NCiAgICAgIDxkaXYgaWQ9InByb2ctYmFyIiBjbGFzcz0iYWJzb2x1dGUgaW5zZXQteS0wIGxlZnQtMCB3LTAgcm91bmRlZC1mdWxsIiBzdHlsZT0iYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTVkZWcsIzZGNURGRiwjMjdENENEKTt0cmFuc2l0aW9uOndpZHRoIC40cyI+PC9kaXY+DQogICAgPC9kaXY+DQogICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIHRleHQteHMgdGV4dC1uZXV0cmFsLTUwMCI+DQogICAgICA8c3BhbiBpZD0icHJvZy1zdGF0dXMiPk1lbmdpcmltIHRhc2suLi48L3NwYW4+DQogICAgICA8c3BhbiBpZD0icHJvZy1wY3QiPjAlPC9zcGFuPg0KICAgIDwvZGl2Pg0KICA8L2Rpdj4NCjwvZGl2Pg0KDQo8IS0tID09PT09PT09PT09PSBMSUdIVEJPWCA9PT09PT09PT09PT0gLS0+DQo8ZGl2IGlkPSJsaWdodGJveCIgY2xhc3M9ImZpeGVkIGluc2V0LTAgei01MCBoaWRkZW4gaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHAtNCBiZy1ibGFjay84MCI+DQogIDxkaXYgY2xhc3M9InJlbGF0aXZlIG1heC13LTN4bCB3LWZ1bGwgYmctWyMyMjJdIGJvcmRlciBiZCByb3VuZGVkLTJ4bCBvdmVyZmxvdy1oaWRkZW4iPg0KICAgIDxidXR0b24gaWQ9ImxiLWNsb3NlIiBjbGFzcz0iYWJzb2x1dGUgdG9wLTIgcmlnaHQtMiB6LTEwIHctOSBoLTkgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC13aGl0ZSBob3ZlcjpiZy13aGl0ZS8xMCByb3VuZGVkLWxnIHRleHQteGwiPuKclTwvYnV0dG9uPg0KICAgIDxpbWcgaWQ9ImxiLWltZyIgY2xhc3M9InctZnVsbCBtYXgtaC1bNjB2aF0gb2JqZWN0LWNvbnRhaW4gYmctYmxhY2siIGFsdD0iIi8+DQogICAgPGRpdiBpZD0ibGItbWV0YSIgY2xhc3M9InAtNCBzcGFjZS15LTEuNSB0ZXh0LXhzIHRleHQtbmV1dHJhbC00MDAgb3ZlcmZsb3cteS1hdXRvIG1heC1oLVszMHZoXSI+PC9kaXY+DQogIDwvZGl2Pg0KPC9kaXY+DQoNCjwhLS0gPT09PT09PT09PT09IFRPQVNUID09PT09PT09PT09PSAtLT4NCjxkaXYgaWQ9InRvYXN0IiBjbGFzcz0iZml4ZWQgYm90dG9tLTIwIGxlZnQtMS8yIC10cmFuc2xhdGUteC0xLzIgei01MCBoaWRkZW4gYmctWyMyYTJhMmFdIGJvcmRlciBiZCByb3VuZGVkLXhsIHB4LTQgcHktMi41IHRleHQtc20gc2hhZG93LWxnIG1heC13LVs4NXZ3XSI+PC9kaXY+DQoNCjwhLS0gPT09PT09PT09PT09IFNFTEVDVE9SIE1PREFMID09PT09PT09PT09PSAtLT4NCjxkaXYgaWQ9Im1vZGFsIiBjbGFzcz0iZml4ZWQgaW5zZXQtMCBiZy1ibGFjay82MCB6LTUwIGhpZGRlbiBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgcC00Ij4NCiAgPGRpdiBjbGFzcz0idy1mdWxsIG1heC13LTV4bCBiZy1bIzIyMl0gYm9yZGVyIGJkIHJvdW5kZWQtMnhsIG92ZXJmbG93LWhpZGRlbiI+DQogICAgPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1iZXR3ZWVuIHB4LTQgcHQtMyBwYi0yIGJvcmRlci1iIGJkIj4NCiAgICAgIDxkaXYgaWQ9Im1vZGFsLXRhYnMiIGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMSI+DQogICAgICAgIDxidXR0b24gY2xhc3M9Im10YWIgc2VsIiBkYXRhLW10YWI9ImJhc2ljIj5CYXNpYyBNb2RlbDwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIGNsYXNzPSJtdGFiIiBkYXRhLW10YWI9InN0YXJyZWQiPk15IFN0YXJyZWQ8L2J1dHRvbj4NCiAgICAgICAgPGJ1dHRvbiBjbGFzcz0ibXRhYiIgZGF0YS1tdGFiPSJteW1vZGVscyI+TXkgTW9kZWxzPC9idXR0b24+DQogICAgICA8L2Rpdj4NCiAgICAgIDxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0yIj4NCiAgICAgICAgPGRpdiBjbGFzcz0icmVsYXRpdmUiPg0KICAgICAgICAgIDxpIGRhdGEtaWNvbj0ibWFnbmlmeWluZy1nbGFzcyIgY2xhc3M9InctNCBoLTQgYWJzb2x1dGUgbGVmdC0zIHRvcC0xLzIgLXRyYW5zbGF0ZS15LTEvMiB0ZXh0LW5ldXRyYWwtNTAwIj48L2k+DQogICAgICAgICAgPGlucHV0IGlkPSJtc2VhcmNoIiBjbGFzcz0iaW5wIHBsLTkgdy01NiBoLTkiIHBsYWNlaG9sZGVyPSJTZWFyY2guLi4iLz4NCiAgICAgICAgPC9kaXY+DQogICAgICAgIDxidXR0b24gaWQ9Im1maWx0ZXJzIiBjbGFzcz0iYnRuIGJ0bi1naG9zdCBoLTkgcHgtMyBib3JkZXIgYmQgdGV4dC14cyBzaHJpbmstMCI+PGkgZGF0YS1pY29uPSJzbGlkZXJzLWhvcml6b250YWwiIGNsYXNzPSJ3LTQgaC00Ij48L2k+RmlsdGVyczwvYnV0dG9uPg0KICAgICAgICA8YnV0dG9uIGlkPSJtb2RhbC1jbG9zZSIgY2xhc3M9InctOSBoLTkgZmxleCBpdGVtcy1jZW50ZXIganVzdGlmeS1jZW50ZXIgdGV4dC13aGl0ZSBob3ZlcjpiZy1bIzJhMmEyYV0gcm91bmRlZC1sZyB0ZXh0LXhsIGxlYWRpbmctbm9uZSIgdGl0bGU9IlR1dHVwIj7inJU8L2J1dHRvbj4NCiAgICAgICAgPGgzIGlkPSJtb2RhbC10aXRsZSIgY2xhc3M9ImhpZGRlbiBmb250LXNlbWlib2xkIHRleHQtc20iPlBpbGloIE1vZGVsPC9oMz4NCiAgICAgIDwvZGl2Pg0KICAgIDwvZGl2Pg0KICAgIDxkaXYgaWQ9Im1jYXQiIGNsYXNzPSJmbGV4IGl0ZW1zLWNlbnRlciBnYXAtMS41IHB4LTQgcHktMiBoaWRlYmFyIG92ZXJmbG93LXgtYXV0byI+PC9kaXY+DQogICAgPGRpdiBpZD0ibW9kYWwtYm9keSIgY2xhc3M9Im1heC1oLVs1NXZoXSBvdmVyZmxvdy15LWF1dG8gcC00Ij48L2Rpdj4NCiAgPC9kaXY+DQo8L2Rpdj4NCg0KDQo8c2NyaXB0Pg0KY29uc3QgJCA9IGlkID0+IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTsNCmNvbnN0IFMgPSAnaHR0cHM6Ly9waWNzdW0ucGhvdG9zL3NlZWQvJzsNCmNvbnN0IHN0YXRlID0geyByZXN1bHRzOltdLCBwYWdlOid0ZXh0JywgYXNwZWN0Oidwb3J0cmFpdCcsIG5jb2w6MiwgbW9kZWw6bnVsbCB9Ow0KDQovKiA9PT09PSBMb1JBIOKAlCBkYWZ0YXIgYXNsaSBwZXIgcHJvdmlkZXIgPT09PT0gKi8NCnZhciBMT1JBX0xJQlMgPSB7DQogIHRhbXM6IFsNCiAgICB7IG5hbWU6J1otSW1hZ2UgTG9SQSB8IERldGFpbCcsIHRhZ3M6WydkZXRhaWxlZCcsJ3NoYXJwJ10sIHRodW1iOidhZnJvJywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMTJLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sDQogICAgeyBuYW1lOidaLUltYWdlIFR1cmJvJywgdGFnczpbJ3R1cmJvJywnZmFzdCddLCB0aHVtYjoncmV0cm8nLCBiYWRnZTonWi1JTUFHRS1UVVJCTycsIHZpZXdzOic4SycsIHZlcjonVjEnLCBiYXNlOidaIEltYWdlJyB9LA0KICAgIHsgbmFtZTonWi1JbWFnZSBIRFInLCB0YWdzOlsnaGRyJywndml2aWQnXSwgdGh1bWI6J2hkcicsIGJhZGdlOidaLUlNQUdFJywgdmlld3M6JzE1SycsIHZlcjonVjEnLCBiYXNlOidaIEltYWdlJyB9LA0KICAgIHsgbmFtZTonWi1JbWFnZSBQb3J0cmFpdCcsIHRhZ3M6Wydwb3J0cmFpdCcsJ2Jva2VoJ10sIHRodW1iOidwdHJ0JywgYmFkZ2U6J1otSU1BR0UnLCB2aWV3czonMjJLJywgdmVyOidWMScsIGJhc2U6J1ogSW1hZ2UnIH0sDQogICAgeyBuYW1lOidaLUltYWdlIEFydGlzdGljJywgdGFnczpbJ2FydGlzdGljJywncGFpbnQnXSwgdGh1bWI6J2FydCcsIGJhZGdlOidaLUlNQUdFJywgdmlld3M6JzE4SycsIHZlcjonVjEnLCBiYXNlOidaIEltYWdlJyB9LA0KICAgIHsgbmFtZTonRmx1eCBSZWFsaXNtIExvUkEnLCB0YWdzOlsncmVhbGlzdGljJywncGhvdG8nXSwgdGh1bWI6J2ZsdXhsJywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonNDVLJywgdmVyOidWMScsIGJhc2U6J0ZMVVguMScgfSwNCiAgICB7IG5hbWU6J0ZsdXggQ2luZW1hdGljIExvUkEnLCB0YWdzOlsnY2luZW1hdGljJywnbW9vZHknXSwgdGh1bWI6J2ZsdXhjJywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonMzNLJywgdmVyOidWMScsIGJhc2U6J0ZMVVguMScgfSwNCiAgICB7IG5hbWU6J1NEWEwgRmluZSBEZXRhaWwnLCB0YWdzOlsnZGV0YWlsZWQnLCdzaGFycCddLCB0aHVtYjonZGV0YWlsJywgYmFkZ2U6J1NEWEwnLCB2aWV3czonNTAwSycsIHZlcjonVjEnLCBiYXNlOidTRFhMJyB9LA0KICAgIHsgbmFtZTonU0RYTCBBbmltZSBTdHlsZScsIHRhZ3M6WydhbmltZScsJ2NlbCddLCB0aHVtYjonYW5pbWVzbCcsIGJhZGdlOidTRFhMJywgdmlld3M6JzI4MEsnLCB2ZXI6J1YxJywgYmFzZTonU0RYTCcgfSwNCiAgICB7IG5hbWU6J1BvbnkgRXF1ZXN0cmlhbiBBcnQnLCB0YWdzOlsncG9ueScsJ2ZhbnRhc3knXSwgdGh1bWI6J3BvbnlsJywgYmFkZ2U6J1BPTlknLCB2aWV3czonMTUwSycsIHZlcjonVjEnLCBiYXNlOidQb255JyB9LA0KICAgIHsgbmFtZTonTmlwcG9uLUNvcmUgUmV0cm8gLSB2MC4xJywgdGFnczpbJ2phcHJldHI3Y29tbScsJ3JldHJvIG1hZ2F6aW5lJ10sIHRodW1iOidiaWxpYmluJywgYmFkZ2U6J1NUWUxFJywgdmlld3M6Jzk2SycsIHZlcjonVi4xJywgYmFzZTonU0RYTCcgfSwNCiAgICB7IG5hbWU6J0l2YW4gQmlsaWJpbiAtIHYwLjcnLCB0YWdzOlsnaXZhbmJpbGliaW41eicsJ2lsbHVzdHJhdGlvbicsJ2FydCBkZWNvJ10sIHRodW1iOidkZXRhaWwnLCBiYWRnZTonSUxMVVNUUkFUSU9OJywgdmlld3M6JzE1NEsnLCB2ZXI6J1YuMScsIGJhc2U6J1NEWEwnIH0sDQogICAgeyBuYW1lOidEZXRhaWwgVHdlYWtlciAtIHYxLjAnLCB0YWdzOlsnZGV0YWlsZWQnXSwgdGh1bWI6J2dyYWluJywgYmFkZ2U6J1VUSUxJVFknLCB2aWV3czonMS4yTScsIHZlcjonVi4xJywgYmFzZTonU0RYTCcgfSwNCiAgICB7IG5hbWU6J0ZpbG0gR3JhaW4gLSB2MC41JywgdGFnczpbJ2ZpbG0gZ3JhaW4nLCdhbmFsb2cnXSwgdGh1bWI6J2dyYWluJywgYmFkZ2U6J1VUSUxJVFknLCB2aWV3czonNjdLJywgdmVyOidWLjEnLCBiYXNlOidTRFhMJyB9LA0KICBdLA0KICByZXBsaWNhdGU6IFsNCiAgICB7IG5hbWU6J0ZMVVguMSBbc2NobmVsbF0gTG9SQScsIGJhc2U6J0ZMVVgnLCBtb2RlbDonYmxhY2stZm9yZXN0LWxhYnMvZmx1eC1zY2huZWxsLWxvcmEnLCB0YWdzOlsnZmx1eC1sb3JhJ10sIHRodW1iOidmbHV4bCcsIGJhZGdlOidGTFVYLUxPUkEnLCB2aWV3czonMTIwSycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwNCiAgICB7IG5hbWU6J0ZMVVguMSBbZGV2XSBMb1JBJywgYmFzZTonRkxVWCcsIG1vZGVsOidibGFjay1mb3Jlc3QtbGFicy9mbHV4LWRldi1sb3JhJywgdGFnczpbJ2ZsdXgtbG9yYSddLCB0aHVtYjonZmx1eGRsJywgYmFkZ2U6J0ZMVVgtTE9SQScsIHZpZXdzOic5MEsnLCB2ZXI6J1YxJywgbmVlZFVybDp0cnVlIH0sDQogICAgeyBuYW1lOidTRFhMICsgTG9SQSBVUkwgKGN1c3RvbSknLCBiYXNlOidTRFhMJywgbW9kZWw6J3p5bGltMDcwMi9zZHhsLWxvcmEtY3VzdG9taXplLW1vZGVsJywgdGFnczpbJ2xvcmEnXSwgdGh1bWI6J3NkeGxsJywgYmFkZ2U6J1NEWEwtTE9SQScsIHZpZXdzOiczMTBLJywgdmVyOidWMScsIG5lZWRVcmw6dHJ1ZSB9LA0KICAgIHsgbmFtZTonSUtFQSBJbnN0cnVjdGlvbnMgKFNEWEwsIGJhd2FhbiknLCBiYXNlOidTRFhMJywgbW9kZWw6J29zdHJpcy9pa2VhLWluc3RydWN0aW9ucy1sb3JhLXNkeGwnLCB0YWdzOlsnaWtlYSBpbnN0cnVjdGlvbnMnXSwgdGh1bWI6J2lrZWEnLCBiYWRnZTonU1RZTEUnLCB2aWV3czonMjEwSycsIHZlcjonVjEnIH0sDQogIF0sDQogIGZhbDogWw0KICAgIHsgbmFtZTonRkxVWCBMb1JBJywgYmFzZTonRkxVWCcsIG1vZGVsOidmYWwtYWkvZmx1eC1sb3JhJywgdGFnczpbJ2ZsdXgtbG9yYSddLCB0aHVtYjonZmx1eGwnLCBiYWRnZTonRkxVWC1MT1JBJywgdmlld3M6JzE1MEsnLCB2ZXI6J1YxJywgbmVlZFVybDp0cnVlIH0sDQogICAgeyBuYW1lOidTRFhMICsgTG9SQSBVUkwgKGZhc3Qtc2R4bCknLCBiYXNlOidTRFhMJywgbW9kZWw6J2ZhbC1haS9mYXN0LXNkeGwnLCB0YWdzOlsnbG9yYSddLCB0aHVtYjonc2R4bGwnLCBiYWRnZTonU0RYTC1MT1JBJywgdmlld3M6JzEyMEsnLCB2ZXI6J1YxJywgbmVlZFVybDp0cnVlIH0sDQogICAgeyBuYW1lOidLcmVhIDIgTG9SQSAodHVyYm8pJywgYmFzZTonS3JlYSAyJywgbW9kZWw6J2ZhbC1haS9rcmVhLTIvdHVyYm8vbG9yYScsIHRhZ3M6WydrcmVhMiddLCB0aHVtYjona3JlYScsIGJhZGdlOidLUkVBMi1MT1JBJywgdmlld3M6JzY2SycsIHZlcjonVjEnLCBuZWVkVXJsOnRydWUgfSwNCiAgXSwNCiAgcG9sbGluYXRpb25zOiBbXSwgLy8gTG9SQSB0aWRhayBkaWR1a3VuZyDigJQgZ3JhdGlzLCBtb2RlbCBiYXdhYW4gc2FqYQ0KfTsNCnZhciBMT1JBX0xJQiA9IExPUkFfTElCUy50YW1zOyAvLyBkYWZ0YXIgYWt0aWYgbWVuZ2lrdXRpIHByb3ZpZGVyDQpjb25zdCBMT1JBID0gW107DQovKiA9PT09PSBNb2RlbCBtb2RhbCDigJQgZGFmdGFyIG1vZGVsIGFzbGkgcGVyIHByb3ZpZGVyID09PT09ICovDQp2YXIgTU9ERUxfTElCUyA9IHsNCiAgdGFtczogWw0KICAgIHsgbmFtZTonWiBJbWFnZSAtIGJhc2UtYmYxNicsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonWiBJbWFnZScsIHRodW1iOid6aW1hZ2UnLCBiYWRnZTonWicsIHZpZXdzOic0NEsnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYyNTMyNjA2MDM4MDUnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjI1NDMzNDM2NjI0NScgfSwNCiAgICB7IG5hbWU6J0ZMVVguMSBbZGV2XScsIGJhc2U6J0Jhc2ljIE1vZGVsJywgYXJjaDonRkxVWC4xJywgdGh1bWI6J2ZsdXgnLCBiYWRnZTonRkxVWCcsIHZpZXdzOicxNTRLJywgdmVyOidWLjEnLCBtb2RlbElkOicxMDI3OTA2MjgyNjQ0NTI1MDU2JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYyODI2NDQ1MjUwNTcnIH0sDQogICAgeyBuYW1lOidTdGFibGUgRGlmZnVzaW9uIFhMJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J3NkeGwnLCBiYWRnZTonU0RYTCAxLjAnLCB2aWV3czonODkySycsIHZlcjonVi4xJywgbW9kZWxJZDonMTAyNzkwNjMwOTAzMjEzNjcwNCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzA5MDMyMTM2NzA1JyB9LA0KICAgIHsgbmFtZTonU3RhYmxlIERpZmZ1c2lvbiAzLjUgTWVkaXVtJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRCAzLjUnLCB0aHVtYjonc2QzNScsIGJhZGdlOidTRCAzLjUnLCB2aWV3czonMzEySycsIHZlcjonVi4xJywgbW9kZWxJZDonMTAyNzkwNjMxNzQ1MjgwODE5MicsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzE3NDUyODA4MTkzJyB9LA0KICAgIHsgbmFtZTonUG9ueSBEaWZmdXNpb24gVjYnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1BvbnknLCB0aHVtYjoncG9ueScsIGJhZGdlOidQT05ZJywgdmlld3M6JzIuMU0nLCB2ZXI6J1Y2JywgbW9kZWxJZDonMTAyNzkwNjMyNjg3NDI3MTc0NCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzI2ODc0MjcxNzQ1JyB9LA0KICAgIHsgbmFtZTonSWxsdXN0cmlvdXMgWEwnLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J0lsbHVzdHJpb3VzJywgdGh1bWI6J2lsbHVzdCcsIGJhZGdlOidJTExVU1RSSU9VUycsIHZpZXdzOic2N0snLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYzMzU3ODI0MTQzMzYnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjMzNTc4MjQxNDMzNycgfSwNCiAgICB7IG5hbWU6J0FuaW1hJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidBbmltYScsIHRodW1iOidhbmltYScsIGJhZGdlOidBTklNQScsIHZpZXdzOic1MksnLCB2ZXI6J1YuMScsIG1vZGVsSWQ6JzEwMjc5MDYzNDQ3MTY3NzE4NDAnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM0NDcxNjc3MTg0MScgfSwNCiAgICB7IG5hbWU6J0RyZWFtU2hhcGVyJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J2RyZWFtJywgYmFkZ2U6J0RTJywgdmlld3M6JzgxMksnLCB2ZXI6J1YuNScsIG1vZGVsSWQ6JzEwMjc5MDYzNTM0OTk0Mjk4ODgnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM1MzQ5OTQyOTg4OScgfSwNCiAgICB7IG5hbWU6J1JlYWxpc3RpYyBWaXNpb24nLCBiYXNlOidCYXNpYyBNb2RlbCcsIGFyY2g6J1NEWEwnLCB0aHVtYjoncmVhbCcsIGJhZGdlOidSVicsIHZpZXdzOic2NDVLJywgdmVyOidWLjYuMCcsIG1vZGVsSWQ6JzEwMjc5MDYzNjI0MTI1MzE3MTInLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM2MjQxMjUzMTcxMycgfSwNCiAgICB7IG5hbWU6J0NvdW50ZXJmZWl0JywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J2NvdW50ZXInLCBiYWRnZTonQ09VTlRFUkZFSVQnLCB2aWV3czonNDIwSycsIHZlcjonVi41JywgbW9kZWxJZDonMTAyNzkwNjM3MTMzNDcyNzY4MCcsIG1vZGVsRmlsZUlkOicxMDI3OTA2MzcxMzM0NzI3NjgxJyB9LA0KICAgIHsgbmFtZTonTHlyaWVsJywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J2x5cmllbCcsIGJhZGdlOidMWVJJRUwnLCB2aWV3czonMzIwSycsIHZlcjonVi4xLjYnLCBtb2RlbElkOicxMDI3OTA2Mzc5OTk2MDEzNTY4JywgbW9kZWxGaWxlSWQ6JzEwMjc5MDYzNzk5OTYwMTM1NjknIH0sDQogICAgeyBuYW1lOidKdWdnZXJuYXV0JywgYmFzZTonQmFzaWMgTW9kZWwnLCBhcmNoOidTRFhMJywgdGh1bWI6J2p1ZycsIGJhZGdlOidKVUdHJywgdmlld3M6JzIxMEsnLCB2ZXI6J1YuOScsIG1vZGVsSWQ6JzEwMjc5MDYzODg0MjEwOTk1MjAnLCBtb2RlbEZpbGVJZDonMTAyNzkwNjM4ODQyMTA5OTUyMScgfSwNCiAgXSwNCiAgcmVwbGljYXRlOiBbDQogICAgeyBuYW1lOidGTFVYLjEgW3NjaG5lbGxdJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonRkxVWCcsIHRodW1iOidmbHV4JywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonNE0nLCB2ZXI6J1YxJywgbW9kZWw6J2JsYWNrLWZvcmVzdC1sYWJzL2ZsdXgtc2NobmVsbCcgfSwNCiAgICB7IG5hbWU6J0ZMVVguMSBbZGV2XScsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J0ZMVVgnLCB0aHVtYjonZmx1eGQnLCBiYWRnZTonRkxVWCcsIHZpZXdzOicyLjFNJywgdmVyOidWMScsIG1vZGVsOidibGFjay1mb3Jlc3QtbGFicy9mbHV4LWRldicgfSwNCiAgICB7IG5hbWU6J1NEWEwgMS4wJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0RYTCcsIHRodW1iOidzZHhsJywgYmFkZ2U6J1NEWEwgMS4wJywgdmlld3M6JzEuMk0nLCB2ZXI6J1YxJywgbW9kZWw6J3N0YWJpbGl0eS1haS9zZHhsJyB9LA0KICAgIHsgbmFtZTonU3RhYmxlIERpZmZ1c2lvbiAzLjUgTGFyZ2UnLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRCAzLjUnLCB0aHVtYjonc2QzNScsIGJhZGdlOidTRCAzLjUnLCB2aWV3czonMS41TScsIHZlcjonVjEnLCBtb2RlbDonc3RhYmlsaXR5LWFpL3N0YWJsZS1kaWZmdXNpb24tMy41LWxhcmdlJyB9LA0KICAgIHsgbmFtZTonU0RYTCBMaWdodG5pbmcgNC1TdGVwJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0RYTCcsIHRodW1iOidsaWdodG5pbmcnLCBiYWRnZTonTElHSFROSU5HJywgdmlld3M6JzEuOE0nLCB2ZXI6J1YxJywgbW9kZWw6J2J5dGVkYW5jZS9zZHhsLWxpZ2h0bmluZy00c3RlcCcgfSwNCiAgICB7IG5hbWU6J1JlYWxWaXNYTCBWNC4wJywgYmFzZTonUmVwbGljYXRlJywgYXJjaDonU0RYTCcsIHRodW1iOidyZWFsJywgYmFkZ2U6J1JFQUxJU1RJQycsIHZpZXdzOic5MDBLJywgdmVyOidWNC4wJywgbW9kZWw6J2x1Y2F0YWNvL3JlYWx2aXN4bC12NC4wJyB9LA0KICAgIHsgbmFtZTonSnVnZ2VybmF1dCBYTCBWOScsIGJhc2U6J1JlcGxpY2F0ZScsIGFyY2g6J1NEWEwnLCB0aHVtYjonanVnJywgYmFkZ2U6J0pVR0cnLCB2aWV3czonNzUwSycsIHZlcjonVjknLCBtb2RlbDonZGlnaXBsYXkvSnVnZ2VybmF1dF9YTF92OScgfSwNCiAgICB7IG5hbWU6J1NEWEwgRW1vamknLCBiYXNlOidSZXBsaWNhdGUnLCBhcmNoOidTRFhMJywgdGh1bWI6J2Vtb2ppJywgYmFkZ2U6J0VNT0pJJywgdmlld3M6JzYwMEsnLCB2ZXI6J1YxJywgbW9kZWw6J2ZvZnIvc2R4bC1lbW9qaScgfSwNCiAgXSwNCiAgZmFsOiBbDQogICAgeyBuYW1lOidGTFVYLjEgW3NjaG5lbGxdJywgYmFzZTonZmFsLmFpJywgYXJjaDonRkxVWCcsIHRodW1iOidmbHV4JywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonNU0nLCB2ZXI6J1YxJywgbW9kZWw6J2ZhbC1haS9mbHV4L3NjaG5lbGwnIH0sDQogICAgeyBuYW1lOidGTFVYLjEgW2Rldl0nLCBiYXNlOidmYWwuYWknLCBhcmNoOidGTFVYJywgdGh1bWI6J2ZsdXhkJywgYmFkZ2U6J0ZMVVgnLCB2aWV3czonM00nLCB2ZXI6J1YxJywgbW9kZWw6J2ZhbC1haS9mbHV4L2RldicgfSwNCiAgICB7IG5hbWU6J0Zhc3QgU0RYTCcsIGJhc2U6J2ZhbC5haScsIGFyY2g6J1NEWEwnLCB0aHVtYjonZmFzdHNkeGwnLCBiYWRnZTonRkFMJywgdmlld3M6JzIuNU0nLCB2ZXI6J1YxJywgbW9kZWw6J2ZhbC1haS9mYXN0LXNkeGwnIH0sDQogICAgeyBuYW1lOidTRFhMJywgYmFzZTonZmFsLmFpJywgYXJjaDonU0RYTCcsIHRodW1iOidzZHhsJywgYmFkZ2U6J1NEWEwgMS4wJywgdmlld3M6JzEuMU0nLCB2ZXI6J1YxJywgbW9kZWw6J2ZhbC1haS9zZHhsJyB9LA0KICAgIHsgbmFtZTonU3RhYmxlIERpZmZ1c2lvbiAzLjUgTGFyZ2UnLCBiYXNlOidmYWwuYWknLCBhcmNoOidTRCAzLjUnLCB0aHVtYjonc2QzNScsIGJhZGdlOidTRCAzLjUnLCB2aWV3czonOTAwSycsIHZlcjonVjEnLCBtb2RlbDonZmFsLWFpL3N0YWJsZS1kaWZmdXNpb24tdjM1LWxhcmdlJyB9LA0KICAgIHsgbmFtZTonUGxheWdyb3VuZCB2Mi41JywgYmFzZTonZmFsLmFpJywgYXJjaDonU0RYTCcsIHRodW1iOidwbGF5JywgYmFkZ2U6J1BMQVknLCB2aWV3czonNzAwSycsIHZlcjonVjIuNScsIG1vZGVsOidmYWwtYWkvcGxheWdyb3VuZC92Mi41JyB9LA0KICAgIHsgbmFtZTonS3JlYSAyIFR1cmJvJywgYmFzZTonZmFsLmFpJywgYXJjaDonS3JlYSAyJywgdGh1bWI6J2tyZWEnLCBiYWRnZTonS1JFQTInLCB2aWV3czonMS4xTScsIHZlcjonVjInLCBtb2RlbDonZmFsLWFpL2tyZWEtMi90dXJibycgfSwNCiAgXSwNCiAgcG9sbGluYXRpb25zOiBbDQogICAgeyBuYW1lOidaLUltYWdlIFR1cmJvJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonQWxpYmFiYScsIHRodW1iOid6aW1hZ2UnLCBiYWRnZTonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J3ppbWFnZScgfSwNCiAgICB7IG5hbWU6J0dQVCBJbWFnZSAyJywgYmFzZTonUG9sbGluYXRpb25zJywgYXJjaDonT3BlbkFJJywgdGh1bWI6J2dwdCcsIGJhZGdlOidGUkVFJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDonZ3B0LWltYWdlLTInIH0sDQogICAgeyBuYW1lOidGTFVYLjEgU2NobmVsbCcsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0JsYWNrIEZvcmVzdCBMYWJzJywgdGh1bWI6J2ZsdXgnLCBiYWRnZTonRlJFRScsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J2ZsdXgnIH0sDQogICAgeyBuYW1lOidEcmVhbVNoYXBlciA4IExDTScsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0x5a29uJywgdGh1bWI6J2RyZWFtJywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidkcmVhbXNoYXBlcicgfSwNCiAgICB7IG5hbWU6J0ZMVVguMiBLbGVpbiA0QicsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0JsYWNrIEZvcmVzdCBMYWJzJywgdGh1bWI6J2tsZWluJywgYmFkZ2U6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidrbGVpbicgfSwNCiAgICB7IG5hbWU6J0tyZWEgMiBNZWRpdW0nLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidLcmVhJywgdGh1bWI6J2tyZWEnLCBiYWRnZTonUEFJRCcsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J2tyZWEnIH0sDQogICAgeyBuYW1lOidTZWVkcmVhbSA1LjAgTGl0ZScsIGJhc2U6J1BvbGxpbmF0aW9ucycsIGFyY2g6J0J5dGVEYW5jZScsIHRodW1iOidzZWVkJywgYmFkZ2U6J1BBSUQnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOidzZWVkcmVhbTUnIH0sDQogICAgeyBuYW1lOidRd2VuIEltYWdlIDMnLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidRd2VuJywgdGh1bWI6J3F3ZW4nLCBiYWRnZTonUEFJRCcsIHZpZXdzOicnLCB2ZXI6J1YxJywgbW9kZWw6J3F3ZW4taW1hZ2UtMycgfSwNCiAgICB7IG5hbWU6J05hbm8gQmFuYW5hIDInLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOidHb29nbGUnLCB0aHVtYjonbmFubycsIGJhZGdlOidQQUlEJywgdmlld3M6JycsIHZlcjonVjEnLCBtb2RlbDonbmFub2JhbmFuYS0yJyB9LA0KICBdLA0KfTsNCnZhciBNT0RFTFMgPSBNT0RFTF9MSUJTLnRhbXM7IC8vIGRhZnRhciBha3RpZiBtZW5naWt1dGkgcHJvdmlkZXINCnZhciBNQ0FUID0gWydUcnkgTm93JywnQUxMJywnT0ZGSUNJQUwgTU9ERUwnLCdNRU1FJywnRVhDTFVTSVZFJywnQkVBVVRZJywnM0QnLCcyLjVEJywnTUFMRScsJ0FOSU1FJywnUkVBTElTVElDJywnU1RZTEUnLCdHQU1FJywnREVTSUdOJywnU0NFTkVSWScsJ0JVSUxESU5HUycsJ01FQ0hBJ107DQp2YXIgX2N1ckxpc3Q9W10sIF9jdXJPblNlbD1mdW5jdGlvbigpe307DQpmdW5jdGlvbiByZW5kZXJDYXJkcyhsaXN0LCBvblNlbCl7DQogIF9jdXJMaXN0PWxpc3Q7IF9jdXJPblNlbD1vblNlbDsNCiAgdmFyIGI9JCgnbW9kYWwtYm9keScpOyBiLmlubmVySFRNTD0nJzsNCiAgaWYoIWxpc3QubGVuZ3RoKXsgYi5pbm5lckhUTUw9JzxwIGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgcC0zIHRleHQtY2VudGVyIj5UaWRhayBhZGEgaGFzaWwuPC9wPic7IHJldHVybjsgfQ0KICB2YXIgZ3JpZD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsNCiAgZ3JpZC5jbGFzc05hbWU9J2dyaWQgZ3JpZC1jb2xzLTMgc206Z3JpZC1jb2xzLTQgbWQ6Z3JpZC1jb2xzLTUgZ2FwLTMnOw0KICBsaXN0LmZvckVhY2goZnVuY3Rpb24obSl7DQogICAgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7DQogICAgZC5jbGFzc05hbWU9J21jYXJkJzsNCiAgICBkLmlubmVySFRNTCA9JzxkaXYgY2xhc3M9Im1jYXJkLWltZyI+Jw0KICAgICAgKyc8aW1nIHNyYz0iJytTK20udGh1bWIrJy8zMDAiLz4nDQogICAgICArJzxzcGFuIGNsYXNzPSJtY2FyZC1iYWRnZSI+JyttLmJhZGdlKyc8L3NwYW4+Jw0KICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC1zdGFyIj48aSBkYXRhLWljb249InN0YXIiIGNsYXNzPSJ3LTQgaC00Ij48L2k+PC9kaXY+Jw0KICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC12aWV3cyI+PGkgZGF0YS1pY29uPSJwbGF5LWZpbGwiIGNsYXNzPSJ3LTMgaC0zIj48L2k+JyttLnZpZXdzKyc8L2Rpdj4nDQogICAgICArJzwvZGl2PicNCiAgICAgICsnPGRpdiBjbGFzcz0ibWNhcmQtaW5mbyI+Jw0KICAgICAgKyc8ZGl2IGNsYXNzPSJtY2FyZC1uYW1lIiB0aXRsZT0iJyttLm5hbWUrJyI+JyttLm5hbWUrJzwvZGl2PicNCiAgICAgICsnPGRpdiBjbGFzcz0ibWNhcmQtbWV0YSI+Jw0KICAgICAgKyc8c2VsZWN0IGNsYXNzPSJtY2FyZC12ZXIiPjxvcHRpb24+JyttLnZlcisnPC9vcHRpb24+PG9wdGlvbj5WLjI8L29wdGlvbj48b3B0aW9uPlYuMzwvb3B0aW9uPjwvc2VsZWN0PicNCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibWNhcmQtc2VsIj5TZWxlY3Q8L2J1dHRvbj4nDQogICAgICArJzwvZGl2PjwvZGl2Pic7DQogICAgZC5xdWVyeVNlbGVjdG9yKCcubWNhcmQtc3RhcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgZS50YXJnZXQuY2xvc2VzdCgnLm1jYXJkLXN0YXInKS5jbGFzc0xpc3QudG9nZ2xlKCdvbicpOyB9KTsNCiAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5tY2FyZC1zZWwnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgX2N1ck9uU2VsKG0pOyB9KTsNCiAgICBncmlkLmFwcGVuZENoaWxkKGQpOw0KICB9KTsNCiAgYi5hcHBlbmRDaGlsZChncmlkKTsNCn0NCmZ1bmN0aW9uIGFwcGx5U2VhcmNoKCl7DQogIHZhciBxPSgkKCdtc2VhcmNoJykudmFsdWV8fCcnKS50b0xvd2VyQ2FzZSgpOw0KICByZW5kZXJDYXJkcyhfY3VyTGlzdC5maWx0ZXIoZnVuY3Rpb24obSl7cmV0dXJuICFxfHxtLm5hbWUudG9Mb3dlckNhc2UoKS5pbmRleE9mKHEpPj0wfSksIF9jdXJPblNlbCk7DQp9DQokKCdtc2VhcmNoJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGFwcGx5U2VhcmNoKTsNCiQoJ21maWx0ZXJzJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7ICQoJ21jYXQnKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nKTsgJCgnbWZpbHRlcnMnKS5jbGFzc0xpc3QudG9nZ2xlKCdvbicpOyB9KTsNCmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy5tdGFiJykuZm9yRWFjaChmdW5jdGlvbih0KXsNCiAgdC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsNCiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcubXRhYicpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QucmVtb3ZlKCdzZWwnKX0pOw0KICAgIHQuY2xhc3NMaXN0LmFkZCgnc2VsJyk7DQogICAgaWYodC5kYXRhc2V0Lm10YWI9PT0nYmFzaWMnKSByZW5kZXJDYXJkcyhNT0RFTFMsIGZ1bmN0aW9uKG0peyBzZXRNb2RlbChtKTsgY2xvc2VNb2RhbCgpOyB9KTsNCiAgICBlbHNlIHJlbmRlckNhcmRzKFtdLCBudWxsKTsNCiAgfSk7DQp9KTsNCmZ1bmN0aW9uIHJlbmRlck1DYXQob25QaWNrKXsNCiAgdmFyIGM9JCgnbWNhdCcpOw0KICBpZighb25QaWNrKSBvblBpY2s9ZnVuY3Rpb24oKXt9Ow0KICB2YXIgaHRtbD0nJzsNCiAgTUNBVC5mb3JFYWNoKGZ1bmN0aW9uKGNhdCxpKXsNCiAgICBodG1sKz0nPGJ1dHRvbiBjbGFzcz0ibWNoaXAiIGRhdGEtbWNhdD0iJytjYXQrJyI+JytjYXQrJzwvYnV0dG9uPic7DQogIH0pOw0KICBjLmlubmVySFRNTD1odG1sOw0KICBjLnF1ZXJ5U2VsZWN0b3IoJy5tY2hpcCcpLmNsYXNzTGlzdC5hZGQoJ29uJyk7DQogIGMucXVlcnlTZWxlY3RvckFsbCgnLm1jaGlwJykuZm9yRWFjaChmdW5jdGlvbihjaCl7DQogICAgY2guYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7DQogICAgICBjLnF1ZXJ5U2VsZWN0b3JBbGwoJy5tY2hpcCcpLmZvckVhY2goZnVuY3Rpb24oeCl7eC5jbGFzc0xpc3QucmVtb3ZlKCdvbicpfSk7DQogICAgICBjaC5jbGFzc0xpc3QuYWRkKCdvbicpOw0KICAgICAgb25QaWNrKGNoLmRhdGFzZXQubWNhdCk7DQogICAgfSk7DQogIH0pOw0KfQ0KZnVuY3Rpb24gc2V0TW9kZWwobSl7DQogIHN0YXRlLm1vZGVsPW07DQogICQoJ21vZGVsLW5hbWUnKS50ZXh0Q29udGVudD1tLm5hbWU7DQogICQoJ21vZGVsLXRodW1iJykuc3JjPSdodHRwczovL3BpY3N1bS5waG90b3Mvc2VlZC8nK20udGh1bWIrJy82NCc7DQogIHZhciBiPSQoJ21vZGVsLWJhZGdlJyk7IGlmKGIpIGIudGV4dENvbnRlbnQ9KG0uYmFzZXx8J01vZGVsJykrJyAtICcrKG0uYXJjaHx8JycpOw0KfQ0KZnVuY3Rpb24gb3Blbk1vZGVsU2VsZWN0b3IoKXsNCiAgJCgnbW9kYWwtdGl0bGUnKS50ZXh0Q29udGVudD0nUGlsaWggTW9kZWwnOw0KICByZW5kZXJNQ2F0KGZ1bmN0aW9uKCl7IHJlbmRlckNhcmRzKE1PREVMUywgZnVuY3Rpb24obSl7IHNldE1vZGVsKG0pOyBjbG9zZU1vZGFsKCk7IH0pOyB9KTsNCiAgcmVuZGVyQ2FyZHMoTU9ERUxTLCBmdW5jdGlvbihtKXsgc2V0TW9kZWwobSk7IGNsb3NlTW9kYWwoKTsgfSk7DQogIG9wZW5Nb2RhbCgpOw0KfQ0KJCgnbW9kZWwtY2FyZCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxvcGVuTW9kZWxTZWxlY3Rvcik7DQpmdW5jdGlvbiBvcGVuTG9yYU1vZGFsKCl7DQogICQoJ21vZGFsLXRpdGxlJykudGV4dENvbnRlbnQ9J1BpbGloIExvUkEnOw0KICB2YXIgYXJjaD1zdGF0ZS5tb2RlbD9zdGF0ZS5tb2RlbC5hcmNoOicnOw0KICB2YXIgYXZhaWw9ZnVuY3Rpb24oKXsgcmV0dXJuIExPUkFfTElCLmZpbHRlcihmdW5jdGlvbihsKXsNCiAgICByZXR1cm4gKCFMT1JBLnNvbWUoZnVuY3Rpb24oeCl7cmV0dXJuIHgubmFtZT09PWwubmFtZX0pKSAmJiAoIWFyY2ggfHwgIWwuYmFzZSB8fCBsLmJhc2U9PT1hcmNoKTsNCiAgfSk7IH07DQogIHZhciBvblNlbD1mdW5jdGlvbihsKXsNCiAgICBMT1JBLnB1c2goeyBuYW1lOmwubmFtZSwgdzowLjgsIHRhZ3M6bC50YWdzLCB0aHVtYjpsLnRodW1iLCBiYXNlOmwuYmFzZSwgbG9yYU1vZGVsOmwubW9kZWx8fCcnLCBuZWVkVXJsOmwubmVlZFVybCwgbG9yYVVybDonJyB9KTsNCiAgICByZW5kZXJMb3JhKCk7IGNsb3NlTW9kYWwoKTsNCiAgfTsNCiAgcmVuZGVyTUNhdChmdW5jdGlvbigpeyByZW5kZXJDYXJkcyhhdmFpbCgpLCBvblNlbCk7IH0pOw0KICByZW5kZXJDYXJkcyhhdmFpbCgpLCBvblNlbCk7DQogIGlmKCFhdmFpbCgpLmxlbmd0aCl7ICQoJ21vZGFsLXRpdGxlJykudGV4dENvbnRlbnQ9J1RpZGFrIGFkYSBMb1JBIHVudHVrICcrYXJjaDsgfQ0KICBvcGVuTW9kYWwoKTsNCn0NCmZ1bmN0aW9uIG9wZW5Nb2RhbCgpeyAkKCdtb2RhbCcpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyAkKCdtb2RhbCcpLmNsYXNzTGlzdC5hZGQoJ2ZsZXgnKTsgfQ0KZnVuY3Rpb24gY2xvc2VNb2RhbCgpeyAkKCdtb2RhbCcpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyAkKCdtb2RhbCcpLmNsYXNzTGlzdC5yZW1vdmUoJ2ZsZXgnKTsgfQ0KZnVuY3Rpb24gb3BlbkxvcmFJbmZvKGwpew0KICAkKCdtb2RhbC10aXRsZScpLnRleHRDb250ZW50PSdEZXRhaWwgTG9SQSc7DQogICQoJ21jYXQnKS5pbm5lckhUTUw9Jyc7DQogIHZhciBiPSQoJ21vZGFsLWJvZHknKTsNCiAgYi5pbm5lckhUTUw9JzxkaXYgY2xhc3M9ImZsZXggZ2FwLTMgcC0yIj4nDQogICAgKyc8aW1nIHNyYz0iJytTK2wudGh1bWIrJy8xNDAiIGNsYXNzPSJ3LTI4IGgtMjggcm91bmRlZC1sZyBvYmplY3QtY292ZXIgc2hyaW5rLTAiLz4nDQogICAgKyc8ZGl2IGNsYXNzPSJmbGV4LTEgbWluLXctMCI+Jw0KICAgICsnPGRpdiBjbGFzcz0iZmxleCBmbGV4LXdyYXAgZ2FwLTEuNSBtYi0xIj4nDQogICAgKyc8c3BhbiBjbGFzcz0idGV4dC1bMTBweF0gZm9udC1zZW1pYm9sZCBiZy1bIzJhMmEyYV0gYm9yZGVyIGJkIHB4LTEuNSBweS0wLjUgcm91bmRlZCB0ZXh0LW5ldXRyYWwtNDAwIj5MT1JBPC9zcGFuPicNCiAgICArJzxzcGFuIGNsYXNzPSJ0ZXh0LVsxMHB4XSBmb250LXNlbWlib2xkIGJnLVtyZ2JhKDExMSw5MywyNTUsLjE1KV0gYm9yZGVyIGJvcmRlci1bIzZGNURGRl0gcHgtMS41IHB5LTAuNSByb3VuZGVkIHRleHQtWyM2RjVERkZdIj4nK2wuYmFkZ2UrJzwvc3Bhbj4nDQogICAgKyc8c3BhbiBjbGFzcz0idGV4dC1bMTBweF0gZm9udC1zZW1pYm9sZCBiZy1bIzJhMmEyYV0gYm9yZGVyIGJkIHB4LTEuNSBweS0wLjUgcm91bmRlZCB0ZXh0LW5ldXRyYWwtNDAwIj5PcmlnaW5hbDwvc3Bhbj4nDQogICAgKyc8L2Rpdj4nDQogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LXNtIGZvbnQtc2VtaWJvbGQiPicrbC5uYW1lKyc8L2Rpdj4nDQogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgbXQtMC41Ij5SZWt0eSBBSTwvZGl2PicNCiAgICArJzxkaXYgY2xhc3M9ImZsZXggaXRlbXMtY2VudGVyIGdhcC0xIG10LTEgdGV4dC14cyB0ZXh0LW5ldXRyYWwtNDAwIj48aSBkYXRhLWljb249ImRvd25sb2FkLXNpbXBsZSIgY2xhc3M9InctMy41IGgtMy41Ij48L2k+JysobC52aWV3cz9sLnZpZXdzOicxMksnKSsnIGRvd25sb2FkczwvZGl2PicNCiAgICArJzwvZGl2PjwvZGl2PicNCiAgICArJzxkaXYgY2xhc3M9ImJvcmRlci10IGJkIG10LTIgcHQtMyI+Jw0KICAgICsnPGRpdiBjbGFzcz0idGV4dC1zbSBmb250LXNlbWlib2xkIG1iLTIgZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEiPjxpIGRhdGEtaWNvbj0idGFnIiBjbGFzcz0idy00IGgtNCI+PC9pPlZlcnNpb24gRGV0YWlsPC9kaXY+Jw0KICAgICsnPGRpdiBjbGFzcz0iZ3JpZCBncmlkLWNvbHMtMiBnYXAtMiB0ZXh0LXhzIj4nDQogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiBib3JkZXIgYmQgcm91bmRlZC1sZyBweC0yIHB5LTEuNSI+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPkJhc2UgTW9kZWw8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPlogSW1hZ2U8L3NwYW4+PC9kaXY+Jw0KICAgICsnPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4gYm9yZGVyIGJkIHJvdW5kZWQtbGcgcHgtMiBweS0xLjUiPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtNTAwIj5TdGVwczwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+MjUwMDwvc3Bhbj48L2Rpdj4nDQogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiBib3JkZXIgYmQgcm91bmRlZC1sZyBweC0yIHB5LTEuNSI+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPkVwb2NoPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4xMjwvc3Bhbj48L2Rpdj4nDQogICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiBib3JkZXIgYmQgcm91bmRlZC1sZyBweC0yIHB5LTEuNSI+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC01MDAiPlRyaWdnZXIgV29yZHM8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtWyMyN0Q0Q0RdIj4nK2wudGFncy5zbGljZSgwLDIpLmpvaW4oJywgJykrJzwvc3Bhbj48L2Rpdj4nDQogICAgKyc8L2Rpdj4nDQogICAgKyc8ZGl2IGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC01MDAgbXQtMyBtYi0xIj5EZXNjcmlwdGlvbjwvZGl2PicNCiAgICArJzxkaXYgY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTQwMCBsZWFkaW5nLXJlbGF4ZWQiPicrbC50YWdzLmpvaW4oJywgJykrJyDigJQgTG9SQSB1bnR1ayBnYXlhIGRhbiBkZXRhaWwgdGFtYmFoYW4gZGkgWiBJbWFnZS48L2Rpdj4nOw0KICBvcGVuTW9kYWwoKTsNCn0NCiQoJ21vZGVsLWluZm8nKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oZSl7IGUuc3RvcFByb3BhZ2F0aW9uKCk7IG9wZW5Mb3JhSW5mbyh7bmFtZTokKCdtb2RlbC1uYW1lJykudGV4dENvbnRlbnQsYmFkZ2U6J1ogSW1hZ2UnLHRodW1iOid6aW1hZ2UnLHRhZ3M6WydkZXRhaWwnLCdzaGFycCddfSk7IH0pOw0KJCgnbW9kYWwtY2xvc2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsY2xvc2VNb2RhbCk7DQokKCdtb2RhbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbihlKXsgaWYoZS50YXJnZXQ9PT0kKCdtb2RhbCcpKSBjbG9zZU1vZGFsKCk7IH0pOw0KJCgnYnRuLWFkZGxvcmEnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsb3BlbkxvcmFNb2RhbCk7DQpkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCdrZXlkb3duJyxmdW5jdGlvbihlKXsgaWYoZS5rZXk9PT0nRXNjYXBlJykgY2xvc2VNb2RhbCgpOyB9KTsNCmZ1bmN0aW9uIHJlbmRlckxvcmEoKXsNCiAgdmFyIGxpc3QgPSAkKCdsb3JhLWxpc3QnKTsgbGlzdC5pbm5lckhUTUw9Jyc7DQogIGlmKCFMT1JBLmxlbmd0aCl7IGxpc3QuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJ0ZXh0LXhzIHRleHQtbmV1dHJhbC02MDAgYm9yZGVyIGJvcmRlci1kYXNoZWQgYm9yZGVyLVtyZ2JhKDI1NSwyNTUsMjU1LC4xNildIHJvdW5kZWQtbGcgcC0zIHRleHQtY2VudGVyIj5CZWx1bSBhZGEgTG9SQS4gS2xpayAiQWRkIExvUkEiLjwvZGl2Pic7IHJlbmRlclRyaWdnZXJzKCk7IHJldHVybjsgfQ0KICBMT1JBLmZvckVhY2goZnVuY3Rpb24obCxyaSl7DQogICAgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7DQogICAgZC5jbGFzc05hbWU9J2xvcmEtY2FyZCc7DQogICAgZC5pbm5lckhUTUw9JycNCiAgICAgICsnPHNwYW4gY2xhc3M9ImxvcmEtbGFiZWwiPkxvUkEgLSAnKyhsLmJhc2V8fCdaIEltYWdlJykrJzwvc3Bhbj4nDQogICAgICArJzxkaXYgY2xhc3M9ImxvcmEtdG9wIj4nDQogICAgICArJzxpbWcgc3JjPSInK1MrbC50aHVtYisnLzQwIiBjbGFzcz0ibG9yYS10aHVtYiIgYWx0PSIiLz4nDQogICAgICArJzxzcGFuIGNsYXNzPSJsb3JhLW5hbWUiPicrbC5uYW1lKyc8L3NwYW4+Jw0KICAgICAgKyc8ZGl2IGNsYXNzPSJsb3JhLWljb25zIj4nDQogICAgICArJzxidXR0b24gY2xhc3M9ImxvcmEtaWNvbiIgZGF0YS1pbmZvPSInK3JpKyciIHRpdGxlPSJJbmZvIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSIxMCIvPjxsaW5lIHgxPSIxMiIgeTE9IjE2IiB4Mj0iMTIiIHkyPSIxMiIvPjxsaW5lIHgxPSIxMiIgeTE9IjgiIHgyPSIxMi4wMSIgeTI9IjgiLz48L3N2Zz48L2J1dHRvbj4nDQogICAgICArJzxidXR0b24gY2xhc3M9ImxvcmEtaWNvbiBkZWwiIGRhdGEtZGVsPSInK3JpKyciIHRpdGxlPSJIYXB1cyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBvbHlsaW5lIHBvaW50cz0iMyA2IDUgNiAyMSA2Ii8+PHBhdGggZD0iTTE5IDZ2MTRhMiAyIDAgMCAxLTIgMkg3YTIgMiAwIDAgMS0yLTJWNm0zIDBWNGEyIDIgMCAwIDEgMi0yaDRhMiAyIDAgMCAxIDIgMnYyIi8+PGxpbmUgeDE9IjEwIiB5MT0iMTEiIHgyPSIxMCIgeTI9IjE3Ii8+PGxpbmUgeDE9IjE0IiB5MT0iMTEiIHgyPSIxNCIgeTI9IjE3Ii8+PC9zdmc+PC9idXR0b24+Jw0KICAgICAgKyc8L2Rpdj4nDQogICAgICArJzwvZGl2PicNCiAgICAgICsnPGRpdiBjbGFzcz0ibG9yYS1zbGlkZXItcm93Ij4nDQogICAgICArJzxkaXYgY2xhc3M9Imwtc2xpZGVyIj48ZGl2IGNsYXNzPSJsLXRyYWNrIj48L2Rpdj48ZGl2IGNsYXNzPSJsLWZpbGwiIHN0eWxlPSJ3aWR0aDonKyhsLncvMioxMDApKyclIj48L2Rpdj48ZGl2IGNsYXNzPSJsLWhhbmRsZSIgc3R5bGU9ImxlZnQ6JysobC53LzIqMTAwKSsnJSI+PC9kaXY+PGlucHV0IHR5cGU9InJhbmdlIiBtaW49IjAiIG1heD0iMiIgc3RlcD0iMC4xIiB2YWx1ZT0iJytsLncrJyIgZGF0YS1yaT0iJytyaSsnIiBjbGFzcz0ibG9yYS1zbCIvPjwvZGl2PicNCiAgICAgICsnPGRpdiBjbGFzcz0ibC1udW0iPicNCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0ibG9yYS1idG4iIGRhdGEtZGVjPSInK3JpKyciPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxsaW5lIHgxPSI1IiB5MT0iMTIiIHgyPSIxOSIgeTI9IjEyIi8+PC9zdmc+PC9idXR0b24+Jw0KICAgICAgKyc8aW5wdXQgdHlwZT0idGV4dCIgdmFsdWU9IicrbC53LnRvRml4ZWQoMSkrJyIgY2xhc3M9ImxvcmEtaW5wdXQiIGRhdGEtcmk9IicrcmkrJyIgaW5wdXRtb2RlPSJkZWNpbWFsIi8+Jw0KICAgICAgKyc8YnV0dG9uIGNsYXNzPSJsb3JhLWJ0biIgZGF0YS1pbmM9IicrcmkrJyI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGxpbmUgeDE9IjEyIiB5MT0iNSIgeDI9IjEyIiB5Mj0iMTkiLz48bGluZSB4MT0iNSIgeTE9IjEyIiB4Mj0iMTkiIHkyPSIxMiIvPjwvc3ZnPjwvYnV0dG9uPicNCiAgICAgICsnPC9kaXY+Jw0KICAgICAgKyhsLm5lZWRVcmw/JzxkaXYgY2xhc3M9Im10LTIiPjxpbnB1dCB0eXBlPSJ0ZXh0IiBjbGFzcz0iaW5wIGxvcmEtdXJsLWlucCIgdmFsdWU9IicrKGwubG9yYVVybHx8JycpKyciIGRhdGEtdXJsPSInK3JpKyciIHBsYWNlaG9sZGVyPSJodHRwczovL2h1Z2dpbmdmYWNlLmNvL3VzZXIvcmVwby9yZXNvbHZlL21haW4vbG9yYS5zYWZldGVuc29ycyIvPjxkaXYgY2xhc3M9Im10LTEgdGV4dC1bMTBweF0gbGVhZGluZy1zbnVnIHRleHQtbmV1dHJhbC01MDAiPlVSTCBwdWJsaWsgbGFuZ3N1bmcgKC5zYWZldGVuc29ycykg4oCUIGNvbnRvaCBIdWdnaW5nRmFjZSByZXNvbHZlLiBLYWdnbGUgdGlkYWsgYmlzYSAoYnV0dWggbG9naW4pLjwvZGl2PjwvZGl2Pic6JycpDQogICAgICArJzwvZGl2Pic7DQogICAgdmFyIHNsPWQucXVlcnlTZWxlY3RvcignLmwtc2xpZGVyIFtkYXRhLXJpPSInK3JpKyciXScpOw0KICAgIHZhciB1SW5wPWQucXVlcnlTZWxlY3RvcignW2RhdGEtdXJsPSInK3JpKyciXScpOw0KICAgIGlmKHVJbnApeyB1SW5wLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbihlKXsgTE9SQVtyaV0ubG9yYVVybD1lLnRhcmdldC52YWx1ZS50cmltKCk7IH0pOyB9DQogICAgc2wuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpew0KICAgICAgdmFyIHY9cGFyc2VGbG9hdChlLnRhcmdldC52YWx1ZSk7IGlmKGlzTmFOKHYpKXJldHVybjsNCiAgICAgIExPUkFbcmldLnc9djsNCiAgICAgIHZhciBwY3Q9KHYvMioxMDApOw0KICAgICAgZC5xdWVyeVNlbGVjdG9yKCcubC1maWxsJykuc3R5bGUud2lkdGg9cGN0KyclJzsNCiAgICAgIGQucXVlcnlTZWxlY3RvcignLmwtaGFuZGxlJykuc3R5bGUubGVmdD1wY3QrJyUnOw0KICAgICAgZC5xdWVyeVNlbGVjdG9yKCcubG9yYS1pbnB1dCcpLnZhbHVlPXYudG9GaXhlZCgxKTsNCiAgICAgIHJlbmRlclRyaWdnZXJzKCk7DQogICAgfSk7DQogICAgZC5xdWVyeVNlbGVjdG9yKCcubC1udW0gW2RhdGEtaW5jPSInK3JpKyciXScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBzZXRMVyhyaSwrKExPUkFbcmldLncrMC4xKS50b0ZpeGVkKDEpKTsgcmVuZGVyTG9yYSgpOyB9KTsNCiAgICBkLnF1ZXJ5U2VsZWN0b3IoJy5sLW51bSBbZGF0YS1kZWM9IicrcmkrJyJdJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IHNldExXKHJpLCsoTE9SQVtyaV0udy0wLjEpLnRvRml4ZWQoMSkpOyByZW5kZXJMb3JhKCk7IH0pOw0KICAgIGQucXVlcnlTZWxlY3RvcignW2RhdGEtZGVsPSInK3JpKyciXScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBMT1JBLnNwbGljZShyaSwxKTsgcmVuZGVyTG9yYSgpOyByZW5kZXJUcmlnZ2VycygpOyB9KTsNCiAgICBkLnF1ZXJ5U2VsZWN0b3IoJ1tkYXRhLWluZm89IicrcmkrJyJdJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IG9wZW5Mb3JhSW5mbyhsKTsgfSk7DQogICAgbGlzdC5hcHBlbmRDaGlsZChkKTsNCiAgfSk7DQogIHJlbmRlclRyaWdnZXJzKCk7DQp9DQpmdW5jdGlvbiBzZXRMVyhpLHYpeyBMT1JBW2ldLnc9TWF0aC5tYXgoMCxNYXRoLm1pbigyLHYpKTsgfQ0KdmFyIF9wZW5kaW5nVHJpZyA9IFtdOw0KZnVuY3Rpb24gcmVuZGVyVHJpZ2dlcnMoKXsNCiAgdmFyIHA9KCQoJ3Byb21wdCcpLnZhbHVlfHwnJykudG9Mb3dlckNhc2UoKTsNCiAgdmFyIHQ9JCgndHJpZ2dlcnMnKTsgdC5pbm5lckhUTUw9Jyc7DQogIF9wZW5kaW5nVHJpZz1bXTsNCiAgTE9SQS5maWx0ZXIoZnVuY3Rpb24obCl7cmV0dXJuIGwudz4wfSkuZm9yRWFjaChmdW5jdGlvbihsKXsNCiAgICBsLnRhZ3MuZm9yRWFjaChmdW5jdGlvbih3KXsgaWYocC5pbmRleE9mKHcudG9Mb3dlckNhc2UoKSk8MCkgX3BlbmRpbmdUcmlnLnB1c2goe3dvcmQ6dyxsb3JhOmwubmFtZX0pOyB9KTsNCiAgfSk7DQogICQoJ3RyLWNvdW50JykudGV4dENvbnRlbnQ9X3BlbmRpbmdUcmlnLmxlbmd0aDsNCiAgaWYoIV9wZW5kaW5nVHJpZy5sZW5ndGgpeyB0LmlubmVySFRNTD0nPHNwYW4gY2xhc3M9InRleHQteHMgdGV4dC1uZXV0cmFsLTYwMCI+VGlkYWsgYWRhIHRyaWdnZXIgd29yZCB0ZXJzaXNhPC9zcGFuPic7IHJldHVybjsgfQ0KICBfcGVuZGluZ1RyaWcuZm9yRWFjaChmdW5jdGlvbihpdGVtKXsNCiAgICB2YXIgYj1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsNCiAgICBiLmNsYXNzTmFtZT0ndGFnIGN1cnNvci1wb2ludGVyIGhvdmVyOmJvcmRlci1bIzI3RDRDRF0gaG92ZXI6dGV4dC1bIzI3RDRDRF0gdHJhbnNpdGlvbic7DQogICAgYi5pbm5lckhUTUw9JzxpIGRhdGEtaWNvbj0ic3BhcmtsZSIgY2xhc3M9InctMyBoLTMgdGV4dC1bIzI3RDRDRF0iPjwvaT4nK2l0ZW0ud29yZDsNCiAgICBiLnRpdGxlPSdUYW1iYWhrYW4ga2UgcHJvbXB0ICgnK2l0ZW0ubG9yYSsnKSc7DQogICAgYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsNCiAgICAgIGFkZFdvcmQoaXRlbS53b3JkKTsNCiAgICAgIHJlbmRlclRyaWdnZXJzKCk7DQogICAgfSk7DQogICAgdC5hcHBlbmRDaGlsZChiKTsNCiAgfSk7DQp9DQpmdW5jdGlvbiBhZGRXb3JkKHcpew0KICB2YXIgcHI9JCgncHJvbXB0JyksIGN2PXByLnZhbHVlLnRyaW0oKTsNCiAgaWYoY3YgJiYgIWN2LmVuZHNXaXRoKCcsJykpIGN2Kz0nLCc7DQogIHByLnZhbHVlPWN2K3crJywnOw0KICBwci5mb2N1cygpOw0KfQ0KZnVuY3Rpb24gYWRkQWxsVHJpZygpew0KICB2YXIgYWxsPV9wZW5kaW5nVHJpZy5tYXAoZnVuY3Rpb24oeCl7cmV0dXJuIHgud29yZH0pOw0KICBhbGwuZm9yRWFjaChhZGRXb3JkKTsNCiAgcmVuZGVyVHJpZ2dlcnMoKTsNCn0NCiQoJ2FkZGFsbC10cmlnJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGFkZEFsbFRyaWcpOw0KDQovKiA9PT09PSBhc3BlY3QgcmF0aW8gPT09PT0gKi8NCnZhciBBUl9NQVAgPSB7DQogIHBvcnRyYWl0OlsnUG9ydHJhaXQnLDc2OCwxMTUyXSwNCiAgbGFuZHNjYXBlOlsnTGFuZHNjYXBlJywxMTUyLDc2OF0sDQogIHNxdWFyZTpbJ1NxdWFyZScsMTAyNCwxMDI0XSwNCiAgY3VzdG9tOlsnY3VzdG9tJyxudWxsLG51bGxdDQp9Ow0KZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmFyJykuZm9yRWFjaChmdW5jdGlvbihiKXsNCiAgYi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsNCiAgICB2YXIgYXI9Yi5kYXRhc2V0LmFyOyBzdGF0ZS5hc3BlY3Q9YXI7DQogICAgc2V0QXJBY3RpdmUoYXIpOw0KICAgIGlmKGFyIT09J2N1c3RvbScpeyAkKCd3aWR0aCcpLnZhbHVlPUFSX01BUFthcl1bMV07ICQoJ2hlaWdodCcpLnZhbHVlPUFSX01BUFthcl1bMl07IH0NCiAgICB1cGRXSCgpOw0KICB9KTsNCn0pOw0KZnVuY3Rpb24gdXBkV0goKXsgJCgnd3YnKS52YWx1ZT0kKCd3aWR0aCcpLnZhbHVlOyAkKCdodicpLnZhbHVlPSQoJ2hlaWdodCcpLnZhbHVlOyB9DQokKCd3aWR0aCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbigpeyAkKCd3dicpLnZhbHVlPSQoJ3dpZHRoJykudmFsdWU7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsNCiQoJ2hlaWdodCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbigpeyAkKCdodicpLnZhbHVlPSQoJ2hlaWdodCcpLnZhbHVlOyBzdGF0ZS5hc3BlY3Q9J2N1c3RvbSc7IHNldEFyQWN0aXZlKCdjdXN0b20nKTsgfSk7DQokKCd3dicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsZnVuY3Rpb24oKXsgdmFyIHY9TWF0aC5tYXgoMjU2LE1hdGgubWluKDE1MzYscGFyc2VJbnQoJCgnd3YnKS52YWx1ZSl8fDc2OCkpOyB2PU1hdGgucm91bmQodi82NCkqNjQ7ICQoJ3d2JykudmFsdWU9djsgJCgnd2lkdGgnKS52YWx1ZT12OyBzdGF0ZS5hc3BlY3Q9J2N1c3RvbSc7IHNldEFyQWN0aXZlKCdjdXN0b20nKTsgfSk7DQokKCdodicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsZnVuY3Rpb24oKXsgdmFyIHY9TWF0aC5tYXgoMjU2LE1hdGgubWluKDE1MzYscGFyc2VJbnQoJCgnaHYnKS52YWx1ZSl8fDExNTIpKTsgdj1NYXRoLnJvdW5kKHYvNjQpKjY0OyAkKCdodicpLnZhbHVlPXY7ICQoJ2hlaWdodCcpLnZhbHVlPXY7IHN0YXRlLmFzcGVjdD0nY3VzdG9tJzsgc2V0QXJBY3RpdmUoJ2N1c3RvbScpOyB9KTsNCmZ1bmN0aW9uIHNldEFyQWN0aXZlKGFyKXsNCiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmFyJykuZm9yRWFjaChmdW5jdGlvbih4KXt4LmNsYXNzTGlzdC50b2dnbGUoJ3NlbCcsIHguZGF0YXNldC5hcj09PWFyKX0pOw0KICAkKCdhci1sYWJlbCcpLnRleHRDb250ZW50PUFSX01BUFthcl1bMF07DQp9DQokKCdzdGVwcycpLmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0JyxmdW5jdGlvbihlKXskKCdzdicpLnRleHRDb250ZW50PWUudGFyZ2V0LnZhbHVlfSk7DQokKCdjZmcnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7JCgnY2Z2JykudGV4dENvbnRlbnQ9ZS50YXJnZXQudmFsdWV9KTsNCiQoJ2NsaXBza2lwJykuYWRkRXZlbnRMaXN0ZW5lcignaW5wdXQnLGZ1bmN0aW9uKGUpeyQoJ2NzdicpLnRleHRDb250ZW50PWUudGFyZ2V0LnZhbHVlfSk7DQokKCdldGFuc2QnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7JCgnZW5zZCcpLnRleHRDb250ZW50PWUudGFyZ2V0LnZhbHVlfSk7DQokKCdhZHYtdG9nZ2xlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7JCgnYWR2LWZpZWxkcycpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicpfSk7DQokKCdkaWNlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7JCgnc2VlZCcpLnZhbHVlPVN0cmluZyhNYXRoLmZsb29yKE1hdGgucmFuZG9tKCkqOTk5OTk5OTk5OTk5OTk5OSkpfSk7DQokKCduZWdjaGVjaycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsZnVuY3Rpb24oZSl7JCgnbmVnd3JhcCcpLmNsYXNzTGlzdC50b2dnbGUoJ2hpZGRlbicsIWUudGFyZ2V0LmNoZWNrZWQpfSk7DQokKCdwcm9tcHQnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcscmVuZGVyVHJpZ2dlcnMpOw0KJCgnYnRuLWVuaGFuY2UnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsNCiAgdmFyIHA9KCQoJ3Byb21wdCcpLnZhbHVlfHwnJykudHJpbSgpOw0KICBpZighcCl7ICQoJ3Byb21wdCcpLmZvY3VzKCk7IHJldHVybjsgfQ0KICB2YXIgYj0kKCdidG4tZW5oYW5jZScpOw0KICBiLmlubmVySFRNTD0nPGkgZGF0YS1pY29uPSJjaXJjbGUtbm90Y2giIGNsYXNzPSJ3LTMuNSBoLTMuNSBhbmltYXRlLXNwaW4iPjwvaT5FbmhhbmNpbmcuLi4nOw0KICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7DQogICAgJCgncHJvbXB0JykudmFsdWU9cA0KICAgICAgKydcblxuRW5oYW5jZSBkZXRhaWwsIGxpZ2h0aW5nLCBjb21wb3NpdGlvbiwgYW5kIGF0bW9zcGhlcmUuICcNCiAgICAgICsnVWx0cmEtZGV0YWlsZWQsIHByb2Zlc3Npb25hbCBwaG90b2dyYXBoeSwgc2hhcnAgZm9jdXMsIGNpbmVtYXRpYyBsaWdodGluZy4nOw0KICAgIHJlbmRlclRyaWdnZXJzKCk7DQogICAgYi5pbm5lckhUTUw9JzxpIGRhdGEtaWNvbj0ic3BhcmtsZSIgY2xhc3M9InctMy41IGgtMy41Ij48L2k+RW5oYW5jZSc7DQogIH0sOTAwKTsNCn0pOw0KZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLmNoaXAnKS5mb3JFYWNoKGZ1bmN0aW9uKGMpew0KICBjLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpe2MuY2xhc3NMaXN0LnRvZ2dsZSgnb24nKX0pOw0KfSk7DQoNCi8qID09PT09IHRhYnMgPT09PT0gKi8NCmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50YWInKS5mb3JFYWNoKGZ1bmN0aW9uKHQpew0KICB0LmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpew0KICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoJy50YWInKS5mb3JFYWNoKGZ1bmN0aW9uKHgpe3guY2xhc3NMaXN0LnJlbW92ZSgnc2VsJyl9KTsNCiAgICB0LmNsYXNzTGlzdC5hZGQoJ3NlbCcpOyBzdGF0ZS5wYWdlPXQuZGF0YXNldC50YWI7DQogICAgcmVuZGVyQ2FudmFzKCk7DQogIH0pOw0KfSk7DQpkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCcucnRhYicpLmZvckVhY2goZnVuY3Rpb24odCl7DQogIHQuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7DQogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnJ0YWInKS5mb3JFYWNoKGZ1bmN0aW9uKHgpe3guY2xhc3NMaXN0LnJlbW92ZSgnc2VsJyl9KTsNCiAgICB0LmNsYXNzTGlzdC5hZGQoJ3NlbCcpOw0KICB9KTsNCn0pOw0KDQovKiA9PT09PSBtb2JpbGUgZHJhd2VyID09PT09ICovDQokKCdtbWVudScpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBvcGVuTGVmdCgpOyB9KTsNCiQoJ292ZXJsYXknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgY2xvc2VMZWZ0KCk7IH0pOw0KZnVuY3Rpb24gb3BlbkxlZnQoKXsgJCgnb3ZlcmxheScpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyAkKCdsZWZ0cGFuJykuY2xhc3NMaXN0LnJlbW92ZSgnLXRyYW5zbGF0ZS14LWZ1bGwnKTsgfQ0KZnVuY3Rpb24gY2xvc2VMZWZ0KCl7ICQoJ292ZXJsYXknKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsgaWYod2luZG93LmlubmVyV2lkdGg8MTAyNCkgJCgnbGVmdHBhbicpLmNsYXNzTGlzdC5hZGQoJy10cmFuc2xhdGUteC1mdWxsJyk7IH0NCg0KLyogPT09PT0gaW1hZ2UgY291bnQgPT09PT0gKi8NCiQoJ25jb2wnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsNCiAgc3RhdGUubmNvbCA9IHN0YXRlLm5jb2w9PT0yPzE6MjsNCiAgJCgnZ3JpZCcpLmNsYXNzTmFtZT0nZ3JpZCBncmlkLWNvbHMtJytzdGF0ZS5uY29sKycgZ2FwLTMnOw0KICAkKCduY29sbGJsJykudGV4dENvbnRlbnQ9c3RhdGUubmNvbDsNCn0pOw0KDQovKiA9PT09PSBnZW5lcmF0ZSAocmVhbCBBUEkgLyBkZW1vIGZhbGxiYWNrKSA9PT09PSAqLw0KJCgnYnRuLWdvJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGRvR2VuZXJhdGUpOw0KZnVuY3Rpb24gc2V0QnVzeShiKXsNCiAgJCgnYnRuLWdvJykuZGlzYWJsZWQ9YjsgJCgnYnRuLWdvJykuc3R5bGUub3BhY2l0eT1iPycwLjUnOicxJzsNCiAgJCgnYnRuLWdvJykuaW5uZXJIVE1MPWI/JzxpIGRhdGEtaWNvbj0iY2lyY2xlLW5vdGNoIiBjbGFzcz0idy00IGgtNCBhbmltYXRlLXNwaW4iPjwvaT5HZW5lcmF0aW5nLi4uJw0KICAgIDonPGkgZGF0YS1pY29uPSJwbGF5IiBjbGFzcz0idy00IGgtNCI+PC9pPkdlbmVyYXRlIDxzcGFuIGNsYXNzPSJ0ZXh0LXhzIG9wYWNpdHktOTAgZm9udC1ub3JtYWwiPiskMC4zMzwvc3Bhbj4nOw0KfQ0KZnVuY3Rpb24gZXh0cmFjdEltYWdlcyhkYXRhKXsNCiAgaWYoIWRhdGEpIHJldHVybiBbXTsNCiAgaWYoQXJyYXkuaXNBcnJheShkYXRhKSkgZGF0YT17aW1hZ2VzOmRhdGF9Ow0KICB2YXIgaW1ncz1kYXRhLmltYWdlc3x8ZGF0YS5kYXRhJiZkYXRhLmRhdGEuaW1hZ2VzfHxkYXRhLnJlc3VsdCYmZGF0YS5yZXN1bHQuaW1hZ2VzfHxkYXRhLnVybHN8fFtdOw0KICByZXR1cm4gaW1ncy5tYXAoZnVuY3Rpb24oaSl7IHJldHVybiB0eXBlb2YgaT09PSdzdHJpbmcnP2k6KGkudXJsfHxpLnNyY3x8aS5pbWFnZXx8aS5wYXRoKTsgfSkuZmlsdGVyKEJvb2xlYW4pOw0KfQ0KLyogPT09PT0gaGFzaWwgKyByaXdheWF0IChwZXJzaXN0IGxvY2FsU3RvcmFnZSkgPT09PT0gKi8NCmZ1bmN0aW9uIHBlcnNpc3RSZXN1bHRzKCl7DQogIHRyeXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oUkVTVUxUU19LRVksSlNPTi5zdHJpbmdpZnkoc3RhdGUucmVzdWx0cy5zbGljZSgwLDYwKSkpOyB9Y2F0Y2goZSl7fQ0KfQ0KZnVuY3Rpb24gbWFrZUdyaWRDYXJkKHIpew0KICB2YXIgZz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCdkaXYnKTsNCiAgZy5jbGFzc05hbWU9J3JlbGF0aXZlIHJvdW5kZWQteGwgb3ZlcmZsb3ctaGlkZGVuIGJvcmRlciBiZCBhc3BlY3QtWzQvNV0gYmctWyMyYTJhMmFdIGN1cnNvci1wb2ludGVyIGhvdmVyOmJvcmRlci1bcmdiYSgyNTUsMjU1LDI1NSwuMjQpXSc7DQogIGcuaW5uZXJIVE1MPSc8aW1nIHNyYz0iJytyLnNyYysnIiBjbGFzcz0idy1mdWxsIGgtZnVsbCBvYmplY3QtY292ZXIiLz4nDQogICAgKyhyLmRlbW8/JzxzcGFuIGNsYXNzPSJhYnNvbHV0ZSB0b3AtMS41IGxlZnQtMS41IHRleHQtWzlweF0gYmctYmxhY2svNjAgcHgtMS41IHB5LTAuNSByb3VuZGVkIHRleHQtbmV1dHJhbC0zMDAiPkRFTU88L3NwYW4+JzonJyk7DQogIGcuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7IG9wZW5MaWdodGJveChyKTsgfSk7DQogIHJldHVybiBnOw0KfQ0KZnVuY3Rpb24gcmVuZGVyR3JpZCgpew0KICB2YXIgZ3JpZD0kKCdncmlkJyk7IGdyaWQuaW5uZXJIVE1MPScnOw0KICB2YXIgYXJyPXN0YXRlLnJlc3VsdHMuc2xpY2UoKS5yZXZlcnNlKCk7IC8vIGhhc2lsIHRlcmJhcnUgdGFtcGlsIGR1bHVhbg0KICBhcnIuZm9yRWFjaChmdW5jdGlvbihyKXsgZ3JpZC5hcHBlbmRDaGlsZChtYWtlR3JpZENhcmQocikpOyB9KTsNCiAgJCgnZW1wdHknKS5zdHlsZS5kaXNwbGF5ID0gc3RhdGUucmVzdWx0cy5sZW5ndGg+MCA/ICdub25lJyA6ICcnOw0KfQ0KZnVuY3Rpb24gYWRkUmVzdWx0KHIpew0KICBzdGF0ZS5yZXN1bHRzLnVuc2hpZnQocik7DQogIGlmKHN0YXRlLnJlc3VsdHMubGVuZ3RoPjYwKSBzdGF0ZS5yZXN1bHRzLmxlbmd0aD02MDsNCiAgcGVyc2lzdFJlc3VsdHMoKTsNCiAgcmVuZGVyR3JpZCgpOw0KICByZW5kZXJSaWdodCgpOw0KfQ0KDQovKiA9PT09PSByaWdodCBoaXN0b3J5ID09PT09ICovDQpmdW5jdGlvbiBmbXREYXRlKHRzKXsgdHJ5eyByZXR1cm4gbmV3IERhdGUodHMpLnRvTG9jYWxlRGF0ZVN0cmluZygnaWQtSUQnKTsgfWNhdGNoKGUpeyByZXR1cm4gJyc7IH0gfQ0KZnVuY3Rpb24gcmVuZGVyUmlnaHQoKXsNCiAgdmFyIGxpc3Q9JCgncmxpc3QnKTsgbGlzdC5pbm5lckhUTUw9Jyc7DQogIGlmKCFzdGF0ZS5yZXN1bHRzLmxlbmd0aCl7IGxpc3QuaW5uZXJIVE1MPSc8cCBjbGFzcz0idGV4dC14cyB0ZXh0LW5ldXRyYWwtNTAwIHAtNCB0ZXh0LWNlbnRlciI+QmVsdW0gYWRhIGhhc2lsLjwvcD4nOyAkKCdyY291bnQnKS50ZXh0Q29udGVudD0nMCBoYXNpbCc7IHJldHVybjsgfQ0KICAkKCdyY291bnQnKS50ZXh0Q29udGVudD1zdGF0ZS5yZXN1bHRzLmxlbmd0aCsnIGhhc2lsJzsNCiAgc3RhdGUucmVzdWx0cy5mb3JFYWNoKGZ1bmN0aW9uKHIsaSl7DQogICAgdmFyIGQ9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnZGl2Jyk7IGQuY2xhc3NOYW1lPSdyY2FyZCc7DQogICAgdmFyIGxibD1yLmRlbW8/J0RlbW8gKHNpbXVsYXNpKSc6KHIucGFnZT09PSdpbWcnPydJbWFnZSB0byBJbWFnZSc6J1RleHQgdG8gSW1hZ2UnKTsNCiAgICBkLmlubmVySFRNTD0nPGRpdiBjbGFzcz0icmVsYXRpdmUiPicNCiAgICAgICsnPGltZyBzcmM9Iicrci5zcmMrJyIgY2xhc3M9InctZnVsbCBhc3BlY3QtWzQvM10gb2JqZWN0LWNvdmVyIGN1cnNvci1wb2ludGVyIi8+Jw0KICAgICAgKyc8YnV0dG9uIGNsYXNzPSJhYnNvbHV0ZSB0b3AtMS41IHJpZ2h0LTEuNSB3LTYgaC02IHJvdW5kZWQtbWQgYmctYmxhY2svNTAgaG92ZXI6YmctcmVkLTUwMC84MCB0ZXh0LXdoaXRlIGZsZXggaXRlbXMtY2VudGVyIGp1c3RpZnktY2VudGVyIHRleHQteHMiIHRpdGxlPSJIYXB1cyI+4pyVPC9idXR0b24+Jw0KICAgICAgKyc8L2Rpdj4nDQogICAgICArJzxkaXYgY2xhc3M9InAtMi41IHNwYWNlLXktMS41IHRleHQteHMiPicNCiAgICAgICsnPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEuNSI+PGkgZGF0YS1pY29uPSJzcGFya2xlIiBjbGFzcz0idy0zIGgtMyB0ZXh0LXZpb2xldC00MDAiPjwvaT48c3BhbiBjbGFzcz0iYmctdmlvbGV0LTUwMC8xMCB0ZXh0LXZpb2xldC0zMDAgcHgtMS41IHB5LXB4IHJvdW5kZWQgdGV4dC1bMTBweF0iPicrbGJsKyc8L3NwYW4+PC9kaXY+Jw0KICAgICAgKyc8ZGl2IGNsYXNzPSJiZy1ibGFjay80MCByb3VuZGVkIHAtMS41IHRleHQtWzExcHhdIHRleHQtbmV1dHJhbC0zMDAgbGVhZGluZy1zbnVnIGN1cnNvci1wb2ludGVyIGhvdmVyOnRleHQtd2hpdGUiIHRpdGxlPSJMaWhhdCBkZXRhaWwiPicrKHIucHJvbXB0fHwnJykuc2xpY2UoMCw5MCkrJzwvZGl2PicNCiAgICAgICsnPGRpdiBjbGFzcz0iZmxleCBpdGVtcy1jZW50ZXIgZ2FwLTEgdGV4dC1bMTBweF0gdGV4dC1uZXV0cmFsLTUwMCI+PGkgZGF0YS1pY29uPSJsYXllcnMiIGNsYXNzPSJ3LTMgaC0zIj48L2k+JytMT1JBLmZpbHRlcihmdW5jdGlvbihsKXtyZXR1cm4gbC53PjB9KS5sZW5ndGgrJyBMb1JBPC9kaXY+Jw0KICAgICAgKyc8ZGl2IGNsYXNzPSJzcGFjZS15LTEgdGV4dC1bMTBweF0gdGV4dC1uZXV0cmFsLTUwMCI+Jw0KICAgICAgKyhyLnRhc2tJZD8nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlRhc2sgSUQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAgdHJ1bmNhdGUgbWF4LXctWzYwJV0iIHRpdGxlPSInK3IudGFza0lkKyciPicrci50YXNrSWQrJzwvc3Bhbj48L2Rpdj4nOicnKQ0KICAgICAgKyhyLmNyZWRpdHM/JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DcmVkaXRzPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK3IuY3JlZGl0cysnPC9zcGFuPjwvZGl2Pic6JycpDQogICAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5DcmVhdGVkPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK2ZtdERhdGUoci50cykrJzwvc3Bhbj48L2Rpdj4nDQogICAgICArKHIubmVnPyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+TmVnYXRpdmU8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0zMDAgdHJ1bmNhdGUgbWF4LXctWzYwJV0iIHRpdGxlPSInK3IubmVnKyciPicrci5uZWcrJzwvc3Bhbj48L2Rpdj4nOicnKQ0KICAgICAgKyc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+U2l6ZTwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTMwMCI+JytyLnNpemUrJzwvc3Bhbj48L2Rpdj4nDQogICAgICArJzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TZWVkPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMzAwIj4nK3Iuc2VlZCsnPC9zcGFuPjwvZGl2PicNCiAgICAgICsnPC9kaXY+PC9kaXY+JzsNCiAgICBkLnF1ZXJ5U2VsZWN0b3IoJ2ltZycpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBvcGVuTGlnaHRib3gocik7IH0pOw0KICAgIGQucXVlcnlTZWxlY3RvcignLmJnLWJsYWNrXFwvNDAnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgb3BlbkxpZ2h0Ym94KHIpOyB9KTsNCiAgICBkLnF1ZXJ5U2VsZWN0b3IoJ2J1dHRvbicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpew0KICAgICAgc3RhdGUucmVzdWx0cy5zcGxpY2UoaSwxKTsgcGVyc2lzdFJlc3VsdHMoKTsgcmVuZGVyUmlnaHQoKTsNCiAgICB9KTsNCiAgICBsaXN0LmFwcGVuZENoaWxkKGQpOw0KICB9KTsNCn0NCg0KLyogPT09PT0gbGlnaHRib3ggPT09PT0gKi8NCmZ1bmN0aW9uIG9wZW5MaWdodGJveChyKXsNCiAgJCgnbGItaW1nJykuc3JjPXIuc3JjOw0KICB2YXIgaD0nJzsNCiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5Nb2RlbDwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+Jysoci5tb2RlbHx8Jy0nKSsnPC9zcGFuPjwvZGl2Pic7DQogIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+UHJvbXB0PC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nKyhyLnByb21wdHx8Jy0nKSsnPC9zcGFuPjwvZGl2Pic7DQogIGlmKHIubmVnKSBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPk5lZ2F0aXZlPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nK3IubmVnKyc8L3NwYW4+PC9kaXY+JzsNCiAgaCs9JzxkaXYgY2xhc3M9ImZsZXgganVzdGlmeS1iZXR3ZWVuIj48c3Bhbj5TaXplPC9zcGFuPjxzcGFuIGNsYXNzPSJ0ZXh0LW5ldXRyYWwtMjAwIj4nKyhyLnNpemV8fCctJykrJzwvc3Bhbj48L2Rpdj4nOw0KICBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlNlZWQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrKHIuc2VlZHx8Jy0nKSsnPC9zcGFuPjwvZGl2Pic7DQogIGlmKHIudGFza0lkKSBoKz0nPGRpdiBjbGFzcz0iZmxleCBqdXN0aWZ5LWJldHdlZW4iPjxzcGFuPlRhc2sgSUQ8L3NwYW4+PHNwYW4gY2xhc3M9InRleHQtbmV1dHJhbC0yMDAiPicrci50YXNrSWQrJzwvc3Bhbj48L2Rpdj4nOw0KICBpZihyLmNyZWRpdHMpIGgrPSc8ZGl2IGNsYXNzPSJmbGV4IGp1c3RpZnktYmV0d2VlbiI+PHNwYW4+Q3JlZGl0czwvc3Bhbj48c3BhbiBjbGFzcz0idGV4dC1uZXV0cmFsLTIwMCI+JytyLmNyZWRpdHMrJzwvc3Bhbj48L2Rpdj4nOw0KICBoKz0nPGRpdiBjbGFzcz0ibXQtMiI+PGEgaHJlZj0iJytyLnNyYysnIiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciIgY2xhc3M9InRleHQtWyM2RjVERkZdIGhvdmVyOnVuZGVybGluZSB0ZXh0LXhzIj5CdWthIGdhbWJhciBhc2xpICZuZWFycjs8L2E+PC9kaXY+JzsNCiAgJCgnbGItbWV0YScpLmlubmVySFRNTD1oOw0KICAkKCdsaWdodGJveCcpLmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOyAkKCdsaWdodGJveCcpLmNsYXNzTGlzdC5hZGQoJ2ZsZXgnKTsNCn0NCiQoJ2xiLWNsb3NlJykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKCl7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ2xpZ2h0Ym94JykuY2xhc3NMaXN0LnJlbW92ZSgnZmxleCcpOyB9KTsNCiQoJ2xpZ2h0Ym94JykuYWRkRXZlbnRMaXN0ZW5lcignY2xpY2snLGZ1bmN0aW9uKGUpeyBpZihlLnRhcmdldD09PSQoJ2xpZ2h0Ym94JykpeyAkKCdsaWdodGJveCcpLmNsYXNzTGlzdC5hZGQoJ2hpZGRlbicpOyAkKCdsaWdodGJveCcpLmNsYXNzTGlzdC5yZW1vdmUoJ2ZsZXgnKTsgfSB9KTsNCg0KLyogPT09PT0gcGF5bG9hZCAoc3RydWt0dXIgbnlhdGEgVGVuc29yLkFydCkgPT09PT0gKi8NCmZ1bmN0aW9uIGJ1aWxkUGF5bG9hZCgpew0KICB2YXIgbmVnPSQoJ25lZ2NoZWNrJykuY2hlY2tlZD8kKCduZWdwcm9tcHQnKS52YWx1ZTonJzsNCiAgdmFyIG09c3RhdGUubW9kZWw7DQogIHJldHVybiB7DQogICAgcGFyYW1zOnsNCiAgICAgIGJhc2VNb2RlbDp7IG1vZGVsSWQ6bS5tb2RlbElkLCBtb2RlbEZpbGVJZDptLm1vZGVsRmlsZUlkIH0sDQogICAgICBtb2RlbDpzZXR0aW5ncy5wcm92aWRlcj09PSd0YW1zJz8nJzoobSYmbS5tb2RlbD9tLm1vZGVsOicnKSwNCiAgICAgIHNkeGw6eyByZWZpbmVyOmZhbHNlIH0sDQogICAgICBtb2RlbHM6TE9SQS5maWx0ZXIoZnVuY3Rpb24obCl7cmV0dXJuIGwudz4wfSkubWFwKGZ1bmN0aW9uKGwpe3JldHVybiB7IG5hbWU6bC5uYW1lLCB3ZWlnaHQ6bC53LCB0cmlnZ2VyV29yZHM6bC50YWdzLCBsb3JhTW9kZWw6bC5sb3JhTW9kZWx8fCcnLCBsb3JhVXJsOmwubG9yYVVybHx8JycgfSB9KSwNCiAgICAgIGVtYmVkZGluZ01vZGVsczpbXSwNCiAgICAgIHNkVmFlOiQoJ3ZhZScpLnZhbHVlPT09J2F1dG9tYXRpYyc/J0F1dG9tYXRpYyc6JCgndmFlJykudmFsdWUsDQogICAgICBwcm9tcHQ6JCgncHJvbXB0JykudmFsdWUsDQogICAgICBuZWdhdGl2ZVByb21wdDpuZWcsDQogICAgICBoZWlnaHQ6cGFyc2VJbnQoJCgnaGVpZ2h0JykudmFsdWUpLA0KICAgICAgd2lkdGg6cGFyc2VJbnQoJCgnd2lkdGgnKS52YWx1ZSksDQogICAgICBpbWFnZUNvdW50OnN0YXRlLm5jb2wsDQogICAgICBzdGVwczpwYXJzZUludCgkKCdzdGVwcycpLnZhbHVlKSwNCiAgICAgIGltYWdlczppMmlEYXRhVXJsP1tpMmlEYXRhVXJsXTpbXSwNCiAgICAgIGRlbm9pc2luZ1N0cmVuZ3RoOnBhcnNlRmxvYXQoJCgnaTJpLWRzJykudmFsdWUpfHwwLjUsDQogICAgICBjZmdTY2FsZTpwYXJzZUZsb2F0KCQoJ2NmZycpLnZhbHVlKSwNCiAgICAgIHNlZWQ6KCQoJ3NlZWQnKS52YWx1ZXx8JycpLnRyaW0oKXx8U3RyaW5nKE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSo5OTk5OTk5OTk5KSksDQogICAgICBjbGlwU2tpcDpwYXJzZUludCgkKCdjbGlwc2tpcCcpLnZhbHVlKSwNCiAgICAgIGV0YU5vaXNlU2VlZERlbHRhOnBhcnNlSW50KCQoJ2V0YW5zZCcpLnZhbHVlKSwNCiAgICAgIHYxQ2xpcDpmYWxzZSwNCiAgICAgIGVuYWJsZVBpeDJwaXg6c3RhdGUucGFnZT09PSdpbWcnJiYhIWkyaURhdGFVcmwsDQogICAgICBndWlkYW5jZTozLjUsDQogICAgICB1c2VGaXJzdExhc3RGcmFtZTpmYWxzZSwNCiAgICAgIGtzYW1wbGVyTmFtZTokKCdzYW1wbGVyJykudmFsdWUsDQogICAgICBzY2hlZHVsZTokKCdzY2hlZCcpLnZhbHVlDQogICAgfSwNCiAgICBwcm92aWRlcjpzZXR0aW5ncy5wcm92aWRlcnx8J3RhbXMnLA0KICAgIGNyZWRpdHM6MS4yMiwNCiAgICB0YXNrVHlwZTpzdGF0ZS5wYWdlPT09J2ltZycmJmkyaURhdGFVcmw/J0lNRzJJTUcnOidUWFQySU1HJywNCiAgICBpc1JlbWl4OmZhbHNlLA0KICAgIGNhcHRjaGFUeXBlOidDTE9VREZMQVJFX1RVUk5TVElMRScNCiAgfTsNCn0NCi8qID09PT09PT09PT09PSBSRUtUWSBHRU5FUkFUT1Ig4oCUIHZlcnNpIHdlYiBmdWxsID09PT09PT09PT09PQ0KICogR2VuZXJhdGUgYXNsaSB2aWEgYmFja2VuZCAoL2FwaSAtPiBUZW5zb3IuQXJ0IE1vZGVsIFNlcnZpY2UpDQogKiBhdGF1IG1vZGUgZGVtbyAocGljc3VtKSBrYWxhdSBiYWNrZW5kL0FQSSBrZXkgYmVsdW0gYWt0aWYuDQogKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovDQp2YXIgU0VUVElOR1NfS0VZPSdyZWt0eS5zZXR0aW5ncycsIFJFU1VMVFNfS0VZPSdyZWt0eS5yZXN1bHRzJzsNCnZhciBzZXR0aW5ncz17IG1vZGU6J2F1dG8nLCBwcm92aWRlcjondGFtcycsIGFwaUtleTonJyB9Ow0KdmFyIFBST1ZJREVSX0lORk89ew0KICB0YW1zOnsgbGFiZWw6J0FQSSBLZXkgVEFNUyAodGFtcy50ZW5zb3IuYXJ0KScsIGhpbnQ6J0dyYXRpcyBkaSB0YW1zLnRlbnNvci5hcnQg4oCUIHBha2FpIGRhZnRhciBNb2RlbCBkaSBVSS4nIH0sDQogIHJlcGxpY2F0ZTp7IGxhYmVsOidBUEkgVG9rZW4gUmVwbGljYXRlIChyZXBsaWNhdGUuY29tKScsIGhpbnQ6J1BpbGloIG1vZGVsIGRpIGthcnR1IE1vZGVsIChGTFVYLCBTRFhMLCBkc3QpLiBJbWcySW1nIGJlbHVtIGRpZHVrdW5nLicgfSwNCiAgZmFsOnsgbGFiZWw6J0FQSSBLZXkgZmFsLmFpIChmYWwuYWkpJywgaGludDonUGlsaWggbW9kZWwgZGkga2FydHUgTW9kZWwgKEZMVVgsIFNEWEwsIGRzdCkuIEltZzJJbWcgYmVsdW0gZGlkdWt1bmcuJyB9LA0KICBwb2xsaW5hdGlvbnM6eyBsYWJlbDonQVBJIEtleSBQb2xsaW5hdGlvbnMgKG9wc2lvbmFsIOKAlCBza18qKScsIGhpbnQ6J0dyYXRpcyB0YW5wYSBrZXkgKG1vZGVsIG90b21hdGlzKS4gSXNpIGtleSBza18qIGRhcmkgZW50ZXIucG9sbGluYXRpb25zLmFpL2tleXMgdW50dWsgZGFmdGFyIG1vZGVsIGxlbmdrYXAuIEhhc2lsIG90b21hdGlzIGRpYXJzaXAgcGVybWFuZW4uJyB9DQp9Ow0KDQpmdW5jdGlvbiBsb2FkU2V0dGluZ3MoKXsNCiAgdHJ5ew0KICAgIHZhciBzPUpTT04ucGFyc2UobG9jYWxTdG9yYWdlLmdldEl0ZW0oU0VUVElOR1NfS0VZKXx8J3t9Jyk7DQogICAgaWYocyYmdHlwZW9mIHM9PT0nb2JqZWN0Jyl7DQogICAgICBzZXR0aW5ncy5tb2RlPXMubW9kZXx8J2F1dG8nOyBzZXR0aW5ncy5wcm92aWRlcj1zLnByb3ZpZGVyfHwndGFtcyc7IHNldHRpbmdzLmFwaUtleT1zLmFwaUtleXx8Jyc7DQogICAgfQ0KICB9Y2F0Y2goZSl7fQ0KfQ0KZnVuY3Rpb24gc2F2ZVNldHRpbmdzKCl7IHRyeXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oU0VUVElOR1NfS0VZLEpTT04uc3RyaW5naWZ5KHNldHRpbmdzKSk7IH1jYXRjaChlKXt9IH0NCmZ1bmN0aW9uIGFwcGx5U2V0dGluZ3NVSSgpew0KICAkKCdhcGltb2RlJykudmFsdWU9c2V0dGluZ3MubW9kZTsgJCgnYXBpa2V5JykudmFsdWU9c2V0dGluZ3MuYXBpS2V5Ow0KICB1cGRhdGVQcm92aWRlclVJKCk7DQp9DQpmdW5jdGlvbiB1cGRhdGVQcm92aWRlclVJKCl7DQogIHZhciBpbmZvPVBST1ZJREVSX0lORk9bc2V0dGluZ3MucHJvdmlkZXJdfHxQUk9WSURFUl9JTkZPLnRhbXM7DQogICQoJ2FwaXByb3ZpZGVyJykudmFsdWU9c2V0dGluZ3MucHJvdmlkZXI7DQogICQoJ2FwaWtleS1sYWJlbCcpLnRleHRDb250ZW50PWluZm8ubGFiZWw7DQogICQoJ2FwaS1oaW50JykudGV4dENvbnRlbnQ9aW5mby5oaW50Ow0KICB1cGRhdGVBcGlTdGF0dXMoKTsNCiAgLy8gR2FudGkgZGFmdGFyIG1vZGVsIHNlc3VhaSBwcm92aWRlciBha3RpZi4NCiAgdmFyIGxpYj1NT0RFTF9MSUJTW3NldHRpbmdzLnByb3ZpZGVyXXx8TU9ERUxfTElCUy50YW1zOw0KICBpZihNT0RFTFMhPT1saWIpew0KICAgIE1PREVMUz1saWI7DQogICAgaWYoTU9ERUxTLmxlbmd0aCkgc2V0TW9kZWwoTU9ERUxTWzBdKTsNCiAgfQ0KICAvLyBHYW50aSBkYWZ0YXIgTG9SQSBzZXN1YWkgcHJvdmlkZXIgKExvUkEgbGFtYSBkaWJlcnNpaGthbikuDQogIExPUkFfTElCPUxPUkFfTElCU1tzZXR0aW5ncy5wcm92aWRlcl18fExPUkFfTElCUy50YW1zOw0KICBMT1JBLmxlbmd0aD0wOw0KICByZW5kZXJMb3JhKCk7DQogIC8vIFBvbGxpbmF0aW9uczogYW1iaWwgZGFmdGFyIG1vZGVsIGFzbGkgZGFyaSBBUEkgKGZhbGxiYWNrIGtlIGRhZnRhciBzdGF0aXMpLg0KICBpZihzZXR0aW5ncy5wcm92aWRlcj09PSdwb2xsaW5hdGlvbnMnKSByZWZyZXNoUG9sbGluYXRpb25zTW9kZWxzKCk7DQp9DQpmdW5jdGlvbiByZWZyZXNoUG9sbGluYXRpb25zTW9kZWxzKCl7DQogIGZldGNoKCcvYXBpL3BvbGxpbmF0aW9ucy1tb2RlbHMnKS50aGVuKGZ1bmN0aW9uKHIpeyByZXR1cm4gci5qc29uKCk7IH0pLnRoZW4oZnVuY3Rpb24oZCl7DQogICAgaWYoIWR8fCFBcnJheS5pc0FycmF5KGQubW9kZWxzKXx8IWQubW9kZWxzLmxlbmd0aCkgcmV0dXJuOw0KICAgIHZhciBsaWI9ZC5tb2RlbHMNCiAgICAgIC5maWx0ZXIoZnVuY3Rpb24obSl7IHJldHVybiBtLmNhdGVnb3J5PT09J2ltYWdlJyYmbS5uYW1lJiZtLm5hbWUuaW5kZXhPZignYnlvcC8nKSE9PTA7IH0pDQogICAgICAuc2xpY2UoMCw4MCkNCiAgICAgIC5tYXAoZnVuY3Rpb24obSl7IHJldHVybiB7IG5hbWU6bS50aXRsZXx8bS5uYW1lLCBiYXNlOidQb2xsaW5hdGlvbnMnLCBhcmNoOm0uYnJhbmR8fCcnLCB0aHVtYjpTdHJpbmcobS5uYW1lKS5yZXBsYWNlKC9bXmEtejAtOV0vZ2ksJycpLCBiYWRnZTptLnBhaWRfb25seT8nUEFJRCc6J0ZSRUUnLCB2aWV3czonJywgdmVyOidWMScsIG1vZGVsOm0ubmFtZSB9OyB9KQ0KICAgICAgLnNvcnQoZnVuY3Rpb24oYSxiKXsgcmV0dXJuIChhLmJhZGdlPT09J1BBSUQnPzE6MCktKGIuYmFkZ2U9PT0nUEFJRCc/MTowKTsgfSk7DQogICAgaWYoIWxpYi5sZW5ndGgpIHJldHVybjsNCiAgICBNT0RFTF9MSUJTLnBvbGxpbmF0aW9ucz1saWI7DQogICAgaWYoTU9ERUxTPT09TU9ERUxfTElCUy5wb2xsaW5hdGlvbnMpeyBzZXRNb2RlbChNT0RFTFNbMF0pOyB9DQogIH0pLmNhdGNoKGZ1bmN0aW9uKCl7fSk7DQp9DQpmdW5jdGlvbiB1cGRhdGVBcGlTdGF0dXMoKXsNCiAgdmFyIGVsPSQoJ2FwaS1zdGF0dXMnKTsgaWYoIWVsKSByZXR1cm47DQogIGlmKHNldHRpbmdzLnByb3ZpZGVyPT09J3BvbGxpbmF0aW9ucycpew0KICAgIGVsLnRleHRDb250ZW50PSdQb2xsaW5hdGlvbnMgwrcgZ3JhdGlzJzsNCiAgICBlbC5zdHlsZS5jb2xvcj0nIzI3RDRDRCc7DQogICAgcmV0dXJuOw0KICB9DQogIHZhciBuYW1lPXNldHRpbmdzLnByb3ZpZGVyPT09J3RhbXMnPydUQU1TJzooc2V0dGluZ3MucHJvdmlkZXI9PT0ncmVwbGljYXRlJz8nUmVwbGljYXRlJzonZmFsLmFpJyk7DQogIGVsLnRleHRDb250ZW50PW5hbWUrKHNldHRpbmdzLmFwaUtleT8nIMK3IGtleSc6JyDCtyB0YW5wYSBrZXknKTsNCiAgZWwuc3R5bGUuY29sb3I9c2V0dGluZ3MuYXBpS2V5PycjMjdENENEJzonIzlhOWFhMic7DQp9DQokKCdhcGlwcm92aWRlcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NoYW5nZScsZnVuY3Rpb24oKXsNCiAgc2V0dGluZ3MucHJvdmlkZXI9JCgnYXBpcHJvdmlkZXInKS52YWx1ZTsgc2F2ZVNldHRpbmdzKCk7IHVwZGF0ZVByb3ZpZGVyVUkoKTsNCn0pOw0KJCgnYXBpLXNhdmUnKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsNCiAgc2V0dGluZ3MubW9kZT0kKCdhcGltb2RlJykudmFsdWU7IHNldHRpbmdzLmFwaUtleT0kKCdhcGlrZXknKS52YWx1ZS50cmltKCk7DQogIHNhdmVTZXR0aW5ncygpOyB1cGRhdGVQcm92aWRlclVJKCk7IHRvYXN0KCdQZW5nYXR1cmFuIEFQSSBkaXNpbXBhbicpOw0KfSk7DQokKCdhcGktdGVzdCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxhc3luYyBmdW5jdGlvbigpew0KICB2YXIgYj0kKCdhcGktdGVzdCcpOyBiLmRpc2FibGVkPXRydWU7IGIudGV4dENvbnRlbnQ9J1Rlcy4uLic7DQogIHRyeXsNCiAgICB2YXIgcj1hd2FpdCBmZXRjaCgnL2FwaS9oZWFsdGgnLHtoZWFkZXJzOnsneC1hcGkta2V5JzokKCdhcGlrZXknKS52YWx1ZS50cmltKCl8fHNldHRpbmdzLmFwaUtleX19KTsNCiAgICB2YXIgZD1hd2FpdCByLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsfSk7DQogICAgaWYoIXIub2spIHRocm93IG5ldyBFcnJvcignSFRUUCAnK3Iuc3RhdHVzKTsNCiAgICB2YXIgcGFydHM9W107DQogICAgaWYoZCYmZC5oYXNLZXlzKXsgWyd0YW1zJywncmVwbGljYXRlJywnZmFsJ10uZm9yRWFjaChmdW5jdGlvbihwKXsgaWYoZC5oYXNLZXlzW3BdKSBwYXJ0cy5wdXNoKHApOyB9KTsgfQ0KICAgIHRvYXN0KCdCYWNrZW5kIE9LLiBLZXkgZGkgZW52OiAnKyhwYXJ0cy5sZW5ndGg/cGFydHMuam9pbignLCAnKTondGlkYWsgYWRhJykrJy4gS2V5IGRpIGJyb3dzZXI6ICcrKHNldHRpbmdzLmFwaUtleT8nYWRhJzondGlkYWsnKSk7DQogIH1jYXRjaChlKXsgdG9hc3QoJ0JhY2tlbmQgdGlkYWsgYWt0aWYg4oCUIGRlcGxveSBkZW5nYW4gRnVuY3Rpb25zIGF0YXUgcGFrYWkgbW9kZSBkZW1vJyk7IH0NCiAgYi5kaXNhYmxlZD1mYWxzZTsgYi50ZXh0Q29udGVudD0nVGVzJzsNCn0pOw0KDQovKiAtLS0gdG9hc3QgLS0tICovDQp2YXIgX3RvYXN0VGltZXI9bnVsbDsNCmZ1bmN0aW9uIHRvYXN0KG1zZyl7DQogIHZhciB0PSQoJ3RvYXN0Jyk7IGlmKCF0KSByZXR1cm47DQogIHQudGV4dENvbnRlbnQ9bXNnOyB0LmNsYXNzTGlzdC5yZW1vdmUoJ2hpZGRlbicpOw0KICBjbGVhclRpbWVvdXQoX3RvYXN0VGltZXIpOw0KICBfdG9hc3RUaW1lcj1zZXRUaW1lb3V0KGZ1bmN0aW9uKCl7IHQuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7IH0sMzUwMCk7DQp9DQoNCi8qIC0tLSBwcm9ncmVzcyBvdmVybGF5IC0tLSAqLw0KdmFyIF9wb2xsU3RvcD1mYWxzZTsNCmZ1bmN0aW9uIHNob3dQcm9ncmVzcyh0aXRsZSxzdGF0dXMscGN0KXsNCiAgJCgncHJvZy10aXRsZScpLnRleHRDb250ZW50PXRpdGxlOw0KICAkKCdwcm9nLXN0YXR1cycpLnRleHRDb250ZW50PXN0YXR1c3x8Jyc7DQogICQoJ3Byb2ctYmFyJykuc3R5bGUud2lkdGg9TWF0aC5tYXgoMCxNYXRoLm1pbigxMDAscGN0fHwwKSkrJyUnOw0KICAkKCdwcm9nLXBjdCcpLnRleHRDb250ZW50PU1hdGgucm91bmQocGN0fHwwKSsnJSc7DQogICQoJ3Byb2dvdmVybGF5JykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7ICQoJ3Byb2dvdmVybGF5JykuY2xhc3NMaXN0LmFkZCgnZmxleCcpOw0KfQ0KZnVuY3Rpb24gaGlkZVByb2dyZXNzKCl7ICQoJ3Byb2dvdmVybGF5JykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ3Byb2dvdmVybGF5JykuY2xhc3NMaXN0LnJlbW92ZSgnZmxleCcpOyB9DQokKCdwcm9nLWNhbmNlbCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyBfcG9sbFN0b3A9dHJ1ZTsgdG9hc3QoJ01lbWJhdGFsa2FuLi4uJyk7IH0pOw0KDQovKiAtLS0gQVBJIGNsaWVudCAtLS0gKi8NCmZ1bmN0aW9uIGJ1aWxkQXBpS2V5KCl7IHJldHVybiBzZXR0aW5ncy5hcGlLZXl8fCQoJ2FwaWtleScpLnZhbHVlLnRyaW0oKTsgfQ0KDQphc3luYyBmdW5jdGlvbiBhcGlHZW5lcmF0ZShwYXlsb2FkKXsNCiAgdmFyIHJlcz1hd2FpdCBmZXRjaCgnL2FwaS9nZW5lcmF0ZScse21ldGhvZDonUE9TVCcsaGVhZGVyczp7J0NvbnRlbnQtVHlwZSc6J2FwcGxpY2F0aW9uL2pzb24nLCd4LWFwaS1rZXknOmJ1aWxkQXBpS2V5KCl9LGJvZHk6SlNPTi5zdHJpbmdpZnkocGF5bG9hZCl9KTsNCiAgdmFyIGQ9YXdhaXQgcmVzLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsfSk7DQogIGlmKCFyZXMub2spIHRocm93IG5ldyBFcnJvcigoZCYmZC5lcnJvcil8fCgnSFRUUCAnK3Jlcy5zdGF0dXMpKTsNCiAgcmV0dXJuIGR8fHt9Ow0KfQ0KYXN5bmMgZnVuY3Rpb24gYXBpVGFzayh0YXNrSWQpew0KICB2YXIgcmVzPWF3YWl0IGZldGNoKCcvYXBpL3Rhc2s/aWQ9JytlbmNvZGVVUklDb21wb25lbnQodGFza0lkKSx7aGVhZGVyczp7J3gtYXBpLWtleSc6YnVpbGRBcGlLZXkoKX19KTsNCiAgdmFyIGQ9YXdhaXQgcmVzLmpzb24oKS5jYXRjaChmdW5jdGlvbigpe3JldHVybiBudWxsfSk7DQogIGlmKCFyZXMub2spIHRocm93IG5ldyBFcnJvcigoZCYmZC5lcnJvcil8fCgnSFRUUCAnK3Jlcy5zdGF0dXMpKTsNCiAgcmV0dXJuIGR8fHt9Ow0KfQ0KDQphc3luYyBmdW5jdGlvbiBwb2xsVGFzayh0YXNrSWQsb25Qcm9nKXsNCiAgdmFyIHN0YXJ0PURhdGUubm93KCksIG1heE1zPTYqNjAqMTAwMDsNCiAgd2hpbGUoRGF0ZS5ub3coKS1zdGFydDxtYXhNcyl7DQogICAgaWYoX3BvbGxTdG9wKSB0aHJvdyBuZXcgRXJyb3IoJ2RpYmF0YWxrYW4gcGVuZ2d1bmEnKTsNCiAgICB2YXIgZD1hd2FpdCBhcGlUYXNrKHRhc2tJZCk7DQogICAgaWYoZC5zdGF0dXM9PT0nU1VDQ0VTUycpIHJldHVybiBkLmltYWdlc3x8W107DQogICAgaWYoZC5zdGF0dXM9PT0nRkFJTEVEJykgdGhyb3cgbmV3IEVycm9yKGQuZXJyb3J8fCdUYXNrIGdhZ2FsJyk7DQogICAgaWYoZC5zdGF0dXM9PT0nQ0FOQ0VMRUQnKSB0aHJvdyBuZXcgRXJyb3IoJ1Rhc2sgZGliYXRhbGthbicpOw0KICAgIHZhciBzdD0oZC5zdGF0dXM9PT0nV0FJVElORycpPygnQW50cmUgJysoZC5xdWV1ZXx8JycpKTooZC5zdGF0dXM9PT0nUlVOTklORyc/J0dlbmVyYXRpbmcuLi4nOidNZW51bmdndS4uLicpOw0KICAgIG9uUHJvZyhzdCxkLnByb2dyZXNzfHwwKTsNCiAgICBhd2FpdCBuZXcgUHJvbWlzZShmdW5jdGlvbihyKXsgc2V0VGltZW91dChyLCBkLnN0YXR1cz09PSdXQUlUSU5HJz80MDAwOjIwMDApOyB9KTsNCiAgfQ0KICB0aHJvdyBuZXcgRXJyb3IoJ1RpbWVvdXQgbWVudW5nZ3UgaGFzaWwgZ2VuZXJhdGUnKTsNCn0NCg0KLyogLS0tIGhhc2lsIC0tLSAqLw0KZnVuY3Rpb24gbWtSZXN1bHQoc3JjLHBhcix0YXNrSWQsY3JlZGl0cyl7DQogIHJldHVybiB7DQogICAgc3JjOnNyYywgcHJvbXB0OnBhci5wYXJhbXMucHJvbXB0LCBuZWc6cGFyLnBhcmFtcy5uZWdhdGl2ZVByb21wdCwNCiAgICBtb2RlbDpzdGF0ZS5tb2RlbD9zdGF0ZS5tb2RlbC5uYW1lOicnLA0KICAgIHNpemU6cGFyLnBhcmFtcy53aWR0aCsneCcrcGFyLnBhcmFtcy5oZWlnaHQsIHNlZWQ6cGFyLnBhcmFtcy5zZWVkLA0KICAgIHRhc2tJZDp0YXNrSWR8fCcnLCBjcmVkaXRzOmNyZWRpdHMhPW51bGw/Y3JlZGl0czonJywNCiAgICB0czpEYXRlLm5vdygpLCBkZW1vOmZhbHNlLCBwYWdlOnN0YXRlLnBhZ2UNCiAgfTsNCn0NCmZ1bmN0aW9uIGRlbW9SZXN1bHRzKHBhcil7DQogIHNob3dQcm9ncmVzcygnTW9kZSBkZW1vJywnTWVueWlhcGthbiBnYW1iYXIgc2ltdWxhc2kuLi4nLDE1KTsNCiAgc2V0VGltZW91dChmdW5jdGlvbigpew0KICAgIGZvcih2YXIgaT0wO2k8c3RhdGUubmNvbDtpKyspew0KICAgICAgdmFyIHNyYz1TK01hdGguZmxvb3IoTWF0aC5yYW5kb20oKSoxZTkpKycvNTEyJzsNCiAgICAgIGFkZFJlc3VsdCh7c3JjOnNyYywgcHJvbXB0OnBhci5wYXJhbXMucHJvbXB0LCBuZWc6cGFyLnBhcmFtcy5uZWdhdGl2ZVByb21wdCwNCiAgICAgICAgbW9kZWw6c3RhdGUubW9kZWw/c3RhdGUubW9kZWwubmFtZTonJywgc2l6ZTpwYXIucGFyYW1zLndpZHRoKyd4JytwYXIucGFyYW1zLmhlaWdodCwNCiAgICAgICAgc2VlZDpwYXIucGFyYW1zLnNlZWQsIHRhc2tJZDonJywgY3JlZGl0czonJywgdHM6RGF0ZS5ub3coKSwgZGVtbzp0cnVlLCBwYWdlOnN0YXRlLnBhZ2V9KTsNCiAgICB9DQogICAgaGlkZVByb2dyZXNzKCk7DQogIH0sNzAwKTsNCn0NCg0KYXN5bmMgZnVuY3Rpb24gZG9HZW5lcmF0ZSgpew0KICBpZihzdGF0ZS5idXN5KSByZXR1cm47DQogIHZhciBwPSQoJ3Byb21wdCcpLnZhbHVlLnRyaW0oKTsNCiAgaWYoIXApeyBvcGVuTGVmdCgpOyAkKCdwcm9tcHQnKS5mb2N1cygpOyB0b2FzdCgnSXNpIHByb21wdCBkdWx1Jyk7IHJldHVybjsgfQ0KICB2YXIgcGFyPWJ1aWxkUGF5bG9hZCgpOw0KICBzdGF0ZS5idXN5PXRydWU7IHNldEJ1c3kodHJ1ZSk7IF9wb2xsU3RvcD1mYWxzZTsNCiAgdHJ5ew0KICAgIGlmKHNldHRpbmdzLm1vZGU9PT0nZGVtbyd8fCghYnVpbGRBcGlLZXkoKSYmc2V0dGluZ3MucHJvdmlkZXIhPT0ncG9sbGluYXRpb25zJykpew0KICAgICAgYXdhaXQgbmV3IFByb21pc2UoZnVuY3Rpb24ocil7IHNldFRpbWVvdXQociwzMDApOyB9KTsNCiAgICAgIGRlbW9SZXN1bHRzKHBhcik7DQogICAgICBpZighYnVpbGRBcGlLZXkoKSkgdG9hc3QoJ0JlbHVtIGFkYSBBUEkga2V5IOKAlCBoYXNpbCBzaW11bGFzaS4gSXNpIEFQSSBLZXkgVEFNUyBkaSBwYW5lbCBraXJpIHVudHVrIGdlbmVyYXRlIGFzbGkuJyk7DQogICAgICBlbHNlIHRvYXN0KCdNb2RlIGRlbW8gYWt0aWYg4oCUIGhhc2lsIHNpbXVsYXNpLicpOw0KICAgIH1lbHNlew0KICAgICAgc2hvd1Byb2dyZXNzKCdNZW5naXJpbSBrZSBUQU1TLi4uJywnTWVueWlhcGthbiB0YXNrLi4uJyw1KTsNCiAgICAgIHZhciByPWF3YWl0IGFwaUdlbmVyYXRlKHBhcik7DQogICAgICB2YXIgdGFza0lkPXIudGFza0lkfHxyLmpvYklkOw0KICAgICAgaWYodGFza0lkKXsNCiAgICAgICAgdmFyIGltZ3M9YXdhaXQgcG9sbFRhc2sodGFza0lkLGZ1bmN0aW9uKHN0LHBjdCl7IHNob3dQcm9ncmVzcygnR2VuZXJhdGluZy4uLicsc3QscGN0KTsgfSk7DQogICAgICAgIGltZ3MuZm9yRWFjaChmdW5jdGlvbihzcmMpeyBhZGRSZXN1bHQobWtSZXN1bHQoc3JjLHBhcix0YXNrSWQsci5jcmVkaXRzKSk7IH0pOw0KICAgICAgfWVsc2V7DQogICAgICAgIHZhciBpbWdzMj1leHRyYWN0SW1hZ2VzKHIpOw0KICAgICAgICBpZighaW1nczIubGVuZ3RoKSB0aHJvdyBuZXcgRXJyb3IoJ1Jlc3BvbnNlIHRhbnBhIGdhbWJhcicpOw0KICAgICAgICBpbWdzMi5mb3JFYWNoKGZ1bmN0aW9uKHNyYyl7IGFkZFJlc3VsdChta1Jlc3VsdChzcmMscGFyLCcnLHIuY3JlZGl0cykpOyB9KTsNCiAgICAgIH0NCiAgICB9DQogIH1jYXRjaChlKXsNCiAgICBpZihzZXR0aW5ncy5tb2RlPT09J2F1dG8nKXsNCiAgICAgIHRvYXN0KCdCYWNrZW5kL0FQSSBiZWx1bSBha3RpZiAoJytlLm1lc3NhZ2UrJykg4oCUIHBha2FpIHNpbXVsYXNpIGRlbW8nKTsNCiAgICAgIGRlbW9SZXN1bHRzKHBhcik7DQogICAgfWVsc2V7DQogICAgICB0b2FzdCgnR2FnYWw6ICcrZS5tZXNzYWdlKTsNCiAgICB9DQogIH1maW5hbGx5ew0KICAgIGhpZGVQcm9ncmVzcygpOyBzdGF0ZS5idXN5PWZhbHNlOyBzZXRCdXN5KGZhbHNlKTsNCiAgfQ0KfQ0KDQovKiAtLS0gSW1nMkltZyAtLS0gKi8NCnZhciBpMmlEYXRhVXJsPW51bGw7DQokKCdpMmktZHJvcCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpeyAkKCdpMmktZmlsZScpLmNsaWNrKCk7IH0pOw0KJCgnaTJpLWZpbGUnKS5hZGRFdmVudExpc3RlbmVyKCdjaGFuZ2UnLGZ1bmN0aW9uKGUpeyBoYW5kbGVJMmlGaWxlKGUudGFyZ2V0LmZpbGVzJiZlLnRhcmdldC5maWxlc1swXSk7IH0pOw0KJCgnaTJpLWRyb3AnKS5hZGRFdmVudExpc3RlbmVyKCdkcmFnb3ZlcicsZnVuY3Rpb24oZSl7IGUucHJldmVudERlZmF1bHQoKTsgfSk7DQokKCdpMmktZHJvcCcpLmFkZEV2ZW50TGlzdGVuZXIoJ2Ryb3AnLGZ1bmN0aW9uKGUpeyBlLnByZXZlbnREZWZhdWx0KCk7IGhhbmRsZUkyaUZpbGUoZS5kYXRhVHJhbnNmZXIuZmlsZXMmJmUuZGF0YVRyYW5zZmVyLmZpbGVzWzBdKTsgfSk7DQokKCdpMmktZHMnKS5hZGRFdmVudExpc3RlbmVyKCdpbnB1dCcsZnVuY3Rpb24oZSl7ICQoJ2kyaS1kc3YnKS50ZXh0Q29udGVudD1wYXJzZUZsb2F0KGUudGFyZ2V0LnZhbHVlKS50b0ZpeGVkKDIpOyB9KTsNCiQoJ2kyaS1jbGVhcicpLmFkZEV2ZW50TGlzdGVuZXIoJ2NsaWNrJyxmdW5jdGlvbigpew0KICBpMmlEYXRhVXJsPW51bGw7ICQoJ2kyaS1wcmV2aWV3JykuY2xhc3NMaXN0LmFkZCgnaGlkZGVuJyk7ICQoJ2kyaS1pbWcnKS5zcmM9Jyc7ICQoJ2kyaS1kcm9wJykuY2xhc3NMaXN0LnJlbW92ZSgnaGlkZGVuJyk7DQp9KTsNCmZ1bmN0aW9uIGhhbmRsZUkyaUZpbGUoZil7DQogIGlmKCFmKSByZXR1cm47DQogIHZhciByZD1uZXcgRmlsZVJlYWRlcigpOw0KICByZC5vbmxvYWQ9ZnVuY3Rpb24oKXsNCiAgICBpMmlEYXRhVXJsPXJkLnJlc3VsdDsNCiAgICAkKCdpMmktaW1nJykuc3JjPXJkLnJlc3VsdDsgJCgnaTJpLXByZXZpZXcnKS5jbGFzc0xpc3QucmVtb3ZlKCdoaWRkZW4nKTsgJCgnaTJpLWRyb3AnKS5jbGFzc0xpc3QuYWRkKCdoaWRkZW4nKTsNCiAgfTsNCiAgcmQucmVhZEFzRGF0YVVSTChmKTsNCn0NCg0KLyogLS0tIHJlbmRlciBwZXIgdGFiIC0tLSAqLw0KZnVuY3Rpb24gcmVuZGVyQ2FudmFzKCl7DQogIHZhciBwYWdlPXN0YXRlLnBhZ2U7DQogIHZhciBoaWRlTWFpbiA9ICEocGFnZT09PSd0ZXh0J3x8cGFnZT09PSdpbWcnKTsNCiAgJCgnaW1nMmltZy1jYXJkJykuY2xhc3NMaXN0LnRvZ2dsZSgnaGlkZGVuJywgcGFnZSE9PSdpbWcnKTsNCiAgJCgnZW1wdHknKS5zdHlsZS5kaXNwbGF5ID0gKGhpZGVNYWluIHx8IHN0YXRlLnJlc3VsdHMubGVuZ3RoPjApID8gJ25vbmUnIDogJyc7DQogICQoJ2dyaWQnKS5zdHlsZS5kaXNwbGF5ID0gaGlkZU1haW4/J25vbmUnOicnOw0KICAkKCd0YWItcGxhY2Vob2xkZXInKS5jbGFzc0xpc3QudG9nZ2xlKCdoaWRkZW4nLCAhaGlkZU1haW4pOw0KICAkKCd0YWItcGxhY2Vob2xkZXInKS5jbGFzc0xpc3QudG9nZ2xlKCdmbGV4JywgaGlkZU1haW4pOw0KICBpZihwYWdlPT09J2VkaXQnKSAkKCd0YWItcGxhY2Vob2xkZXItdGV4dCcpLnRleHRDb250ZW50PSdFZGl0IC8gSW5wYWludGluZyDigJQgc2VnZXJhIGhhZGlyJzsNCiAgZWxzZSBpZihwYWdlPT09J3ZpZGVvJykgJCgndGFiLXBsYWNlaG9sZGVyLXRleHQnKS50ZXh0Q29udGVudD0nVGV4dCAvIEltYWdlIHRvIFZpZGVvIOKAlCBzZWdlcmEgaGFkaXInOw0KICBlbHNlIGlmKHBhZ2U9PT0ncHJpbWUnKSAkKCd0YWItcGxhY2Vob2xkZXItdGV4dCcpLnRleHRDb250ZW50PSdQcmltZSDigJQgc2VnZXJhIGhhZGlyJzsNCn0NCg0KLyogLS0tIHJpd2F5YXQgZGkgbW9iaWxlIC0tLSAqLw0KJCgnYnRuLWhpc3RvcnknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgncmlnaHRQYW4nKS5jbGFzc0xpc3QudG9nZ2xlKCdtb2JpbGUtb3BlbicpOyB9KTsNCiQoJ292ZXJsYXknKS5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsZnVuY3Rpb24oKXsgJCgncmlnaHRQYW4nKS5jbGFzc0xpc3QucmVtb3ZlKCdtb2JpbGUtb3BlbicpOyB9KTsNCg0KcmVuZGVyTG9yYSgpOw0Kc2V0TW9kZWwoTU9ERUxTWzBdKTsNCnVwZFdIKCk7DQpsb2FkU2V0dGluZ3MoKTsgYXBwbHlTZXR0aW5nc1VJKCk7DQp0cnl7DQogIHZhciBzYXZlZD1KU09OLnBhcnNlKGxvY2FsU3RvcmFnZS5nZXRJdGVtKFJFU1VMVFNfS0VZKXx8J1tdJyk7DQogIGlmKEFycmF5LmlzQXJyYXkoc2F2ZWQpKSBzdGF0ZS5yZXN1bHRzPXNhdmVkOw0KfWNhdGNoKGUpe30NCnJlbmRlckNhbnZhcygpOw0KcmVuZGVyR3JpZCgpOw0KcmVuZGVyUmlnaHQoKTsNCjwvc2NyaXB0Pg0KPC9ib2R5Pg0KPC9odG1sPg0KDQoNCg==';
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
