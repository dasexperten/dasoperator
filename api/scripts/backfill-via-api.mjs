/**
 * Backfill Emailer Sent via POST /api/email/archive-sent (no re-send).
 *
 * Hydrates **full text** from Resend GET /emails/{id} when RESEND_API_KEY is set.
 * Never stores the one-line stub as the body.
 * Attachments stay on Resend — only text/html are archived.
 *
 * Usage (from api/):
 *   set EMAILER_SERVICE_SECRET=...
 *   set RESEND_API_KEY=...   # required for full body hydrate
 *   node scripts/backfill-via-api.mjs path/to/SENT.md
 *
 * Optional:
 *   EMAILER_API_BASE=https://dasoperator-api.dasexperten.workers.dev
 */
import { readFileSync } from 'node:fs';

const sentPath = process.argv[2];
const secret = process.env.EMAILER_SERVICE_SECRET;
const resendKey = process.env.RESEND_API_KEY;
const base = (process.env.EMAILER_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev').replace(/\/$/, '');

if (!sentPath) {
  console.error('Usage: EMAILER_SERVICE_SECRET=... RESEND_API_KEY=... node scripts/backfill-via-api.mjs <SENT.md>');
  process.exit(1);
}
if (!secret) {
  console.error('EMAILER_SERVICE_SECRET env required');
  process.exit(1);
}
if (!resendKey) {
  console.error('RESEND_API_KEY env required (hydrate full body from Resend — no stubs)');
  process.exit(1);
}

async function fetchResendBody(id) {
  const res = await fetch(`https://api.resend.com/emails/${id}`, {
    headers: {
      Authorization: `Bearer ${resendKey}`,
      Accept: 'application/json',
      'User-Agent': 'dasoperator-backfill/1.0',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Resend ${id} HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

const md = readFileSync(sentPath, 'utf8');
const rows = [];
for (const line of md.split('\n')) {
  const m = line.match(
    /^\|\s*\d+\s*\|\s*([^|]+)\s*\|\s*([^\s|]+@[^\s|]+)\s*\|\s*([^|]+)\s*\|\s*`([^`]+)`\s*\|/,
  );
  if (!m) continue;
  const outlet = m[1].trim();
  const email = m[2].trim().toLowerCase();
  const lead = m[3].trim();
  const id = m[4].trim();
  if (id === 'FAIL' || email.includes('dasexperten@gmail')) continue;
  rows.push({ outlet, email, lead, id });
}

console.log('parsed', rows.length, 'rows — hydrating from Resend…');

const items = [];
const hydrateErrors = [];
for (const row of rows) {
  try {
    const j = await fetchResendBody(row.id);
    const text = (j.text || '').trim();
    const html = (j.html || '').trim();
    if (!text && !html) {
      hydrateErrors.push({ id: row.id, error: 'empty body from Resend' });
      continue;
    }
    const from =
      j.from ||
      (/julian/i.test(row.lead)
        ? 'Julian Farah <sales@dasexperten.com>'
        : 'Roberta Di Maria <sales@dasexperten.com>');
    items.push({
      from,
      to: Array.isArray(j.to) && j.to.length ? j.to : row.email,
      subject: j.subject || `Partnership / education (${row.outlet})`,
      text: text || '(see html)',
      ...(html ? { html } : {}),
      messageId: row.id,
      trigger: 'backfill-resend-hydrate',
    });
  } catch (e) {
    hydrateErrors.push({ id: row.id, error: e instanceof Error ? e.message : String(e) });
  }
}

console.log('hydrated', items.length, 'errors', hydrateErrors.length, '→', `${base}/api/email/archive-sent`);
if (hydrateErrors.length) console.error('hydrate sample', hydrateErrors.slice(0, 5));

const CHUNK = 10;
let archived = 0;
let failed = 0;
const errors = [];

for (let i = 0; i < items.length; i += CHUNK) {
  const chunk = items.slice(i, i + CHUNK);
  const res = await fetch(`${base}/api/email/archive-sent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Emailer-Service-Secret': secret,
    },
    body: JSON.stringify({ items: chunk }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.error('chunk', i, 'non-JSON', res.status, text.slice(0, 300));
    failed += chunk.length;
    continue;
  }
  if (!res.ok) {
    console.error('chunk', i, 'HTTP', res.status, json);
    failed += chunk.length;
    continue;
  }
  archived += json.archived || 0;
  failed += json.failed || 0;
  if (json.errors?.length) errors.push(...json.errors);
  console.log('chunk', i, '+', json.archived, 'fail', json.failed);
}

console.log(JSON.stringify({ success: true, archived, failed, hydrateErrors: hydrateErrors.length, errorSample: errors.slice(0, 5) }, null, 2));
process.exit(failed || hydrateErrors.length === rows.length ? 2 : 0);
