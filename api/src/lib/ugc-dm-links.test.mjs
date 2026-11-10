import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {publicationLink,publicationLinks,contentReviewKey} from './ugc-publication-links.mjs';
import {contentEngagement} from './ugc-content-metrics.mjs';
import {contentState,publicationNetwork} from '../../../web/lib/ugc-content-state.mjs';
const {build}=createRequire(import.meta.url)('esbuild');
const dir=mkdtempSync(join(tmpdir(),'ugc-pending-'));
for(const file of ['ugc-dm-links','ugc-content-review'])await build({entryPoints:[fileURLToPath(new URL('./'+file+'.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:join(dir,file+'.mjs')});
await build({entryPoints:[fileURLToPath(new URL('../routes/ugc.ts',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:join(dir,'ugc-route.mjs')});
const {default:ugcRoute}=await import(pathToFileURL(join(dir,'ugc-route.mjs')));
await build({entryPoints:[fileURLToPath(new URL('../../../scripts/ugc-content-review.mjs',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:join(dir,'protected-review.mjs')});
const {protectedContentReview}=await import(pathToFileURL(join(dir,'protected-review.mjs')));
const {captureDmLinks}=await import(pathToFileURL(join(dir,'ugc-dm-links.mjs')));
const {reviewContent}=await import(pathToFileURL(join(dir,'ugc-content-review.mjs')));
rmSync(dir,{recursive:true});
const url='https://www.instagram.com/reel/De2AtC9ihsI/';
function fixture(handles=['alice']){
 const db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
 for(const name of ['0098_ugc_creator_pipeline.sql','0099_ugc_link_health.sql','0100_ugc_product_identification.sql'])db.exec(readFileSync(new URL('../../../db/migrations/'+name,import.meta.url),'utf8'));
 db.exec("ALTER TABLE ugc_creators ADD COLUMN archived_at INTEGER;CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);CREATE TABLE ugc_ig_messages(conversation_id TEXT,from_username TEXT,text TEXT,created_at TEXT,direction TEXT);");
 let maxParams=0;
 for(const h of handles){db.prepare("INSERT INTO ugc_creators(id,normalized_handle,lifecycle_stage,created_at,updated_at) VALUES (?,?,'creation',1,1)").run('c-'+h,h);db.prepare("INSERT INTO ugc_creator_platforms(id,creator_id,platform,handle,normalized_handle,created_at,updated_at) VALUES (?,?,'instagram',?,?,1,1)").run('p-'+h,'c-'+h,h,h);}
 const env={DB:{prepare(sql){let p=[];const q={bind(...a){p=a;maxParams=Math.max(maxParams,p.length);return q;},async all(){return {results:db.prepare(sql).all(...p)};},async first(){return db.prepare(sql).get(...p)??null;},async run(){const r=db.prepare(sql).run(...p);return {meta:{changes:Number(r.changes)}};}};return q;},async batch(stmts){db.exec('BEGIN');try{const results=[];for(const q of stmts)results.push(await q.run());db.exec('COMMIT');return results;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 return {db,env,get maxParams(){return maxParams;},message(h,text=url){db.prepare("INSERT INTO ugc_ig_messages VALUES (?,?,?,'2026-11-06T14:00:00Z','in')").run('chat-'+h,h,text);},rows(){return db.prepare('SELECT * FROM ugc_content').all();},stage(h='alice'){return db.prepare('SELECT lifecycle_stage FROM ugc_creators WHERE id=?').get('c-'+h).lifecycle_stage;}};
}
test('discovery inserts one pending row, preserves stage/unknown metrics, keeps alarm; health cannot confirm',async()=>{
 const f=fixture();f.message('alice');
 assert.deepEqual(await captureDmLinks(f.env),{added:1});
 let r=f.rows()[0];assert.equal(r.product_status,'queued');assert.equal(r.engagement_rate,null);assert.equal(r.published_at,null);assert.equal(f.stage(),'creation');assert.equal(r.creator_platform_id,'p-alice');assert.equal(JSON.parse(r.product_evidence).author_verified,false);
 assert.ok(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_round_alarm:chat-alice'));
 f.db.prepare("UPDATE ugc_content SET link_status='active',likes=20,comments=5").run();
 r=f.rows()[0];assert.equal(contentState(r),'pending');assert.equal(contentEngagement(r,1000,'instagram'),null);
 assert.deepEqual(await captureDmLinks(f.env),{added:0});assert.equal(f.rows().length,1);
});
test('confirmation requires evidence, preserves id and observed date, then confirmed platform state and posted',async()=>{
 const f=fixture();f.message('alice');await captureDmLinks(f.env);const id=f.rows()[0].id;
 await assert.rejects(reviewContent(f.env,id,{verdict:'confirmed',evidence:'loaded'}),/author_and_product/);
 await reviewContent(f.env,id,{verdict:'confirmed',evidence:'Diana opened the original: creator is author; our tube is visible',author_verified:true,our_product:true,published_at:'2026-11-04T12:00:00Z'});
 const r=f.rows()[0];assert.equal(r.id,id);assert.equal(r.product_source,'manual');assert.equal(contentState(r),'live');assert.equal(r.published_at,'2026-11-04T12:00:00Z');assert.equal(f.stage(),'posted');
 assert.deepEqual(await captureDmLinks(f.env),{added:0});
});
test('Marysa: verified live publication advances creation without inventing a product check',async()=>{
 const f=fixture(['marysa.shat']);f.message('marysa.shat');await captureDmLinks(f.env);const id=f.rows()[0].id;
 f.db.prepare("UPDATE ugc_content SET product_status='unknown',product_evidence=NULL").run();
 const input={verdict:'published',evidence:'Existing verified Diana event: creator shared her published reel; original thread and URL recorded',author_verified:true,publication_verified:true,published_at:'2026-11-08T05:53:02Z'};
 await reviewContent(f.env,id,input);
 const r=f.rows()[0];assert.equal(f.stage('marysa.shat'),'posted');assert.equal(r.link_status,'active');assert.equal(r.published_at,input.published_at);
 assert.equal(r.product_status,'unknown');assert.equal(r.product_evidence,null);assert.equal(r.product_checked_at,null);assert.equal(contentState(r),'pending');
 const receipt=JSON.parse(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get(contentReviewKey('c-marysa.shat',publicationLink(url).key)).value);
 assert.equal(receipt.publication_verified,true);assert.equal(receipt.our_product,null);
 await reviewContent(f.env,id,input);assert.equal(f.rows().length,1);assert.equal(f.stage('marysa.shat'),'posted');
 assert.equal((await captureDmLinks(f.env)).added,0);
});
test('publication requires author and live evidence; preserves unknown date, product facts, manual stages and gold',async()=>{
 const f=fixture();f.message('alice');await captureDmLinks(f.env);const id=f.rows()[0].id;
 const input={verdict:'published',evidence:'Original author and live URL verified',author_verified:true,publication_verified:true};
 for(const bad of [{...input,author_verified:false},{...input,publication_verified:false},{...input,evidence:''},{...input,published_at:'2099-01-01T00:00:00Z'}])await assert.rejects(reviewContent(f.env,id,bad));
 assert.equal(f.stage(),'creation');assert.equal(f.rows()[0].link_status,null);
 f.db.prepare("INSERT INTO crm_sync_state VALUES ('manual_stage:c-alice',?,1)").run(JSON.stringify({to:'creation',at:1}));
 await reviewContent(f.env,id,input);assert.equal(f.stage(),'creation');assert.equal(f.rows()[0].published_at,null);
 f.db.prepare("DELETE FROM crm_sync_state WHERE key='manual_stage:c-alice'").run();f.db.prepare("UPDATE ugc_creators SET lifecycle_stage='gold'").run();
 f.db.prepare("UPDATE ugc_content SET product_status='identified',product_evidence='previous verified product',product_checked_at='2026-11-01'").run();
 await reviewContent(f.env,id,input);assert.equal(f.stage(),'gold');assert.equal(f.rows()[0].product_evidence,'previous verified product');assert.equal(f.rows()[0].product_checked_at,'2026-11-01');
});
test('rejected row is removed atomically and never restored; other creator same URL is untouched',async()=>{
 const f=fixture(['alice','bob']);f.message('alice');f.message('bob');assert.equal((await captureDmLinks(f.env)).added,2);
 const a=f.rows().find(r=>r.creator_id==='c-alice'),b=f.rows().find(r=>r.creator_id==='c-bob');assert.notEqual(a.id,b.id);
 await assert.rejects(reviewContent(f.env,a.id,{verdict:'rejected',evidence:'could not open'}),/wrong_author_or_product/);
 await reviewContent(f.env,a.id,{verdict:'rejected',evidence:'Forwarded another author',author_verified:false,our_product:true});
 assert.equal(f.rows().length,1);assert.equal(f.rows()[0].id,b.id);assert.equal(f.stage(),'creation');
 assert.ok(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get(contentReviewKey('c-alice','instagram:De2AtC9ihsI')));
 assert.deepEqual(await captureDmLinks(f.env),{added:0});assert.equal(f.rows().length,1);
});
test('cross-network pending uses known provenance without inventing identity or wrong-platform ER',async()=>{
 const f=fixture();f.message('alice','https://www.tiktok.com/@someauthor/video/1234567890');
 await captureDmLinks(f.env);let r=f.rows()[0];assert.equal(r.creator_id,'c-alice');assert.equal(r.creator_platform_id,'p-alice');assert.equal(publicationNetwork(r.content_url),'tiktok');
 await reviewContent(f.env,r.id,{verdict:'confirmed',evidence:'Actual original belongs to Alice and shows our product',author_verified:true,our_product:true});
 r=f.rows()[0];assert.equal(contentEngagement({...r,likes:10,comments:2},100,'instagram'),null);
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_creator_platforms').get().n,1);
});
test('unmapped sender keeps alarm without a fabricated card; malformed/unowned URLs are ignored',async()=>{
 const f=fixture();f.message('stranger');f.message('alice','https://instagram.com.evil.invalid/reel/AAAAAA1/ https://instagram.com/profile/ https://evil.test/?url=https://instagram.com/reel/AAAAAA1/');
 assert.equal((await captureDmLinks(f.env)).added,0);assert.equal(f.rows().length,0);
 assert.ok(f.db.prepare('SELECT value FROM crm_sync_state WHERE key=?').get('diana_round_alarm:chat-stranger'));
 assert.equal(publicationLink('https://instagram.com@evil.test/reel/AAAAAA1/'),null);
});
test('bounded parameter batches and canonical variants do not duplicate large imports',async()=>{
 const handles=Array.from({length:177},(_,i)=>'author'+i),f=fixture(handles);
 for(let i=0;i<handles.length;i++)f.message(handles[i],'https://instagram.com/reels/ABCDEF'+i+'/?igsh=ignored');
 assert.equal((await captureDmLinks(f.env)).added,177);assert.ok(f.maxParams<=50);assert.equal((await captureDmLinks(f.env)).added,0);
});
test('supported publication platforms have exact canonical identity; pending/confirmed state follows review not HTTP',()=>{
 const cases=[['https://instagram.com/reels/ABCDEF1/?igsh=x','instagram'],['https://www.tiktok.com/@creator/video/12345','tiktok'],['https://t.me/mychannel/123','telegram'],['https://vk.com/wall-123_456','vk'],['https://vk.com/clip-123_456','vk'],['https://facebook.com/reel/123456/','facebook']];
 for(const [href,network] of cases){assert.equal(publicationLinks(href)[0].platform,network);assert.equal(publicationNetwork(href),network);assert.equal(contentState({product_status:'queued',link_status:'active'}),'pending');assert.equal(contentState({product_status:'identified',link_status:'active'}),'live');}
 assert.equal(publicationLink('https://t.me/+invite'),null);assert.equal(publicationLink('https://instagram.com:443/reel/AAAAAA1/')?.platform,'instagram');
});


test('review route enforces existing session and write permission before changing content',async()=>{
 const f=fixture();f.message('alice');await captureDmLinks(f.env);const id=f.rows()[0].id;
 f.db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER,permissions TEXT);CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id TEXT,expires_at INTEGER);");
 const insertUser=f.db.prepare('INSERT INTO users VALUES (?,?,?,?,?)'),insertSession=f.db.prepare('INSERT INTO sessions VALUES (?,?,?)');
 insertUser.run('reader','reader','user',1,JSON.stringify({'/ugc':'read'}));insertUser.run('writer','writer','user',1,JSON.stringify({'/ugc':'rw'}));
 insertSession.run('r'.repeat(32),'reader',Date.now()+100000);insertSession.run('w'.repeat(32),'writer',Date.now()+100000);
 const review={verdict:'confirmed',evidence:'Original author and product independently read by Diana',author_verified:true,our_product:true};
 const request=token=>ugcRoute.request('/content/'+id+'/review',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(review)},f.env);
 assert.equal((await request()).status,401);assert.equal((await request('r'.repeat(32))).status,403);assert.equal(f.rows()[0].product_status,'queued');
 assert.equal((await request('w'.repeat(32))).status,200);assert.equal(f.rows()[0].product_status,'identified');
});


test('existing protected helper reuses review validation and one atomic REST batch, no new auth door',async()=>{
 const f=fixture();f.message('alice');await captureDmLinks(f.env);const id=f.rows()[0].id,calls=[];
 const fetchImpl=async(_url,init)=>{
   const body=JSON.parse(init.body);calls.push(body);
   if(body.batch){const results=await f.env.DB.batch(body.batch.map(q=>f.env.DB.prepare(q.sql).bind(...q.params)));return Response.json({success:true,result:results.map(r=>({...r,success:true}))});}
   const result=await f.env.DB.prepare(body.sql).bind(...body.params).all();return Response.json({success:true,result:[{success:true,results:result.results}]});
 };
 const input={id,verdict:'published',evidence:'Original author and live publication verified by Diana',author_verified:true,publication_verified:true};
 await assert.rejects(protectedContentReview(input,{fetchImpl}),/existing_protected_credential/);
 assert.equal((await protectedContentReview(input,{token:'synthetic-test-credential',fetchImpl})).verdict,'published');
 assert.equal(calls.length,2);assert.equal(calls[1].batch.length,3);assert.equal(f.rows()[0].product_status,'queued');assert.equal(f.stage(),'posted');
});

test('background discovery queues unverified links without creating a Direct alarm',async()=>{
 const f=fixture();f.message('alice');const result=await captureDmLinks(f.env,{signalAlarms:false});assert.equal(result.added,1);assert.equal(f.rows()[0].product_status,'queued');
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM crm_sync_state WHERE key LIKE 'diana_round_alarm:%'").get().n,0);
 assert.equal((await captureDmLinks(f.env,{signalAlarms:false})).added,0);
});
