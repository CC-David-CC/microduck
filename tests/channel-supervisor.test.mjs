import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {captureProjectInventory} from '../foundation/implementation/src/projects/project-inventory.ts';
import {createMujocoWorldFromProject} from '../foundation/implementation/src/simulation/mujoco-world.ts';
import {createMeasuredControllerSupervisor} from '../foundation/implementation/src/simulation/mujoco-controller-boundary.ts';
const path=process.env.MICRODUCK_BUILTIN_PROJECT;if(!path)throw Error('MICRODUCK_BUILTIN_PROJECT required');
const fixture=JSON.parse(await readFile(path)),profile=JSON.parse(await readFile(new URL('../microduck-profile.json',import.meta.url)));
const reference=JSON.parse(await readFile(new URL('./fixtures/granted-truth.json',import.meta.url)))[0];
async function setup(fail=false){
 const inventory=await captureProjectInventory(fixture.files.map(x=>({path:x.path,data:Uint8Array.from(Buffer.from(x.data_base64,'base64'))})),profile.policy.inventoryLimits);
 const group={...profile.profile.groups[0],owner_id:'test-owner'};
 const {world}=await createMujocoWorldFromProject(inventory,{blocks:profile.profile.blocks,groups:[group],microduck_truth:profile.profile.microduck_truth},profile.policy.compileLimits);
 const channel=world.describeMeasurementChannel(),initial=world.inspect(),lease=initial.commands.groups[0].lease,calls=[];
 const runner={async initialize(){},async stage(value){calls.push(structuredClone(value.observation));if(fail)throw Error('synthetic controller failure');return {stageId:'step-'+value.sequence,control:Array(14).fill(0)}},async commit(stageId){return {stageId}},async abort(){},async close(){}};
 const supervisor=await createMeasuredControllerSupervisor(world,[{group_id:'all',runner,grants:profile.controllers[0].grants,parameters:{},intent:{speed:0}}]);
 const authority={...initial.identity,group_id:'all',lease_generation:lease.generation,channel_id:channel.id,definition_sha256:channel.definition_sha256};
 const grant={purpose:'channel-recording',authority:structuredClone(authority),channel:structuredClone(channel),max_entries:8};
 return {world,channel,supervisor,authority,grant,calls};
}
test('actual Microduck world records its exact pre-step truth vector at each successful boundary',async()=>{
 const f=await setup();try{
  const rec=f.supervisor.createStepRecorder({authority:f.authority,grant:f.grant},8);
  for(let i=0;i<8;i++){
   await f.supervisor.integrateBoundary(rec);
   const captured=f.world.lastIntegratedMeasurement();
   assert.equal(captured.boundary_tick,i);assert.equal(captured.measurement.stage,i===0?'initial-forward':'post-step-pre-forward');
   assert.deepEqual(rec.snapshot().entries[i].sample,captured.measurement.sample);
  }
  const rows=rec.snapshot().entries;assert.equal(rows.length,8);assert.deepEqual(rows.map(x=>x.observed_tick),[0,1,2,3,4,5,6,7]);
  for(const row of rows){assert.equal(row.outcome,'completed');assert.equal(row.sample.values.length,35);assert.equal(row.sample.capture_tick,row.observed_tick);assert.equal(row.sample.available_tick,row.observed_tick)}
  assert.equal(rows[0].sample.validity,reference.validity);assert.equal(rows[0].sample.values.length,reference.values.length);
  for(let i=0;i<reference.values.length;i++)assert.ok(Math.abs(rows[0].sample.values[i]-reference.values[i])<1e-12,`Initial reference mismatch at ${i}`);
  assert.equal(f.calls.length,2);for(const observation of f.calls){const row=rows[observation.tick];assert.deepEqual(row.sample,observation.samples['microduck.truth'])}
  assert.equal(f.world.inspect().plant.tick,8);assert.equal(rec.snapshot().complete,false);
 }finally{await f.supervisor.dispose();await f.world.dispose()}
});
test('changed grant or compiled descriptor is refused without stepping',async()=>{
 const f=await setup();try{
  for(const mutate of [g=>g.channel.size=1,g=>g.channel.kind='measurement',g=>g.channel.definition_sha256='f'.repeat(64),g=>g.authority.run_epoch++,g=>g.max_entries=256]){
   const grant=structuredClone(f.grant);mutate(grant);assert.throws(()=>f.supervisor.createStepRecorder({authority:f.authority,grant},8));
  }
  assert.equal(f.world.inspect().plant.tick,0);assert.equal(f.calls.length,0);
 }finally{await f.supervisor.dispose();await f.world.dispose()}
});
test('failed controller boundary retains unknown outcome instead of claiming success',async()=>{
 const f=await setup(true);try{
  const rec=f.supervisor.createStepRecorder({authority:f.authority,grant:f.grant},1);
  await assert.rejects(f.supervisor.integrateBoundary(rec));const snapshot=rec.snapshot();
  assert.equal(snapshot.entries.length,1);assert.equal(snapshot.entries[0].outcome,'unknown');assert.equal(snapshot.complete,false);
 }finally{await Promise.resolve().then(()=>f.supervisor.dispose()).catch(()=>{});await Promise.resolve().then(()=>f.world.dispose()).catch(()=>{})}
});
