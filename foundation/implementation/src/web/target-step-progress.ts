type Identity={session_id:string;project_revision:string;run_epoch:number};
const same=(a:any,b:Identity)=>!!a&&a.session_id===b.session_id&&a.project_revision===b.project_revision&&a.run_epoch===b.run_epoch;
/** Presentation feedback derived from the same session's acknowledged target and step. */
export function targetThenStepProgress(identity:Identity,history:any,step:any,source:'step'|'pause'='step'):'pending'|'ready'|'complete'|'unavailable'{
  if(source!=='step'&&source!=='pause')return 'unavailable';
  if(!identity||!history||!Array.isArray(history.entries)||history.entries.length>4096||typeof history.truncated!=='boolean')return 'unavailable';
  const accepted=history.entries.filter((row:any)=>row?.status==='accepted'&&same(row.identity,identity)&&Number.isSafeInteger(row.tick)&&row.tick>=0);
  if(!accepted.length)return history.truncated?'unavailable':'pending';
  if(step===null)return 'ready';
  if(!step||!same(step.identity,identity)||!same(step.inspection?.identity,identity)||(source==='step'&&(!Number.isSafeInteger(step.steps_completed)||step.steps_completed<1))||!Number.isSafeInteger(step.inspection?.plant?.tick)||step.inspection.plant.tick<0)return 'unavailable';
  return accepted.some((row:any)=>row.tick<step.inspection.plant.tick)?'complete':'ready';
}
