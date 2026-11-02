import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageChannel} from 'node:worker_threads';
import {setTimeout as sleep} from 'node:timers/promises';
import {connectRunner} from '../../src/isolation/runner-client.ts';

const turn=()=>sleep(10);
const track=p=>{let settled=false;void p.then(()=>{settled=true},()=>{settled=true});return ()=>settled;};

test('concurrent client close calls wait for the same lifecycle termination',async()=>{
 const data=new MessageChannel(),lifecycle=new MessageChannel();
 const client=await connectRunner({dataPort:data.port1,lifecyclePort:lifecycle.port1,source:'',sourceId:'close-test',
  identity:{session_id:'s',project_revision:'a'.repeat(64),run_epoch:0},groupId:'g',ownerId:'o',leaseGeneration:1,timeoutMs:500});
 let request;const received=new Promise(resolve=>{lifecycle.port2.onmessage=e=>{request=e.data;resolve();};lifecycle.port2.start();});
 const first=client.close(),firstDone=track(first);await received;
 const second=client.close(),secondDone=track(second);
 try{await turn();assert.equal(firstDone(),false);assert.equal(secondDone(),false,'second close must await pending termination');}
 finally{lifecycle.port2.postMessage({version:1,kind:'termination-requested',request_id:request.request_id});await Promise.allSettled([first,second]);data.port2.close();lifecycle.port2.close();}
});

test('concurrent Window owner close calls wait until the frame has been removed',async()=>{
 const prior={HTMLIFrameElement:globalThis.HTMLIFrameElement,document:globalThis.document,location:globalThis.location,
  addEventListener:globalThis.addEventListener,removeEventListener:globalThis.removeEventListener};
 let listener,frame,control,request,receive;
 class Frame { constructor(){this.value=false;this.contentWindow={postMessage:(message,origin,ports)=>{
    control=ports[1];control.onmessage=e=>{request=e.data;receive();};control.start();}};}
  get credentialless(){return this.value;} set credentialless(value){this.value=value;}
  addEventListener(){} remove(){this.removed=true;}}
 globalThis.HTMLIFrameElement=Frame;globalThis.document={createElement(){return frame=new Frame();}};
 globalThis.location={origin:'http://app.invalid'};
 globalThis.addEventListener=(kind,fn)=>{if(kind==='message')listener=fn;};
 globalThis.removeEventListener=(kind,fn)=>{if(kind==='message'&&listener===fn)listener=null;};
 const mount={append(element){queueMicrotask(()=>listener({source:element.contentWindow,origin:'http://runner.invalid',ports:[],
  data:{version:1,kind:'c1-frame-ready',challenge:new URL(element.src).searchParams.get('challenge')}}));}};
 let first,second;
 try{
  const owner=await (await import('../../src/isolation/runner-host.ts')).openRunnerFrame({mount,runnerOrigin:'http://runner.invalid',frameURL:'http://runner.invalid/frame',timeoutMs:500});
  const received=new Promise(resolve=>{receive=resolve;});
  first=owner.close();const firstDone=track(first);await received;
  second=owner.close();const secondDone=track(second);
  try{await turn();assert.equal(firstDone(),false);assert.equal(frame.removed,undefined);assert.equal(secondDone(),false,'second close must await removal');}
  finally{control.postMessage({version:1,kind:'termination-requested',request_id:request.request_id});await Promise.allSettled([first,second]);control.close();}
  assert.equal(frame.removed,true);
 }finally{Object.assign(globalThis,prior);}
});

async function initializedClient(){
 const data=new MessageChannel(),lifecycle=new MessageChannel();
 data.port2.onmessage=e=>{const m=e.data;if(m.kind==='initialize')data.port2.postMessage({request_id:m.request_id,kind:'initialized'});
  else if(m.kind==='stage')data.port2.postMessage({request_id:m.request_id,kind:'stage',stageId:m.stageId,authority:m.authority,control:[1]});
  else if(m.kind==='dispose')data.port2.postMessage({request_id:m.request_id,kind:'error',code:'CONTROLLER_FAULT'});};data.port2.start();
 const identity={session_id:'s',project_revision:'a'.repeat(64),run_epoch:0};
 const client=await connectRunner({dataPort:data.port1,lifecyclePort:lifecycle.port1,source:'',sourceId:'close-test',identity,groupId:'g',ownerId:'o',leaseGeneration:1,timeoutMs:500});
 await client.initialize({group_id:'g',control_size:1,inputs:[{}],control_stride:1,observations:[]},{});
 return {client,data,lifecycle,identity};
}

test('client close waits for an already-started abort termination',async()=>{
 const {client,data,lifecycle,identity}=await initializedClient();
 const staged=await client.stage({observation:{...identity,tick:0,sim_time:0,dt:0,samples:{}},intent:{},sequence:1,applyTick:0});
 let request;const received=new Promise(resolve=>{lifecycle.port2.onmessage=e=>{request=e.data;resolve();};lifecycle.port2.start();});
 const aborting=client.abort(staged.stageId),abortDone=track(aborting);await received;
 const closing=client.close(),closeDone=track(closing);
 try{await turn();assert.equal(abortDone(),false);assert.equal(closeDone(),false,'close must await already-started termination');}
 finally{lifecycle.port2.postMessage({version:1,kind:'termination-requested',request_id:request.request_id});await Promise.allSettled([aborting,closing]);data.port2.close();lifecycle.port2.close();}
});

test('overlapping client close callers observe the same dispose failure',async()=>{
 const {client,data,lifecycle}=await initializedClient();
 let request;const received=new Promise(resolve=>{lifecycle.port2.onmessage=e=>{request=e.data;resolve();};lifecycle.port2.start();});
 const first=client.close();first.catch(()=>{});await received;
 const second=client.close();second.catch(()=>{});const secondDone=track(second);
 try{await turn();assert.equal(secondDone(),false,'second close must await the failed disposal cleanup');}
 finally{lifecycle.port2.postMessage({version:1,kind:'termination-requested',request_id:request.request_id});const outcomes=await Promise.allSettled([first,second]);data.port2.close();lifecycle.port2.close();
  assert.equal(outcomes[0].status,'rejected');assert.equal(outcomes[1].status,'rejected');}
});
