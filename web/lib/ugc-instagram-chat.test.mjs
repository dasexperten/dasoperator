import test from 'node:test';
import assert from 'node:assert/strict';
import { instagramChatHref } from './ugc-instagram-chat.mjs';

test('status targets Instagram Direct, preferring Instagram over another network', () => {
  assert.equal(instagramChatHref([{ platform: 'tiktok', handle: 'someone_else' }, { platform: 'instagram', handle: '@zalina.alkhsv_obzor' }]), 'https://ig.me/m/zalina.alkhsv_obzor');
  assert.equal(instagramChatHref([{ platform: 'other', handle: 'legacy_blogger' }]), 'https://ig.me/m/legacy_blogger');
  assert.equal(instagramChatHref([{ platform: 'tiktok', handle: 'tiktok_only' }]), null);
  for (const handle of ['https://wrong.example/', '../inbox', '...', '', 'a'.repeat(31)]) assert.equal(instagramChatHref([{ platform: 'instagram', handle }]), null);
});
