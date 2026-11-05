import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createPilotStore, pilotMode, sha256 } from './store.mjs';

const config = { namespace: 'pilot-unit', agents: { 'diana-helios': 'shadow', angela: 'shadow' } };
const decode = b => new TextDecoder().decode(b);
const bytes = x => new TextEncoder().encode(x);
function fixture(options = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const objects = new Map();
  const writes = [];
  const counters = { queries: 0, puts: 0, gets: 0 };
  const db = { prepare(sql) {
    counters.queries++;
    const statement = sqlite.prepare(sql);
    return { bind(...args) { return {
      first: async () => statement.get(...args) ?? null,
      run: async () => {
        if (options.failD1) throw new Error('D1 unavailable');
        const result = statement.run(...args);
        if (options.uncertainD1Write) throw new Error('D1 response lost after commit');
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    }; } };
  } };
  const bucket = {
    async get(key) {
      counters.gets++;
      if (options.failR2Read) throw new Error('R2 unavailable');
      const body = objects.get(key);
      if (options.missingReadback && counters.puts > 0) return null;
      return body ? { size: body.length, arrayBuffer: async () => body.slice().buffer } : null;
    },
    async put(key, body, metadata) {
      counters.puts++;
      if (options.failR2Write) throw new Error('R2 unavailable');
      assert.equal(metadata.sha256, await sha256(body));
      objects.set(key, options.corruptUpload ? bytes('corrupted') : body.slice());
      writes.push({key, metadata});
      if (options.uncertainR2Write) throw new Error('write outcome uncertain');
    },
  };
  const makeStore = (overrides = {}) => createPilotStore({config, db, bucket,
    authorize: async () => true, now: () => new Date('2026-11-05T06:00:00Z'), ...overrides});
  return {sqlite, objects, writes, counters, db, bucket, makeStore, store: makeStore()};
}
async function descriptor(body, changes = {}) {
  return {agent:'diana-helios', kind:'evidence', contentType:'text/plain; charset=utf-8',
    expectedSha256:await sha256(typeof body === 'string' ? bytes(body) : body),
    source:{type:'github',key:'dasexperten/organizacia:agents/diana-helios/data/example.txt',
      revision:'a'.repeat(40),originalUrl:`https://github.com/dasexperten/organizacia/blob/${'a'.repeat(40)}/agents/diana-helios/data/example.txt`},...changes};
}

test('default off, unsupported agents and invalid mode fail before storage I/O', async () => {
  const f = fixture(); const d = await descriptor('hello');
  assert.equal(pilotMode(undefined,'angela'),'off');
  for (const c of [undefined, {namespace:'pilot-unit',agents:{}}, {...config,agents:{angela:'off','diana-helios':'off'}}]) {
    await assert.rejects(f.makeStore({config:c}).importSnapshot(d,'hello'),/pilot_disabled/);
  }
  for (const c of [{...config,agents:{angela:'primary'}},{namespace:'production',agents:config.agents},
    {...config,agents:{'diana':'shadow'}},{...config,enabled:true}]) {
    await assert.rejects(f.makeStore({config:c}).importSnapshot(d,'hello'),/invalid_/);
  }
  await assert.rejects(f.store.importSnapshot({...d,agent:'someone'},'hello'),/unsupported_agent/);
  assert.deepEqual(f.counters,{queries:0,puts:0,gets:0});
});
test('only explicitly enabled agent can use pilot; config mutation cannot enable', async () => {
  const f=fixture(); const c={namespace:'pilot-unit',agents:{angela:'shadow'}};
  const s=f.makeStore({config:c}); c.agents['diana-helios']='shadow';
  await assert.rejects(s.importSnapshot(await descriptor('x'),'x'),/pilot_disabled/);
  assert.equal(f.counters.queries,0);
});
test('authorization missing, false, non-boolean and thrown errors fail closed', async () => {
  const f=fixture(), d=await descriptor('x');
  for (const authorize of [undefined, async()=>false, async()=>({approved:true}), async()=>{throw Error('auth down');}]) {
    await assert.rejects(f.makeStore({authorize}).importSnapshot(d,'x'),/access_denied|auth down/);
  }
  assert.deepEqual(f.counters,{queries:0,puts:0,gets:0});
});
test('exact source bytes, URL and unknown status round trip without interpreting approval', async () => {
  const f=fixture();
  const body='{"status":"unknown","approved":true,"initializedAt":1720000000000,"seen":["old"],"version":41,"deliveryId":"remote-7"}\n';
  const d=await descriptor(body,{agent:'angela',kind:'queue-snapshot'});
  const result=await f.store.importSnapshot(d,body);
  const read=await f.store.readSnapshot('angela',result.manifest.manifest_id);
  assert.equal(decode(read.bytes),body);
  assert.equal(read.manifest.original_url,d.source.originalUrl);
  assert.equal(read.manifest.archive_only,1);
  assert.equal(read.manifest.integrity_state,'bytes-verified');
  assert.equal(read.manifest.verified,undefined);
  assert.equal(read.manifest.approved,undefined);
  assert.deepEqual(Object.keys(f.store).sort(),['importSnapshot','readSnapshot']);
});
test('idempotent duplicate and concurrent imports create one manifest and stable address', async () => {
  const f=fixture(), d=await descriptor('body');
  const results=await Promise.all(Array.from({length:8},()=>f.store.importSnapshot(d,'body')));
  assert.equal(new Set(results.map(r=>r.manifest.manifest_id)).size,1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM pilot_operational_manifests').get().n,1);
  const replay=await f.store.importSnapshot(d,'body');
  assert.equal(replay.replay,true);
  assert.equal(replay.manifest.imported_at,'2026-11-05T06:00:00.000Z');
});
test('same revision cannot replace data or metadata; old version remains readable', async () => {
  const f=fixture(), d=await descriptor('first');
  const initial=await f.store.importSnapshot(d,'first');
  for (const [changed,body] of [
    [{...d,expectedSha256:await sha256(bytes('second'))},'second'],
    [{...d,kind:'report'},'first'],
    [{...d,source:{...d.source,originalUrl:'https://example.test/replaced'}},'first'],
  ]) await assert.rejects(f.store.importSnapshot(changed,body),/source_revision_conflict/);
  const next={...await descriptor('second'),source:{...d.source,revision:'b'.repeat(40)}};
  const second=await f.store.importSnapshot(next,'second');
  assert.notEqual(initial.manifest.manifest_id,second.manifest.manifest_id);
  assert.equal(decode((await f.store.readSnapshot(d.agent,initial.manifest.manifest_id)).bytes),'first');
});
test('expected SHA256 required and mismatch writes nothing', async () => {
  const f=fixture(), d=await descriptor('expected');
  await assert.rejects(f.store.importSnapshot(d,'different'),/source_hash_mismatch/);
  await assert.rejects(f.store.importSnapshot({...d,expectedSha256:'a'.repeat(40)},'expected'),/invalid_expected_sha256/);
  assert.deepEqual(f.counters,{queries:0,puts:0,gets:0});
});
test('R2 outage and partial/corrupt upload never commit a verified manifest', async () => {
  for (const failure of ['failR2Read','failR2Write','corruptUpload']) {
    const f=fixture({[failure]:true});
    await assert.rejects(f.store.importSnapshot(await descriptor('proof'),'proof'),/R2 unavailable|object_integrity_failure/);
    assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM pilot_operational_manifests').get().n,0);
  }
});
test('uncertain R2 write is reconciled on retry without another upload', async () => {
  const options={uncertainR2Write:true}, f=fixture(options), d=await descriptor('proof');
  await assert.rejects(f.store.importSnapshot(d,'proof'),/uncertain/);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM pilot_operational_manifests').get().n,0);
  options.uncertainR2Write=false;
  const result=await f.store.importSnapshot(d,'proof');
  assert.equal(f.counters.puts,1); assert.equal(result.manifest.archive_only,1);
});
test('D1 failure leaves an unreferenced blob and retry reuses it safely', async () => {
  const options={failD1:true}, f=fixture(options), d=await descriptor('proof');
  await assert.rejects(f.store.importSnapshot(d,'proof'),/D1 unavailable/);
  assert.equal(f.objects.size,1);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM pilot_operational_manifests').get().n,0);
  options.failD1=false;
  await f.store.importSnapshot(d,'proof');
  assert.equal(f.counters.puts,1);
});
test('D1 response lost after commit is reconciled as exact replay', async () => {
  const options={uncertainD1Write:true}, f=fixture(options), d=await descriptor('proof');
  await assert.rejects(f.store.importSnapshot(d,'proof'),/response lost/);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM pilot_operational_manifests').get().n,1);
  options.uncertainD1Write=false;
  const retried=await f.store.importSnapshot(d,'proof');
  assert.equal(retried.replay,true); assert.equal(f.counters.puts,1);
});
test('conflicting concurrent same-revision imports have one winner and no overwrite', async () => {
  const f=fixture(); const first=await descriptor('first'), second=await descriptor('second');
  const result=await Promise.allSettled([f.store.importSnapshot(first,'first'),f.store.importSnapshot(second,'second')]);
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
  const rejected=result.find(x=>x.status==='rejected');
  assert.match(rejected.reason.message,/source_revision_conflict/);
  const saved=result.find(x=>x.status==='fulfilled').value.manifest;
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM pilot_operational_manifests').get().n,1);
  const read=await f.store.readSnapshot(saved.agent_slug,saved.manifest_id);
  assert.ok(['first','second'].includes(decode(read.bytes)));
});
test('missing R2 readback cannot create a manifest', async () => {
  const f=fixture({missingReadback:true});
  await assert.rejects(f.store.importSnapshot(await descriptor('proof'),'proof'),/object_missing/);
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM pilot_operational_manifests').get().n,0);
});
test('oversized import and oversized object are refused', async () => {
  const f=fixture(), d=await descriptor('small');
  await assert.rejects(f.store.importSnapshot(d,new Uint8Array(32*1024*1024+1)),/payload_too_large/);
  assert.equal(f.counters.queries,0);
  const saved=await f.store.importSnapshot(d,'small');
  let read=false;
  const large=f.makeStore({bucket:{...f.bucket,get:async()=>({size:32*1024*1024+1,arrayBuffer:async()=>{read=true;return new ArrayBuffer(0);}})}});
  await assert.rejects(large.readSnapshot(d.agent,saved.manifest.manifest_id),/object_too_large/);
  assert.equal(read,false);
});
test('corrupted existing object is never overwritten or silently repaired', async () => {
  const f=fixture(), d=await descriptor('proof'), result=await f.store.importSnapshot(d,'proof');
  f.objects.set(result.manifest.object_key,bytes('corrupt'));
  await assert.rejects(f.store.readSnapshot(d.agent,result.manifest.manifest_id),/object_integrity_failure/);
  await assert.rejects(f.store.importSnapshot(d,'proof'),/object_integrity_failure/);
  assert.equal(f.counters.puts,1);
});
test('cross-agent and cross-namespace reads cannot resolve records', async () => {
  const f=fixture(), d=await descriptor('private'), result=await f.store.importSnapshot(d,'private');
  const angela=f.makeStore({authorize:async ({agent})=>agent==='angela'});
  await assert.rejects(angela.readSnapshot('diana-helios',result.manifest.manifest_id),/access_denied/);
  assert.equal(await angela.readSnapshot('angela',result.manifest.manifest_id),null);
  const other=f.makeStore({config:{...config,namespace:'pilot-other'}});
  assert.equal(await other.readSnapshot('diana-helios',result.manifest.manifest_id),null);
});
test('database corruption cannot read a different agent object or activate archive', async () => {
  const f=fixture(), d=await descriptor('private'), result=await f.store.importSnapshot(d,'private');
  assert.throws(()=>f.sqlite.exec("UPDATE pilot_operational_manifests SET source_key='changed'"),/append-only/);
  assert.throws(()=>f.sqlite.exec('DELETE FROM pilot_operational_manifests'),/append-only/);
  // Simulate corruption beyond normal clients, who cannot update any manifest.
  f.sqlite.exec('DROP TRIGGER pilot_manifests_no_update');
  f.sqlite.prepare('UPDATE pilot_operational_manifests SET object_key=?').run('Social/angela/offers/existing/page.json');
  await assert.rejects(f.store.readSnapshot(d.agent,result.manifest.manifest_id),/manifest_integrity_failure/);
  assert.throws(()=>f.sqlite.exec('UPDATE pilot_operational_manifests SET archive_only=0'),/CHECK/);
});
test('source identity is rechecked on read even after database corruption', async () => {
  const f=fixture(), d=await descriptor('private'), result=await f.store.importSnapshot(d,'private');
  f.sqlite.exec("DROP TRIGGER pilot_manifests_no_update; UPDATE pilot_operational_manifests SET source_revision='tampered'");
  await assert.rejects(f.store.readSnapshot(d.agent,result.manifest.manifest_id),/manifest_integrity_failure/);
});
test('INSERT OR REPLACE cannot replace an existing manifest with recursive triggers off', async () => {
  const f=fixture(), d=await descriptor('private');
  await f.store.importSnapshot(d,'private');
  f.sqlite.exec('PRAGMA recursive_triggers = OFF');
  const before=f.sqlite.prepare('SELECT * FROM pilot_operational_manifests').get();
  const row={...before,content_type:'text/html'};
  const cols=Object.keys(row);
  f.sqlite.prepare(`INSERT OR REPLACE INTO pilot_operational_manifests (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`).run(...Object.values(row));
  assert.deepEqual(f.sqlite.prepare('SELECT * FROM pilot_operational_manifests').get(),before);
});
test('mutable caller input is frozen before asynchronous authorization', async () => {
  const f=fixture(), body=bytes('before'), d=await descriptor(body);
  const s=f.makeStore({authorize:async()=>{ body.fill(0); d.source.key='changed'; return true; }});
  const result=await s.importSnapshot(d,body);
  assert.equal(decode((await s.readSnapshot('diana-helios',result.manifest.manifest_id)).bytes),'before');
  assert.notEqual(result.manifest.source_key,'changed');
});
test('Node Buffer is copied, never a shared Buffer.slice view', async () => {
  const f=fixture(), body=Buffer.from('before'), d=await descriptor(body);
  const s=f.makeStore({authorize:async()=>{body.fill(0);return true;}});
  const result=await s.importSnapshot(d,body);
  assert.equal(decode((await s.readSnapshot('diana-helios',result.manifest.manifest_id)).bytes),'before');
});
test('inherited config properties cannot activate an agent or satisfy required fields', () => {
  Object.prototype.angela='shadow';
  Object.prototype.namespace='pilot-unit';
  try {
    assert.equal(pilotMode({namespace:'pilot-unit',agents:{}},'angela'),'off');
    assert.throws(()=>pilotMode({agents:{}},'angela'),/invalid_pilot_config/);
  } finally { delete Object.prototype.angela; delete Object.prototype.namespace; }
});
test('inherited optional source URL is never persisted', async () => {
  const f=fixture(), d=await descriptor('x'); delete d.source.originalUrl;
  Object.prototype.originalUrl='javascript:alert(1)';
  try {
    const result=await f.store.importSnapshot(d,'x');
    assert.equal(result.manifest.original_url,null);
  } finally { delete Object.prototype.originalUrl; }
});
test('accessor descriptors cannot change values between validation and copying', async () => {
  const f=fixture(), d=await descriptor('x'); let reads=0;
  Object.defineProperty(d,'contentType',{enumerable:true,get(){reads++;return reads<3?'text/plain':'text/html\r\nX: 1';}});
  await assert.rejects(f.store.importSnapshot(d,'x'),/invalid_descriptor/);
  assert.equal(reads,0); assert.equal(f.counters.queries,0);
  const source=await descriptor('x');
  Object.defineProperty(source.source,'revision',{enumerable:true,get(){throw Error('getter executed');}});
  await assert.rejects(f.store.importSnapshot(source,'x'),/invalid_source/);
});
test('empty and binary evidence bytes are preserved, malformed descriptors are refused', async () => {
  const f=fixture();
  for (const body of [new Uint8Array(),new Uint8Array([0,255,4,128])]) {
    const d=await descriptor(body,{source:{type:'r2',key:`original-${body.length}`,revision:'snapshot-1'},contentType:'application/octet-stream'});
    const r=await f.store.importSnapshot(d,body);
    assert.deepEqual((await f.store.readSnapshot(d.agent,r.manifest.manifest_id)).bytes,body);
  }
  const d=await descriptor('x');
  for (const change of [{kind:'publish'}, {contentType:'text/html\r\nX: 1'}, {approved:true},
    {source:{...d.source,originalUrl:'https://user:secret@example.test/file'}}, {source:{...d.source,key:'a\u0000b'}}]) {
    await assert.rejects(f.store.importSnapshot({...d,...change},'x'),/invalid_/);
  }
});
test('new pilot schema never touches source tables or legacy export/delivery markers', async () => {
  const f=fixture();
  f.sqlite.exec(`CREATE TABLE org_task_runs (id INTEGER PRIMARY KEY, status TEXT, exported_at TEXT);
    INSERT INTO org_task_runs VALUES (1,'missed',NULL);
    CREATE TABLE angela_article_queue (id TEXT PRIMARY KEY, state TEXT, version INTEGER);
    INSERT INTO angela_article_queue VALUES ('state','{"initializedAt":1,"seen":["old"],"status":"unknown"}',17);`);
  const legacy=JSON.stringify(f.sqlite.prepare('SELECT * FROM angela_article_queue').all());
  f.objects.set('Social/angela/offers/old/main.json',bytes('{"status":"unknown"}'));
  await f.store.importSnapshot(await descriptor('copy'),'copy');
  assert.equal(JSON.stringify(f.sqlite.prepare('SELECT * FROM angela_article_queue').all()),legacy);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM org_task_runs WHERE status='missed' AND exported_at IS NULL").get().n,1);
  assert.equal(decode(f.objects.get('Social/angela/offers/old/main.json')),'{"status":"unknown"}');
});
