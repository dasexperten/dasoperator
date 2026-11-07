import type { Env } from './types';
import { pendingDianaMessages } from './lib/diana-alarm';

// Owner 2026-11-07: ERP never hands Diana text or the whole queue. One dispatch carries at most 50 identifiers
// (oldest first); Diana reads the originals herself, and the rest follow on the next dispatch.
export const DIANA_BATCH = 50;
// Newest first, never the oldest backlog (Owner 2026-11-07: "the last 20 chats with no answer from our side").
// A chat whose newest message is ours (last_from_us === true) comes after every unanswered one.
const dianaTime = (item: any) => { const t = Date.parse(String(item.at ?? '')); return Number.isFinite(t) ? t : 0; };
export function dianaBatch(pending: any[]) {
  return [...pending]
    .sort((a, b) => (a.last_from_us === true ? 1 : 0) - (b.last_from_us === true ? 1 : 0) || dianaTime(b) - dianaTime(a))
    .slice(0, DIANA_BATCH)
    .map(item => String(item.event_id ?? '').startsWith('action:') ? item : ({
      cid: item.cid, message_id: item.message_id, event_id: item.event_id, handle: item.handle, at: item.at, reason: item.reason, queue_key: item.queue_key,
      ...(Array.isArray(item.jev_tried) && item.jev_tried.length ? { jev_tried: item.jev_tried } : {}),
    }));
}

type Peer = { role: string; busy: boolean; seen?: number };
const RANK = ['primary', 'backup', 'secondary'];

// Persistent delivery channel, not another polling clock or model executor.
export class DianaWake {
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
    if (url.pathname === '/status') return Response.json({ connections: this.state.getWebSockets().map(ws => ws.deserializeAttachment()) });
    const peers = this.state.getWebSockets().filter(ws => ws.readyState === 1 && Date.now() - ((ws.deserializeAttachment() as Peer).seen ?? Date.now()) < 180_000)
      .sort((a,b) => RANK.indexOf((a.deserializeAttachment() as Peer).role) - RANK.indexOf((b.deserializeAttachment() as Peer).role));
    const pending = await pendingDianaMessages(this.env);
    if (!peers.length) return Response.json({ pending: pending.length, dispatched: false, reason: 'no_machine_connected' });
    // Owner 2026-11-07: a stuck chat whose picture one machine's Jev could not open goes to the next machine
    // in order M1 -> PC -> M5 (the runner writes jev_tried). Everything else goes to the highest machine.
    const role = (ws: WebSocket) => (ws.deserializeAttachment() as Peer).role;
    const groups = new Map<WebSocket, any[]>();
    for (const item of pending) {
      const tried: string[] = Array.isArray(item.jev_tried) ? item.jev_tried : [];
      const target = peers.find(ws => !tried.includes(role(ws))) ?? peers[0];
      if (!groups.has(target)) groups.set(target, []);
      groups.get(target)!.push(item);
    }
    let dispatched = 0, working = false;
    for (const [peer, items] of groups) {
      if ((peer.deserializeAttachment() as Peer).busy) { working = true; continue; }
      peer.serializeAttachment({ ...(peer.deserializeAttachment() as Peer), busy: true });
      try { peer.send(JSON.stringify({ type: 'messages', messages: dianaBatch(items) })); dispatched += items.length; }
      catch { peer.close(1011, 'delivery failed'); }
    }
    if (!dispatched && working) return Response.json({ pending: pending.length, dispatched: false, reason: 'diana_working' });
    return Response.json({ pending: pending.length, dispatched: dispatched > 0 });
  }
  webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    try {
      const message = JSON.parse(String(raw));
      ws.serializeAttachment({ ...(ws.deserializeAttachment() as Peer), seen: Date.now() });
      if (message.type === 'ready') ws.serializeAttachment({ ...(ws.deserializeAttachment() as Peer), busy: false });
      if (message.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
    } catch { ws.close(1003, 'invalid message'); }
  }
  webSocketClose(ws: WebSocket) { ws.close(); }
  webSocketError(ws: WebSocket) { ws.close(1011, 'connection failed'); }
}
