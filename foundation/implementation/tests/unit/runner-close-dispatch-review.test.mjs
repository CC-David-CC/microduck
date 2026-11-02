import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import {setTimeout as sleep} from 'node:timers/promises';
import {connectRunner} from '../../src/isolation/runner-client.ts';

async function fixture(){
 const data=new MessageChannel(),lifecycle=new MessageChannel(),seen=[];
 let pendingDispose;const disposeSeen=new Promise(resolve=>{pendingDispose=resolve;});let disposeRequest,terminationRequest,terminationSeen;
 const termination=new Promise(resolve=>{terminationSeen=resolve;});
 data.port2.onmessage=e=>{const m=e.data;seen.push(m.kind);
  if(m.kind==='initialize')data.port2.postMessage({request_id:m.request_id,kind:'initialized'});
  if(m.kind==='stage')data.port2.postMessage({request_id:m.request_id,kind:'stage',stageId:m.stageId,authority:m.authority,control:[1]});
  if(m.kind==='commit')data.port2.postMessage({request_id:m.request_id,kind:'committed',stageId:m.stageId,authority:m.authority});
  if(m.kind==='dispose'){disposeRequest=m;pendingDispose();}
 };data.port2.start();
 lifecycle.port2.onmessage=e=>{terminationRequest=e.data;terminationSeen();};lifecycle.port2.start();
 const identity={session_id:'s',project_revision:'a'.repeat(64),run_epoch:0};
 const client=await connectRunner({dataPort:data.port1,lifecyclePort:lifecycle.port1,source:'',sourceId:'close-test',identity,groupId:'g',ownerId:'o',leaseGeneration:1,timeoutMs:500});
 await client.initialize({group_id:'g',control_size:1,inputs:[{}],control_stride:1,observations:[]},{});
 const stage=()=>client.stage({observation:{...identity,tick:0,sim_time:0,dt:0,samples:{}},intent:{},sequence:1,applyTick:0});
 async function finish(closing){data.port2.postMessage({request_id:disposeRequest.request_id,kind:'disposed'});await termination;
  lifecycle.port2.postMessage({version:1,kind:'termination-requested',request_id:terminationRequest.request_id});await Promise.allSettled([closing]);data.port2.close();lifecycle.port2.close();}
 return {client,stage,seen,disposeSeen,finish};
}

test('stage after close starts rejects before runner dispatch',async()=>{
 const f=await fixture();const closing=f.client.close();await f.disposeSeen;
 try{await assert.rejects(f.stage(),error=>error.code==='CLOSED');await sleep(10);assert.deepEqual(f.seen,['initialize','dispose']);}
 finally{await f.finish(closing);}
});

test('commit after close starts rejects before runner dispatch',async()=>{
 const f=await fixture();const staged=await f.stage();const closing=f.client.close();await f.disposeSeen;
 try{await assert.rejects(f.client.commit(staged.stageId),error=>error.code==='CLOSED');await sleep(10);assert.deepEqual(f.seen,['initialize','stage','dispose']);}
 finally{await f.finish(closing);}
});

test('abort after close starts rejects without terminating ahead of disposal',async()=>{
 const f=await fixture();const staged=await f.stage();const closing=f.client.close();await f.disposeSeen;
 try{await assert.rejects(f.client.abort(staged.stageId),error=>error.code==='CLOSED');await sleep(10);assert.deepEqual(f.seen,['initialize','stage','dispose']);}
 finally{await f.finish(closing);}
});
