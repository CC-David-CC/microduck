import test from 'node:test';import assert from 'node:assert/strict';import {replayTargetSchedule} from '../replay-target-schedule.mjs';
const revision='a'.repeat(64),id={session_id:'new',project_revision:revision,run_epoch:0};
const entry=(tick,value)=>({identity:{session_id:'old',project_revision:revision,run_epoch:0},group_id:'all',field:'speed',value,status:'accepted',tick,lease_generation:1});
function fixture(start=0){let tick=start,closed=0;const calls=[];const session={identity:id,targets:[{group_id:'all',field:'speed',min:0,max:.25}],async inspect(){return {identity:id,plant:{tick}}},async acquireAttempt(){return {async setTarget(x){calls.push(['target',tick,x.value]);return {status:'accepted',identity:id,tick,group_id:x.group_id,field:x.field,value:x.value}},async step(n){calls.push(['step',n]);tick+=n;return {identity:id,steps_completed:n,inspection:{identity:id,plant:{tick}}}},async finish(){closed++}}}};return {session,calls,closed:()=>closed}}
test('replays target changes at their recorded ticks through one exclusive lease',async()=>{
 const f=fixture(),history={kind:'structural-only',provenance:'unverified',complete:true,truncated:false,unknown:false,entries:[entry(0,.1),entry(4,.25)]};
 const result=await replayTargetSchedule(f.session,history,8);
 assert.equal(result.status,'completed');assert.equal(result.last_verified_tick,8);assert.deepEqual(f.calls,[['target',0,.1],['step',4],['target',4,.25],['step',4]]);assert.equal(f.closed(),1);
});
test('rejects incomplete, unsupported or unpermitted histories before acquiring a lease',async()=>{
 for(const changes of [{complete:false},{entries:[{...entry(0,.1),status:'rejected'}]},{entries:[entry(0,.3)]},{entries:[entry(5,.1),entry(4,.2)]},{entries:[entry(1,.1)]}]){
  const f=fixture(),h={kind:'structural-only',provenance:'unverified',complete:true,truncated:false,unknown:false,entries:[entry(0,.1)],...changes};
  await assert.rejects(replayTargetSchedule(f.session,h,8));assert.equal(f.closed(),0);assert.deepEqual(f.calls,[]);
 }
});
test('a nonzero starting tick is not a fresh experiment and releases the lease',async()=>{
 const f=fixture(1),h={kind:'structural-only',provenance:'unverified',complete:true,truncated:false,unknown:false,entries:[entry(0,.1)]};
 const result=await replayTargetSchedule(f.session,h,8);assert.equal(result.status,'not-started');assert.equal(f.closed(),1);assert.deepEqual(f.calls,[]);
});
test('an unknown step outcome is never claimed complete',async()=>{
 const f=fixture(),original=f.session.acquireAttempt;f.session.acquireAttempt=async()=>{const lease=await original();lease.step=async()=>{throw Error('lost response')};return lease};
 const h={kind:'structural-only',provenance:'unverified',complete:true,truncated:false,unknown:false,entries:[entry(0,.1)]};
 const result=await replayTargetSchedule(f.session,h,8);assert.equal(result.status,'unknown');assert.equal(result.last_verified_tick,0);assert.equal(f.closed(),1);
});
