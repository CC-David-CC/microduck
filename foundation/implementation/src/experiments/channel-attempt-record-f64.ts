import {copyBounded,sameBoundedData} from '../session/project-world-wire.ts';
import {readManifestJson} from '../projects/manifest-json.ts';
import {createSampleLog} from './measurement-log.ts';
import {validRecordingChannel} from './measurement-recording-grant.ts';
import {validateMeasuredAttemptMetadata} from './measured-attempt-record.ts';
import {encodeMicroduckTruthDefinition,decodeMicroduckTruthDefinition,microduckTruthDefinitionHash} from '../observations/microduck-truth-channel.ts';

const metadataKeys=['status','identity','configuration_evidence','requested_ticks','last_verified_tick','reported_steps'];
const exact=(v:any,keys:readonly string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
function limit(value:unknown):number {if(!Number.isSafeInteger(value)||(value as number)<1||(value as number)>524288)throw Error('Invalid channel record limit');return value as number;}
function bits(n:unknown):string{if(typeof n!=='number'||!Number.isFinite(n))throw Error('Invalid value');const d=new DataView(new ArrayBuffer(8));d.setFloat64(0,n,false);return d.getBigUint64(0,false).toString(16).padStart(16,'0');}
function fromBits(v:unknown):number{if(typeof v!=='string'||!/^[0-9a-f]{16}$/.test(v))throw Error('Invalid value bits');const d=new DataView(new ArrayBuffer(8));d.setBigUint64(0,BigInt('0x'+v),false);const n=d.getFloat64(0,false);if(!Number.isFinite(n))throw Error('Nonfinite value');return n;}

/** Check a retained prefix with the same sample rules used at capture time.
 * Chunks preserve the 4096-value in-memory log bound even for longer runs. */
async function prepare(input:any){
 if(!exact(input,[...metadataKeys,'measurement'])||!exact(input.measurement,['authority','channel','definition','entries','complete']))throw Error('Invalid channel attempt');
 const {measurement,...receipt}=input;validateMeasuredAttemptMetadata(receipt);
 const {channel,definition,authority,entries,complete}=measurement;
 if(!validRecordingChannel(channel)||channel.kind!=='truth'||!definition||definition.version!=='brf.microduck-plant-truth.v1'||
    definition.id!==channel.id||definition.project_revision!==receipt.identity.project_revision||!Array.isArray(definition.layout)||definition.layout.length<1||definition.layout.length>64||
    definition.layout.some((x:any)=>!exact(x,['name','size','unit','stage'])||typeof x.name!=='string'||!x.name||typeof x.unit!=='string'||!x.unit||typeof x.stage!=='string'||!x.stage||!Number.isSafeInteger(x.size)||x.size<1)||
    definition.layout.reduce((sum:number,x:any)=>sum+x.size,0)!==channel.size||await microduckTruthDefinitionHash(definition)!==channel.definition_sha256||
    !Array.isArray(entries)||entries.length!==(receipt.last_verified_tick??0)||
    typeof complete!=='boolean'||complete!==(receipt.status==='completed'&&entries.length===receipt.requested_ticks))throw Error('Invalid channel interval');
 if(authority===null){if(entries.length||complete)throw Error('Missing channel authority');return {receipt,measurement:{authority:null,channel,definition,entries:[],complete}};}
 if(!authority||authority.session_id!==receipt.identity.session_id||authority.project_revision!==receipt.identity.project_revision||authority.run_epoch!==receipt.identity.run_epoch||
    authority.channel_id!==channel.id||authority.definition_sha256!==channel.definition_sha256)throw Error('Channel authority mismatch');
 const capacity=Math.min(256,Math.floor(4096/channel.size)),retained:any[]=[];
 // Construct even for zero entries so authority is fully validated.
 let log=createSampleLog(authority,capacity,channel.size);
 for(let i=0;i<entries.length;i++){
  const row=entries[i];if(!exact(row,['observed_tick','sample','outcome'])||row.observed_tick!==i||row.outcome!=='completed')throw Error('Invalid retained boundary');
  if(i>0&&i%capacity===0){retained.push(...log.snapshot().entries);log=createSampleLog(authority,capacity,channel.size);}
  if(!log.capture({authority,observed_tick:i,sample:row.sample}))throw Error('Channel capacity exceeded');log.settle(i,'completed');
 }
 retained.push(...log.snapshot().entries);
 return {receipt,measurement:{authority:log.snapshot().authority,channel,definition,entries:retained,complete}};
}
/** Store the exact source and timing definition, plus exact sample bits. */
export async function encodeChannelAttemptRecord(input:unknown,maxBytes:unknown){
 const cap=limit(maxBytes),owned=copyBounded(input,524288),{receipt,measurement}=await prepare(owned);
 const entries=measurement.entries.map((row:any)=>({observed_tick:row.observed_tick,sample:{validity:row.sample.validity,value_bits:row.sample.values.map(bits),sequence:row.sample.sequence,capture_tick:row.sample.capture_tick,available_tick:row.sample.available_tick},outcome:row.outcome}));
 const blob=new Blob([JSON.stringify({schema_version:2,definition_status:'complete',receipt,measurement:{authority:measurement.authority,channel:measurement.channel,definition_canonical:encodeMicroduckTruthDefinition(measurement.definition),entries,complete:measurement.complete}})],{type:'application/json'});
 if(blob.size>cap)throw Error('Channel record exceeds limit');
 await inspectChannelAttemptRecord(blob,measurement.authority,measurement.channel,cap);return blob;
}
/** Structural inspection only: saved values and definition hashes are unverified assertions. */
export async function inspectChannelAttemptRecord(content:Blob,expectedAuthority:unknown,expectedChannel:unknown,maxBytes:unknown){
 const cap=limit(maxBytes),doc=await readManifestJson(content,{max_bytes:cap,max_depth:20}),data:any=doc.data,span=doc.numberSpan(['schema_version']);
 if(!exact(data,['schema_version','definition_status','receipt','measurement'])||data.schema_version!==2||!span||doc.source.slice(span.start,span.end)!=='2'||data.definition_status!=='complete'||
    !exact(data.measurement,['authority','channel','definition_canonical','entries','complete'])||!Array.isArray(data.measurement.entries)||data.measurement.entries.length>256)throw Error('Invalid channel record');
 const expected=copyBounded(expectedAuthority,4096),channel=copyBounded(expectedChannel,8192);
 if(!validRecordingChannel(channel)||!sameBoundedData(data.measurement.authority,expected)||!sameBoundedData(data.measurement.channel,channel))throw Error('Channel record mismatch');
 const entries=data.measurement.entries.map((row:any)=>{
  if(!exact(row,['observed_tick','sample','outcome'])||!exact(row.sample,['validity','value_bits','sequence','capture_tick','available_tick'])||!Array.isArray(row.sample.value_bits))throw Error('Invalid channel entry');
  return {observed_tick:row.observed_tick,sample:{validity:row.sample.validity,values:row.sample.value_bits.map(fromBits),sequence:row.sample.sequence,capture_tick:row.sample.capture_tick,available_tick:row.sample.available_tick},outcome:row.outcome};
 });
 const definition=decodeMicroduckTruthDefinition(data.measurement.definition_canonical);
 const checked=await prepare({...data.receipt,measurement:{authority:expected,channel,definition,entries,complete:data.measurement.complete}});
 return Object.freeze({kind:'structural-only',provenance:'unverified',definition_status:'complete',receipt:copyBounded(checked.receipt,8192),measurement:Object.freeze(checked.measurement)});
}
