import test from 'node:test';import assert from 'node:assert/strict';
import {commandBatchBudget,stepEnvelopeBudget} from '../foundation/implementation/src/experiments/command-batch-budget.ts';
import {createCommandBatchRecorder} from '../foundation/implementation/src/experiments/command-batch-record.ts';
const authority={session_id:'s',project_revision:'a'.repeat(64),run_epoch:0,group_id:'all',lease_generation:1};
function layout(n){const blocks=Array.from({length:n},(_,i)=>({actuator_name:'motor'+i,validation_rule_id:'independent-scalar-ranges',engine_indices:[i],inputs:[{actuator_name:'motor'+i,component:0,unit:'N',semantic:'bounded input ?',input_range:[-10,10]}]}));return {group_id:'all',control_stride:4,control_size:n,blocks};}
test('conservative command bound exceeds independently serialized worst-case rows',()=>{
 const l=layout(14),count=32,bound=commandBatchBudget(authority,l,100,count),empty=createCommandBatchRecorder(authority,l,100,count).snapshot();
 const rows=Array.from({length:count},(_,i)=>({boundary_tick:100+i,outcome:'completed',sequence:9007199254740991,source:'fresh',request_tick:9007199254740991,requested:Array(14).fill(-1.7976931348623157e308),applied:Array(14).fill(-1.7976931348623157e308),limited:Array(14).fill(false)}));
 const bytes=new TextEncoder().encode(JSON.stringify({...empty,rows,complete:true})).length;assert.ok(bytes<=bound,`${bytes} > ${bound}`);assert.ok(bound<=65536);
});
test('oversized command sidecars are refused rather than truncated',()=>{assert.throws(()=>commandBatchBudget(authority,layout(256),0,64),/budget/i)});
test('envelope sizing reserves for nullable counters becoming long numbers',()=>{
 const initial={identity:{session_id:'?',run_epoch:0},groups:[{tick:null,active:true}],value:0},later={identity:{session_id:'?',run_epoch:9007199254740991},groups:[{tick:9007199254740991,active:false}],value:-1.7976931348623157e308};
 assert.ok(stepEnvelopeBudget(initial)>=new TextEncoder().encode(JSON.stringify(later)).length);
});
