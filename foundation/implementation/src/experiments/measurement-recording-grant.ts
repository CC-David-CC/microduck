import {copyBounded, sameBoundedData} from '../session/project-world-wire.ts';
import {createMeasurementLog, createSampleLog} from './measurement-log.ts';

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


/** Validate the complete descriptor supplied by a trusted host or compiler. */
export function validRecordingChannel(channel:any):boolean {
 const channelKeys=['id','kind','size','unit','frame','definition_sha256','source_ids'];
 return exact(channel,channelKeys)&&typeof channel.id==='string'&&channel.id.length>0&&channel.id.length<=256&&
    typeof channel.definition_sha256==='string'&&/^[0-9a-f]{64}$/.test(channel.definition_sha256)&&
    ['truth','measurement','estimate'].includes(channel.kind)&&Number.isSafeInteger(channel.size)&&channel.size>=1&&channel.size<=64&&
    typeof channel.unit==='string'&&channel.unit.length>0&&channel.unit.length<=128&&
    (channel.frame===null||(typeof channel.frame==='string'&&channel.frame.length>0&&channel.frame.length<=256))&&
    Array.isArray(channel.source_ids)&&channel.source_ids.length<=64&&
    channel.source_ids.every((id:unknown)=>typeof id==='string'&&id.length>0&&id.length<=256)&&
    new Set(channel.source_ids).size===channel.source_ids.length;
}

/**
 * Both the host grant and the independently compiled channel descriptor are
 * trusted inputs. This binds their complete descriptors; it does not derive
 * the definition hash or establish that source data was produced safely.
 */
export function createGrantedChannelRecorder(requested:unknown,input:unknown,compiledChannel:unknown){
 const authority=copyBounded(requested,4096),grant=copyBounded(input,8192),channel=copyBounded(compiledChannel,8192);
 if(!exact(authority,keys)||!exact(grant,['purpose','authority','channel','max_entries'])||grant.purpose!=='channel-recording'||
    !exact(grant.authority,keys)||keys.some(k=>grant.authority[k]!==authority[k])||
    !validRecordingChannel(channel)||!validRecordingChannel(grant.channel)||!sameBoundedData(grant.channel,channel)||
    channel.id!==authority.channel_id||channel.definition_sha256!==authority.definition_sha256||
    !Number.isSafeInteger(grant.max_entries)||grant.max_entries<1||grant.max_entries>256)throw Error('Invalid channel recording grant');
 const log=createSampleLog(authority,grant.max_entries,channel.size);
 const description=Object.freeze({...channel,source_ids:Object.freeze(channel.source_ids.slice())});
 return Object.freeze({channel:description,log});
}
