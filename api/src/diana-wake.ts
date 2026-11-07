import type { Env } from './types';
import { pendingDianaMessages } from './lib/diana-alarm';

// Owner 2026-11-07: ERP never hands Diana text or the whole queue. One dispatch carries at most 20 identifiers
// (oldest first); Diana reads the originals herself, and the rest follow on the next dispatch.
export const DIANA_BATCH = 20;
export function dianaBatch(pending: any[]) {
  return pending.slice(0, DIANA_BATCH).map(item => String(item.event_id ?? '').startsWith('action:') ? item : ({
    cid: item.cid, message_id: item.message_id, event_id: item.event_id, handle: item.handle, at: item.at, reason: item.reason, queue_key: item.queue_key,
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
    const peer = peers[0];
    const pending = await pendingDianaMessages(this.env);
    if (!peer) return Response.json({ pending: pending.length, dispatched: false, reason: 'no_machine_connected' });
    if ((peer.deserializeAttachment() as Peer).busy) return Response.json({ pending: pending.length, dispatched: false, reason: 'diana_working' });
    if (pending.length) {
      peer.serializeAttachment({ ...(peer.deserializeAttachment() as Peer), busy: true });
      try { peer.send(JSON.stringify({ type: 'messages', messages: dianaBatch(pending) })); }
      catch { peer.close(1011, 'delivery failed'); return Response.json({ pending: pending.length, dispatched: false }); }
    }
    return Response.json({ pending: pending.length, dispatched: pending.length > 0 });
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
