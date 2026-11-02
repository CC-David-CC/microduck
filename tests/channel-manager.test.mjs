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


const descriptor={id:'angle',kind:'truth',size:35,unit:'mixed',frame:null,definition_sha256:channelHash,source_ids:['model']};
function channelPolicy(label='active'){
 const p=policy();p.approvedRecordingGrants=[{project_revision:fixture(label).revision,group_id:'arm',channel_id:'angle',definition_sha256:channelHash,max_entries:64,channel:structuredClone(descriptor)}];return p;
}
function vectorReply(wire,ready,channel=descriptor){
 const {authority,attempt_token}=wire.recording;
 const rows=Array.from({length:wire.steps},(_,i)=>({observed_tick:i,sample:{validity:'valid',values:Array.from({length:35},(_,j)=>i+j/100),sequence:i+1,capture_tick:i,available_tick:i},outcome:'completed'}));
 return stepped(wire,ready,wire.steps,{measurement_batch:{request_id:wire.request_id,generation:wire.generation,command_sequence:wire.command_sequence,identity:ready.identity,start_tick:0,steps:wire.steps,attempt_token,authority,channel,rows}});
}
test('manager binds vector recording to trusted host policy and validates returned descriptor and samples',async()=>{
 const manager=create(channelPolicy());try{
  const a=await active(manager);const p=manager.stepMeasured({identity:a.ready.identity,steps:2,group_id:'arm',channel_id:'angle',definition_sha256:channelHash,attempt_token:'attempt'});
  const wire=(await getPost(a.worker,'step')).data;assert.equal(wire.recording.grant.purpose,'channel-recording');assert.deepEqual(wire.recording.grant.channel,descriptor);
  a.worker.emit(vectorReply(wire,a.ready));const result=await p;
  assert.deepEqual(result.measurement_channel,descriptor);assert.equal(result.measurement.entries.length,2);assert.equal(result.measurement.entries[1].sample.values[1],1.01);
 }finally{await manager.dispose();}
});
test('invalid channel host policy is rejected, including mismatched identity and excessive vector capacity',()=>{
 for(const change of [r=>r.channel.id='other',r=>r.channel.definition_sha256='d'.repeat(64),r=>r.channel.kind='command',r=>r.channel.size=65,r=>r.max_entries=256,r=>r.channel.extra=1]){
  const p=channelPolicy();change(p.approvedRecordingGrants[0]);assert.throws(()=>create(p),/recording/i);
 }
});
test('oversized vector batch is rejected before dispatch and a later valid batch uses the first sequence',async()=>{
 const manager=create(channelPolicy());try{
  const a=await active(manager),request={identity:a.ready.identity,steps:64,group_id:'arm',channel_id:'angle',definition_sha256:channelHash,attempt_token:'attempt'};
  await assert.rejects(manager.stepMeasured(request),/budget/i);assert.equal(a.worker.posts.filter(x=>x.data.kind==='step').length,0);
  const p=manager.stepMeasured({...request,steps:1});const wire=(await getPost(a.worker,'step')).data;assert.equal(wire.command_sequence,1);
  a.worker.emit(vectorReply(wire,a.ready));assert.equal((await p).steps_completed,1);
 }finally{await manager.dispose();}
});
test('worker descriptor substitution faults the world instead of returning mislabeled data',async()=>{
 const manager=create(channelPolicy());try{
  const a=await active(manager),p=manager.stepMeasured({identity:a.ready.identity,steps:1,group_id:'arm',channel_id:'angle',definition_sha256:channelHash,attempt_token:'attempt'}),rejected=assert.rejects(p);
  const wire=(await getPost(a.worker,'step')).data;a.worker.emit(vectorReply(wire,a.ready,{...descriptor,kind:'measurement'}));await rejected;await assertRetired(a.worker);
 }finally{await manager.dispose().catch(()=>{});}
});

test('recording authority is host-owned, snapshotted and cannot be supplied by the caller',async()=>{
 const options=channelPolicy(),manager=create(options);options.approvedRecordingGrants[0].channel.kind='measurement';
 try{const a=await active(manager),request={identity:a.ready.identity,steps:1,group_id:'arm',channel_id:'angle',definition_sha256:channelHash,attempt_token:'attempt'};
  await assert.rejects(manager.stepMeasured({...request,channel:descriptor}));
  await assert.rejects(manager.stepMeasured({...request,definition_sha256:'d'.repeat(64)}));
  assert.equal(a.worker.posts.filter(x=>x.data.kind==='step').length,0);
  const pending=manager.stepMeasured(request),wire=(await getPost(a.worker,'step')).data;assert.equal(wire.recording.grant.channel.kind,'truth');
  a.worker.emit(vectorReply(wire,a.ready));assert.equal((await pending).measurement_channel.kind,'truth');
 }finally{await manager.dispose();}
});
