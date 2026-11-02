import test from 'node:test';import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';
const root=process.env.BRF_IMPL;if(!root)throw Error('BRF_IMPL required');
const {validateChannelStepResponse}=await import(pathToFileURL(root+'/src/experiments/measured-step-response.ts'));
const {channelStepBudget}=await import(pathToFileURL(root+'/src/experiments/channel-step-budget.ts'));
const id={session_id:'s',project_revision:'a'.repeat(64),run_epoch:0},authority={...id,group_id:'all',lease_generation:1,channel_id:'duck.truth',definition_sha256:'b'.repeat(64)};
const channel={id:'duck.truth',kind:'truth',size:35,unit:'mixed',frame:null,definition_sha256:'b'.repeat(64),source_ids:[]};
const grant={purpose:'channel-recording',authority,channel,max_entries:8};
const expected={request_id:'step',generation:1,command_sequence:1,identity:id,start_tick:0,steps:2,attempt_token:'attempt',authority};
const sample=t=>({validity:'valid',values:Array.from({length:35},(_,i)=>i===0?-0:i+t),sequence:t+1,capture_tick:t,available_tick:t});
const batch=()=>({...structuredClone(expected),channel:structuredClone(channel),rows:[0,1].map(t=>({observed_tick:t,sample:sample(t),outcome:'completed'}))});
test('correlated complete vector response retains its immutable channel and exact boundaries',()=>{
 const data=batch(),result=validateChannelStepResponse(expected,grant,data);data.channel.kind='measurement';data.rows[0].sample.values[1]=999;
 assert.equal(result.channel.kind,'truth');assert.equal(result.channel.size,35);assert.ok(Object.isFrozen(result.channel));assert.equal(result.log.entries.length,2);assert.equal(result.log.entries[0].sample.values[1],1);assert.ok(Object.is(result.log.entries[0].sample.values[0],-0));assert.equal(result.log.sealed,false);assert.equal(result.log.complete,false);
});
test('wrong correlation, channel, shape, outcome or excess data is rejected',()=>{
 const mutators=[x=>x.request_id='other',x=>x.generation++,x=>x.command_sequence++,x=>x.attempt_token='other',x=>x.identity.run_epoch++,x=>x.authority.lease_generation++,x=>x.channel.kind='measurement',x=>x.channel.size=1,x=>x.channel.definition_sha256='c'.repeat(64),x=>x.rows.pop(),x=>x.rows[1].observed_tick=0,x=>x.rows[0].outcome='unknown',x=>x.rows[0].sample.values.pop(),x=>x.rows[0].sample.available_tick=1,x=>x.extra='x'.repeat(70000)];
 for(const mutate of mutators){const x=batch();mutate(x);assert.throws(()=>validateChannelStepResponse(expected,grant,x));}
 const changed=structuredClone(grant);changed.channel.unit='rad';assert.throws(()=>validateChannelStepResponse(expected,changed,batch()));
});

test('preflight bounds a worst-case 35-value batch and rejects oversized work',()=>{
 const request={...expected,steps:48},bound=channelStepBudget(request,channel);
 const rows=Array.from({length:48},(_,i)=>({observed_tick:i,sample:{validity:'valid',values:Array(35).fill(-1.7976931348623157e+308),sequence:i+1,capture_tick:i,available_tick:i},outcome:'completed'}));
 const bytes=new TextEncoder().encode(JSON.stringify({...request,channel,rows})).length;
 assert.ok(bytes<=bound);assert.ok(bound<=65536);assert.throws(()=>channelStepBudget({...request,steps:64},channel));
 assert.throws(()=>channelStepBudget({...request,start_tick:-1},channel));assert.throws(()=>channelStepBudget({...request,start_tick:Number.MAX_SAFE_INTEGER},channel));
 const unicode={...request,attempt_token:'??'.repeat(100)};const unicodeBound=channelStepBudget(unicode,channel);
 assert.ok(new TextEncoder().encode(JSON.stringify({...unicode,channel,rows})).length<=unicodeBound);
});
