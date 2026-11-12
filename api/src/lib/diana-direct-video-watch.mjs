// Owner 2026-11-12: «a video sent straight into the chat — a model watches it». Gemini watches
// the original Meta video file (picture and sound) and returns plain facts; Diana answers from them.
// Owner 2026-11-12: unpacking as part of the scene is fine; only a video that is all unpacking or
// just showing the product, without use, is a red flag (unboxing_only).
// Nothing about the video is stored: the facts live only in memory for this one decision.
import {download} from './diana-video.mjs';
const MODEL='gemini-3.5-flash';
const PROMPT=`Ты смотришь видео, которое блогер прислала бренду Das Experten (зубные пасты и щётки) в личные сообщения Instagram. Посмотри видео целиком, со звуком. Верни только JSON:
{"summary":"2-3 предложения по-русски: что происходит в видео",
"our_product":"yes|no|unknown — видна ли паста или щётка Das Experten (например оранжевая туба TERMO 39°)",
"product_seen":"что за товар виден, коротко, или null",
"face_visible":"yes|no|unknown — видно ли лицо блогера",
"in_use":"yes|no|unknown — чистит ли она зубы этим товаром в кадре",
"unboxing_only":"yes|no — yes ТОЛЬКО если весь ролик в основном про распаковку или просто показ товара, без использования; если распаковка или коробка лишь часть общей сцены, где она пользуется пастой, это no",
"speech":"главное, что она говорит, 1-2 предложения, или null",
"kind":"draft_reel|finished_reel|question|other — похоже на черновик ролика для нас, готовый ролик, вопрос или другое"}
Не выдумывай: чего не видно или не слышно, то unknown или null.`;
export async function watchVideo({apiKey,url,fetchImpl=fetch}){
  if(!apiKey||!url)return null;
  const data=await download(url,fetchImpl);
  const r=await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(90000),
    body:JSON.stringify({contents:[{parts:[{inline_data:{mime_type:'video/mp4',data}},{text:PROMPT}]}],generationConfig:{responseMimeType:'application/json',maxOutputTokens:4000,thinkingConfig:{thinkingLevel:'low'}}})});
  if(!r.ok)throw Error('video_watch_'+r.status);
  const body=await r.json();const text=body?.candidates?.[0]?.content?.parts?.map(p=>p.text??'').join('')??'';
  let v=null;try{v=JSON.parse(text);}catch{const m=text.match(/\{[\s\S]*\}/);try{v=m?JSON.parse(m[0]):null;}catch{v=null;}}
  if(Array.isArray(v))v=v[0];
  if(!v)throw Error('video_watch_invalid:'+String(body?.candidates?.[0]?.finishReason??'none'));
  if(typeof v?.summary!=='string'||!v.summary.trim())throw Error('video_watch_invalid');
  const pick=(x,allowed)=>allowed.includes(x)?x:'unknown';
  return {summary:v.summary.slice(0,600),our_product:pick(v.our_product,['yes','no','unknown']),product_seen:v.product_seen?String(v.product_seen).slice(0,120):null,
    face_visible:pick(v.face_visible,['yes','no','unknown']),in_use:pick(v.in_use,['yes','no','unknown']),unboxing_only:pick(v.unboxing_only,['yes','no']),
    speech:v.speech?String(v.speech).slice(0,300):null,kind:pick(v.kind,['draft_reel','finished_reel','question','other'])};
}
