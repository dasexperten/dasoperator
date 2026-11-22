// Explicit opt-in. Default unit tests need no npm package or workerd binary.
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let entry;
try { entry = require.resolve('miniflare'); }
catch { console.error('Run npm ci --prefix pilots/operational-storage/miniflare-runtime first.'); process.exit(1); }
// No Cloudflare/provider tokens, account IDs, configuration or source paths are
// inherited. The only bindings are synthetic local D1/R2 declared by the suite.
const env = { MINIFLARE_MODULE: entry, NODE_ENV: 'test', CLOUDFLARE_CF_FETCH_ENABLED: 'false' };
for (const key of ['PATH', 'TMPDIR', 'TEMP', 'TMP', 'SYSTEMROOT', 'SystemRoot']) {
  if (process.env[key]) env[key] = process.env[key];
}
const child = spawnSync(process.execPath, [
  '--import', fileURLToPath(new URL('./local-only.mjs', import.meta.url)),
  '--test', fileURLToPath(new URL('../miniflare.test.mjs', import.meta.url)),
], { env, stdio: 'inherit' });
if (child.error) console.error(child.error.message);
process.exit(child.status ?? 1);
