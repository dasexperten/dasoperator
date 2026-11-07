// Allocate only the unspent remainder of a received marketplace bank transaction.
// Existing payment rows (manual, inbox, webhook and FIFO alike) conserve cash.
// Read-only planning is separate from conditional, atomic application.
import type { Env } from '../types';

const PARTNER_ALIASES: Record<string, string> = {
  // 7704217370 → ozon already maps via partners.tax_id directly
  // 9714053621 → wb already maps via partners.tax_id directly
  // 9705212635 → яндекс_пей_продажи_с_нашего_сайта already maps directly
  '9703026898': 'ozon', // OZON MKK Credit pays for Ozon sales
  '7802754982': 'ozon', // Sberbank Factoring — pays for ИНН 7704217370 (Ozon) via factoring
  '7702045051': 'ozon', // MTS-Bank — pays for contract ИР-34138/22 (Ozon factoring)
};

const PARTNER_NAME_ALIASES: Record<string, string> = {
  'NETWORK INTERNATIONAL LLC': 'dasexperten_com', // Stripe via Wio → dasexperten.com online sales
};

const SUPPORTED_PARTNERS = [
  'ozon',
  'wb',
  'яндекс_пей_продажи_с_нашего_сайта',
  'dasexperten_com',
];


const NO_SUBDIVISION = new Set(['VND','JPY','KRW']);
const MAX_MINOR = Number.MAX_SAFE_INTEGER;
const PARKED = "'awaiting_marketplace_settlement','awaiting_invoice','awaiting_site_sales_settlement'";
const PARTIAL = 'partially_allocated_marketplace_fifo';
const FULL = 'auto_allocated_marketplace_fifo';
const ACTIVE = '(deleted_at IS NULL OR deleted_at=0)';
const ELIGIBLE = `(match_method='${PARTIAL}' OR (matched_operation_id IS NULL AND match_method IN (${PARKED})))`;

interface BankTx {
  id:string; amount:number; currency:string; executed_at:number; direction:string;
  payment_purpose:string|null; contragent_name:string|null; contragent_inn:string|null;
  external_doc_number:string|null; match_method:string|null; matched_operation_id:string|null;
  matched_payment_id:string|null; matched_by:string|null;
}
interface SaleOp { id:string; reference:string; total_amount:number; currency:string; operation_date:number; }
interface Payment { id:string; operation_id:string|null; source_ref_id:string|null; amount:number|null;
  currency:string|null; direction:string|null; deleted_at:number|null; }
interface LegacyPayment {id:string;operation_id:string|null;notes:string|null;}
interface Ledger { paid:number; active:number; all:number; problem:string|null; }
interface Allocation {
  id:string; tx:BankTx; op:SaleOp; amount_minor:number;
  tx_paid_before:number; tx_active_before:number; tx_all_before:number;
  op_paid_before:number; op_active_before:number; op_all_before:number;
}
export interface MarketplaceFifoPlan {
  partner_id:string; currency:string; minor_factor:number;
  transactions:Array<{tx_id:string;amount_minor:number;allocated_minor:number|null;available_minor:number|null}>;
  allocations:Allocation[];
  reconciliations:Array<{tx:BankTx;ledger:Ledger}>;
  review:Array<{id:string;reason:string;scope:'transaction'|'operation'}>;
  leftover_minor:number;
}
export interface MarketplaceAllocatorResult {
  partner_id:string; payments_processed:number; allocations_created:number;
  ops_fully_closed:string[]; ops_partially_paid:string[]; leftover_amount_major:number|null; known_leftover_amount_major:number;
  review_required:number; review_transactions:number; review_operations:number; review:MarketplaceFifoPlan['review']; stale_allocations:number;
}

// Parse the stored decimal representation, never round a fractional kopek up.
function toMinor(value:number|null, factor:number):number|null {
  if (typeof value!=='number' || !Number.isFinite(value) || value<0) return null;
  const places=factor===1?0:2;
  const match=/^(\d+)(?:\.(\d+))?$/.exec(String(value));
  if (!match || (match[2]?.length??0)>places) return null;
  const n=BigInt(match[1])*BigInt(factor)+BigInt((match[2]??'').padEnd(places,'0')||'0');
  return n<=BigInt(MAX_MINOR)?Number(n):null;
}
function ledger(rows:Payment[],currency:string,factor:number,source:boolean):Ledger {
  let paid=0,active=0;
  for(const row of rows) {
    if(row.deleted_at!==null && row.deleted_at!==0) continue;
    active++;
    if(source && !row.operation_id) return {paid,active,all:rows.length,problem:'unassigned_payment_evidence'};
    if(row.currency!==currency || row.direction!=='incoming') return {paid,active,all:rows.length,problem:'payment_currency_or_direction_conflict'};
    const amount=toMinor(row.amount,factor);
    if(amount===null || !Number.isSafeInteger(paid+amount)) return {paid,active,all:rows.length,problem:'invalid_payment_minor_units'};
    paid+=amount;
  }
  return {paid,active,all:rows.length,problem:null};
}
async function allocationId(tx:BankTx,op:SaleOp,cash:Ledger,paid:Ledger,amount:number) {
  const key=JSON.stringify([tx.id,op.id,cash.paid,cash.active,cash.all,paid.paid,paid.active,paid.all,amount]);
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)));
  return 'att_fifo_'+[...bytes].map(v=>v.toString(16).padStart(2,'0')).join('');
}

/** SELECT-only snapshot; safe for audit adapters whose run/batch methods throw. */
export async function planMarketplaceFifoForPartner(env:Env,partnerId:string):Promise<MarketplaceFifoPlan> {
  const partner=await env.DB.prepare('SELECT id,tax_id,currency FROM partners WHERE id=? AND deleted_at IS NULL')
    .bind(partnerId).first<{id:string;tax_id:string;currency:string|null}>();
  const currency=partner?.currency||'RUB',factor=NO_SUBDIVISION.has(currency)?1:100;
  const plan:MarketplaceFifoPlan={partner_id:partnerId,currency,minor_factor:factor,transactions:[],allocations:[],reconciliations:[],review:[],leftover_minor:0};
  if(!partner?.tax_id)return plan;
  const inns=[partner.tax_id,...Object.entries(PARTNER_ALIASES).filter(([,p])=>p===partnerId).map(([inn])=>inn)];
  const names=Object.entries(PARTNER_NAME_ALIASES).filter(([,p])=>p===partnerId).map(([name])=>name);
  const sender=`(contragent_inn IN (${inns.map(()=>'?').join(',')})${names.length?` OR (contragent_inn IS NULL AND contragent_name IN (${names.map(()=>'?').join(',')}))`:''})`;
  const txWhere=`${ACTIVE} AND ${ELIGIBLE} AND direction='incoming' AND status='Received' AND ${sender} AND currency=?`;
  const txParams=[...inns,...names,currency];
  const opWhere=`partner_id=? AND operation_type='sale' AND ${ACTIVE} AND status IN ('issued','shipped','delivered') AND total_amount>0 AND currency=?`;
  const txs=(await env.DB.prepare(`SELECT id,amount,currency,executed_at,direction,payment_purpose,contragent_name,contragent_inn,external_doc_number,match_method,matched_operation_id,matched_payment_id,matched_by FROM bank_transactions WHERE ${txWhere} ORDER BY executed_at,id`).bind(...txParams).all<BankTx>()).results;
  if(!txs.length)return plan;
  const ops=(await env.DB.prepare(`SELECT id,reference,total_amount,currency,operation_date FROM operations WHERE ${opWhere} ORDER BY operation_date,id`).bind(partnerId,currency).all<SaleOp>()).results;
  // Bulk reads include tombstones for allocation-ID generations, but only live
  // payment allocations reduce cash. They never filter by parsed_from or partner.
  const cashRows=(await env.DB.prepare(`SELECT id,operation_id,source_ref_id,amount,currency,direction,deleted_at FROM operation_attachments
    WHERE kind='payment' AND source_ref_id IN (SELECT id FROM bank_transactions WHERE ${txWhere})`).bind(...txParams).all<Payment>()).results;
  const opRows=(await env.DB.prepare(`SELECT id,operation_id,source_ref_id,amount,currency,direction,deleted_at FROM operation_attachments
    WHERE kind='payment' AND operation_id IN (SELECT id FROM operations WHERE ${opWhere})`).bind(partnerId,currency).all<Payment>()).results;
  // The legacy payments table is a second settlement layer, not extra cash.
  // Do not sum it with attachments or decide which representation is canonical.
  const legacy=(await env.DB.prepare(`SELECT id,operation_id,notes FROM payments p WHERE (p.deleted_at IS NULL OR p.deleted_at=0)
    AND (p.partner_id=? OR p.operation_id IN (SELECT id FROM operations WHERE ${opWhere})
      OR p.operation_id IN (SELECT operation_id FROM operation_attachments WHERE kind='payment'
        AND source_ref_id IN (SELECT id FROM bank_transactions WHERE ${txWhere}))
      OR EXISTS (SELECT 1 FROM bank_transactions WHERE ${txWhere} AND instr(COALESCE(p.notes,''),id)>0))`)
    .bind(partnerId,partnerId,currency,...txParams,...txParams).all<LegacyPayment>()).results;
  const payable:Array<{op:SaleOp;total:number;ledger:Ledger}>=[];
  for(const op of ops) {
    const total=toMinor(op.total_amount,factor),paid=ledger(opRows.filter(row=>row.operation_id===op.id),currency,factor,false);
    const problem=legacy.some(row=>row.operation_id===op.id)?'legacy_operation_settlement_requires_review'
      :total===null?'invalid_operation_minor_units':paid.problem||(paid.paid>total?'operation_overallocated':null);
    if(problem){plan.review.push({id:op.id,reason:problem,scope:'operation'});continue;}
    if(paid.paid<total!)payable.push({op,total:total!,ledger:paid});
  }
  let cursor=0;
  for(const tx of txs) {
    const cash=ledger(cashRows.filter(row=>row.source_ref_id===tx.id),currency,factor,true);
    const problem=!Number.isSafeInteger(tx.amount)||tx.amount<=0?'invalid_bank_minor_units'
      :(tx.matched_payment_id?'manual_bank_payment_link':null)
      ||(tx.match_method===PARTIAL && tx.matched_by && tx.matched_by!=='system_fifo'?'manual_bank_match':null)
      ||(legacy.some(row=>row.notes?.includes(tx.id))?'legacy_bank_settlement_requires_review':null)
      ||(cashRows.some(row=>(row.deleted_at===null||row.deleted_at===0) && row.source_ref_id===tx.id
        && row.operation_id && legacy.some(payment=>payment.operation_id===row.operation_id))?'legacy_allocated_operation_requires_review':null)
      ||cash.problem||(cash.paid>tx.amount?'transaction_overallocated':null);
    if(problem){plan.transactions.push({tx_id:tx.id,amount_minor:tx.amount,allocated_minor:cash.problem?null:cash.paid,available_minor:null});plan.review.push({id:tx.id,reason:problem,scope:'transaction'});continue;}
    let remaining=tx.amount-cash.paid;
    plan.transactions.push({tx_id:tx.id,amount_minor:tx.amount,allocated_minor:cash.paid,available_minor:remaining});
    if(remaining===0){if(tx.match_method===PARTIAL)plan.reconciliations.push({tx,ledger:{...cash}});continue;}
    while(remaining>0 && cursor<payable.length) {
      const target=payable[cursor],amount=Math.min(remaining,target.total-target.ledger.paid);
      const id=await allocationId(tx,target.op,cash,target.ledger,amount);
      plan.allocations.push({id,tx:{...tx},op:target.op,amount_minor:amount,
        tx_paid_before:cash.paid,tx_active_before:cash.active,tx_all_before:cash.all,
        op_paid_before:target.ledger.paid,op_active_before:target.ledger.active,op_all_before:target.ledger.all});
      remaining-=amount;cash.paid+=amount;cash.active++;cash.all++;
      tx.matched_operation_id=target.op.id;tx.match_method=remaining===0?FULL:PARTIAL;tx.matched_by='system_fifo';
      target.ledger.paid+=amount;target.ledger.active++;target.ledger.all++;
      if(target.ledger.paid===target.total)cursor++;
    }
    if(!Number.isSafeInteger(plan.leftover_minor+remaining))throw Error('FIFO leftover exceeds safe minor units');
    plan.leftover_minor+=remaining;
  }
  return plan;
}

// Integer sums are checked again by SQLite at the write boundary. ROUND is only
// representation conversion: rows with fractional minor units are rejected.
function ledgerGuard(expectedSum:number,activeCount:number,allCount:number,source:boolean) {
  const clause=source?'source_ref_id=?1':'operation_id=?2';
  const active=`(${clause}) AND kind='payment' AND ${ACTIVE}`;
  const valid=`currency IS NOT NULL AND currency=?4 AND direction IS NOT NULL AND direction='incoming' AND amount IS NOT NULL AND typeof(amount) IN ('integer','real')
    AND amount>=0 AND amount<=${MAX_MINOR}/?5 AND ROUND(amount,?6)=amount${source?' AND operation_id IS NOT NULL':''}`;
  return `NOT EXISTS (SELECT 1 FROM operation_attachments WHERE ${active} AND (${valid}) IS NOT TRUE)
    AND (SELECT COALESCE(SUM(CAST(ROUND(amount*?5) AS INTEGER)),0) FROM operation_attachments WHERE ${active})=${expectedSum}
    AND (SELECT COUNT(*) FROM operation_attachments WHERE ${active})=${activeCount}
    AND (SELECT COUNT(*) FROM operation_attachments WHERE (${clause}) AND kind='payment')=${allCount}`;
}
function bindings(a:Allocation,partner:string,factor:number,now:number) {
  return [a.tx.id,a.op.id,partner,a.tx.currency,factor,factor===1?0:2,a.tx.amount,a.op.total_amount,
    a.tx_paid_before,a.tx_active_before,a.tx_all_before,a.op_paid_before,a.op_active_before,a.op_all_before,
    a.amount_minor,a.id,a.tx.contragent_inn,a.tx.contragent_name,a.tx.executed_at,a.tx.external_doc_number,
    a.tx.payment_purpose,a.tx.contragent_name||'marketplace',
    `[FIFO marketplace alloc] ${a.amount_minor} minor units from tx ${a.tx.id} -> ${a.op.reference}`,now,
    a.tx.matched_operation_id,a.tx.match_method,a.tx.matched_by];
}

export async function runMarketplaceFifoForPartner(env:Env,partnerId:string):Promise<MarketplaceAllocatorResult> {
  const plan=await planMarketplaceFifoForPartner(env,partnerId),factor=plan.minor_factor;
  const result:MarketplaceAllocatorResult={partner_id:partnerId,payments_processed:0,allocations_created:0,
    ops_fully_closed:[],ops_partially_paid:[],leftover_amount_major:plan.leftover_minor/factor,known_leftover_amount_major:plan.leftover_minor/factor,
    review_required:plan.review.length,review_transactions:0,review_operations:0,review:[...plan.review],stale_allocations:0};
  const processed=new Set<string>(),closed=new Set<string>(),partial=new Set<string>();
  for(const a of plan.allocations) {
    const now=Math.floor(Date.now()/1000);
    const sourceGuard=ledgerGuard(a.tx_paid_before,a.tx_active_before,a.tx_all_before,true);
    const opGuard=ledgerGuard(a.op_paid_before,a.op_active_before,a.op_all_before,false);
    const args=bindings(a,partnerId,factor,now);
    const applied=await env.DB.batch([
      env.DB.prepare(`INSERT INTO operation_attachments
        (id,operation_id,direction,kind,doc_number,doc_date,amount,currency,issuer,parsed_from,source_ref_id,notes,created_at,updated_at)
        SELECT ?16,o.id,'incoming','payment',bt.external_doc_number,bt.executed_at,?15*1.0/?5,?4,?22,'bank_tx',bt.id,?23,?24,?24
        FROM bank_transactions bt JOIN operations o ON o.id=?2
        WHERE bt.id=?1 AND (bt.deleted_at IS NULL OR bt.deleted_at=0) AND (bt.match_method='${PARTIAL}' OR (bt.matched_operation_id IS NULL AND bt.match_method IN (${PARKED})))
          AND bt.direction='incoming' AND bt.status='Received' AND bt.currency=?4 AND bt.amount=?7 AND bt.matched_payment_id IS NULL
          AND (bt.matched_by IS NULL OR bt.match_method<>'${PARTIAL}' OR bt.matched_by='system_fifo')
          AND bt.matched_operation_id IS ?25 AND bt.match_method IS ?26 AND bt.matched_by IS ?27
          AND bt.contragent_inn IS ?17 AND bt.contragent_name IS ?18 AND bt.executed_at=?19
          AND bt.external_doc_number IS ?20 AND bt.payment_purpose IS ?21
          AND o.partner_id=?3 AND o.operation_type='sale' AND (o.deleted_at IS NULL OR o.deleted_at=0) AND o.status IN ('issued','shipped','delivered')
          AND o.currency=?4 AND o.total_amount=?8 AND ?15>0 AND ?9+?15<=bt.amount
          AND ?12+?15<=CAST(ROUND(o.total_amount*?5) AS INTEGER)
          AND NOT EXISTS (SELECT 1 FROM payments WHERE operation_id=o.id AND ${ACTIVE})
          AND NOT EXISTS (SELECT 1 FROM payments WHERE ${ACTIVE} AND
            (instr(COALESCE(notes,''),bt.id)>0 OR operation_id IN (SELECT operation_id FROM operation_attachments
              WHERE source_ref_id=bt.id AND kind='payment' AND ${ACTIVE})))
          AND ${sourceGuard} AND ${opGuard}
        ON CONFLICT(id) DO NOTHING`).bind(...args),
      env.DB.prepare(`UPDATE bank_transactions SET matched_operation_id=?2,
        match_method=CASE WHEN ?9+?15=amount THEN '${FULL}' ELSE '${PARTIAL}' END,
        matched_at=?24,matched_by='system_fifo',updated_at=?24
        WHERE id=?1 AND ${ACTIVE} AND ${ELIGIBLE} AND amount=?7 AND currency=?4 AND direction='incoming' AND status='Received'
          AND matched_operation_id IS ?25 AND match_method IS ?26 AND matched_by IS ?27
          AND matched_payment_id IS NULL AND (contragent_inn IS ?17) AND (contragent_name IS ?18)
          AND EXISTS (SELECT 1 FROM operation_attachments WHERE id=?16 AND operation_id=?2 AND source_ref_id=?1
            AND kind='payment' AND amount=?15*1.0/?5 AND ${ACTIVE})
          AND ${ledgerGuard(a.tx_paid_before+a.amount_minor,a.tx_active_before+1,a.tx_all_before+1,true)}`)
        .bind(...args),
    ]);
    if(!applied[0].meta.changes){result.stale_allocations++;continue;}
    processed.add(a.tx.id);result.allocations_created++;
    if(a.op_paid_before+a.amount_minor===toMinor(a.op.total_amount,factor)){closed.add(a.op.reference);partial.delete(a.op.reference);}
    else partial.add(a.op.reference);
  }
  for(const {tx,ledger:paid} of plan.reconciliations) {
    // A legacy partial label with zero remaining cash needs no new attachment.
    const stub:Allocation={id:'',tx,op:{id:'',reference:'',total_amount:0,currency:plan.currency,operation_date:0},amount_minor:0,
      tx_paid_before:paid.paid,tx_active_before:paid.active,tx_all_before:paid.all,op_paid_before:0,op_active_before:0,op_all_before:0};
    const changed=await env.DB.prepare(`UPDATE bank_transactions SET match_method='${FULL}',updated_at=?24
      WHERE id=?1 AND ${ACTIVE} AND match_method='${PARTIAL}' AND matched_payment_id IS NULL
        AND amount=?7 AND currency=?4 AND direction='incoming' AND status='Received'
        AND matched_operation_id IS ?25 AND match_method IS ?26 AND matched_by IS ?27
        AND (matched_by IS NULL OR matched_by='system_fifo') AND contragent_inn IS ?17 AND contragent_name IS ?18
        AND NOT EXISTS (SELECT 1 FROM payments WHERE ${ACTIVE} AND
          (instr(COALESCE(notes,''),?1)>0 OR operation_id IN (SELECT operation_id FROM operation_attachments
            WHERE source_ref_id=?1 AND kind='payment' AND ${ACTIVE})))
        AND ${ledgerGuard(paid.paid,paid.active,paid.all,true)}`)
      .bind(...bindings(stub,partnerId,factor,Math.floor(Date.now()/1000))).run();
    if(changed.meta.changes)processed.add(tx.id);
  }
  if(result.stale_allocations) {
    // A concurrent manual change invalidated this snapshot. Report the remaining
    // known cash, not the old plan's hypothetical post-allocation balance.
    const fresh=await planMarketplaceFifoForPartner(env,partnerId);
    const remaining=fresh.transactions.reduce((sum,tx)=>sum+(tx.available_minor??0),0);
    if(!Number.isSafeInteger(remaining))throw Error('FIFO remainder exceeds safe minor units');
    result.known_leftover_amount_major=remaining/factor;
    const reviews=new Map(result.review.map(row=>[`${row.scope}:${row.id}:${row.reason}`,row]));
    for(const row of fresh.review)reviews.set(`${row.scope}:${row.id}:${row.reason}`,row);
    result.review=[...reviews.values()];
  }
  result.review_required=result.review.length;
  result.review_transactions=new Set(result.review.filter(row=>row.scope==='transaction').map(row=>row.id)).size;
  result.review_operations=new Set(result.review.filter(row=>row.scope==='operation').map(row=>row.id)).size;
  // Unresolved legacy cash is unknown; zero only describes the known subset.
  result.leftover_amount_major=result.review_transactions?null:result.known_leftover_amount_major;
  result.payments_processed=processed.size;
  result.ops_fully_closed=[...closed];result.ops_partially_paid=[...partial];
  return result;
}
export async function runMarketplaceFifoAll(env:Env):Promise<MarketplaceAllocatorResult[]> {
  const results:MarketplaceAllocatorResult[]=[];
  for(const partner of SUPPORTED_PARTNERS)results.push(await runMarketplaceFifoForPartner(env,partner));
  return results;
}
export async function planMarketplaceFifoAll(env:Env):Promise<MarketplaceFifoPlan[]> {
  const results:MarketplaceFifoPlan[]=[];
  for(const partner of SUPPORTED_PARTNERS)results.push(await planMarketplaceFifoForPartner(env,partner));
  return results;
}
