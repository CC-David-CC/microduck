import {readManifestJson} from '../projects/manifest-json.ts';
import {summarizeSavedTargets} from './saved-target-summary.ts';

/** Inspect untrusted history only; this function never authorizes or applies it. */
export async function readSavedTarget(content:Blob,revision:string) {
  if(!(content instanceof Blob) || typeof revision!=='string' || !/^[a-f0-9]{64}$/.test(revision))throw Error('Invalid target source');
  const owned=structuredClone(content);
  await summarizeSavedTargets(owned,revision);
  const parsed=await readManifestJson(owned,{max_bytes:1048576,max_depth:12}),data:any=parsed.data;
  if(data.truncated || data.entries.some((row:any)=>row.status==='unknown'))throw Error('Target history is incomplete');
  if(!data.entries.length)throw Error('No saved target');
  const epoch=data.entries.at(-1).identity.run_epoch;
  const selected=[...data.entries].reverse().find((row:any)=>row.identity.run_epoch===epoch && row.status==='accepted');
  if(!selected)throw Error('No accepted target in the latest run');
  const view=new DataView(new ArrayBuffer(8));view.setBigUint64(0,BigInt('0x'+selected.value_bits),false);
  return Object.freeze({group_id:selected.group_id,field:selected.field,value:view.getFloat64(0,false),
    source_epoch:epoch,source_tick:selected.tick,provenance:'unverified' as const});
}
