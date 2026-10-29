import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareDianaContext } from './diana-context.mjs';
import { checkDianaImages, summarizeImageChecks } from './diana-image-check.mjs';
import { normalizeJevImage } from './diana-image-normalize.mjs';
import { encode as encodePng } from 'fast-png';
import jpeg from 'jpeg-js';

const names = ['ugc-master', 'personizer', 'product-skill', 'benefit-gate', 'marketolog'];
function fixture() {
  const requests = [];
  let rejectSkill = false, rejectJev = false;
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, ...init });
    if (url.includes('/commits/')) return Response.json({ sha: 'a'.repeat(40) });
    if (url.includes('/git/trees/')) return Response.json({ tree: names.map(n => ({ path: `SKILLS/${n}/SKILL.md` })) });
    if (url.includes('index-skills.md')) return new Response(names.map(n => `| \`${n}\` | ${n} description | creator |`).join('\n'));
    if (url.includes('IMAGE_RULES.json')) return Response.json({ product: { name: 'TERMO' }, sellers: [] }, { headers: { 'content-type': 'text/plain' } });
    if (url.includes('/SKILLS/')) return rejectSkill ? new Response('', { status: 503 }) : new Response('COMPLETE SKILL BODY\n' + 'x'.repeat(9000) + '\nEND OF SKILL');
    if (url.includes('/contents/')) return new Response('# Source\n## ENTRY | current task\nComplete original entry.');
    if (url.includes('decisions')) {
      if (rejectJev) return new Response('', { status: 503 });
      const body = JSON.parse(init.body);
      return Response.json({ answers: Object.fromEntries(Object.keys(body.questions).map(k => [k, { noul: 0.8 }])) });
    }
    throw Error('Unexpected request');
  };
  return { requests, fetchImpl, options: { task: 'current task', githubToken: 'test', infer: async messages => { if(rejectJev) throw Error('subscription unavailable'); const {candidates}=JSON.parse(messages[1].content); return {text:JSON.stringify({scores:candidates.map(c=>({id:c.id,score:.8}))})}; }, fetchImpl },
    failSkill: () => { rejectSkill = true; }, failJev: () => { rejectJev = true; } };
}
test('Diana gets subscription-selected full skills and knowledge pinned to source commits', async () => {
  const f = fixture();
  const result = await prepareDianaContext(f.options);
  assert.equal(result.receipt.method, 'subscription');
  assert.deepEqual(result.receipt.skills, names);
  assert.equal(result.system.match(/END OF SKILL/g).length, 5);
  assert.equal(result.system.match(/Complete original entry/g).length, 6);
  assert.ok(f.requests.filter(r => r.url.includes('/contents/')).every(r => r.url.endsWith('?ref=' + 'a'.repeat(40))));
});
test('Subscription, credentials or skill failure blocks preparation; no lexical or embedded fallback', async () => {
  const a = fixture(); a.failJev(); await assert.rejects(prepareDianaContext(a.options), /subscription unavailable/);
  const b = fixture(); b.failSkill(); await assert.rejects(prepareDianaContext(b.options), /GitHub 503/);
  await assert.rejects(prepareDianaContext({ ...fixture().options, githubToken: '' }), /credentials/);
});
test('the image request actually sends bytes to JEV; seller unknown on a basket is fine (Owner 2026-10-18)', async () => {
  let request;
  const result = await checkDianaImages({ images: [{ mediaType: 'image/png', data: 'IMAGE_BYTES', label: 'latest' }], policy: { sellers: ['verified seller'] }, task: 'basket', apiKey: 'test', normalize: i => i,
    fetchImpl: async (_url, init) => { request = JSON.parse(init.body); return Response.json({ answers: { kind: { choice: 'basket' }, product: { choice: 'yes' }, seller: { choice: 'unknown' }, amount: { choice: 'yes' } } }); } });
  assert.equal(request.model, 'typesafe/jev-1.14');
  assert.equal(request.state[1].image_url.url, 'data:image/png;base64,IMAGE_BYTES');
  assert.equal(result.status, 'yes'); assert.deepEqual(result.reasons, []);
});
test('a different seller is no; a fresh unreadable picture cannot borrow an older yes', () => {
  const good = { kind: 'basket', product: 'yes', seller: 'yes', amount: 'yes' };
  assert.equal(summarizeImageChecks([good]).status, 'yes');
  assert.equal(summarizeImageChecks([{ ...good, seller: 'no' }]).status, 'no');
  assert.equal(summarizeImageChecks([good, { kind: 'unknown' }]).status, 'unknown');
});
test('JEV image outage throws; unsupported media or dimensions return uncertainty', async () => {
  const args = { images: [{ mediaType: 'image/png', data: 'x' }], policy: {}, task: 'basket', apiKey: 'test', normalize: i => i };
  await assert.rejects(checkDianaImages({ ...args, fetchImpl: async () => new Response('', { status: 503 }) }), /JEV HTTP/);
  assert.equal((await checkDianaImages({ ...args, fetchImpl: async () => new Response('', { status: 413 }) })).status, 'unknown');
  assert.equal((await checkDianaImages({ ...args, images: [{ mediaType: 'image/webp' }] })).status, 'unknown');
});
test('a tall phone screenshot is resized whole; a small picture is padded, never cropped', () => {
  for (const [width, height] of [[1080, 2400], [100, 80]]) {
    const input = { width, height, data: new Uint8Array(width * height * 4).fill(255), channels: 4, depth: 8 };
    input.data[0] = 0; input.data[1] = 0; input.data[2] = 0;
    const normalized = normalizeJevImage({ mediaType: 'image/png', data: Buffer.from(encodePng(input)).toString('base64') });
    const output = jpeg.decode(Buffer.from(normalized.data, 'base64'));
    assert.ok(output.width >= 256 && output.height >= 256);
    assert.ok(output.width <= 1568 && output.height <= 1568);
    assert.ok(output.width * output.height >= 78400);
  }
});
