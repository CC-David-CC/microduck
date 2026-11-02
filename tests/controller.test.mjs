import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createMicroduckController} from '../controller.mjs';

const samples=JSON.parse(await readFile(new URL('./fixtures/granted-truth.json',import.meta.url)));
const obs=(index)=>({tick:samples[index].capture_tick,samples:{'microduck.truth':samples[index]}});
test('controller stages policy output without committing its memory',async()=>{
  const calls=[];
  const policy={async evaluate(sample,previous,speed){calls.push({sample,previous:[...previous],speed});return {action:Array(14).fill(2),control:Array(14).fill(3)}},async close(){}};
  const controller=createMicroduckController(policy);
  const committed=controller.initialize();
  const first=await controller.step(obs(0),{speed:.25},committed);
  assert.deepEqual(committed,Array(14).fill(0));
  assert.deepEqual(first,{control:Array(14).fill(3),memory:Array(14).fill(2)});
  await controller.step(obs(1),{speed:0},committed);
  assert.deepEqual(calls[1].previous,Array(14).fill(0));
  await controller.step(obs(1),{speed:0},first.memory);
  assert.deepEqual(calls[2].previous,Array(14).fill(2));
  await controller.dispose();
});
test('rejects stale or missing truth before inference and disposes once',async()=>{
  let calls=0,closes=0;
  const policy={async evaluate(){calls++;throw Error('unexpected')},async close(){closes++}};
  const controller=createMicroduckController(policy);
  await assert.rejects(controller.step({...obs(0),tick:1},{speed:0},controller.initialize()));
  await assert.rejects(controller.step({tick:0,samples:{}},{speed:0},controller.initialize()));
  assert.equal(calls,0);
  await Promise.all([controller.dispose(),controller.dispose()]);
  assert.equal(closes,1);
  await assert.rejects(controller.step(obs(0),{speed:0},Array(14).fill(0)));
});
