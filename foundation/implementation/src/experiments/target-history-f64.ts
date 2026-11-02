import {isCapturedProjectInventory, type ProjectInventory} from '../projects/project-inventory.ts';
import {captureProjectTargets} from '../projects/project-target-admission.ts';
import {readManifestJson} from '../projects/manifest-json.ts';
import {copyBounded} from '../session/project-world-wire.ts';

const maxBytes=2*1024*1024;
function exact(value:any,keys:readonly string[]):boolean {return !!value && typeof value==='object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value)===Object.prototype || Object.getPrototypeOf(value)===null) &&
  Reflect.ownKeys(value).length===keys.length && keys.every(k=>Object.hasOwn(value,k));}
function encodeBits(value:unknown):string {
  if(typeof value!=='number'||!Number.isFinite(value))throw Error('Invalid target value');
  const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,value,false);return view.getBigUint64(0,false).toString(16).padStart(16,'0');
}
function decodeBits(value:unknown):number {
  if(typeof value!=='string'||!/^[0-9a-f]{16}$/.test(value))throw Error('Invalid target value bits');
  const view=new DataView(new ArrayBuffer(8));view.setBigUint64(0,BigInt('0x'+value),false);const number=view.getFloat64(0,false);
  if(!Number.isFinite(number))throw Error('Nonfinite target value');return number;
}
/** Imported bytes are structurally inspected, not authenticated or validated as an experiment. */
export async function inspectExactTargetHistory(inventory:Readonly<ProjectInventory>,controllers:unknown,content:Blob,maxTick:number) {
  if(!isCapturedProjectInventory(inventory)||!Number.isSafeInteger(maxTick)||maxTick<0)throw Error('Invalid project or tick bound');
  const policyPromise=captureProjectTargets(inventory,controllers),documentPromise=readManifestJson(content,{max_bytes:maxBytes,max_depth:12});
  const [policy,document]=await Promise.all([policyPromise,documentPromise]);const data:any=document.data;
  const span=document.numberSpan(['schema_version']);
  if(!exact(data,['schema_version','entries','truncated'])||![1,2].includes(data.schema_version)||!span||document.source.slice(span.start,span.end)!==String(data.schema_version)||
     typeof data.truncated!=='boolean'||!Array.isArray(data.entries)||data.entries.length>4096)throw Error('Invalid exact target history');
  let identity:any=null,lastTick=-1,unknown=false;const entries:any[]=[];
  for(const row of data.entries) {
    if(!exact(row,['identity','group_id','field','value_bits','status','tick','lease_generation'])||!exact(row.identity,['session_id','project_revision','run_epoch'])||
       typeof row.identity.session_id!=='string'||!row.identity.session_id||row.identity.session_id.length>256||row.identity.project_revision!==inventory.project_revision||
       !Number.isSafeInteger(row.identity.run_epoch)||row.identity.run_epoch<0||typeof row.group_id!=='string'||!row.group_id||row.group_id.length>256||
       typeof row.field!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.field)||!['accepted','rejected','unknown'].includes(row.status))throw Error('Invalid target record');
    const value=decodeBits(row.value_bits);
    if(identity){
      if(identity.session_id!==row.identity.session_id||identity.project_revision!==row.identity.project_revision)throw Error('Mixed target identities');
      if(identity.run_epoch!==row.identity.run_epoch){
        if(data.schema_version!==2||row.identity.run_epoch<identity.run_epoch)throw Error('Invalid target epoch order');
        identity=Object.freeze({...row.identity});lastTick=-1;
      }
    } else identity=Object.freeze({...row.identity});
    if(row.status==='accepted') {const bound=policy.targets.find(x=>x.group_id===row.group_id&&x.field===row.field);
      if(!bound||value<bound.min||value>bound.max||!Number.isSafeInteger(row.tick)||row.tick<0||row.tick<lastTick||row.tick>maxTick||!Number.isSafeInteger(row.lease_generation)||row.lease_generation<1)throw Error('Invalid accepted target');lastTick=row.tick;
    } else {if(row.tick!==null||row.lease_generation!==null)throw Error('Invalid unaccepted target');if(row.status==='unknown')unknown=true;}
    entries.push(Object.freeze({identity,group_id:row.group_id,field:row.field,value,status:row.status,tick:row.tick,lease_generation:row.lease_generation}));
  }
  return Object.freeze({kind:'structural-only' as const,provenance:'unverified' as const,complete:!data.truncated&&!unknown,truncated:data.truncated,unknown,entries:Object.freeze(entries)});
}
/** Snapshot host-owned data before asynchronous project/record checks. */
export async function encodeExactTargetHistory(inventory:Readonly<ProjectInventory>,controllers:unknown,history:unknown,maxTick:number):Promise<Blob> {
  const captured=copyBounded(history,maxBytes);
  if(!exact(captured,['entries','truncated'])||!Array.isArray(captured.entries)||captured.entries.length>4096||typeof captured.truncated!=='boolean')throw Error('Invalid history');
  const entries=captured.entries.map((row:any)=>{if(!exact(row,['identity','group_id','field','value','status','tick','lease_generation']))throw Error('Invalid target record');
    return {identity:row.identity,group_id:row.group_id,field:row.field,value_bits:encodeBits(row.value),status:row.status,tick:row.tick,lease_generation:row.lease_generation};});
  const epoch=entries[0]?.identity?.run_epoch;
  const schema_version=entries.some((entry:any)=>entry.identity?.run_epoch!==epoch)?2:1;
  const output=new Blob([JSON.stringify({schema_version,entries,truncated:captured.truncated})],{type:'application/json'});
  if(output.size>maxBytes)throw Error('Target history exceeds limit');
  await inspectExactTargetHistory(inventory,controllers,output,maxTick);return output;
}
