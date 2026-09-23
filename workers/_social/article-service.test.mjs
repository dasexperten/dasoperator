import test from 'node:test';
import assert from 'node:assert/strict';
import { publish } from './article-service.mjs';
import { validatePayload } from './article-queue.mjs';

const article = { id:'silica', url:'https://www.dasexperten.com/blog/silica', author:'kobayashi' };
const preview = {
  title:'Silica', description:'What RDA measures', image:'https://www.dasexperten.com/assets/hero.jpg',
  verified:true, evidence:'live check',
};
const creative = {
  kind:'otto-infographic', source:'article-inline', image:'https://www.dasexperten.com/assets/plate-en.jpg', alt:'Two scales for one paste',
  acceptance:{by:'marika-nowicka',accepted:true,evidence:'accepted second pass'},
  verified:true, evidence:'live inline check',
};
const item = {language:'en',sourceId:'silica',summary:'Abrasivity has two scales.',link:article.url,preview,creative,approval:{by:'roberta-di-maria',approved:true,evidence:'editorial check'},intrigue:{passed:true,evidence:'specific supported hook'}};

test('creative requires actual Marika acceptance', () => {
  const bad = structuredClone(item);
  bad.creative.acceptance.accepted = false;
  assert.throws(() => validatePayload({main:bad}, article, ['main']), /Missing Marika acceptance/);
  assert.equal(validatePayload({main:item}, article, ['main']).main.creative.kind, 'otto-infographic');
});

test('accepted Otto creative publishes through Page photos with the article link in caption', async () => {
  const calls = [];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({url:String(url),init});
    const u = String(url);
    if (u.includes('/1697038263872226?fields=id,name,access_token')) return Response.json({id:'1697038263872226',access_token:'page-token'});
    if (u === article.url) return new Response(`<article><meta property="og:title" content="Silica"><meta property="og:description" content="What RDA measures"><meta property="og:image" content="${preview.image}"><meta property="og:url" content="${article.url}"><img src="/assets/plate-en.jpg"></article>`,{headers:{'content-type':'text/html'}});
    if (u === preview.image || u === creative.image) return new Response(null,{status:200,headers:{'content-type':'image/jpeg'}});
    if (u.endsWith('/1697038263872226/photos')) return Response.json({id:'photo-1',post_id:'1697038263872226_42'});
    if (u.includes('/1697038263872226_42?fields=id,permalink_url,is_published')) return Response.json({id:'1697038263872226_42',permalink_url:'https://www.facebook.com/1697038263872226/posts/42',is_published:true});
    throw new Error(`Unexpected fetch ${u}`);
  };
  try {
    const result = await publish({META_SYSTEM_USER_TOKEN:'system-token'},{...item,pageId:'1697038263872226'},{now:()=>Date.UTC(2026,8,23,12)});
    assert.equal(result.status,'published');
    assert.equal(result.postId,'1697038263872226_42');
    const photoCall = calls.find(c=>c.url.endsWith('/1697038263872226/photos'));
    assert.ok(photoCall);
    assert.equal(photoCall.init.body.get('url'),creative.image);
    assert.match(photoCall.init.body.get('caption'),new RegExp(`${article.url}$`));
  } finally { globalThis.fetch = oldFetch; }
});
