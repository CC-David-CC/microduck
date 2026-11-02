import {copyBounded} from '../session/project-world-wire.ts';
import {createGrantedChannelRecorder, createGrantedMeasurementRecorder} from './measurement-recording-grant.ts';

const requestKeys=['request_id','generation','command_sequence','identity','start_tick','steps','attempt_token','authority'];
const identityKeys=['session_id','project_revision','run_epoch'];
const authorityKeys=[...identityKeys,'group_id','lease_generation','channel_id','definition_sha256'];
const exact=(v:any,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const equal=(a:any,b:any,keys:string[])=>keys.every(k=>a[k]===b[k]);
const text=(v:any)=>typeof v==='string'&&v.length>0&&v.length<=256;

function validateEnvelope(expected:unknown,grantInput:unknown,input:unknown,channel:boolean){
 const e=copyBounded(expected,8192),grant=copyBounded(grantInput,8192),r=copyBounded(input,65536);
 if(!exact(e,requestKeys)||!exact(e.identity,identityKeys)||!exact(e.authority,authorityKeys)||
    !text(e.request_id)||!text(e.attempt_token)||!Number.isSafeInteger(e.generation)||e.generation<1||
    !Number.isSafeInteger(e.command_sequence)||e.command_sequence<1||!Number.isSafeInteger(e.start_tick)||e.start_tick<0||
    !Number.isSafeInteger(e.steps)||e.steps<1||e.steps>64||!Number.isSafeInteger(e.start_tick+e.steps)||
    !equal(e.identity,e.authority,identityKeys)||!exact(r,[...requestKeys,...(channel?['channel']:[]),'rows'])||
    !exact(r.identity,identityKeys)||!exact(r.authority,authorityKeys)||
    !equal(e,r,['request_id','generation','command_sequence','start_tick','steps','attempt_token'])||
    !equal(e.identity,r.identity,identityKeys)||!equal(e.authority,r.authority,authorityKeys)||
    !Array.isArray(r.rows)||r.rows.length!==e.steps||!grant||grant.max_entries<e.steps)throw Error('Invalid measured step response');
 return {e,grant,r};
}
function captureRows(log:ReturnType<typeof createGrantedMeasurementRecorder>,e:any,r:any){
 for(let i=0;i<r.rows.length;i++){
  const row=r.rows[i];if(!exact(row,['observed_tick','sample','outcome'])||row.observed_tick!==e.start_tick+i||row.outcome!=='completed')throw Error('Invalid measured step row');
  if(!log.capture({authority:e.authority,observed_tick:row.observed_tick,sample:row.sample}))throw Error('Measurement capacity exceeded');
  log.settle(row.observed_tick,'completed');
 }
 return log.snapshot();
}
/** Trusted expected request and grant only; this does not authenticate a sender. */
export function validateMeasuredStepResponse(expected:unknown,grantInput:unknown,input:unknown){
 const {e,grant,r}=validateEnvelope(expected,grantInput,input,false);
 return captureRows(createGrantedMeasurementRecorder(e.authority,grant),e,r);
}
/** Vector responses also bind the worker's descriptor to the host-owned grant. */
export function validateChannelStepResponse(expected:unknown,grantInput:unknown,input:unknown){
 const {e,grant,r}=validateEnvelope(expected,grantInput,input,true);
 const recorder=createGrantedChannelRecorder(e.authority,grant,r.channel);
 return Object.freeze({channel:recorder.channel,log:captureRows(recorder.log,e,r)});
}
