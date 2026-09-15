// =============================================================================
// Frontend mirror of api/src/lib/mailbox-registry.ts
// Keep labels/addresses in sync when adding agents or departments.
// Owner 2026-07-17: Agents + Departments (not "pipes"); no dr.badalyan in UI.
// =============================================================================

export type MailboxKind = 'agent' | 'department';

export interface UiMailbox {
  address: string;
  kind: MailboxKind;
  slug?: string;
  label: string;
  role?: string;
  /** Aliases that also belong to this folder (e.g. maria@ → marika@) */
  aliases?: string[];
}

// Same-origin first: files in web/public/agents/ (bundled with Pages deploy).
// CDN path was 404 on dasexperten.com (assets not live) → img onError → initials only.
// Keep CDN as documented SSOT publish target; emailer must not depend on a dead URL.
const AVATAR_BASE = '/agents';

export function agentAvatarUrl(slug: string): string {
  return `${AVATAR_BASE}/${slug}.png`;
}

/** Named agent mailboxes — always show avatar chip when present. */
export const AGENT_MAILBOXES: UiMailbox[] = [
  { address: 'sales@dasexperten.com', kind: 'agent', slug: 'lauda-briana', label: 'Lauda Briana', role: 'Head of Commerce', aliases: ['lauda@dasexperten.com', 'sales@my.dasexperten.com'] },
  { address: 'roberta@dasexperten.com', kind: 'agent', slug: 'roberta-di-maria', label: 'Roberta Di Maria', role: 'Head of Content' },
  { address: 'support@dasexperten.com', kind: 'agent', slug: 'tamara-haar', label: 'Tamara Haar', role: 'Customer Support', aliases: ['tamara@dasexperten.com'] },
  { address: 'brand@dasexperten.com', kind: 'agent', slug: 'marika-nowicka', label: 'Marika Nowicka', role: 'Head of Brand', aliases: ['maria@dasexperten.com', 'marika@dasexperten.com'] },
  { address: 'legal@dasexperten.com', kind: 'agent', slug: 'valentina-korolyeva', label: 'Valentina Korolyeva', role: 'Head of Legal', aliases: ['valentina@dasexperten.com'] },
  { address: 'finance@dasexperten.com', kind: 'agent', slug: 'justina-timber', label: 'Justina Timber', role: 'Head of Finance', aliases: ['justina@dasexperten.com'] },
  { address: 'geo@dasexperten.com', kind: 'agent', slug: 'julian-farah', label: 'Julian Farah', role: 'GEO Specialist', aliases: ['partnerships@dasexperten.com', 'julian@dasexperten.com'] },
  { address: 'hr@dasexperten.com', kind: 'agent', slug: 'lena-sergeeva', label: 'Lena Sergeeva', role: 'Central Executive Officer', aliases: ['lena@dasexperten.com'] },
  { address: 'vetrova@dasexperten.com', kind: 'agent', slug: 'alexandra-obnorskaya', label: 'Alexandra Obnorskaya', role: 'Marketplaces', aliases: ['alexandra@dasexperten.com'] },
  { address: 'sysadmin@dasexperten.com', kind: 'agent', slug: 'mina-rutunya', label: 'Mina', role: 'Sysadmin', aliases: ['mina@dasexperten.com', 'admin@dasexperten.com'] },
  { address: 'logistics@dasexperten.com', kind: 'agent', slug: 'zina-pevtsova', label: 'Zina Pevtsova', role: 'Logistics', aliases: ['zina@dasexperten.com'] },
  { address: 'maya@dasexperten.com', kind: 'agent', slug: 'maya-krasochkina', label: 'Maya Krasochkina', role: 'Operations', aliases: ['tech@dasexperten.com'] },
  { address: 'ozon@dasexperten.com', kind: 'agent', slug: 'dasha-kozlovskaya', label: 'Dasha Kozlovskaya', role: 'Ozon Specialist', aliases: ['dasha@dasexperten.com'] },
  { address: 'wb@dasexperten.com', kind: 'agent', slug: 'arina-volkova', label: 'Arina Volkova', role: 'WB Specialist', aliases: ['arina@dasexperten.com'] },
  { address: 'webmaster@dasexperten.com', kind: 'agent', slug: 'jurgen-witt', label: 'Jurgen Witt', role: 'Webmaster · Technical SEO', aliases: ['jurgen@dasexperten.com'] },
  { address: 'lisa@dasexperten.com', kind: 'agent', slug: 'lisa', label: 'Lisa', role: 'Brand Studio', aliases: ['image@dasexperten.com'] },
  { address: 'taras@dasexperten.com', kind: 'agent', slug: 'taras-ryzhiy', label: 'Taras Ryzhiy', role: 'Video' },
  { address: 'build@dasexperten.com', kind: 'agent', slug: 'alessandro-conti', label: 'Alessandro Conti', role: 'Architecture · Construction' },
  { address: 'social@dasexperten.com', kind: 'agent', slug: 'angela', label: 'Angela', role: 'Social Media' },
  { address: 'validation@dasexperten.com', kind: 'agent', slug: 'viktor-palich', label: 'Viktor Palich', role: 'General Director · quality gate' },
];

/** Functional department mailboxes (UI label: Departments — never "pipes"). */
export const DEPARTMENT_MAILBOXES: UiMailbox[] = [
  { address: 'eurasia@dasexperten.com', kind: 'department', label: 'Eurasia', role: 'RU / CIS hub' },
  { address: 'emea@dasexperten.com', kind: 'department', label: 'EMEA', role: 'EN/DE/IT/ES/AR hub' },
  { address: 'asean@dasexperten.com', kind: 'department', label: 'ASEAN', role: 'SE Asia hub' },
  { address: 'marketing@dasexperten.com', kind: 'department', label: 'Marketing', role: 'UGC / brand collabs' },
  { address: 'hello@dasexperten.com', kind: 'department', label: 'Hello', role: 'Warm brand front' },
  { address: 'orders@dasexperten.com', kind: 'department', label: 'Orders', role: 'Order notifications', aliases: ['orders@notify.dasexperten.com'] },
  { address: 'delivery@dasexperten.com', kind: 'department', label: 'Delivery', role: 'Shipping notifications', aliases: ['delivery@notify.dasexperten.com'] },
  { address: 'zakaz@dasexperten.ru', kind: 'department', label: 'Заказ .ru', role: 'dasexperten.ru — приём заказа' },
  { address: 'oplata@dasexperten.ru', kind: 'department', label: 'Оплата .ru', role: 'dasexperten.ru — подтверждение оплаты' },
  { address: 'dostavka@dasexperten.ru', kind: 'department', label: 'Доставка .ru', role: 'dasexperten.ru — отправка, трек, ПВЗ' },
  { address: 'shop@dasexperten.ru', kind: 'department', label: 'Магазин .ru', role: 'dasexperten.ru — письма заказа и ответы на них' },
];

/** Owner personal — excluded from Agents accordion; CF forwards to Gmail. */
export const OWNER_PERSONAL = 'dr.badalyan@dasexperten.com';
export const OWNER_GMAIL = 'dasexperten@gmail.com';

// ---------------------------------------------------------------------------
// Transactional mailboxes (Owner 2026-08-03)
//
// These speak as the brand: order confirmations and shipment notices carry no
// agent name and are signed Das Experten. Nobody owns them, so nobody may
// answer AS them — a customer who writes here is answered by Tamara from
// support@, under her own name. The folder still exists (the letters must be
// visible); only the right to send from the address is withdrawn.
// ---------------------------------------------------------------------------
export const TRANSACTIONAL_ADDRESSES = [
  'orders@dasexperten.com',
  'delivery@dasexperten.com',
  'zakaz@dasexperten.ru',
  'oplata@dasexperten.ru',
  'dostavka@dasexperten.ru',
  'shop@dasexperten.ru',
];
export const SUPPORT_ADDRESS = 'support@dasexperten.com';

export function isTransactional(address: string): boolean {
  return TRANSACTIONAL_ADDRESSES.includes(address.trim().toLowerCase());
}

/** Compose From options: agents + departments (not Owner personal, not transactional). */
export const COMPOSE_FROM_ADDRESSES: string[] = [
  ...DEPARTMENT_MAILBOXES.map((m) => m.address),
  ...AGENT_MAILBOXES.map((m) => m.address),
].filter((a) => !isTransactional(a));

export function addressesForMailbox(m: UiMailbox): string[] {
  return [m.address, ...(m.aliases || [])].map((a) => a.toLowerCase());
}

export function findUiMailbox(address: string): UiMailbox | undefined {
  const a = address.trim().toLowerCase();
  return (
    AGENT_MAILBOXES.find((m) => addressesForMailbox(m).includes(a)) ||
    DEPARTMENT_MAILBOXES.find((m) => addressesForMailbox(m).includes(a))
  );
}

function extractEmail(raw?: string): string {
  if (!raw) return '';
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim().toLowerCase();
}

/** Company mailbox — agents, departments, notify/my. Not customer Gmail. */
export function isHouseAddress(raw?: string): boolean {
  const a = extractEmail(raw);
  if (!a || !a.includes('@')) return false;
  return a.endsWith('@dasexperten.com') || a.endsWith('.dasexperten.com') || a.endsWith('@dasexperten.ru');
}

/** Agents/departments writing only to each other — hidden in Emailer.
 *  Do not guess `to` from the mailbox: every inbound letter's mailbox is house. */
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

// ---------------------------------------------------------------------------
// Signatures (Owner 2026-08-03)
//
// Every outgoing letter is signed. A named mailbox signs with its owner's name
// — the customer must know which human answered them. A department mailbox has
// no owner, so it signs as the brand. The signature is PREFILLED into the reply
// box, never appended silently at send: HARD_RULES §0 requires the person to
// see the exact text before it leaves.
// ---------------------------------------------------------------------------
export function signatureFor(address: string): string {
  const a = address.trim().toLowerCase();
  const agent = AGENT_MAILBOXES.find((m) => addressesForMailbox(m).includes(a));
  return agent ? `\n\n— ${agent.label}\nDas Experten` : `\n\n— Das Experten`;
}

/** Body with the signature removed — used to reject a letter that is signature only. */
export function bodyWithoutSignature(text: string, signature: string): string {
  return text.replace(signature, '').trim();
}
