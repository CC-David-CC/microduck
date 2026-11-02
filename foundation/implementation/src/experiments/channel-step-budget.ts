import {copyBounded} from '../session/project-world-wire.ts';
const keys=['request_id','generation','command_sequence','identity','start_tick','steps','attempt_token','authority'];
/** Conservative serialized batch bound before a physical step. */
export function channelStepBudget(requestInput:unknown,channelInput:unknown):number {
 const request=copyBounded(requestInput,8192),channel=copyBounded(channelInput,8192);
 if(!request||typeof request!=='object'||Array.isArray(request)||Object.keys(request).length!==keys.length||
    !keys.every(k=>Object.hasOwn(request,k))||!Number.isSafeInteger(request.start_tick)||request.start_tick<0||
    !Number.isSafeInteger(request.steps)||request.steps<1||request.steps>64||!Number.isSafeInteger(request.start_tick+request.steps)||
    !channel||typeof channel!=='object'||Array.isArray(channel)||!Number.isSafeInteger(channel.size)||channel.size<1||channel.size>64)throw Error('Invalid channel batch budget request');
 // The fixed envelope is measured as UTF-8. Each row has at most 256 bytes of
 // field/tick/validity overhead plus 26 bytes per finite double including its
 // separator. The bound is deliberately conservative and may reject a batch
 // that would happen to fit; callers can request a smaller batch.
 const fixed=new TextEncoder().encode(JSON.stringify({...request,channel,rows:[]})).length;
 const bound=fixed+request.steps*(256+26*channel.size);
 if(bound>65536)throw Error('Channel batch exceeds response budget');
 return bound;
}
