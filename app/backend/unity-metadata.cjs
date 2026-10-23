'use strict';
// Narrow, read-only decoder: Addressables binary v2, UnityFS 7/8 LZ4, serialized assets v22.
// Unknown layouts fail closed. No game code, native library or resource is executed/exported.
const common=require('./unity-common.json');
const fail=()=>{throw new Error('UNSUPPORTED_LOCAL_RESOURCE_FORMAT');};
const LIMIT=64*1024*1024;
class Reader {
 constructor(b,be=false){this.b=b;this.p=0;this.be=be;}
 take(n){if(!Number.isSafeInteger(n)||n<0||this.p+n>this.b.length)fail();const v=this.b.subarray(this.p,this.p+n);this.p+=n;return v;}
 align(n=4){this.take((n-this.p%n)%n);}
 u8(){return this.take(1)[0];}
 u16(){const b=this.take(2);return this.be?b.readUInt16BE():b.readUInt16LE();}
 u32(){const b=this.take(4);return this.be?b.readUInt32BE():b.readUInt32LE();}
 i32(){const b=this.take(4);return this.be?b.readInt32BE():b.readInt32LE();}
 u64(){const b=this.take(8),n=this.be?b.readBigUInt64BE():b.readBigUInt64LE();if(n>BigInt(Number.MAX_SAFE_INTEGER))fail();return Number(n);}
 count(max=100000){const n=this.i32();if(n<0||n>max)fail();return n;}
 z(){const end=this.b.indexOf(0,this.p);if(end<0||end-this.p>4096)fail();const v=this.take(end-this.p).toString('utf8');this.take(1);return v;}
 str(){const n=this.count(1024*1024);const v=new TextDecoder('utf-8',{fatal:true}).decode(this.take(n));this.align();return v;}
}
function lz4(input,length){
 if(!Number.isInteger(length)||length<0||length>LIMIT)fail();
 const out=Buffer.alloc(length);let i=0,o=0;
 function extra(n){if(n!==15)return n;let x;do{if(i>=input.length)fail();x=input[i++];n+=x;}while(x===255);return n;}
 while(i<input.length){const token=input[i++],literal=extra(token>>>4);if(i+literal>input.length||o+literal>length)fail();input.copy(out,o,i,i+literal);i+=literal;o+=literal;if(i===input.length)break;
  if(i+2>input.length)fail();const offset=input.readUInt16LE(i);i+=2;if(offset===0||offset>o)fail();const n=extra(token&15)+4;if(o+n>length)fail();for(let j=0;j<n;j++)out[o+j]=out[o+j-offset];o+=n;
 }
 if(o!==length)fail();return out;
}
function decompress(b,n,flag){if(flag===0){if(b.length!==n)fail();return b;}if(flag===2||flag===3)return lz4(b,n);fail();}
function bundleFiles(b){
 if(b.length>LIMIT)fail();const r=new Reader(b,true);if(r.z()!=='UnityFS'||![7,8].includes(r.u32()))fail();r.z();if(!/^6000\./.test(r.z()))fail();if(r.u64()!==b.length)fail();const compressed=r.u32(),size=r.u32(),flags=r.u32();if(flags&~0x2ff||!(flags&64))fail();r.align(16);
 let info;if(flags&128){if(compressed>b.length-r.p)fail();info=b.subarray(b.length-compressed);}else info=r.take(compressed);
 const q=new Reader(decompress(info,size,flags&63),true);q.take(16);const blocks=Array.from({length:q.count(4096)},()=>({n:q.u32(),c:q.u32(),f:q.u16()}));
 const files=Array.from({length:q.count(128)},()=>({offset:q.u64(),size:q.u64(),flags:q.u32(),name:q.z()}));if(q.p!==q.b.length)fail();if(flags&512)r.align(16);
 if(blocks.reduce((s,x)=>s+x.n,0)>LIMIT)fail();const bytes=Buffer.concat(blocks.map(x=>decompress(r.take(x.c),x.n,x.f&63)));
 if(r.p>(flags&128?b.length-compressed:b.length))fail();
 return files.map(f=>{if(f.offset+f.size>bytes.length)fail();return {...f,bytes:bytes.subarray(f.offset,f.offset+f.size)};});
}
function typeTree(r){
 const count=r.count(30000),size=r.count(4*1024*1024),nodes=[];
 for(let i=0;i<count;i++){r.u16();const level=r.u8();r.u8();const type=r.u32(),name=r.u32(),bytes=r.i32();r.i32();const flags=r.u32();r.take(8);nodes.push({level,type,name,bytes,flags,children:[]});}
 const strings=r.take(size);function string(offset){if(offset&0x80000000){const v=common[offset&0x7fffffff];if(!v)fail();return v;}if(offset>=strings.length)fail();const q=new Reader(strings);q.p=offset;return q.z();}
 const stack=[];for(const n of nodes){n.type=string(n.type);n.name=string(n.name);if(n.level>64||n.level>stack.length)fail();stack.length=n.level;if(n.level)stack[n.level-1].children.push(n);stack.push(n);}
 if(!nodes.length||nodes[0].level!==0||nodes.slice(1).some(x=>!x.level))fail();return nodes[0];
}
function treeValue(n,r,budget){
 if(--budget.n<0)fail();let v;const t=n.type;
 if(t==='string')v=r.str();
 else if(n.children.length&&n.children[0].type==='Array'){
  const a=n.children[0];if(a.children.length!==2||a.children[0].name!=='size')fail();v=Array.from({length:r.count(100000)},()=>treeValue(a.children[1],r,budget));if(a.flags&0x4000)r.align();
 }else if(n.children.length){v=Object.create(null);for(const c of n.children){if(Object.hasOwn(v,c.name))fail();v[c.name]=treeValue(c,r,budget);}}
 else if(['int','SInt32'].includes(t))v=r.i32();
 else if(['UInt32','unsigned int'].includes(t))v=r.u32();
 else if(['bool','UInt8','char'].includes(t))v=r.u8();
 else if(t==='SInt8')v=r.take(1).readInt8();
 else if(['UInt16','unsigned short'].includes(t))v=r.u16();
 else if(['SInt16','short'].includes(t))v=r.take(2).readInt16LE();
 else if(['SInt64','long long','UInt64','unsigned long long'].includes(t))v=(t==='SInt64'||t==='long long'?r.take(8).readBigInt64LE():r.take(8).readBigUInt64LE()).toString();
 else if(t==='float')v=r.take(4).readFloatLE();
 else if(t==='double')v=r.take(8).readDoubleLE();
 else fail();
 if(n.flags&0x4000)r.align();return v;
}
function metadataObjects(b,targets){
 const r=new Reader(b,true);r.take(8);if(r.u32()!==22)fail();r.take(4);if(r.u8()!==0)fail();r.take(3);const metadataSize=r.u32();if(r.u64()!==b.length)fail();const offset=r.u64();r.take(8);if(metadataSize>offset||offset>b.length)fail();r.be=false;if(!/^6000\./.test(r.z()))fail();r.i32();const hasTree=r.u8();if(hasTree!==1)fail();
 const types=Array.from({length:r.count(4096)},()=>{const id=r.i32();r.u8();r.u16();if(id===114)r.take(16);r.take(16);const tree=typeTree(r);r.take(r.count(4096)*4);return {id,tree};});
 const entries=Array.from({length:r.count(100000)},()=>{r.align();r.take(8);const start=r.u64()+offset,size=r.u32(),type=r.i32();if(!types[type]||start+size>b.length||start<offset)fail();return {start,size,type};});
 if(r.p>offset)fail();const out=[];
 for(const e of entries)if(types[e.type].id===114){const q=new Reader(b.subarray(e.start,e.start+e.size));q.take(28);const name=q.str();if(!targets.includes(name))continue;q.p=0;const value=treeValue(types[e.type].tree,q,{n:1000000});if(q.p!==q.b.length||value.m_Name!==name)fail();out.push(value);}
 return out;
}
function readBundle(b,targets){return bundleFiles(b).filter(f=>f.flags&4).flatMap(f=>metadataObjects(f.bytes,targets));}
function catalogAssetLocations(b,requests){
 const targets=requests.map(x=>x.key);if(new Set(targets).size!==targets.length)fail();
 if(b.length>16*1024*1024)fail();function u(p){if(p<0||p+4>b.length)fail();return b.readUInt32LE(p);}
 if(u(0)!==0x0de38942||u(4)!==2)fail();
 function array(p,stride=4){if(p===0xffffffff)return [];const n=u(p-4);if(n>1000000||n%stride||p+n>b.length)fail();return Array.from({length:n/stride},(_,i)=>p+i*stride);}
 function str(id,sep='/',depth=0){if(depth>40)fail();if(id===0xffffffff)return null;if(id&0x40000000){let parts=[],seen=new Set();while(id!==0xffffffff){const p=id&0x3fffffff;if(seen.has(p)||parts.length>40)fail();seen.add(p);parts.push(str(u(p),sep,depth+1));id=u(p+4);}return parts.reverse().join(sep);}
  const p=id&0x3fffffff,n=u(p-4);if(n>8192||p+n>b.length)fail();return b.subarray(p,p+n).toString(id&0x80000000?'utf16le':'ascii');}
 const out=Object.fromEntries(targets.map(t=>[t,[]]));
 for(const p of array(u(8),8)){
  const key=u(p),type=u(key),obj=u(key+4);
  // Only System.String keys: do not interpret integer/hash keys as strings.
  if(str(u(type+4),'.')!=='System.String')continue;
  const name=str(u(obj),String.fromCharCode(u(obj+4)&65535));const target=requests.find(t=>name===t.key);if(!target)continue;
  for(const l of array(u(p+4))){const loc=u(l);if(str(u(loc+4))!==target.asset)fail();
   const deps=array(u(loc+12)).map(x=>{const s=str(u(u(x)+4));const match=/^\{UnityEngine\.AddressableAssets\.Addressables\.RuntimePath\}\/StandaloneWindows64\/([a-f0-9]{32}\.bundle)$/.exec(s);if(!match)fail();return match[1];});out[target.key].push(deps);
  }
 }
 for(const t of targets){if(out[t].length!==1||!out[t][0].length||out[t][0].length>8)fail();out[t]=out[t][0];}return out;
}
function catalogLocations(b,targets){
 const result=catalogAssetLocations(b,targets.map(t=>({key:'release/'+t+'.asset',asset:'Assets/BuildSpecificAssets/release/'+t+'.asset'})));
 return Object.fromEntries(targets.map(t=>[t,result['release/'+t+'.asset']]));
}
module.exports={Reader,lz4,bundleFiles,metadataObjects,readBundle,catalogLocations,catalogAssetLocations};
