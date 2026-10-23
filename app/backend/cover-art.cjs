'use strict';
// Optional local preview artwork. Never accept URL paths as filesystem paths.
const path=require('node:path');
const {readFile}=require('./readonly-resource.cjs');
const DEFAULT_COVER_ROOT=path.join(__dirname,'../assets/covers');
async function loadCoverAssets(root=DEFAULT_COVER_ROOT){
 const empty={files:new Map(),index:{schema:'infalsus-cover-index/v1',charts:{}}};
 try{
  const manifest=JSON.parse((await readFile(path.join(root,'manifest.json'),1024*1024)).toString('utf8'));
  if(manifest.schema!=='infalsus-cover-art/v1'||!Array.isArray(manifest.songs)||manifest.songs.length>10000)throw new Error('INVALID_COVER_MANIFEST');
  const files=new Map(),charts=Object.create(null);
  for(const song of manifest.songs){
   if(!/^if-(?:wiki|local)-[1-9][0-9]{0,9}$/.test(song.song_id)||song.file!==song.song_id+'.webp'||files.has('/assets/covers/'+song.file)||!Array.isArray(song.chart_ids)||song.chart_ids.length!==4)throw new Error('INVALID_COVER_MANIFEST');
   const url='/assets/covers/'+song.file;
   for(const chart of song.chart_ids){
    if(typeof chart!=='string'||!new RegExp('^'+song.song_id+'-(min|evo|ult|fbd)$').test(chart)||Object.hasOwn(charts,chart))throw new Error('INVALID_COVER_MANIFEST');
    charts[chart]=url;
   }
   files.set(url,path.join(root,song.file));
  }
  return {files,index:{schema:'infalsus-cover-index/v1',charts}};
 }catch{return empty;}
}
module.exports={loadCoverAssets,DEFAULT_COVER_ROOT};
