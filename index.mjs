import './style.css';
import {mountProjectApplication} from './foundation/implementation/src/web/project-application.ts';
import profile from './microduck-profile.json' with {type:'json'};
import {createFileActions} from './file-actions.mjs';
import {createDriveGrant} from './drive-grant.mjs';
import {mountQuickDrive} from './quick-drive.mjs';

const REVISION='0183b6ea156fbb779121ecdb9b4c0ee205cdfec652eb427c4326b1064868ac2a';
const PROJECT_HASH='7bed18ccb5ee0da8d6939f8ce43fb4272fea35b82f357f0be4db92d28b4b63f2';
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
 body.className='window-content microduck-app';status.setAttribute('role','status');status.textContent='Preparing Microduck...';
 const files=document.createElement('div'),save=document.createElement('button'),open=document.createElement('button'),fileStatus=document.createElement('p');
 save.type='button';open.type='button';save.textContent='Save to My files';open.textContent='Open from My files';fileStatus.setAttribute('role','status');
 const grantButton=document.createElement('button'),grantStatus=document.createElement('p');
 grantButton.type='button';grantButton.textContent='Allow agent drive';grantButton.disabled=true;grantStatus.setAttribute('role','status');grantStatus.textContent='Agent drive is off.';
 files.className='microduck-files';root.className='microduck-content';files.append(save,open,fileStatus,grantButton,grantStatus);body.append(status,files,root);
 const abort=new AbortController();let disposed=false,application=null,quickDrive=null;
 const driveGrant=createDriveGrant(()=>application?.getDriveSession());let granted=false;const unregister=[];
 if(host.commands){unregister.push(host.commands.register({id:'set-walk-speed',description:'Request the Microduck walk speed when the person has enabled agent drive.',parameters:{type:'object',required:['speed'],properties:{speed:{type:'number',minimum:0,maximum:0.25}},additionalProperties:false}},args=>driveGrant.drive(args)));unregister.push(host.commands.register({id:'set-turn-rate',description:'Request the Microduck turn target when the person has enabled agent drive.',parameters:{type:'object',required:['turn'],properties:{turn:{type:'number',minimum:-1,maximum:1}},additionalProperties:false}},args=>driveGrant.drive(args)))}
 const resetGrant=()=>{driveGrant.revoke();granted=false;grantButton.textContent='Allow agent drive';grantStatus.textContent='Agent drive is off.';};
 grantButton.addEventListener('click',()=>{try{if(granted){resetGrant();return}driveGrant.enable();granted=true;grantButton.textContent='Turn off agent drive';grantStatus.textContent='Agent drive is on. The agent must still request a target.'}catch{resetGrant();grantStatus.textContent='Open a session before enabling agent drive.'}});
 const actions=host.storage?createFileActions(host,()=>application,()=>!disposed):null;
 save.disabled=!actions;open.disabled=!actions;
 save.addEventListener('click',()=>{if(!actions)return;fileStatus.textContent='Saving project...';void actions.saveAs().then(result=>{if(!disposed&&result)fileStatus.textContent=result.current?'Saved locally: '+result.path+' ('+result.status+').':'An earlier snapshot was saved; the current session has changed.'},error=>{if(!disposed)fileStatus.textContent='Save failed: '+String(error?.message||error)})});
 open.addEventListener('click',()=>{if(!actions)return;void (async()=>{try{if(typeof host.ui?.confirm!=='function')throw Error('Open confirmation unavailable');const confirmed=await host.ui.confirm('Open a saved project? Unsaved session changes will be closed.',{title:'Open Microduck project',signal:host.signal});if(!confirmed||disposed)return;fileStatus.textContent='Opening project...';const result=await actions.open();if(!disposed&&result)fileStatus.textContent='Opened '+result.path+'. Saved records are unverified.'}catch(error){if(!disposed)fileStatus.textContent='Open failed: '+String(error?.message||error)}})()});
 const stop=()=>{if(disposed)return;disposed=true;driveGrant.revoke();quickDrive?.dispose();quickDrive=null;for(const remove of unregister)remove();abort.abort();host.signal?.removeEventListener('abort',stop);if(application){const owned=application;application=null;void owned.dispose().catch(error=>console.error('Microduck cleanup failed',error))}};
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
   application=mountProjectApplication({root,compactPresentation:true,publishedDuckAssetURL:new URL('./assets/microduck-visual.json',import.meta.url).href,chooseDirectory:()=>typeof window.showDirectoryPicker==='function'?window.showDirectoryPicker():Promise.reject(Error('Folder selection unavailable')),folderLimits:{max_files:512,max_file_bytes:16777216,max_total_bytes:67108864,max_depth:32,max_path_length:240},inventoryLimits:decision.policy.inventoryLimits,resolveTrusted:r=>r===REVISION?structuredClone(decision):null,onSessionPublished:()=>{if(!disposed){status.textContent='Microduck ready.';resetGrant();grantButton.disabled=!host.commands;if(host.w)host.w.microduck={dirty:true};try{quickDrive?.dispose();quickDrive=mountQuickDrive(root,()=>application?.getDriveSession())}catch{quickDrive=null}}}});
   if(disposed||host.signal?.aborted){const owned=application;application=null;await owned.dispose();return}
   application.openFile(new File([bytes],'microduck.brf',{type:'application/json'}));
   status.textContent='Opening Microduck...';
  }catch(error){if(!disposed&&!host.signal?.aborted)status.textContent='Unable to open Microduck: '+String(error?.message||error)}
 })()});
 return {element:body,dispose:stop};
}
