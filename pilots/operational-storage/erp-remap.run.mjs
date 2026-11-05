import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const require=createRequire(new URL('./miniflare-runtime/package.json',import.meta.url));
const env={MINIFLARE_MODULE:require.resolve('miniflare'),NODE_ENV:'test',CLOUDFLARE_CF_FETCH_ENABLED:'false'};
for(const key of ['PATH','TMPDIR','TEMP','TMP','SYSTEMROOT','SystemRoot']) if(process.env[key]) env[key]=process.env[key];
const child=spawnSync(process.execPath,['--import',fileURLToPath(new URL('./miniflare-runtime/local-only.mjs',import.meta.url)),'--test',fileURLToPath(new URL('./erp-remap.test.mjs',import.meta.url))],{env,stdio:'inherit'});
if(child.error) console.error(child.error.message);process.exit(child.status??1);
