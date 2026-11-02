import {createPublishedDuckView} from '../display/published-duck-view.ts';
import {createSurfaceHost} from './session-surface-host.ts';
import {mountSavedMeasurementComparison} from './saved-measurement-comparison-ui.ts';
import type {ProjectInventoryLimits} from '../projects/project-inventory.ts';
import {createSessionControls} from './session-controls.ts';
import {mountProjectInspector, type ProjectInspectorConfig} from './project-inspector.ts';
import {createAttemptHistory, type AttemptNoteStatus} from '../experiments/attempt-history.ts';
import {copyBounded} from '../session/project-world-wire.ts';
import {safeProjectPath} from '../projects/project-path.ts';
import {drawBodySchematic} from '../display/body-schematic.ts';
import {targetThenStepProgress} from './target-step-progress.ts';
import {bodyTurnRadians} from './body-turn-radians.ts';
import {encodeQuaternionBits} from '../experiments/game-challenge-record.ts';

type Session = {
  readonly identity: Readonly<{session_id:string; project_revision:string; run_epoch:number}>;
  readonly state: 'ready-paused' | 'running' | 'paused' | 'faulted' | 'disposed';
  readonly assetNotices?: readonly unknown[];
  submit(command:unknown):Promise<unknown>;
  startBoundedAttempt?(options:unknown):{result:Promise<unknown>;cancel():Promise<void>};
  startMeasuredAttempt?(options:unknown):{result:Promise<unknown>;cancel():Promise<void>};
  readonly targets?:readonly Readonly<{group_id:string;field:string;min:number;max:number}>[];
  setTarget?(request:unknown):Promise<unknown>;
  targetHistory?():unknown;
  readonly recordingChannels?:readonly {group_id:string;channel_id:string;definition_sha256:string;max_entries:number}[];
  inspect?():Promise<unknown>;
  readVisualFacts?():Promise<unknown>;
  listenSchematicFrames?(callback:(value:unknown)=>void):()=>void;
  attachDisplay?(canvas:HTMLCanvasElement, options:{width:number;height:number}):Promise<unknown>;
  attachAttributedDisplay?(canvas:HTMLCanvasElement, options:{width:number;height:number;visibility:boolean[]}):Promise<unknown>;
};

/** Mount presentation around an existing caller-owned session. */
export function mountSessionShell({root, session, projectInspector, comparisonInventoryLimits, publishedDuckAssetURL}:{root:HTMLElement; session:Session; projectInspector?:ProjectInspectorConfig; comparisonInventoryLimits?:ProjectInventoryLimits; publishedDuckAssetURL?:string}) {
  if (!root || !root.ownerDocument || typeof root.ownerDocument.createElement !== 'function' ||
      typeof root.appendChild !== 'function' || !session || typeof session.submit !== 'function' ||
      !session.identity || typeof session.identity.session_id !== 'string' ||
      typeof session.identity.project_revision !== 'string' || !Number.isSafeInteger(session.identity.run_epoch) ||
      !['ready-paused','running','paused','faulted','disposed'].includes(session.state)) {
    throw new Error('Invalid session shell');
  }
  const doc = root.ownerDocument;
  const make = (tag:string, role:string, label?:string) => {
    const node=doc.createElement(tag);
    node.setAttribute('data-brf',role);
    if (label !== undefined) node.textContent=label;
    return node;
  };
  const container=make('section','session-shell');
  const toolbar=make('nav','toolbar');
  toolbar.setAttribute('aria-label','Session controls');
  const run=make('button','run','Run') as HTMLButtonElement;
  const pause=make('button','pause','Pause') as HTMLButtonElement;
  const step=make('button','step','Step') as HTMLButtonElement;
  const play=make('button','play','Game mode') as HTMLButtonElement;
  const research=make('button','research','Hardware tuning mode') as HTMLButtonElement;
  const refresh=make('button','refresh-readings','Refresh readings') as HTMLButtonElement;
  for (const button of [run,pause,step,play,research,refresh]) button.setAttribute('type','button');
  const status=make('p','status');
  status.setAttribute('role','status');
  const viewport=make('div','viewport');
  const showDisplay=make('button','show-display','Show paused display') as HTMLButtonElement;
  const refreshDisplay=make('button','refresh-display','Refresh display') as HTMLButtonElement;
  for (const button of [showDisplay,refreshDisplay]) button.setAttribute('type','button');
  const displayStatus=make('p','display-status','Display not shown.');
  displayStatus.setAttribute('role','status');
  const canvas=make('canvas','display-canvas') as HTMLCanvasElement;
  canvas.hidden=true;
  const schematicButton=make('button','show-schematic','Show body schematic') as HTMLButtonElement;schematicButton.type='button';schematicButton.hidden=true;
  const duckButton=make('button','show-published-duck','Show Microduck') as HTMLButtonElement;duckButton.type='button';duckButton.hidden=true;
  const schematicStatus=make('p','schematic-status','Schematic unavailable.');schematicStatus.setAttribute('role','status');schematicStatus.hidden=true;
  const schematicCanvas=make('canvas','schematic-canvas') as HTMLCanvasElement;schematicCanvas.hidden=true;schematicCanvas.setAttribute('aria-label','Simplified simulated body and links');schematicCanvas.style.maxWidth='100%';
  const duckCanvas=make('canvas','microduck-canvas') as HTMLCanvasElement;duckCanvas.hidden=true;duckCanvas.setAttribute('aria-label','Simulated Microduck robot');duckCanvas.style.maxWidth='100%';
  viewport.append(showDisplay,refreshDisplay,displayStatus,canvas,schematicButton,duckButton,schematicStatus,schematicCanvas,duckCanvas);
  const playPane=make('section','play-pane');
  const researchPane=make('section','research-pane');
  playPane.setAttribute('aria-label','Game mode');
  researchPane.setAttribute('aria-label','Hardware tuning mode');
  const researchStepCount=make('input','research-step-count') as HTMLInputElement;
  researchStepCount.setAttribute('type','text');researchStepCount.setAttribute('inputmode','numeric');researchStepCount.setAttribute('aria-label','Number of steps (1 to 64)');researchStepCount.value='1';
  const researchStep=make('button','research-step','Step selected count') as HTMLButtonElement;
  researchStep.setAttribute('type','button');
  const attemptPanel=make('section','research-attempt');
  const attemptNotice=make('p','research-attempt-notice','Configuration and runtime-lock hashes are declarations, not verified. Start from a paused session at step 0. The outcome is not saved.');
  const attemptTicks=make('input','research-attempt-ticks') as HTMLInputElement;
  attemptTicks.setAttribute('type','text');attemptTicks.setAttribute('inputmode','numeric');attemptTicks.setAttribute('aria-label','Attempt steps (1 to 4096)');attemptTicks.value='1';
  const attemptConfig=make('input','research-attempt-config') as HTMLInputElement;
  attemptConfig.setAttribute('type','text');attemptConfig.setAttribute('aria-label','Configuration SHA-256 declaration');attemptConfig.value='';
  const attemptRuntime=make('input','research-attempt-runtime') as HTMLInputElement;
  attemptRuntime.setAttribute('type','text');attemptRuntime.setAttribute('aria-label','Runtime lock SHA-256 declaration');attemptRuntime.value='';
  const attemptStart=make('button','research-attempt-start','Start bounded attempt') as HTMLButtonElement;
  const measurementChoice=make('select','research-measurement-channel') as HTMLSelectElement;
  measurementChoice.setAttribute('aria-label','Measurement channel');
  for(const [index,row] of (session.recordingChannels??[]).entries()){const option=doc.createElement('option');option.value=String(index);option.textContent=`${row.group_id}: ${row.channel_id}`;measurementChoice.appendChild(option);}
  const measuredStart=make('button','research-measured-start','Start measured attempt') as HTMLButtonElement;measuredStart.setAttribute('type','button');measuredStart.disabled=!(session.recordingChannels?.length);
  const attemptCancel=make('button','research-attempt-cancel','Cancel attempt') as HTMLButtonElement;
  const attemptPlan=make('button','research-attempt-plan','Plan attempt') as HTMLButtonElement;
  const attemptExport=make('button','research-attempt-export','Download attempt notes') as HTMLButtonElement;
  for(const button of [attemptStart,attemptCancel,attemptPlan,attemptExport])button.setAttribute('type','button');attemptCancel.disabled=true;
  const attemptStatus=make('p','research-attempt-status','No attempt yet.');attemptStatus.setAttribute('role','status');
  const ledgerStatus=make('p','research-attempt-ledger-status','');ledgerStatus.setAttribute('role','status');
  const attemptHistory=make('p','research-attempt-history');
  attemptPanel.append(attemptNotice,attemptTicks,attemptConfig,attemptRuntime,attemptPlan,attemptStart,measurementChoice,measuredStart,attemptCancel,attemptExport,attemptStatus,ledgerStatus,attemptHistory);
  const playFeedback=make('p','play-feedback','No paused snapshot yet.');
  const playGoal=make('p','play-goal','Project goal unavailable.');
  const goalProgress=make('p','game-goal-progress','');goalProgress.setAttribute('role','status');goalProgress.hidden=true;
  const turnStart=make('button','game-goal-start','Start challenge') as HTMLButtonElement,turnCheck=make('button','game-goal-check','Check progress') as HTMLButtonElement,turnFeedback=make('p','game-physical-feedback','');turnStart.type='button';turnCheck.type='button';turnStart.hidden=true;turnCheck.hidden=true;turnFeedback.hidden=true;turnFeedback.setAttribute('role','status');
  const playWelcome=make('p','play-welcome','Project welcome unavailable.');
  const researchFeedback=make('p','research-feedback','No paused snapshot yet.');
  const authorityFeedback=make('p','authority-feedback','No paused snapshot yet.');
  const playAssetNotices=make('p','play-asset-notices');playAssetNotices.setAttribute('role','status');
  const researchAssetNotices=make('p','research-asset-notices');researchAssetNotices.setAttribute('role','status');
  playPane.append(playFeedback,playWelcome,playGoal,goalProgress,turnStart,turnCheck,turnFeedback,playAssetNotices);
  const vectorsPrevious=make('button','research-vectors-previous','Previous values') as HTMLButtonElement;
  const vectorsNext=make('button','research-vectors-next','Next values') as HTMLButtonElement;
  const vectorsPage=make('p','research-vectors-page','No paused snapshot.');
  vectorsPrevious.setAttribute('type','button');vectorsNext.setAttribute('type','button');
  vectorsPrevious.disabled=true;vectorsNext.disabled=true;
  const pinBaseline=make('button','research-pin-baseline','Pin reference snapshot') as HTMLButtonElement;
  pinBaseline.setAttribute('type','button');pinBaseline.disabled=true;
  const comparison=make('p','research-comparison','No reference snapshot.');
  researchPane.append(researchStepCount,researchStep,attemptPanel,researchFeedback,vectorsPrevious,vectorsNext,vectorsPage,pinBaseline,comparison,authorityFeedback,researchAssetNotices);
  const savedComparison=comparisonInventoryLimits?mountSavedMeasurementComparison(researchPane,comparisonInventoryLimits):null;let comparisonDrain:Promise<void>|null=null;
  toolbar.append(run,pause,step,play,research,refresh);
  const targetPanel=make('section','target-panel');
  container.append(toolbar,status,targetPanel,viewport,playPane,researchPane);
  let disposed=false, generation=0;
  let attemptOutcomeIdentity:Session['identity']|null=null;
  type VectorSnapshot={identity:Session['identity']; label:string; vectors:number[][]; page:number};
  let vectorSnapshot:VectorSnapshot|null=null, referenceSnapshot:VectorSnapshot|null=null;
  const clear=(message:string) => {vectorSnapshot=null;pinBaseline.disabled=true;comparison.textContent=referenceSnapshot?'Current snapshot unavailable.':'No reference snapshot.';vectorsPrevious.disabled=true;vectorsNext.disabled=true;vectorsPage.textContent='No paused snapshot.';playFeedback.textContent=message;researchFeedback.textContent=message;authorityFeedback.textContent=message;};
  let displayGeneration=0;
  const invalidate=()=>{generation++;displayGeneration++;canvas.hidden=true;schematicCanvas.hidden=true;duckCanvas.hidden=true;if(schematicEnabled)schematicStatus.textContent='Pause and refresh the body schematic.';displayStatus.textContent='Display unavailable. Pause and refresh.';clear('Snapshot unavailable. Pause and try again.');};
  const same=(a:Session['identity'],b:Session['identity']) => !!a && !!b && a.session_id===b.session_id && a.project_revision===b.project_revision && a.run_epoch===b.run_epoch;
  const targetCleanup:Array<()=>void>=[];const targetLabelNodes:Array<{group_id:string;field:string;min:number;max:number;exact:HTMLElement;slider:HTMLElement}>=[];let targetBusy=false;
  if(Array.isArray(session.targets) && typeof session.setTarget==='function' && session.targets.length) {
    const heading=make('h2','target-heading','Controls');targetPanel.append(heading);
    for(const target of session.targets) {
      const row=make('div','target-row'),label=make('label','target-label'),labelText=make('span','target-label-text');label.append(labelText);
      const input=make('input','target-value') as HTMLInputElement;input.type='text';input.inputMode='decimal';label.append(input);
      const sliderLabel=make('label','target-slider-label'),sliderText=make('span','target-slider-text'),slider=make('input','target-slider') as HTMLInputElement;sliderLabel.append(sliderText);targetLabelNodes.push({group_id:target.group_id,field:target.field,min:target.min,max:target.max,exact:labelText,slider:sliderText});
      slider.type='range';slider.min=String(target.min);slider.max=String(target.max);slider.step='any';slider.value=String(target.min);sliderLabel.append(slider);
      const onSlide=()=>{input.value=slider.value;},onType=()=>{const raw=input.value.trim(),value=Number(raw);if(raw&&Number.isFinite(value)&&value>=target.min&&value<=target.max)slider.value=raw;};
      slider.addEventListener('input',onSlide);input.addEventListener('input',onType);targetCleanup.push(()=>{slider.removeEventListener('input',onSlide);input.removeEventListener('input',onType)});
      const button=make('button','target-set','Set target') as HTMLButtonElement;button.type='button';
      const feedback=make('p','target-feedback','Move the slider or enter a number while paused, then select Set target.');feedback.setAttribute('role','status');row.append(sliderLabel,label,button,feedback);targetPanel.append(row);
      const onTarget=()=>{
        if(disposed)return;
        if(targetBusy || !paused()) {feedback.textContent='Pause before changing a target.';return;}
        const raw=input.value.trim(),value=Number(raw);
        if(!raw || !Number.isFinite(value) || value<target.min || value>target.max){feedback.textContent=`Choose a number from ${target.min} to ${target.max}.`;return;}
        const identity=session.identity;targetBusy=true;button.disabled=true;feedback.textContent='Sending target request...';
        void Promise.resolve().then(()=>{if(disposed || !same(identity,session.identity))throw Error('Session unavailable');return session.setTarget!({group_id:target.group_id,field:target.field,value})}).then((reply:any)=>{
          if(!disposed && same(identity,session.identity)){feedback.textContent=reply?.status==='accepted'?'Target request accepted.':reply?.status==='rejected'?'Target request rejected.':'Target outcome unknown.';if(reply?.status==='accepted')updateTutorial(null);}
        },()=>{if(!disposed && same(identity,session.identity))feedback.textContent='Target outcome unknown.';}).finally(()=>{targetBusy=false;if(!disposed)button.disabled=false;});
      };
      button.addEventListener('click',onTarget);targetCleanup.push(()=>button.removeEventListener('click',onTarget));
    }
  }

  const paused=()=>session.state==='paused'||session.state==='ready-paused';
  const fenceReference=()=>{if(referenceSnapshot && !same(referenceSnapshot.identity,session.identity)){referenceSnapshot=null;comparison.textContent='No reference snapshot.';}};
  const vector=(v:unknown):number[] => {
    if (!Array.isArray(v)||v.length>4096||!v.every(n=>typeof n==='number'&&Number.isFinite(n))) throw new Error('Invalid snapshot');
    return v;
  };
  const densePlantVector=(value:unknown):number[] => {
    if(!Array.isArray(value) || Object.getPrototypeOf(value)!==Array.prototype || value.length>4096 ||
       Reflect.ownKeys(value).length!==value.length+1) throw new Error('Invalid plant snapshot');
    const result:number[]=[];
    for(let i=0;i<value.length;i++) {
      const field=Object.getOwnPropertyDescriptor(value,String(i));
      if(!field || !Object.hasOwn(field,'value') || !field.enumerable ||
         typeof field.value!=='number' || !Number.isFinite(field.value)) throw new Error('Invalid plant snapshot');
      result.push(field.value);
    }
    return result;
  };
  const format=(v:number[],page:number)=>{const start=page*12, end=Math.min(start+12,v.length);return `[${v.slice(start,end).join(', ')}${page===0 && v.length>12?', … (truncated)':''}] (indices ${start<end?`${start}-${end-1}`:'none'} of ${v.length})`;};
  const showVectors=()=>{
    const snapshot=vectorSnapshot;
    if(!snapshot || disposed)return;
    try {
      fenceReference();
      if(!paused() || !same(snapshot.identity,session.identity)) {clear('Snapshot unavailable. Pause and try again.');return;}
      const max=Math.max(...snapshot.vectors.map(v=>v.length)), pages=Math.max(1,Math.ceil(max/12)), page=snapshot.page;
      const [qpos,qvel,activation,actuatorForce,control,sensors]=snapshot.vectors.map(v=>format(v,page));
      if(disposed || vectorSnapshot!==snapshot || !paused() || !same(snapshot.identity,session.identity)) return;
      researchFeedback.textContent=`${snapshot.label} Plant position: ${qpos}; plant velocity: ${qvel}; plant truth activation: ${activation}; plant truth actuator force: ${actuatorForce}; commanded input: ${control}; raw simulated sensors: ${sensors}.`;
      vectorsPage.textContent=`Page ${page+1} of ${pages}.`;vectorsPrevious.disabled=page===0;vectorsNext.disabled=page+1>=pages;pinBaseline.disabled=false;
      const reference=referenceSnapshot;
      if (!reference) comparison.textContent='No reference snapshot.';
      else if (!same(reference.identity,snapshot.identity) || reference.vectors.some((v,i)=>v.length!==snapshot.vectors[i].length)) comparison.textContent='Snapshots incompatible: identity or vector lengths differ.';
      else {
        const names=['Plant position','Plant velocity','Plant truth activation','Plant truth actuator force','Commanded input','Raw simulated sensors'];
        const id=snapshot.identity;
        comparison.textContent=`Paused snapshot comparison. Session ${id.session_id}; revision ${id.project_revision}; epoch ${id.run_epoch}. Reference: ${reference.label} Current: ${snapshot.label} `+names.map((name,i)=>`${name}: reference ${format(reference.vectors[i],page)}, current ${format(snapshot.vectors[i],page)}`).join(' | ');
      }
    } catch {if(!disposed && vectorSnapshot===snapshot)clear('Snapshot unavailable. Pause and try again.');}
  };
  const onPrevious=()=>{if(vectorSnapshot && vectorSnapshot.page>0){vectorSnapshot.page--;showVectors();}};
  const onNext=()=>{if(vectorSnapshot){vectorSnapshot.page++;showVectors();}};
  const onPin=()=>{
    if(disposed)return;
    try {fenceReference();const current=vectorSnapshot;if(!current || !paused() || !same(current.identity,session.identity)) {clear('Snapshot unavailable. Pause and try again.');return;} referenceSnapshot=current;showVectors();}
    catch {if(!disposed)clear('Snapshot unavailable. Pause and try again.');}
  };
  const onRefresh=()=>{void (async()=>{
    if(disposed)return;
    try {fenceReference();} catch {referenceSnapshot=null;}
    const token=++generation;
    clear('Checking paused snapshot…');
    const id={...session.identity};
    if (!paused() || typeof session.inspect!=='function') {clear('Snapshot unavailable. Pause and try again.');return;}
    try {
      const result:any=await session.inspect();
      if (disposed || token!==generation) return;
      if (!paused() || !same(id,session.identity) || !result || !same(id,result.identity) || result.phase!=='paused' ||
          !result.plant || !Number.isSafeInteger(result.plant.tick) || result.plant.tick<0 ||
          typeof result.plant.time!=='number' || !Number.isFinite(result.plant.time) || result.plant.time<0 || !result.commands) throw new Error('Invalid snapshot');
      const qpos=vector(result.plant.qpos),qvel=vector(result.plant.qvel),control=vector(result.commands.control),sensors=vector(result.plant.sensors);
      const activation=densePlantVector(result.plant.activation),actuatorForce=densePlantVector(result.plant.actuator_force);
      if (!same(id,result.commands.identity) || !Array.isArray(result.commands.groups) || result.commands.groups.length>4096 ||
          !Array.isArray(result.due_group_ids) || result.due_group_ids.length>result.commands.groups.length) throw new Error('Invalid authority');
      const groups=new Set<string>();
      const count=(n:unknown):n is number => typeof n==='number' && Number.isSafeInteger(n) && n>=0;
      const data=(record:any,key:string):any => {
        if (!record || typeof record!=='object') throw new Error('Invalid authority');
        const descriptor=Object.getOwnPropertyDescriptor(record,key);
        if (!descriptor || !('value' in descriptor)) throw new Error('Invalid authority');
        return descriptor.value;
      };
      const captured:{id:string;generation:number;stride:number;sequence:number;last:number|null}[]=[];
      for (const group of result.commands.groups) {
        const lease=data(group,'lease'), groupId=data(lease,'group_id'), owner=data(lease,'owner_id');
        const generation=data(lease,'generation'),stride=data(lease,'control_stride');
        const sequence=data(group,'accepted_sequence'),last=data(group,'last_control_tick');
        if (typeof groupId!=='string' || !groupId || groupId.length>4096 || groups.has(groupId) ||
            typeof owner!=='string' || !owner || owner.length>4096 || !count(generation) || generation<1 ||
            !count(stride) || stride<1 || !count(sequence) ||
            (last!==null && (!count(last) || last>result.plant.tick))) throw new Error('Invalid authority');
        groups.add(groupId);
        captured.push({id:groupId,generation,stride,sequence,last});
      }
      const due=new Set<string>();
      for (const groupId of result.due_group_ids) {
        if (typeof groupId!=='string' || !groups.has(groupId) || due.has(groupId)) throw new Error('Invalid authority');
        due.add(groupId);
      }
      const authority=captured.map((group,index) =>
        `Group ${index+1}: generation ${group.generation}, stride ${group.stride}, sequence ${group.sequence}, last control tick ${group.last===null?'none':group.last}, due at next boundary ${due.has(group.id)?'yes':'no'}.`);
      const label=`Paused snapshot: step ${result.plant.tick}, ${result.plant.time} simulated seconds.`;
      playFeedback.textContent=label;
      vectorSnapshot={identity:id,label,vectors:[qpos,qvel,activation,actuatorForce,control,sensors].map(v=>v.slice()),page:0};
      showVectors();
      authorityFeedback.textContent=`Paused snapshot epoch ${id.run_epoch}.\n${authority.length ? authority.join('\n') : 'No controller groups.'}`;
    } catch {
      if (!disposed && token===generation) clear('Snapshot unavailable. Pause and try again.');
    } finally {
      try {if (!disposed && same(id,session.identity) && session.state==='faulted' && !disposed) controls.reconcileFault(id);} catch { /* Presentation reconciliation must not escape. */ }
    }
  })();};
  type DisplayView = {readonly retired?:boolean;refresh():Promise<any>;detach():Promise<void>};
  let view:DisplayView|null=null, attachPending:Promise<void>|null=null, refreshPending:Promise<void>|null=null;
  let partialView=false;
  const partialNotice='Partial untextured view: materials, textures, ground and other scene details are omitted.';
  const validLimits=(value:unknown)=>{try{const list:any=copyBounded(value,4096);return Array.isArray(list) && list.length<=32 &&
    list.every((v:any)=>typeof v==='string' && v.length>0 && v.length<=80) && list.includes('untextured') && list.includes('materials') && list.includes('textures');}catch{return false;}};
  let disposal:Promise<void>|null=null, cleanupFailure:unknown;
  let cleanupFailed=false;
  const own=(value:any,key:string)=>{if(!value || typeof value!=='object')return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d && Object.hasOwn(d,'value')?d.value:undefined;};
  const safeIdentity=(value:unknown)=>{try{return copyBounded(value,4096);}catch{return null;}};
  const currentDisplay=(id:Session['identity'], token:number)=>!disposed && displayGeneration===token && paused() && same(id,session.identity);
  const rememberCleanup=(error:unknown)=>{if (!cleanupFailed) {cleanupFailed=true;cleanupFailure=error;}};
  const show=()=>{
    if (disposed || cleanupFailed || attachPending || refreshPending || view || !paused() || typeof session.attachDisplay!=='function') return;
    const id={...session.identity},token=displayGeneration;
    canvas.hidden=true;displayStatus.textContent='Preparing paused display...';
    const job=Promise.resolve().then(async()=>{
      try {
        if (!currentDisplay(id,token)) return;
        let result:any=await session.attachDisplay!(canvas,{width:640,height:480});
        let partial=false;
        if(own(result,'status')==='unsupported' && currentDisplay(id,token) && same(id,safeIdentity(own(result,'identity'))) && typeof session.attachAttributedDisplay==='function') {
          result=await session.attachAttributedDisplay(canvas,{width:640,height:480,visibility:[true,true,true,false,false,false]});partial=true;
        }
        const candidate=own(result,'view'),resultIdentity=safeIdentity(own(result,'identity'));
        if ((partial ? own(result,'status')==='partial' && validLimits(own(result,'limitations')) : own(result,'status')==='available') && candidate && typeof own(candidate,'detach')==='function' && typeof own(candidate,'refresh')==='function') {
          if (!currentDisplay(id,token) || !same(id,resultIdentity)) {
            canvas.hidden=true;
            try {await candidate.detach();} catch(error) {rememberCleanup(error);}
            if (!disposed) displayStatus.textContent='Display unavailable. Pause and refresh.';
            return;
          }
          view=candidate;partialView=partial;canvas.hidden=false;displayStatus.textContent=partial?partialNotice:'Paused display available.';
        } else {
          canvas.hidden=true;
          if(partial && candidate && typeof own(candidate,'detach')==='function')try{await candidate.detach();}catch(error){rememberCleanup(error);}
          if (!disposed) displayStatus.textContent=own(result,'status')==='unsupported'?'Display unsupported.':'Display unavailable.';
        }
      } catch (error) {
        if(error instanceof AggregateError) rememberCleanup(error);
        canvas.hidden=true;
        if (!disposed) displayStatus.textContent='Display unavailable.';
      } finally {
        try {if (!disposed && same(id,session.identity) && session.state==='faulted' && !disposed) controls.reconcileFault(id);} catch { /* Presentation reconciliation must not escape. */ }
      }
    });
    attachPending=job;void job.finally(()=>{if(attachPending===job)attachPending=null;});
  };
  const refreshView=()=>{
    if(disposed || cleanupFailed || attachPending || refreshPending || !view || !paused())return;
    const active=view,id={...session.identity},token=displayGeneration;
    canvas.hidden=true;displayStatus.textContent='Refreshing paused display...';
    const job=Promise.resolve().then(async()=>{try {
      if (!currentDisplay(id,token) || view!==active) return;
      const result=await active.refresh();
      if(own(result,'status')==='unsupported' || own(result,'status')==='unavailable') {
        canvas.hidden=true;
        try {await active.detach();if(view===active)view=null;}catch(error){rememberCleanup(error);}
        if(currentDisplay(id,token) && (view===active || view===null))displayStatus.textContent=own(result,'status')==='unsupported'?'Display unsupported.':'Display unavailable.';
        return;
      }
      if(!currentDisplay(id,token) || view!==active) {canvas.hidden=true;return;}
      if(own(result,'status')!==(partialView?'partial':'available') ||
         (partialView && !validLimits(own(result,'limitations'))) || !same(id,safeIdentity(own(result,'identity')))) {
        canvas.hidden=true;displayStatus.textContent='Display unavailable.';return;
      }
      canvas.hidden=false;displayStatus.textContent=partialView?partialNotice:'Paused display available.';
    } catch (error) {if(error instanceof AggregateError)rememberCleanup(error);if(!disposed && view===active)canvas.hidden=true;try {if(!(error instanceof AggregateError) && !disposed && view===active && active.retired===true && !disposed && view===active)view=null;} catch { /* A missing or invalid retirement signal retains ownership. */ } if(currentDisplay(id,token))displayStatus.textContent='Display unavailable.';}
    finally {try {if (!disposed && same(id,session.identity) && session.state==='faulted' && !disposed) controls.reconcileFault(id);} catch { /* Presentation reconciliation must not escape. */ }} });
    refreshPending=job;void job.finally(()=>{if(refreshPending===job)refreshPending=null;});
  };
  showDisplay.addEventListener('click',show);refreshDisplay.addEventListener('click',refreshView);
  // Install invalidation before the controls' submit listeners.
  run.addEventListener('click',invalidate);step.addEventListener('click',invalidate);
  // A chooser's session authority is captured before its asynchronous work.
  let choiceAuthority:{attempt:number;session_id:string;project_revision:string}|null=null;
  let selectionAuthority:{attempt:number;session_id:string;project_revision:string}|null=null;
  let tutorialEnabled=false,lastTutorialStep:any=null;const gameRecordId='session-challenge-'+crypto.randomUUID();let turnOutcome:{status:'completed'|'not_yet'|'unknown';checked_tick:number|null;angle_radians:number|null;quaternion:number[]|null}|null=null;let turnGoal:{body:string;min_radians:number}|null=null,turnBaseline:{identity:Session['identity'];body:string;quaternion:number[];tick:number}|null=null,turnSerial=0,turnBusy=false;let selectedGoal:string|null=null, selectedWelcome:string|null=null;let selectedLabels:readonly {group_id:string;field:string;label:string}[]=[];
  const labelsOf=(value:unknown)=>{const rows=copyBounded(value,16384);if(!Array.isArray(rows)||rows.length>32)throw Error('Invalid labels');const seen=new Set<string>();return rows.map((r:any)=>{if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length!==3||typeof r.group_id!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(r.group_id)||typeof r.field!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(r.field)||typeof r.label!=='string'||!r.label.trim()||r.label.length>80||/[\u0000-\u001f\u007f]/.test(r.label))throw Error('Invalid label');const key=r.group_id+'\0'+r.field;if(seen.has(key))throw Error('Duplicate label');seen.add(key);return {group_id:r.group_id,field:r.field,label:r.label};});};
  type AttemptHandle={result:Promise<unknown>;cancel():Promise<void>};
  type ActiveAttempt={rowId:string;identity:Session['identity'];handle:AttemptHandle|null;cancelled:boolean;cancelFailed:boolean;cancelWork:Promise<void>|null;settlement:Promise<void>|null};
  let activeAttempt:ActiveAttempt|null=null;
  const history=createAttemptHistory();
  const exportUrls=new Set<string>();
  const exportTimers=new Map<string,ReturnType<typeof setTimeout>>();
  const revokeExport=(url:string)=>{
    if(!exportUrls.has(url))return;
    try {URL.revokeObjectURL(url);exportUrls.delete(url);} catch(error) {rememberCleanup(error);}
  };
  let historyVersion=0;
  const renderHistory=()=>{
    historyVersion++;
    const data=history.snapshot(),c=data.counts;
    const counts=`Missing: ${c.missing}; running: ${c.running}; completed: ${c.completed}; cancelled: ${c.cancelled}; deadline: ${c.deadline}; failed: ${c.failed}; unknown: ${c.unknown}; unavailable: ${c.unavailable}.`;
    const rows=data.rows.map(row=>`${row.id}: ${row.status==='planned'?'planned (missing outcome)':row.status}; ${row.requested_ticks} steps; ${row.last_verified_tick===null?'no verified tick':`verified tick: ${row.last_verified_tick}`}; ${row.identity?`session ${row.identity.session_id}, epoch ${row.identity.run_epoch}`:'not dispatched'}; project ${row.declaration.project_revision}; configuration ${row.declaration.configuration_sha256}; runtime ${row.declaration.runtime_lock_sha256}.`);
    attemptHistory.textContent=`Attempt notes: user declarations not verified; incomplete. ${counts}${rows.length?'\n'+rows.join('\n'):''}`;
  };
  renderHistory();
  const sessionMatches=(authority:{session_id:string;project_revision:string}|null)=>{
    const current=session.identity;
    return !!authority && !!current && current.session_id===authority.session_id && current.project_revision===authority.project_revision;
  };
  const noticeIdentity={session_id:session.identity.session_id,project_revision:session.identity.project_revision};
  let noticeText='No material notices.';
  try {
    const descriptor=Object.getOwnPropertyDescriptor(session,'assetNotices');
    if(descriptor) {
      if(!Object.hasOwn(descriptor,'value'))throw Error('Invalid material notices');
      const rows=copyBounded(descriptor.value,1048576);
      if(!Array.isArray(rows)||rows.length>4096)throw Error('Invalid material notices');
      const seen=new Set<string>();
      const paths=rows.map((row:any)=>{
        if(!row || typeof row!=='object' || Array.isArray(row) ||
           Object.keys(row).length!==4 || !['path','kind','libraries','names'].every(key=>Object.hasOwn(row,key)) ||
           row.kind!=='obj_materials_ignored' || typeof row.path!=='string' || safeProjectPath(row.path)!==row.path ||
           !/\.obj$/i.test(row.path) || seen.has(row.path) || !Array.isArray(row.libraries) || !Array.isArray(row.names) ||
           row.libraries.length>1 || row.names.length>1 || row.libraries.length+row.names.length===0 ||
           !row.libraries.every((s:unknown)=>typeof s==='string' && s.length<=128 && /^[A-Za-z0-9_][A-Za-z0-9_-]*\.mtl$/.test(s)) ||
           !row.names.every((s:unknown)=>typeof s==='string' && s.length<=128 && /^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(s)))throw Error('Invalid material notices');
        seen.add(row.path);return row.path;
      });
      if(paths.length)noticeText=`The pinned MuJoCo decoder ignores OBJ material declarations; the model's appearance may differ. Affected files: ${paths.join(', ')}.`;
    }
  } catch {noticeText='Material notice unavailable.';}
  const renderAssetNotices=()=>{
    if(disposed)return;
    let valid=false;try {valid=sessionMatches(noticeIdentity);} catch {valid=false;}
    const text=valid?noticeText:'Material notice unavailable.';
    playAssetNotices.textContent=text;researchAssetNotices.textContent=text;
  };
  renderAssetNotices();
  let schematicEnabled=false,schematicRequested=false,stopSchematic:(()=>void)|null=null;
  let representation:'schematic'|'duck'='schematic';
  const duckView=publishedDuckAssetURL ? createPublishedDuckView(duckCanvas,publishedDuckAssetURL) : null;
  const viewName=()=>representation==='duck'?'Microduck':'Body schematic';
  const hideViews=()=>{schematicCanvas.hidden=true;duckCanvas.hidden=true;};
  const setSchematic=(enabled:boolean,duck=false)=>{duck=duck&&!!duckView;const any=enabled||duck;if(schematicEnabled!==any){schematicEnabled=any;generation++;hideViews();if(!any){schematicRequested=false;stopSchematic?.();stopSchematic=null;}}schematicButton.hidden=!enabled;duckButton.hidden=!duck;schematicStatus.hidden=!any;};
  const paintFrame=async(model:any,frame:any,version:number,id:Session['identity'])=>{
    const selected=representation;
    if(selected==='duck'){if(!duckView)throw Error('Microduck visual unavailable');await duckView.draw(model,frame);}
    else drawBodySchematic(schematicCanvas,model,frame);
    if(disposed||!schematicEnabled||version!==generation||selected!==representation||!same(id,session.identity))return;
    schematicCanvas.hidden=selected!=='schematic';duckCanvas.hidden=selected!=='duck';schematicStatus.textContent=`${viewName()}, step ${frame.tick}.`;
  };
  const onSchematic=()=>{if(disposed||!schematicEnabled||!paused()||typeof session.readVisualFacts!=='function')return;schematicRequested=true;const version=generation,id={...session.identity};schematicStatus.textContent='Reading body positions.';
    void session.readVisualFacts().then(async(value:any)=>{if(disposed||!schematicEnabled||version!==generation||!paused()||!same(id,session.identity)||!same(id,value?.identity))return;
      if(value.status!=='partial')throw Error('Body view unavailable');await paintFrame(value.model,value.frame,version,id);
      if(disposed||version!==generation||!same(id,session.identity))return;
      stopSchematic?.();stopSchematic=null;
      if(typeof session.listenSchematicFrames==='function') {
        const model=value.model;
        try {stopSchematic=session.listenSchematicFrames((pose:any)=>{
          if(disposed||!schematicEnabled||!same(id,session.identity))return;
          if(pose?.status!=='available'||!same(id,pose.identity)){hideViews();schematicStatus.textContent='Live body view unavailable.';return;}
          const liveVersion=generation;void paintFrame(model,pose.frame,liveVersion,id).catch(()=>{if(!disposed&&liveVersion===generation){hideViews();schematicStatus.textContent='Live body view unavailable.';}});
        });} catch {schematicStatus.textContent=`${viewName()}, step ${value.frame.tick}. Live updates unavailable.`;}
      }
    }).catch(()=>{if(!disposed&&version===generation){hideViews();schematicStatus.textContent=representation==='duck'?'Microduck visual unavailable.':'Body schematic unavailable.';}});
  };
  const onShowSchematic=()=>{representation='schematic';generation++;hideViews();onSchematic()};const onShowDuck=()=>{representation='duck';generation++;hideViews();onSchematic()};schematicButton.addEventListener('click',onShowSchematic);duckButton.addEventListener('click',onShowDuck);
  function resetTurnChallenge(){turnSerial++;turnBaseline=null;turnOutcome=null;turnGoal=null;turnStart.hidden=true;turnCheck.hidden=true;turnFeedback.hidden=true;}
  function syncTurnButtons(){if(turnBaseline&&!same(turnBaseline.identity,session.identity)){turnBaseline=null;turnOutcome=null;turnFeedback.textContent='Start the challenge again.';}turnStart.hidden=!turnGoal;turnCheck.hidden=!turnGoal;turnFeedback.hidden=!turnGoal;turnStart.disabled=turnBusy||!paused();turnCheck.disabled=turnBusy||!paused()||!turnBaseline;}
  function readTurnPose(value:any,id:Session['identity'],body:string){
    if(value?.status!=='partial'||!same(id,value.identity)||!Array.isArray(value.model?.bodies)||!Array.isArray(value.frame?.bodies)||!Number.isSafeInteger(value.frame.tick)||value.frame.tick<0)throw Error('Unavailable body');
    const matches=value.model.bodies.filter((x:any)=>x?.name===body);if(matches.length!==1||!Number.isSafeInteger(matches[0].id)||matches[0].id<1)throw Error('Unavailable body');
    const pose=value.frame.bodies[matches[0].id];if(!pose||pose.id!==matches[0].id)throw Error('Unavailable pose');bodyTurnRadians(pose.quaternion,pose.quaternion);return {tick:value.frame.tick,quaternion:pose.quaternion.slice()};
  }
  const readTurn=(starting:boolean)=>{
    if(disposed||turnBusy||!paused()||!turnGoal||!selectionAuthority||!sessionMatches(selectionAuthority)||typeof session.readVisualFacts!=='function')return;
    const goal=turnGoal,id={...session.identity},token=++turnSerial,baseline=turnBaseline;if(!starting&&(!baseline||!same(id,baseline.identity)||baseline.body!==goal.body)){turnBaseline=null;turnFeedback.textContent='Start the challenge again.';syncTurnButtons();return;}
    if(starting){turnBaseline=null;turnOutcome=null;}else turnOutcome={status:'unknown',checked_tick:null,angle_radians:null,quaternion:null};turnBusy=true;syncTurnButtons();turnFeedback.textContent='Checking the robot...';
    void session.readVisualFacts().then((result:any)=>{if(disposed||token!==turnSerial||turnGoal!==goal||!paused()||!same(id,session.identity)||!sessionMatches(selectionAuthority))return;
      const pose=readTurnPose(result,id,goal.body);
      if(starting){turnBaseline={identity:id,body:goal.body,quaternion:pose.quaternion,tick:pose.tick};turnFeedback.textContent='Ready! Turn the robot part, then check progress.';}
      else {const turn=bodyTurnRadians(baseline!.quaternion,pose.quaternion),completed=pose.tick>baseline!.tick&&turn>=goal.min_radians;turnOutcome={status:completed?'completed':'not_yet',checked_tick:pose.tick,angle_radians:turn,quaternion:pose.quaternion};turnFeedback.textContent=completed?'The robot part turned!':'Keep going, then check again.';}
    }).catch(()=>{if(!disposed&&token===turnSerial)turnFeedback.textContent='Cannot check the robot right now. Pause and try again.';}).finally(()=>{turnBusy=false;if(!disposed)syncTurnButtons();});
  };
  const onTurnStart=()=>readTurn(true),onTurnCheck=()=>readTurn(false);turnStart.addEventListener('click',onTurnStart);turnCheck.addEventListener('click',onTurnCheck);
  const updateTutorial=(step:unknown,source:'step'|'pause'='step')=>{
    if(disposed)return;if(step!==null)lastTutorialStep={value:step,source};
    if(!tutorialEnabled||!selectionAuthority||!sessionMatches(selectionAuthority)){goalProgress.hidden=true;lastTutorialStep=null;return;}
    goalProgress.hidden=false;if(lastTutorialStep&&!same(lastTutorialStep.value?.identity,session.identity))lastTutorialStep=null;let outcome:'pending'|'ready'|'complete'|'unavailable'='unavailable';
    try {outcome=targetThenStepProgress(session.identity,session.targetHistory?.(),lastTutorialStep?.value??null,lastTutorialStep?.source??'step');} catch {/* no unverified success */}
    goalProgress.textContent=outcome==='complete'?'You set a target and moved the simulation forward!':outcome==='ready'?'Target set. Run or take a step.':outcome==='pending'?'Choose a target, then run or take a step.':'Goal progress unavailable.';
  };
  const updateGoal=()=>{
    if(disposed)return;
    renderAssetNotices();
    if(!activeAttempt){attemptStart.disabled=!paused();measuredStart.disabled=!paused()||!(session.recordingChannels?.length);}
    if(activeAttempt && !same(activeAttempt.identity,session.identity)) attemptStatus.textContent='Attempt belongs to an earlier session; waiting for it to settle.';
    if(attemptOutcomeIdentity && !same(attemptOutcomeIdentity,session.identity)) {
      attemptOutcomeIdentity=null;attemptStatus.textContent='Previous attempt belongs to an earlier session.';
    }
    let matches=false;
    try {matches=sessionMatches(selectionAuthority);} catch {matches=false;}
    if(disposed)return;
    if(!matches){selectionAuthority=null;selectedGoal=null;selectedWelcome=null;selectedLabels=[];setSchematic(false);resetTurnChallenge();}
    for(const row of targetLabelNodes){const friendly=selectedLabels.find(x=>x.group_id===row.group_id&&x.field===row.field)?.label??`${row.group_id}: ${row.field}`;row.exact.textContent=`${friendly} (${row.min} to ${row.max}) `;row.slider.textContent=`Choose ${friendly} `;}
    playGoal.textContent=selectionAuthority && selectedGoal ? `Project's stated goal (not verified): ${selectedGoal}`:'Project goal unavailable.';
    playWelcome.textContent=selectionAuthority && selectedWelcome ? selectedWelcome:'Project welcome unavailable.';updateTutorial(null);if(turnGoal)syncTurnButtons();
  };
  // Presentation-only projection; the application owns inventory and session fencing.
  const setProjectGoal=(value:{attempt:number;session_id:string;project_revision:string;goal:string;welcome?:string|null;schematic?:boolean;simpleDuck?:boolean;tutorial?:boolean;turnGoal?:{body:string;min_radians:number}|null;targetLabels?:readonly {group_id:string;field:string;label:string}[]}|null)=>{
    if(disposed)return;
    if(value===null){selectionAuthority=null;selectedGoal=null;selectedWelcome=null;selectedLabels=[];tutorialEnabled=false;lastTutorialStep=null;setSchematic(false);resetTurnChallenge();updateGoal();return;}
    const keys=['attempt','session_id','project_revision','goal'];
    const fields=keys.map(key=>Object.getOwnPropertyDescriptor(value,key));
    const turnField=Object.getOwnPropertyDescriptor(value,'turnGoal'),tutorialField=Object.getOwnPropertyDescriptor(value,'tutorial'),welcomeField=Object.getOwnPropertyDescriptor(value,'welcome'),schematicField=Object.getOwnPropertyDescriptor(value,'schematic'),duckField=Object.getOwnPropertyDescriptor(value,'simpleDuck'),labelsField=Object.getOwnPropertyDescriptor(value,'targetLabels');
    if(fields.some(field=>!field || !Object.hasOwn(field,'value')) ||
       !Number.isSafeInteger(value.attempt) || value.attempt<1 ||
       typeof value.session_id!=='string' || !value.session_id ||
       typeof value.project_revision!=='string' || !value.project_revision ||
       typeof value.goal!=='string' || !value.goal || value.goal.length>240 ||
       (schematicField && (!Object.hasOwn(schematicField,'value') || typeof schematicField.value!=='boolean')) ||
       (duckField && (!Object.hasOwn(duckField,'value') || typeof duckField.value!=='boolean')) ||
       (welcomeField && (!Object.hasOwn(welcomeField,'value') || (welcomeField.value!==null && (typeof welcomeField.value!=='string' || !welcomeField.value || welcomeField.value.length>1200))))) {
      selectionAuthority=null;selectedGoal=null;selectedWelcome=null;updateGoal();return;
    }
    try {selectedLabels=labelsField&&Object.hasOwn(labelsField,'value')?labelsOf(labelsField.value):[];} catch {selectedLabels=[];}
    let nextTurn:{body:string;min_radians:number}|null=null;
    try {const t=turnField&&Object.hasOwn(turnField,'value')?copyBounded(turnField.value,2048):null;if(t!==null){if(!t||typeof t!=='object'||Array.isArray(t)||Object.keys(t).length!==2||typeof (t as any).body!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test((t as any).body)||typeof (t as any).min_radians!=='number'||!Number.isFinite((t as any).min_radians)||(t as any).min_radians<0.00001||(t as any).min_radians>Math.PI)throw Error('Invalid turn goal');nextTurn={body:(t as any).body,min_radians:(t as any).min_radians};}}catch{nextTurn=null;}
    if(!nextTurn||!turnGoal||nextTurn.body!==turnGoal.body||nextTurn.min_radians!==turnGoal.min_radians||!sessionMatches(selectionAuthority)){resetTurnChallenge();turnGoal=nextTurn;if(turnGoal)turnFeedback.textContent='Start the challenge when you are ready.';}
    selectionAuthority={attempt:value.attempt,session_id:value.session_id,project_revision:value.project_revision};
    tutorialEnabled=!!tutorialField&&Object.hasOwn(tutorialField,'value')&&tutorialField.value===true;selectedGoal=value.goal;selectedWelcome=welcomeField?.value ?? null;setSchematic(schematicField?.value===true,duckField?.value===true);updateGoal();
    if(duckField?.value===true && duckView && schematicEnabled && !schematicRequested && sessionMatches(selectionAuthority)){representation='duck';onSchematic();}
  };
  const onChoice=(attempt:number)=>{
    const id=session.identity;
    choiceAuthority=id && typeof id.session_id==='string' && typeof id.project_revision==='string' ? {attempt,session_id:id.session_id,project_revision:id.project_revision}:null;
  };
  const onOverview=(event:{kind:'selected'|'overview';attempt:number;revision:string;goal?:string|null;welcome?:string|null;targetLabels?:readonly {group_id:string;field:string;label:string}[]})=>{
    if(disposed)return;
    if(event.kind==='selected') {
      selectionAuthority=choiceAuthority?.attempt===event.attempt && choiceAuthority.project_revision===event.revision && sessionMatches(choiceAuthority) ? choiceAuthority:null;
      selectedGoal=null;selectedWelcome=null;selectedLabels=[];
    } else if(selectionAuthority?.attempt===event.attempt && selectionAuthority.project_revision===event.revision) {
      selectedGoal=typeof event.goal==='string'?event.goal:null;
      try {selectedLabels=event.targetLabels?labelsOf(event.targetLabels):[];} catch {selectedLabels=[];}
      selectedWelcome=typeof event.welcome==='string' && event.welcome.length>0 && event.welcome.length<=1200 ? event.welcome:null;
    }
    updateGoal();
  };
  play.addEventListener('click',updateGoal);research.addEventListener('click',updateGoal);
  const host=createSurfaceHost({session,viewport,playPane,researchPane});
  const controls=createSessionControls({session,surfaceHost:host,controls:{run,pause,step,play,research,status,researchStep,researchStepCount},beforeResearchStep:invalidate,afterStep:(result)=>{updateTutorial(result);syncTurnButtons();if(schematicRequested)onSchematic();},afterPause:(result)=>{updateTutorial(result,'pause');syncTurnButtons();if(schematicRequested)onSchematic();},beforeAdvance:()=>{turnSerial++;if(turnGoal){turnStart.disabled=true;turnCheck.disabled=true;}}});
  const cancelAttempt=(attempt:ActiveAttempt)=>{
    if(attempt.cancelled)return;
    attempt.cancelled=true;
    if(!disposed) {attemptCancel.disabled=true;attemptStatus.textContent='Cancellation requested; waiting for the current batch.';}
    if(!attempt.handle)return;
    try {
      attempt.cancelWork=Promise.resolve(attempt.handle.cancel()).catch(error=>{attempt.cancelFailed=true;rememberCleanup(error);});
    } catch(error) {attempt.cancelFailed=true;rememberCleanup(error);attempt.cancelWork=Promise.resolve();}
  };
  const onAttemptCancel=()=>{if(activeAttempt)cancelAttempt(activeAttempt);};
  const validAttemptFields=()=>{
    const text=attemptTicks.value,configuration=attemptConfig.value,runtime=attemptRuntime.value;
    if(!/^[1-9][0-9]*$/.test(text) || Number(text)>4096 || !/^[a-f0-9]{64}$/.test(configuration) || !/^[a-f0-9]{64}$/.test(runtime))throw new Error('Enter 1 to 4096 steps and two lowercase SHA-256 declarations.');
    return {requested:Number(text),declaration:{project_revision:session.identity.project_revision,configuration_sha256:configuration,runtime_lock_sha256:runtime}};
  };
  const onAttemptPlan=()=>{
    if(disposed)return;
    try {const {requested,declaration}=validAttemptFields();history.plan(requested,declaration);renderHistory();ledgerStatus.textContent='Attempt planned; outcome missing.';}
    catch(error) {ledgerStatus.textContent=error instanceof Error?error.message:'Unable to plan attempt.';}
  };
  const onAttemptExport=()=>{
    if(disposed)return;
    let url:string|null=null;
    try {
      const text=JSON.stringify(history.snapshot(),null,2)+'\n';
      if(new TextEncoder().encode(text).byteLength>65536)throw new Error('Attempt notes exceed the export limit');
      url=URL.createObjectURL(new Blob([text],{type:'application/json'}));exportUrls.add(url);
      const link=doc.createElement('a');link.href=url;link.download='robot-attempt-notes.json';link.click();
      const owned=url;const timer=setTimeout(()=>{exportTimers.delete(owned);revokeExport(owned);},1000);exportTimers.set(owned,timer);
    } catch {
      if(url)revokeExport(url);
      ledgerStatus.textContent='Unable to create the download.';
    }
  };
  let lastMeasured:{id:string;receipt:any;identity:any}|null=null;
  const startAttempt=(measured:boolean)=>{
    if(disposed || activeAttempt)return;
    let fields:ReturnType<typeof validAttemptFields>;
    try {fields=validAttemptFields();} catch(error) {attemptStatus.textContent=error instanceof Error?error.message:'Invalid attempt.';return;}
    const {requested,declaration}=fields, configuration=declaration.configuration_sha256, runtime=declaration.runtime_lock_sha256;
    if(typeof session.startBoundedAttempt!=='function') {attemptStatus.textContent='Bounded attempts are unavailable.';return;}
    const channel=measured ? session.recordingChannels?.[Number(measurementChoice.value)] : undefined;
    if(measured && (!channel || typeof session.startMeasuredAttempt!=='function' || requested>256)){attemptStatus.textContent='Choose an available measurement and 1 to 256 steps.';return;}
    if(!paused()) {attemptStatus.textContent='Pause the session before starting an attempt.';return;}
    const id={...session.identity};
    let rowId:string;
    try {rowId=history.reserve(requested,declaration,id);renderHistory();}
    catch(error) {attemptStatus.textContent=error instanceof Error?error.message:'Unable to start attempt.';return;}
    const attempt:ActiveAttempt={rowId,identity:id,handle:null,cancelled:false,cancelFailed:false,cancelWork:null,settlement:null};
    activeAttempt=attempt;attemptOutcomeIdentity=null;attemptStart.disabled=true;measuredStart.disabled=true;attemptCancel.disabled=false;controls.setAttemptBusy(true);
    attemptStatus.textContent='Attempt running.';invalidate();
    try {
      const options={requested_ticks:requested,batch_size:measured ? Math.min(64,channel!.max_entries) : 64,max_wall_ms:30000,configuration_evidence:declaration};
      attempt.handle=measured ? session.startMeasuredAttempt!({...options,measurement:{group_id:channel!.group_id,channel_id:channel!.channel_id,definition_sha256:channel!.definition_sha256}}) : session.startBoundedAttempt(options);
      if(!attempt.handle || typeof attempt.handle.cancel!=='function' || !attempt.handle.result || typeof attempt.handle.result.then!=='function')throw new Error('Invalid attempt handle');
      if(attempt.cancelled) {attempt.cancelled=false;cancelAttempt(attempt);}
      const result=attempt.handle.result;
      attempt.settlement=Promise.resolve(result).then(async(receipt:any)=>{
        try {
        if(attempt.cancelWork)await attempt.cancelWork;
        if(disposed || activeAttempt!==attempt)return;
        if(!same(id,session.identity)){history.settle(rowId,'unavailable',null,null);renderHistory();attemptStatus.textContent='Attempt outcome unavailable because the session changed.';return;}
        if(attempt.cancelFailed){history.settle(rowId,'unavailable',null,null);renderHistory();attemptStatus.textContent='Attempt outcome unavailable because cancellation failed.';return;}
        const statuses=['completed','cancelled','deadline','failed','unknown'];
        const verified=receipt?.last_verified_tick, reported=receipt?.reported_steps;
        if(!receipt || !same(id,receipt.identity) || receipt.requested_ticks!==requested ||
           !receipt.configuration_evidence || receipt.configuration_evidence.project_revision!==declaration.project_revision ||
           receipt.configuration_evidence.configuration_sha256!==configuration || receipt.configuration_evidence.runtime_lock_sha256!==runtime ||
           !statuses.includes(receipt.status) || (verified!==null && (!Number.isSafeInteger(verified) || verified<0 || verified>requested)) ||
           (reported!==null && (!Number.isSafeInteger(reported) || reported<0)) || (receipt.status==='completed' && verified!==requested)) {
          history.settle(rowId,'unavailable',null,null);renderHistory();attemptStatus.textContent='Attempt outcome unavailable.';return;
        }
        if(measured){
          if(!receipt.measurement || !Array.isArray(receipt.measurement.entries))throw Error('Missing measurement');
          lastMeasured={id:'session-measured-'+crypto.randomUUID(),receipt:copyBounded(receipt,524288),identity:id};
        }
        history.settle(rowId,receipt.status as Exclude<AttemptNoteStatus,'planned'|'running'>,verified,reported);renderHistory();
        attemptOutcomeIdentity=id;
        attemptStatus.textContent=`Attempt ${receipt.status} (epoch ${id.run_epoch}). ${verified===null?'No verified tick.':`Verified tick: ${verified}.`} Outcome not saved.`;
        } catch {if(!disposed && activeAttempt===attempt){try {history.settle(rowId,'unavailable',null,null);renderHistory();} catch {} attemptStatus.textContent='Attempt outcome unavailable.';}}
      },async()=>{if(attempt.cancelWork)await attempt.cancelWork;if(!disposed && activeAttempt===attempt){history.settle(rowId,'unavailable',null,null);renderHistory();attemptStatus.textContent=same(id,session.identity)?'Attempt failed; outcome unavailable.':'Attempt outcome unavailable because the session changed.';}})
      .finally(async()=>{if(attempt.cancelWork)await attempt.cancelWork;if(activeAttempt===attempt){activeAttempt=null;if(!disposed){attemptStart.disabled=!paused();measuredStart.disabled=!paused()||!(session.recordingChannels?.length);attemptCancel.disabled=true;controls.setAttemptBusy(false);}}});
    } catch {
      if(!disposed){try {history.settle(rowId,'unavailable',null,null);renderHistory();} catch {}}
      activeAttempt=null;attemptStart.disabled=!paused();measuredStart.disabled=!paused()||!(session.recordingChannels?.length);attemptCancel.disabled=true;controls.setAttemptBusy(false);
      if(!disposed)attemptStatus.textContent='Attempt failed; outcome unavailable.';
    }
  };
  attemptStart.disabled=!paused();
  const onAttemptStart=()=>startAttempt(false),onMeasuredStart=()=>startAttempt(true);
  attemptStart.addEventListener('click',onAttemptStart);measuredStart.addEventListener('click',onMeasuredStart);attemptCancel.addEventListener('click',onAttemptCancel);
  attemptPlan.addEventListener('click',onAttemptPlan);attemptExport.addEventListener('click',onAttemptExport);
  let inspector:ReturnType<typeof mountProjectInspector>|null=null;
  // Terminal state is published before cleanup so queued display work is fenced.
  const retireShell=()=>{
    disposed=true;generation++;displayGeneration++;
    for (const action of [
      ()=>{canvas.hidden=true;schematicCanvas.hidden=true;duckCanvas.hidden=true;duckView?.dispose();},
      ()=>{schematicButton.removeEventListener('click',onShowSchematic);duckButton.removeEventListener('click',onShowDuck);},
      ()=>{stopSchematic?.();stopSchematic=null;},
      ()=>inspector?.dispose(),
      ()=>{comparisonDrain=savedComparison?.dispose()??null;},
      ()=>play.removeEventListener('click',updateGoal),
      ()=>research.removeEventListener('click',updateGoal),
      ()=>refresh.removeEventListener('click',onRefresh),
      ()=>pinBaseline.removeEventListener('click',onPin),
      ()=>{referenceSnapshot=null;},
      ()=>vectorsPrevious.removeEventListener('click',onPrevious),
      ()=>vectorsNext.removeEventListener('click',onNext),
      ()=>{vectorSnapshot=null;},
      ()=>run.removeEventListener('click',invalidate),
      ()=>step.removeEventListener('click',invalidate),
      ()=>{turnSerial++;turnStart.removeEventListener('click',onTurnStart);turnCheck.removeEventListener('click',onTurnCheck);for(const cleanup of targetCleanup)cleanup();},
      ()=>attemptStart.removeEventListener('click',onAttemptStart),
      ()=>measuredStart.removeEventListener('click',onMeasuredStart),
      ()=>attemptCancel.removeEventListener('click',onAttemptCancel),
      ()=>attemptPlan.removeEventListener('click',onAttemptPlan),
      ()=>attemptExport.removeEventListener('click',onAttemptExport),
      ()=>{for(const timer of exportTimers.values())clearTimeout(timer);exportTimers.clear();for(const url of exportUrls)revokeExport(url);},
      ()=>showDisplay.removeEventListener('click',show),
      ()=>refreshDisplay.removeEventListener('click',refreshView),
      ()=>controls.dispose(),
      ()=>container.remove(),
    ]) {try {action();} catch(error) {rememberCleanup(error);}}
  };
  try {
    if (projectInspector !== undefined) {
      if (!projectInspector || typeof projectInspector!=='object') throw new Error('Invalid project inspector');
      inspector=mountProjectInspector({root:container,chooseDirectory:projectInspector.chooseDirectory,folderLimits:projectInspector.folderLimits,inventoryLimits:projectInspector.inventoryLimits,onChoice,onOverview});
    }
  } catch(error) {retireShell();throw error;}
  refresh.addEventListener('click',onRefresh);
  vectorsPrevious.addEventListener('click',onPrevious);vectorsNext.addEventListener('click',onNext);pinBaseline.addEventListener('click',onPin);
  try {root.appendChild(container);} catch (error) {retireShell();throw error;}
  const captureGameChallenge=()=>{
    if(disposed||!turnGoal||!turnBaseline||!selectionAuthority||!sessionMatches(selectionAuthority))return null;
    if(turnBusy||!paused())throw Error('Challenge operation in progress');
    const id={...session.identity},baseline=turnBaseline,goal=turnGoal,version=turnSerial,outcome=turnOutcome;
    if(!same(id,baseline.identity))return null;
    const record={schema_version:2,kind:'body-turn',identity:id,body:goal.body,threshold_radians:goal.min_radians,started_tick:baseline.tick,checked_tick:outcome?.checked_tick??null,angle_radians:outcome?.angle_radians??null,status:outcome?.status??'not_checked',start_quaternion_bits:encodeQuaternionBits(baseline.quaternion),checked_quaternion_bits:outcome?.quaternion?encodeQuaternionBits(outcome.quaternion):null};
    const content=new Blob([JSON.stringify(record)],{type:'application/json'});
    return Object.freeze({id:gameRecordId,content,isCurrent:()=>!disposed&&!turnBusy&&paused()&&turnSerial===version&&turnBaseline===baseline&&turnGoal===goal&&same(id,session.identity)&&sessionMatches(selectionAuthority)});
  };
  const captureAttemptNotes=()=>{
    if(disposed)return null;const snapshot=history.snapshot();if(!snapshot.rows.length)return null;
    const version=historyVersion,id={...session.identity};const content=new Blob([JSON.stringify(snapshot)],{type:'application/json'});
    return Object.freeze({content,isCurrent:()=>!disposed&&historyVersion===version&&same(id,session.identity)});
  };
  const captureMeasuredAttempt=()=>{
    const chosen=lastMeasured;if(disposed||activeAttempt||!chosen||!same(chosen.identity,session.identity))return null;
    return Object.freeze({id:chosen.id,receipt:chosen.receipt,isCurrent:()=>!disposed&&!activeAttempt&&lastMeasured===chosen&&same(chosen.identity,session.identity)});
  };
  return Object.freeze({get selectedProject(){return inspector?.selectedProject ?? null;},setProjectGoal,captureAttemptNotes,captureMeasuredAttempt,captureGameChallenge,dispose() {
    if (disposal) return disposal;
    let resolveDisposal!:()=>void, rejectDisposal!:(reason:unknown)=>void;
    disposal=new Promise<void>((resolve,reject)=>{resolveDisposal=resolve;rejectDisposal=reject;});
    const attempt=activeAttempt;
    retireShell();
    if(attempt)cancelAttempt(attempt);
    void Promise.resolve().then(async()=>{
      if(comparisonDrain)try {await comparisonDrain;} catch(error) {rememberCleanup(error);}
      if(attempt?.settlement)try {await attempt.settlement;} catch(error) {rememberCleanup(error);}
      if(attempt?.cancelWork)try {await attempt.cancelWork;} catch(error) {rememberCleanup(error);}
      if(attachPending)try {await attachPending;} catch(error) {rememberCleanup(error);}
      if(refreshPending)try {await refreshPending;} catch(error) {rememberCleanup(error);}
      if(view){const active=view;view=null;try {await active.detach();}catch(error){rememberCleanup(error);}}
      if(cleanupFailed)throw cleanupFailure;
    }).then(resolveDisposal,rejectDisposal);
    return disposal;
  }});
}
