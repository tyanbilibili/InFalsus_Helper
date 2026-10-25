'use strict';
// Offline updater. Reads a fixed metadata allowlist; only writes catalog_data via SafeStore.
const fs=require('node:fs/promises'),path=require('node:path');
const {SafeStore,noLinks}=require('./store.cjs');
const {readFile}=require('./readonly-resource.cjs');
const {catalogLocations,readBundle}=require('./unity-metadata.cjs');
const {hash,FLAGS,DEFAULT_ROOT,baseline,validate,assertCompatible,loadActive}=require('./catalog-data.cjs');
const targets=['SongData','DynamicStringMapping','PackData'];
const fail=code=>{throw new Error(code);};
function vdf(text){
 if(typeof text!=='string'||text.length>1024*1024)fail('INVALID_STEAM_MANIFEST');let p=0,count=0;
 function space(){while(p<text.length){if(/\s|\uFEFF/.test(text[p]))p++;else if(text.slice(p,p+2)==='//'){while(p<text.length&&text[p]!=='\n')p++;}else break;}}
 function token(){space();if(text[p++]!=='"')fail('INVALID_STEAM_MANIFEST');let s='';while(p<text.length){let c=text[p++];if(c==='"')return s;if(c==='\\'){c=text[p++];if(c!=='\\'&&c!=='"')fail('INVALID_STEAM_MANIFEST');}s+=c;}fail('INVALID_STEAM_MANIFEST');}
 function object(depth=0){if(depth>16)fail('INVALID_STEAM_MANIFEST');const result=Object.create(null);while(true){space();if(p===text.length){if(depth)fail('INVALID_STEAM_MANIFEST');break;}if(text[p]==='}'){if(!depth)fail('INVALID_STEAM_MANIFEST');p++;break;}const k=token();if(++count>30000||Object.hasOwn(result,k))fail('INVALID_STEAM_MANIFEST');space();if(text[p]==='{'){p++;result[k]=object(depth+1);}else result[k]=token();}return result;}
 return object();
}
async function discoverInstall(steamRoot){
 if(!steamRoot||!path.isAbsolute(steamRoot))fail('STEAM_NOT_FOUND');const roots=new Map();const addRoot=p=>{const resolved=path.resolve(p);roots.set(resolved.toLowerCase(),resolved);};addRoot(steamRoot);
 let libs={};try{libs=vdf((await readFile(path.join(steamRoot,'steamapps/libraryfolders.vdf'),1024*1024)).toString('utf8')).libraryfolders;}catch(e){if(e.code!=='ENOENT')throw e;}
 if(!libs||typeof libs!=='object')fail('INVALID_STEAM_MANIFEST');for(const v of Object.values(libs)){const p=typeof v==='object'?v.path:typeof v==='string'&&path.isAbsolute(v)?v:null;if(p){if(!path.isAbsolute(p))fail('INVALID_STEAM_MANIFEST');addRoot(p);}}
 const candidates=[];for(const root of roots.values()){const manifest=path.join(root,'steamapps/appmanifest_3971950.acf');try{const b=await readFile(manifest,1024*1024);const m=vdf(b.toString('utf8')).AppState;if(m?.appid!=='3971950'||!m.installdir||/[\\/:]|^\.{1,2}$/.test(m.installdir))fail('INVALID_STEAM_MANIFEST');candidates.push({gameRoot:path.join(root,'steamapps/common',m.installdir),manifest});}catch(e){if(e.code!=='ENOENT')throw e;}}
 if(candidates.length!==1)fail(candidates.length?'AMBIGUOUS_GAME_INSTALL':'GAME_NOT_FOUND');return candidates[0];
}
function localized(mapping){
 if(!mapping||!Array.isArray(mapping.Ids)||!Array.isArray(mapping.IdValues)||mapping.Ids.length!==mapping.IdValues.length)fail('INVALID_LOCAL_METADATA');
 const result=new Map();mapping.Ids.forEach((id,i)=>{const k=id.Value;if(!Number.isInteger(k)||result.has(k))fail('INVALID_LOCAL_METADATA');const texts=mapping.IdValues[i];if(!texts||typeof texts!=='object')fail('INVALID_LOCAL_METADATA');result.set(k,texts);});return result;
}
function clean(s,max=512){if(typeof s!=='string'||!s.trim()||s.length>max||/[\u0000-\u001f\u007f\ufffd]/.test(s))fail('INVALID_LOCAL_METADATA');return s;}
function choose(t){return clean(t?.SimplifiedChinese||t?.English||t?.Japanese||t?.TraditionalChinese||t?.Korean);}
function buildCatalog(tables,source,previous){
 const sd=tables.SongData,strings=tables.DynamicStringMapping,pd=tables.PackData;
 if(!sd||!strings||!pd||!Array.isArray(sd.allSongInfo)||!Array.isArray(pd.PackInfo)||! /^[a-f0-9]{40}$/.test(sd.CommitId)||sd.CommitId!==pd.CommitId)fail('INVALID_LOCAL_METADATA');
 const titles=localized(strings.songIdTitleTypeMapping),artists=localized(strings.songIdArtistTypeMapping),packs=localized(strings.packIdTypeMapping);
 const regular=new Map();for(const pack of pd.PackInfo){const id=pack.Id?.Value;if(id===0)continue;if(!Number.isInteger(id)||!Array.isArray(pack.SongIds))fail('INVALID_LOCAL_METADATA');for(const song of pack.SongIds){const k=song.Value;if(!Number.isInteger(k)||k<1||regular.has(k)||baseline.mapping.tutorial_ids.includes(k))fail('INVALID_LOCAL_METADATA');regular.set(k,{id,title:choose(packs.get(id)),slug:clean(pack.Slug),external:pack.ExternalURL});}}
 const oldMappings=new Map(previous.mapping.songs.map(s=>[s.game_song_id,s]));
 const rawKnown=new Map(require('../sources/save-adapter/songs.json').filter(x=>x.songId).map(s=>[s.songId,s]));
 const songs=[],mapped=[],seen=new Set(),chartIds=new Set();
 for(const raw of sd.allSongInfo){const id=raw.Id?.Value;if(!regular.has(id)){
   // Empty slots/tutorials are excluded; an unclassified playable entry is not silently dropped.
   if(raw.ChartInfos?.some(c=>c.Available)&&!baseline.mapping.tutorial_ids.includes(id))fail('UNCLASSIFIED_SONG_REVIEW_REQUIRED');continue;
  }
  if(seen.has(id)||!Array.isArray(raw.ChartInfos))fail('INVALID_LOCAL_METADATA');seen.add(id);const base=clean(raw.BaseName,128),old=oldMappings.get(id);
  if(old&&old.base_name!==base)fail('CATALOG_IDENTITY_REVIEW_REQUIRED');const sid=old?.song_id||'if-local-'+id;
  const title=choose(titles.get(id)),artist=choose(artists.get(id)),pack=regular.get(id),group={};const links={};
  const charts=raw.ChartInfos.filter(c=>c.Available===1||c.Available===true);
  if(charts.length!==4||raw.ChartInfos.some(c=>![0,1,false,true].includes(c.Available)))fail('CHART_LAYOUT_REVIEW_REQUIRED');
  for(const c of charts){const d=FLAGS[c.Difficulty];if(!d||group[d]||!Number.isInteger(c.Rating)||c.Rating<1||c.Rating>99)fail('CHART_LAYOUT_REVIEW_REQUIRED');const gameChart=clean(c.Id,128);if(chartIds.has(gameChart))fail('INVALID_LOCAL_METADATA');chartIds.add(gameChart);
   const oldGame=old?.charts[c.Difficulty]?.game_chart_id||rawKnown.get(id)?.charts.find(x=>({Hard:1,Expert:2,Extreme:4,Special:8})[x.difficulty]===c.Difficulty)?.chartId;
   if(oldGame&&oldGame!==gameChart)fail('CATALOG_IDENTITY_REVIEW_REQUIRED');const cid=sid+'-'+d.toLowerCase();
   // Note counts/BPM/audio duration are NOT derived from this metadata or guessed.
   group[d]={id:cid,song_id:sid,title,difficulty:d,rating:c.Rating,rating_kind:'local_resource_integer_rating',hidden_constant:null,designer:c.DisplayChartDesigner||null,total_notes:null,notes_method:null,notes_build:null,notes_live_verified:false,source_url:null,source_revision:null};
   links[c.Difficulty]={chart_id:cid,difficulty:d,constant:c.Rating,game_chart_id:gameChart};
  }
  songs.push({id:sid,title,title_en:titles.get(id)?.English||null,artist,pack:pack.title,is_dlc:pack.slug.startsWith('dlc-'),game_song_id:id,bpm_base:null,bpm_min:null,bpm_max:null,duration_seconds:null,source_url:null,source_revision:null,source_build:source.build_id,evidence_status:'local_readonly_metadata',version_note:null,charts:group});
  mapped.push({game_song_id:id,base_name:base,song_id:sid,title,charts:links});
 }
 if(seen.size!==regular.size)fail('INCOMPLETE_LOCAL_CATALOG');songs.sort((a,b)=>a.game_song_id-b.game_song_id);mapped.sort((a,b)=>a.game_song_id-b.game_song_id);
 const catalog={meta:{schema_version:'1.0.0',source:'local_readonly_metadata',source_build:source.build_id,source_commit:sd.CommitId,song_count:songs.length,chart_count:songs.length*4,chart_difficulties:Object.values(FLAGS),notes_definition:'未从本地元数据提取物量；实时评分使用游玩记录自带判定数。'},songs};
 const value={schema:'infalsus-local-catalog/v1',catalog,mapping:{schema:'infalsus-game-mapping/v1',catalog_sha256:hash(JSON.stringify(catalog)),tutorial_ids:baseline.mapping.tutorial_ids,songs:mapped},accepted_catalog_hashes:[...new Set([baseline.mapping.catalog_sha256,...previous.accepted_catalog_hashes,previous.mapping.catalog_sha256])],source:{...source,metadata_commit:sd.CommitId}};
 validate(value);assertCompatible(previous,value);return value;
}
async function extractLocal(install){
 const watched=new Map();async function read(file,limit){const b=await readFile(file,limit);watched.set(file,{sha256:hash(b),limit});return b;}
 const manifestBytes=await read(install.manifest,1024*1024),manifest=vdf(manifestBytes.toString('utf8')).AppState;
 if(manifest?.appid!=='3971950'||!/^\d+$/.test(manifest.buildid)||manifest.StateFlags!=='4'||manifest.TargetBuildID&&manifest.TargetBuildID!==manifest.buildid)fail('GAME_UPDATE_IN_PROGRESS');
 await noLinks(install.gameRoot);if(!(await fs.stat(path.join(install.gameRoot,'infalsus.exe'))).isFile())fail('GAME_NOT_FOUND');
 const aa=path.join(install.gameRoot,'infalsus_Data/StreamingAssets/aa'),catalog=await read(path.join(aa,'catalog.bin'),16*1024*1024),locations=catalogLocations(catalog,targets),tables=Object.create(null),files=[];
 for(const name of [...new Set(Object.values(locations).flat())].sort()){
  const bytes=await read(path.join(aa,'StandaloneWindows64',name),64*1024*1024);files.push({name,sha256:hash(bytes)});
  for(const table of readBundle(bytes,targets)){if(tables[table.m_Name]||!locations[table.m_Name].includes(name))fail('AMBIGUOUS_LOCAL_METADATA');tables[table.m_Name]=table;}
 }
 if(targets.some(t=>!tables[t]))fail('INCOMPLETE_LOCAL_CATALOG');
 const identity={build_id:manifest.buildid,catalog_sha256:hash(catalog),files};
 const source={adapter:'local-metadata/1',...identity,fingerprint:hash(JSON.stringify(identity)),checked_at:new Date().toISOString()};
 async function recheck(){for(const [file,old] of watched){if(hash(await readFile(file,old.limit))!==old.sha256)fail('GAME_FILES_CHANGING');}}
 return {tables,source,recheck};
}
async function checkUpdate({steamRoot,storeRoot=DEFAULT_ROOT,install=null,extract=extractLocal}={}){
 const store=new SafeStore(storeRoot);await store.init();await store.lock();try{
  const previous=await loadActive(storeRoot),found=install||await discoverInstall(steamRoot),read=await extract(found);
  const next=buildCatalog(read.tables,read.source,previous);await read.recheck();
  // Compare both the validated content and its source fingerprint, never a version label alone.
  const current=previous.source?.fingerprint===next.source.fingerprint&&previous.mapping.catalog_sha256===next.mapping.catalog_sha256;
  if(!current)await store.write('active.json',next,{backup:true});
  const old=new Map(previous.mapping.songs.map(s=>[s.game_song_id,s]));let changed=0;for(const s of next.mapping.songs)for(const [f,c] of Object.entries(s.charts))if(old.get(s.game_song_id)?.charts[f]?.constant!==c.constant)changed++;
  return {schema:'infalsus-catalog-check/v1',status:current?'current':'updated',build_id:next.source.build_id,song_count:next.catalog.songs.length,chart_count:next.catalog.songs.length*4,added_songs:next.catalog.songs.length-previous.catalog.songs.length,changed_charts:changed,fingerprint:next.source.fingerprint,message:current?'当前曲库已为最新！':'本地曲库同步完成！'};
 }finally{await store.unlock();}
}
if(require.main===module)(async()=>{if(process.argv.length!==4||process.argv[2]!=='--steam-root')fail('INVALID_UPDATE_ARGUMENTS');console.log(JSON.stringify(await checkUpdate({steamRoot:process.argv[3]})));})().catch(e=>{console.error(/^[A-Z][A-Z_0-9]{2,80}$/.test(e.message)?e.message:'LOCAL_UPDATE_IO_ERROR');process.exitCode=1;});
module.exports={vdf,readFile,discoverInstall,buildCatalog,extractLocal,checkUpdate};
