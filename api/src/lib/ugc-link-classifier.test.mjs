import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyUgcLink, isSafePublicHttpUrl } from './ugc-link-classifier.mjs';

test('classifies definitive missing and restricted responses', () => {
  assert.equal(classifyUgcLink(404, 'https://example.com/post'), 'missing');
  assert.equal(classifyUgcLink(410, 'https://example.com/post'), 'missing');
  assert.equal(classifyUgcLink(401, 'https://example.com/post'), 'restricted');
  assert.equal(classifyUgcLink(429, 'https://example.com/post'), 'restricted');
});

test('keeps server and ambiguous client failures unknown', () => {
  assert.equal(classifyUgcLink(503, 'https://example.com/post'), 'unknown');
  assert.equal(classifyUgcLink(400, 'https://example.com/post'), 'unknown');
  assert.equal(classifyUgcLink(0, 'https://example.com/post'), 'unknown');
});

test('detects clear login and challenge pages without marking ordinary HTML restricted', () => {
  assert.equal(classifyUgcLink(200, 'https://instagram.com/accounts/login/'), 'restricted');
  assert.equal(classifyUgcLink(200, 'https://example.com/post', 'Verify you are human'), 'restricted');
  assert.equal(classifyUgcLink(200, 'https://example.com/post', '<html>Public post</html>'), 'active');
});

test('keeps ambiguous 200 unavailable shells unknown', () => {
  assert.equal(classifyUgcLink(200, 'https://www.youtube.com/watch?v=x', 'This video is unavailable'), 'unknown');
});

test('only permits public-looking HTTP URLs', () => {
  assert.equal(isSafePublicHttpUrl('https://www.instagram.com/reel/abc/'), true);
  assert.equal(isSafePublicHttpUrl('javascript:alert(1)'), false);
  assert.equal(isSafePublicHttpUrl('http://127.0.0.1/admin'), false);
  assert.equal(isSafePublicHttpUrl('http://192.168.1.2/'), false);
  assert.equal(isSafePublicHttpUrl('not a url'), false);
});
