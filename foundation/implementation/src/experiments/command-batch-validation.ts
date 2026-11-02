import {copyBounded,sameBoundedData} from '../session/project-world-wire.ts';
import {createCommandBatchRecorder} from './command-batch-record.ts';
const continuationState=new WeakMap<object,any>();
const exact=(v:any,k:readonly string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));
const finite=(x:any)=>typeof x==='number'&&Number.isFinite(x);
const rowKeys=['boundary_tick','outcome','sequence','source','request_tick','requested','applied','limited'];
const requestKeys=['authority','attempt_token','start_tick','steps'];
const sameNumbers=(a:any[],b:any[])=>a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
function frozen(v:any):any{if(v&&typeof v==='object'&&!Object.isFrozen(v)){for(const k of Object.keys(v))frozen(v[k]);Object.freeze(v)}return v}
/** Validate a completed command sidecar against trusted layout and before/after
 * authority. A continuation is minted only after a fully validated batch. */
export function validateCommandBatch(expectedInput:unknown,layoutInput:unknown,beforeGroupInput:unknown,beforeControlInput:unknown,afterGroupInput:unknown,afterControlInput:unknown,batchInput:unknown,continuation?:unknown){
 const e=copyBounded(expectedInput,8192),layout=copyBounded(layoutInput,65536),before=copyBounded(beforeGroupInput,65536),after=copyBounded(afterGroupInput,65536),beforeControl=copyBounded(beforeControlInput,1048576),afterControl=copyBounded(afterControlInput,1048576),batch=copyBounded(batchInput,65536);
 if(!exact(e,requestKeys)||typeof e.attempt_token!=='string'||!e.attempt_token||e.attempt_token.length>256||!Number.isSafeInteger(e.start_tick)||e.start_tick<0||!Number.isSafeInteger(e.steps)||e.steps<1||e.steps>64||!Number.isSafeInteger(e.start_tick+e.steps))throw Error('Invalid command request');
 const expectedLayout=createCommandBatchRecorder(e.authority,layout,e.start_tick,e.steps).snapshot().layout;
 if(!exact(batch,['authority','start_tick','requested_count','layout','rows','complete'])||!sameBoundedData(batch.authority,e.authority)||batch.start_tick!==e.start_tick||batch.requested_count!==e.steps||!sameBoundedData(batch.layout,expectedLayout)||batch.complete!==true||!Array.isArray(batch.rows)||batch.rows.length!==e.steps)throw Error('Invalid command batch');
 if(!before?.lease||!after?.lease||!sameBoundedData(before.lease,after.lease)||before.lease.group_id!==e.authority.group_id||before.lease.generation!==e.authority.lease_generation||before.lease.control_stride!==layout.control_stride||!Number.isSafeInteger(before.accepted_sequence)||before.accepted_sequence<0||
    (before.last_control_tick!==null&&(!Number.isSafeInteger(before.last_control_tick)||before.last_control_tick<0||before.last_control_tick>=e.start_tick))||
    ((before.last_control_tick===null)!==(before.accepted_sequence===0))||
    (before.fresh_at_tick!==null&&(!Number.isSafeInteger(before.fresh_at_tick)||before.fresh_at_tick<e.start_tick))||!Array.isArray(beforeControl)||!Array.isArray(afterControl)||beforeControl.length!==afterControl.length||!beforeControl.every(finite)||!afterControl.every(finite))throw Error('Invalid command baseline');
 const defs=expectedLayout.inputs,indices=defs.map((d:any)=>d.engine_index);if(indices.some((i:number)=>i>=beforeControl.length))throw Error('Invalid command indices');
 let sequence=before.accepted_sequence,lastTick=before.last_control_tick,fresh=before.fresh_at_tick,applied=indices.map((i:number)=>beforeControl[i]),knownRequested:any[]=defs.map(()=>null),knownLimited:any[]=defs.map(()=>null);
 if(continuation!==undefined&&continuation!==null){
  if(typeof continuation!=='object'||!continuationState.has(continuation as object))throw Error('Untrusted command continuation');const prior=continuationState.get(continuation as object);
  if(!sameBoundedData(prior.authority,e.authority)||prior.attempt_token!==e.attempt_token||prior.boundary_tick!==e.start_tick-1||!sameBoundedData(prior.layout,expectedLayout)||prior.sequence!==sequence||prior.request_tick!==lastTick||!sameNumbers(prior.applied,applied))throw Error('Command continuation mismatch');
  knownRequested=[...prior.requested];knownLimited=[...prior.limited];
 }
 for(let n=0;n<batch.rows.length;n++){
  const row=batch.rows[n],tick=e.start_tick+n;if(!exact(row,rowKeys)||row.boundary_tick!==tick||row.outcome!=='completed'||!Array.isArray(row.requested)||!Array.isArray(row.applied)||!Array.isArray(row.limited)||[row.requested,row.applied,row.limited].some((x:any[])=>x.length!==defs.length))throw Error('Invalid command row');
  const due=tick%layout.control_stride===0||fresh===tick;
  if(due){
   if(!Number.isSafeInteger(sequence+1)||row.source!=='fresh'||row.sequence!==sequence+1||row.request_tick!==tick)throw Error('Invalid fresh command cadence');
   sequence++;lastTick=tick;fresh=null;
   for(let i=0;i<defs.length;i++){
    const want=row.requested[i],got=row.applied[i],limited=row.limited[i],range=defs[i].input_range;
    if(!finite(want)||!finite(got)||typeof limited!=='boolean')throw Error('Invalid fresh command');
    const expected=range===null?want:want<range[0]?range[0]:want>range[1]?range[1]:want;
    if(!Object.is(expected,got)||limited!==(want!==got))throw Error('Invalid command limiting');
   }
   knownRequested=[...row.requested];knownLimited=[...row.limited];applied=[...row.applied];
  }else{
   if(row.source!=='held'||row.sequence!==sequence||row.request_tick!==lastTick||!sameNumbers(row.applied,applied)||!sameNumbers(row.requested,knownRequested)||!sameNumbers(row.limited,knownLimited))throw Error('Invalid held command');
  }
 }
 if(after.accepted_sequence!==sequence||after.last_control_tick!==lastTick||after.fresh_at_tick!==fresh||!sameNumbers(indices.map((i:number)=>afterControl[i]),applied))throw Error('Command final state mismatch');
 const token=Object.freeze({});continuationState.set(token,{authority:e.authority,attempt_token:e.attempt_token,boundary_tick:e.start_tick+e.steps-1,layout:expectedLayout,sequence,request_tick:lastTick,applied,requested:knownRequested,limited:knownLimited});
 return Object.freeze({batch:frozen(batch),continuation:token});
}
