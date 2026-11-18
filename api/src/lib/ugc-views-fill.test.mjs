import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fillMissingViews } from './ugc-views-fill.mjs';
import { contentEngagement } from './ugc-content-metrics.mjs';

function db(rows) {
  const s = new DatabaseSync(':memory:');
  s.exec(`CREATE TABLE ugc_content(id TEXT PRIMARY KEY, content_url TEXT, published_at TEXT, imported_at, views INTEGER, likes INTEGER, comments INTEGER,
    metrics_checked_at TEXT, metrics_source TEXT, link_status TEXT, updated_at INTEGER);
    CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);`);
  for (const r of rows) s.prepare('INSERT INTO ugc_content(id,content_url,published_at,imported_at,views,likes,comments,metrics_source,link_status) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(r.id, r.url, r.pub ?? null, r.imp ?? null, r.views ?? null, r.likes ?? null, r.comments ?? null, r.src ?? null, r.ls ?? 'active');
  const env = { DB: { prepare(sql) { let v = []; return { bind(...a) { v = a; return this; }, async all() { return { results: s.prepare(sql).all(...v) }; }, async run() { return { meta: { changes: Number(s.prepare(sql).run(...v).changes) } }; } }; } } };
  return { s, env };
}
const reel = code => `https://www.instagram.com/reel/${code}/`;

test('a reel with browser likes but no plays gets its plays; newest first, published date filled', async () => {
  const { s, env } = db([
    { id: 'old', url: reel('OLD'), pub: '2026-02-17', views: 2152, likes: 26 },
    { id: 'akab', url: reel('DfO9sv7tn1g'), imp: Date.parse('2026-11-02T09:00:00Z'), likes: 5, comments: 0, src: 'instagram_browser' },
    { id: 'new', url: reel('NEW'), pub: '2026-11-18T13:15:17Z' },
    { id: 'gone', url: reel('GONE'), pub: '2026-11-17', ls: 'missing' },
  ]);
  const order = [];
  const read = async (_env, { url }) => { order.push(url); return { status: 'ok', views: url.includes('NEW') ? 120 : 640, likes: 7, comments: 1, observedAt: '2026-11-19T00:01:00Z', postedAt: '2026-11-02T08:00:00Z' }; };
  const t = await fillMissingViews(env, { read });
  assert.deepEqual(order, [reel('NEW'), reel('DfO9sv7tn1g')]);
  assert.equal(t.filled, 2);
  const akab = s.prepare("SELECT * FROM ugc_content WHERE id='akab'").get();
  assert.equal(akab.views, 640); assert.equal(akab.likes, 7); assert.equal(akab.metrics_source, 'apify'); assert.equal(akab.published_at, '2026-11-02T08:00:00Z');
  assert.equal(s.prepare("SELECT views FROM ugc_content WHERE id='old'").get().views, 2152);
});

test('a reading still running is collected in the same night; a reading without plays keeps the dash', async () => {
  const { s, env } = db([{ id: 'a', url: reel('A'), pub: '2026-11-16' }, { id: 'b', url: reel('B'), pub: '2026-11-15' }]);
  const calls = {};
  const read = async (_env, { url }) => { calls[url] = (calls[url] ?? 0) + 1; if (url.includes('/A/')) return calls[url] === 1 ? { status: 'pending' } : { status: 'ok', views: 50, likes: 1, comments: 0 }; return { status: 'ok', views: null, likes: 3, comments: 0 }; };
  const t = await fillMissingViews(env, { read });
  assert.equal(calls[reel('A')], 2); assert.equal(t.filled, 1); assert.equal(t.no_views, 1);
  assert.equal(s.prepare("SELECT views FROM ugc_content WHERE id='a'").get().views, 50);
  assert.equal(s.prepare("SELECT views FROM ugc_content WHERE id='b'").get().views, null);
  assert.ok(JSON.parse(s.prepare("SELECT value FROM crm_sync_state WHERE key='ugc_views_fill:last'").get().value).filled === 1);
});

test('the daily Apify budget stops the step without inventing anything', async () => {
  const { env } = db([{ id: 'a', url: reel('A'), pub: '2026-11-16' }, { id: 'b', url: reel('B'), pub: '2026-11-15' }]);
  let n = 0;
  const t = await fillMissingViews(env, { read: async () => { n++; return { status: 'budget_exhausted' }; } });
  assert.equal(n, 1); assert.equal(t.budget_exhausted, true); assert.equal(t.filled, 0);
});

test('ER is counted only once plays are visible (Owner 2026-11-18)', () => {
  const row = { product_status: 'identified', content_url: reel('DfO9sv7tn1g'), likes: 10, comments: 2 };
  assert.equal(contentEngagement({ ...row, views: null }, 1000, 'instagram'), null);
  assert.equal(contentEngagement({ ...row, views: 300 }, 1000, 'instagram'), 1.2);
});

test('the next pass of a round skips the reels already tried', async () => {
  const { env } = db([{ id: 'a', url: reel('A'), pub: '2026-11-16' }, { id: 'b', url: reel('B'), pub: '2026-11-15' }]);
  const seen = [];
  const t = await fillMissingViews(env, { exclude: ['a'], read: async (_e, { url }) => { seen.push(url); return { status: 'ok', views: 9 }; } });
  assert.deepEqual(seen, [reel('B')]); assert.deepEqual(t.ids, ['b']);
});

test('a reel whose reading brings no plays is deferred a day, so older reels are reached (Codex review)', async () => {
  const rows = Array.from({ length: 3 }, (_, i) => ({ id: 'n' + i, url: reel('N' + i), pub: `2026-11-1${8 - i}` }));
  const { env } = db([...rows, { id: 'old', url: reel('OLD'), pub: '2026-11-02' }]);
  const read = async (_e, { url }) => url.includes('OLD') ? { status: 'ok', views: 77 } : { status: 'ok', views: null, likes: 1 };
  const first = await fillMissingViews(env, { limit: 3, read });
  assert.equal(first.no_views, 3); assert.equal(first.filled, 0);
  const second = await fillMissingViews(env, { limit: 3, read });
  assert.deepEqual(second.ids, ['old']); assert.equal(second.filled, 1);
});
