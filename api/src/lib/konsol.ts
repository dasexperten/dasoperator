// Konsol Payment Service client (Owner 2026-10-14). Key: Worker secret
// KONSOL_API_KEY (card SECRETS/konsol.md, both vaults). Never logged.
//
// Shapes measured by live GET calls on 2026-10-14:
//   GET  /api/v1/company_accounts   → { collection: [{ id, balance: "1936615.38", bank }] }  (balance INCLUDES overdraft)
//   GET  /api/v1/contractors        → { collection: [{ id, first_name, last_name, patronymic, taxpayer_id, kind, phone: "+7…" }],
//                                       pagination: { next_page, from, to } }; next page = ?from=<pagination.to>
//   POST /api/v1/contractors        → required: kind, first_name, last_name, phone (400 lists them when absent)
//   GET  /api/v1/payments/:id       → { id, contractor_id, amount: "691.0", status: executed|failed|…, error_message,
//                                       kind: "fps", requisites: { fps_mobile_phone, fps_bank_member_id }, services_list, paid_at }
//   GET  /api/v1/references/fps_bank_members → { collection: [{ id, name, russian_name, external_id: "100000000004", … }] }
//                                       fps_bank_member_id in a payment is external_id (the NSPK id)
import type { Env } from '../types';

const HOST = 'https://api-payments.konsol.ru';
const MAX_CONTRACTOR_PAGES = 20;

export type KonsolAnswer = { ok: boolean; status: number; body: any; error?: string | undefined };

function errorText(body: any): string | undefined {
  if (!body) return undefined;
  if (Array.isArray(body.errors)) return body.errors.join('; ').slice(0, 500);
  if (typeof body.error === 'string') return body.error.slice(0, 500);
  return undefined;
}

export function konsolClient(env: Env) {
  const key = (env as unknown as { KONSOL_API_KEY?: string }).KONSOL_API_KEY ?? '';

  async function call(method: string, path: string, body?: unknown): Promise<KonsolAnswer> {
    if (!key) return { ok: false, status: 0, body: null, error: 'KONSOL_API_KEY not set on the Worker' };
    try {
      const init: RequestInit = {
        method,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        signal: AbortSignal.timeout(25_000),
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      const res = await fetch(`${HOST}${path}`, init);
      const text = await res.text();
      let parsed: any = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
      return { ok: res.ok, status: res.status, body: parsed, error: res.ok ? undefined : (errorText(parsed) ?? text.slice(0, 200)) };
    } catch (e) {
      return { ok: false, status: 0, body: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    companyAccounts: () => call('GET', '/api/v1/company_accounts'),
    getPayment: (id: string) => call('GET', `/api/v1/payments/${encodeURIComponent(id)}`),
    createPayment: (body: unknown) => call('POST', '/api/v1/payments', body),
    createContractor: (body: unknown) => call('POST', '/api/v1/contractors', body),

    async bankMember(externalId: string): Promise<{ found: boolean; name?: string; error?: string }> {
      const r = await call('GET', '/api/v1/references/fps_bank_members');
      if (!r.ok) return { found: false, error: r.error ?? `HTTP ${r.status}` };
      const hit = (r.body?.collection ?? []).find((b: any) => String(b.external_id) === String(externalId));
      return hit ? { found: true, name: hit.russian_name || hit.name } : { found: false };
    },

    /** Walks the contractor list (no server filter exists) for an individual with this phone. */
    async findContractorByPhone(phone: string): Promise<{ id?: string; error?: string }> {
      let from: string | null = null;
      for (let page = 0; page < MAX_CONTRACTOR_PAGES; page++) {
        const r = await call('GET', `/api/v1/contractors${from ? `?from=${encodeURIComponent(from)}` : ''}`);
        if (!r.ok) return { error: `contractor list: ${r.error ?? `HTTP ${r.status}`}` };
        const hit = (r.body?.collection ?? []).find((c: any) => c.phone === phone && c.kind === 'individual');
        if (hit) return { id: String(hit.id) };
        const next = r.body?.pagination;
        if (!next?.next_page || !next.to || next.to === from) return {};
        from = String(next.to);
      }
      return { error: 'contractor list longer than expected — stopped' };
    },
  };
}
