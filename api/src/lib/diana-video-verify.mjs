// Compare two independently fetched and analysed copies. Incomplete or conflicting
// facts are never financial proof; a confirmed basket remains a separate source.
export function compareVideoPayoutEvidence(first, second, messageId) {
 if(!messageId||!Array.isArray(first?.frames)||!first.frames.length||first.frames.length!==second?.frames?.length||first.checks?.length!==first.frames.length||second.checks?.length!==second.frames.length)return {verified:false,reason:'video_evidence_incomplete'};
 for(let i=0;i<first.frames.length;i++){
  const a=first.frames[i],b=second.frames[i];
  if(a.sourceMessageId!==messageId||b.sourceMessageId!==messageId||!a.videoSha256||a.videoSha256!==b.videoSha256||a.data!==b.data)return {verified:false,reason:'video_original_changed'};
 }
 const required=['holder_name','bank','phone'], fields=[...required,'amount','currency','card'];
 const collect=(checks)=>{
  const values=Object.fromEntries(fields.map(k=>[k,new Set()]));
  for(const check of checks){
   if((check.unresolved_required??[]).some(k=>['holder_name','bank','phone','card','amount','contradictory_evidence'].includes(k)))return null;
   for(const field of fields){const v=check.requisites?.[field];if(v!=null&&String(v).trim())values[field].add(String(v).trim());}
  }
  if(fields.some(k=>values[k].size>1))return null;
  return Object.fromEntries(fields.map(k=>[k,[...values[k]][0]??null]));
 };
 const a=collect(first.checks),b=collect(second.checks);
 if(!a||!b||required.some(k=>!a[k])||fields.some(k=>a[k]!==b[k]))return {verified:false,reason:'video_requisites_incomplete_or_conflicting'};
 return {verified:true,facts:a,videoSha256:first.frames[0].videoSha256,messageId};
}
