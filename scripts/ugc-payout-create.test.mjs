import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createPayout} from './ugc-payout-create.mjs';
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ugc_creator_platforms(id TEXT, creator_id TEXT, platform TEXT, normalized_handle TEXT);
    CREATE TABLE ugc_creators(id TEXT, lifecycle_stage TEXT, updated_at INTEGER, stage_changed_at INTEGER);
    CREATE TABLE ugc_payouts(id TEXT, creator_id TEXT, creator_platform_id TEXT, platform TEXT, handle TEXT, amount_minor INTEGER, currency TEXT, status TEXT, payout_date TEXT, phone_masked TEXT, fps_bank_member_id TEXT, note TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER, product TEXT);
    CREATE TABLE ugc_payout_requisites(payout_id TEXT, fps_mobile_phone TEXT, first_name TEXT, last_name TEXT, patronymic TEXT, created_at INTEGER, updated_at INTEGER);
    INSERT INTO ugc_creator_platforms VALUES('p1','c1','instagram','anyanapanike');
    INSERT INTO ugc_creators VALUES('c1','agreed',0,0);`);
  const DB = {prepare(sql){let p=[];const q={bind(...a){p=a;return q},get statement(){return {sql,params:p}},async first(){return db.prepare(sql).get(...p)??null},async all(){return {results:db.prepare(sql).all(...p)}},async run(){return {meta:{changes:db.prepare(sql).run(...p).changes}}}};return q},
    async batch(st){for(const s of st)db.prepare(s.statement.sql).run(...s.statement.params);return []}};
  return {db, DB};
}
const input = {handle: '@AnyaNapanike', amount_rub: 453, phone: '8 (912) 345-67-89', bank: 'Сбербанк', first_name: 'Анна', evidence: 'Скрин корзины: TERMO 453 ₽'};
test('creates one awaiting payout with requisites; a second call reuses it', async t => {
  const {db, DB} = fixture(); t.after(() => db.close());
  const first = await createPayout(input, {DB, uuid: () => 'x1'});
  assert.equal(first.created, true); assert.equal(first.amount_minor, 45300);
  assert.equal(db.prepare('SELECT fps_mobile_phone FROM ugc_payout_requisites').get().fps_mobile_phone, '+79123456789');
  assert.match(db.prepare('SELECT note FROM ugc_payouts').get().note, /453/);
  const again = await createPayout(input, {DB, uuid: () => 'x2'});
  assert.equal(again.created, false); assert.equal(again.existing, 'x1');
});
test('refuses bad requisites, unknown blogger and missing evidence', async t => {
  const {db, DB} = fixture(); t.after(() => db.close());
  await assert.rejects(createPayout({...input, amount_rub: 5000}, {DB}), /requisites_invalid/);
  await assert.rejects(createPayout({...input, handle: 'nobody'}, {DB}), /creator_not_in_erp/);
  await assert.rejects(createPayout({...input, evidence: ''}, {DB}), /evidence_required/);
});
