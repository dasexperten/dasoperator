import { apiGet, apiPost, apiPut, apiDelete, type ApiResponse } from './api';

export type GmailAttachment = { partId: string; filename: string; mimeType: string; size: number; contentId?: string; inline?: boolean };
export type GmailMessage = {
  provider?: string; account: string; id: string; gmailThreadId?: string; labelIds: string[];
  snippet?: string; timestamp: string; subject: string; from: string; to: string; cc?: string; bcc?: string;
  replyTo?: string; messageId?: string; inReplyTo?: string; references?: string | string[];
  text?: string; html?: string; attachments?: GmailAttachment[];
};
export type GmailFile = { filename: string; mimeType: string; content: string; contentId?: string; inline?: boolean };
export type GmailDraftInput = { id?: string; from: string; to: string; cc?: string; bcc?: string; subject: string; text: string; html?: string; gmailThreadId?: string; inReplyTo?: string; references?: string | string[]; attachments: GmailFile[] };
export type GmailAction = 'read' | 'unread' | 'star' | 'unstar' | 'archive' | 'inbox' | 'trash' | 'untrash';
const base = '/api/email/gmail';
const accountPath = (account: string) => `${base}/${encodeURIComponent(account)}`;
async function result<T>(promise: Promise<ApiResponse<T>>): Promise<T> {
  const response = await promise;
  if (!response.success || !response.result) throw new Error('Google Почта: запрос не выполнен. Повторите попытку.');
  return response.result;
}
export const gmailAccounts = () => result(apiGet<{ accounts: { email: string }[] }>(`${base}/accounts`));
export const gmailIdentities = (account: string) => result(apiGet<{ identities: string[] }>(`${accountPath(account)}/identities`));
export const gmailList = (account: string, params: { q?: string; label?: string; pageToken?: string }) => result(apiGet<{ messages: GmailMessage[]; nextPageToken?: string; resultSizeEstimate?: number }>(`${accountPath(account)}/messages?${new URLSearchParams(Object.entries(params).filter(([, value]) => !!value) as [string, string][])}`));
export const gmailBody = (account: string, id: string) => result(apiGet<{ message: GmailMessage }>(`${accountPath(account)}/messages/${encodeURIComponent(id)}`));
export const gmailDrafts = (account: string, pageToken?: string) => result(apiGet<{ drafts: { id: string; message: GmailMessage }[]; nextPageToken?: string }>(`${accountPath(account)}/drafts${pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : ''}`));
export const gmailDraft = (account: string, id: string) => result(apiGet<{ draft: { id: string; message: GmailMessage } }>(`${accountPath(account)}/drafts/${encodeURIComponent(id)}`));
export const gmailSave = (account: string, draft: GmailDraftInput) => result(apiPut<{ draft: { id: string; message: { id: string; threadId: string } } }>(`${accountPath(account)}/drafts`, draft));
export const gmailDeleteDraft = (account: string, id: string) => result(apiDelete(`${accountPath(account)}/drafts/${encodeURIComponent(id)}`));
export const gmailSend = (account: string, id: string) => result(apiPost<{ message: { id: string; threadId: string } }>(`${accountPath(account)}/drafts/${encodeURIComponent(id)}/send`, {}));
export const gmailAction = (account: string, id: string, action: GmailAction) => result(apiPost(`${accountPath(account)}/messages/${encodeURIComponent(id)}/action`, { action }));
export async function gmailDownload(account: string, messageId: string, partId: string): Promise<Blob> {
  const token = localStorage.getItem('dx_auth_token');
  const response = await fetch(`https://dasoperator-api.dasexperten.workers.dev${accountPath(account)}/messages/${encodeURIComponent(messageId)}/attachment?${new URLSearchParams({ partId })}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error('Не удалось загрузить вложение из Gmail.');
  return response.blob();
}
export async function gmailFile(blob: Blob, filename: string, mimeType: string): Promise<GmailFile> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + 8192)));
  return { filename, mimeType: mimeType || 'application/octet-stream', content: btoa(binary) };
}

export type MailCount = { value: number; more: boolean };
export const gmailCounts = (account: string, queries: { key: string; label?: string; unread?: boolean; q?: string }[]) => result(apiPost<{counts: Record<string, MailCount | null>}>(`${accountPath(account)}/counts`, {queries}));
