/** Pinned production selector, synthetic SQLite rows only. Never imports/runs purge. */
import './no-network.mjs';
import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const external = process.env.UGC_SCHEMA_SOURCE;
const root = external || fileURLToPath(new URL('./erp-handoff-fixtures/', import.meta.url));
const now = 1800000000000, week = 7 * 24 * 3600 * 1000;
const hash = data => createHash('sha256').update(data).digest('hex');
let schema, selector;
if (root) {
  const source = readFileSync(join(root, external ? 'originals/api/src/lib/ugc-silent-purge.ts' : 'ugc-silent-purge.ts.fixture.txt'));
  schema = readFileSync(join(root, 'purge-schema.sql'));
  assert.equal(hash(source), '0d829586d85eb2791301ee320eb2b44f544e8a2adeda4305b53e4f65e2a1d4ab');
  assert.equal(hash(schema), 'b71f8da41691b23512da454b15f172e47ccb44cae00b9d4108e35f6eaae7da37');
  const matches = [...source.toString('utf8').matchAll(/env\.DB\.prepare\(`(\s*SELECT c\.id,[\s\S]*?LIMIT \?2)`\)/g)];
  assert.equal(matches.length, 1, 'Pinned selector extraction must be exact, not a rewritten query');
  selector = matches[0][1];
}
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(schema.toString('utf8'));
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  t.after(() => db.close());
  return db;
}
function creator(db, id, {stage='', platform='instagram', createdAt=now-week-1, handle=id}={}) {
  db.prepare(`INSERT INTO ugc_creators(id,normalized_handle,lifecycle_stage,notes,created_at,updated_at)
    VALUES(?,?,?,'synthetic preserved notes',?,?)`).run(id,handle,stage,createdAt,createdAt);
  db.prepare(`INSERT INTO ugc_creator_platforms(id,creator_id,platform,handle,normalized_handle,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run('p-'+id,id,platform,handle,handle,createdAt,createdAt);
}
function collaboration(db, id, status) {
  db.prepare(`INSERT INTO ugc_collaborations(id,creator_id,platform,status,notes,created_at,updated_at)
    VALUES(?,?,'instagram',?,'synthetic discussion',?,?)`).run('co-'+id,id,status,now,now);
}
function message(db, id, username, direction='in') {
  db.prepare(`INSERT INTO ugc_ig_messages(id,conversation_id,direction,from_username,created_at,seen_at)
    VALUES(?, 'synthetic-conversation', ?, ?, 'synthetic-time', 'synthetic-time')`).run(id,direction,username);
}
function selected(db) { return db.prepare(selector).all(now-week,200).map(r=>r.id).sort(); }
function rows(db, table) { return db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(); }

describe('actual pinned ERP purge selector, local synthetic state only', () => {
  test('schema uses original accepted_at triggers and enforced FKs', t => {
    const db=fixture(t); creator(db,'blank'); creator(db,'agreed',{stage:'agreed'});
    assert.equal(db.prepare('SELECT accepted_at FROM ugc_creators WHERE id=?').get('blank').accepted_at,null);
    assert.ok(Number.isInteger(db.prepare('SELECT accepted_at FROM ugc_creators WHERE id=?').get('agreed').accepted_at));
    assert.throws(()=>db.prepare('DELETE FROM ugc_creators WHERE id=?').run('blank'),/FOREIGN KEY/);
  });
  test('only old empty or silent Instagram creators are selected', t => {
    const db=fixture(t);
    for (const stage of ['', 'silent', 'replied', 'agreed', 'refused', 'failed']) creator(db,'stage-'+(stage||'blank'),{stage});
    creator(db,'too-new',{createdAt:now-week+1});
    creator(db,'boundary',{createdAt:now-week});
    creator(db,'non-instagram',{platform:'threads'});
    assert.deepEqual(selected(db),['boundary','stage-blank','stage-silent']);
  });
  test('genuine replied collaboration protects blank stage without agreement', t => {
    const db=fixture(t);creator(db,'qualified');
    const before=rows(db,'ugc_creators');collaboration(db,'qualified','replied');
    assert.deepEqual(selected(db),[]);assert.deepEqual(rows(db,'ugc_creators'),before);
    assert.equal(before[0].lifecycle_stage,'');assert.equal(before[0].accepted_at,null);
    assert.equal(rows(db,'ugc_collaborations')[0].accepted_at,null);
  });
  test('found and silent collaborations do not protect; new currently does', t => {
    const db=fixture(t);
    for(const status of ['', 'found', 'silent', 'new', 'replied']) {creator(db,'co-'+(status||'blank'));collaboration(db,'co-'+(status||'blank'),status);}
    assert.deepEqual(selected(db),['co-blank','co-found','co-silent']);
  });
  test('inbound current handle is case-insensitive; outbound does not qualify', t => {
    const db=fixture(t);creator(db,'incoming');creator(db,'outgoing');
    message(db,'m-in','INCOMING');message(db,'m-out','outgoing','out');
    assert.deepEqual(selected(db),['outgoing']);
  });
  test('historical alias inbound alone is a known selector gap', t => {
    const db=fixture(t);creator(db,'renamed',{handle:'current_name'});
    db.prepare(`INSERT INTO ugc_handle_history(id,creator_platform_id,platform,old_handle,new_handle,evidence,changed_at)
      VALUES('h','p-renamed','instagram','old_name','current_name','synthetic evidence','synthetic time')`).run();
    message(db,'m-old','old_name');assert.deepEqual(selected(db),['renamed']);
  });
  test('manual-stage record, archive and notes alone are not purge exclusions', t => {
    const db=fixture(t);creator(db,'manual');
    db.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?,?,?)`).run('manual_stage:manual',JSON.stringify({from:'replied',to:'',by:'synthetic-user',at:now,reviewed_at:null}),now);
    db.prepare('UPDATE ugc_creators SET archived_at=? WHERE id=?').run(now,'manual');
    assert.deepEqual(selected(db),['manual']);
  });
  test('existing source evidence excludes a card without changing lifecycle', t => {
    const db=fixture(t);creator(db,'source');
    db.prepare(`INSERT INTO ugc_source_records(id,creator_id,kind,source_document,source_sheet,source_row,imported_at)
      VALUES('s','source','product_reference','synthetic doc','synthetic tab',1,?)`).run(now);
    assert.deepEqual(selected(db),[]);
  });
  test('existing content excludes a card without changing lifecycle', t => {
    const db=fixture(t);creator(db,'content');
    db.prepare(`INSERT INTO ugc_content(id,creator_id,creator_platform_id,imported_at,updated_at)
      VALUES('k','content','p-content',?,?)`).run(now,now);
    assert.deepEqual(selected(db),[]);
  });
  test('existing synthetic payout row is an exclusion, never a handoff workaround', t => {
    const db=fixture(t);creator(db,'payout');
    db.prepare(`INSERT INTO ugc_payouts(id,creator_id,amount_minor,payout_date,created_at,updated_at)
      VALUES('y','payout',1,'synthetic-date',?,?)`).run(now,now);
    assert.deepEqual(selected(db),[]);
  });
  test('candidate selection is bounded to the source batch size', t => {
    const db=fixture(t);for(let i=0;i<205;i++)creator(db,'fixture-'+i);
    assert.equal(selected(db).length,200);
    assert.equal(db.prepare('SELECT count(*) n FROM ugc_creators').get().n,205);
  });
  test('selection before a discussion is stale; a new SELECT is not a deletion fence', t => {
    const db=fixture(t);creator(db,'racing');const stale=selected(db);
    collaboration(db,'racing','replied');assert.deepEqual(selected(db),[]);
    assert.deepEqual(stale,['racing']);
    // The original worker later dispatches deletes from its saved list. This
    // test never does that and does not claim SELECT holds a lock or rechecks.
    assert.equal(rows(db,'ugc_collaborations').length,1);
  });
});
