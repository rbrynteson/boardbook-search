import { config } from '../config.js';
import { log } from './log.js';

let nextAllowedAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Serialize every outbound request through a single rate-limit gate.
 * BoardBook is a small vendor site hosting public records for many districts;
 * we go one request at a time with a fixed delay rather than parallelising.
 */
async function gate() {
  const now = Date.now();
  const wait = Math.max(0, nextAllowedAt - now);
  nextAllowedAt = Math.max(now, nextAllowedAt) + config.requestDelayMs;
  if (wait > 0) await sleep(wait);
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Polite fetch with rate limiting, bounded retries and exponential backoff.
 * Returns the Response; callers decide how to read the body.
 */
export async function politeFetch(url, { headers = {}, expect = null, signal } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    await gate();
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal,
        headers: {
          'User-Agent': config.userAgent,
          'Accept-Language': 'en-US,en;q=0.9',
          ...headers,
        },
      });

      if (RETRYABLE.has(res.status)) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const backoff = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : Math.min(30_000, 1500 * 2 ** attempt);
        log.warn(`HTTP ${res.status} for ${url} — retrying in ${Math.round(backoff / 1000)}s`);
        await sleep(backoff);
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

      if (expect) {
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes(expect)) {
          throw new Error(`Expected ${expect} from ${url}, got "${ct}"`);
        }
      }
      return res;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
      if (attempt === config.maxRetries) break;
      const backoff = Math.min(30_000, 1500 * 2 ** attempt);
      log.warn(`${err.message} — retrying in ${Math.round(backoff / 1000)}s`);
      await sleep(backoff);
    }
  }
  throw new Error(`Failed after ${config.maxRetries + 1} attempts: ${url} (${lastErr?.message})`);
}

export async function fetchText(url, opts = {}) {
  const res = await politeFetch(url, opts);
  return res.text();
}

export async function fetchBuffer(url, { maxBytes = Infinity, ...opts } = {}) {
  const res = await politeFetch(url, opts);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { tooLarge: true, bytes: declared, contentType: res.headers.get('content-type') || '' };
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) {
    return { tooLarge: true, bytes: buf.length, contentType: res.headers.get('content-type') || '' };
  }
  return { buffer: buf, bytes: buf.length, contentType: res.headers.get('content-type') || '' };
}
