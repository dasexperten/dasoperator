import test from 'node:test';import assert from 'node:assert/strict';
import {createRequire} from 'node:module';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
const require=createRequire(import.meta.url),out=join(mkdtempSync(join(tmpdir(),'gmail-inline-')),'client.mjs');
await require('esbuild').build({entryPoints:[fileURLToPath(new URL('./gmail-client.ts',import.meta.url))],outfile:out,bundle:true,format:'esm',platform:'node',plugins:[{name:'workspace-fixture',setup(b){b.onResolve({filter:/google-workspace$/},()=>({path:'workspace',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export class GmailError extends Error{};export const workspaceAccounts=()=>[];export const workspaceGrant=()=>{};export const gmailRequest=(...a)=>globalThis.gmailFixture(...a);'}));}}]});
const {gmailBody}=await import(pathToFileURL(out));
const encode=s=>Buffer.from(s).toString('base64url');
const message={id:'m1',threadId:'t1',payload:{parts:[{partId:'0',mimeType:'text/html',body:{data:encode('<p>Original text</p><img src="cid:image.1"><img src="https://tracker.invalid/pixel">')}},{partId:'1',filename:'photo.png',mimeType:'image/png',headers:[{name:'Content-ID',value:'<image.1>'}],body:{attachmentId:'a1',size:4}}]}};
test('Gmail cid image becomes embedded bytes and retains exact attachment identity',async()=>{
 globalThis.gmailFixture=async(token,path)=>{assert.equal(path,'messages/m1/attachments/a1');return {data:encode('PNG!')};};
 const body=await gmailBody('fixture',message);assert.match(body.html,/src="data:image\/png;base64,UE5HIQ"/);assert.equal(body.attachments[0].partId,'1');assert.equal(body.attachments[0].filename,'photo.png');assert.match(body.html,/https:\/\/tracker.invalid/);
});
test('failed inline preview keeps text and attachment download available',async()=>{
 globalThis.gmailFixture=async()=>{throw Error('fixture failure');};const body=await gmailBody('fixture',message);assert.match(body.html,/Original text/);assert.equal(body.attachments.length,1);assert.match(body.html,/cid:image.1/);
});
