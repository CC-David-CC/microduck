import {copyBounded} from '../session/project-world-wire.ts';
import {createMeasurementLog} from './measurement-log.ts';

const keys=['session_id','project_revision','run_epoch','group_id','lease_generation','channel_id','definition_sha256'];
function exact(v:any,fields:readonly string[]):boolean{return !!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===fields.length&&fields.every(k=>Object.hasOwn(v,k));}

/** Both arguments are trusted-host data. Project code must never issue this grant. */
export function createGrantedMeasurementRecorder(requested:unknown,input:unknown){
 const authority=copyBounded(requested,4096),grant=copyBounded(input,8192);
 if(!exact(authority,keys)||!exact(grant,['purpose','authority','max_entries'])||grant.purpose!=='measurement-recording'||
    !exact(grant.authority,keys)||keys.some(k=>grant.authority[k]!==authority[k])||
    !Number.isSafeInteger(grant.max_entries)||grant.max_entries<1||grant.max_entries>256)throw Error('Invalid recording grant');
 return createMeasurementLog(authority,grant.max_entries);
}
