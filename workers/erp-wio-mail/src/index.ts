import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { parseWioMail } from '../../_bank/wio-mail.mjs';
import { autoMatchBankTransaction } from '../../../api/src/lib/bank-auto-match';
import type { Env as ErpEnv } from '../../../api/src/types';

// Owner 2026-10-17: Wio Business money letters in dasexperten@gmail.com (credits, local and
// international transfers) are written into the ERP bank lines of DEI, and the Gmail thread is
// archived. Once a day, every day. A thread with a letter that could not be read stays in the
// inbox for a human. A row already in the ERP (same reference, or same account, direction and
// amount within three days, e.g. loaded earlier from a payout file) is never written twice.

interface Env extends BaseEnv {
  EMAILER: Fetcher;
}

const QUERY =
  'from:communications@mail.wio.io in:inbox (subject:"received money" OR subject:"local transfer is sent" OR subject:"transfer is on its way")';

async function bridge(env: Env, body: unknown, ms = 90_000): Promise<any> {
  const r = await env.EMAILER.fetch('https://emailer/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ms),
  });
  if (!r.ok) throw new Error(`gmail bridge HTTP ${r.status}`);
  return r.json();
}

function isoDay(v: unknown): string | null {
  const d = v ? new Date(String(v)) : null;
  return d && !isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : null;
}

export default erpWorker<Env>('erp-wio-mail', async (env, dry) => {
  const found = await bridge(env, { action: 'find', query: QUERY, max_results: 20, skip_attachments: true }, 150_000);
  const threads: any[] = found?.threads ?? [];
  let letters = 0, inserted = 0, known = 0, archived = 0, held = 0;
  const problems: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (const t of threads) {
    const threadId = t.thread_id || t.id;
    if (!threadId) continue;
    let thr: any;
    try {
      thr = await bridge(env, { action: 'get_thread', thread_id: threadId, skip_attachments: true });
    } catch (e) {
      problems.push(`${threadId}: ${e instanceof Error ? e.message : String(e)}`);
      held++;
      continue;
    }
    if (!thr?.success && !Array.isArray(thr?.messages)) {
      problems.push(`${threadId}: ${thr?.error || 'get_thread failed'}`);
      held++;
      continue;
    }
    let clean = true;
    for (const m of thr.messages ?? []) {
      letters++;
      const body = m.body_plain || m.body || m.plain || m.body_html || '';
      const parsed = parseWioMail(body, {
        subject: m.subject || thr.subject || t.subject || '',
        fallbackDate: isoDay(m.date || m.received_at || thr.last_message_date),
      });
      if (parsed.problems.length) {
        clean = false;
        problems.push(...parsed.problems.map((p: string) => `${threadId} ${p}`));
      }
      for (const tx of parsed.transactions) {
        const at = Math.floor(new Date(tx.executed_at + 'T12:00:00Z').getTime() / 1000);
        const dup = await env.DB.prepare(
          `SELECT id FROM bank_transactions
            WHERE company_bank_account_id = ? AND (deleted_at IS NULL OR deleted_at = 0)
              AND (external_id = ? OR external_doc_number = ?
                   OR (direction = ? AND amount = ? AND ABS(executed_at - ?) <= 3 * 86400))
            LIMIT 1`,
        ).bind(tx.account_id, tx.external_id, tx.external_id, tx.direction, tx.amount, at).first();
        if (dup || dry) { known++; continue; }
        const txId = `bt_${crypto.randomUUID()}`;
        try {
          const res = await env.DB.prepare(
            `INSERT OR IGNORE INTO bank_transactions
               (id, company_bank_account_id, external_id, external_doc_number, direction, status,
                amount, currency, executed_at, created_at_bank, contragent_name,
                payment_purpose, raw_payload, source_type, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'email_inbox', ?, ?)`,
          ).bind(
            txId, tx.account_id, tx.external_id, tx.external_doc_number, tx.direction,
            tx.direction === 'incoming' ? 'Received' : 'Executed', tx.amount, tx.currency, at, at,
            tx.contragent_name, tx.payment_purpose,
            JSON.stringify({ source: 'wio_mail', thread_id: threadId, ...tx }), now, now,
          ).run();
          if (res.meta.changes > 0) {
            inserted++;
            try { await autoMatchBankTransaction(env as unknown as ErpEnv, txId); } catch { /* bank-match retries nightly */ }
          } else {
            known++;
          }
        } catch (e) {
          clean = false;
          problems.push(`${tx.external_id}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
        }
      }
    }
    if (clean && !dry) {
      try {
        await bridge(env, { action: 'modify', thread_id: threadId, archive: true }, 30_000);
        archived++;
      } catch (e) {
        problems.push(`${threadId} archive: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (!clean) {
      held++;
    }
  }

  const note = `threads ${threads.length} · letters ${letters} · new ${inserted} · already known ${known} · archived ${archived} · left in inbox ${held}`
    + (problems.length ? ` · ${problems.slice(0, 5).join('; ')}` : '');
  return { rows: inserted, note: note.slice(0, 1000) };
});
