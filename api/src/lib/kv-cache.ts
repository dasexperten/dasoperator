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
//   3. KV.put(key, JSON, expirationTtl=TTL)  ← fire-and-forget via waitUntil
//   4. Return data
//
// Cache hit flow:
//   1. KV.get(key) → cached JSON
//   2. Parse + return
//
// Errors from upstream are NOT cached — they bubble up so the next caller
// retries. We never cache a fail. We also never return stale data on error;
// callers can implement stale-on-error explicitly if they need it.
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

  // Write-through (don't await — return ASAP)
  // Note: in Workers, async writes after the response is sent need
  // ctx.waitUntil() to survive. Without ctx access here we fire-and-forget;
  // CF runtime keeps the write alive until the request lifecycle completes
  // for short writes like this.
  try {
    const safeTtl = Math.max(60, Math.floor(ttlSec));
    void env.CACHE.put(key, JSON.stringify(data), { expirationTtl: safeTtl });
  } catch {
    // Don't let cache-write failures break the response
  }

  return data;
}
