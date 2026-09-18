// Review figures to Maya's canon (agents/maya-krasochkina/CANON_FIGURES.md): one claim,
// one number — rewrites the figure, never the sentence. Model-free.
// Copied from the LIVE Cloudflare worker care-canon on 2026-09-18 (the organizacia
// workers/care-canon/worker.js source was behind it: updated_at as epoch, not datetime).
/**
 * care-canon — one claim, one number.
 *
 * Numbers in an answer sell, and they stay. This worker does not remove them,
 * does not soften them and does not hold the queue. It does exactly one thing:
 * makes the same claim carry the same number everywhere.
 *
 * Before it existed, the model rebuilt the figure on every answer — P. gingivalis
 * came out as 74%, then 65–79%, then 26–40%, all on the same product card. Three
 * numbers for one claim read as a lie and cost more trust than no number at all.
 *
 * Source of truth: agents/maya-krasochkina/CANON_FIGURES.md — Maya's file, Maya's
 * call. Change a value there and the next pass rewrites answers to match. Drop a
 * row and that claim stops being normalised.
 *
 * Drafts stay `pending` throughout. Nothing is ever blocked.
 */

const REPO = 'dasexperten/organizacia';
const CANON_PATH = 'agents/maya-krasochkina/CANON_FIGURES.md';
const BATCH = 300;

// The subject is recognised in code; only the value comes from Maya's file.
// group 1 = the number to replace.
const SUBJECTS = {
  gingivalis:      /(?:gingivalis|гингивалис)[^.!?]{0,45}?на\s+(\d{1,3}(?:\s*[–—-]\s*\d{1,3})?)\s*%/i,
  biofilm:         /биоплён\w*[^.!?]{0,30}?(\d{1,3}(?:\s*[–—-]\s*\d{1,3})?)\s*%|(?:до\s+)?(\d{1,3})\s*%\s*биоплён/i,
  enamel_minerals: /потер\w*\s+минерал\w*[^.!?]{0,30}?на\s+(\d{1,3}(?:\s*[–—-]\s*\d{1,3})?)\s*%/i,
  enamel_smooth:   /гладк\w*[^.!?]{0,30}?до\s+(\d{1,3}(?:\s*[–—-]\s*\d{1,3})?)\s*нм/i,
  bristle_soft:    /на\s+(\d{1,3})\s*%\s*мягче/i,
  brush_life:      /(?:жизнь|срок\s+служб\w*|служит)[^.!?]{0,35}?на\s+(\d{1,3}(?:\s*[–—-]\s*\d{1,3})?)\s*%/i,
  hemp_oil:        /(?:конопл\w*|COCOCANNABIS)[^.!?]{0,40}?(\d{1,2})\s*%|(\d{1,2})\s*%\s*масл\w*\s+семян\s+конопл/i,
  ginger:          /(\d{1,2})\s*%\s*экстракт\w*\s+имбир|имбир\w*[^.!?]{0,20}?(\d{1,2})\s*%/i,
  repeat_purchase: /(\d{1,3})\s*%\s*(?:покупателей|клиентов)[^.!?]{0,40}?(?:возвраща|повторн)/i
};

const json = (o, s = 200) =>
  new Response(JSON.stringify(o, null, 2), { status: s, headers: { 'Content-Type': 'application/json' } });

async function loadCanon(env) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${CANON_PATH}`, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'care-canon'
    }
  });
  if (!res.ok) throw new Error(`canon file unreachable: github ${res.status}`);
  const meta = await res.json();
  const md = new TextDecoder().decode(
    Uint8Array.from(atob(meta.content.replace(/\n/g, '')), (c) => c.charCodeAt(0))
  );
  const canon = {};
  for (const line of md.split('\n')) {
    const m = /^\|\s*`(\w+)`\s*\|[^|]*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
    if (m && SUBJECTS[m[1]]) canon[m[1]] = { value: m[2].trim(), status: m[3].trim() };
  }
  return canon;
}

// Replace only the number, keep the sentence exactly as Tamara wrote it.
function normalise(text, canon) {
  let out = String(text || '');
  const changed = [];
  for (const [key, re] of Object.entries(SUBJECTS)) {
    const target = canon[key];
    if (!target) continue;
    const want = target.value.replace(/\s*%$/, '').replace(/\s*нм$/, '').trim();
    const m = re.exec(out);
    if (!m) continue;
    const found = (m.slice(1).find(Boolean) || '').replace(/\s+/g, '');
    if (!found) continue;
    const norm = (s) => s.replace(/\s+/g, '').replace(/[—-]/g, '–');
    if (norm(found) === norm(want)) continue;
    const at = m.index + m[0].indexOf(m.slice(1).find(Boolean));
    out = out.slice(0, at) + want + out.slice(at + (m.slice(1).find(Boolean) || '').length);
    changed.push({ key, from: found, to: want });
  }
  return { text: out, changed };
}

async function run(env, { dry = true, hours = 24 } = {}) {
  const canon = await loadCanon(env);
  const since = hours > 0 ? ` AND updated_at > strftime('%s','now') - ${Number(hours) * 3600}` : '';
  const rows = await env.ERP_DB.prepare(
    `SELECT id, channel, product_sku, draft_text FROM review_drafts
      WHERE status = 'pending' AND draft_text IS NOT NULL AND LENGTH(draft_text) > 0${since}
      ORDER BY updated_at DESC LIMIT ${BATCH}`
  ).all();

  const scanned = rows.results || [];
  const fixes = [];
  for (const r of scanned) {
    const { text, changed } = normalise(r.draft_text, canon);
    if (changed.length) fixes.push({ id: r.id, channel: r.channel, sku: r.product_sku, changed, text });
  }

  const byKey = {};
  for (const f of fixes) for (const c of f.changed) {
    byKey[c.key] = byKey[c.key] || {};
    byKey[c.key][`${c.from} → ${c.to}`] = (byKey[c.key][`${c.from} → ${c.to}`] || 0) + 1;
  }

  if (dry) {
    return {
      dry: true, canon_loaded: Object.keys(canon).length, scanned: scanned.length,
      would_fix: fixes.length, by_claim: byKey,
      sample: fixes.slice(0, 4).map((f) => ({ id: f.id, changed: f.changed, after: f.text.slice(0, 200) }))
    };
  }

  let fixed = 0;
  for (let i = 0; i < fixes.length; i += 25) {
    const chunk = fixes.slice(i, i + 25);
    await env.ERP_DB.batch(chunk.map((f) =>
      env.ERP_DB.prepare(
        `UPDATE review_drafts SET draft_text = ?, updated_at = strftime('%s','now')
          WHERE id = ? AND status = 'pending'`
      ).bind(f.text, f.id)
    ));
    fixed += chunk.length;
  }
  return { canon_loaded: Object.keys(canon).length, scanned: scanned.length, fixed, by_claim: byKey };
}

export { run as runReviewCanon };
