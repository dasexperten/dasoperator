import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./ga4.ts', import.meta.url), 'utf8');

function route(path, nextPath) {
  const start = source.indexOf(`ga4.get('${path}'`);
  const end = source.indexOf(`ga4.get('${nextPath}'`, start + 1);
  assert.ok(start >= 0 && end > start, `route bounds missing for ${path}`);
  return source.slice(start, end);
}

test('commercial GA4 reports are bounded to the .com host', () => {
  assert.match(source, /const COM_HOSTS = \['www\.dasexperten\.com', 'dasexperten\.com'\]/);
  assert.match(source, /fieldName: 'hostName'/);
  assert.match(source, /www\.dasexperten\.com host only/);
  assert.equal((source.match(/source: comSourceLabel\(c\.env\)/g) || []).length, 4);

  const overview = route('/overview', '/channels');
  assert.equal((overview.match(/dimensionFilter: comHostFilter\(\)/g) || []).length, 2);

  const acquisition = route('/acquisition-detail', '/funnel');
  assert.equal((acquisition.match(/dimensionFilter: comHostFilter\(\)/g) || []).length, 2);

  const funnel = route('/funnel', '/price-test-exposure');
  assert.match(funnel, /dimensionFilter: comHostFilter\(\)/);
  assert.match(funnel, /dimensionFilter: withComHostFilter\(/);

  const losses = route('/commerce-losses', '/geo');
  assert.match(losses, /dimensionFilter: withComHostFilter\(/);
});

test('host correction busts every affected cache key', () => {
  assert.match(source, /ga4:overview:v2[\s\S]*?host: 'com'/);
  assert.match(source, /ga4:acquisition-detail:v6[\s\S]*?host: 'com'/);
  assert.match(source, /ga4:funnel:v2[\s\S]*?host: 'com'/);
  assert.match(source, /ga4:commerce-losses:v24[\s\S]*?host: 'com'/);
});
