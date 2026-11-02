import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const root=process.env.BRF_IMPL;if(!root)throw Error('BRF_IMPL required');
const {createGrantedChannelRecorder,createGrantedMeasurementRecorder}=await import(pathToFileURL(root+'/src/experiments/measurement-recording-grant.ts'));
const authority={session_id:'s',project_revision:'a'.repeat(64),run_epoch:0,group_id:'all',lease_generation:1,channel_id:'microduck.truth',definition_sha256:'b'.repeat(64)};
const channel={id:'microduck.truth',kind:'truth',size:35,unit:'mixed',frame:null,definition_sha256:'b'.repeat(64),source_ids:[]};
const grant=()=>({purpose:'channel-recording',authority:structuredClone(authority),channel:structuredClone(channel),max_entries:64});
const sample=()=>({validity:'valid',values:Array.from({length:35},(_,i)=>i===0?-0:i),sequence:1,capture_tick:0,available_tick:0});
test('trusted grant binds full truth channel descriptor and records its exact vector',()=>{
 const c=structuredClone(channel),g=grant(),rec=createGrantedChannelRecorder(authority,g,c);c.kind='measurement';g.channel.size=1;
 assert.equal(rec.channel.kind,'truth');assert.equal(rec.channel.size,35);assert.ok(Object.isFrozen(rec.channel));assert.ok(Object.isFrozen(rec.channel.source_ids));
 assert.equal(rec.log.capture({authority,observed_tick:0,sample:sample()}),true);rec.log.settle(0,'completed');rec.log.seal(1,'completed');
 const row=rec.log.snapshot().entries[0];assert.equal(row.sample.values.length,35);assert.ok(Object.is(row.sample.values[0],-0));assert.equal(rec.log.snapshot().complete,true);
});
test('mismatched identity, digest, kind, size, unit, source and purpose reject before recording',()=>{
 for(const mutate of [g=>g.authority.run_epoch++,g=>g.authority.lease_generation++,g=>g.authority.definition_sha256='c'.repeat(64),g=>g.channel.id='other',g=>g.channel.kind='measurement',g=>g.channel.size=1,g=>g.channel.unit='rad',g=>g.channel.source_ids.push('other'),g=>g.channel.definition_sha256='c'.repeat(64),g=>g.purpose='measurement-recording',g=>g.max_entries=256,g=>g.extra=true]){
  const g=grant();mutate(g);assert.throws(()=>createGrantedChannelRecorder(authority,g,channel));
 }
 for(const bad of [{...channel,kind:'command'},{...channel,size:0},{...channel,size:65},{...channel,unit:''},{...channel,source_ids:['x','x']},{...channel,extra:true}]){
  const g=grant();g.channel=structuredClone(bad);assert.throws(()=>createGrantedChannelRecorder(authority,g,bad));
 }
});
test('scalar grant retains its existing contract',()=>{
 const g={purpose:'measurement-recording',authority:structuredClone(authority),max_entries:2};
 const log=createGrantedMeasurementRecorder(authority,g);assert.throws(()=>log.capture({authority,observed_tick:0,sample:sample()}));
 assert.equal(log.capture({authority,observed_tick:0,sample:{...sample(),values:[2]}}),true);
});

test('modeled measurement stays labeled and accessor-backed data is never invoked',()=>{
 const measurement={id:'microduck.truth',kind:'measurement',size:1,unit:'rad',frame:null,definition_sha256:'b'.repeat(64),source_ids:['joint.truth']};
 const g={purpose:'channel-recording',authority:structuredClone(authority),channel:structuredClone(measurement),max_entries:4};
 const rec=createGrantedChannelRecorder(authority,g,measurement);assert.equal(rec.channel.kind,'measurement');assert.deepEqual(rec.channel.source_ids,['joint.truth']);
 let invoked=false;const bad=grant();Object.defineProperty(bad.channel,'size',{enumerable:true,get(){invoked=true;return 35}});
 assert.throws(()=>createGrantedChannelRecorder(authority,bad,channel));assert.equal(invoked,false);
});

test('a synthetic grant binds the actual compiled Microduck truth descriptor',async()=>{
 if(!process.env.MICRODUCK_BUILTIN_PROJECT)throw Error('MICRODUCK_BUILTIN_PROJECT required');
 const profile=JSON.parse(await readFile(new URL('../microduck-profile.json',import.meta.url)));
 const command=await promisify(execFile)(process.execPath,[new URL('../tools/inspect-builtin-channel.mjs',import.meta.url).pathname],{env:process.env});
 const {revision,channel:actual}=JSON.parse(command.stdout);
 assert.equal(actual.kind,'truth');assert.equal(actual.size,35);assert.equal(actual.definition_sha256,profile.policy.approvedGrants[0].definition_sha256);
 const auth={...authority,project_revision:revision,channel_id:actual.id,definition_sha256:actual.definition_sha256};
 const g={purpose:'channel-recording',authority:auth,channel:actual,max_entries:64};
 const record=createGrantedChannelRecorder(auth,g,actual);assert.equal(record.channel.kind,'truth');assert.equal(record.channel.size,35);
 assert.equal(record.log.capture({authority:auth,observed_tick:0,sample:sample()}),true);
});
