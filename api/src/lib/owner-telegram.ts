// Owner decision 2026-09-19: ERP alerts go to @dasexpertenbot, never Saved Messages.
// The organization owns the bot token and recipient; ERP uses its authenticated door.
import type { Env } from '../types';

export async function sendOwnerTelegram(env: Env, text: string): Promise<boolean> {
  const secret = env.DASORG_API_KEY;
  if (!secret || !env.ORGANIZATION) {
    console.warn('[owner-telegram] organization bot route not configured — nothing sent');
    return false;
  }
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'mina-rutunya', text, report: true }),
    signal: AbortSignal.timeout(20_000),
  };
  try {
    const res = await env.ORGANIZATION.fetch('https://organizacia.internal/api/telegram-bot/send', init);
    if (!res.ok) {
      console.warn(`[owner-telegram] bot route HTTP ${res.status}`);
      return false;
    }
    const result = await res.json() as { ok?: boolean; message_id?: number };
    return result.ok === true && typeof result.message_id === 'number';
  } catch {
    console.warn('[owner-telegram] bot delivery failed');
    return false;
  }
}
