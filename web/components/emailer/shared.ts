// =============================================================================
// Emailer Dark UI v3 — shared types/helpers for the dashboard, message and
// orders screens. Kept separate from cloudflare-inbox-view.tsx (the legacy
// list view stays untouched, reachable via "List view").
// =============================================================================

import type { MailboxIndexEntry } from '@/lib/api';

export type MailEntry = MailboxIndexEntry & { mailbox: string };

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch {
    return iso;
  }
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffMs = Date.now() - t;
  const hours = Math.floor(diffMs / (60 * 60 * 1000));
  if (hours < 1) return 'just now';
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function fmtAddressList(v?: string | string[]): string {
  if (!v) return '—';
  return Array.isArray(v) ? v.join(', ') : v;
}

// The correspondent = the counterparty on a message, never our own mailbox.
export function correspondent(e: { direction: 'sent' | 'received'; from?: string; to?: string | string[] }): string {
  const raw = e.direction === 'received' ? e.from : Array.isArray(e.to) ? e.to[0] : e.to;
  return (raw || '').trim();
}

// Bare lowercase address out of either `Name <a@b>` or `a@b` — the archive
// stores both forms for the same counterparty, so every grouping/matching
// must go through this.
export function emailAddr(raw: string): string {
  const m = raw.match(/<([^>]+)>/);
  return (m?.[1] ?? raw).trim().toLowerCase();
}

export function displayName(addr: string): string {
  if (!addr) return '—';
  const named = addr.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  if (named && named[1]?.trim()) return named[1].trim();
  const at = addr.indexOf('@');
  return at > 0 ? addr.slice(0, at) : addr;
}

// Stable warm colour per seed string (correspondent, mailbox local-part…).
export function dotColor(seed: string): string {
  const palette = ['#B23A2E', '#8A6D3B', '#4A6B57', '#5A5566', '#7A5230', '#3F5E6B'];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return palette[h % palette.length] as string;
}

// A mailbox is a system sender (notify./my. subdomain) vs a human-facing
// dasexperten.com apex address. Mirrors api/src/routes/email-state.ts.
export function isSystemMailbox(address: string): boolean {
  return address.includes('@notify.') || address.includes('@my.');
}

// Per-message origin: the tagged field wins; legacy untagged records fall
// back to their mailbox's nature (same rule the API applies server-side).
export function originOf(e: MailEntry): 'human' | 'auto' {
  return e.origin ?? (isSystemMailbox(e.mailbox) ? 'auto' : 'human');
}

export interface CorrespondentGroup {
  address: string;
  name: string;
  entries: MailEntry[];
  latest: MailEntry;
}

// Groups entries by counterparty address, newest-first within each group,
// groups themselves sorted by their most recent activity.
export function groupByCorrespondent(entries: MailEntry[]): CorrespondentGroup[] {
  const byAddr = new Map<string, MailEntry[]>();
  for (const e of entries) {
    const addr = emailAddr(correspondent(e));
    if (!addr) continue;
    if (!byAddr.has(addr)) byAddr.set(addr, []);
    byAddr.get(addr)!.push(e);
  }
  const groups: CorrespondentGroup[] = [];
  for (const [address, list] of Array.from(byAddr.entries())) {
    list.sort((a: MailEntry, b: MailEntry) => (a.timestamp < b.timestamp ? 1 : -1));
    const latest = list[0];
    if (!latest) continue;
    groups.push({ address, name: displayName(correspondent(latest)), entries: list, latest });
  }
  groups.sort((a, b) => (a.latest.timestamp < b.latest.timestamp ? 1 : -1));
  return groups;
}

export type Period = 'today' | 'yesterday' | 'week' | 'all';

export function withinPeriod(iso: string, period: Period): boolean {
  if (period === 'all') return true;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 24 * 60 * 60 * 1000;
  if (period === 'today') return t >= startOfToday;
  if (period === 'yesterday') return t >= startOfToday - DAY && t < startOfToday;
  if (period === 'week') return t >= startOfToday - 7 * DAY;
  return true;
}
