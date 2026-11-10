import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inflateSync} from 'node:zlib';

test('diagnostic image is an intact PNG',()=>{
 const source=readFileSync(new URL('../routes/internal-ugc.ts',import.meta.url),'utf8');
 const b=Buffer.from(source.match(/const pixel='([^']+)'/)[1],'base64');
 assert.equal(b.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 let p=8,idat=[];
 while(p<b.length){
  const len=b.readUInt32BE(p),type=b.subarray(p+4,p+8),data=b.subarray(p+8,p+8+len);let crc=0xffffffff;
  for(const byte of Buffer.concat([type,data])){crc^=byte;for(let i=0;i<8;i++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  assert.equal((crc^0xffffffff)>>>0,b.readUInt32BE(p+8+len),`${type.toString()} CRC`);
  if(type.toString()==='IDAT')idat.push(data);p+=12+len;
 }
 assert.ok(inflateSync(Buffer.concat(idat)).length>0);
});
