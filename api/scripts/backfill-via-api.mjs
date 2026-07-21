/**
 * Backfill Emailer Sent via POST /api/email/archive-sent (no re-send).
 *
 * Usage (from api/):
 *   set EMAILER_SERVICE_SECRET=...
 *   node scripts/backfill-via-api.mjs path/to/SENT.md
 *
 * Optional:
 *   EMAILER_API_BASE=https://dasoperator-api.dasexperten.workers.dev
 */
import { readFileSync } from 'node:fs';

const sentPath = process.argv[2];
const secret = process.env.EMAILER_SERVICE_SECRET;
const base = (process.env.EMAILER_API_BASE || 'https://dasoperator-api.dasexperten.workers.dev').replace(/\/$/, '');

if (!sentPath) {
  console.error('Usage: EMAILER_SERVICE_SECRET=... node scripts/backfill-via-api.mjs <SENT.md>');
  process.exit(1);
}
if (!secret) {
  console.error('EMAILER_SERVICE_SECRET env required');
  process.exit(1);
}

const md = readFileSync(sentPath, 'utf8');
const items = [];
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
  const from = /julian/i.test(lead)
    ? 'Julian Farah <sales@dasexperten.com>'
    : 'Roberta Di Maria <sales@dasexperten.com>';
  const subject = /julian/i.test(lead)
    ? `Partnership / education — enzyme & probiotic oral care (${outlet})`
    : `Collaboration — enzyme & probiotic toothpaste education (${outlet})`;
  items.push({
    from,
    to: email,
    subject,
    text: `(Archived into Emailer Sent from Resend id ${id}. Original body was partnership/education outreach. Outlet: ${outlet}.)`,
    messageId: id,
    trigger: 'backfill-2026-07-21-batch50',
  });
}

console.log('parsed', items.length, '→', `${base}/api/email/archive-sent`);

const CHUNK = 15;
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

console.log(JSON.stringify({ success: true, archived, failed, errorSample: errors.slice(0, 5) }, null, 2));
process.exit(failed ? 2 : 0);
