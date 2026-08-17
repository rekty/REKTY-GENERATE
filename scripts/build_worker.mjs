/**
 * Bangun `_worker.js` (Advanced Mode Cloudflare Pages) dari `functions/api.js`
 * + `index.html`.
 *
 * Mengapa: pada setup direct-upload via wrangler, Pages Functions berbasis
 * file (`functions/`) kadang tidak ter-attach, dan binding env.ASSETS pada
 * Advanced Mode direct-upload tidak menyajikan file statis. Karena app ini
 * single-file (`index.html` + CDN eksternal), worker cukup:
 *   - `/api/*`      -> logika backend dari functions/api.js
 *   - path lain     -> kembalikan index.html (SPA, 200)
 *
 * `_worker.js` harus self-contained (tanpa import), jadi index.html di-embed
 * sebagai string aman (JSON.stringify -> JSON.parse).
 *
 * Jalankan: node scripts/build_worker.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = fs.readFileSync(path.join(root, 'functions', 'api.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace(/^\uFEFF/, ''); // buang BOM
const favicon = fs.existsSync(path.join(root, 'favicon.svg')) ? fs.readFileSync(path.join(root, 'favicon.svg'), 'utf8') : '';
const faviconPng = fs.existsSync(path.join(root, 'favicon.png')) ? fs.readFileSync(path.join(root, 'favicon.png')) : null;

const body = src
  .replace('export async function onRequest(context) {', 'async function onRequest(context) {')
  .replace('export {', '');


const router = `

/* ---------- Advanced Mode: /api/* -> backend, path lain -> index.html ---------- */
// index.html di-embed sebagai base64 (ASCII murni, aman untuk bundler/minifier).
const HTML_B64 = '${Buffer.from(html, 'utf8').toString('base64')}';
const INDEX_HTML = new TextDecoder().decode(Uint8Array.from(atob(HTML_B64), (c) => c.charCodeAt(0)));
// Header keamanan untuk halaman HTML & favicon (nama beda dari SEC_H di api.js
// karena keduanya di-embed ke file yang sama)
const ROUTER_SEC_H = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'microphone=(), geolocation=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://unpkg.com https://cdn.jsdelivr.net https://fonts.googleapis.com https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://fonts.googleapis.com https://unpkg.com; img-src 'self' data: blob: https:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' https: wss: data: blob: https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
};
const HTML_CT = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache, must-revalidate', ...ROUTER_SEC_H };
const FAVICON_B64 = '${Buffer.from(favicon, 'utf8').toString('base64')}';
const FAVICON_SVG = new TextDecoder().decode(Uint8Array.from(atob(FAVICON_B64), (c) => c.charCodeAt(0)));
const FAVICON_PNG_B64 = '${faviconPng ? Buffer.from(faviconPng).toString('base64') : ''}';
const FAVICON_PNG = Uint8Array.from(atob(FAVICON_PNG_B64), (c) => c.charCodeAt(0));

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Redirect domain lama (rekty-generator.pages.dev + alias preview-nya)
    // ke visualaiartwork.pages.dev — pengunjung lama ikut pindah (308 permanen,
    // path & query dipertahankan). KV sama, jadi /img/ arsip tetap terbaca.
    const host = (url.hostname || '').toLowerCase();
    if (host === 'rekty-generator.pages.dev' || host.endsWith('.rekty-generator.pages.dev')) {
      return Response.redirect('https://visualaiartwork.pages.dev' + url.pathname + url.search, 308);
    }
    if (url.pathname === '/favicon.svg') {
      return new Response(FAVICON_SVG, { status: 200, headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', ...ROUTER_SEC_H } });
    }
    if (url.pathname === '/favicon.png') {
      return new Response(FAVICON_PNG, { status: 200, headers: { 'Content-Type': 'image/png', ...ROUTER_SEC_H } });
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/img/')) {
      return onRequest({ request, env, data: {}, waitUntil: ctx.waitUntil.bind(ctx) });
    }
    return new Response(INDEX_HTML, { status: 200, headers: HTML_CT });
  },
};
`;

const out = body + router;
fs.writeFileSync(path.join(root, '_worker.js'), out, 'utf8');
console.log('OK: _worker.js ditulis (' + (out.length / 1024).toFixed(1) + ' KB)');
