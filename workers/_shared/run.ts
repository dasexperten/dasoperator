// Every erp-* worker is one action on one timer. This wrapper gives each of them the
// same run log (D1 erp_cron_runs), the same /health, and the same guarded manual /run.

export interface RunOutcome {
  rows?: number;
  note?: string;
}

export interface BaseEnv {
  DB: D1Database;
  DRY_RUN?: string;
  ERP_RUN_SECRET?: string;
}

type Job<E> = (env: E, dry: boolean, cron: string) => Promise<RunOutcome>;

interface RunReport extends RunOutcome {
  ok: boolean;
  dry: boolean;
  error?: string;
}

async function runLogged<E extends BaseEnv>(env: E, worker: string, cron: string, job: Job<E>): Promise<RunReport> {
  const dry = env.DRY_RUN === '1';
  let id: number | null = null;
  try {
    const row = await env.DB.prepare(
      'INSERT INTO erp_cron_runs (worker, cron, started_at, dry_run) VALUES (?, ?, ?, ?) RETURNING id',
    ).bind(worker, cron, new Date().toISOString(), dry ? 1 : 0).first<{ id: number }>();
    id = row?.id ?? null;
  } catch (e) {
    console.error(`[${worker}] run log insert failed`, e);
  }

  let report: RunReport;
  try {
    const out = await job(env, dry, cron);
    report = { ok: true, dry, ...out };
  } catch (e) {
    report = { ok: false, dry, error: e instanceof Error ? e.message : String(e) };
  }

  if (id !== null) {
    try {
      await env.DB.prepare(
        'UPDATE erp_cron_runs SET finished_at = ?, ok = ?, rows = ?, note = ?, error = ? WHERE id = ?',
      ).bind(
        new Date().toISOString(),
        report.ok ? 1 : 0,
        report.rows ?? null,
        report.note?.slice(0, 1000) ?? null,
        report.error?.slice(0, 1000) ?? null,
        id,
      ).run();
    } catch (e) {
      console.error(`[${worker}] run log update failed`, e);
    }
  }
  console.log(`[${worker}] ${JSON.stringify(report)}`);
  return report;
}

function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function erpWorker<E extends BaseEnv>(worker: string, job: Job<E>): ExportedHandler<E> {
  return {
    async scheduled(event, env, ctx) {
      ctx.waitUntil(
        runLogged(env, worker, event.cron, job).then((r) => {
          if (!r.ok) throw new Error(r.error);
        }),
      );
    },

    async fetch(req, env) {
      const url = new URL(req.url);
      if (url.pathname === '/health') {
        return Response.json({ ok: true, worker, dry_run: env.DRY_RUN === '1' });
      }
      if (url.pathname === '/run' && req.method === 'POST') {
        const secret = env.ERP_RUN_SECRET ?? '';
        const given = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
        if (!secret || !sameSecret(given, secret)) return new Response('unauthorized', { status: 401 });
        return Response.json(await runLogged(env, worker, 'manual', job));
      }
      return new Response('not found', { status: 404 });
    },
  };
}
