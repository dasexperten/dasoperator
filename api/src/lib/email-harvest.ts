// Email archive harvester — paginates the whole Gmail archive via the bridge
// ActionExport, writes each batch to R2, checkpoints the cursor in KV.
// Robust to Apps Script flakiness: never advances on error; only marks done
// when a count:0 page arrives AFTER we already harvested something.
import type { Env } from '../types';

const K_CURSOR = 'email-harvest:cursor';
const K_COUNT  = 'email-harvest:count';
const K_DONE   = 'email-harvest:done';
const BATCH    = 25;

export async function runHarvestTick(env: Env): Promise<Record<string, unknown>> {
  if ((await env.CACHE.get(K_DONE)) === '1') return { skipped: 'done' };

  const cursor = parseInt((await env.CACHE.get(K_CURSOR)) || '0', 10) || 0;

  let r: Response;
  try {
    r = await env.EMAILER.fetch(new Request('https://emailer/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'export', query: '', start: cursor, max: BATCH, bodies: true }),
      signal: AbortSignal.timeout(120_000),
    }));
  } catch (e) {
    return { error: 'bridge_unreachable', cursor, detail: String(e) };
  }
  if (!r.ok) return { error: 'bridge_http_' + r.status, cursor };

  let j: any;
  try { j = await r.json(); } catch { return { error: 'bad_json', cursor }; }
  const res = (j && j.result) ? j.result : j;
  if (!res || !Array.isArray(res.threads)) return { error: 'no_threads', cursor };

  const count = res.count || res.threads.length;

  // count:0 — end of archive, but only trust it past the start (avoid transient 0)
  if (count === 0) {
    if (cursor > 0) { await env.CACHE.put(K_DONE, '1'); return { done: true, cursor }; }
    return { error: 'transient_empty_at_start', cursor };
  }

  const key = `emails/archive/batch-${String(cursor).padStart(7, '0')}.json`;
  await env.ARCHIVE.put(key, JSON.stringify(res.threads), { httpMetadata: { contentType: 'application/json' } });

  const next = (typeof res.next_start === 'number') ? res.next_start : cursor + count;
  const total = (parseInt((await env.CACHE.get(K_COUNT)) || '0', 10) || 0) + count;
  await env.CACHE.put(K_CURSOR, String(next));
  await env.CACHE.put(K_COUNT, String(total));
  if (res.done) await env.CACHE.put(K_DONE, '1');

  return { wrote: count, total, cursor, next, key, done: !!res.done };
}
