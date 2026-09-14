import { gmailCount, type CountQuery } from '../lib/gmail-counts';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { gmailDraftSchema, composeGmailRaw } from '../lib/gmail-compose';
import type { Env } from '../types';
import { validateSession } from '../lib/auth';
import { ok, fail } from '../lib/responses';
import { GmailError, gmailRequest, workspaceAccounts } from '../lib/google-workspace';
import { gmailSession, gmailMessage, gmailSummary, gmailBody, gmailParts, gmailBytes, type GmailMessage } from '../lib/gmail-client';

const route = new Hono<{ Bindings: Env }>();
route.use('*', async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  const bearer = /^Bearer\s+(.+)$/i.exec(c.req.header('Authorization') || '')?.[1];
  const user = bearer ? await validateSession(c.env.DB, bearer) : null;
  if (!user) return fail(c, 401, [{code:'unauthorized',message:'Valid ERP session required'}]);
  if (user.role !== 'admin') return fail(c, 403, [{code:'forbidden',message:'Mailbox access requires an administrator'}]);
  return next();
});
route.onError((error, c) => {
  const status = error instanceof GmailError && error.status === 404 ? 404 : error instanceof GmailError && error.status === 403 ? 403 : 502;
  return fail(c, status, [{code:'gmail_unavailable',message:status === 404 ? 'Connected mailbox or message not found' : status === 403 ? 'Google permission required. Reconnect Workspace with mail management access.' : 'Google mail request failed. Reconnect the mailbox or retry.'}]);
});
route.get('/accounts', c => ok(c, {accounts:workspaceAccounts(c.env).map(a => ({email:a.email})), provider:'gmail'}));
route.post('/:account/counts', bodyLimit({maxSize:20000}), async c => {
  const body = await c.req.json<{queries?:CountQuery[]}>().catch(() => null);
  const queries = body?.queries;
  if (!Array.isArray(queries) || !queries.length || queries.length > 8 || queries.some(q => !q || typeof q.key !== 'string' || q.key.length > 160 || (q.label !== undefined && (typeof q.label !== 'string' || !/^[A-Z_]{1,32}$/.test(q.label))) || (q.q !== undefined && (typeof q.q !== 'string' || q.q.length > 2048)) || (q.unread !== undefined && typeof q.unread !== 'boolean'))) return fail(c,400,[{code:'invalid_counts',message:'Invalid folder count request'}]);
  const {token}=await gmailSession(c.env,c.req.param('account'));
  const counts:Record<string,Awaited<ReturnType<typeof gmailCount>> | null>=Object.create(null);
  for (let i=0;i<queries.length;i+=4) {
    await Promise.all(queries.slice(i,i+4).map(async q => {
      try { counts[q.key]=await gmailCount(token,q); } catch { counts[q.key]=null; }
    }));
  }
  return ok(c,{counts});
});
route.get('/:account/messages', async c => {
  const pageToken=c.req.query('pageToken'), search=c.req.query('q') || '', label=c.req.query('label');
  if ((pageToken?.length || 0)>2048 || search.length>2048 || (label && !/^[a-zA-Z0-9_-]{1,128}$/.test(label))) return fail(c,400,[{code:'invalid_query',message:'Invalid mail query'}]);
  const {token,account}=await gmailSession(c.env,c.req.param('account'));
  const query=new URLSearchParams({maxResults:'25',includeSpamTrash:'true'});
  if (pageToken) query.set('pageToken',pageToken);
  if (search) query.set('q',search);
  if (label) query.set('labelIds',label);
  const page=await gmailRequest<{messages?:{id:string}[];nextPageToken?:string;resultSizeEstimate?:number}>(token,`messages?${query}`);
  const messages=[];
  // Bounded fan-out: never download message bodies just to paint the list.
  for(let i=0;i<(page.messages?.length || 0);i+=5) {
    const batch=await Promise.all(page.messages!.slice(i,i+5).map(async ({id}) => {
      const message=await gmailRequest<GmailMessage>(token,`messages/${encodeURIComponent(id)}?format=metadata`);
      return gmailSummary(account,message);
    }));
    messages.push(...batch);
  }
  return ok(c,{provider:'gmail',account,messages,nextPageToken:page.nextPageToken || null,resultSizeEstimate:page.resultSizeEstimate || 0});
});
route.get('/:account/messages/:id', async c => {
  const {token,account}=await gmailSession(c.env,c.req.param('account'));
  const message=await gmailMessage(token,c.req.param('id'));
  return ok(c,{message:{...gmailSummary(account,message),...await gmailBody(token,message)}});
});
route.get('/:account/messages/:id/attachment', async c => {
  const partId=c.req.query('partId');
  if (partId === undefined || partId.length>256) return fail(c,400,[{code:'invalid_part',message:'Message attachment part required'}]);
  const {token}=await gmailSession(c.env,c.req.param('account'));
  const message=await gmailMessage(token,c.req.param('id'));
  const part=gmailParts(message.payload).find(p => (p.partId || '') === partId && !p.parts?.length);
  if (!part?.body) return fail(c,404,[{code:'attachment_missing',message:'Attachment not found'}]);
  let data=part.body.data;
  if (part.body.attachmentId) data=(await gmailRequest<{data:string}>(token,`messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`)).data;
  if(data === undefined) return fail(c,404,[{code:'attachment_missing',message:'Attachment not found'}]);
  const bytes=gmailBytes(data);
  const filename=(part.filename || 'attachment').replace(/[\r\n\x00-\x1f]/g,'_');
  c.header('Content-Type','application/octet-stream');
  c.header('X-Content-Type-Options','nosniff');
  c.header('Content-Disposition',`attachment; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g,'%27')}`);
  return c.body(bytes.buffer as ArrayBuffer);
});
async function writeGoogle<T>(token: string, path: string, method: string, body?: unknown): Promise<T> {
  const response=await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body === undefined ? {} : {body:JSON.stringify(body)})});
  if(!response.ok)throw new GmailError(response.status);
  return (response.status === 204 ? {} : await response.json()) as T;
}
async function identities(token: string, account: string) {
  const response=await gmailRequest<{sendAs:{sendAsEmail:string;verificationStatus?:string;isPrimary?:boolean}[]}>(token,'settings/sendAs');
  return response.sendAs.filter(s=>s.verificationStatus === 'accepted' || (s.isPrimary && s.sendAsEmail.toLowerCase() === account)).map(s=>s.sendAsEmail.toLowerCase());
}
route.get('/:account/identities',async c=>{
  const {token,account}=await gmailSession(c.env,c.req.param('account'));
  return ok(c,{identities:await identities(token,account)});
});
route.get('/:account/drafts',async c=>{
  const pageToken=c.req.query('pageToken');
  if((pageToken?.length || 0)>2048)return fail(c,400,[{code:'invalid_query',message:'Invalid page token'}]);
  const {token,account}=await gmailSession(c.env,c.req.param('account'));
  const query=new URLSearchParams({maxResults:'25'});if(pageToken)query.set('pageToken',pageToken);
  const page=await gmailRequest<{drafts?:{id:string;message:{id:string}}[];nextPageToken?:string}>(token,`drafts?${query}`);
  const drafts=[];
  for(let i=0;i<(page.drafts?.length || 0);i+=5) drafts.push(...await Promise.all(page.drafts!.slice(i,i+5).map(async d=>({id:d.id,message:gmailSummary(account,await gmailRequest<GmailMessage>(token,`messages/${encodeURIComponent(d.message.id)}?format=metadata`))}))));
  return ok(c,{drafts,nextPageToken:page.nextPageToken || null});
});
route.get('/:account/drafts/:id',async c=>{
  const {token,account}=await gmailSession(c.env,c.req.param('account'));
  const draft=await gmailRequest<{id:string;message:GmailMessage}>(token,`drafts/${encodeURIComponent(c.req.param('id'))}?format=full`);
  return ok(c,{draft:{id:draft.id,message:{...gmailSummary(account,draft.message),...await gmailBody(token,draft.message)}}});
});
route.put('/:account/drafts',bodyLimit({maxSize:30*1024*1024}),async c=>{
  const parsed=gmailDraftSchema.safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return fail(c,422,[{code:'invalid_draft',message:'Invalid draft fields or attachment limits'}]);
  let raw: string;
  try{raw=composeGmailRaw(parsed.data);}catch{return fail(c,422,[{code:'invalid_attachment',message:'Invalid attachment; maximum 10 MB each and 20 MB total'}]);}
  const {token,account}=await gmailSession(c.env,c.req.param('account'));
  if(!(await identities(token,account)).includes(parsed.data.from.toLowerCase()))return fail(c,403,[{code:'sender_unverified',message:'Sender is not a verified identity of this Google mailbox'}]);
  const {id,gmailThreadId}=parsed.data;
  const draft=await writeGoogle(token,id?`drafts/${encodeURIComponent(id)}`:'drafts',id?'PUT':'POST',{...(id?{id}:{}),message:{raw,...(gmailThreadId?{threadId:gmailThreadId}:{})}});
  return ok(c,{draft});
});
route.delete('/:account/drafts/:id',async c=>{
  const {token}=await gmailSession(c.env,c.req.param('account'));
  await writeGoogle(token,`drafts/${encodeURIComponent(c.req.param('id'))}`,'DELETE');
  return ok(c,{deleted:true});
});
route.post('/:account/drafts/:id/send',async c=>{
  const {token}=await gmailSession(c.env,c.req.param('account'));
  const message=await writeGoogle(token,'drafts/send','POST',{id:c.req.param('id')});
  return ok(c,{message});
});
route.post('/:account/messages/:id/action',async c=>{
  const body=await c.req.json<{action?:string}>().catch(()=>null);
  const actions:Record<string,{addLabelIds?:string[];removeLabelIds?:string[]}>= {
    read:{removeLabelIds:['UNREAD']},unread:{addLabelIds:['UNREAD']},star:{addLabelIds:['STARRED']},unstar:{removeLabelIds:['STARRED']},archive:{removeLabelIds:['INBOX']},inbox:{addLabelIds:['INBOX']},
  };
  const action=body?.action;
  if(!action || (!actions[action] && action!=='trash' && action!=='untrash'))return fail(c,422,[{code:'invalid_action',message:'Unsupported mail action'}]);
  const {token}=await gmailSession(c.env,c.req.param('account'));
  const message=await writeGoogle(token,`messages/${encodeURIComponent(c.req.param('id'))}/${action==='trash'||action==='untrash'?action:'modify'}`,'POST',actions[action] || {});
  return ok(c,{message});
});
export default route;
