import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createMicroduckRunnerLoader, MICRODUCK_SOURCE, MICRODUCK_SOURCE_PATH} from '../runner-loader.mjs';

const modelPath=process.env.MICRODUCK_POLICY;
if(!modelPath) throw Error('MICRODUCK_POLICY is required');
const model=new Uint8Array(await readFile(modelPath));
const wasm=new Uint8Array(await readFile(new URL('../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm',import.meta.url)));
function fake(){
 let creates=0;
 const runtime={env:{wasm:{}},Tensor:class Tensor{},InferenceSession:{async create(){creates++;return {inputNames:['input'],outputNames:['output'],async run(){return {output:{data:new Float32Array(14)}}},async release(){}}}}};
 return {runtime,creates:()=>creates};
}
test('only the explicitly declared built-in adapter is loaded, once, with pinned assets',async()=>{
 const f=fake(), m=model.slice(), w=wasm.slice();
 const load=createMicroduckRunnerLoader({runtime:f.runtime,modelBytes:m,wasmBytes:w});
 m.fill(0);w.fill(0);
 const c=await load(MICRODUCK_SOURCE,MICRODUCK_SOURCE_PATH,{control_size:14});
 assert.deepEqual(c.initialize(),Array(14).fill(0));
 assert.equal(f.creates(),1);
 assert.equal(f.runtime.env.wasm.numThreads,1);
 assert.equal(f.runtime.env.wasm.wasmBinary[1],0x61); // WebAssembly magic
 await assert.rejects(load(MICRODUCK_SOURCE,MICRODUCK_SOURCE_PATH,{control_size:14}));
 await c.dispose();
});
for (const [name,change] of [
 ['different source',(x)=>{x.source+=' '}],
 ['different path',(x)=>{x.sourceId='controllers/other.mjs'}],
 ['wrong actuator width',(x)=>{x.descriptor.control_size=13}],
 ['tampered model',(x)=>{x.model[0]^=1}],
 ['tampered runtime',(x)=>{x.wasm[0]^=1}],
]) test('rejects '+name+' before creating any session',async()=>{
 const f=fake(),x={source:MICRODUCK_SOURCE,sourceId:MICRODUCK_SOURCE_PATH,descriptor:{control_size:14},model:model.slice(),wasm:wasm.slice()};
 change(x);
 const load=createMicroduckRunnerLoader({runtime:f.runtime,modelBytes:x.model,wasmBytes:x.wasm});
 await assert.rejects(load(x.source,x.sourceId,x.descriptor));
 assert.equal(f.creates(),0);
 assert.equal(f.runtime.env.wasm.wasmBinary,undefined);
});
