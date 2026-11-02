import {copyBounded} from '../session/project-world-wire.ts';
import {readManifestJson} from '../projects/manifest-json.ts';
import {createMeasurementLog} from './measurement-log.ts';

const authorityKeys=['session_id','project_revision','run_epoch','group_id','lease_generation','channel_id','definition_sha256'];
const snapshotKeys=['authority','entries','truncated','gaps','sealed','expectedCount','terminalOutcome','complete'];
function exact(v:any,keys:readonly string[]):boolean{return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));}
function budget(n:unknown):number{if(!Number.isSafeInteger(n)||(n as number)<1||(n as number)>131072)throw Error('Invalid record budget');return n as number;}
function bits(n:unknown):string{if(typeof n!=='number'||!Number.isFinite(n))throw Error('Invalid sample');const d=new DataView(new ArrayBuffer(8));d.setFloat64(0,n,false);return d.getBigUint64(0,false).toString(16).padStart(16,'0');}
function number(value:unknown):number{if(typeof value!=='string'||!/^[0-9a-f]{16}$/.test(value))throw Error('Invalid bits');const d=new DataView(new ArrayBuffer(8));d.setBigUint64(0,BigInt('0x'+value),false);const n=d.getFloat64(0,false);if(!Number.isFinite(n))throw Error('Nonfinite bits');return n;}

export async function inspectMeasurementRecord(content:Blob,expected:unknown,maxBytes:unknown){
 const cap=budget(maxBytes),authority=copyBounded(expected,4096),log=createMeasurementLog(authority,256);
 const doc=await readManifestJson(content,{max_bytes:cap,max_depth:12}),data:any=doc.data,span=doc.numberSpan(['schema_version']);
 if(!exact(data,['schema_version',...snapshotKeys])||data.schema_version!==1||!span||doc.source.slice(span.start,span.end)!=='1'||
    !exact(data.authority,authorityKeys)||authorityKeys.some(k=>data.authority[k]!==authority[k])||
    !Array.isArray(data.entries)||data.entries.length>256||typeof data.truncated!=='boolean'||typeof data.gaps!=='boolean'||
    typeof data.sealed!=='boolean'||typeof data.complete!=='boolean')throw Error('Invalid measurement record');
 for(const row of data.entries){
  if(!exact(row,['observed_tick','sample','outcome'])||!exact(row.sample,['validity','value_bits','sequence','capture_tick','available_tick'])||
     !Array.isArray(row.sample.value_bits)||!['pending','completed','unknown'].includes(row.outcome))throw Error('Invalid measurement entry');
  const sample={validity:row.sample.validity,values:row.sample.value_bits.map(number),sequence:row.sample.sequence,capture_tick:row.sample.capture_tick,available_tick:row.sample.available_tick};
  log.capture({authority,observed_tick:row.observed_tick,sample});if(row.outcome!=='pending')log.settle(row.observed_tick,row.outcome);
 }
 if(data.sealed)log.seal(data.expectedCount,data.terminalOutcome);
 else if(data.expectedCount!==null||data.terminalOutcome!==null)throw Error('Invalid terminal state');
 const rebuilt=log.snapshot();
 if(rebuilt.gaps&&!data.gaps)throw Error('Hidden gap');
 if(!data.truncated&&rebuilt.gaps!==data.gaps)throw Error('Invalid gap state');
 const complete=rebuilt.complete&&!data.truncated&&!data.gaps;
 if(data.complete!==complete)throw Error('Invalid completeness claim');
 return Object.freeze({kind:'structural-only',provenance:'unverified',authority:rebuilt.authority,entries:rebuilt.entries,
  truncated:data.truncated,gaps:data.gaps,sealed:data.sealed,expectedCount:data.expectedCount,terminalOutcome:data.terminalOutcome,complete});
}
export async function encodeMeasurementRecord(snapshot:unknown,expected:unknown,maxBytes:unknown){
 const cap=budget(maxBytes),data=copyBounded(snapshot,131072);
 if(!exact(data,snapshotKeys)||!Array.isArray(data.entries)||data.entries.length>256)throw Error('Invalid measurement snapshot');
 const entries=data.entries.map((row:any)=>{
  if(!exact(row,['observed_tick','sample','outcome'])||!exact(row.sample,['validity','values','sequence','capture_tick','available_tick'])||!Array.isArray(row.sample.values))throw Error('Invalid measurement snapshot entry');
  return {observed_tick:row.observed_tick,sample:{validity:row.sample.validity,value_bits:row.sample.values.map(bits),sequence:row.sample.sequence,capture_tick:row.sample.capture_tick,available_tick:row.sample.available_tick},outcome:row.outcome};
 });
 const blob=new Blob([JSON.stringify({schema_version:1,authority:data.authority,entries,truncated:data.truncated,gaps:data.gaps,sealed:data.sealed,expectedCount:data.expectedCount,terminalOutcome:data.terminalOutcome,complete:data.complete})],{type:'application/json'});
 if(blob.size>cap)throw Error('Measurement record exceeds budget');await inspectMeasurementRecord(blob,expected,cap);return blob;
}
