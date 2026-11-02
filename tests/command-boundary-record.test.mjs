import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {captureProjectInventory} from '../foundation/implementation/src/projects/project-inventory.ts';
import {createMujocoWorldFromProject} from '../foundation/implementation/src/simulation/mujoco-world.ts';
import {createMeasuredControllerSupervisor} from '../foundation/implementation/src/simulation/mujoco-controller-boundary.ts';
import {projectCommandBoundary} from '../foundation/implementation/src/experiments/command-boundary-record.ts';
const path=process.env.MICRODUCK_BUILTIN_PROJECT;if(!path)throw Error('MICRODUCK_BUILTIN_PROJECT required');const f=JSON.parse(await readFile(path)),profile=JSON.parse(await readFile(new URL('../microduck-profile.json',import.meta.url)));
async function setup(){const inventory=await captureProjectInventory(f.files.map(x=>({path:x.path,data:Uint8Array.from(Buffer.from(x.data_base64,'base64'))})),profile.policy.inventoryLimits);const group={...profile.profile.groups[0],owner_id:'command-test-owner'};
 const {world}=await createMujocoWorldFromProject(inventory,{blocks:profile.profile.blocks,groups:[group],microduck_truth:profile.profile.microduck_truth},profile.policy.compileLimits);
 const runner={async initialize(){},async stage(v){return {stageId:'s'+v.sequence,control:Array.from({length:14},(_,i)=>i===0?20:i===1?-20:.25)}},async commit(stageId){return {stageId}},async abort(){},async close(){}};
 const supervisor=await createMeasuredControllerSupervisor(world,[{group_id:'all',runner,grants:profile.controllers[0].grants,parameters:{},intent:{speed:0}}]);return {world,supervisor}}
test('records requested and limited commands on actual world steps and explicitly links held commands',async()=>{
 const f=await setup();try{const layout=f.world.describeControlGroup('all');let previous;for(let tick=0;tick<5;tick++){
  const receipt=await f.supervisor.integrateBoundary(),group=f.world.inspect().commands.groups[0],row=projectCommandBoundary(receipt,group,layout,previous);
  assert.equal(row.boundary_tick,tick);assert.equal(row.outcome,'completed');assert.equal(row.group_id,'all');assert.equal(row.inputs.length,14);
  assert.deepEqual(row.inputs.map(x=>x.applied),receipt.committed_control);assert.equal(row.inputs[0].actuator_name,'left_hip_yaw');
  if(tick===0||tick===4){assert.equal(row.source,'fresh');assert.equal(row.request_tick,tick);assert.equal(row.inputs[0].requested,20);assert.equal(row.inputs[0].applied,10);assert.equal(row.inputs[0].limited,true);assert.equal(row.inputs[1].requested,-20);assert.equal(row.inputs[1].applied,-10);assert.equal(row.inputs[2].limited,false)}
  else {assert.equal(row.source,'held');assert.equal(row.request_tick,0);assert.equal(row.sequence,1);assert.equal(row.inputs[0].requested,20);assert.equal(row.inputs[0].limited,true);const withoutHistory=projectCommandBoundary(receipt,group,layout);assert.ok(withoutHistory.inputs.every(x=>x.requested===null&&x.limited===null))}
  previous=row;
 }}finally{await f.supervisor.dispose();await f.world.dispose()}
});
test('rejects changed authority, wrong layout, incomplete integration or falsified limited values',async()=>{
 const f=await setup();try{const receipt=await f.supervisor.integrateBoundary(),group=f.world.inspect().commands.groups[0],layout=f.world.describeControlGroup('all');
  for(const mutate of [r=>r.status='engine-fault',r=>r.boundary_tick++,r=>r.commits[0].lease_generation++,r=>r.commits[0].clipped[0]=false,r=>r.committed_control[0]=7]){const bad=structuredClone(receipt);mutate(bad);assert.throws(()=>projectCommandBoundary(bad,group,layout))}
  const badLayout=structuredClone(layout);badLayout.blocks[0].engine_indices[0]=999;assert.throws(()=>projectCommandBoundary(receipt,group,badLayout));
 }finally{await f.supervisor.dispose();await f.world.dispose()}
});

test('held request provenance cannot be forged by passing a copied or modified prior row',async()=>{
 const f=await setup();try{const layout=f.world.describeControlGroup('all'),firstReceipt=await f.supervisor.integrateBoundary(),first=projectCommandBoundary(firstReceipt,f.world.inspect().commands.groups[0],layout);
  const heldReceipt=await f.supervisor.integrateBoundary(),group=f.world.inspect().commands.groups[0],forged=structuredClone(first);forged.inputs[0].requested=999;
  assert.throws(()=>projectCommandBoundary(heldReceipt,group,layout,forged));assert.throws(()=>projectCommandBoundary(heldReceipt,group,layout,structuredClone(first)));
  const held=projectCommandBoundary(heldReceipt,group,layout,first);assert.equal(held.inputs[0].requested,20);assert.equal(held.inputs[0].limited,true);
 }finally{await f.supervisor.dispose();await f.world.dispose()}
});

test('whole multi-input blocks use their actual engine indices without exposing another group',()=>{
 const identity={session_id:'s',project_revision:'a'.repeat(64),run_epoch:0},lease={group_id:'arm',owner_id:'owner',generation:1,control_stride:1};
 const group={lease,accepted_sequence:1,last_control_tick:0,fresh_at_tick:null};
 const layout={group_id:'arm',control_stride:1,control_size:2,blocks:[{actuator_name:'motor',engine_indices:[2,0],inputs:[{actuator_name:'motor',component:0,unit:'N',semantic:'first',input_range:[-1,1]},{actuator_name:'motor',component:1,unit:'N',semantic:'second',input_range:null}]}]};
 const receipt={identity,boundary_tick:0,status:'integrated',plant_before:{tick:0},plant_after:{tick:1},committed_control:[2,99,1],commits:[{group_id:'arm',owner_id:'owner',lease_generation:1,sequence:1,requested:[5,2],committed:[1,2],clipped:[true,false]}],held_group_ids:['other']};
 const row=projectCommandBoundary(receipt,group,layout);assert.deepEqual(row.inputs.map(x=>x.engine_index),[2,0]);assert.deepEqual(row.inputs.map(x=>x.applied),[1,2]);assert.deepEqual(row.inputs.map(x=>x.requested),[5,2]);assert.equal(JSON.stringify(row).includes('99'),false);
});
