import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as ort from '../node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs';
import {createMicroduckPolicy} from '../policy.mjs';
const model=process.env.MICRODUCK_POLICY;if(!model)throw Error('MICRODUCK_POLICY required');
const bytes=await readFile(model),fixture=JSON.parse(await readFile(new URL('./fixtures/turn-native-reference.json',import.meta.url))); ort.env.wasm.numThreads=1;
test('turning policy matches the independently captured native-physics trajectory at every boundary',async()=>{
 assert.equal(fixture.engine,'3.17.0');assert.equal(fixture.steps_per_action,4);assert.equal(fixture.timestep,.005);assert.equal(fixture.policy_steps,100);
 const policy=await createMicroduckPolicy({runtime:ort,modelBytes:new Uint8Array(bytes),expectedSha256:'e36332d383997d51401897734cd3e79cf5038406feddb18b4d57ecfb141daa6c'});let maxAction=0,maxControl=0;
 try{for(const [key,turn] of [['left',.5],['right',-.5]]){let previous=Array(14).fill(0);assert.equal(fixture[key].length,100);for(const [i,row] of fixture[key].entries()){assert.equal(row.sample.capture_tick,4*i);assert.equal(row.observation[48],.25);assert.equal(row.observation[50],turn);assert.deepEqual(row.observation.slice(34,48),previous);const out=await policy.evaluate(row.sample,previous,.25,turn);for(let j=0;j<14;j++){maxAction=Math.max(maxAction,Math.abs(out.action[j]-row.action[j]));maxControl=Math.max(maxControl,Math.abs(out.control[j]-row.control[j]))}previous=row.action;}}
 assert.ok(maxAction<1e-6&&maxControl<1e-6,`action=${maxAction} control=${maxControl}`);assert.ok(fixture.left.at(-1).qpos[6]>0);assert.ok(fixture.right.at(-1).qpos[6]<0);console.log(JSON.stringify({sides:2,boundariesPerSide:100,maxAction,maxControl,runtime:'onnxruntime-web 1.31.1',reference:fixture.runtime}));}finally{await policy.close()}
});
