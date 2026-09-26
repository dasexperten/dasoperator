// Caller agent bar (Owner 2026-09-26). The roster mirrors whatsapp-voice-bridge
// config/call-seats.json (every seat that can call); names and roles come from each seat's
// CHARTER.md. Avatars are the organization's SSOT portraits served by the org board; a seat
// without a portrait shows initials — a face is never invented.

export interface CallerAgent { slug: string; name: string; role: string }

export const CALLER_AGENTS: CallerAgent[] = [
  { slug: 'viktor-palich', name: 'Viktor Palich', role: 'General Director' },
  { slug: 'lauda-briana', name: 'Lauda Briana', role: 'Head of Commerce' },
  { slug: 'lena-sergeeva', name: 'Lena Sergeeva', role: 'HR Head' },
  { slug: 'mina-rutunya', name: 'Mina Rutunya', role: 'Sysadmin' },
  { slug: 'justina-timber', name: 'Justina Timber', role: 'Head of Finance' },
  { slug: 'valentina-korolyeva', name: 'Valentina Korolyeva', role: 'Head of Legal' },
  { slug: 'alexandra-obnorskaya', name: 'Alexandra Vetrova', role: 'SMM' },
  { slug: 'arina-volkova', name: 'Arina Volkova', role: 'WB Specialist' },
  { slug: 'dasha-kozlovskaya', name: 'Dasha Kozlovskaya', role: 'Ozon Specialist' },
  { slug: 'tet', name: 'Tet Nguyen', role: 'Regional Manager' },
  { slug: 'diana-helios', name: 'Diana Helios', role: '' },
  { slug: 'angela', name: 'Angela', role: '' },
  { slug: 'lisa', name: 'Lisa', role: '' },
  { slug: 'marika-nowicka', name: 'Marika Nowicka', role: 'Head of Brand' },
  { slug: 'zina-pevtsova', name: 'Zina Pevtsova', role: 'Head of Logistics' },
  { slug: 'maya-krasochkina', name: 'Maya Krasochkina', role: 'Head of R&D and Intelligence' },
  { slug: 'roberta-di-maria', name: 'Roberta Di Maria', role: 'Content & SMM head' },
  { slug: 'tamara-haar', name: 'Tamara Haar', role: 'Customer Support' },
  { slug: 'alessandro-conti', name: 'Alessandro Conti', role: 'Architect' },
  { slug: 'alfred-bradley', name: 'Alfred Bradley', role: 'Personal Counsel to the Owner' },
  { slug: 'denis-vasilevski', name: 'Denis Vasilevskiy', role: '' },
  { slug: 'dieter-mons', name: 'Dieter Mons', role: '' },
  { slug: 'julian-farah', name: 'Julian Farah', role: 'GEO Specialist' },
  { slug: 'jurgen-witt', name: 'Jurgen Witt', role: '' },
  { slug: 'kobayashi', name: 'Kobayashi', role: '' },
  { slug: 'magnus-larsen', name: 'Magnus Larsen', role: '' },
  { slug: 'otto-zuckerman', name: 'Otto Zuckerman', role: '' },
  { slug: 'taras-ryzhiy', name: 'Taras Ryzhiy', role: '' },
  { slug: 'valera', name: 'Valera', role: '' },
];

export const AVATAR_BASE = 'https://organizacia.dasexperten.workers.dev/assets/agents';
export const NO_PORTRAIT = new Set(['otto-zuckerman', 'valera']);

// Every agent calls from the same company accounts on the DEASEAN number.
export const CALL_ACCOUNTS = {
  whatsapp: { label: 'WhatsApp', account: '+84 931 679 853', detail: 'Das Experten ASEAN' },
  telegram: { label: 'Telegram', account: '+84 931 679 853', detail: 'Das Experten (no username)' },
} as const;

export type CallChannel = keyof typeof CALL_ACCOUNTS;

export function initials(name: string) {
  return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
}
