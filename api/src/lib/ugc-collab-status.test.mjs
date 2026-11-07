import test from 'node:test';
import assert from 'node:assert/strict';
import { decideCollab, postCode, codeOrder } from './ugc-collab-status.mjs';

test('post code from reel and post links', () => {
  assert.equal(postCode('https://www.instagram.com/reel/DfS87avtNw0/'), 'DfS87avtNw0');
  assert.equal(postCode('https://instagram.com/name/p/DL2PSEKMhhD/?igsh=1'), 'DL2PSEKMhhD');
  assert.equal(postCode('https://youtube.com/shorts/x'), null);
});

test('newer shortcode orders higher', () => {
  assert.ok(codeOrder('DfS87avtNw0') > codeOrder('DL2PSEKMhhD'));
});

test('confirmed by link, requested on the newest unconfirmed posts per open invite', () => {
  const rows = [
    { id: 'a', handle: 'alina', content_url: 'https://www.instagram.com/reel/DW09e7kiCMk/' },
    { id: 'b', handle: 'alina', content_url: 'https://www.instagram.com/reel/DfS87avtNw0/' },
    { id: 'c', handle: 'alina', content_url: 'https://www.instagram.com/reel/DL2PSEKMhhD/' },
    { id: 'd', handle: 'other', content_url: 'https://www.instagram.com/reel/DMsGoqetD02/' },
  ];
  const out = decideCollab(rows, new Set(['DW09e7kiCMk']), new Map([['alina', 1]]));
  assert.equal(out.get('a'), 'confirmed');
  assert.equal(out.get('b'), 'requested');
  assert.equal(out.get('c'), null);
  assert.equal(out.get('d'), null);
});
