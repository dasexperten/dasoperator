import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./banks-modulbank.ts', import.meta.url), 'utf8');
const accountsRoute = source.match(/banksModulbank\.get\('\/accounts',[\s\S]*?\n\}\);/);

assert.ok(accountsRoute, 'Modulbank accounts route must exist');
assert.match(source, /import \{ validateSession \} from '\.\.\/lib\/auth';/);
assert.match(accountsRoute[0], /validateSession\(c\.env\.DB, token\)/);
assert.match(accountsRoute[0], /return fail\(c, 401, \[\{ code: 'unauthorized', message: 'valid session required' \}\]\)/);
assert.ok(
  accountsRoute[0].indexOf('validateSession(c.env.DB, token)') < accountsRoute[0].indexOf('c.env.DB.prepare'),
  'session validation must run before the account query',
);

console.log('banks-modulbank accounts auth contract: ok');
