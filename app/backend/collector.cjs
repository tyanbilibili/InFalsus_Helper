'use strict';
const engine=require('../rating.js');
const {baseline,validate}=require('./catalog-data.cjs');
const {sha}=require('./save-reader.cjs');
const fs=require('node:fs'),path=require('node:path');
const MAX_RECORDS=100000, SCHEMA='infalsus-observed-history/v1';
function verifyMapping(){
  if(sha(fs.readFileSync(path.join(__dirname,'../../data/catalog.json')))!==baseline.mapping.catalog_sha256)throw new Error('CATALOG_CHANGED_REBUILD_MAPPING');
  validate(baseline,true);
}
verifyMapping();
function project(r,catalogData=baseline,byId=new Map(catalogData.mapping.songs.map(s=>[s.game_song_id,s]))) {
  const mapping=catalogData.mapping;
  if(mapping.tutorial_ids.includes(r.song_id))return {reason:'tutorial'};
  const song=byId.get(r.song_id),c=song?.charts[r.difficulty_flag];
  if(!c)return {reason:'unknown_song_or_difficulty'};
  const j=r.counts, n=j.shiny+j.perfect+j.near+j.miss;
  const score=BigInt(r.score);
  if(score<0n)return {reason:'invalid_score'};
  if(r.result_clear<2)return {reason:'not_cleared',chart_id:c.chart_id,title:song.title,difficulty:c.difficulty};
  if(!n||j.none||j.unused)return {reason:'incomplete_judgements'};
  const expected=100000000n*BigInt(j.shiny+j.perfect)+50000000n*BigInt(j.near)+BigInt(j.shiny)*BigInt(n);
  const delta=score*BigInt(n)-expected;
  if(delta>BigInt(n)||delta< -BigInt(n))return {reason:'score_judgement_mismatch'};
  return {chart_id:c.chart_id,title:song.title,difficulty:c.difficulty,play:{chart_id:c.chart_id,cleared:true,
    // Do NOT set assisted here: the caller must have the account owner's declaration.
    judgements:{shiny:j.shiny,perfect:j.perfect,near:j.near,miss:j.miss}}};
}
function validRaw(r){
  if(!r||!/^[a-f0-9]{64}$/.test(r.id)||!Number.isInteger(r.song_id)||r.song_id<1||r.song_id>65535||
    ![1,2,4,8].includes(r.difficulty_flag)||![0,1,2].includes(r.lamp)||![0,1,2,3,4].includes(r.result_clear)||
    typeof r.score!=='string'||! /^-?\d{1,19}$/.test(r.score)||!r.counts)return false;
  return ['shiny','perfect','near','miss','none','unused'].every(k=>Number.isInteger(r.counts[k])&&r.counts[k]>=0&&r.counts[k]<=524280);
}
class Collector {
  constructor(store,key,catalogData=baseline){this.catalogData=catalogData;this.byId=new Map(catalogData.mapping.songs.map(s=>[s.game_song_id,s]));if(!/^[a-f0-9]{64}$/.test(key))throw new Error('INVALID_ACCOUNT_KEY');this.store=store;this.key=key;this.name=`accounts/${key}/archive.json`;this.data=null;this.lastHash=null;this.state=null;}
  async load(){
    const mapping=this.catalogData.mapping;
    const d=await this.store.read(this.name);
    this.data=d||{schema:SCHEMA,account_key:this.key,algorithm_version:engine.VERSION,catalog_sha256:mapping.catalog_sha256,adapter_version:'0.1.0',eligibility_confirmed:false,confirmed_at:null,records:[],excluded:[],last_source:null,coverage:null};
    const x=this.data;
    const recordIds=new Set(Array.isArray(x.records)?x.records.map(r=>r?.id):[]);
    if(x.algorithm_version!==undefined&&x.algorithm_version!==engine.VERSION || x.catalog_sha256!==undefined&&x.catalog_sha256!==mapping.catalog_sha256&&!this.catalogData.accepted_catalog_hashes.includes(x.catalog_sha256))throw new Error('ARCHIVE_VERSION_REVIEW_REQUIRED');
    if(x.schema!==SCHEMA||x.account_key!==this.key||typeof x.eligibility_confirmed!=='boolean'||!Array.isArray(x.records)||x.records.length>MAX_RECORDS||
      !Array.isArray(x.excluded)||x.excluded.length>MAX_RECORDS||x.records.some(r=>!validRaw(r))||recordIds.size!==x.records.length||x.excluded.some(id=>!recordIds.has(id)))throw new Error('ARCHIVE_INVALID_KEEP_FILES');
    this.data={...x,algorithm_version:engine.VERSION,catalog_sha256:mapping.catalog_sha256,adapter_version:'0.1.0'};
    this.recompute();return this;
  }
  recompute(){
    const excluded=new Set(this.data.excluded),plays=[],playIds=[],records=[],reasons={};
    for(const r of this.data.records){
      const p=project(r,this.catalogData,this.byId),reason=excluded.has(r.id)?'user_excluded':p.reason||(!this.data.eligibility_confirmed?'eligibility_unknown':null);
      if(reason)reasons[reason]=(reasons[reason]||0)+1;
      if(!reason){plays.push({...p.play,assisted:false});playIds.push(r.id);}
      records.push({id:r.id,chart_id:p.chart_id||null,title:p.title||this.byId.get(r.song_id)?.title||`未知/教学 #${r.song_id}`,
        difficulty:p.difficulty||String(r.difficulty_flag),score:r.score,counts:r.counts,result_clear:r.result_clear,
        excluded:excluded.has(r.id),reason,first_observed_at:r.first_observed_at});
    }
    const result=this.data.eligibility_confirmed?engine.calculate({schema:engine.INPUT_SCHEMA,plays},this.catalogData.catalog):null;
    if(result){
      // Presentation enrichment only; keep all engine values and ordering untouched.
      const rawById=new Map(this.data.records.map(r=>[r.id,r]));
      result.top30=result.top30.map(r=>{
        const record_id=playIds[r.input_index],raw=rawById.get(record_id);
        return {...r,record_id,score:raw.score,counts:raw.counts,result_clear:raw.result_clear};
      });
      const evaluations=new Map(result.evaluated.map(r=>[playIds[r.input_index],r]));
      for(const r of records){const e=evaluations.get(r.id);if(e){r.rating_display=e.rating_display;r.accuracy_display=e.accuracy_display;r.reason=e.exclusion_reasons.join(',')||null;r.warnings=e.warnings;}}
      delete result.evaluated;
      // Algorithm output is unchanged; only correct the legacy offline-adapter status text.
      result.warning='非官方只读伴随模组；无辅助资格来自用户声明，非反作弊认证。已观察历史不等于完整生涯记录。';
    }
    this.records=records;
    this.state={account_key:this.key,eligibility_confirmed:this.data.eligibility_confirmed,confirmed_at:this.data.confirmed_at,
      observed_count:records.length,excluded_count:excluded.size,reason_counts:reasons,coverage:this.data.coverage,
      last_source:this.data.last_source,result};
  }
  async commit(next){
    const previous=this.data;this.data=next;
    try{this.recompute();await this.store.write(this.name,next,{backup:true});}
    catch(e){this.data=previous;this.recompute();throw e;}
  }
  async ingest(parsed,snapshot){
    if(this.lastHash===parsed.source_hash)return false;
    const known=new Map(this.data.records.map(r=>[r.id,r]));
    const now=new Date().toISOString();
    for(const r of parsed.history)if(!known.has(r.id)){if(!validRaw(r))throw new Error('INVALID_PARSED_RECORD');known.set(r.id,{...r,first_observed_at:now});}
    if(known.size>MAX_RECORDS)throw new Error('ARCHIVE_LIMIT_KEEP_LAST_RESULT');
    const maxScores=new Map();
    for(const r of known.values()){const k=r.song_id+':'+r.difficulty_flag;if(!maxScores.has(k)||BigInt(r.score)>maxScores.get(k))maxScores.set(k,BigInt(r.score));}
    let gaps=0;for(const h of parsed.highscores)if(!this.catalogData.mapping.tutorial_ids.includes(h.song_id)){
      const old=maxScores.get(h.song_id+':'+h.difficulty_flag);if(old===undefined||BigInt(h.score)>old)gaps++;
    }
    const coverage={history_occupied:parsed.occupied,history_capacity:parsed.slots,highscore_count:parsed.highscores.length,
      highscore_gaps:gaps,note:'高分仅用于覆盖缺口提示，不参与计算；相同分数也不能证明完整生涯覆盖。'};
    const last_source={sha256:snapshot.sha256,size:snapshot.size,mtime_ms:snapshot.mtime_ms,read_at:now};
    await this.commit({...this.data,records:[...known.values()],coverage,last_source});
    this.lastHash=parsed.source_hash;return true;
  }
  async confirm(value){if(typeof value!=='boolean')throw new Error('INVALID_CONFIRMATION');await this.commit({...this.data,eligibility_confirmed:value,confirmed_at:value?new Date().toISOString():null});}
  async exclude(id,value){
    if(typeof value!=='boolean'||!this.data.records.some(r=>r.id===id))throw new Error('INVALID_EXCLUSION');
    const set=new Set(this.data.excluded);value?set.add(id):set.delete(id);await this.commit({...this.data,excluded:[...set]});
  }
  publicState(){return this.state;}
}
module.exports={Collector,project,validRaw,verifyMapping,MAX_RECORDS};
