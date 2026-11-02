import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {bindPublishedDuckRig,projectPublishedDuckFrame} from '../foundation/implementation/src/display/published-duck-pose.ts';
const pack=JSON.parse(await readFile(new URL('../assets/microduck-visual.json',import.meta.url)));
function fixture(){const bodies=[{id:0,name:'world'},...pack.bodies.map((b,i)=>({id:i+1,name:b.name}))];return {model:{bodies},frame:{tick:3,bodies:bodies.map((b,i)=>({id:i,position:[i*.01,i*.02,i*.03],quaternion:[1,0,0,0]}))}}}
test('published mesh rig follows each exact named simulated body pose without changing it',()=>{
 const {model,frame}=fixture(),before=structuredClone(frame),binding=bindPublishedDuckRig(pack.bodies,model),poses=projectPublishedDuckFrame(binding,frame);
 assert.equal(poses.length,15);for(let i=0;i<15;i++){assert.equal(poses[i].name,pack.bodies[i].name);assert.deepEqual(poses[i].position,frame.bodies[i+1].position);assert.deepEqual(poses[i].quaternion,[1,0,0,0])}assert.deepEqual(frame,before);
});
test('missing or duplicate bodies and invalid transforms are rejected explicitly',()=>{
 const {model,frame}=fixture();assert.throws(()=>bindPublishedDuckRig(pack.bodies,{bodies:model.bodies.slice(0,-1)}));
 assert.throws(()=>bindPublishedDuckRig(pack.bodies,{bodies:[...model.bodies,{id:100,name:'trunk_base'}]}));
 const binding=bindPublishedDuckRig(pack.bodies,model);const bad=structuredClone(frame);bad.bodies[1].quaternion=[0,0,0,0];assert.throws(()=>projectPublishedDuckFrame(binding,bad));
});
test('the cartoon renderer is no longer mounted in the application shell',async()=>{
 const shell=await readFile(new URL('../foundation/implementation/src/web/session-shell.ts',import.meta.url),'utf8');assert.doesNotMatch(shell,/createSimpleDuckView/);assert.match(shell,/createPublishedDuckView/);
});

test('published rig tracks the actual compiled Microduck world without changing its physics',async()=>{
 const path=process.env.MICRODUCK_BUILTIN_PROJECT;if(!path)throw Error('MICRODUCK_BUILTIN_PROJECT required');
 const fixture=JSON.parse(await readFile(path)),profile=JSON.parse(await readFile(new URL('../microduck-profile.json',import.meta.url)));
 const {captureProjectInventory}=await import('../foundation/implementation/src/projects/project-inventory.ts');
 const {createMujocoWorldFromProject}=await import('../foundation/implementation/src/simulation/mujoco-world.ts');
 const {createMeasuredControllerSupervisor}=await import('../foundation/implementation/src/simulation/mujoco-controller-boundary.ts');
 async function world(){const inventory=await captureProjectInventory(fixture.files.map(x=>({path:x.path,data:Uint8Array.from(Buffer.from(x.data_base64,'base64'))})),profile.policy.inventoryLimits);
  const group={...profile.profile.groups[0],owner_id:'visual-test-owner'};const {world}=await createMujocoWorldFromProject(inventory,{blocks:profile.profile.blocks,groups:[group],microduck_truth:profile.profile.microduck_truth},profile.policy.compileLimits);
  const runner={async initialize(){},async stage(v){return {stageId:'step-'+v.sequence,control:Array(14).fill(0)}},async commit(stageId){return {stageId}},async abort(){},async close(){}};
  const supervisor=await createMeasuredControllerSupervisor(world,[{group_id:'all',runner,grants:profile.controllers[0].grants,parameters:{},intent:{speed:0}}]);return {world,supervisor};}
 const a=await world(),b=await world();try{
  for(let tick=0;tick<9;tick++){
   const before=a.world.inspect(),visual=a.world.visualSnapshot(),binding=bindPublishedDuckRig(pack.bodies,visual.model),poses=projectPublishedDuckFrame(binding,visual.frame);
   assert.equal(visual.frame.tick,tick);for(const pose of poses){const body=visual.model.bodies.find(x=>x.name===pose.name),actual=visual.frame.bodies[body.id];assert.deepEqual(pose.position,actual.position);assert.deepEqual(pose.quaternion,actual.quaternion)}
   assert.deepEqual(a.world.inspect(),before);assert.deepEqual(a.world.inspect().plant,b.world.inspect().plant);
   if(tick<8){await a.supervisor.integrateBoundary();await b.supervisor.integrateBoundary();}
  }
 }finally{await a.supervisor.dispose();await b.supervisor.dispose();await a.world.dispose();await b.world.dispose()}
});
