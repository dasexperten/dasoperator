// =============================================================================
// GA4 Data API client (analyticsdata.googleapis.com/v1beta)
//
// Auth: service-account JWT (RS256) signed with WebCrypto, exchanged at the
// key's token_uri for a 1h Bearer token. The access token is cached in the
// CACHE KV namespace for 55 minutes so every request within the window skips
// the JWT dance entirely.
//
// Secrets (Worker secrets, never in code): GA4_PROPERTY_ID, GA4_SA_KEY
// (the full service-account JSON). Code reads env.* only.
// =============================================================================

import type { Env } from '../types';

const GA4_BASE = 'https://analyticsdata.googleapis.com/v1beta';
const GA4_ADMIN_BASE = 'https://analyticsadmin.googleapis.com/v1beta';
const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const TOKEN_CACHE_KEY = 'ga4:access_token';
const PROPERTY_TZ_CACHE_KEY = 'ga4:property_time_zone';
const TOKEN_TTL_SEC = 55 * 60; // Google issues 1h tokens; refresh 5 min early

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
}

// ----- base64url helpers (WebCrypto gives ArrayBuffers, JWT wants b64url) ----
function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const b64 = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf.buffer;
}

export function ga4Configured(env: Env): boolean {
  return Boolean(env.GA4_PROPERTY_ID && env.GA4_SA_KEY);
}

// =============================================================================
// Access token: KV-cached 55 min, otherwise sign JWT -> exchange at token_uri.
// =============================================================================
export async function getGa4AccessToken(env: Env): Promise<string> {
  try {
    const hit = await env.CACHE.get(TOKEN_CACHE_KEY);
    if (hit) return hit;
  } catch {
    // KV read failure — fall through to a fresh token
  }

  if (!env.GA4_SA_KEY) throw new Error('GA4_SA_KEY not configured');
  const sa = JSON.parse(env.GA4_SA_KEY) as ServiceAccountKey;

  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: GA4_SCOPE,
      aud: sa.token_uri,
      iat,
      exp: iat + 3600,
    })
  );
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${b64url(new Uint8Array(sig))}`;

  const res = await fetch(sa.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:
      `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}` +
      `&assertion=${jwt}`,
  });
  if (!res.ok) {
    throw new Error(`GA4 token exchange HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json<{ access_token: string; expires_in: number }>();

  try {
    await env.CACHE.put(TOKEN_CACHE_KEY, data.access_token, { expirationTtl: TOKEN_TTL_SEC });
  } catch {
    // cache-write failure never breaks the caller
  }
  return data.access_token;
}

// =============================================================================
// runReport wrapper
// =============================================================================
export interface Ga4Report {
  dimensionHeaders?: Array<{ name: string }>;
  metricHeaders?: Array<{ name: string; type?: string }>;
  rows?: Array<{
    dimensionValues?: Array<{ value: string }>;
    metricValues?: Array<{ value: string }>;
  }>;
  rowCount?: number;
}

export async function ga4RunReport(env: Env, body: Record<string, unknown>): Promise<Ga4Report> {
  if (!env.GA4_PROPERTY_ID) throw new Error('GA4_PROPERTY_ID not configured');
  const token = await getGa4AccessToken(env);
  const res = await fetch(`${GA4_BASE}/properties/${env.GA4_PROPERTY_ID}:runReport`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GA4 runReport HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Ga4Report;
}

// dateHourMinute is expressed in the GA4 property's time zone, not UTC. Read
// that setting from the owning Admin API instead of duplicating it in code.
export async function getGa4PropertyTimeZone(env: Env): Promise<string> {
  if (!env.GA4_PROPERTY_ID) throw new Error('GA4_PROPERTY_ID not configured');
  try {
    const hit = await env.CACHE.get(PROPERTY_TZ_CACHE_KEY);
    if (hit) return hit;
  } catch {
    // KV is an optimization; property metadata remains authoritative.
  }
  const token = await getGa4AccessToken(env);
  const res = await fetch(`${GA4_ADMIN_BASE}/properties/${env.GA4_PROPERTY_ID}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GA4 property metadata HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json<{ timeZone?: string }>();
  if (!data.timeZone) throw new Error('GA4 property metadata has no timeZone');
  try {
    await env.CACHE.put(PROPERTY_TZ_CACHE_KEY, data.timeZone, { expirationTtl: 86400 });
  } catch {
    // A cache-write failure does not invalidate the metadata response.
  }
  return data.timeZone;
}

// GA4 returns dates as "20260706" — normalize to "2026-07-06".
export function ga4Date(raw: string): string {
  if (/^\d{8}$/.test(raw)) return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  return raw;
}

export function metricNum(row: { metricValues?: Array<{ value: string }> }, idx: number): number {
  const v = parseFloat(row.metricValues?.[idx]?.value ?? '0');
  return Number.isFinite(v) ? v : 0;
}


// =============================================================================
// runRealtimeReport wrapper — separate endpoint (analyticsdata …:runRealtimeReport),
// same Bearer token as runReport. No date range (last ~30 min, GA4-managed window).
// =============================================================================
export async function ga4RunRealtimeReport(env: Env, body: Record<string, unknown>): Promise<Ga4Report> {
  if (!env.GA4_PROPERTY_ID) throw new Error('GA4_PROPERTY_ID not configured');
  const token = await getGa4AccessToken(env);
  const res = await fetch(`${GA4_BASE}/properties/${env.GA4_PROPERTY_ID}:runRealtimeReport`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`GA4 runRealtimeReport HTTP ${res.status}: ${await res.text()}`);
  }
  return (await res.json()) as Ga4Report;
}
