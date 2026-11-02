import {copyBounded} from '../session/project-world-wire.ts';
import {projectCommandBoundary,isProjectedCommandBoundary} from './command-boundary-record.ts';

const identityKeys=['session_id','project_revision','run_epoch','group_id','lease_generation'];
const exact=(v:any,k:readonly string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));
const freeze=(value:any):any=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const key of Object.keys(value))freeze(value[key]);Object.freeze(value)}return value};
const same=(a:any,b:any)=>a.session_id===b.session_id&&a.project_revision===b.project_revision&&a.run_epoch===b.run_epoch;
/** Bounded evidence for one already-authorized group; no command authority is created. */
export function createCommandBatchRecorder(authorityInput:unknown,layoutInput:unknown,startInput:unknown,countInput:unknown,previous?:unknown){
 const authority=copyBounded(authorityInput,4096),layout=copyBounded(layoutInput,65536),start=startInput as number,count=countInput as number;
 if(!exact(authority,identityKeys)||typeof authority.session_id!=='string'||!authority.session_id||authority.session_id.length>256||typeof authority.project_revision!=='string'||!/^[0-9a-f]{64}$/.test(authority.project_revision)||!Number.isSafeInteger(authority.run_epoch)||authority.run_epoch<0||typeof authority.group_id!=='string'||!authority.group_id||authority.group_id.length>256||!Number.isSafeInteger(authority.lease_generation)||authority.lease_generation<1||
    !Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(count)||count<1||count>64||!Number.isSafeInteger(start+count)||!layout||layout.group_id!==authority.group_id||!Number.isSafeInteger(layout.control_stride)||layout.control_stride<1||!Array.isArray(layout.blocks)||!layout.blocks.length)throw Error('Invalid command batch');
 if(previous!==undefined&&previous!==null){const p=previous as any;if(!isProjectedCommandBoundary(p)||!same(p.identity,authority)||p.group_id!==authority.group_id||p.lease_generation!==authority.lease_generation||p.boundary_tick!==start-1||p.outcome!=='completed')throw Error('Invalid preceding command evidence');}
 const inputs:any[]=[],indices=new Set<number>();
 for(const block of layout.blocks){if(!block||block.validation_rule_id!=='independent-scalar-ranges'||typeof block.actuator_name!=='string'||!block.actuator_name||!Array.isArray(block.inputs)||!Array.isArray(block.engine_indices)||!block.inputs.length||block.inputs.length!==block.engine_indices.length)throw Error('Invalid command layout');
  for(let i=0;i<block.inputs.length;i++){const x=block.inputs[i],engine_index=block.engine_indices[i],range=x?.input_range;
   if(!x||x.actuator_name!==block.actuator_name||!Number.isSafeInteger(x.component)||x.component<0||typeof x.unit!=='string'||!x.unit||typeof x.semantic!=='string'||!x.semantic||!Number.isSafeInteger(engine_index)||engine_index<0||engine_index>=4096||indices.has(engine_index)||!(range===null||Array.isArray(range)&&range.length===2&&range.every((v:any)=>typeof v==='number'&&Number.isFinite(v))&&range[0]<=range[1]))throw Error('Invalid command input');
   indices.add(engine_index);inputs.push({actuator_name:x.actuator_name,component:x.component,unit:x.unit,semantic:x.semantic,validation_rule:block.validation_rule_id,engine_index,input_range:range});
  }
 }
 if(inputs.length>256||inputs.length!==layout.control_size)throw Error('Invalid command size');
 const description=freeze({group_id:authority.group_id,control_stride:layout.control_stride,limit_stage:'host-control-input-range',inputs});const rows:any[]=[];let prior=previous??null,last:any=null,unknown=false;
 function capture(receipt:unknown,group:unknown){
  if(unknown||rows.length>=count)throw Error('Command batch closed');
  const row=projectCommandBoundary(receipt,group,layout,prior??undefined);
  if(!same(row.identity,authority)||row.group_id!==authority.group_id||row.lease_generation!==authority.lease_generation||row.boundary_tick!==start+rows.length)throw Error('Command batch authority or timing changed');
  const compact=freeze({boundary_tick:row.boundary_tick,outcome:row.outcome,sequence:row.sequence,source:row.source,request_tick:row.request_tick,
   requested:row.inputs.map(x=>x.requested),applied:row.inputs.map(x=>x.applied),limited:row.inputs.map(x=>x.limited)});
  rows.push(compact);prior=row;last=row;
 }
 function markUnknown(tick:unknown){
  if(unknown||rows.length>=count||tick!==start+rows.length)throw Error('Invalid unknown command boundary');
  rows.push(freeze({boundary_tick:tick,outcome:'unknown',sequence:null,source:'unknown',request_tick:null,requested:null,applied:null,limited:null}));unknown=true;last=null;
 }
 function snapshot(){return freeze({authority:copyBounded(authority,4096),start_tick:start,requested_count:count,layout:description,rows:[...rows],complete:!unknown&&rows.length===count});}
 return Object.freeze({capture,markUnknown,snapshot,lastRecord(){return last}});
}
