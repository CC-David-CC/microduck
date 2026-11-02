import {acquireProjectFolder, type ProjectFolderLimits} from '../projects/project-folder-acquisition.ts';
import {captureProjectInventory, type ProjectInventory, type ProjectInventoryLimits} from '../projects/project-inventory.ts';
import {readManifestJson} from '../projects/manifest-json.ts';
import {safeProjectPath} from '../projects/project-path.ts';
import {decodeExperimentFile,encodeExperimentFile} from '../projects/experiment-file.ts';
import {encodeMeasuredAttemptRecord} from '../experiments/measured-attempt-record.ts';
import {inspectMeasuredAttemptRecord} from '../experiments/measured-attempt-record.ts';
import {summarizeSavedTargets} from './saved-target-summary.ts';
import {summarizeSavedNotes} from './saved-notes-summary.ts';
import {inspectGameChallenge} from '../experiments/game-challenge-record.ts';

type OverviewEvent = {kind:'selected';attempt:number;revision:string} | {kind:'overview';attempt:number;revision:string;goal:string|null;welcome:string|null;schematic?:boolean;simpleDuck?:boolean;tutorial?:boolean;turnGoal?:{body:string;min_radians:number}|null;targetLabels?:readonly {group_id:string;field:string;label:string}[]};
export type ProjectInspectorConfig = {chooseDirectory:()=>Promise<unknown>; folderLimits:ProjectFolderLimits; inventoryLimits:ProjectInventoryLimits; onChoice?:(attempt:number)=>void; onSelectionCleared?:()=>void; captureSessionGame?:(inventory:Readonly<ProjectInventory>)=>{id:string;content:Blob;isCurrent:()=>boolean}|null; captureSessionNotes?:(inventory:Readonly<ProjectInventory>)=>{content:Blob;isCurrent:()=>boolean}|null; captureSessionMeasured?:(inventory:Readonly<ProjectInventory>)=>{id:string;receipt:unknown;isCurrent:()=>boolean}|null; captureSessionTargets?:(inventory:Readonly<ProjectInventory>)=>{id:string;encode:()=>Promise<Blob>;isCurrent:()=>boolean}|null; onOverview?:(event:OverviewEvent)=>void};

/** Inspect selected source bytes; this does not admit, compile or run a project. */
export function mountProjectInspector({root,chooseDirectory,folderLimits,inventoryLimits,onChoice,onSelectionCleared,captureSessionGame,captureSessionNotes,captureSessionMeasured,captureSessionTargets,onOverview}:{root:HTMLElement}&ProjectInspectorConfig) {
  if (!root || !root.ownerDocument || typeof root.ownerDocument.createElement!=='function' || typeof root.appendChild!=='function' || typeof chooseDirectory!=='function') throw new Error('Invalid project inspector');
  const limits = <T extends object>(value:T, keys:readonly string[]):T => {
    if (!value || typeof value!=='object' || Array.isArray(value) || ![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length!==keys.length) throw new Error('Invalid project inspector limits');
    const result:Record<string,number>=Object.create(null);
    for (const key of keys) {
      const d=Object.getOwnPropertyDescriptor(value,key);
      if (!d || !Object.hasOwn(d,'value') || !Number.isSafeInteger(d.value) || d.value<1) throw new Error('Invalid project inspector limits');
      result[key]=d.value;
    }
    return Object.freeze(result) as T;
  };
  const folder=limits(folderLimits,['max_files','max_file_bytes','max_total_bytes','max_depth','max_path_length']);
  const inventoryCaps=limits(inventoryLimits,['max_files','max_file_bytes','max_total_bytes','max_manifest_bytes','max_manifest_depth']);
  if (folder.max_files>4096 || folder.max_file_bytes>67108864 || folder.max_total_bytes>268435456 || folder.max_depth>64 || folder.max_path_length>960 || inventoryCaps.max_manifest_depth>64) throw new Error('Invalid project inspector limits');
  const doc=root.ownerDocument, container=doc.createElement('section'), button=doc.createElement('button'), status=doc.createElement('p'), overview=doc.createElement('p');
  container.setAttribute('data-brf','project-inspector');
  button.setAttribute('data-brf','project-choose');button.setAttribute('type','button');button.textContent='Inspect project folder';
  status.setAttribute('data-brf','project-status');status.setAttribute('role','status');status.textContent='No folder inspected.';
  overview.setAttribute('data-brf','project-overview');overview.textContent='No project overview yet.';
  const fileInput=doc.createElement('input');fileInput.setAttribute('data-brf','project-file-input');fileInput.setAttribute('type','file');fileInput.setAttribute('aria-label','Inspect saved project file');
  const savedRecords=doc.createElement('p');savedRecords.setAttribute('data-brf','saved-records');savedRecords.textContent='No saved records selected.';
  const exportButton=doc.createElement('button'),exportStatus=doc.createElement('p');exportButton.setAttribute('data-brf','project-file-export');exportButton.setAttribute('type','button');exportButton.textContent='Download project and saved attempts';exportButton.disabled=true;
  exportStatus.setAttribute('data-brf','project-file-export-status');exportStatus.textContent='No export prepared.';
  container.append(button,fileInput,status,overview,savedRecords,exportButton,exportStatus);
  let disposed=false, generation=0, selected:Readonly<ProjectInventory>|null=null, acquisition:AbortController|null=null;
  let loadedRecords:{id:string;kind:'game'|'research';content:Blob}[]=[],exportActive=false;const exportUrls=new Set<string>();
  const syncExport=()=>{exportButton.disabled=disposed||!selected||exportActive;};
  const attempts=new WeakMap<object,number>();
  const notify=(event:OverviewEvent)=>{try {onOverview?.(Object.freeze(event));} catch { /* Presentation observer cannot block inspection. */ }};
  // Two concurrent reads let a replacement progress while an older read is
  // stalled; a single latest-value slot bounds subsequent pending selections.
  let activeOverviews=0, queuedOverview:Readonly<ProjectInventory>|null=null;
  function startOverview(result:Readonly<ProjectInventory>) {
    if (disposed || selected!==result) return;
    if (activeOverviews>=2) { queuedOverview=result; return; }
    queuedOverview=null; activeOverviews++;
    void showOverview(result).finally(()=>{
      activeOverviews--;
      const next=queuedOverview;
      if (next && !disposed && selected===next) {queuedOverview=null;startOverview(next);}
    });
  }
  async function showOverview(result:Readonly<ProjectInventory>):Promise<void> {
    try {
      const manifest=result.envelope.document.data;
      const title=manifest.title, reference=manifest.experience;
      if (typeof title!=='string' || !title || title.length>160 || typeof reference!=='string') throw new Error('Invalid overview');
      const path=safeProjectPath(reference);
      if (!Object.hasOwn(result.envelope.files,path) || !Object.hasOwn(result.files,path)) throw new Error('Missing overview');
      const descriptor=await readManifestJson(result.files[path].content,{max_bytes:65536,max_depth:16});
      const data=descriptor.data, version=descriptor.numberSpan(['schema_version']);
      const goal=data.goal;
      const goalLabel=goal && typeof goal==='object' && !Array.isArray(goal) ? (goal as Record<string,unknown>).label : undefined;
      if (data.schema_version!==1 || !version || descriptor.source.slice(version.start,version.end)!=='1' ||
          typeof data.welcome!=='string' || !data.welcome || data.welcome.length>1200 ||
          typeof goalLabel!=='string' || !goalLabel || goalLabel.length>240) throw new Error('Invalid overview');
      let schematic=false,simpleDuck=false;
      if(Object.hasOwn(data,'visual_representations')) {
        const representations=data.visual_representations;
        if(!Array.isArray(representations)||representations.length>8||representations.some((row:any)=>!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==2||typeof row.id!=='string'||typeof row.label!=='string'||!row.label||row.label.length>80))throw Error('Invalid representations');
        schematic=representations.some((row:any)=>row.id==='body-schematic');simpleDuck=representations.some((row:any)=>row.id==='microduck-simple');
      }
      let targetLabels:{group_id:string;field:string;label:string}[]=[];
      if(Object.hasOwn(data,'target_labels')) {
        if(!Array.isArray(data.target_labels)||data.target_labels.length>32)throw Error('Invalid target labels');
        const seen=new Set<string>();for(const row of data.target_labels){
          if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).length!==3||typeof row.group_id!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(row.group_id)||typeof row.field!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.field)||typeof row.label!=='string'||!row.label.trim()||row.label.length>80||/[\u0000-\u001f\u007f]/.test(row.label))throw Error('Invalid target label');
          const key=row.group_id+'\0'+row.field;if(seen.has(key))throw Error('Duplicate target label');seen.add(key);targetLabels.push({group_id:row.group_id,field:row.field,label:row.label});
        }
      }
      const tutorial=(goal as Record<string,unknown>).kind==='target-then-step';
      let turnGoal:{body:string;min_radians:number}|null=null;
      if((goal as Record<string,unknown>).kind==='turn-body') {const candidate=goal as Record<string,unknown>;if(typeof candidate.body!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(candidate.body)||typeof candidate.min_radians!=='number'||!Number.isFinite(candidate.min_radians)||candidate.min_radians<0.00001||candidate.min_radians>Math.PI)throw Error('Invalid turn goal');turnGoal={body:candidate.body,min_radians:candidate.min_radians};}

      const text=`Project: ${title} | Welcome: ${data.welcome} | Project's stated goal (not verified): ${goalLabel}`;
      if (text.length>2048) throw new Error('Overview too long');
      if (!disposed && selected===result) {overview.textContent=text;notify({kind:'overview',attempt:attempts.get(result)!,revision:result.project_revision,goal:goalLabel,welcome:data.welcome,schematic,simpleDuck,targetLabels,tutorial,turnGoal});}
    } catch {
      if (!disposed && selected===result) {overview.textContent='Project overview unavailable.';notify({kind:'overview',attempt:attempts.get(result)!,revision:result.project_revision,goal:null,welcome:null});}
    }
  }
  let activeDecodes=0,queuedFile:{file:File;token:number}|null=null;
  const onChoose=()=>{
    if (disposed) return;
    const token=++generation;queuedFile=null;savedRecords.textContent='No saved records selected.';
    try {onChoice?.(token);} catch { /* Observer has no acquisition authority. */ }
    if (disposed || token!==generation) return;
    acquisition?.abort();
    const controller=new AbortController();acquisition=controller;
    status.textContent='Choosing project folder…';
    let choice:Promise<unknown>;
    try {choice=chooseDirectory();} catch(error) {choice=Promise.reject(error);}
    void (async()=>{
      try {
        const directory=await choice;
        if (disposed || token!==generation) return;
        status.textContent='Inspecting project folder…';
        const entries=await acquireProjectFolder(directory,folder,{signal:controller.signal});
        if (disposed || token!==generation) return;
        const result=await captureProjectInventory(entries,inventoryCaps);
        if (disposed || token!==generation) return;
        selected=result;loadedRecords=[];syncExport();attempts.set(result,token);
        const names=Object.keys(result.files),shown=names.slice(0,8).join(', ');
        status.textContent=(`Project inspected. Revision: ${result.project_revision}. Files: ${shown}${names.length>8?', … (more files)':''}.`).slice(0,1200);
        overview.textContent='Checking project overview…';
        notify({kind:'selected',attempt:token,revision:result.project_revision});
        if (!disposed && selected===result) startOverview(result);
      } catch(error) {
        if (disposed || token!==generation) return;
        status.textContent=error instanceof DOMException && error.name==='AbortError' ? 'Folder selection canceled.' : 'Unable to inspect project folder.';
      } finally {if (acquisition===controller) acquisition=null;}
    })();
  };
  async function showSavedRecords(records:readonly any[],token:number,revision:string) {
    const lines:string[]=[];
    for (const row of records) {
      if(disposed||token!==generation)return;
      let detail='unverified';
      if(row.kind==='game'&&row.id.startsWith('session-challenge-')) {
        try {const game=await inspectGameChallenge(row.content,revision);detail=`unverified reported game result; ${game.status}; start step ${game.started_tick}; checked step ${game.checked_tick??'unknown'}`;} catch {detail='unverified; game details unavailable';}
      } else if(row.kind==='research'&&row.id==='session-attempt-notes') {
        try {detail=await summarizeSavedNotes(row.content,revision);} catch {detail='unverified; note details unavailable';}
      } else if(row.kind==='research'&&row.id.startsWith('session-targets-')) {
        try {detail=await summarizeSavedTargets(row.content,revision);} catch {detail='unverified; target details unavailable';}
      } else if(row.kind==='research') {
        try {
          const parsed=await readManifestJson(row.content,{max_bytes:131072,max_depth:20});
          const authority=(parsed.data as any)?.measurement?.authority ?? null;
          const checked=await inspectMeasuredAttemptRecord(row.content,authority,131072);
          if(checked.receipt.identity.project_revision!==revision)throw Error('Record revision mismatch');
          const count=checked.measurement?.entries.length??0;
          detail=`unverified; ${checked.receipt.status}; ${count} samples; last verified tick ${checked.receipt.last_verified_tick??'unknown'}`;
        } catch {detail='unverified; details unavailable';}
      }
      lines.push(`${row.id} (${row.kind}): ${detail}`);
    }
    if(!disposed&&token===generation)savedRecords.textContent=lines.length?lines.join(' | '):'No saved records in this file.';
  }
  function decodeFile(file:File,token:number){
    if(disposed||token!==generation)return;
    if(activeDecodes>=2){queuedFile={file,token};return;}
    activeDecodes++;
    void (async()=>{
      try{
        const decoded=await decodeExperimentFile(file,{max_bundle_bytes:67108864,max_records:8,max_record_bytes:1048576,max_total_record_bytes:2097152,inventory:inventoryCaps});
        if(disposed||token!==generation)return;
        const result=decoded.inventory;selected=result;loadedRecords=decoded.records.map(row=>({id:row.id,kind:row.kind,content:row.content}));syncExport();attempts.set(result,token);
        status.textContent=`Project inspected. Revision: ${result.project_revision}. ${decoded.records.length} saved records (unverified).`;
        overview.textContent='Checking project overview…';notify({kind:'selected',attempt:token,revision:result.project_revision});
        if(!disposed&&selected===result)startOverview(result);
        await showSavedRecords(decoded.records,token,result.project_revision);
      }catch{if(!disposed&&token===generation)status.textContent='Unable to inspect saved project file.'}
      finally{activeDecodes--;const next=queuedFile;queuedFile=null;if(next&&!disposed&&next.token===generation)decodeFile(next.file,next.token);}
    })();
  }
  const onFile=()=>{
    if(disposed)return;
    const file=fileInput.files?.[0];fileInput.value='';if(!file)return;
    const token=++generation;selected=null;loadedRecords=[];syncExport();queuedOverview=null;overview.textContent='No project overview yet.';savedRecords.textContent='No saved records selected.';
    try{onSelectionCleared?.()}catch{}
    if(disposed||token!==generation)return;
    try{onChoice?.(token)}catch{}
    if(disposed||token!==generation)return;
    acquisition?.abort();acquisition=null;status.textContent='Inspecting saved project file…';
    decodeFile(file,token);
  };
  const onExport=()=>{
    if(disposed||exportActive||!selected)return;
    const inventory=selected,token=generation,records=loadedRecords.slice();exportActive=true;syncExport();exportStatus.textContent='Preparing project download.';
    void (async()=>{try{
      const game=captureSessionGame?.(inventory)??null,notes=captureSessionNotes?.(inventory)??null,measured=captureSessionMeasured?.(inventory)??null,targets=captureSessionTargets?.(inventory)??null;
      if(game){const index=records.findIndex(row=>row.id===game.id);if(index>=0)records.splice(index,1);records.push({id:game.id,kind:'game',content:game.content});}
      if(notes){const index=records.findIndex(row=>row.id==='session-attempt-notes');if(index>=0)records.splice(index,1);records.push({id:'session-attempt-notes',kind:'research',content:notes.content});}
      if(measured){const content=await encodeMeasuredAttemptRecord(measured.receipt,131072);const index=records.findIndex(row=>row.id===measured.id);if(index>=0)records.splice(index,1);records.push({id:measured.id,kind:'research',content});}
      if(targets){const content=await targets.encode();const index=records.findIndex(row=>row.id===targets.id);if(index>=0)records.splice(index,1);records.push({id:targets.id,kind:'research',content});}
      const blob=await encodeExperimentFile(inventory,records,{max_bundle_bytes:67108864,max_records:8,max_record_bytes:1048576,max_total_record_bytes:2097152,inventory:inventoryCaps});
      if(disposed||token!==generation||selected!==inventory||(notes&&!notes.isCurrent())||(measured&&!measured.isCurrent())||(targets&&!targets.isCurrent())||(game&&!game.isCurrent()))return;
      const url=URL.createObjectURL(blob);exportUrls.add(url);const link=doc.createElement('a');link.href=url;link.download='robot-project.brf';doc.body.appendChild(link);
      try {link.click();exportStatus.textContent='Project download started. Saved records remain unverified.';} finally {link.remove();setTimeout(()=>{URL.revokeObjectURL(url);exportUrls.delete(url)},1000);}
    }catch{if(!disposed&&token===generation&&selected===inventory)exportStatus.textContent='Unable to export project.';}finally{exportActive=false;if(!disposed)syncExport();}})();
  };
  exportButton.addEventListener('click',onExport);
  fileInput.addEventListener('change',onFile);
  button.addEventListener('click',onChoose);
  try {root.appendChild(container);} catch(error) {button.removeEventListener('click',onChoose);fileInput.removeEventListener('change',onFile);container.remove();throw error;}
  return Object.freeze({get selectedProject(){return selected;},dispose(){
    if (disposed) return;
    disposed=true;generation++;queuedOverview=null;queuedFile=null;loadedRecords=[];for(const url of exportUrls)URL.revokeObjectURL(url);exportUrls.clear();exportButton.removeEventListener('click',onExport);acquisition?.abort();button.removeEventListener('click',onChoose);fileInput.removeEventListener('change',onFile);container.remove();
  }});
}
