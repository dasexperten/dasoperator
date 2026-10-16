// Publication classification uses only the exact original workbook row AND URL.
// An account's other orders/posts are never evidence for this publication.
import { readFileSync, writeFileSync } from 'node:fs';
import { identifyExplicitProducts } from '../api/src/lib/ugc-products.mjs';
import { identifySourceProductNames, sourceProductLabels } from '../api/src/lib/ugc-source-records.mjs';

function urlKey(value) {
  try { const u = new URL(value); return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}`; } catch { return null; }
}
function codes(value) {
  try { const parsed = JSON.parse(value ?? '[]'); return Array.isArray(parsed) ? parsed.map(String) : []; } catch { return []; }
}
export function planPublicationProducts(source, content, sourceRecords) {
  const rows = new Map(source.sheets.flatMap((sheet) => sheet.rows.map((row) => [`${sheet.sheet}:${row.row}`, row])));
  const references = new Map(sourceRecords.filter((r) => r.kind === 'product_reference').map((r) => [`${r.source_sheet}:${r.source_row}`, r]));
  const updates = []; const issues = [];
  for (const item of content) {
    if (item.source_workbook !== 'Blooger Database.xlsx') continue;
    const key = `${item.source_sheet}:${item.source_row}`;
    const row = rows.get(key); const reference = references.get(key);
    if (!row) continue;
    const rowUrl = urlKey(row.url); const contentUrl = urlKey(item.content_url);
    if (!rowUrl || rowUrl !== contentUrl) {
      if (reference) issues.push({ id: item.id, reason: 'url_mismatch', sheet: item.source_sheet, row: item.source_row });
      continue;
    }
    if (reference && (reference.creator_id !== item.creator_id || reference.creator_platform_id !== item.creator_platform_id)) {
      issues.push({ id: item.id, reason: 'identity_mismatch', sheet: item.source_sheet, row: item.source_row }); continue;
    }
    if (item.product_source && !['explicit_import'].includes(item.product_source)) continue;
    const raw = codes(item.product_codes);
    const combined = [...new Set([...raw, ...codes(reference?.product_codes), ...identifySourceProductNames(row.product_text)])];
    const identified = identifyExplicitProducts(combined).matches;
    const labels = sourceProductLabels(row.product_text, identified.map((p) => p.sku));
    if (!identified.length && !labels.length) continue;
    const evidence = JSON.stringify({ source_document: source.source_document, source_sheet: item.source_sheet, source_row: item.source_row, content_url: item.content_url, source_text: reference?.source_text ?? row.product_text ?? raw.join(', '), labels });
    updates.push({ id: item.id, creator_platform_id: item.creator_platform_id, content_url: item.content_url, product_codes: JSON.stringify(combined), product_status: identified.length ? 'identified' : 'unknown', product_source: 'explicit_import', product_confidence: identified.length ? 1 : null, product_evidence: evidence });
  }
  return { summary: { updates: updates.length, identified: updates.filter((r) => r.product_status === 'identified').length, family_only: updates.filter((r) => r.product_status === 'unknown').length, newly_identified: updates.filter((r) => r.product_status === 'identified' && content.find((c) => c.id === r.id)?.product_status !== 'identified').length, issues: issues.length }, updates, issues };
}
if (process.argv[1]?.endsWith('/plan-ugc-publication-products.mjs')) {
  const [source, content, references, output] = process.argv.slice(2);
  const result = planPublicationProducts(JSON.parse(readFileSync(source)), JSON.parse(readFileSync(content)), JSON.parse(readFileSync(references)).records);
  writeFileSync(output, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result.summary));
}
