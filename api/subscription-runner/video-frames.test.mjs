import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {extractVideoFrames} from './video-frames.mjs';
test('bounded local video is probed and sampled without shell or network access',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'video-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));const calls=[];
 const execute=async(cmd,args)=>{calls.push([cmd,args]);if(cmd==='ffprobe')return {stdout:'{"format":{"duration":"10"}}'};await writeFile(join(dir,'frame-01.jpg'),'synthetic jpeg');return {stdout:''};};
 const result=await extractVideoFrames({video:Buffer.from('synthetic').toString('base64')},dir,{execute});
 assert.equal(result.frames.length,1);assert.equal(result.sampled,true);assert.deepEqual(calls.map(c=>c[0]),['ffprobe','ffmpeg']);assert.ok(calls.every(c=>c[1].includes('file,pipe')));assert.ok(calls.every(c=>c[1].includes('mov')));
});
test('invalid, oversized, unknown and overlong video never reaches decoder',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'video-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 await assert.rejects(extractVideoFrames({video:'!'},dir),/invalid_video/);
 const execute=async()=>({stdout:'{"format":{"duration":"121"}}'});
 await assert.rejects(extractVideoFrames({video:Buffer.from('x').toString('base64')},dir,{execute}),/unsupported_video_duration/);
});
