import { GmailError } from './google-workspace';
import type { GmailMessage } from './gmail-client';

/** Read-only metadata batch; Gmail quotas still count each contained request. */
export async function gmailMetadataBatch(token: string, ids: string[]): Promise<GmailMessage[]> {
  if (!ids.length) return [];
  if (ids.length>25) throw new Error('Gmail metadata batch exceeds page size');
  const boundary='gmail_metadata_batch';
  const body=ids.map((id,i)=>`--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <mail-${i}>\r\n\r\nGET /gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata HTTP/1.1\r\n\r\n`).join('')+`--${boundary}--\r\n`;
  const response=await fetch('https://gmail.googleapis.com/batch/gmail/v1',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':`multipart/mixed; boundary=${boundary}`},body});
  if(!response.ok) throw new GmailError(response.status);
  const match=/boundary=(?:"([^"\r\n]+)"|([^;\s]+))/i.exec(response.headers.get('content-type') || '');
  if(!match) throw new Error('Invalid Gmail batch response');
  const delimiter=match[1] || match[2];
  const raw=await response.text();
  const results=new Map<number,GmailMessage>();
  for(const part of raw.split(`--${delimiter}`).slice(1)) {
    if(part.startsWith('--')) break;
    const normalized=part.replace(/^\r?\n/,'');
    const outerEnd=/\r?\n\r?\n/.exec(normalized);
    if(!outerEnd) throw new Error('Incomplete Gmail batch part');
    const headers=normalized.slice(0,outerEnd.index);
    const id=/^Content-ID:\s*<response-mail-(\d+)>\s*$/im.exec(headers);
    const index=id ? Number(id[1]) : -1;
    if(index<0 || index>=ids.length || results.has(index)) throw new Error('Invalid Gmail batch response identity');
    const http=normalized.slice(outerEnd.index+outerEnd[0].length);
    const status=/^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(http);
    if(!status) throw new Error('Invalid Gmail batch status');
    if(Number(status[1])!==200) throw new GmailError(Number(status[1]));
    const innerEnd=/\r?\n\r?\n/.exec(http);
    if(!innerEnd) throw new Error('Incomplete Gmail batch message');
    const message=JSON.parse(http.slice(innerEnd.index+innerEnd[0].length).trim()) as GmailMessage;
    if(message.id!==ids[index]) throw new Error('Gmail batch message identity mismatch');
    results.set(index,message);
  }
  if(results.size!==ids.length) throw new Error('Missing Gmail batch messages');
  return ids.map((_,i)=>results.get(i)!);
}
