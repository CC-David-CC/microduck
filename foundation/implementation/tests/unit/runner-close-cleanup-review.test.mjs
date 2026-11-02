import test from 'node:test';
import assert from 'node:assert/strict';
import {MessageChannel as NativeChannel} from 'node:worker_threads';
import {setTimeout as sleep} from 'node:timers/promises';
import {connectRunner} from '../../src/isolation/runner-client.ts';

test('owner remove failure rejects concurrent and later callers and closes every port',async()=>{
 const keys=['HTMLIFrameElement','document','location','addEventListener','removeEventListener','MessageChannel'];
 const prior=Object.fromEntries(keys.map(k=>[k,globalThis[k]]));const closed=[];let listener,frame,control,request,receive;
 class Channel {constructor(){const c=new NativeChannel();this.port1=c.port1;this.port2=c.port2;
  for(const port of [this.port1,this.port2]){const close=port.close.bind(port);port.close=()=>{closed.push(port);close();};}}}
 class Frame {constructor(){this.value=false;this.contentWindow={postMessage:(message,origin,ports)=>{control=ports[1];control.onmessage=e=>{request=e.data;receive();};control.start();}};}
  get credentialless(){return this.value;} set credentialless(v){this.value=v;} addEventListener(){} remove(){throw new Error('remove failed');}}
 globalThis.MessageChannel=Channel;globalThis.HTMLIFrameElement=Frame;globalThis.document={createElement(){return frame=new Frame();}};
 globalThis.location={origin:'http://app.invalid'};globalThis.addEventListener=(kind,fn)=>{if(kind==='message')listener=fn;};
 globalThis.removeEventListener=(kind,fn)=>{if(kind==='message'&&listener===fn)listener=null;};
 const mount={append(element){queueMicrotask(()=>listener({source:element.contentWindow,origin:'http://runner.invalid',ports:[],
  data:{version:1,kind:'c1-frame-ready',challenge:new URL(element.src).searchParams.get('challenge')}}));}};
 try{
  const owner=await (await import('../../src/isolation/runner-host.ts')).openRunnerFrame({mount,runnerOrigin:'http://runner.invalid',frameURL:'http://runner.invalid/frame',timeoutMs:500});
  const received=new Promise(resolve=>{receive=resolve;});const first=owner.close(),second=owner.close();first.catch(()=>{});second.catch(()=>{});await received;
  control.postMessage({version:1,kind:'termination-requested',request_id:request.request_id});
  const outcomes=await Promise.allSettled([first,second,owner.close()]);
  assert.ok(outcomes.every(x=>x.status==='rejected'&&/remove failed/.test(x.reason.message)));
  await assert.rejects(owner.close(),/remove failed/);
  assert.equal(new Set(closed).size,6,'all six owned ports close despite removal failure');
 }finally{Object.assign(globalThis,prior);control?.close();}
});

test('client repeated close after dispose failure preserves rejection',async()=>{
 const data=new NativeChannel(),lifecycle=new NativeChannel();
 data.port2.onmessage=e=>{const m=e.data;if(m.kind==='initialize')data.port2.postMessage({request_id:m.request_id,kind:'initialized'});
  if(m.kind==='dispose')data.port2.postMessage({request_id:m.request_id,kind:'error',code:'CONTROLLER_FAULT'});};data.port2.start();
 lifecycle.port2.onmessage=e=>lifecycle.port2.postMessage({version:1,kind:'termination-requested',request_id:e.data.request_id});lifecycle.port2.start();
 const identity={session_id:'s',project_revision:'a'.repeat(64),run_epoch:0};
 const client=await connectRunner({dataPort:data.port1,lifecyclePort:lifecycle.port1,source:'',sourceId:'close-test',identity,groupId:'g',ownerId:'o',leaseGeneration:1,timeoutMs:500});
 try{await client.initialize({group_id:'g',control_size:1,inputs:[{}],control_stride:1,observations:[]},{});
  await assert.rejects(client.close(),error=>error.code==='CONTROLLER_FAULT');await assert.rejects(client.close(),error=>error.code==='CONTROLLER_FAULT');}
 finally{data.port2.close();lifecycle.port2.close();}
});
