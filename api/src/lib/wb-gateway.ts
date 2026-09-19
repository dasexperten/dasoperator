// One WB egress for the account. Only the private WorkerEntrypoint exposes this
// to other Workers; it is deliberately not mounted on the public Hono app.
export interface WbEnv {
  DB: D1Database;
  WB_API_TOKEN?: string;
}
const HOSTS = new Set(['statistics-api.wildberries.ru', 'seller-analytics-api.wildberries.ru',
  'discounts-prices-api.wildberries.ru', 'common-api.wildberries.ru',
  'advert-api.wildberries.ru']);
export function wbPolicy(url: URL) {
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password)
    throw new Error('WB gateway destination denied');
  if (/warehouse_remains|stocks-report\/wb-warehouses|\/supplier\/stocks/.test(url.pathname))
    throw new Error('WB warehouse-stock APIs are retired; FBS-only');
  const host = url.hostname;
  let group = url.pathname;
  let interval = 1000;
  if (host.startsWith('statistics-')) interval = 65000;
  if (host.startsWith('seller-analytics-')) {
    interval = 21000;
    group = url.pathname.includes('sales-funnel') ? 'sales-funnel' : url.pathname.replace(/\/tasks\/[^/]+\//, '/tasks/:id/');
    if (url.pathname.endsWith('/warehouse_remains')) interval = 65000;
  }
  if (host.startsWith('discounts-prices-')) { interval = 6500; group = 'prices'; }
  return { key: `${host}:${group}`, interval };
}
export function retryMilliseconds(headers: Headers, fallback = 65000, now = Date.now()) {
  const wb = Number(headers.get('x-ratelimit-retry')) * 1000;
  const raw = headers.get('retry-after');
  const http = raw ? (/^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now) : 0;
  return Math.max(1000, wb || 0, Number.isFinite(http) ? http : 0, !wb && !http ? fallback : 0);
}
function throttled(ms: number) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  return Response.json({ error: true, errorText: 'ERP WB cooldown; no upstream request sent' }, {
    status: 429, headers: { 'Retry-After': String(seconds), 'X-Ratelimit-Retry': String(seconds), 'X-WB-Gateway': 'cooldown' },
  });
}
export async function wbRequest(env: WbEnv, input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const { key, interval } = wbPolicy(url);
  const token = env.WB_API_TOKEN;
  if (!token) return Response.json({ error: 'ERP WB credential missing' }, { status: 503 });
  const now = Date.now();
  // Atomic conditional upsert: concurrent isolates cannot both spend a slot.
  const claim = await env.DB.prepare(`INSERT INTO wb_api_limits (bucket, next_at) VALUES (?, ?)
    ON CONFLICT(bucket) DO UPDATE SET next_at=excluded.next_at WHERE wb_api_limits.next_at<=?
    RETURNING bucket`).bind(key, now + Math.max(interval, 30000), now).first();
  if (!claim) {
    const row = await env.DB.prepare('SELECT next_at FROM wb_api_limits WHERE bucket=?').bind(key).first<{next_at:number}>();
    return throttled((row?.next_at ?? now + interval) - now);
  }
  const headers = new Headers(request.headers);
  headers.set('Authorization', token);
  headers.set('User-Agent', 'dasoperator-erp/wb-gateway');
  headers.delete('cookie');
  let status = 0;
  try {
    const response = await fetch(new Request(request, { headers, redirect: 'manual', signal: AbortSignal.timeout(25000) }));
    status = response.status;
    const delay = status === 429 ? retryMilliseconds(response.headers) : interval;
    await env.DB.prepare('UPDATE wb_api_limits SET next_at=? WHERE bucket=?')
      .bind(Math.max(now + interval, Date.now() + (status === 429 ? delay + 1000 : 0)), key).run();
    return response;
  } finally {
    await env.DB.prepare(`INSERT INTO wb_api_requests (host, path, method, status, started_at)
      VALUES (?, ?, ?, ?, ?)`).bind(url.hostname, url.pathname, request.method, status, now).run();
  }
}
