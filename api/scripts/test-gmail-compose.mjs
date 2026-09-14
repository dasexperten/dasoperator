import assert from 'node:assert/strict';
import {build} from 'esbuild';
import PostalMime from 'postal-mime';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'gmail-compose-'));
try{
 await build({entryPoints:['api/src/lib/gmail-compose.ts'],bundle:true,platform:'node',format:'esm',outfile:join(dir,'compose.mjs')});
 const {gmailDraftSchema,composeGmailRaw}=await import(join(dir,'compose.mjs'));
 const input={from:'sales@dasexperten.com',to:'customer@example.com',cc:'copy@example.com',bcc:'hidden@example.com',subject:'Проверка 📬',text:'Первая строка\nВторая строка',html:'<p>Текст</p>',inReplyTo:'<parent@example.com>',references:['<first@example.com>','<parent@example.com>'],attachments:[{filename:'договор.bin',mimeType:'application/octet-stream',content:Buffer.from([0,255,10]).toString('base64')},{filename:'empty.txt',mimeType:'text/plain',content:''}]};
 const raw=Buffer.from(composeGmailRaw(gmailDraftSchema.parse(input)),'base64url');
 const mail=await PostalMime.parse(raw);
 const longSubject='Проверка 📬 '.repeat(100);
 const longMail=await PostalMime.parse(Buffer.from(composeGmailRaw({...input,subject:longSubject}),'base64url'));assert.equal(longMail.subject,longSubject);
 assert.equal(mail.subject,input.subject);assert.equal(mail.text.trim(),input.text);assert.equal(mail.html.trim(),input.html);
 assert.equal(mail.cc[0].address,'copy@example.com');assert.equal(mail.bcc[0].address,'hidden@example.com');
 assert.equal(mail.inReplyTo,input.inReplyTo);assert.equal(mail.attachments[0].filename,'договор.bin');
 assert.deepEqual([...new Uint8Array(mail.attachments[0].content)],[0,255,10]);assert.equal(mail.attachments[1].content.byteLength,0);
 for(const field of ['to','cc','bcc','subject','inReplyTo'])assert.equal(gmailDraftSchema.safeParse({...input,[field]:'bad\r\nBcc: injected@example.com'}).success,false);
 assert.throws(()=>composeGmailRaw({...input,attachments:[{filename:'bad',mimeType:'text/plain',content:'!!!'}]}));
 assert.throws(()=>composeGmailRaw({...input,attachments:[{filename:'large',mimeType:'text/plain',content:Buffer.alloc(10*1024*1024+1).toString('base64')}]}));
 console.log('PASS Gmail MIME: Unicode, CC/BCC, reply headers, exact attachment bytes, empty files, header injection and size guards');
}finally{await rm(dir,{recursive:true,force:true});}
