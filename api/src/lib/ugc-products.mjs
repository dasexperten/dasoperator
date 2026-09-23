export const UGC_PRODUCTS = {
  DE101: 'ETALON', DE105: 'SCHWARZ Brush', DE106: 'SENSITIV', DE107: 'MITTEL',
  DE111: 'WAXED MINT Floss', DE112: 'EXPANDING Floss', DE115: 'SCHWARZ Floss',
  DE116: 'KRAFT', DE117: 'ZERO', DE119: 'GROSSE', DE120: 'NANO MASSAGE',
  DE122: 'AKTIV', DE125: 'INTERDENTALS S', DE126: 'INTERDENTALS M',
  DE130: 'INTENSIV', DE131: '3D Brush', DE201: 'SCHWARZ Toothpaste',
  DE202: 'DETOX', DE203: 'GINGER FORCE', DE205: 'COCOCANNABIS', DE206: 'SYMBIOS',
  DE207: 'BUDDY MICROBIES', DE208: 'EVOLUTION Kids', DE209: 'THERMO 39°',
  DE210: 'INNOWEISS Toothpaste', DE310: 'INNOWEISS Mouthwash',
};

export function baseProductSku(value) {
  const match = /^DE(\d{3})/i.exec(String(value ?? '').trim());
  return match ? `DE${match[1]}` : null;
}

function packFactor(raw, sku) {
  const suffix = raw.slice(sku.length);
  if (/^A+$/.test(suffix)) return suffix.length;
  const numbered = /^A(\d+)$/.exec(suffix);
  return numbered ? Number(numbered[1]) : null;
}

export function identifyExplicitProducts(values) {
  const matches = new Map();
  const unknown = new Set();
  for (const value of values) {
    const raw = String(value ?? '').trim().toUpperCase();
    if (!raw) continue;
    const sku = baseProductSku(raw);
    const name = sku ? UGC_PRODUCTS[sku] : null;
    if (!sku || !name) { unknown.add(raw); continue; }
    if (!matches.has(sku)) matches.set(sku, { raw_code: raw, raw_offer_id: raw, sku, name, pack_factor: packFactor(raw, sku), source: 'explicit_import', confidence: 1 });
  }
  return { matches: Array.from(matches.values()), unknown_codes: Array.from(unknown) };
}

export function initialProductClassification(values, hasContentUrl) {
  const explicit = values.map((value) => String(value ?? '').trim()).filter(Boolean);
  const identified = identifyExplicitProducts(explicit);
  if (identified.matches.length) return { status: 'identified', source: 'explicit_import', confidence: 1, evidence: explicit.join(', ').slice(0, 500) };
  if (explicit.length) return { status: 'unknown', source: 'explicit_import', confidence: null, evidence: explicit.join(', ').slice(0, 500) };
  return { status: hasContentUrl ? 'queued' : 'unknown', source: null, confidence: null, evidence: null };
}
