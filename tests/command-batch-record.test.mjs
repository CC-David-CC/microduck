import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {captureProjectInventory} from '../foundation/implementation/src/projects/project-inventory.ts';import {createMujocoWorldFromProject} from '../foundation/implementation/src/simulation/mujoco-world.ts';import {createMeasuredControllerSupervisor} from '../foundation/implementation/src/simulation/mujoco-controller-boundary.ts';
import {createCommandBatchRecorder} from '../foundation/implementation/src/experiments/command-batch-record.ts';
const path=process.env.MICRODUCK_BUILTIN_PROJECT;if(!path)throw Error('MICRODUCK_BUILTIN_PROJECT required');const f=JSON.parse(await readFile(path)),profile=JSON.parse(await readFile(new URL('../microduck-profile.json',import.meta.url)));
async function setup(){const inv=await captureProjectInventory(f.files.map(x=>({path:x.path,data:Uint8Array.from(Buffer.from(x.data_base64,'base64'))})),profile.policy.inventoryLimits),group={...profile.profile.groups[0],owner_id:'batch-test'};
 const {world}=await createMujocoWorldFromProject(inv,{blocks:profile.profile.blocks,groups:[group],microduck_truth:profile.profile.microduck_truth},profile.policy.compileLimits);
 const runner={async initialize(){},async stage(v){return {stageId:'s'+v.sequence,control:Array.from({length:14},(_,i)=>i===0?20:.25)}},async commit(stageId){return {stageId}},async abort(){},async close(){}};
 const supervisor=await createMeasuredControllerSupervisor(world,[{group_id:'all',runner,grants:profile.controllers[0].grants,parameters:{},intent:{speed:0}}]);return {world,supervisor}}
test('bounded batches retain each actual step and held provenance across a batch boundary',async()=>{
 const f=await setup();try{const view=f.world.inspect(),lease=view.commands.groups[0].lease,authority={...view.identity,group_id:'all',lease_generation:lease.generation},layout=f.world.describeControlGroup('all');
  const first=createCommandBatchRecorder(authority,layout,0,5);for(let i=0;i<5;i++){const receipt=await f.supervisor.integrateBoundary();first.capture(receipt,f.world.inspect().commands.groups[0])}const a=first.snapshot();assert.equal(a.rows.length,5);assert.equal(a.complete,true);assert.equal(a.rows[0].requested[0],20);assert.equal(a.rows[0].applied[0],10);assert.equal(a.rows[0].limited[0],true);
  const second=createCommandBatchRecorder(authority,layout,5,3,first.lastRecord());for(let i=0;i<3;i++){const receipt=await f.supervisor.integrateBoundary();second.capture(receipt,f.world.inspect().commands.groups[0])}const b=second.snapshot();assert.equal(b.rows[0].source,'held');assert.equal(b.rows[0].request_tick,4);assert.equal(b.rows[0].requested[0],20);assert.equal(b.rows[0].limited[0],true);assert.equal(b.rows[0].applied[0],10);assert.equal(b.complete,true);assert.deepEqual(b.layout,a.layout);
 }finally{await f.supervisor.dispose();await f.world.dispose()}
});
test('unknown step outcomes remain explicitly unknown and never claim applied values',async()=>{
 const f=await setup();try{const v=f.world.inspect(),lease=v.commands.groups[0].lease,authority={...v.identity,group_id:'all',lease_generation:lease.generation},rec=createCommandBatchRecorder(authority,f.world.describeControlGroup('all'),0,2);
  const r=await f.supervisor.integrateBoundary();rec.capture(r,f.world.inspect().commands.groups[0]);rec.markUnknown(1);const result=rec.snapshot();assert.equal(result.complete,false);assert.equal(result.rows[1].outcome,'unknown');assert.equal(result.rows[1].requested,null);assert.equal(result.rows[1].applied,null);assert.equal(result.rows[1].limited,null);assert.throws(()=>rec.markUnknown(2));
 }finally{await f.supervisor.dispose();await f.world.dispose()}
});
test('wrong authority, oversized batch, noncontiguous steps and forged preceding evidence are refused',async()=>{
 const f=await setup();try{const v=f.world.inspect(),lease=v.commands.groups[0].lease,authority={...v.identity,group_id:'all',lease_generation:lease.generation},layout=f.world.describeControlGroup('all');
  assert.throws(()=>createCommandBatchRecorder(authority,layout,0,65));assert.throws(()=>createCommandBatchRecorder({...authority,group_id:'other'},layout,0,1));
  const rec=createCommandBatchRecorder(authority,layout,0,1),r=await f.supervisor.integrateBoundary(),group=f.world.inspect().commands.groups[0];const bad=structuredClone(r);bad.boundary_tick=3;assert.throws(()=>rec.capture(bad,group));rec.capture(r,group);assert.throws(()=>rec.capture(r,group));
  assert.throws(()=>createCommandBatchRecorder(authority,layout,1,1,structuredClone(rec.lastRecord())));assert.equal(f.world.inspect().plant.tick,1);
 }finally{await f.supervisor.dispose();await f.world.dispose()}
});
