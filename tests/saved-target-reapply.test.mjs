import test from 'node:test';import assert from 'node:assert/strict';import {readSavedTarget} from '../foundation/implementation/src/web/saved-target-reapply.ts';
const rev='a'.repeat(64),identity={session_id:'old',project_revision:rev,run_epoch:0};
const bits=value=>{const d=new DataView(new ArrayBuffer(8));d.setFloat64(0,value,false);return d.getBigUint64(0,false).toString(16).padStart(16,'0')};
const row=(value,status='accepted',epoch=0)=>({identity:{...identity,run_epoch:epoch},group_id:'all',field:'speed',value_bits:bits(value),status,tick:status==='accepted'?0:null,lease_generation:status==='accepted'?1:null});
const file=(entries,truncated=false)=>new Blob([JSON.stringify({schema_version:2,entries,truncated})]);
test('selects the latest accepted target from the latest epoch without granting authority',async()=>{
 assert.deepEqual(await readSavedTarget(file([row(.1),row(.2),row(.25,'accepted',1)]),rev),{group_id:'all',field:'speed',value:.25,source_epoch:1,source_tick:0,provenance:'unverified'});
});
test('refuses incomplete or unknown history, other revisions and no accepted target in the latest epoch',async()=>{
 await assert.rejects(readSavedTarget(file([row(.2)],true),rev));
 await assert.rejects(readSavedTarget(file([row(.2),row(.3,'unknown')]),rev));
 await assert.rejects(readSavedTarget(file([row(.2)]),'b'.repeat(64)));
 await assert.rejects(readSavedTarget(file([row(.2),row(.3,'rejected',1)]),rev));
});
