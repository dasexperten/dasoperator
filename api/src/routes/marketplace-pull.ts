import { Hono } from 'hono';
import type { Env } from '../types';
import { scheduleWbWeekly, scheduleOzonMonthly, tickMarketplacePull, rebuildPriorMonthSite } from '../lib/marketplace-pull';
import { ok, fail } from '../lib/responses';

const r = new Hono<{ Bindings: Env }>();

// POST /api/marketplace-pull/schedule — manually trigger schedule for testing
// Body: { "marketplace": "wb" | "ozon", "asOf"?: "2026-05-19" }
r.post('/schedule', async (c) => {
  let body: any = {};
  try { body = await c.req.json(); } catch { /* allow empty */ }
  const mp = body.marketplace;
  const asOf = body.asOf ? new Date(body.asOf + 'T12:00:00Z') : undefined;

  if (mp === 'wb') {
    const result = await scheduleWbWeekly(c.env, asOf);
    return ok(c, { result });
  }
  if (mp === 'ozon') {
    const result = await scheduleOzonMonthly(c.env, asOf);
    return ok(c, { result });
  }
  return fail(c, 400, [{ code: 'invalid_marketplace', message: 'marketplace must be wb or ozon' }]);
});

r.post('/tick', async (c) => {
  const result = await tickMarketplacePull(c.env);
  return ok(c, { result });
});

r.get('/tasks', async (c) => {
  const status = c.req.query('status');
  let sql = 'SELECT * FROM marketplace_pull_tasks';
  let params: any[] = [];
  if (status) {
    sql += ' WHERE status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC LIMIT 50';
  const result = await c.env.DB.prepare(sql).bind(...params).all();
  return ok(c, { tasks: result.results });
});

r.get('/tasks/:id', async (c) => {
  const id = c.req.param('id');
  const task = await c.env.DB.prepare('SELECT * FROM marketplace_pull_tasks WHERE id=?').bind(id).first();
  if (!task) return fail(c, 404, [{ code: 'not_found', message: 'task not found' }]);

  const stagingTable = (task as any).marketplace === 'wb' ? 'wb_realization_staging' : 'ozon_transaction_staging';
  const stagingCount = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${stagingTable} WHERE task_id=?`).bind(id).first<{ n: number }>();
  return ok(c, { task, staging_rows: stagingCount?.n || 0 });
});

r.delete('/tasks/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM marketplace_pull_tasks WHERE id=?').bind(id).run();
  return ok(c, { deleted: id });
});


// Manual trigger: rebuild Yandex Pay monthly settlement for the previous calendar month.
// Same as the cron 0 4 1-7 * 3 — useful for manual triggering.
r.post('/rebuild-site', async (c) => {
  try {
    const result = await rebuildPriorMonthSite(c.env);
    return ok(c, result);
  } catch (e) {
    return c.json({ success: false, error: String(e) }, 500);
  }
});

export default r;
