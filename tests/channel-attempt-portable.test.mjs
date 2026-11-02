import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {encodePortableMeasuredAttempt,inspectPortableMeasuredAttempt} from '../foundation/implementation/src/experiments/portable-measured-attempt.ts';
import {encodeExperimentFile,decodeExperimentFile} from '../foundation/implementation/src/projects/experiment-file.ts';
const path=process.env.MICRODUCK_BUILTIN_PROJECT;if(!path)throw Error('MICRODUCK_BUILTIN_PROJECT required');
const source=await readFile(path),retained=JSON.parse(await readFile(new URL('./fixtures/microduck-truth-definition.json',import.meta.url)));
const limits={max_bundle_bytes:67108864,max_records:8,max_record_bytes:1048576,max_total_record_bytes:2097152,inventory:{max_files:128,max_total_bytes:33554432,max_file_bytes:8388608,max_manifest_bytes:262144,max_manifest_depth:16}};
const identity={session_id:'test',project_revision:retained.revision,run_epoch:0},authority={...identity,group_id:'all',lease_generation:1,channel_id:retained.channel.id,definition_sha256:retained.channel.definition_sha256};
const metadata={status:'completed',identity,configuration_evidence:{project_revision:retained.revision,configuration_sha256:'a'.repeat(64),runtime_lock_sha256:'b'.repeat(64)},requested_ticks:2,last_verified_tick:2,reported_steps:null};
const entries=Array.from({length:2},(_,i)=>({observed_tick:i,sample:{validity:'valid',values:Array.from({length:35},(_,j)=>i===0&&j===0?-0:i+j/100),sequence:i+1,capture_tick:i,available_tick:i},outcome:'completed'}));
test('game and complete Microduck research share one project file and reload with full exact definition',async()=>{
 const base=await decodeExperimentFile(new Blob([source]),limits),receipt={...metadata,measurement:{authority,channel:retained.channel,definition:retained.definition,entries,complete:true}};
 const data=await encodePortableMeasuredAttempt(receipt),game=new Blob(['game-save']);
 const file=await encodeExperimentFile(base.inventory,[{id:'game-test',kind:'game',content:game},{id:'research-test',kind:'research',content:data}],limits);
 const restored=await decodeExperimentFile(file,limits);assert.equal(restored.inventory.project_revision,retained.revision);assert.equal(restored.records.length,2);assert.equal(await restored.records[0].content.text(),'game-save');
 const checked=await inspectPortableMeasuredAttempt(restored.records[1].content,retained.revision);assert.equal(checked.provenance,'unverified');assert.deepEqual(checked.measurement.definition,retained.definition);
 assert.deepEqual(checked.measurement.entries[1].sample.values,entries[1].sample.values);assert.ok(Object.is(checked.measurement.entries[0].sample.values[0],-0));
});
test('a vector record without its definition and a record for another project are rejected',async()=>{
 const receipt={...metadata,measurement:{authority,channel:retained.channel,entries,complete:true}};await assert.rejects(encodePortableMeasuredAttempt(receipt));
 receipt.measurement.definition=retained.definition;const data=await encodePortableMeasuredAttempt(receipt);await assert.rejects(inspectPortableMeasuredAttempt(data,'f'.repeat(64)));
});
test('legacy scalar attempt remains readable through the same portable adapter',async()=>{
 const scalar={...metadata,measurement:{authority:{...authority,channel_id:'angle'},entries:entries.map(x=>({...x,sample:{...x.sample,values:[x.sample.values[0]]}})),complete:true}};
 const data=await encodePortableMeasuredAttempt(scalar),checked=await inspectPortableMeasuredAttempt(data,retained.revision);assert.equal(checked.provenance,'unverified');assert.equal(checked.measurement.entries.length,2);assert.ok(Object.is(checked.measurement.entries[0].sample.values[0],-0));
});
