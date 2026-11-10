import {writeFile,readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
// Fixed arguments, no shell or network protocol; input has already been bounded.
export async function extractVideoFrames(body,dir,{execute=run}={}) {
 if(typeof body.video!=='string'||!/^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.video))throw Error('invalid_video');
 const bytes=Buffer.from(body.video,'base64');
 if(!bytes.length||bytes.length>12_000_000)throw Error('invalid_video_size');
 const input=join(dir,'input.video');await writeFile(input,bytes,{mode:0o600});
 const probe=await execute('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-f','mov','-show_entries','format=duration','-of','json',input],{timeout:15000,maxBuffer:100000});
 const duration=Number(JSON.parse(probe.stdout).format?.duration);
 if(!Number.isFinite(duration)||duration<=0||duration>60)throw Error('unsupported_video_duration');
 await execute('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-f','mov','-i',input,'-vf','fps=1,scale=1280:1280:force_original_aspect_ratio=decrease','-frames:v','60','-q:v','3',join(dir,'frame-%02d.jpg')],{timeout:30000,maxBuffer:100000});
 const paths=(await readdir(dir)).filter(name=>/^frame-\d\d\.jpg$/.test(name)).sort();
 if(!paths.length)throw Error('video_frames_missing');
 let total=0;const frames=[];
 for(const name of paths){const data=await readFile(join(dir,name));total+=data.length;if(!data.length||total>12_000_000)throw Error('video_frames_too_large');frames.push({mediaType:'image/jpeg',data:data.toString('base64'),label:`Video frame ${frames.length+1} of ${paths.length}`});}
 return {frames,duration,sampled:true};
}
