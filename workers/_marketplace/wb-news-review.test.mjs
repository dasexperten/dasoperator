import test from 'node:test';
import assert from 'node:assert/strict';
import { runWbNews } from './seat-reports.mjs';
const rows = Array.from({ length: 20 }, (_, i) => ({ date: new Date().toISOString(), header: `News ${i}`, content: `Content ${i}` }));
function envFor(review) {
  let sent;
  const env = {
    WB_GATEWAY: { fetch: async () => Response.json({ data: rows }) },
    ARINA_NEWS: { fetch: async (_url, init) => { sent = JSON.parse(init.body); return review(sent); } },
    BOARD: { fetch: async () => Response.json({ ok: true }) },
  };
  return { env, sent: () => sent };
}
test('full feed reaches Arina even when there are more than sixteen items', async () => {
  const f = envFor(p => Response.json({ ok: true, reviewed: p.items.length, decisions: p.items.map(x => ({ title: x.header, status: 'not_relevant' })) }));
  const result = await runWbNews(f.env);
  assert.equal(result.ok, true); assert.equal(f.sent().items.length, 20); assert.equal(result.review.reviewed, 20);
});
test('review failure is an error, not a successful empty report', async () => {
  const f = envFor(() => Response.json({ ok: false, error: 'model unavailable' }, { status: 502 }));
  const result = await runWbNews(f.env);
  assert.equal(result.ok, false); assert.match(result.error, /model unavailable/);
});
