// A short line to the Owner's Telegram through telegramer-bridge.
// Worker-to-worker on the same account must use the service binding: a fetch to the
// bridge's public *.workers.dev address is refused by Cloudflare (error 1042), so alerts
// sent that way never arrived. The public address stays only as a fallback.
import type { Env } from '../types';

export async function sendOwnerTelegram(env: Env, text: string): Promise<boolean> {
  const secret = env.TELEGRAMER_BRIDGE_SECRET;
  if (!secret) {
    console.warn('[owner-telegram] TELEGRAMER_BRIDGE_SECRET not set — nothing sent');
    return false;
  }
  const init: RequestInit = {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: 'me', text, first_message_confirmation: 'ok' }),
  };
  try {
    const bridge = (env as unknown as { TELEGRAMER?: Fetcher }).TELEGRAMER;
    const res = bridge
      ? await bridge.fetch('https://telegramer-bridge.internal/send', init)
      : await fetch('https://telegramer-bridge.dasexperten.workers.dev/send', init);
    if (!res.ok) {
      console.warn(`[owner-telegram] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[owner-telegram] failed:', e);
    return false;
  }
}
