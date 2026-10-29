import test from 'node:test';import assert from 'node:assert/strict';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
import {nativeInfer,prepareInput} from './native.mjs';
const auth={auth_mode:'chatgpt',tokens:{refresh_token:'fixture-only'}};
test('native command enforces subscription/no keys/no shell and preserves fresh auth',async()=>{
 let captured;const spawnImpl=(command,args,opts)=>{
  assert.equal(command,'codex');assert.ok(args.includes('forced_login_method="chatgpt"'));assert.ok(args.includes('features.shell_tool=false'));assert.equal(opts.env.OPENAI_API_KEY,undefined);
  const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
  child.stdin.on('data',d=>{captured=String(d)});
  child.stdin.on('finish',async()=>{await writeFile(join(opts.env.CODEX_HOME,'auth.json'),JSON.stringify({...auth,last_refresh:'new'}));child.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}})+'\n'+JSON.stringify({type:'turn.completed'})+'\n');child.emit('close',0);});return child;
 };
 const r=await nativeInfer({model:'gpt-6-luna',operation:'context',requestId:'test',messages:[{role:'user',content:'tail'.repeat(10000)}]},{auth,spawnImpl});
 assert.equal(r.auth.last_refresh,'new');assert.equal(r.receipt.model,'gpt-6-luna');assert.ok(captured.includes('tail'.repeat(10000)));
});
test('unsupported model and API auth rejected before spawning',async()=>{
 const base={model:'gpt-6-luna',operation:'image',messages:[]};
 await assert.rejects(nativeInfer({...base,model:'other'},{auth}),/invalid_request/);
 await assert.rejects(nativeInfer(base,{auth:{auth_mode:'apikey'}}),/subscription_auth/);
});
test('images remain bytes, not an external URL fetch',()=>{
 const p=prepareInput([{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,QUJD'}}]}]);assert.equal(p.images[0].data,'QUJD');
 assert.throws(()=>prepareInput([{role:'user',content:[{type:'image_url',image_url:{url:'https://example.com/image'}}]}]),/inline_image/);
});
test('an ignored SIGTERM escalates to SIGKILL and releases the native request',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 let ready;const started=new Promise(r=>{ready=r});const signals=[];
 const spawnImpl=()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=signal=>{signals.push(signal);if(signal==='SIGKILL')child.emit('close',null);};ready();return child;};
 const pending=nativeInfer({model:'gpt-6-luna',operation:'context',requestId:'timeout',messages:[]},{auth,spawnImpl});
 await started;t.mock.timers.tick(180000);assert.deepEqual(signals,['SIGTERM']);t.mock.timers.tick(5000);assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal((await pending).error,'native_inference_failed');t.mock.timers.reset();
});
