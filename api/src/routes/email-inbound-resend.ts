// =============================================================================
// Входящая почта dasexperten.ru — вебхук Resend (Owner 2026-08-27).
//
// Почему отдельный путь, а не общий email() воркера.
// Штатный обработчик `email:` в index.ts — это Cloudflare Email Routing: он
// получает ForwardableEmailMessage и работает только для доменов, лежащих в
// Cloudflare. Домен dasexperten.ru там не лежит и лежать не будет: перенос NS
// отклонён Владельцем в мае 2026 из-за риска для выдачи. Resend отдаёт письмо
// не сообщением, а POST-запросом, поэтому нужна дверь по HTTP.
//
// Куда кладём. В тот же archiveEmail, что наполняет /emailer по .com. Никакого
// второго хранилища: одна папка Inbox/<адрес>/received/, один индекс, один
// экран. Ящик, показанный в реестре, показывает настоящие письма.
//
// Тело письма в вебхуке не приходит. Resend шлёт метаданные (кто, кому, тема)
// и id; за текстом и вложениями идём отдельным запросом в Receiving API. Это
// не наша прихоть, а форма события: письмо может весить мегабайты, событие —
// нет.
//
// Подпись обязательна. Эндпоинт открыт всему интернету, и без проверки любой
// желающий положил бы нам в архив письмо от имени клиента. Формат Svix:
// HMAC-SHA256 по строке `id.timestamp.body` ключом из whsec_, окно 5 минут.
// Нет секрета — маршрут отвечает 503 и ничего не пишет: замолчать безопаснее,
// чем принять неподписанное.
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { archiveEmail, type ArchiveEmailInput } from '../lib/inbox-archive';

const app = new Hono<{ Bindings: Env }>();

/** Окно, за пределами которого подпись считается протухшей (защита от повтора). */
const TOLERANCE_SEC = 5 * 60;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: ArrayBuffer): string {
  const arr = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i] as number);
  return btoa(s);
}

/** Сравнение за постоянное время: обычное === утекает длину общего префикса. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Проверка подписи Svix, как её шлёт Resend.
 * Заголовок svix-signature может нести несколько подписей через пробел
 * ("v1,<base64> v1,<base64>") — при ротации секрета там лежат обе, и принять
 * надо, если совпала хотя бы одна.
 */
async function verifySvix(
  secret: string,
  svixId: string,
  svixTimestamp: string,
  body: string,
  svixSignature: string
): Promise<boolean> {
  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  const drift = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (drift > TOLERANCE_SEC) return false;

  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  let keyBytes: Uint8Array;
  try {
    keyBytes = b64ToBytes(raw);
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signed = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${svixId}.${svixTimestamp}.${body}`)
  );
  const expected = bytesToB64(signed);

  for (const part of svixSignature.split(' ')) {
    const value = part.includes(',') ? part.split(',')[1] : part;
    if (value && timingSafeEqual(value, expected)) return true;
  }
  return false;
}

/** Первый адрес нашего домена среди получателей — под ним и лежит папка. */
function pickOurMailbox(to: unknown): string {
  const list = Array.isArray(to) ? to : to ? [to] : [];
  for (const entry of list) {
    const raw = String(entry);
    const m = /<([^>]+)>/.exec(raw);
    const addr = (m?.[1] ?? raw).trim().toLowerCase();
    if (addr.endsWith('@dasexperten.ru')) return addr;
  }
  const first = list[0] ? String(list[0]) : '';
  const m = /<([^>]+)>/.exec(first);
  return (m?.[1] ?? first).trim().toLowerCase();
}

/**
 * Тело письма отдельным запросом: событие несёт только метаданные.
 * Молчаливо возвращаем пустое, если не достали — письмо с темой и отправителем
 * лучше, чем потерянное письмо.
 */
async function fetchReceived(env: Env, emailId: string): Promise<Record<string, unknown> | null> {
  if (!env.RESEND_API_KEY || !emailId) return null;
  try {
    const res = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

app.post('/resend', async (c) => {
  const secret = c.env.RESEND_INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    // Секрета нет — принять нечего проверить. Не 200: пусть Resend повторит,
    // он держит письмо у себя и отдаст, когда дверь будет готова.
    return c.json({ success: false, error: 'webhook_secret_missing' }, 503);
  }

  const svixId = c.req.header('svix-id') ?? '';
  const svixTimestamp = c.req.header('svix-timestamp') ?? '';
  const svixSignature = c.req.header('svix-signature') ?? '';
  const body = await c.req.text();

  if (!svixId || !svixTimestamp || !svixSignature) {
    return c.json({ success: false, error: 'signature_headers_missing' }, 400);
  }
  if (!(await verifySvix(secret, svixId, svixTimestamp, body, svixSignature))) {
    return c.json({ success: false, error: 'signature_invalid' }, 401);
  }

  let event: { type?: string; data?: Record<string, unknown> };
  try {
    event = JSON.parse(body) as typeof event;
  } catch {
    return c.json({ success: false, error: 'body_not_json' }, 400);
  }

  // Чужие события не наша забота, но 200 обязателен: иначе Resend будет их
  // повторять вечно.
  if (event.type !== 'email.received') {
    return c.json({ success: true, skipped: event.type ?? 'unknown' });
  }

  const d = event.data ?? {};
  const emailId = String(d.email_id ?? d.id ?? '');
  const mailbox = pickOurMailbox(d.to);
  if (!mailbox) return c.json({ success: true, skipped: 'no_recipient' });

  const full = await fetchReceived(c.env, emailId);
  const src: Record<string, unknown> = full ?? d;

  const payload: ArchiveEmailInput = {
    to: (src.to ?? d.to) as string | string[] | undefined,
    from: (src.from ?? d.from) as string | undefined,
    cc: (src.cc ?? d.cc) as string | string[] | undefined,
    subject: String(src.subject ?? d.subject ?? '(без темы)'),
    text: (src.text as string | undefined) ?? undefined,
    html: (src.html as string | undefined) ?? undefined,
    messageId: emailId || undefined,
    origin: 'human',
  };

  await archiveEmail(c.env, 'received', mailbox, payload);

  return c.json({ success: true, mailbox, email_id: emailId, body_fetched: full !== null });
});

export default app;
