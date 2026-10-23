'use strict';
// All writes are restricted to this store. No API accepts a game/save output path.
const fs=require('node:fs/promises'), path=require('node:path'), crypto=require('node:crypto');
const fail=code=>{throw new Error(code);};
async function noLinks(target) {
  let p=path.resolve(target);
  for(;;){
    try{const s=await fs.lstat(p);if(s.isSymbolicLink()||s.isFile()&&s.nlink>1)fail('UNSAFE_LINK_IN_STORE');}
    catch(e){if(e.code!=='ENOENT')throw e;}
    const up=path.dirname(p);if(up===p)break;p=up;
  }
}
class SafeStore {
  constructor(root){this.root=path.resolve(root);this.locked=false;}
  async init(){
    if(/(?:^|[\\/])LocalLow[\\/]lowiro[\\/]infalsus(?:[\\/]|$)/i.test(this.root))fail('STORE_MUST_NOT_BE_GAME_SAVE');
    for(let p=this.root;;p=path.dirname(p)) {
      for(const marker of ['infalsus.exe','infalsus_Data'])try{await fs.lstat(path.join(p,marker));fail('STORE_MUST_NOT_BE_GAME_INSTALL');}catch(e){if(e.code!=='ENOENT')throw e;}
      if(p===path.dirname(p))break;
    }
    await noLinks(this.root);await fs.mkdir(this.root,{recursive:true});await noLinks(this.root);
  }
  resolve(name){
    if(!/^(?:accounts\/[a-f0-9]{64}\/)?[a-z][a-z0-9.-]*\.(?:json|lock)$/.test(name))fail('INVALID_STORE_KEY');
    const file=path.resolve(this.root,...name.split('/'));
    if(!file.startsWith(this.root+path.sep))fail('STORE_ESCAPE');return file;
  }
  async read(name,fallback=null){
    const p=this.resolve(name);await noLinks(p);
    try{const s=await fs.stat(p);if(s.size>128*1024*1024)fail('STORE_TOO_LARGE');return JSON.parse(await fs.readFile(p,'utf8'));}
    catch(e){if(e.code==='ENOENT')return fallback;if(e instanceof SyntaxError)fail('STORE_CORRUPT_KEEP_FILES');throw e;}
  }
  async write(name,value,{backup=false}={}){
    const dest=this.resolve(name);await noLinks(dest);await fs.mkdir(path.dirname(dest),{recursive:true});await noLinks(dest);
    if(backup){const old=await this.read(name);if(old!==null)await this.write(name.replace(/\.json$/,'.backup.json'),old);}
    const temp=path.join(path.dirname(dest),'.'+crypto.randomBytes(12).toString('hex')+'.tmp');
    const h=await fs.open(temp,'wx',0o600);
    try{await h.writeFile(JSON.stringify(value)+'\n','utf8');await h.sync();}finally{await h.close();}
    try{await noLinks(dest);await fs.rename(temp,dest);}catch(e){await fs.unlink(temp).catch(()=>{});throw e;}
  }
  async lock(){
    const file=this.resolve('session.lock');await noLinks(file);
    let h;
    try{h=await fs.open(file,'wx',0o600);}catch(e){
      if(e.code!=='EEXIST')throw e;
      const old=await this.read('session.lock');
      if(!Number.isSafeInteger(old?.pid)||old.pid<=0)fail('INVALID_SESSION_LOCK');
      let alive=true;try{process.kill(old.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;}
      if(alive)fail('MOD_ALREADY_RUNNING');
      await noLinks(file);await fs.unlink(file);h=await fs.open(file,'wx',0o600);
    }
    try{await h.writeFile(JSON.stringify({pid:process.pid}),'utf8');}finally{await h.close();}this.locked=true;
  }
  async unlock(){
    if(!this.locked)return;
    const file=this.resolve('session.lock');await noLinks(file);
    const saved=await this.read('session.lock');if(saved?.pid===process.pid)await fs.unlink(file);this.locked=false;
  }
}
module.exports={SafeStore,noLinks};
