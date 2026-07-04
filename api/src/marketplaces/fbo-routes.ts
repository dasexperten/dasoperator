// api/src/marketplaces/fbo-routes.ts
//
// FBO supply planning — HTTP surface over fbo-sync / fbo-calc.
//
//   GET  /api/marketplaces/fbo/ozon   -> live recalc, JSON in the exact shape
//   GET  /api/marketplaces/fbo/wb        the /marketplaces frontend expects
//   GET  /api/marketplaces/fbo/runs?marketplace=ozon|wb
//                                     -> GitHub-Actions workflow_runs mimicry
//                                        from fbo_calc_runs (frontend RunsTable
//                                        renders it unchanged)
//   POST /api/marketplaces/fbo/sync   -> runFboSync (Ozon + WB, 60-90 s)
//
// The calc returns a cluster-array shape (fbo-calc.ts FboStatus); the frontend
// (web/app/marketplaces/page.tsx) wants clusters as a Record plus a flat skus
// list with UPPERCASE zones. The adapter below is the single place where the
// two shapes meet — evolve the frontend contract here, not in calc.

import { Hono } from 'hono';
import type { Env } from '../types';
import { runFboSync } from './fbo-sync';
import { runFboCalc } from './fbo-calc';
import type { FboStatus, Zone } from './fbo-calc';

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

export const fboRoutes = new Hono<{ Bindings: Env }>();

fboRoutes.get('/ozon', async (c) => {
  const status = await runFboCalc(c.env, 'ozon');
  return c.json(toFrontendShape(status));
});

fboRoutes.get('/wb', async (c) => {
  const status = await runFboCalc(c.env, 'wb');
  return c.json(toFrontendShape(status));
});

// GitHub-Actions mimicry: { workflow_runs: [{ run_number, created_at,
// updated_at, status, conclusion, html_url }] } — RunsTable + RunBadge
// consume it unchanged. html_url points at the live status JSON.
fboRoutes.get('/runs', async (c) => {
  const mp = c.req.query('marketplace') === 'wb' ? 'wb' : 'ozon';
  const { results } = await c.env.DB
    .prepare(
      'SELECT id, status, created_at FROM fbo_calc_runs WHERE marketplace = ? ORDER BY created_at DESC LIMIT 10',
    )
    .bind(mp)
    .all<{ id: number; status: string; created_at: number }>();
  const workflow_runs = results.map((r) => {
    const iso = new Date(r.created_at * 1000).toISOString();
    return {
      run_number: r.id,
      created_at: iso,
      updated_at: iso,
      status: 'completed',
      conclusion: r.status === 'ok' ? 'success' : 'failure',
      html_url: `https://dasoperator-api.dasexperten.workers.dev/api/marketplaces/fbo/${mp}`,
    };
  });
  return c.json({ workflow_runs });
});

// Manual full sync (Ozon + WB). WB statistics-api throttling makes this a
// 60-90 s request — callers should be patient, not retry.
fboRoutes.post('/sync', async (c) => {
  const report = await runFboSync(c.env);
  return c.json(report);
});

export default fboRoutes;
