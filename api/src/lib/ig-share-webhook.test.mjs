import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { validSignature, extractShares, saveShares, applyShares } from './ig-share-webhook.mjs';

function db() {
  const s = new DatabaseSync(':memory:');
  s.exec(`CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER);
    CREATE TABLE ugc_ig_messages(id TEXT PRIMARY KEY, text TEXT);`);
  return { s, prepare(sql) { let v = []; return { bind(...a) { v = a; return this; },
    async first() { return s.prepare(sql).get(...v) ?? null; },
    async run() { return { meta: { changes: Number(s.prepare(sql).run(...v).changes) } }; } }; } };
}
const reel = { object: 'instagram', entry: [{ id: '17841466350261166', time: 1, messaging: [
  { sender: { id: '111' }, recipient: { id: '17841466350261166' }, timestamp: 1762852380000,
    message: { mid: 'mid-reel', attachments: [{ type: 'ig_reel', payload: { url: 'https://www.instagram.com/reel/Dfg9gBMIZaL/', title: 'Гигиена = легальный повод', reel_video_id: '999' } }] } },
  { sender: { id: '17841466350261166' }, recipient: { id: '111' }, timestamp: 1,
    message: { mid: 'mid-echo', is_echo: true, attachments: [{ type: 'ig_reel', payload: { url: 'https://www.instagram.com/reel/X/' } }] } },
  { sender: { id: '111' }, recipient: { id: '1' }, timestamp: 2, message: { mid: 'mid-img', attachments: [{ type: 'image', payload: { url: 'https://cdn.example/a.jpg' } }] } },
]}]};

test('only DasWA-signed deliveries are accepted', async () => {
  const body = JSON.stringify(reel), secret = 'test-secret';
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(await validSignature(body, sig, secret), true);
  assert.equal(await validSignature(body + ' ', sig, secret), false);
  assert.equal(await validSignature(body, sig, 'other'), false);
  assert.equal(await validSignature(body, '', secret), false);
});

test('a forwarded reel yields its exact link; echoes and plain images do not', () => {
  const shares = extractShares(reel);
  assert.equal(shares.length, 1);
  assert.deepEqual({ mid: shares[0].mid, type: shares[0].type, url: shares[0].url, media_id: shares[0].media_id },
    { mid: 'mid-reel', type: 'ig_reel', url: 'https://www.instagram.com/reel/Dfg9gBMIZaL/', media_id: '999' });
  assert.deepEqual(extractShares({ entry: [{ messaging: [{ message: { mid: 'x', attachments: [{ type: 'ig_post', payload: { url: 'javascript:alert(1)' } }] } }] }] }), []);
});

test('the empty polled message gets the forwarded link, so Diana sees the reel itself', async () => {
  const d = db();
  d.s.prepare('INSERT INTO ugc_ig_messages VALUES(?,?)').run('mid-reel', '');
  await saveShares(d, extractShares(reel));
  assert.equal(d.s.prepare('SELECT text FROM ugc_ig_messages WHERE id=?').get('mid-reel').text, 'https://www.instagram.com/reel/Dfg9gBMIZaL/');
  const messages = [{ id: 'mid-text', message: 'Добрый день' }, { id: 'mid-reel', message: '', is_unsupported: true }, { id: 'mid-none', is_unsupported: true }];
  assert.equal(await applyShares(d, messages), 1);
  assert.equal(messages[1].message, 'https://www.instagram.com/reel/Dfg9gBMIZaL/');
  assert.equal(messages[1].is_unsupported, false);
  assert.equal(messages[1].forwarded.type, 'ig_reel');
  assert.equal(messages[2].is_unsupported, true); // no webhook record: unchanged, nothing guessed
  assert.equal(messages[0].message, 'Добрый день');
});
