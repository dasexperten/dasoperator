import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [route, sync, ui] = await Promise.all([
  readFile(new URL('./clarity.ts', import.meta.url), 'utf8'),
  readFile(new URL('../lib/web-analytics-sync.ts', import.meta.url), 'utf8'),
  readFile(new URL('../../../web/app/analytics/tabs/BehaviorTab.tsx', import.meta.url), 'utf8'),
]);

assert.match(route, /clarity\.get\('\/behavior-by-url'/);
assert.match(route, /clarityUrlCacheKey\(days\)/);
assert.match(sync, /fetchClarityBehaviorByUrl\(env, 1\)/);
assert.match(sync, /if \(byUrl\) await env\.CACHE\.put\(clarityUrlCacheKey\(1\)/);
assert.match(ui, /\/api\/clarity\/behavior-by-url\?days=1/);
assert.match(ui, /Behavior friction by page/);
assert.match(ui, /quickback_sessions/);
assert.match(ui, /2 API calls — 10\/day hard limit/);

console.log('PASS 8/8 Clarity URL breakdown delivery checks');
