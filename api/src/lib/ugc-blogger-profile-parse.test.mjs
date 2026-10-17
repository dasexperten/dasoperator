import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInstagramProfile, isInstagramAvatarUrl } from './ugc-blogger-profile-parse.mjs';

test('profile metadata supplies counts and the real avatar with either attribute order', () => {
  assert.deepEqual(parseInstagramProfile('<meta content="9,361 Followers, 1,501 Following, 672 Posts - Zalinka" property="og:description"><meta property="og:image" content="https://scontent.cdninstagram.com/avatar.jpg?a=1&amp;b=2">'), { followers: 9361, posts: 672, avatar: 'https://scontent.cdninstagram.com/avatar.jpg?a=1&b=2' });
  assert.equal(parseInstagramProfile('<meta name="description" content="12,5 тыс. подписчиков, 0 публикаций">').followers, 12500);
  assert.equal(parseInstagramProfile('<meta name="description" content="12,5 тыс. подписчиков, 0 публикаций">').posts, 0);
});

test('a login wall or generic logo supplies no invented measurements or photo', () => {
  assert.deepEqual(parseInstagramProfile('<meta property="og:image" content="https://www.instagram.com/static/logo.png"><p>Sign in</p>'), { followers: null, posts: null, avatar: null });
  for (const url of ['http://scontent.fbcdn.net/a', 'https://fbcdn.net.attacker.test/a', 'https://127.0.0.1/a', 'https://user:pass@scontent.fbcdn.net/a']) assert.equal(isInstagramAvatarUrl(url), false);
});
