import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'draft-reply-route-'));
const outfile = join(dir, 'route.mjs');
await require('esbuild').build({ entryPoints: [fileURLToPath(new URL('./email-reply.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile,
  plugins: [{ name: 'mail-fixture', setup(build) {
    build.onResolve({ filter: /\/lib\/(auth|resend-human|mail-draft-files)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'auth'
      ? 'export async function validateSession(){return {id:"owner"}}'
      : args.path === 'mail-draft-files' ? 'export async function loadDraftAttachments(){return [{filename:"logistics.xlsx",content:new Uint8Array([1,2,3])}]}'
      : 'export const isAllowedHumanFrom=()=>true;export const extractEmailAddr=s=>s;export async function sendHumanResend(env,p){env.calls.push(p);return {success:true,messageId:"fixture",archived:true}}' }));
  } }] });
const { default: route } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });

test('the manual-send route preserves reopened draft history headers and XLSX attachment', async () => {
  const text = 'Reply\n\nComplete history';
  const context = { from_addr: 'Manager <retail@example.com>', in_reply_to: '<parent@example.com>',
    references_json: JSON.stringify(['<root@example.com>', '<parent@example.com>']), reply_to_tag: 'oldtag',
    body_sha256: createHash('sha256').update(text).digest('hex'), html: '<p>Reply</p><p>Complete history</p>' };
  const env = { calls: [], DB: { prepare: () => ({ bind: (draft, owner) => {
    assert.equal(draft, 'saved'); assert.equal(owner, 'owner'); return { first: async () => context };
  } }) } };
  const res = await route.request('http://localhost/reply', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fixture' },
    body: JSON.stringify({ from: 'retail@example.com', to: ['buyer@example.com'], cc: ['colleague@example.com'], subject: 'RE: Logistics', text,
      draft_id: 'saved', attachment_ids: ['12345678-1234-4234-8234-123456789012'], in_reply_to: context.in_reply_to }) }, env);
  assert.equal(res.status, 200);
  assert.equal(env.calls.length, 1);
  const sent = env.calls[0];
  assert.deepEqual(sent.references, ['<root@example.com>', '<parent@example.com>']);
  assert.equal(sent.replyToTag, 'oldtag');
  assert.equal(sent.from, context.from_addr);
  assert.equal(sent.html, context.html);
  assert.equal(sent.attachments[0].filename, 'logistics.xlsx');
  assert.deepEqual(sent.cc, ['colleague@example.com']);
});
