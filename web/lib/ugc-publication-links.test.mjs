import test from 'node:test';
import assert from 'node:assert/strict';
import { contentHref, creatorPublicationLinks } from './ugc-publication-links.mjs';

test('all publications from every creator profile remain available beyond the first two', () => {
  const instagram = Array.from({ length: 4 }, (_, index) => ({ id: `ig${index}`, content_url: `https://www.instagram.com/reel/reel${index}/` }));
  const tiktok = { id: 'tt', content_url: 'https://www.tiktok.com/@creator/video/1234567890' };
  const result = creatorPublicationLinks([{ content: instagram }, { content: [tiktok, instagram[0]] }]);
  assert.deepEqual(result.map(({ item }) => item.id), ['ig0', 'ig1', 'ig2', 'ig3', 'tt']);
  assert.equal(result.at(-1).href, tiktok.content_url);
});

test('only navigable public HTTP links enter the carousel', () => {
  assert.equal(contentHref('javascript:alert(1)'), null);
  assert.equal(contentHref(null), null);
  assert.deepEqual(creatorPublicationLinks([{ content: [{ id: 'empty' }, { id: 'bad', content_url: 'not a URL' }] }]), []);
});
