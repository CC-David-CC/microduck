import test from 'node:test';import assert from 'node:assert/strict';import {createDriveGrant} from '../drive-grant.mjs';
const id=()=>({session_id:'s',project_revision:'a'.repeat(64),run_epoch:0});
test('agent drive is denied until explicitly granted and uses the same session target operation',async()=>{
 let calls=[];const session={identity:id(),async setTarget(x){calls.push(x);return {status:'accepted',value:x.value}}};
 const gate=createDriveGrant(()=>session);await assert.rejects(gate.drive({speed:.2}),/grant/i);assert.deepEqual(calls,[]);
 gate.enable();const result=await gate.drive({speed:.2});assert.equal(result.status,'accepted');assert.deepEqual(calls,[{group_id:'all',field:'speed',value:.2}]);
 for(const value of [-.1,.3,NaN])await assert.rejects(gate.drive({speed:value}));
 await assert.rejects(gate.drive({speed:.1,extra:1}));assert.equal(calls.length,1);
 gate.revoke();await assert.rejects(gate.drive({speed:.1}));
});
test('a new epoch invalidates the grant and revocation during a pending command reports unknown',async()=>{
 let resolve;const session={identity:id(),setTarget:()=>new Promise(r=>{resolve=r})};const gate=createDriveGrant(()=>session);
 gate.enable();session.identity={...session.identity,run_epoch:1};await assert.rejects(gate.drive({speed:.1}));gate.enable();
 const pending=gate.drive({speed:.1});gate.revoke();resolve({status:'accepted',value:.1});
 assert.deepEqual(await pending,{status:'unknown'});
});
