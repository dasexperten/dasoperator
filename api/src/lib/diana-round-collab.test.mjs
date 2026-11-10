import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {build} from 'esbuild';import {fileURLToPath} from 'node:url';
const b=await build({entryPoints:[fileURLToPath(new URL('./diana-round-collab.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',write:false});
const {reviewRoundCollab}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
function fixture(t){const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);CREATE TABLE ugc_creators(id TEXT,archived_at INTEGER);CREATE TABLE ugc_creator_platforms(creator_id TEXT,platform TEXT,normalized_handle TEXT);INSERT INTO ugc_creators VALUES('c',NULL);INSERT INTO ugc_creator_platforms VALUES('c','instagram','alice');`);const DB={prepare(sql){let args=[];return{bind(...v){args=v;return this},async first(){return db.prepare(sql).get(...args)??null},async run(){return{meta:{changes:Number(db.prepare(sql).run(...args).changes)}}}}}};return {db,env:{DB,META_IG_MESSAGING_TOKEN:'test'}};}
test('accepts only the exact creator invite and verifies accepted media',async t=>{
 const f=fixture(t);let posts=0,accepted=false;
 t.mock.method(globalThis,'fetch',async(url,options)=>{if(options.method==='POST'){posts++;accepted=true;assert.match(String(url),/media_id=12345/);return Response.json({success:true});}if(String(url).includes('collaborative_media'))return Response.json({data:accepted?[{id:'12345'}]:[]});return Response.json({data:accepted?[]:[{media_id:'12345',media_owner_username:'alice'},{media_id:'98765',media_owner_username:'other'}]});});
 const out=await reviewRoundCollab(f.env,'c','alice');assert.equal(out.status,'verified');assert.equal(posts,1);assert.equal(JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state').get().value).status,'verified');
});
test('a lost acceptance response is left unknown and never sent twice',async t=>{
 const f=fixture(t);let posts=0;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{if(options.method==='POST'){posts++;throw Error('timeout')}return Response.json({data:[{media_id:'12345',media_owner_username:'alice'}]})});
 assert.equal((await reviewRoundCollab(f.env,'c','alice')).status,'needs_review');assert.equal((await reviewRoundCollab(f.env,'c','alice')).status,'needs_review');assert.equal(posts,1);
});
test('failed list read is not treated as no pending invites',async t=>{
 const f=fixture(t);t.mock.method(globalThis,'fetch',async()=>new Response('{}',{status:403}));
 assert.equal((await reviewRoundCollab(f.env,'c','alice')).reason,'collab_list_unavailable');
});
