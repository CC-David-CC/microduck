import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {MessageChannel} from 'node:worker_threads';import {setTimeout as delay} from 'node:timers/promises';
import {validateChannelStepResponse} from '../foundation/implementation/src/experiments/measured-step-response.ts';
const path=process.env.MICRODUCK_BUILTIN_PROJECT;if(!path)throw Error('MICRODUCK_BUILTIN_PROJECT required');
const fixture=JSON.parse(await readFile(path)),profile=JSON.parse(await readFile(new URL('../microduck-profile.json',import.meta.url)));
const report=JSON.parse((await promisify(execFile)(process.execPath,[new URL('../tools/inspect-builtin-channel.mjs',import.meta.url).pathname],{env:process.env})).stdout);
let serial=0;
async function until(fn){const deadline=Date.now()+10000;while(!fn()&&Date.now()<deadline)await delay(5);assert.ok(fn(),'expected worker message');return fn()}
function peer(failTick=null){const data=new MessageChannel(),life=new MessageChannel(),seen=[];
 data.port2.onmessage=e=>{const m=e.data;if(m.kind==='initialize')data.port2.postMessage({kind:'initialized',request_id:m.request_id});
  else if(m.kind==='dispose')data.port2.postMessage({kind:'disposed',request_id:m.request_id});
  else if(m.kind==='stage'){seen.push(structuredClone(m));if(m.authority.observed_tick===failTick)data.port2.postMessage({kind:'error',request_id:m.request_id,code:'CONTROLLER_FAULT'});else data.port2.postMessage({kind:'stage',request_id:m.request_id,stageId:m.stageId,authority:m.authority,control:Array(14).fill(0)});}
  else if(m.kind==='commit')data.port2.postMessage({kind:'committed',request_id:m.request_id,stageId:m.stageId,authority:m.authority});};data.port2.start();
 life.port2.onmessage=e=>{const m=e.data;if(m.kind==='terminate')life.port2.postMessage({version:1,kind:'termination-requested',request_id:m.request_id})};life.port2.start();
 return {row:{group_id:'all',dataPort:data.port1,lifecyclePort:life.port1},seen,close(){data.port1.close();data.port2.close();life.port1.close();life.port2.close()}};
}
async function start(t,failTick=null){const previous=globalThis.self,received=[];let listener;
 globalThis.self={postMessage(v){received.push(structuredClone(v))},close(){},addEventListener(kind,fn){if(kind==='message')listener=fn}};
 await import(new URL('../foundation/implementation/src/session/project-world-worker.ts?channel-worker='+serial++,import.meta.url));
 const emit=data=>listener({data,ports:[]}),p=peer(failTick);t.after(()=>{p.close();globalThis.self=previous});
 const entries=fixture.files.map(x=>({path:x.path,data:Uint8Array.from(Buffer.from(x.data_base64,'base64'))}));
 const worldProfile=structuredClone(profile.profile);worldProfile.groups[0].owner_id='worker-test-owner';
 const msg={kind:'stage',request_id:'stage',generation:3,entries,profile:worldProfile,controllers:profile.controllers,inventoryLimits:profile.policy.inventoryLimits,compileLimits:profile.policy.compileLimits,maxReplyBytes:1048576,runnerTimeoutMs:3000};
 emit(msg);await until(()=>received.find(x=>x.kind==='need-runners'||x.kind==='error'));assert.equal(received.at(-1).kind,'need-runners',JSON.stringify(received.at(-1)));
 emit({kind:'bind-runners',request_id:'stage',generation:3,ports:[p.row]});const ready=await until(()=>received.find(x=>x.kind==='ready'||x.kind==='error'));assert.equal(ready.kind,'ready',JSON.stringify(ready));
 const authority={...ready.identity,group_id:'all',lease_generation:ready.inspection.commands.groups[0].lease.generation,channel_id:report.channel.id,definition_sha256:report.channel.definition_sha256};
 const grant={purpose:'channel-recording',authority,channel:report.channel,max_entries:64};
 t.after(async()=>{emit({kind:'dispose',request_id:'cleanup',generation:3,identity:ready.identity});await delay(50)});
 return {emit,received,p,ready,authority,grant};
}
const step=(s,id,count,grant=s.grant)=>({kind:'step',request_id:id,generation:3,identity:s.ready.identity,command_sequence:1,steps:count,recording:{authority:s.authority,grant,attempt_token:'attempt'}});
test('worker returns a correlated vector batch with the actual channel descriptor',async t=>{
 const s=await start(t);s.emit(step(s,'vector',8));const result=await until(()=>s.received.find(x=>x.request_id==='vector'&&(x.kind==='stepped'||x.kind==='step-error')));
 assert.equal(result.kind,'stepped',JSON.stringify(result));assert.equal(result.inspection.plant.tick,8);
 const expected={request_id:'vector',generation:3,command_sequence:1,identity:s.ready.identity,start_tick:0,steps:8,attempt_token:'attempt',authority:s.authority};
 const validated=validateChannelStepResponse(expected,s.grant,result.measurement_batch);assert.deepEqual(validated.channel,report.channel);assert.equal(validated.log.entries.length,8);
 assert.deepEqual(validated.log.entries.map(x=>x.observed_tick),[0,1,2,3,4,5,6,7]);assert.equal(s.p.seen.length,2);
 for(const m of s.p.seen)assert.deepEqual(validated.log.entries[m.authority.observed_tick].sample,m.observation.samples['microduck.truth']);
});
test('mismatched and oversized vector requests are denied before any physical step',async t=>{
 const s=await start(t),bad=structuredClone(s.grant);bad.channel.kind='measurement';s.emit(step(s,'bad',1,bad));
 const rejected=await until(()=>s.received.find(x=>x.request_id==='bad'));assert.equal(rejected.kind,'step-error');assert.equal(rejected.steps_completed,0);assert.equal(s.p.seen.length,0);
 s.emit(step(s,'oversize',64));const large=await until(()=>s.received.find(x=>x.request_id==='oversize'));assert.equal(large.kind,'step-error');assert.equal(large.steps_completed,0);assert.equal(s.p.seen.length,0);
 s.emit(step(s,'valid',1));const valid=await until(()=>s.received.find(x=>x.request_id==='valid'));assert.equal(valid.kind,'stepped');assert.equal(valid.inspection.plant.tick,1);
});

test('a failed worker batch reports its confirmed prefix and unknown boundary',async t=>{
 const s=await start(t,4);s.emit(step(s,'failure',8));
 const result=await until(()=>s.received.find(x=>x.request_id==='failure'&&(x.kind==='stepped'||x.kind==='step-error')));
 assert.equal(result.kind,'step-error');assert.equal(result.steps_completed,4);assert.deepEqual(result.measurement_batch.channel,report.channel);
 assert.deepEqual(result.measurement_batch.rows.map(x=>x.observed_tick),[0,1,2,3,4]);
 assert.deepEqual(result.measurement_batch.rows.map(x=>x.outcome),['completed','completed','completed','completed','unknown']);
 const expected={request_id:'failure',generation:3,command_sequence:1,identity:s.ready.identity,start_tick:0,steps:8,attempt_token:'attempt',authority:s.authority};
 assert.throws(()=>validateChannelStepResponse(expected,s.grant,result.measurement_batch));
});
