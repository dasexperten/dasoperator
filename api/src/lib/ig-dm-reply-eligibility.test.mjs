import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url), { build } = require('esbuild');
const dir = mkdtempSync(join(tmpdir(), 'ig-retry-wake-'));
await build({ stdin: { contents: `export * from './ig-dm-reply-eligibility'; export {igDmHasNew} from './ig-dm-watch'; export {runAdaptiveLane} from './adaptive-runner';`,
  resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(dir, 'wake.mjs'),
  plugins: [{ name: 'watch-network-isolation', setup(b) {
    b.onResolve({ filter: /^\.\/ig-dm-(image-cache|archive)$/ }, a => ({ path: a.path, namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const cacheIncomingImages=()=>{}; export const archiveIgMessage=()=>{}; export const resumeRecoveredIgImage=()=>{};' }));
  } }] });
const { actionableIgReplyRetries, igDmHasNew, runAdaptiveLane, scenarioEvidence, completeScenario } = await import(pathToFileURL(join(dir, 'wake.mjs')));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const now = Date.parse('2026-10-23T20:50:00Z'), incoming = '2026-10-23T20:29:00.000Z', cid = 'test-conversation';
let seq = 0;
function fixture(t) {
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => assert.fail('fixture must not contact external services'));
  const path = join(dir, `${seq++}.sqlite`);
  function sql(query, params = [], script = false) {
    const p = spawnSync('python3', ['-c', `import sqlite3,json,sys
q,p,s=json.load(sys.stdin);c=sqlite3.connect(sys.argv[1]);c.row_factory=sqlite3.Row
if s:c.executescript(q);r=[]
else:r=[dict(x) for x in c.execute(q,p).fetchall()]
n=c.execute('SELECT changes()').fetchone()[0];c.commit();print(json.dumps({'results':r,'meta':{'changes':n}}))`, path], { input: JSON.stringify([query, params, script]), encoding: 'utf8' });
    if (p.status) throw Error(p.stderr); return JSON.parse(p.stdout);
  }
  sql(`CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
    CREATE TABLE ugc_ig_messages(id TEXT,conversation_id TEXT,created_at TEXT,direction TEXT,from_username TEXT,text TEXT,attachments_json TEXT);
    CREATE TABLE ugc_creators(id TEXT PRIMARY KEY,lifecycle_stage TEXT,archived_at INTEGER);
    CREATE TABLE ugc_creator_platforms(creator_id TEXT,platform TEXT,normalized_handle TEXT);
    CREATE TABLE ugc_payouts(creator_id TEXT,status TEXT,paid_at TEXT,sent_at TEXT,created_at INTEGER);`, [], true);
  const f = { sql, env: { DB: { prepare(query) { let params=[]; return { bind(...p){params=p;return this;}, async all(){return sql(query,params);},async first(){return sql(query,params).results[0]??null;},async run(){return sql(query,params);} }; } } } };
  f.state = value => sql('INSERT OR REPLACE INTO crm_sync_state VALUES(?,?,?)',['ig_reply_escalated:'+cid, JSON.stringify({ handle:'fixture',at:incoming,kind:'technical',status:'needs_review',reason:'send_failed: scenario_resend_unverified', ...value }),now]);
  f.plan = (plan, at='2026-10-23T19:00:00.000Z') => sql('INSERT OR REPLACE INTO crm_sync_state VALUES(?,?,?)', ['ig_reply_delivery:'+cid+':'+at, JSON.stringify({ incomingAt:at,conversationId:cid,version:1,items:[],...plan }),now]);
  f.key = (key,value) => sql('INSERT OR REPLACE INTO crm_sync_state VALUES(?,?,?)',[key,typeof value==='string'?value:JSON.stringify(value),now]);
  f.message = (at, direction='in') => sql('INSERT INTO ugc_ig_messages VALUES(?,?,?,?,?,?,?)',[crypto.randomUUID(),cid,at,direction,'fixture','Thanks',null]);
  f.message(incoming);f.state({});sql('INSERT INTO ugc_creators VALUES(?,?,NULL)',['creator','posted']);sql('INSERT INTO ugc_creator_platforms VALUES(?,?,?)',['creator','instagram','fixture']);
  return f;
}
test('current unsent recoverable scenario review wakes the normal probe without Graph or mutation', async t => {
  const f=fixture(t), before=f.sql('SELECT * FROM crm_sync_state').results;
  assert.deepEqual((await actionableIgReplyRetries(f.env)).map(x=>x.h),['fixture']);
  assert.equal(await igDmHasNew(f.env),true);
  assert.deepEqual(f.sql('SELECT * FROM crm_sync_state').results,before);
});
test('technical retries wake only when due; business and stuck reviews stay with Owner', async t => {
  const f=fixture(t);
  f.state({status:'retry',reason:'provider_error',next_retry_at:now+1}); assert.equal((await actionableIgReplyRetries(f.env)).length,0);
  f.state({status:'retry',reason:'provider_error',next_retry_at:now}); assert.equal((await actionableIgReplyRetries(f.env)).length,1);
  for (const state of [{kind:'business',status:'retry',next_retry_at:0},{kind:'stuck'},{status:'needs_review',reason:'send_failed: unknown' }]) {
    f.state(state);assert.equal((await actionableIgReplyRetries(f.env)).length,0);
  }
});
test('handled or superseded input never wakes, including a later outgoing response', async t => {
  const f=fixture(t);f.key('ig_reply:'+cid,incoming);assert.equal((await actionableIgReplyRetries(f.env)).length,0);
  f.sql('DELETE FROM crm_sync_state WHERE key=?',['ig_reply:'+cid]);
  f.message('2026-10-23T20:40:00.000Z','out');assert.equal((await actionableIgReplyRetries(f.env)).length,0);
});
test('90-second settle and seven-day reply age stay enforced', async t => {
  const f=fixture(t);
  for (const at of [new Date(now-30_000).toISOString(),new Date(now-8*86400000).toISOString()]) {
    f.sql('UPDATE ugc_ig_messages SET created_at=?',[at]);f.state({at});assert.equal((await actionableIgReplyRetries(f.env)).length,0);
  }
});
test('Owner decisions, browser queue and manual stages exclude automatic wake', async t => {
  const f=fixture(t);
  f.key('ig_owner_decision:'+cid,{at:incoming,text:'Owner decision'});assert.equal((await actionableIgReplyRetries(f.env)).length,0);
  f.sql('DELETE FROM crm_sync_state WHERE key=?',['ig_owner_decision:'+cid]);
  f.key('browser_queue:fixture',{items:[{text:'queued manually'}]});assert.equal((await actionableIgReplyRetries(f.env)).length,0);
  f.sql('DELETE FROM crm_sync_state WHERE key=?',['browser_queue:fixture']);
  for(const stage of ['refused','rival','owner','paused']){f.sql('UPDATE ugc_creators SET lifecycle_stage=?',[stage]);assert.equal((await actionableIgReplyRetries(f.env)).length,0);}
  f.sql("UPDATE ugc_creators SET lifecycle_stage='posted',archived_at=1");assert.equal((await actionableIgReplyRetries(f.env)).length,0);
});
test('current immutable, ambiguous, in-flight and partial historical outboxes never regenerate a reply', async t => {
  const f=fixture(t);
  for (const [plan,at] of [ [{status:'complete'},incoming], [{status:'ambiguous',items:[]}], [{status:'pending',items:[]}],
    [{status:'superseded',items:[{text:'unknown',status:'sending'}]}], [{status:'superseded',items:[{imageUrl:'one-card',status:'sent',messageId:'receipt'}]}] ]) {
    f.sql("DELETE FROM crm_sync_state WHERE key LIKE 'ig_reply_delivery:%'");f.plan(plan,at);
    assert.equal((await actionableIgReplyRetries(f.env)).length,0);
  }
});
test('active adaptive lease prevents probe and every business effect', async t => {
  const f=fixture(t);f.key('adaptive:ig_dm',{running_since:now-60_000,lease_until:now+60_000,next_at:now+30*60_000});
  const result=await runAdaptiveLane(f.env,'ig_dm',async()=>assert.fail('business must not run'),now,async()=>assert.fail('probe must not run'));
  assert.equal(result,'ig_dm: not due (running)');
});
test('completed four-card receipts imply text-only continuation even when stage is ordered', () => {
  const orderAt='2026-10-23T18:00:00.000Z', plan={status:'complete',incomingAt:'2026-10-23T19:00:00.000Z',completedAt:Date.parse('2026-10-23T19:01:00Z'),completion:{creatorId:'creator'},items:Array.from({length:4},(_,i)=>({imageUrl:'card'+i,status:'sent',messageId:'receipt'+i}))};
  assert.equal(completeScenario(plan,'creator',Date.parse(orderAt)),true);
  const evidence=scenarioEvidence({history:[],deliveryPlans:[plan],creatorId:'creator',stage:'ordered',orderAt,lastOutIndex:-1,incomingAt:incoming});
  assert.equal(evidence.scenarioSent,true);assert.equal(evidence.textOnlyScenario,true);assert.equal(evidence.canResumeReview,true);
});

test('empty browser queue is not an Owner hold, but real legacy text queue remains gated', async t => {
  const f=fixture(t);f.key('browser_queue:fixture',{items:[]});assert.equal((await actionableIgReplyRetries(f.env)).length,1);
  f.key('browser_queue:fixture',{text:'Manual queued reply'});assert.equal((await actionableIgReplyRetries(f.env)).length,0);
});
test('known unsupported order metadata and exact text-only receipt enable the paid-stage review', async t => {
  const f=fixture(t), order='2026-10-23T19:00:00.000Z',offer='2026-10-23T19:01:00.000Z';
  f.sql("UPDATE ugc_creators SET lifecycle_stage='paid'");
  f.sql('INSERT INTO ugc_payouts VALUES(?,?,?,?,?)',['creator','paid','2026-10-23T18:00:00.000Z',null,1]);
  f.sql('INSERT INTO ugc_ig_messages VALUES(?,?,?,?,?,?,?)',['order',cid,order,'in','fixture','', '[]']);
  f.key('ig_attachment_probe:order','unsupported_by_instagram');
  f.sql('INSERT INTO ugc_ig_messages VALUES(?,?,?,?,?,?,?)',['offer',cid,offer,'out',null,'Хотите сценарий?',null]);
  f.plan({status:'complete',items:[{text:'Хотите сценарий?',status:'sent',messageId:'offer'}]},order);
  assert.equal((await actionableIgReplyRetries(f.env)).length,1);
  f.sql("DELETE FROM crm_sync_state WHERE key='ig_attachment_probe:order'");
  assert.equal((await actionableIgReplyRetries(f.env)).length,0);
});
