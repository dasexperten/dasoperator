import type { Env } from '../types';
import { classifyUgcLink, isSafePublicHttpUrl, type UgcLinkStatus } from './ugc-link-classifier.mjs';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 60;
const CONCURRENCY = 6;
const TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 5;
const BODY_BYTES = 32_768;

type DueLink = { id: string; content_url: string };
type CheckResult = {
  contentId: string;
  status: UgcLinkStatus;
  checkedAt: string;
  httpStatus: number | null;
  finalUrl: string | null;
  note: string;
  responseMs: number;
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

export async function runUgcLinkHealthBatch(env: Env, requestedLimit = DEFAULT_LIMIT): Promise<Record<string, unknown>> {
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(requestedLimit || DEFAULT_LIMIT)));
  const due = await env.DB.prepare(
    `SELECT id, content_url FROM ugc_content
     WHERE content_url IS NOT NULL AND TRIM(content_url) <> ''
       AND (link_checked_at IS NULL OR datetime(link_checked_at) <= datetime('now', '-30 days'))
     ORDER BY link_checked_at IS NOT NULL ASC, datetime(link_checked_at) ASC, imported_at ASC, id ASC
     LIMIT ?1`
  ).bind(limit).all<DueLink>();
  const rows = due.results ?? [];
  const results: CheckResult[] = [];
  for (let offset = 0; offset < rows.length; offset += CONCURRENCY) {
    const group = await Promise.all(rows.slice(offset, offset + CONCURRENCY).map(inspectLink));
    for (const result of group) {
      await saveCheck(env, result);
      results.push(result);
    }
  }
  const counts = Object.fromEntries(['active', 'missing', 'restricted', 'unknown', 'invalid'].map((status) => [status, results.filter((r) => r.status === status).length]));
  return { selected: rows.length, checked: results.length, limit, counts, checked_at: new Date().toISOString() };
}
