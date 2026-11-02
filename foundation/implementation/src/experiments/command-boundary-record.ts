import {copyBounded} from '../session/project-world-wire.ts';

const exact=(v:any,keys:readonly string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const sameIdentity=(a:any,b:any)=>!!a&&!!b&&a.session_id===b.session_id&&a.project_revision===b.project_revision&&a.run_epoch===b.run_epoch;
const projectedRecords=new WeakSet<object>();
export function isProjectedCommandBoundary(value:unknown):boolean{return !!value&&typeof value==='object'&&projectedRecords.has(value as object);}
const identityKeys=['session_id','project_revision','run_epoch'];
const inputKeys=['actuator_name','component','unit','semantic','engine_index','input_range','requested','applied','limited'];
const recordKeys=['identity','boundary_tick','outcome','group_id','lease_generation','sequence','source','request_tick','inputs'];
const finite=(v:any)=>typeof v==='number'&&Number.isFinite(v);
const equalRange=(a:any,b:any)=>a===null&&b===null||Array.isArray(a)&&Array.isArray(b)&&a.length===2&&b.length===2&&Object.is(a[0],b[0])&&Object.is(a[1],b[1]);

/** Read a completed group boundary without granting control or changing the world.
 * Held steps inherit request/limit evidence only from an explicitly supplied,
 * contiguous prior record; absent evidence remains null, never guessed. */
export function projectCommandBoundary(receipt:unknown,groupState:unknown,compiledGroup:unknown,previous?:unknown){
 if(previous!==undefined&&previous!==null&&((typeof previous!=='object')||!projectedRecords.has(previous as object)))throw Error('Untrusted preceding command record');
 const owned=copyBounded({receipt,groupState,compiledGroup,previous:previous??null},1048576),r=owned.receipt,g=owned.groupState,layout=owned.compiledGroup,prior=owned.previous;
 const id=r?.identity,tick=r?.boundary_tick,lease=g?.lease;
 if(!exact(id,identityKeys)||typeof id.session_id!=='string'||!id.session_id||typeof id.project_revision!=='string'||!/^[0-9a-f]{64}$/.test(id.project_revision)||!Number.isSafeInteger(id.run_epoch)||id.run_epoch<0||
    !Number.isSafeInteger(tick)||tick<0||r.status!=='integrated'||r.plant_before?.tick!==tick||r.plant_after?.tick!==tick+1||
    !Array.isArray(r.committed_control)||r.committed_control.length>4096||!r.committed_control.every(finite)||!Array.isArray(r.commits)||!Array.isArray(r.held_group_ids)||
    !lease||typeof lease.group_id!=='string'||!lease.group_id||typeof lease.owner_id!=='string'||!lease.owner_id||!Number.isSafeInteger(lease.generation)||lease.generation<1||
    !Number.isSafeInteger(g.accepted_sequence)||g.accepted_sequence<0||!Number.isSafeInteger(lease.control_stride)||lease.control_stride<1||
    !layout||layout.group_id!==lease.group_id||layout.control_stride!==lease.control_stride||!Array.isArray(layout.blocks)||!layout.blocks.length)throw Error('Invalid command boundary');
 const inputDefs:any[]=[],indices=new Set<number>();
 for(const block of layout.blocks){
  if(!block||typeof block.actuator_name!=='string'||!block.actuator_name||!Array.isArray(block.engine_indices)||!Array.isArray(block.inputs)||!block.inputs.length||block.inputs.length!==block.engine_indices.length)throw Error('Invalid command layout');
  for(let i=0;i<block.inputs.length;i++){
   const d=block.inputs[i],index=block.engine_indices[i],range=d?.input_range;
   if(!Number.isSafeInteger(index)||index<0||index>=r.committed_control.length||indices.has(index)||!d||d.actuator_name!==block.actuator_name||!Number.isSafeInteger(d.component)||d.component<0||typeof d.unit!=='string'||!d.unit||typeof d.semantic!=='string'||!d.semantic||
      !(range===null||Array.isArray(range)&&range.length===2&&range.every(finite)&&range[0]<=range[1]))throw Error('Invalid command input');
   indices.add(index);inputDefs.push({actuator_name:d.actuator_name,component:d.component,unit:d.unit,semantic:d.semantic,engine_index:index,input_range:range===null?null:[...range]});
  }
 }
 if(inputDefs.length>256||inputDefs.length!==layout.control_size)throw Error('Invalid command size');
 const commits=r.commits.filter((x:any)=>x?.group_id===lease.group_id),held=r.held_group_ids.filter((x:any)=>x===lease.group_id);
 if(commits.length+held.length!==1)throw Error('Command group missing or duplicated');
 const fresh=commits.length===1;let requestTick:number|null=null,requested:any[]=[],limited:any[]=[];
 if(fresh){
  const c=commits[0];if(c.owner_id!==lease.owner_id||c.lease_generation!==lease.generation||c.sequence!==g.accepted_sequence||g.last_control_tick!==tick||
    !Array.isArray(c.requested)||!Array.isArray(c.committed)||!Array.isArray(c.clipped)||[c.requested,c.committed,c.clipped].some((x:any[])=>x.length!==inputDefs.length))throw Error('Invalid committed command');
  requestTick=tick;requested=c.requested;limited=c.clipped;
  for(let i=0;i<inputDefs.length;i++){
   const d=inputDefs[i],want=requested[i],applied=c.committed[i],range=d.input_range;
   if(!finite(want)||!finite(applied)||typeof limited[i]!=='boolean')throw Error('Invalid command values');
   const expected=range===null?want:want<range[0]?range[0]:want>range[1]?range[1]:want;
   if(!Object.is(expected,applied)||!Object.is(applied,r.committed_control[d.engine_index])||limited[i]!== (want!==applied))throw Error('Inconsistent command limiting');
  }
 }else{
  if(g.last_control_tick!==null&&(!Number.isSafeInteger(g.last_control_tick)||g.last_control_tick<0||g.last_control_tick>=tick))throw Error('Invalid held command origin');
  if((g.last_control_tick===null)!==(g.accepted_sequence===0))throw Error('Invalid held command sequence');
  requestTick=g.last_control_tick;requested=inputDefs.map(()=>null);limited=inputDefs.map(()=>null);
 }
 if(prior!==null){
  if(!exact(prior,recordKeys)||!sameIdentity(prior.identity,id)||prior.boundary_tick!==tick-1||prior.outcome!=='completed'||prior.group_id!==lease.group_id||prior.lease_generation!==lease.generation||!Array.isArray(prior.inputs)||prior.inputs.length!==inputDefs.length)throw Error('Invalid preceding command record');
  if(!fresh){
   if(prior.sequence!==g.accepted_sequence||prior.request_tick!==requestTick)throw Error('Held command origin changed');
   for(let i=0;i<inputDefs.length;i++){
    const d=inputDefs[i],old=prior.inputs[i],applied=r.committed_control[d.engine_index];
    if(!exact(old,inputKeys)||old.actuator_name!==d.actuator_name||old.component!==d.component||old.unit!==d.unit||old.semantic!==d.semantic||old.engine_index!==d.engine_index||!equalRange(old.input_range,d.input_range)||!Object.is(old.applied,applied)||
       !((old.requested===null&&old.limited===null)||(finite(old.requested)&&typeof old.limited==='boolean'&&old.limited===(old.requested!==old.applied))))throw Error('Invalid held command evidence');
    if(old.requested!==null){const range=d.input_range,want=old.requested,expected=range===null?want:want<range[0]?range[0]:want>range[1]?range[1]:want;if(!Object.is(expected,applied))throw Error('Invalid held command limiting');}
    requested[i]=old.requested;limited[i]=old.limited;
   }
  }
 }
 const inputs=inputDefs.map((d,i)=>Object.freeze({...d,input_range:d.input_range===null?null:Object.freeze(d.input_range),requested:requested[i],applied:r.committed_control[d.engine_index],limited:limited[i]}));
 const result=Object.freeze({identity:Object.freeze({...id}),boundary_tick:tick,outcome:'completed',group_id:lease.group_id,lease_generation:lease.generation,sequence:g.accepted_sequence,source:fresh?'fresh':'held',request_tick:requestTick,inputs:Object.freeze(inputs)});projectedRecords.add(result);return result;
}
