import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { composeDiana, matchEntries, parseEntries } from './diana-profile.mjs';

const ORG = 'C:/Users/user/.claude/org-ssot/organizacia';

test('entries are parsed by heading, fences and [регистр] skipped', () => {
  const e = parseEntries('# T\n## A-1 | если пишешь блогеру\nx\n```\n## not\n```\n## [регистр] r\nz\n## B-2 | если оплата\ny');
  assert.deepEqual(e.map((x) => x.heading), ['A-1 | если пишешь блогеру', 'B-2 | если оплата']);
});

test('the message picks the entries whose trigger it shares', () => {
  const e = parseEntries('## X | если выплата не прошла\na\n## Y | если пишешь сценарий ролика\nb\n## Z | если склад\nc');
  assert.deepEqual(matchEntries('Перевод не прошёл, выплата отклонена банком', e).map((x) => x.heading), ['X | если выплата не прошла']);
});

test('on the real profile: voice and charter whole, selected entries, size sane', { skip: !existsSync(`${ORG}/agents/diana-helios/DIRECT_RULES.md`) }, () => {
  const r = (p) => readFileSync(`${ORG}/${p}`, 'utf8');
  const files = { harness: r('agents/diana-helios/DIRECT_RULES.md'), voice: r('agents/diana-helios/VOICE.md'), charter: r('agents/diana-helios/CHARTER.md'),
    hardRules: r('HARD_RULES.md'), learning: r('agents/diana-helios/LEARNING.md'), memory: r('agents/diana-helios/MEMORY.md') };
  const s = composeDiana(files, 'Выбрала сценарий 4, у меня паста TERMO. Перевод пришёл, спасибо');
  assert.match(s, /=== 01 VOICE\.md/);
  assert.match(s, /=== 02 CHARTER\.md/);
  assert.match(s, /=== 04 LEARNING\.md/);
  assert.ok(s.length < 120000, `prompt ${s.length} chars`);
});
