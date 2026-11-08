import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'mailbox-route-test-'));
const outfile = join(dir, 'registry.mjs');
await require('esbuild').build({ entryPoints: [fileURLToPath(new URL('./mailbox-registry.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile });
const { routeInboundRecipient } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });

// Owner 2026-11-05: Magnit replies to eurasia+t9spx8@ must be archived with attachments.
test('tagged reply to a company box is archived under the base box', () => {
  const r = routeInboundRecipient('eurasia+t9spx8@dasexperten.com');
  assert.deepEqual(r, { base: 'eurasia@dasexperten.com', tag: 't9spx8', action: 'archive' });
});
test('plain company box is archived', () => {
  assert.equal(routeInboundRecipient('Eurasia@dasexperten.com').action, 'archive');
});
test('Dieter support replies retain their thread tag in the existing reels mailbox', () => {
  assert.deepEqual(routeInboundRecipient('reels+vk261108@dasexperten.com'), { base: 'reels@dasexperten.com', tag: 'vk261108', action: 'archive' });
});
test('alias with a tag resolves through the registry', () => {
  assert.equal(routeInboundRecipient('mina+x1@dasexperten.com').action, 'archive');
});
test('owner personal box stays Gmail-only, tagged or not', () => {
  assert.equal(routeInboundRecipient('dr.badalyan@dasexperten.com').action, 'owner_only');
  assert.equal(routeInboundRecipient('dr.badalyan+a@dasexperten.com').action, 'owner_only');
});
test('unknown address is forwarded only, never archived', () => {
  assert.equal(routeInboundRecipient('random-junk@dasexperten.com').action, 'forward_only');
  assert.equal(routeInboundRecipient('').action, 'forward_only');
});
