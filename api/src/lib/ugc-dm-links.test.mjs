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
await build({ entryPoints: [fileURLToPath(new URL('./ugc-dm-links.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile,
  plugins: [{ name: 'creator-boundary', setup(b) {
    b.onResolve({ filter: /^\.\/ig-dm-reply$/ }, () => ({ path: 'creator', namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
      export const ensureCreator = (_env, handle) => globalThis.__dmLinks.ensure(handle);
      export const nextStage = (stage, target) => ['posted','gold','refused','failed'].includes(stage) ? null : target;
    ` }));
  } }] });
const { captureDmLinks } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });

const url = code => `https://www.instagram.com/reel/${code}/`;
const message = (h, code, date = '2026-07-10T12:00:00Z') => ({ h, conversation_id: 'chat-' + h, text: url(code), created_at: date });
function fixture(rows, platforms = [], urls = []) {
  const f = { rows, platforms, urls: new Set(urls), firstReads: 0, allReads: 0, ensureCalls: 0, writes: [], maxParams: 0 };
  f.ensure = async h => {
    f.ensureCalls++;
    const p = f.platforms.find(p => p.h === h) ?? { h, cid: 'creator-' + h, pid: 'platform-' + h, stage: 'replied' };
    if (!f.platforms.includes(p)) f.platforms.push(p);
    return { cid: p.cid, pid: p.pid };
  };
  f.env = { DB: { prepare(sql) {
    let p;
    const q = { bind(...values) { p = values; f.maxParams = Math.max(f.maxParams, p.length); return q; },
      async all() {
        f.allReads++;
        if (f.failReads) throw Error('D1 unavailable');
        if (sql.includes('FROM ugc_ig_messages')) return { results: f.rows };
        if (sql.includes('FROM ugc_content')) return { results: [...f.urls].filter(u => p.some(pattern => u.includes(pattern.slice(1, -1)))).map(content_url => ({ content_url })) };
        if (sql.includes('FROM ugc_creator_platforms')) return { results: f.platforms.filter(x => p.includes(x.h)).map(x => ({ ...x })) };
        throw Error('unexpected all ' + sql);
      },
      async first() {
        f.firstReads++;
        if (sql.includes('FROM ugc_content')) return [...f.urls].some(u => u.includes(p[0].slice(1, -1))) ? { known: 1 } : null;
        if (sql.includes('FROM ugc_creators')) { const item = f.platforms.find(x => x.cid === p[0]); return item ? { s: item.stage } : null; }
        throw Error('unexpected first ' + sql);
      },
      async run() {
        if (sql.startsWith('UPDATE ugc_creators')) {
          const creator = f.platforms.find(x => x.cid === p[0]);
          if (f.beforeStageWrite) f.beforeStageWrite(creator);
          if (p.length >= 3 && creator.stage !== p[2]) return { meta: { changes: 0 } };
          creator.stage = 'posted'; f.writes.push({ type: 'stage', cid: p[0] });
        } else if (sql.includes('INSERT INTO ugc_content')) {
          if (f.urls.has(p[3])) return { meta: { changes: 0 } };
          f.urls.add(p[3]); f.writes.push({ type: 'content', cid: p[1], pid: p[2], url: p[3], at: p[7] });
        } else throw Error('unexpected run ' + sql);
        return { meta: { changes: 1 } };
      }
    }; return q;
  } } };
  globalThis.__dmLinks = f; return f;
}

test('177 known links from posted creators use bounded preloads, no per-link lookup or write', async () => {
  const rows = Array.from({ length: 177 }, (_, i) => message('creator' + i, 'ABCDEF' + i));
  const f = fixture(rows, rows.map(r => ({ h: r.h, cid: r.h, pid: 'p-' + r.h, stage: 'posted' })), rows.map(r => r.text));
  assert.deepEqual(await captureDmLinks(f.env), { added: 0 });
  assert.equal(f.firstReads, 0); assert.equal(f.ensureCalls, 0); assert.equal(f.writes.length, 0);
  assert.ok(f.allReads <= 9); assert.ok(f.maxParams <= 50);
});

test('a known link still advances its sender, without moving a different creator', async () => {
  const f = fixture([message('sender', 'ABCDEF')], [{ h: 'sender', cid: 'right', pid: 'p', stage: 'replied' }, { h: 'other', cid: 'wrong', pid: 'other', stage: 'replied' }], [url('ABCDEF')]);
  assert.deepEqual(await captureDmLinks(f.env), { added: 0 });
  assert.deepEqual(f.writes, [{ type: 'stage', cid: 'right' }]);
});

test('missing creator is ensured once and publication date remains the message date', async () => {
  const f = fixture([message('new', 'ABCDEF'), message('new', 'GHIJKL')]);
  assert.deepEqual(await captureDmLinks(f.env), { added: 2 });
  assert.equal(f.ensureCalls, 1);
  assert.deepEqual(f.writes.filter(w => w.type === 'content').map(w => [w.cid, w.pid, w.at]), [
    ['creator-new', 'platform-new', Date.parse('2026-07-10T12:00:00Z')], ['creator-new', 'platform-new', Date.parse('2026-07-10T12:00:00Z')]
  ]);
});

test('new publications retain the limit of 40; repeated codes count once', async () => {
  const rows = Array.from({ length: 45 }, (_, i) => message('one', 'ABCDEF' + i));
  const f = fixture([rows[0], ...rows], [{ h: 'one', cid: 'c', pid: 'p', stage: 'posted' }]);
  assert.deepEqual(await captureDmLinks(f.env), { added: 40 });
  assert.equal(f.writes.filter(w => w.type === 'content').length, 40);
});

test('concurrent promotion to gold is not overwritten by the earlier preload', async () => {
  const f = fixture([message('one', 'ABCDEF')], [{ h: 'one', cid: 'c', pid: 'p', stage: 'replied' }], [url('ABCDEF')]);
  f.beforeStageWrite = creator => { creator.stage = 'gold'; };
  await captureDmLinks(f.env); assert.equal(f.platforms[0].stage, 'gold');
});

test('a different publication with a longer code cannot hide a new link', async () => {
  const f = fixture([message('one', 'ABCDEF')], [{ h: 'one', cid: 'c', pid: 'p', stage: 'posted' }], [url('ABCDEFextra')]);
  assert.deepEqual(await captureDmLinks(f.env), { added: 1 });
});

test('a failed preload remains a failed scan without silent skips or writes', async () => {
  const f = fixture([message('one', 'ABCDEF')]); f.failReads = true;
  await assert.rejects(captureDmLinks(f.env), /D1 unavailable/);
  assert.equal(f.writes.length, 0); assert.equal(f.ensureCalls, 0);
});
