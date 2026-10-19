// Owner 2026-10-19: the browser queue (browser_queue:<handle>) is sent by a button on /ugc, at once,
// through the Owner's own Chrome — on the PC or on the Mac. Pure helpers, tested offline.

export const RUN_COOLDOWN_MS = 2 * 60_000;

/** Queue rows → [{handle, texts}] with each text split into its own message lines. */
export function queueItems(rows) {
  const out = [];
  for (const row of rows ?? []) {
    let v = null;
    try { v = JSON.parse(row.value); } catch { v = null; }
    const handle = String(v?.handle ?? String(row.key ?? '').replace(/^browser_queue:/, '')).toLowerCase().replace(/^@/, '').trim();
    const items = Array.isArray(v?.items) ? v.items : v?.text ? [v] : [];
    const texts = items.flatMap((it) => String(it?.text ?? '').split('\n')).map((t) => t.trim()).filter(Boolean);
    if (handle && texts.length) out.push({ handle, texts });
  }
  return out;
}

export function isTarget(value) { return value === 'pc' || value === 'mac'; }

/** Seconds left before the next run may start; 0 when free. */
export function cooldownLeft(lastAt, now) {
  const left = Number(lastAt || 0) + RUN_COOLDOWN_MS - now;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** The text handed to the browser task: everything it needs, nothing it must look up. */
export function fireText({ target, run, key, doneUrl, items }) {
  return JSON.stringify({ target, run, key, done_url: doneUrl, items });
}
