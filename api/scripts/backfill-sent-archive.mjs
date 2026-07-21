/**
 * Backfill Emailer Sent (R2 Inbox/<from>/sent/) from organizacia SENT markdown.
 * Does NOT re-send. Does NOT touch personal Gmail.
 *
 * Usage (from api/):
 *   node scripts/backfill-sent-archive.mjs path/to/SENT.md
 *
 * Requires wrangler auth + ARCHIVE bucket binding (self-learning).
 */
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const sentPath = process.argv[2];
if (!sentPath) {
  console.error('Usage: node scripts/backfill-sent-archive.mjs <SENT.md>');
  process.exit(1);
}

const md = readFileSync(sentPath, 'utf8');
// Parse table rows: | n | Outlet | email | lead | `resend-id` |
const rows = [];
for (const line of md.split('\n')) {
  const m = line.match(
    /^\|\s*\d+\s*\|\s*([^|]+)\s*\|\s*([^\s|]+@[^\s|]+)\s*\|\s*([^|]+)\s*\|\s*`([^`]+)`\s*\|/,
  );
  if (!m) continue;
  const [, outlet, email, lead, id] = m;
  if (id === 'FAIL' || email.includes('dasexperten@gmail')) continue;
  rows.push({
    outlet: outlet.trim(),
    email: email.trim().toLowerCase(),
    lead: lead.trim(),
    messageId: id.trim(),
  });
}

console.log('parsed', rows.length, 'sends');

const dir = mkdtempSync(join(tmpdir(), 'sent-backfill-'));
let n = 0;
const indexAdds = new Map(); // mailbox -> entries[]

for (const r of rows) {
  const fromAddr = 'sales@dasexperten.com';
  const from =
    r.lead === 'julian' || r.lead === 'julian-topup'
      ? `Julian Farah <${fromAddr}>`
      : r.lead === 'boss'
        ? `Roberta Di Maria <${fromAddr}>`
        : `Roberta Di Maria <${fromAddr}>`;
  const ts = new Date().toISOString();
  // stagger timestamps so sort order is stable
  const timestamp = new Date(Date.now() - (rows.length - n) * 1000).toISOString();
  const key = `Inbox/${fromAddr}/sent/${timestamp}-${randomUUID()}.json`;
  const record = {
    direction: 'sent',
    address: fromAddr,
    timestamp,
    from,
    to: [r.email],
    subject:
      r.lead === 'julian' || r.lead === 'julian-topup'
        ? `Partnership / education — enzyme & probiotic oral care (${r.outlet})`
        : `Collaboration — enzyme & probiotic toothpaste education (${r.outlet})`,
    text: `(Backfilled into Emailer Sent from Resend id ${r.messageId}. Original body was partnership/education outreach. Outlet: ${r.outlet}.)`,
    messageId: r.messageId,
    origin: 'human',
    trigger: 'backfill-2026-07-21-batch50',
  };
  const local = join(dir, `rec-${n}.json`);
  writeFileSync(local, JSON.stringify(record), 'utf8');
  // Remote R2 is the default; do NOT pass --remote (unknown flag on this wrangler).
  execSync(
    `npx wrangler r2 object put self-learning/${key} --file "${local}" --content-type application/json`,
    { stdio: 'inherit', cwd: process.cwd() },
  );
  if (!indexAdds.has(fromAddr)) indexAdds.set(fromAddr, []);
  indexAdds.get(fromAddr).push({
    key,
    direction: 'sent',
    timestamp,
    subject: record.subject,
    from,
    to: [r.email],
    messageId: r.messageId,
    origin: 'human',
    trigger: 'backfill-2026-07-21-batch50',
  });
  n++;
}

// Merge index files
for (const [addr, adds] of indexAdds) {
  const indexKey = `Inbox/${addr}.json`;
  const localGet = join(dir, `idx-get-${addr}.json`);
  let entries = [];
  try {
    execSync(
      `npx wrangler r2 object get self-learning/${indexKey} --file "${localGet}"`,
      { stdio: 'pipe', cwd: process.cwd() },
    );
    entries = JSON.parse(readFileSync(localGet, 'utf8'));
    if (!Array.isArray(entries)) entries = [];
  } catch {
    entries = [];
  }
  entries.push(...adds);
  const localPut = join(dir, `idx-put-${addr}.json`);
  writeFileSync(localPut, JSON.stringify(entries), 'utf8');
  execSync(
    `npx wrangler r2 object put self-learning/${indexKey} --file "${localPut}" --content-type application/json`,
    { stdio: 'inherit', cwd: process.cwd() },
  );
  console.log('index', addr, 'entries', entries.length);
}

console.log('BACKFILL_DONE', n);
