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
