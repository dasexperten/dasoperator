// Full original Blooger Database audit. Never reads or exports payment requisites.
// The native workbook's blank A cells continue the previous creator, exactly as
// in its original ERP importer. Money comes only from Sheet1 E (sum), never D.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { identifyExplicitProducts } from '../api/src/lib/ugc-products.mjs';
import { identifySourceProductNames } from '../api/src/lib/ugc-source-records.mjs';

export function workbookAmountMinor(value) {
  if (value == null || String(value).trim() === '') return null;
  let text = String(value).replace(/\s|₽|руб\.?|RUB/gi, '');
  if (text.includes('+')) {
    const terms = text.split('+').map(workbookAmountMinor);
    return terms.length > 1 && terms.every((term) => term != null) ? terms.reduce((sum, term) => sum + term, 0) : null;
  }
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(text)) text = text.replaceAll(',', '');
  else if (/^\d+,\d{1,2}$/.test(text)) text = text.replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
  const minor = Math.round(Number(text) * 100);
  return Number.isSafeInteger(minor) && minor >= 0 ? minor : null;
}

export function planWorkbook(source, snapshot) {
  const profiles = snapshot[1];
  const byHandle = new Map();
  for (const profile of profiles) {
    const list = byHandle.get(profile.normalized_handle) ?? [];
    list.push(profile); byHandle.set(profile.normalized_handle, list);
  }
  const records = []; const issues = []; const sheetCounts = [];
  function add(row, sheet, profile, kind, fields) {
    const key = [source.source_document, sheet, row.row, kind, profile.creator_id].join('|');
    records.push({ id: `ugs_${createHash('sha256').update(key).digest('hex').slice(0, 24)}`, creator_id: profile.creator_id, creator_platform_id: profile.id, kind, source_document: source.source_document, source_sheet: sheet, source_row: row.row, ...fields });
  }
  for (const sheet of source.sheets) {
    let handle = sheet.sheet === 'Sheet1' ? String(sheet.rows[0]?.handle ?? '') : '';
    let inheritedPlatform = 'other';
    let amountRows = 0; let productRows = 0;
    for (const row of sheet.rows.slice(1)) {
      if (row.handle) handle = String(row.handle);
      const override = (source.verified_handles ?? []).find((item) => item.sheet === sheet.sheet && item.row === row.row);
      const normalized = String(override?.handle ?? handle).trim().toLowerCase().replace(/^@+/, '').replace(/\s+/g, '');
      // Reels and misplaced product names in A are data errors, not account ids.
      const validHandle = /^[a-z0-9_.]+$/.test(normalized) && !['reel', 'reels', 'p'].includes(normalized);
      const platformRaw = String(row.platform ?? '').toLowerCase();
      const platform = sheet.sheet === 'Sheet1' ? 'instagram' : platformRaw.includes('instagram') ? 'instagram' : /tik.?tok/.test(platformRaw) ? 'tiktok' : platformRaw.includes('telegram') ? 'telegram' : platformRaw.includes('youtube') ? 'youtube' : platformRaw === 'vk' ? 'vk' : 'other';
      inheritedPlatform = platform;
      const candidates = validHandle ? (byHandle.get(normalized) ?? []).filter((profile) => profile.platform === inheritedPlatform) : [];
      const profile = candidates.length === 1 ? candidates[0] : null;
      const hasAmount = row.amount != null && String(row.amount).trim() !== '';
      const rawCodes = (row.products ?? []).filter((value) => value != null && String(value).trim() && String(value) !== '0').map((value) => /^\d{3}[A-Z]*$/i.test(String(value)) ? `DE${value}` : String(value).toUpperCase());
      const explicit = identifyExplicitProducts(rawCodes);
      const names = String(row.product_text ?? '').trim();
      const codes = [...new Set([...explicit.matches.map((product) => product.sku), ...identifySourceProductNames(names)])];
      const hasProduct = codes.length > 0 || Boolean(names);
      if (hasAmount) amountRows++;
      if (hasProduct) productRows++;
      if (!profile) {
        if (hasAmount || hasProduct) issues.push({ sheet: sheet.sheet, row: row.row, reason: !validHandle ? 'invalid_handle_cell' : candidates.length > 1 ? 'ambiguous_profile' : 'unmatched_profile', amount_present: hasAmount, product_present: hasProduct, content_url: row.url || null });
        continue;
      }
      if (hasAmount) {
        const amount = workbookAmountMinor(row.amount);
        if (amount == null) issues.push({ sheet: sheet.sheet, row: row.row, reason: 'unparsed_amount' });
        else add(row, sheet.sheet, profile, 'payment_register', { source_text: String(row.amount), amount_minor: amount, currency: 'RUB', content_url: row.url || null });
      }
      if (hasProduct) add(row, sheet.sheet, profile, 'product_reference', { source_text: [rawCodes.join(', '), names].filter(Boolean).join(' | '), product_codes: JSON.stringify(codes), content_url: row.url || null });
      if (explicit.unknown_codes.length) issues.push({ sheet: sheet.sheet, row: row.row, reason: 'unknown_product_codes', codes: explicit.unknown_codes });
    }
    sheetCounts.push({ sheet: sheet.sheet, scanned_rows: sheet.rows.length, amount_rows: amountRows, product_rows: productRows });
  }
  return { summary: { sheets: sheetCounts, records: records.length, payment_rows: records.filter((r) => r.kind === 'payment_register').length, payment_accounts: new Set(records.filter((r) => r.kind === 'payment_register').map((r) => r.creator_id)).size, product_profiles: new Set(records.filter((r) => r.kind === 'product_reference').map((r) => r.creator_platform_id)).size, issues: issues.length }, records, issues };
}

if (process.argv[1]?.endsWith('/plan-ugc-workbook-backfill.mjs')) {
  const [input, snapshot, output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node tools/plan-ugc-workbook-backfill.mjs source.json snapshot.json plan.json');
  const plan = planWorkbook(JSON.parse(readFileSync(input, 'utf8')), JSON.parse(readFileSync(snapshot, 'utf8')));
  writeFileSync(output, JSON.stringify(plan, null, 2) + '\n');
  console.log(JSON.stringify(plan.summary));
}
