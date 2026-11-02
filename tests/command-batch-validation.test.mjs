import test from 'node:test';import assert from 'node:assert/strict';
import {createCommandBatchRecorder} from '../foundation/implementation/src/experiments/command-batch-record.ts';
import {validateCommandBatch} from '../foundation/implementation/src/experiments/command-batch-validation.ts';
const identity={session_id:'s',project_revision:'a'.repeat(64),run_epoch:0},authority={...identity,group_id:'arm',lease_generation:1};
const lease={group_id:'arm',owner_id:'owner',generation:1,control_stride:2};
const layout={group_id:'arm',control_stride:2,control_size:2,blocks:[{actuator_name:'motor',engine_indices:[2,0],inputs:[{actuator_name:'motor',component:0,unit:'N',semantic:'first',input_range:[-1,1]},{actuator_name:'motor',component:1,unit:'N',semantic:'second',input_range:null}]}]};
const initial={lease,accepted_sequence:0,last_control_tick:null,fresh_at_tick:null};
const after={lease,accepted_sequence:2,last_control_tick:2,fresh_at_tick:null};
const request={authority,attempt_token:'run',start_tick:0,steps:3};
const row=(tick,sequence,source,request_tick,requested,applied,limited)=>({boundary_tick:tick,outcome:'completed',sequence,source,request_tick,requested,applied,limited});
const rows=[row(0,1,'fresh',0,[5,2],[1,2],[true,false]),row(1,1,'held',0,[5,2],[1,2],[true,false]),row(2,2,'fresh',2,[-5,3],[-1,3],[true,false])];
function batch(){return {authority,start_tick:0,requested_count:3,layout:createCommandBatchRecorder(authority,layout,0,3).snapshot().layout,rows:structuredClone(rows),complete:true}}
function verify(value=batch(),prior){return validateCommandBatch(request,layout,initial,[0,99,0],after,[3,99,-1],value,prior)}
test('host validates fresh, limited and held commands against trusted nonsequential layout and control state',()=>{
 const r=verify();assert.equal(r.batch.rows.length,3);assert.deepEqual(r.batch.rows[0].requested,[5,2]);assert.deepEqual(r.batch.rows[0].applied,[1,2]);assert.deepEqual(r.batch.rows[1].limited,[true,false]);assert.ok(Object.isFrozen(r.batch));
});
test('forged rows, metadata, cadence, authority, completeness and final controls are rejected',()=>{
 const changes=[b=>b.layout.inputs[0].unit='wrong',b=>b.authority.lease_generation++,b=>b.rows[0].applied[0]=.5,b=>b.rows[0].limited[0]=false,b=>b.rows[1].requested[0]=7,b=>b.rows[1].source='fresh',b=>b.rows[2].sequence=8,b=>b.rows.pop(),b=>b.complete=false];
 for(const change of changes){const b=structuredClone(batch());change(b);assert.throws(()=>verify(b))}assert.equal(authority.lease_generation,1);assert.equal(batch().layout.inputs[0].unit,'N');
 assert.throws(()=>validateCommandBatch(request,layout,initial,[0,99,0],after,[3,99,0],batch()));
});
test('held request across batches requires validated matching attempt provenance',()=>{
 const first=verify(),before=after,end={lease,accepted_sequence:2,last_control_tick:2,fresh_at_tick:null},req={authority,attempt_token:'run',start_tick:3,steps:1};
 const input={authority,start_tick:3,requested_count:1,layout:batch().layout,rows:[row(3,2,'held',2,[-5,3],[-1,3],[true,false])],complete:true};
 const r=validateCommandBatch(req,layout,before,[3,99,-1],end,[3,99,-1],input,first.continuation);assert.equal(r.batch.rows[0].requested[0],-5);
 assert.throws(()=>validateCommandBatch({...req,attempt_token:'other'},layout,before,[3,99,-1],end,[3,99,-1],input,first.continuation));
 assert.throws(()=>validateCommandBatch(req,layout,before,[3,99,-1],end,[3,99,-1],input,structuredClone(first.continuation)));
 assert.throws(()=>validateCommandBatch(req,layout,before,[3,99,-1],end,[3,99,-1],input));
 const unknown=structuredClone(input);unknown.rows[0].requested=[null,null];unknown.rows[0].limited=[null,null];assert.equal(validateCommandBatch(req,layout,before,[3,99,-1],end,[3,99,-1],unknown).batch.rows[0].requested[0],null);
});
