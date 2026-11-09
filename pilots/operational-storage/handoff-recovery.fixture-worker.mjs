// Test fixture only. Also imported by the parent to share fixtures and deny network.
import './no-network.mjs';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { createHandoffRecoveryJournal } from './handoff-recovery.mjs';
const deny=()=>{throw Error('Network disabled for handoff file fixtures');};
// The explicit no-network preload blocks fetch and sockets. Cover DNS/datagrams and
// higher-level entrypoints too, in both parent and worker, before opening SQLite.
for(const [module,keys] of [[net,['connect','createConnection']],[tls,['connect']],[http,['request','get']],[https,['request','get']],[http2,['connect']],[dgram,['createSocket']]]) for(const key of keys) module[key]=deny;
for(const key of Object.keys(dns)) if(key.startsWith('resolve')||['lookup','lookupService','reverse'].includes(key)) {
 if(typeof dns[key]==='function') dns[key]=deny;
 if(typeof dns.promises[key]==='function') dns.promises[key]=deny;
}
for(const proto of [dns.Resolver.prototype,dns.promises.Resolver.prototype]) for(const key of Object.getOwnPropertyNames(proto)) if(key.startsWith('resolve')||key==='reverse') proto[key]=deny;
syncBuiltinESMExports();
export const config={namespace:'pilot-handoff-file-test',agents:{angela:'shadow','diana-helios':'shadow'}};
export function candidate() {
 const binding={agent:'angela',spreadsheetId:'fixture-workbook',tabId:1,caseId:'fixture-stable-case',threadId:'fixture-thread',checkpoint:'fixture-checkpoint',manualStage:'',responseId:'fixture-reply'};
 return {reservationId:'fixture-reservation',binding,sourceAssertion:{state:'current',doNotContact:false,purgeMarker:null,relationship:'unmapped',actionOutcome:'settled',responseId:binding.responseId},
  decisionAssertion:{kind:'substantive',decisionId:'fixture-decision',reviewerId:'fixture-reviewer',decidedAt:'2026-11-05T00:00:00.000Z',provenanceReference:'fixture-not-authentication',binding:structuredClone(binding)}};
}
export const observation=(expectedSequence,observationId,kind='erp_unknown',erpCaseId=null)=>({agent:'angela',reservationId:'fixture-reservation',expectedSequence,observationId,kind,erpCaseId});
export async function verifyNetworkDenied() {
 for(const invoke of [()=>fetch('https://fixture.invalid/'),()=>new net.Socket().connect(1,'127.0.0.1'),()=>dgram.createSocket('udp4'),()=>dns.lookup('fixture.invalid'),()=>http.request('http://fixture.invalid/'),()=>tls.connect(1)]) {
  let denied=false;try {await invoke();} catch(error) {denied=/Network disabled|Sockets disabled/.test(error.message);}
  if(!denied) throw Error('fixture_network_guard_missing');
 }
 return true;
}
if(!isMainThread) {
 await verifyNetworkDenied();
 const db=new DatabaseSync(workerData.path);db.exec('PRAGMA busy_timeout=3000');
 const journal=createHandoffRecoveryJournal({config,db});
 parentPort.postMessage({ready:true,networkDenied:true});
 const gate=new Int32Array(workerData.gate);
 if(Atomics.wait(gate,0,0,5000)==='timed-out') throw Error('fixture_gate_timeout');
 const results=[];
 for(const request of workerData.requests) {
  try {results.push({ok:true,result:journal[request.method](request.input)});}
  catch(error) {results.push({ok:false,error:error.message});}
 }
 if(workerData.dropResponse) {
  if(results.some(r=>!r.ok)) throw Error('fixture_commit_failed_before_lost_response');
  // Exit this worker after synchronous SQLite commits, without sending results.
  // This is response loss / worker exit, not a power-loss simulation.
  process.exit(0);
 }
 db.close();parentPort.postMessage({results});parentPort.close();
}
