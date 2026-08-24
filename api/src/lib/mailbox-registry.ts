// =============================================================================
// Mailbox registry — SSOT for /emailer navigation (Agents + Departments).
// Owner 2026-07-17:
//   · UI groups = Agents accordion + Departments accordion (NOT "pipes")
//   · dr.badalyan@ is Owner personal mail — never listed in ERP agent UI
//   · CF Email Routing: dr.badalyan@ → forward to dasexperten@gmail.com only
//   · All other listed addresses → Worker dasoperator-api → R2 Inbox/
// =============================================================================

export type MailboxKind = 'agent' | 'department' | 'system' | 'owner';

export interface MailboxDef {
  address: string;
  kind: MailboxKind;
  /** Agent slug (organizacia) — for avatars on CDN */
  slug?: string;
  /** Display name (agent full name or department label) */
  label: string;
  /** Short role / department description */
  role?: string;
  /** Show in /emailer left nav (Agents or Departments) */
  showInUi: boolean;
  /** Inbound path: worker archives to R2, or forward-only (Gmail) */
  inbound: 'worker' | 'forward_gmail' | 'none';
  /** Optional aliases that map into this mailbox folder */
  aliases?: string[];
}

const AVATAR_BASE = 'https://www.dasexperten.com/assets/agents';

/** Public avatar URL for a rostered agent slug. */
export function agentAvatarUrl(slug: string): string {
  return `${AVATAR_BASE}/${slug}.png`;
}

/**
 * Full registry. Order is stable for UI.
 * Owner (dr.badalyan) is present for routing docs only — showInUi: false.
 */
export const MAILBOX_REGISTRY: MailboxDef[] = [
  // ── Agents (named identities) ───────────────────────────────────────────
  { address: 'sales@dasexperten.com', kind: 'agent', slug: 'lauda-briana', label: 'Lauda Briana', role: 'Head of Commerce', showInUi: true, inbound: 'worker', aliases: ['lauda@dasexperten.com'] },
  { address: 'roberta@dasexperten.com', kind: 'agent', slug: 'roberta-di-maria', label: 'Roberta Di Maria', role: 'Head of Content', showInUi: true, inbound: 'worker' },
  { address: 'support@dasexperten.com', kind: 'agent', slug: 'tamara-haar', label: 'Tamara Haar', role: 'Customer Support', showInUi: true, inbound: 'worker' },
  { address: 'brand@dasexperten.com', kind: 'agent', slug: 'marika-nowicka', label: 'Marika Nowicka', role: 'Head of Brand', showInUi: true, inbound: 'worker', aliases: ['maria@dasexperten.com', 'marika@dasexperten.com'] },
  { address: 'legal@dasexperten.com', kind: 'agent', slug: 'valentina-korolyeva', label: 'Valentina Korolyeva', role: 'Head of Legal', showInUi: true, inbound: 'worker', aliases: ['valentina@dasexperten.com'] },
  { address: 'finance@dasexperten.com', kind: 'agent', slug: 'justina-timber', label: 'Justina Timber', role: 'Head of Finance', showInUi: true, inbound: 'worker', aliases: ['justina@dasexperten.com'] },
  { address: 'partnerships@dasexperten.com', kind: 'agent', slug: 'julian-farah', label: 'Julian Farah', role: 'GEO Specialist', showInUi: true, inbound: 'worker', aliases: ['julian@dasexperten.com'] },
  { address: 'hr@dasexperten.com', kind: 'agent', slug: 'lena-sergeeva', label: 'Lena Sergeeva', role: 'Central Executive Officer', showInUi: true, inbound: 'worker', aliases: ['lena@dasexperten.com'] },
  { address: 'vetrova@dasexperten.com', kind: 'agent', slug: 'alexandra-obnorskaya', label: 'Alexandra Obnorskaya', role: 'Marketplaces', showInUi: true, inbound: 'worker', aliases: ['alexandra@dasexperten.com'] },
  // CDN: mina-rutunya.png (+ alias mina.png). Canonical slug = mina-rutunya.
  // Owner 2026-08-14: sysadmin@ is the primary box; mina@ demoted to alias but
  // kept sending (see HUMAN_SENDERS in resend-human.ts - that set reads
  // m.address only, never aliases, so a demoted address loses From rights
  // unless it is listed explicitly).
  { address: 'sysadmin@dasexperten.com', kind: 'agent', slug: 'mina-rutunya', label: 'Mina', role: 'Sysadmin', showInUi: true, inbound: 'worker', aliases: ['mina@dasexperten.com'] },
  { address: 'logistics@dasexperten.com', kind: 'agent', slug: 'zina-pevtsova', label: 'Zina Pevtsova', role: 'Logistics', showInUi: true, inbound: 'worker', aliases: ['zina@dasexperten.com'] },
  { address: 'maya@dasexperten.com', kind: 'agent', slug: 'maya-krasochkina', label: 'Maya Krasochkina', role: 'Operations', showInUi: true, inbound: 'worker' },
  { address: 'ozon@dasexperten.com', kind: 'agent', slug: 'dasha-kozlovskaya', label: 'Dasha Kozlovskaya', role: 'Ozon Specialist', showInUi: true, inbound: 'worker', aliases: ['dasha@dasexperten.com'] },
  { address: 'wb@dasexperten.com', kind: 'agent', slug: 'arina-volkova', label: 'Arina Volkova', role: 'WB Specialist', showInUi: true, inbound: 'worker', aliases: ['arina@dasexperten.com'] },

  // ── Owner (NOT in Agents UI) ────────────────────────────────────────────
  {
    address: 'dr.badalyan@dasexperten.com',
    kind: 'owner',
    label: 'Dr. Badalyan (Owner)',
    role: 'Owner personal — read in Gmail only',
    showInUi: false,
    inbound: 'forward_gmail',
  },

  // ── Departments (functional mailboxes — not "pipes") ────────────────────
  { address: 'eurasia@dasexperten.com', kind: 'department', label: 'Eurasia', role: 'RU / CIS hub', showInUi: true, inbound: 'worker' },
  { address: 'emea@dasexperten.com', kind: 'department', label: 'EMEA', role: 'EN/DE/IT/ES/AR hub', showInUi: true, inbound: 'worker' },
  { address: 'asean@dasexperten.com', kind: 'department', label: 'ASEAN', role: 'SE Asia hub', showInUi: true, inbound: 'worker' },
  { address: 'marketing@dasexperten.com', kind: 'department', label: 'Marketing', role: 'UGC / brand collabs', showInUi: true, inbound: 'worker' },
  { address: 'hello@dasexperten.com', kind: 'department', label: 'Hello', role: 'Warm brand front', showInUi: true, inbound: 'worker' },
  { address: 'orders@dasexperten.com', kind: 'department', label: 'Orders', role: 'Order notifications', showInUi: true, inbound: 'worker' },
];

export const OWNER_GMAIL_FORWARD = 'dasexperten@gmail.com';
export const OWNER_PERSONAL_ADDRESS = 'dr.badalyan@dasexperten.com';

export function agentsForUi(): MailboxDef[] {
  return MAILBOX_REGISTRY.filter((m) => m.kind === 'agent' && m.showInUi);
}

export function departmentsForUi(): MailboxDef[] {
  return MAILBOX_REGISTRY.filter((m) => m.kind === 'department' && m.showInUi);
}

export function findMailbox(address: string): MailboxDef | undefined {
  const a = address.trim().toLowerCase();
  return MAILBOX_REGISTRY.find(
    (m) => m.address === a || (m.aliases || []).some((al) => al.toLowerCase() === a),
  );
}

/** True when inbound must not land in R2 (Owner Gmail-only path). */
export function isOwnerGmailOnly(address: string): boolean {
  const def = findMailbox(address);
  return def?.inbound === 'forward_gmail' || address.trim().toLowerCase() === OWNER_PERSONAL_ADDRESS;
}

function extractEmail(raw?: string): string {
  if (!raw) return '';
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim().toLowerCase();
}

/** Company mailbox — agents, departments, notify/my subdomains. Not Gmail. */
export function isHouseAddress(raw?: string): boolean {
  const a = extractEmail(raw);
  if (!a || !a.includes('@')) return false;
  return a.endsWith('@dasexperten.com') || a.endsWith('.dasexperten.com');
}

/** Letter is only agents/departments talking to each other — not shown in Emailer.
 *  Do not guess `to` from the mailbox: every inbound letter's mailbox is house,
 *  and that guess wiped the inbox. */
export function isAgentToAgentMail(e: {
  from?: string;
  to?: string | string[];
  mailbox?: string;
  direction?: string;
}): boolean {
  const from = extractEmail(e.from) || (e.direction === 'sent' ? extractEmail(e.mailbox) : '');
  const tos = (Array.isArray(e.to) ? e.to : e.to ? [e.to] : [])
    .map(extractEmail)
    .filter(Boolean);
  if (!from || !tos.length) return false;
  if (!isHouseAddress(from)) return false;
  return tos.every((addr) => isHouseAddress(addr));
}
