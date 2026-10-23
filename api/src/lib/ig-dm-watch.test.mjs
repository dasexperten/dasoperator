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
const dir = mkdtempSync(join(tmpdir(), 'ig-watch-'));
const outfile = join(dir, 'watch.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./ig-dm-watch.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile,
  plugins: [{ name: 'archive-boundary', setup(b) {
    b.onResolve({ filter: /^\.\/ig-dm-(archive|image-cache)$/ }, a => ({ path: a.path, namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
      export const archiveIgMessage=async(_env,cid,msg)=>{globalThis.__watchArchived.push([cid,msg.id]);return {inserted:true,incoming:true}};
      export const resumeRecoveredIgImage=async()=>{}, cacheIncomingImages=async()=>{};
    ` }));
  } }] });
const { igDmWatch, sendIgDirect } = await import(pathToFileURL(outfile)); rmSync(dir, { recursive: true });

async function run(t, { failMessage = false, failListPage = false } = {}) {
  const old = '2026-10-23T10:00:00Z', good = '2026-10-23T10:01:00Z', bad = '2026-10-23T10:02:00Z';
  const state = new Map([['ig_dm:last_seen', old], ['ig_dm_seen_conversations', JSON.stringify({ good: old, bad: old })]]);
  globalThis.__watchArchived = [];
  t.mock.method(Date, 'now', () => Date.parse('2026-10-23T10:03:00Z'));
  t.mock.method(globalThis, 'fetch', async input => {
    const u = new URL(input);
    if (u.searchParams.get('fields') === 'access_token') return Response.json({ access_token: 'fixture-only' });
    if (u.pathname.endsWith('/conversations')) {
      if (u.searchParams.has('after')) return Response.json({ error: { message: 'temporary list failure' } }, { status: 503 });
      return Response.json({ data: [{ id: 'good', updated_time: good }, ...(!failListPage ? [{ id: 'bad', updated_time: bad }] : [])], ...(failListPage ? { paging: { cursors: { after: 'page2' } } } : {}) });
    }
    if (u.pathname.endsWith('/bad') && failMessage) return Response.json({ error: { message: 'temporary message failure' } }, { status: 503 });
    const cid = u.pathname.endsWith('/good') ? 'good' : 'bad';
    return Response.json({ messages: { data: [{ id: cid + '-message', message: 'hello', created_time: cid === 'good' ? good : bad, from: { id: 'blogger' } }] } });
  });
  const env = { META_IG_MESSAGING_TOKEN: 'fixture-only', DB: { prepare(sql) { let p; const q = {
    bind(...values) { p = values; return q; }, async all() { return { results: [] }; },
    async first() { return state.has(p[0]) ? { value: state.get(p[0]) } : null; },
    async run() { state.set(p[0], p[1]); return { meta: { changes: 1 } }; }
  }; return q; } } };
  return { result: await igDmWatch(env), state, old, good, bad, archived: globalThis.__watchArchived };
}
test('a failed conversation fails the pass while good imports and failed seen marker are preserved', async t => {
  const f = await run(t, { failMessage: true });
  assert.equal(f.result.ok, false); assert.equal(f.result.activity, true); assert.match(f.result.error, /1.*unreadable/);
  assert.equal(f.result.stored, 1); assert.equal(f.result.incoming, 1); assert.deepEqual(f.archived, [['good', 'good-message']]);
  const seen = JSON.parse(f.state.get('ig_dm_seen_conversations'));
  assert.equal(seen.good, f.good); assert.equal(seen.bad, f.old);
});
test('a partially failed conversation list reports failure without losing successful imports', async t => {
  const f = await run(t, { failListPage: true });
  assert.equal(f.result.ok, false); assert.match(f.result.error, /list incomplete/);
  assert.equal(f.result.stored, 1); assert.equal(JSON.parse(f.state.get('ig_dm_seen_conversations')).good, f.good);
});
test('fully successful conversation reads remain successful', async t => {
  const f = await run(t); assert.equal(f.result.ok, true); assert.equal(f.result.stored, 2); assert.equal(f.result.error, undefined);
});

async function sendFixture(t, response) {
  let sends=0;
  t.mock.method(globalThis,'fetch',async input=>{
    const url=new URL(input);
    if(url.searchParams.get('fields')==='access_token')return Response.json({access_token:'fixture-only'});
    sends++;
    if(response instanceof Error)throw response;
    return response;
  });
  const env={META_IG_MESSAGING_TOKEN:'fixture-only',DB:{prepare(){return {bind(){return this;},async first(){return {from_id:'recipient'};}};}}};
  return {result:await sendIgDirect(env,'creator','test'),sends};
}
test('send classifies explicit allowed-window rejection as known unsent',async t=>{
  const f=await sendFixture(t,Response.json({error:{code:10,message:'Message cannot be sent outside the allowed window'}},{status:400}));
  assert.equal(f.result.delivery,'not_sent');assert.equal(f.result.ok,false);assert.equal(f.sends,1);
});
for(const [name,response]of [
  ['generic 4xx',()=>Response.json({error:{code:2,message:'An unknown error occurred'}},{status:400})],
  ['unstructured 4xx',()=>new Response('gateway error',{status:408})],
  ['server failure',()=>Response.json({error:{code:10,message:'Permission unavailable'}},{status:503})],
  ['missing receipt',()=>Response.json({recipient_id:'recipient'})],
  ['conflicting receipt and error',()=>Response.json({message_id:'maybe-sent',error:{code:10,message:'Permission denied'}},{status:400})],
  ['transport timeout',()=>new Error('timeout')]
])test('send keeps '+name+' ambiguous without retrying',async t=>{
  const f=await sendFixture(t,response());assert.equal(f.result.delivery,'unknown');assert.equal(f.result.ok,false);assert.equal(f.sends,1);
});
test('successful send returns the actual Meta receipt',async t=>{
  const f=await sendFixture(t,Response.json({message_id:'meta-receipt'}));assert.equal(f.result.ok,true);assert.equal(f.result.messageId,'meta-receipt');assert.equal(f.sends,1);
});
test('send preflight failure is known unsent and makes no POST',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw Error('unexpected network');});
  const r=await sendIgDirect({},'creator','text');assert.equal(r.delivery,'not_sent');assert.equal(r.ok,false);
});

test('recipient lookup failure is known unsent, not an ambiguous POST',async t=>{
  t.mock.method(globalThis,'fetch',()=>{throw Error('unexpected network');});
  const env={META_IG_MESSAGING_TOKEN:'fixture-only',DB:{prepare(){return {bind(){return this;},async first(){throw Error('database unavailable');}};}}};
  const r=await sendIgDirect(env,'creator','text');assert.equal(r.delivery,'not_sent');assert.equal(r.ok,false);
});
