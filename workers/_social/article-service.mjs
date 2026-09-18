/** Owner 2026-09-14: one Kobayashi article across localized pages, >=4h, 08-24 Yerevan.
 * Copy is prepared by the named editorial seats in the publication job and committed to
 * social-outbox. This clock consumes verified output; it never impersonates their review.
 */
import { createArticleQueue, articleQueueRoutes, allowedNow } from './article-queue.mjs';
import { cleanAiMarks } from './ai-marks.mjs';
export const PAGES = { main: '1697038263872226', en: '599438763247924', ar: '567336749803658', vi: '516598391547915' };
const OUTBOX = 'agents/angela/social-outbox';
const GRAPH = 'https://graph.facebook.com/v21.0';
const HOSTS = ['www.dasexperten.com', 'dasexperten.com', 'dasexperten.ru', 'www.dasexperten.ru'];
const cacheHeaders = { 'cache-control': 'no-store' };
function safeUrl(url) { const u = new URL(url); if (u.protocol !== 'https:' || !HOSTS.includes(u.hostname) || u.username || u.password) throw Error('Expected company article URL'); return u; }
const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_,n)=>String.fromCodePoint(+n)).replace(/&#x([a-f0-9]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)));
export function readPreview(html) {
  const values = {};
  const document = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  for (const tag of document.match(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) || []) {
    const attrs = {};
    for (const m of tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs)) attrs[m[1].toLowerCase()] = decode(m[3]);
    if (attrs.property?.startsWith('og:')) values[attrs.property] = attrs.content;
  }
  return { title: values['og:title'], description: values['og:description'], image: values['og:image'], url: values['og:url'] };
}
async function livePreview(url) {
  safeUrl(url);
  const r = await fetch(url, { redirect: 'error', headers: cacheHeaders, signal: AbortSignal.timeout(25000) });
  if (!r.ok || !r.headers.get('content-type')?.includes('text/html')) throw Error(`Article unavailable (${r.status})`);
  const html = await r.text();
  if (!/<article\b/i.test(html)) throw Error('URL is not an article');
  const p = readPreview(html);
  if (!p.title || !p.description || !p.image || !p.url) throw Error('Article preview metadata incomplete');
  if (safeUrl(p.url).href !== safeUrl(url).href) throw Error('Article canonical preview URL mismatch');
  safeUrl(p.image);
  const im = await fetch(p.image, { method:'HEAD', redirect:'error', signal:AbortSignal.timeout(25000) });
  if (!im.ok || !im.headers.get('content-type')?.startsWith('image/')) throw Error('Article preview image unavailable');
  return { ...p, verified: true, evidence: `Live article and image checked ${new Date().toISOString()}` };
}
export async function graph(path, token, init = {}) {
  const r = await fetch(`${GRAPH}/${path}`, { ...init, signal: AbortSignal.timeout(25000), headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  const b = await r.json();
  return { ok: r.ok && !b.error, body: b, status:r.status };
}
export async function tokenFor(env, pageId) {
  if (!env.META_SYSTEM_USER_TOKEN) throw Error('Meta credential unavailable');
  const r = await graph(`${pageId}?fields=id,name,access_token`, env.META_SYSTEM_USER_TOKEN);
  return r.ok && r.body.access_token ? r.body.access_token : null;
}
export async function publicationAccess(env) {
  const result = {};
  for (const [lang,id] of Object.entries(PAGES)) {
    try { result[lang] = { pageId: id, available: !!await tokenFor(env,id) }; }
    catch { result[lang] = { pageId:id, available:false }; }
  }
  return result;
}
export async function publish(env, input) {
  // Nothing has been submitted before these checks; failures here are safe to retry.
  let token;
  try {
    token = await tokenFor(env,input.pageId);
    if (!token) return { status:'not_sent', definitive:true };
    const p = await livePreview(input.link);
    if (p.title !== input.preview.title || p.description !== input.preview.description || p.image !== input.preview.image) return { status:'not_sent', definitive:true };
  } catch { return {status:'not_sent',definitive:true}; }
  if (!allowedNow(Date.now())) return {status:'not_sent',definitive:true};
  const summary = cleanAiMarks(input.summary).text;
  // Link posts preserve Facebook's own preview. Never fabricate a preview image attachment.
  const result = await graph(`${input.pageId}/feed`, token, {method:'POST',body:new URLSearchParams({message:summary,link:input.link,published:'true'})});
  if (!result.ok) {
    if ([400, 401, 403, 404, 429].includes(result.status) && result.body.error && result.body.error.is_transient !== true) return {status:'not_sent',definitive:true};
    return {status:'unknown'};
  }
  const id = result.body.id;
  if (!id) return {status:'unknown'};
  try {
    const verified = await graph(`${id}?fields=id,permalink_url,is_published`,token);
    if (verified.ok && verified.body.id === id && verified.body.is_published === true && verified.body.permalink_url) return {status:'published',postId:id,proof:verified.body.permalink_url};
  } catch {}
  // Acceptance plus failed verification is ambiguous; queue must not duplicate the post.
  return {status:'unknown',postId:id,proof:`Graph accepted post ${id}; read-back unconfirmed`};
}
export function articleQueue(env) { return createArticleQueue(env.DB,{pages:PAGES,publish:input=>publish(env,input)}); }
async function github(env,path) {
  if (!env.GITHUB_TOKEN) throw Error('GitHub read credential unavailable');
  const r = await fetch(`https://api.github.com/repos/dasexperten/organizacia/contents/${path}?ref=main`,{headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,'User-Agent':'angela-social','Accept':'application/vnd.github+json'}});
  if (!r.ok) throw Error(`Publication outbox read failed (${r.status})`);
  return r.json();
}
function content(file) { return new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\s/g,'')),x=>x.charCodeAt(0))); }
export async function syncOutbox(env, queue = articleQueue(env)) {
  const files = await github(env,OUTBOX);
  if (!Array.isArray(files)) throw Error('Publication outbox is not a directory');
  const state = await queue.status();
  if (state.initializedAt === null) throw Error('Activation baseline must be initialized explicitly');
  const results = [];
  for (const file of files.filter(f=>f.type==='file' && f.name.endsWith('.json'))) {
    const id = file.name.slice(0,-5);
    const existing=state.articles.find(a=>a.id===id);
    if (existing && existing.status !== 'draft') continue;
    try {
      const manifest=JSON.parse(content(await github(env,file.path)));
      if (manifest.id!==id || manifest.author!=='kobayashi' || manifest.publicationStatus!=='live' || !/^[0-9a-f]{40}$/.test(manifest.siteCommit||'') || !manifest.sourcePath?.startsWith('agents/kobayashi/ARTICLE_') || !manifest.sourcePath.endsWith('.md')) throw Error('Missing explicit Kobayashi publication provenance');
      const provenance=content(await github(env,manifest.sourcePath));
      if (!provenance.includes(new URL(manifest.url).pathname)) throw Error('Article absent from named publication record');
      // A historical manifest never becomes new just because it was copied into the outbox.
      if (!Number.isFinite(Date.parse(manifest.publishedAt))) throw Error('Missing valid publication timestamp');
      const historical = Date.parse(manifest.publishedAt)<=state.initializedAt;
      const audit = manifest.backfill;
      const backfillVerified = historical && audit?.unshared === true && audit?.by === 'angela'
        && typeof audit.evidence === 'string' && audit.evidence.trim().length > 0
        && Number.isFinite(Date.parse(audit.checkedAt))
        && Date.now() - Date.parse(audit.checkedAt) >= 0
        && Date.now() - Date.parse(audit.checkedAt) <= 24*60*60*1000
        && Array.isArray(audit.pageIds)
        && Object.values(PAGES).every(id => audit.pageIds?.includes(id));
      if (historical && !backfillVerified) { results.push({id,status:'historical-review-required'}); continue; }
      const payload={};
      for (const lang of Object.keys(PAGES)) {
        const p=manifest.payload?.[lang];
        if (!p) throw Error(`Missing ${lang} editorial copy`);
        const preview=await livePreview(p.link);
        if (preview.title!==p.preview?.title || preview.image!==p.preview?.image || preview.description!==p.preview?.description) throw Error(`Changed ${lang} preview requires editorial check`);
        payload[lang]={...p,sourceId:id,preview,summary:cleanAiMarks(p.summary).text};
      }
      await queue.discover([{id,url:manifest.url,title:manifest.title,author:'kobayashi',publishedAt:manifest.publishedAt,backfillVerified}]);
      await queue.approve(id,payload);
      results.push({id,status:'approved'});
    } catch { results.push({id,status:'blocked',reason:'Source, live preview or editorial validation failed; inspect manifest'}); }
  }
  return results;
}
export async function articleTick(env) {
  const q=articleQueue(env);
  const sync=await syncOutbox(env,q);
  const state=await q.status();
  if (!state.articles.some(a=>["approved","partial"].includes(a.status))) return {sync,skipped:"No approved article"};
  // One article is a cross-page batch. Report missing rights without half-posting a new batch.
  const access=await publicationAccess(env);
  if (Object.values(access).some(x=>!x.available)) return {sync,access,skipped:'Regional page publishing access missing'};
  return {sync,publication:await q.tick()};
}
export async function articleRoutes(req,env) {
  const path=new URL(req.url).pathname;
  if (!path.startsWith('/articles/')) return null;
  if (!env.SOCIAL_READ_SECRET || req.headers.get('X-Social-Read-Secret')!==env.SOCIAL_READ_SECRET) return Response.json({error:'unauthorized'},{status:401});
  if (path==='/articles/status' && req.method==='GET') {
    const last = await env.ARCHIVE.get("Social/angela/latest-run.json");
    return Response.json({queue:await articleQueue(env).status(),lastRun:last ? await last.json() : null});
  }
  if (path==='/articles/access' && req.method==='GET') return Response.json(await publicationAccess(env));
  if (path==='/articles/sync' && req.method==='POST') return Response.json(await syncOutbox(env));
  if (path==='/articles/tick' && req.method==='POST') return Response.json(await articleTick(env));
  // Read and initialize/reconcile are exposed. Editorial approval enters only via committed outbox.
  if (!['/articles/status','/articles/initialize','/articles/reconcile'].includes(path)) return Response.json({error:'Use committed publication outbox'},{status:405});
  return articleQueueRoutes(req,env,articleQueue(env));
}
