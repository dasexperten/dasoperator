import type { Env } from '../types';
import { instagramPostFallback } from './ugc-apify.mjs';
import { refreshCadence, dueCadenceSql } from './ugc-refresh-cadence.mjs';
import { classifyUgcLink, isSafePublicHttpUrl, type UgcLinkStatus } from './ugc-link-classifier.mjs';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 60;
const CONCURRENCY = 3;
const TIMEOUT_MS = 8_000;
// Leave time for the final group of bounded Apify calls before the worker runtime limit.
const BATCH_TIME_BUDGET_MS = 4 * 60_000;
const MAX_REDIRECTS = 5;
const BODY_BYTES = 32_768;

type DueLink = { id: string; content_url: string; published_at?: string | null; link_checked_at?: string | null };
type CheckResult = {
  contentId: string;
  status: UgcLinkStatus;
  checkedAt: string;
  httpStatus: number | null;
  finalUrl: string | null;
  note: string;
  responseMs: number;
  pending?: boolean;
  metrics?: { views: number | null; likes: number | null; comments: number | null; observedAt: string; source: string };
};

function note(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}

async function readPrefix(response: Response): Promise<string> {
  if (!response.headers.get('content-type')?.toLowerCase().includes('text/html') || !response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < BODY_BYTES) {
      const part = await reader.read();
      if (part.done) break;
      const remaining = BODY_BYTES - size;
      const chunk = part.value.byteLength > remaining ? part.value.slice(0, remaining) : part.value;
      chunks.push(chunk);
      size += chunk.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

async function fetchWithSafeRedirects(rawUrl: string, signal: AbortSignal): Promise<{ response: Response; finalUrl: string }> {
  let current = new URL(rawUrl).href;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (!isSafePublicHttpUrl(current)) throw new Error('invalid_or_private_url');
    const response = await fetch(current, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.2',
        'User-Agent': 'DasExperten-UGC-LinkHealth/1.0 (+https://dasexperten.com)',
      },
    });
    if (response.status < 300 || response.status >= 400) return { response, finalUrl: current };
    const location = response.headers.get('location');
    if (!location) return { response, finalUrl: current };
    await response.body?.cancel().catch(() => undefined);
    current = new URL(location, current).href;
  }
  throw new Error('too_many_redirects');
}

async function inspectLink(row: DueLink): Promise<CheckResult> {
  const started = Date.now();
  const checkedAt = new Date().toISOString();
  const rawUrl = row.content_url.trim();
  if (!isSafePublicHttpUrl(rawUrl)) {
    return { contentId: row.id, status: 'invalid', checkedAt, httpStatus: null, finalUrl: null, note: 'Invalid or non-public HTTP URL', responseMs: Date.now() - started };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const { response, finalUrl } = await fetchWithSafeRedirects(rawUrl, controller.signal);
    const body = await readPrefix(response);
    const status = classifyUgcLink(response.status, finalUrl, body);
    return {
      contentId: row.id,
      status,
      checkedAt,
      httpStatus: response.status,
      finalUrl,
      note: status === 'restricted'
        ? 'Login, challenge, rate limit or access restriction'
        : status === 'unknown' && response.status >= 200 && response.status < 400
          ? `Ambiguous unavailable page returned HTTP ${response.status}`
          : `HTTP ${response.status}`,
      responseMs: Date.now() - started,
    };
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason);
    const invalid = message === 'invalid_or_private_url';
    return {
      contentId: row.id,
      status: invalid ? 'invalid' : 'unknown',
      checkedAt,
      httpStatus: null,
      finalUrl: null,
      note: note(controller.signal.aborted ? 'Network timeout' : invalid ? 'Invalid or non-public redirect URL' : `Network error: ${message}`),
      responseMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function saveCheck(env: Env, result: CheckResult): Promise<void> {
  await env.DB.batch([
    ...(result.metrics ? [env.DB.prepare(`UPDATE ugc_content SET views=COALESCE(?1,views),likes=COALESCE(?2,likes),comments=COALESCE(?3,comments),metrics_checked_at=?4,metrics_source=?5,updated_at=?6 WHERE id=?7`).bind(result.metrics.views,result.metrics.likes,result.metrics.comments,result.metrics.observedAt,result.metrics.source,Date.now(),result.contentId)] : []),
    env.DB.prepare(
      `UPDATE ugc_content SET link_status = ?1, link_checked_at = ?2,
         link_http_status = ?3, link_final_url = ?4, link_check_note = ?5
       WHERE id = ?6`
    ).bind(result.status, result.checkedAt, result.httpStatus, result.finalUrl, result.note, result.contentId),
    env.DB.prepare(
      `INSERT INTO ugc_link_checks
         (id, content_id, checked_at, status, http_status, final_url, note, response_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
    ).bind(crypto.randomUUID(), result.contentId, result.checkedAt, result.status, result.httpStatus, result.finalUrl, result.note, result.responseMs),
  ]);
}

export async function runUgcLinkHealthBatch(env: Env, requestedLimit = DEFAULT_LIMIT, contentId?: string): Promise<Record<string, unknown>> {
  if (contentId !== undefined && !/^[A-Za-z0-9_-]{1,160}$/.test(contentId)) throw new Error('invalid_content_id');
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(requestedLimit || DEFAULT_LIMIT)));
  const due = await env.DB.prepare(
    `SELECT id, content_url, published_at, link_checked_at FROM ugc_content
     WHERE content_url IS NOT NULL AND TRIM(content_url) <> ''
       AND (?2 IS NULL OR id = ?2)
       AND (?2 IS NOT NULL OR ${dueCadenceSql('published_at','link_checked_at')} OR (content_url LIKE '%instagram.com/%' AND ${dueCadenceSql('published_at','metrics_checked_at')}))
     ORDER BY link_checked_at IS NOT NULL ASC, datetime(link_checked_at) ASC, imported_at ASC, id ASC
     LIMIT ?1`
  ).bind(limit, contentId ?? null).all<DueLink>();
  const rows = due.results ?? [];
  const results: CheckResult[] = [];
  const startedAt = Date.now();
  for (let offset = 0; offset < rows.length; offset += CONCURRENCY) {
    if (Date.now() - startedAt >= BATCH_TIME_BUDGET_MS) break;
    const group = await Promise.all(rows.slice(offset, offset + CONCURRENCY).map(inspectLink));
    for (const result of group) {
      const row = rows.find(row => row.id === result.contentId)!;
      const ig = /^(https?:\/\/)?(www\.)?instagram\.com\//i.test(row.content_url);
      if (result.status === 'restricted' || result.status === 'unknown' || (result.status === 'active' && ig)) {
        const fallback = await instagramPostFallback(env, { url: row.content_url, cacheForMs: refreshCadence({activityAt:row.published_at,checkedAt:row.link_checked_at,manual:Boolean(contentId)}).cacheForMs });
        if (fallback.status === 'pending' || fallback.status === 'budget_exhausted') {
          result.pending = true;
          if (result.status === 'active') await saveCheck(env, result);
          results.push(result);
          continue; // Missing metrics remain due; never discard a successful lightweight check.
        }
        if (fallback.status === 'ok') {
          result.status = 'active'; result.checkedAt = fallback.observedAt ?? result.checkedAt;
          result.finalUrl = fallback.url ?? result.finalUrl; result.note = 'Exact Instagram post observed by bounded Apify fallback';
          if ([fallback.views, fallback.likes, fallback.comments].some(v => v !== null && v !== undefined)) result.metrics = { views: fallback.views ?? result.metrics?.views ?? null, likes: fallback.likes ?? result.metrics?.likes ?? null, comments: fallback.comments ?? result.metrics?.comments ?? null, observedAt: fallback.observedAt ?? result.checkedAt, source: 'apify' };
        }
      }
      await saveCheck(env, result);
      results.push(result);
    }
  }
  const counts = Object.fromEntries(['active', 'missing', 'restricted', 'unknown', 'invalid'].map((status) => [status, results.filter((r) => r.status === status).length]));
  return { selected: rows.length, checked: results.filter(r => !r.pending).length, pending: results.filter(r => r.pending).length, deferred: rows.length - results.length, limit, counts, checked_at: new Date().toISOString() };
}
