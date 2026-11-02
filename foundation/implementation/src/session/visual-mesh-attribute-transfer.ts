import {copyBounded} from './project-world-wire.ts';
import {createVisualMeshAttributeReceiver} from './visual-mesh-attribute-receiver.ts';

/** One manager-owned visual catalog transfer. No simulation commands are issued here. */
export function createVisualMeshAttributeTransfer(input: {authority: unknown; replyLimit: number; timeoutMs: number; post: (message: unknown) => void}) {
  const {replyLimit, timeoutMs, post} = input;
  if (!Number.isSafeInteger(replyLimit) || replyLimit < 131072 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || typeof post !== 'function') throw Error('Invalid mesh transfer configuration');
  const exact = (v: any, keys: string[]) => !!v && typeof v === 'object' && !Array.isArray(v) &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null) && Reflect.ownKeys(v).length === keys.length &&
    keys.every(k => {const d = Object.getOwnPropertyDescriptor(v,k); return !!d && d.enumerable && Object.hasOwn(d,'value');});
  const text = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256;
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  const a: any = copyBounded(input.authority,65536);
  if (!exact(a,['request_id','generation','identity']) || !text(a.request_id) || !count(a.generation) ||
      !exact(a.identity,['session_id','project_revision','run_epoch']) || !text(a.identity.session_id) ||
      !text(a.identity.project_revision) || !count(a.identity.run_epoch)) throw Error('Invalid mesh authority');
  let state: 'opening'|'receiving'|'closing'|'cancelling'|'terminal' = 'opening';
  let transferId: string | null = null, receiver: ReturnType<typeof createVisualMeshAttributeReceiver> | null = null;
  let cancellationSent = false, closeSent = false, reason = new Error('Attribute transfer cancelled');
  let posting = false, reentrant: unknown = null, reentrantOverflow = false;
  let resolveResult!: (v: unknown) => void, rejectResult!: (e: Error) => void;
  let resolveDone!: () => void, rejectDone!: (e: Error) => void;
  const result = new Promise<unknown>((resolve,reject) => {resolveResult=resolve;rejectResult=reject;});
  const done = new Promise<void>((resolve,reject) => {resolveDone=resolve;rejectDone=reject;});
  void result.catch(() => {}); void done.catch(() => {});
  const deadline = performance.now() + timeoutMs;
  let timer: ReturnType<typeof setTimeout>;
  const envelope = (kind: string) => ({kind,...a,...(transferId === null ? {} : {transfer_id:transferId})});
  function terminalFailure(message: string) {
    if (state === 'terminal') return;
    state = 'terminal'; clearTimeout(timer); receiver?.abort(); receiver = null; reentrant = null;
    const error = new Error('Attribute cleanup failure: ' + message); rejectResult(error); rejectDone(error);
  }
  function released(error?: Error, value?: unknown) {
    if (state === 'terminal') return;
    state = 'terminal'; clearTimeout(timer); receiver?.abort(); receiver = null; reentrant = null;
    if (error) rejectResult(error); else resolveResult(value);
    resolveDone();
  }
  function send(message: unknown) {
    if (posting) {terminalFailure('Nested Worker post');return false;}
    if (performance.now() >= deadline) {terminalFailure('deadline exceeded before confirmed release');return false;}
    if ((message as any)?.kind === 'mesh-attributes-close') closeSent = true;
    posting = true;
    try {post(message);} catch {posting = false; terminalFailure('Worker post failed'); return false;}
    posting = false;
    if (reentrantOverflow) {reentrantOverflow=false;terminalFailure('Multiple reentrant Worker messages');return false;}
    const queued=reentrant;reentrant=null;
    if (queued !== null) receive(queued);
    if (state === 'cancelling') sendCancel();
    return true;
  }
  function sendCancel() {
    if (state !== 'cancelling' || transferId === null || cancellationSent) return;
    if (posting) return;
    cancellationSent = true; send(envelope('mesh-attributes-cancel'));
  }
  function beginCancel(error: Error) {
    if (state === 'terminal' || state === 'cancelling') return;
    reason = error; state = 'cancelling'; receiver?.abort(); receiver = null; sendCancel();
  }
  function cancel() {beginCancel(new Error('Attribute transfer cancelled')); return done;}
  timer = setTimeout(() => terminalFailure('deadline exceeded before confirmed release'), timeoutMs);
  function ownValue(value: any, key: string) {
    const d = Object.getOwnPropertyDescriptor(value,key);
    return d && Object.hasOwn(d,'value') && d.enumerable ? d.value : undefined;
  }
  function receive(value: unknown): boolean {
    if (state === 'terminal' || !value || typeof value !== 'object') return false;
    try {
      const raw: any = value;
      if (ownValue(raw,'request_id') !== a.request_id || ownValue(raw,'generation') !== a.generation) return false;
      const incomingId = ownValue(raw,'transfer_id');
      if (transferId !== null && incomingId !== undefined && incomingId !== transferId) return false;
      const kind = ownValue(raw,'kind');
      if (posting) {
        if (kind === 'mesh-attributes-chunk') {reentrantOverflow=true;return true;}
        if (reentrant !== null) reentrantOverflow=true;
        else {try {reentrant=copyBounded(raw,Math.min(replyLimit,65536));} catch {reentrantOverflow=true;}}
        return true;
      }
      if (performance.now() >= deadline) {terminalFailure('deadline exceeded before confirmed release'); return true;}
      if (kind === 'mesh-attributes-chunk') {
        if (state === 'cancelling') return true;
        if (state !== 'receiving' || !receiver) {beginCancel(new Error('Unexpected mesh chunk')); return true;}
        let accepted: {sequence:number;ack_token:string}, complete: boolean;
        try {accepted=receiver.acceptChunk(raw); complete=receiver.complete;}
        catch {beginCancel(new Error('Invalid mesh chunk')); return true;}
        if (complete) state = 'closing';
        const next = complete ? {...envelope('mesh-attributes-close'),ack_token:accepted.ack_token} :
          {...envelope('mesh-attributes-pull'),sequence:accepted.sequence+1,ack_token:accepted.ack_token};
        queueMicrotask(() => {if (state === (complete ? 'closing' : 'receiving')) send(next);});
        return true;
      }
      const m: any = copyBounded(raw,Math.min(replyLimit,65536));
      const same = () => exact(m.identity,['session_id','project_revision','run_epoch']) &&
        m.identity.session_id === a.identity.session_id && m.identity.project_revision === a.identity.project_revision && m.identity.run_epoch === a.identity.run_epoch;
      if (kind === 'mesh-attributes-unavailable' && transferId === null && (state === 'opening' || state === 'cancelling') &&
          exact(m,['kind','request_id','generation','identity','reason']) && same() && ['busy','capacity','unsupported'].includes(m.reason)) {
        released(state === 'cancelling' ? reason : new Error('Attribute unavailable: '+m.reason)); return true;
      }
      if (kind === 'mesh-attributes-manifest' && transferId === null && (state === 'opening' || state === 'cancelling')) {
        if (!text(m.transfer_id) || !same()) {terminalFailure('invalid manifest transfer identity'); return true;}
        transferId = m.transfer_id;
        if (state === 'cancelling') {sendCancel(); return true;}
        try {receiver=createVisualMeshAttributeReceiver({...a,transfer_id:transferId},m,replyLimit);}
        catch {beginCancel(new Error('Invalid mesh manifest')); sendCancel(); return true;}
        if (receiver.complete) {state='closing'; send(envelope('mesh-attributes-close'));}
        else {state='receiving'; send({...envelope('mesh-attributes-pull'),sequence:0});}
        return true;
      }
      if (kind === 'mesh-attributes-cancelled' && state === 'cancelling') {
        if (exact(m,['kind','request_id','generation','identity','transfer_id']) && m.transfer_id === transferId && same()) released(reason);
        return true;
      }
      if (kind === 'mesh-attributes-closed' && state === 'closing' && receiver) {
        try {const output=receiver.finish(m); released(undefined,output);} catch {beginCancel(new Error('Invalid mesh close'));}
        return true;
      }
      if (kind === 'mesh-attributes-closed' && state === 'cancelling' && closeSent &&
          exact(m,['kind','request_id','generation','identity','transfer_id']) && m.transfer_id === transferId && same()) {
        released(reason); return true;
      }
      if (kind === 'mesh-attributes-error' && transferId !== null && exact(m,['kind','request_id','generation','identity','transfer_id','reason']) &&
          m.transfer_id === transferId && same() && ['protocol','capacity'].includes(m.reason)) {released(new Error('Attribute Worker error: '+m.reason)); return true;}
      beginCancel(new Error('Invalid mesh message')); return true;
    } catch {beginCancel(new Error('Invalid mesh message')); return true;}
  }
  send(envelope('mesh-attributes-open'));
  return Object.freeze({result,done,cancel,receive});
}

