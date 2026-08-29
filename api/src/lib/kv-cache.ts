// =============================================================================
// Generic KV-backed cache for slow external API responses.
//
// Wraps an async fetcher with a stale-tolerant cache stored in the CACHE
// KV namespace. The first caller pays the slow upstream cost; everyone else
// within the TTL window gets a sub-50ms response.
//
// Cache miss flow:
//   1. KV.get(key) → null
//   2. fetcher() runs (slow: e.g. 17s Retail CRM call)
//   3. KV.put(key, JSON, expirationTtl=TTL) — awaited inside the request
//      so the write definitely commits before Worker terminates
//   4. Return data
//
// Cache hit flow:
//   1. KV.get(key) → cached JSON
//   2. Parse + return
//
// Errors from upstream are NOT cached — they bubble up so the next caller
// retries. We never cache a fail.
// =============================================================================

import type { Env } from '../types';

/** Build a cache key from a base + ordered params. */
export function cacheKey(base: string, params: Record<string, string | number | undefined> = {}): string {
  const parts: string[] = [base];
  const keys = Object.keys(params).sort();
  for (const k of keys) {
    const v = params[k];
    if (v === undefined || v === '' || v === null) continue;
    parts.push(`${k}=${String(v)}`);
  }
  return parts.join('|');
}

/**
 * Wrap a slow async fetcher with KV cache.
 *
 * IMPORTANT: We AWAIT the KV.put on cache miss. Cloudflare Workers kill
 * unawaited promises after the response is sent unless explicitly extended
 * via ctx.waitUntil(). Awaiting here adds ~30-50ms to the slow miss path
 * (which is already multi-second) but guarantees the write commits.
 * Subsequent hits within TTL serve from KV in <100ms.
 *
 * @param env       Worker env (needs CACHE KVNamespace)
 * @param key       Cache key (use cacheKey() helper)
 * @param ttlSec    Time-to-live in seconds. Minimum 60 per CF KV rules.
 * @param fetcher   Async function producing the data on miss
 */
export async function withKvCache<T>(
  env: Env,
  key: string,
  ttlSec: number,
  fetcher: () => Promise<T>
): Promise<T> {
  // Read-through
  try {
    const hit = await env.CACHE.get(key);
    if (hit !== null) {
      return JSON.parse(hit) as T;
    }
  } catch {
    // KV read failure — fall through to upstream
  }

  // Miss — go upstream
  const data = await fetcher();

  // Write-through — awaited to guarantee commit
  try {
    const safeTtl = Math.max(60, Math.floor(ttlSec));
    await env.CACHE.put(key, JSON.stringify(data), { expirationTtl: safeTtl });
  } catch {
    // Don't let cache-write failures break the response
  }

  return data;
}

// =============================================================================
// Stale-tolerant variant.
//
// Same read-through/write-through as withKvCache, plus a second, long-lived
// copy under `<key>|lastgood`. When the upstream fails — 429, timeout, or a
// truncated body that will not parse — the caller gets the last copy that DID
// parse, flagged stale, instead of an exception surfacing as a raw error
// string on the Owner's screen.
//
// Only a total absence of any good copy still throws.
// =============================================================================

export interface StaleResult<T> {
  data: T;
  stale: boolean;
  /** Unix seconds — when this payload was actually produced upstream. */
  produced_at: number;
}

/** How long a last-known-good copy stays usable as a fallback. */
const LAST_GOOD_TTL_SEC = 86400; // 24h

export async function withKvCacheStale<T>(
  env: Env,
  key: string,
  ttlSec: number,
  fetcher: () => Promise<T>
): Promise<StaleResult<T>> {
  const lastGoodKey = `${key}|lastgood`;

  // Fresh hit
  try {
    const hit = await env.CACHE.get(key);
    if (hit !== null) {
      const parsed = JSON.parse(hit) as { at: number; data: T };
      return { data: parsed.data, stale: false, produced_at: parsed.at };
    }
  } catch {
    // KV read failure — fall through to upstream
  }

  try {
    const data = await fetcher();
    const at = Math.floor(Date.now() / 1000);
    const envelope = JSON.stringify({ at, data });
    try {
      await env.CACHE.put(key, envelope, { expirationTtl: Math.max(60, Math.floor(ttlSec)) });
      await env.CACHE.put(lastGoodKey, envelope, { expirationTtl: LAST_GOOD_TTL_SEC });
    } catch {
      // Cache-write failures never break the response
    }
    return { data, stale: false, produced_at: at };
  } catch (upstreamError) {
    try {
      const fallback = await env.CACHE.get(lastGoodKey);
      if (fallback !== null) {
        const parsed = JSON.parse(fallback) as { at: number; data: T };
        return { data: parsed.data, stale: true, produced_at: parsed.at };
      }
    } catch {
      // No usable copy — the original failure stands
    }
    throw upstreamError;
  }
}
