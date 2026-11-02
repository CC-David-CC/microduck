import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {encodePortableMeasuredAttempt,inspectPortableMeasuredAttempt} from '../foundation/implementation/src/experiments/portable-measured-attempt.ts';
import {commandGroupLayout} from '../foundation/implementation/src/experiments/command-group-layout.ts';import {createCommandBatchRecorder} from '../foundation/implementation/src/experiments/command-batch-record.ts';
const pinned=JSON.parse(await readFile(new URL('./fixtures/microduck-truth-definition.json',import.meta.url))),profile=JSON.parse(await readFile(new URL('../microduck-profile.json',import.meta.url)));
const identity={session_id:'s',project_revision:pinned.revision,run_epoch:0},authority={...identity,group_id:'all',lease_generation:1};
const layout=commandGroupLayout(profile.profile.blocks,profile.profile.groups,'all'),description=createCommandBatchRecorder(authority,layout,0,1).snapshot().layout;
function receipt(total=100,status='completed',kept=total){
 const metadata={status,identity,configuration_evidence:{project_revision:pinned.revision,configuration_sha256:'a'.repeat(64),runtime_lock_sha256:'b'.repeat(64)},requested_ticks:total,last_verified_tick:kept,reported_steps:null};
 const samples=Array.from({length:kept},(_,t)=>({observed_tick:t,sample:{validity:'valid',values:Array.from({length:35},(_,i)=>t===0&&i===0?-0:t+i/100),sequence:t+1,capture_tick:t,available_tick:t},outcome:'completed'}));
 const commands=Array.from({length:kept},(_,t)=>({boundary_tick:t,outcome:'completed',sequence:Math.floor(t/4)+1,source:t%4===0?'fresh':'held',request_tick:t-t%4,requested:Array.from({length:14},(_,i)=>i===0?20:i===1?-20:i===2?-0:.25),applied:Array.from({length:14},(_,i)=>i===0?10:i===1?-10:i===2?-0:.25),limited:Array.from({length:14},(_,i)=>i<2)}));
 return {...metadata,measurement:{authority:{...authority,channel_id:pinned.channel.id,definition_sha256:pinned.channel.definition_sha256},channel:pinned.channel,definition:pinned.definition,entries:samples,complete:status==='completed'},commands:{authority,layout:description,entries:commands,complete:status==='completed'}};
}
test('saved run preserves every requested, applied, limited and held command with exact numeric bits',async()=>{
 const data=await encodePortableMeasuredAttempt(receipt()),saved=await inspectPortableMeasuredAttempt(data,pinned.revision);assert.equal(saved.provenance,'unverified');assert.equal(saved.receipt.status,'completed');assert.equal(saved.commands.complete,true);assert.equal(saved.commands.entries.length,100);
 assert.equal(saved.commands.layout.limit_stage,'host-control-input-range');assert.equal(saved.commands.layout.inputs[0].validation_rule,'independent-scalar-ranges');
 for(let i=0;i<100;i++){const row=saved.commands.entries[i];assert.equal(row.boundary_tick,i);assert.equal(row.source,i%4===0?'fresh':'held');assert.equal(row.requested[0],20);assert.equal(row.applied[0],10);assert.equal(row.limited[0],true);assert.ok(Object.is(row.requested[2],-0));assert.ok(Object.is(row.applied[2],-0))}
});
test('cancelled and unknown attempts preserve only their confirmed joint prefix',async()=>{
 for(const status of ['cancelled','unknown']){const data=await encodePortableMeasuredAttempt(receipt(10,status,5)),saved=await inspectPortableMeasuredAttempt(data,pinned.revision);assert.equal(saved.receipt.status,status);assert.equal(saved.commands.complete,false);assert.equal(saved.commands.entries.length,5);assert.equal(saved.measurement.entries.length,5)}
});
test('rejects tampered limiting, cadence, authority and mismatched measurement/command prefixes',async()=>{
 for(const change of [r=>r.commands.entries[0].applied[0]=9,r=>r.commands.entries[0].limited[0]=false,r=>r.commands.entries[1].source='fresh',r=>r.commands.entries[4].sequence=99,r=>r.commands.authority.lease_generation++,r=>r.commands.entries.pop(),r=>r.commands.layout.inputs[0].input_range=[-9,9]]){const x=structuredClone(receipt(8));change(x);await assert.rejects(encodePortableMeasuredAttempt(x))}
});
test('empty unavailable attempts preserve the command layout without invented authority or values',async()=>{
 const x=receipt(10,'failed',0);x.last_verified_tick=null;x.measurement.authority=null;x.commands.authority=null;const saved=await inspectPortableMeasuredAttempt(await encodePortableMeasuredAttempt(x),pinned.revision);assert.equal(saved.commands.authority,null);assert.deepEqual(saved.commands.entries,[]);assert.equal(saved.commands.complete,false);
});
