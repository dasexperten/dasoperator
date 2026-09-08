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
  assert.equal((source.match(/source: comSourceLabel\(c\.env\)/g) || []).length, 11);

  const overview = route('/overview', '/channels');
  assert.equal((overview.match(/dimensionFilter: comHostFilter\(\)/g) || []).length, 2);

  const pages = route('/pages', '/acquisition-detail');
  assert.equal((pages.match(/dimensionFilter: comHostFilter\(\)/g) || []).length, 2);
  assert.match(pages, /const \[resp, exact\] = await Promise\.all/);

  const acquisition = route('/acquisition-detail', '/funnel');
  assert.equal((acquisition.match(/dimensionFilter: comHostFilter\(\)/g) || []).length, 2);

  const funnel = route('/funnel', '/price-test-exposure');
  assert.match(funnel, /dimensionFilter: comHostFilter\(\)/);
  assert.match(funnel, /dimensionFilter: withComHostFilter\(/);

  const losses = route('/commerce-losses', '/geo');
  assert.match(losses, /dimensionFilter: withComHostFilter\(/);

  const content = route('/content', '/snapshot');
  assert.match(content, /dimensionFilter: comHostFilter\(\)/);
  assert.match(content, /dimensionFilter: withComHostFilter\(/);

  const channels = route('/channels', '/pages');
  assert.match(channels, /dimensionFilter: comHostFilter\(\)/);

  const geo = route('/geo', '/languages');
  assert.equal((geo.match(/dimensionFilter: comHostFilter\(\)/g) || []).length, 3);
  assert.match(geo, /const \[resp, exact\] = await Promise\.all/);

  const languages = route('/languages', '/content');
  assert.equal((languages.match(/dimensionFilter: comHostFilter\(\)/g) || []).length, 2);
  assert.match(languages, /const \[resp, exact\] = await Promise\.all/);

  const snapshot = route('/snapshot', '/nav-flows');
  assert.equal((snapshot.match(/dimensionFilter: comHostFilter\(\)/g) || []).length, 3);
  assert.match(snapshot, /const \[current, currentExact, previous\] = await Promise\.all/);

  const flows = route('/nav-flows', '/realtime');
  assert.match(flows, /dimensionFilter: comHostFilter\(\)/);
  assert.match(flows, /dimensionFilter: withComHostFilter\(/);
});

test('host correction busts every affected cache key', () => {
  assert.match(source, /ga4:overview:v2[\s\S]*?host: 'com'/);
  assert.match(source, /ga4:pages:v2[\s\S]*?host: 'com'/);
  assert.match(source, /ga4:acquisition-detail:v6[\s\S]*?host: 'com'/);
  assert.match(source, /ga4:funnel:v3[\s\S]*?host: 'com'/);
  assert.match(source, /ga4:commerce-losses:v32[\s\S]*?host: 'com'/);
  assert.match(source, /ga4:content:v5[\s\S]*?host: 'com'/);
  assert.match(source, /ga4:channels:v2[\s\S]*?host: 'com'/);
  assert.match(source, /ga4:geo:v2[\s\S]*?host: 'com'/);
  assert.match(source, /ga4:languages:v2[\s\S]*?host: 'com'/);
  assert.match(source, /ga4:snapshot:v2[\s\S]*?host: 'com'/);
  assert.match(source, /ga4:nav-flows:v2[\s\S]*?host: 'com'/);
});
