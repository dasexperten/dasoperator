import http from 'node:http';import {nativeInfer,runtimeCheck} from './native.mjs';
let busy=false;
http.createServer(async(req,res)=>{
 if(req.url==='/health'){res.end('ok');return;}
 if(req.method==='GET'&&req.url==='/runtime-check'){
  if(busy){res.writeHead(409).end();return;}busy=true;
  try{const result=await runtimeCheck();const ok=result.tools_ready&&result.dieter_stdin_safe&&result.diana_stdin_safe&&result.process_alive;res.writeHead(ok?200:503,{'Content-Type':'application/json'}).end(JSON.stringify(result));}
  catch{res.writeHead(503,{'Content-Type':'application/json'}).end(JSON.stringify({error:'runtime_check_failed'}));}finally{busy=false;}return;
 }
 if(req.method!=='POST'||req.url!=='/infer'){res.writeHead(404).end();return;}
 if(busy){res.writeHead(409).end();return;}
 busy=true;let phase='read_request';
 try{let data='';for await(const chunk of req){data+=chunk;if(data.length>32000000)throw Error('request_too_large');}
 phase='parse_request';const body=JSON.parse(data);phase='native_initialization';const result=await nativeInfer(body,{auth:body.auth});phase='write_response';res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 }catch(error){
  // A closed diagnostic vocabulary: never return exception text, paths,
  // request bodies or credential values from an initialization failure.
  const code=['ENOSPC','EACCES','ENOENT','EMFILE'].includes(error?.code)?error.code:
   error instanceof SyntaxError?'invalid_json':['request_too_large','invalid_request','subscription_auth_required'].includes(error?.message)?error.message:'unclassified';
  res.writeHead(500,{'Content-Type':'application/json'}).end(JSON.stringify({error:'runner_failed',diagnostic:{phase,code}}));
 }finally{busy=false;}
}).listen(8080,'0.0.0.0');
