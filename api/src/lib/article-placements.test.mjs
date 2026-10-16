import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = mkdtempSync(join(tmpdir(), 'erp-articles-'));
const outfile = join(dir, 'ledger.mjs');
buildSync({ entryPoints: [fileURLToPath(new URL('./article-placements.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile });
const { articlePlacements } = await import(pathToFileURL(outfile));
const routeFile = join(dir, 'analytics.mjs');
buildSync({ entryPoints: [fileURLToPath(new URL('../routes/analytics.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile: routeFile });
const { default: analytics } = await import(pathToFileURL(routeFile));
const published = {
  article_title: 'Freshness and plaque', website_domain: 'medium.com', language: 'en',
  status: 'verified_published', permalink: 'https://medium.com/@company/freshness-and-plaque',
  published_at: '2026-10-15T21:30:00Z', account_email: 'private@example.com', notes: 'private access notes',
};

test('the Articles response exposes only requested publication fields and uses the Yerevan day', () => {
  assert.deepEqual(articlePlacements({ placements: [published] }), [{
    article_title: published.article_title, service: 'Medium', language: 'EN',
    url: published.permalink, placement_date: '2026-10-16',
  }]);
});

test('drafts, moderation and private posts never appear as published articles', () => {
  const excluded = [
    { status: 'draft' }, { status: 'pending_review' }, { status: 'submitted' },
    { visibility: 'private' }, { visibility: 'under_review' }, { visibility: 'pending publication' },
  ].map(extra => ({ ...published, ...extra }));
  assert.deepEqual(articlePlacements({ placements: excluded }), []);
});

test('links must be HTTPS on the recorded platform and cannot contain credentials', () => {
  const bad = ['javascript:alert(1)', 'http://medium.com/article', 'https://medium.com.evil.test/article', 'https://user:pass@medium.com/article'];
  assert.deepEqual(articlePlacements({ placements: bad.map(permalink => ({ ...published, permalink })) }), []);
});

test('Vietnamese is displayed as VN, subdomains work, duplicate URLs appear once and date-only stays fixed', () => {
  const vn = { ...published, language: 'vi', website_domain: 'blogspot.com', permalink: 'https://company.blogspot.com/article', published_at: '2026-10-14' };
  const rows = articlePlacements({ placements: [vn, published, vn] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].service, 'Medium');
  assert.deepEqual(rows[1], { article_title: vn.article_title, service: 'Blogger', language: 'VN', url: vn.permalink, placement_date: '2026-10-14' });
});

test('missing publication evidence is omitted and a broken ledger fails instead of showing an empty success', () => {
  assert.throws(() => articlePlacements({ records: [] }), /Invalid article placement ledger/);
  const bad = [{ article_title: '' }, { published_at: 'unknown' }, { language: 'English' }, { permalink: null }];
  assert.deepEqual(articlePlacements({ placements: [null, ...bad.map(extra => ({ ...published, ...extra }))] }), []);
});

test('API reports source configuration and upstream failures without exposing access data', async () => {
  const absent = await analytics.request('/articles', {}, {});
  assert.equal(absent.status, 503);
  assert.equal((await absent.json()).success, false);
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response('private upstream details', { status: 403 });
    const failure = await analytics.request('/articles', {}, { ORG_SSOT_TOKEN: 'test-only-placeholder' });
    assert.equal(failure.status, 502);
    const body = await failure.text();
    assert.doesNotMatch(body, /private upstream|test-only-placeholder/);
  } finally { globalThis.fetch = original; }
});

test('API fetches the canonical ledger and caches only the safe projection', async () => {
  const original = globalThis.fetch;
  const writes = [];
  try {
    globalThis.fetch = async (url) => {
      assert.equal(url, 'https://api.github.com/repos/dasexperten/organizacia/contents/jobs/julian-brand-seeding/PLACEMENTS.json?ref=main');
      return Response.json({ placements: [published] });
    };
    const response = await analytics.request('/articles', {}, {
      ORG_SSOT_TOKEN: 'test-only-placeholder',
      CACHE: { get: async () => null, put: async (...args) => writes.push(args) },
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.result.rows.length, 1);
    assert.doesNotMatch(JSON.stringify([payload, writes]), /private@example|private access|test-only-placeholder/);
    assert.equal(writes[0][2].expirationTtl, 60);
  } finally { globalThis.fetch = original; }
});
