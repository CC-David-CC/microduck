import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier,ctx,next){
 if(specifier.endsWith('.css'))return {shortCircuit:true,url:'data:text/javascript,export default {}'};
 if(specifier.endsWith('/web/project-application.ts'))return {shortCircuit:true,url:'data:text/javascript,export function mountProjectApplication(o){return globalThis.__microduckTest.mount(o)}'};
 return next(specifier,ctx);
}});
const {mount}=await import('../index.mjs');
const file=process.env.MICRODUCK_BUILTIN_PROJECT;
if(!file)throw Error('MICRODUCK_BUILTIN_PROJECT required');
const project=await readFile(file);
class Element {
 constructor(){this.children=[];this.textContent='';this.className='';this.attributes={};}
 append(...nodes){this.children.push(...nodes)} setAttribute(k,v){this.attributes[k]=v} addEventListener(){}
}
const tick=()=>new Promise(r=>setTimeout(r,10));
test('desktop mount loads the verified project and closes its owned application once',async()=>{
 const oldDoc=globalThis.document,oldFetch=globalThis.fetch;let selected,options,closed=0;
 globalThis.document={createElement:()=>new Element()};
 globalThis.__microduckTest={mount(o){options=o;return {openFile(f){selected=f},async dispose(){closed++}}}};
 globalThis.fetch=async()=>new Response(project,{status:200,headers:{'content-length':String(project.length)}});
 const signal=new AbortController(), windowState={};
 try{
  const view=mount({signal:signal.signal,w:windowState,microduckRunnerOrigin:'https://runner.example'});
  assert.equal(view.element.className,'window-content microduck-app');
  for(let i=0;i<50&&!selected;i++)await tick();
  assert.ok(selected instanceof File);
  options.onSessionPublished();assert.equal(windowState.microduck.dirty,true);
  assert.equal(selected.size,project.length);
  assert.equal((await options.resolveTrusted('0183b6ea156fbb779121ecdb9b4c0ee205cdfec652eb427c4326b1064868ac2a')).runnerOrigin,'https://runner.example');
  assert.equal(await options.resolveTrusted('a'.repeat(64)),null);
  view.dispose();view.dispose();await tick();assert.equal(closed,1);windowState.microduck.dirty=false;options.onSessionPublished();assert.equal(windowState.microduck.dirty,false);
 }finally{globalThis.document=oldDoc;globalThis.fetch=oldFetch;delete globalThis.__microduckTest}
});
test('disposal before the built-in asset arrives cannot open a late session',async()=>{
 const oldDoc=globalThis.document,oldFetch=globalThis.fetch;let release,opened=0,closed=0,mounted=0;
 globalThis.document={createElement:()=>new Element()};
 globalThis.__microduckTest={mount(){mounted++;return {openFile(){opened++},async dispose(){closed++}}}};
 globalThis.fetch=()=>new Promise(resolve=>{release=resolve});
 try{
  const view=mount({signal:new AbortController().signal,microduckRunnerOrigin:'https://runner.example'});
  await tick();view.dispose();release(new Response(project,{status:200}));
  await tick();assert.equal(opened,0);assert.equal(mounted,0);assert.equal(closed,0);
 }finally{globalThis.document=oldDoc;globalThis.fetch=oldFetch;delete globalThis.__microduckTest}
});
