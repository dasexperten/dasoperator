// CI-only: observe upload response metadata without enabling unsanitized logs.
const { channel } = require('node:diagnostics_channel');
const { createHash } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const UPLOAD_PATH = '/client/v4/accounts/081ddb85cb399ad62a70210328d744fc/workers/scripts/dasoperator-api/versions';
function responseDiagnostic({ request, response } = {}) {
  if (String(request?.origin) !== 'https://api.cloudflare.com'
    || request?.path !== UPLOAD_PATH || request?.method !== 'POST') return null;
  if (!Number.isInteger(response?.statusCode) || response.statusCode < 100 || response.statusCode > 599) return null;
  const result = { phase: 'api_version_upload_response', status: response.statusCode };
  const allowed = {
    'cf-ray': /^[a-f0-9]{16,32}-[A-Z]{3}$/i,
    'cf-auditlog-id': /^[a-f0-9-]{16,64}$/i,
    'api-version': /^\d{4}-\d{2}-\d{2}$/,
  };
  const headers = response.headers || [];
  for (let i = 0; i + 1 < headers.length; i += 2) {
    const name = String(headers[i]).toLowerCase();
    if (!Object.hasOwn(allowed, name)) continue;
    const value = String(headers[i + 1]);
    if (allowed[name].test(value)) result[name] = value;
  }
  return result;
}

channel('undici:request:headers').subscribe((message) => {
  // Observability must never change request behavior, even for unexpected data.
  try {
    const result = responseDiagnostic(message);
    if (result) process.stdout.write(`[deploy-diagnostic] ${JSON.stringify(result)}\n`);
  } catch { /* No raw diagnostics or exception payload may escape. */ }
});

function deploy() {
  const bundleDir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), 'erp-deploy-bundle-'));
  let result;
  try {
    result = spawnSync('npx', ['wrangler', 'deploy', '--outdir', bundleDir], {
      stdio: 'inherit',
      env: {
        ...process.env,
        // Force sanitization even if a runner inherited a different setting.
        WRANGLER_LOG_SANITIZE: 'true',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(__filename)}`.trim(),
      },
    });
    try {
      const bundle = readFileSync(join(bundleDir, 'index.js'));
      console.log('[deploy-diagnostic]', JSON.stringify({
        phase: 'bundle', file: 'index.js', bytes: bundle.length,
        sha256: createHash('sha256').update(bundle).digest('hex'),
      }));
    } catch {
      console.log('[deploy-diagnostic]', JSON.stringify({ phase: 'bundle', available: false }));
    }
    if (result.error || result.signal) {
      console.log('[deploy-diagnostic]', JSON.stringify({ phase: 'process', completed: false }));
    }
    return result.status ?? 1;
  } finally {
    rmSync(bundleDir, { recursive: true, force: true });
  }
}

module.exports = { responseDiagnostic };
if (require.main === module) process.exitCode = deploy();
