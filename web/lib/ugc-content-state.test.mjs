import test from 'node:test';
import assert from 'node:assert/strict';
import { contentState, publicationNetwork } from './ugc-content-state.mjs';

test('TikTok short links select the same platform mark as direct video links', () => {
  for (const href of [
    'https://vt.tiktok.com/ZSUYXTmQU/',
    'https://vm.tiktok.com/ZGda9Y7kE/',
    'https://www.tiktok.com/@creator/video/7555461682667998482',
    'https://www.tiktok.com/t/ZP8AUh6pY/',
  ]) {
    assert.equal(publicationNetwork(href), 'tiktok', href);
  }
});

test('TikTok-looking domains keep the generic link mark', () => {
  assert.equal(publicationNetwork('https://vt.tiktok.com.example.org/video/123'), '');
  assert.equal(publicationNetwork('https://example.org/?url=https://vt.tiktok.com/123'), '');
});

test('only a link that fails its check is grey; an unconfirmed working reel is live', () => {
  assert.equal(contentState({ product_status: 'queued', link_status: 'active' }), 'live');
  assert.equal(contentState({ product_status: null, link_status: null }), 'live');
  assert.equal(contentState({ product_status: 'identified', link_status: 'unknown' }), 'live');
  for (const link_status of ['missing', 'restricted', 'invalid']) assert.equal(contentState({ product_status: 'identified', link_status }), 'dead');
});
