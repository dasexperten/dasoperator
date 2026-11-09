import test from 'node:test';
import assert from 'node:assert/strict';
import { reelPublicationProof, reelTaskText, appendPublicationProofs } from './ugc-reel-jobs.mjs';
const proof = { platform: 'instagram', url: 'https://www.instagram.com/reel/NEW123/', account: 'dasexperten', verified: true, verified_at: new Date().toISOString(), evidence: 'Opened the new publication: account, video and author credit checked' };
test('green proof requires a real post address and a recorded verification, never a profile or source', () => {
  assert.equal(reelPublicationProof([], ''), null);
  assert.equal(reelPublicationProof([{ ...proof, verified: false }], ''), null);
  assert.equal(reelPublicationProof([{ ...proof, evidence: '' }], ''), null);
  assert.equal(reelPublicationProof([{ ...proof, url: 'https://instagram.com/dasexperten/' }], ''), null);
  assert.equal(reelPublicationProof([{ ...proof, url: 'https://instagram.com.evil/reel/NEW123' }], ''), null);
  assert.equal(reelPublicationProof([proof], 'https://instagram.com/reel/NEW123'), null);
  assert.equal(reelPublicationProof([proof], 'https://instagram.com/p/NEW123/?igsh=x'), null);
  assert.equal(reelPublicationProof([proof], 'https://instagram.com/reel/ORIGINAL')[0].url, 'https://www.instagram.com/reel/NEW123/');
});
test('Threads and VK proofs accept concrete post/video links and reject lookalikes', () => {
  for (const [platform,url] of [['threads','https://www.threads.com/@dasexperten/post/abc123'], ['vk','https://vk.com/clip-123_456']]) {
    assert.ok(reelPublicationProof([{ ...proof,platform,url }], 'https://instagram.com/reel/SOURCE'));
  }
  assert.equal(reelPublicationProof([{...proof,platform:'vk',url:'https://vk.com/dasexperten'}], ''),null);
});
test('task states exact Owner scope and real worker callbacks without a raw credential', () => {
  const text = reelTaskText({content_id:'id/1',content_url:'https://instagram.com/reel/ABC/',handle:'author',claim_id:'claim-exact',required_destinations:['instagram','threads','vk','youtube','tiktok']},'https://erp.test');
  assert.match(text,/РОВНО ОДИН/);
  assert.match(text,/reel-jobs\/id%2F1\/complete/);
  assert.match(text,/claim-exact/);
  assert.match(text,/Юридическую маркировку/);
  assert.match(text,/Марикой/);
  assert.match(text,/EMAILER_SERVICE_SECRET/);
  assert.match(text,/ugc-videos\/originals/);
  assert.match(text,/no editorial cuts or automatic translation/);
  assert.match(text,/HeyGen/);
  assert.doesNotMatch(text,/POST .*\/claim /);
});

test('YouTube concrete URLs retain video identity and TikTok requires the matching account', () => {
  const base={...proof,platform:'youtube',account:'UCJ1YJScbvNVrwVJW2tPApGQ'};
  for(const url of ['https://www.youtube.com/watch?v=AbC123def_0&feature=share','https://youtube.com/shorts/AbC123def_0','https://youtu.be/AbC123def_0']) assert.ok(reelPublicationProof([{...base,url}],''));
  assert.equal(reelPublicationProof([{...base,url:'https://youtube.com/watch?v=AbC123def_0&feature=share'}],'')[0].url,'https://youtube.com/watch?v=AbC123def_0');
  assert.equal(reelPublicationProof([{...base,url:'https://youtube.com/watch?v=AbC123def_0'}],'https://youtu.be/AbC123def_0'),null);
  assert.equal(reelPublicationProof([{...base,url:'https://youtube.com/@dasexperten'}],''),null);
  const tiktok={...proof,platform:'tiktok',account:'dasbroadcast',url:'https://www.tiktok.com/@dasbroadcast/video/1234567890123456789'};
  assert.ok(reelPublicationProof([tiktok],''));assert.equal(reelPublicationProof([{...tiktok,account:'different'}],''),null);
});
test('append preserves original proofs and deduplicates equivalent YouTube URLs', () => {
  const old={...proof,platform:'youtube',url:'https://www.youtube.com/watch?v=AbC123def_0',account:'channel'};
  const incoming={...old,url:'https://youtu.be/AbC123def_0',evidence:'newer check'};
  const merged=appendPublicationProofs([old],[incoming,proof]);assert.equal(merged.length,2);assert.deepEqual(merged[0],old);
});

test('current vk.ru clip links are accepted and alias retries preserve the original proof',()=>{
  const vk={...proof,platform:'vk',url:'https://vk.ru/clip-229095983_456240567',account:'dasexperten'};
  assert.ok(reelPublicationProof([vk],''));
  assert.equal(reelPublicationProof([vk],'https://vk.com/clip-229095983_456240567'),null);
  assert.equal(appendPublicationProofs([vk],[{...vk,url:'https://vk.com/clip-229095983_456240567'}]).length,1);
});

test('active scope preserves raw history and rejects unknown destinations',async()=>{
 const {reelScope}=await import('./ugc-reel-jobs.mjs');const original=['instagram','threads','vk','youtube','tiktok'];const row={required_destinations:JSON.stringify(original)};assert.deepEqual(reelScope(row).active,original);assert.deepEqual(reelScope(row).deferred,[]);assert.equal(row.required_destinations,JSON.stringify(original));assert.throws(()=>reelScope({required_destinations:'["linkedin"]'}));assert.deepEqual(reelScope({required_destinations:'["vk","tiktok"]'}).active,['vk','tiktok']);
});
test('source publication is accepted only with explicit verified own accepted-coauth identity',()=>{
 const p={platform:'instagram',url:'https://instagram.com/reel/SOURCE/',account:'dasexperten',verified:true,verified_at:new Date().toISOString(),evidence:'Official accepted collaborative_media exact source, complete pagination'};
 assert.equal(reelPublicationProof([p],p.url),null);
 const accepted={...p,instagram_placement:'accepted_coauth',instagram_media_id:'17911111111111111',instagram_collaborator_account_id:'17841466350261166'};
 assert.equal(reelPublicationProof([accepted],p.url)?.[0].instagram_placement,'accepted_coauth');
 assert.equal(reelPublicationProof([{...accepted,instagram_collaborator_account_id:'wrong'}],p.url),null);
});

test('Facebook and Rutube proofs require concrete public videos and preserve media identity',()=>{
 const facebook={...proof,platform:'facebook',url:'https://www.facebook.com/reel/1444100564600075/',account:'1697038263872226'};
 const rutube={...proof,platform:'rutube',url:'https://rutube.ru/video/0123456789abcdef0123456789abcdef/',account:'channel'};
 assert.ok(reelPublicationProof([facebook,rutube],'https://t.me/source/123'));
 assert.equal(reelPublicationProof([{...facebook,url:'https://facebook.com/dasexperten'}],''),null);
 assert.equal(reelPublicationProof([{...rutube,url:'https://rutube.ru/channel/123'}],''),null);
 assert.equal(reelPublicationProof([{...rutube,url:rutube.url.replace('rutube.ru','rutube.ru.evil')}],''),null);
 assert.equal(reelPublicationProof([facebook],'https://facebook.com/1697038263872226/videos/1444100564600075/'),null);
 assert.equal(reelPublicationProof([rutube],rutube.url.replace('/video/','/shorts/')),null);
 assert.equal(appendPublicationProofs([facebook],[{...facebook,url:'https://facebook.com/1697038263872226/videos/1444100564600075/'}]).length,1);
});

test('two product outputs across seven platforms are not truncated by the old twelve-proof ceiling',()=>{
 const platforms=[['instagram',i=>`https://instagram.com/reel/OUT${i}/`],['threads',i=>`https://threads.com/@dasexperten/post/OUT${i}`],['youtube',i=>`https://youtube.com/watch?v=AbC123def_${i}`],['vk',i=>`https://vk.com/clip-123_${456+i}`],['facebook',i=>`https://facebook.com/reel/${1444100564600070+i}/`],['rutube',i=>`https://rutube.ru/video/0123456789abcdef0123456789abcde${i}/`],['tiktok',i=>`https://tiktok.com/@dasexperten/video/123456789012345678${i}`]];
 const outputs=[0,1].flatMap(i=>platforms.map(([platform,url])=>({...proof,platform,url:url(i),account:'dasexperten'})));
 assert.equal(reelPublicationProof(outputs,'https://t.me/source/123')?.length,14);
});


test('new jobs require the full seven-account API round while old saved scopes remain exact',async()=>{
 const {reelScope,ACTIVE_REEL_DESTINATIONS}=await import('./ugc-reel-jobs.mjs');
 assert.deepEqual(ACTIVE_REEL_DESTINATIONS,['instagram','threads','youtube','facebook','vk','rutube','tiktok']);
 const scope=reelScope({});assert.deepEqual(scope.active,[...ACTIVE_REEL_DESTINATIONS]);assert.equal(scope.accounts.rutube_channel_id,'59945486');assert.equal(scope.accounts.tiktok,'dasbroadcast');assert.equal(scope.publication_transport,'api');assert.equal(scope.tiktok_publisher,'Das Experten UGC Publisher');assert.deepEqual(scope.deferred,[]);
 assert.deepEqual(reelScope({required_destinations:'["youtube"]'}).active,['youtube']);
 const text=reelTaskText({content_id:'rutube-new',content_url:'https://youtube.com/watch?v=AbC123def_0',claim_id:'private-placeholder',handle:'author'},'https://erp.test');
 assert.match(text,/jobs\/diter-rutube-upload\/runner.py/);assert.match(text,/59945486/);assert.match(text,/Das Experten UGC Publisher/);assert.match(text,/полный раунд не завершать/);assert.match(text,/модерация не равны публичной/);
});

test('assignment includes verified identity, canonical keyword provenance and ERP plan before provider intent',()=>{
 const text=reelTaskText({content_id:'caption-source',claim_id:'plan-test-claim',content_url:'https://youtube.com/watch?v=abc',handle:'actual_creator',required_destinations:['facebook']},'https://erp.test');
 for(const value of ['product_keyword_pools.source_ref','body_keyword_realizations','source SHA256','missing_pool','editorial priorities','39°C measurement','/reel-jobs/caption-source/caption-plan','verified_products','Jurgen','required_search_tokens_enabled','required_search_token_evidence','#termo','не увеличивает утверждённые platform counts']) assert.ok(text.includes(value),value);
 assert.match(text,/не переноси имя Юлия/);assert.match(text,/без ручного approval gate/);
});
