import { z } from 'zod';
const header = (max: number) => z.string().max(max).refine(value => !/[\r\n\x00]/.test(value), 'Header cannot contain line breaks');
export const gmailDraftSchema = z.object({
  id: header(256).optional(), from: z.string().email().max(254), to: header(10000), cc: header(10000).optional(), bcc: header(10000).optional(),
  subject: header(2000), text: z.string().max(1000000), html: z.string().max(2000000).optional(),
  gmailThreadId: header(256).optional(), inReplyTo: header(1000).optional(), references: z.union([header(10000),z.array(header(1000)).max(100)]).optional(),
  attachments: z.array(z.object({filename:header(256).refine(s=>s.length>0),mimeType:header(256),content:z.string().max(13981016),contentId:header(256).optional(),inline:z.boolean().optional()})).max(20).default([]),
});
export type GmailDraftInput = z.infer<typeof gmailDraftSchema>;
function base64(bytes: Uint8Array) {
  let s=''; for(let i=0;i<bytes.length;i+=8192) s+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(s);
}
const encoded = (s: string) => base64(new TextEncoder().encode(s));
function encodedSubject(subject: string) {
  const words: string[]=[];let chunk='';
  for(const char of subject) {if(new TextEncoder().encode(chunk+char).length>39){words.push(`=?UTF-8?B?${encoded(chunk)}?=`);chunk='';}chunk+=char;}
  if(chunk || !words.length)words.push(`=?UTF-8?B?${encoded(chunk)}?=`);
  return words.join('\r\n ');
}
const lines = (s: string) => s.match(/.{1,76}/g)?.join('\r\n') || '';
export function composeGmailRaw(input: GmailDraftInput): string {
  const boundary=`erp_${crypto.randomUUID().replace(/-/g,'')}`;
  const headers=[`From: ${input.from}`,`To: ${input.to}`,`Subject: ${encodedSubject(input.subject)}`, 'MIME-Version: 1.0',`Content-Type: multipart/mixed; boundary="${boundary}"`];
  if(input.cc)headers.push(`Cc: ${input.cc}`); if(input.bcc)headers.push(`Bcc: ${input.bcc}`);
  if(input.inReplyTo)headers.push(`In-Reply-To: ${input.inReplyTo}`);
  if(input.references)headers.push(`References: ${Array.isArray(input.references)?input.references.join(' '):input.references}`);
  const parts: string[]=[];
  const textPart=(type:string,content:string)=>`Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${lines(encoded(content))}`;
  if(input.html) {
    const alt=`alt_${boundary}`;
    parts.push(`Content-Type: multipart/alternative; boundary="${alt}"\r\n\r\n--${alt}\r\n${textPart('text/plain',input.text)}\r\n--${alt}\r\n${textPart('text/html',input.html)}\r\n--${alt}--`);
  } else parts.push(textPart('text/plain',input.text));
  let total=0;
  for(const file of input.attachments) {
    if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content))throw new Error('Invalid attachment encoding');
    const bytes=atob(file.content).length;total+=bytes;
    if(bytes>10*1024*1024 || total>20*1024*1024)throw new Error('Attachment limits exceeded');
    const filename=encodeURIComponent(file.filename).replace(/'/g,'%27');
    const mime=/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(file.mimeType)?file.mimeType:'application/octet-stream';
    parts.push(`Content-Type: ${mime}\r\nContent-Disposition: ${file.inline ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}\r\n${file.contentId ? `Content-ID: <${file.contentId.replace(/[<>]/g,'')}>\r\n` : ''}Content-Transfer-Encoding: base64\r\n\r\n${lines(file.content)}`);
  }
  const raw=`${headers.join('\r\n')}\r\n\r\n${parts.map(p=>`--${boundary}\r\n${p}`).join('\r\n')}\r\n--${boundary}--\r\n`;
  return encoded(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
