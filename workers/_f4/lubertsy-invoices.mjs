// F4 Lyubertsy invoices → ERP operations, and bank payments matched to them. Model-free.
// Copied from the LIVE Cloudflare worker lubertsy-invoice-cron on 2026-09-18 (no source in
// any repo). Its own lubertsy_cron_log write fails silently (no "errors" column); the run
// log is now erp_cron_runs.
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/index.ts
var PARTNER = "f4_lubertsy";
var INN = "550412856773";
function opId() {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return "op_" + [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
__name(opId, "opId");
function ymd(d) {
  return d.replace(/-/g, "");
}
__name(ymd, "ymd");
function epoch(d) {
  return Math.floor(Date.parse(d + "T00:00:00Z") / 1e3);
}
__name(epoch, "epoch");
function extractInvoiceNos(purpose) {
  const nos = [];
  const re1 = /№\s*([0-9][0-9A-Za-z-]*)\s+от/g;
  let m;
  while ((m = re1.exec(purpose)) !== null) nos.push(m[1]);
  const re2 = /(?:Счет|счет|счёт|Счёт)\s*N([0-9][0-9A-Za-z-]*)\s+от/g;
  while ((m = re2.exec(purpose)) !== null) {
    if (!nos.includes(m[1])) nos.push(m[1]);
  }
  const re3 = /№\s*([0-9][0-9A-Za-z-]*)\s+№/g;
  while ((m = re3.exec(purpose)) !== null) {
    if (!nos.includes(m[1])) nos.push(m[1]);
  }
  return nos;
}
__name(extractInvoiceNos, "extractInvoiceNos");
function extractFirstDate(purpose) {
  const m = purpose.match(/от\s+(\d{1,2}[./]\d{1,2}[./]\d{2,4})/);
  if (!m) return null;
  const parts = m[1].split(/[./]/);
  if (parts.length !== 3) return null;
  let [dd, mm, yyyy] = parts;
  if (yyyy.length === 2) yyyy = "20" + yyyy;
  if (dd.length === 1) dd = "0" + dd;
  if (mm.length === 1) mm = "0" + mm;
  return `${yyyy}-${mm}-${dd}`;
}
__name(extractFirstDate, "extractFirstDate");
async function run(env) {
  const now = Math.floor(Date.now() / 1e3);
  const created = [];
  const linked = [];
  let opsCreated = 0;
  let opsLinked = 0;
  let paymentsMatched = 0;
  const errors = [];
  const inboxRows = await env.DB.prepare(`
    SELECT extracted_invoice_no no, extracted_invoice_date d, MAX(extracted_amount) amt
    FROM invoice_inbox
    WHERE matched_partner_id = ?1
      AND status IN ('needs_partner_link','error')
      AND extracted_amount IS NOT NULL AND extracted_amount > 0
      AND extracted_invoice_no IS NOT NULL AND extracted_invoice_date IS NOT NULL
    GROUP BY extracted_invoice_no, extracted_invoice_date
  `).bind(PARTNER).all();
  for (const r of inboxRows.results) {
    try {
      const existing = await env.DB.prepare(
        "SELECT id FROM operations WHERE partner_id = ? AND reference LIKE ?"
      ).bind(PARTNER, `LBR-%-${r.no}`).first();
      if (existing) {
        await env.DB.prepare(
          `UPDATE invoice_inbox SET created_operation_id = ?, status = 'linked',
           processed_at = ?, resolved_at = ?
           WHERE matched_partner_id = ? AND extracted_invoice_no = ?
           AND status IN ('needs_partner_link','error') AND created_operation_id IS NULL`
        ).bind(existing.id, now, now, PARTNER, r.no).run();
        opsLinked++;
        linked.push(r.no);
        continue;
      }
      const id = opId();
      const ref = `LBR-${ymd(r.d)}-${r.no}`;
      const ep = epoch(r.d);
      await env.DB.prepare(
        `INSERT INTO operations
         (id, operation_date, operation_type, partner_id, our_company_id,
          currency, total_amount, status, operation_track, delivery_status,
          vat_rate, dei_layer, via_dei, reference, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id,
        ep,
        "service",
        PARTNER,
        "dee",
        "RUB",
        r.amt,
        "issued",
        "service",
        "delivered",
        0,
        0,
        0,
        ref,
        `Invoice from invoice_inbox (cron) ${r.no}`,
        now,
        now
      ).run();
      await env.DB.prepare(
        `UPDATE invoice_inbox SET created_operation_id = ?, status = 'auto_created',
         processed_at = ?, resolved_at = ?
         WHERE matched_partner_id = ? AND extracted_invoice_no = ?
         AND status IN ('needs_partner_link','error') AND created_operation_id IS NULL`
      ).bind(id, now, now, PARTNER, r.no).run();
      opsCreated++;
      created.push(ref);
    } catch (e) {
      errors.push(`phaseA:${r.no}:${e.message}`);
    }
  }
  const btxRows = await env.DB.prepare(
    `SELECT id, payment_purpose, amount, executed_at FROM bank_transactions
     WHERE contragent_inn = ? AND matched_operation_id IS NULL`
  ).bind(INN).all();
  for (const t of btxRows.results) {
    try {
      const purpose = t.payment_purpose || "";
      const nos = extractInvoiceNos(purpose);
      if (nos.length === 0) continue;
      const firstNo = nos[0];
      const op = await env.DB.prepare(
        "SELECT id, reference, total_amount FROM operations WHERE partner_id = ? AND reference LIKE ?"
      ).bind(PARTNER, `LBR-%-${firstNo}`).first();
      if (op) {
        await env.DB.prepare(
          `UPDATE bank_transactions
           SET matched_operation_id = ?, match_method = 'auto_invno_pair',
               matched_at = ?, matched_by = 'lubertsy-invoice-cron'
           WHERE id = ?`
        ).bind(op.id, now, t.id).run();
        paymentsMatched++;
        linked.push(`btx:${firstNo}`);
      } else {
        const id = opId();
        const txDate = extractFirstDate(purpose);
        const ref = txDate ? `LBR-${ymd(txDate)}-${firstNo}` : `LBR-${firstNo}`;
        const ep = txDate ? epoch(txDate) : t.executed_at || now;
        const amountMinor = t.amount || 0;
        await env.DB.prepare(
          `INSERT INTO operations
           (id, operation_date, operation_type, partner_id, our_company_id,
            currency, total_amount, status, operation_track, delivery_status,
            vat_rate, dei_layer, via_dei, reference, notes, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).bind(
          id,
          ep,
          "service",
          PARTNER,
          "dee",
          "RUB",
          amountMinor,
          "draft",
          "service",
          "delivered",
          0,
          0,
          0,
          ref,
          `Auto-created from bank tx ${t.id}. ${purpose.slice(0, 200)}`,
          now,
          now
        ).run();
        await env.DB.prepare(
          `UPDATE bank_transactions
           SET matched_operation_id = ?, match_method = 'auto_from_btx',
               matched_at = ?, matched_by = 'lubertsy-invoice-cron'
           WHERE id = ?`
        ).bind(id, now, t.id).run();
        const inboxLink = await env.DB.prepare(
          `SELECT id FROM invoice_inbox
           WHERE extracted_invoice_no = ? AND matched_partner_id IS NULL
           AND created_operation_id IS NULL LIMIT 1`
        ).bind(firstNo).first();
        if (inboxLink) {
          await env.DB.prepare(
            `UPDATE invoice_inbox SET created_operation_id = ?, status = 'linked',
             matched_partner_id = ?, processed_at = ?, resolved_at = ?
             WHERE id = ?`
          ).bind(id, PARTNER, now, now, inboxLink.id).run();
        }
        opsCreated++;
        paymentsMatched++;
        created.push(ref);
      }
    } catch (e) {
      errors.push(`phaseB:${t.id}:${e.message}`);
    }
  }
  const orphanInbox = await env.DB.prepare(
    `SELECT id, extracted_invoice_no, extracted_amount
     FROM invoice_inbox
     WHERE matched_partner_id IS NULL
       AND extracted_invoice_no IS NOT NULL
       AND created_operation_id IS NULL
       AND status != 'auto_created'`
  ).all();
  for (const row of orphanInbox.results) {
    try {
      const invNo = row.extracted_invoice_no;
      const op = await env.DB.prepare(
        "SELECT id FROM operations WHERE partner_id = ? AND reference LIKE ?"
      ).bind(PARTNER, `LBR-%-${invNo}`).first();
      if (op) {
        await env.DB.prepare(
          `UPDATE invoice_inbox
           SET created_operation_id = ?, matched_partner_id = ?, status = 'linked',
               processed_at = ?, resolved_at = ?
           WHERE id = ? AND created_operation_id IS NULL`
        ).bind(op.id, PARTNER, now, now, row.id).run();
        opsLinked++;
        linked.push(`inbox:${invNo}`);
      }
    } catch (e) {
      errors.push(`phaseC:${row.id}:${e.message}`);
    }
  }
  try {
    await env.DB.prepare(
      `INSERT INTO lubertsy_cron_log (run_at, ops_created, payments_matched, refs, errors)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(now, opsCreated, paymentsMatched, created.concat(linked).join(","), errors.join(",")).run();
  } catch (e) {
    if (e.message?.includes("no such table")) {
      await env.DB.prepare(
        `CREATE TABLE IF NOT EXISTS lubertsy_cron_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          run_at INTEGER NOT NULL,
          ops_created INTEGER DEFAULT 0,
          payments_matched INTEGER DEFAULT 0,
          refs TEXT, errors TEXT
        )`
      ).run();
      await env.DB.prepare(
        `INSERT INTO lubertsy_cron_log (run_at, ops_created, payments_matched, refs, errors)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(now, opsCreated, paymentsMatched, created.concat(linked).join(","), errors.join(",")).run();
    }
  }
  return { ok: true, opsCreated, opsLinked, paymentsMatched, created, linked, errors };
}
__name(run, "run");

export { run as runLubertsyInvoices };
