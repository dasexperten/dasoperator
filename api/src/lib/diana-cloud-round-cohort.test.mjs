import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
const bundle=await build({entryPoints:[fileURLToPath(new URL('./diana-cloud-round-cohort.ts',import.meta.url))],bundle:true,format:'esm',platform:'node',write:false});
const {roundCandidates}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
test('cohort retains missing original identities and includes posted only without content',async t=>{
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE ugc_creators(id TEXT,normalized_handle TEXT,lifecycle_stage TEXT,archived_at INTEGER);CREATE TABLE ugc_content(creator_id TEXT,content_url TEXT);CREATE TABLE ugc_ig_messages(id TEXT,conversation_id TEXT,direction TEXT,from_username TEXT,created_at TEXT);
 INSERT INTO ugc_creators VALUES('a','alice','paid',NULL),('b','bob','ordered',NULL),('c','carol','creation',NULL),('d','dee','posted',NULL),('e','eve','posted',NULL),('f','fern','replied',NULL),('g','gone','paid',1);
 INSERT INTO ugc_content VALUES('d','   '),('e','https://example.test/reel');
 INSERT INTO ugc_ig_messages VALUES('m1','chat','in','ALICE','2026-01-01'),('m2','chat','in','alice','2026-01-02'),('m3','chat','out','alice','2026-01-03');`);
 const env={DB:{prepare(sql){return{async all(){return{results:db.prepare(sql).all()}}}}}};
 const rows=await roundCandidates(env);assert.deepEqual(rows.map(x=>x.id),['a','b','c','d']);assert.equal(rows[0].message_id,'m2');assert.equal(rows[0].cid,'chat');assert.equal(rows[1].cid,null);
});
