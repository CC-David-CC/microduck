import {copyBounded} from '../session/project-world-wire.ts';
import {readManifestJson} from '../projects/manifest-json.ts';
import {encodeMeasuredAttemptRecord,inspectMeasuredAttemptRecord} from './measured-attempt-record.ts';
import {encodeChannelAttemptRecord,inspectChannelAttemptRecord} from './channel-attempt-record-f64.ts';
import {encodeCommandAttemptRecord,inspectCommandAttemptRecord} from './command-attempt-record-f64.ts';

/** The caller owns this captured receipt. A vector must contain its full definition. */
export async function encodePortableMeasuredAttempt(input:unknown):Promise<Blob>{
 const data=copyBounded(input,1048576),measurement=data?.measurement;
 if(!measurement||typeof measurement!=='object'||Array.isArray(measurement))throw Error('Invalid measured attempt');
 if(Object.hasOwn(data,'commands'))return encodeCommandAttemptRecord(data);
 if(Object.hasOwn(measurement,'channel')||Object.hasOwn(measurement,'definition'))return encodeChannelAttemptRecord(data,524288);
 return encodeMeasuredAttemptRecord(data,131072);
}
/** Saved contents supply their own authority: inspection is structural and unverified. */
export async function inspectPortableMeasuredAttempt(content:Blob,revision:string){
 if(typeof revision!=='string'||!/^[0-9a-f]{64}$/.test(revision))throw Error('Invalid project revision');
 const doc=await readManifestJson(content,{max_bytes:1048576,max_depth:24}),data:any=doc.data;
 let checked:any;
 if(data.schema_version===1)checked=await inspectMeasuredAttemptRecord(content,data.measurement?.authority??null,131072);
 else if(data.schema_version===2)checked=await inspectChannelAttemptRecord(content,data.measurement?.authority??null,data.measurement?.channel,524288);
 else if(data.schema_version===3)checked=await inspectCommandAttemptRecord(content,revision);
 else throw Error('Unsupported measured attempt');
 if(checked.receipt.identity.project_revision!==revision)throw Error('Record revision mismatch');
 return checked;
}
