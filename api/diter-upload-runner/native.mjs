import {mkdtemp,writeFile,readFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {runDieter,runDieterProcess} from './dieter.mjs';
export async function nativeInfer(body,{auth,spawnImpl}={}){
 if(body.operation!=='dieter_round'||body.model!=='gpt-6.1-terra')throw Error('invalid_request');
 if(auth?.auth_mode!=='chatgpt'||!auth.tokens?.refresh_token)throw Error('subscription_auth_required');
 const base=process.env.DIETER_STATE_DIR??tmpdir();await mkdir(base,{recursive:true,mode:0o700});
 const dir=await mkdtemp(join(base,'dieter-')),home=join(dir,'auth');await mkdir(home,{mode:0o700});let refreshed=auth;
 try{
  await writeFile(join(home,'auth.json'),JSON.stringify(auth),{mode:0o600});
  const result=await runDieter(body,{dir,home,...(spawnImpl?{spawnImpl}:{})});
  refreshed=JSON.parse(await readFile(join(home,'auth.json'),'utf8'));return {...result,auth:refreshed};
 }catch(error){
  try{refreshed=JSON.parse(await readFile(join(home,'auth.json'),'utf8'));}catch{}
  const safe=/^(?:invalid_\w+|exact_dieter_assignment_required|dieter_\w+|dieter_process_(?:stdin_)?failed:(?:git|gh|python3|ffmpeg|yt-dlp|codex))$/.test(error?.message??'')?error.message:'native_execution_failed';
  const code=['ENOSPC','EACCES','ENOENT','EMFILE'].includes(error?.code)?error.code:error instanceof SyntaxError?'invalid_json':'unclassified';
  return {error:safe,diagnostic:{phase:'native_initialization',code},auth:refreshed};
 }finally{await rm(dir,{recursive:true,force:true});}
}
export async function runtimeCheck(){
 const env={PATH:process.env.PATH,SSL_CERT_FILE:process.env.SSL_CERT_FILE};
 for(const[cmd,args]of[['git',['--version']],['python3',['--version']],['ffmpeg',['-version']],['gh',['--version']],['yt-dlp',['--version']],['codex',['--version']]])await runDieterProcess(cmd,args,undefined,{env});
 let safe=false;try{await runDieterProcess(process.execPath,['-e',"require('node:fs').closeSync(0);setTimeout(()=>process.exit(0),100)"],'x'.repeat(4000000),{env,timeout:2000});}catch(error){safe=error.message==='dieter_process_stdin_failed:'+process.execPath;}
 return {version:'dieter-only-stdin-v1',tools_ready:true,dieter_stdin_safe:safe,process_alive:true,model_invocations:0};
}
