// Offline, idempotent reconciliation plan. No credentials or bank requisites.
// Inputs: minimized Google Sheet rows and a live UGC creator/profile snapshot.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { identifySourceProductNames } from '../api/src/lib/ugc-source-records.mjs';

const [sourceFile, extraProductFile, snapshotFile, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error('Usage: node tools/plan-ugc-source-backfill.mjs sources.json extra-products.json live-snapshot.json output.json');
const source = JSON.parse(readFileSync(sourceFile, 'utf8'));
const extra = JSON.parse(readFileSync(extraProductFile, 'utf8'));
const [, profiles] = JSON.parse(readFileSync(snapshotFile, 'utf8'));
function normalize(value) {
  let text = String(value ?? '').trim().toLowerCase();
  if (/^https?:\/\//.test(text)) {
    try { text = new URL(text).pathname.split('/').filter(Boolean)[0] ?? ''; } catch { return ''; }
  }
  return text.replace(/^@+/, '').replace(/\/$/, '');
}
function platform(value) {
  const text = String(value ?? '').toLowerCase();
  if (text.includes('instagram')) return 'instagram';
  if (/tik.?tok/.test(text)) return 'tiktok';
  if (text.includes('telegram')) return 'telegram';
  if (text.includes('youtube')) return 'youtube';
  if (text === 'vk') return 'vk';
  return 'other';
}
const byHandle = new Map();
for (const profile of profiles) {
  const list = byHandle.get(profile.normalized_handle) ?? [];
  list.push(profile); byHandle.set(profile.normalized_handle, list);
}
const records = [];
const skipped = { product_unmatched: 0, product_ambiguous_profile: 0, product_without_sku: 0, payment_unmatched: 0, payment_ambiguous_profile: 0, payment_invalid_amount: 0, payment_source_error: 0 };
function record(doc, row, profile, kind, fields) {
  const key = [doc.id, doc.sheet, row.row, kind, profile.creator_id].join('|');
  records.push({ id: `ugs_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`, creator_id: profile.creator_id, creator_platform_id: profile.id, kind, source_document: doc.id, source_sheet: doc.sheet, source_row: row.row, ...fields });
}
for (const doc of [source.product_source, extra]) {
  for (const row of doc.rows.filter((row) => row.products)) {
    const candidates = byHandle.get(normalize(row.handle)) ?? [];
    const exact = candidates.filter((profile) => profile.platform === platform(row.platform));
    if (!candidates.length) { skipped.product_unmatched++; continue; }
    if (exact.length !== 1) { skipped.product_ambiguous_profile++; continue; }
    const codes = identifySourceProductNames(row.products);
    if (!codes.length) skipped.product_without_sku++;
    record(doc, row, exact[0], 'product_reference', { source_text: row.products, product_codes: JSON.stringify(codes), content_url: row.content_url || null });
  }
}
for (const row of source.payment_source.rows) {
  if ((source.payment_source.excluded_rows ?? []).some((item) => item.row === row.row)) { skipped.payment_source_error++; continue; }
  const candidates = byHandle.get(normalize(row.handle)) ?? [];
  const instagram = candidates.filter((profile) => profile.platform === 'instagram');
  const profile = instagram.length === 1 ? instagram[0] : candidates.length === 1 ? candidates[0] : null;
  if (!candidates.length) { skipped.payment_unmatched++; continue; }
  if (!profile) { skipped.payment_ambiguous_profile++; continue; }
  const rub = String(row.amount_rub).replace(/\s/g, '').replace(',', '.');
  const minor = Math.round(Number(rub) * 100);
  if (!/^\d+(?:\.\d{1,2})?$/.test(rub) || !Number.isSafeInteger(minor) || minor < 0) { skipped.payment_invalid_amount++; continue; }
  record(source.payment_source, row, profile, 'payment_register', { source_text: String(row.amount_rub), source_flag: row.source_flag, amount_minor: minor, currency: 'RUB' });
}
const summary = { records: records.length, product_profiles: new Set(records.filter((r) => r.kind === 'product_reference' && JSON.parse(r.product_codes).length).map((r) => r.creator_platform_id)).size, payment_accounts: new Set(records.filter((r) => r.kind === 'payment_register').map((r) => r.creator_id)).size, payment_rows: records.filter((r) => r.kind === 'payment_register').length, skipped };
writeFileSync(outputFile, JSON.stringify({ summary, records }, null, 2) + '\n');
console.log(JSON.stringify(summary));
