// api/src/marketplaces/fbo-routes.ts
//
// HTTP layer for FBO supply planning. Mount in the main app:
//
//   import { fboRoutes } from './marketplaces/fbo-routes';
//   app.route('/api/marketplaces/fbo', fboRoutes);
//
// Endpoints:
//   GET  /api/marketplaces/fbo/ozon   -> status JSON (replaces the dead
//   GET  /api/marketplaces/fbo/wb        raw.githubusercontent *-fbo-status.json)
//   POST /api/marketplaces/fbo/sync   -> pull fresh cluster-grain data from
//                                        Ozon + WB APIs (60-90s: WB throttle),
//                                        then recalc both. Manual trigger for
//                                        the "recalculate" button; the daily
//                                        cron calls runFboSync directly.
//   GET  /api/marketplaces/fbo/runs   -> last 10 calc runs per marketplace
//                                        (feeds the status panel that replaces
//                                        the old GitHub Actions runs block).
//
// Calc is cheap (pure D1 read + math), so GET endpoints recalc on every hit:
// the screen always reflects the latest synced data, no staleness, and the
// run log doubles as an access log. If that ever gets heavy, add KV caching.
//
// SHAPE ADAPTER: the deployed frontend (web/app/marketplaces/page.tsx)
// consumes a different shape than fbo-calc emits — clusters as a Record of
// {to_ship, sku_count, oos, deficit}, a FLAT skus list with cluster on each
// row, UPPERCASE zone labels (DEFICIT/OVERSTOCK checked at page.tsx:637/744),
// total_skus / unknown_pack field names, and runs consumed strictly via
// data.workflow_runs (page.tsx:258). toFrontendShape() below is the single
// place the two shapes meet — evolve the frontend contract here, not in calc.
// /runs returns BOTH keys: workflow_runs (current frontend) + runs (raw rows
// for the future native status panel).

import { Hono } from 'hono';
import { runFboCalc } from './fbo-calc';
import type { FboStatus, Zone } from './fbo-calc';
import { runFboSync, type FboEnv } from './fbo-sync';

type Env = { Bindings: FboEnv };

const ZONE_LABEL: Record<Zone, string> = {
  toship: 'DEFICIT',
  stockout: 'STOCKOUT',
  overstock: 'OVERSTOCK',
  default: 'OK',
};

function toFrontendShape(s: FboStatus) {
  const clusters: Record<string, { to_ship: number; sku_count: number; oos: number; deficit: number }> = {};
  const skus: Array<{
    sku: string;
    cluster: string;
    stock: number;
    sales_30d: number;
    k: number | null;
    zone: string;
    to_ship: number;
    flag?: string;
  }> = [];
  for (const c of s.clusters) {
    clusters[c.cluster] = {
      to_ship: c.to_ship,
      sku_count: c.skus.length,
      oos: c.oos,
      deficit: c.skus.filter((r) => r.zone === 'toship').length,
    };
    for (const r of c.skus) {
      skus.push({
        sku: r.sku,
        cluster: c.cluster,
        stock: r.stock,
        sales_30d: r.sales_30d,
        k: r.k,
        zone: ZONE_LABEL[r.zone],
        to_ship: r.to_ship,
        ...(r.unknown_pack ? { flag: 'unknown_pack' } : {}),
      });
    }
  }
  return {
    run_date: s.run_date,
    generated_at: new Date(s.generated_at * 1000).toISOString(),
    stocks_rows: s.stocks_rows,
    sales_rows: s.sales_rows,
    total_skus: s.sku_count,
    to_ship_count: s.to_ship_count,
    to_ship_units: s.to_ship_units,
    oos_count: s.oos_count,
    overstock_count: s.overstock_count,
    unknown_cluster_count: s.unknown_cluster_count,
    unknown_pack: s.unknown_pack_count,
    clusters,
    skus,
  };
}

export const fboRoutes = new Hono<Env>();

fboRoutes.get('/ozon', async (c) => {
  try {
    return c.json(toFrontendShape(await runFboCalc(c.env, 'ozon')));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

fboRoutes.get('/wb', async (c) => {
  try {
    return c.json(toFrontendShape(await runFboCalc(c.env, 'wb')));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

fboRoutes.post('/sync', async (c) => {
  try {
    const report = await runFboSync(c.env);
    return c.json({ ok: true, report });
  } catch (e) {
    return c.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

fboRoutes.get('/runs', async (c) => {
  const mp = c.req.query('marketplace');
  const stmt = mp
    ? c.env.DB.prepare(
        'SELECT * FROM fbo_calc_runs WHERE marketplace = ? ORDER BY created_at DESC LIMIT 10',
      ).bind(mp)
    : c.env.DB.prepare('SELECT * FROM fbo_calc_runs ORDER BY created_at DESC LIMIT 20');
  const { results } = await stmt.all<{ id: number; status: string; created_at: number }>();
  // workflow_runs = GitHub Actions mimicry (RunsTable + RunBadge consume it
  // unchanged); html_url points at the live status JSON.
  const workflow_runs = results.map((r) => {
    const iso = new Date(r.created_at * 1000).toISOString();
    return {
      run_number: r.id,
      created_at: iso,
      updated_at: iso,
      status: 'completed',
      conclusion: r.status === 'ok' ? 'success' : 'failure',
      html_url: `https://dasoperator-api.dasexperten.workers.dev/api/marketplaces/fbo/${mp === 'wb' ? 'wb' : 'ozon'}`,
    };
  });
  return c.json({ workflow_runs, runs: results });
});

export default fboRoutes;
