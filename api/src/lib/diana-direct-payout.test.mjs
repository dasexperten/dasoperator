import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {createRequire} from 'node:module';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const dir=mkdtempSync(join(tmpdir(),'direct-payout-'));
await createRequire(import.meta.url)('esbuild').build({entryPoints:[fileURLToPath(new URL('./diana-direct-payout.mjs',import.meta.url))],bundle:true,platform:'node',format:'esm',outfile:join(dir,'handoff.mjs'),plugins:[{name:'forbid-effects',setup(b){b.onResolve({filter:/(?:ig-dm-image-cache|ig-dm-watch|diana-subscription\.mjs)$/},()=>({path:'effects',namespace:'mock'}));b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:'export const imageUrls=s=>JSON.parse(s||"[]").filter(x=>x.image_data).map(x=>x.image_data.url);export const loadInstagramImage=async()=>{throw Error("unexpected image read")};export const refreshIgAttachments=async()=>{throw Error("archive repair forbidden")};export const subscriptionInfer=()=>{throw Error("legacy model runner forbidden")};'}));}}]});
const {handoffDirectPayout,textAmount,stable}=await import(pathToFileURL(join(dir,'handoff.mjs')));rmSync(dir,{recursive:true});
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`CREATE TABLE ugc_creators(id TEXT PRIMARY KEY,normalized_handle TEXT,lifecycle_stage TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE ugc_creator_platforms(id TEXT PRIMARY KEY,creator_id TEXT,platform TEXT,handle TEXT,normalized_handle TEXT,profile_url TEXT,source TEXT,created_at INTEGER,updated_at INTEGER,UNIQUE(platform,normalized_handle));
 CREATE TABLE ugc_payouts(id TEXT PRIMARY KEY,creator_id TEXT,creator_platform_id TEXT,platform TEXT,handle TEXT,amount_minor INTEGER,currency TEXT,status TEXT,payout_date TEXT,marketplace TEXT,phone_masked TEXT,bank_ref TEXT,fps_bank_member_id TEXT,product TEXT,note TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER,konsol_payment_id TEXT,execute_claim TEXT,paid_at TEXT,sent_at TEXT,approved_at TEXT,approved_by TEXT);
 CREATE TABLE ugc_payout_requisites(payout_id TEXT PRIMARY KEY,fps_mobile_phone TEXT,first_name TEXT,last_name TEXT,patronymic TEXT,created_at INTEGER,updated_at INTEGER);
 CREATE TABLE crm_sync_state(key TEXT PRIMARY KEY,value TEXT,updated_at INTEGER);
 CREATE TABLE ugc_ig_messages(id TEXT,conversation_id TEXT,direction TEXT,from_username TEXT,created_at TEXT,attachments_json TEXT);
 INSERT INTO ugc_ig_messages VALUES('amount','chat','in','alice','2026-11-08T10:00:00Z',NULL),('bank','chat','in','alice','2026-11-08T11:00:00Z',NULL),('new-bank','chat','in','alice','2026-11-09T11:00:00Z',NULL);`);
 db.exec("UPDATE ugc_ig_messages SET attachments_json='[{}]' WHERE id='new-bank'");
 const DB={prepare(sql){let params=[];return {statement:{sql,get params(){return params}},bind(...p){params=p;return this},async first(){return db.prepare(sql).get(...params)??null}}},async batch(qs){db.exec('BEGIN');try{const results=qs.map(q=>/^\s*SELECT/.test(q.statement.sql)?{success:true,results:db.prepare(q.statement.sql).all(...q.statement.params)}:{success:true,meta:{changes:db.prepare(q.statement.sql).run(...q.statement.params).changes}});db.exec('COMMIT');return results}catch(e){db.exec('ROLLBACK');throw e}}};
 return {db,env:{DB}};
}
function setup(){const f=fixture();const prepare=f.env.DB.prepare;f.env.DB.prepare=sql=>{if(sql.includes('ugc_ig_messages'))throw Error('ERP chat read/write forbidden');return prepare(sql);};f.env.DOCS={put(){throw Error('R2 write forbidden')},get(){throw Error('R2 read forbidden')}};const source={status:'ready',conversationId:'chat',messageId:'details',messages:[{id:'amount',from:{id:'person',username:'alice'},message:'Итого 453 руб',created_time:'2026-11-09T10:00:00Z'},{id:'details',from:{id:'person',username:'alice'},message:'89990000000 ТБанк Елена',created_time:'2026-11-09T10:01:00Z'}]};const event={cid:'chat',message_id:'details',event_id:'message:details'};return{...f,source,event,args:{env:f.env,event,source,refreshOriginal:async()=>structuredClone(source),infer:async()=>{throw Error('text needs no vision')}}};}
test('active handoff persists only approval/payment facts; replay produces no duplicate',async()=>{const f=setup();try{const a=await handoffDirectPayout(f.args),b=await handoffDirectPayout(f.args);assert.equal(a.status,'registered');assert.equal(a.amount_minor,45300);assert.equal(a.payout_id,b.payout_id);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_payouts').get().n,1);assert.equal(f.db.prepare('SELECT status FROM ugc_payouts').get().status,'awaiting_approval');const states=f.db.prepare('SELECT value FROM crm_sync_state').all().map(x=>x.value).join(' ');assert.ok(!states.includes('Итого 453 руб'));assert.ok(!states.includes('89990000000 ТБанк Елена'));assert.ok(!JSON.stringify(a).includes('phone'));}finally{f.db.close();}});
test('missing amount: Owner 2026-11-12 no 0.01 ₽ button, the amount is asked first',async()=>{const f=setup();try{f.source.messages[0].message='Здравствуйте';const result=await handoffDirectPayout(f.args);assert.equal(result.status,'amount_needed');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_payouts').get().n,0);}finally{f.db.close();}});
test('fresh edit to earlier source blocks stale registration',async()=>{const f=setup();try{f.args.refreshOriginal=async()=>{const s=structuredClone(f.source);s.messages[0].message='Итого 499 руб';return s;};assert.equal((await handoffDirectPayout(f.args)).reason,'payout_original_changed');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_payouts').get().n,0);}finally{f.db.close();}});
test('dry run never reads or saves and returns only closed metadata',async()=>{const f=setup();try{f.event.dryRun=true;f.args.refreshOriginal=()=>{throw Error('must not run')};assert.equal((await handoffDirectPayout(f.args)).reason,'payout_preview_no_write');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_payouts').get().n,0);}finally{f.db.close();}});
test('paid cycle never registers a second row',async()=>{const f=setup();try{await handoffDirectPayout(f.args);f.db.exec("UPDATE ugc_payouts SET status='paid',konsol_payment_id='provider',paid_at='2026-11-10T12:00:00Z'");assert.equal((await handoffDirectPayout(f.args)).reason,'payout_cycle_already_processed');assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_payouts').get().n,1);}finally{f.db.close();}});
test('image cart is independently read transiently, no image cache/archive or legacy inference',async t=>{const f=setup();try{
 f.env.GITHUB_TOKEN='test';f.source.messages[0].message='';f.source.messages[0].attachments={data:[{mime_type:'image/jpeg',image_data:{url:'https://example.test/image'}}]};
 const policy={product:{name:'TERMO'},sellers:['shop']};t.mock.method(globalThis,'fetch',async url=>{assert.match(url,/api.github.com/);return Response.json({sha:'a'.repeat(40),encoding:'base64',content:Buffer.from(JSON.stringify(policy)).toString('base64')});});
 let reads=0,models=0;f.args.readImage=async(_env,id)=>{assert.equal(id,undefined);reads++;return{mediaType:'image/jpeg',data:'ZmFrZQ=='}};
 f.args.infer=async()=>{models++;return{text:JSON.stringify({kind:'basket',product:'yes',seller:'yes',amount:'yes',seller_evidence:'explicit_shop',unresolved_required:[],what:'basket',visible_text:'453 RUB',observed:{product_name:'TERMO',price:'453',currency:'RUB',payment_status:null,delivery_status:null,seller_name:'shop'},requisites:{holder_name:null,bank:null,phone:null,card:null,amount:null,currency:null}})};};
 const result=await handoffDirectPayout(f.args);assert.equal(result.status,'registered');assert.equal(result.amount_minor,45300);assert.equal(reads,1);assert.equal(models,1);
 assert.ok(!f.db.prepare('SELECT value FROM crm_sync_state').all().some(x=>x.value.includes('visible_text')));
 }finally{f.db.close();}});

test('Owner 2026-11-11: unknown media after the details never blocks the button; a screen amount waits',async()=>{
 for(const earlier of [false,true]){const f=setup();try{
 const unknown={id:'unknown',from:{id:'person',username:'alice'},is_unsupported:true,message:'',created_time:earlier?'2026-11-09T09:00:00Z':'2026-11-09T10:00:30Z'};
 f.source.messages.splice(earlier?0:1,0,unknown);
 const result=await handoffDirectPayout(f.args);assert.equal(result.status,earlier?'registered':'amount_needed');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_payouts').get().n,earlier?1:0);
 }finally{f.db.close();}}
});
test('older selected amount extends unreadable guard beyond short requisites cluster',async()=>{
 const f=setup();try{
 f.source.messages[0].created_time='2026-11-09T09:00:00Z';
 f.source.messages.splice(1,0,{id:'unknown',from:{id:'person',username:'alice'},is_unsupported:true,message:'',created_time:'2026-11-09T09:30:00Z'});
 assert.equal((await handoffDirectPayout(f.args)).status,'amount_needed');
 assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_payouts').get().n,0);
 }finally{f.db.close();}
});
test('out-of-order full source cannot assert latest original',async()=>{
 const f=setup();try{f.source.messages[0].created_time='2026-11-09T10:02:00Z';await assert.rejects(handoffDirectPayout(f.args),/source_identity/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM ugc_payouts').get().n,0);}finally{f.db.close();}
});

test('persisted financial proof truthfully references transient hash and exact amount source, not nonexistent ERP cart',async()=>{
 const f=setup();try{
 await handoffDirectPayout(f.args);
 const record=f.db.prepare("SELECT value FROM crm_sync_state WHERE key LIKE 'diana_payout_intake:%'").get();const proof=JSON.parse(record.value),cart=proof.verified_cart;
 assert.equal(cart.evidence_kind,'transient_original');assert.match(cart.source_sha256,/^[a-f0-9]{64}$/);assert.equal(cart.source_message_id,'amount');assert.equal(cart.amount_minor,45300);assert.equal(cart.authority,'incoming_text');assert.equal('receipt_key' in cart,false);
 assert.equal(f.db.prepare("SELECT COUNT(*) n FROM crm_sync_state WHERE key LIKE 'ugc_cart_review:%'").get().n,0);
 assert.equal(record.value.includes('Итого 453 руб'),false);assert.equal(record.value.includes('89990000000 ТБанк Елена'),false);
 }finally{f.db.close();}
});
test('Owner 11.11: the creator text amount is read after our amount question or with a rouble mark',async()=>{

 assert.deepEqual(textAmount([{id:'q',direction:'out',text:'Подскажите сумму к оплате текстом?'},{id:'a',direction:'in',text:'432'}]),{amount_minor:43200,source_message_id:'a'});
 assert.deepEqual(textAmount([{id:'a',direction:'in',text:'Итого 453,50 ₽'}]),{amount_minor:45350,source_message_id:'a'});
 assert.equal(textAmount([{id:'a',direction:'in',text:'Мне 25 лет'}]),null);
 assert.equal(textAmount([{id:'q',direction:'out',text:'сумму?'},{id:'a',direction:'in',text:'+7 999 123 45 67 Сбер Анна'}]),null);
 assert.equal(textAmount([{id:'q',direction:'out',text:'сумму?'},{id:'a',direction:'in',text:'3500'}]),null);
 assert.deepEqual(textAmount([{id:'q',direction:'out',text:'сумму?'},{id:'a',direction:'in',text:'1037'}]),{amount_minor:103700,source_message_id:'a'});
});

test('Meta re-signing image links between two reads is not a change of the conversation',async()=>{
 const m=sig=>[{id:'1',direction:'in',from_id:'p',text:'',created_at:'t',unsupported:false,attachments:[{mime_type:'image/jpeg',image_data:{url:'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=111&signature='+sig}}]}];
 assert.equal(stable(m('a')),stable(m('b')));
 const other=m('a');other[0].attachments[0].image_data.url='https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=222&signature=a';
 assert.notEqual(stable(m('a')),stable(other));
});
test('Owner 2026-11-11 (nazilya__85): text amount reads the marked price and ignores an old cycle',()=>{
 const at=s=>new Date(s).toISOString();
 const msgs=[
  {id:'old',direction:'in',text:'500',created_at:at('2026-02-24T09:51:08Z')},
  {id:'q',direction:'out',text:'Подскажите, какая паста у вас в корзине и сколько она стоит?',created_at:at('2026-11-11T07:39:00Z')},
  {id:'new',direction:'in',text:'Термо 39 \nЦена 445 р',created_at:at('2026-11-11T08:10:06Z')},
 ];
 assert.deepEqual(textAmount(msgs,Date.parse('2026-11-11T09:22:31Z')-7*86400000),{amount_minor:44500,source_message_id:'new'});
 assert.equal(textAmount(msgs.slice(0,1),Date.parse('2026-11-11T09:22:31Z')-7*86400000),null);
 assert.deepEqual(textAmount([{id:'a',direction:'in',text:'447',created_at:at('2026-11-08T12:00:00Z')},{id:'b',direction:'in',text:'Рублей',created_at:at('2026-11-08T12:00:05Z')}].map((m,i)=>i?m:{...m}),-Infinity),null); // bare 447 without a question stays unmarked
});
