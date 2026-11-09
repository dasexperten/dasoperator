import type { Env } from '../types';
import { ALARM, ROUND, inMoscowWindow, START_GAP_MS, freshSignal, isTriggerMinute } from './diter-ugc-alarm.mjs';
import { reelTaskText, reelScope } from './ugc-reel-jobs.mjs';

export const CONSUMER_TTL_MS = 90_000;
export const START_INTERVAL_MS = START_GAP_MS;
export function diterWindow(now: number): boolean { return inMoscowWindow(new Date(now)); }

// No /adhoc, model, download or publication here. Only accept one concrete job
// for a registered live executor, before the executor starts its round.
export async function tickDiterAlarm(env: Env, now = Date.now(), contentId: string | null = null) {
  const pending = await env.DB.prepare("SELECT content_id,required_destinations FROM ugc_reel_jobs WHERE status='queued' AND attempts<3 AND (?1 IS NULL OR content_id=?1) ORDER BY requested_at,content_id LIMIT 1").bind(contentId).first<{content_id:string;required_destinations:string}>();
  const state = await env.DB.prepare('SELECT * FROM ugc_reel_alarm WHERE id=1').first<Record<string, any>>();
  const working = await env.DB.prepare("SELECT content_id FROM ugc_reel_jobs WHERE status='working' LIMIT 1").first<{content_id:string}>();
  let scopeNote:string|null=null;
  if(pending){try{if(!reelScope(pending).active.length)scopeNote='deferred_destinations_only';}catch{scopeNote='invalid_destination_scope';}}
  const note = !diterWindow(now) ? 'outside_window' : working ? 'working_job_exists'
    : !pending ? 'empty' : scopeNote ? scopeNote : !state?.ready || !state.consumer_id || state.heartbeat_at < now-CONSUMER_TTL_MS ? 'consumer_missing'
    : state.last_started_at != null && now-state.last_started_at < START_INTERVAL_MS ? 'cooldown' : 'ready';
  await env.DB.prepare('UPDATE ugc_reel_alarm SET tick_at=?,pending_content_id=?,note=? WHERE id=1').bind(now,pending?.content_id ?? null,note).run();
  await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
    .bind(ALARM,JSON.stringify({name:ALARM,target:ROUND,checked_at:new Date(now).toISOString(),state:note==='consumer_missing' ? 'ready' : note,transport:'preflight_only',content_id:pending?.content_id ?? null}),now).run();
  if (note !== 'ready' || !state || !pending) return {ok:true,accepted:false,note,content_id:pending?.content_id ?? null};
  const claim = crypto.randomUUID();
  const iso = new Date(now).toISOString();
  // D1 batch is a transaction. Both fresh liveness and global concurrency are
  // checked in the write itself, so overlapping cron ticks cannot claim two.
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE ugc_reel_jobs SET status='working',claim_id=?1,consumer_id=?2,started_at=?3,acknowledged_at=NULL,attempts=attempts+1,last_error=NULL,updated_at=?3
      WHERE content_id=?4 AND status='queued' AND attempts<3
      AND NOT EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE status='working')
      AND NOT EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE started_at>?7)
      AND EXISTS(SELECT 1 FROM ugc_reel_alarm WHERE id=1 AND consumer_id=?2 AND ready=1 AND heartbeat_at>=?5 AND (last_started_at IS NULL OR last_started_at<=?6))`)
      .bind(claim,state.consumer_id,iso,pending!.content_id,now-CONSUMER_TTL_MS,now-START_INTERVAL_MS,new Date(now-START_INTERVAL_MS).toISOString()),
    env.DB.prepare(`UPDATE ugc_reel_alarm SET last_started_at=?1,ready=0,pending_content_id=NULL,note='accepted'
      WHERE id=1 AND EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE claim_id=?2 AND status='working')`).bind(now,claim),
  ]);
  return {ok:true,accepted:Boolean(result[0]?.meta.changes),note:result[0]?.meta.changes ? 'accepted' : 'race_lost',content_id:pending!.content_id};
}

export async function reelAssignment(env: Env, consumerId: string, origin: string) {
  const row = await env.DB.prepare(`SELECT j.*,c.content_url,p.handle FROM ugc_reel_jobs j JOIN ugc_content c ON c.id=j.content_id JOIN ugc_creator_platforms p ON p.id=c.creator_platform_id WHERE j.status='working' AND j.consumer_id=? LIMIT 1`).bind(consumerId).first<{content_id:string;claim_id:string;content_url:string;handle:string;started_at:string;acknowledged_at:string|null;required_destinations:string;publications:string}>();
  if (!row) return null;
  return { runner:'diter-ugc-round', content_id:row.content_id,claim_id:row.claim_id,status:'working',source_url:row.content_url,author:row.handle,
    started_at:row.started_at,acknowledged_at:row.acknowledged_at,required_destinations:reelScope(row).active,destination_scope:reelScope(row),publications:JSON.parse(row.publications),
    task:reelTaskText(row,origin) };
}

// The shared ERP clock remains minute-based for its other processes. Dieter's
// atomic slot gate runs only at the Owner's fixed Moscow trigger minutes.
export async function tickDiterUgcAlarm(env: Env, now = new Date()) {
  const ms=now.getTime();
  if (!isTriggerMinute(now)) return {ok:true,accepted:false,note:'not_due'};
  const due=await env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
    WHERE CAST(crm_sync_state.value AS INTEGER)<?4
    RETURNING key`)
    .bind('slot:erp-ugc-diter',String(Math.floor(ms/60000)),Math.floor(ms/1000),Math.floor(ms/60000)).first();
  if (!due) return {ok:true,accepted:false,note:'not_due'};
  return tickDiterAlarm(env,ms);
}

// Backward-compatible PC transport has already done real tool preflight before
// this call. Acceptance is still performed by the same alarm, not by the model.
export async function acceptLegacyReel(env: Env, contentId: string, origin: string, now = Date.now()) {
  if (!diterWindow(now)) return null;
  const stored=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?').bind(ALARM).first<{value:string}>();
  const signal=freshSignal(stored?.value ?? '',new Date(now));
  if (signal?.content_id!==contentId) return null;
  const consumerId='legacy-PC-preflight';
  const registered=await env.DB.prepare(`UPDATE ugc_reel_alarm SET consumer_id=?1,heartbeat_at=?2,ready=1 WHERE id=1
    AND NOT EXISTS(SELECT 1 FROM ugc_reel_jobs WHERE status='working')
    AND (consumer_id IS NULL OR consumer_id=?1 OR heartbeat_at<?3)`)
    .bind(consumerId,now,now-CONSUMER_TTL_MS).run();
  if (!registered.meta.changes) return null;
  const accepted=await tickDiterAlarm(env,now,contentId);
  if (!accepted.accepted) return null;
  const assignment=await reelAssignment(env,consumerId,origin);
  if (!assignment || assignment.content_id!==contentId) return null;
  await env.DB.prepare(`UPDATE ugc_reel_jobs SET acknowledged_at=? WHERE content_id=? AND claim_id=? AND consumer_id=? AND status='working'`).bind(new Date(now).toISOString(),contentId,assignment.claim_id,consumerId).run();
  return assignment;
}
