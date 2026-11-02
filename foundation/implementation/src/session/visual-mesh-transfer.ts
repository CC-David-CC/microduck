import {copyBounded} from './project-world-wire.ts';
import {createVisualMeshReceiver} from './visual-mesh-receiver.ts';

/** One manager-owned visual catalog transfer. No simulation commands are issued here. */
export function createVisualMeshTransfer(input: {authority: unknown; replyLimit: number; timeoutMs: number; post: (message: unknown) => void}) {
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
  let transferId: string | null = null, receiver: ReturnType<typeof createVisualMeshReceiver> | null = null;
  let cancellationSent = false, closeSent = false, reason = new Error('Mesh transfer cancelled');
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
    state = 'terminal'; clearTimeout(timer); receiver?.abort(); receiver = null;
    const error = new Error('Mesh cleanup failure: ' + message); rejectResult(error); rejectDone(error);
  }
  function released(error?: Error, value?: unknown) {
    if (state === 'terminal') return;
    state = 'terminal'; clearTimeout(timer); receiver?.abort(); receiver = null;
    if (error) rejectResult(error); else resolveResult(value);
    resolveDone();
  }
  function send(message: unknown) {
    if ((message as any)?.kind === 'mesh-close') closeSent = true;
    try {post(message); return true;} catch {terminalFailure('Worker post failed'); return false;}
  }
  function sendCancel() {
    if (state !== 'cancelling' || transferId === null || cancellationSent) return;
    cancellationSent = true; send(envelope('mesh-cancel'));
  }
  function beginCancel(error: Error) {
    if (state === 'terminal' || state === 'cancelling') return;
    reason = error; state = 'cancelling'; receiver?.abort(); receiver = null; sendCancel();
  }
  function cancel() {beginCancel(new Error('Mesh transfer cancelled')); return done;}
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
      if (performance.now() >= deadline) {terminalFailure('deadline exceeded before confirmed release'); return true;}
      if (kind === 'mesh-chunk') {
        if (state === 'cancelling') return true;
        if (state !== 'receiving' || !receiver) {beginCancel(new Error('Unexpected mesh chunk')); return true;}
        let accepted: {sequence:number;ack_token:string}, complete: boolean;
        try {accepted=receiver.acceptChunk(raw); complete=receiver.complete;}
        catch {beginCancel(new Error('Invalid mesh chunk')); return true;}
        if (complete) state = 'closing';
        const next = complete ? {...envelope('mesh-close'),ack_token:accepted.ack_token} :
          {...envelope('mesh-pull'),sequence:accepted.sequence+1,ack_token:accepted.ack_token};
        queueMicrotask(() => {if (state === (complete ? 'closing' : 'receiving')) send(next);});
        return true;
      }
      const m: any = copyBounded(raw,Math.min(replyLimit,65536));
      const same = () => exact(m.identity,['session_id','project_revision','run_epoch']) &&
        m.identity.session_id === a.identity.session_id && m.identity.project_revision === a.identity.project_revision && m.identity.run_epoch === a.identity.run_epoch;
      if (kind === 'mesh-unavailable' && transferId === null && (state === 'opening' || state === 'cancelling') &&
          exact(m,['kind','request_id','generation','identity','reason']) && same() && ['busy','capacity'].includes(m.reason)) {
        released(state === 'cancelling' ? reason : new Error('Mesh unavailable: '+m.reason)); return true;
      }
      if (kind === 'mesh-manifest' && transferId === null && (state === 'opening' || state === 'cancelling')) {
        if (!text(m.transfer_id)) {terminalFailure('invalid manifest transfer identity'); return true;}
        transferId = m.transfer_id;
        try {receiver=createVisualMeshReceiver({...a,transfer_id:transferId},m,replyLimit);}
        catch {beginCancel(new Error('Invalid mesh manifest')); sendCancel(); return true;}
        if (state === 'cancelling') {receiver.abort(); receiver=null; sendCancel(); return true;}
        if (receiver.complete) {state='closing'; send(envelope('mesh-close'));}
        else {state='receiving'; send({...envelope('mesh-pull'),sequence:0});}
        return true;
      }
      if (kind === 'mesh-cancelled' && state === 'cancelling') {
        if (exact(m,['kind','request_id','generation','identity','transfer_id']) && m.transfer_id === transferId && same()) released(reason);
        return true;
      }
      if (kind === 'mesh-closed' && state === 'closing' && receiver) {
        try {const output=receiver.finish(m); released(undefined,output);} catch {beginCancel(new Error('Invalid mesh close'));}
        return true;
      }
      if (kind === 'mesh-closed' && state === 'cancelling' && closeSent &&
          exact(m,['kind','request_id','generation','identity','transfer_id']) && m.transfer_id === transferId && same()) {
        released(reason); return true;
      }
      if (kind === 'mesh-error' && transferId !== null && exact(m,['kind','request_id','generation','identity','transfer_id','reason']) &&
          m.transfer_id === transferId && same() && ['protocol','capacity'].includes(m.reason)) {released(new Error('Mesh Worker error: '+m.reason)); return true;}
      beginCancel(new Error('Invalid mesh message')); return true;
    } catch {beginCancel(new Error('Invalid mesh message')); return true;}
  }
  send(envelope('mesh-open'));
  return Object.freeze({result,done,cancel,receive});
}
