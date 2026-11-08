import type { Env } from '../types';
import { publicationLink, contentReviewKey } from './ugc-publication-links.mjs';

export async function reviewContent(env: Env, id: string, input: { verdict: string; evidence: string; author_verified?: boolean; publication_verified?: boolean; our_product?: boolean; published_at?: string }) {
  if (!['published','confirmed','rejected'].includes(input.verdict) || !input.evidence?.trim() || input.evidence.length>2000) throw Error('review_evidence_required');
  // Owner 08.11: publication and product identification are independent facts.
  if(input.verdict==='published' && (input.author_verified!==true || input.publication_verified!==true)) throw Error('author_and_publication_verification_required');
  if(input.verdict==='confirmed' && (input.author_verified!==true || input.our_product!==true)) throw Error('author_and_product_verification_required');
  if(input.verdict==='rejected' && input.author_verified!==false && input.our_product!==false) throw Error('rejection_requires_wrong_author_or_product');
  if(input.published_at && (!Number.isFinite(Date.parse(input.published_at)) || Date.parse(input.published_at)>Date.now())) throw Error('invalid_observed_publication_date');
  const row=await env.DB.prepare('SELECT id,creator_id,content_url FROM ugc_content WHERE id=?1').bind(id).first<{id:string;creator_id:string;content_url:string}>();
  if(!row) throw Error('content_not_found');
  const link=publicationLink(row.content_url); if(!link) throw Error('unsupported_publication');
  const now=Date.now(),at=new Date(now).toISOString();
  const receipt=JSON.stringify({verdict:input.verdict,evidence:input.evidence.trim(),author_verified:input.author_verified===true,publication_verified:input.verdict==='published'||input.verdict==='confirmed',our_product:input.verdict==='published'?null:input.our_product===true,reviewer:'diana-helios',at});
  const marker=env.DB.prepare('INSERT INTO crm_sync_state (key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at').bind(contentReviewKey(row.creator_id,link.key),receipt,now);
  if(input.verdict==='rejected') {
    // The marker and removal commit together: the next capture cannot restore it.
    await env.DB.batch([marker,env.DB.prepare('DELETE FROM ugc_link_checks WHERE content_id=?1').bind(id),env.DB.prepare('DELETE FROM ugc_content WHERE id=?1').bind(id)]);
  } else {
    const content = input.verdict==='published'
      ? env.DB.prepare("UPDATE ugc_content SET link_status='active',link_checked_at=?2,link_check_note=?3,published_at=COALESCE(?4,published_at),updated_at=?5 WHERE id=?1").bind(id,at,receipt,input.published_at??null,now)
      : env.DB.prepare("UPDATE ugc_content SET product_status='identified',product_source='manual',product_confidence=NULL,product_evidence=?2,product_checked_at=?3,link_status='active',link_checked_at=?3,published_at=COALESCE(?5,published_at),updated_at=?4 WHERE id=?1").bind(id,receipt,at,now,input.published_at??null);
    await env.DB.batch([marker,content,
      env.DB.prepare("UPDATE ugc_creators SET lifecycle_stage='posted',updated_at=?2 WHERE id=?1 AND COALESCE(lifecycle_stage,'') IN ('','replied','agreed','cart','paid','ordered','creation','silent') AND NOT EXISTS (SELECT 1 FROM crm_sync_state WHERE key='manual_stage:'||?1 AND json_valid(value) AND json_type(value,'$.to')='text' AND json_type(value,'$.at') IN ('integer','real'))").bind(row.creator_id,now)]);
  }
  return {id,verdict:input.verdict,checked_at:at};
}
