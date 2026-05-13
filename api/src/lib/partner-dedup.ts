// ────────────────────────────────────────────────────────────────────────────
// Partner dedup library — single source of truth for "should this become a
// new partners row, and if so what id?". Replaces the previous pattern of
// every ingestion path generating its own prt_${randomUUID} regardless of
// whether the same real-world counterparty was already in the table.
//
// Added 2026-05-13 after the Accuvat/Modulbank duplicate incident, in which
// 4 Accuvat rows and 1 Modulbank row were created within a 2-minute window
// from different ingestion sources (bank webhook + inbox invoice confirm).
//
// Used by:
//   • api/src/lib/bank-auto-match.ts   (bank webhook → outgoing service tx)
//   • api/src/routes/inbox.ts          (parsed invoice → "save vendor")
//   • api/src/routes/inbox-banking.ts  (manual assign-partner UI)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Lowercase, strip common legal-form noise words and punctuation, collapse
 * whitespace. Aggressive enough that "Accuvat LLC", "Accuvat Chartered
 * Accounting and Bookkeeping" and "ACCUVAT ACCOUNTING & BOOK KEEPING" all
 * collapse to the same token. Tolerates ASCII and Cyrillic.
 */
export function normalisePartnerName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(llc|ооо|ltd\.?|co\.?\s*,?\s*ltd\.?|gmbh|inc\.?|jsc|ао|оао|зао|пао|акб|кб|cb|chartered|accounting|bookkeeping|book\s*keeping|trading|technology|filial|филиал|московский|moscow)\b/g, '')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Look up an existing live partner by name. Two-pass:
 *   1. Exact case-insensitive on trade_name OR legal_name.
 *   2. Normalised fuzzy across all live partners (table is small, ~80 rows).
 * Prefers crm_status='active' over leads, then oldest created_at.
 */
export async function findExistingPartnerByName(
  db: D1Database,
  name: string,
): Promise<{ id: string; kind: string | null } | null> {
  if (!name || name.trim().length < 3) return null;
  const norm = normalisePartnerName(name);
  if (norm.length < 3) return null;

  const exact = await db.prepare(`
    SELECT id, kind FROM partners
    WHERE (LOWER(TRIM(trade_name)) = ? OR LOWER(TRIM(legal_name)) = ?)
      AND (deleted_at IS NULL OR deleted_at = 0)
    ORDER BY CASE WHEN crm_status='active' THEN 0 ELSE 1 END, created_at ASC
    LIMIT 1
  `).bind(name.trim().toLowerCase(), name.trim().toLowerCase())
    .first<{ id: string; kind: string | null }>();
  if (exact) return exact;

  const all = await db.prepare(`
    SELECT id, kind, trade_name, legal_name FROM partners
    WHERE deleted_at IS NULL OR deleted_at = 0
  `).all<{ id: string; kind: string | null; trade_name: string; legal_name: string | null }>();
  for (const p of (all.results ?? [])) {
    if (normalisePartnerName(p.trade_name) === norm) return { id: p.id, kind: p.kind };
    if (p.legal_name && normalisePartnerName(p.legal_name) === norm) return { id: p.id, kind: p.kind };
  }
  return null;
}

/**
 * Is this name actually a bank from bank_providers? Used to reject
 * payment-routing artefacts that the LLM parser misclassified as the
 * vendor of an invoice (the issuing bank often appears in the "pay to"
 * block of foreign invoices). Also catches bank self-references in
 * webhook contragent_name.
 */
export async function isBankProviderName(
  db: D1Database,
  name: string,
): Promise<boolean> {
  if (!name) return false;
  const lower = name.toLowerCase().trim();

  const banks = await db.prepare(`
    SELECT name, bank_legal_name, bank_legal_name_ru FROM bank_providers
    WHERE is_active = 1 AND (deleted_at IS NULL OR deleted_at = 0)
  `).all<{ name: string; bank_legal_name: string | null; bank_legal_name_ru: string | null }>();

  const stripLegal = (s: string) =>
    s.replace(/^(оао|ао|зао|пао|ооо|jsc|llc|cb|кб|акб)\s+/i, '').replace(/^"|"$/g, '').trim();

  for (const b of (banks.results ?? [])) {
    for (const cand of [b.name, b.bank_legal_name, b.bank_legal_name_ru].filter(Boolean) as string[]) {
      const cLower = cand.toLowerCase();
      if (lower.includes(cLower) || cLower.includes(lower)) return true;
      const a = stripLegal(lower), c = stripLegal(cLower);
      if (a && c && (a.includes(c) || c.includes(a))) return true;
    }
  }
  return false;
}

/**
 * Generate a human-readable partner id from trade_name.
 * "Accuvat Accounting & Book Keeping" → "accuvat_accounting_book_keeping"
 * On collision, appends _2, _3, … then random suffix.
 *
 * Replaces opaque `prt_draft_${uuid}`, `prt_inbox_${uuid}` and
 * `prt_${uuid16}` patterns that left rows like prt_draft_45afad91 in
 * logs and SQL queries.
 */
export async function generateReadablePartnerId(
  db: D1Database,
  tradeName: string,
): Promise<string> {
  const base = (tradeName || 'partner')
    .toLowerCase()
    .replace(/[^a-z0-9а-я]+/gi, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 40)
    || 'partner';

  const exists = await db.prepare('SELECT id FROM partners WHERE id = ?').bind(base).first();
  if (!exists) return base;

  for (let i = 2; i < 100; i++) {
    const candidate = `${base}_${i}`;
    const taken = await db.prepare('SELECT id FROM partners WHERE id = ?').bind(candidate).first();
    if (!taken) return candidate;
  }
  return `${base}_${crypto.randomUUID().slice(0, 6)}`;
}
