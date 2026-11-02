import {copyBounded} from '../session/project-world-wire.ts';
import {partitionControlInputs} from '../simulation/control-layout.ts';
import {validateControlBlockMetadata} from '../simulation/control-boundary.ts';
/** Reconstruct a group's whole-block layout from host-owned admitted metadata. */
export function commandGroupLayout(blockInput:unknown,groupInput:unknown,groupId:unknown){
 const blocks=copyBounded(blockInput,1048576),groups=copyBounded(groupInput,1048576);
 if(!Array.isArray(blocks)||!blocks.length||!Array.isArray(groups)||!groups.length||typeof groupId!=='string'||!groupId)throw Error('Invalid command group layout');
 const indices=blocks.flatMap((b:any)=>Array.isArray(b?.engine_indices)?b.engine_indices:[]);if(!indices.length||indices.length>4096||indices.some((x:any)=>!Number.isSafeInteger(x)||x<0||x>=4096))throw Error('Invalid command indices');
 validateControlBlockMetadata(blocks);const count=Math.max(...indices)+1;
 const partitions=partitionControlInputs(count,blocks,groups.map((g:any)=>({group_id:g.group_id,actuator_names:g.actuator_names})));
 const matching=groups.filter((g:any)=>g.group_id===groupId);if(matching.length!==1||!Number.isSafeInteger(matching[0].control_stride)||matching[0].control_stride<1)throw Error('Unknown command group');
 const group=matching[0],partition=partitions.find(x=>x.group_id===groupId),map=new Map(blocks.map((b:any)=>[b.actuator_name,b]));
 if(!partition)throw Error('Unknown command group');return {group_id:groupId,control_stride:group.control_stride,control_size:partition.engine_indices.length,blocks:group.actuator_names.map((name:string)=>map.get(name))};
}
