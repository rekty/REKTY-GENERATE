/**
 * Tes integrasi backend `functions/api.js` — TANPA memanggil API asli.
 *
 * Menimpa global fetch dengan respons tiruan untuk TAMS / Replicate / fal.ai,
 * lalu memanggil handler `onRequest` persis seperti Cloudflare Pages Function.
 *
 * Jalankan: node scripts/test_backend.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'functions', 'api.js'), 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { onRequest } = mod;

const calls = []; // url + body yang "dikirim" ke provider

function jsonResp(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

async function run(reqUrl, body, env = {}, headers = {}) {
  const h = body ? { 'Content-Type': 'application/json', ...headers } : headers;
  const req = new Request('http://test.local' + reqUrl, {
    method: body ? 'POST' : 'GET',
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
  });
  const res = await onRequest({ request: req, env });
  return { status: res.status, data: await res.json() };
}

const AUTH = { 'x-api-key': 'test-key' };

// ---------- payload web-format (persis buildPayload di index.html) ----------
function webPayload(provider, model) {
  return {
    provider,
    params: {
      baseModel: { modelId: '1027906253260603805', modelFileId: '1027906254334366245' },
      model: model || '',
      sdxl: { refiner: false },
      models: [{ name: 'Detail LoRA', weight: 0.8, triggerWords: ['detailed'], loraModel: '987654321' }],
      embeddingModels: [],
      sdVae: 'Automatic',
      prompt: 'seorang wanita di taman bunga',
      negativePrompt: 'blurry, low quality',
      height: 1152, width: 768, imageCount: 2, steps: 25,
      images: [], denoisingStrength: 0.5,
      cfgScale: 7, seed: '123456789',
      clipSkip: 2, etaNoiseSeedDelta: 31337, v1Clip: false,
      enablePix2pix: false, guidance: 3.5, useFirstLastFrame: false,
      ksamplerName: 'DPM++ 2M Karras', schedule: 'karras',
    },
    credits: 1.22, taskType: 'TXT2IMG', isRemix: false, captchaType: 'CLOUDFLARE_TURNSTILE',
    apiKey: 'test-key',
  };
}


// ---------- tiruan fetch ----------
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  const method = (opts && opts.method) || 'GET';
  const bodyText = (opts && opts.body) ? String(opts.body) : '';
  calls.push({ method, url: u, body: bodyText });

  // --- TAMS ---
  if (u.includes('ap-east-1.tensorart.cloud')) {
    if (method === 'POST' && u.endsWith('/v1/jobs')) {
      const b = JSON.parse(bodyText);
      assert.ok(b.request_id, 'TAMS: request_id wajib');
      assert.ok(Array.isArray(b.stages) && b.stages.length === 2, 'TAMS: 2 stages');
      const diff = b.stages[1].diffusion;
      assert.strictEqual(diff.sdModel, '1027906253260603805', 'TAMS sdModel');
      assert.deepStrictEqual(diff.negativePrompts, [{ text: 'blurry, low quality' }], 'TAMS negativePrompts');
      assert.strictEqual(diff.sampler, 'DPM++ 2M Karras', 'TAMS sampler display name');
      assert.strictEqual(diff.scheduleName, 'karras', 'TAMS scheduleName');
      assert.strictEqual(diff.lora.items[0].loraModel, '987654321', 'TAMS lora id');
      assert.strictEqual(b.stages[0].inputInitialize.count, 2, 'TAMS count');
      return jsonResp({ job: { id: '12345', credits: 1.22 } });
    }
    if (method === 'GET' && u.includes('/v1/jobs/')) {
      return jsonResp({ job: { status: 'SUCCESS', credits: 1.22, successInfo: { images: [{ url: 'https://img.tams/1.png' }, { url: 'https://img.tams/2.png' }] } } });
    }
  }

  // --- Replicate ---
  if (u.includes('api.replicate.com')) {
    if (method === 'POST' && u.endsWith('/v1/models/stability-ai/sdxl/predictions')) {
      const b = JSON.parse(bodyText);
      assert.strictEqual(b.input.prompt, 'seorang wanita di taman bunga', 'replicate prompt');
      assert.strictEqual(b.input.negative_prompt, 'blurry, low quality', 'replicate negative');
      assert.strictEqual(b.input.num_outputs, 2, 'replicate num_outputs');
      assert.strictEqual(b.input.seed, 123456789, 'replicate seed');
      assert.strictEqual(b.input.scheduler, 'DPMSolverMultistep', 'replicate scheduler');
      assert.strictEqual(b.input.num_inference_steps, 25, 'replicate steps');
      return jsonResp({ id: 'rp_abc123' });
    }
    if (method === 'POST' && u.endsWith('/v1/models/black-forest-labs/flux-schnell/predictions')) {
      const b = JSON.parse(bodyText);
      assert.strictEqual(b.input.prompt, 'seorang wanita di taman bunga', 'flux prompt');
      assert.strictEqual(b.input.aspect_ratio, '2:3', 'flux aspect_ratio dari 768x1152');
      assert.strictEqual(b.input.num_outputs, 2, 'flux num_outputs');
      assert.strictEqual(b.input.num_inference_steps, 4, 'flux schnell selalu 4 steps');
      assert.ok(!('negative_prompt' in b.input), 'flux tanpa negative_prompt');
      return jsonResp({ id: 'rp_flux1' });
    }
    if (method === 'POST' && u.endsWith('/v1/models/black-forest-labs/flux-schnell-lora/predictions')) {
      const b = JSON.parse(bodyText);
      assert.strictEqual(b.input.lora_url, 'https://example.com/lora.safetensors', 'flux lora_url');
      assert.strictEqual(b.input.lora_scale, 0.8, 'flux lora_scale dari weight');
      assert.strictEqual(b.input.lora_trigger_phrase, 'flux-lora', 'flux lora_trigger_phrase dari triggerWords');
      assert.strictEqual(b.input.num_inference_steps, 4, 'flux lora schnell 4 steps');
      return jsonResp({ id: 'rp_fluxlora1' });
    }
    if (method === 'POST' && u.endsWith('/v1/models/ostris/ikea-instructions-lora-sdxl/predictions')) {
      const b = JSON.parse(bodyText);
      assert.strictEqual(b.input.prompt, 'seorang wanita di taman bunga', 'ikea prompt');
      assert.strictEqual(b.input.negative_prompt, 'blurry, low quality', 'ikea negative (SDXL family)');
      assert.ok(!('lora_url' in b.input), 'ikea tanpa lora_url (weights baked-in)');
      return jsonResp({ id: 'rp_ikea1' });
    }
    if (method === 'POST' && u.endsWith('/v1/models/zylim0702/sdxl-lora-customize-model/predictions')) {
      const b = JSON.parse(bodyText);
      assert.strictEqual(b.input.lora_url, 'https://example.com/sdxl-lora.safetensors', 'zylim lora_url');
      assert.strictEqual(b.input.lora_scale, 0.9, 'zylim lora_scale dari weight');
      assert.strictEqual(b.input.negative_prompt, 'blurry, low quality', 'zylim negative (SDXL)');
      return jsonResp({ id: 'rp_zylim1' });
    }
    if (method === 'GET' && u.includes('/v1/predictions/')) {
      return jsonResp({ id: 'rp_x', status: 'succeeded', output: ['https://img.repl/1.png'] });
    }
  }

  // --- fal.ai (status/results URL menyandikan model path) ---
  if (u.includes('queue.fal.run')) {
    const m = u.match(/\/requests\/([^/?]+)(\/status)?$/);
    if (method === 'POST' && !m) {
      const b = JSON.parse(bodyText);
      if (u.endsWith('/fal-ai/fast-sdxl')) {
        if (b.prompt === 'sampler-probe') {
          // jalur khusus: verifikasi pemetaan sampler ComfyUI -> fal
          assert.strictEqual(b.sampler, 'dpmpp_2m_sde', 'fal sampler dipetakan dari nama ComfyUI');
          return jsonResp({ request_id: 'fal_smp1', status_url: 'x', response_url: 'https://queue.fal.run/fal-ai/fast-sdxl/requests/fal_smp1' });
        }
        assert.strictEqual(b.prompt, 'seorang wanita di taman bunga', 'fal prompt');
        assert.strictEqual(b.num_images, 2, 'fal num_images');
        assert.deepStrictEqual(b.image_size, { width: 768, height: 1152 }, 'fal image_size');
        assert.strictEqual(b.negative_prompt, 'blurry, low quality', 'fal negative');
        assert.ok(!('sampler' in b), 'fast-sdxl tanpa sampler utk payload default');
        if (b.loras) {
          assert.deepStrictEqual(b.loras, [{ path: 'https://example.com/sdxl2.safetensors', scale: 0.8 }], 'fal fast-sdxl loras (path+scale)');
        }
        return jsonResp({ request_id: 'fal_xyz789', status_url: 'x', response_url: 'https://queue.fal.run/fal-ai/fast-sdxl/requests/fal_xyz789' });
      }
      if (u.endsWith('/fal-ai/krea-2/turbo/lora')) {
        assert.strictEqual(b.prompt, 'seorang wanita di taman bunga', 'fal krea prompt');
        assert.deepStrictEqual(b.loras, [{ path: 'https://example.com/rekty-anjany.safetensors', scale: 0.8 }], 'fal krea loras');
        assert.ok(!('negative_prompt' in b), 'krea tanpa negative_prompt');
        assert.ok(!('num_inference_steps' in b), 'krea tanpa steps (distilled)');
        assert.ok(!('guidance_scale' in b), 'krea tanpa guidance (distilled)');
        assert.strictEqual(b.num_images, 2, 'krea num_images');
        assert.deepStrictEqual(b.image_size, { width: 768, height: 1152 }, 'krea image_size');
        assert.strictEqual(b.seed, 123456789, 'krea seed');
        return jsonResp({ request_id: 'fal_krea1', status_url: 'x', response_url: 'https://queue.fal.run/fal-ai/krea-2/turbo/lora/requests/fal_krea1' });
      }
      if (u.endsWith('/fal-ai/flux/dev')) {
        assert.strictEqual(b.prompt, 'seorang wanita di taman bunga', 'fal flux prompt');
        assert.ok(!('negative_prompt' in b), 'fal flux tanpa negative_prompt');
        assert.strictEqual(b.num_inference_steps, 25, 'fal flux steps');
        assert.ok(b.guidance_scale >= 0 && b.guidance_scale <= 10, 'fal flux guidance 0-10');
        return jsonResp({ request_id: 'fal_dev999', status_url: 'x', response_url: 'https://queue.fal.run/fal-ai/flux/dev/requests/fal_dev999' });
      }
      if (u.endsWith('/fal-ai/flux-lora')) {
        assert.strictEqual(b.prompt, 'seorang wanita di taman bunga', 'fal flux-lora prompt');
        assert.strictEqual(b.lora_url, 'https://example.com/lora2.safetensors', 'fal lora_url');
        assert.strictEqual(b.lora_scale, 0.7, 'fal lora_scale');
        return jsonResp({ request_id: 'fal_lora1', status_url: 'x', response_url: 'https://queue.fal.run/fal-ai/flux-lora/requests/fal_lora1' });
      }
      throw new Error('fal create tak dikenal: ' + u);
    }
    if (m) {
      if (m[2]) return jsonResp({ status: 'COMPLETED', response_url: u.replace(/\/status$/, '') });
      return jsonResp({ images: [{ url: 'https://img.fal/' + m[1] + '.png' }] });
    }
    throw new Error('fal tak tertangani: ' + u);
  }

  // --- gambar hasil generate (dipakai saat arsip KV aktif) ---
  if (method === 'GET' && u.startsWith('https://img.')) {
    return new Response(new Uint8Array([137, 80, 78, 71, 1, 2, 3]), { headers: { 'content-type': 'image/png' } });
  }

  // --- terjemahan prompt (Google gtx gratis) ---
  if (u.startsWith('https://translate.googleapis.com/translate_a/single')) {
    assert.ok(u.includes('tl=en'), 'translate: target bahasa Inggris');
    assert.ok(u.includes('q='), 'translate: q dikirim');
    return jsonResp([[["a woman in a flower garden", "seorang wanita di taman bunga", null, null, 1]], null, "id", "id", null, null, 1, ""]);
  }

  // --- refine prompt (Pollinations chat completions) ---
  if (u === 'https://gen.pollinations.ai/v1/chat/completions') {
    assert.strictEqual(method, 'POST', 'refine pakai POST');
    const b = JSON.parse(bodyText);
    assert.strictEqual(b.model, 'openai', 'refine model openai');
    assert.ok(Array.isArray(b.messages) && b.messages.length === 2, 'refine ada system+user');
    assert.strictEqual(b.messages[1].content, 'seorang wanita di taman bunga', 'refine isi prompt');
    const auth = opts && opts.headers && opts.headers.Authorization;
    assert.ok(auth, 'refine wajib Bearer key');
    return jsonResp({ choices: [{ message: { content: 'A beautiful woman standing in a vibrant flower garden, golden hour lighting, shallow depth of field, ultra detailed, masterpiece.' } }] });
  }

  // --- OAuth BYOP: tukar kode -> token ---
  if (u === 'https://enter.pollinations.ai/api/oauth/token') {
    assert.strictEqual(method, 'POST', 'oauth token pakai POST');
    assert.ok(bodyText.includes('grant_type=authorization_code'), 'grant_type authorization_code');
    assert.ok(bodyText.includes('code='), 'code dikirim');
    assert.ok(bodyText.includes('code_verifier='), 'code_verifier dikirim');
    assert.ok(bodyText.includes('client_id='), 'client_id dikirim');
    return jsonResp({ access_token: 'sk_byop_test', token_type: 'bearer', expires_in: 604800, scope: 'usage' });
  }

  // --- OAuth BYOP: saldo akun ---
  if (u === 'https://gen.pollinations.ai/account/balance') {
    const auth = opts && opts.headers && opts.headers.Authorization;
    assert.strictEqual(auth, 'Bearer sk_byop_test', 'balance pakai token BYOP');
    return jsonResp({ balance: 15.452, pollenBalance: 15.452, currency: 'pollen' });
  }

  // --- Pollinations (sinkron, balas bytes gambar) ---
  if (u.startsWith('https://image.pollinations.ai/prompt/') || u.startsWith('https://gen.pollinations.ai/image/')) {
    assert.strictEqual(method, 'GET', 'pollinations pakai GET');
    if (u.startsWith('https://gen.pollinations.ai/')) {
      const auth = opts && opts.headers && opts.headers.Authorization;
      assert.ok(['Bearer test-key', 'Bearer sk_byop_test', 'Bearer sk_env_fallback'].includes(auth), 'gen API pakai Bearer key: ' + auth);
    }
    // negative_prompt + guidance_scale (CFG) harus diteruskan ke Pollinations;
    // sampler tidak didukung Pollinations jadi tidak boleh ada param sampler.
    if (u.includes('width=768') && u.includes('height=1152') && u.includes('model=flux')) {
      assert.ok(u.includes('negative_prompt='), 'pollinations URL bawa negative_prompt');
      assert.ok(u.includes('guidance_scale='), 'pollinations URL bawa guidance_scale (CFG)');
      assert.ok(!u.includes('sampler='), 'pollinations tidak menerima sampler');
      assert.ok(!u.includes('steps='), 'pollinations tidak menerima steps');
    }
    return new Response(new Uint8Array([255, 216, 255, 224, 1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
  }

  // --- Self-Host gateway OpenAI-compatible (ComfyUI + LoRA) ---
  if (u.includes('/v1/images/generations') && u.includes('selfhost.test')) {
    assert.strictEqual(method, 'POST', 'selfhost pakai POST');
    const b = JSON.parse(bodyText);
    assert.strictEqual(b.model, 'rekty1988/anjany', 'selfhost model default rekty1988/anjany');
    assert.strictEqual(b.size, '768x1152', 'selfhost size WxH');
    assert.strictEqual(b.prompt, 'seorang wanita di taman bunga', 'selfhost prompt diteruskan');
    assert.ok(b.sampler, 'selfhost sampler ada');
    assert.ok(b.scheduler, 'selfhost scheduler ada');
    assert.ok(b.negative_prompt, 'selfhost negative_prompt ada');
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    return jsonResp({ created: 123, data: [{ b64_json: PNG }, { b64_json: PNG }] });
  }

  // --- Self-Host health ---
  if (u === 'https://selfhost.test/health') {
    return jsonResp({ ok: true, comfy: 'http://127.0.0.1:8188' });
  }

  throw new Error('fetch tak tertangani: ' + method + ' ' + u);
};

// ---------- tiruan Cloudflare KV (namespace IMAGES) ----------
const kvstore = new Map();
const IMAGES = {
  async put(key, value) {
    kvstore.set(key, value);
  },
  async get(key, opts) {
    const it = kvstore.get(key);
    if (it === undefined) return null;
    if (opts && opts.type === 'stream') return { value: it, metadata: {} };
    return it;
  },
  async delete(key) {
    kvstore.delete(key);
  },
};

async function runRaw(reqUrl, env = {}) {
  const req = new Request('http://test.local' + reqUrl, { method: 'GET' });
  return onRequest({ request: req, env });
}

// ============================ TES ============================
let passed = 0;
function ok(name) { passed++; console.log('  ✓ ' + name); }

console.log('TAMS:');
{
  const g = await run('/api/generate', webPayload('tams'));
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.data.taskId, '12345');
  assert.strictEqual(g.data.credits, 1.22);
  assert.strictEqual(g.data.provider, 'tams');
  ok('generate -> taskId 12345, credits 1.22');

  const t = await run('/api/task?id=12345', null, {}, AUTH);
  assert.strictEqual(t.data.status, 'SUCCESS');
  assert.deepStrictEqual(t.data.images, ['https://img.tams/1.png', 'https://img.tams/2.png']);
  assert.strictEqual(t.data.progress, 100);
  ok('task -> SUCCESS + 2 gambar');
}

console.log('Replicate:');
{
  const g = await run('/api/generate', webPayload('replicate'));
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.data.taskId, 'replicate:rp_abc123');
  ok('generate -> taskId replicate:rp_abc123');

  const t = await run('/api/task?id=replicate:rp_abc123', null, {}, AUTH);
  assert.strictEqual(t.data.provider, 'replicate');
  assert.strictEqual(t.data.status, 'SUCCESS');
  assert.deepStrictEqual(t.data.images, ['https://img.repl/1.png']);
  ok('task (prefix replicate) -> SUCCESS + 1 gambar');
}

console.log('Replicate (flux-schnell):');
{
  const g = await run('/api/generate', webPayload('replicate', 'black-forest-labs/flux-schnell'));
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.data.taskId, 'replicate:rp_flux1');
  ok('generate -> taskId replicate:rp_flux1 (aspect_ratio 2:3, steps 4)');

  const t = await run('/api/task?id=replicate:rp_flux1', null, {}, AUTH);
  assert.strictEqual(t.data.status, 'SUCCESS');
  ok('task flux -> SUCCESS');
}

console.log('fal.ai:');
{
  const g = await run('/api/generate', webPayload('fal'));
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.data.taskId, 'fal:fal-ai/fast-sdxl:fal_xyz789');
  ok('generate -> taskId fal:fal-ai/fast-sdxl:fal_xyz789');

  const t = await run('/api/task?id=' + encodeURIComponent('fal:fal-ai/fast-sdxl:fal_xyz789'), null, {}, AUTH);
  assert.strictEqual(t.data.provider, 'fal');
  assert.strictEqual(t.data.status, 'SUCCESS');
  assert.deepStrictEqual(t.data.images, ['https://img.fal/fal_xyz789.png']);
  ok('task (model tersandikan) -> SUCCESS + gambar');
}

console.log('fal.ai (sampler ComfyUI -> fal):');
{
  const p = webPayload('fal');
  p.params.prompt = 'sampler-probe';
  p.params.ksamplerName = 'dpmpp_2m_sde_gpu';
  const g = await run('/api/generate', p);
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.data.taskId, 'fal:fal-ai/fast-sdxl:fal_smp1');
  ok('generate -> sampler dpmpp_2m_sde_gpu dipetakan ke dpmpp_2m_sde utk fal');
}

console.log('Replicate (LoRA flux-schnell-lora):');
{
  const p = webPayload('replicate', 'black-forest-labs/flux-schnell');
  p.params.models = [{ name: 'FLUX.1 [schnell] LoRA', weight: 0.8, triggerWords: ['flux-lora'], loraModel: 'black-forest-labs/flux-schnell-lora', loraUrl: 'https://example.com/lora.safetensors' }];
  const g = await run('/api/generate', p);
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.data.taskId, 'replicate:rp_fluxlora1');
  ok('generate -> target beralih ke flux-schnell-lora (lora_url + trigger phrase)');

  const t = await run('/api/task?id=replicate:rp_fluxlora1', null, {}, AUTH);
  assert.strictEqual(t.data.status, 'SUCCESS');
  ok('task lora -> SUCCESS');
}

console.log('Replicate (LoRA SDXL ikea, tanpa URL):');
{
  const p = webPayload('replicate', 'stability-ai/sdxl');
  p.params.models = [{ name: 'IKEA Instructions', weight: 0.9, triggerWords: ['ikea instructions'], loraModel: 'ostris/ikea-instructions-lora-sdxl', loraUrl: '' }];
  const g = await run('/api/generate', p);
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.data.taskId, 'replicate:rp_ikea1');
  ok('generate -> target ikea-instructions-lora-sdxl (tanpa lora_url)');
}

console.log('fal.ai (LoRA flux-lora):');
{
  const p = webPayload('fal', 'fal-ai/flux/schnell');
  p.params.models = [{ name: 'FLUX LoRA', weight: 0.7, triggerWords: ['flux-lora'], loraModel: 'fal-ai/flux-lora', loraUrl: 'https://example.com/lora2.safetensors' }];
  const g = await run('/api/generate', p);
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.data.taskId, 'fal:fal-ai/flux-lora:fal_lora1');
  ok('generate -> target fal-ai/flux-lora (lora_url + scale)');

  const t = await run('/api/task?id=' + encodeURIComponent('fal:fal-ai/flux-lora:fal_lora1'), null, {}, AUTH);
  assert.strictEqual(t.data.status, 'SUCCESS');
  assert.deepStrictEqual(t.data.images, ['https://img.fal/fal_lora1.png']);
  ok('task lora -> SUCCESS + gambar');
}

console.log('Replicate (LoRA SDXL zylim via URL):');
{
  const p = webPayload('replicate', 'stability-ai/sdxl');
  p.params.models = [{ name: 'SDXL + LoRA URL', weight: 0.9, triggerWords: ['lora'], loraModel: 'zylim0702/sdxl-lora-customize-model', loraUrl: 'https://example.com/sdxl-lora.safetensors' }];
  const g = await run('/api/generate', p);
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.data.taskId, 'replicate:rp_zylim1');
  ok('generate -> target zylim0702/sdxl-lora-customize-model (lora_url + scale)');

  const p2 = webPayload('replicate', 'stability-ai/sdxl');
  p2.params.models = [{ name: 'SDXL + LoRA URL', weight: 0.9, triggerWords: ['lora'], loraModel: 'zylim0702/sdxl-lora-customize-model', loraUrl: '' }];
  const bad = await run('/api/generate', p2);
  assert.strictEqual(bad.status, 400);
  ok('zylim tanpa lora_url -> 400');
}

console.log('fal.ai (LoRA SDXL fast-sdxl):');
{
  const p = webPayload('fal', 'fal-ai/fast-sdxl');
  p.params.models = [{ name: 'SDXL + LoRA URL', weight: 0.8, triggerWords: ['lora'], loraModel: 'fal-ai/fast-sdxl', loraUrl: 'https://example.com/sdxl2.safetensors' }];
  const g = await run('/api/generate', p);
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.data.taskId, 'fal:fal-ai/fast-sdxl:fal_xyz789');
  ok('generate -> fast-sdxl + input.loras (path+scale), tetap kirim negative_prompt');
}

console.log('fal.ai (LoRA Krea 2 turbo):');
{
  const p = webPayload('fal', 'fal-ai/krea-2/turbo');
  p.params.models = [{ name: 'Krea 2 LoRA', weight: 0.8, triggerWords: ['krea2'], loraModel: 'fal-ai/krea-2/turbo/lora', loraUrl: 'https://example.com/rekty-anjany.safetensors' }];
  const g = await run('/api/generate', p);
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.data.taskId, 'fal:fal-ai/krea-2/turbo/lora:fal_krea1');
  ok('generate -> target fal-ai/krea-2/turbo/lora (loras, tanpa negative/steps/guidance)');

  const t = await run('/api/task?id=' + encodeURIComponent('fal:fal-ai/krea-2/turbo/lora:fal_krea1'), null, {}, AUTH);
  assert.strictEqual(t.data.status, 'SUCCESS');
  assert.deepStrictEqual(t.data.images, ['https://img.fal/fal_krea1.png']);
  ok('task krea lora -> SUCCESS + gambar');

  const p2 = webPayload('fal', 'fal-ai/krea-2/turbo');
  p2.params.models = [{ name: 'Krea 2 LoRA', weight: 0.8, triggerWords: ['krea2'], loraModel: 'fal-ai/krea-2/turbo/lora', loraUrl: '' }];
  const bad = await run('/api/generate', p2);
  assert.strictEqual(bad.status, 400);
  ok('krea lora tanpa URL -> 400');
}

console.log('fal.ai (flux dev):');
{
  const g = await run('/api/generate', webPayload('fal', 'fal-ai/flux/dev'));
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.data.taskId, 'fal:fal-ai/flux/dev:fal_dev999');
  ok('generate -> taskId fal:fal-ai/flux/dev:fal_dev999');

  const t = await run('/api/task?id=' + encodeURIComponent('fal:fal-ai/flux/dev:fal_dev999'), null, {}, AUTH);
  assert.strictEqual(t.data.provider, 'fal');
  assert.strictEqual(t.data.status, 'SUCCESS');
  assert.deepStrictEqual(t.data.images, ['https://img.fal/fal_dev999.png']);
  ok('task (model tersandikan) -> SUCCESS + gambar');
}

console.log('Cloudflare KV (arsip gambar):');
{
  const h = await run('/api/health', null, { IMAGES });
  assert.strictEqual(h.data.storage, 'kv', 'health storage:kv saat binding IMAGES ada');
  const h2 = await run('/api/health', null, {});
  assert.strictEqual(h2.data.storage, null, 'health storage null tanpa binding');
  ok('health -> storage sesuai binding');

  const t = await run('/api/task?id=12345', null, { IMAGES }, AUTH);
  assert.strictEqual(t.data.status, 'SUCCESS');
  assert.ok(t.data.images.length === 2, '2 gambar diarsip');
  for (const img of t.data.images) {
    assert.ok(img.startsWith('/img/'), 'URL permanen /img/<nama>: ' + img);
  }
  assert.strictEqual(kvstore.size, 2, '2 objek tersimpan di KV');
  ok('task SUCCESS -> gambar diarsip ke KV (URL /img/...)');

  const key = t.data.images[0].slice(5);
  const raw = await runRaw('/img/' + key, { IMAGES });
  assert.strictEqual(raw.status, 200);
  assert.strictEqual(raw.headers.get('content-type'), 'image/png');
  assert.ok(raw.headers.get('cache-control').includes('immutable'), 'cache-control immutable');
  const bytes = new Uint8Array(await raw.arrayBuffer());
  assert.deepStrictEqual(Array.from(bytes), [137, 80, 78, 71, 1, 2, 3], 'body gambar sama');
  ok('GET /img/<nama> -> 200 + content-type + body');

  const miss = await runRaw('/img/tidak-ada.png', { IMAGES });
  assert.strictEqual(miss.status, 404);
  ok('GET /img/tidak-ada -> 404');

  const nokv = await runRaw('/img/x.png', {});
  assert.strictEqual(nokv.status, 404);
  ok('GET /img tanpa binding -> 404');
}

console.log('Pollinations (gratis, tanpa API key):');
{
  const p = webPayload('pollinations', 'flux');
  const g = await run('/api/generate', p, { IMAGES });
  assert.strictEqual(g.status, 200);
  assert.ok(String(g.data.taskId).startsWith('pollinations:'), 'taskId pollinations');
  assert.ok(Array.isArray(g.data.images) && g.data.images.length === 1, 'images langsung di response');
  assert.ok(g.data.images[0].startsWith('/img/'), 'gambar diarsip ke /img/');
  ok('generate -> taskId pollinations:... + gambar /img/ (tanpa key)');

  const t = await run('/api/task?id=' + encodeURIComponent(g.data.taskId), null, { IMAGES });
  assert.strictEqual(t.data.status, 'SUCCESS');
  assert.deepStrictEqual(t.data.images, g.data.images);
  ok('task pollinations -> SUCCESS + gambar sama');

  // tanpa API key & tanpa KV -> tetap jalan, gambar pakai URL langsung
  const p2 = webPayload('pollinations', 'flux');
  p2.apiKey = '';
  const g2 = await run('/api/generate', p2, {});
  assert.strictEqual(g2.status, 200);
  assert.ok(String(g2.data.images[0]).startsWith('https://image.pollinations.ai/'), 'tanpa KV pakai URL langsung');
  ok('generate tanpa key & tanpa KV -> URL pollinations langsung');
}

console.log('Self-Host (gateway ComfyUI + LoRA):');
{
  const p = webPayload('selfhost', 'rekty1988/anjany');
  p.selfhostUrl = 'https://selfhost.test';
  const g = await run('/api/generate', p, { IMAGES });
  assert.strictEqual(g.status, 200);
  assert.ok(String(g.data.taskId).startsWith('selfhost:'), 'taskId selfhost');
  assert.ok(Array.isArray(g.data.images) && g.data.images.length === 2, '2 gambar dari n=2');
  assert.ok(g.data.images[0].startsWith('/img/'), 'gambar selfhost diarsip ke /img/');
  ok('generate selfhost -> taskId selfhost:... + 2 gambar /img/ (tanpa key)');

  const t = await run('/api/task?id=' + encodeURIComponent(g.data.taskId), null, { IMAGES });
  assert.strictEqual(t.data.status, 'SUCCESS');
  assert.deepStrictEqual(t.data.images, g.data.images);
  ok('task selfhost -> SUCCESS + gambar sama');

  // tanpa URL endpoint -> 400
  const p2 = webPayload('selfhost', 'rekty1988/anjany');
  p2.selfhostUrl = '';
  const bad = await run('/api/generate', p2, {});
  assert.strictEqual(bad.status, 500);
  assert.ok(String(bad.data.error).includes('endpoint self-host'), 'error menyebut endpoint self-host');
  ok('generate selfhost tanpa URL -> error jelas');

  // /api/archive: simpan base64 -> /img/
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  const arc = await run('/api/archive', { images: [{ b64: PNG }] }, { IMAGES });
  assert.strictEqual(arc.status, 200);
  assert.ok(Array.isArray(arc.data.images) && arc.data.images.length === 1);
  assert.ok(arc.data.images[0].startsWith('/img/'), 'archive -> /img/');
  ok('/api/archive -> gambar tersimpan permanen');

  const arcBad = await run('/api/archive', { images: [] }, {});
  assert.strictEqual(arcBad.status, 400);
  ok('/api/archive kosong -> 400');
}

console.log('Translate + Refine prompt:');
{
  // translate semua bahasa -> Inggris (gratis via Google gtx)
  const tr = await run('/api/translate?q=' + encodeURIComponent('seorang wanita di taman bunga'), null, {});
  assert.strictEqual(tr.status, 200);
  assert.strictEqual(tr.data.text, 'a woman in a flower garden', 'translate hasil Inggris');
  assert.strictEqual(tr.data.detected, 'id', 'translate deteksi bahasa');
  ok('translate -> teks Inggris + deteksi bahasa');

  const trEmpty = await run('/api/translate?q=', null, {});
  assert.strictEqual(trEmpty.status, 400);
  ok('translate q kosong -> 400');

  // refine via Pollinations chat (pakai key)
  const rf = await run('/api/refine', { prompt: 'seorang wanita di taman bunga' }, { POLLINATIONS_API_KEY: 'sk_env_fallback' });
  assert.strictEqual(rf.status, 200);
  assert.ok(rf.data.ok, 'refine ok');
  assert.ok(rf.data.text.includes('flower garden'), 'refine hasil: ' + rf.data.text);
  ok('refine -> prompt diperluas pakai Pollinations chat');

  const rfNoKey = await run('/api/refine', { prompt: 'seorang wanita' }, {});
  assert.strictEqual(rfNoKey.status, 400);
  ok('refine tanpa key -> 400 (perlu BYOP/key)');
}

console.log('OAuth BYOP (Bring Your Own Pollen):');
{
  // config -> clientId + redirectUri
  const cfg = await run('/api/oauth/config', null, { POLLINATIONS_APP_KEY: 'pk_test' });
  assert.strictEqual(cfg.status, 200);
  assert.strictEqual(cfg.data.clientId, 'pk_test');
  assert.ok(cfg.data.redirectUri.endsWith('/callback'), 'redirectUri /callback: ' + cfg.data.redirectUri);
  assert.ok(cfg.data.authorizeBase.includes('enter.pollinations.ai/authorize'), 'authorizeBase benar');
  ok('oauth/config -> clientId pk_ + redirectUri /callback');

  const cfgNoKey = await run('/api/oauth/config', null, {});
  assert.strictEqual(cfgNoKey.data.clientId, '');
  ok('oauth/config tanpa App Key -> clientId kosong');

  // tukar kode -> session
  const tok = await run('/api/oauth/token', { code: 'oauth_code_1', code_verifier: 'verifier123', redirect_uri: 'http://test.local/callback' }, { POLLINATIONS_APP_KEY: 'pk_test', IMAGES });
  assert.strictEqual(tok.status, 200);
  assert.ok(tok.data.session, 'session id dikembalikan');
  assert.strictEqual(tok.data.expiresIn, 604800);
  const session = tok.data.session;
  ok('oauth/token -> session id + expiresIn 7 hari');

  // status -> connected + balance
  const st = await run('/api/oauth/status?session=' + session, null, { IMAGES });
  assert.strictEqual(st.status, 200);
  assert.strictEqual(st.data.connected, true);
  assert.strictEqual(st.data.balance.balance, 15.452);
  ok('oauth/status -> connected + balance 15.452');

  // generate dengan session -> BYOP token dipakai (bukan env/header)
  const p = webPayload('pollinations', 'flux');
  const g = await run('/api/generate', p, { POLLINATIONS_API_KEY: 'sk_env_fallback', IMAGES }, { 'x-session': session });
  assert.strictEqual(g.status, 200);
  assert.ok(String(g.data.taskId).startsWith('pollinations:'), 'taskId pollinations');
  ok('generate + x-session -> token BYOP (Bearer sk_byop_test) diprioritaskan');

  // logout -> sesi terhapus
  const lo = await run('/api/oauth/logout', { session }, { IMAGES });
  assert.strictEqual(lo.status, 200);
  const st2 = await run('/api/oauth/status?session=' + session, null, { IMAGES });
  assert.strictEqual(st2.data.connected, false);
  ok('oauth/logout -> status jadi disconnected');

  // tanpa session -> fallback ke secret env
  const p2 = webPayload('pollinations', 'flux');
  const g2 = await run('/api/generate', p2, { POLLINATIONS_API_KEY: 'sk_env_fallback', IMAGES });
  assert.strictEqual(g2.status, 200);
  ok('generate tanpa session -> fallback env POLLINATIONS_API_KEY');
}

console.log('Validasi (API key + provider salah):');
{
  const bad = await run('/api/generate', { provider: 'nope', params: {}, apiKey: 'k' });
  assert.strictEqual(bad.status, 400);
  ok('provider tidak dikenal -> 400');

  const nokey = await run('/api/generate', { provider: 'tams', params: {} });
  assert.strictEqual(nokey.status, 401);
  ok('tanpa api key -> 401');

  const h = await run('/api/health', null, { REPLICATE_API_TOKEN: 'x' });
  assert.deepStrictEqual(h.data.hasKeys, { tams: false, replicate: true, fal: false, pollinations: true });
  ok('/api/health -> hasKeys per provider (+ pollinations selalu true)');
}

console.log('\nSemua tes lolos (' + passed + '). Panggilan keluar tercatat ' + calls.length + ' (semua ke host tiruan).');
