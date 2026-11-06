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

test('only the latest five are selected across profiles, newest first', () => {
  const item = (day) => ({ id: `post${day}`, content_url: `https://example.org/${day}`, published_at: `2026-11-0${day}T10:00:00Z` });
  const result = creatorPublicationLinks([{ content: [item(1), item(7), item(3)] }, { content: [item(4), item(2), item(6), item(5)] }]);
  assert.deepEqual(result.map(({ item }) => item.id), ['post7', 'post6', 'post5', 'post4', 'post3']);
});

test('a publication without a date uses its recorded import time for ordering', () => {
  const result = creatorPublicationLinks([{ content: [
    { id: 'dated', content_url: 'https://example.org/dated', published_at: '2026-11-01T10:00:00Z' },
    { id: 'undated', content_url: 'https://example.org/undated', published_at: null, imported_at: Date.parse('2026-11-02T10:00:00Z') },
  ] }]);
  assert.deepEqual(result.map(({ item }) => item.id), ['undated', 'dated']);
  assert.equal(result[0].item.published_at, null);
});
