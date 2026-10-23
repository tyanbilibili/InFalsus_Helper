'use strict';
const http=require('node:http'),fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {parseSave,readStable,discover,accountKey}=require('./save-reader.cjs');
const {SafeStore}=require('./store.cjs');
const {Collector}=require('./collector.cjs');
const {loadActive,DEFAULT_ROOT}=require('./catalog-data.cjs');
const {loadCoverAssets}=require('./cover-art.cjs');
const {readFile:readArtwork}=require('./readonly-resource.cjs');
const exportSettings=require('./export-settings.cjs');
const DECLARATION='all-nonexcluded-and-future-unassisted';
function publicError(e){const m=String(e?.message||'');return /^[A-Z][A-Z_0-9]{2,80}$/.test(m)?m:'LOCAL_IO_ERROR';}
async function startService({storeRoot=path.join(__dirname,'../user_data'),saveFiles=null,pollInterval=2500,parentPid=null,catalogRoot=null,coverRoot=undefined}={}) {
  const store=new SafeStore(storeRoot);await store.init();await store.lock();
  catalogRoot=catalogRoot||(path.resolve(storeRoot)===path.resolve(__dirname,'../user_data')?DEFAULT_ROOT:path.join(storeRoot,'catalog-data'));
  let preferences,server,timer,parentTimer,catalogData;
  try{catalogData=await loadActive(catalogRoot);preferences=await store.read('preferences.json',{selected_account:null});}
  catch(e){await store.unlock();throw e;}
  if(!preferences||!(preferences.selected_account===null||/^[a-f0-9]{64}$/.test(preferences.selected_account))){await store.unlock();throw new Error('INVALID_PREFERENCES');}
  let accounts=[],selected=saveFiles?.length===1?accountKey(saveFiles[0]):preferences.selected_account,collector=null,error=null,stale=true,lastChecked=null,closed=false,queue=Promise.resolve(),lastOverlay='';
  const token=crypto.randomBytes(32).toString('hex');let origin;
  const enqueue=fn=>{const job=queue.then(fn);queue=job.catch(()=>{});return job;};
  function state(){return {schema:'infalsus-live-state/v1',mode:'read-only-companion',algorithm_version:'1.0.0',
    catalog:{build_id:catalogData.source?.build_id||null,source:catalogData.source?'local':'baseline',sha256:catalogData.mapping.catalog_sha256,song_count:catalogData.catalog.songs.length},
    accounts:accounts.map((a,i)=>({key:a.key,label:`账号 ${i+1} · ${a.key.slice(0,8)}`})),selected_account:selected,
    status:error?'error':!accounts.length?'waiting_save':!selected?'choose_account':!collector?'waiting_save':stale?'stale':collector.data.eligibility_confirmed?'ready':'needs_declaration',
    error,stale,last_checked_at:lastChecked,...(collector?.publicState()||{} )};}
  async function overlay(){
    const s=state(),v={schema:s.schema,status:s.status,error:s.error,stale:s.stale,rating:s.result?.rating_display||'--',
      selected_count:s.result?.selected_count||0,observed_count:s.observed_count||0,eligibility_confirmed:s.eligibility_confirmed||false};
    const text=JSON.stringify(v);if(text!==lastOverlay){await store.write('overlay.json',v);lastOverlay=text;}
  }
  async function scan(){
    try{
      const active=await loadActive(catalogRoot);
      accounts=saveFiles?saveFiles.map(f=>({file:path.resolve(f),key:accountKey(f)})):await discover();
      if(new Set(accounts.map(a=>a.key)).size!==accounts.length)throw new Error('DUPLICATE_ACCOUNT');
      for(const a of accounts){
        if(path.basename(a.file)!=='savestate_V3.sav')throw new Error('UNEXPECTED_SAVE_FILENAME');
        const real=await fs.realpath(a.file),out=await fs.realpath(store.root);
        if(real.toLowerCase().startsWith(out.toLowerCase()+path.sep))throw new Error('SAVE_INSIDE_MOD_STORE');
      }
      if(!selected&&accounts.length===1){selected=accounts[0].key;await store.write('preferences.json',{selected_account:selected});}
      if(!selected){catalogData=active;error=null;stale=true;return;}
      const account=accounts.find(a=>a.key===selected);
      if(!account)throw new Error('SELECTED_SAVE_UNAVAILABLE');
      if(!collector||collector.key!==selected||catalogData.mapping.catalog_sha256!==active.mapping.catalog_sha256){const c=await new Collector(store,selected,active).load();collector=c;}
      catalogData=active;
      const snap=await readStable(account.file);
      if(collector.lastHash!==snap.sha256)await collector.ingest(parseSave(snap.buffer),snap);
      stale=false;error=null;lastChecked=new Date().toISOString();
    }catch(e){stale=true;error=publicError(e);}
    finally {await overlay();}
  }
  async function poll(){if(closed)return;try{await enqueue(scan);}catch(e){error=publicError(e);stale=true;}if(!closed)timer=setTimeout(poll,pollInterval);}
  async function close(){
    if(closed)return;closed=true;clearTimeout(timer);clearInterval(parentTimer);
    if(server)await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections?.();});
    await queue;await store.unlock();
  }
  const covers=await loadCoverAssets(coverRoot);
  const staticFiles={'/display.js':['../../display.js','text/javascript; charset=utf-8'],'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8']};
  // Explicit visual assets only: no arbitrary path or directory access.
  staticFiles['/assets/interface.css']=['../../assets/interface.css','text/css; charset=utf-8'];
  staticFiles['/assets/interface-triangles.svg']=['../../assets/interface-triangles.svg','image/svg+xml'];
  // Explicit local-font allowlist, never a general directory/file endpoint.
  for(const name of ['fonts.css','Kazesawa-Regular.ttf','Kazesawa-Bold.ttf','IFCJKText-Regular.ttf','IFCJKText-Bold.ttf','Oxanium-Regular.ttf','Oxanium-Bold.ttf']){
    staticFiles['/assets/fonts/'+name]=['../../assets/fonts/'+name,name.endsWith('.css')?'text/css; charset=utf-8':'font/ttf'];
  }
  async function body(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8192)throw new Error('BODY_TOO_LARGE');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  function send(res,status,value){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));}
  const validToken=req=>{const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+token);return a.length===b.length&&crypto.timingSafeEqual(a,b);};
  server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try{
      if(req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin)return send(res,403,{error:'ORIGIN_REJECTED'});
      const url=new URL(req.url,origin);
      if(req.method==='GET'&&url.pathname==='/assets/covers/index.json')return send(res,200,covers.index);
      if(req.method==='GET'&&covers.files.has(url.pathname)){
        try{const data=await readArtwork(covers.files.get(url.pathname),1024*1024);res.writeHead(200,{'Content-Type':'image/webp'});return res.end(data);}
        catch{return send(res,404,{error:'ARTWORK_UNAVAILABLE'});}
      }
      if(!url.pathname.startsWith('/api/')){
        if(req.method!=='GET'||!staticFiles[url.pathname])return send(res,404,{error:'NOT_FOUND'});
        const [file,type]=staticFiles[url.pathname],data=await fs.readFile(path.join(__dirname,'web',file));res.writeHead(200,{'Content-Type':type});return res.end(data);
      }
      if(!validToken(req))return send(res,401,{error:'AUTH_REQUIRED'});
      if(req.method==='GET'&&url.pathname==='/api/export/settings')return send(res,200,await exportSettings.readSettings(store));
      if(req.method==='GET'&&url.pathname==='/api/state')return send(res,200,state());
      if(req.method==='GET'&&url.pathname==='/api/records'){
        const offset=Number(url.searchParams.get('offset')||0),search=(url.searchParams.get('search')||'').slice(0,120).toLowerCase();
        if(!Number.isSafeInteger(offset)||offset<0||offset>100000)return send(res,400,{error:'INVALID_OFFSET'});
        const rows=(collector?.records||[]).filter(r=>r.title.toLowerCase().includes(search)).slice().reverse();
        return send(res,200,{total:rows.length,offset,rows:rows.slice(offset,offset+50)});
      }
      if(req.method!=='POST')return send(res,405,{error:'METHOD_REJECTED'});
      if(req.headers['content-type']!=='application/json')return send(res,415,{error:'JSON_REQUIRED'});
      const data=await body(req);
      if(!data||typeof data!=='object'||Array.isArray(data))return send(res,400,{error:'INVALID_BODY'});
      if(url.pathname==='/api/export/settings'){const value=await enqueue(()=>exportSettings.saveSettings(store,data.directory));return send(res,200,value);}
      if(url.pathname==='/api/shutdown'){send(res,200,{ok:true});setImmediate(()=>close().catch(()=>{}));return;}
      await enqueue(async()=>{
        if(url.pathname==='/api/catalog/refresh'){
          await scan();
        }else if(url.pathname==='/api/select'){
          if(!accounts.some(a=>a.key===data.key))throw new Error('UNKNOWN_ACCOUNT');
          await store.write('preferences.json',{selected_account:data.key});
          selected=data.key;collector=null;stale=true;error=null;await scan();
        }else if(url.pathname==='/api/confirm'){
          if(!collector)throw new Error('NO_ACCOUNT');if(data.account_key!==collector.key)throw new Error('ACCOUNT_CHANGED_REFRESH');
          if(data.value===true&&data.declaration!==DECLARATION)throw new Error('DECLARATION_REQUIRED');
          await collector.confirm(data.value);await overlay();
        }else if(url.pathname==='/api/exclude'){
          if(!collector)throw new Error('NO_ACCOUNT');if(data.account_key!==collector.key)throw new Error('ACCOUNT_CHANGED_REFRESH');await collector.exclude(data.id,data.value);await overlay();
        }else throw new Error('NOT_FOUND');
      });
      send(res,200,state());
    }catch(e){send(res,400,{error:publicError(e)});}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;server.keepAliveTimeout=2000;
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;await enqueue(scan);}
  catch(e){await close();throw e;}
  timer=setTimeout(poll,pollInterval);
  if(parentPid)parentTimer=setInterval(()=>{try{process.kill(parentPid,0);}catch(e){if(e.code==='ESRCH')close().catch(()=>{});}},3000);
  return {origin,token,url:origin+'/#'+token,close,state,refresh:()=>enqueue(scan)};
}
if(require.main===module)(async()=>{
  const args=process.argv.slice(2);let saveFiles=null,parentPid=null;
  for(let i=0;i<args.length;i++){
    if(args[i]==='--save'&&args[i+1])saveFiles=[args[++i]];
    else if(args[i]==='--parent-pid'&&/^\d+$/.test(args[i+1]||''))parentPid=Number(args[++i]);
    else throw new Error('INVALID_ARGUMENTS');
  }
  const app=await startService({saveFiles,parentPid});
  console.log('READY '+JSON.stringify({url:app.url,pid:process.pid}));
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().catch(()=>{}));
})().catch(e=>{console.error(publicError(e));process.exitCode=1;});
module.exports={startService,DECLARATION};

