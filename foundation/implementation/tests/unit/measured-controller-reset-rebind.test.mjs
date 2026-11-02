import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import * as boundary from '../../src/simulation/mujoco-controller-boundary.ts';
import {createMujocoWorld} from '../../src/simulation/mujoco-world.ts';

const root=resolve(import.meta.dirname,'../../..');
const digest=x=>createHash('sha256').update(x).digest('hex');
const oracleBytes=await readFile(resolve(root,'reports/v1-hinge-measurement-preparation/ORACLES.json'));
assert.equal(digest(oracleBytes),'77712f94f47c1654a8ab410ed577bb9e205d42f4ac246f14a03e77f177c31534');
const oracle=JSON.parse(oracleBytes.toString('utf8'));
const base=oracle.vectors.find(row=>row.id==='base');
const xmlBytes=await readFile(resolve(root,oracle.projects.base.fixture_path));
assert.equal(digest(xmlBytes),'f0fcc0184861506dd2c1c09dec3ca0f220c8992c5c902df8be2b403d4ecb5270');
const xml=xmlBytes.toString('utf8');
const channel={id:'measure.angle',kind:'measurement',size:1,unit:'rad',frame:null,
  definition_sha256:'2167a5d9688d02d3c9acf3ea6050bf49674e59df2291ea63d4d1da25ac7d355b',source_ids:['truth.angle']};
const grant=[{channel_id:channel.id,definition_sha256:channel.definition_sha256}];
const input=(name,unit)=>({actuator_name:name,component:0,unit,
  semantic:'qualified unit-gear fixture input',input_range:null});
const torqueBlock={actuator_name:'torque',engine_indices:[0],validation_rule_id:'independent-scalar-ranges',
  inputs:[input('torque','N m')]};
const forceBlock={actuator_name:'force',engine_indices:[1],validation_rule_id:'independent-scalar-ranges',
  inputs:[input('force','N')]};
const expectedDue=[['hinge','slide'],[],['hinge'],['slide'],['hinge'],[],['hinge','slide'],[],
  ['hinge'],['slide'],['hinge'],[],['hinge','slide']];

function factory(world,registrations) {
  assert.equal(typeof boundary.createMeasuredControllerSupervisor,'function',
    'C04-B must export createMeasuredControllerSupervisor');
  return boundary.createMeasuredControllerSupervisor(world,registrations);
}
function blockConfig(){return [structuredClone(torqueBlock),structuredClone(forceBlock)];}
function worldConfig({measured=true,combined=false}={}) {
  return {project_revision:base.project_revision,blocks:blockConfig(),
    groups:combined?[{group_id:'combined',owner_id:'combined-owner',control_stride:1,
      actuator_names:['force','torque']}]:[
      {group_id:'hinge',owner_id:'hinge-owner',control_stride:2,actuator_names:['torque']},
      {group_id:'slide',owner_id:'slide-owner',control_stride:3,actuator_names:['force']}],
    ...(measured?{hinge_measurement:{joint_name:'angle',request:structuredClone(base.request)}}:{})};
}
async function newWorld(options){return createMujocoWorld(xml,worldConfig(options));}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
async function waitFor(promise,message){
  let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{
    timer=setTimeout(()=>reject(new Error(message)),5000);
  })]);}finally{clearTimeout(timer);}
}
function makeRunner(id,hooks={}) {
  const calls=[];let width=1;
  const runner={
    initialize(descriptor,parameters){
      calls.push({kind:'initialize',descriptor:structuredClone(descriptor),parameters:structuredClone(parameters)});
      width=descriptor.control_size;
      if(hooks.initialize)return hooks.initialize(descriptor,parameters);
      return Promise.resolve();
    },
    stage(value){
      calls.push({kind:'stage',observation:structuredClone(value.observation),intent:structuredClone(value.intent),
        sequence:value.sequence,applyTick:value.applyTick});
      if(hooks.stage)return hooks.stage(value);
      return Promise.resolve({stageId:`${id}:${value.sequence}:${value.applyTick}`,control:Array(width).fill(2)});
    },
    commit(stageId){
      calls.push({kind:'commit',stageId});
      if(hooks.commit)return hooks.commit(stageId);
      return Promise.resolve({stageId});
    },
    abort(stageId){
      calls.push({kind:'abort',stageId});
      if(hooks.abort)return hooks.abort(stageId);
      return Promise.resolve();
    },
    close(){
      calls.push({kind:'close'});
      if(hooks.close)return hooks.close();
      return Promise.resolve();
    },
  };
  return {runner,calls};
}
function registration(group_id,handle,grants=[]) {
  return {group_id,runner:handle.runner,grants:structuredClone(grants),parameters:{gain:1},intent:{target:0}};
}
function pair(world,hooks={}) {
  const hinge=makeRunner('hinge',hooks.hinge||{}),slide=makeRunner('slide',hooks.slide||{});
  return {hinge,slide,registrations:[registration('hinge',hinge,grant),registration('slide',slide,[])]};
}
function only(calls,kind){return calls.filter(row=>row.kind===kind);}
function dueAt(tick){return expectedDue[tick];}
function expectedSample(row){
  if(row.value===null)return {validity:'missing',values:[],sequence:null,capture_tick:null,available_tick:null};
  return {validity:row.validity,values:[row.value],sequence:row.sequence,
    capture_tick:row.capture_tick,available_tick:row.available_tick};
}
function assertSample(actual,row){
  assert.equal(actual.validity,row.validity);assert.equal(actual.sequence,row.sequence);
  assert.equal(actual.capture_tick,row.capture_tick);assert.equal(actual.available_tick,row.available_tick);
  if(row.value===null)assert.deepEqual(actual.values,[]);
  else {assert.equal(actual.values.length,1);assert.ok(Math.abs(actual.values[0]-row.value)<=1e-12);}
}
async function assertWorldMutatorsBlocked(world){
  const before=world.inspect(),last=world.lastBoundary(),measurement=world.readMeasurement();
  await assert.rejects(Promise.resolve().then(()=>world.reset()));
  await assert.rejects(Promise.resolve().then(()=>world.dispose()));
  assert.deepEqual(world.inspect(),before);assert.deepEqual(world.lastBoundary(),last);
  assert.deepEqual(world.readMeasurement(),measurement);
}
function cleanupWorld(t,world){
  const owners=[];
  t.after(async()=>{
    for(let i=owners.length-1;i>=0;i--)await owners[i].dispose();
    await world.dispose();
  });
  return supervisor=>owners.push(supervisor);
}
function c02Assignments(view,handles){
  return view.due_group_ids.map(group_id=>({group_id,runner:handles[group_id].runner,samples:{},intent:{target:0}}));
}

test('same world can bind fresh runners after reset with a restarted measurement stream',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world),old=pair(world);
  const prior=await factory(world,old.registrations);own(prior);
  await prior.integrateBoundary();
  const original=world.inspect().identity;
  await prior.dispose();
  const reset=world.reset();
  assert.equal(reset.identity.session_id,original.session_id);
  assert.equal(reset.identity.project_revision,original.project_revision);
  assert.equal(reset.identity.run_epoch,original.run_epoch+1);
  assert.equal(reset.plant.tick,0);
  assert.ok(reset.commands.groups.every(group=>group.accepted_sequence===0));
  assert.equal(world.readMeasurement(),null);
  const fresh=pair(world),next=await factory(world,fresh.registrations);own(next);
  await next.integrateBoundary();
  const after=world.inspect();
  assert.equal(after.plant.tick,1);assert.equal(after.identity.run_epoch,1);
  const observation=only(fresh.hinge.calls,'stage')[0].observation;
  assert.equal(observation.run_epoch,1);assert.equal(observation.tick,0);
  assert.equal(only(fresh.hinge.calls,'stage')[0].sequence,1);
  assertSample(observation.samples[channel.id],oracle.trace[0]);
  assert.equal(only(old.hinge.calls,'close').length,1);
});

test('rebind rejects old runner objects and leaves reset world unchanged',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world),old=pair(world);
  const prior=await factory(world,old.registrations);own(prior);
  await prior.integrateBoundary();await prior.dispose();world.reset();
  const before=world.inspect();
  await assert.rejects(factory(world,old.registrations));
  assert.deepEqual(world.inspect(),before);
  assert.equal(only(old.hinge.calls,'initialize').length,1);
});

test('a live old supervisor reservation prevents fresh reset-epoch binding',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world),old=pair(world);
  const prior=await factory(world,old.registrations);own(prior);
  world.reset();
  const fresh=pair(world),before=world.inspect();
  await assert.rejects(factory(world,fresh.registrations));
  assert.deepEqual(fresh.hinge.calls,[]);assert.deepEqual(fresh.slide.calls,[]);
  assert.deepEqual(world.inspect(),before);
});

test('failed runner teardown is surfaced and prevents a new supervisor reservation',async t=>{
  const world=await newWorld(),old=pair(world,{hinge:{close(){return Promise.reject(new Error('termination failed'));}}});
  t.after(()=>world.dispose());
  const supervisor=await factory(world,old.registrations);
  await supervisor.integrateBoundary();
  await assert.rejects(supervisor.dispose(),/close|termination/i);
  world.reset();
  const before=world.inspect(),fresh=pair(world);
  await assert.rejects(factory(world,fresh.registrations));
  assert.deepEqual(fresh.hinge.calls,[]);assert.deepEqual(fresh.slide.calls,[]);
  assert.deepEqual(world.inspect(),before);
});

test('failed teardown after a boundary fault retains the supervisor reservation',async t=>{
  const world=await newWorld(),old=pair(world,{hinge:{stage(){throw new Error('stage failed');},close(){throw new Error('close failed');}}});
  t.after(()=>world.dispose());
  const supervisor=await factory(world,old.registrations);
  await assert.rejects(supervisor.integrateBoundary(),/close/i);
  await assert.rejects(supervisor.dispose(),/close/i);
  const fresh=pair(world),before=world.inspect();
  await assert.rejects(factory(world,fresh.registrations));
  assert.deepEqual(fresh.hinge.calls,[]);assert.deepEqual(fresh.slide.calls,[]);
  assert.deepEqual(world.inspect(),before);
});
