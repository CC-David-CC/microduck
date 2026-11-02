import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {microduckTruthDefinitionHash} from '../foundation/implementation/src/observations/microduck-truth-channel.ts';
import {encodeChannelAttemptRecord,inspectChannelAttemptRecord} from '../foundation/implementation/src/experiments/channel-attempt-record-f64.ts';
const retained=JSON.parse(await readFile(new URL('./fixtures/microduck-truth-definition.json',import.meta.url)));
const revision=retained.revision,channel=retained.channel,definition=retained.definition,hash=channel.definition_sha256;
const identity={session_id:'session',project_revision:revision,run_epoch:0};
const authority={...identity,group_id:'all',lease_generation:1,channel_id:channel.id,definition_sha256:hash};
function receipt(count=256,status='completed',keep=count){return {status,identity,configuration_evidence:{project_revision:revision,configuration_sha256:'d'.repeat(64),runtime_lock_sha256:'e'.repeat(64)},requested_ticks:count,last_verified_tick:keep,reported_steps:null,measurement:{authority:structuredClone(authority),channel:structuredClone(channel),definition:structuredClone(definition),complete:status==='completed',entries:Array.from({length:keep},(_,i)=>({observed_tick:i,sample:{validity:'valid',values:Array.from({length:35},(_,j)=>i===0&&j===0?-0:(i+j/100)),sequence:i+1,capture_tick:i,available_tick:i},outcome:'completed'}))}}}
test('full 256-step vector attempt round-trips every finite bit including signed zero',async()=>{
 const input=receipt(),blob=await encodeChannelAttemptRecord(input,524288),out=await inspectChannelAttemptRecord(blob,authority,channel,524288);
 assert.ok(blob.size>131072);assert.ok(blob.size<524288);assert.equal(out.provenance,'unverified');assert.equal(out.definition_status,'complete');assert.deepEqual(out.measurement.definition,definition);assert.deepEqual(out.measurement.channel,channel);assert.equal(out.measurement.complete,true);assert.equal(out.measurement.entries.length,256);
 for(let i=0;i<256;i++)for(let j=0;j<35;j++)assert.ok(Object.is(out.measurement.entries[i].sample.values[j],input.measurement.entries[i].sample.values[j]));
});
test('unknown and cancelled attempts preserve a clearly incomplete prefix',async()=>{
 for(const status of ['unknown','cancelled']){const input=receipt(10,status,3),blob=await encodeChannelAttemptRecord(input,524288),out=await inspectChannelAttemptRecord(blob,authority,channel,524288);assert.equal(out.receipt.status,status);assert.equal(out.measurement.complete,false);assert.equal(out.measurement.entries.length,3)}
});
test('rejects mismatched authority, descriptor, shape, altered completeness and budgets',async()=>{
 const input=receipt(2),blob=await encodeChannelAttemptRecord(input,524288);
 await assert.rejects(inspectChannelAttemptRecord(blob,{...authority,lease_generation:2},channel,524288));
 await assert.rejects(inspectChannelAttemptRecord(blob,authority,{...channel,kind:'measurement'},524288));
 for(const change of [r=>r.measurement.entries[1].sample.values.pop(),r=>r.measurement.entries[1].observed_tick=5,r=>r.measurement.entries[0].sample.values[0]=NaN,r=>r.measurement.complete=false,r=>r.measurement.channel.definition_sha256='f'.repeat(64),r=>r.measurement.definition.layout[0].stage='changed']){const bad=receipt(2);change(bad);await assert.rejects(encodeChannelAttemptRecord(bad,524288))}
 await assert.rejects(encodeChannelAttemptRecord(receipt(256),1000));
});
test('duplicate JSON fields and non-finite encoded bits cannot masquerade as a valid record',async()=>{
 const text=await (await encodeChannelAttemptRecord(receipt(1),524288)).text();
 await assert.rejects(inspectChannelAttemptRecord(new Blob([text.replace('"schema_version":2','"schema_version":2,"schema_version":2')]),authority,channel,524288));
 await assert.rejects(inspectChannelAttemptRecord(new Blob([text.replace('8000000000000000','7ff0000000000000')]),authority,channel,524288));
});

test('negative fixtures do not mutate the shared trusted descriptor',()=>{
 const altered=receipt(1);altered.measurement.channel.definition_sha256='f'.repeat(64);
 assert.equal(channel.definition_sha256,hash);assert.equal(receipt(1).measurement.channel.definition_sha256,hash);
});
test('an unavailable attempt retains its channel but cannot claim samples or completion',async()=>{
 const r=receipt(10,'unknown',0);r.last_verified_tick=null;r.measurement.authority=null;
 const out=await inspectChannelAttemptRecord(await encodeChannelAttemptRecord(r,524288),null,channel,524288);
 assert.equal(out.measurement.authority,null);assert.equal(out.measurement.complete,false);assert.deepEqual(out.measurement.entries,[]);assert.equal(out.receipt.last_verified_tick,null);
});
test('widest allowed 64-value channel remains bounded across a full attempt',async()=>{
 const r=receipt();r.measurement.channel.size=64;r.measurement.definition.layout[0].size=32;const revisedHash=await microduckTruthDefinitionHash(r.measurement.definition);r.measurement.channel.definition_sha256=revisedHash;r.measurement.authority.definition_sha256=revisedHash;
 for(const row of r.measurement.entries)while(row.sample.values.length<64)row.sample.values.push(1.2345678901234567);
 const blob=await encodeChannelAttemptRecord(r,524288),out=await inspectChannelAttemptRecord(blob,r.measurement.authority,r.measurement.channel,524288);
 assert.equal(out.measurement.entries.length,256);assert.equal(out.measurement.entries[255].sample.values.length,64);
});

test('definition signed zero is preserved and a mismatched or omitted definition is refused',async()=>{
 const r=receipt(1);r.measurement.definition.source.position_facts[0].test_zero=-0;
 const h=await microduckTruthDefinitionHash(r.measurement.definition);r.measurement.channel.definition_sha256=h;r.measurement.authority.definition_sha256=h;
 const blob=await encodeChannelAttemptRecord(r,524288),out=await inspectChannelAttemptRecord(blob,r.measurement.authority,r.measurement.channel,524288);
 assert.ok(Object.is(out.measurement.definition.source.position_facts[0].test_zero,-0));
 const missing=receipt(1);delete missing.measurement.definition;await assert.rejects(encodeChannelAttemptRecord(missing,524288));
});

test('tampered or noncanonical saved definitions are rejected rather than silently reinterpreted',async()=>{
 const blob=await encodeChannelAttemptRecord(receipt(1),524288),original=JSON.parse(await blob.text());
 const changed=structuredClone(original),pairs=changed.measurement.definition_canonical[1];pairs.find(x=>x[0]==='id')[1][1]='different';
 await assert.rejects(inspectChannelAttemptRecord(new Blob([JSON.stringify(changed)]),authority,channel,524288));
 const reordered=structuredClone(original);reordered.measurement.definition_canonical[1].reverse();
 await assert.rejects(inspectChannelAttemptRecord(new Blob([JSON.stringify(reordered)]),authority,channel,524288));
});
