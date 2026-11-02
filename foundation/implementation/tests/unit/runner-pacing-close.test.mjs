import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import {connectRunner} from '../../src/isolation/runner-client.ts';
test('closing cancels a stage waiting for paced dispatch',async()=>{
 const oldPerformance=globalThis.performance;globalThis.performance={now:()=>0};
 const data=new MessageChannel(),lifecycle=new MessageChannel(),seen=[];
 data.port2.onmessage=e=>{const m=e.data;seen.push(m.kind);
  if(m.kind==='initialize')data.port2.postMessage({request_id:m.request_id,kind:'initialized'});
  if(m.kind==='stage')data.port2.postMessage({request_id:m.request_id,kind:'stage',stageId:m.stageId,authority:m.authority,control:[0]});
  if(m.kind==='dispose')data.port2.postMessage({request_id:m.request_id,kind:'disposed'});
 };data.port2.start();
 lifecycle.port2.onmessage=e=>lifecycle.port2.postMessage({version:1,kind:'termination-requested',request_id:e.data.request_id});
 lifecycle.port2.start();
 const identity={session_id:'s',project_revision:'a'.repeat(64),run_epoch:0};
 const client=await connectRunner({dataPort:data.port1,lifecyclePort:lifecycle.port1,source:'',sourceId:'test',identity,groupId:'g',ownerId:'o',leaseGeneration:1,timeoutMs:1000});
 try {
  await client.initialize({group_id:'g',control_size:1,inputs:[{}],control_stride:1,observations:[]},{});
  const stage=client.stage({observation:{...identity,tick:0,sim_time:0,dt:.01,samples:{}},intent:{},sequence:1,applyTick:0});
  const closed=client.close();
  const results=await Promise.allSettled([stage,closed]);
  assert.equal(results[0].status,'rejected');
  assert.equal(results[0].reason.code,'CLOSED');
  assert.equal(results[1].status,'fulfilled');
  assert.deepEqual(seen,['initialize','dispose']);
 } finally {data.port2.close();lifecycle.port2.close();globalThis.performance=oldPerformance}
});
