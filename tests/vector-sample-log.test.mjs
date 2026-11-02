import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const root=process.env.BRF_IMPL;if(!root)throw Error('BRF_IMPL required');
const {createMeasurementLog,createSampleLog}=await import(pathToFileURL(root+'/src/experiments/measurement-log.ts'));
const authority={session_id:'s',project_revision:'a'.repeat(64),run_epoch:0,group_id:'all',lease_generation:1,channel_id:'duck.truth',definition_sha256:'b'.repeat(64)};
const valid=(values,tick)=>({validity:'valid',values,sequence:tick+1,capture_tick:tick,available_tick:tick});
test('records an explicitly sized 35-value boundary without losing order, time, or signed zero',()=>{
 const log=createSampleLog(authority,2,35),values=Array.from({length:35},(_,i)=>i===0?-0:i/10);
 assert.equal(log.capture({authority,observed_tick:0,sample:valid(values,0)}),true);values[1]=999;
 log.settle(0,'completed');assert.equal(log.capture({authority,observed_tick:1,sample:valid(Array(35).fill(3),1)}),true);log.settle(1,'completed');log.seal(2,'completed');
 const record=log.snapshot();assert.equal(record.complete,true);assert.equal(record.entries.length,2);assert.equal(record.entries[0].sample.values.length,35);assert.ok(Object.is(record.entries[0].sample.values[0],-0));assert.equal(record.entries[0].sample.values[1],.1);assert.equal(record.entries[1].sample.capture_tick,1);
});
test('rejects absent, wrong, ragged or nonfinite vector sizes and invalid budgets',()=>{
 for(const [capacity,size] of [[1,undefined],[1,0],[1,65],[256,35],[1,1.5]])assert.throws(()=>createSampleLog(authority,capacity,size));
 const log=createSampleLog(authority,2,35);
 for(const values of [[],Array(34).fill(1),Array(36).fill(1),[...Array(34).fill(1),NaN],Array(35)])assert.throws(()=>log.capture({authority,observed_tick:0,sample:valid(values,0)}));
 assert.equal(log.snapshot().entries.length,0);
});
test('explicit scalar mode still rejects vectors and retains missing or unknown outcomes',()=>{
 const log=createMeasurementLog(authority,2);assert.throws(()=>log.capture({authority,observed_tick:0,sample:valid([1,2],0)}));
 assert.equal(log.capture({authority,observed_tick:0,sample:{validity:'missing',values:[],sequence:null,capture_tick:null,available_tick:null}}),true);log.settle(0,'unknown');log.seal(1,'unknown');
 assert.equal(log.snapshot().complete,false);assert.equal(log.snapshot().entries[0].outcome,'unknown');
});

test('vector overflow and uncertain outcomes cannot claim a complete history',()=>{
 const log=createSampleLog(authority,2,35);
 assert.throws(()=>log.capture({authority:{...authority,run_epoch:1},observed_tick:0,sample:valid(Array(35).fill(1),0)}));
 assert.equal(log.capture({authority,observed_tick:0,sample:valid(Array(35).fill(1),0)}),true);log.settle(0,'completed');
 assert.equal(log.capture({authority,observed_tick:1,sample:{validity:'stale',values:Array(35).fill(2),sequence:1,capture_tick:0,available_tick:0}}),true);log.settle(1,'unknown');
 assert.equal(log.capture({authority,observed_tick:2,sample:valid(Array(35).fill(3),2)}),false);log.seal(3,'completed');
 const record=log.snapshot();assert.equal(record.truncated,true);assert.equal(record.complete,false);assert.equal(record.entries[1].outcome,'unknown');assert.equal(record.entries[1].sample.validity,'stale');
});
