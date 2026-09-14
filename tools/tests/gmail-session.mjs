import assert from 'node:assert/strict';
import { build } from '../../web/node_modules/esbuild/lib/main.js';
const built=await build({entryPoints:['api/src/lib/gmail-client.ts'],bundle:true,platform:'node',format:'esm',write:false});
const {gmailSession,invalidateGmailSessions}=await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
const env={GOOGLE_WORKSPACE_CLIENT_ID:'test-client',GOOGLE_WORKSPACE_CLIENT_SECRET:'test-secret',GOOGLE_WORKSPACE_ACCOUNTS:JSON.stringify([{email:'sales@dasexperten.com',refreshToken:'test-refresh'}])};
const realNow=Date.now;let now=100000;Date.now=()=>now;
let calls=0, profile='sales@dasexperten.com',expiry=3600;
globalThis.fetch=async url=>{calls++;await Promise.resolve();return new Response(JSON.stringify(String(url).includes('oauth2') ? {access_token:'test-access',expires_in:expiry} : {emailAddress:profile}));};
try {
  const concurrent=await Promise.all(Array.from({length:8},()=>gmailSession(env,'sales@dasexperten.com')));
  assert.equal(calls,2,'Concurrent inbox/count/body requests must share one token refresh and identity check');
  assert.ok(concurrent.every(s=>s.account==='sales@dasexperten.com'));
  await gmailSession(env,'sales@dasexperten.com');assert.equal(calls,2);
  now+=121000;await gmailSession(env,'sales@dasexperten.com');assert.equal(calls,4);
  await gmailSession({...env,GOOGLE_WORKSPACE_CLIENT_SECRET:'rotated'},'sales@dasexperten.com');assert.equal(calls,6);
  await assert.rejects(gmailSession(env,'other@dasexperten.com'));assert.equal(calls,6);
  invalidateGmailSessions();profile='wrong@dasexperten.com';
  await assert.rejects(gmailSession(env,'sales@dasexperten.com'));assert.equal(calls,8);
  profile='sales@dasexperten.com';await gmailSession(env,'sales@dasexperten.com');assert.equal(calls,10,'A failed identity check must not stay cached');
  invalidateGmailSessions();expiry=20;
  await gmailSession(env,'sales@dasexperten.com');await gmailSession(env,'sales@dasexperten.com');assert.equal(calls,14,'Do not reuse grants close to expiry');
} finally {Date.now=realNow;invalidateGmailSessions();}
console.log('PASS: eight concurrent requests use two Google auth calls instead of sixteen; expiry, rotation, identity isolation and invalidation verified.');
