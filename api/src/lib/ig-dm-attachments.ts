// Private Instagram screenshots become image inputs, never public R2 links.
import type { Env } from '../types';
import type { LlmImage } from './llm';
import { refreshIgAttachments } from './ig-dm-watch';

// Keep base64 under the partner API's 5 MB/image and 32 MB/request limits.
const MAX_BYTES = 3_500_000;
const MAX_TOTAL_BYTES = 16_000_000;
const MAX_IMAGES = 6;
type Message = { id?: string; direction: string; created_at: string; attachments_json: string | null };

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
async function download(url: string): Promise<{ mediaType: LlmImage['mediaType']; data: string; size: number }> {
  let source = url;
  for (let n = 0; n < 4; n++) {
    const r = await fetch(trustedUrl(source), { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    if ([301,302,303,307,308].includes(r.status)) {
      const location = r.headers.get('location'); await r.body?.cancel();
      if (!location) throw new Error('Missing image redirect');
      source = new URL(location, source).href; continue;
    }
    if (!r.ok || !r.body) throw new Error('Image unavailable');
    const mediaType = (r.headers.get('content-type') ?? '').split(';')[0] as LlmImage['mediaType'];
    if (!['image/jpeg','image/png','image/gif','image/webp'].includes(mediaType) || Number(r.headers.get('content-length')) > MAX_BYTES) { await r.body.cancel(); throw new Error('Unsupported image'); }
    const reader = r.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    while (true) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > MAX_BYTES) { await reader.cancel(); throw new Error('Image too large'); } chunks.push(value); }
    if (!size) throw new Error('Empty image');
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let binary = ''; for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { mediaType, data: btoa(binary), size };
  }
  throw new Error('Image redirect limit');
}

export async function incomingScreenshots(env: Env, history: Message[], at: string): Promise<LlmImage[]> {
  const recent = history.filter((m) => m.direction === 'in' && m.attachments_json && m.attachments_json !== '[]' && Date.parse(m.created_at) >= Date.parse(at) - 7 * 86_400_000);
  const selected: {message: Message; index: number; url: string}[] = [];
  for (const message of recent) {
    let urls: string[];
    try { urls = imageUrls(message.attachments_json); }
    catch { const fresh = message.id ? await refreshIgAttachments(env, message.id) : null; if (!fresh) throw new Error('Image metadata unavailable'); urls = imageUrls(fresh); }
    urls.forEach((url,index) => selected.push({message,index,url}));
  }
  const images: LlmImage[] = []; let total = 0;
  for (const item of selected.slice(-MAX_IMAGES)) {
    let image;
    try { image = await download(item.url); }
    catch {
      const fresh = item.message.id ? await refreshIgAttachments(env, item.message.id) : null;
      const url = fresh ? imageUrls(fresh)[item.index] : null;
      if (!url) throw new Error('Image refresh failed');
      image = await download(url);
    }
    total += image.size; if (total > MAX_TOTAL_BYTES) throw new Error('Image request too large');
    images.push({ mediaType: image.mediaType, data: image.data, label: `Скриншот из входящего сообщения ${item.message.created_at}, вложение ${item.index + 1}.` });
  }
  return images;
}
