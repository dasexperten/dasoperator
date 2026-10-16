import { identifyExplicitProducts } from './ugc-products.mjs';

export const ORIGINAL_BLOGGER_DATABASE = '1U8tY23CA6kUfrybqmtkC_irUgDFSdJ326JyhnZ7FsIM';
export function paymentSource(document) {
  return document === ORIGINAL_BLOGGER_DATABASE
    ? { source_title: 'Blooger Database', amount_column: 'E', priority: 0 }
    : { source_title: document === '17FQ-ZBHVNl_R94tFd27Al_irYCedU78H9GoWbi8uK0c' ? 'Оплаты Консоль' : 'Реестр', amount_column: 'H', priority: 1 };
}

// Bare SCHWARZ is ambiguous (paste/brush/floss); preserve it without guessing.
// Legacy BIO/KINDER/ZUNGER identifiers verified in the live ERP catalogue.
export function identifySourceProductNames(value) {
  const text = String(value ?? '').toUpperCase().replaceAll('Ё', 'Е').replace(/SCHWARTZ/g, 'SCHWARZ').replace(/NANO-MASSAGE/g, 'NANO MASSAGE');
  const codes = new Set(text.match(/\bDE\d{3}\b/g) ?? []);
  for (const [pattern, sku] of [
    [/\bSYMBIOS\b/, 'DE206'], [/\bDETOX\b/, 'DE202'], [/\bGINGER\s+FORCE\b/, 'DE203'],
    [/\bCOCOCANNABIS\b/, 'DE205'], [/\bINNOWEIS{1,2}\b.*(?:ПАСТА|TOOTHPASTE)/, 'DE210'], [/\bTHERMO\b/, 'DE209'],
    [/\bNANO\s+MASSAGE\b/, 'DE120'], [/\bMITTEL\b/, 'DE107'], [/\bINTENSIV\b/, 'DE130'],
    [/\bKRAFT\b/, 'DE116'], [/\bAKTIV\b/, 'DE122'], [/\bBIO\b/, 'DE123'], [/\bZUNGER\b/, 'DE114'],
    [/\bKINDER\s*3\s*\+/, 'DE108'], [/\bKINDER\s*1\s*\+/, 'DE118'],
    [/\bEVOLUTION\b/, 'DE208'], [/ВЕСЕЛЫЕ\s+МИКРОБЧИКИ/, 'DE207'], [/\bEXPANDING\b/, 'DE112'],
    [/\bI?NTERDENTALS?\s+(?:РАЗМЕР\s*)?[MМ](?![A-ZА-Я])/, 'DE126'], [/\bI?NTERDENTALS?\s+S\b/, 'DE125'],
  ]) if (pattern.test(text)) codes.add(sku);
  for (const part of text.split(/[,;\n]/)) {
    if (!/SCHWARZ/.test(part)) continue;
    if (/ПАСТА|TOOTHPASTE/.test(part)) codes.add('DE201');
    if (/ЩЕТК|BRUSH/.test(part)) codes.add('DE105');
    if (/НИТЬ|FLOSS/.test(part)) codes.add('DE115');
  }
  return identifyExplicitProducts([...codes]).matches.map((p) => p.sku);
}

export function sourceRecordIndex(rows) {
  const payments = new Map();
  const paymentSources = new Map();
  const products = new Map();
  const productLabels = new Map();
  for (const row of rows) {
    const evidence = { source_document: row.source_document, source_sheet: row.source_sheet, source_row: row.source_row, source_text: row.source_text, content_url: row.content_url };
    if (row.kind === 'payment_register' && row.amount_minor != null && Number(row.amount_minor) >= 0) {
      const list = payments.get(row.creator_id) ?? [];
      list.push({ ...evidence, ...paymentSource(row.source_document), amount_minor: Number(row.amount_minor), currency: 'RUB' });
      payments.set(row.creator_id, list);
    }
    if (row.kind === 'product_reference' && row.creator_platform_id) {
      let codes = [];
      try { codes = JSON.parse(row.product_codes ?? '[]'); } catch { /* raw source text retained */ }
      if (!Array.isArray(codes)) codes = [];
      const list = products.get(row.creator_platform_id) ?? [];
      for (const match of identifyExplicitProducts(Array.isArray(codes) ? codes : []).matches) {
        if (!list.some((p) => p.sku === match.sku)) list.push({ ...match, source: 'blogger_database', evidence });
      }
      products.set(row.creator_platform_id, list);
      const labels = productLabels.get(row.creator_platform_id) ?? [];
      const text = String(row.source_text ?? '').toUpperCase();
      for (const [pattern, label, related] of [
        [/INNOWEIS{1,2}/, 'INNOWEISS', ['DE210', 'DE310']],
        [/SCHWAR[T]?Z/, 'SCHWARZ', ['DE201', 'DE105', 'DE115']],
      ]) {
        if (pattern.test(text) && !related.some((sku) => codes.includes(sku)) && !labels.some((item) => item.name === label)) labels.push({ name: label, evidence });
      }
      productLabels.set(row.creator_platform_id, labels);
    }
  }
  // These books can describe the same historical payments. Sum all rows WITHIN
  // the Owner's original database; never add a second book to that total.
  for (const [creatorId, records] of payments) {
    const groups = new Map();
    for (const row of records) {
      const list = groups.get(row.source_document) ?? [];
      list.push(row); groups.set(row.source_document, list);
    }
    const sources = [...groups.values()].sort((a, b) => a[0].priority - b[0].priority);
    paymentSources.set(creatorId, sources.map((records) => ({ source_document: records[0].source_document, source_title: records[0].source_title, records })));
    payments.set(creatorId, sources[0] ?? []);
  }
  return { payments, paymentSources, products, productLabels };
}
