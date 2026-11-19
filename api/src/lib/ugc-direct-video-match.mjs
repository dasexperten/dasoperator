// Owner 2026-11-19: «видео, которые нам присылают, если они точь-в-точь совпадают с видео, которое
// выложено, тогда смысла нет два ролика туда ставить». A blogger sends the file in Direct and then
// publishes the same video, so her card showed it twice. The round now compares the two files:
//   1. the lengths, read from the files themselves — a different length is a different video;
//   2. equal lengths — a model watches both and says whether it is the same video start to end.
// Only «identical» links the sent file to the publication; the screen then shows the publication
// alone. A fragment, another cut or another video stays as it is. Nothing is deleted.
const MODEL='gemini-3.5-flash';
const API='https://generativelanguage.googleapis.com';
export const MAX_VIDEO=30_000_000;
export const LENGTH_TOLERANCE=1.5;
const PROMPT=`Тебе даны два видео. ПЕРВОЕ блогер прислала бренду файлом в личные сообщения. ВТОРОЕ опубликовано в Instagram. Посмотри оба целиком и реши, одно ли это видео.
Верни только JSON: {"same":"identical|part|different","reason":"одно предложение по-русски"}
Сравнивай только изображение. Звук не учитывается совсем: наложенная или заменённая музыка, озвучка, тишина не делают видео разными.
identical — это один и тот же ролик от начала до конца: те же кадры в том же порядке, тот же монтаж. Разница в качестве, размере кадра, обрезке краёв, наложенных подписях и плашках не считается.
part — одно видео является фрагментом другого, либо это другой монтаж той же съёмки (кадры добавлены, убраны или переставлены).
different — это разные видео.
Если сомневаешься, совпадает ли изображение, — отвечай part.`;

/** Length of an MP4 in seconds from its own header, or null when the file does not say. */
export function mp4Seconds(bytes){
  const b=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes);
  const v=new DataView(b.buffer,b.byteOffset,b.byteLength);
  for(let i=4;i+32<=b.length;i++){
    if(b[i]!==0x6d||b[i+1]!==0x76||b[i+2]!==0x68||b[i+3]!==0x64)continue; // 'mvhd'
    const version=b[i+4];
    let scale,duration;
    if(version===0){scale=v.getUint32(i+16);duration=v.getUint32(i+20);if(duration===0xffffffff)return null;}
    else if(version===1&&i+40<=b.length){scale=v.getUint32(i+24);duration=v.getUint32(i+28)*2**32+v.getUint32(i+32);}
    else continue;
    if(!scale||!duration)continue;
    const seconds=duration/scale;
    if(seconds>0&&seconds<6*3600)return Math.round(seconds*100)/100;
  }
  return null;
}

/** The cheap part of the decision. null means the lengths allow the two to be the same video. */
export function lengthVerdict(sentSeconds,publishedSeconds){
  if(sentSeconds==null||publishedSeconds==null)return null;
  return Math.abs(sentSeconds-publishedSeconds)>LENGTH_TOLERANCE?'different_length':null;
}

export function parseSame(text){
  let v=null;try{v=JSON.parse(text);}catch{const m=String(text??'').match(/\{[\s\S]*\}/);try{v=m?JSON.parse(m[0]):null;}catch{v=null;}}
  if(Array.isArray(v))v=v[0];
  if(!v||!['identical','part','different'].includes(v.same))return null;
  return {same:v.same,reason:v.reason?String(v.reason).slice(0,300):null};
}

async function upload(apiKey,bytes,fetchImpl){
  const start=await fetchImpl(`${API}/upload/v1beta/files`,{method:'POST',signal:AbortSignal.timeout(30000),
    headers:{'x-goog-api-key':apiKey,'X-Goog-Upload-Protocol':'resumable','X-Goog-Upload-Command':'start','X-Goog-Upload-Header-Content-Length':String(bytes.byteLength),'X-Goog-Upload-Header-Content-Type':'video/mp4','Content-Type':'application/json'},
    body:JSON.stringify({file:{display_name:'ugc-match'}})});
  const target=start.headers.get('x-goog-upload-url');
  if(!start.ok||!target)throw Error('video_match_upload_start_'+start.status);
  const sent=await fetchImpl(target,{method:'POST',signal:AbortSignal.timeout(120000),headers:{'X-Goog-Upload-Offset':'0','X-Goog-Upload-Command':'upload, finalize'},body:bytes});
  const file=(await sent.json().catch(()=>null))?.file;
  if(!sent.ok||!file?.name||!file?.uri)throw Error('video_match_upload_'+sent.status);
  return file;
}
async function ready(apiKey,file,fetchImpl,wait){
  let f=file;
  for(let n=0;n<30&&f.state==='PROCESSING';n++){
    await wait(3000);
    const r=await fetchImpl(`${API}/v1beta/${f.name}`,{headers:{'x-goog-api-key':apiKey},signal:AbortSignal.timeout(20000)});
    if(!r.ok)throw Error('video_match_state_'+r.status);
    f=await r.json();
  }
  if(f.state!=='ACTIVE')throw Error('video_match_not_ready');
  return f;
}

/** Asks the model whether the two files are one video. Both are bytes of an MP4. */
export async function watchBoth({apiKey,sent,published,fetchImpl=fetch,wait=ms=>new Promise(r=>setTimeout(r,ms))}){
  if(!apiKey)throw Error('video_match_no_key');
  const files=[];
  try{
    for(const bytes of [sent,published])files.push(await upload(apiKey,bytes,fetchImpl));
    for(let i=0;i<files.length;i++)files[i]=await ready(apiKey,files[i],fetchImpl,wait);
    const r=await fetchImpl(`${API}/v1beta/models/${MODEL}:generateContent`,{method:'POST',headers:{'x-goog-api-key':apiKey,'Content-Type':'application/json'},signal:AbortSignal.timeout(150000),
      body:JSON.stringify({contents:[{parts:[{text:'ПЕРВОЕ видео:'},{file_data:{mime_type:'video/mp4',file_uri:files[0].uri}},{text:'ВТОРОЕ видео:'},{file_data:{mime_type:'video/mp4',file_uri:files[1].uri}},{text:PROMPT}]}],
        generationConfig:{responseMimeType:'application/json',maxOutputTokens:2000,thinkingConfig:{thinkingLevel:'low'}}})});
    if(!r.ok)throw Error('video_match_watch_'+r.status);
    const body=await r.json();
    const verdict=parseSame(body?.candidates?.[0]?.content?.parts?.map(p=>p.text??'').join('')??'');
    if(!verdict)throw Error('video_match_invalid');
    return verdict;
  }finally{
    for(const f of files)await fetchImpl(`${API}/v1beta/${f.name}`,{method:'DELETE',headers:{'x-goog-api-key':apiKey},signal:AbortSignal.timeout(15000)}).catch(()=>null);
  }
}

/** One pair, start to end. Returns {same, reason, sent_seconds, published_seconds}. */
export async function compareVideos({apiKey,sent,published,fetchImpl=fetch,wait}){
  const sentSeconds=mp4Seconds(sent),publishedSeconds=mp4Seconds(published);
  const lengths={sent_seconds:sentSeconds,published_seconds:publishedSeconds};
  if(lengthVerdict(sentSeconds,publishedSeconds))return {same:'different_length',reason:null,...lengths};
  return {...await watchBoth({apiKey,sent,published,fetchImpl,...(wait?{wait}:{})}),...lengths};
}

// ---- The round's step: every sent file against every live publication of the same blogger. ----
const trustedHost=h=>h.endsWith('.fbcdn.net')||h.endsWith('.cdninstagram.com');
async function fetchVideo(url,fetchImpl){
  let u;try{u=new URL(url);}catch{return {error:'bad_url'};}
  if(u.protocol!=='https:'||u.username||u.password||u.port||!trustedHost(u.hostname))return {error:'untrusted_host'};
  const r=await fetchImpl(u.href,{signal:AbortSignal.timeout(60000),headers:{'User-Agent':'Mozilla/5.0',Accept:'video/*,*/*;q=0.8'}});
  if(!r.ok||!r.body){await r.body?.cancel?.();return {error:'download_'+r.status};}
  if(Number(r.headers.get('content-length')??0)>MAX_VIDEO){await r.body.cancel?.();return {final:'too_large'};}
  const bytes=new Uint8Array(await r.arrayBuffer());
  if(!bytes.byteLength)return {error:'empty'};
  return bytes.byteLength>MAX_VIDEO?{final:'too_large'}:{bytes};
}
export const matchKey=(sentId,publishedId)=>`direct_video_match:${sentId}:${publishedId}`;
const PAIRS=`SELECT d.id sent_id, r.id published_id, r.content_url url, m.value mark
  FROM ugc_content d
  JOIN ugc_creators c ON c.id=d.creator_id AND c.archived_at IS NULL
  JOIN ugc_content r ON r.creator_id=d.creator_id AND r.id<>d.id AND r.content_url LIKE '%instagram.com/%'
    AND COALESCE(r.link_status,'') NOT IN ('missing','invalid','restricted')
  LEFT JOIN crm_sync_state m ON m.key='direct_video_match:'||d.id||':'||r.id
  WHERE d.id LIKE 'ugcc!_dv!_%' ESCAPE '!' AND json_valid(d.product_evidence) AND json_extract(d.product_evidence,'$.published_as') IS NULL
    AND (m.key IS NULL OR (json_valid(m.value) AND COALESCE(json_extract(m.value,'$.final'),0)=0 AND COALESCE(json_extract(m.value,'$.tries'),0)<3))
  ORDER BY d.imported_at DESC, r.imported_at DESC LIMIT ?1`;

export async function matchDirectVideos(env,{limit=6,budgetMs=8*60_000,read,compare=compareVideos,fetchImpl=fetch,now=Date.now}={}){
  const started=now();
  const totals={selected:0,identical:0,other:0,retry:0};
  const apiKey=env.GEMINI_API_KEY;
  if(!apiKey||!env.DB||!env.DOCS)return {...totals,disabled:true};
  const rows=(await env.DB.prepare(PAIRS).bind(Math.max(1,Math.min(12,Math.trunc(limit)))).all()).results??[];
  totals.selected=rows.length;
  const done=new Set();
  const mark=(row,value)=>env.DB.prepare('INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
    .bind(matchKey(row.sent_id,row.published_id),JSON.stringify({...value,at:new Date(now()).toISOString()}),now()).run();
  for(const row of rows){
    if(now()-started>budgetMs)break;
    if(done.has(row.sent_id))continue;
    let tries=0;try{tries=Number(JSON.parse(row.mark??'{}').tries??0);}catch{tries=0;}
    const again=error=>{totals.retry++;return mark(row,{final:0,tries:tries+1,error:String(error).slice(0,80)});};
    const closed=(same,extra={})=>{totals.other++;return mark(row,{final:1,same,...extra});};
    try{
      const file=await env.DOCS.get('ugc/direct-video/'+row.sent_id+'.mp4');
      if(!file){await closed('no_file');continue;}
      const seen=read?await read(env,{url:row.url,cacheForMs:12*3_600_000}):null;
      if(seen?.status!=='ok'){await again('reading_'+String(seen?.status??'none'));continue;}
      if(!seen.videoUrl){await closed('no_video');continue;}
      const published=await fetchVideo(seen.videoUrl,fetchImpl);
      if(published.final){await closed(published.final);continue;}
      if(!published.bytes){await again(published.error);continue;}
      const sent=new Uint8Array(await file.arrayBuffer());
      const verdict=await compare({apiKey,sent,published:published.bytes,fetchImpl});
      if(verdict.same!=='identical'){await closed(verdict.same,{reason:verdict.reason??null,sent_seconds:verdict.sent_seconds??null,published_seconds:verdict.published_seconds??null});continue;}
      const at=new Date(now()).toISOString();
      await env.DB.prepare(`UPDATE ugc_content SET product_evidence=json_set(product_evidence,'$.published_as',?2,'$.published_as_url',?3,'$.matched_at',?4),updated_at=?5 WHERE id=?1 AND json_valid(product_evidence)`)
        .bind(row.sent_id,row.published_id,row.url,at,now()).run();
      await mark(row,{final:1,same:'identical',reason:verdict.reason??null,sent_seconds:verdict.sent_seconds??null,published_seconds:verdict.published_seconds??null});
      totals.identical++;done.add(row.sent_id);
    }catch(e){await again(e?.message??e).catch(()=>null);}
  }
  return totals;
}
