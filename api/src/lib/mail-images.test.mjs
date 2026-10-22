import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardMailImages, AGENT_AVATAR_BASE } from './mail-images.mjs';

function fakeFetch(map) {
  return async (url) => {
    const r = map[url] || { status: 404, type: 'text/html' };
    return { status: r.status, headers: new Headers({ 'content-type': r.type }), body: null };
  };
}

const denis = '<p>С уважением,</p><table><tr><td style="padding-right:12px"><img src="https://www.dasexperten.com/assets/agents/denis-vasilevski.png" width="48" height="48" alt="Денис"></td><td><strong>Денис Василевский</strong></td></tr></table>';

test('legacy www portrait moves to the live store and stays when it opens', async () => {
  const live = `${AGENT_AVATAR_BASE}/denis-vasilevski.png`;
  const { html, removed } = await guardMailImages(denis, fakeFetch({ [live]: { status: 200, type: 'image/png' } }));
  assert.ok(html.includes(live));
  assert.ok(!html.includes('www.dasexperten.com'));
  assert.deepEqual(removed, []);
});

test('a portrait that does not open is removed with its cell; the text signature stays', async () => {
  const { html, removed } = await guardMailImages(denis, fakeFetch({}));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('padding-right'));
  assert.ok(html.includes('<td><strong>Денис Василевский</strong></td>'));
  assert.equal(removed.length, 1);
});

test('webp is broken for Outlook and is removed', async () => {
  const src = 'https://example.com/a.webp';
  const { html } = await guardMailImages(`<p>x</p><img src="${src}">`, fakeFetch({ [src]: { status: 200, type: 'image/webp' } }));
  assert.equal(html, '<p>x</p>');
});

test('inline data and cid images are left alone; plain text is untouched', async () => {
  const inl = '<img src="cid:logo1"><img src="data:image/png;base64,AAAA">';
  assert.equal((await guardMailImages(inl, fakeFetch({}))).html, inl);
  assert.equal((await guardMailImages('<p>no pictures</p>', fakeFetch({}))).html, '<p>no pictures</p>');
});
