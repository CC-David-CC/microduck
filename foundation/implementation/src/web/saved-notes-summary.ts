import {readManifestJson} from '../projects/manifest-json.ts';

/** Summarize untrusted saved notes for display; this does not validate an experiment. */
export async function summarizeSavedNotes(content:Blob,revision:string):Promise<string>{
  const parsed=await readManifestJson(content,{max_bytes:65536,max_depth:12}),data:any=parsed.data,span=parsed.numberSpan(['schema_version']);
  const exact=(v:any,keys:string[])=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
  if(!exact(data,['schema_version','provenance','counts','rows'])||data.schema_version!==1||!span||parsed.source.slice(span.start,span.end)!=='1'||typeof data.provenance!=='string'||data.provenance.length>512||!Array.isArray(data.rows)||data.rows.length>32)throw Error('Invalid notes');
  const counts:Record<string,number>=Object.create(null),statuses=['planned','running','completed','cancelled','deadline','failed','unknown','unavailable'];for(const status of statuses)counts[status]=0;
  const seen=new Set<string>();
  for(const row of data.rows){
    if(!exact(row,['id','requested_ticks','declaration','identity','status','last_verified_tick','reported_steps'])||typeof row.id!=='string'||!/^local-[1-9][0-9]*$/.test(row.id)||seen.has(row.id)||!Number.isSafeInteger(row.requested_ticks)||row.requested_ticks<1||row.requested_ticks>4096||!exact(row.declaration,['project_revision','configuration_sha256','runtime_lock_sha256'])||row.declaration.project_revision!==revision||!/^[a-f0-9]{64}$/.test(row.declaration.configuration_sha256)||!/^[a-f0-9]{64}$/.test(row.declaration.runtime_lock_sha256)||!statuses.includes(row.status))throw Error('Invalid note');
    seen.add(row.id);counts[row.status]++;
    if(row.identity!==null&&(!exact(row.identity,['session_id','project_revision','run_epoch'])||typeof row.identity.session_id!=='string'||!row.identity.session_id||row.identity.session_id.length>256||row.identity.project_revision!==revision||!Number.isSafeInteger(row.identity.run_epoch)||row.identity.run_epoch<0))throw Error('Invalid note identity');
    if((row.last_verified_tick!==null&&(!Number.isSafeInteger(row.last_verified_tick)||row.last_verified_tick<0||row.last_verified_tick>row.requested_ticks))||(row.reported_steps!==null&&(!Number.isSafeInteger(row.reported_steps)||row.reported_steps<0)))throw Error('Invalid note outcome');
  }
  const items=statuses.filter(status=>counts[status]>0).map(status=>`${counts[status]} ${status}`);
  return `unverified reported notes; incomplete; ${data.rows.length} attempts${items.length?'; '+items.join('; '):''}`;
}
