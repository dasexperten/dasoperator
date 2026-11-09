import type { Env } from './types';
import { pendingDianaMessages } from './lib/diana-alarm';
import { dispatchDianaCloud } from './lib/diana-cloud-dispatch';

// Owner 2026-11-07: ERP never hands Diana text or the whole queue. One dispatch carries at most 50 identifiers
// (oldest first); Diana reads the originals herself, and the rest follow on the next dispatch.
export const DIANA_BATCH = 50;
// Newest first, never the oldest backlog (Owner 2026-11-07: "the last 20 chats with no answer from our side").
// A chat whose newest message is ours (last_from_us === true) comes after every unanswered one.
const financialNotice=(item:any)=>['payout_paid_notice','payout_failed_notice'].includes(item.task);
const dianaTime = (item: any) => { const t = Date.parse(String(item.at ?? '')); return Number.isFinite(t) ? t : 0; };
export function dianaBatch(pending: any[], priorityEventId?: string) {
  return [...pending]
    .sort((a, b) => Number(b.event_id === priorityEventId && !!priorityEventId) - Number(a.event_id === priorityEventId && !!priorityEventId) || Number(financialNotice(b))-Number(financialNotice(a)) || (a.last_from_us === true ? 1 : 0) - (b.last_from_us === true ? 1 : 0) || dianaTime(b) - dianaTime(a))
    .slice(0, DIANA_BATCH)
    .map(item => String(item.event_id ?? '').startsWith('action:') ? item : ({
      cid: item.cid, message_id: item.message_id, event_id: item.event_id, handle: item.handle, display_name: item.display_name, at: item.at, reason: item.reason, queue_key: item.queue_key,
    }));
}

type Peer = { role: string; busy: boolean; seen?: number; inflight_event_ids?:string[]; deferred_event_ids?:string[]; dispatched_at?:string };
const RANK = ['primary', 'backup', 'secondary'];

// Persistent delivery channel, not another polling clock or model executor.
export class DianaWake {
  private cloudQueue: Promise<unknown> = Promise.resolve();
  constructor(private state: DurableObjectState, private env: Env) {}
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/connect') {
      const role = url.searchParams.get('role') ?? '';
      if (!RANK.includes(role)) return new Response('', { status: 400 });
      const pair = new WebSocketPair();
      for (const old of this.state.getWebSockets()) {
        if ((old.deserializeAttachment() as Peer)?.role === role) old.close(1000, 'replaced');
      }
      this.state.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ role, busy: false, seen: Date.now() } satisfies Peer);
      pair[1].send(JSON.stringify({ type: 'connected' }));
      return new Response(null, { status: 101, webSocket: pair[0], headers: { 'Sec-WebSocket-Protocol': 'diana-wake' } });
    }
    if (url.pathname === '/status') return Response.json({ connections: this.state.getWebSockets().map(ws => ws.deserializeAttachment()),round_claim:await this.roundClaim() });
    let priorityEventId:string|undefined;
    try{const body=await request.json() as {priority_event_id?:unknown};if(typeof body.priority_event_id==='string')priorityEventId=body.priority_event_id;}catch{}
    return Response.json(await this.dispatch(priorityEventId));
  }
  private async roundClaim(){
    const row=await this.env.DB.prepare("SELECT updated_at FROM crm_sync_state WHERE key='diana_round_claim'").first<{updated_at:number}>();
    return{active:!!row&&Date.now()-Number(row.updated_at)<180_000,updated_at:row?.updated_at??null};
  }
  private async dispatch(priorityEventId?:string,justReturned:string[]=[]){
    const mode=await this.env.DB.prepare("SELECT (SELECT value FROM crm_sync_state WHERE key='diana_execution_mode') value,(SELECT value FROM crm_sync_state WHERE key='diana_cloud_mode') cloud").first<{value:string;cloud:string}>();
    if(mode?.cloud==='enabled'){
      const result=this.cloudQueue.then(()=>dispatchDianaCloud(this.env,priorityEventId));
      this.cloudQueue=result.catch(()=>undefined);return result;
    }
    const directOnly=mode?.value==='direct_only_primary';
    const peers=this.state.getWebSockets().filter(ws=>(!directOnly||(ws.deserializeAttachment() as Peer).role==='primary')&&ws.readyState===1&&Date.now()-((ws.deserializeAttachment() as Peer).seen??Date.now())<180_000)
      .sort((a,b)=>RANK.indexOf((a.deserializeAttachment() as Peer).role)-RANK.indexOf((b.deserializeAttachment() as Peer).role));
    const peer=peers[0];
    // Preserve main's fast path: a busy/offline peer cannot take a per-chat priority push.
    if(priorityEventId&&!peer)return{dispatched:false,reason:'no_machine_connected'};
    if(priorityEventId&&(peer.deserializeAttachment() as Peer).busy)return{dispatched:false,reason:'diana_working'};
    const claim=await this.roundClaim();
    if(claim.active)return{dispatched:false,reason:'diana_round_running',claim_updated_at:claim.updated_at};
    const pending=(await pendingDianaMessages(this.env)).filter(item=>!directOnly||String(item.queue_key).startsWith('diana_round_alarm:')||item.task==='owner_direct_only');
    if(!peer)return{pending:pending.length,dispatched:false,reason:'no_machine_connected'};
    if((peer.deserializeAttachment() as Peer).busy)return{pending:pending.length,dispatched:false,reason:'diana_working'};
    const deferred=justReturned.length?justReturned:(priorityEventId?((peer.deserializeAttachment() as Peer).deferred_event_ids??[]).filter(id=>id!==priorityEventId):[]);
    const inFlight=new Set(peers.filter(p=>(p.deserializeAttachment() as Peer).busy).flatMap(p=>(p.deserializeAttachment() as Peer).inflight_event_ids??[]));
    const batch=dianaBatch(pending.filter(item=>!inFlight.has(String(item.event_id))&&!deferred.includes(String(item.event_id))),priorityEventId);
    if(!batch.length)return{pending:pending.length,dispatched:false,reason:pending.length?'awaiting_verified_completion':'queue_empty'};
    const dispatchedAt=new Date().toISOString(),role=(peer.deserializeAttachment() as Peer).role;
    peer.serializeAttachment({...peer.deserializeAttachment() as Peer,busy:true,deferred_event_ids:deferred,inflight_event_ids:batch.map(item=>String(item.event_id)),dispatched_at:dispatchedAt});
    try{peer.send(JSON.stringify({type:'messages',messages:batch}));}
    catch{peer.close(1011,'delivery failed');return{pending:pending.length,dispatched:false,reason:'websocket_send_failed'};}
    await this.env.DB.batch(batch.map(item=>this.env.DB.prepare(`INSERT INTO crm_sync_state(key,value,updated_at) VALUES(?1,?2,?3)
      ON CONFLICT(key) DO NOTHING`).bind('diana_wake_dispatch:'+item.event_id,JSON.stringify({event_id:item.event_id,task:item.task??null,payout_id:item.payout_id??null,queued_at:item.at,dispatched_at:dispatchedAt,peer_role:role,batch_size:batch.length,status:'pushed_to_machine',transport:'websocket'}),Date.now())));
    return{pending:pending.length,dispatched:true,peer_role:role,dispatched_at:dispatchedAt,event_ids:batch.map(item=>item.event_id)};
  }
  async webSocketMessage(ws:WebSocket,raw:string|ArrayBuffer){
    let message:any;
    try{message=JSON.parse(String(raw));}catch{ws.close(1003,'invalid message');return;}
    ws.serializeAttachment({...ws.deserializeAttachment() as Peer,seen:Date.now()});
    if(message.type==='ready'){
      const attachment=ws.deserializeAttachment() as Peer;
      const returned=[...new Set([...(attachment.deferred_event_ids??[]),...(attachment.inflight_event_ids??[])])];
      ws.serializeAttachment({...ws.deserializeAttachment() as Peer,busy:false,inflight_event_ids:[],deferred_event_ids:returned});
      try{await this.dispatch(undefined,returned);}catch{console.warn('[diana-wake] ready dispatch unavailable');}
    }
    if(message.type==='ping')ws.send(JSON.stringify({type:'pong'}));
  }
  webSocketClose(ws: WebSocket) { ws.close(); }
  webSocketError(ws: WebSocket) { ws.close(1011, 'connection failed'); }
}
