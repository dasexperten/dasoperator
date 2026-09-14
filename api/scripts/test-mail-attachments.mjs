import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'mail-attachments-'));
const sqlite = new DatabaseSync(':memory:');
const nativeFetch = globalThis.fetch;
try {
  for (const [name, source] of [['receipt','lib/mail-send-receipt'],['send','lib/resend-human'],['archive','routes/email-archive'],['reply','routes/email-reply']]) {
    await build({ entryPoints: [`api/src/${source}.ts`], bundle:true, platform:'node', format:'esm', outfile:join(dir, `${name}.mjs`) });
  }
  const {sendHumanResend} = await import(join(dir, 'send.mjs'));
  const {default: archiveRoute} = await import(join(dir, 'archive.mjs'));
  const {default: replyRoute} = await import(join(dir, 'reply.mjs'));
  sqlite.exec(`CREATE TABLE users (id TEXT, name TEXT, role TEXT, active INTEGER, permissions TEXT);
    CREATE TABLE sessions (token TEXT, user_id TEXT, expires_at INTEGER);
    INSERT INTO users VALUES ('alice','Alice','admin',1,'{}');`);
  sqlite.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run('fixture-session-000001', 'alice', Date.now()+60000);
  sqlite.exec(await readFile('db/migrations/0085_mail_index_mirror.sql','utf8'));
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql); let args=[];
      return {bind(...values) { args=values.map(value=>value===undefined?null:value); return this; },
        async first(){return statement.get(...args)||null;}, async all(){return {results:statement.all(...args)};},
        async run(){return {success:true,meta:{changes:Number(statement.run(...args).changes)}};}};
    },
    async batch(statements){sqlite.exec('BEGIN'); try {const out=[]; for(const s of statements) out.push(await s.run()); sqlite.exec('COMMIT'); return out;}catch(e){sqlite.exec('ROLLBACK'); throw e;}}
  };
  const objects = new Map(); let failPut = null; let reads=0;
  const ARCHIVE = {
    async get(key){reads++; if(!objects.has(key))return null; const bytes=objects.get(key); return {size:bytes.length,etag:'test',text:async()=>new TextDecoder().decode(bytes),json:async()=>JSON.parse(new TextDecoder().decode(bytes)),arrayBuffer:async()=>bytes.slice().buffer,body:new Response(bytes).body};},
    async head(key){return objects.has(key)?{key}:null;},
    async put(key,data){if(failPut?.(key))throw new Error('fixture storage failure'); objects.set(key,typeof data==='string'?new TextEncoder().encode(data):new Uint8Array(data));return {etag:'test'};},
    async delete(keys){for(const key of Array.isArray(keys)?keys:[keys]) objects.delete(key);},
    async list({prefix}){return {objects:[...objects.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key})),truncated:false};}
  };
  const env={DB,ARCHIVE,RESEND_API_KEY:'fixture-key',MAIL_INDEX_WRITE:'append'};
  let posts=[]; let providerId='fixture-message-1';
  globalThis.fetch=async(url,options)=>{
    assert.equal(String(url),'https://api.resend.com/emails');
    posts.push({payload:JSON.parse(options.body),headers:options.headers});
    return new Response(JSON.stringify({id:providerId}));
  };
  const bytes=Uint8Array.from([0,255,10,128,42]);
  const input={from:'sales@dasexperten.com',to:['customer@example.com'],cc:['team@example.com'],bcc:['private@example.com'],subject:'Attachments',text:'A complete attachment test message that does not need body hydration.',in_reply_to:'<parent@example.com>',references:['<root@example.com>'],replyToTag:'abcd1234',idempotencyKey:'fixture-stable-request',attachments:[{filename:'договор.bin',mimeType:'application/octet-stream',content:bytes.buffer},{filename:'empty.txt',content:new ArrayBuffer(0)}]};
  let result=await sendHumanResend(env,input);
  assert.equal(result.success,true); assert.equal(result.archived,true);
  assert.deepEqual(Buffer.from(posts[0].payload.attachments[0].content,'base64'),Buffer.from(bytes));
  assert.deepEqual(posts[0].payload.bcc,['private@example.com']);
  assert.equal(posts[0].headers['Idempotency-Key'],'fixture-stable-request');
  assert.equal(posts[0].payload.headers.References,'<root@example.com> <parent@example.com>');
  const index=JSON.parse(new TextDecoder().decode(objects.get('Inbox/sales@dasexperten.com.json')));
  const key=index[0].key;
  const record=JSON.parse(new TextDecoder().decode(objects.get(key)));
  assert.equal(record.attachments.length,2); assert.equal(record.attachments[1].size,0);
  assert.deepEqual(objects.get(record.attachments[0].key),bytes);
  await sendHumanResend(env,input);
  assert.equal(JSON.parse(new TextDecoder().decode(objects.get('Inbox/sales@dasexperten.com.json'))).length,1);
  assert.equal(JSON.parse(new TextDecoder().decode(objects.get(key))).timestamp,record.timestamp);
  const path=`http://localhost/mailboxes/sales%40dasexperten.com/attachment?key=${encodeURIComponent(key)}&id=0`;
  const before=reads;
  assert.equal((await archiveRoute.request(path,{},env)).status,401); assert.equal(reads,before);
  const response=await archiveRoute.request(path,{headers:{Authorization:'Bearer fixture-session-000001'}},env);
  assert.equal(response.status,200); assert.deepEqual(new Uint8Array(await response.arrayBuffer()),bytes);
  assert.equal(response.headers.get('Cache-Control'),'private, no-store');
  assert(response.headers.get('Content-Disposition').includes(encodeURIComponent('договор.bin')));
  assert.equal((await archiveRoute.request(path.replace('&id=0','&id=99'),{headers:{Authorization:'Bearer fixture-session-000001'}},env)).status,404);
  assert.equal((await archiveRoute.request(path.replace('mailboxes/sales','mailboxes/legal'),{headers:{Authorization:'Bearer fixture-session-000001'}},env)).status,422);
  providerId='fixture-message-2'; failPut=key=>key.includes('/att/');
  result=await sendHumanResend(env,{...input,idempotencyKey:'fixture-next-request'});
  assert.equal(result.success,true); assert.equal(result.archived,false);
  assert([...objects.keys()].some(key=>key.startsWith('MailOutbox/')));
  failPut=key=>key.startsWith('MailOutbox/'); const count=posts.length;
  result=await sendHumanResend(env,input); assert.equal(result.success,false); assert.equal(posts.length,count);
  failPut=null;
  result=await sendHumanResend(env,{...input,attachments:[{filename:'large.bin',content:new ArrayBuffer(10*1024*1024+1)}]});
  assert.equal(result.success,false); assert.equal(posts.length,count);
  assert.equal((await replyRoute.request('http://localhost/reply',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer fixture-session-000001'},body:JSON.stringify({to:'customer@example.com',subject:'No draft',text:'Hello',attachment_ids:[crypto.randomUUID()]})},env)).status,422);
  providerId='fixture-message-route';
  const routePayload={to:'customer@example.com',bcc:'private@example.com',subject:'Route replay',text:input.text,send_id:'stable-route-attempt'};
  const routeRequest=()=>replyRoute.request('http://localhost/reply',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer fixture-session-000001'},body:JSON.stringify(routePayload)},env);
  assert.equal((await routeRequest()).status,200);
  const afterRoute=posts.length;
  assert.equal((await routeRequest()).status,200);
  assert.equal(posts.length,afterRoute);
  const {withMailSendReceipt} = await import(join(dir,'receipt.mjs'));
  const receipts=new Map(); let version=0; let dispatches=0;
  const receiptEnv={ARCHIVE:{
    async get(key){const value=receipts.get(key);return value?{etag:value.etag,json:async()=>JSON.parse(value.data)}:null;},
    async put(key,data,options){const current=receipts.get(key); if(options?.onlyIf?.etagDoesNotMatch==='*'&&current)return null;
      if(options?.onlyIf?.etagMatches&&current?.etag!==options.onlyIf.etagMatches)return null;
      const etag=String(++version);receipts.set(key,{etag,data});return {etag};}
  }};
  const deliver=async()=>{dispatches++;return {success:true,messageId:'accepted',archived:true};};
  await withMailSendReceipt(receiptEnv,'stable',{text:'body'},deliver);
  await withMailSendReceipt(receiptEnv,'stable',{text:'body'},deliver);
  assert.equal(dispatches,1);
  assert.equal((await withMailSendReceipt(receiptEnv,'stable',{text:'changed'},deliver)).success,false);
  let release; const barrier=new Promise(resolve=>{release=resolve;});
  const pending=withMailSendReceipt(receiptEnv,'concurrent',{text:'body'},async()=>{await barrier;return deliver();});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal((await withMailSendReceipt(receiptEnv,'concurrent',{text:'body'},deliver)).success,false);
  release(); await pending; assert.equal(dispatches,2);
  const old=JSON.parse(receipts.get('MailSendRequests/concurrent.json').data);
  old.status='sending';delete old.result;old.createdAt=Date.now()-25*60*60*1000;old.leaseUntil=0;
  receipts.get('MailSendRequests/concurrent.json').data=JSON.stringify(old);
  assert.equal((await withMailSendReceipt(receiptEnv,'concurrent',{text:'body'},deliver)).success,false);
  assert.equal(dispatches,2);
  console.log('Mail attachments: exact bytes, empty files, durable pre-send copy, truthful archive status, retry deduplication, BCC/thread headers, protected downloads and size limits passed.');
} finally { globalThis.fetch=nativeFetch; sqlite.close(); await rm(dir,{recursive:true,force:true}); }
