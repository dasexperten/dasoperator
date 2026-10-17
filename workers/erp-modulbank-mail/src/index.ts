import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { parseModulbankMail, MODULBANK_ACCOUNT_ID } from '../../_bank/modulbank-mail.mjs';
import { autoMatchBankTransaction } from '../../../api/src/lib/bank-auto-match';
import type { Env as ErpEnv } from '../../../api/src/types';

// Owner 2026-10-12: Modulbank payment notifications in dasexperten@gmail.com are read,
// written into the ERP bank lines, and the Gmail thread is archived. Once a day, every day (Owner 2026-10-17).
// A thread with any letter that could not be read stays in the inbox for a human.

interface Env extends BaseEnv {
  EMAILER: Fetcher;
}

const QUERY =
  'from:no-reply@modulbank.ru in:inbox (subject:Поступление OR subject:Списан OR subject:Списание OR subject:комиссия)';

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

export default erpWorker<Env>('erp-modulbank-mail', async (env, dry) => {
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
      const body = m.body_plain || m.body || m.plain || '';
      const parsed = parseModulbankMail(body, {
        subject: m.subject || thr.subject || t.subject || '',
        fallbackDate: isoDay(m.date || m.received_at || thr.last_message_date),
      });
      if (parsed.problems.length) {
        clean = false;
        problems.push(...parsed.problems.map((p: string) => `${threadId} ${p}`));
      }
      for (const tx of parsed.transactions) {
        if (dry) { known++; continue; }
        const txId = `bt_${crypto.randomUUID()}`;
        const at = Math.floor(new Date(tx.executed_at + 'T12:00:00Z').getTime() / 1000);
        try {
          const res = await env.DB.prepare(
            `INSERT OR IGNORE INTO bank_transactions
               (id, company_bank_account_id, external_id, external_doc_number, direction, status,
                amount, currency, executed_at, created_at_bank, contragent_name, contragent_inn,
                payment_purpose, raw_payload, source_type, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'email_inbox', ?, ?)`,
          ).bind(
            txId, MODULBANK_ACCOUNT_ID, tx.external_id, tx.external_doc_number, tx.direction,
            tx.direction === 'incoming' ? 'Received' : 'Executed', tx.amount, tx.currency, at, at,
            tx.contragent_name, tx.contragent_inn, tx.payment_purpose,
            JSON.stringify({ source: 'modulbank_mail', thread_id: threadId, ...tx }), now, now,
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
