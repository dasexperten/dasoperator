import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const dir = mkdtempSync(join(tmpdir(), 'mail-recovery-test-'));
const outfile = join(dir, 'recovery.mjs');
await require('esbuild').build({ entryPoints: [fileURLToPath(new URL('./mail-archive-recovery.ts', import.meta.url))], bundle: true, platform: 'node', format: 'esm', outfile });
const { mailArchiveEnv, reconcileMailRecovery, RECOVERY_PREFIX } = await import(pathToFileURL(outfile));
rmSync(dir, { recursive: true });

class Bucket {
  data = new Map(); failWrites = false; afterWrite;
  async head(key) { const o=this.data.get(key); return o ? { ...o, body:undefined } : null; }
  async get(key) {
    const o=this.data.get(key); if (!o) return null;
    return { ...o, body: new Response(o.bytes).body,
      async text(){return new TextDecoder().decode(o.bytes);},
      async json(){return JSON.parse(new TextDecoder().decode(o.bytes));},
      async arrayBuffer(){return o.bytes.slice().buffer;} };
  }
  async put(key,value,options={}) {
    if(this.failWrites) throw Error('put: internal error (10001)');
    const old=this.data.get(key), c=options.onlyIf;
    if(c?.etagMatches && c.etagMatches!==old?.etag) return null;
    if(c?.etagDoesNotMatch && (c.etagDoesNotMatch==='*' ? !!old : c.etagDoesNotMatch===old?.etag)) return null;
    const bytes=typeof value==='string' ? new TextEncoder().encode(value) : new Uint8Array(value);
    const o={key,etag:createHash('md5').update(bytes).digest('hex'),size:bytes.length,uploaded:new Date(),httpMetadata:options.httpMetadata,customMetadata:options.customMetadata,bytes};
    this.data.set(key,o); if(this.afterWrite) await this.afterWrite(key);return o;
  }
  async delete(key){if(this.failWrites)throw Error('delete: internal error');this.data.delete(key);}
  async list(options={}) {
    const prefix=options.prefix||'', all=new Map();
    for(const o of this.data.values()) {
      if(!o.key.startsWith(prefix))continue;
      const rest=o.key.slice(prefix.length),i=options.delimiter ? rest.indexOf(options.delimiter) : -1;
      if(i>=0)all.set(prefix+rest.slice(0,i+options.delimiter.length),{prefix:true});else all.set(o.key,o);
    }
    const ordered=[...all].filter(([k])=>!options.startAfter||k>options.startAfter).sort(([a],[b])=>a<b?-1:1);
    const limit=options.limit||1000,page=ordered.slice(0,limit);
    return {objects:page.filter(([,o])=>!o.prefix).map(([,o])=>o),delimitedPrefixes:page.filter(([,o])=>o.prefix).map(([k])=>k),truncated:ordered.length>limit,cursor:'unused'};
  }
}
const setup=()=>{const primary=new Bucket(),old=new Bucket(),raw={ARCHIVE:primary,ARCHIVE_OLD:old,MAIL_ARCHIVE_RECOVERY:'old'};return{primary,old,raw,env:mailArchiveEnv(raw)};};

test('durable overlay preserves canonical history and leaves unrelated writes alone',async()=>{
  const {primary,old,env}=setup();await primary.put('Inbox/a/sent/old.json','история');primary.failWrites=true;
  assert.equal(await (await env.ARCHIVE.get('Inbox/a/sent/old.json')).text(),'история');
  const out=await env.ARCHIVE.put('MailOutbox/new.json','Здравствуйте, коллеги!');
  assert.equal(out.key,'MailOutbox/new.json');assert.equal(await(await env.ARCHIVE.get(out.key)).text(),'Здравствуйте, коллеги!');
  assert.ok(old.data.has(RECOVERY_PREFIX+out.key));assert.equal(primary.data.size,1);
  await assert.rejects(env.ARCHIVE.put('Unrelated/data.json','x'),/10001/);
});

test('parallel conditional claims admit one sender; canonical lease migrates atomically',async()=>{
  const {primary,env}=setup(),key='MailSendRequests/draft.json';await primary.put(key,'previous');const original=await primary.head(key);primary.failWrites=true;
  const claims=await Promise.all([1,2].map(n=>env.ARCHIVE.put(key,'claim'+n,{onlyIf:{etagMatches:original.etag}})));
  assert.equal(claims.filter(Boolean).length,1);
  const claim=claims.find(Boolean);assert.ok(await env.ARCHIVE.put(key,'accepted',{onlyIf:{etagMatches:claim.etag}}));
  assert.equal(await env.ARCHIVE.put(key,'stale',{onlyIf:{etagMatches:claim.etag}}),null);
  const create=await Promise.all([1,2].map(n=>env.ARCHIVE.put('MailSendRequests/new.json','new'+n,{onlyIf:{etagDoesNotMatch:'*'}})));
  assert.equal(create.filter(Boolean).length,1);
});

test('mailbox indexes union old history, recovery writes, and later direct canonical writes',async()=>{
  const {primary,env}=setup(),key='Inbox/logistics@example.com.json';
  const entry=n=>({key:'Inbox/a/sent/'+n+'.json',timestamp:String(n)});
  await primary.put(key,JSON.stringify([entry(1)]));await env.ARCHIVE.put(key,JSON.stringify([entry(2)]));
  await primary.put(key,JSON.stringify([entry(1),entry(3)]));
  assert.deepEqual((await(await env.ARCHIVE.get(key)).json()).map(e=>e.timestamp),['1','2','3']);
  await env.ARCHIVE.put(key,JSON.stringify([entry(4)]));
  assert.deepEqual((await(await env.ARCHIVE.get(key)).json()).map(e=>e.timestamp),['1','2','3','4']);
});

test('tombstones hide canonical objects and do not prevent a new conditional create',async()=>{
  const {primary,env}=setup(),key='MailOutbox/draft.json';await primary.put(key,'old');
  await env.ARCHIVE.delete(key);assert.equal(await env.ARCHIVE.get(key),null);assert.equal(await env.ARCHIVE.head(key),null);
  assert.ok(await env.ARCHIVE.put(key,'new',{onlyIf:{etagDoesNotMatch:'*'}}));assert.equal(await(await env.ARCHIVE.get(key)).text(),'new');
});

test('merged pagination and delimiter retain both buckets without resurrecting deleted records',async()=>{
  const {primary,env}=setup();for(const key of ['Inbox/a/x','Inbox/b/x','Inbox/c/x'])await primary.put(key,'a');
  await env.ARCHIVE.put('Inbox/d/x','b');await env.ARCHIVE.delete('Inbox/b/x');
  const keys=[];let cursor;do{const p=await env.ARCHIVE.list({prefix:'Inbox/',limit:2,cursor});keys.push(...p.objects.map(o=>o.key));cursor=p.truncated?p.cursor:null;}while(cursor);
  assert.deepEqual(keys,['Inbox/a/x','Inbox/c/x','Inbox/d/x']);
  const dirs=await env.ARCHIVE.list({prefix:'Inbox/',delimiter:'/'});assert.deepEqual(dirs.delimitedPrefixes,['Inbox/a/','Inbox/b/','Inbox/c/','Inbox/d/']);
});

test('reconciliation fails closed and retains all bytes; healthy copy verifies content and deletes',async()=>{
  const {primary,old,raw,env}=setup();await primary.put('MailOutbox/gone','old');await env.ARCHIVE.delete('MailOutbox/gone');await env.ARCHIVE.put('Inbox/a/sent/new','письмо');
  primary.failWrites=true;await assert.rejects(reconcileMailRecovery(env),/10001|internal/);assert.equal(old.data.size,2);
  primary.failWrites=false;const done=await reconcileMailRecovery(env);assert.equal(done.done,true);assert.equal(done.copied,1);assert.equal(done.deleted,1);assert.equal(old.data.size,2);
  assert.equal(await(await raw.ARCHIVE.get('Inbox/a/sent/new')).text(),'письмо');assert.equal(await raw.ARCHIVE.get('MailOutbox/gone'),null);
});

test('reconciliation detects a changed source and never deletes the replacement',async()=>{
  const {primary,old,env}=setup(),key='Inbox/a/sent/race';await env.ARCHIVE.put(key,'first');
  primary.afterWrite=async()=>{await old.put(RECOVERY_PREFIX+key,'second');};
  await assert.rejects(reconcileMailRecovery(env),/source changed/);assert.equal(await(await env.ARCHIVE.get(key)).text(),'second');
});

test('reconciliation unions newer canonical indexes and refuses a newer conflicting body',async()=>{
  const {primary,env}=setup(),key='Inbox/a.json';
  await env.ARCHIVE.put(key,JSON.stringify([{key:'Inbox/a/sent/1',timestamp:'1'}]));
  await primary.put(key,JSON.stringify([{key:'Inbox/a/sent/2',timestamp:'2'}]));
  await reconcileMailRecovery(env);assert.equal((await(await primary.get(key)).json()).length,2);
  await env.ARCHIVE.put('Inbox/a/sent/conflict','recovery');await primary.put('Inbox/a/sent/conflict','newer');
  primary.data.get('Inbox/a/sent/conflict').uploaded=new Date(Date.now()+10000);
  await assert.rejects(reconcileMailRecovery(env),/Newer canonical object conflicts/);
  assert.equal(await(await primary.get('Inbox/a/sent/conflict')).text(),'newer');
});
