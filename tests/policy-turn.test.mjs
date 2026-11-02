import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createMicroduckPolicy} from '../policy.mjs';
import {createMicroduckController} from '../controller.mjs';
const bytes=new TextEncoder().encode('turn-fixture'),hash=createHash('sha256').update(bytes).digest('hex');
const sample={validity:'valid',values:[1,2,3,1,0,0,0,...Array(28).fill(0)],sequence:1,capture_tick:0,available_tick:0};
function runtime(){const seen=[];return {seen,Tensor:class{constructor(type,data,dims){this.data=data}},InferenceSession:{async create(){return {inputNames:['in'],outputNames:['out'],async run(feed){seen.push(Array.from(feed.in.data));return {out:{data:new Float32Array(14)}}},async release(){}}}}};}
test('turn target reaches the upstream angular-velocity command slot with legacy zero default',async()=>{
 const r=runtime(),p=await createMicroduckPolicy({runtime:r,modelBytes:bytes,expectedSha256:hash});
 try{for(const turn of [-1,-.5,0,.5,1]){await p.evaluate(sample,Array(14).fill(0),.25,turn);const input=r.seen.at(-1);assert.equal(input[48],.25);assert.equal(input[49],0);assert.equal(input[50],turn);assert.deepEqual(input.slice(51),Array(10).fill(0))}await p.evaluate(sample,Array(14).fill(0),0);assert.equal(r.seen.at(-1)[50],0);for(const bad of [-1.001,1.001,NaN,Infinity,null,'1'])await assert.rejects(p.evaluate(sample,Array(14).fill(0),0,bad));}finally{await p.close()}
});
test('controller forwards the declared turn without altering its staged memory',async()=>{
 const calls=[],p={async evaluate(sample,prev,speed,turn){calls.push({speed,turn,prev:[...prev]});return {action:Array(14).fill(1),control:Array(14).fill(2)}},async close(){}};const c=createMicroduckController(p),memory=c.initialize(),obs={tick:0,samples:{'microduck.truth':sample}};
 await c.step(obs,{speed:.25,turn:-.5},memory);assert.deepEqual(calls[0],{speed:.25,turn:-.5,prev:Array(14).fill(0)});await c.step(obs,{speed:0},memory);assert.equal(calls[1].turn,0);await c.dispose();
});
