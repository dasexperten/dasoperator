// node --test api/src/lib/ugc-rename-parse.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { instagramPostCode, parsePostOwner, decideRename } from './ugc-rename-parse.mjs';

test('post code from post, reel and profile-scoped links', () => {
  assert.equal(instagramPostCode('https://www.instagram.com/p/DV4qg6pirbS/?hl=ru'), 'DV4qg6pirbS');
  assert.equal(instagramPostCode('https://instagram.com/reel/C1abcDEF/'), 'C1abcDEF');
  assert.equal(instagramPostCode('https://www.instagram.com/su.nnat891/reel/C1abcDEF/'), 'C1abcDEF');
  assert.equal(instagramPostCode('https://www.instagram.com/su.nnat891/'), null);
});

test('owner from the post description and from the owner block', () => {
  assert.equal(parsePostOwner('<meta property="og:description" content="13 likes, 9 comments - New.Name_1 on March 7, 2026: &quot;Das Experten&quot;">'), 'new.name_1');
  assert.equal(parsePostOwner('<meta name="description" content="anna.smile on April 7, 2026: text">'), 'anna.smile');
  assert.equal(parsePostOwner('x "owner":{"id":"1","username":"sveta.life"} y'), 'sveta.life');
  assert.equal(parsePostOwner('<html>login</html>'), null);
});

test('decision ladder', () => {
  assert.deepEqual(decideRename('su.nnat891', { graphUsername: 'sunnat.new' }).outcome, 'renamed');
  assert.equal(decideRename('su.nnat891', { postOwners: ['sunnat.new'] }).handle, 'sunnat.new');
  assert.equal(decideRename('su.nnat891', { postOwners: ['SU.NNAT891'] }).outcome, 'alive');
  assert.equal(decideRename('su.nnat891', { profileAlive: true }).outcome, 'alive');
  assert.equal(decideRename('su.nnat891', {}).outcome, 'gone');
});
