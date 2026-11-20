import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
let build;
try { ({ build } = require('esbuild')); } catch { ({ build } = createRequire(new URL('../../../workers/package.json', import.meta.url))('esbuild')); }
const dir = mkdtempSync(join(tmpdir(), 'content-confirm-'));
const outfile = join(dir, 'confirm.mjs');
await build({ entryPoints: [fileURLToPath(new URL('./ugc-content-confirm.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'silent' });
const { postUrl } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });

test('the publication address is taken out of a link as it was pasted', () => {
  assert.equal(postUrl('https://www.instagram.com/reels/DWhFA3WAQTY/'), 'https://www.instagram.com/reel/DWhFA3WAQTY/');
  assert.equal(postUrl('https://www.instagram.com/p/DTnWGwRjEh_/ё'), 'https://www.instagram.com/p/DTnWGwRjEh_/');
  assert.equal(postUrl('https://vm.tiktok.com/ZGda9Y7kE/ https://t.me/x/718 https://www.instagram.com/p/DPgsH63DJ-3/?hl=ru'), 'https://www.instagram.com/p/DPgsH63DJ-3/');
  assert.equal(postUrl('https://www.instagram.com/reel/Df6bTQDsggo/'), 'https://www.instagram.com/reel/Df6bTQDsggo/');
});

test('a profile or a Direct address is not a publication', () => {
  assert.equal(postUrl('https://www.instagram.com/direct/t/17842091366498352/'), null);
  assert.equal(postUrl('https://www.instagram.com/aliya_galimova.r?igsh=ZXox'), null);
  assert.equal(postUrl(null), null);
});
