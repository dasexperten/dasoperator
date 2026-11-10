import type { Env } from '../types';

// This row is shared by every cloud execution of Diana, including scheduled
// rounds. An unknown owner is never evicted based on age alone: a workflow may
// be suspended or running an external action after a long delay.
const KEY = 'diana_cloud_execution_lock';
export type DianaLockOwner = {kind:'direct'|'round'; id:string};

export async function reserveDianaCloud(env:Env, owner:DianaLockOwner) {
  const value=JSON.stringify(owner);
  const result=await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)')
    .bind(KEY,value,Date.now()).run();
  return Number(result.meta.changes)===1;
}

export async function releaseDianaCloud(env:Env, owner:DianaLockOwner) {
  const result=await env.DB.prepare('DELETE FROM crm_sync_state WHERE key=?1 AND value=?2')
    .bind(KEY,JSON.stringify(owner)).run();
  return Number(result.meta.changes)===1;
}

// Called only from a workflow's final step, after all actions and receipts.
// The marker and conditional release commit together. A dispatcher can then
// safely start the next job even while Cloudflare is finishing this final step.
export async function finishDianaCloud(env:Env, owner:DianaLockOwner) {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .bind('diana_cloud_finished:'+owner.id,JSON.stringify(owner),Date.now()),
    env.DB.prepare('DELETE FROM crm_sync_state WHERE key=?1 AND value=?2').bind(KEY,JSON.stringify(owner))
  ]);
}

export async function readDianaCloudLock(env:Env):Promise<DianaLockOwner|null> {
  const row=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(KEY).first<{value:string}>();
  if(!row)return null;
  try {
    const value=JSON.parse(row.value);
    if((value.kind==='direct'||value.kind==='round')&&typeof value.id==='string'&&value.id)return value;
  } catch {}
  throw Error('diana_cloud_lock_invalid');
}

// Recovery never guesses that a missing/unreachable instance is absent. Only
// an explicit terminal status of the exact lock owner permits release. A
// pending create is given a grace period, and three unsuccessful observations
// stop further automatic attempts while retaining the lock and reason.
export async function recoverDianaCloudLock(env:Env, now=Date.now()) {
  const row=await env.DB.prepare('SELECT value,updated_at FROM crm_sync_state WHERE key=?1').bind(KEY).first<{value:string;updated_at:number}>();
  if(!row)return {released:false,reason:'no_lock'};
  let owner:DianaLockOwner;try{owner=JSON.parse(row.value);}catch{return {released:false,reason:'invalid_lock'};}
  if(!owner||!['direct','round'].includes(owner.kind)||typeof owner.id!=='string'||!owner.id)return {released:false,reason:'invalid_lock'};
  if(now-Number(row.updated_at)<180_000)return {released:false,reason:'startup_grace'};
  const countKey=`diana_cloud_recovery_attempt:${owner.kind}:${owner.id}`, receiptKey=`diana_cloud_recovery:${owner.kind}:${owner.id}`;
  await env.DB.prepare('INSERT OR IGNORE INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)').bind(countKey,'0',now).run();
  const attempt=await env.DB.prepare('UPDATE crm_sync_state SET value=CAST(CAST(value AS INTEGER)+1 AS TEXT),updated_at=?2 WHERE key=?1 AND CAST(value AS INTEGER)<3').bind(countKey,now).run();
  if(Number(attempt.meta.changes)!==1)return {released:false,reason:'recovery_attempts_exhausted',owner};
  const save=async(reason:string,status?:string)=>env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .bind(receiptKey,JSON.stringify({owner,reason,...(status?{status}:{}),checked_at:now}),now).run();
  let status:string;
  try {
    const workflow=owner.kind==='direct'?env.DIANA_CLOUD:env.DIANA_ROUND;
    status=String((await(await workflow.get(owner.id)).status()).status);
  } catch {await save('workflow_status_unavailable');return {released:false,reason:'workflow_status_unavailable',owner};}
  if(!['complete','errored','terminated'].includes(status)){
    if(['queued','running','paused','waiting','waitingForPause'].includes(status)){
      await env.DB.prepare('DELETE FROM crm_sync_state WHERE key=?1').bind(countKey).run();
      return {released:false,reason:'workflow_active',status,owner};
    }
    await save('workflow_status_unknown',status);return {released:false,reason:'workflow_status_unknown',owner};
  }
  await save('terminal_workflow_observed',status);
  const released=await releaseDianaCloud(env,owner);
  if(released)await env.DB.prepare('DELETE FROM crm_sync_state WHERE key=?1').bind(countKey).run();
  return {released,reason:released?'terminal_workflow_observed':'lock_owner_changed',status,owner};
}
