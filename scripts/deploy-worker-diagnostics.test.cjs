const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { responseDiagnostic } = require('./deploy-worker-diagnostics.cjs');
const request = {
  origin: 'https://api.cloudflare.com', method: 'POST',
  path: '/client/v4/accounts/081ddb85cb399ad62a70210328d744fc/workers/scripts/dasoperator-api/versions',
  headers: 'Authorization: secret', body: 'private source',
};

test('upload reports only allowed response IDs and status, never payloads', () => {
  const actual = responseDiagnostic({ request, response: {
    statusCode: 500,
    headers: ['cf-ray', 'a1fc48d6da7c33a1-AUS', 'cf-auditlog-id', '019f8ff2-c3ef-7a22-b8b6-f3a6389e0994',
      'api-version', '2026-07-23', 'set-cookie', 'secret-cookie', 'authorization', 'secret-token'].map(Buffer.from),
    body: 'private response',
  } });
  assert.deepEqual(actual, { phase: 'api_version_upload_response', status: 500,
    'cf-ray': 'a1fc48d6da7c33a1-AUS', 'cf-auditlog-id': '019f8ff2-c3ef-7a22-b8b6-f3a6389e0994', 'api-version': '2026-07-23' });
});

test('ignores other origins, paths, methods and malformed statuses', () => {
  for (const change of [{ origin: 'https://example.com' }, { path: '/secrets' }, { method: 'GET' }]) {
    assert.equal(responseDiagnostic({ request: { ...request, ...change }, response: { statusCode: 500 } }), null);
  }
  assert.equal(responseDiagnostic({ request, response: { statusCode: 'secret' } }), null);
});

test('rejects arbitrary values and line injection in allowed header names', () => {
  assert.deepEqual(responseDiagnostic({ request, response: { statusCode: 200,
    headers: ['cf-ray', 'secret\n::warning::payload', 'api-version', 'private value', 'cf-auditlog-id', 'token', 'set-cookie', 'hidden'],
  } }), { phase: 'api_version_upload_response', status: 200 });
});

test('preload captures headers and hashes the produced bundle while preserving deploy exit status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-diagnostics-test-'));
  try {
    // A fake npx makes this a complete subprocess test with no deploy/network call.
    writeFileSync(join(dir, 'npx'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
assert.equal(process.env.WRANGLER_LOG_SANITIZE, 'true');
assert.deepEqual(process.argv.slice(2, 5), ['wrangler', 'deploy', '--outdir']);
fs.writeFileSync(path.join(process.argv[5], 'index.js'), 'fixture-bundle');
require('node:diagnostics_channel').channel('undici:request:headers').publish({
 request: ${JSON.stringify(request)},
 response: {statusCode: 500, headers: ['cf-ray', 'a1fc48d6da7c33a1-AUS', 'set-cookie', 'private-cookie']}
});
process.exit(Number(process.env.FIXTURE_EXIT));
`, { mode: 0o700 });
    for (const exit of [0, 42]) {
      const result = spawnSync(process.execPath, [join(__dirname, 'deploy-worker-diagnostics.cjs')], {
        encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`,
          RUNNER_TEMP: dir, FIXTURE_EXIT: String(exit), WRANGLER_LOG_SANITIZE: 'false' },
      });
      assert.equal(result.status, exit, result.stderr);
      const lines = result.stdout.trim().split('\n').map(line => JSON.parse(line.replace('[deploy-diagnostic] ', '')));
      assert.deepEqual(lines, [
        { phase: 'api_version_upload_response', status: 500, 'cf-ray': 'a1fc48d6da7c33a1-AUS' },
        { phase: 'bundle', file: 'index.js', bytes: 14, sha256: createHash('sha256').update('fixture-bundle').digest('hex') },
      ]);
      assert.doesNotMatch(result.stdout + result.stderr, /private-cookie|private source|Authorization|secret/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
