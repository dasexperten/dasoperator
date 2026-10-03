import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const esbuildPath = createRequire(import.meta.url).resolve('esbuild', {paths:[root,join(root,'workers')]});
const {transformSync} = await import(pathToFileURL(esbuildPath).href);
const dir = mkdtempSync(join(tmpdir(),'ozon-period-'));
writeFileSync(join(dir,'helper.mjs'),transformSync(readFileSync(new URL('./ozon-perf-period.ts',import.meta.url),'utf8'),{loader:'ts',format:'esm'}).code);
const {salesPeriod,historicalCampaigns,mergeCpc,guardOzonCpc,echoedPeriodMatches}=await import(join(dir,'helper.mjs'));
const period={dateFrom:'2026-09-25',dateTo:'2026-10-02'};
test('closed sales window wins; missing/mixed/over-limit snapshots cannot create a report',()=>{
 assert.deepEqual(salesPeriod([{period_from:period.dateFrom,period_to:period.dateTo}]),period);
 assert.throws(()=>salesPeriod([]));
 assert.throws(()=>salesPeriod([{period_from:'2026-09-25',period_to:'2026-10-02'},{period_from:'2026-09-26',period_to:'2026-10-03'}]));
 assert.throws(()=>salesPeriod([{period_from:'2026-01-01',period_to:'2026-10-02'}]));
});
test('paused and archived historical spend included, future/ended/display excluded',()=>{
 const rows=[
 {id:1,advObjectType:'SKU',state:'CAMPAIGN_STATE_RUNNING'},
 {id:2,advObjectType:'SKU',state:'CAMPAIGN_STATE_INACTIVE',fromDate:'2026-09-01',toDate:'2026-09-25'},
 {id:3,advObjectType:'SEARCH_PROMO',state:'CAMPAIGN_STATE_ARCHIVED'},
 {id:4,advObjectType:'SKU',fromDate:'2026-10-03'},
 {id:5,advObjectType:'SKU',toDate:'2026-09-24'},
 {id:6,advObjectType:'BANNER'},
 ];
 assert.deepEqual(historicalCampaigns(rows,period),['1','2','3']);
});
test('live echoed UTC+3 boundaries reject the old shifted window',()=>{
 assert.equal(echoedPeriodMatches({dateFrom:period.dateFrom,dateTo:period.dateTo},period),true);
 assert.equal(echoedPeriodMatches({from:'2026-09-24T21:00:00Z',to:'2026-10-02T20:59:59Z'},period),true);
 assert.equal(echoedPeriodMatches({dateFrom:'',dateTo:'',from:'2026-09-25T21:00:00Z',to:'2026-10-03T20:59:59Z'},period),false);
 assert.equal(echoedPeriodMatches({},period),false);
});
test('campaign batches aggregate shared SKUs instead of overwriting earlier campaigns',()=>{
 assert.deepEqual(mergeCpc({DE205:14000,DE201:8000},new Map([['DE205',234],['DE210',500]])),{DE205:14234,DE201:8000,DE210:500});
});
test('API rejects ratios based on legacy or shifted costs but preserves exact-window zero',()=>{
 const row={period_from:period.dateFrom,period_to:period.dateTo,cost_per_click_rub:8950432,expenses_total_rub:8950432};
 for(const r of [row,{...row,cpc_period_from:'2026-09-26',cpc_period_to:'2026-10-03'}]){
  const guarded=guardOzonCpc(r);
  assert.equal(guarded.cost_per_click_rub,null); assert.equal(guarded.expenses_total_rub,null);
  assert.equal(guarded.cost_per_click_unverified_rub,8950432);assert.equal(guarded.cpc_period_matches_sales,false);
 }
 const valid=guardOzonCpc({...row,cpc_period_from:period.dateFrom,cpc_period_to:period.dateTo,cost_per_click_rub:0});
 assert.equal(valid.cost_per_click_rub,0);assert.equal(valid.cpc_period_matches_sales,true);
});

// Exercise the actual poller against controlled D1/API responses, not a reimplementation.
const scheduled=readFileSync(new URL('../scheduled.ts',import.meta.url),'utf8').split('export async function handleScheduled(')[0]
 .replace(/^import .*$/gm,'')+'\nexport { cronCreatePerfReport };';
writeFileSync(join(dir,'poller.mjs'),`import {salesPeriod,historicalCampaigns,mergeCpc,echoedPeriodMatches} from './helper.mjs';\n`+transformSync(scheduled,{loader:'ts',format:'esm'}).code);
const {cronPollPerfReports}=await import(join(dir,'poller.mjs'));
function mockDb(report){
 const writes=[];const db={prepare(sql){return{args:[],bind(...args){this.args=args;return this;},async all(){
  if(sql.includes('FROM perf_reports'))return{results:[report]};
  if(sql.includes('SELECT DISTINCT'))return{results:[{period_from:period.dateFrom,period_to:period.dateTo}]};
  if(sql.includes('SELECT base_sku'))return{results:[{base_sku:'de205'}]};
  throw new Error(sql);
 },async run(){writes.push({sql,args:this.args});return{meta:{changes:1}};}};},async batch(stmts){writes.push({batch:stmts});}};
 return{db,writes};
}
function makeReport(overrides={}){return{uuid:'old',created_at:Math.floor(Date.now()/1000),date_from:period.dateFrom,date_to:period.dateTo,group_id:'group',remaining_campaigns:'[]',accumulated_cpc:'{}',checked_at:null,...overrides};}
const env=(db)=>({DB:db,OZON_PERF_CLIENT_ID:'test',OZON_PERF_CLIENT_SECRET:'test',OZON_CLIENT_ID:'test',OZON_API_KEY:'test'});
test('actual poller rejects echoed-window mismatch before downloading or changing sales',async()=>{
 const{db,writes}=mockDb(makeReport());const calls=[];const original=globalThis.fetch;
 globalThis.fetch=async(url)=>{calls.push(url);return{ok:true,json:async()=>url.endsWith('/token')?{access_token:'test'}:{state:'OK',link:'/download',request:{from:'2026-09-25T21:00:00Z',to:'2026-10-03T20:59:59Z'}}};};
 try{await cronPollPerfReports(env(db));}finally{globalThis.fetch=original;}
 assert.equal(calls.length,2);assert.equal(writes.some(w=>w.batch),false);
 assert.ok(writes.some(w=>w.sql.includes("status = 'error'")&&w.args[0].includes('period')));
});
test('actual poller carries totals to next ten campaigns without publishing a partial total',async()=>{
 const{db,writes}=mockDb(makeReport({remaining_campaigns:JSON.stringify(Array.from({length:12},(_,i)=>String(i+10))),accumulated_cpc:'{"de205":1000}'}));
 const original=globalThis.fetch;let next;
 globalThis.fetch=async(url,options)=>{
  if(url.endsWith('/token'))return{ok:true,json:async()=>({access_token:'test'})};
  if(url.endsWith('/old'))return{ok:true,json:async()=>({state:'OK',link:'/download',request:{dateFrom:period.dateFrom,dateTo:period.dateTo}})};
  if(url.endsWith('/download'))return{ok:true,text:async()=>JSON.stringify({'1':{report:{rows:[{sku:123,moneySpent:'2,34'}]}}})};
  if(url.endsWith('/product/list'))return{ok:true,json:async()=>({result:{items:[{offer_id:'de205'}]}})};
  if(url.endsWith('/product/info/list'))return{ok:true,json:async()=>({items:[{offer_id:'de205',sku:123}]})};
  if(url.endsWith('/statistics/json')){next=JSON.parse(options.body);return{ok:true,json:async()=>({UUID:'child'})};}
  throw new Error(url);
 };
 try{await cronPollPerfReports(env(db));}finally{globalThis.fetch=original;}
 assert.equal(next.campaigns.length,10);assert.equal(next.dateFrom,period.dateFrom);assert.equal(next.dateTo,period.dateTo);
 assert.equal(writes.some(w=>w.batch),false);
 const child=writes.find(w=>w.sql.includes('INSERT INTO perf_reports'));
 assert.equal(JSON.parse(child.args[5]).length,2);assert.equal(JSON.parse(child.args[6]).de205,1234);
});
