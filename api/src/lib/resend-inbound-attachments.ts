import type { RawAttachment } from './inbox-archive';

// Receiving webhook metadata is not a file. Resolve fresh provider URLs and
// archive real bytes before acknowledging receipt; never persist signed URLs.
export async function receivedAttachments(apiKey: string, emailId: string): Promise<RawAttachment[]> {
  if (!apiKey || !emailId) throw new Error('receiving_credentials_or_id_missing');
  const out: RawAttachment[] = [];
  let after = '', total = 0;
  const seen = new Set<string>();
  for (;;) {
    const path = `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments?limit=100${after ? '&after='+encodeURIComponent(after) : ''}`;
    const response = await fetch(path, {headers:{Authorization:`Bearer ${apiKey}`},signal:AbortSignal.timeout(20000)});
    if (!response.ok) throw new Error('attachment_list_unavailable');
    const page = await response.json() as {data?: any[];has_more?: boolean};
    if (!Array.isArray(page.data)) throw new Error('attachment_list_invalid');
    for (const item of page.data) {
      if (!item.id || seen.has(item.id)) throw new Error('attachment_pagination_invalid');
      seen.add(item.id);
      if (out.length >= 20 || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 10*1024*1024 || total+item.size > 20*1024*1024) throw new Error('attachment_archive_limit');
      const url=new URL(item.download_url);
      if (url.protocol!=='https:' || url.hostname!=='inbound-cdn.resend.com' || url.username || url.password) throw new Error('attachment_url_invalid');
      const file=await fetch(url, {redirect:'error',signal:AbortSignal.timeout(20000)});
      if (!file.ok || !file.body) throw new Error('attachment_download_unavailable');
      const reader=file.body.getReader(), chunks:Uint8Array[]=[]; let size=0;
      for (;;) {
        const {done,value}=await reader.read(); if(done)break;
        size+=value.byteLength;
        if(size>item.size || total+size>20*1024*1024) {await reader.cancel();throw new Error('attachment_size_mismatch');}
        chunks.push(value);
      }
      if(size!==item.size)throw new Error('attachment_size_mismatch');
      const bytes=new Uint8Array(size);let offset=0;
      for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
      total+=size;
      out.push({filename:item.filename,mimeType:item.content_type,disposition:item.content_disposition==='inline'?'inline':'attachment',contentId:item.content_id,content:bytes.buffer});
    }
    if(!page.has_more)return out;
    const next=page.data.at(-1)?.id;
    if(!next || next===after)throw new Error('attachment_pagination_invalid');
    after=next;
  }
}
