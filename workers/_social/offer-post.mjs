/** Offer posts — Owner 2026-09-17: "we need to start some pushing" for the 30-minute free
 * delivery on the international site. Owner picked "our social pages" in the same session.
 *
 * Article posts need a live <article>; an offer is a plain link post to the storefront, so it
 * has its own small lane. The words are committed as JSON in agents/angela/offer-outbox/ —
 * Angela writes them, the commit is the record. This clock only delivers them.
 *
 * At most once per page: the R2 marker is written BEFORE the Graph call. A crash between the
 * marker and Facebook's answer leaves the post "unknown", never posted twice.
 * Rollback: delete the manifest, or remove offerTick from index.js.
 */
import { PAGES, graph, tokenFor } from './article-service.mjs';
import { allowedNow } from './article-queue.mjs';
import { cleanAiMarks } from './ai-marks.mjs';

const OUTBOX = 'agents/angela/offer-outbox';
const HOSTS = ['www.dasexperten.com', 'dasexperten.com'];

export function validOffer(m) {
  if (!m || !/^[a-z0-9-]{6,80}$/.test(m.id || '') || !Array.isArray(m.posts) || !m.posts.length) return false;
  if (m.expires && !(Date.parse(m.expires) > 0)) return false;
  return m.posts.every((p) => {
    if (!PAGES[p.page] || typeof p.message !== 'string' || p.message.length < 20 || p.message.length > 1500) return false;
    try { const u = new URL(p.link); return u.protocol === 'https:' && HOSTS.includes(u.hostname) && !u.username; } catch { return false; }
  });
}

async function readOutbox(env) {
  if (!env.GITHUB_TOKEN) throw Error('GitHub read credential unavailable');
  const h = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'angela-social', Accept: 'application/vnd.github+json' };
  const r = await fetch(`https://api.github.com/repos/dasexperten/organizacia/contents/${OUTBOX}?ref=main`, { headers: h });
  if (r.status === 404) return [];
  if (!r.ok) throw Error(`Offer outbox read failed (${r.status})`);
  const out = [];
  for (const f of (await r.json()).filter((x) => x.type === 'file' && x.name.endsWith('.json'))) {
    const fr = await fetch(f.download_url, { headers: h });
    if (fr.ok) out.push(await fr.json());
  }
  return out;
}

export async function offerTick(env, { manifests, now = Date.now() } = {}) {
  const list = manifests || await readOutbox(env);
  const results = [];
  for (const m of list) {
    if (!validOffer(m)) { results.push({ id: m && m.id, skipped: 'invalid manifest' }); continue; }
    if (m.expires && now > Date.parse(m.expires)) { results.push({ id: m.id, skipped: 'expired' }); continue; }
    for (const p of m.posts) {
      const key = `Social/angela/offers/${m.id}/${p.page}.json`;
      if (await env.ARCHIVE.get(key)) continue;
      if (!allowedNow(now)) { results.push({ id: m.id, page: p.page, skipped: 'outside 08-24 Yerevan' }); continue; }
      const pageId = PAGES[p.page];
      let token;
      try { token = await tokenFor(env, pageId); } catch { token = null; }
      if (!token) { results.push({ id: m.id, page: p.page, status: 'not_sent', reason: 'no page access' }); continue; }
      await env.ARCHIVE.put(key, JSON.stringify({ status: 'attempting', at: new Date(now).toISOString() }));
      const res = await graph(`${pageId}/feed`, token, { method: 'POST', body: new URLSearchParams({ message: cleanAiMarks(p.message).text, link: p.link, published: 'true' }) });
      let row = { id: m.id, page: p.page, status: 'unknown' };
      if (res.ok && res.body.id) {
        row = { ...row, status: 'published', postId: res.body.id };
        try {
          const v = await graph(`${res.body.id}?fields=id,permalink_url,is_published`, token);
          if (v.ok && v.body.is_published) row.proof = v.body.permalink_url;
        } catch {}
      } else if (res.body && res.body.error) {
        row = { ...row, status: 'failed', error: String(res.body.error.message || '').slice(0, 200) };
      }
      await env.ARCHIVE.put(key, JSON.stringify({ ...row, at: new Date(now).toISOString() }));
      results.push(row);
    }
  }
  return results;
}
