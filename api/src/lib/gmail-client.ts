import type { Env } from '../types';
import { GmailError, gmailRequest, workspaceAccounts, workspaceGrant } from './google-workspace';

export interface GmailPart {
  partId?: string; mimeType?: string; filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; attachmentId?: string; size?: number };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string; threadId: string; labelIds?: string[]; snippet?: string;
  internalDate?: string; payload?: GmailPart;
}
export function gmailHeader(part: GmailPart | undefined, name: string) {
  return part?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
}
export function gmailBytes(data: string): Uint8Array {
  return Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}
export function gmailParts(part?: GmailPart): GmailPart[] {
  return part ? [part, ...(part.parts || []).flatMap(gmailParts)] : [];
}
export function gmailSummary(account: string, message: GmailMessage) {
  const header = (name: string) => gmailHeader(message.payload, name);
  return {
    provider: 'gmail' as const, account, id: message.id, gmailThreadId: message.threadId,
    labelIds: message.labelIds || [], snippet: message.snippet || '',
    timestamp: new Date(Number(message.internalDate) || 0).toISOString(),
    subject: header('Subject'), from: header('From'), to: header('To'), cc: header('Cc'), bcc: header('Bcc'),
    replyTo: header('Reply-To'), messageId: header('Message-ID'), inReplyTo: header('In-Reply-To'), references: header('References'),
  };
}
// Isolate-local, short-lived authentication only. No mail or attachments are cached.
const sessions = new Map<string, {until: number; pending: boolean; promise: Promise<{token: string; account: string}>}>();
export function invalidateGmailSessions() { sessions.clear(); }
export async function gmailSession(env: Env, email: string) {
  const account = workspaceAccounts(env).find(a => a.email === email.toLowerCase());
  if (!account) throw new GmailError(404);
  const key=JSON.stringify([account.email,account.refreshToken,env.GOOGLE_WORKSPACE_CLIENT_ID,env.GOOGLE_WORKSPACE_CLIENT_SECRET]);
  const existing=sessions.get(key);
  if (existing && (existing.pending || existing.until>Date.now())) return existing.promise;
  sessions.delete(key);
  while (sessions.size>=16) sessions.delete(sessions.keys().next().value!);
  const entry={until:0,pending:true,promise:Promise.resolve({token:'',account:account.email})};
  entry.promise=(async()=>{
    try {
      const started=Date.now();
      const grant=await workspaceGrant(env,account);
      const profile=await gmailRequest<{emailAddress:string}>(grant.token,'profile');
      if(profile.emailAddress.toLowerCase()!==account.email) throw new GmailError(403);
      entry.until=started+Math.max(0,Math.min(120,grant.expiresIn-30))*1000;
      return {token:grant.token,account:account.email};
    } catch(error) { if(sessions.get(key)===entry)sessions.delete(key);throw error; }
    finally {entry.pending=false;}
  })();
  sessions.set(key,entry);
  return entry.promise;
}
export async function gmailMessage(token: string, id: string) {
  return gmailRequest<GmailMessage>(token, `messages/${encodeURIComponent(id)}?format=full`);
}
export async function gmailBody(token: string, message: GmailMessage) {
  const texts: string[] = [], html: string[] = [];
  const attachments: { partId: string; filename: string; mimeType: string; size: number; contentId: string; inline: boolean }[] = [];
  for (const part of gmailParts(message.payload)) {
    if (part.parts?.length) continue;
    const disposition = gmailHeader(part, 'Content-Disposition');
    const contentId = gmailHeader(part, 'Content-ID').replace(/^<|>$/g, '');
    const isText = !part.filename && !/^attachment/i.test(disposition) && ['text/plain', 'text/html'].includes(part.mimeType || '');
    if (isText) {
      let data = part.body?.data;
      if (data === undefined && part.body?.attachmentId) {
        const response = await gmailRequest<{data: string}>(token, `messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(part.body.attachmentId)}`);
        data = response.data;
      }
      if (data !== undefined) {
        const charset = /charset\s*=\s*"?([^;"\s]+)/i.exec(gmailHeader(part, 'Content-Type'))?.[1] || 'utf-8';
        let decoder: TextDecoder;
        try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder(); }
        (part.mimeType === 'text/html' ? html : texts).push(decoder.decode(gmailBytes(data)));
      }
    } else if (part.body && (part.filename || part.body.attachmentId || part.body.data !== undefined)) {
      attachments.push({ partId: part.partId || '', filename: part.filename || 'attachment', mimeType: part.mimeType || 'application/octet-stream', size: part.body.size || 0, contentId, inline: /^inline/i.test(disposition) || !!contentId });
    }
  }
  return { text: texts.join('\n'), html: html.join('\n'), attachments };
}
