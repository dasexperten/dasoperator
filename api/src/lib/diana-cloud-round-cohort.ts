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
