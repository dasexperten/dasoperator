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
    [/\bCOCOCANNABIS\b/, 'DE205'], [/\b(?:THERMO|TERMO)\b/, 'DE209'],
    [/\bNANO\s+MASSAGE\b/, 'DE120'], [/\bMITTEL\b/, 'DE107'], [/\bINTENSIV\b/, 'DE130'],
    [/\bKRAFT\b/, 'DE116'], [/\bAKTIV\b/, 'DE122'], [/\bBIO\b/, 'DE123'], [/\bZUNGER\b/, 'DE114'],
    [/\bKINDER\s*3\s*\+/, 'DE108'], [/\bKINDER\s*1\s*\+/, 'DE118'],
    [/\bEVOLUTION\b/, 'DE208'], [/ВЕСЕЛЫЕ\s+МИКРОБЧИКИ/, 'DE207'], [/\bEXPANDING\b/, 'DE112'],
    [/\bI?NTERDENTALS?\s+(?:РАЗМЕР\s*)?[MМ](?![A-ZА-Я])/, 'DE126'], [/\bI?NTERDENTALS?\s+S\b/, 'DE125'],
  ]) if (pattern.test(text)) codes.add(sku);
  for (const part of text.split(/[,;\n]/)) {
    // Owner 2026-10-17: bare INNOWEISS (legacy InnoWeis) means paste 210.
    // An explicitly named/code-marked mouthwash remains 310.
    if (/\bINNOWEIS{1,2}\b/.test(part)) {
      if (/ОПОЛАСК|MOUTHWASH|\bRINSE\b|\bDE310\b/.test(part)) codes.add('DE310');
      else if (!codes.has('DE310') || /ПАСТА|TOOTHPASTE/.test(part)) codes.add('DE210');
    }
    if (!/SCHWARZ/.test(part)) continue;
    if (/ПАСТА|TOOTHPASTE/.test(part)) codes.add('DE201');
    if (/ЩЕТК|BRUSH/.test(part)) codes.add('DE105');
    if (/НИТЬ|FLOSS/.test(part)) codes.add('DE115');
  }
  return identifyExplicitProducts([...codes]).matches.map((p) => p.sku);
}

export function sourceProductLabels(value, codes = []) {
  const text = String(value ?? '').toUpperCase();
  return [
    [/INNOWEIS{1,2}/, 'INNOWEISS', ['DE210', 'DE310']],
    [/SCHWAR[T]?Z/, 'SCHWARZ', ['DE201', 'DE105', 'DE115']],
  ].filter(([pattern, , related]) => pattern.test(text) && !related.some((sku) => codes.includes(sku)))
    .map(([, name]) => ({ name }));
}

export function publicationProductLabels(evidence) {
  try {
    const parsed = JSON.parse(evidence ?? '{}');
    return Array.isArray(parsed.labels) ? parsed.labels.filter((label) => ['INNOWEISS', 'SCHWARZ'].includes(label?.name)) : [];
  } catch { return []; }
}

export function payoutProductRecords(payouts) {
  return payouts.filter((p) => p.creator_platform_id && p.product).map((p) => ({
    creator_id: p.creator_id, creator_platform_id: p.creator_platform_id,
    kind: 'product_reference', source_document: `ugc_payout:${p.id}`,
    source_sheet: 'product', source_row: 0, source_text: p.product,
    product_codes: JSON.stringify(identifySourceProductNames(p.product)),
  }));
}

export function sourceRecordIndex(rows) {
  const payments = new Map();
  const paymentSources = new Map();
  const products = new Map();
  const productLabels = new Map();
  const resolvedAtUrl = new Map();
  const urlKey = (profile, value) => {
    try { const u = new URL(value); const media = /instagram\.com$/.test(u.hostname) ? /^\/(?:p|reel|reels)\/([^/]+)/.exec(u.pathname)?.[1] : null; return `${profile}:${media ?? `${u.hostname}${u.pathname.replace(/\/$/, '')}`}`; } catch { return null; }
  };
  for (const row of rows) {
    if (row.kind !== 'product_reference' || !row.creator_platform_id) continue;
    const key = urlKey(row.creator_platform_id, row.content_url);
    if (!key) continue;
    try {
      const codes = JSON.parse(row.product_codes ?? '[]');
      if (Array.isArray(codes)) resolvedAtUrl.set(key, [...(resolvedAtUrl.get(key) ?? []), ...identifyExplicitProducts(codes).matches.map((p) => p.sku)]);
    } catch { /* malformed source cannot resolve a family */ }
  }
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
        if (!list.some((p) => p.sku === match.sku)) list.push({ ...match, source: String(row.source_document).startsWith('ugc_payout:') ? 'payout_record' : String(row.source_document).startsWith('instagram:') ? 'metadata_text' : 'blogger_database', evidence });
      }
      products.set(row.creator_platform_id, list);
      const labels = productLabels.get(row.creator_platform_id) ?? [];
      for (const label of sourceProductLabels(row.source_text, [...codes, ...(resolvedAtUrl.get(urlKey(row.creator_platform_id, row.content_url)) ?? [])])) {
        if (!labels.some((item) => item.name === label.name)) labels.push({ ...label, evidence });
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
