import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tickViewsJob } from './ugc-views-job.mjs';

function db() {
  const s = new DatabaseSync(':memory:');
  s.exec(`CREATE TABLE ugc_creators(id TEXT PRIMARY KEY, archived_at TEXT);
    CREATE TABLE ugc_content(id TEXT PRIMARY KEY, creator_id TEXT, content_url TEXT, published_at TEXT, imported_at, views INTEGER, likes INTEGER, comments INTEGER,
      metrics_checked_at TEXT, metrics_source TEXT, link_status TEXT, link_checked_at TEXT, updated_at INTEGER);
    CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    INSERT INTO ugc_creators VALUES('c',NULL),('gone','2026-11-01');`);
  const add = (id, code, day, extra = {}) => s.prepare('INSERT INTO ugc_content(id,creator_id,content_url,published_at,views,link_status) VALUES(?,?,?,?,?,?)')
    .run(id, extra.creator ?? 'c', `https://www.instagram.com/reel/${code}/?igsh=x`, day, extra.views ?? null, extra.ls ?? 'active');
  const env = { APIFY_TOKEN: 't', DB: { prepare(sql) { let v = []; return { bind(...a) { v = a; return this; }, async all() { return { results: s.prepare(sql).all(...v) }; }, async run() { return { meta: { changes: Number(s.prepare(sql).run(...v).changes) } }; } }; } } };
  return { s, env, add };
}
const state = s => JSON.parse(s.prepare("SELECT value FROM crm_sync_state WHERE key='k'").get().value);

test('the newest reels are read in batches, each batch bought once, views written, the job ends itself', async () => {
  const { s, env, add } = db();
  add('a', 'AAA', '2026-11-18'); add('b', 'BBB', '2026-11-17', { views: 5 }); add('c', 'CCC', '2026-11-16'); add('old', 'OLD', '2026-01-01');
  add('dead', 'DEAD', '2026-11-18', { ls: 'missing' }); add('arch', 'ARCH', '2026-11-18', { creator: 'gone' });
  const posts = [];
  const item = (code, plays) => ({ shortCode: code, url: `https://www.instagram.com/reel/${code}/`, ownerUsername: 'her', videoPlayCount: plays, likesCount: 3, commentsCount: 1, timestamp: '2026-11-10T10:00:00Z' });
  const fetchImpl = async (url, init) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(init.body).directUrls); return { ok: true, json: async () => ({ data: { id: 'run' + posts.length } }) }; }
    if (url.includes('actor-runs/')) return { ok: true, json: async () => ({ data: { status: 'SUCCEEDED', defaultDatasetId: 'ds' + url.slice(-1), finishedAt: '2026-11-18T21:00:00Z' } }) };
    return { ok: true, json: async () => url.includes('ds1') ? [item('AAA', 900), item('BBB', 70)] : [{ ...item('CCC', null), videoPlayCount: undefined }] };
  };
  const go = (now) => tickViewsJob(env, { fetchImpl, now, job: { id: 't', limit: 3, batch: 2 }, key: 'k' });
  assert.deepEqual(await go(1000), { status: 'created', selected: 3 });
  assert.equal((await go(2000)).status, 'working');
  assert.deepEqual(posts, [['https://www.instagram.com/reel/AAA/', 'https://www.instagram.com/reel/BBB/']]);
  // A tick that arrives while another holds the job does nothing.
  s.prepare("UPDATE crm_sync_state SET value=json_set(value,'$.lease',9e15) WHERE key='k'").run();
  assert.equal((await go(3000)).status, 'busy'); assert.equal(posts.length, 1);
  s.prepare("UPDATE crm_sync_state SET value=json_set(value,'$.lease',0) WHERE key='k'").run();
  assert.equal((await go(4000)).status, 'working');
  assert.equal((await go(5000)).status, 'done');
  assert.equal((await go(6000)).status, 'done'); assert.equal(posts.length, 2);
  const row = id => s.prepare('SELECT views,likes,metrics_source,published_at FROM ugc_content WHERE id=?').get(id);
  assert.equal(row('a').views, 900); assert.equal(row('b').views, 70); assert.equal(row('b').metrics_source, 'apify');
  assert.equal(row('c').views, null); assert.equal(row('c').likes, 3); assert.equal(row('old').views, null);
  const end = state(s);
  assert.deepEqual([end.selected, end.read, end.with_views, end.no_views, end.unread, end.runs], [3, 3, 2, 1, 0, 2]);
  assert.equal(JSON.parse(s.prepare("SELECT value FROM crm_sync_state WHERE key='ugc-apify:post:AAA'").get().value).result.views, 900);
});

test('a paid call cut off mid-way is never repeated: its reels are counted unread and the job moves on', async () => {
  const { s, env, add } = db(); add('a', 'AAA', '2026-11-18');
  let posts = 0;
  const fetchImpl = async (_u, init) => { if (init?.method === 'POST') { posts++; throw new Error('cut'); } return { ok: false }; };
  const go = now => tickViewsJob(env, { fetchImpl, now, job: { id: 't', limit: 5, batch: 2 }, key: 'k' });
  await go(1); await go(2); assert.equal((await go(3)).status, 'done'); await go(4);
  assert.equal(posts, 1); assert.equal(state(s).unread, 1);
});

test('two batches in a row with nothing readable stop the job instead of burning the rest', async () => {
  const { s, env, add } = db(); for (const c of ['A1','B1','C1','D1','E1','F1']) add(c, c, '2026-11-18');
  let posts = 0;
  const fetchImpl = async (url, init) => { if (init?.method === 'POST') { posts++; return { ok: true, json: async () => ({ data: { id: 'r' + posts } }) }; } if (url.includes('actor-runs/')) return { ok: true, json: async () => ({ data: { status: 'FAILED' } }) }; return { ok: true, json: async () => [] }; };
  const go = now => tickViewsJob(env, { fetchImpl, now, job: { id: 't', limit: 6, batch: 2 }, key: 'k' });
  for (let i = 1; i < 8; i++) await go(i);
  assert.equal(state(s).phase, 'stopped'); assert.equal(posts, 2);
});
