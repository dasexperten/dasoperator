import { WorkerEntrypoint } from 'cloudflare:workers';
import type { Env } from './types';
import { wbRequest } from './lib/wb-gateway';
export class WbGateway extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    try { return await wbRequest(this.env, request); }
    catch (e) { return Response.json({ error: e instanceof Error ? e.message : 'WB gateway failed' }, { status: 502 }); }
  }
}
