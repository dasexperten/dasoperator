import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let build;
try { ({ build } = require('esbuild')); } catch { ({ build } = createRequire(new URL('../../../workers/package.json', import.meta.url))('esbuild')); }
const dir = mkdtempSync(join(tmpdir(), 'ugc-dm-links-'));
const outfile = join(dir, 'links.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./ugc-dm-links.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile });
const { captureDmLinks } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });

const url = code => `https://www.instagram.com/reel/${code}/`;
const message = (h, code, date = '2026-11-02T12:00:00Z') => ({ h, conversation_id: 'chat-' + h, text: 'смотрите ' + url(code), created_at: date });
function fixture(rows, { content = [], judged = [], alarms = {} } = {}) {
  const f = { rows, content: new Set(content), judged: new Set(judged), alarms: { ...alarms }, writes: [], maxParams: 0 };
  f.env = { DB: { prepare(sql) {
    let p = [];
    const q = { bind(...v) { p = v; f.maxParams = Math.max(f.maxParams, p.length); return q; },
      async all() {
        if (sql.includes('FROM ugc_ig_messages')) return { results: f.rows };
        if (sql.includes('FROM ugc_content')) return { results: [...f.content].filter(u => p.some(x => u.includes(x.slice(1, -1)))).map(content_url => ({ content_url })) };
        if (sql.includes('FROM crm_sync_state WHERE key IN')) return { results: p.filter(k => f.judged.has(k.split(':')[1])).map(key => ({ key })) };
        throw Error('unexpected all ' + sql);
      },
      async first() { if (sql.includes('FROM crm_sync_state')) return f.alarms[p[0]] ? { value: f.alarms[p[0]] } : null; throw Error('unexpected first ' + sql); },
      async run() {
        if (sql.includes('INTO crm_sync_state')) { f.alarms[p[0]] = p[1]; f.writes.push(p[0]); return { meta: { changes: 1 } }; }
        throw Error('the ERP may only ring Diana, never write content or stages: ' + sql);
      } }; return q;
  } } };
  return f;
}

test('a reel link in Direct rings Diana and adds nothing to Content, stage untouched (my.live_2026, Owner 2026-11-03)', async () => {
  const f = fixture([message('my.live_2026', 'De2AtC9ihsI')]);
  assert.deepEqual(await captureDmLinks(f.env), { added: 1 });
  const alarm = JSON.parse(f.alarms['diana_round_alarm:chat-my.live_2026']);
  assert.deepEqual(alarm.links, [url('De2AtC9ihsI')]); assert.equal(alarm.reason, 'reel_link'); assert.equal(alarm.handle, 'my.live_2026');
});

test('a link Diana already judged or added never rings again', async () => {
  const f = fixture([message('a', 'AAAAAA1'), message('b', 'BBBBBB1')], { content: [url('AAAAAA1')], judged: ['BBBBBB1'] });
  assert.deepEqual(await captureDmLinks(f.env), { added: 0 }); assert.equal(f.writes.length, 0);
});

test('a ringing empty-item alarm keeps its reason and gains the link; the same link does not ring twice', async () => {
  const key = 'diana_round_alarm:chat-k';
  const f = fixture([message('k', 'KKKKKK1')], { alarms: { [key]: JSON.stringify({ handle: 'k', cid: 'chat-k', at: '2026-11-03T10:00:00Z', reason: 'meta_empty' }) } });
  await captureDmLinks(f.env);
  const v = JSON.parse(f.alarms[key]); assert.equal(v.reason, 'meta_empty,reel_link'); assert.equal(v.at, '2026-11-03T10:00:00Z');
  assert.deepEqual(await captureDmLinks(f.env), { added: 0 });
});

test('large batches stay within the D1 parameter limit', async () => {
  const rows = Array.from({ length: 177 }, (_, i) => message('c' + i, 'ABCDEF' + i));
  const f = fixture(rows, { content: rows.map(r => url(r.text.split('/reel/')[1].slice(0, -1))) });
  assert.deepEqual(await captureDmLinks(f.env), { added: 0 }); assert.ok(f.maxParams <= 50);
});
