/**
 * Smoke test `firebase-backend/index.js` TANPA emulator / deploy.
 *
 * Memanggil handler onRequest (firebase-functions v2) langsung dengan
 * req/res tiruan + fetch palsu (seperti scripts/test_backend.mjs).
 *
 * Prasyarat: `cd firebase-backend && npm install`
 * Jalankan dari root repo: node scripts/smoke_firebase.cjs
 */
const path = require('node:path');
const { createRequire } = require('node:module');

const fnDir = path.join(__dirname, '..', 'firebase-backend');
const fireReq = createRequire(path.join(fnDir, 'package.json'));
const { api } = fireReq(path.join(fnDir, 'index.js'));

const log = [];
function makeRes() {
  const r = {
    statusCode: 200,
    headers: {},
    listeners: {},
    on(ev, cb) { (r.listeners[ev] ||= []).push(cb); return r; },
    emit(ev) { (r.listeners[ev] || []).forEach((cb) => cb()); },
    status(s) { r.statusCode = s; return r; },
    json(d) { log.push({ status: r.statusCode, data: d }); r.emit('finish'); return r; },
    send(d) { log.push({ status: r.statusCode, data: d }); r.emit('finish'); return r; },
    setHeader(k, v) { r.headers[k] = v; return r; },
    set(k, v) { return r.setHeader(k, v); },
    get(k) { return r.headers[k]; },
    getHeader(k) { return r.headers[k]; },
    removeHeader(k) { delete r.headers[k]; return r; },
    hasHeader(k) { return k in r.headers; },
    end() { r.emit('finish'); return r; },
  };
  return r;
}
function makeReq(method, pathName, query, headers, body) {
  return {
    method,
    path: pathName,
    query,
    headers: { get: (k) => headers[k.toLowerCase()] },
    rawBody: body ? Buffer.from(JSON.stringify(body)) : null,
    body: body || undefined,
  };
}

// fetch tiruan untuk TAMS (generate + poll)
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes('tensorart.cloud') && opts.method === 'POST' && u.endsWith('/v1/jobs')) {
    return new Response(JSON.stringify({ job: { id: 'fb_test_1', credits: 1.22 } }), { status: 200 });
  }
  if (u.includes('tensorart.cloud') && u.includes('/v1/jobs/')) {
    return new Response(JSON.stringify({ job: { status: 'SUCCESS', successInfo: { images: [{ url: 'https://img.fb/1.png' }] } } }), { status: 200 });
  }
  throw new Error('fetch tak tertangani: ' + u);
};

(async () => {
  let res;

  res = makeRes();
  await api(makeReq('GET', '/api/health', {}, {}), res);
  console.log('1. health         ->', JSON.stringify(log.at(-1)));

  res = makeRes();
  await api(makeReq('POST', '/api/generate', {}, {}, { provider: 'tams', params: {} }), res);
  console.log('2. tanpa key      ->', JSON.stringify(log.at(-1)));

  const params = {
    baseModel: { modelId: '1', modelFileId: '2' }, model: '', sdxl: { refiner: false },
    models: [], embeddingModels: [], sdVae: 'Automatic',
    prompt: 'tes', negativePrompt: '', height: 1152, width: 768, imageCount: 1,
    steps: 25, images: [], denoisingStrength: 0.5, cfgScale: 7, seed: '42',
    clipSkip: 2, etaNoiseSeedDelta: 31337, v1Clip: false, enablePix2pix: false,
    guidance: 3.5, useFirstLastFrame: false, ksamplerName: 'Euler a', schedule: 'normal',
  };
  res = makeRes();
  await api(makeReq('POST', '/api/generate', {}, { 'x-api-key': 'k123' }, { provider: 'tams', params, apiKey: 'k123' }), res);
  console.log('3. generate+key   ->', JSON.stringify(log.at(-1)));

  res = makeRes();
  await api(makeReq('GET', '/api/task', { id: 'fb_test_1' }, { 'x-api-key': 'k123' }), res);
  console.log('4. task poll      ->', JSON.stringify(log.at(-1)));

  res = makeRes();
  await api(makeReq('GET', '/api/nope', {}, {}), res);
  console.log('5. 404            ->', JSON.stringify(log.at(-1)));

  const ok = log.length === 5;
  console.log('\nSMOKE ' + (ok ? 'OK' : 'FAIL') + ' (' + log.length + ' response)');
  if (!ok) process.exit(1);
})().catch((e) => { console.error('SMOKE FAIL:', e); process.exit(1); });
