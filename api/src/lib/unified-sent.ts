import type { Env } from '../types';
import { gmailRequest } from './google-workspace';
import { gmailMetadataBatch } from './gmail-metadata-batch';
import { gmailSummary } from './gmail-client';
import { entryFromRow } from './mail-index-sync';

const encode = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const decode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)));
export const sentArchiveId = (key: string) => 'erp.'+encode(key);
export function sentArchiveKey(id: string): string {
  const key=decode(id.slice(4));
  if(!/^Inbox\/[^/]+\/sent\/[^/]+\.json$/.test(key))throw Error('Invalid sent archive identity');
  return key;
}
const addresses = (v: unknown) => Array.isArray(v) ? v.join(', ') : typeof v==='string' ? v : '';
export function sentArchiveMessage(account: string, key: string, r: any) {
  return {provider:'erp',account,id:sentArchiveId(key),labelIds:['SENT'],timestamp:r.timestamp,subject:r.subject || '(Без темы)',from:addresses(r.from),to:addresses(r.to),cc:addresses(r.cc),bcc:addresses(r.bcc),replyTo:r.replyTo || '',messageId:/^<[^<>]+>$/.test(r.messageId || '')?r.messageId:'',text:r.text || '',html:r.html || '',snippet:(r.text || '').slice(0,200),attachments:(r.attachments || []).filter((f:any)=>!f.skipped&&f.key).map((f:any)=>({partId:f.id,filename:f.filename,mimeType:f.mimeType,size:f.size,inline:f.inline,contentId:f.contentId}))};
}
export async function sentArchiveRecord(env: Env,id: string) {
  const key=sentArchiveKey(id),object=await env.ARCHIVE.get(key);
  if(!object)throw Error('Sent archive message not found');
  return {key,record:await object.json<any>()};
}
interface Cursor {g?:string | undefined; pending?:string[]; done?:boolean; a?:{time:string;key:string}}
export function sentCursor(raw?:string): Cursor {
  if(!raw)return {};
  const c=JSON.parse(decode(raw));
  if(!c||typeof c!=='object'||(c.g!==undefined&&(typeof c.g!=='string'||c.g.length>2048))||(c.pending!==undefined&&(!Array.isArray(c.pending)||c.pending.length>25||c.pending.some((id:unknown)=>typeof id!=='string'||! /^[a-f0-9]{1,32}$/i.test(id))))||(c.done!==undefined&&typeof c.done!=='boolean')||(c.a&& (typeof c.a.time!=='string'||!Number.isFinite(Date.parse(c.a.time))||typeof c.a.key!=='string'||c.a.key.length>512)))throw Error('Invalid sent cursor');
  return c;
}
function archiveFilter(search='',scope='') {
  const where=["direction='sent'","COALESCE(trigger_name,'')!='workspace-sync'"];
  const params:string[]=[];
  if(search){
    // SQLite LOWER handles ASCII only; include ordinary Cyrillic name casing.
    const variants=[...new Set([search,search.toLowerCase(),search.toUpperCase(),search.toLowerCase().replace(/(^|\s)\p{L}/gu,c=>c.toUpperCase())])];
    where.push('('+variants.map(()=>"LOWER(subject || ' ' || COALESCE(from_addr,'') || ' ' || COALESCE(to_addr,'')) LIKE ? ESCAPE '\\'").join(' OR ')+')');
    params.push(...variants.map(s=>'%'+s.replace(/[\\%_]/g,'\\$&')+'%'));
  }
  if(scope){const boxes=scope.split(',');if(boxes.length>20||boxes.some(b=>! /^[^\s,@]+@[^\s,@]+$/.test(b)))throw Error('Invalid sent scope');where.push(`mailbox IN (${boxes.map(()=>'?').join(',')})`);params.push(...boxes.map(b=>b.toLowerCase()));}
  return {where:where.join(' AND '),params};
}
export async function archiveSentCount(env:Env){const f=archiveFilter();const r=await env.DB.prepare(`SELECT COUNT(DISTINCT COALESCE(NULLIF(message_id,''),message_key)) AS n FROM mail_index WHERE ${f.where}`).first<{n:number}>();return r?.n || 0;}
/** Two sorted streams: keep unconsumed Gmail IDs; advance archive only past emitted rows. */
export async function unifiedSent(env:Env,token:string,account:string,search:string,scope:string,raw?:string) {
  const c=sentCursor(raw);
  let ids=c.pending || [];
  while(ids.length<25&&!c.done){const q=new URLSearchParams({labelIds:'SENT',maxResults:String(25-ids.length)});const aliases=scope?scope.split(','):[];if(search||aliases.length)q.set('q',[search,aliases.length?`{${aliases.map(a=>'from:'+a).join(' ')}}`:''].filter(Boolean).join(' '));if(c.g)q.set('pageToken',c.g);const page=await gmailRequest<{messages?:{id:string}[];nextPageToken?:string}>(token,'messages?'+q);ids.push(...(page.messages || []).map(m=>m.id));c.g=page.nextPageToken;c.done=!page.nextPageToken;}
  const gmail=(await gmailMetadataBatch(token,ids)).map(m=>gmailSummary(account,m));
  const f=archiveFilter(search,scope);const values=[...f.params];let older='';if(c.a){older=' AND (timestamp < ? OR (timestamp = ? AND message_key < ?))';values.push(c.a.time,c.a.time,c.a.key);}
  // One copy per accepted send, even when indexed in an additional CC mailbox.
  const rows=await env.DB.prepare(`SELECT * FROM mail_index WHERE message_key IN (SELECT MIN(message_key) FROM mail_index WHERE ${f.where} GROUP BY COALESCE(NULLIF(message_id,''),message_key))${older} ORDER BY timestamp DESC,message_key DESC LIMIT 25`).bind(...values).all<Record<string,unknown>>();
  const archived=(rows.results || []).map(r=>{const e=entryFromRow(r);return sentArchiveMessage(account,e.key,e);});
  const messages=[...gmail,...archived].sort((a,b)=>b.timestamp.localeCompare(a.timestamp)||b.id.localeCompare(a.id)).slice(0,25);
  const emitted=new Set(messages.map(m=>m.id));c.pending=gmail.filter(m=>!emitted.has(m.id)).map(m=>m.id);
  const used=archived.filter(m=>emitted.has(m.id));if(used.length){const last=used[used.length-1]!;c.a={time:last.timestamp,key:sentArchiveKey(last.id)};}
  const more=c.pending.length>0||!c.done||archived.some(m=>!emitted.has(m.id))||archived.length===25;
  return {provider:'unified',account,messages,nextPageToken:more?encode(JSON.stringify(c)):null,resultSizeEstimate:messages.length};
}
