const DEFAULT_ATTEMPTS = 5;
const DEFAULT_SPACING_MS = 1100;
const MAX_RETRY_MS = 60_000;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function retryAfterMilliseconds(headers, now = Date.now()) {
  const raw = headers.get("retry-after") || headers.get("x-ratelimit-retry") || "";
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_MS, Math.ceil(seconds * 1000));
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) return null;
  return Math.min(MAX_RETRY_MS, Math.max(0, at - now));
}

export function fallbackBackoffMilliseconds(attempt) {
  return Math.min(MAX_RETRY_MS, 2000 * Math.pow(2, Math.max(0, attempt - 1)));
}

let nextRequestAt = 0;

async function takeSlot(spacingMs, sleep, now) {
  const current = now();
  const waitMs = Math.max(0, nextRequestAt - current);
  nextRequestAt = Math.max(nextRequestAt, current) + spacingMs;
  if (waitMs > 0) await sleep(waitMs);
}

/**
 * Seller API read with per-isolate serialization and bounded retry.
 * POST is safe here because callers use read-only Seller API methods.
 */
export async function fetchOzonRead(url, init, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || DEFAULT_ATTEMPTS));
  const spacingMs = Math.max(0, Number(options.spacingMs ?? DEFAULT_SPACING_MS));
  const sleep = options.sleep || defaultSleep;
  const now = options.now || Date.now;
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 0));
  const path = new URL(url).pathname;

  let response = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await takeSlot(spacingMs, sleep, now);
    const attemptInit = timeoutMs > 0
      ? { ...init, signal: AbortSignal.timeout(timeoutMs) }
      : init;
    response = await fetchImpl(url, attemptInit);
    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt === attempts) return { response, attempts: attempt };

    const requested = retryAfterMilliseconds(response.headers, now());
    const delayMs = requested ?? fallbackBackoffMilliseconds(attempt);
    console.warn(`[ozon-read] ${path} HTTP ${response.status}; retry ${attempt + 1}/${attempts} in ${delayMs}ms`);
    await response.arrayBuffer().catch(() => undefined);
    await sleep(delayMs);
  }
  return { response, attempts };
}
