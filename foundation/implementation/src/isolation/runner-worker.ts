import {createOneShotNativeJsLoader} from '../../../../runner-native-loader.mjs';

// The controller shares this worker realm. Capture every mutable built-in used
// after evaluation before admitting its source.
const apply = Reflect.apply;
const cloneNative = structuredClone;
const nativeGlobal = globalThis;
const prototypeOf = Object.getPrototypeOf;
const ownKeys = Reflect.ownKeys;
const ownDescriptor = Object.getOwnPropertyDescriptor;
const defineProperty = Object.defineProperty;
const create = Object.create;
const isArray = Array.isArray;
const finite = Number.isFinite;
const floor = Math.floor;
const NativeArray = Array;
const NativeNumber = Number;
const NativeString = String;
const stringCharCodeAt = String.prototype.charCodeAt;
const NativeTextEncoder = TextEncoder;
const encoder = new NativeTextEncoder();
const encode = NativeTextEncoder.prototype.encode;
const typedArrayByteLength = (() => {
  const getter = ownDescriptor(prototypeOf(Uint8Array.prototype), 'byteLength')?.get;
  if (typeof getter !== 'function') throw new Error('Native typed-array byteLength unavailable');
  return getter;
})();
const jsonStringify = JSON.stringify;
const promiseThen = Promise.prototype.then;
const noop = () => {};
const plainPrototype = Object.prototype;
const arrayPrototype = Array.prototype;
const loader = createOneShotNativeJsLoader();
const portPost = MessagePort.prototype.postMessage;
const portStart = MessagePort.prototype.start;
const portAddEvent = MessagePort.prototype.addEventListener;
const eventTargetAddEvent = EventTarget.prototype.addEventListener;
// The controller shares this worker realm and can replace browser prototype accessors.
// Capture MessageEvent.data before evaluating controller source and never read it dynamically.
const messageEventData = (() => {
  const getter = ownDescriptor(MessageEvent.prototype,'data')?.get;
  if (typeof getter !== 'function') throw new Error('Native MessageEvent.data unavailable');
  return getter;
})();
const now = performance.now.bind(performance);
const maxMemoryBytes = 16384;
const maxDiagnosticsBytes = 1024;
const maxObservationBytes = 2048;
const maxDepth = 12;
const maxNodes = 4096;
const maxMessagesPerWindow = 128;
const rateWindowMs = 1000;

type Authority = {
  session_id: string; project_revision: string; run_epoch: number; group_id: string;
  owner_id: string; lease_generation: number; observed_tick: number; apply_tick: number; sequence: number;
};
type Request = {kind: string; request_id: string; [key: string]: unknown};
type Controller = {initialize(...args: unknown[]): unknown; step(...args: unknown[]): unknown; dispose(...args: unknown[]): unknown};
type AncestorLink = {value: object; previous: AncestorLink | null};

let dataPort: MessagePort | undefined;
let send: ((value: unknown) => void) | undefined;
let controller: Controller | undefined;
let committedMemory: unknown;
let pending: {id: string; authority: Authority; memory: unknown} | undefined;
let stageInFlight=false;
let identity: {session_id: string; project_revision: string; run_epoch: number; group_id: string; owner_id: string; lease_generation: number} | undefined;
let controlWidth = 0;
let lastSequence = 0;
let lastObservedTick = -1;
let initialized = false;
let initializing = false;
let terminal = false;
let rateWindowStart = 0;
let rateCount = 0;

function hasOwn(value: object, key: PropertyKey): boolean { return ownDescriptor(value, key) !== undefined; }
function field(value: object, key: string): unknown {
  const descriptor = ownDescriptor(value, key);
  return descriptor && hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function exactDataRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = prototypeOf(value);
  if (proto !== plainPrototype && proto !== null) return false;
  const names = ownKeys(value);
  if (names.length !== keys.length) return false;
  for (let i = 0; i < names.length; i++) {
    if (typeof names[i] !== 'string') return false;
    let found = false;
    for (let j = 0; j < keys.length; j++) if (names[i] === keys[j]) { found = true; break; }
    if (!found) return false;
    const descriptor = ownDescriptor(value, names[i] as string);
    if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) return false;
  }
  return true;
}
function isSafeInt(value: unknown, min = 0): value is number {
  return typeof value === 'number' && finite(value) && floor(value) === value && value >= min && value <= 0x1fffffffffffff;
}
function hexRevision(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 64) return false;
  for (let i = 0; i < 64; i++) {
    const c = apply(stringCharCodeAt,value,[i]) as number;
    if (!((c >= 48 && c <= 57) || (c >= 97 && c <= 102))) return false;
  }
  return true;
}
function utf8Length(value: string): number {
  const encoded = apply(encode, encoder, [value]) as Uint8Array;
  return apply(typedArrayByteLength, encoded, []) as number;
}
function quotedStringLength(value: string): number {
  const json = apply(jsonStringify, undefined, [value]) as string;
  return utf8Length(json);
}
function arrayIndex(key: string, length: number): boolean {
  const number = NativeNumber(key);
  return isSafeInt(number) && number < length && NativeString(number) === key;
}
function defineArrayElement(target: unknown[], key: string, value: unknown): void {
  const descriptor = create(null) as PropertyDescriptor;
  descriptor.value = value;
  descriptor.writable = true;
  descriptor.enumerable = true;
  descriptor.configurable = true;
  defineProperty(target,key,descriptor);
}
function cloneBounded(value: unknown, byteLimit: number): {ok: true; value: unknown; bytes: number; nodes: number} | {ok: false} {
  let nodes = 0;
  let bytes = 0;
  let ancestors: AncestorLink | null = null;
  function visit(input: unknown, depth: number): {ok: boolean; value?: unknown} {
    nodes++;
    if (nodes > maxNodes || depth > maxDepth) return {ok: false};
    if (input === null) { bytes += 4; return {ok: bytes <= byteLimit, value: null}; }
    if (typeof input === 'boolean') { bytes += input ? 4 : 5; return {ok: bytes <= byteLimit, value: input}; }
    if (typeof input === 'number') {
      if (!finite(input)) return {ok: false};
      const text = apply(jsonStringify, undefined, [input]) as string;
      bytes += text.length; // finite JSON number syntax is ASCII; negative zero counts as "0".
      return {ok: bytes <= byteLimit, value: input};
    }
    if (typeof input === 'string') {
      if (input.length > byteLimit) return {ok: false};
      bytes += quotedStringLength(input);
      return {ok: bytes <= byteLimit, value: input};
    }
    if (typeof input !== 'object') return {ok: false};
    for (let entry = ancestors; entry; entry = entry.previous) if (entry.value === input) return {ok: false};
    const previous = ancestors;
    const current = create(null) as AncestorLink;
    current.value = input;
    current.previous = previous;
    ancestors = current;
    try {
      let output: unknown;
      if (isArray(input)) {
        if (prototypeOf(input) !== arrayPrototype) return {ok: false};
        const lengthDescriptor = ownDescriptor(input, 'length');
        if (!lengthDescriptor || !hasOwn(lengthDescriptor, 'value') || !isSafeInt(lengthDescriptor.value) || lengthDescriptor.value > maxNodes) return {ok: false};
        const length = lengthDescriptor.value as number;
        const names = ownKeys(input);
        if (names.length !== length + 1) return {ok: false};
        bytes += 2 + (length > 1 ? length - 1 : 0);
        const result = new NativeArray(length);
        for (let i = 0; i < length; i++) {
          const key = NativeString(i);
          const descriptor = ownDescriptor(input, key);
          if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) return {ok: false};
          const child = visit(descriptor.value, depth + 1);
          if (!child.ok) return {ok: false};
          defineArrayElement(result,key,child.value);
        }
        for (let i = 0; i < names.length; i++) {
          const key = names[i];
          if (key === 'length') continue;
          if (typeof key !== 'string' || !arrayIndex(key, length)) return {ok: false};
        }
        output = result;
      } else {
        const proto = prototypeOf(input);
        if (proto !== plainPrototype && proto !== null) return {ok: false};
        const names = ownKeys(input);
        const result = create(null) as Record<string, unknown>;
        bytes += 2 + (names.length > 1 ? names.length - 1 : 0);
        for (let i = 0; i < names.length; i++) {
          const key = names[i];
          if (typeof key !== 'string') return {ok: false};
          const descriptor = ownDescriptor(input, key);
          if (!descriptor || !hasOwn(descriptor, 'value') || !descriptor.enumerable) return {ok: false};
          bytes += quotedStringLength(key) + 1;
          const child = visit(descriptor.value, depth + 1);
          if (!child.ok) return {ok: false};
          result[key] = child.value;
        }
        output = result;
      }
      return {ok: bytes <= byteLimit, value: output};
    } finally {
      ancestors = previous;
    }
  }
  let validated: {ok: boolean; value?: unknown};
  try { validated = visit(value, 0); } catch { return {ok: false}; }
  if (!validated.ok || bytes > byteLimit) return {ok: false};
  // This clone retains IEEE-754 negative zero; JSON counting above never replaces it.
  try { return {ok: true, value: apply(cloneNative, nativeGlobal, [validated.value]), bytes, nodes}; }
  catch { return {ok: false}; }
}
function sameKeys(value: unknown, expected: readonly string[]): boolean { return exactDataRecord(value, expected); }
function validAuthority(value: unknown): value is Authority {
  if (!sameKeys(value, ['session_id','project_revision','run_epoch','group_id','owner_id','lease_generation','observed_tick','apply_tick','sequence'])) return false;
  const a = value as unknown as Authority;
  return typeof a.session_id === 'string' && a.session_id.length > 0 && hexRevision(a.project_revision) && isSafeInt(a.run_epoch) &&
    typeof a.group_id === 'string' && a.group_id.length > 0 && typeof a.owner_id === 'string' && a.owner_id.length > 0 &&
    isSafeInt(a.lease_generation, 1) && isSafeInt(a.observed_tick) && isSafeInt(a.apply_tick) && isSafeInt(a.sequence, 1);
}
function matchesIdentity(value: Authority): boolean {
  return !!identity && value.session_id === identity.session_id && value.project_revision === identity.project_revision &&
    value.run_epoch === identity.run_epoch && value.group_id === identity.group_id && value.owner_id === identity.owner_id &&
    value.lease_generation === identity.lease_generation;
}
function sendReply(request: Request, fields: Record<string, unknown>): void {
  if (!send) return;
  const reply = create(null) as Record<string, unknown>;
  reply.request_id = request.request_id;
  const keys = ownKeys(fields);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    if (typeof key === 'string') reply[key] = field(fields, key);
  }
  send(reply);
}
function fail(request: Request, code: string, fatal: boolean): void {
  if (fatal) terminal = true;
  sendReply(request, {kind:'error', code});
}
function rateAllowed(): boolean {
  const current = now();
  if (current - rateWindowStart >= rateWindowMs) { rateWindowStart = current; rateCount = 0; }
  rateCount++;
  return rateCount <= maxMessagesPerWindow;
}
function replyAuthority(request: Request): Authority | undefined {
  const a = field(request, 'authority');
  return validAuthority(a) && matchesIdentity(a) ? a : undefined;
}
function initializeRequest(request: Request): void {
  if (initialized || initializing || !exactDataRecord(request, ['kind','request_id','source','sourceId','identity','descriptor','parameters'])) {
    fail(request, 'PROTOCOL_FAULT', true); return;
  }
  const source = field(request, 'source'); const sourceId = field(request, 'sourceId');
  const descriptor = field(request, 'descriptor'); const inputIdentity = field(request, 'identity');
  if (typeof source !== 'string' || source.length > 131072 || typeof sourceId !== 'string' || sourceId.length < 1 || sourceId.length > 256 ||
      !exactDataRecord(descriptor, ['group_id','control_size','inputs','control_stride','observations']) ||
      !isSafeInt(field(descriptor, 'control_size'), 1) || (field(descriptor, 'control_size') as number) > 1024 ||
      !cloneBounded(descriptor, maxMemoryBytes).ok || !cloneBounded(field(request,'parameters'),maxMemoryBytes).ok ||
      !sameKeys(inputIdentity, ['session_id','project_revision','run_epoch','group_id','owner_id','lease_generation'])) {
    fail(request, 'INVALID_AUTHORITY', false); return;
  }
  const ids = inputIdentity as Record<string, unknown>;
  if (typeof ids.session_id !== 'string' || ids.session_id.length < 1 || ids.session_id.length > 256 || !hexRevision(ids.project_revision) || !isSafeInt(ids.run_epoch) ||
      typeof ids.group_id !== 'string' || ids.group_id.length < 1 || ids.group_id.length > 256 || typeof ids.owner_id !== 'string' || ids.owner_id.length < 1 || ids.owner_id.length > 256 ||
      !isSafeInt(ids.lease_generation, 1) || ids.group_id !== field(descriptor as object,'group_id')) {
    fail(request, 'INVALID_AUTHORITY', false); return;
  }
  const inputs = field(descriptor as object,'inputs');
  if (!isArray(inputs) || (inputs as unknown[]).length !== field(descriptor as object,'control_size')) { fail(request,'INVALID_AUTHORITY',false); return; }
  const safeDescriptor = cloneBounded(descriptor, maxMemoryBytes);
  const safeParameters = cloneBounded(field(request,'parameters'), maxMemoryBytes);
  if (!safeDescriptor.ok || !safeParameters.ok) { fail(request,'INVALID_AUTHORITY',false); return; }
  initializing = true;
  identity = {session_id:ids.session_id as string,project_revision:ids.project_revision as string,run_epoch:ids.run_epoch as number,
    group_id:ids.group_id as string,owner_id:ids.owner_id as string,lease_generation:ids.lease_generation as number};
  controlWidth = field(safeDescriptor.value as object,'control_size') as number;
  const loading = loader(source, sourceId, safeDescriptor.value);
  apply(promiseThen, loading, [(loaded: Awaited<ReturnType<typeof loader>>) => {
    if (terminal) return;
    if (!loaded.ok) { fail(request, 'CONTROLLER_FAULT', true); return; }
    controller = loaded.controller as Controller;
    let result: unknown;
    try { result = apply(controller.initialize, controller, [safeDescriptor.value, safeParameters.value]); }
    catch { fail(request, 'CONTROLLER_FAULT', true); return; }
    const finish = (value: unknown) => {
      if (terminal) return;
      try {
        const memory = cloneBounded(value, maxMemoryBytes);
        if (!memory.ok) { fail(request, 'INVALID_RESULT', true); return; }
        committedMemory = memory.value;
        initializing = false;
        initialized = true;
        sendReply(request, {kind:'initialized'});
      } catch { fail(request, 'INVALID_RESULT', true); }
    };
    if (isNativePromise(result)) apply(promiseThen, result, [finish, () => { if (!terminal) fail(request, 'CONTROLLER_FAULT', true); }]);
    else finish(result);
  }, () => fail(request, 'CONTROLLER_FAULT', true)]);
}
function isNativePromise(value: unknown): value is Promise<unknown> {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  try { apply(promiseThen, value, [noop, noop]); return true; } catch { return false; }
}
function suppressPromise(value: Promise<unknown>): void { try { apply(promiseThen, value, [noop, noop]); } catch {} }
function stageRequest(request: Request): void {
  if (!exactDataRecord(request, ['kind','request_id','stageId','authority','observation','intent'])) { fail(request,'PROTOCOL_FAULT',true); return; }
  const auth = replyAuthority(request);
  if (!auth || typeof field(request,'stageId') !== 'string' || (field(request,'stageId') as string).length < 1 ||
      pending || stageInFlight || auth.sequence !== lastSequence + 1 || auth.observed_tick !== auth.apply_tick || auth.observed_tick <= lastObservedTick) {
    fail(request, pending || stageInFlight ? 'STAGE_PENDING' : 'INVALID_AUTHORITY', false); return;
  }
  const observation = field(request,'observation');
  if (!sameKeys(observation,['session_id','project_revision','run_epoch','tick','sim_time','dt','samples']) ||
      field(observation as object,'session_id') !== auth.session_id || field(observation as object,'project_revision') !== auth.project_revision ||
      field(observation as object,'run_epoch') !== auth.run_epoch || field(observation as object,'tick') !== auth.observed_tick ||
      !finite(field(observation as object,'sim_time')) || !finite(field(observation as object,'dt')) ||
      !cloneBounded(observation,maxObservationBytes).ok || !cloneBounded(field(request,'intent'),maxDiagnosticsBytes).ok) {
    fail(request,'INVALID_AUTHORITY',false); return;
  }
  const safeObservation = cloneBounded(observation,maxObservationBytes);
  const safeIntent = cloneBounded(field(request,'intent'),maxDiagnosticsBytes);
  const safeMemory = cloneBounded(committedMemory,maxMemoryBytes);
  if (!safeObservation.ok || !safeIntent.ok || !safeMemory.ok) { fail(request,'INVALID_AUTHORITY',false); return; }
  let result: unknown;
  stageInFlight=true;
  try { result = apply(controller!.step, controller, [safeObservation.value,safeIntent.value,safeMemory.value]); }
  catch { fail(request,'CONTROLLER_FAULT',true); return; }
  if (isNativePromise(result)) apply(promiseThen,result,[(value: unknown) => finishStageSafely(request,auth,value),() => fail(request,'CONTROLLER_FAULT',true)]);
  else finishStageSafely(request,auth,result);
}
function finishStage(request: Request, auth: Authority, result: unknown): void {
  if (!result || typeof result !== 'object') { fail(request,'INVALID_RESULT',true); return; }
  const proto = prototypeOf(result);
  if (proto !== plainPrototype && proto !== null) { fail(request,'INVALID_RESULT',true); return; }
  const names = ownKeys(result);
  if (names.length < 2 || names.length > 3) { fail(request,'INVALID_RESULT',true); return; }
  const controlDescriptor = ownDescriptor(result,'control'); const memoryDescriptor = ownDescriptor(result,'memory'); const diagnosticsDescriptor = ownDescriptor(result,'diagnostics');
  if (!controlDescriptor || !hasOwn(controlDescriptor,'value') || !controlDescriptor.enumerable || !memoryDescriptor ||
      !hasOwn(memoryDescriptor,'value') || !memoryDescriptor.enumerable ||
      (diagnosticsDescriptor && (!hasOwn(diagnosticsDescriptor,'value') || !diagnosticsDescriptor.enumerable))) { fail(request,'INVALID_RESULT',true); return; }
  for (let i=0;i<names.length;i++) if (names[i] !== 'control' && names[i] !== 'memory' && names[i] !== 'diagnostics') { fail(request,'INVALID_RESULT',true); return; }
  const control = cloneBounded(controlDescriptor.value, maxMemoryBytes);
  const candidate = cloneBounded(memoryDescriptor.value, maxMemoryBytes);
  const diagnostics = diagnosticsDescriptor ? cloneBounded(diagnosticsDescriptor.value,maxDiagnosticsBytes) : undefined;
  if (!control.ok || !isArray(control.value) || (control.value as unknown[]).length !== controlWidth || !candidate.ok ||
      (diagnosticsDescriptor && !diagnostics?.ok)) { fail(request,'INVALID_RESULT',true); return; }
  for (let i=0;i<(control.value as unknown[]).length;i++) if (typeof (control.value as unknown[])[i] !== 'number' || !finite((control.value as number[])[i])) { fail(request,'INVALID_RESULT',true); return; }
  const id = field(request,'stageId') as string;
  stageInFlight=false;
  pending = {id,authority:auth,memory:candidate.value}; lastSequence = auth.sequence; lastObservedTick = auth.observed_tick;
  const reply = create(null) as Record<string, unknown>;
  reply.kind='stage'; reply.stageId=id; reply.authority=auth; reply.control=control.value;
  if (diagnosticsDescriptor) { if (!diagnostics || !diagnostics.ok) { fail(request,'INVALID_RESULT',true); return; } reply.diagnostics=diagnostics.value; }
  sendReply(request,reply);
}
function finishStageSafely(request: Request, auth: Authority, result: unknown): void {
  try { finishStage(request, auth, result); }
  catch { fail(request, 'INVALID_RESULT', true); }
}
function commitRequest(request: Request): void {
  if (!exactDataRecord(request,['kind','request_id','stageId','authority'])) { fail(request,'PROTOCOL_FAULT',true); return; }
  const auth=replyAuthority(request);
  if (!pending || !auth || field(request,'stageId') !== pending.id || auth.sequence !== pending.authority.sequence ||
      auth.observed_tick !== pending.authority.observed_tick || auth.apply_tick !== pending.authority.apply_tick) {
    fail(request,'INVALID_AUTHORITY',false); return;
  }
  committedMemory=apply(cloneNative,nativeGlobal,[pending.memory]);
  const id=pending.id; pending=undefined;
  sendReply(request,{kind:'committed',stageId:id,authority:auth});
}
function disposeRequest(request: Request): void {
  if (!exactDataRecord(request,['kind','request_id'])) { fail(request,'PROTOCOL_FAULT',true); return; }
  let result: unknown;
  try { result=apply(controller!.dispose,controller,[]); } catch { fail(request,'CONTROLLER_FAULT',true); return; }
  if (isNativePromise(result)) apply(promiseThen,result,[() => sendReply(request,{kind:'disposed'}),() => fail(request,'CONTROLLER_FAULT',true)]);
  else sendReply(request,{kind:'disposed'});
}
function onCommand(event: Event): void {
  const request=apply(messageEventData,event,[]) as Request;
  if (terminal || request === null || typeof request !== 'object' || !rateAllowed()) return;
  if (typeof field(request,'request_id') !== 'string' || (field(request,'request_id') as string).length < 1 ||
      (field(request,'request_id') as string).length > 128 || typeof field(request,'kind') !== 'string') return;
  const kind=field(request,'kind');
  if (kind==='initialize') { initializeRequest(request); return; }
  if (!initialized || !controller) { fail(request,'CLOSED',true); return; }
  if (kind==='stage') { stageRequest(request); return; }
  if (kind==='commit') { commitRequest(request); return; }
  if (kind==='dispose') { disposeRequest(request); return; }
  if (kind==='abort') { fail(request,'CLOSED',true); return; }
  fail(request,'PROTOCOL_FAULT',true);
}
function connect(event: Event): void {
  const message=apply(messageEventData,event,[]) as {kind?: string; port?: MessagePort};
  if (!message || message.kind !== 'c1-connect' || !message.port || dataPort) return;
  dataPort=message.port;
  send=value => apply(portPost,dataPort!,[value]);
  apply(portAddEvent,dataPort,['message',onCommand as EventListener]);
  apply(portStart,dataPort,[]);
}
apply(eventTargetAddEvent,self,['message',connect as EventListener]);
