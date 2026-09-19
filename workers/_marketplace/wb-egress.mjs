// No direct WB fallback. The ERP owns credentials, cooldowns and outbound calls.
export async function wbEgress(env, input, init = {}) {
  if (!env.WB_GATEWAY) throw new Error('ERP WB_GATEWAY binding missing');
  const headers = new Headers(init.headers);
  headers.delete('Authorization');
  return env.WB_GATEWAY.fetch(input, { ...init, headers });
}
export function retryMs(response) {
  const raw = response.headers.get('retry-after');
  const http = raw ? (/^\d+(\.\d+)?$/.test(raw) ? Number(raw)*1000 : Date.parse(raw)-Date.now()) : 0;
  return Math.max(1000, Number(response.headers.get('x-ratelimit-retry'))*1000 || 0, http || 0, !raw && !response.headers.get('x-ratelimit-retry') ? 65000 : 0) + 1000;
}
export async function wbRead(env, input, init = {}, { attempts = 3, budgetMs = 150000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const deadline = Date.now() + budgetMs;
  for (let attempt = 1; ; attempt++) {
    const response = await wbEgress(env, input, { ...init, signal: AbortSignal.timeout(28000) });
    if (response.status !== 429 && response.status < 500) return response;
    const delay = response.status === 429 ? retryMs(response) : 2000 * attempt;
    if (attempt >= attempts || Date.now() + delay + 28000 > deadline) return response;
    await response.body?.cancel();
    await sleep(delay);
  }
}
