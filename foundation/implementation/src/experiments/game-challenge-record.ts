import {readManifestJson} from '../projects/manifest-json.ts';
import {bodyTurnRadians} from '../web/body-turn-radians.ts';

export function encodeQuaternionBits(value:unknown):string[] {
 bodyTurnRadians(value,value);return (value as number[]).map(v=>{const view=new DataView(new ArrayBuffer(8));view.setFloat64(0,v,false);return view.getBigUint64(0,false).toString(16).padStart(16,'0')});
}
function decodeQuaternionBits(value:unknown):number[] {
 if(!Array.isArray(value)||value.length!==4)throw Error('Invalid orientation bits');
 const decoded=value.map(bits=>{if(typeof bits!=='string'||!/^[0-9a-f]{16}$/.test(bits))throw Error('Invalid orientation bits');const view=new DataView(new ArrayBuffer(8));view.setBigUint64(0,BigInt('0x'+bits),false);const v=view.getFloat64(0,false);if(!Number.isFinite(v))throw Error('Invalid orientation');return v});
 bodyTurnRadians(decoded,decoded);return decoded;
}

/** Imported game results are display-only reports, never authority or proof of an experiment. */
export async function inspectGameChallenge(content:Blob,revision:string){
 const doc=await readManifestJson(content,{max_bytes:8192,max_depth:8}),x:any=doc.data,span=doc.numberSpan(['schema_version']);
 const exact=(v:any,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
 const base=['schema_version','kind','identity','body','threshold_radians','started_tick','checked_tick','angle_radians','status'];
 if(!exact(x,x.schema_version===2?[...base,'start_quaternion_bits','checked_quaternion_bits']:base)||![1,2].includes(x.schema_version)||!span||doc.source.slice(span.start,span.end)!==String(x.schema_version)||x.kind!=='body-turn'||!exact(x.identity,['session_id','project_revision','run_epoch'])||typeof x.identity.session_id!=='string'||!x.identity.session_id||x.identity.session_id.length>256||x.identity.project_revision!==revision||!Number.isSafeInteger(x.identity.run_epoch)||x.identity.run_epoch<0||typeof x.body!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(x.body)||typeof x.threshold_radians!=='number'||!Number.isFinite(x.threshold_radians)||x.threshold_radians<0.00001||x.threshold_radians>Math.PI||!Number.isSafeInteger(x.started_tick)||x.started_tick<0||!['completed','not_yet','not_checked','unknown'].includes(x.status))throw Error('Invalid game report');
 if(x.status==='completed'||x.status==='not_yet'){
  if(!Number.isSafeInteger(x.checked_tick)||x.checked_tick<x.started_tick||typeof x.angle_radians!=='number'||!Number.isFinite(x.angle_radians)||x.angle_radians<0||x.angle_radians>Math.PI||(x.status==='completed'&&(x.checked_tick===x.started_tick||x.angle_radians<x.threshold_radians))||(x.status==='not_yet'&&x.checked_tick>x.started_tick&&x.angle_radians>=x.threshold_radians))throw Error('Invalid game outcome');
 } else if(x.checked_tick!==null||x.angle_radians!==null)throw Error('Invalid incomplete game outcome');
 if(x.schema_version===2){
  const start=decodeQuaternionBits(x.start_quaternion_bits);
  if(x.status==='completed'||x.status==='not_yet'){
   const end=decodeQuaternionBits(x.checked_quaternion_bits),angle=bodyTurnRadians(start,end);
   if(Math.abs(angle-x.angle_radians)>1e-12||(x.status==='completed'&&angle<x.threshold_radians)||(x.status==='not_yet'&&x.checked_tick>x.started_tick&&angle>=x.threshold_radians))throw Error('Inconsistent reported orientation');
  } else if(x.checked_quaternion_bits!==null)throw Error('Unexpected end orientation');
 }
 return Object.freeze({kind:'structural-only' as const,provenance:'unverified' as const,body:x.body,status:x.status,started_tick:x.started_tick,checked_tick:x.checked_tick});
}
