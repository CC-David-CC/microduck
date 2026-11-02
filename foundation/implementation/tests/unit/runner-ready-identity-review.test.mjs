import test from 'node:test';
import assert from 'node:assert/strict';
import {openRunnerFrame} from '../../src/isolation/runner-host.ts';

test('runner ready requires matching source, origin, challenge and message shape',async()=>{
 const prior={HTMLIFrameElement:globalThis.HTMLIFrameElement,document:globalThis.document,location:globalThis.location,addEventListener:globalThis.addEventListener,removeEventListener:globalThis.removeEventListener};
 let listener,frame,bootstrapCount=0,remoteControl;
 class Frame {
  constructor(){this.value=false;this.contentWindow={postMessage:(_message,_origin,ports)=>{bootstrapCount++;remoteControl=ports[1];remoteControl.onmessage=e=>remoteControl.postMessage({version:1,kind:'termination-requested',request_id:e.data.request_id});remoteControl.start()}}}
  get credentialless(){return this.value} set credentialless(v){this.value=v}
  addEventListener(){} remove(){this.removed=true}
 }
 globalThis.HTMLIFrameElement=Frame;globalThis.document={createElement:()=>frame=new Frame()};globalThis.location={origin:'http://app.invalid'};
 globalThis.addEventListener=(name,fn)=>{if(name==='message')listener=fn};globalThis.removeEventListener=(name,fn)=>{if(name==='message'&&listener===fn)listener=null};
 const mount={append(element){queueMicrotask(()=>{
  const challenge=new URL(element.src).searchParams.get('challenge'),data={version:1,kind:'c1-frame-ready',challenge};
  listener({source:{},origin:'http://runner.invalid',ports:[],data});
  listener({source:element.contentWindow,origin:'http://other.invalid',ports:[],data});
  listener({source:element.contentWindow,origin:'http://runner.invalid',ports:[],data:{...data,challenge:'wrong'}});
  listener({source:element.contentWindow,origin:'http://runner.invalid',ports:[],data:{...data,extra:true}});
  listener({source:element.contentWindow,origin:'http://runner.invalid',ports:[{}],data});
  assert.equal(bootstrapCount,0,'invalid events must not bootstrap');
  listener({source:element.contentWindow,origin:'http://runner.invalid',ports:[],data});
 })}};
 try{
  const owner=await openRunnerFrame({mount,runnerOrigin:'http://runner.invalid',frameURL:'http://runner.invalid/frame',timeoutMs:1000});
  assert.equal(bootstrapCount,1);assert.equal(frame.credentialless,true);await owner.close();assert.equal(frame.removed,true);
 }finally{remoteControl?.close();Object.assign(globalThis,prior)}
});
