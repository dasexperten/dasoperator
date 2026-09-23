/** Durable Facebook article batches. A persisted in-flight attempt is NEVER auto-reposted.
 * The caller supplies verified page IDs, an editorially approved payload and a publisher.
 * Rollback: stop invoking tick; leave this table intact to preserve publication proofs.
 */
export const FOUR_HOURS = 4 * 60 * 60 * 1000;
export const LOCALES = ['main', 'en', 'ar', 'vi'];
const SITE_HOSTS = ['dasexperten.com', 'www.dasexperten.com', 'dasexperten.ru', 'www.dasexperten.ru'];
const TABLE = 'angela_article_queue';
const copy = value => JSON.parse(JSON.stringify(value));
const empty = () => ({ initializedAt: null, seen: [], articles: [], lastBatchAt: null, lastSlot: null, pageLastAt: {} });

export function yerevanSlot(now) {
  const d = new Date(now + FOUR_HOURS);
  const hour = d.getUTCHours();
  // Observability label only; eligibility is a rolling four-hour interval.
  return hour >= 8 ? `${d.toISOString().slice(0, 10)}T${hour}` : null;
}
export function allowedNow(now) {
  return new Date(now + FOUR_HOURS).getUTCHours() >= 8;
}
function httpsUrl(value, hosts) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && (!hosts || hosts.includes(u.hostname));
  } catch { return false; }
}
export function validatePayload(payload, article, destinations = LOCALES) {
  if (!payload || typeof payload !== 'object') throw new Error('Missing editorial payload');
  for (const lang of destinations) {
    const p = payload[lang];
    const author = 'roberta-di-maria';
    if (!p || typeof p.summary !== 'string' || !p.summary.trim()) throw new Error(`Missing brief ${lang} summary`);
    if (p.language !== (['main', 'x'].includes(lang) ? 'en' : lang)) throw new Error(`Wrong ${lang} publication language`);
    if (p.approval?.by !== author || p.approval?.approved !== true || !p.approval?.evidence) throw new Error(`Missing ${author} approval`);
    if (p.intrigue?.passed !== true || !p.intrigue?.evidence) throw new Error(`Missing ${lang} intrigue gate`);
    if (!httpsUrl(p.link, SITE_HOSTS)) throw new Error(`Invalid ${lang} article link`);
    if (!p.preview?.title || !p.preview?.description || !httpsUrl(p.preview?.image) || p.preview?.verified !== true || !p.preview?.evidence) throw new Error(`Missing verified ${lang} preview`);
    if (p.creative) {
      const c = p.creative;
      if (c.kind !== 'otto-infographic' || c.source !== 'article-inline' || !httpsUrl(c.image, SITE_HOSTS) || typeof c.alt !== 'string' || !c.alt.trim()) throw new Error(`Invalid ${lang} creative`);
      if (c.acceptance?.by !== 'marika-nowicka' || c.acceptance?.accepted !== true || !c.acceptance?.evidence) throw new Error(`Missing Marika acceptance for ${lang} creative`);
      if (c.verified !== true || !c.evidence) throw new Error(`Missing live verification for ${lang} creative`);
    }
    if (p.sourceId !== article.id) throw new Error(`Wrong ${lang} source article`);
  }
  return copy(payload);
}

/** D1 CAS is the global lock: all reservations and proofs are committed before/after I/O.
 * A crash after reservation leaves 'publishing', requiring verified reconciliation.
 */
export function d1QueueStore(db) {
  let ready;
  async function init() {
    ready ||= (async () => {
      await db.prepare(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, data TEXT NOT NULL)`).run();
      await db.prepare(`INSERT OR IGNORE INTO ${TABLE}(id,version,data) VALUES(1,0,?)`).bind(JSON.stringify(empty())).run();
    })();
    return ready;
  }
  return {
    async read() { await init(); const row = await db.prepare(`SELECT version,data FROM ${TABLE} WHERE id=1`).first(); return { version: row.version, state: JSON.parse(row.data) }; },
    async swap(version, state) {
      const data = JSON.stringify(state);
      // D1 maximum string/BLOB/row: 2,000,000 bytes. Keep margin for row overhead.
      // https://developers.cloudflare.com/d1/platform/limits/
      // Fail closed; never discard history or silently reset.
      if (new TextEncoder().encode(data).length > 1500000) throw new Error('Queue capacity requires archival; publishing paused');
      const r = await db.prepare(`UPDATE ${TABLE} SET data=?,version=version+1 WHERE id=1 AND version=?`).bind(data, version).run();
      return r.meta.changes === 1;
    },
  };
}
export function createArticleQueue(db, { pages, xAccountId, publish, now = Date.now, store = d1QueueStore(db) } = {}) {
  if (!pages || LOCALES.some(lang => !/^\d+$/.test(pages[lang] || '')) || new Set(Object.values(pages)).size !== 4) throw new Error('Four verified distinct page IDs required');
  if (xAccountId !== undefined && !/^\d+$/.test(xAccountId)) throw new Error('Verified X account ID required');
  const destinations = xAccountId ? [...LOCALES, 'x'] : LOCALES;
  const destinationIds = { ...pages, ...(xAccountId ? { x: xAccountId } : {}) };
  const destinationKey = (lang, id) => `${lang === 'x' ? 'x' : 'facebook'}:${id}`;
  async function change(fn) {
    for (let i = 0; i < 20; i++) {
      const { version, state } = await store.read();
      const result = fn(state);
      if (await store.swap(version, state)) return result;
    }
    throw new Error('Queue busy; retry later');
  }
  return {
    async initialize(baselineIds) {
      if (!Array.isArray(baselineIds) || baselineIds.some(id => typeof id !== 'string')) throw new Error('Baseline IDs required');
      return change(s => { if (s.initializedAt !== null) return { initialized: false }; s.initializedAt = now(); s.seen = [...new Set(baselineIds)]; return { initialized: true, baselineCount: s.seen.length }; });
    },
    async discover(articles) {
      if (!Array.isArray(articles)) throw new Error('Articles array required');
      return change(s => {
        if (s.initializedAt === null) throw new Error('Initialize historical baseline before discovery');
        const added = [];
        for (const a of articles) {
          if (!a.id || typeof a.id !== 'string' || !httpsUrl(a.url, SITE_HOSTS) || a.author !== 'kobayashi') throw new Error('Verified Kobayashi article required');
          if (s.seen.includes(a.id)) continue;
          s.seen.push(a.id);
          // Discovery must supply a trusted publication time: old articles never backfill.
          if (!Number.isFinite(Date.parse(a.publishedAt)) || (Date.parse(a.publishedAt) <= s.initializedAt && a.backfillVerified !== true)) continue;
          s.articles.push({ id: a.id, url: a.url, title: a.title || '', publishedAt: a.publishedAt, discoveredAt: now(), status: 'draft', payload: null, deliveries: {} });
          added.push(a.id);
        }
        return { added };
      });
    },
    async approve(id, payload) {
      return change(s => {
        const a = s.articles.find(a => a.id === id);
        if (!a) throw new Error('Article not discovered');
        if (Object.keys(a.deliveries).length) throw new Error('An attempted batch is immutable');
        a.payload = validatePayload(payload, a, destinations); a.status = 'approved'; return { approved: id };
      });
    },
    async status() { return (await store.read()).state; },
    async tick() {
      if (typeof publish !== 'function') throw new Error('Publisher not configured');
      const t = now(); const slot = yerevanSlot(t);
      if (!slot) return { skipped: 'outside publication slot' };
      const reserved = await change(s => {
        if (s.initializedAt === null) return { skipped: 'baseline missing' };
        if (s.lastBatchAt !== null && t - s.lastBatchAt < FOUR_HOURS) return { skipped: 'four-hour interval' };
        // A partial batch blocks later articles; even unknown outcomes cannot be bypassed.
        const a = s.articles.find(a => a.status === 'partial') || s.articles.find(a => a.status === 'approved');
        if (!a) return { skipped: 'no approved article' };
        if (Object.values(a.deliveries).some(d => ['publishing', 'unknown'].includes(d.status))) return { skipped: 'reconciliation required', articleId: a.id };
        validatePayload(a.payload, a, destinations);
        const pending = destinations.filter(lang => a.deliveries[lang]?.status !== 'published');
        if (pending.some(lang => s.pageLastAt[destinationKey(lang, destinationIds[lang])] != null && t - s.pageLastAt[destinationKey(lang, destinationIds[lang])] < FOUR_HOURS)) return { skipped: 'page four-hour interval' };
        for (const lang of pending) a.deliveries[lang] = { status: 'publishing', pageId: destinationIds[lang], channel: lang === 'x' ? 'x' : 'facebook', attemptId: crypto.randomUUID(), attemptedAt: t, previous: a.deliveries[lang] || null };
        a.status = 'partial'; s.lastBatchAt = t; s.lastSlot = slot;
        return { article: copy(a), pending };
      });
      if (!reserved.article) return reserved;
      for (const lang of reserved.pending) {
        const a = reserved.article; const d = a.deliveries[lang];
        // Recheck wall clock before every external side effect, including a delayed run.
        if (!allowedNow(now())) {
          await change(s => { s.articles.find(x => x.id === a.id).deliveries[lang].status = 'retry'; });
          continue;
        }
        let outcome;
        try {
          outcome = await publish({ ...a.payload[lang], articleId: a.id, lang: ['x', 'main'].includes(lang) ? 'en' : lang, deliveryKey: lang, channel: d.channel, pageId: d.pageId, attemptId: d.attemptId });
        } catch { outcome = { status: 'unknown', reason: 'Publisher exception; verify remote before retry' }; }
        await change(s => {
          const target = s.articles.find(x => x.id === a.id); const delivery = target.deliveries[lang];
          if (delivery.attemptId !== d.attemptId) throw new Error('Attempt mismatch');
          if (outcome?.postId && outcome?.proof && outcome?.status === 'published') {
            Object.assign(delivery, { status: 'published', postId: String(outcome.postId), proof: outcome.proof, publishedAt: now() });
            s.pageLastAt[destinationKey(lang, d.pageId)] = now();
            s.lastBatchAt = Math.max(s.lastBatchAt ?? 0, now());
          } else if (outcome?.status === 'not_sent' && outcome?.definitive === true) {
            Object.assign(delivery, { status: 'retry', reason: 'Provider definitively rejected publication' });
          } else {
            Object.assign(delivery, { status: 'unknown', reason: 'Unconfirmed publication; reconciliation required' });
            // Graph may return a post ID before read-back fails. Retain that acceptance
            // evidence even though it is insufficient to claim verified publication.
            if (outcome?.postId) delivery.postId = String(outcome.postId);
            if (outcome?.proof) delivery.proof = outcome.proof;
          }
          if (destinations.every(l => target.deliveries[l]?.status === 'published')) target.status = 'published';
        });
      }
      return { articleId: reserved.article.id, deliveries: (await store.read()).state.articles.find(a => a.id === reserved.article.id).deliveries };
    },
    /** Only a trusted verifier may resolve ambiguous outcomes, never a blind retry. */
    async reconcile(id, lang, verification) {
      if (!verification?.evidence || !['published', 'not_sent'].includes(verification?.status)) throw new Error('Remote verification evidence required');
      return change(s => {
        const a = s.articles.find(a => a.id === id); const d = a?.deliveries[lang];
        if (!d || !['unknown', 'publishing'].includes(d.status)) throw new Error('No ambiguous delivery');
        if (verification.status === 'published') {
          if (!verification.postId) throw new Error('Post ID required');
          Object.assign(d, { status: 'published', postId: String(verification.postId), proof: verification.evidence, publishedAt: now() });
          s.pageLastAt[destinationKey(lang, d.pageId)] = now();
            s.lastBatchAt = Math.max(s.lastBatchAt ?? 0, now());
        } else Object.assign(d, { status: 'retry', reconciliationProof: verification.evidence });
        if (destinations.every(l => a.deliveries[l]?.status === 'published')) a.status = 'published';
        return { reconciled: id, lang, status: d.status };
      });
    },
  };
}

/** No unauthenticated preview, enqueue, approval, tick or reconciliation endpoint. */
export async function articleQueueRoutes(req, env, queue) {
  const path = new URL(req.url).pathname;
  if (!path.startsWith('/articles/')) return null;
  const json = (data, status = 200) => Response.json(data, { status });
  if (!env.SOCIAL_READ_SECRET || req.headers.get('X-Social-Read-Secret') !== env.SOCIAL_READ_SECRET) return json({ error: 'unauthorized' }, 401);
  if (req.method === 'GET' && path === '/articles/status') return json(await queue.status());
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  try {
    if (path === '/articles/tick') return json(await queue.tick());
    const b = await req.json();
    if (path === '/articles/initialize') return json(await queue.initialize(b.baselineIds));
    if (path === '/articles/discover') return json(await queue.discover(b.articles));
    if (path === '/articles/approve') return json(await queue.approve(b.id, b.payload));
    if (path === '/articles/reconcile') return json(await queue.reconcile(b.id, b.lang, b.verification));
    return json({ error: 'unknown route' }, 404);
  } catch (e) { return json({ error: e.message }, 400); }
}
