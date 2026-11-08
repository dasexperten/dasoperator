import { erpWorker, type BaseEnv } from '../../_shared/run';
import { NAME, PREFIX, dayKey, signal, validEvidence } from './alarm.mjs';

const timer = erpWorker<BaseEnv>(NAME, async (env, dry, _cron, context) => {
  if (dry) return { note: 'dry · alarm not queued' };
  const now = new Date(context.scheduledTime ?? Date.now());
  const row = signal(now);
  const result = await env.DB.prepare(`INSERT OR IGNORE INTO crm_sync_state (key,value,updated_at) VALUES (?,?,?)`)
    .bind(dayKey(now), JSON.stringify(row), Math.floor(Date.now()/1000)).run();
  return { rows: result.meta.changes, note: 'Tet wakeup queued; order/invoice work is separate' };
});
const reply = (data: unknown, status = 200) => Response.json(data, {status, headers:{'Cache-Control':'no-store'}});
export default {
  scheduled: timer.scheduled,
  async fetch(request: Request, env: BaseEnv, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/alarm')) return timer.fetch(request, env, ctx);
    const given = (request.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const secret = env.ERP_RUN_SECRET ?? '';
    let diff = given.length ^ secret.length;
    for (let i=0;i<secret.length;i++) diff |= secret.charCodeAt(i) ^ (given.charCodeAt(i)||0);
    if (!secret || diff) return reply({ok:false,error:'unauthorized'},401);
    if (request.method === 'GET' && url.pathname === '/alarm') {
      const rows = await env.DB.prepare(`SELECT key,value FROM crm_sync_state WHERE key LIKE ? ORDER BY key`).bind(PREFIX+'%').all<{key:string;value:string}>();
      const signals = rows.results.map(r=>({key:r.key,...JSON.parse(r.value)}));
      return reply({ok:true,name:NAME,target:'tet',finance:'justina-timber',schedule:'06:00 Asia/Yerevan',signals});
    }
    const body = await request.json().catch(()=>null) as any;
    if (!body || typeof body.key !== 'string' || !/^erp-order-vn:\d{4}-\d{2}-\d{2}$/.test(body.key)) return reply({ok:false,error:'exact_day_key_required'},422);
    const stored = await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(body.key).first<{value:string}>();
    if (!stored) return reply({ok:false,error:'not_found'},404);
    const row = JSON.parse(stored.value);
    if (request.method === 'POST' && url.pathname === '/alarm/claim') {
      if (row.state !== 'pending') return reply({ok:false,error:'already_claimed'},409);
      const claim = crypto.randomUUID();
      const next = {...row,state:'working',claim,started_at:new Date().toISOString()};
      const result = await env.DB.prepare(`UPDATE crm_sync_state SET value=?,updated_at=? WHERE key=? AND value=?
        AND NOT EXISTS (SELECT 1 FROM crm_sync_state WHERE key LIKE ? AND json_extract(value,'$.state')='working')`)
        .bind(JSON.stringify(next),Math.floor(Date.now()/1000),body.key,stored.value,PREFIX+'%').run();
      return result.meta.changes ? reply({ok:true,key:body.key,claim,assignment:next}) : reply({ok:false,error:'busy_or_changed'},409);
    }
    if (request.method === 'POST' && url.pathname === '/alarm/result') {
      if (row.state !== 'working' || row.claim !== body.claim) return reply({ok:false,error:'claim_mismatch'},409);
      if (!['completed','blocked'].includes(body.state) || !validEvidence(body)) return reply({ok:false,error:'state_note_and_evidence_required'},422);
      const next = {...row,state:body.state,note:body.note,evidence:body.evidence,finished_at:new Date().toISOString()};
      const result=await env.DB.prepare('UPDATE crm_sync_state SET value=?,updated_at=? WHERE key=? AND value=?')
        .bind(JSON.stringify(next),Math.floor(Date.now()/1000),body.key,stored.value).run();
      return reply({ok:Boolean(result.meta.changes),state:next.state},result.meta.changes?200:409);
    }
    return reply({ok:false,error:'not_found'},404);
  }
};
