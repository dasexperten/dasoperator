import { erpWorker, type BaseEnv } from '../../_shared/run';
// @ts-expect-error plain JS module
import { runGeoSnapshot } from '../../_geo/geo-snapshot.mjs';
// @ts-expect-error plain JS module
import { runGscSnapshot } from '../../_geo/gsc.mjs';

interface Env extends BaseEnv {
  GEO_DB: D1Database;
  CF_ANALYTICS_TOKEN?: string;
  CF_ZONE_ID?: string;
  GSC_CLIENT_ID?: string;
  GSC_CLIENT_SECRET?: string;
  GSC_REFRESH_TOKEN?: string;
}

async function logHalf(db: D1Database, half: string, ok: boolean, detail: string): Promise<void> {
  try {
    await db.prepare(
      'CREATE TABLE IF NOT EXISTS geo_snapshot_log (at TEXT NOT NULL, half TEXT NOT NULL, ok INTEGER NOT NULL, detail TEXT)',
    ).run();
    await db.prepare('INSERT INTO geo_snapshot_log (at, half, ok, detail) VALUES (?, ?, ?, ?)')
      .bind(new Date().toISOString(), half, ok ? 1 : 0, detail.slice(0, 400)).run();
  } catch (e) {
    console.log(`snapshot-log failed · ${half}: ${String(e).slice(0, 180)}`);
  }
}

// Two independent halves, as on the seat: a failed Search Console pull never costs the edge series.
export default erpWorker<Env>('erp-geo-snapshot', async (env, dry) => {
  if (dry) return { note: 'dry · snapshot skipped' };
  const geo = { ...env, DB: env.GEO_DB };
  const notes: string[] = [];
  const failed: string[] = [];
  let rows = 0;

  try {
    const o = await runGeoSnapshot(geo, { days: 3 });
    const d = `${o.from}..${o.to} daily=${o.daily} paths=${o.paths} worst5xx=${o.worstErrPct}%`;
    rows += Number(o.daily ?? 0) + Number(o.paths ?? 0);
    notes.push(`edge ${d}`);
    await logHalf(env.GEO_DB, 'edge', true, d);
  } catch (e) {
    const m = String((e as Error)?.message ?? e).slice(0, 300);
    failed.push(`edge: ${m}`);
    await logHalf(env.GEO_DB, 'edge', false, m);
  }

  try {
    const g = await runGscSnapshot(geo, { days: 8 });
    const d = `${g.from}..${g.to} rows=${g.written ?? 0} days=${g.days ?? 0}`;
    rows += Number(g.written ?? 0);
    notes.push(`gsc ${d}`);
    await logHalf(env.GEO_DB, 'gsc', true, d);
  } catch (e) {
    const m = String((e as Error)?.message ?? e).slice(0, 300);
    failed.push(`gsc: ${m}`);
    await logHalf(env.GEO_DB, 'gsc', false, m);
  }

  if (failed.length) throw new Error(`${failed.join(' · ')}${notes.length ? ' | ok: ' + notes.join(' · ') : ''}`);
  return { rows, note: notes.join(' · ') };
});
