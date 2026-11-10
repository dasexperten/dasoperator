import http from 'node:http';import {fileURLToPath} from 'node:url';import {nativeInfer,runtimeCheck,runtimeProbe} from './native.mjs';
export function createDieterServer({infer=nativeInfer,checkRuntime=runtimeCheck,probe=runtimeProbe}={}){
let busy=false;const completed=new Map();
return http.createServer(async(req,res)=>{
 res.on('error',()=>{});
 if(req.method==='GET'&&req.url.startsWith('/result/')){let id;try{id=decodeURIComponent(req.url.slice(8));}catch{res.writeHead(400).end();return;}const value=completed.get(id);res.writeHead(value?200:404,{'Content-Type':'application/json'}).end(JSON.stringify(value??{error:'result_not_available'}));return;}
 if(req.url==='/health'){res.end('ok');return;}
 const isProbe=req.method==='POST'&&req.url==='/runtime-probe';
 const check=req.method==='GET'&&req.url==='/runtime-check';
 if(!check&&!isProbe&&(req.method!=='POST'||req.url!=='/infer')){res.writeHead(404).end();return;}
 if(busy){res.writeHead(409).end();return;}busy=true;
 try{
  let result;if(check)result=await checkRuntime();else{let data='';for await(const part of req){data+=part;if(data.length>32000000)throw Error('request_too_large');}const body=JSON.parse(data);result=completed.get(body.requestId);if(!result){if(isProbe&&!/^runtime-probe:[A-Za-z0-9_-]{1,100}$/.test(body.requestId))throw Error('invalid_request');result=isProbe?await probe(body.requestId):await infer(body);completed.set(body.requestId,result);}}
  if(!res.destroyed){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));}
 }catch(error){
  const code=['ENOSPC','EACCES','ENOENT','EMFILE'].includes(error?.code)?error.code:error instanceof SyntaxError?'invalid_json':'unclassified';
  if(!res.destroyed&&!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'}).end(JSON.stringify({error:'runner_failed',diagnostic:{phase:'native_initialization',code}}));
 }finally{busy=false;}
});
}
if(process.argv[1]===fileURLToPath(import.meta.url))createDieterServer().listen(8080,'0.0.0.0');
