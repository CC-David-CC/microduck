import {readManifestJson} from '../projects/manifest-json.ts';

// This is a display-only view of attacker-controlled saved bytes. It grants no authority.
export async function summarizeSavedTargets(content:Blob,revision:string):Promise<string> {
  const document=await readManifestJson(content,{max_bytes:1048576,max_depth:12});
  const data:any=document.data,span=document.numberSpan(['schema_version']);
  const exact=(v:any,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
  if(!exact(data,['schema_version','entries','truncated'])||![1,2].includes(data.schema_version)||!span||document.source.slice(span.start,span.end)!==String(data.schema_version)||!Array.isArray(data.entries)||data.entries.length>4096||typeof data.truncated!=='boolean')throw Error('Invalid target summary');
  const visible:string[]=[];let session:string|null=null,lastEpoch=-1,lastTick=-1,unknown=false;
  for(const row of data.entries){
    if(!exact(row,['identity','group_id','field','value_bits','status','tick','lease_generation'])||!exact(row.identity,['session_id','project_revision','run_epoch'])||typeof row.identity.session_id!=='string'||!row.identity.session_id||row.identity.session_id.length>256||row.identity.project_revision!==revision||!Number.isSafeInteger(row.identity.run_epoch)||row.identity.run_epoch<0||typeof row.group_id!=='string'||!/^[A-Za-z0-9_.-]{1,128}$/.test(row.group_id)||typeof row.field!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(row.field)||typeof row.value_bits!=='string'||!/^[0-9a-f]{16}$/.test(row.value_bits)||!['accepted','rejected','unknown'].includes(row.status))throw Error('Invalid target summary row');
    if(session!==null&&session!==row.identity.session_id)throw Error('Mixed target sessions');session=row.identity.session_id;
    const epoch=row.identity.run_epoch;if(epoch<lastEpoch||(data.schema_version===1&&lastEpoch>=0&&epoch!==lastEpoch))throw Error('Invalid target epochs');if(epoch!==lastEpoch){lastEpoch=epoch;lastTick=-1;}
    if(row.status==='accepted'){if(!Number.isSafeInteger(row.tick)||row.tick<0||row.tick<lastTick||!Number.isSafeInteger(row.lease_generation)||row.lease_generation<1)throw Error('Invalid target position');lastTick=row.tick;}else{if(row.tick!==null||row.lease_generation!==null)throw Error('Invalid target outcome');if(row.status==='unknown')unknown=true;}
    const bits=new DataView(new ArrayBuffer(8));bits.setBigUint64(0,BigInt('0x'+row.value_bits),false);const value=bits.getFloat64(0,false);if(!Number.isFinite(value))throw Error('Invalid target value');
    if(visible.length<8)visible.push(`run ${epoch}: ${row.group_id}.${row.field} = ${Object.is(value,-0)?'-0':String(value)} (${row.status})`);
  }
  const hidden=data.entries.length-visible.length;
  return `unverified reported targets; ${data.entries.length} entries${data.truncated||unknown?'; incomplete':''}${visible.length?'; '+visible.join('; '):''}${hidden?`; ${hidden} more not shown`:''}`;
}
