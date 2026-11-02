import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {MICRODUCK_SOURCE,MICRODUCK_SOURCE_PATH} from '../runner-loader.mjs';
import {createOneShotNativeJsLoader} from '../runner-native-loader.mjs';
const model=new Uint8Array(await readFile(process.env.MICRODUCK_POLICY));
const wasm=new Uint8Array(await readFile(new URL('../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',import.meta.url)));
function fakeRuntime(){return {env:{wasm:{}},Tensor:class {},InferenceSession:{async create(){return {inputNames:['i'],outputNames:['o'],async run(){return {o:{data:new Float32Array(14)}}},async release(){}}}}}}
function response(data,url){const result=new Response(data,{status:200,headers:{'content-length':String(data.length)}});Object.defineProperty(result,'url',{value:url});return result}
test('loads only pinned first-party assets and returns a staged controller',async()=>{
 const requested=[];
 const fetch=async url=>{requested.push(url);return response(url.endsWith('/microduck-policy.onnx')?model:wasm,url)};
 const loader=createOneShotNativeJsLoader({runtime:fakeRuntime(),fetch,origin:'https://runner.example'});
 const loaded=await loader(MICRODUCK_SOURCE,MICRODUCK_SOURCE_PATH,{control_size:14});
 assert.equal(loaded.ok,true);
 assert.deepEqual(requested.sort(),['https://runner.example/microduck-policy.onnx','https://runner.example/microduck-runtime.wasm']);
 assert.deepEqual(loaded.controller.initialize(),Array(14).fill(0));
 assert.equal((await loader(MICRODUCK_SOURCE,MICRODUCK_SOURCE_PATH,{control_size:14})).ok,false);
 await loaded.controller.dispose();
});
test('rejects arbitrary imported source without a network request or evaluation',async()=>{
 let fetched=0;globalThis.__microduckExecuted=false;
 const loader=createOneShotNativeJsLoader({runtime:fakeRuntime(),fetch:async()=>{fetched++;throw Error('unexpected')},origin:'https://runner.example'});
 const result=await loader('globalThis.__microduckExecuted=true',MICRODUCK_SOURCE_PATH,{control_size:14});
 assert.equal(result.ok,false);assert.equal(fetched,0);assert.equal(globalThis.__microduckExecuted,false);
 delete globalThis.__microduckExecuted;
});
test('rejects oversized response without reading its body',async()=>{
 let reads=0;
 const stream=new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array(10));c.close()}});
 const loader=createOneShotNativeJsLoader({runtime:fakeRuntime(),origin:'https://runner.example',fetch:async url=>{const r=new Response(stream,{headers:{'content-length':String(25*1024*1024)}});Object.defineProperty(r,'url',{value:url});return r}});
 const result=await loader(MICRODUCK_SOURCE,MICRODUCK_SOURCE_PATH,{control_size:14});
 assert.equal(result.ok,false);
 // A ReadableStream may prefetch once; it must not be drained.
 assert.ok(reads<=1);
});
