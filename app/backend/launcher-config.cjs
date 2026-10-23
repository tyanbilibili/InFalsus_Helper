'use strict';
// Configuration only: importing this module MUST NOT load the save reader or collector.
const path=require('node:path');
const {SafeStore}=require('./store.cjs');
const FEATURES=Object.freeze([
 // Keep the legacy 'rating' key: it now controls only overlay visibility, never the always-on query.
 {id:'rating',title:'启用游戏内 Rating 浮窗',description:'仅控制浮窗 · 查分始终开启',defaultEnabled:true},
 {id:'sideKeys',title:'启用全局侧边按键改写',description:'全局：鼠标左键 → LShift    鼠标右键 → Space    鼠标中键 → 原左键',defaultEnabled:false}
]);
const KEYS=Object.freeze([
 ...Array.from({length:24},(_,i)=>({code:112+i,label:`F${i+1}`})),
 ...Array.from({length:26},(_,i)=>({code:65+i,label:String.fromCharCode(65+i)})),
 ...Array.from({length:10},(_,i)=>({code:48+i,label:String(i)})),
 ...Array.from({length:10},(_,i)=>({code:96+i,label:`Num ${i}`})),
 ...[{code:8,label:'Backspace'},{code:9,label:'Tab'},{code:12,label:'Clear'},{code:13,label:'Enter'},
     {code:19,label:'Pause'},{code:20,label:'Caps Lock'},{code:27,label:'Esc'},{code:32,label:'Space'},
     {code:37,label:'Left'},{code:38,label:'Up'},{code:39,label:'Right'},{code:40,label:'Down'},
     {code:46,label:'Delete'},{code:93,label:'Menu'},{code:106,label:'Num *'},{code:107,label:'Num +'},
     {code:109,label:'Num -'},{code:110,label:'Num .'},{code:111,label:'Num /'},{code:144,label:'Num Lock'},
     {code:186,label:'; / :'},{code:187,label:'= / +'},{code:188,label:', / <'},{code:189,label:'- / _'},
     {code:190,label:'. / >'},{code:191,label:'/ / ?'},{code:192,label:'` / ~'},{code:219,label:'[ / {'},
     {code:220,label:'\\ / |'},{code:221,label:'] / }'},{code:222,label:"' / \""},{code:226,label:'OEM 102'}],
 ...[{code:36,label:'Home'},{code:35,label:'End'},{code:33,label:'Page Up'},{code:34,label:'Page Down'},{code:45,label:'Insert'},{code:145,label:'Scroll Lock'}]
]);
function defaults(){return {schema:'infalsus-launcher/v1',features:Object.fromEntries(FEATURES.map(f=>[f.id,f.defaultEnabled])),bindings:{ratingOverlay:116}};}
function validate(value){
 if(!value||value.schema!=='infalsus-launcher/v1')throw new Error('UNSUPPORTED_LAUNCHER_CONFIG');
 if(!value.features||Array.isArray(value.features)||!value.bindings||Array.isArray(value.bindings))throw new Error('INVALID_LAUNCHER_CONFIG');
 if(Object.keys(value).some(k=>!['schema','features','bindings'].includes(k))||Object.keys(value.features).some(k=>!FEATURES.some(f=>f.id===k))||Object.keys(value.bindings).some(k=>k!=='ratingOverlay'))throw new Error('UNKNOWN_CONFIG_FIELD_KEEP_FILE');
 const config=defaults();
 for(const feature of FEATURES){if(Object.hasOwn(value.features,feature.id)){if(typeof value.features[feature.id]!=='boolean')throw new Error('INVALID_FEATURE_SWITCH');config.features[feature.id]=value.features[feature.id];}}
 if(!KEYS.some(k=>k.code===value.bindings.ratingOverlay))throw new Error('INVALID_OVERLAY_KEY');
 config.bindings.ratingOverlay=value.bindings.ratingOverlay;return config;
}
async function load(store){await store.init();const saved=await store.read('launcher.json');return saved===null?defaults():validate(saved);}
async function save(store,value){const config=validate(value);await load(store);await store.write('launcher.json',config,{backup:true});return config;}
async function command(action,input,root=path.join(__dirname,'../user_data')){
 if(action==='defaults')return {config:defaults(),features:FEATURES,keys:KEYS};
 const store=new SafeStore(root);if(action==='get')return {config:await load(store),features:FEATURES,keys:KEYS};
 if(action==='set')return {config:await save(store,input),features:FEATURES,keys:KEYS};
 throw new Error('UNKNOWN_CONFIG_COMMAND');
}
if(require.main===module)(async()=>{
 const action=process.argv[2];if(process.argv.length!==3)throw new Error('INVALID_CONFIG_ARGUMENTS');
 let text='';if(action==='set'){for await(const chunk of process.stdin){text+=chunk;if(text.length>16384)throw new Error('CONFIG_TOO_LARGE');}}
 const result=await command(action,action==='set'?JSON.parse(text):null);process.stdout.write(JSON.stringify(result)+'\n');
})().catch(e=>{console.error(/^[A-Z_]+$/.test(e.message)?e.message:'CONFIG_IO_ERROR');process.exitCode=1;});
module.exports={FEATURES,KEYS,defaults,validate,load,save,command};
