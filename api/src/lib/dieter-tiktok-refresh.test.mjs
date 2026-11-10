import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshDieterTikTok} from './dieter-tiktok-refresh.mjs';
const now=Date.parse('2026-11-11T20:00:00Z');
const fixtureCard=(expires='2026-11-11T21:00:00Z')=>`TIKTOK_BUSINESS_APP_ID=7706160588917342228\nTIKTOK_BUSINESS_USERNAME=dasbroadcast\nTIKTOK_BUSINESS_APP_SECRET=fixture-secret\nTIKTOK_BUSINESS_OPEN_ID=fixture-id\nTIKTOK_BUSINESS_ACCESS_TOKEN=old-access\nTIKTOK_BUSINESS_REFRESH_TOKEN=old-refresh\nTIKTOK_BUSINESS_SCOPE=video.upload,video.publish,video.list\nTIKTOK_BUSINESS_ACCESS_TOKEN_EXPIRES_AT=${expires}\nTIKTOK_BUSINESS_REFRESH_TOKEN_EXPIRES_AT=2027-11-11T20:00:00Z\n`;
function fixture(options={}){
 let state=null,posts=0,failMirror=!!options.failMirror;
 const master='dasexperten/das-architektura',mirror='dasexperten/organizacia';
 const cards={[master]:fixtureCard(options.expires),[mirror]:fixtureCard(options.expires)};
 const db={prepare(sql){let b=[];return {bind(...v){b=v;return this;},async first(){return state?{value:state}:null;},async run(){if(sql.startsWith('INSERT')){if(state)return {meta:{changes:0}};state=b[1];return {meta:{changes:1}};}if(state!==b[3])return {meta:{changes:0}};state=b[0];return {meta:{changes:1}};}}}};
 const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
 const fetchImpl=async(url,init={})=>{
  if(url.includes('business-api.tiktok.com')){posts++;if(options.unknown)throw new Error('timeout');return json({code:0,data:{access_token:'new-access',refresh_token:options.sameRefresh?'old-refresh':'new-refresh',open_id:'fixture-id',expires_in:86400,refresh_token_expires_in:31536000,scope:'video.upload,video.publish,video.list',...options.providerData}});}
  const repo=url.includes(master)?master:mirror;
  if(url.includes('/contents/')){if(init.method==='PUT'){if(repo===mirror&&failMirror){failMirror=false;return json({},503);}cards[repo]=atob(JSON.parse(init.body).content);return json({});}return json({sha:'fixture-sha',content:btoa(cards[repo])});}
  return json({permissions:{push:true}});
 };
 return {env:{DB:db,GITHUB_TOKEN:'fixture'},fetchImpl,get posts(){return posts},cards,master,mirror};
}
const call=f=>refreshDieterTikTok(f.env,{fetchImpl:f.fetchImpl,now:()=>now});
test('valid grant does not refresh early',async()=>{const f=fixture({expires:'2026-11-12T20:00:00Z'});assert.equal((await call(f)).status,'not_due');assert.equal(f.posts,0);});
test('one rotation writes both vaults and does not repeat',async()=>{const f=fixture();assert.equal((await call(f)).status,'refreshed');assert.equal(f.cards[f.master],f.cards[f.mirror]);assert.match(f.cards[f.master],/ACCESS_TOKEN=new-access/);assert.equal((await call(f)).status,'not_due');assert.equal(f.posts,1);});
test('unknown provider outcome prevents repeated request',async()=>{const f=fixture({unknown:true});assert.equal((await call(f)).status,'outcome_unknown_no_retry');assert.equal((await call(f)).status,'outcome_unknown_no_retry');assert.equal(f.posts,1);});
test('mirror failure recovers from master without another refresh, including unchanged refresh token',async()=>{const f=fixture({failMirror:true,sameRefresh:true});assert.equal((await call(f)).status,'storage_unavailable');assert.notEqual(f.cards[f.master],f.cards[f.mirror]);assert.equal((await call(f)).status,'mirror_recovered');assert.equal(f.cards[f.master],f.cards[f.mirror]);assert.equal(f.posts,1);});
test('concurrent ticks make at most one provider request',async()=>{const f=fixture();await Promise.all([call(f),call(f)]);assert.equal(f.posts,1);});
for(const key of ['TIKTOK_BUSINESS_ACCESS_TOKEN','TIKTOK_BUSINESS_REFRESH_TOKEN','TIKTOK_BUSINESS_SCOPE','TIKTOK_BUSINESS_ACCESS_TOKEN_EXPIRES_AT','TIKTOK_BUSINESS_REFRESH_TOKEN_EXPIRES_AT']){
 for(const mode of ['missing','duplicate'])test(`${mode} ${key} never rotates`,async()=>{const f=fixture();for(const repo of [f.master,f.mirror]){let lines=f.cards[repo].split('\n');const line=lines.find(l=>l.startsWith(key+'='));lines=mode==='missing'?lines.filter(l=>!l.startsWith(key+'=')):[...lines,line];f.cards[repo]=lines.join('\n');}const result=await call(f);assert.notEqual(result.status,'refreshed');assert.equal(f.posts,0);});
}
test('invalid refresh expiry never rotates',async()=>{const f=fixture();for(const repo of [f.master,f.mirror])f.cards[repo]=f.cards[repo].replace(/TIKTOK_BUSINESS_REFRESH_TOKEN_EXPIRES_AT=.*/, 'TIKTOK_BUSINESS_REFRESH_TOKEN_EXPIRES_AT=invalid');assert.equal((await call(f)).status,'refresh_expired');assert.equal(f.posts,0);});

for(const [field,value] of [['access_token',{}],['refresh_token',['bad']],['access_token','bad\nline'],['refresh_token','bad\rline'],['scope',['video.upload','video.publish','video.list','bad\nline']],['scope','video.upload,video.publish,video.list\nbad']])test(`reject unsafe provider ${field}`,async()=>{const f=fixture({providerData:{[field]:value}});assert.equal((await call(f)).status,'outcome_unknown_no_retry');assert.equal((await call(f)).status,'outcome_unknown_no_retry');assert.equal(f.posts,1);assert.equal(f.cards[f.master],f.cards[f.mirror]);});
