import type { Env } from '../types';
import { MAILBOX_REGISTRY, findMailbox } from './mailbox-registry';

// Migration covers every visible ERP mailbox, including the .ru departments.
// geo is the Owner-requested replacement identity for Julian; retain the old
// partnerships archive until historical mail has been migrated.
export const WORKSPACE_ADDRESSES = [...new Set([...MAILBOX_REGISTRY.filter(m => m.showInUi && m.inbound === 'worker').map(m => m.address), 'geo@dasexperten.com'])];
export interface WorkspaceAccount { email: string; refreshToken: string }
export function workspaceAccounts(env: Env): WorkspaceAccount[] {
  if (!env.GOOGLE_WORKSPACE_ACCOUNTS) return [];
  const accounts: unknown = JSON.parse(env.GOOGLE_WORKSPACE_ACCOUNTS);
  if (!Array.isArray(accounts) || accounts.some(a => !a || typeof a.email !== 'string' || !/^[a-z0-9._-]+@dasexperten\.com$/i.test(a.email) || typeof a.refreshToken !== 'string' || !a.refreshToken)) {
    throw new Error('Workspace account configuration is invalid');
  }
  return accounts.map(a => ({ email: a.email.toLowerCase(), refreshToken: a.refreshToken }));
}
export async function workspaceGrant(env: Env, account: WorkspaceAccount): Promise<{token: string; expiresIn: number}> {
  if (!env.GOOGLE_WORKSPACE_CLIENT_ID || !env.GOOGLE_WORKSPACE_CLIENT_SECRET) throw new Error('Workspace OAuth client is not configured');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.GOOGLE_WORKSPACE_CLIENT_ID, client_secret: env.GOOGLE_WORKSPACE_CLIENT_SECRET, refresh_token: account.refreshToken }),
  });
  const data = await response.json() as { access_token?: string; expires_in?: number };
  // Never surface Google's response body: it may contain credential material.
  if (!response.ok || !data.access_token) throw new Error(`Workspace authorization failed (${response.status}); reconnect this account`);
  return {token:data.access_token,expiresIn:typeof data.expires_in === 'number' ? data.expires_in : 0};
}
export async function workspaceToken(env: Env, account: WorkspaceAccount): Promise<string> {
  return (await workspaceGrant(env,account)).token;
}
export class GmailError extends Error {
  constructor(public status: number) { super(`Gmail request failed (${status})`); }
}
export async function gmailRequest<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new GmailError(response.status);
  return response.json() as Promise<T>;
}
export async function workspaceStatus(env: Env) {
  const accounts = workspaceAccounts(env);
  const results: { email: string; connected: boolean; messageCount: number | null; sendAs: string[]; error: string | null }[] = [];
  for (const account of accounts) {
    try {
      const token = await workspaceToken(env, account);
      const profile = await gmailRequest<{ emailAddress: string; messagesTotal: number }>(token, 'profile');
      if (profile.emailAddress.toLowerCase() !== account.email) throw new Error('Connected Google account does not match the configured business mailbox');
      const identities = await gmailRequest<{ sendAs: { sendAsEmail: string; verificationStatus?: string; isPrimary?: boolean }[] }>(token, 'settings/sendAs');
      results.push({ email: account.email, connected: true, messageCount: profile.messagesTotal, sendAs: identities.sendAs.filter(s => s.verificationStatus === 'accepted' || (s.isPrimary === true && s.sendAsEmail.toLowerCase() === account.email)).map(s => s.sendAsEmail.toLowerCase()), error: null });
    } catch (error) {
      results.push({ email: account.email, connected: false, messageCount: null, sendAs: [] as string[], error: error instanceof Error ? error.message : 'Connection failed' });
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    oauthConfigured: !!(env.GOOGLE_WORKSPACE_CLIENT_ID && env.GOOGLE_WORKSPACE_CLIENT_SECRET),
    accounts: results,
    synchronization: await Promise.all(accounts.map(async account => {
      const object = env.ARCHIVE ? await env.ARCHIVE.get(`Workspace/sync/${account.email}.json`) : null;
      const state: WorkspaceSyncState | null = object ? await object.json() : null;
      return { email: account.email, mode: state?.mode || 'pending', lastSuccessAt: state?.lastSuccessAt || null, error: state?.lastError || null };
    })),
    addresses: WORKSPACE_ADDRESSES.map(address => ({ address, owner: address.startsWith('geo@') ? 'Julian' : 'Aram', connectedMailbox: results.find(a => a.connected && a.sendAs.includes(address))?.email || null })),
    // Identity access proves neither MX delivery nor forwarding/ERP durability.
    replacementReady: false,
    remainingChecks: ['Receive external mail at every business address', 'Send and receive a reply using every business identity', 'Verify message bodies and attachments in the ERP archive', 'Verify selected mail is visible in dasexperten@gmail.com'],
  };
}

// Imports one bounded page. The caller continues with nextPageToken until done.
// Tokens advance only after every message and its attachments reached ERP/R2.
export async function syncWorkspacePage(env: Env, email: string, pageToken?: string) {
  const account = workspaceAccounts(env).find(a => a.email === email);
  if (!account) throw new Error('Business mailbox is not connected');
  const token = await workspaceToken(env, account);
  const profile = await gmailRequest<{ emailAddress: string }>(token, 'profile');
  if (profile.emailAddress.toLowerCase() !== email) throw new Error('Connected mailbox identity mismatch');
  const query = new URLSearchParams({ maxResults: '20', q: '-in:drafts -in:spam -in:trash' });
  if (pageToken) query.set('pageToken', pageToken);
  const page = await gmailRequest<{ messages?: { id: string }[]; nextPageToken?: string }>(token, `messages?${query}`);
  const receipts = await archiveWorkspaceMessages(env, email, token, page.messages || []);
  return { email, receipts, nextPageToken: page.nextPageToken || null, complete: !page.nextPageToken };
}

async function archiveWorkspaceMessages(env: Env, email: string, token: string, messages: { id: string }[]) {
  const { default: PostalMime } = await import('postal-mime');
  const { archiveEmail } = await import('./inbox-archive');
  const receipts = [];
  for (const message of messages) {
    if (!/^[a-z0-9]+$/i.test(message.id)) throw new Error('Invalid Gmail message identifier');
    const receiptKey = `Workspace/receipts/${email}/${message.id}.json`;
    const receipt = await env.ARCHIVE.get(receiptKey);
    if (receipt) { receipts.push(await receipt.json()); continue; }
    let raw: { raw: string; threadId: string; internalDate: string; labelIds?: string[] };
    try { raw = await gmailRequest(token, `messages/${message.id}?format=raw`); }
    catch (error) {
      // Mail permanently deleted between listing and fetch has no body to import.
      if (error instanceof GmailError && error.status === 404) continue;
      throw error;
    }
    if (raw.labelIds?.includes('DRAFT')) continue;
    const encoded = raw.raw.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const direction = raw.labelIds?.includes('SENT') ? 'sent' : 'received';
    // Full original MIME is retained even if parsing or attachment storage fails.
    await env.ARCHIVE.put(`Workspace/raw/${email}/${message.id}.eml`, bytes, { httpMetadata: { contentType: 'message/rfc822' } });
    const parsed = await PostalMime.parse(bytes);
    const address = (a: { name?: string; address?: string }) => a.address || '';
    const to = (parsed.to || []).map(address).filter(Boolean);
    const envelope = parsed.headers.filter(h => h.key?.toLowerCase() === 'x-das-erp-recipient').map(h => h.value).filter((value): value is string => typeof value === 'string');
    const identities = direction === 'sent' ? [parsed.from?.address || email] : [...to, ...(parsed.cc || []).map(address), ...envelope];
    const boxes = [...new Set(identities.map(a => { const normalized = a.toLowerCase().replace(/\+[^@]+(?=@)/, ''); return findMailbox(normalized)?.address || normalized; }).filter(a => WORKSPACE_ADDRESSES.includes(a)))];
    if (!boxes.length) boxes.push(email);
    const keys = [];
    for (const mailbox of boxes) {
      const key = await archiveEmail(env, direction, mailbox, {
        from: parsed.from?.address || email, to, cc: (parsed.cc || []).map(address),
        subject: parsed.subject || '(no subject)', text: parsed.text || '', html: parsed.html || '',
        messageId: parsed.messageId || `gmail:${email}:${message.id}`, threadId: `gmail:${email}:${raw.threadId}`,
        origin: 'human', trigger: 'workspace-sync', attachments: parsed.attachments,
      }, { strict: true, recordId: `workspace-${btoa(email).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}-${message.id}`, timestamp: new Date(Number(raw.internalDate)).toISOString() });
      if (!key || !(await env.ARCHIVE.head(key))) throw new Error('ERP archive readback failed');
      keys.push(key);
    }
    const result = { messageId: message.id, direction, keys, attachments: parsed.attachments.length };
    await env.ARCHIVE.put(receiptKey, JSON.stringify(result));
    receipts.push(result);
  }
  return receipts;
}

interface WorkspaceSyncState {
  mode: 'full' | 'history';
  historyId?: string | undefined;
  pageToken?: string | undefined;
  pendingIds?: string[];
  pendingNextPage?: string | undefined;
  pendingHistoryId?: string | undefined;
  leaseUntil?: number;
  lastSuccessAt?: string;
  lastError?: string | null;
}

// A conditional R2 write owns both the lease and cursor. A worker whose lease
// expires cannot overwrite a newer worker's progress. Every tick is bounded.
export async function syncWorkspaceAccount(env: Env, account: WorkspaceAccount) {
  const key = `Workspace/sync/${account.email}.json`;
  const object = await env.ARCHIVE.get(key);
  const previous: WorkspaceSyncState = object ? await object.json() : { mode: 'full' };
  if ((previous.leaseUntil || 0) > Date.now()) return { email: account.email, busy: true };
  const claimed = await env.ARCHIVE.put(key, JSON.stringify({ ...previous, leaseUntil: Date.now() + 90_000 }), {
    onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
  });
  if (!claimed) return { email: account.email, busy: true };
  const state = { ...previous };
  try {
    const token = await workspaceToken(env, account);
    const profile = await gmailRequest<{ emailAddress: string; historyId: string }>(token, 'profile');
    if (profile.emailAddress.toLowerCase() !== account.email) throw new Error('Connected mailbox identity mismatch');
    if (!profile.historyId) throw new Error('Gmail history cursor missing');
    let count = 0;
    if (state.mode === 'full') {
      // Capture the starting history BEFORE listing, so arrivals during initial
      // import are replayed by the next history pass rather than missed.
      state.historyId ||= profile.historyId;
      const query = new URLSearchParams({ maxResults: '20', q: '-in:drafts', includeSpamTrash: 'true' });
      if (state.pageToken) query.set('pageToken', state.pageToken);
      const page = await gmailRequest<{ messages?: { id: string }[]; nextPageToken?: string }>(token, `messages?${query}`);
      count = (await archiveWorkspaceMessages(env, account.email, token, page.messages || [])).length;
      state.pageToken = page.nextPageToken;
      if (!page.nextPageToken) state.mode = 'history';
    } else {
      if (!state.pendingIds) {
        const query = new URLSearchParams({ startHistoryId: state.historyId!, maxResults: '20', historyTypes: 'messageAdded' });
        if (state.pageToken) query.set('pageToken', state.pageToken);
        try {
          const page = await gmailRequest<{ history?: { messagesAdded?: { message: { id: string } }[] }[]; historyId: string; nextPageToken?: string }>(token, `history?${query}`);
          state.pendingIds = [...new Set((page.history || []).flatMap(h => (h.messagesAdded || []).map(m => m.message.id)))];
          state.pendingNextPage = page.nextPageToken;
          state.pendingHistoryId = page.historyId;
        } catch (error) {
          if (!(error instanceof GmailError) || error.status !== 404) throw error;
          // Expired Google history is recovered by a complete receipt-aware scan.
          state.mode = 'full';
          state.historyId = profile.historyId;
          delete state.pageToken;
        }
      }
      if (state.pendingIds) {
        count = (await archiveWorkspaceMessages(env, account.email, token, state.pendingIds.slice(0, 20).map(id => ({ id })))).length;
        state.pendingIds = state.pendingIds.slice(20);
        if (!state.pendingIds.length) {
          state.pageToken = state.pendingNextPage;
          if (!state.pageToken) state.historyId = state.pendingHistoryId || state.historyId;
          delete state.pendingIds;
          delete state.pendingNextPage;
          delete state.pendingHistoryId;
        }
      }
    }
    state.leaseUntil = 0;
    state.lastSuccessAt = new Date().toISOString();
    state.lastError = null;
    const committed = await env.ARCHIVE.put(key, JSON.stringify(state), { onlyIf: { etagMatches: claimed.etag } });
    if (!committed) throw new Error('Workspace sync lease changed');
    return { email: account.email, archived: count, mode: state.mode };
  } catch {
    // Retain the committed cursor on every failure; archive receipts make retries
    // safe even if some messages succeeded before an attachment or index failed.
    await env.ARCHIVE.put(key, JSON.stringify({ ...previous, leaseUntil: 0, lastError: 'Sync failed; progress retained for retry' }), { onlyIf: { etagMatches: claimed.etag } });
    return { email: account.email, error: 'Sync failed; progress retained for retry' };
  }
}

export async function syncConnectedWorkspace(env: Env) {
  const results = [];
  for (const account of workspaceAccounts(env)) results.push(await syncWorkspaceAccount(env, account));
  return results;
}
