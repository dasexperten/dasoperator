// F4 invoices and executed bank debits -> ERP records. No models or payment sending.
// Owner 2026-11-07: exact partner + invoice number + date + RUB amount only.
const PARTNER = 'f4_lubertsy';
const INN = '550412856773';
const COMPANY = 'dee';
const ACTIVE = '(deleted_at IS NULL OR deleted_at = 0)';
const UNRESOLVED = "status IN ('needs_partner_link','error')";
const INBOX_FILE_BASE = 'https://dasoperator-api.dasexperten.workers.dev/api/inbox/';

// A known business conflict holds that record for a person; it is not a broken
// timer. Only this explicit type is a review hold. SQL/R2/storage errors stay red.
class ReviewRequiredError extends Error {
  constructor(reason) { super(reason); this.name = 'ReviewRequiredError'; }
}
function recordFailure(result, id, source, error) {
  if (error instanceof ReviewRequiredError) {
    result.skipped.push({id,reason:error.message,review_required:true});
  } else {
    result.errors.push(`${source}:${id}:${error instanceof Error ? error.message : String(error)}`);
  }
}


function minor(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return null;
  const cents = Math.round(amount * 100);
  return Number.isSafeInteger(cents) && Math.abs(amount * 100 - cents) < 0.00001 ? cents : null;
}
function dateEpoch(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) return null;
  const time = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? time / 1000 : null;
}
function identity(number, date) {
  if (typeof number !== 'string' || !number.trim() || number.trim().length > 100 || /[\x00-\x1f]/.test(number)) return null;
  const at = dateEpoch(date);
  return at === null ? null : { number: number.trim(), date, at, ref: `LBR-${date.replaceAll('-', '')}-${number.trim()}` };
}
async function stableId(prefix, value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return prefix + [...new Uint8Array(digest)].map(v => v.toString(16).padStart(2, '0')).join('').slice(0, 32);
}
export function parseSingleInvoice(purpose = '') {
  // A payment covering several invoices is never assigned entirely to the first.
  if ((purpose.match(/[№#]/g) ?? []).length > 1 || /частич|часть\s+оплат|аванс|предоплат/i.test(purpose)) return null;
  const dates = purpose.match(/от\s+\d{1,2}[./]\d{1,2}[./]\d{2,4}/gi) ?? [];
  if (dates.length !== 1) return null;
  const matches = [...purpose.matchAll(/(?:сч[её]т[а-яё]*(?:\s+на\s+оплату)?\s*[№N#]?|№)\s*([0-9][0-9A-Za-zА-Яа-я/._-]*)\s+от\s+(\d{1,2})[./](\d{1,2})[./](\d{2,4})/gi)];
  if (matches.length !== 1) return null;
  const [, no, dd, mm, yy] = matches[0];
  const date = `${yy.length === 2 ? '20' + yy : yy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
  return identity(no, date);
}

// Shared canonical helpers also perform fuzzy matching / model-backed creation,
// or lack atomic deduplication. This narrow path uses the same attachment schema
// and stored file URL convention, with exact identity and transactional writes.
async function findOperation(db, inv) {
  const { results } = await db.prepare(`SELECT o.* FROM operations o
    WHERE o.partner_id = ? AND o.our_company_id = ? AND
      (o.reference IN (?,? || '-A') OR EXISTS (SELECT 1 FROM operation_attachments a
        WHERE a.operation_id = o.id AND a.deleted_at IS NULL
          AND a.direction = 'incoming' AND a.kind IN ('invoice','service_invoice','commercial_invoice','freight_invoice')
          AND a.doc_number = ? AND a.doc_date = ?))`)
    .bind(PARTNER, COMPANY, inv.ref, inv.ref, inv.number, inv.at).all();
  if (results.length > 1) throw new ReviewRequiredError('ambiguous invoice operations');
  const op = results[0];
  if (!op) {
    // Canonical bank creation sometimes uses the payment date or strips '/'.
    // Such a same-year identity is a conflict, never permission to create twice.
    const possible = (await db.prepare(`SELECT o.reference,a.doc_number,a.doc_date FROM operations o
      LEFT JOIN operation_attachments a ON a.operation_id=o.id AND a.deleted_at IS NULL
      WHERE o.partner_id=? AND o.our_company_id=?`)
      .bind(PARTNER,COMPANY).all()).results;
    const sanitized = inv.number.replace(/[^A-Za-z0-9]/g,'');
    for (const row of possible) {
      const m = /^LBR-(\d{8})-(.+)$/.exec(row.reference ?? '');
      const no = m?.[2]?.replace(/-A$/, '');
      if ((m && m[1].slice(0,4) === inv.date.slice(0,4) && [inv.number,sanitized].includes(no))
        || row.reference === `LBR-${inv.number}`
        || (row.doc_number === inv.number && (!row.doc_date || new Date(row.doc_date*1000).getUTCFullYear() === Number(inv.date.slice(0,4)))))
        throw new ReviewRequiredError('conflicting legacy invoice identity; review required');
    }
    return null;
  }
  if (op.deleted_at || op.status === 'cancelled' || op.operation_type !== 'service' || op.operation_track !== 'service'
    || op.currency !== 'RUB') throw new ReviewRequiredError('invoice operation is deleted, cancelled or incompatible');
  return op;
}
async function ensureOperation(db, inv, amount, status, note, now, source) {
  let op = await findOperation(db, inv);
  if (op) {
    if (minor(Number(op.total_amount)) !== minor(amount)) throw new ReviewRequiredError('invoice amount conflict; existing money unchanged');
    return { op, insert: null };
  }
  const id = await stableId('op_lbr_', JSON.stringify([PARTNER, COMPANY, inv.date, inv.number, 'RUB']));
  const sourceGuard = source.kind === 'inbox'
    ? `EXISTS (SELECT 1 FROM invoice_inbox WHERE id=? AND ${ACTIVE} AND ${UNRESOLVED}
        AND created_operation_id IS NULL AND classification='service'
        AND (matched_partner_id=? OR (matched_partner_id IS NULL AND extracted_vendor_inn=?))
        AND TRIM(extracted_invoice_no)=? AND extracted_invoice_date=? AND extracted_currency='RUB'
        AND ROUND(extracted_amount*100)=? AND attachment_r2_key=?)`
    : `EXISTS (SELECT 1 FROM bank_transactions WHERE id=? AND ${ACTIVE}
        AND matched_operation_id IS NULL AND matched_payment_id IS NULL
        AND contragent_inn=? AND direction='outgoing' AND currency='RUB' AND status='Executed'
        AND amount=? AND payment_purpose=?)`;
  const sourceArgs = source.kind === 'inbox'
    ? [source.row.id,PARTNER,INN,inv.number,inv.date,minor(amount),source.row.attachment_r2_key]
    : [source.row.id,INN,source.row.amount,source.row.payment_purpose];
  const insert = db.prepare(`INSERT INTO operations
    (id,operation_date,operation_type,partner_id,our_company_id,currency,total_amount,status,
     operation_track,delivery_status,vat_rate,dei_layer,via_dei,reference,notes,created_at,updated_at)
    SELECT ?,?,'service',?,?,'RUB',?,?,'service','delivered',0,0,0,?,?,?,?
    WHERE ${sourceGuard} AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.partner_id=? AND o.our_company_id=?
      AND (o.reference IN (?,? || '-A') OR o.reference=?
        OR (SUBSTR(o.reference,1,4)='LBR-' AND SUBSTR(o.reference,5,4)=?
          AND SUBSTR(o.reference,14) IN (?,?,? || '-A',? || '-A'))
        OR EXISTS (SELECT 1 FROM operation_attachments a WHERE a.operation_id=o.id AND a.deleted_at IS NULL
          AND a.doc_number=? AND (a.doc_date IS NULL OR strftime('%Y',a.doc_date,'unixepoch')=?))))
    ON CONFLICT(id) DO NOTHING`)
    .bind(id,inv.at,PARTNER,COMPANY,amount,status,inv.ref,note,now,now,...sourceArgs,
      PARTNER,COMPANY,inv.ref,inv.ref,`LBR-${inv.number}`,inv.date.slice(0,4),
      inv.number,inv.number.replace(/[^A-Za-z0-9]/g,''),inv.number,inv.number.replace(/[^A-Za-z0-9]/g,''),inv.number,inv.date.slice(0,4));
  return { op: {id,reference:inv.ref,total_amount:amount}, insert };
}

async function attachInbox(db, row, inv, op, now, insert) {
  if (!row.attachment_r2_key) throw Error('invoice file missing; inbox remains unresolved');
  const conflict = await db.prepare(`SELECT id FROM operation_attachments WHERE parsed_from='inbox'
    AND source_ref_id=? AND deleted_at IS NULL AND operation_id IS NOT NULL AND operation_id<>? LIMIT 1`)
    .bind(row.id, op.id).first();
  if (conflict) throw new ReviewRequiredError('invoice document already belongs to another operation');
  const id = await stableId('att_lbr_', `inbox:${row.id}`);
  const fileUrl = `${INBOX_FILE_BASE}${encodeURIComponent(row.id)}/file`;
  const guard = `EXISTS (SELECT 1 FROM invoice_inbox i JOIN operations o ON o.id=?
    WHERE i.id=? AND (i.deleted_at IS NULL OR i.deleted_at=0) AND i.${UNRESOLVED}
      AND (i.created_operation_id IS NULL OR i.created_operation_id=o.id)
      AND (i.matched_partner_id=? OR (i.matched_partner_id IS NULL AND i.extracted_vendor_inn=?))
      AND i.classification=? AND TRIM(i.extracted_invoice_no)=? AND i.extracted_invoice_date=? AND i.extracted_currency='RUB'
      AND ROUND(i.extracted_amount*100)=? AND i.attachment_r2_key=?
      AND (o.deleted_at IS NULL OR o.deleted_at=0) AND o.status<>'cancelled'
      AND o.partner_id=? AND o.our_company_id=? AND o.currency='RUB' AND ROUND(o.total_amount*100)=?)`;
  const args = [op.id,row.id,PARTNER,INN,row.classification,inv.number,inv.date,minor(row.extracted_amount),row.attachment_r2_key,
    PARTNER,COMPANY,minor(row.extracted_amount)];
  const out = await db.batch([
    ...(insert ? [insert] : []),
    db.prepare(`INSERT INTO operation_attachments
      (id,operation_id,direction,kind,doc_number,doc_date,amount,currency,issuer,file_url,parsed_from,source_ref_id,notes,created_at,updated_at)
      SELECT ?,?,'incoming',?,?,?,?,'RUB',?,?,'inbox',?,'F4 exact invoice match',?,?
      WHERE ${guard} AND NOT EXISTS (SELECT 1 FROM operation_attachments
        WHERE parsed_from='inbox' AND source_ref_id=? AND deleted_at IS NULL)
      ON CONFLICT(id) DO NOTHING`)
      .bind(id,op.id,row.classification === 'acceptance' ? 'act' : 'invoice',inv.number,inv.at,row.extracted_amount,row.extracted_vendor_name ?? null,fileUrl,row.id,now,now,...args,row.id),
    db.prepare(`UPDATE invoice_inbox SET created_operation_id=?,matched_partner_id=?,status='auto_attached',processed_at=?,resolved_at=?
      WHERE id=? AND ${guard} AND EXISTS (SELECT 1 FROM operation_attachments a
        WHERE a.operation_id=? AND a.source_ref_id=? AND a.parsed_from='inbox' AND a.file_url=? AND a.deleted_at IS NULL)`)
      .bind(op.id,PARTNER,now,now,row.id,...args,op.id,row.id,fileUrl),
  ]);
  return {linked:Boolean(out.at(-1).meta.changes),created:Boolean(insert && out[0].meta.changes)};
}

async function matchBank(db, tx, inv, op, now, insert) {
  const conflict = await db.prepare(`SELECT id FROM operation_attachments WHERE source_ref_id=? AND parsed_from='webhook'
    AND deleted_at IS NULL AND operation_id IS NOT NULL AND operation_id<>? LIMIT 1`).bind(tx.id,op.id).first();
  if (conflict) throw new ReviewRequiredError('bank document already belongs to another operation');
  const priorPayment = await db.prepare(`SELECT id FROM bank_transactions WHERE matched_operation_id=? AND id<>? AND ${ACTIVE} LIMIT 1`)
    .bind(op.id,tx.id).first();
  if (priorPayment) throw new ReviewRequiredError('invoice already has a bank debit; review required');
  const id = await stableId('att_lbr_', `bank:${tx.id}`);
  const out = await db.batch([
    ...(insert ? [insert] : []),
    db.prepare(`UPDATE bank_transactions SET matched_operation_id=?,match_method='auto_invno_pair',
      matched_at=?,matched_by='erp-lubertsy-invoices',updated_at=?
      WHERE id=? AND matched_operation_id IS NULL AND matched_payment_id IS NULL AND ${ACTIVE}
        AND contragent_inn=? AND direction='outgoing' AND status='Executed' AND currency='RUB' AND amount=?
        AND payment_purpose=? AND NOT EXISTS (SELECT 1 FROM bank_transactions b2 WHERE b2.matched_operation_id=?
          AND b2.id<>? AND (b2.deleted_at IS NULL OR b2.deleted_at=0))
        AND EXISTS (SELECT 1 FROM operations o WHERE o.id=? AND o.partner_id=? AND o.our_company_id=?
          AND (o.deleted_at IS NULL OR o.deleted_at=0) AND o.status<>'cancelled'
          AND o.currency='RUB' AND ROUND(o.total_amount*100)=?)`)
      .bind(op.id,now,now,tx.id,INN,tx.amount,tx.payment_purpose,op.id,tx.id,op.id,PARTNER,COMPANY,tx.amount),
    db.prepare(`UPDATE operation_attachments SET operation_id=?,updated_at=? WHERE source_ref_id=?
      AND parsed_from='webhook' AND kind='payment' AND operation_id IS NULL AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM bank_transactions WHERE id=? AND matched_operation_id=?)`)
      .bind(op.id,now,tx.id,tx.id,op.id),
    db.prepare(`INSERT INTO operation_attachments
      (id,operation_id,direction,kind,doc_number,doc_date,amount,currency,issuer,parsed_from,source_ref_id,notes,created_at,updated_at)
      SELECT ?,?,'outgoing','payment',?,?,?,'RUB',?,'webhook',?,'Executed F4 bank debit; no payment sent',?,?
      WHERE EXISTS (SELECT 1 FROM bank_transactions WHERE id=? AND matched_operation_id=?)
        AND NOT EXISTS (SELECT 1 FROM operation_attachments WHERE source_ref_id=? AND parsed_from='webhook' AND kind='payment' AND deleted_at IS NULL)
      ON CONFLICT(id) DO NOTHING`)
      .bind(id,op.id,tx.external_doc_number ?? null,tx.executed_at,tx.amount/100,tx.contragent_name ?? null,tx.id,now,now,tx.id,op.id,tx.id),
  ]);
  return {linked:Boolean(out[insert ? 1 : 0].meta.changes),created:Boolean(insert && out[0].meta.changes)};
}

export async function runLubertsyInvoices(env) {
  const now = Math.floor(Date.now()/1000);
  const result = { ok:true,review_required:0,opsCreated:0,opsLinked:0,paymentsMatched:0,created:[],linked:[],skipped:[],errors:[] };
  const rows = (await env.DB.prepare(`SELECT * FROM invoice_inbox WHERE ${ACTIVE} AND ${UNRESOLVED}
    AND classification IN ('service','acceptance')
    AND (matched_partner_id=? OR (matched_partner_id IS NULL AND extracted_vendor_inn=?))`)
    .bind(PARTNER,INN).all()).results;
  for (const row of rows) {
    try {
      const inv = identity(row.extracted_invoice_no,row.extracted_invoice_date);
      if (!inv || row.extracted_currency !== 'RUB' || minor(row.extracted_amount) === null || !row.attachment_r2_key) {
        result.skipped.push({id:row.id,reason:'invoice_identity_amount_currency_or_file_missing'}); continue;
      }
      // Stored metadata is not proof that the actual attachment still exists.
      const file = env.DOCS ? await env.DOCS.head(row.attachment_r2_key) : null;
      if (!file || !(file.size > 0)) {
        result.skipped.push({id:row.id,reason:'invoice_file_not_available'}); continue;
      }
      // Conflicting versions must not be collapsed with MAX(amount).
      const peers = rows.filter(other => other.classification === 'service' && other.extracted_invoice_no?.trim() === inv.number && other.extracted_invoice_date === inv.date);
      if (peers.some(other => other.extracted_currency !== 'RUB' || minor(other.extracted_amount) !== minor(row.extracted_amount)))
        throw new ReviewRequiredError('conflicting invoice versions; review required');
      let match;
      if (row.classification === 'acceptance') {
        const op = await findOperation(env.DB,inv);
        if (!op) { result.skipped.push({id:row.id,reason:'acceptance_requires_invoice_operation'}); continue; }
        if (minor(Number(op.total_amount)) !== minor(row.extracted_amount)) throw new ReviewRequiredError('acceptance amount conflict');
        match = {op,insert:null};
      } else match = await ensureOperation(env.DB,inv,row.extracted_amount,'issued',`F4 invoice inbox ${row.id}`,now,{kind:'inbox',row});
      const {op,insert} = match;
      const outcome = await attachInbox(env.DB,row,inv,op,now,insert);
      if (outcome.created) { result.opsCreated++; result.created.push(inv.ref); }
      if (outcome.linked) { result.opsLinked++; result.linked.push(`inbox:${row.id}`); }
      else result.skipped.push({id:row.id,reason:'invoice_changed_before_link_or_already_linked'});
    } catch(error) { recordFailure(result,row.id,'inbox',error); }
  }
  const txs = (await env.DB.prepare(`SELECT * FROM bank_transactions WHERE contragent_inn=? AND ${ACTIVE}
    AND matched_operation_id IS NULL AND matched_payment_id IS NULL AND direction='outgoing' AND currency='RUB' AND status='Executed'`)
    .bind(INN).all()).results;
  for (const tx of txs) {
    try {
      const inv = parseSingleInvoice(tx.payment_purpose ?? '');
      if (!inv || !Number.isSafeInteger(tx.amount) || tx.amount <= 0) {
        result.skipped.push({id:tx.id,reason:'bank_invoice_identity_or_amount_ambiguous'}); continue;
      }
      const {op,insert} = await ensureOperation(env.DB,inv,tx.amount/100,'draft',`Unconfirmed F4 invoice draft from executed bank debit ${tx.id}; invoice file pending`,now,{kind:'bank',row:tx});
      const outcome = await matchBank(env.DB,tx,inv,op,now,insert);
      if (outcome.created) { result.opsCreated++; result.created.push(inv.ref); }
      if (outcome.linked) { result.paymentsMatched++; result.linked.push(`bank:${tx.id}`); }
      else result.skipped.push({id:tx.id,reason:'bank_changed_before_link_or_already_linked'});
    } catch(error) { recordFailure(result,tx.id,'bank',error); }
  }
  result.review_required = result.skipped.filter(row => row.review_required === true).length;
  result.ok = result.errors.length === 0;
  return result;
}
