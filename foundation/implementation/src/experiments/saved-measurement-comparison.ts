import {readManifestJson} from '../projects/manifest-json.ts';
import {inspectMeasuredAttemptRecord} from './measured-attempt-record.ts';

/** Compare declared-compatible, structurally inspected reports; never authenticate them. */
export async function compareSavedMeasurements(left:Blob,right:Blob,leftRevision:string,rightRevision:string){
 async function load(blob:Blob){const doc=await readManifestJson(blob,{max_bytes:131072,max_depth:20});const authority=(doc.data as any)?.measurement?.authority;if(!authority)throw Error('No measurement record');const result=await inspectMeasuredAttemptRecord(blob,authority,131072);if(!result.measurement||!result.measurement.complete||result.receipt.status!=='completed')throw Error('Incomplete measurement record');return result;}
 if(!/^[0-9a-f]{64}$/.test(leftRevision)||!/^[0-9a-f]{64}$/.test(rightRevision))throw Error('Invalid containing project');
 const [a,b]=await Promise.all([load(left),load(right)]);if(a.receipt.identity.project_revision!==leftRevision||b.receipt.identity.project_revision!==rightRevision)throw Error('Record does not match containing source');const x=a.measurement!,y=b.measurement!,keys=['project_revision','group_id','channel_id','definition_sha256'] as const;
 if(keys.some(k=>x.authority[k]!==y.authority[k])||a.receipt.requested_ticks!==b.receipt.requested_ticks)return Object.freeze({compatible:false as const,provenance:'unverified' as const});
 let validPairs=0,omitted=0,timingMismatches=0,exactDifferences=0,overflow=false,maxDifference=0;
 for(let i=0;i<x.entries.length;i++){
  const p=x.entries[i],q=y.entries[i];if(!q||p.observed_tick!==q.observed_tick)throw Error('Invalid measurement alignment');
  const u=p.sample,v=q.sample;if(u.validity!=='valid'||v.validity!=='valid'){omitted++;continue;}
  if(u.capture_tick!==v.capture_tick||u.available_tick!==v.available_tick||u.sequence!==v.sequence){timingMismatches++;continue;}
  if(u.values.length!==1||v.values.length!==1)throw Error('Invalid scalar values');validPairs++;
  if(!Object.is(u.values[0],v.values[0]))exactDifferences++;
  const delta=Math.abs(u.values[0]-v.values[0]);if(!Number.isFinite(delta))overflow=true;else maxDifference=Math.max(maxDifference,delta);
 }
 return Object.freeze({compatible:true as const,provenance:'unverified' as const,leftIdentity:a.receipt.identity,rightIdentity:b.receipt.identity,channel:x.authority.channel_id,boundaries:x.entries.length,validPairs,omitted,timingMismatches,exactDifferences,maxDifference:validPairs&&!overflow?maxDifference:null,overflow,configurationMatches:a.receipt.configuration_evidence.configuration_sha256===b.receipt.configuration_evidence.configuration_sha256,runtimeMatches:a.receipt.configuration_evidence.runtime_lock_sha256===b.receipt.configuration_evidence.runtime_lock_sha256});
}
