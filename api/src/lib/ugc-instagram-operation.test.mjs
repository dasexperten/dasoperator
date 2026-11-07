import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const temp=mkdtempSync(join(tmpdir(),'ugc-instagram-'));
await build({entryPoints:[new URL('../routes/internal-ugc.ts',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',outfile:join(temp,'route.mjs'),logLevel:'silent'});
const route=(await import(pathToFileURL(join(temp,'route.mjs')))).default;
const root=new URL('../../../',import.meta.url);
const sql=new DatabaseSync(':memory:');
sql.exec('CREATE TABLE ugc_content(id TEXT PRIMARY KEY,content_url TEXT);');
sql.exec(readFileSync(new URL('db/migrations/0157_ugc_reel_jobs.sql',root),'utf8'));
sql.exec(readFileSync(new URL('db/migrations/0159_ugc_reel_alarm.sql',root),'utf8'));
sql.exec(readFileSync(new URL('db/migrations/0160_ugc_instagram_operations.sql',root),'utf8'));
const DB={prepare(query){return {values:[],bind(...values){this.values=values;return this;},async first(){return sql.prepare(query).get(...this.values)??null;},async all(){return {results:sql.prepare(query).all(...this.values)};},async run(){return {meta:{changes:Number(sql.prepare(query).run(...this.values).changes)}};}};},async batch(statements){sql.exec('BEGIN');try{const out=[];for(const statement of statements)out.push(await statement.run());sql.exec('COMMIT');return out;}catch(error){sql.exec('ROLLBACK');throw error;}}};
const env={DB,EMAILER_SERVICE_SECRET:'test-only-service-secret'};
const call=(path,body,authorized=true)=>route.request('https://erp.test'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(authorized?{'X-Emailer-Service-Secret':env.EMAILER_SERVICE_SECRET}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})},env);
const base=id=>`/reel-jobs/${id}/instagram-operation`;
const media='18099547076128004';
const container='17990000000000000001';
const caption='Автор видео: Ксения @kseniya_obzor_wb_ozon';
const permalink='https://www.instagram.com/reel/DfahVHDCjCY/';
const input={account:'dasexperten',source_sha256:'a'.repeat(64),caption};
const verification={id:media,username:'dasexperten',caption,media_type:'VIDEO',media_product_type:'REELS',permalink,checked_at:new Date(Date.now()-1000).toISOString()};
function seed(id,status='working',proofs=[]){
  sql.prepare('INSERT INTO ugc_content VALUES(?,?)').run(id,'https://www.youtube.com/watch?v=gQazkM1tBxw&access_token=never_store_this');
  sql.prepare(`INSERT INTO ugc_reel_jobs(content_id,status,claim_id,requested_by,requested_at,published_at,publications,updated_at) VALUES(?,?,?,'owner','2026-11-07T00:00:00Z',?,?,?)`).run(id,status,'test-claim',status==='published'?'2026-11-07T01:00:00Z':null,JSON.stringify(proofs),'2026-11-07T01:00:00Z');
}
async function prepare(id){const response=await call(base(id),{...input,claim_id:'test-claim'});assert.equal(response.status,200);return (await response.json()).operation;}
async function event(id,op,kind,extra={}){return call(base(id)+'/'+op.id+'/event',{claim_id:'test-claim',expected_revision:op.revision,kind,...extra});}
test.beforeEach(()=>sql.exec('DELETE FROM ugc_instagram_operation_events;DELETE FROM ugc_instagram_operations;DELETE FROM ugc_reel_jobs;DELETE FROM ugc_content;'));
test('journal remains behind existing service auth and accepts only official account/working claim',async()=>{
  seed('auth');
  assert.equal((await call(base('auth'),undefined,false)).status,401);
  assert.equal((await call(base('auth'),{...input,claim_id:'wrong'})).status,409);
  assert.equal((await call(base('auth'),{...input,account:'unrelated',claim_id:'test-claim'})).status,422);
  assert.equal((await call(base('auth'),{...input,caption:'EAA'+'x'.repeat(40),claim_id:'test-claim'})).status,422);
});
test('reservation is idempotent; file/caption changes cannot create a second operation',async()=>{
  seed('prepare');const op=await prepare('prepare');
  const again=await(await call(base('prepare'),{...input,claim_id:'test-claim'})).json();
  assert.equal(again.operation.id,op.id);assert.equal(again.created,false);
  assert.match(op.idempotency_key,/^[a-f0-9]{64}$/);
  assert.equal(op.source_url,'https://www.youtube.com/watch?v=gQazkM1tBxw');
  assert.equal((await call(base('prepare'),{...input,source_sha256:'b'.repeat(64),claim_id:'test-claim'})).status,409);
  assert.equal((await call(base('prepare'),{...input,caption:caption+' changed',claim_id:'test-claim'})).status,409);
  const snapshot=await(await call(base('prepare'))).json();assert.equal(snapshot.events.length,1);
  seed('duplicate-other-content');
  assert.equal((await call(base('duplicate-other-content'),{...input,claim_id:'test-claim'})).status,409);
});
test('one pre-send reservation wins, stale revisions cannot send again, and IDs never become floats',async()=>{
  seed('send');let op=await prepare('send');
  const accepted=await event('send',op,'container_requested');assert.equal(accepted.status,200);
  assert.equal((await event('send',op,'container_requested')).status,409);
  op=(await accepted.json()).operation;
  const created=await event('send',op,'container_created',{container_id:container});assert.equal(created.status,200);op=(await created.json()).operation;
  assert.equal(op.container_id,container);
  assert.equal((await event('send',op,'processing',{container_id:Number(container)})).status,409);
  assert.equal((await event('send',op,'processing',{container_id:'17999999999999999'})).status,409);
  assert.equal((await event('send',op,'verified',{verification})).status,409);
  const pending=await event('send',op,'publish_requested');op=(await pending.json()).operation;
  const posted=await event('send',op,'published',{media_id:media});op=(await posted.json()).operation;
  assert.equal((await event('send',op,'verified',{verification:{...verification,username:'other'}})).status,409);
  const verified=await event('send',op,'verified',{verification});assert.equal(verified.status,200);
  assert.equal((await verified.json()).operation.state,'verified');
  assert.equal(sql.prepare('SELECT status FROM ugc_reel_jobs WHERE content_id=?').get('send').status,'working');
});
test('uncertain request is terminal: no automatic reset, recreation or resend',async()=>{
  seed('uncertain');let op=await prepare('uncertain');op=(await(await event('uncertain',op,'container_requested')).json()).operation;
  op=(await(await event('uncertain',op,'uncertain',{error_code:'provider_timeout'})).json()).operation;
  assert.equal((await event('uncertain',op,'container_requested')).status,409);
  const replay=await(await call(base('uncertain'),{...input,claim_id:'test-claim'})).json();assert.equal(replay.operation.state,'uncertain');assert.equal(replay.created,false);
});
test('historical reconciliation imports exact IDs and real readback without changing old job or inventing stage times',async()=>{
  const proof={platform:'instagram',account:'dasexperten',url:permalink,verified:true};
  seed('history','published',[proof]);const before=sql.prepare('SELECT * FROM ugc_reel_jobs WHERE content_id=?').get('history');
  const request={...input,mode:'reconcile_existing',container_id:container,media_id:media,verification};
  assert.equal((await call(base('history'),{...request,verification:{...verification,checked_at:'2099-01-01T00:00:00Z'}})).status,422);
  assert.equal((await call(base('history'),{...request,verification:{...verification,permalink:'https://www.instagram.com:444/reel/DfahVHDCjCY/'}})).status,422);
  const response=await call(base('history'),request);assert.equal(response.status,200);
  const op=(await response.json()).operation;assert.equal(op.state,'verified');assert.equal(op.container_id,container);assert.equal(op.media_id,media);
  const snapshot=await(await call(base('history'))).json();assert.equal(snapshot.events.length,1);assert.equal(snapshot.events[0].kind,'reconciled_existing');
  assert.equal(JSON.parse(snapshot.events[0].evidence_json).original_stage_timestamps,null);
  assert.deepEqual(sql.prepare('SELECT * FROM ugc_reel_jobs WHERE content_id=?').get('history'),before);
  assert.equal((await(await call(base('history'),request)).json()).created,false);
  assert.equal((await call(base('history'),{...request,verification:{...verification,caption:'wrong'}})).status,422);
  assert.equal(JSON.parse((await currentHistory()).verification_json).caption,caption);
  async function currentHistory(){return (await(await call(base('history'))).json()).operation;}
});
test.after(()=>{sql.close();rmSync(temp,{recursive:true,force:true});});
