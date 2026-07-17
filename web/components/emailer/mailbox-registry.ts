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

const AVATAR_BASE = 'https://www.dasexperten.com/assets/agents';

export function agentAvatarUrl(slug: string): string {
  return `${AVATAR_BASE}/${slug}.png`;
}

/** Named agent mailboxes — always show avatar chip when present. */
export const AGENT_MAILBOXES: UiMailbox[] = [
  { address: 'lauda@dasexperten.com', kind: 'agent', slug: 'lauda-briana', label: 'Lauda Briana', role: 'Head of Commerce' },
  { address: 'roberta@dasexperten.com', kind: 'agent', slug: 'roberta-di-maria', label: 'Roberta Di Maria', role: 'Head of Content' },
  { address: 'marika@dasexperten.com', kind: 'agent', slug: 'marika-nowicka', label: 'Marika Nowicka', role: 'Head of Brand', aliases: ['maria@dasexperten.com'] },
  { address: 'valentina@dasexperten.com', kind: 'agent', slug: 'valentina-korolyeva', label: 'Valentina Korolyeva', role: 'Head of Legal' },
  { address: 'justina@dasexperten.com', kind: 'agent', slug: 'justina-timber', label: 'Justina Timber', role: 'Head of Finance' },
  { address: 'julian@dasexperten.com', kind: 'agent', slug: 'julian-farah', label: 'Julian Farah', role: 'GEO Specialist' },
  { address: 'lena@dasexperten.com', kind: 'agent', slug: 'lena-sergeeva', label: 'Lena Sergeeva', role: 'Central Executive Officer' },
  { address: 'alexandra@dasexperten.com', kind: 'agent', slug: 'alexandra-obnorskaya', label: 'Alexandra Obnorskaya', role: 'Marketplaces' },
  { address: 'mina@dasexperten.com', kind: 'agent', slug: 'mina', label: 'Mina', role: 'Sysadmin' },
  { address: 'zina@dasexperten.com', kind: 'agent', slug: 'zina-pevtsova', label: 'Zina Pevtsova', role: 'Logistics' },
  { address: 'maya@dasexperten.com', kind: 'agent', slug: 'maya-krasochkina', label: 'Maya Krasochkina', role: 'Operations' },
  { address: 'dasha@dasexperten.com', kind: 'agent', slug: 'dasha-kozlovskaya', label: 'Dasha Kozlovskaya', role: 'Ozon Specialist' },
  { address: 'arina@dasexperten.com', kind: 'agent', slug: 'arina-volkova', label: 'Arina Volkova', role: 'WB Specialist' },
];

/** Functional department mailboxes (UI label: Departments — never "pipes"). */
export const DEPARTMENT_MAILBOXES: UiMailbox[] = [
  { address: 'sales@dasexperten.com', kind: 'department', label: 'Sales', role: 'B2B / wholesale' },
  { address: 'support@dasexperten.com', kind: 'department', label: 'Support', role: 'Post-sale' },
  { address: 'eurasia@dasexperten.com', kind: 'department', label: 'Eurasia', role: 'RU / CIS' },
  { address: 'emea@dasexperten.com', kind: 'department', label: 'EMEA', role: 'EN/DE/IT/ES/AR' },
  { address: 'asean@dasexperten.com', kind: 'department', label: 'ASEAN', role: 'SE Asia' },
  { address: 'marketing@dasexperten.com', kind: 'department', label: 'Marketing', role: 'UGC / brand' },
  { address: 'partnerships@dasexperten.com', kind: 'department', label: 'Partnerships', role: 'GEO / DA / outreach' },
  { address: 'hello@dasexperten.com', kind: 'department', label: 'Hello', role: 'Warm front' },
  { address: 'orders@dasexperten.com', kind: 'department', label: 'Orders', role: 'Orders' },
];

/** Owner personal — excluded from Agents accordion; CF forwards to Gmail. */
export const OWNER_PERSONAL = 'dr.badalyan@dasexperten.com';
export const OWNER_GMAIL = 'dasexperten@gmail.com';

/** Compose From options: agents + departments (not Owner personal). */
export const COMPOSE_FROM_ADDRESSES: string[] = [
  ...DEPARTMENT_MAILBOXES.map((m) => m.address),
  ...AGENT_MAILBOXES.map((m) => m.address),
];

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
