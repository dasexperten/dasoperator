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

export async function readDianaCloudLock(env:Env):Promise<DianaLockOwner|null> {
  const row=await env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind(KEY).first<{value:string}>();
  if(!row)return null;
  try {
    const value=JSON.parse(row.value);
    if((value.kind==='direct'||value.kind==='round')&&typeof value.id==='string'&&value.id)return value;
  } catch {}
  throw Error('diana_cloud_lock_invalid');
}
