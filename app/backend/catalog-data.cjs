'use strict';
// One atomic envelope keeps the runtime catalog and game-ID mapping in the same generation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {SafeStore}=require('./store.cjs');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const DEFAULT_ROOT=path.join(__dirname,'../catalog_data');
const baselineCatalog=fs.readFileSync(path.join(__dirname,'../data/catalog.json'));
const baseline={schema:'infalsus-local-catalog/v1',catalog:JSON.parse(baselineCatalog),mapping:require('./mapping.json'),accepted_catalog_hashes:[],source:null};
const FLAGS={'1':'MIN','2':'EVO','4':'ULT','8':'FBD'};
function reject(){throw new Error('LOCAL_CATALOG_INVALID_KEEP_PREVIOUS');}
function validate(value,isBaseline=false){
 if(!value||value.schema!=='infalsus-local-catalog/v1'||!value.catalog||!value.mapping||!Array.isArray(value.catalog.songs)||!Array.isArray(value.mapping.songs))reject();
 const {catalog,mapping}=value;
 if(mapping.catalog_sha256!==(isBaseline?hash(baselineCatalog):hash(JSON.stringify(catalog))))reject();
 if(!Array.isArray(value.accepted_catalog_hashes)||value.accepted_catalog_hashes.length>256||value.accepted_catalog_hashes.some(h=>! /^[a-f0-9]{64}$/.test(h)))reject();
 if(!Array.isArray(mapping.tutorial_ids)||JSON.stringify(mapping.tutorial_ids)!==JSON.stringify(baseline.mapping.tutorial_ids))reject();
 if(catalog.songs.length<baseline.catalog.songs.length||catalog.songs.length>5000||mapping.songs.length!==catalog.songs.length)reject();
 if(!isBaseline&&(catalog.meta?.song_count!==catalog.songs.length||catalog.meta?.chart_count!==catalog.songs.length*4||mapping.schema!=='infalsus-game-mapping/v1'))reject();
 const gameCharts=new Set();
 const songs=new Map(catalog.songs.map(s=>[s.id,s])),ids=new Set(),games=new Set(),projects=new Set();
 if(songs.size!==catalog.songs.length)reject();
 for(const m of mapping.songs){const s=songs.get(m.song_id);
  if(!s||!Number.isInteger(m.game_song_id)||m.game_song_id<1||m.game_song_id>65535||games.has(m.game_song_id)||projects.has(m.song_id)||typeof s.title!=='string'||!s.title.trim()||!/^if-(?:wiki|local)-[a-zA-Z0-9-]+$/.test(s.id))reject();games.add(m.game_song_id);projects.add(m.song_id);
  if(typeof m.base_name!=='string'||!m.base_name.trim()||m.base_name.length>128)reject();
  if(!isBaseline&&(s.game_song_id!==m.game_song_id||m.title!==s.title))reject();
  if(Object.keys(m.charts||{}).length!==4||Object.keys(s.charts||{}).length!==4)reject();
  for(const [f,d] of Object.entries(FLAGS)){const c=s.charts[d],link=m.charts[f];if(!c||!link||c.id!==s.id+'-'+d.toLowerCase()||ids.has(c.id)||c.id!==link.chart_id||c.difficulty!==d||c.song_id!==s.id||!Number.isInteger(c.rating)||c.rating<1||c.rating>99||c.rating!==link.constant||link.difficulty!==d||c.hidden_constant!==null)reject();ids.add(c.id);if(!isBaseline){if(typeof link.game_chart_id!=='string'||!link.game_chart_id.trim()||link.game_chart_id.length>128||gameCharts.has(link.game_chart_id))reject();gameCharts.add(link.game_chart_id);}}
 }
 if(!isBaseline){
  if(!value.source||! /^[a-f0-9]{64}$/.test(value.source.fingerprint)||!/^\d+$/.test(value.source.build_id)||value.source.adapter!=='local-metadata/1')reject();
  const src=value.source;
  if(!/^[a-f0-9]{64}$/.test(src.catalog_sha256)||!Array.isArray(src.files)||!src.files.length||src.files.length>24||! /^[a-f0-9]{40}$/.test(src.metadata_commit))reject();
  const names=new Set();for(const file of src.files){if(!/^[a-f0-9]{32}\.bundle$/.test(file.name)||! /^[a-f0-9]{64}$/.test(file.sha256)||names.has(file.name))reject();names.add(file.name);}
  if(src.fingerprint!==hash(JSON.stringify({build_id:src.build_id,catalog_sha256:src.catalog_sha256,files:src.files}))||catalog.meta.source_build!==src.build_id||catalog.meta.source_commit!==src.metadata_commit)reject();
  if(!value.accepted_catalog_hashes.includes(baseline.mapping.catalog_sha256))reject();
  assertCompatible(baseline,value);
 }
 return value;
}
function assertCompatible(previous,next){
 const rows=new Map(next.mapping.songs.map(s=>[s.game_song_id,s]));
 for(const old of previous.mapping.songs){const n=rows.get(old.game_song_id);if(!n||old.song_id!==n.song_id||old.base_name!==n.base_name)throw new Error('CATALOG_IDENTITY_REVIEW_REQUIRED');
  for(const [f,c] of Object.entries(old.charts)){if(n.charts[f]?.chart_id!==c.chart_id||c.game_chart_id&&c.game_chart_id!==n.charts[f]?.game_chart_id)throw new Error('CATALOG_IDENTITY_REVIEW_REQUIRED');}
 }
}
validate(baseline,true);
async function loadActive(root=DEFAULT_ROOT){const value=await new SafeStore(root).read('active.json');return value===null?baseline:validate(value);}
module.exports={hash,FLAGS,DEFAULT_ROOT,baseline,validate,assertCompatible,loadActive};
