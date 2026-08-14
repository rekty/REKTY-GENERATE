/**
 * Consumer Cloudflare Queues untuk antrian generate Pollinations.
 *
 * Pages Functions TIDAK BISA jadi queue consumer (batasan resmi Cloudflare),
 * jadi consumer dipisah menjadi Worker sendiri. Logika pemrosesan ada di
 * `functions/api.js` (single source of truth) — file ini hanya wrapper.
 *
 * Deploy: npx wrangler@3.90.0 deploy -c consumer/wrangler.toml
 * (secret POLLINATIONS_API_KEY juga perlu diset di worker ini kalau dipakai.)
 */
import { queue } from '../functions/api.js';

export default { queue };
