import { gmailRequest } from './google-workspace';

export type MailCount = { value: number; more: boolean };
export type CountQuery = { key: string; label?: string; unread?: boolean; q?: string };
export async function gmailCount(token: string, query: CountQuery): Promise<MailCount> {
  if (query.label) {
    const label = await gmailRequest<{ messagesTotal?: number; messagesUnread?: number }>(token, `labels/${encodeURIComponent(query.label)}`);
    const value = query.unread ? label.messagesUnread : label.messagesTotal;
    if (typeof value !== 'number') throw new Error('Google did not return a label count');
    return { value, more: false };
  }
  // Count actual IDs, never present Google's resultSizeEstimate as exact.
  // Bound per-request work; a large mailbox is explicitly shown as N+.
  const ids = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 4; page++) {
    const params = new URLSearchParams({ maxResults: '500', includeSpamTrash: 'true', q: query.q || '' });
    if (cursor) params.set('pageToken', cursor);
    const result = await gmailRequest<{ messages?: { id: string }[]; nextPageToken?: string }>(token, `messages?${params}`);
    for (const message of result.messages || []) ids.add(message.id);
    cursor = result.nextPageToken;
    if (!cursor) break;
  }
  return { value: ids.size, more: !!cursor };
}
