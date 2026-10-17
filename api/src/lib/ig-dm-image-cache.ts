// Instagram screenshots stay in the ERP's private document bucket.
import type { Env } from '../types';
import type { LlmImage } from './llm';
const MAX_BYTES = 3_500_000;
/** Meta sometimes labels a PNG screenshot image/jpeg. Trust the bytes, not
 * that label, including for images cached before this fix. */
export function detectImageMediaType(bytes: Uint8Array): LlmImage['mediaType'] {
  if(bytes.length>=8 && [137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))return 'image/png';
  if(bytes.length>=3 && bytes[0]===255 && bytes[1]===216 && bytes[2]===255)return 'image/jpeg';
  const ascii=(start:number,end:number)=>String.fromCharCode(...bytes.subarray(start,end));
  if(bytes.length>=6 && ['GIF87a','GIF89a'].includes(ascii(0,6)))return 'image/gif';
  if(bytes.length>=12 && ascii(0,4)==='RIFF' && ascii(8,12)==='WEBP')return 'image/webp';
  throw new Error('Unsupported image bytes');
}
export function imageUrls(json: string | null): string[] {
  if (!json || json === '[]') return [];
  const data = JSON.parse(json);
  if (!Array.isArray(data)) throw new Error('Invalid attachment metadata');
  return data.flatMap((a) => {
    if (!a?.image_data && !String(a?.mime_type ?? '').startsWith('image/')) return [];
    const url = a.image_data?.url || a.image_data?.preview_url || a.file_url;
    if (typeof url !== 'string' || !url) throw new Error('Missing image URL');
    return [url];
  });
}
function trustedUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !(u.hostname === 'lookaside.fbsbx.com' || u.hostname.endsWith('.fbcdn.net') || u.hostname.endsWith('.cdninstagram.com'))) throw new Error('Unsupported image source');
  return u.href;
}
async function download(url: string): Promise<{ mediaType: LlmImage['mediaType']; data: string; size: number; bytes: Uint8Array }> {
  let source = url;
  for (let n = 0; n < 4; n++) {
    // Without a browser User-Agent Meta answers 302 → facebook.com/unsupportedbrowser (found 2026-10-17):
    // every screenshot looked unreadable and Direct replies stalled.
    const r = await fetch(trustedUrl(source), { redirect: 'manual', signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', Accept: 'image/avif,image/webp,image/png,image/jpeg,*/*;q=0.8' } });
    if ([301,302,303,307,308].includes(r.status)) {
      const location = r.headers.get('location'); await r.body?.cancel();
      if (!location) throw new Error('Missing image redirect');
      source = new URL(location, source).href; continue;
    }
    if (!r.ok || !r.body) throw new Error('Image unavailable');
    if (Number(r.headers.get('content-length')) > MAX_BYTES) { await r.body.cancel(); throw new Error('Image too large'); }
    const reader = r.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Image too large'); } chunks.push(value); }
    if (!size) throw new Error('Empty image');
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const mediaType=detectImageMediaType(bytes);
    let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { mediaType, data: btoa(binary), size, bytes };
  }
  throw new Error('Image redirect limit');
}

async function keyFor(messageId: string, index: number): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(messageId));
  return `ugc/ig-private/${Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2,'0')).join('')}/${index}`;
}
export async function loadInstagramImage(env: Env, messageId: string | undefined, index: number, url: string): Promise<{mediaType: LlmImage['mediaType']; data: string; size: number}> {
  const key = messageId ? await keyFor(messageId,index) : null;
  let cached = null;
  try { cached = key && env.DOCS ? await env.DOCS.get(key) : null; } catch { console.warn('[ig-images] private cache read failed; using source'); }
  if (cached) {
    if (cached.size > MAX_BYTES) throw new Error('Invalid cached image');
    const bytes = new Uint8Array(await cached.arrayBuffer());
    const mediaType=detectImageMediaType(bytes);let binary = '';
    for (let i=0;i<bytes.length;i+=32768) binary += String.fromCharCode(...bytes.subarray(i,i+32768));
    return {mediaType,data:btoa(binary),size:bytes.length};
  }
  const image = await download(url);
  if (key && env.DOCS) { try { await env.DOCS.put(key,image.bytes,{httpMetadata:{contentType:image.mediaType}}); } catch { console.warn('[ig-images] private cache write failed; current image remains readable'); } }
  return image;
}
export async function cacheIncomingImages(env: Env, messageId: string, attachments: unknown[]): Promise<void> {
  const urls = imageUrls(JSON.stringify(attachments));
  // Cache while Meta's signed URL is fresh, before a later reply needs it.
  for (const [index,url] of urls.entries()) await loadInstagramImage(env,messageId,index,url);
}
