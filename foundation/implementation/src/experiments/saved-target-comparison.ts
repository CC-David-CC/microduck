import {readManifestJson} from '../projects/manifest-json.ts';
import {isCapturedProjectInventory} from '../projects/project-inventory.ts';
import {readProjectTargetDeclarations} from '../projects/project-target-admission.ts';

const exact=(v:any,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const identityKeys=['session_id','project_revision','run_epoch'];
const rowKeys=['identity','group_id','field','value_bits','status','tick','lease_generation'];
const validIdentity=(x:any)=>exact(x,identityKeys)&&typeof x.session_id==='string'&&x.session_id.length>0&&x.session_id.length<=256&&typeof x.project_revision==='string'&&/^[0-9a-f]{64}$/.test(x.project_revision)&&Number.isSafeInteger(x.run_epoch)&&x.run_epoch>=0;
const sameIdentity=(a:any,b:any)=>identityKeys.every(k=>a[k]===b[k]);
/** Compare reported target requests only. No record or its declared authority is authenticated. */
export async function compareReportedTargetHistories(left:Blob|null,right:Blob|null,leftIdentity:unknown,rightIdentity:unknown,leftInventory:unknown,rightInventory:unknown){
 async function load(blob:Blob|null,selected:any,inventory:unknown):Promise<string[]|null>{
  if(!(blob instanceof Blob)||!validIdentity(selected)||!isCapturedProjectInventory(inventory)||inventory.project_revision!==selected.project_revision)return null;
  try{
   const declarations=await readProjectTargetDeclarations(inventory);if(!declarations.source)return null;
   const targets=new Map(declarations.targets.map(t=>[JSON.stringify([t.group_id,t.field]),t]));

   const document=await readManifestJson(blob,{max_bytes:131072,max_depth:12}),data:any=document.data,span=document.numberSpan(['schema_version']);
   if(!exact(data,['schema_version','entries','truncated'])||![1,2].includes(data.schema_version)||!span||document.source.slice(span.start,span.end)!==String(data.schema_version)||data.truncated!==false||!Array.isArray(data.entries)||data.entries.length>4096)return null;
   let epoch=-1,tick=-1;const selectedRows:string[]=[];
   for(const row of data.entries){
    if(!exact(row,rowKeys)||!validIdentity(row.identity)||row.identity.session_id!==selected.session_id||row.identity.project_revision!==selected.project_revision||
       row.identity.run_epoch<epoch||(data.schema_version===1&&epoch>=0&&row.identity.run_epoch!==epoch)||
       typeof row.group_id!=='string'||!row.group_id||row.group_id.length>256||typeof row.field!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.field)||
       typeof row.value_bits!=='string'||!/^[0-9a-f]{16}$/.test(row.value_bits)||!['accepted','rejected'].includes(row.status))return null;
    const view=new DataView(new ArrayBuffer(8));view.setBigUint64(0,BigInt('0x'+row.value_bits),false);const value=view.getFloat64(0,false);if(!Number.isFinite(value))return null;const target=targets.get(JSON.stringify([row.group_id,row.field]));if(!target||(row.status==='accepted'&&(value<target.min||value>target.max)))return null;
    if(row.identity.run_epoch!==epoch){epoch=row.identity.run_epoch;tick=-1;}
    if(row.status==='accepted'){
     if(!Number.isSafeInteger(row.tick)||row.tick<tick||row.tick<0||!Number.isSafeInteger(row.lease_generation)||row.lease_generation<1)return null;
     tick=row.tick;
    }else if(row.tick!==null||row.lease_generation!==null)return null;
    if(sameIdentity(row.identity,selected))selectedRows.push(JSON.stringify([row.group_id,row.field,row.value_bits,row.status,row.tick]));
   }
   return selectedRows.length?selectedRows:null;
  }catch{return null;}
 }
 const [a,b]=await Promise.all([load(left,leftIdentity,leftInventory),load(right,rightIdentity,rightInventory)]);
 if(!a||!b)return Object.freeze({status:'unavailable' as const,provenance:'unverified' as const});
 return Object.freeze({status:(a.length===b.length&&a.every((x,i)=>x===b[i])?'match':'different') as 'match'|'different',provenance:'unverified' as const,leftCount:a.length,rightCount:b.length});
}
