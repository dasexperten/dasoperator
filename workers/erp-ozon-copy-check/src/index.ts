const worker = 'erp-ozon-copy-check';
const cron = '0 5 * * *';
const dayOf = (time: number) => new Date(time + 4 * 3600000).toISOString().slice(0, 10);
const reply = (value: unknown, status = 200) => Response.json(value, {status,headers:{'Cache-Control':'no-store'}});
const skuValid = (value: unknown) => typeof value === 'string' && /^\d{4,18}$/.test(value);
const okText = (x: unknown, max: number) => typeof x === 'string' && x.trim().length > 0 && x.length <= max;
type Env = {DB: D1Database, DEVICE_TOKEN?: string};

async function enqueue(db: D1Database, time: number) {
  const day = dayOf(time);
  const when = new Date(time).toISOString();
  await db.batch([
    db.prepare('INSERT OR IGNORE INTO ozon_copy_days(day) VALUES(?)').bind(day),
    db.prepare(`INSERT OR IGNORE INTO erp_cron_runs(worker,cron,started_at,finished_at,ok,rows,note,run_key)
      VALUES(?,?,?,?,1,1,'Задание создано. Ожидается обход в Яндексе.',?)`).bind(worker,cron,when,when,worker+':'+day)
  ]);
  return {day};
}

async function handle(request: Request, env: Env) {
  const path = new URL(request.url).pathname;
  const db = env.DB.withSession('first-primary');
  if (path === '/health') return reply({worker,cron});
  if (!env.DEVICE_TOKEN || request.headers.get('Authorization') !== 'Bearer '+env.DEVICE_TOKEN)
    return reply({error:'unauthorized'},401);
  if (request.method === 'GET' && path === '/tickets')
    return reply((await db.prepare('SELECT sku,original_sku,seller,evidence,reserved_at,ticket,thread FROM ozon_copy_tickets ORDER BY reserved_at DESC').all()).results);
  if (request.method === 'GET' && path === '/job') {
    const row = await db.prepare('SELECT day,catalog FROM ozon_copy_days WHERE finished_at IS NULL AND day=?').bind(dayOf(Date.now())).first<{day:string,catalog:string|null}>();
    if (!row) return reply({day:null});
    const cards = (await db.prepare('SELECT sku,status,detail FROM ozon_copy_cards WHERE day=?').bind(row.day).all()).results;
    return reply({day:row.day,skus:row.catalog ? JSON.parse(row.catalog) : null,cards});
  }
  if (request.method !== 'POST') return reply({error:'unknown operation'},404);
  if (path === '/run') return reply(await enqueue(env.DB,Date.now()));
  if (!['/catalog','/card','/reserve','/ticket','/finish'].includes(path)) return reply({error:'unknown operation'},404);
  const b = await request.json<any>();
  if (!b || typeof b.day !== 'string') return reply({error:'day required'},400);
  const run = await db.prepare('SELECT catalog,finished_at FROM ozon_copy_days WHERE day=?').bind(b.day).first<{catalog:string|null,finished_at:string|null}>();
  if (!run || run.finished_at) return reply({error:'no open job for date'},409);
  if (path === '/catalog') {
    if (!Array.isArray(b.skus) || !b.skus.length || b.skus.length>10000 || !b.skus.every(skuValid))
      return reply({error:'a complete nonempty SKU list is required'},400);
    const catalog = JSON.stringify([...new Set(b.skus)].sort());
    const result = await db.prepare('UPDATE ozon_copy_days SET catalog=? WHERE day=? AND (catalog IS NULL OR catalog=?)').bind(catalog,b.day,catalog).run();
    return result.meta.changes ? reply({total:JSON.parse(catalog).length}) : reply({error:'catalog already frozen'},409);
  }
  if (!run.catalog) return reply({error:'record the live catalog first'},409);
  const skus: string[] = JSON.parse(run.catalog);
  if (path === '/card') {
    if (!skus.includes(b.sku) || !['checked','error','unread'].includes(b.status) || !okText(b.detail,12000)) return reply({error:'invalid card'},400);
    await db.batch([db.prepare(`INSERT INTO ozon_copy_cards(day,sku,status,detail) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM ozon_copy_days WHERE day=? AND finished_at IS NULL)
      ON CONFLICT(day,sku) DO UPDATE SET status=excluded.status,detail=excluded.detail,updated_at=CURRENT_TIMESTAMP
      WHERE ozon_copy_cards.status<>'checked' OR excluded.status='checked'`).bind(b.day,b.sku,b.status,b.detail,b.day),
      db.prepare(`UPDATE erp_cron_runs SET rows=(SELECT COUNT(*) FROM ozon_copy_cards WHERE day=? AND status='checked'),
      note=printf('Проверено %d из %d. Требуют повторной проверки: %d.',
        (SELECT COUNT(*) FROM ozon_copy_cards WHERE day=? AND status='checked'),?,
        (SELECT COUNT(*) FROM ozon_copy_cards WHERE day=? AND status<>'checked')) WHERE run_key=?`)
        .bind(b.day,b.day,skus.length,b.day,worker+':'+b.day)
    ]);
    return reply({saved:b.sku});
  }
  if (path === '/reserve') {
    if (!skus.includes(b.originalSku) || !skuValid(b.sku) || skus.includes(b.sku) || !okText(b.evidence,10000) || !okText(b.seller,512)) return reply({error:'confirmed competing offer and evidence required'},400);
    const token = crypto.randomUUID();
    const result = await db.prepare(`INSERT INTO ozon_copy_tickets(sku,original_sku,seller,evidence,token) VALUES(?,?,?,?,?)
      ON CONFLICT(sku) DO NOTHING`).bind(b.sku,b.originalSku,b.seller,b.evidence,token).run();
    if (result.meta.changes) return reply({acquired:true,token});
    const old = await db.prepare('SELECT sku,original_sku,seller,ticket FROM ozon_copy_tickets WHERE sku=?').bind(b.sku).first();
    return reply({acquired:false,existing:old});
  }
  if (path === '/ticket') {
    if (!skuValid(b.sku) || !skuValid(b.ticket)) return reply({error:'numeric SKU and ticket required'},400);
    // Recovery requires the operator to verify the actual Ozon thread for this SKU.
    const expected = 'https://seller.ozon.ru/app/messenger';
    const found = typeof b.thread === 'string' && b.thread.startsWith(expected+'?') && new URL(b.thread).searchParams.has('id');
    if (!found) return reply({error:'verified support thread required'},400);
    const [res] = await db.batch([db.prepare(`UPDATE ozon_copy_tickets SET ticket=?,thread=? WHERE sku=? AND
      (ticket IS NULL OR ticket=?) AND (token=? OR ?=1)`).bind(b.ticket,b.thread,b.sku,b.ticket,b.token || '',Number(b.reconciled === true)),
      db.prepare(`INSERT OR IGNORE INTO erp_cron_runs(worker,cron,started_at,finished_at,ok,rows,note,run_key)
        SELECT ?, 'manual', ?, ?, 1, 1, 'Ozon №' || ticket || ' · ' || seller || ' · SKU ' || sku, ? || ticket
        FROM ozon_copy_tickets WHERE sku=? AND ticket=?`)
        .bind(worker,new Date().toISOString(),new Date().toISOString(),worker+':ticket:',b.sku,b.ticket)
    ]);
    return res.meta.changes ? reply({sku:b.sku,ticket:b.ticket}) : reply({error:'missing reservation or ticket conflict'},409);
  }
  const stats = await db.prepare(`SELECT count(*) checked FROM ozon_copy_cards WHERE day=? AND status='checked'`).bind(b.day).first<{checked:number}>();
  if (stats?.checked !== skus.length) return reply({error:'incomplete coverage',checked:stats?.checked,total:skus.length},409);
  const note = 'Проверено карточек: '+skus.length;
  await db.batch([
    db.prepare('UPDATE ozon_copy_days SET finished_at=CURRENT_TIMESTAMP WHERE day=?').bind(b.day),
    db.prepare('UPDATE erp_cron_runs SET rows=?,note=? WHERE run_key=?').bind(skus.length,note,worker+':'+b.day)
  ]);
  return reply({finished:true,total:skus.length});
}
export default {
  async scheduled(event: ScheduledController, env: Env) { await enqueue(env.DB,event.scheduledTime); },
  async fetch(request: Request, env: Env) {
    try { return await handle(request,env); }
    catch (e) { return reply({error:e instanceof SyntaxError?'invalid JSON':'ERP operation failed'}, e instanceof SyntaxError?400:500); }
  }
};
