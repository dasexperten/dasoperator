import type { Env } from '../types';

export const WORKSPACE_ADDRESSES = ['sysadmin', 'webmaster', 'sales', 'asean', 'geo', 'logistics', 'legal', 'support'].map(n => `${n}@dasexperten.com`);
export interface WorkspaceAccount { email: string; refreshToken: string }
export function workspaceAccounts(env: Env): WorkspaceAccount[] {
  if (!env.GOOGLE_WORKSPACE_ACCOUNTS) return [];
  const accounts: unknown = JSON.parse(env.GOOGLE_WORKSPACE_ACCOUNTS);
  if (!Array.isArray(accounts) || accounts.some(a => !a || typeof a.email !== 'string' || !/^[a-z0-9._-]+@dasexperten\.com$/i.test(a.email) || typeof a.refreshToken !== 'string' || !a.refreshToken)) {
    throw new Error('Workspace account configuration is invalid');
  }
  return accounts.map(a => ({ email: a.email.toLowerCase(), refreshToken: a.refreshToken }));
}
export async function workspaceToken(env: Env, account: WorkspaceAccount): Promise<string> {
  if (!env.GOOGLE_WORKSPACE_CLIENT_ID || !env.GOOGLE_WORKSPACE_CLIENT_SECRET) throw new Error('Workspace OAuth client is not configured');
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', client_id: env.GOOGLE_WORKSPACE_CLIENT_ID, client_secret: env.GOOGLE_WORKSPACE_CLIENT_SECRET, refresh_token: account.refreshToken }),
  });
  const data = await response.json() as { access_token?: string };
  // Never surface Google's response body: it may contain credential material.
  if (!response.ok || !data.access_token) throw new Error(`Workspace authorization failed (${response.status}); reconnect this account`);
  return data.access_token;
}
export async function gmailRequest<T>(token: string, path: string): Promise<T> {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Gmail request failed (${response.status})`);
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
      const identities = await gmailRequest<{ sendAs: { sendAsEmail: string; verificationStatus: string }[] }>(token, 'settings/sendAs');
      results.push({ email: account.email, connected: true, messageCount: profile.messagesTotal, sendAs: identities.sendAs.filter(s => s.verificationStatus === 'accepted').map(s => s.sendAsEmail.toLowerCase()), error: null });
    } catch (error) {
      results.push({ email: account.email, connected: false, messageCount: null, sendAs: [] as string[], error: error instanceof Error ? error.message : 'Connection failed' });
    }
  }
  return {
    checkedAt: new Date().toISOString(),
    oauthConfigured: !!(env.GOOGLE_WORKSPACE_CLIENT_ID && env.GOOGLE_WORKSPACE_CLIENT_SECRET),
    accounts: results,
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
  const { default: PostalMime } = await import('postal-mime');
  const { archiveEmail } = await import('./inbox-archive');
  const receipts = [];
  for (const message of page.messages || []) {
    if (!/^[a-z0-9]+$/i.test(message.id)) throw new Error('Invalid Gmail message identifier');
    const receiptKey = `Workspace/receipts/${email}/${message.id}.json`;
    const receipt = await env.ARCHIVE.get(receiptKey);
    if (receipt) { receipts.push(await receipt.json()); continue; }
    const raw = await gmailRequest<{ raw: string; threadId: string; internalDate: string; labelIds?: string[] }>(token, `messages/${message.id}?format=raw`);
    const encoded = raw.raw.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const direction = raw.labelIds?.includes('SENT') ? 'sent' : 'received';
    // Full original MIME is retained even if parsing or attachment storage fails.
    await env.ARCHIVE.put(`Workspace/raw/${email}/${message.id}.eml`, bytes, { httpMetadata: { contentType: 'message/rfc822' } });
    const parsed = await PostalMime.parse(bytes);
    const address = (a: { name?: string; address?: string }) => a.address || '';
    const to = (parsed.to || []).map(address).filter(Boolean);
    const identities = direction === 'sent' ? [parsed.from?.address || email] : [...to, ...(parsed.cc || []).map(address)];
    const boxes = [...new Set(identities.map(a => a.toLowerCase().replace(/\+[^@]+(?=@)/, '')).filter(a => WORKSPACE_ADDRESSES.includes(a)))];
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
  return { email, receipts, nextPageToken: page.nextPageToken || null, complete: !page.nextPageToken };
}
