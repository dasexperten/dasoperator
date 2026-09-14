import { Hono } from 'hono';
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
  const status = error instanceof GmailError && error.status === 404 ? 404 : 502;
  return fail(c, status, [{code:'gmail_unavailable',message:status === 404 ? 'Connected mailbox or message not found' : 'Google mail request failed. Reconnect the mailbox or retry.'}]);
});
route.get('/accounts', c => ok(c, {accounts:workspaceAccounts(c.env).map(a => ({email:a.email})), provider:'gmail'}));
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
export default route;
