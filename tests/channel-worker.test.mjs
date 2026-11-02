import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {MessageChannel} from 'node:worker_threads';import {setTimeout as delay} from 'node:timers/promises';
import {validateChannelStepResponse} from '../foundation/implementation/src/experiments/measured-step-response.ts';
const path=process.env.MICRODUCK_BUILTIN_PROJECT;if(!path)throw Error('MICRODUCK_BUILTIN_PROJECT required');
const fixture=JSON.parse(await readFile(path)),profile=JSON.parse(await readFile(new URL('../microduck-profile.json',import.meta.url)));
const report=JSON.parse((await promisify(execFile)(process.execPath,[new URL('../tools/inspect-builtin-channel.mjs',import.meta.url).pathname],{env:process.env})).stdout);
let serial=0;
async function until(fn){const deadline=Date.now()+10000;while(!fn()&&Date.now()<deadline)await delay(5);assert.ok(fn(),'expected worker message');return fn()}
function peer(failTick=null,control=Array(14).fill(0)){const data=new MessageChannel(),life=new MessageChannel(),seen=[];
 data.port2.onmessage=e=>{const m=e.data;if(m.kind==='initialize')data.port2.postMessage({kind:'initialized',request_id:m.request_id});
  else if(m.kind==='dispose')data.port2.postMessage({kind:'disposed',request_id:m.request_id});
  else if(m.kind==='stage'){seen.push(structuredClone(m));if(m.authority.observed_tick===failTick)data.port2.postMessage({kind:'error',request_id:m.request_id,code:'CONTROLLER_FAULT'});else data.port2.postMessage({kind:'stage',request_id:m.request_id,stageId:m.stageId,authority:m.authority,control:structuredClone(control)});}
  else if(m.kind==='commit')data.port2.postMessage({kind:'committed',request_id:m.request_id,stageId:m.stageId,authority:m.authority});};data.port2.start();
 life.port2.onmessage=e=>{const m=e.data;if(m.kind==='terminate')life.port2.postMessage({version:1,kind:'termination-requested',request_id:m.request_id})};life.port2.start();
 return {row:{group_id:'all',dataPort:data.port1,lifecyclePort:life.port1},seen,close(){data.port1.close();data.port2.close();life.port1.close();life.port2.close()}};
}
async function start(t,failTick=null,control=Array(14).fill(0),maxReplyBytes=1048576){const previous=globalThis.self,received=[];let listener;
 globalThis.self={postMessage(v){received.push(structuredClone(v))},close(){},addEventListener(kind,fn){if(kind==='message')listener=fn}};
 await import(new URL('../foundation/implementation/src/session/project-world-worker.ts?channel-worker='+serial++,import.meta.url));
 const emit=data=>listener({data,ports:[]}),p=peer(failTick,control);t.after(()=>{p.close();globalThis.self=previous});
 const entries=fixture.files.map(x=>({path:x.path,data:Uint8Array.from(Buffer.from(x.data_base64,'base64'))}));
 const worldProfile=structuredClone(profile.profile);worldProfile.groups[0].owner_id='worker-test-owner';
 const msg={kind:'stage',request_id:'stage',generation:3,entries,profile:worldProfile,controllers:profile.controllers,inventoryLimits:profile.policy.inventoryLimits,compileLimits:profile.policy.compileLimits,maxReplyBytes,runnerTimeoutMs:3000};
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

test('combined worker recording carries real commands across batches with held provenance',async t=>{
 const control=Array.from({length:14},(_,i)=>i===0?20:i===1?-20:.25),s=await start(t,null,control);
 s.emit({...step(s,'combined-1',5),kind:'step-recorded'});const first=await until(()=>s.received.find(x=>x.request_id==='combined-1'));
 assert.equal(first.kind,'stepped',JSON.stringify(first));assert.equal(first.command_batch.complete,true);assert.equal(first.command_batch.rows.length,5);
 const row=first.command_batch.rows[0];assert.equal(row.source,'fresh');assert.equal(row.requested[0],20);assert.equal(row.applied[0],10);assert.equal(row.limited[0],true);
 assert.equal(first.command_batch.rows[1].source,'held');assert.equal(first.command_batch.rows[1].request_tick,0);
 s.emit({...step(s,'combined-2',3),kind:'step-recorded',command_sequence:2});const second=await until(()=>s.received.find(x=>x.request_id==='combined-2'));
 assert.equal(second.kind,'stepped',JSON.stringify(second));assert.equal(second.command_batch.rows[0].source,'held');assert.equal(second.command_batch.rows[0].request_tick,4);assert.equal(second.command_batch.rows[0].requested[0],20);assert.equal(second.command_batch.rows[0].limited[0],true);
 assert.deepEqual(second.command_batch.layout,first.command_batch.layout);assert.equal(second.inspection.plant.tick,8);
});
test('combined recording explicitly marks a controller failure as unknown without invented values',async t=>{
 const s=await start(t,4);s.emit({...step(s,'combined-failure',8),kind:'step-recorded'});const reply=await until(()=>s.received.find(x=>x.request_id==='combined-failure'));
 assert.equal(reply.kind,'step-error');assert.equal(reply.steps_completed,4);assert.equal(reply.command_batch.complete,false);assert.deepEqual(reply.command_batch.rows.map(x=>x.outcome),['completed','completed','completed','completed','unknown']);
 const last=reply.command_batch.rows.at(-1);assert.equal(last.requested,null);assert.equal(last.applied,null);assert.equal(last.limited,null);
});

test('combined recording rejects an oversized batch before stepping and preserves the next sequence',async t=>{
 const s=await start(t);s.emit({...step(s,'combined-large',64),kind:'step-recorded'});const denied=await until(()=>s.received.find(x=>x.request_id==='combined-large'));
 assert.equal(denied.kind,'step-error');assert.equal(denied.steps_completed,0);assert.equal(s.p.seen.length,0);
 s.emit({...step(s,'combined-after-large',1),kind:'step-recorded'});const reply=await until(()=>s.received.find(x=>x.request_id==='combined-after-large'));assert.equal(reply.kind,'stepped');assert.equal(reply.inspection.plant.tick,1);
});
test('unrecorded steps break command provenance instead of inventing a held request',async t=>{
 const s=await start(t);s.emit({...step(s,'before-gap',1),kind:'step-recorded'});const a=await until(()=>s.received.find(x=>x.request_id==='before-gap'));assert.equal(a.kind,'stepped');
 const {recording,...ordinary}=step(s,'gap',1);s.emit({...ordinary,command_sequence:2});const gap=await until(()=>s.received.find(x=>x.request_id==='gap'));assert.equal(gap.kind,'stepped');
 s.emit({...step(s,'after-gap',1),kind:'step-recorded',command_sequence:3});const b=await until(()=>s.received.find(x=>x.request_id==='after-gap'));assert.equal(b.kind,'stepped');
 const row=b.command_batch.rows[0];assert.equal(row.source,'held');assert.equal(row.request_tick,0);assert.ok(row.requested.every(x=>x===null));assert.ok(row.limited.every(x=>x===null));
});

test('combined reply budget is checked before any command or physical step',async t=>{
 const s=await start(t,null,Array(14).fill(0),65536);s.emit({...step(s,'combined-small-budget',32),kind:'step-recorded'});
 const denied=await until(()=>s.received.find(x=>x.request_id==='combined-small-budget'));assert.equal(denied.kind,'step-error');assert.equal(denied.steps_completed,0);assert.equal(s.p.seen.length,0);
 s.emit({...step(s,'combined-small-after',1),kind:'step-recorded'});const ok=await until(()=>s.received.find(x=>x.request_id==='combined-small-after'));assert.equal(ok.kind,'stepped');assert.equal(ok.inspection.plant.tick,1);
});

test('a new attempt cannot inherit the prior attempt command provenance',async t=>{
 const s=await start(t);s.emit({...step(s,'old-attempt',1),kind:'step-recorded'});const a=await until(()=>s.received.find(x=>x.request_id==='old-attempt'));assert.equal(a.kind,'stepped');
 const next=step(s,'new-attempt',1);next.recording.attempt_token='different-attempt';s.emit({...next,kind:'step-recorded',command_sequence:2});
 const b=await until(()=>s.received.find(x=>x.request_id==='new-attempt'));assert.equal(b.kind,'stepped');const row=b.command_batch.rows[0];assert.equal(row.source,'held');assert.ok(row.requested.every(x=>x===null));assert.ok(row.limited.every(x=>x===null));
});
