const LIMIT=12_000_000;
const trusted = value => {
 const u=new URL(value);
 if(u.protocol!=='https:'||u.username||u.password||u.port||!(u.hostname==='lookaside.fbsbx.com'||u.hostname.endsWith('.fbcdn.net')||u.hostname.endsWith('.cdninstagram.com')))throw Error('video_source_untrusted');
 return u.href;
};
export function currentVideos(messages) {
 const result=[];
 for(const message of messages.filter(m=>m.direction==='in')) {
  let attachments;try{attachments=JSON.parse(message.attachments_json||'[]');}catch{throw Error('video_metadata_invalid');}
  if(!Array.isArray(attachments))throw Error('video_metadata_invalid');
  for(const a of attachments)if(a?.video_data||String(a?.mime_type??'').startsWith('video/')){
   const url=a.video_data?.url||a.video_data?.video_url||a.file_url;
   if(typeof url!=='string'||!url)throw Error('video_url_unavailable');
   result.push({url,messageId:message.id});
  }
 }
 return result;
}
async function download(url,fetcher=fetch){
 let next=url;
 for(let n=0;n<4;n++){
  const r=await fetcher(trusted(next),{redirect:'manual',signal:AbortSignal.timeout(30000),headers:{'User-Agent':'Mozilla/5.0','Accept':'video/*,*/*;q=0.8'}});
  if([301,302,303,307,308].includes(r.status)){const loc=r.headers.get('location');await r.body?.cancel();if(!loc)throw Error('video_redirect_missing');next=new URL(loc,next).href;continue;}
  if(!r.ok||!r.body)throw Error('video_download_unavailable');
  if(Number(r.headers.get('content-length'))>LIMIT){await r.body.cancel();throw Error('video_too_large');}
  const reader=r.body.getReader(),chunks=[];let size=0;
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>LIMIT){await reader.cancel();throw Error('video_too_large');}chunks.push(value);}
  if(!size)throw Error('video_empty');let binary='';for(const chunk of chunks)for(let i=0;i<chunk.length;i+=32768)binary+=String.fromCharCode(...chunk.subarray(i,i+32768));return btoa(binary);
 }
 throw Error('video_redirect_limit');
}
export async function extractCurrentVideoFrames(env,videos,{fetcher=fetch}={}){
 if(videos.length>1)throw Error('too_many_videos');const frames=[];
 for(const video of videos){
  const data=await download(video.url,fetcher);const rawHash=await crypto.subtle.digest('SHA-256',Uint8Array.from(atob(data),c=>c.charCodeAt(0)));
  const videoSha256=[...new Uint8Array(rawHash)].map(v=>v.toString(16).padStart(2,'0')).join('');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(video.messageId+':'+videoSha256));
  const id='video-'+[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
  const response=await env.DIANA_SUBSCRIPTION.fetch('https://subscription.internal/infer',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:id,operation:'video_frames',model:'gpt-6-luna',video:data})});
  if(!response.ok)throw Error('video_frame_extraction_unavailable');const result=await response.json();
  if(result?.receipt?.operation!=='video_frames'||result.receipt.requestId!==id||!Array.isArray(result.frames)||!result.frames.length||result.frames.length>60)throw Error('video_frame_extraction_invalid');
  for(const frame of result.frames){if(frame.mediaType!=='image/jpeg'||typeof frame.data!=='string')throw Error('video_frame_extraction_invalid');frames.push({...frame,sourceMessageId:video.messageId,videoSha256,label:`Source message ${video.messageId}; ${frame.label}`});}
 }
 return frames;
}
