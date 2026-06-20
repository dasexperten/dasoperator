// =============================================================================
// Daily Digest — Cloudflare Worker cron endpoint
//
// POST /api/daily-digest — generates morning digest (Gmail + Calendar + Marketplace)
// Cron: 0 3 * * * (03:00 UTC = 06:00 MSK)
//
// Data sources:
//   1. Gmail via Apps Script (google-apps-script.md)
//   2. Calendar via Apps Script
//   3. Marketplace pulse from D1 (marketplace_sales_daily)
// =============================================================================

import { Hono } from 'hono';
import type { Env } from '../types';
import { ok, fail } from '../lib/responses';

const app = new Hono<{ Bindings: Env }>();

const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbyYhBHfkhvU6anAJeP6l5u-kmWAbP11RhXt0JHHPTVHpGjebsC7Z9LWEy7EszIe8vIB/exec';

interface GmailMessage {
  id: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
  hasAttachment: boolean;
  isUnread: boolean;
}

interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  location?: string;
  description?: string;
}

interface DigestData {
  timestamp: string;
  gmail: { messages: GmailMessage[]; unreadCount: number; waitingForReply: string[] };
  calendar: { events: CalendarEvent[]; todayCount: number };
  marketplace: { ozon: { revenue: number; units: number; delta: number | null }; wb: { revenue: number; units: number; delta: number | null }; combined: number };
}

async function fetchGmail(env: Env): Promise<DigestData['gmail']> {
  try {
    const secret = env.APPS_SCRIPT_SECRET;
    if (!secret) return { messages: [], unreadCount: 0, waitingForReply: [] };
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, action: 'getInbox', window: 24, maxResults: 50 }),
    });
    if (!res.ok) return { messages: [], unreadCount: 0, waitingForReply: [] };
    const data = await res.json() as { messages?: GmailMessage[] };
    const messages = data.messages ?? [];
    return { messages, unreadCount: messages.filter(m => m.isUnread).length, waitingForReply: [] };
  } catch (err) {
    console.error('[daily-digest] Gmail error:', err);
    return { messages: [], unreadCount: 0, waitingForReply: [] };
  }
}

async function fetchCalendar(env: Env): Promise<DigestData['calendar']> {
  try {
    const secret = env.APPS_SCRIPT_SECRET;
    if (!secret) return { events: [], todayCount: 0 };
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).toISOString();
    const res = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret, action: 'getCalendar', calendarId: 'primary', timeMin: startOfDay, timeMax: endOfDay, maxResults: 20 }),
    });
    if (!res.ok) return { events: [], todayCount: 0 };
    const data = await res.json() as { events?: CalendarEvent[] };
    const events = data.events ?? [];
    return { events, todayCount: events.length };
  } catch (err) {
    console.error('[daily-digest] Calendar error:', err);
    return { events: [], todayCount: 0 };
  }
}

async function fetchMarketplace(env: Env): Promise<DigestData['marketplace']> {
  const def = { ozon: { revenue: 0, units: 0, delta: null as number | null }, wb: { revenue: 0, units: 0, delta: null as number | null }, combined: 0 };
  try {
    const rows = await env.DB.prepare(`
      SELECT marketplace, SUM(units_sold) as units, SUM(revenue_rub) / 100 as revenue
      FROM marketplace_sales_daily WHERE date >= date('now', '-2 days') GROUP BY marketplace
    `).all<{ marketplace: string; units: number; revenue: number }>();
    const byMp = new Map<string, { units: number; revenue: number }>();
    for (const r of rows.results ?? []) byMp.set(r.marketplace, { units: r.units, revenue: r.revenue });
    const ozon = byMp.get('ozon') ?? { units: 0, revenue: 0 };
    const wb = byMp.get('wb') ?? { units: 0, revenue: 0 };
    return { ozon: { ...ozon, delta: null }, wb: { ...wb, delta: null }, combined: ozon.revenue + wb.revenue };
  } catch (err) {
    console.error('[daily-digest] Marketplace error:', err);
    return def;
  }
}

function formatDigest(data: DigestData): string {
  const lines: string[] = [];
  const now = new Date(data.timestamp);
  const timeStr = now.toLocaleString('ru-RU', { timeZone: 'Asia/Yerevan', hour: '2-digit', minute: '2-digit' });
  lines.push(`🌅 **Дайджест дня** — ${now.toLocaleDateString('ru-RU', { timeZone: 'Asia/Yerevan', weekday: 'long', day: 'numeric', month: 'long' })}`);
  lines.push(`⏰ ${timeStr} (Ереван)`);
  lines.push('');
  lines.push('📧 **Почта**');
  if (data.gmail.messages.length === 0) { lines.push('Нет новых писем за сутки'); }
  else { lines.push(`Непрочитанных: ${data.gmail.unreadCount}`); for (const msg of data.gmail.messages.slice(0, 5)) { lines.push(`• ${msg.from.split('<')[0].trim()}: ${msg.subject?.slice(0, 60) || '(без темы)'}`); } if (data.gmail.messages.length > 5) lines.push(`... и ещё ${data.gmail.messages.length - 5}`); }
  lines.push('');
  lines.push('📅 **Календарь на сегодня**');
  if (data.calendar.events.length === 0) { lines.push('Нет событий на сегодня'); }
  else { for (const evt of data.calendar.events) { const start = new Date(evt.start).toLocaleTimeString('ru-RU', { timeZone: 'Asia/Yerevan', hour: '2-digit', minute: '2-digit' }); lines.push(`• ${start} — ${evt.summary}`); } }
  lines.push('');
  lines.push('🛒 **Маркетплейсы**');
  if (data.marketplace.combined === 0) { lines.push('Данные о продажах недоступны'); }
  else { const ozonStr = data.marketplace.ozon.revenue > 0 ? `Ozon: ${Math.round(data.marketplace.ozon.revenue).toLocaleString('ru-RU')} ₽ (${data.marketplace.ozon.units} шт)` : 'Ozon: —'; const wbStr = data.marketplace.wb.revenue > 0 ? `WB: ${Math.round(data.marketplace.wb.revenue).toLocaleString('ru-RU')} ₽ (${data.marketplace.wb.units} шт)` : 'WB: —'; lines.push(`• ${ozonStr}`); lines.push(`• ${wbStr}`); lines.push(`• Итого: ${Math.round(data.marketplace.combined).toLocaleString('ru-RU')} ₽`); }
  return lines.join('\n');
}

app.post('/', async (c) => {
  console.log('[daily-digest] generating digest');
  const [gmail, calendar, marketplace] = await Promise.all([fetchGmail(c.env), fetchCalendar(c.env), fetchMarketplace(c.env)]);
  const digestData: DigestData = { timestamp: new Date().toISOString(), gmail, calendar, marketplace };
  const text = formatDigest(digestData);
  if (c.env.CACHE) await c.env.CACHE.put('daily-digest:latest', JSON.stringify({ ...digestData, text }), { expirationTtl: 86400 });
  return ok(c, { text, data: digestData });
});

app.get('/', async (c) => {
  if (!c.env.CACHE) return fail(c, 500, [{ code: 'no_cache', message: 'CACHE KV not configured' }]);
  const cached = await c.env.CACHE.get('daily-digest:latest', 'json');
  if (!cached) return fail(c, 404, [{ code: 'no_digest', message: 'No digest generated yet. Run POST first.' }]);
  return ok(c, cached);
});

export default app;
