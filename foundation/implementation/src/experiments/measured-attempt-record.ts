import {copyBounded} from '../session/project-world-wire.ts';
import {readManifestJson} from '../projects/manifest-json.ts';
import {createMeasurementLog} from './measurement-log.ts';
import {encodeMeasurementRecord,inspectMeasurementRecord} from './measurement-record-f64.ts';

const identityKeys=['session_id','project_revision','run_epoch'];
const metaKeys=['status','identity','configuration_evidence','requested_ticks','last_verified_tick','reported_steps'];
const exact=(v:any,k:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));
const hash=(v:any)=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
function cap(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<1||(value as number)>262144)throw Error('Invalid record limit');return value as number;}
export function validateMeasuredAttemptMetadata(r:any) {
 if(!exact(r,metaKeys)||!exact(r.identity,identityKeys)||typeof r.identity.session_id!=='string'||!r.identity.session_id||r.identity.session_id.length>256||
    !hash(r.identity.project_revision)||!Number.isSafeInteger(r.identity.run_epoch)||r.identity.run_epoch<0||
    !exact(r.configuration_evidence,['project_revision','configuration_sha256','runtime_lock_sha256'])||
    r.configuration_evidence.project_revision!==r.identity.project_revision||!hash(r.configuration_evidence.configuration_sha256)||!hash(r.configuration_evidence.runtime_lock_sha256)||
    !['completed','cancelled','deadline','failed','unknown'].includes(r.status)||!Number.isSafeInteger(r.requested_ticks)||r.requested_ticks<1||r.requested_ticks>256||
    (r.last_verified_tick!==null&&(!Number.isSafeInteger(r.last_verified_tick)||r.last_verified_tick<0||r.last_verified_tick>r.requested_ticks))||
    (r.reported_steps!==null&&(!Number.isSafeInteger(r.reported_steps)||r.reported_steps<0||r.reported_steps>r.requested_ticks))||
    (r.status==='completed'&&r.last_verified_tick!==r.requested_ticks))throw Error('Invalid attempt receipt');
}
function prepare(input:any){
 if(!exact(input,[...metaKeys,'measurement'])||!exact(input.measurement,['authority','entries','complete']))throw Error('Invalid measured attempt');
 const {measurement,...receipt}=input;validateMeasuredAttemptMetadata(receipt);
 if(!Array.isArray(measurement.entries)||measurement.entries.length!==(receipt.last_verified_tick??0)||
    typeof measurement.complete!=='boolean'||measurement.complete!==(receipt.status==='completed'&&measurement.entries.length===receipt.requested_ticks))throw Error('Invalid retained interval');
 if(measurement.authority===null){if(measurement.entries.length||measurement.complete)throw Error('Missing measurement authority');return {receipt,log:null};}
 const a=measurement.authority;
 if(!a||identityKeys.some(k=>a[k]!==receipt.identity[k]))throw Error('Measurement identity mismatch');
 const log=createMeasurementLog(a,256);
 for(let i=0;i<measurement.entries.length;i++){
  const row=measurement.entries[i];if(!exact(row,['observed_tick','sample','outcome'])||row.observed_tick!==i||row.outcome!=='completed')throw Error('Invalid retained boundary');
  log.capture({authority:a,observed_tick:i,sample:row.sample});log.settle(i,'completed');
 }
 log.seal(receipt.requested_ticks,receipt.status==='completed'?'completed':receipt.status==='unknown'?'unknown':'incomplete');
 return {receipt,log};
}
export async function encodeMeasuredAttemptRecord(input:unknown,maxBytes:unknown){
 const limit=cap(maxBytes),owned=copyBounded(input,262144),{receipt,log}=prepare(owned);
 const record=log?JSON.parse(await (await encodeMeasurementRecord(log.snapshot(),log.snapshot().authority,Math.min(limit,131072))).text()):null;
 const blob=new Blob([JSON.stringify({schema_version:1,receipt,measurement:record})],{type:'application/json'});
 if(blob.size>limit)throw Error('Record exceeds limit');
 await inspectMeasuredAttemptRecord(blob,log?log.snapshot().authority:null,limit);return blob;
}
export async function inspectMeasuredAttemptRecord(blob:Blob,expected:unknown,maxBytes:unknown){
 const limit=cap(maxBytes),doc=await readManifestJson(blob,{max_bytes:limit,max_depth:20}),data:any=doc.data,span=doc.numberSpan(['schema_version']);
 if(!exact(data,['schema_version','receipt','measurement'])||data.schema_version!==1||!span||doc.source.slice(span.start,span.end)!=='1')throw Error('Invalid measured attempt record');
 validateMeasuredAttemptMetadata(data.receipt);
 let measurement:any=null;
 if(data.measurement!==null){
  if(expected===null||expected===undefined)throw Error('Expected authority required');
  measurement=await inspectMeasurementRecord(new Blob([JSON.stringify(data.measurement)]),expected,Math.min(limit,131072));
  const recomposed={...data.receipt,measurement:{authority:measurement.authority,entries:measurement.entries,complete:measurement.complete}};
  const validated=prepare(recomposed);
  if(!measurement.sealed||measurement.expectedCount!==data.receipt.requested_ticks||measurement.terminalOutcome!==validated.log?.snapshot().terminalOutcome)throw Error('Invalid measurement terminal state');
 } else {
  if(expected!==null)throw Error('Unexpected missing measurement');
  prepare({...data.receipt,measurement:{authority:null,entries:[],complete:false}});
 }
 return Object.freeze({kind:'structural-only',provenance:'unverified',receipt:copyBounded(data.receipt,8192),measurement});
}
