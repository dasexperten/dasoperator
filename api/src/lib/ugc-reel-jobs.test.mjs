import test from 'node:test';
import assert from 'node:assert/strict';
import { reelPublicationProof, reelTaskText } from './ugc-reel-jobs.mjs';
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
  const text = reelTaskText({content_id:'id/1',content_url:'https://instagram.com/reel/ABC/',handle:'author'},'https://erp.test');
  assert.match(text,/двойным кликом/);
  assert.match(text,/reel-jobs\/id%2F1\/claim/);
  assert.match(text,/EMAILER_SERVICE_SECRET/);
  assert.match(text,/минимальное|Минимальное/);
  assert.match(text,/HeyGen/);
  assert.ok(text.length < 4000, 'shell seat-call payload ceiling');
});
