import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {instagramProfileFallback,instagramPostFallback,parseApifyProfile,parseApifyPost,yerevanBudgetDay} from './ugc-apify.mjs';
function database(){
 const s=new DatabaseSync(':memory:');s.exec('CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER)');
 return {s,prepare(sql){let values=[];return {bind(...v){values=v;return this},async first(){return s.prepare(sql).get(...values)||null},async run(){return {meta:{changes:Number(s.prepare(sql).run(...values).changes)}}}}}};
}
const profile={username:'katy',followersCount:500,postsCount:0};
const post={shortCode:'Example',ownerUsername:'katy',likesCount:0,commentsCount:-1,videoViewCount:20};
const url='https://www.instagram.com/reel/Example/';
async function fixture(fn,options={}){
 const DB=database(),env={DB,APIFY_TOKEN:'test-only',APIFY_DAILY_BUDGET_USD:options.budget||'1'};let starts=0,gets=0;
 const original=globalThis.fetch;
 globalThis.fetch=async(u,init)=>{
  assert.equal(init.headers.Authorization,'Bearer test-only');assert.equal(new URL(u).searchParams.has('token'),false);
  if(init.method==='POST'){
   starts++;assert.equal(new URL(u).searchParams.get('maxTotalChargeUsd'),'0.01');
   const input=JSON.parse(init.body);assert.equal((input.usernames||input.directUrls).length,1);
   if(options.uncertain)throw Error('socket lost');
   return Response.json({data:{id:'run'+starts}});
  }
  if(u.includes('/actor-runs/')){gets++;return Response.json({data:{status:options.pending?'RUNNING':'SUCCEEDED',defaultDatasetId:'dataset',finishedAt:new Date().toISOString()}})}
  return Response.json(options.items||[u.includes('never')?{}:profile,post]);
 };
 try{await fn(env,()=>({starts,gets}));}finally{globalThis.fetch=original;DB.s.close()}
}
test('identity checks and nullable counts preserve zero and reject unrelated records',()=>{
 assert.equal(parseApifyProfile([profile],'other'),null);
 assert.equal(parseApifyProfile([profile,profile],'katy'),null);
 assert.equal(parseApifyProfile([profile],'KATY').posts,0);
 assert.equal(parseApifyPost([post],url).likes,0);assert.equal(parseApifyPost([post],url).comments,null);
 assert.equal(parseApifyPost([{...post,url:'https://www.instagram.com/reel/Other/'}],url),null);
 assert.equal(parseApifyPost([post],url.replace('www.instagram.com','evil.test')),null);
});
test('ER requires six dated complete interactions and positive matching denominator',()=>{
 const posts=Array.from({length:6},(_,i)=>({timestamp:`2026-11-0${i+1}T00:00:00Z`,likesCount:10,commentsCount:0}));
 assert.equal(parseApifyProfile([{...profile,latestPosts:posts}],'katy').er,2);
 assert.equal(parseApifyProfile([{...profile,latestPosts:posts.slice(1)}],'katy').er,null);
});
test('profile and post share atomic cap; cached results cause no extra starts',async()=>fixture(async(env,stats)=>{
 assert.equal((await instagramProfileFallback(env,{handle:'katy'})).status,'ok');
 assert.equal((await instagramProfileFallback(env,{handle:'katy'})).status,'ok');
 assert.equal((await instagramPostFallback(env,{url})).status,'budget_exhausted');
 assert.equal(stats().starts,1);
}, {budget:'0.01'}));
test('concurrent requests cannot overspend or duplicate one target',async()=>fixture(async(env,stats)=>{
 await Promise.all([instagramProfileFallback(env,{handle:'katy'}),instagramProfileFallback(env,{handle:'katy'}),instagramPostFallback(env,{url})]);
 assert.equal(stats().starts,1);
}, {budget:'0.01'}));
test('uncertain POST remains journaled and never automatically creates another charged run',async()=>fixture(async(env,stats)=>{
 assert.equal((await instagramProfileFallback(env,{handle:'katy'})).status,'unknown');
 assert.equal((await instagramProfileFallback(env,{handle:'katy'})).status,'unknown');
 assert.equal(stats().starts,1);
}, {uncertain:true}));
test('in progress run is resumed through its saved ID without POST',async()=>fixture(async(env,stats)=>{
 assert.equal((await instagramProfileFallback(env,{handle:'katy'})).status,'pending');
 assert.equal((await instagramProfileFallback(env,{handle:'katy'})).status,'pending');
 assert.deepEqual(stats(),{starts:1,gets:2});
}, {pending:true}));
test('empty result remains unknown rather than deleted or a zero metric',async()=>fixture(async(env)=>{
 const r=await instagramProfileFallback(env,{handle:'katy'});assert.equal(r.status,'unknown');assert.equal(r.followers,undefined);
},{items:[]}));
test('daily key resets at Yerevan midnight',()=>{
 assert.equal(yerevanBudgetDay(Date.parse('2026-11-08T19:59:59Z')),'2026-11-08');
 assert.equal(yerevanBudgetDay(Date.parse('2026-11-08T20:00:00Z')),'2026-11-09');
});

test('a start cut off mid-call blocks for six hours, then retries once',async()=>fixture(async(env,calls)=>{
 const key='ugc-apify:post:Example';
 env.DB.s.prepare('INSERT INTO crm_sync_state VALUES(?,?,?)').run(key,JSON.stringify({phase:'starting',at:Date.now()-3_600_000}),0);
 assert.equal((await instagramPostFallback(env,{url})).status,'unknown');assert.equal(calls().starts,0);
 env.DB.s.prepare('UPDATE crm_sync_state SET value=? WHERE key=?').run(JSON.stringify({phase:'ambiguous',at:Date.now()-7*3_600_000}),key);
 const r=await instagramPostFallback(env,{url});
 assert.equal(r.status,'ok');assert.equal(r.views,20);assert.equal(calls().starts,1);
}));
