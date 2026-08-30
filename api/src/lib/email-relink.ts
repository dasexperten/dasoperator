// =============================================================================
// email-relink — gives every archived letter its email_links row.
//
// Why this exists (Owner 2026-08-30, R1 "every box must reach the ERP"):
//
// Three addresses are routed by Cloudflare to a seat Worker, not to this one —
// sales@ -> lauda-commerce, asean@ -> tet-asean, build@ -> alessandro-build.
// Those Workers archive into the SAME R2 bucket and the SAME Inbox/<box>.json
// key space we do (fleet/shared/email-in.mjs), so the Emailer already lists
// their letters. What they do not write is D1: the shared seat handler touches
// no database at all. Those letters therefore had no counterparty attribution.
//
// The same gap opens on our own path whenever linkEmail throws — it swallows
// its own failure by design (email-link.ts), because losing the letter is worse
// than losing the link.
//
// So this is a sweeper, not a second ingest path. It reads what is already in
// R2, finds the letters D1 has never seen, and runs them through the one
// linkEmail that both directions already use. It creates no mail, moves no
// mail, and deletes nothing.
//
// Bounded on purpose: a cron tick has a CPU budget, and the backlog is finite.
// Whatever it does not reach this hour it reaches the next.
// =============================================================================

import type { Env } from '../types';
import { MAILBOX_REGISTRY } from './mailbox-registry';
import { linkEmail } from './email-link';

/** Index entry shape written by both writers — the fields we rely on. */
interface IndexEntry {
  key?: string;
  direction?: string;
  timestamp?: string;
  subject?: string;
  from?: string;
  to?: string | string[];
}

/** Ceiling per tick, across all boxes. Keeps one run inside the CPU budget. */
const MAX_PER_TICK = 150;

/** Newest letters matter most; an old unlinked letter can wait a tick. */
const NEWEST_FIRST = (a: IndexEntry, b: IndexEntry) =>
  (a.timestamp || '') < (b.timestamp || '') ? 1 : -1;

export interface RelinkResult {
  boxes: number;
  scanned: number;
  linked: number;
  skipped_no_key: number;
  errors: number;
  budget_exhausted: boolean;
}

/**
 * One sweep. Safe to run twice: linkEmail is keyed on mail_key UNIQUE and
 * refuses to touch a row a human has locked.
 */
export async function relinkUnlinked(env: Env, limit = MAX_PER_TICK): Promise<RelinkResult> {
  const out: RelinkResult = {
    boxes: 0, scanned: 0, linked: 0, skipped_no_key: 0, errors: 0, budget_exhausted: false,
  };
  if (!env.DB || !env.ARCHIVE) return out;

  // Only real mailboxes: the Owner's forward-only box never lands in R2, and a
  // box we do not list is a box the Emailer cannot show anyway.
  const addresses = MAILBOX_REGISTRY
    .filter((m) => m.inbound === 'worker')
    .map((m) => m.address.toLowerCase());

  for (const address of addresses) {
    if (out.linked >= limit) { out.budget_exhausted = true; break; }

    let entries: IndexEntry[];
    try {
      const obj = await env.ARCHIVE.get(`Inbox/${address}.json`);
      if (!obj) continue;
      const parsed = JSON.parse(await obj.text());
      if (!Array.isArray(parsed)) continue;
      entries = parsed as IndexEntry[];
    } catch {
      out.errors++;
      continue;
    }
    if (!entries.length) continue;
    out.boxes++;

    // One query per box, not per letter: the mailbox column is indexed
    // (idx_email_links_mailbox), so this is the cheap half of the sweep.
    const known = new Set<string>();
    try {
      const rows = await env.DB.prepare(
        'SELECT mail_key FROM email_links WHERE mailbox = ?1'
      ).bind(address).all<{ mail_key: string }>();
      for (const r of rows.results || []) known.add(r.mail_key);
    } catch {
      out.errors++;
      continue; // without the known set we would re-link the whole box
    }

    for (const e of [...entries].sort(NEWEST_FIRST)) {
      if (out.linked >= limit) { out.budget_exhausted = true; break; }
      if (!e.key) { out.skipped_no_key++; continue; }
      out.scanned++;
      if (known.has(e.key)) continue;

      // Seat records carry no `text` in the index; subject alone still feeds
      // reference matching, and the address match — the confident one — does
      // not need a body at all.
      try {
        await linkEmail(env, {
          mailKey: e.key,
          mailbox: address,
          direction: e.direction === 'sent' ? 'sent' : 'received',
          from: e.from,
          to: e.to,
          subject: e.subject,
        });
        out.linked++;
      } catch {
        out.errors++; // linkEmail swallows its own; this is belt and braces
      }
    }
  }

  console.log(JSON.stringify({ scope: 'email-relink', success: true, ...out }));
  return out;
}
