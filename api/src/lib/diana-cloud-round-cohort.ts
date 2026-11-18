import type {Env} from '../types';
export type Candidate={id:string;normalized_handle:string;lifecycle_stage:string;cid:string|null;message_id:string|null;message_at:string|null};
// Include every qualifying creator, even if the archived chat identity is
// missing: that condition must be written as an exception, never discarded.
export async function roundCandidates(env:Env):Promise<Candidate[]> {
  const rows=await env.DB.prepare(`SELECT c.id,c.normalized_handle,c.lifecycle_stage,
    (SELECT m.conversation_id FROM ugc_ig_messages m WHERE m.direction='in' AND LOWER(m.from_username)=LOWER(c.normalized_handle) ORDER BY m.created_at DESC LIMIT 1) cid,
    (SELECT m.id FROM ugc_ig_messages m WHERE m.direction='in' AND LOWER(m.from_username)=LOWER(c.normalized_handle) ORDER BY m.created_at DESC LIMIT 1) message_id,
    (SELECT m.created_at FROM ugc_ig_messages m WHERE m.direction='in' AND LOWER(m.from_username)=LOWER(c.normalized_handle) ORDER BY m.created_at DESC LIMIT 1) message_at
    FROM ugc_creators c WHERE c.archived_at IS NULL AND (c.lifecycle_stage IN ('paid','ordered','creation') OR
    (c.lifecycle_stage='posted' AND NOT EXISTS (SELECT 1 FROM ugc_content x WHERE x.creator_id=c.id AND TRIM(COALESCE(x.content_url,''))<>'')))
    ORDER BY c.id`).all<Candidate>();
  return rows.results??[];
}

// Owner 2026-11-18 (Даша, Сочи): the round takes every chat where the blogger has the last word,
// whatever her stage. These are the standing alarms of bloggers outside the cohort above. A blogger
// whose payout button already stands is not here: her message was handled and the next move is the Owner's.
export async function alarmCandidates(env:Env):Promise<Candidate[]> {
  const rows=await env.DB.prepare(`SELECT c.id,c.normalized_handle,c.lifecycle_stage,json_extract(s.value,'$.cid') cid
    FROM crm_sync_state s JOIN ugc_creators c ON LOWER(c.normalized_handle)=LOWER(json_extract(s.value,'$.handle')) AND c.archived_at IS NULL
    WHERE s.key LIKE 'diana_round_alarm:%' AND json_valid(s.value)
      AND NOT EXISTS (SELECT 1 FROM ugc_payouts y WHERE y.creator_id=c.id AND y.status IN ('awaiting_approval','approved','sent'))
    ORDER BY s.updated_at LIMIT 60`).all<Candidate>();
  return rows.results??[];
}
