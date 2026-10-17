// Owner decision 2026-09-19: ERP alerts go to @dasexpertenbot, never Saved Messages.
// The organization owns the bot token and recipient; ERP uses its authenticated door.
import type { Env } from '../types';

// The message is signed by the seat whose work it reports (Owner 2026-10-16:
// UGC payout notices are Diana's, not Mina's). Mina stays the default for ERP
// system alerts.
export async function sendOwnerTelegram(env: Env, text: string, slug = 'mina-rutunya'): Promise<boolean> {
  const secret = env.DASORG_API_KEY;
  if (!secret || !env.ORGANIZATION) {
    console.warn('[owner-telegram] organization bot route not configured — nothing sent');
    return false;
  }
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug, text, report: true }),
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

// Owner 2026-10-17: a hard Diana question goes to Telegram with answer buttons.
// Returns the Telegram message id, so the tap can find the question again.
export async function sendOwnerQuestion(env: Env, text: string, buttons: string[], slug = 'diana-helios'): Promise<number | null> {
  const secret = env.DASORG_API_KEY;
  if (!secret || !env.ORGANIZATION) return null;
  try {
    const res = await env.ORGANIZATION.fetch('https://organizacia.internal/api/telegram-bot/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug, text, report: true, options: buttons.map((button, i) => ({ key: `ans${i}`, button, explanation: '' })) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const result = await res.json() as { ok?: boolean; message_id?: number };
    return result.ok === true && typeof result.message_id === 'number' ? result.message_id : null;
  } catch {
    return null;
  }
}
