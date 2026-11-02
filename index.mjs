import {mountProjectApplication} from './foundation/implementation/src/web/project-application.ts';
import profile from './microduck-profile.json' with {type:'json'};

const REVISION='5ead0e42f7e44efb865941852fc8ecf93f8348ae4f1f48d2b27808713ff989d6';
const PROJECT_HASH='b32639fc7783f4d1f249f17ed458faf8b9e65ab3cbbdbfdcd844179265a18a82';
const LIMIT=8*1024*1024;
async function assetBytes(response) {
 if(!response.ok || !response.body)throw Error('Built-in project unavailable');
 const size=response.headers.get('content-length');
 if(size!==null && (!/^[0-9]+$/.test(size)||Number(size)>LIMIT))throw Error('Built-in project exceeds limit');
 const reader=response.body.getReader(),chunks=[];let total=0;
 try{while(true){const x=await reader.read();if(x.done)break;total+=x.value.byteLength;if(total>LIMIT){await reader.cancel();throw Error('Built-in project exceeds limit')}chunks.push(x.value)}}finally{reader.releaseLock()}
 const result=new Uint8Array(total);let offset=0;for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.length}return result;
}
async function digest(bytes){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')}

export function mount(host) {
 const body=document.createElement('div'),status=document.createElement('p'),root=document.createElement('div');
 body.className='window-content microduck-app';status.setAttribute('role','status');status.textContent='Preparing Microduck...';body.append(status,root);
 const abort=new AbortController();let disposed=false,application=null;
 const stop=()=>{if(disposed)return;disposed=true;abort.abort();host.signal?.removeEventListener('abort',stop);if(application){const owned=application;application=null;void owned.dispose().catch(error=>console.error('Microduck cleanup failed',error))}};
 host.signal?.addEventListener('abort',stop,{once:true});
 queueMicrotask(()=>{void (async()=>{
  try{
   if(disposed||host.signal?.aborted)return;
   const origin=host.microduckRunnerOrigin;
   let parsed;try{parsed=new URL(origin)}catch{throw Error('Microduck runner is not configured')}
   if(parsed.origin!==origin||!(parsed.protocol==='https:'||(parsed.protocol==='http:'&&['localhost','127.0.0.1'].includes(parsed.hostname)))||(typeof location!=='undefined'&&origin===location.origin))throw Error('Microduck runner configuration is invalid');
   const response=await fetch(new URL('./assets/microduck-project.json',import.meta.url),{signal:abort.signal,credentials:'same-origin',redirect:'error',cache:'no-store'});
   const bytes=await assetBytes(response);
   if(await digest(bytes)!==PROJECT_HASH)throw Error('Built-in project integrity check failed');
   if(disposed||host.signal?.aborted)return;
   const decision={project_revision:REVISION,...structuredClone(profile),runnerOrigin:origin,frameURL:origin+'/frame',policy:{...structuredClone(profile.policy),wasmUrl:new URL('./node_modules/@mujoco/mujoco/mujoco.wasm',import.meta.url).href}};
   application=mountProjectApplication({root,chooseDirectory:()=>typeof window.showDirectoryPicker==='function'?window.showDirectoryPicker():Promise.reject(Error('Folder selection unavailable')),folderLimits:{max_files:512,max_file_bytes:16777216,max_total_bytes:67108864,max_depth:32,max_path_length:240},inventoryLimits:decision.policy.inventoryLimits,resolveTrusted:r=>r===REVISION?structuredClone(decision):null});
   if(disposed||host.signal?.aborted){const owned=application;application=null;await owned.dispose();return}
   application.openFile(new File([bytes],'microduck.brf',{type:'application/json'}));
   status.textContent='Opening Microduck...';
  }catch(error){if(!disposed&&!host.signal?.aborted)status.textContent='Unable to open Microduck: '+String(error?.message||error)}
 })()});
 return {element:body,dispose:stop};
}
