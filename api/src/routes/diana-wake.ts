import { Hono } from 'hono';
import type { Env } from '../types';
import { acknowledgeDianaEvent } from '../lib/diana-alarm';
const route = new Hono<{ Bindings: Env }>();
route.use('*', async (c, next) => {
  const expected = (c.env as unknown as { ERP_RUN_SECRET?: string }).ERP_RUN_SECRET;
  const protocols = (c.req.header('Sec-WebSocket-Protocol') ?? '').split(',').map(s => s.trim());
  const received = (c.req.header('Authorization') ?? '').replace(/^Bearer /, '') || protocols.find(s => s.startsWith('auth.'))?.slice(5);
  if (!expected || received !== expected) return c.json({ ok: false }, 401);
  return next();
});
route.get('/connect', c => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') return c.json({ ok: false }, 400);
  const url = new URL(c.req.url); url.pathname = '/connect';
  return c.env.DIANA_WAKE.get(c.env.DIANA_WAKE.idFromName('diana')).fetch(new Request(url, c.req.raw));
});
route.get('/status', async c => {
  const response=await c.env.DIANA_WAKE.get(c.env.DIANA_WAKE.idFromName('diana')).fetch('https://wake.internal/status');
  return new Response(response.body,{status:response.status,headers:new Headers(response.headers)});
});
// Owner 2026-11-12: proof that the live Worker itself downloads and watches a chat video.
// Read-only: nothing is sent, nothing is stored; returns only the watched facts.
route.post('/video-watch-check',async c=>{
  const input=await c.req.json<{url?:string}>().catch(()=>({} as {url?:string}));
  if(!input.url)return c.json({ok:false},400);
  // @ts-expect-error plain JS module
  const {watchVideo}=await import('../lib/diana-direct-video-watch.mjs');
  const t=Date.now();
  try{const seen=await watchVideo({apiKey:c.env.GEMINI_API_KEY,url:input.url});return c.json({ok:true,ms:Date.now()-t,seen});}
  catch(e){return c.json({ok:false,ms:Date.now()-t,error:e instanceof Error?e.message:'failed'});}
});
// Owner 2026-11-12: record reels that tag us right now (the round does the same at 06:00 and 18:00).
route.post('/record-tagged-reels',async c=>{
  const {recordTaggedReels}=await import('../lib/diana-round-tags');
  try{return c.json({ok:true,...(await recordTaggedReels(c.env))});}catch(e){return c.json({ok:false,error:e instanceof Error?e.message:'failed'});}
});
// Private preview executes the real read/context/model chain with send/ACK disabled.
route.post('/cloud-preview',async c=>{
  const input=await c.req.json<{cid?:string}>();
  if(!input.cid)return c.json({ok:false},400);
  const row=await c.env.DB.prepare('SELECT value FROM crm_sync_state WHERE key=?1').bind('diana_round_alarm:'+input.cid).first<{value:string}>();
  if(!row)return c.json({ok:false,error:'pending_event_missing'},404);
  let source:any;try{source=JSON.parse(row.value);}catch{return c.json({ok:false},409);}
  if(!source.message_id||source.event_id!=='message:'+source.message_id)return c.json({ok:false,error:'original_message_identity_missing'},409);
  const id='preview-'+crypto.randomUUID();
  await c.env.DIANA_CLOUD.create({id,params:{cid:source.cid,message_id:source.message_id,event_id:source.event_id,handle:source.handle,at:source.at,dryRun:true}});
  return c.json({ok:true,id,dry_run:true});
});
route.get('/cloud-status/:id',async c=>{
  const id=c.req.param('id');
  if(!/^(?:preview-[a-f0-9-]{36}|direct-v1-[a-f0-9]{64})$/.test(id))return c.json({ok:false},400);
  const status=await(await c.env.DIANA_CLOUD.get(id)).status();
  return c.json({ok:true,id,...status});
});
route.get('/cloud-preview-result/:id',async c=>{
  const id=c.req.param('id');
  if(!/^preview-[a-f0-9-]{36}$/.test(id))return c.json({ok:false},400);
  const status=await(await c.env.DIANA_CLOUD.get(id)).status();
  const output=status.output as any;
  if(status.status!=='complete'||output?.status!=='preview'||!/^diana\/cloud-direct\/v1\/[a-f0-9]{64}\/decision\.json$/.test(output.decisionKey??''))return c.json({ok:false,status:status.status,output:output??null},409);
  const artifact=await c.env.DOCS.get(output.decisionKey);
  if(!artifact)return c.json({ok:false},404);
  const draft=await artifact.json<any>();
  return c.json({ok:true,dry_run:true,sent:0,decision:{reply:draft.decision.reply,escalate:draft.decision.escalate,reason:draft.decision.reason,sendCards:draft.decision.sendCards},receipt:draft.receipt});
});
// Explicit attended recovery uses the same dispatch and ownership checks as metadata scans.
route.post('/dispatch', async c => {
  const response=await c.env.DIANA_WAKE.get(c.env.DIANA_WAKE.idFromName('diana'))
    .fetch(new Request('https://wake.internal/dispatch', c.req.raw));
  return new Response(response.body,{status:response.status,headers:new Headers(response.headers)});
});
route.post('/ack', async c => {
  const body = await c.req.json<{ cid?: string; message_id?: string | null; event_id?: string }>();
  if (!body.cid || body.message_id === undefined || !body.event_id || (body.message_id === null && !body.event_id.startsWith('legacy:'))) return c.json({ ok: false }, 400);
  const ok = await acknowledgeDianaEvent(c.env, {cid:body.cid,message_id:body.message_id,event_id:body.event_id});
  return c.json({ ok }, ok ? 200 : 409);
});
export default route;
