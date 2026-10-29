import http from 'node:http';import {nativeInfer} from './native.mjs';
let busy=false;
http.createServer(async(req,res)=>{
 if(req.url==='/health'){res.end('ok');return;}
 if(req.method!=='POST'||req.url!=='/infer'){res.writeHead(404).end();return;}
 if(busy){res.writeHead(409).end();return;}
 busy=true;
 try{let data='';for await(const chunk of req){data+=chunk;if(data.length>32000000)throw Error('request_too_large');}
 const body=JSON.parse(data);const result=await nativeInfer(body,{auth:body.auth});res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
 }catch{res.writeHead(500).end('{"error":"runner_failed"}');}finally{busy=false;}
}).listen(8080,'0.0.0.0');
