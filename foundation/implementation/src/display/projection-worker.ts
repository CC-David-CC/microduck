import {copyBounded, DataBudgetExceeded} from '../session/project-world-wire.ts';
import {projectVisualSnapshot, UnsupportedVisualError, VisualCapacityError} from './visual-projection.ts';

// This Worker is a presentation-only processor. Its owner must bind these inert
// facts to an admitted session, enforce a bounded mailbox, and fence replies.
const LIMIT = 1048576, MAX_BODIES = 64, MAX_GEOMS = 1024;
const worker = self as unknown as {postMessage(value:unknown):void; close():void;
  addEventListener(type:'message', listener:(event:MessageEvent)=>void):void};
const closeRejectedPort = MessagePort.prototype.close;
let binding: {generation:number; identity:any; model:any; tick:number; time:number} | null = null;
let closed = false;
function record(value:unknown): value is Record<string,any> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function field(value:any, key:string):unknown {
  const d = Object.getOwnPropertyDescriptor(value,key);
  return d && d.enumerable && Object.hasOwn(d,'value') ? d.value : undefined;
}
function exact(value:any, keys:string[]):boolean {
  return record(value) && Reflect.ownKeys(value).length === keys.length &&
    keys.every(key => Object.hasOwn(value,key) && field(value,key) !== undefined);
}
function header(value:any): {request_id:string;generation:number;identity:any} | null {
  if (!record(value)) return null;
  const id=field(value,'request_id'), generation=field(value,'generation'), raw=field(value,'identity');
  if (typeof id !== 'string' || !id || id.length > 128 || !Number.isSafeInteger(generation) || (generation as number)<1 || !exact(raw,['session_id','project_revision','run_epoch'])) return null;
  const session=field(raw,'session_id'), revision=field(raw,'project_revision'), epoch=field(raw,'run_epoch');
  if (typeof session !== 'string' || !session || session.length>128 || typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision) || !Number.isSafeInteger(epoch) || (epoch as number)<0) return null;
  return {request_id:id,generation:generation as number,identity:{session_id:session,project_revision:revision,run_epoch:epoch}};
}
function same(a:any,b:any) {return a.session_id===b.session_id && a.project_revision===b.project_revision && a.run_epoch===b.run_epoch;}
function preflight(value:any, kind:string) {
  const frame=field(value,'frame'), model=kind==='bind' ? field(value,'model') : binding?.model;
  if (!record(model) || !record(frame)) throw Error('Invalid model or frame');
  const bodies=field(model,'bodies'), geoms=field(model,'geoms'), frameBodies=field(frame,'bodies');
  if (!Array.isArray(bodies) || !Array.isArray(geoms) || !Array.isArray(frameBodies)) throw Error('Invalid visual arrays');
  if (bodies.length>MAX_BODIES || frameBodies.length>MAX_BODIES || geoms.length>MAX_GEOMS) throw new VisualCapacityError('Visual count limit exceeded');
}
function unavailable(h:any, reason:'invalid'|'capacity'|'unsupported'|'stale') {
  try {worker.postMessage(copyBounded({kind:'unavailable',...h,reason},LIMIT));} catch {worker.close();closed=true;binding=null;}
}
worker.addEventListener('message', event => {
  for (const port of event.ports ?? []) { try {Reflect.apply(closeRejectedPort, port, []);} catch {} }
  if (closed || (event.ports?.length ?? 0)>0) return;
  let h:ReturnType<typeof header> = null;
  let sending = false;
  try {
    h=header(event.data); if (!h) return;
    const kind=field(event.data,'kind');
    if (kind==='dispose') {
      if (!exact(event.data,['kind','request_id','generation','identity']) || !binding || h.generation!==binding.generation || !same(h.identity,binding.identity)) return;
      const output=copyBounded({kind:'disposed',...h},LIMIT); sending=true;worker.postMessage(output); closed=true;binding=null;worker.close();return;
    }
    if (kind!=='bind' && kind!=='project') return;
    const keys=kind==='bind' ? ['kind','request_id','generation','identity','model','frame'] : ['kind','request_id','generation','identity','frame'];
    if (!exact(event.data,keys)) {unavailable(h,'invalid');return;}
    if (kind==='bind' && binding) {unavailable(h,'stale');return;}
    if (kind==='project' && (!binding || h.generation!==binding.generation || !same(h.identity,binding.identity))) {unavailable(h,'stale');return;}
    preflight(event.data,kind);
    const input=copyBounded(event.data,LIMIT);
    if (kind==='project' && (input.frame.tick<=binding!.tick || input.frame.time<binding!.time)) {unavailable(h,'stale');return;}
    const model=kind==='bind' ? input.model : binding!.model;
    const snapshot=projectVisualSnapshot({model,frame:input.frame});
    const output=copyBounded({kind:kind==='bind'?'bound':'projected',...h,snapshot},LIMIT);
    sending=true;worker.postMessage(output);sending=false;
    if (kind==='bind') binding={generation:h.generation,identity:h.identity,model,tick:snapshot.tick,time:snapshot.time};
    else {binding!.tick=snapshot.tick;binding!.time=snapshot.time;}
  } catch (error) {
    if (sending) {closed=true;binding=null;worker.close();return;}
    if (!h || closed) return;
    unavailable(h,error instanceof DataBudgetExceeded || error instanceof VisualCapacityError ? 'capacity' : error instanceof UnsupportedVisualError ? 'unsupported' : 'invalid');
  }
});
