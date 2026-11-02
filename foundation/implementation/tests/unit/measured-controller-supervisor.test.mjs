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

test('initializes world-canonical descriptors and preserves combined block binding order',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world);
  const handles=pair(world),supervisor=await factory(world,handles.registrations);own(supervisor);
  assert.deepEqual(only(handles.hinge.calls,'initialize')[0],{kind:'initialize',parameters:{gain:1},
    descriptor:{group_id:'hinge',control_size:1,inputs:[input('torque','N m')],control_stride:2,observations:[channel]}});
  assert.deepEqual(only(handles.slide.calls,'initialize')[0],{kind:'initialize',parameters:{gain:1},
    descriptor:{group_id:'slide',control_size:1,inputs:[input('force','N')],control_stride:3,observations:[]}});
  await supervisor.dispose();

  const combinedWorld=await newWorld({combined:true}),ownCombined=cleanupWorld(t,combinedWorld);
  const combined=makeRunner('combined');
  const combinedSupervisor=await factory(combinedWorld,[registration('combined',combined,grant)]);
  ownCombined(combinedSupervisor);
  assert.deepEqual(only(combined.calls,'initialize')[0].descriptor,
    {group_id:'combined',control_size:2,inputs:[input('force','N'),input('torque','N m')],
      control_stride:1,observations:[channel]});
});

test('invalid groups, duplicate clients, forged grants, and unmeasured worlds reject before side effects',async t=>{
  const world=await newWorld();cleanupWorld(t,world);
  const before=world.inspect();
  async function rejected(registrations,handles){
    await assert.rejects(factory(world,registrations));
    for(const handle of handles)assert.deepEqual(handle.calls,[],'preflight rejection leaves client ownership with caller');
    assert.deepEqual(world.inspect(),before);assert.equal(world.readMeasurement(),null);
  }
  const a=makeRunner('a'),b=makeRunner('b');
  await rejected([registration('hinge',a,grant)], [a]); // missing group
  await rejected([registration('hinge',a,grant),registration('hinge',b,[])], [a,b]); // duplicate group
  await rejected([registration('invented',a,[]),registration('slide',b,[])], [a,b]); // unknown group
  await rejected([registration('hinge',a,grant),registration('slide',a,[])], [a]); // duplicate runner
  await rejected([registration('hinge',a,[{channel_id:'unknown',definition_sha256:'0'.repeat(64)}]),
    registration('slide',b,[])], [a,b]);
  await rejected([registration('hinge',a,[{channel_id:channel.id,definition_sha256:'0'.repeat(64)}]),
    registration('slide',b,[])], [a,b]); // same ID, wrong definition
  await rejected([registration('hinge',a,[{channel_id:'truth.angle',definition_sha256:'0'.repeat(64)}]),
    registration('slide',b,[])], [a,b]); // truth can never be granted
  await rejected([registration('hinge',a,[...grant,...grant]),registration('slide',b,[])], [a,b]);

  const unmeasured=await newWorld({measured:false});cleanupWorld(t,unmeasured);
  const u1=makeRunner('u1'),u2=makeRunner('u2'),unmeasuredBefore=unmeasured.inspect();
  await assert.rejects(factory(unmeasured,[registration('hinge',u1,grant),registration('slide',u2,[])]));
  assert.deepEqual(u1.calls,[]);assert.deepEqual(u2.calls,[]);
  assert.deepEqual(unmeasured.inspect(),unmeasuredBefore);assert.equal(unmeasured.readMeasurement(),null);
});

test('captures registration data before asynchronous initialization',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world);
  const initializeGate=deferred(),initializeEntered=deferred();let delayedArguments,delayedAfter;
  const delayedHandle=makeRunner('delayed');
  const delayedRunner={
    ...delayedHandle.runner,
    initialize(descriptor,parameters){delayedArguments={descriptor,parameters};initializeEntered.resolve();
      return initializeGate.promise.then(()=>{delayedAfter=structuredClone({descriptor,parameters});});},
  };
  const slide=makeRunner('slide');
  const mutableGrant=structuredClone(grant),parameters={gain:1},intent={target:0};
  const registrations=[{group_id:'hinge',runner:delayedRunner,grants:mutableGrant,parameters,intent},
    registration('slide',slide,[])];
  const constructing=factory(world,registrations);await waitFor(initializeEntered.promise,'controller initialization did not start');
  mutableGrant[0].channel_id='truth.angle';mutableGrant[0].definition_sha256='0'.repeat(64);
  parameters.gain=99;intent.target=99;
  initializeGate.resolve();const supervisor=await constructing;own(supervisor);
  assert.deepEqual(delayedAfter.parameters,{gain:1});assert.deepEqual(delayedAfter.descriptor.observations,[channel]);
  assert.deepEqual(delayedArguments.parameters,{gain:1});
  assert.equal(world.readMeasurement(),null,'initialization must not sample the world');
  await supervisor.integrateBoundary();
  const staged=only(delayedHandle.calls,'stage');assert.equal(staged[0].intent.target,0);
  assert.deepEqual(staged[0].observation.samples,{[channel.id]:staged[0].observation.samples[channel.id]});
  assertSample(staged[0].observation.samples[channel.id],oracle.trace[0]);
  assert.equal(only(slide.calls,'stage')[0].intent.target,0);
  assert.deepEqual(only(slide.calls,'stage')[0].observation.samples,{});
});

test('samples only world measurements on each physical tick, including empty-due ticks',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world);
  let prepareCalls=0;const prepare=world.prepareBoundary.bind(world);
  world.prepareBoundary=(...args)=>{prepareCalls++;return prepare(...args);};
  const handles=pair(world),supervisor=await factory(world,handles.registrations);own(supervisor);
  assert.equal(supervisor.integrateBoundary.length,0);
  const forged={identity:{session_id:'forged'},channel,sample:{validity:'valid',values:[999],sequence:999,
    capture_tick:999,available_tick:999},observed_tick:999,pending_count:0};
  await assert.rejects(supervisor.integrateBoundary({samples:{'measure.angle':forged.sample}}));
  assert.equal(prepareCalls,0);assert.equal(only(handles.hinge.calls,'stage').length,0);
  assert.equal(world.inspect().plant.tick,0);

  const lastControl={hinge:null,slide:null};
  for(let tick=0;tick<=12;tick++){
    const receipt=await supervisor.integrateBoundary();
    const due=dueAt(tick),held=['hinge','slide'].filter(id=>!due.includes(id));
    assert.equal(receipt.boundary_tick,tick);assert.equal(receipt.status,'integrated');
    assert.deepEqual(receipt.commits.map(row=>row.group_id),due);
    assert.deepEqual(receipt.held_group_ids,held);
    assert.equal(world.inspect().plant.tick,tick+1);
    assert.equal(prepareCalls,tick+1,'prepare exactly once even with no due controller');
    for(const [id,handle] of [['hinge',handles.hinge],['slide',handles.slide]]){
      const current=only(handle.calls,'stage').filter(row=>row.observation.tick===tick);
      assert.equal(current.length,due.includes(id)?1:0,`${id} stage count at tick ${tick}`);
      if(!due.includes(id))continue;
      const stage=current[0];
      assert.equal(stage.observation.project_revision,base.project_revision);
      assert.equal(stage.observation.run_epoch,0);assert.equal(stage.observation.sim_time,tick*0.0625);
      assert.equal(stage.observation.dt,lastControl[id]===null?0:(tick-lastControl[id])*0.0625);
      assert.equal(stage.sequence,expectedDue.slice(0,tick+1).filter(groups=>groups.includes(id)).length);
      assert.deepEqual(stage.intent,{target:0});
      if(id==='hinge'){
        assert.deepEqual(Object.keys(stage.observation.samples),[channel.id]);
        assertSample(stage.observation.samples[channel.id],oracle.trace[tick]);
      }else assert.deepEqual(stage.observation.samples,{});
      lastControl[id]=tick;
    }
  }
  const final=world.inspect().plant;
  assert.ok(Math.abs(final.qpos[7]-0.91015625)<=1e-12);
  assert.ok(Math.abs(final.qvel[6]-1.625)<=1e-12);
});

test('one lifetime reservation blocks competing C04 and valid C02 calls during initialization and a boundary',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world);
  const initGate=deferred(),initEntered=deferred(),stageGate=deferred(),stageEntered=deferred();
  const handles=pair(world,{hinge:{initialize(){initEntered.resolve();return initGate.promise;},
    stage(){stageEntered.resolve();return stageGate.promise.then(()=>({stageId:'hinge:1:0',control:[2]}));}}});
  const constructing=factory(world,handles.registrations);await waitFor(initEntered.promise,'initialization did not start');
  await assertWorldMutatorsBlocked(world);
  const rival=pair(world);await assert.rejects(factory(world,rival.registrations));
  assert.deepEqual(rival.hinge.calls,[]);assert.deepEqual(rival.slide.calls,[]);
  const c02=pair(world);
  await assert.rejects(boundary.integrateControllerBoundary(world,c02Assignments(world.inspect(),
    {hinge:c02.hinge,slide:c02.slide})));
  assert.equal(only(c02.hinge.calls,'stage').length,0);assert.equal(world.readMeasurement(),null);
  initGate.resolve();const supervisor=await constructing;own(supervisor);

  const active=supervisor.integrateBoundary();await waitFor(stageEntered.promise,'boundary stage did not start');
  const prepareCount=world.readMeasurement();assert.equal(prepareCount.observed_tick,0);
  await assertWorldMutatorsBlocked(world);
  const c02During=pair(world);
  await assert.rejects(boundary.integrateControllerBoundary(world,c02Assignments(world.inspect(),
    {hinge:c02During.hinge,slide:c02During.slide})));
  assert.equal(only(c02During.hinge.calls,'stage').length,0);
  await assert.rejects(supervisor.integrateBoundary());
  stageGate.resolve();await active;
  assert.equal(world.inspect().plant.tick,1);

  await supervisor.dispose();
  world.prepareBoundary(); // C02's existing measured-world precondition is satisfied.
  const c02After=await boundary.integrateControllerBoundary(world,[]); // tick 1 has no due group
  assert.equal(c02After.status,'integrated');assert.equal(world.inspect().plant.tick,2);
});

test('all initialization and cleanup settle and a failed close retains the reservation',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world);
  const initGate=deferred(),initEntered=deferred(),closeGate=deferred(),closeEntered=deferred();
  const fail=makeRunner('fail',{initialize(){throw new Error('sync init failure');},
    close(){throw new Error('sync close failure');}});
  const slow=makeRunner('slow',{initialize(){initEntered.resolve();return initGate.promise;},
    close(){closeEntered.resolve();return closeGate.promise;}});
  const registrations=[registration('hinge',fail,grant),registration('slide',slow,[])];
  const constructing=factory(world,registrations);
  await waitFor(Promise.race([initEntered.promise,constructing.then(()=>{
    throw new Error('factory settled before starting the later initialization');
  },error=>{throw error;})]),'later client initialization did not start');
  assert.equal(only(fail.calls,'initialize').length,1);
  assert.equal(only(slow.calls,'initialize').length,1,'an earlier synchronous throw must not prevent later initialization');
  const rival=pair(world);await assert.rejects(factory(world,rival.registrations));
  await assertWorldMutatorsBlocked(world);
  initGate.resolve();await waitFor(closeEntered.promise,'later client cleanup did not start after initialization settled');
  assert.equal(only(slow.calls,'close').length,1);assert.equal(only(fail.calls,'close').length,1);
  const contender=pair(world);await assert.rejects(factory(world,contender.registrations));
  assert.deepEqual(contender.hinge.calls,[]);
  let settled=false;constructing.finally(()=>{settled=true;}).catch(()=>{});
  await Promise.resolve();assert.equal(settled,false,'factory rejection waits for client close');
  closeGate.resolve();await assert.rejects(constructing);
  assert.equal(world.readMeasurement(),null);assert.equal(world.inspect().plant.tick,0);
  const fresh=pair(world);await assert.rejects(factory(world,fresh.registrations));
  assert.deepEqual(fresh.hinge.calls,[],'failed close retains the reservation and blocks replacement');
});

test('stage failure settles all groups, aborts successes, and fresh tick-zero clients reuse the cached sample',async t=>{
  const failedWorld=await newWorld(),referenceWorld=await newWorld();
  const ownFailed=cleanupWorld(t,failedWorld),ownReference=cleanupWorld(t,referenceWorld);
  const slowStage=deferred(),stageEntered=deferred(),closeGate=deferred(),closeEntered=deferred();
  const failed=pair(failedWorld,{hinge:{stage(){throw new Error('sync stage failure');}},
    slide:{stage(){stageEntered.resolve();return slowStage.promise.then(()=>({stageId:'slide:1:0',control:[2]}));},
      close(){closeEntered.resolve();return closeGate.promise;}}});
  const oldPrepare=failedWorld.prepareBoundary.bind(failedWorld);let preparedAttempts=0;
  failedWorld.prepareBoundary=(...args)=>{preparedAttempts++;return oldPrepare(...args);};
  const failedSupervisor=await factory(failedWorld,failed.registrations);ownFailed(failedSupervisor);
  const reference=pair(referenceWorld),referenceSupervisor=await factory(referenceWorld,reference.registrations);
  ownReference(referenceSupervisor);

  const firstAttempt=failedSupervisor.integrateBoundary();await waitFor(stageEntered.promise,'delayed stage did not start');
  assert.equal(failedWorld.inspect().plant.tick,0);assert.equal(failedWorld.lastBoundary(),null);
  const firstSample=only(failed.hinge.calls,'stage')[0].observation.samples[channel.id];
  assertSample(firstSample,oracle.trace[0]);
  await Promise.resolve();assert.equal(only(failed.slide.calls,'close').length,0,'do not close before slow stage settles');
  slowStage.resolve();await waitFor(closeEntered.promise,'client cleanup did not start after stage settlement');
  assert.equal(only(failed.slide.calls,'abort').length,1);
  const contender=pair(failedWorld);await assert.rejects(factory(failedWorld,contender.registrations));
  assert.deepEqual(contender.hinge.calls,[]);
  closeGate.resolve();await assert.rejects(firstAttempt);
  assert.equal(preparedAttempts,1);assert.equal(failedWorld.inspect().plant.tick,0);
  assert.equal(failedWorld.inspect().phase,'paused');assert.deepEqual(failedWorld.lastBoundary(),null);
  assert.deepEqual(failedWorld.readMeasurement().sample,firstSample);
  await failedSupervisor.dispose();

  const retry=pair(failedWorld),retrySupervisor=await factory(failedWorld,retry.registrations);ownFailed(retrySupervisor);
  const other=pair(referenceWorld);
  // Fresh initial runner clients on the reference world use the same scheduler seed.
  await referenceSupervisor.dispose();
  const referenceRetry=await factory(referenceWorld,other.registrations);ownReference(referenceRetry);
  for(let tick=0;tick<=4;tick++){
    await Promise.all([retrySupervisor.integrateBoundary(),referenceRetry.integrateBoundary()]);
    const a=only(retry.hinge.calls,'stage').find(row=>row.observation.tick===tick);
    const b=only(other.hinge.calls,'stage').find(row=>row.observation.tick===tick);
    if(a){
      assert.deepEqual(a.observation.samples,b.observation.samples);
      if(tick===0)assert.deepEqual(a.observation.samples[channel.id],firstSample);
      if(tick===4)assertSample(a.observation.samples[channel.id],oracle.trace[4]);
    }
  }
  assert.equal(preparedAttempts,6,'one prepare call for the failed attempt, then one for each retry/world tick');
  await retrySupervisor.dispose();await referenceRetry.dispose();
});

test('delayed ACK failure waits for every group, aborts without stepping, then closes clients',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world);
  const ackGate=deferred(),ackEntered=deferred(),closeEntered=deferred();
  const handles=pair(world,{hinge:{commit(){return Promise.reject(new Error('ACK failure'));}},
    slide:{commit(){ackEntered.resolve();return ackGate.promise.then(()=>({stageId:'slide:1:0'}));},
      close(){closeEntered.resolve();return Promise.resolve();}}});
  const supervisor=await factory(world,handles.registrations);own(supervisor);
  const operation=supervisor.integrateBoundary();await waitFor(ackEntered.promise,'delayed ACK did not start');
  assert.equal(world.inspect().phase,'committed');assert.equal(world.inspect().plant.tick,0);
  await assertWorldMutatorsBlocked(world);
  assert.equal(only(handles.hinge.calls,'close').length,0);
  ackGate.resolve();await waitFor(closeEntered.promise,'client cleanup did not start after ACK settlement');await assert.rejects(operation);
  assert.equal(world.inspect().plant.tick,0);assert.equal(world.inspect().phase,'faulted');
  assert.equal(world.lastBoundary().status,'aborted');
  assert.equal(only(handles.hinge.calls,'close').length,1);assert.equal(only(handles.slide.calls,'close').length,1);
  await supervisor.dispose();
});

test('measurement preparation failure starts no stages and releases owned clients after cleanup',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world);
  const handles=pair(world),supervisor=await factory(world,handles.registrations);own(supervisor);
  const prepare=world.prepareBoundary.bind(world);
  world.prepareBoundary=()=>{throw new Error('injected preparation failure');};
  await assert.rejects(supervisor.integrateBoundary());
  assert.equal(only(handles.hinge.calls,'stage').length,0);assert.equal(only(handles.slide.calls,'stage').length,0);
  assert.equal(only(handles.hinge.calls,'close').length,1);assert.equal(only(handles.slide.calls,'close').length,1);
  assert.equal(world.inspect().plant.tick,0);assert.equal(world.lastBoundary(),null);
  await supervisor.dispose();world.prepareBoundary=prepare;world.prepareBoundary();
  const afterFailure=pair(world);
  const receipt=await boundary.integrateControllerBoundary(world,c02Assignments(world.inspect(),afterFailure));
  assert.equal(receipt.status,'integrated');assert.equal(world.inspect().plant.tick,1);
});

test('world commit rejection aborts every staged client and never steps',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world);
  const handles=pair(world),supervisor=await factory(world,handles.registrations);own(supervisor);
  const commit=world.commitBoundary.bind(world);
  world.commitBoundary=()=>{throw new Error('injected world commit rejection');};
  await assert.rejects(supervisor.integrateBoundary());
  assert.equal(only(handles.hinge.calls,'stage').length,1);assert.equal(only(handles.slide.calls,'stage').length,1);
  assert.equal(only(handles.hinge.calls,'abort').length,1);assert.equal(only(handles.slide.calls,'abort').length,1);
  assert.equal(only(handles.hinge.calls,'close').length,1);assert.equal(only(handles.slide.calls,'close').length,1);
  assert.equal(world.inspect().plant.tick,0);assert.equal(world.inspect().phase,'paused');
  assert.equal(world.lastBoundary(),null);
  await supervisor.dispose();world.commitBoundary=commit;
});

test('reset between boundaries is allowed, then epoch drift invalidates before prepare or stage',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world);
  const handles=pair(world),supervisor=await factory(world,handles.registrations);own(supervisor);
  await supervisor.integrateBoundary();assert.equal(world.inspect().plant.tick,1);
  const prior=world.inspect().identity;world.reset();
  const after=world.inspect();assert.equal(after.identity.run_epoch,prior.run_epoch+1);assert.equal(after.plant.tick,0);
  const stagesBefore=only(handles.hinge.calls,'stage').length+only(handles.slide.calls,'stage').length;
  await assert.rejects(supervisor.integrateBoundary());
  assert.equal(only(handles.hinge.calls,'stage').length+only(handles.slide.calls,'stage').length,stagesBefore);
  assert.equal(world.readMeasurement(),null);assert.equal(world.inspect().plant.tick,0);
  assert.equal(only(handles.hinge.calls,'close').length,1);assert.equal(only(handles.slide.calls,'close').length,1);
  await supervisor.dispose();
});

test('identity and lease drift after initialization or before a boundary fail closed',async t=>{
  for(const mutation of ['epoch-after-init','lease-after-init','epoch-before-boundary','lease-before-boundary']){
    const world=await newWorld(),own=cleanupWorld(t,world);
    const inspect=world.inspect.bind(world);let altered=false;
    world.inspect=()=>{
      const view=inspect();if(!altered)return view;
      if(mutation.startsWith('epoch'))view.identity.run_epoch++;
      else view.commands.groups[0].lease.generation++;
      return view;
    };
    const hooks=mutation.endsWith('after-init')?{hinge:{initialize(){altered=true;return Promise.resolve();}}}:{};
    const handles=pair(world,hooks);
    if(mutation.endsWith('after-init')){
      await assert.rejects(factory(world,handles.registrations));
    }else{
      const supervisor=await factory(world,handles.registrations);own(supervisor);altered=true;
      await assert.rejects(supervisor.integrateBoundary());await supervisor.dispose();
    }
    assert.equal(world.readMeasurement(),null);assert.equal(world.inspect().plant.tick,0);
    assert.equal(only(handles.hinge.calls,'stage').length,0);assert.equal(only(handles.slide.calls,'stage').length,0);
    assert.equal(only(handles.hinge.calls,'close').length,1);assert.equal(only(handles.slide.calls,'close').length,1);
  }
});

test('prepared measurement identity, tick, and channel definition are checked before any stage',async t=>{
  for(const mismatch of ['epoch','tick','channel-hash']){
    const world=await newWorld(),own=cleanupWorld(t,world);
    const handles=pair(world),supervisor=await factory(world,handles.registrations);own(supervisor);
    const prepare=world.prepareBoundary.bind(world);
    world.prepareBoundary=()=>{
      const snapshot=prepare();
      if(mismatch==='epoch')snapshot.identity.run_epoch++;
      else if(mismatch==='tick')snapshot.observed_tick++;
      else snapshot.channel.definition_sha256='0'.repeat(64);
      return snapshot;
    };
    await assert.rejects(supervisor.integrateBoundary());
    assert.equal(only(handles.hinge.calls,'stage').length,0);assert.equal(only(handles.slide.calls,'stage').length,0);
    assert.equal(world.inspect().plant.tick,0);assert.equal(world.lastBoundary(),null);
    assert.equal(only(handles.hinge.calls,'close').length,1);assert.equal(only(handles.slide.calls,'close').length,1);
    await supervisor.dispose();
  }
});

test('fresh C1 clients cannot bind after a nonzero accepted world sequence',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world);
  const first=pair(world),supervisor=await factory(world,first.registrations);own(supervisor);
  await supervisor.integrateBoundary();assert.ok(world.inspect().commands.groups.every(group=>group.accepted_sequence>0));
  await supervisor.dispose();
  const fresh=pair(world);const before=world.inspect();
  await assert.rejects(factory(world,fresh.registrations));
  assert.deepEqual(fresh.hinge.calls,[]);assert.deepEqual(fresh.slide.calls,[]);
  assert.deepEqual(world.inspect(),before);assert.equal(world.readMeasurement(),null);
});

test('dispose drains an active boundary, closes clients once, and releases the reservation afterward',async t=>{
  const world=await newWorld(),own=cleanupWorld(t,world);
  const stageGate=deferred(),stageEntered=deferred(),closeGate=deferred(),closeEntered=deferred();
  const handles=pair(world,{hinge:{stage(){stageEntered.resolve();return stageGate.promise.then(()=>({stageId:'hinge:1:0',control:[2]}));},
    close(){closeEntered.resolve();return closeGate.promise;}}});
  const supervisor=await factory(world,handles.registrations);own(supervisor);
  const active=supervisor.integrateBoundary();await waitFor(stageEntered.promise,'active stage did not start');
  let disposeSettled=false;const disposing=supervisor.dispose().then(()=>{disposeSettled=true;});
  await assert.rejects(supervisor.integrateBoundary());
  assert.equal(only(handles.hinge.calls,'close').length,0);
  stageGate.resolve();await waitFor(closeEntered.promise,'client cleanup did not start after boundary completion');
  assert.equal(world.inspect().plant.tick,1,'active boundary settles before client cleanup');
  assert.equal(disposeSettled,false,'dispose waits for client close');
  const rival=pair(world);await assert.rejects(factory(world,rival.registrations));
  assert.deepEqual(rival.hinge.calls,[]);
  closeGate.resolve();await active;await disposing;await supervisor.dispose();
  assert.equal(only(handles.hinge.calls,'close').length,1);assert.equal(only(handles.slide.calls,'close').length,1);
  world.prepareBoundary();
  const receipt=await boundary.integrateControllerBoundary(world,[]); // reservation is released; tick 1 has no due group
  assert.equal(receipt.status,'integrated');assert.equal(world.inspect().plant.tick,2);
});

test('C02 operation fence blocks direct world mutation while a stage is pending',async t=>{
  const world=await newWorld({measured:false});cleanupWorld(t,world);
  const stageGate=deferred(),stageEntered=deferred();
  const handles={hinge:makeRunner('hinge',{stage(){stageEntered.resolve();return stageGate.promise.then(()=>({
    stageId:'hinge:1:0',control:[2]}));}}),slide:makeRunner('slide')};
  const operation=boundary.integrateControllerBoundary(world,c02Assignments(world.inspect(),handles));
  await waitFor(stageEntered.promise,'C02 stage did not start');await assertWorldMutatorsBlocked(world);
  stageGate.resolve();const receipt=await operation;
  assert.equal(receipt.status,'integrated');assert.equal(world.inspect().plant.tick,1);
});
