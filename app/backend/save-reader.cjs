'use strict';
// MemoryPack layout researched from REDDRAGON-HL/InFalsus-SaveData-Parser (MIT).
// Independent strict reader: NO serialization or writing API exists here.
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const SIZE = 96, SLOTS = 1024, MAX_BYTES = 32 * 1024 * 1024;
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const delay = ms => new Promise(r=>setTimeout(r,ms));
const failure = code => { const e = new Error(code); e.code=code; return e; };
function rawRecord(b, p) {
  const raw=b.subarray(p,p+SIZE);
  if (raw.length!==SIZE) throw failure('TRUNCATED_RECORD');
  if (raw.every(v=>v===0)) return null;
  const song_id=raw.readUInt16LE(0), difficulty_flag=raw[2], lamp=raw[3], result_clear=raw.readUInt16LE(4);
  if (!song_id || ![1,2,4,8].includes(difficulty_flag) || lamp>2 || result_clear>4) throw failure('UNSUPPORTED_RECORD_HEADER');
  const counts={shiny:0,perfect:0,near:0,miss:0,none:0,unused:0};
  for(let g=0;g<4;g++) {
    const a=Array.from({length:8},(_,i)=>raw.readUInt16LE(10+16*g+2*i));
    counts.none+=a[0]; counts.miss+=a[1]; counts.near+=a[2]+a[3]; counts.perfect+=a[4]+a[5]; counts.shiny+=a[6]; counts.unused+=a[7];
  }
  return {
    id: sha(raw),
    song_id,
    difficulty_flag,
    lamp,
    result_clear,
    counts,
    score: raw.readBigInt64LE(80).toString(),
    trailer: raw.subarray(88, 96).toString('hex')
  };
}
function candidate(b, start) {
  let p=start+1;
  const need=n=>{if(p+n>b.length)throw failure('TRUNCATED_SAVE');};
  need(4);const n=b.readInt32LE(p);p+=4;
  if(n<0 || n>4096)throw failure('INVALID_HIGHSCORE_COUNT');
  const highs=[],keys=new Set();
  for(let i=0;i<n;i++) {
    need(9);if(b[p++]!==3)throw failure('INVALID_HIGHSCORE_HEADER');
    const encoded=b.readInt32LE(p),len=b.readInt32LE(p+4);p+=8;
    if(len<1||len>160||encoded!==-len-1)throw failure('INVALID_NAME');
    need(len+3+SIZE);const name=b.toString('ascii',p,p+len);
    if(!/^[a-zA-Z0-9_-]+$/.test(name))throw failure('INVALID_NAME');p+=len;
    const song_id=b.readUInt16LE(p),flag=b[p+2];p+=3;
    if(b.readUInt16LE(p)!==song_id||b[p+2]!==flag)throw failure('KEY_MISMATCH');
    const r=rawRecord(b,p);p+=SIZE;
    if(!r || keys.has(song_id+':'+flag))throw failure('DUPLICATE_HIGHSCORE');
    keys.add(song_id+':'+flag);
    // Only structural/coverage information; NEVER feed these judgement counts to Rating.
    highs.push({song_id,difficulty_flag:flag,base_name:name,score:r.score});
  }
  need(5+SLOTS*SIZE+4);
  if(b[p++]!==2||b.readInt32LE(p)!==SLOTS)throw failure('INVALID_HISTORY');p+=4;
  const history=[];
  for(let i=0;i<SLOTS;i++,p+=SIZE){const r=rawRecord(b,p);if(r){r.slot=i;history.push(r);}}
  const cursor=b.readInt32LE(p);
  if(cursor<0)throw failure('INVALID_CURSOR'); // No assumption that this is a timestamp or modulo position.
  // The cursor is the next ring slot. Rotate the fixed history table into
  // chronological order instead of returning physical slot order.
  const next=cursor%SLOTS;
  history.sort((a,b)=>((a.slot-next+SLOTS)%SLOTS)-((b.slot-next+SLOTS)%SLOTS));
  history.forEach((r,i)=>{r.history_order=i;});
  return {history,highscores:highs,slots:SLOTS,occupied:history.length,cursor};
}
function parseSave(b) {
  if(!Buffer.isBuffer(b)||b.length<1||b.length>MAX_BYTES)throw failure('INVALID_SAVE_SIZE');
  if(b[0]!==9)throw failure('UNSUPPORTED_SAVE_VERSION');
  const found=[];
  for(let p=1;p+5+5+SLOTS*SIZE+4<=b.length;p++) {
    if(b[p]!==4)continue;
    try{found.push(candidate(b,p));}catch(e){if(!e.code)throw e;}
    if(found.length>1)throw failure('AMBIGUOUS_HISTORY');
  }
  if(found.length!==1)throw failure('HISTORY_LAYOUT_NOT_RECOGNIZED');
  return {...found[0],schema:'infalsus-history-v4',source_hash:sha(b)};
}
function same(a,b){return a.size===b.size && a.mtimeMs===b.mtimeMs && a.ino===b.ino && a.dev===b.dev;}
async function once(file) {
  // 'r' is the ONLY file-open mode in this module. No copy/repair/rename/write.
  const h=await fs.open(file,'r');
  try {
    const before=await h.stat();
    if(!before.isFile()||before.size<1||before.size>MAX_BYTES)throw failure('INVALID_SAVE_SIZE');
    // Bounded read: a growing file cannot cause unbounded allocation.
    const data=Buffer.alloc(before.size);let pos=0;
    while(pos<data.length){const {bytesRead}=await h.read(data,pos,data.length-pos,pos);if(!bytesRead)break;pos+=bytesRead;}
    const after=await h.stat(),named=await fs.stat(file);
    if(pos!==data.length||!same(before,after)||!same(after,named))throw failure('SAVE_CHANGING');
    return {data,stat:after,hash:sha(data)};
  } finally {await h.close();}
}
async function readStable(file,{attempts=4,interval=180}={}) {
  let last;
  for(let i=0;i<attempts;i++)try {
    const a=await once(file);await delay(interval);const b=await once(file);
    if(!same(a.stat,b.stat)||a.hash!==b.hash)throw failure('SAVE_CHANGING');
    return {buffer:b.data,sha256:b.hash,size:b.stat.size,mtime_ms:b.stat.mtimeMs};
  }catch(e){last=e;if(i+1<attempts)await delay(interval);}
  // Avoid disclosing account paths through error messages.
  throw failure(['ENOENT','EACCES','EPERM'].includes(last?.code)?last.code:(last?.code||'SAVE_READ_FAILED'));
}
function accountKey(file){return sha(path.resolve(file).toLowerCase());}
async function discover(root=path.join(process.env.USERPROFILE||require('node:os').homedir(),'AppData','LocalLow','lowiro','infalsus')) {
  let dirs;try{dirs=await fs.readdir(root,{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return [];throw failure('DISCOVERY_FAILED');}
  const accounts=[];
  for(const d of dirs)if(d.isDirectory()&&/^\d{15,20}$/.test(d.name)){
    const file=path.join(root,d.name,'release','savestate_V3.sav');
    try {const s=await fs.stat(file);if(s.isFile())accounts.push({key:accountKey(file),file});}catch(e){if(e.code!=='ENOENT')throw failure('DISCOVERY_FAILED');}
  }
  return accounts.sort((a,b)=>a.key.localeCompare(b.key));
}
module.exports={parseSave,rawRecord,readStable,discover,accountKey,sha,SIZE,SLOTS};
