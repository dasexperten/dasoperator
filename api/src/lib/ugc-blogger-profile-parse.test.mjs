import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInstagramProfile, isInstagramAvatarUrl } from './ugc-blogger-profile-parse.mjs';

test('profile metadata supplies counts and the real avatar with either attribute order', () => {
  assert.deepEqual(parseInstagramProfile('<meta content="9,361 Followers, 1,501 Following, 672 Posts - Zalinka" property="og:description"><meta property="og:image" content="https://scontent.cdninstagram.com/v/t51.2885-19/avatar.jpg?a=1&amp;b=2">'), { followers: 9361, posts: 672, avatar: 'https://scontent.cdninstagram.com/v/t51.2885-19/avatar.jpg?a=1&b=2' });
  assert.equal(parseInstagramProfile('<meta name="description" content="12,5 тыс. подписчиков, 0 публикаций">').followers, 12500);
  assert.equal(parseInstagramProfile('<meta name="description" content="12,5 тыс. подписчиков, 0 публикаций">').posts, 0);
});

test('CDN logos, post previews and the observed default silhouette are not avatars', () => {
  for (const url of ['https://static.cdninstagram.com/rsrc.php/v4/yR/r/logo.png', 'https://scontent.fbcdn.net/v/t51.2885-15/post.jpg', 'https://scontent.fbcdn.net/v/t51.89012-19/573323465_1219825463302212_7278921664109726296_n.jpg']) {
    assert.equal(isInstagramAvatarUrl(url), false);
    assert.equal(parseInstagramProfile(`<meta property="og:image" content="${url}">`).avatar, null);
  }
});

test('public metadata must identify the requested profile before any photo or metrics are accepted', () => {
  const photo = '<meta property="og:image" content="https://scontent.fbcdn.net/v/t51.2885-19/photo.jpg">';
  assert.equal(parseInstagramProfile(photo, 'anzhela.like').avatar, null);
  assert.equal(parseInstagramProfile('<meta property="og:url" content="https://www.instagram.com/someone.else/">'+photo, 'anzhela.like').avatar, null);
  assert.ok(parseInstagramProfile('<meta property="og:url" content="https://www.instagram.com/anzhela.like/">'+photo, 'anzhela.like').avatar);
  assert.ok(parseInstagramProfile('<meta property="og:title" content="Анжела (@anzhela.like) • Instagram">'+photo, 'anzhela.like').avatar);
});

test('a login wall or generic logo supplies no invented measurements or photo', () => {
  assert.deepEqual(parseInstagramProfile('<meta property="og:image" content="https://www.instagram.com/static/logo.png"><p>Sign in</p>'), { followers: null, posts: null, avatar: null });
  for (const url of ['http://scontent.fbcdn.net/a', 'https://fbcdn.net.attacker.test/a', 'https://127.0.0.1/a', 'https://user:pass@scontent.fbcdn.net/a']) assert.equal(isInstagramAvatarUrl(url), false);
});
