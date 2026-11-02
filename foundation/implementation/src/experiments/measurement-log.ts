import {copyBounded} from '../session/project-world-wire.ts';

const authorityKeys=['session_id','project_revision','run_epoch','group_id','lease_generation','channel_id','definition_sha256'];
const sampleKeys=['validity','values','sequence','capture_tick','available_tick'];
function exact(v:any,keys:readonly string[]):boolean{return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));}
function identity(v:any):boolean{return exact(v,authorityKeys)&&typeof v.session_id==='string'&&v.session_id.length>0&&v.session_id.length<=256&&
 typeof v.project_revision==='string'&&/^[0-9a-f]{64}$/.test(v.project_revision)&&Number.isSafeInteger(v.run_epoch)&&v.run_epoch>=0&&
 typeof v.group_id==='string'&&v.group_id.length>0&&v.group_id.length<=256&&Number.isSafeInteger(v.lease_generation)&&v.lease_generation>0&&
 typeof v.channel_id==='string'&&v.channel_id.length>0&&v.channel_id.length<=256&&typeof v.definition_sha256==='string'&&/^[0-9a-f]{64}$/.test(v.definition_sha256);}
function sampleValid(s:any,tick:number,width:number):boolean {
 if(!exact(s,sampleKeys)||!['valid','stale','missing'].includes(s.validity)||!Array.isArray(s.values))return false;
 if(s.validity==='missing')return s.values.length===0&&s.sequence===null&&s.capture_tick===null&&s.available_tick===null;
 return s.values.length===width&&s.values.every((value:unknown)=>typeof value==='number'&&Number.isFinite(value))&&Number.isSafeInteger(s.sequence)&&s.sequence>0&&
 Number.isSafeInteger(s.capture_tick)&&s.capture_tick>=0&&Number.isSafeInteger(s.available_tick)&&s.available_tick>=s.capture_tick&&s.available_tick<=tick;
}
/** The scalar measurement contract remains scalar. Vector callers must bind
 * the explicit width to their trusted channel definition before using this log;
 * this data structure alone does not authenticate a channel or prove a run. */
export function createMeasurementLog(input:unknown,capacity:unknown){return createSampleLog(input,capacity,1);}
export function createSampleLog(input:unknown,capacity:unknown,width:unknown){
 const authority=copyBounded(input,4096);
 if(!identity(authority)||!Number.isSafeInteger(capacity)||(capacity as number)<1||(capacity as number)>256||
    !Number.isSafeInteger(width)||(width as number)<1||(width as number)>64||(capacity as number)*(width as number)>4096)throw Error('Invalid log authority, capacity or width');
 const entries:any[]=[];let truncated=false,gaps=false,lastTick=-1,seen=0;
 let terminal:{expectedCount:number;outcome:'completed'|'incomplete'|'unknown'}|null=null;
 return Object.freeze({
  capture(value:unknown):boolean {
   if(terminal)throw Error('Log is sealed');
   const v=copyBounded(value,8192);
   if(!exact(v,['authority','observed_tick','sample'])||!identity(v.authority)||authorityKeys.some(k=>v.authority[k]!==authority[k])||
     !Number.isSafeInteger(v.observed_tick)||v.observed_tick<=lastTick||!sampleValid(v.sample,v.observed_tick,width as number))throw Error('Invalid measurement boundary');
   if(seen>0&&v.observed_tick!==lastTick+1)gaps=true;
   lastTick=v.observed_tick;seen++;
   if(entries.length===(capacity as number)){truncated=true;return false;}
   entries.push({observed_tick:v.observed_tick,sample:v.sample,outcome:'pending'});return true;
  },
  settle(tick:unknown,outcome:unknown):void {
   if(terminal)throw Error('Log is sealed');
   if(!Number.isSafeInteger(tick)||!['completed','unknown'].includes(outcome as string))throw Error('Invalid settlement');
   const row=entries.find(x=>x.observed_tick===tick);if(!row||row.outcome!=='pending')throw Error('Boundary not pending');row.outcome=outcome;
  },
  seal(expectedCount:unknown,outcome:unknown):void {
   if(terminal||!Number.isSafeInteger(expectedCount)||(expectedCount as number)<0||(expectedCount as number)>256||
      !['completed','incomplete','unknown'].includes(outcome as string))throw Error('Invalid log seal');
   terminal={expectedCount:expectedCount as number,outcome:outcome as 'completed'|'incomplete'|'unknown'};
  },
  snapshot(){
   const rows=entries.map(row=>Object.freeze({observed_tick:row.observed_tick,sample:Object.freeze({...row.sample,values:Object.freeze([...row.sample.values])}),outcome:row.outcome}));
   return Object.freeze({authority:Object.freeze({...authority}),entries:Object.freeze(rows),truncated,gaps,sealed:terminal!==null,
    expectedCount:terminal?.expectedCount??null,terminalOutcome:terminal?.outcome??null,
    complete:terminal!==null&&terminal.outcome==='completed'&&seen===terminal.expectedCount&&!truncated&&!gaps&&rows.every(x=>x.outcome==='completed')});
  },
 });
}
