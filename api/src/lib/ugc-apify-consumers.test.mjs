import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {stripTypeScriptTypes} from 'node:module';
import {refreshCadence,dueCadenceSql} from './ugc-refresh-cadence.mjs';
import {classifyUgcLink,isSafePublicHttpUrl} from './ugc-link-classifier.mjs';
function load(name,bindings,fn){
 const source=stripTypeScriptTypes(readFileSync(new URL(name,import.meta.url),'utf8')).replace(/^import .*;\n/gm,'').replace(/export /g,'');
 bindings={refreshCadence,dueCadenceSql,...bindings};
 return Function(...Object.keys(bindings),source+`;return ${fn};`)(...Object.values(bindings));
}
function db(rows){const writes=[],queries=[];return {writes,queries,prepare(sql){queries.push(sql);let args;return {bind(...v){args=v;return this},async first(){return {worker:'ok'}},async all(){return {results:rows}},async run(){writes.push({sql,args});return {success:true}}}},async batch(statements){for(const s of statements)await s.run()}}}
function profile(db,fallback,measure={followers:null,er:null},options={}){
 return load('./ugc-blogger-profiles.ts',{instagramProfileFallback:fallback,measureInstagram:async()=>measure,render:async()=>null,parseInstagramProfile:()=>({avatar:null}),isInstagramAvatarUrl:()=>false},'refreshBloggerProfiles')({DB:db},'p',1,options);
}
test('pending profile operation stays due and never rewrites good metrics',async()=>{
 const d=db([{id:'p',normalized_handle:'katy',igsid:null}]);const r=await profile(d,async()=>({status:'pending'}));assert.equal(r.apify_pending,1);assert.equal(d.writes.filter(x=>x.sql.includes('UPDATE ugc_creator_platforms')).length,0);
});
test('fallback fills missing fields but preserves primary followers and rejects mismatched ER',async()=>{
 const d=db([{id:'p',normalized_handle:'katy',igsid:null}]);await profile(d,async()=>({status:'ok',followers:500,posts:30,er:8,sample:6,avatar:null}),{followers:100,er:null});const w=d.writes.find(x=>x.sql.includes('UPDATE ugc_creator_platforms'));assert.equal(w.args[1],100);assert.equal(w.args[2],30);assert.equal(w.args[4],null);assert.match(w.sql,/followers=COALESCE/);
});
async function links(fallback,status=403){
 const d=db([{id:'c',content_url:'https://www.instagram.com/reel/ExampleCode/'}]);let calls=0;const original=globalThis.fetch;globalThis.fetch=async()=>new Response('blocked',{status});
 try{const f=load('./ugc-link-health.ts',{instagramPostFallback:async(...args)=>{calls++;return fallback(...args)},classifyUgcLink,isSafePublicHttpUrl},'runUgcLinkHealthBatch');return {d,r:await f({DB:d},1,'c'),calls}}finally{globalThis.fetch=original}
}
test('pending paid post keeps lightweight restriction due without saving terminal check',async()=>{const {d,r}=await links(async()=>({status:'pending'}));assert.equal(r.pending,1);assert.equal(r.checked,0);assert.equal(d.writes.length,0)});
test('unknown actor response cannot turn restriction into missing or active',async()=>{const {d}=await links(async()=>({status:'unknown'}));assert.equal(d.writes[0].args[0],'restricted')});
test('positive exact post result upgrades ambiguous check and carries provider observed date',async()=>{const {d}=await links(async()=>({status:'ok',url:'https://www.instagram.com/reel/ExampleCode/',observedAt:'2026-11-08T06:00:00Z'}));assert.equal(d.writes[0].args[0],'active');assert.equal(d.writes[0].args[1],'2026-11-08T06:00:00Z')});
test('definitive lightweight success and missing never launch paid fallback',async()=>{for(const status of [200,404]){const {calls}=await links(()=>{throw Error('unexpected paid fallback')},status);assert.equal(calls,0)}});

test('exhausted shared day budget keeps both consumers due for tomorrow',async()=>{const d=db([{id:'p',normalized_handle:'katy',igsid:null}]);const p=await profile(d,async()=>({status:'budget_exhausted'}));assert.equal(p.apify_pending,1);assert.equal(d.writes.filter(x=>x.sql.includes('UPDATE ugc_creator_platforms')).length,0);const {d:ld,r}=await links(async()=>({status:'budget_exhausted'}));assert.equal(r.pending,1);assert.equal(ld.writes.length,0)});

test('cached fallback carries observation dates rather than making old metrics fresh',async()=>{const d=db([{id:'p',normalized_handle:'katy',igsid:null}]);await profile(d,async()=>({status:'ok',observedAt:'2026-11-02T00:00:00Z',followers:500,posts:30,er:8,sample:6,avatar:null}));const w=d.writes.find(x=>x.sql.includes('UPDATE ugc_creator_platforms'));assert.equal(w.args[11],'2026-11-02T00:00:00Z');assert.equal(w.args[12],'2026-11-02T00:00:00Z');assert.notEqual(w.args[6],w.args[12]);});

test('avatar-only fallback never updates metric or attempt clocks',async()=>{const d=db([{id:'p',normalized_handle:'katy',igsid:null}]);await profile(d,async()=>({status:'ok',followers:500,posts:30,er:8,sample:6,avatar:null}),undefined,{avatarOnly:true});assert.equal(d.writes.filter(x=>x.sql.includes('UPDATE ugc_creator_platforms')).length,0)});

test('pending paid fallback saves valid primary observations while retaining due state',async()=>{const d=db([{id:'p',normalized_handle:'katy',igsid:null}]);await profile(d,async()=>({status:'budget_exhausted'}),{followers:100,er:null});const w=d.writes.find(x=>x.sql.includes('UPDATE ugc_creator_platforms'));assert.equal(w.args[1],100);assert.doesNotMatch(w.sql,/profile_attempted_at|profile_checked_at/)});

test('actual profile selector SQL uses campaign/contact age, not row or check updates',async()=>{
 const fake=db([]);await profile(fake,async()=>({status:'disabled'}));const query=fake.queries.find(x=>x.startsWith('WITH candidates'));
 const d=new DatabaseSync(':memory:');d.exec(`CREATE TABLE ugc_creators(id TEXT,archived_at TEXT); CREATE TABLE ugc_creator_platforms(id TEXT,creator_id TEXT,platform TEXT,normalized_handle TEXT,profile_attempted_at TEXT); CREATE TABLE ugc_collaborations(creator_id TEXT,last_contact_at TEXT,invited_at TEXT,accepted_at TEXT,sample_sent_at TEXT,published_at TEXT); CREATE TABLE ugc_ig_messages(direction TEXT,from_username TEXT,from_id TEXT,conversation_id TEXT,created_at TEXT); INSERT INTO ugc_creators VALUES('c',NULL); INSERT INTO ugc_creator_platforms VALUES('p','c','instagram','katy',datetime('now','-4 days')); INSERT INTO ugc_collaborations VALUES('c',datetime('now','-20 days'),NULL,NULL,NULL,NULL);`);
 assert.equal(d.prepare(query).all(null,20).length,1);d.exec("UPDATE ugc_creator_platforms SET profile_attempted_at=datetime('now','-2 days')");assert.equal(d.prepare(query).all(null,20).length,0);assert.equal(d.prepare(query).all('p',20).length,1);d.exec("INSERT INTO ugc_ig_messages VALUES('in','katy','123','conv',datetime('now','-1 day'))");assert.equal(d.prepare(query).all(null,20).length,1);d.close();
});
