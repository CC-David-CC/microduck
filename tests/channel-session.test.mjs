import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {registerHooks} from 'node:module';import {pathToFileURL} from 'node:url';
const source=`export class ResetFault extends Error{};export class InspectionFault extends Error{};export class OperationBusy extends Error{};export class StepFault extends Error{};export function createControlledProjectWorldManager(){return globalThis.__targetTestManager}`;registerHooks({resolve(specifier,context,next){if(specifier==='./project-world-manager.ts'&&context.parentURL?.endsWith('/session/browser-session.ts'))return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(source)};return next(specifier,context)}});
const impl=process.env.BRF_IMPL;if(!impl)throw Error('missing implementation');const {createBrowserSession}=await import(pathToFileURL(impl+'/src/session/browser-session.ts'));const h=b=>createHash('sha256').update(b).digest('hex'),enc=new TextEncoder();function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}}
function fixture(){const model=enc.encode('<mujoco/>'),manifest=enc.encode(JSON.stringify({schema_version:2,model:'m.xml',files:{'m.xml':{bytes:model.length,sha256:h(model)}}}));return {revision:h(manifest),entries:[{path:'manifest.json',data:manifest},{path:'m.xml',data:model}]}}
async function setup(recordingRows=[]){const f=fixture(),id={session_id:'session',project_revision:f.revision,run_epoch:0},calls=[],m={targetGate:null,stepGate:null,runGate:null,disposed:0,async stage(){return {}},async promote(){return {identity:id}},async setTarget(x){calls.push(structuredClone(x));if(this.targetGate)await this.targetGate.promise;return {status:'accepted',identity:id,group_id:x.group_id,field:x.field,value:x.value,lease_generation:1,tick:0}},async step(){if(this.stepGate)await this.stepGate.promise;return {identity:id}},async run(){if(this.runGate)await this.runGate.promise;return {identity:id}},async pause(){return {identity:id}},async dispose(){this.disposed++}};globalThis.__targetTestManager=m;const session=await createBrowserSession({runInput:{project_revision:f.revision,entries:f.entries,profile:{},controllers:[]},mount:{},runnerOrigin:'http://runner.invalid',frameURL:'http://runner.invalid/frame',policy:{inventoryLimits:{max_files:8,max_total_bytes:4096,max_file_bytes:2048,max_manifest_bytes:2048,max_manifest_depth:16},compileLimits:{},timeoutMs:1000,maxReplyBytes:1048576,frameTimeoutMs:500,approvedGrants:[],approvedRecordingGrants:recordingRows.map(r=>({...r,project_revision:f.revision}))}});return {session,m,calls,id}}

const choice={group_id:'arm',channel_id:'angle',definition_sha256:'c'.repeat(64)};
function configure(m,id){let tick=0;const calls=[];m.inspectActive=async()=>({identity:id,plant:{tick}});m.stepMeasured=async x=>{calls.push(structuredClone(x));const start=tick;tick+=x.steps;return {identity:id,steps_completed:x.steps,inspection:{identity:id,plant:{tick}},measurement:{authority:{...id,group_id:x.group_id,channel_id:x.channel_id,definition_sha256:x.definition_sha256,lease_generation:1},entries:Array.from({length:x.steps},(_,i)=>({observed_tick:start+i,sample:{validity:'missing',values:[],sequence:null,capture_tick:null,available_tick:null},outcome:'completed'})),sealed:false,complete:false}}};return calls}
const options=id=>({requested_ticks:3,batch_size:2,max_wall_ms:10000,configuration_evidence:{project_revision:id.project_revision,configuration_sha256:'a'.repeat(64),runtime_lock_sha256:'b'.repeat(64)},measurement:choice});
test('bounded attempt records every measured boundary with one host-owned token',async()=>{const {session,m,id}=await setup(),calls=configure(m,id);assert.equal(typeof session.startMeasuredAttempt,'function','measured attempt unavailable');const r=await session.startMeasuredAttempt(options(id)).result;assert.equal(r.status,'completed');assert.equal(r.measurement.complete,true);assert.deepEqual(r.measurement.entries.map(x=>x.observed_tick),[0,1,2]);assert.equal(calls.length,2);assert.ok(calls[0].attempt_token);assert.equal(calls[0].attempt_token,calls[1].attempt_token);assert.deepEqual(calls.map(x=>x.steps),[2,1]);await session.dispose()});
test('malformed or missing batch yields unknown and preserves only verified earlier entries',async()=>{const {session,m,id}=await setup();configure(m,id);assert.equal(typeof session.startMeasuredAttempt,'function');const original=m.stepMeasured;m.stepMeasured=async x=>{const result=await original(x);if(x.steps===1)delete result.measurement;return result};const r=await session.startMeasuredAttempt(options(id)).result;assert.equal(r.status,'unknown');assert.equal(r.measurement.complete,false);assert.deepEqual(r.measurement.entries.map(x=>x.observed_tick),[0,1]);await session.dispose()});
test('measurement scope and retention budget are validated before dispatch',async()=>{const {session,m,id}=await setup(),calls=configure(m,id);assert.equal(typeof session.startMeasuredAttempt,'function');assert.throws(()=>session.startMeasuredAttempt({...options(id),requested_ticks:257}));assert.throws(()=>session.startMeasuredAttempt({...options(id),measurement:{...choice,extra:true}}));assert.equal(calls.length,0);await session.dispose()});

test('measured attempt fences commands and cancellation drains the in-flight batch',async()=>{const {session,m,id}=await setup();configure(m,id);const gate=deferred(),original=m.stepMeasured;m.stepMeasured=async x=>{await gate.promise;return original(x)};const attempt=session.startMeasuredAttempt(options(id));while(!session.state)await Promise.resolve();await assert.rejects(session.submit({...id,kind:'step',steps:1}));const stopped=attempt.cancel();gate.resolve();const r=await attempt.result;await stopped;assert.equal(r.status,'cancelled');assert.equal(r.last_verified_tick,2);assert.equal(r.measurement.complete,false);assert.equal(r.measurement.entries.length,2);await session.dispose()});

test('a busy measured attempt explicitly returns an incomplete empty record',async()=>{const {session,m,id}=await setup();configure(m,id);const lease=await session.acquireAttempt();const result=await session.startMeasuredAttempt(options(id)).result;assert.equal(result.status,'failed');assert.equal(result.measurement.complete,false);assert.deepEqual(result.measurement.entries,[]);await lease.finish();await session.dispose()});

const descriptor={id:'angle',kind:'truth',size:35,unit:'mixed',frame:null,definition_sha256:'c'.repeat(64),source_ids:['model']};
const vectorGrant=()=>({...choice,max_entries:64,channel:structuredClone(descriptor)});
function vectorManager(m,id){
 let tick=0;const calls=[];m.inspectActive=async()=>({identity:id,plant:{tick}});
 m.stepMeasured=async x=>{calls.push(structuredClone(x));const start=tick;tick+=x.steps;return {identity:id,steps_completed:x.steps,inspection:{identity:id,plant:{tick}},measurement_channel:structuredClone(descriptor),measurement:{authority:{...id,...choice,lease_generation:1},entries:Array.from({length:x.steps},(_,i)=>({observed_tick:start+i,sample:{validity:'valid',values:Array.from({length:35},(_,j)=>start+i+j/100),sequence:start+i+1,capture_tick:start+i,available_tick:start+i},outcome:'completed'})),sealed:false,complete:false}}};return calls;
}
test('session carries host-approved truth descriptor and records all samples across bounded batches',async()=>{
 const grant=vectorGrant(),{session,m,id}=await setup([grant]);grant.channel.kind='estimate';
 try{assert.deepEqual(session.recordingChannels[0].channel,descriptor);assert.ok(Object.isFrozen(session.recordingChannels[0].channel));
  const calls=vectorManager(m,id),result=await session.startMeasuredAttempt({...options(id),requested_ticks:100,batch_size:64}).result;
  assert.equal(result.status,'completed');assert.deepEqual(result.measurement.channel,descriptor);assert.equal(result.measurement.complete,true);
  assert.equal(result.measurement.entries.length,100);assert.deepEqual(result.measurement.entries.map(x=>x.observed_tick),Array.from({length:100},(_,i)=>i));
  assert.equal(result.measurement.entries[99].sample.values[1],99.01);assert.ok(calls.length>1);assert.ok(calls.every(x=>x.steps<64));assert.equal(new Set(calls.map(x=>x.attempt_token)).size,1);
 }finally{await session.dispose()}
});
test('changed descriptor in a later batch leaves only verified data and an incomplete outcome',async()=>{
 const {session,m,id}=await setup([vectorGrant()]);try{const calls=vectorManager(m,id),original=m.stepMeasured;
  m.stepMeasured=async x=>{const r=await original(x);if(calls.length===2)r.measurement_channel.kind='estimate';return r};
  const r=await session.startMeasuredAttempt({...options(id),requested_ticks:3,batch_size:2}).result;
  assert.equal(r.status,'unknown');assert.equal(r.measurement.complete,false);assert.deepEqual(r.measurement.channel,descriptor);assert.deepEqual(r.measurement.entries.map(x=>x.observed_tick),[0,1]);
 }finally{await session.dispose()}
});
test('session rejects malformed, mismatched and excessive trusted channel policies',async()=>{
 for(const change of [r=>r.channel.id='other',r=>r.channel.kind='command',r=>r.channel.size=65,r=>r.max_entries=256,r=>r.channel.extra=true]){const grant=vectorGrant();change(grant);await assert.rejects(setup([grant]),/recording/i)}
});

test('cancelling a vector attempt drains the in-flight batch and keeps an explicitly incomplete prefix',async()=>{
 const grant=vectorGrant();grant.max_entries=4;const {session,m,id}=await setup([grant]);try{
  const calls=vectorManager(m,id),original=m.stepMeasured,entered=deferred(),gate=deferred();
  m.stepMeasured=async x=>{entered.resolve();await gate.promise;return original(x)};
  const attempt=session.startMeasuredAttempt({...options(id),requested_ticks:10,batch_size:8});await entered.promise;
  const cancelled=attempt.cancel();gate.resolve();const result=await attempt.result;await cancelled;
  assert.equal(result.status,'cancelled');assert.equal(result.last_verified_tick,4);assert.equal(result.measurement.complete,false);
  assert.deepEqual(result.measurement.channel,descriptor);assert.deepEqual(result.measurement.entries.map(x=>x.observed_tick),[0,1,2,3]);assert.deepEqual(calls.map(x=>x.steps),[4]);
 }finally{await session.dispose()}
});
