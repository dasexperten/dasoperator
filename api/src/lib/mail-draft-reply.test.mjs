import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'draft-reply-'));
const outfile = join(dir, 'context.mjs');
await require('esbuild').build({ entryPoints: [fileURLToPath(new URL('./mail-draft-reply.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile });
const { readDraftReplyContext, restoreDraftReply } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });

const text = 'New reply\n\nPrevious correspondence';
const context = { draft_id: 'saved', user_id: 'owner', from_addr: 'Manager <retail@example.com>',
  in_reply_to: '<parent@example.com>', references_json: JSON.stringify(['<root@example.com>', '<parent@example.com>']),
  reply_to_tag: 'oldtag', body_sha256: createHash('sha256').update(text).digest('hex'), html: '<p>New reply</p>' };

test('reopened draft restores full ancestry, original tag and verified HTML', async () => {
  const result = await restoreDraftReply(context, { from: 'retail@example.com', text, in_reply_to: context.in_reply_to });
  assert.deepEqual(result, { from: context.from_addr, html: context.html, in_reply_to: context.in_reply_to,
    references: ['<root@example.com>', '<parent@example.com>'], replyToTag: 'oldtag' });
});
test('editing the draft preserves threading but never sends stale HTML', async () => {
  const result = await restoreDraftReply(context, { from: 'retail@example.com', text: 'Edited reply' });
  assert.equal(result.html, undefined);
  assert.equal(result.in_reply_to, context.in_reply_to);
  assert.equal(result.references.length, 2);
});
test('changed sender is never overwritten by a saved persona', async () => {
  const result = await restoreDraftReply(context, { from: 'other@example.com', text });
  assert.equal(result.from, undefined);
  assert.equal(result.html, undefined);
});
test('another parent and ordinary drafts do not inherit this conversation', async () => {
  assert.deepEqual(await restoreDraftReply(context, { from: 'retail@example.com', text, in_reply_to: '<other@example.com>' }), {});
  assert.deepEqual(await restoreDraftReply(null, { from: 'retail@example.com', text }), {});
});
test('context lookup is scoped to the authenticated owner', async () => {
  let values;
  const env = { DB: { prepare: sql => { assert.match(sql, /draft_id = \? AND user_id = \?/); return { bind: (...args) => {
    values = args; return { first: async () => null };
  } }; } } };
  assert.equal(await readDraftReplyContext(env, 'another-owner', 'saved'), null);
  assert.deepEqual(values, ['saved', 'another-owner']);
});
