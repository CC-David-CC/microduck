import test from 'node:test';import assert from 'node:assert/strict';
import {createFileActions,rememberOpenedFile} from '../file-actions.mjs';
function fixture(){
 let valid=true,current=true,writes=[],opened=null;
 const context={owner:'alice',valid:()=>valid,path:x=>x,name:x=>x,files:{async stat(){throw Error('File not found.')},async read(){return {data:new TextEncoder().encode('saved'),version:'v1',status:'synced'}},async write(...args){writes.push(args);return {version:'v2',status:'pending'}}}};
 const host={signal:new AbortController().signal,ui:{prompt:async()=> 'Microduck.brf'},storage:{signedInSubject:()=>'alice',pickFolder:async()=>'/Robot',pickFile:async()=>'/Robot/Microduck.brf',mirrorFileContext:async()=>context}};
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
 f.context.files.stat=async()=>({version:'v1',status:'synced'});
 await a.open();assert.equal(f.opened(),'saved');
 f.context.files.read=async()=>({data:new Uint8Array([1]),status:'conflict',version:'v2'});
 await assert.rejects(a.open(),/conflict/i);
});

test('an existing file is replaced only after confirmation with its observed version',async()=>{
 const f=fixture();f.context.files.stat=async()=>({version:'old',status:'synced'});f.host.ui.confirm=async()=>true;
 const a=createFileActions(f.host,()=>f.application,()=>true);
 await a.saveAs();assert.equal(f.writes[0][2],'old');
});
test('canceling replacement preserves the existing file',async()=>{
 const f=fixture();f.context.files.stat=async()=>({version:'old',status:'synced'});f.host.ui.confirm=async()=>false;
 const a=createFileActions(f.host,()=>f.application,()=>true);
 assert.equal(await a.saveAs(),null);assert.equal(f.writes.length,0);
});
test('a session changed while writing is not reported as the current saved snapshot',async()=>{
 const f=fixture();let finish,started;const writing=new Promise(resolve=>{started=resolve});
 f.context.files.write=async()=>{started();return await new Promise(resolve=>{finish=resolve})};
 const saving=createFileActions(f.host,()=>f.application,()=>true).saveAs();await writing;
 f.setStale();finish({version:'v2',status:'pending'});
 const result=await saving;assert.equal(result.current,false);assert.equal(result.status,'pending');
});
test('the user chooses a project filename and cancellation or a wrong extension does not write',async()=>{
 const f=fixture(),a=createFileActions(f.host,()=>f.application,()=>true);
 f.host.ui.prompt=async()=> 'Robot walk.brf';assert.equal((await a.saveAs()).path,'/Robot/Robot walk.brf');
 f.host.ui.prompt=async()=>null;assert.equal(await a.saveAs(),null);
 f.host.ui.prompt=async()=> 'robot.txt';await assert.rejects(a.saveAs(),/\.brf/);assert.equal(f.writes.length,1);
});
test('direct file handoff rechecks the version after the candidate opens',async()=>{
 const f=fixture();let version='v1';f.context.files.stat=async()=>({version,status:'synced'});
 f.application.replaceFile=async(_file,_current,precommit)=>{version='v2';await precommit()};
 const a=createFileActions(f.host,()=>f.application,()=>true);
 await assert.rejects(a.open('/Robot/walk.brf'),/changed while opening/);
 await assert.rejects(a.open('/Robot/walk.txt'),/\.brf/);
});
test('layout path advances only for a successful current-account open',()=>{
 const controller=new AbortController();let owner='alice',saves=0;
 const host={w:{launchContext:{path:'/old.brf'}},signal:controller.signal,storage:{signedInSubject:()=>owner},desktop:{saveLayout(){saves++}}};
 assert.equal(rememberOpenedFile(host,null),false);assert.equal(host.w.launchContext.path,'/old.brf');
 owner='bob';assert.equal(rememberOpenedFile(host,{owner:'alice',path:'/new.brf'}),false);assert.equal(host.w.launchContext.path,'/old.brf');
 owner='alice';assert.equal(rememberOpenedFile(host,{owner:'alice',path:'/new.brf'}),true);assert.deepEqual(host.w.launchContext,{version:1,storage:'mirror',owner:'alice',path:'/new.brf'});assert.equal(saves,1);
 controller.abort();assert.equal(rememberOpenedFile(host,{owner:'alice',path:'/late.brf'}),false);assert.equal(host.w.launchContext.path,'/new.brf');
});
