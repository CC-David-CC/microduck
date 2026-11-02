import {copyBounded,sameBoundedData} from '../session/project-world-wire.ts';
import {readManifestJson} from '../projects/manifest-json.ts';
import {encodeMicroduckTruthDefinition,decodeMicroduckTruthDefinition} from '../observations/microduck-truth-channel.ts';
import {encodeChannelAttemptRecord,inspectChannelAttemptRecord} from './channel-attempt-record-f64.ts';
const exact=(v:any,k:readonly string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===k.length&&k.every(x=>Object.hasOwn(v,x));
const finite=(v:any)=>typeof v==='number'&&Number.isFinite(v);
const rowKeys=['boundary_tick','outcome','sequence','source','request_tick','requested','applied','limited'];
const inputKeys=['actuator_name','component','unit','semantic','validation_rule','engine_index','input_range'];
const identityKeys=['session_id','project_revision','run_epoch','group_id','lease_generation'];
const same=(a:any[],b:any[])=>a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
function bits(n:unknown):string{if(!finite(n))throw Error('Invalid command value');const d=new DataView(new ArrayBuffer(8));d.setFloat64(0,n as number,false);return d.getBigUint64(0,false).toString(16).padStart(16,'0')}
function fromBits(v:unknown):number{if(typeof v!=='string'||!/^[0-9a-f]{16}$/.test(v))throw Error('Invalid command bits');const d=new DataView(new ArrayBuffer(8));d.setBigUint64(0,BigInt('0x'+v),false);const n=d.getFloat64(0,false);if(!Number.isFinite(n))throw Error('Nonfinite command');return n}
function validateCommands(receipt:any,measurement:any,commands:any){
 if(!exact(commands,['authority','layout','entries','complete'])||!exact(commands.layout,['group_id','control_stride','limit_stage','inputs'])||typeof commands.layout.group_id!=='string'||!commands.layout.group_id||commands.layout.group_id.length>256||!Number.isSafeInteger(commands.layout.control_stride)||commands.layout.control_stride<1||commands.layout.limit_stage!=='host-control-input-range'||!Array.isArray(commands.layout.inputs)||commands.layout.inputs.length<1||commands.layout.inputs.length>256||!Array.isArray(commands.entries)||commands.entries.length!==(receipt.last_verified_tick??0)||commands.entries.length!==measurement.entries.length||typeof commands.complete!=='boolean'||commands.complete!==measurement.complete)throw Error('Invalid command history');
 const seenIndices=new Set<number>(),lastComponent=new Map<string,number>();
 for(const d of commands.layout.inputs){
  if(!exact(d,inputKeys)||typeof d.actuator_name!=='string'||!d.actuator_name||d.actuator_name.length>256||!Number.isSafeInteger(d.component)||d.component<0||typeof d.unit!=='string'||!d.unit||typeof d.semantic!=='string'||!d.semantic||d.validation_rule!=='independent-scalar-ranges'||!Number.isSafeInteger(d.engine_index)||d.engine_index<0||d.engine_index>=4096||seenIndices.has(d.engine_index)||!(d.input_range===null||Array.isArray(d.input_range)&&d.input_range.length===2&&d.input_range.every(finite)&&d.input_range[0]<=d.input_range[1]))throw Error('Invalid saved command layout');
  const expected=(lastComponent.get(d.actuator_name)??-1)+1;if(d.component!==expected)throw Error('Invalid actuator component ordering');lastComponent.set(d.actuator_name,d.component);seenIndices.add(d.engine_index);
 }
 const a=commands.authority,ma=measurement.authority;
 if(a===null){if(ma!==null||commands.entries.length||commands.complete)throw Error('Missing command authority');}
 else if(!exact(a,identityKeys)||!ma||a.session_id!==receipt.identity.session_id||a.project_revision!==receipt.identity.project_revision||a.run_epoch!==receipt.identity.run_epoch||a.group_id!==commands.layout.group_id||a.group_id!==ma.group_id||a.lease_generation!==ma.lease_generation||!Number.isSafeInteger(a.lease_generation)||a.lease_generation<1)throw Error('Command authority mismatch');
 let previous:any=null,sequence=0;
 for(let tick=0;tick<commands.entries.length;tick++){
  const row=commands.entries[tick],due=tick%commands.layout.control_stride===0;
  if(!exact(row,rowKeys)||row.boundary_tick!==tick||row.outcome!=='completed'||!Array.isArray(row.requested)||!Array.isArray(row.applied)||!Array.isArray(row.limited)||[row.requested,row.applied,row.limited].some((x:any[])=>x.length!==commands.layout.inputs.length)||row.source!==(due?'fresh':'held'))throw Error('Invalid saved command boundary');
  if(due){sequence++;if(row.sequence!==sequence||row.request_tick!==tick)throw Error('Invalid saved command cadence');
   for(let i=0;i<commands.layout.inputs.length;i++){const want=row.requested[i],got=row.applied[i],limited=row.limited[i],range=commands.layout.inputs[i].input_range;if(!finite(want)||!finite(got)||typeof limited!=='boolean')throw Error('Invalid saved command value');const expected=range===null?want:want<range[0]?range[0]:want>range[1]?range[1]:want;if(!Object.is(expected,got)||limited!==(want!==got))throw Error('Invalid saved command limiting');}
  }else if(!previous||row.sequence!==sequence||row.request_tick!==previous.request_tick||!same(row.requested,previous.requested)||!same(row.applied,previous.applied)||!same(row.limited,previous.limited))throw Error('Invalid saved held command');
  previous=row;
 }
 return commands;
}
/** Exact bounded command values and their layout; structural validation is not run attestation. */
export async function encodeCommandAttemptRecord(input:unknown):Promise<Blob>{
 const data=copyBounded(input,1048576);if(!data||typeof data!=='object'||!Object.hasOwn(data,'commands'))throw Error('Missing command history');
 const {commands,...measured}=data,measurementBlob=await encodeChannelAttemptRecord(measured,524288),checked=await inspectChannelAttemptRecord(measurementBlob,measured.measurement.authority,measured.measurement.channel,524288);
 validateCommands(checked.receipt,checked.measurement,commands);
 const entries=commands.entries.map((r:any)=>({boundary_tick:r.boundary_tick,outcome:r.outcome,sequence:r.sequence,source:r.source,request_tick:r.request_tick,requested_bits:r.requested.map(bits),applied_bits:r.applied.map(bits),limited:r.limited}));
 const blob=new Blob([JSON.stringify({schema_version:3,measured:JSON.parse(await measurementBlob.text()),commands:{authority:commands.authority,layout_canonical:encodeMicroduckTruthDefinition(commands.layout),entries,complete:commands.complete}})],{type:'application/json'});
 if(blob.size>1048576)throw Error('Command record exceeds budget');await inspectCommandAttemptRecord(blob,checked.receipt.identity.project_revision);return blob;
}
export async function inspectCommandAttemptRecord(content:Blob,revision:string){
 if(typeof revision!=='string'||!/^[0-9a-f]{64}$/.test(revision))throw Error('Invalid project revision');
 const doc=await readManifestJson(content,{max_bytes:1048576,max_depth:24}),data:any=doc.data,span=doc.numberSpan(['schema_version']);
 if(!exact(data,['schema_version','measured','commands'])||data.schema_version!==3||!span||doc.source.slice(span.start,span.end)!=='3'||!exact(data.commands,['authority','layout_canonical','entries','complete'])||!Array.isArray(data.commands.entries)||data.commands.entries.length>256)throw Error('Invalid command attempt');
 const m=data.measured,checked=await inspectChannelAttemptRecord(new Blob([JSON.stringify(m)]),m?.measurement?.authority??null,m?.measurement?.channel,524288);
 if(checked.receipt.identity.project_revision!==revision)throw Error('Record revision mismatch');
 const entries=data.commands.entries.map((r:any)=>{if(!exact(r,['boundary_tick','outcome','sequence','source','request_tick','requested_bits','applied_bits','limited'])||!Array.isArray(r.requested_bits)||!Array.isArray(r.applied_bits))throw Error('Invalid command entry');return {boundary_tick:r.boundary_tick,outcome:r.outcome,sequence:r.sequence,source:r.source,request_tick:r.request_tick,requested:r.requested_bits.map(fromBits),applied:r.applied_bits.map(fromBits),limited:r.limited}});
 const commands={authority:data.commands.authority,layout:decodeMicroduckTruthDefinition(data.commands.layout_canonical),entries,complete:data.commands.complete};validateCommands(checked.receipt,checked.measurement,commands);
 return Object.freeze({kind:'structural-only',provenance:'unverified',definition_status:checked.definition_status,receipt:checked.receipt,measurement:checked.measurement,commands:copyBounded(commands,1048576)});
}
