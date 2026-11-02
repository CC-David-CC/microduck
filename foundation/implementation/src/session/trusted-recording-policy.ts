import {validRecordingChannel} from '../experiments/measurement-recording-grant.ts';

/** Validate already-snapshotted trusted host policy, never project-supplied authority. */
export function validateTrustedRecordingPolicy(rows:any, revision:string): void {
  if (!Array.isArray(rows) || rows.length>256) throw Error('Invalid recording policy');
  const seen=new Set<string>();
  for (const row of rows) {
    if (!row || typeof row!=='object' || Array.isArray(row) || (Object.keys(row).length!==5 && !(Object.keys(row).length===6 && Object.hasOwn(row,'channel'))) ||
        !['project_revision','group_id','channel_id','definition_sha256','max_entries'].every(k=>Object.hasOwn(row,k)) ||
        row.project_revision!==revision || typeof row.group_id!=='string' || !row.group_id || row.group_id.length>256 ||
        typeof row.channel_id!=='string' || !row.channel_id || row.channel_id.length>256 ||
        typeof row.definition_sha256!=='string' || !/^[0-9a-f]{64}$/.test(row.definition_sha256) ||
        !Number.isSafeInteger(row.max_entries) || row.max_entries<1 || row.max_entries>256 ||
        (Object.hasOwn(row,'channel') && (!validRecordingChannel(row.channel) || row.channel.id!==row.channel_id ||
          row.channel.definition_sha256!==row.definition_sha256 || row.max_entries*row.channel.size>4096))) throw Error('Invalid recording policy');
    const key=JSON.stringify([row.group_id,row.channel_id]);
    if(seen.has(key))throw Error('Invalid recording policy');
    seen.add(key);
  }
}
