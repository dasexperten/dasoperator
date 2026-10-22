import { test } from 'node:test';
import assert from 'node:assert/strict';
import { guardMailImages, MAIL_LOGO_URL, AGENT_AVATAR_BASE } from './mail-images.mjs';

function fakeFetch(map) {
  return async (url) => {
    const r = map[url] || { status: 404, type: 'text/html' };
    return { status: r.status, headers: new Headers({ 'content-type': r.type }), body: null };
  };
}

const denis = '<p>С уважением,</p><img src="https://www.dasexperten.com/assets/agents/denis-vasilevski.png" width="48" height="48" alt="Денис">';

test('legacy www portrait moves to the live store and stays when it opens', async () => {
  const live = `${AGENT_AVATAR_BASE}/denis-vasilevski.png`;
  const { html, replaced } = await guardMailImages(denis, fakeFetch({ [live]: { status: 200, type: 'image/png' } }));
  assert.ok(html.includes(live));
  assert.ok(!html.includes('www.dasexperten.com'));
  assert.deepEqual(replaced, []);
});

test('a portrait that does not open becomes the logo, never an empty frame', async () => {
  const { html, replaced } = await guardMailImages(denis, fakeFetch({}));
  assert.ok(html.includes(MAIL_LOGO_URL));
  assert.ok(!html.includes('denis-vasilevski.png'));
  assert.equal(replaced.length, 1);
});

test('webp is broken for Outlook and is replaced', async () => {
  const src = 'https://example.com/a.webp';
  const { html } = await guardMailImages(`<img src="${src}">`, fakeFetch({ [src]: { status: 200, type: 'image/webp' } }));
  assert.ok(html.includes(MAIL_LOGO_URL));
});

test('inline data and cid images are left alone; plain text is untouched', async () => {
  const inl = '<img src="cid:logo1"><img src="data:image/png;base64,AAAA">';
  assert.equal((await guardMailImages(inl, fakeFetch({}))).html, inl);
  assert.equal((await guardMailImages('<p>no pictures</p>', fakeFetch({}))).html, '<p>no pictures</p>');
});
