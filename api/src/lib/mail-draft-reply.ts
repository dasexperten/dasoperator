import type { Env } from '../types';

// Saved reply context survives closing/reopening a draft. It carries no auth data.
export interface DraftReplyContext {
  draft_id: string;
  user_id: string;
  from_addr: string;
  in_reply_to: string;
  references_json: string;
  reply_to_tag: string;
  body_sha256: string;
  html: string;
}

const address = (value: string) => (value.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] || '').toLowerCase();

export async function readDraftReplyContext(env: Env, userId: string, draftId: string) {
  try {
    return await env.DB.prepare('SELECT * FROM email_draft_reply_context WHERE draft_id = ? AND user_id = ?')
      .bind(draftId, userId).first<DraftReplyContext>();
  } catch (error) {
    // Older databases have no contextual drafts yet.
    if (String(error).includes('no such table: email_draft_reply_context')) return null;
    throw error;
  }
}

export async function restoreDraftReply(context: DraftReplyContext | null, input: { from: string; text: string; in_reply_to?: string }) {
  if (!context || (input.in_reply_to && input.in_reply_to !== context.in_reply_to)) return {};
  const references = JSON.parse(context.references_json) as string[];
  if (!Array.isArray(references) || references.some(value => typeof value !== 'string' || /[\r\n]/.test(value))) {
    throw new Error('Invalid saved reply references');
  }
  const sameSender = address(input.from) === address(context.from_addr);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.text));
  const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return {
    in_reply_to: context.in_reply_to,
    references,
    preserveThreadRecipients: true,
    ...(context.reply_to_tag ? { replyToTag: context.reply_to_tag } : {}),
    ...(sameSender ? { from: context.from_addr } : {}),
    // An edited message must never send the old HTML instead of the user's text.
    ...(sameSender && hash === context.body_sha256 ? { html: context.html } : {}),
  };
}
