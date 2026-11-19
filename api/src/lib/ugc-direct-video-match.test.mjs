import test from 'node:test';
import assert from 'node:assert/strict';
import {mp4Seconds,lengthVerdict,parseSame,compareVideos,matchDirectVideos,matchKey} from './ugc-direct-video-match.mjs';

// A minimal MP4 header: only the 'mvhd' box matters here.
function mp4(seconds,{version=0,scale=1000}={}){
  const b=new Uint8Array(version?64:48),v=new DataView(b.buffer);
  b.set([0x6d,0x76,0x68,0x64],8);b[12]=version;
  if(version){v.setUint32(32,scale);v.setUint32(40,Math.round(seconds*scale));}
  else{v.setUint32(24,scale);v.setUint32(28,Math.round(seconds*scale));}
  return b;
}
test('the length is read from the file itself',()=>{
  assert.equal(mp4Seconds(mp4(19.27)),19.27);
  assert.equal(mp4Seconds(mp4(31.09,{version:1,scale:600})),31.09);
  assert.equal(mp4Seconds(new Uint8Array(64)),null);
});
test('a different length is a different video, an unknown length decides nothing',()=>{
  assert.equal(lengthVerdict(3.37,31.09),'different_length'); // o__kseniaa: a 3-second cut of a 31-second reel
  assert.equal(lengthVerdict(19.27,19.34),null);
  assert.equal(lengthVerdict(null,30),null);
});
test('only a clear model answer is accepted',()=>{
  assert.deepEqual(parseSame('{"same":"identical","reason":"те же кадры"}'),{same:'identical',reason:'те же кадры'});
  assert.equal(parseSame('{"same":"maybe"}'),null);
  assert.equal(parseSame('nonsense'),null);
});
test('files of different length are never sent to the model',async()=>{
  const fetchImpl=async()=>{throw Error('must not be called');};
  const r=await compareVideos({apiKey:'k',sent:mp4(3.37),published:mp4(31.09),fetchImpl});
  assert.equal(r.same,'different_length');assert.equal(r.sent_seconds,3.37);assert.equal(r.published_seconds,31.09);
});

function fakeEnv(pairs){
  const marks=new Map(),updates=[];
  const DB={prepare(sql){return {bind(...a){return {
    all:async()=>({results:pairs.map(p=>({...p,mark:marks.get(matchKey(p.sent_id,p.published_id))??null}))}),
    run:async()=>{if(sql.startsWith('INSERT INTO crm_sync_state'))marks.set(a[0],a[1]);else if(sql.startsWith('UPDATE ugc_content'))updates.push(a);return {meta:{changes:1}};},
  };}};}};
  const DOCS={get:async key=>key.includes('nofile')?null:{arrayBuffer:async()=>mp4(20).buffer}};
  return {env:{DB,DOCS,GEMINI_API_KEY:'k'},marks,updates};
}
const video=()=>new Response(mp4(20),{headers:{'content-length':'48'}});
const read=async()=>({status:'ok',videoUrl:'https://scontent.cdninstagram.com/v/x.mp4'});
test('an identical pair links the sent file to the publication; anything else only closes the pair',async()=>{
  const pairs=[{sent_id:'ugcc_dv_a',published_id:'r1',url:'https://www.instagram.com/reel/AAAAAA/'},{sent_id:'ugcc_dv_a',published_id:'r2',url:'https://www.instagram.com/reel/BBBBBB/'},
    {sent_id:'ugcc_dv_b',published_id:'r3',url:'https://www.instagram.com/reel/CCCCCC/'},{sent_id:'ugcc_dv_nofile',published_id:'r4',url:'https://www.instagram.com/reel/DDDDDD/'}];
  const {env,marks,updates}=fakeEnv(pairs);
  const compare=async()=>({same:updates.length?'part':'identical',reason:'x',sent_seconds:20,published_seconds:20});
  const totals=await matchDirectVideos(env,{read,compare,fetchImpl:async()=>video()});
  assert.deepEqual(totals,{selected:4,identical:1,other:2,retry:0});
  assert.deepEqual(updates.map(u=>[u[0],u[1]]),[['ugcc_dv_a','r1']]); // r2 is not compared once r1 matched
  assert.equal(marks.has(matchKey('ugcc_dv_a','r2')),false);
  assert.equal(JSON.parse(marks.get(matchKey('ugcc_dv_b','r3'))).same,'part');
  assert.equal(JSON.parse(marks.get(matchKey('ugcc_dv_nofile','r4'))).same,'no_file');
});
test('a failed download or an unfinished reading is tried again, never taken for an answer',async()=>{
  const pairs=[{sent_id:'ugcc_dv_a',published_id:'r1',url:'https://www.instagram.com/reel/AAAAAA/'}];
  const {env,marks,updates}=fakeEnv(pairs);
  let totals=await matchDirectVideos(env,{read,compare:async()=>{throw Error('no');},fetchImpl:async()=>new Response('',{status:403})});
  assert.deepEqual(totals,{selected:1,identical:0,other:0,retry:1});
  totals=await matchDirectVideos(env,{read:async()=>({status:'pending'}),fetchImpl:async()=>video()});
  const mark=JSON.parse(marks.get(matchKey('ugcc_dv_a','r1')));
  assert.equal(mark.final,0);assert.equal(mark.tries,2);assert.equal(updates.length,0);
});
test('a video from an unknown host is not downloaded',async()=>{
  const {env,marks}=fakeEnv([{sent_id:'ugcc_dv_a',published_id:'r1',url:'https://www.instagram.com/reel/AAAAAA/'}]);
  const totals=await matchDirectVideos(env,{read:async()=>({status:'ok',videoUrl:'https://evil.example/x.mp4'}),fetchImpl:async()=>{throw Error('must not be called');}});
  assert.equal(totals.retry,1);assert.equal(JSON.parse(marks.get(matchKey('ugcc_dv_a','r1'))).error,'untrusted_host');
});
