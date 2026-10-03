// Default: repair only unit rounding. The explicit rebill mode corrects two
// audited weeks whose stored components have no unallocated penalty pool.
// Payments/documents and concurrent/manual changes always prevent rewriting.
const snapshotSql = `SELECT json_group_array(json_object(
  'payout',payout,'logistics',logistics,'penalty',penalty,'acceptance',acceptance,
  'rebill',rebill_logistic,'storage',storage_share,'deduction',advert_share,
  'pnl_id',pnl_id,'product_id',product_id,'qty',qty,'net_total',net_total,'net_per',net_per,
  'line_id',line_id,'line_qty',line_qty,'unit_price',unit_price,
  'unit_price_after_disc',unit_price_after_disc,'line_amount',line_amount,'discount_pct',discount_pct))
  FROM (SELECT p.payout,p.logistics,p.penalty,p.acceptance,p.rebill_logistic,p.storage_share,p.advert_share,p.id pnl_id,p.product_id,p.qty,p.net_total,p.net_per,l.id line_id,
    l.qty line_qty,l.unit_price,l.unit_price_after_disc,l.line_amount,l.discount_pct
    FROM marketplace_pnl_lines p LEFT JOIN line_items l
      ON l.operation_id=p.operation_id AND l.product_id=p.product_id
    WHERE p.operation_id=? AND p.marketplace='wb' ORDER BY p.id,l.id)`;

export async function reconcileWbSettlementRounding(db: D1Database, id: string, mode: 'rounding' | 'rebill' = 'rounding') {
  if (!/^op_wb_\d{6}_weekly$/.test(id)) throw new Error('Not an automatic WB weekly settlement');
  if (mode === 'rebill' && !['op_wb_260920_weekly','op_wb_260927_weekly'].includes(id)) {
    throw new Error('Rebill correction requires an audited settlement');
  }
  const op = await db.prepare(`SELECT total_amount,updated_at FROM operations
    WHERE id=? AND partner_id='wb' AND currency='RUB' AND deleted_at IS NULL`).bind(id)
    .first<{total_amount:number;updated_at:number}>();
  if (!op) throw new Error('WB operation not found');
  const linksSql = `SELECT
    (SELECT COUNT(*) FROM payments WHERE operation_id=? AND deleted_at IS NULL) +
    (SELECT COUNT(*) FROM documents WHERE operation_id=?) AS n`;
  const links = await db.prepare(linksSql).bind(id,id).first<{n:number}>();
  if (links?.n) throw new Error('Linked payments or documents require separate reconciliation');
  const snapshot = await db.prepare(`SELECT (${snapshotSql}) AS value`).bind(id).first<{value:string}>();
  const rows = JSON.parse(snapshot?.value || '[]');
  const lineCount = await db.prepare('SELECT COUNT(*) n FROM line_items WHERE operation_id=?').bind(id).first<{n:number}>();
  if (!rows.length || lineCount?.n !== rows.length || new Set(rows.map((r:any)=>r.line_id)).size !== rows.length) {
    throw new Error('Incomplete or duplicate settlement lines');
  }
  let oldTotal = 0, newMinor = 0;
  // SQLite JSON renders REAL values with fewer significant digits than JS.
  const sameAverage = (a:number,b:number) => Math.abs(a-b) <= 1e-12 * Math.max(1,Math.abs(a),Math.abs(b));
  for (const r of rows) {
    if (!r.line_id || !Number.isSafeInteger(r.qty) || r.qty <= 0 || r.line_qty !== r.qty
        || ![r.net_total,r.net_per,r.unit_price,r.unit_price_after_disc,r.line_amount].every(Number.isFinite)
        || Number(r.discount_pct || 0) !== 0) throw new Error('Invalid settlement line');
    r.new_net = r.net_total;
    if (mode === 'rebill') {
      if (![r.payout,r.logistics,r.penalty,r.acceptance,r.rebill,r.storage,r.deduction].every(Number.isFinite)) {
        throw new Error('Incomplete financial components');
      }
      const neutral = r.payout-r.logistics-r.penalty-r.acceptance-r.storage-r.deduction;
      // A different residual could represent a pooled charge or manual adjustment;
      // never infer its meaning. These two weeks were independently audited.
      if (!sameAverage(r.net_total,neutral+r.rebill) && !sameAverage(r.net_total,neutral)) {
        throw new Error('Unexpected settlement formula');
      }
      r.new_net = neutral;
    }
    const cents = Math.round(r.new_net * 100);
    if (!Number.isSafeInteger(cents)) throw new Error('Invalid settlement amount');
    r.new_amount = cents / 100;
    r.new_unit = r.new_net / r.qty;
    const currentUnit = r.net_total / r.qty;
    const oldUnit = Math.round(r.net_total / r.qty);
    const legacy = r.net_per === oldUnit && r.unit_price === oldUnit
      && r.unit_price_after_disc === oldUnit && r.line_amount === r.qty * oldUnit;
    const currentRounded = sameAverage(r.net_per,currentUnit) && sameAverage(r.unit_price,currentUnit)
      && sameAverage(r.unit_price_after_disc,currentUnit) && r.line_amount === Math.round(r.net_total*100)/100;
    const corrected = currentRounded && sameAverage(r.net_total,r.new_net);
    r.corrected = corrected;
    if (!legacy && !currentRounded) throw new Error('Settlement has manual or unexpected line changes');
    oldTotal += r.line_amount;
    newMinor += cents;
  }
  if (Math.abs(oldTotal-op.total_amount)>0.000001) throw new Error('Operation does not match its lines');
  const newTotal = newMinor / 100;
  if (rows.every((r:any)=>r.corrected)) {
    return { operation_id:id,changed:false,before_rub:op.total_amount,after_rub:newTotal,lines:rows.length };
  }

  // D1 batch is transactional. json() deliberately rejects the non-JSON branch:
  // a concurrent change aborts the entire batch before any financial write.
  const guard = db.prepare(`SELECT json(CASE WHEN
    EXISTS(SELECT 1 FROM operations WHERE id=? AND total_amount=? AND updated_at=?
      AND partner_id='wb' AND currency='RUB' AND deleted_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM payments WHERE operation_id=? AND deleted_at IS NULL)
    AND NOT EXISTS(SELECT 1 FROM documents WHERE operation_id=?)
    AND (SELECT COUNT(*) FROM line_items WHERE operation_id=?)=?
    AND (${snapshotSql})=?
    THEN '{}' ELSE 'settlement changed during reconciliation' END)`)
    .bind(id,op.total_amount,op.updated_at,id,id,id,rows.length,id,snapshot!.value);
  const now = Math.floor(Date.now()/1000);
  const statements = [guard];
  for (const r of rows) {
    statements.push(db.prepare(`UPDATE line_items SET unit_price=?,unit_price_after_disc=?,line_amount=?,updated_at=? WHERE id=?`)
      .bind(r.new_unit,r.new_unit,r.new_amount,now,r.line_id));
    statements.push(mode === 'rebill'
      ? db.prepare('UPDATE marketplace_pnl_lines SET net_per=?,net_total=? WHERE id=?').bind(r.new_unit,r.new_net,r.pnl_id)
      : db.prepare('UPDATE marketplace_pnl_lines SET net_per=? WHERE id=?').bind(r.new_unit,r.pnl_id));
  }
  statements.push(db.prepare('UPDATE operations SET total_amount=?,updated_at=? WHERE id=?').bind(newTotal,now,id));
  await db.batch(statements);
  return { operation_id:id,changed:true,before_rub:op.total_amount,after_rub:newTotal,lines:rows.length };
}
