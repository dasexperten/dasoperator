// Owner 2026-11-07: «выплата сразу». Since the ERP became an alarm only (f4e661b, 06.11), nothing registered
// the brown button. Diana registers it herself the moment she has read requisites and the cart amount; the
// Owner still pays only by his own click. Same rules as the retired ERP path: one open payout per blogger,
// cleanRequisites validation (50–999 ₽, Russian mobile, known SBP bank, first name), awaiting_approval only.
// Node 24; JSON on stdin: {handle, amount_rub, phone, bank, first_name, last_name?, patronymic?, product?, doubt?, evidence}.
// The existing protected D1 credential stays in the environment (CLOUDFLARE_API_TOKEN), never in argv or output.
import {pathToFileURL} from 'node:url';
import {cleanRequisites} from '../api/src/lib/ig-dm-reply-guard.mjs';
import {followPayoutStage} from '../api/src/lib/ugc-payout-stage.mjs';

const ENDPOINT = 'https://api.cloudflare.com/client/v4/accounts/081ddb85cb399ad62a70210328d744fc/d1/database/0653d156-5069-4c46-a496-fad982d0d1df/query';

export function protectedDatabase({token, fetchImpl = fetch}) {
  async function execute(body) {
    const response = await fetchImpl(ENDPOINT, {method: 'POST', headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    if (!response.ok) throw Error(`payout_storage_http_${response.status}`);
    const out = await response.json();
    if (!out.success || !Array.isArray(out.result) || out.result.some(r => !r.success)) throw Error('payout_storage_failed');
    return out.result;
  }
  return {
    prepare(sql) {
      let params = [];
      const q = {
        bind(...p) { params = p; return q; },
        get statement() { return {sql, params}; },
        async first() { return (await execute({sql, params}))[0].results?.[0] ?? null; },
        async all() { return {results: (await execute({sql, params}))[0].results ?? []}; },
        async run() { const r = (await execute({sql, params}))[0]; return {meta: r.meta ?? {}}; },
      };
      return q;
    },
    async batch(statements) { return execute({batch: statements.map(q => q.statement)}); },
  };
}

export async function createPayout(input, {DB, now = Date.now(), uuid = () => crypto.randomUUID()}) {
  const handle = String(input?.handle ?? '').trim().replace(/^@/, '').toLowerCase();
  if (!handle) throw Error('handle_required');
  if (typeof input.evidence !== 'string' || !input.evidence.trim()) throw Error('evidence_required');
  const r = cleanRequisites(input);
  if (!r) throw Error('requisites_invalid: amount 50-999, Russian mobile, known SBP bank and first name are required');
  const profile = await DB.prepare(`SELECT id, creator_id FROM ugc_creator_platforms WHERE platform='instagram' AND normalized_handle=?1`).bind(handle).first();
  if (!profile) throw Error('creator_not_in_erp');
  const cid = String(profile.creator_id);
  const open = await DB.prepare(`SELECT id, status, amount_minor FROM ugc_payouts WHERE creator_id=?1 AND status IN ('awaiting_approval','approved','sent') ORDER BY created_at DESC LIMIT 1`).bind(cid).first();
  if (open) return {created: false, existing: open.id, status: open.status, amount_minor: open.amount_minor};
  const id = uuid();
  const day = new Date(now + 4 * 3_600_000).toISOString().slice(0, 10);
  const masked = `${r.phone.slice(0, 5)}*****${r.phone.slice(-2)}`;
  const doubt = String(input.doubt ?? '').trim().slice(0, 300);
  const note = `Реквизиты из переписки (Диана). ${input.evidence.trim().slice(0, 500)}${doubt ? ` Проверь перед оплатой: ${doubt}.` : ''}`;
  await DB.batch([
    DB.prepare(`INSERT INTO ugc_payouts (id, creator_id, creator_platform_id, platform, handle, amount_minor, currency, status, payout_date, phone_masked, fps_bank_member_id, note, created_by, created_at, updated_at, product)
      VALUES (?1, ?2, ?3, 'instagram', ?4, ?5, 'RUB', 'awaiting_approval', ?6, ?7, ?8, ?9, 'Diana Helios', ?10, ?10, ?11)`)
      .bind(id, cid, String(profile.id), handle, r.amount_minor, day, masked, r.bank, note, now, r.product),
    DB.prepare(`INSERT INTO ugc_payout_requisites (payout_id, fps_mobile_phone, first_name, last_name, patronymic, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)`)
      .bind(id, r.phone, r.first_name, r.last_name, r.patronymic, now),
  ]);
  await followPayoutStage(DB, cid, 'awaiting_approval', now);
  const saved = await DB.prepare(`SELECT id, status, amount_minor FROM ugc_payouts WHERE id=?1`).bind(id).first();
  if (!saved || saved.status !== 'awaiting_approval') throw Error('payout_not_saved');
  return {created: true, id, status: saved.status, amount_minor: saved.amount_minor};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    let text = ''; for await (const part of process.stdin) { text += part; if (text.length > 6000) throw Error('payout_input_too_large'); }
    const token = process.env.CLOUDFLARE_API_TOKEN;
    if (!token) throw Error('existing_protected_credential_required');
    console.log(JSON.stringify({ok: true, ...await createPayout(JSON.parse(text), {DB: protectedDatabase({token})})}));
  } catch (error) {
    console.error(JSON.stringify({ok: false, error: error instanceof Error ? error.message : 'payout_create_failed'}));
    process.exitCode = 1;
  }
}
