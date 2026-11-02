// Replay a structurally inspected target schedule; this is not proof of a
// prior experiment or a full-state checkpoint.
export async function replayTargetSchedule(session,input,endTick,{signal}={}) {
 if(!session||typeof session.acquireAttempt!=='function'||typeof session.inspect!=='function'||!Number.isSafeInteger(endTick)||endTick<1||endTick>4096)throw Error('Invalid replay request');
 const id=structuredClone(session.identity), history=structuredClone(input),targets=structuredClone(session.targets);
 if(!id||typeof id.session_id!=='string'||!id.session_id||!/^[a-f0-9]{64}$/.test(id.project_revision)||!Number.isSafeInteger(id.run_epoch)||id.run_epoch<0||
    !history||history.kind!=='structural-only'||history.provenance!=='unverified'||history.complete!==true||history.truncated!==false||history.unknown!==false||
    !Array.isArray(history.entries)||!history.entries.length||history.entries.length>256||!Array.isArray(targets))throw Error('Incomplete or invalid target schedule');
 if(history.entries[0]?.tick!==0)throw Error('Replay requires an explicit target at step zero');
 let prior=-1,source=null;
 for(const row of history.entries){
  const who=row?.identity;
  if(!who||who.project_revision!==id.project_revision||typeof who.session_id!=='string'||!who.session_id||!Number.isSafeInteger(who.run_epoch)||who.run_epoch<0||
     row.status!=='accepted'||!Number.isSafeInteger(row.tick)||row.tick<prior||row.tick>endTick||
     !Number.isSafeInteger(row.lease_generation)||row.lease_generation<1||typeof row.value!=='number'||!Number.isFinite(row.value))throw Error('Unsupported target schedule');
  if(source&&(source.session_id!==who.session_id||source.run_epoch!==who.run_epoch))throw Error('Multiple source runs are unsupported');
  source=who;prior=row.tick;
  const target=targets.find(t=>t.group_id===row.group_id&&t.field===row.field);
  if(!target||row.value<target.min||row.value>target.max)throw Error('Target not permitted');
 }
 const same=v=>v&&v.session_id===id.session_id&&v.project_revision===id.project_revision&&v.run_epoch===id.run_epoch;
 let verified=null,dispatch=false,lease;
 try {
  lease=await session.acquireAttempt();
  if(signal?.aborted)return {status:'cancelled',last_verified_tick:null};
  const start=await session.inspect();
  if(!same(session.identity)||!same(start?.identity)||start.plant?.tick!==0)return {status:'not-started',last_verified_tick:null};
  verified=0;
  for(const row of history.entries){
   while(verified<row.tick){
    if(signal?.aborted)return {status:'cancelled',last_verified_tick:verified};
    const n=Math.min(64,row.tick-verified);dispatch=true;const result=await lease.step(n);dispatch=false;
    if(!same(session.identity)||!same(result?.identity)||!same(result?.inspection?.identity)||result.steps_completed!==n||result.inspection.plant?.tick!==verified+n)return {status:'unknown',last_verified_tick:verified};
    verified+=n;
   }
   if(signal?.aborted)return {status:'cancelled',last_verified_tick:verified};
   dispatch=true;const reply=await lease.setTarget({group_id:row.group_id,field:row.field,value:row.value});dispatch=false;
   if(!same(session.identity)||!same(reply?.identity)||reply.tick!==verified||reply.status!=='accepted'||reply.group_id!==row.group_id||reply.field!==row.field||!Object.is(reply.value,row.value))return {status:'unknown',last_verified_tick:verified};
  }
  while(verified<endTick){
   if(signal?.aborted)return {status:'cancelled',last_verified_tick:verified};
   const n=Math.min(64,endTick-verified);dispatch=true;const result=await lease.step(n);dispatch=false;
   if(!same(session.identity)||!same(result?.identity)||!same(result?.inspection?.identity)||result.steps_completed!==n||result.inspection.plant?.tick!==verified+n)return {status:'unknown',last_verified_tick:verified};
   verified+=n;
  }
  return {status:'completed',last_verified_tick:verified};
 } catch(error) {
  if(dispatch)return {status:'unknown',last_verified_tick:verified};
  throw error;
 } finally {if(lease)await lease.finish()}
}
