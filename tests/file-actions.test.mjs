import test from 'node:test';import assert from 'node:assert/strict';
import {createFileActions} from '../file-actions.mjs';
function fixture(){
 let valid=true,current=true,writes=[],opened=null;
 const context={owner:'alice',valid:()=>valid,path:x=>x,name:x=>x,files:{async read(){return {data:new TextEncoder().encode('saved'),version:'v1',status:'synced'}},async write(...args){writes.push(args);return {version:'v2',status:'pending'}}}};
 const host={signal:new AbortController().signal,storage:{signedInSubject:()=>'alice',pickFolder:async()=>'/Robot',pickFile:async()=>'/Robot/Microduck.brf',mirrorFileContext:async()=>context}};
 const application={captureFile:async()=>({blob:new Blob(['project']),isCurrent:()=>current}),replaceFile:async f=>{opened=await f.text()}};
 return {host,application,writes,context,setInvalid:()=>{valid=false},setStale:()=>{current=false},opened:()=>opened};
}
test('save writes the captured project as a new account file and reports pending sync',async()=>{
 const f=fixture(),a=createFileActions(f.host,()=>f.application,()=>true);
 const result=await a.saveAs();
 assert.equal(result.path,'/Robot/Microduck.brf');assert.equal(result.status,'pending');
 assert.equal(f.writes.length,1);assert.equal(f.writes[0][2],null);assert.equal(new TextDecoder().decode(f.writes[0][1]),'project');
});
test('does not write when the account or captured session changes',async()=>{
 for(const change of ['account','session']){
  const f=fixture();f.application.captureFile=async()=>{if(change==='account')f.setInvalid();else f.setStale();return {blob:new Blob(['project']),isCurrent:()=>change!=='session'}};
  const a=createFileActions(f.host,()=>f.application,()=>true);
  await assert.rejects(a.saveAs());assert.equal(f.writes.length,0);
 }
});
test('opens the selected account file and rejects conflicts',async()=>{
 const f=fixture(),a=createFileActions(f.host,()=>f.application,()=>true);
 await a.open();assert.equal(f.opened(),'saved');
 f.context.files.read=async()=>({data:new Uint8Array([1]),status:'conflict',version:'v2'});
 await assert.rejects(a.open(),/conflict/i);
});

test('an existing file is replaced only after confirmation with its observed version',async()=>{
 const f=fixture();f.context.files.stat=async()=>({version:'old',status:'synced'});f.host.ui={confirm:async()=>true};
 const a=createFileActions(f.host,()=>f.application,()=>true);
 await a.saveAs();assert.equal(f.writes[0][2],'old');
});
test('canceling replacement preserves the existing file',async()=>{
 const f=fixture();f.context.files.stat=async()=>({version:'old',status:'synced'});f.host.ui={confirm:async()=>false};
 const a=createFileActions(f.host,()=>f.application,()=>true);
 assert.equal(await a.saveAs(),null);assert.equal(f.writes.length,0);
});
