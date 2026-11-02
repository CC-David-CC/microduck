import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {registerHooks} from 'node:module';
import {MessageChannel, MessagePort} from 'node:worker_threads';

// Test-only module hook preserves the production static import; no caller can
// inject a runner factory into the real manager.
registerHooks({resolve(specifier,context,next){
 if(specifier.endsWith('/isolation/runner-host.ts')) return {shortCircuit:true,
  url:'data:text/javascript,export function openRunnerFrame(args){return globalThis.__testControlledOpen(args)}'};
 return next(specifier,context);
}});
const moduleUnderTest=await import('../foundation/implementation/src/session/project-world-manager.ts');
const inventoryLimits={max_files:8,max_total_bytes:1048576,max_file_bytes:1048576,max_manifest_bytes:65536,max_manifest_depth:16};
const compileLimits={closure:{max_files:8,max_total_bytes:1048576,max_references:64,max_include_depth:8,
 scan:{max_xml_bytes:1048576,max_depth:64,max_elements:10000,max_attributes_per_element:64,max_attribute_utf16:8192,max_references:64}},
 assets:{max_obj_bytes:65536,max_obj_line_bytes:8192,max_obj_vertices:1000,max_obj_faces:1000,max_obj_triangles:1000,max_obj_abs_coordinate:1000,
 max_png_bytes:65536,max_png_width:128,max_png_height:128,max_png_pixels:16384,max_png_decoded_bytes:50000,max_png_chunks:128},audit:{max_records:4096,max_bytes:1048576}};
const encoder=new TextEncoder(),digest=data=>createHash('sha256').update(data).digest('hex');
const channelHash='c'.repeat(64);
const input=(name,unit)=>({actuator_name:name,component:0,unit,semantic:'fixture input',input_range:null});
function fixture(label='one'){
 const model=encoder.encode('<mujoco model="'+label+'"/>');
 const source=encoder.encode('export function initialize(){}\nexport function step(){}\nexport function dispose(){}\n');
 const files={'model.xml':{bytes:model.length,sha256:digest(model)},'controllers/main.mjs':{bytes:source.length,sha256:digest(source)}};
 const manifest=encoder.encode(JSON.stringify({schema_version:2,model:'model.xml',files,label}));
 return {entries:[{path:'model.xml',data:model},{path:'controllers/main.mjs',data:source},{path:'manifest.json',data:manifest}],
  profile:{blocks:[{actuator_name:'a',engine_indices:[0],validation_rule_id:'independent-scalar-ranges',inputs:[input('a','N')]},
   {actuator_name:'b',engine_indices:[1],validation_rule_id:'independent-scalar-ranges',inputs:[input('b','N')]}],
   groups:[{group_id:'arm',control_stride:1,actuator_names:['a']},{group_id:'base',control_stride:1,actuator_names:['b']}]},
  controllers:[{group_id:'arm',source_path:'controllers/main.mjs',parameters:{gain:1},intent:{},grants:[{channel_id:'angle',definition_sha256:channelHash}]},
   {group_id:'base',source_path:'controllers/main.mjs',parameters:{gain:1},intent:{},grants:[]}],revision:digest(manifest)};
}
function policy(timeoutMs=1500){return {inventoryLimits:structuredClone(inventoryLimits),compileLimits:structuredClone(compileLimits),
 timeoutMs,maxReplyBytes:1048576,mount:{},runnerOrigin:'http://runner.invalid',frameURL:'http://runner.invalid/frame',frameTimeoutMs:500,
 approvedGrants:[{group_id:'arm',channel_id:'angle',definition_sha256:channelHash}]};}
function create(options=policy()){
 assert.equal(typeof moduleUnderTest.createControlledProjectWorldManager,'function','controlled manager must exist');
 return moduleUnderTest.createControlledProjectWorldManager(options);
}
class FakeWorker{
 static instances=[];
 constructor(url,options){this.url=url;this.options=options;this.posts=[];this.terminated=0;this.listeners=new Map();FakeWorker.instances.push(this);}
 addEventListener(name,fn){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(fn);}
 removeEventListener(name,fn){this.listeners.get(name)?.delete(fn);}
 postMessage(data,transfer=[]){if(this.failTransfer && transfer.length)throw Error('injected port transfer failure');this.posts.push({data,transfer});if(data.kind==='dispose')queueMicrotask(()=>this.emit({kind:'disposed',request_id:data.request_id,generation:data.generation,identity:data.identity}));}
 terminate(){this.terminated++;}
 emit(data){for(const fn of this.listeners.get('message')||[])fn({data});}
}
const savedWorker=globalThis.Worker,savedOpen=globalThis.__testControlledOpen;
let owners,openHandler;
test.beforeEach(()=>{FakeWorker.instances=[];owners=[];openHandler=async()=>newOwner();globalThis.Worker=FakeWorker;globalThis.__testControlledOpen=args=>openHandler(args);});
test.afterEach(()=>{for(const owner of owners)owner.forceClose();if(savedWorker===undefined)delete globalThis.Worker;else globalThis.Worker=savedWorker;if(savedOpen===undefined)delete globalThis.__testControlledOpen;else globalThis.__testControlledOpen=savedOpen;});
function newOwner(){const d=new MessageChannel(),l=new MessageChannel();let closed=0;const value={dataPort:d.port1,lifecyclePort:l.port1,
 async close(){closed++;d.port1.close();d.port2.close();l.port1.close();l.port2.close();},
 forceClose(){d.port1.close();d.port2.close();l.port1.close();l.port2.close();},get closeCount(){return closed;}};owners.push(value);return value;}
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};}
function observed(p){let settled=false;void p.then(()=>settled=true,()=>settled=true);return ()=>settled;}
async function waitFor(fn,what){for(let i=0;i<1000;i++){const value=fn();if(value)return value;await delay(1);}assert.fail('timed out waiting for '+what);}
async function getWorker(index){return waitFor(()=>FakeWorker.instances[index],'worker');}
async function getPost(w,kind,count=0){return waitFor(()=>w.posts.filter(p=>p.data.kind===kind)[count],'worker '+kind);}
function fakeReady(request,revision,session='s'){
 const identity={session_id:session,project_revision:revision,run_epoch:0};
 const groups=request.profile.groups.map(g=>({lease:{group_id:g.group_id,owner_id:g.owner_id,generation:1,control_stride:g.control_stride},accepted_sequence:0,last_control_tick:null,fresh_at_tick:null}));
 const inspection={identity,phase:'paused',plant:{tick:0,time:0,qpos:[],qvel:[],activation:[],control:[0,0],actuator_force:[],sensors:[]},
 commands:{identity,control:[0,0],groups},due_group_ids:groups.map(g=>g.lease.group_id),fault:null};
 const model=request.entries.find(x=>x.path==='model.xml');const hash=digest(model.data),path='/brf-project/model.xml';
 const audit={project_revision:revision,entry_path:'model.xml',closure_paths:['model.xml'],staged_files:[{project_path:'model.xml',engine_path:path,bytes:model.data.length,sha256:hash}],
 staging_attempts:[{project_path:'model.xml',outcome:'present'}],lookups:[{sequence:1,operation:'open',engine_path:path,project_path:'model.xml',sha256:hash,outcome:'present'}],
 model_facts:{version:'3.17.0',ngeom:0,nmesh:0,nmat:0,ntex:0,texture_width:[],texture_height:[]}};
 return {kind:'ready',request_id:request.request_id,generation:request.generation,identity,phase:'paused',audit,inspection};
}
function need(ready){return {...ready,kind:'need-runners',group_ids:ready.inspection.commands.groups.map(g=>g.lease.group_id)};}
async function begin(manager,input,index=0,session='s'){
 const promise=manager.stage({entries:input.entries,profile:input.profile,controllers:input.controllers});promise.catch(()=>{});
 const worker=await getWorker(index),stage=(await getPost(worker,'stage')).data,ready=fakeReady(stage,input.revision,session);
 return {promise,worker,stage,ready};
}
async function promote(manager,handle,worker,ready){
 const previous=worker.posts.filter(p=>p.data.kind==='inspect').length;
 const pending=manager.promote(handle);pending.catch(()=>{});const request=(await getPost(worker,'inspect',previous)).data;
 worker.emit({kind:'inspection',request_id:request.request_id,generation:request.generation,inspection:ready.inspection});
 return pending;
}
async function completeStage(manager,input,index=0,session='s'){
 const x=await begin(manager,input,index,session);x.worker.emit(need(x.ready));await getPost(x.worker,'bind-runners');x.worker.emit(x.ready);
 return {...x,handle:await x.promise};
}
async function inspect(manager,worker,ready){const count=worker.posts.filter(p=>p.data.kind==='inspect').length;const p=manager.inspectActive();
 const req=(await getPost(worker,'inspect',count)).data;worker.emit({kind:'inspection',request_id:req.request_id,generation:req.generation,inspection:ready.inspection});return p;}

function requireStep(manager){assert.equal(typeof manager.step,'function','controlled manager must expose step');}
function atTick(ready,tick){
 const view=structuredClone(ready.inspection);view.plant.tick=tick;view.plant.time=tick*0.01;
 for(const group of view.commands.groups){group.accepted_sequence=tick;group.last_control_tick=tick?tick-1:null;group.fresh_at_tick=null;}
 return view;
}
function stepped(request,ready,tick,changes={}){return {kind:'stepped',request_id:request.request_id,generation:request.generation,
 identity:structuredClone(ready.identity),command_sequence:request.command_sequence,steps_completed:request.steps,
 inspection:atTick(ready,tick),...changes};}
async function active(manager,label='active',index=0,session='active'){
 const x=await completeStage(manager,fixture(label),index,session);await promote(manager,x.handle,x.worker,x.ready);return x;
}
async function assertRetired(worker){await waitFor(()=>worker.terminated===1&&owners.every(owner=>owner.closeCount===1),'worker and owner retirement');}

test('step mints correlated monotone commands and reports exact one- and multi-boundary advances',async()=>{
 const manager=create();requireStep(manager);try{
  const a=await active(manager),identity=structuredClone(a.ready.identity);
  const one=manager.step({identity,steps:1}),wire1=(await getPost(a.worker,'step',0)).data;
  assert.deepEqual(Object.keys(wire1).sort(),['command_sequence','generation','identity','kind','request_id','steps']);
  assert.equal(wire1.kind,'step');assert.equal(wire1.generation,a.stage.generation);assert.deepEqual(wire1.identity,identity);
  assert.equal(wire1.command_sequence,1);assert.equal(wire1.steps,1);
  assert.match(wire1.request_id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  a.worker.emit(stepped(wire1,a.ready,1));const first=await one;
  assert.deepEqual(first.identity,identity);assert.equal(first.steps_completed,1);assert.equal(first.inspection.plant.tick,1);
  const many=manager.step({identity,steps:3}),wire2=(await getPost(a.worker,'step',1)).data;
  assert.equal(wire2.command_sequence,2);assert.notEqual(wire1.request_id,wire2.request_id);assert.equal(wire2.steps,3);
  a.worker.emit(stepped(wire2,a.ready,4));const second=await many;
  assert.deepEqual(second.identity,identity);assert.equal(second.steps_completed,3);assert.equal(second.inspection.plant.tick,4);
 }finally{await manager.dispose();}
});

test('invalid step shape, bounds and old identity reject before dispatch without invoking getters',async()=>{
 const manager=create();requireStep(manager);try{
  const a=await active(manager),identity=structuredClone(a.ready.identity),badIdentity={...identity,run_epoch:identity.run_epoch+1};let calls=0;
  const accessor={identity,steps:1};Object.defineProperty(accessor,'steps',{enumerable:true,get(){calls++;return 1;}});
  for(const input of [{identity:badIdentity,steps:1},{identity:{...identity,session_id:'forged'},steps:1},
   {identity:{...identity,project_revision:'0'.repeat(64)},steps:1},{identity,steps:0},{identity,steps:65},
   {identity,steps:-1},{identity,steps:1.5},{identity,steps:NaN},{identity,steps:1,extra:1},accessor]){
   await assert.rejects(Promise.resolve().then(()=>manager.step(input)));
  }
  assert.equal(calls,0);assert.equal(a.worker.posts.filter(x=>x.data.kind==='step').length,0);assert.equal(a.worker.terminated,0);
 }finally{await manager.dispose();}
});

test('step serializes against inspect, other steps and candidate promotion',async()=>{
 const manager=create();requireStep(manager);try{
  const a=await active(manager),candidate=await completeStage(manager,fixture('next'),1,'next');
  const action=manager.step({identity:a.ready.identity,steps:1}),wire=(await getPost(a.worker,'step')).data;
  await assert.rejects(manager.step({identity:a.ready.identity,steps:1}));await assert.rejects(manager.inspectActive());
  await assert.rejects(manager.promote(candidate.handle));assert.equal(candidate.worker.posts.filter(x=>x.data.kind==='inspect').length,0);
  a.worker.emit(stepped(wire,a.ready,1));await action;
  const promotion=manager.promote(candidate.handle);const challenge=(await getPost(candidate.worker,'inspect')).data;
  await assert.rejects(manager.step({identity:a.ready.identity,steps:1}));
  candidate.worker.emit({kind:'inspection',request_id:challenge.request_id,generation:challenge.generation,inspection:candidate.ready.inspection});
  await promotion;await assert.rejects(manager.step({identity:a.ready.identity,steps:1}));
 }finally{await manager.dispose();}
});

test('concurrent inspection prevents step before any command dispatch',async()=>{
 const manager=create();requireStep(manager);try{
  const a=await active(manager),count=a.worker.posts.filter(p=>p.data.kind==='inspect').length;
  const inspecting=manager.inspectActive(),req=(await getPost(a.worker,'inspect',count)).data;
  await assert.rejects(manager.step({identity:a.ready.identity,steps:1}));
  assert.equal(a.worker.posts.filter(x=>x.data.kind==='step').length,0);
  a.worker.emit({kind:'inspection',request_id:req.request_id,generation:req.generation,inspection:a.ready.inspection});await inspecting;
 }finally{await manager.dispose();}
});

test('wrong correlation, identity, count, sequence or tick faults the controlled active world',async()=>{
 assert.equal(typeof create().step,'function','controlled manager must expose step');
 for(const mode of ['id','generation','identity','sequence','completed','tick','kind','oversize']){
  FakeWorker.instances=[];owners=[];const manager=create(policy(500));try{
   const a=await active(manager,mode,0,mode),p=manager.step({identity:a.ready.identity,steps:1});const rejected=assert.rejects(p);
   const wire=(await getPost(a.worker,'step')).data;let reply=stepped(wire,a.ready,1);
   if(mode==='id')reply.request_id='forged';if(mode==='generation')reply.generation++;
   if(mode==='identity')reply.identity={...reply.identity,run_epoch:1};if(mode==='sequence')reply.command_sequence++;
   if(mode==='completed')reply.steps_completed=0;if(mode==='tick')reply.inspection=atTick(a.ready,2);
   if(mode==='kind')reply.kind='not-stepped';if(mode==='oversize')reply.padding='x'.repeat(1048577);
   a.worker.emit(reply);await rejected;await assertRetired(a.worker);await assert.rejects(manager.inspectActive());
   await assert.rejects(manager.step({identity:a.ready.identity,steps:1}));
  }finally{await manager.dispose().catch(()=>{});}
 }
});

test('step timeout faults and retires the active world; a late reply cannot resurrect it',async()=>{
 const manager=create(policy(70));requireStep(manager);try{
  const a=await active(manager),p=manager.step({identity:a.ready.identity,steps:1}),rejected=assert.rejects(p);
  const wire=(await getPost(a.worker,'step')).data;await rejected;await assertRetired(a.worker);
  a.worker.emit(stepped(wire,a.ready,1));await assert.rejects(manager.inspectActive());
  await assert.rejects(manager.step({identity:a.ready.identity,steps:1}));
 }finally{await manager.dispose().catch(()=>{});}
});

test('duplicate stepped reply faults the active world rather than applying a result twice',async()=>{
 const manager=create();requireStep(manager);try{
  const a=await active(manager),p=manager.step({identity:a.ready.identity,steps:1});const wire=(await getPost(a.worker,'step')).data;
  const reply=stepped(wire,a.ready,1);a.worker.emit(reply);await p;a.worker.emit(reply);
  await assertRetired(a.worker);await assert.rejects(manager.inspectActive());
 }finally{await manager.dispose().catch(()=>{});}
});

test('disposal drains a pending step and rejects a late duplicate result',async()=>{
 const manager=create();requireStep(manager);try{
  const a=await active(manager),p=manager.step({identity:a.ready.identity,steps:1});
  const wire=(await getPost(a.worker,'step')).data,disposal=manager.dispose();assert.equal(a.worker.terminated,0);
  a.worker.emit(stepped(wire,a.ready,1));await p;await disposal;assert.equal(a.worker.terminated,1);
  a.worker.emit(stepped(wire,a.ready,1));await assert.rejects(manager.inspectActive());
 }finally{await manager.dispose().catch(()=>{});}
});

test('a correlated Worker step error reports confirmed completed count and retires the session',async()=>{
 const manager=create();requireStep(manager);try{
  const a=await active(manager),p=manager.step({identity:a.ready.identity,steps:3});
  const rejected=assert.rejects(p,error=>{assert.equal(error.steps_completed,1);return true;});
  const wire=(await getPost(a.worker,'step')).data;
  a.worker.emit({kind:'step-error',request_id:wire.request_id,generation:wire.generation,
   identity:structuredClone(a.ready.identity),command_sequence:wire.command_sequence,steps_completed:1,error:'controller fault'});
  await rejected;await assertRetired(a.worker);await assert.rejects(manager.inspectActive());
 }finally{await manager.dispose().catch(()=>{});}
});

test('a forged Worker step error cannot assert a trusted completed count',async()=>{
 const manager=create();requireStep(manager);try{
  const a=await active(manager),p=manager.step({identity:a.ready.identity,steps:3});
  const rejected=assert.rejects(p,error=>{assert.notEqual(error.steps_completed,2);return true;});
  const wire=(await getPost(a.worker,'step')).data;
  a.worker.emit({kind:'step-error',request_id:'forged',generation:wire.generation,
   identity:structuredClone(a.ready.identity),command_sequence:wire.command_sequence,steps_completed:2,error:'controller fault'});
  await rejected;await assertRetired(a.worker);
 }finally{await manager.dispose().catch(()=>{});}
});

function measuredPolicy(){const f=fixture('active');return {...policy(),approvedRecordingGrants:[{project_revision:f.revision,group_id:'arm',channel_id:'angle',definition_sha256:channelHash,max_entries:8}]};}
function measuredInput(identity){return {identity,steps:2,group_id:'arm',channel_id:'angle',definition_sha256:channelHash,attempt_token:'attempt'};}
function measuredReply(req,ready){const authority=req.recording.authority,sample={validity:'missing',values:[],sequence:null,capture_tick:null,available_tick:null};return {request_id:req.request_id,generation:req.generation,command_sequence:req.command_sequence,identity:req.identity,start_tick:0,steps:2,attempt_token:req.recording.attempt_token,authority,rows:[0,1].map(observed_tick=>({observed_tick,sample,outcome:'completed'}))};}
test('trusted recording policy creates a correlated measured step',async()=>{
 const baseline=create();try{assert.equal(typeof baseline.stepMeasured,'function','manager has no measured step');}finally{await baseline.dispose()}
 const manager=create(measuredPolicy());try{const a=await active(manager),pending=manager.stepMeasured(measuredInput(a.ready.identity)),req=(await getPost(a.worker,'step')).data;
 assert.equal(req.recording.grant.purpose,'measurement-recording');assert.equal(req.recording.authority.lease_generation,1);assert.equal(req.recording.authority.project_revision,a.ready.identity.project_revision);
 a.worker.emit(stepped(req,a.ready,2,{measurement_batch:measuredReply(req,a.ready)}));const result=await pending;assert.equal(result.inspection.plant.tick,2);assert.equal(result.measurement.entries.length,2);assert.equal(result.measurement.sealed,false);
 }finally{await manager.dispose()}
});
test('controller grant alone never authorizes recording',async()=>{const manager=create();try{const a=await active(manager);await assert.rejects(manager.stepMeasured(measuredInput(a.ready.identity)));assert.equal(a.worker.posts.filter(p=>p.data.kind==='step').length,0)}finally{await manager.dispose()}});
test('unsolicited measurement on an ordinary step faults instead of publishing',async()=>{const manager=create();try{const a=await active(manager),p=manager.step({identity:a.ready.identity,steps:1}),rejected=assert.rejects(p),req=(await getPost(a.worker,'step')).data;a.worker.emit(stepped(req,a.ready,1,{measurement_batch:{}}));await rejected;await assertRetired(a.worker)}finally{await manager.dispose()}});
test('a wrong measured batch faults and does not publish a result',async()=>{const manager=create(measuredPolicy());try{const a=await active(manager),p=manager.stepMeasured(measuredInput(a.ready.identity)),rejected=assert.rejects(p),req=(await getPost(a.worker,'step')).data,batch=measuredReply(req,a.ready);batch.attempt_token='wrong';a.worker.emit(stepped(req,a.ready,2,{measurement_batch:batch}));await rejected;await assertRetired(a.worker)}finally{await manager.dispose()}});
test('measured step error reports an unknown, incomplete measurement outcome',async()=>{const manager=create(measuredPolicy());try{const a=await active(manager),p=manager.stepMeasured(measuredInput(a.ready.identity)),req=(await getPost(a.worker,'step')).data;const failure={kind:'step-error',request_id:req.request_id,generation:req.generation,identity:req.identity,command_sequence:req.command_sequence,steps_completed:1,error:'failed',measurement_batch:{}};a.worker.emit(failure);await assert.rejects(p,e=>e.outcome_unknown===true&&e.measurement_incomplete===true);await assertRetired(a.worker)}finally{await manager.dispose()}});

test('malformed measured reply marks the measurement incomplete and outcome unknown',async()=>{const manager=create(measuredPolicy());try{const a=await active(manager),p=manager.stepMeasured(measuredInput(a.ready.identity)),rejected=assert.rejects(p,e=>e.outcome_unknown===true&&e.measurement_incomplete===true),req=(await getPost(a.worker,'step')).data,batch=measuredReply(req,a.ready);batch.attempt_token='wrong';a.worker.emit(stepped(req,a.ready,2,{measurement_batch:batch}));await rejected;await assertRetired(a.worker)}finally{await manager.dispose()}});
