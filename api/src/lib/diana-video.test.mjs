import test from 'node:test';import assert from 'node:assert/strict';
import {currentVideos,extractCurrentVideoFrames} from './diana-video.mjs';
const msg=a=>[{id:'original',direction:'in',attachments_json:JSON.stringify(a)}];
test('detect current video and fail closed if URL missing',()=>{
 assert.equal(currentVideos(msg([{mime_type:'video/mp4',file_url:'https://x.fbcdn.net/v'}]))[0].messageId,'original');
 assert.throws(()=>currentVideos(msg([{mime_type:'video/mp4'}])),/video_url_unavailable/);
 assert.equal(currentVideos(msg([{mime_type:'image/jpeg',file_url:'https://x.fbcdn.net/i'}])).length,0);
});
test('only Meta CDN can supply video and runner must return matching receipt',async()=>{
 let sent;const env={DIANA_SUBSCRIPTION:{fetch:async(_url,init)=>{sent=JSON.parse(init.body);return Response.json({frames:[{mediaType:'image/jpeg',data:'ZmFrZQ==',label:'frame 1'}],receipt:{operation:'video_frames',requestId:sent.requestId}});}}};
 const frames=await extractCurrentVideoFrames(env,[{messageId:'original',url:'https://x.fbcdn.net/v'}],{fetcher:async()=>new Response('fake')});
 assert.equal(sent.operation,'video_frames');assert.match(frames[0].label,/original/);
 await assert.rejects(extractCurrentVideoFrames(env,[{messageId:'original',url:'https://evil.example/v'}],{fetcher:async()=>new Response('fake')}),/untrusted/);
 env.DIANA_SUBSCRIPTION.fetch=async()=>Response.json({frames:[],receipt:{}});
 await assert.rejects(extractCurrentVideoFrames(env,[{messageId:'original',url:'https://x.fbcdn.net/v'}],{fetcher:async()=>new Response('fake')}),/invalid/);
});
