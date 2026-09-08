// =============================================================================
// MAIL HOLDS — the do-not-contact register, enforced in code.
//
// Mirror of organizacia `knowledge/mail-holds.md`. That file is the law; this
// one is the lock. The law was set on 2026-07-30 and broken on 2026-09-04 by a
// reply that went out to a held address, because the only thing standing
// between the seat and the send was memory. Memory is not a lock.
//
// A hold beats the frame test: an address here is not written to even when
// every other condition passes. It covers outbound and reply alike, and every
// header a recipient can sit in — to, cc, bcc. Inbound mail from a held
// address is still read, still archived, still reported. Only the answer stops.
//
// The hold is on the channel, not on the work: archiving a copy of a message
// somebody else sent is not writing to the contact, so `archive_only` records
// stay allowed. Only a live send is refused.
//
// Who adds and who lifts: the Owner, by editing this file and the law file
// together. An agent proposes; it does not set and does not lift.
// =============================================================================

export type MailHold = {
  /** The person or company, as the Owner names them. */
  contact: string;
  /** Exact addresses, lowercase. */
  addresses: string[];
  /** Whole domains, lowercase, matched on the part after the @. */
  domains: string[];
  setBy: string;
  /** ISO date the hold was set. */
  date: string;
  /** Shown verbatim in the refusal, so the caller sees the reason, not a code. */
  reason: string;
};

export const MAIL_HOLDS: readonly MailHold[] = [
  {
    contact: 'Ellen Wei — Guangzhou Honghui Daily Technology',
    addresses: ['hh0025@honghui88.com.cn'],
    domains: ['honghui88.com.cn'],
    setBy: 'Owner',
    date: '2026-07-30',
    reason:
      'Owner-only channel (Owner 2026-07-30, repeated 2026-09-08): «ей пишу только я». ' +
      'No agent sends, replies, follows up, or appears in cc. Anything you would say to ' +
      'this contact goes to the Owner in one line instead. Purchase order HHUI-26073001, ' +
      'freight, stock and landed-cost work on this supplier all continue — the hold is on ' +
      'the channel, not on the work.',
  },
];

/** Strip a display name: "Ellen Wei <hh0025@…>" → "hh0025@…". */
export function addrOf(raw: string): string {
  const m = /<([^>]+)>/.exec(raw || '');
  return (m?.[1] ?? raw ?? '').trim().toLowerCase();
}

/** The hold covering this address, or null. Matches the address or its domain. */
export function findMailHold(raw: string): MailHold | null {
  const addr = addrOf(raw);
  if (!addr) return null;
  const domain = addr.slice(addr.lastIndexOf('@') + 1);
  for (const hold of MAIL_HOLDS) {
    if (hold.addresses.includes(addr)) return hold;
    if (domain && hold.domains.some((d) => domain === d || domain.endsWith(`.${d}`))) return hold;
  }
  return null;
}

/** Every held recipient among the given headers, deduplicated by address. */
export function heldRecipients(
  ...lists: Array<string | string[] | undefined | null>
): Array<{ addr: string; hold: MailHold }> {
  const seen = new Set<string>();
  const hits: Array<{ addr: string; hold: MailHold }> = [];
  for (const list of lists) {
    if (!list) continue;
    for (const raw of Array.isArray(list) ? list : [list]) {
      const addr = addrOf(raw);
      if (!addr || seen.has(addr)) continue;
      const hold = findMailHold(addr);
      if (!hold) continue;
      seen.add(addr);
      hits.push({ addr, hold });
    }
  }
  return hits;
}

/** One refusal line per held recipient — the reason, not a code. */
export function mailHoldRefusal(hits: Array<{ addr: string; hold: MailHold }>): string {
  return hits
    .map(
      ({ addr, hold }) =>
        `${addr} is on mail hold — ${hold.contact}, set by ${hold.setBy} on ${hold.date}. ${hold.reason}`
    )
    .join(' | ');
}
