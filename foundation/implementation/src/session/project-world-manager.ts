import {captureProjectInventory, type ProjectInventoryLimits} from '../projects/project-inventory.ts';
import {copyBounded, sameBoundedData as sameData} from './project-world-wire.ts';
import {projectVisualSnapshot, UnsupportedVisualError, VisualCapacityError} from '../display/visual-projection.ts';
import {safeProjectPath} from '../projects/project-path.ts';
import {collectMjcfClosure} from '../projects/mjcf-closure.ts';
import {validateModelAssets} from '../projects/model-assets-profile.ts';
import {prepareProjectControllers} from '../projects/project-controller-admission.ts';
import {openRunnerFrame} from '../isolation/runner-host.ts';
import {validateMeasuredStepResponse, validateChannelStepResponse} from '../experiments/measured-step-response.ts';
import {validRecordingChannel} from '../experiments/measurement-recording-grant.ts';
import {channelStepBudget} from '../experiments/channel-step-budget.ts';
import {commandBatchBudget,stepEnvelopeBudget} from '../experiments/command-batch-budget.ts';
import {commandGroupLayout} from '../experiments/command-group-layout.ts';
import {validateCommandBatch} from '../experiments/command-batch-validation.ts';
import {createVisualMeshTransfer} from './visual-mesh-transfer.ts';
import {createVisualMeshAttributeTransfer} from './visual-mesh-attribute-transfer.ts';

export class ResetFault extends Error {}
export class InspectionFault extends Error {}
export class OperationBusy extends Error {}
export class StepFault extends Error {}

type SourceFailureRecord = {facts: Readonly<{project_revision:string;asset_notices:readonly unknown[]}>; ready:boolean; valid:()=>boolean};
const sourceFailures = new WeakMap<object, SourceFailureRecord>();
/** Read only manager-created, cleanup-qualified source facts. */
export function readSourceMaterialFailure(value: unknown) {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
  const record = sourceFailures.get(value);
  return record && record.ready && record.valid() ? record.facts : null;
}

type Policy = {inventoryLimits: ProjectInventoryLimits; compileLimits: any; timeoutMs: number; maxReplyBytes: number; wasmUrl?: string};
type ControlledPolicy = {mount: HTMLElement; runnerOrigin: string; frameURL: string; frameTimeoutMs: number; approvedGrants: any[]; approvedRecordingGrants: any[]};
type Owner = Awaited<ReturnType<typeof openRunnerFrame>>;
type ResetPending = {id: string; phase: 'dispatching' | 'opening' | 'binding'; deadline: number; timer: ReturnType<typeof setTimeout>;
  oldIdentity: any; expectedIdentity: any; expectedInspection: any; expectedAudit: any;
  resolve: (value: unknown) => void; reject: (reason: Error) => void; completion: Promise<unknown>};
type Attempt = {generation: number; requestId: string; status: 'admitting' | 'staging' | 'opening' | 'binding' | 'ready' | 'active' | 'faulted' | 'retiring' | 'retired';
  deadline: number; timer: ReturnType<typeof setTimeout> | null; worker: Worker | null; handle: object;
  revision: string; entry: string; files: Map<string, {bytes:number;sha256:string}>; closure: Set<string>; identity: any; baseline: any; promoting: boolean; pendingResolve: (value: object) => void; pendingReject: (reason: Error) => void;
  owners?: Owner[]; ownerClosures?: Map<Owner, Promise<void>>; opening?: Promise<void>; retirement?: Promise<void>; expectedGroups?: any[]; expectedBlocks?: any[]; controllers?: any[]; admittedAudit?: any; expectedNotices?: any[];
  targetSequence?: number; targetPending?: {id:string; sequence:number; group_id:string; field:string; value:number; deadline:number; timer:ReturnType<typeof setTimeout>; resolve:(value:unknown)=>void; reject:(reason:Error)=>void; completion:Promise<unknown>};
  commandSequence?: number; commandEvidence?:{token:string;group_id:string;lease_generation:number;tick:number;continuation:object}|null; visualBinding?: {identity:any; bodyCount:number};
  meshPrefix?: string; meshSequence?: number;
  groupPrefix?: string; groupSequence?: number;
  rawVisualPrefix?: string; rawVisualSequence?: number;
  stepPending?: {id:string; sequence:number; steps:number; startTick:number; deadline:number; timer:ReturnType<typeof setTimeout>; resolve:(value:unknown)=>void; reject:(reason:Error)=>void; completion:Promise<unknown>; poseCount:number|null; recording:any; commandPlan:any};
  resetPending?: ResetPending;
  groupPending?: {id:string; deadline:number; timer:ReturnType<typeof setTimeout>; resolve:(value:unknown)=>void; reject:(error:Error)=>void};
  cleanup?: {id:string; stage:boolean; deadline:number; timer:ReturnType<typeof setTimeout>; resolve:()=>void; reject:(reason:Error)=>void};
  message: (event: MessageEvent) => void; error: () => void; inspect: null | {id: string; deadline: number; timer: ReturnType<typeof setTimeout>;
    resolve: (value: unknown) => void; reject: (reason: Error) => void; completion:Promise<unknown>; visual:boolean; raw?:boolean; baseline?:any}};
function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value); if (proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(value);
  return keys.every(key => typeof key === 'string' && [...required, ...optional].includes(key) &&
    !!Object.getOwnPropertyDescriptor(value, key) && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value')) &&
    required.every(key => Object.hasOwn(value, key));
}
function validForwardPose(value:any, identity:any, inspection:any, bodyCount:number): boolean {
  if (!fields(value,['identity','frame']) || !sameIdentity(value.identity,identity) ||
      !fields(value.frame,['engine_version','tick','time','bodies']) || value.frame.engine_version !== '3.17.0' ||
      !Object.is(value.frame.tick,inspection.plant.tick) || !Object.is(value.frame.time,inspection.plant.time) ||
      !Array.isArray(value.frame.bodies) || value.frame.bodies.length !== bodyCount || bodyCount < 1 || bodyCount > 64) return false;
  return value.frame.bodies.every((body:any,id:number) => {
    if (!fields(body,['id','position','quaternion']) || body.id !== id || !Array.isArray(body.position) || body.position.length !== 3 ||
        !Array.isArray(body.quaternion) || body.quaternion.length !== 4 ||
        !body.position.every((n:any)=>typeof n==='number' && Number.isFinite(n)) ||
        !body.quaternion.every((n:any)=>typeof n==='number' && Number.isFinite(n))) return false;
    return Math.abs(Math.hypot(...body.quaternion)-1) <= 1e-9;
  });
}
function snapshotEntries(entries: unknown, limits: ProjectInventoryLimits): Array<{path: string; data: Uint8Array}> {
  if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype) throw new Error('Invalid selected entries');
  const keys = Reflect.ownKeys(entries);
  if (keys.length !== entries.length + 1 || keys.some(key => key !== 'length' &&
      (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= entries.length))) throw new Error('Invalid selected entries');
  if (!Number.isSafeInteger(limits.max_files) || limits.max_files < 1 || entries.length > limits.max_files ||
      !Number.isSafeInteger(limits.max_total_bytes) || limits.max_total_bytes < 1 ||
      !Number.isSafeInteger(limits.max_file_bytes) || limits.max_file_bytes < 1) throw new Error('Invalid selected entry limits');
  const result: Array<{path: string; data: Uint8Array}> = []; let total = 0;
  for (let index = 0; index < entries.length; index++) {
    const item = Object.getOwnPropertyDescriptor(entries, String(index));
    if (!item || !Object.hasOwn(item, 'value') || !item.enumerable || !fields(item.value, ['path','data'])) throw new Error('Invalid selected entry');
    const path = Object.getOwnPropertyDescriptor(item.value, 'path')!.value;
    const data = Object.getOwnPropertyDescriptor(item.value, 'data')!.value;
    const typed = Object.getPrototypeOf(Uint8Array.prototype);
    if (typeof path !== 'string' || !(data instanceof Uint8Array) || !ArrayBuffer.isView(data) ||
        Reflect.get(typed, Symbol.toStringTag, data) !== 'Uint8Array') throw new Error('Invalid selected entry');
    const buffer = Reflect.get(typed, 'buffer', data), size: number = Reflect.get(typed, 'byteLength', data);
    if (!(buffer instanceof ArrayBuffer)) throw new Error('Shared or foreign selected bytes');
    Reflect.get(ArrayBuffer.prototype, 'byteLength', buffer);
    if (size > limits.max_file_bytes || size > limits.max_total_bytes - total) throw new Error('Selected byte budget exceeded');
    total += size; result.push({path, data:new Uint8Array(data)});
  }
  return result;
}
function sameIdentity(a: any, b: any) {
  return fields(a, ['session_id','project_revision','run_epoch']) && fields(b, ['session_id','project_revision','run_epoch']) &&
    typeof a.session_id === 'string' && a.session_id.length > 0 && a.session_id === b.session_id &&
    a.project_revision === b.project_revision && a.run_epoch === b.run_epoch;
}
function finiteArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isFinite(item));
}
function validRawVisual(model:any,frame:any,facts:any):boolean {
  const vector=(v:any,n:number)=>finiteArray(v) && v.length===n;
  const quaternion=(v:any)=>vector(v,4) && Math.abs(Math.hypot(...v)-1)<=1e-9;
  if (!fields(model,['engine_version','bodies','geoms']) || !fields(frame,['engine_version','tick','time','bodies']) ||
      model.engine_version!=='3.17.0' || frame.engine_version!=='3.17.0' || !count(frame.tick) ||
      typeof frame.time!=='number' || !Number.isFinite(frame.time) || frame.time<0 ||
      !Array.isArray(model.bodies) || model.bodies.length<1 || model.bodies.length>4096 ||
      !Array.isArray(frame.bodies) || frame.bodies.length!==model.bodies.length || !Array.isArray(model.geoms) ||
      model.geoms.length>1024 || model.geoms.length!==facts?.ngeom || !count(facts?.nmat)) return false;
  for(let id=0;id<model.bodies.length;id++) {
    const m=model.bodies[id],b=frame.bodies[id];
    if(!fields(m,['id','name','parent_id']) || m.id!==id || !(m.name===null||typeof m.name==='string') ||
       (id===0?m.parent_id!==null:!count(m.parent_id)||m.parent_id>=id) ||
       !fields(b,['id','position','quaternion']) || b.id!==id || !vector(b.position,3) || !quaternion(b.quaternion)) return false;
  }
  for(let id=0;id<model.geoms.length;id++) {
    const g=model.geoms[id];
    if(!fields(g,['id','name','body_id','type','material_id','size','position','quaternion','rgba']) || g.id!==id ||
       !(g.name===null||typeof g.name==='string') || !count(g.body_id) || g.body_id>=model.bodies.length ||
       !['plane','hfield','sphere','capsule','ellipsoid','cylinder','box','mesh','sdf','unsupported'].includes(g.type) ||
       !(g.material_id===null || (count(g.material_id) && g.material_id<facts.nmat)) || !vector(g.size,3) ||
       g.size.some((x:number)=>x<0) || !vector(g.position,3) || !quaternion(g.quaternion) || !vector(g.rgba,4) ||
       g.rgba.some((x:number)=>x<0||x>1)) return false;
  }
  return true;
}
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function validInspection(value: any, identity: any) {
  if (!fields(value, ['identity','phase','plant','commands','due_group_ids','fault']) ||
      !sameIdentity(value.identity, identity) || value.phase !== 'paused' || value.fault !== null ||
      !fields(value.plant, ['tick','time','qpos','qvel','activation','control','actuator_force','sensors']) ||
      !count(value.plant.tick) || typeof value.plant.time !== 'number' || !Number.isFinite(value.plant.time) || value.plant.time < 0 ||
      !['qpos','qvel','activation','control','actuator_force','sensors'].every(key => finiteArray(value.plant[key])) ||
      !fields(value.commands, ['identity','control','groups']) || !sameIdentity(value.commands.identity, identity) ||
      !finiteArray(value.commands.control) || value.commands.control.length !== value.plant.control.length ||
      value.commands.control.some((n: number, i: number) => !Object.is(n, value.plant.control[i])) ||
      !Array.isArray(value.commands.groups) || !Array.isArray(value.due_group_ids)) return false;
  const groups = new Set<string>();
  for (const group of value.commands.groups) {
    if (!fields(group, ['lease','accepted_sequence','last_control_tick','fresh_at_tick']) ||
        !fields(group.lease, ['group_id','owner_id','generation','control_stride']) ||
        typeof group.lease.group_id !== 'string' || !group.lease.group_id || groups.has(group.lease.group_id) ||
        typeof group.lease.owner_id !== 'string' || !group.lease.owner_id ||
        !count(group.lease.generation) || group.lease.generation < 1 ||
        !count(group.lease.control_stride) || group.lease.control_stride < 1 || !count(group.accepted_sequence) ||
        (group.last_control_tick !== null && !count(group.last_control_tick)) ||
        (group.fresh_at_tick !== null && !count(group.fresh_at_tick))) return false;
    groups.add(group.lease.group_id);
  }
  return new Set(value.due_group_ids).size === value.due_group_ids.length &&
    value.due_group_ids.every((id: unknown) => typeof id === 'string' && groups.has(id));
}
/** Verify host-known authority and sample/hold cadence, independent of reply assertions. */
function validStepProgress(before: any, after: any, steps: number, attempt: Attempt): boolean {
  if (!before || !after || !Number.isSafeInteger(steps) || steps < 1 || steps > 64 ||
      after.plant.tick !== before.plant.tick + steps || after.plant.time <= before.plant.time) return false;
  for (const key of ['qpos','qvel','activation','control','actuator_force','sensors']) {
    if (!Array.isArray(before.plant[key]) || !Array.isArray(after.plant[key]) ||
        before.plant[key].length !== after.plant[key].length) return false;
  }
  const oldGroups = before.commands.groups, newGroups = after.commands.groups;
  if (!Array.isArray(oldGroups) || !Array.isArray(newGroups) || oldGroups.length !== newGroups.length ||
      !Array.isArray(attempt.expectedGroups) || !Array.isArray(attempt.expectedBlocks)) return false;
  const finalDue: string[] = [];
  for (let index=0; index<oldGroups.length; index++) {
    const old = oldGroups[index], next = newGroups[index], stride = old.lease.control_stride;
    if (!next || !sameData(old.lease, next.lease)) return false;
    let sequence = old.accepted_sequence, last = old.last_control_tick, fresh = old.fresh_at_tick, updated = false;
    for (let tick=before.plant.tick; tick<after.plant.tick; tick++) {
      if (tick % stride === 0 || fresh === tick) {
        if (!Number.isSafeInteger(sequence + 1)) return false;
        sequence++; last=tick; fresh=null; updated=true;
      }
    }
    if (next.accepted_sequence !== sequence || next.last_control_tick !== last || next.fresh_at_tick !== fresh) return false;
    if (after.plant.tick % stride === 0 || fresh === after.plant.tick) finalDue.push(old.lease.group_id);
    if (!updated) {
      const group = attempt.expectedGroups.find(item => item.group_id === old.lease.group_id);
      if (!group || !Array.isArray(group.actuator_names)) return false;
      for (const name of group.actuator_names) {
        const block = attempt.expectedBlocks.find(item => item.actuator_name === name);
        if (!block || !Array.isArray(block.engine_indices)) return false;
        for (const position of block.engine_indices) {
          if (!Number.isSafeInteger(position) || position < 0 || position >= before.commands.control.length ||
              !Object.is(before.commands.control[position], after.commands.control[position])) return false;
        }
      }
    }
  }
  return sameData(after.due_group_ids, finalDue);
}
function validAudit(audit: any, attempt: Attempt, policy: Policy) {
  const notices = attempt.expectedNotices;
  if (!notices || !fields(audit, ['project_revision','entry_path','closure_paths','staged_files','staging_attempts','lookups','model_facts'], notices.length ? ['asset_notices'] : []) ||
      (notices.length ? !Object.hasOwn(audit,'asset_notices') || !sameData(audit.asset_notices,notices) : Object.hasOwn(audit,'asset_notices')) ||
      audit.project_revision !== attempt.revision || audit.entry_path !== attempt.entry ||
      !Array.isArray(audit.closure_paths) || !Array.isArray(audit.staged_files) ||
      !Array.isArray(audit.staging_attempts) || !Array.isArray(audit.lookups) ||
      !fields(audit.model_facts, ['version','ngeom','nmesh','nmat','ntex','texture_width','texture_height']) ||
      audit.model_facts.version !== '3.17.0' || !['ngeom','nmesh','nmat','ntex'].every(key => count(audit.model_facts[key])) ||
      !Array.isArray(audit.model_facts.texture_width) || !Array.isArray(audit.model_facts.texture_height) ||
      audit.model_facts.texture_width.length !== audit.model_facts.ntex || audit.model_facts.texture_height.length !== audit.model_facts.ntex ||
      !audit.model_facts.texture_width.every(count) || !audit.model_facts.texture_height.every(count)) return false;
  const recordCap = policy.compileLimits.audit.max_records, byteCap = policy.compileLimits.audit.max_bytes;
  if (!Number.isSafeInteger(recordCap) || recordCap < 1 || !Number.isSafeInteger(byteCap) || byteCap < 1 ||
      audit.lookups.length + notices.length > recordCap || new TextEncoder().encode(JSON.stringify(audit)).length > byteCap) return false;
  const closure = new Set<string>();
  for (const path of audit.closure_paths) {
    if (typeof path !== 'string' || !attempt.files.has(path) || !attempt.closure.has(path) || closure.has(path)) return false;
    closure.add(path);
  }
  if (!closure.has(attempt.entry) || closure.size !== attempt.closure.size || audit.staged_files.length !== closure.size || audit.staging_attempts.length !== closure.size) return false;
  const staged = new Set<string>(), attempts = new Set<string>();
  for (const file of audit.staged_files) {
    if (!fields(file, ['project_path','engine_path','bytes','sha256']) || typeof file.project_path !== 'string' ||
        !closure.has(file.project_path) || staged.has(file.project_path)) return false;
    const selected = attempt.files.get(file.project_path)!;
    if (file.engine_path !== '/brf-project/' + file.project_path || file.bytes !== selected.bytes || file.sha256 !== selected.sha256) return false;
    staged.add(file.project_path);
  }
  for (const row of audit.staging_attempts) {
    if (!fields(row, ['project_path','outcome']) || !closure.has(row.project_path) ||
        attempts.has(row.project_path) || row.outcome !== 'present') return false;
    attempts.add(row.project_path);
  }
  let entryOpened = false;
  for (let index = 0; index < audit.lookups.length; index++) {
    const row = audit.lookups[index];
    if (!fields(row, ['sequence','operation','engine_path','project_path','sha256','outcome']) ||
        row.sequence !== index + 1 || !['stat','lstat','open','read'].includes(row.operation) ||
        typeof row.engine_path !== 'string' || !row.engine_path.startsWith('/brf-project/') ||
        !['present','missing-candidate'].includes(row.outcome)) return false;
    if (row.outcome === 'present') {
      if (typeof row.project_path !== 'string' || !closure.has(row.project_path) ||
          row.engine_path !== '/brf-project/' + row.project_path || row.sha256 !== attempt.files.get(row.project_path)!.sha256) return false;
      if (row.operation === 'open' && row.project_path === attempt.entry) entryOpened = true;
    } else if (row.project_path !== null || row.sha256 !== null) return false;
  }
  return entryOpened;
}

/** Owns a paused project world and one staged replacement; not a C1 session. */
export function createProjectWorldManager(input: Policy) { return createManager(input); }

/** Trusted Window-only controller-ready staging. Imported packages do not supply
 * runner origins, grants, owner IDs, or frame factories. */
export function createControlledProjectWorldManager(input: any) {
  if (!fields(input, ['inventoryLimits','compileLimits','timeoutMs','maxReplyBytes',
      'mount','runnerOrigin','frameURL','frameTimeoutMs','approvedGrants'], ['wasmUrl','approvedRecordingGrants'])) throw new Error('Invalid controlled manager policy');
  const get = (key: string) => Object.getOwnPropertyDescriptor(input, key)!.value;
  const mount = get('mount'), runnerOrigin = get('runnerOrigin'), frameURL = get('frameURL'), frameTimeoutMs = get('frameTimeoutMs');
  if (!mount || typeof mount !== 'object' || typeof runnerOrigin !== 'string' || typeof frameURL !== 'string' ||
      !Number.isSafeInteger(frameTimeoutMs) || frameTimeoutMs < 1 || frameTimeoutMs > 60000) throw new Error('Invalid runner frame policy');
  const budget = get('maxReplyBytes');
  const approvedGrants = copyBounded(get('approvedGrants'), budget);
  if (!Array.isArray(approvedGrants) || approvedGrants.length > 256) throw new Error('Invalid approved grant policy');
  const seen = new Set<string>(), channels = new Map<string,string>();
  for (const row of approvedGrants) {
    if (!fields(row, ['group_id','channel_id','definition_sha256']) || typeof row.group_id !== 'string' || !row.group_id ||
        row.group_id.length > 256 || typeof row.channel_id !== 'string' || !row.channel_id || row.channel_id.length > 256 ||
        typeof row.definition_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.definition_sha256)) throw new Error('Invalid approved grant policy');
    const key = JSON.stringify([row.group_id,row.channel_id]);
    if (seen.has(key) || (channels.has(row.channel_id) && channels.get(row.channel_id) !== row.definition_sha256)) throw new Error('Invalid approved grant policy');
    seen.add(key); channels.set(row.channel_id,row.definition_sha256);
  }
  const approvedRecordingGrants = copyBounded(Object.hasOwn(input,'approvedRecordingGrants') ? get('approvedRecordingGrants') : [], budget);
  if (!Array.isArray(approvedRecordingGrants) || approvedRecordingGrants.length > 256) throw new Error('Invalid recording policy');
  const recordingKeys = new Set<string>();
  for (const row of approvedRecordingGrants) {
    if (!fields(row,['project_revision','group_id','channel_id','definition_sha256','max_entries'],['channel']) ||
        typeof row.project_revision !== 'string' || !/^[0-9a-f]{64}$/.test(row.project_revision) ||
        typeof row.group_id !== 'string' || !row.group_id || row.group_id.length > 256 ||
        typeof row.channel_id !== 'string' || !row.channel_id || row.channel_id.length > 256 ||
        typeof row.definition_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.definition_sha256) ||
        !Number.isSafeInteger(row.max_entries) || row.max_entries < 1 || row.max_entries > 256 ||
        (Object.hasOwn(row,'channel') && (!validRecordingChannel(row.channel) || row.channel.id !== row.channel_id ||
          row.channel.definition_sha256 !== row.definition_sha256 || row.max_entries * row.channel.size > 4096))) throw new Error('Invalid recording policy');
    const key=JSON.stringify([row.project_revision,row.group_id,row.channel_id]);
    if (recordingKeys.has(key)) throw new Error('Invalid recording policy');
    recordingKeys.add(key);
  }
  const policy: any = {inventoryLimits:get('inventoryLimits'),compileLimits:get('compileLimits'),
    timeoutMs:get('timeoutMs'),maxReplyBytes:budget};
  if (Object.hasOwn(input,'wasmUrl')) policy.wasmUrl=get('wasmUrl');
  return createManager(policy, {mount,runnerOrigin,frameURL,frameTimeoutMs,approvedGrants,approvedRecordingGrants});
}

function createManager(input: Policy, controlled?: ControlledPolicy) {
  if (!fields(input, ['inventoryLimits','compileLimits','timeoutMs','maxReplyBytes'], ['wasmUrl'])) throw new Error('Invalid manager policy');
  const timeout = Object.getOwnPropertyDescriptor(input, 'timeoutMs')!.value;
  const budget = Object.getOwnPropertyDescriptor(input, 'maxReplyBytes')!.value;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647 || !Number.isSafeInteger(budget) || budget < 1) throw new Error('Invalid manager limits');
  const policy = copyBounded(input, budget) as Policy;
  if (policy.wasmUrl !== undefined && typeof policy.wasmUrl !== 'string') throw new Error('Invalid WASM URL');
  let generation = 0, disposed = false;
  const cleanupHealth = {ok:true};
  let disposal: Promise<void> | null = null;
  let active: Attempt | null = null, candidate: Attempt | null = null;
  let meshJob: {attempt:Attempt; requestId:string; transfer:ReturnType<typeof createVisualMeshTransfer>} | null = null;
  function issuedMeshRequest(attempt: Attempt, id: unknown, gen: unknown): boolean {
    if (!count(gen) || typeof id !== 'string' || !attempt.meshPrefix || !id.startsWith(attempt.meshPrefix)) return false;
    const suffix = id.slice(attempt.meshPrefix.length);
    if (!/^[1-9][0-9]*$/.test(suffix)) return false;
    const sequence = Number(suffix);
    return Number.isSafeInteger(sequence) && sequence <= (attempt.meshSequence ?? 0);
  }
  function issuedGroupRequest(attempt:Attempt,id:unknown): boolean {
    if (typeof id!=='string' || !attempt.groupPrefix || !id.startsWith(attempt.groupPrefix)) return false;
    const suffix=id.slice(attempt.groupPrefix.length);
    if (!/^[1-9][0-9]*$/.test(suffix)) return false;
    const sequence=Number(suffix);
    return Number.isSafeInteger(sequence) && sequence<=(attempt.groupSequence ?? 0);
  }
  function issuedRawVisual(attempt:Attempt,id:unknown): boolean {
    if(typeof id!=='string' || !attempt.rawVisualPrefix || !id.startsWith(attempt.rawVisualPrefix))return false;
    const suffix=id.slice(attempt.rawVisualPrefix.length);
    if(!/^[1-9][0-9]*$/.test(suffix))return false;
    const sequence=Number(suffix);
    return Number.isSafeInteger(sequence) && sequence<=(attempt.rawVisualSequence ?? 0);
  }
  type RunJob = {attempt:Attempt; identity:any; stopping:boolean; inFlight:boolean; timer:ReturnType<typeof setTimeout>|null; promise:Promise<unknown>; resolve:(value:unknown)=>void; reject:(reason:Error)=>void; settled:boolean};
  let poseSink:{attempt:Attempt;identity:any;callback:(value:unknown)=>void;pending:any;raf:number|null}|null=null;
  function clearPoseSink(){const old=poseSink;poseSink=null;if(old?.raf!==null&&old?.raf!==undefined)cancelAnimationFrame(old.raf);}
  function discardPendingPose(){if(poseSink){if(poseSink.raf!==null)cancelAnimationFrame(poseSink.raf);poseSink.raf=null;poseSink.pending=null;}}
  function deliverPose(attempt:Attempt,value:any){
    const owner=poseSink;if(!owner||owner.attempt!==attempt)return;
    owner.pending=value;
    if(owner.raf!==null)return;
    try {owner.raf=requestAnimationFrame(()=>{owner.raf=null;const item=owner.pending;owner.pending=null;if(poseSink!==owner||active!==attempt||attempt.status!=='active'||!sameIdentity(owner.identity,attempt.identity))return;try{owner.callback(item)}catch{/* presentation cannot fault physics */}})}
    catch {owner.pending=null;owner.raf=null;}
  }
  let runJob: RunJob | null = null;
  let pauseBarrier: {attempt:Attempt; promise:Promise<unknown>} | null = null;
  function abortRun(attempt: Attempt, reason: string, cause?: Error) {
    const job = runJob;
    if (!job || job.attempt !== attempt || job.settled) return;
    job.settled = true; if (job.timer !== null) clearTimeout(job.timer);
    runJob = null; job.reject(cause ?? Object.assign(new Error(reason), {outcome_unknown:true}));
  }
  function finishRun(job: RunJob) {
    if (job.settled) return;
    if (disposed || active !== job.attempt || job.attempt.status !== 'active') { abortRun(job.attempt, 'Active world unavailable'); return; }
    job.settled = true; if (job.timer !== null) clearTimeout(job.timer);
    runJob = null;
    job.resolve({identity:copyBounded(job.attempt.identity, budget), inspection:copyBounded(job.attempt.baseline, budget)});
  }
  const orphaned = new Set<Attempt>();
  const handles = new WeakMap<object, Attempt>();
  function closeOwner(attempt: Attempt, owner: Owner): Promise<void> {
    const closings = attempt.ownerClosures ??= new Map();
    const existing = closings.get(owner);
    if (existing) return existing;
    const task = Promise.resolve().then(() => owner.close());
    closings.set(owner, task);
    void task.catch(() => {});
    return task;
  }
  function stop(attempt: Attempt, reason: string, rejectPending = true, rejection?: Error) {
    if (attempt.status === 'retired' || attempt.retirement) return;
    if(poseSink?.attempt===attempt)clearPoseSink();
    const wasPending = ['admitting','staging','opening','binding'].includes(attempt.status);
    attempt.status = 'retiring';
    if (attempt.timer !== null) { clearTimeout(attempt.timer); attempt.timer = null; }
    if (attempt.inspect) { clearTimeout(attempt.inspect.timer); attempt.inspect.reject(new InspectionFault(reason)); attempt.inspect = null; }
    if (attempt.groupPending) {clearTimeout(attempt.groupPending.timer); attempt.groupPending.reject(new InspectionFault(reason)); attempt.groupPending=undefined;}
    if (attempt.cleanup) { clearTimeout(attempt.cleanup.timer); attempt.cleanup.reject(new Error(reason)); attempt.cleanup = undefined; }
    if (attempt.resetPending) {
      clearTimeout(attempt.resetPending.timer);
      attempt.resetPending.reject(new ResetFault(reason));
      attempt.resetPending = undefined;
    }
    if(attempt.targetPending){clearTimeout(attempt.targetPending.timer);attempt.targetPending.reject(Object.assign(new Error(reason),{outcome_unknown:true}));attempt.targetPending=undefined;}
    if (attempt.stepPending) {
      clearTimeout(attempt.stepPending.timer);
      const error = Object.assign(new StepFault(reason), {outcome_unknown:true,...(attempt.stepPending.recording ? {measurement_incomplete:true} : {})});
      attempt.stepPending.reject(error); attempt.stepPending = undefined;
    }
    if (wasPending && rejectPending) attempt.pendingReject(rejection ?? new Error(reason));
    let terminationError: unknown;
    if (attempt.worker) {
      attempt.worker.removeEventListener('message', attempt.message);
      attempt.worker.removeEventListener('error', attempt.error);
      attempt.worker.removeEventListener('messageerror', attempt.error);
      try { attempt.worker.terminate(); attempt.worker = null; }
      catch (error) { terminationError = error; orphaned.add(attempt); }
    }
    if (controlled && (attempt.opening || attempt.owners?.length)) {
      orphaned.add(attempt);
      for (const owner of attempt.owners ?? []) closeOwner(attempt, owner);
      const task = (async () => {
        if (attempt.opening) await attempt.opening.catch(() => {});
        const owners = attempt.owners ?? [];
        const results = await Promise.allSettled(owners.map(owner => closeOwner(attempt, owner)));
        attempt.owners = owners.filter((_, index) => results[index].status === 'rejected');
        for (const owner of attempt.owners) attempt.ownerClosures?.delete(owner);
        if (terminationError || attempt.owners.length) throw new Error('Candidate retirement failed');
        attempt.status = 'retired'; orphaned.delete(attempt);
      })();
      attempt.retirement = task;
      void task.catch(() => { if (attempt.retirement === task) attempt.retirement = undefined; });
    } else if (!terminationError) {
      attempt.status = 'retired'; orphaned.delete(attempt);
    }
    if (terminationError) throw terminationError;
  }
  function candidateFailure(attempt: Attempt, reason: string) {
    const eligible = candidate === attempt && !disposed && cleanupHealth.ok &&
      ['admitting','staging','opening','binding'].includes(attempt.status) && !!attempt.expectedNotices?.length &&
      performance.now() < attempt.deadline && !['Candidate superseded','Candidate deadline exceeded','Manager disposed'].includes(reason);
    let record: SourceFailureRecord | undefined, error: Error | undefined;
    if (eligible) {
      error = new Error('Candidate failed');
      const freeze = (value:any):any => {if(value && typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}return value;};
      const facts = freeze({project_revision:attempt.revision,asset_notices:copyBounded(attempt.expectedNotices,policy.maxReplyBytes)});
      record = {facts,ready:false,valid:()=>cleanupHealth.ok && generation===attempt.generation};
      sourceFailures.set(error,record);
    }
    try {
      stop(attempt, reason, true, error);
      if (record) {
        const complete=()=>{if(cleanupHealth.ok && generation===attempt.generation && performance.now()<attempt.deadline && attempt.status==='retired')record!.ready=true;};
        if (attempt.retirement) void attempt.retirement.then(complete,()=>{}); else complete();
      }
    } catch { /* Retain ownership for disposal retry; never release source facts. */ }
    if (candidate === attempt) candidate = null;
  }
  function faultActive(attempt: Attempt, reason: string, cause?: Error) {
    if (attempt.status !== 'active') return;
    abortRun(attempt, reason, cause);
    attempt.status = 'faulted';
    if (attempt.inspect) { clearTimeout(attempt.inspect.timer); attempt.inspect.reject(new InspectionFault(reason)); attempt.inspect = null; }
    if (controlled) { try { stop(attempt, reason); } catch { /* Retain ownership for disposal retry. */ } }
  }
  function failReset(attempt: Attempt, pending: ResetPending, reason: string) {
    if (attempt.resetPending !== pending) return;
    clearTimeout(pending.timer);
    attempt.resetPending = undefined;
    pending.reject(new ResetFault(reason));
    faultActive(attempt, reason);
  }
  function stage(inputStage: {entries: readonly {path: string; data: Uint8Array}[]; profile: unknown; controllers?: unknown}): Promise<object> {
    if (disposed) return Promise.reject(new Error('Manager disposed'));
    if (controlled && active?.resetPending) return Promise.reject(new Error('Active operation in progress'));
    if (orphaned.size) return Promise.reject(new Error('Prior worker cleanup is pending'));
    let entries: Array<{path:string;data:Uint8Array}>, profile: any, controllers: any[] | undefined;
    try {
      if (!fields(inputStage, controlled ? ['entries','profile','controllers'] : ['entries','profile'])) throw new Error('Invalid stage input');
      entries = snapshotEntries(Object.getOwnPropertyDescriptor(inputStage, 'entries')!.value, policy.inventoryLimits);
      profile = copyBounded(Object.getOwnPropertyDescriptor(inputStage, 'profile')!.value, policy.maxReplyBytes);
      if (controlled) {
        controllers = copyBounded(Object.getOwnPropertyDescriptor(inputStage, 'controllers')!.value, policy.maxReplyBytes);
        if (!Array.isArray(profile?.groups) || profile.groups.length > 64 || !Array.isArray(controllers) || controllers.length !== profile.groups.length) throw new Error('Invalid controlled profile');
        const ids = new Set<string>(), owners = new Set<string>();
        for (const group of profile.groups) {
          if (!fields(group, ['group_id','control_stride','actuator_names']) || typeof group.group_id !== 'string' ||
              !group.group_id || group.group_id.length > 256 || ids.has(group.group_id)) throw new Error('Invalid controlled group');
          ids.add(group.group_id);
          const owner = crypto.randomUUID();
          if (owners.has(owner)) throw new Error('Owner identity collision');
          owners.add(owner); group.owner_id = owner;
        }
        const selected = new Set<string>();
        for (const row of controllers) {
          if (!fields(row, ['group_id','source_path','parameters','intent','grants']) || typeof row.group_id !== 'string' ||
              !ids.has(row.group_id) || selected.has(row.group_id) || !Array.isArray(row.grants)) throw new Error('Invalid controller selection');
          selected.add(row.group_id);
          for (const grant of row.grants) {
            if (!fields(grant, ['channel_id','definition_sha256']) || !controlled.approvedGrants.some(allowed =>
              allowed.group_id === row.group_id && allowed.channel_id === grant.channel_id && allowed.definition_sha256 === grant.definition_sha256)) throw new Error('Unapproved controller grant');
          }
        }
      }
    } catch (error) { return Promise.reject(error); }
    if (!Number.isSafeInteger(generation + 1)) return Promise.reject(new Error('Generation exhausted'));
    if (candidate) candidateFailure(candidate, 'Candidate superseded');
    if (controlled && orphaned.size) return Promise.reject(new Error('Prior worker cleanup is pending'));
    const requestId = crypto.randomUUID(), serial = ++generation;
    let resolve!: (value: object) => void, reject!: (reason: Error) => void;
    const promise = new Promise<object>((yes, no) => { resolve = yes; reject = no; });
    const attempt: Attempt = {generation: serial, requestId, status:'admitting', deadline:performance.now()+policy.timeoutMs,
      timer:null, worker:null, handle:Object.freeze({}), revision:'', entry:'', files:new Map(), closure:new Set(), identity:null, baseline:null, promoting:false, pendingResolve:resolve, pendingReject:reject,
      ...(controlled ? {owners:[],expectedGroups:profile.groups,expectedBlocks:profile.blocks,controllers,commandSequence:0} : {}),
      message:() => {}, error:() => {}, inspect:null};
    candidate = attempt;
    attempt.timer = setTimeout(() => candidateFailure(attempt, 'Candidate deadline exceeded'), policy.timeoutMs);
    attempt.error = () => {
      if (attempt.status === 'active') faultActive(attempt, 'Active Worker failed');
      else candidateFailure(attempt, 'Candidate Worker failed');
    };
    attempt.message = (event: MessageEvent) => {
      let msg: any;
      let poseDescriptor: PropertyDescriptor | undefined;
      try {
        // Only the bounded mesh codec may consume a binary Worker message.
        const raw = event.data;
        const kind = raw && typeof raw === 'object' ? Object.getOwnPropertyDescriptor(raw,'kind') : undefined;
        if(attempt.status==='active' && kind && Object.hasOwn(kind,'value') &&
           ['visual-result','visual-unavailable','visual-error'].includes(kind.value)) {
          const id=Object.getOwnPropertyDescriptor(raw,'request_id'),gen=Object.getOwnPropertyDescriptor(raw,'generation');
          if(id?.enumerable && gen?.enumerable && Object.hasOwn(id,'value') && Object.hasOwn(gen,'value') &&
             issuedRawVisual(attempt,id.value) && (!attempt.inspect?.raw || attempt.inspect.id!==id.value || gen.value!==attempt.generation))return;
        }
        if (attempt.status==='active' && kind && Object.hasOwn(kind,'value') &&
            ['visual-groups-result','visual-groups-unavailable','visual-groups-error'].includes(kind.value)) {
          const id=Object.getOwnPropertyDescriptor(raw,'request_id'), gen=Object.getOwnPropertyDescriptor(raw,'generation');
          if (id?.enumerable && gen?.enumerable && Object.hasOwn(id,'value') && Object.hasOwn(gen,'value') &&
              issuedGroupRequest(attempt,id.value) && (!attempt.groupPending || id.value!==attempt.groupPending.id || gen.value!==attempt.generation)) return;
        }
        if (kind && Object.hasOwn(kind,'value') && (kind.value === 'mesh-chunk' || kind.value === 'mesh-attributes-chunk')) {
          const id = Object.getOwnPropertyDescriptor(raw,'request_id'), gen = Object.getOwnPropertyDescriptor(raw,'generation');
          if (id?.enumerable && gen?.enumerable && Object.hasOwn(id,'value') && Object.hasOwn(gen,'value') && issuedMeshRequest(attempt,id.value,gen.value)) {
            if (meshJob?.attempt === attempt && id.value === meshJob.requestId) meshJob.transfer.receive(raw);
            return;
          }
        }
        if (controlled && attempt.status === 'active' && attempt.stepPending?.poseCount !== null && attempt.stepPending &&
            event.data && typeof event.data === 'object' && !Array.isArray(event.data) &&
            (Object.getPrototypeOf(event.data) === Object.prototype || Object.getPrototypeOf(event.data) === null) &&
            Object.hasOwn(event.data,'forward_pose')) {
          const outer:any = {};
          for (const key of Reflect.ownKeys(event.data)) {
            if (key === 'forward_pose') continue;
            if (typeof key !== 'string') throw Error('Invalid Worker message');
            const descriptor = Object.getOwnPropertyDescriptor(event.data,key);
            if (!descriptor || !Object.hasOwn(descriptor,'value') || !descriptor.enumerable) throw Error('Invalid Worker message');
            Object.defineProperty(outer,key,{value:descriptor.value,enumerable:true});
          }
          msg = copyBounded(outer,policy.maxReplyBytes);
          poseDescriptor = Object.getOwnPropertyDescriptor(event.data,'forward_pose');
        } else msg = copyBounded(event.data, policy.maxReplyBytes);
      }
      catch {
        const raw = event.data;
        if (meshJob?.attempt === attempt && raw && typeof raw === 'object') {
          const id = Object.getOwnPropertyDescriptor(raw,'request_id'), gen = Object.getOwnPropertyDescriptor(raw,'generation');
          if (id && gen && Object.hasOwn(id,'value') && Object.hasOwn(gen,'value') &&
              id.value === meshJob.requestId && gen.value === attempt.generation) {
            meshJob.transfer.receive(raw); return;
          }
        }
        if (controlled && attempt.status === 'active') faultActive(attempt, 'Invalid Worker message');
        else if (attempt.status === 'active' && attempt.inspect) { clearTimeout(attempt.inspect.timer); attempt.inspect.reject(new Error('Invalid inspection')); attempt.inspect=null; }
        else candidateFailure(attempt, 'Invalid Worker message');
        return;
      }
      if (typeof msg.kind === 'string' && msg.kind.startsWith('mesh-') && issuedMeshRequest(attempt,msg.request_id,msg.generation)) {
        if (meshJob?.attempt === attempt && msg.request_id === meshJob.requestId) meshJob.transfer.receive(msg);
        return;
      }
      if (attempt.status==='active' && issuedGroupRequest(attempt,msg.request_id) &&
          ['visual-groups-result','visual-groups-unavailable','visual-groups-error'].includes(msg.kind)) {
        const pending=attempt.groupPending;
        if (!pending || msg.request_id !== pending.id || msg.generation !== attempt.generation) return;
        clearTimeout(pending.timer); attempt.groupPending=undefined;
        const base=['kind','request_id','generation','identity'];
        const valid=performance.now()<pending.deadline && active===attempt && attempt.status==='active' && sameIdentity(msg.identity,attempt.identity);
        if (valid && msg.kind==='visual-groups-result' && fields(msg,[...base,'groups']) && Array.isArray(msg.groups) &&
            msg.groups.length === attempt.admittedAudit?.model_facts?.ngeom && msg.groups.length<=1024 &&
            msg.groups.every((value:any)=>Number.isInteger(value) && value>=-2147483648 && value<=2147483647)) {
          pending.resolve({identity:copyBounded(attempt.identity,budget),status:'available',groups:[...msg.groups]}); return;
        }
        if (valid && msg.kind==='visual-groups-unavailable' && fields(msg,[...base,'reason']) && msg.reason==='capacity') {
          pending.resolve({identity:copyBounded(attempt.identity,budget),status:'unavailable',reason:'capacity'}); return;
        }
        pending.reject(new InspectionFault('Visual groups unavailable')); return;
      }
      if (attempt.cleanup) {
        const pending = attempt.cleanup;
        if (pending.stage && msg.kind === 'need-runners' && msg.request_id === attempt.requestId && msg.generation === attempt.generation) return;
        const valid = performance.now() < pending.deadline && msg.request_id === pending.id && msg.generation === attempt.generation &&
          (pending.stage ? msg.kind === 'stage-disposed' && fields(msg, ['kind','request_id','generation','stage_request_id']) && msg.stage_request_id === attempt.requestId :
            msg.kind === 'disposed' && fields(msg, ['kind','request_id','generation','identity']) && sameIdentity(msg.identity, attempt.identity));
        clearTimeout(pending.timer); attempt.cleanup = undefined;
        if (valid) pending.resolve(); else pending.reject(new Error('Invalid Worker cleanup acknowledgment'));
        return;
      }
      if (controlled && attempt.status === 'active' && attempt.resetPending) {
        const pending = attempt.resetPending, groups = attempt.expectedGroups ?? [];
        if (fields(msg, ['kind','request_id','generation','error']) && msg.kind === 'reset-error' &&
            msg.request_id === pending.id && msg.generation === attempt.generation &&
            typeof msg.error === 'string' && msg.error.length <= 2000) {
          failReset(attempt, pending, 'Reset failed: ' + msg.error); return;
        }
        if (msg.kind === 'need-runners' && pending.phase === 'dispatching') {
          const priorGroups = attempt.baseline?.commands?.groups;
          if (performance.now() >= pending.deadline ||
              !fields(msg, ['kind','request_id','generation','identity','phase','audit','inspection','group_ids']) ||
              msg.request_id !== pending.id || msg.generation !== attempt.generation ||
              !fields(msg.identity, ['session_id','project_revision','run_epoch']) ||
              msg.identity.session_id !== pending.oldIdentity.session_id ||
              msg.identity.project_revision !== pending.oldIdentity.project_revision ||
              msg.identity.run_epoch !== pending.oldIdentity.run_epoch + 1 || msg.phase !== 'paused' ||
              !validAudit(msg.audit, attempt, policy) || !validInspection(msg.inspection, msg.identity) ||
              msg.inspection.plant.tick !== 0 || msg.inspection.plant.time !== 0 ||
              !Array.isArray(msg.group_ids) || !sameData(msg.group_ids, groups.map(group => group.group_id)) ||
              msg.inspection.commands.groups.length !== groups.length ||
              msg.inspection.commands.groups.some((row: any) => {
                const expected = groups.find(group => group.group_id === row.lease.group_id);
                const prior = Array.isArray(priorGroups) ? priorGroups.find((item: any) => item.lease.group_id === row.lease.group_id) : null;
                return !expected || !prior || row.lease.owner_id !== expected.owner_id ||
                  row.lease.control_stride !== expected.control_stride || row.lease.generation !== prior.lease.generation ||
                  row.accepted_sequence !== 0 || row.last_control_tick !== null || row.fresh_at_tick !== null;
              }) || !sameData(msg.inspection.due_group_ids, msg.group_ids)) {
            failReset(attempt, pending, 'Invalid reset runner request'); return;
          }
          pending.expectedIdentity = copyBounded(msg.identity, policy.maxReplyBytes);
          pending.expectedInspection = copyBounded(msg.inspection, policy.maxReplyBytes);
          pending.expectedAudit = copyBounded(msg.audit, policy.maxReplyBytes);
          pending.phase = 'opening';
          attempt.opening = (async () => {
            try {
              const oldOwners = [...(attempt.owners ?? [])];
              const closures = await Promise.allSettled(oldOwners.map(owner => closeOwner(attempt, owner)));
              if (closures.some(result => result.status === 'rejected')) throw new Error('Old frame close failed');
              if (attempt.resetPending !== pending || attempt.status !== 'active') return;
              const ports: Array<{group_id:string;dataPort:MessagePort;lifecyclePort:MessagePort}> = [];
              for (const group_id of msg.group_ids) {
                if (performance.now() >= pending.deadline) throw new Error('Reset deadline exceeded');
                const owner = await openRunnerFrame({mount:controlled.mount,runnerOrigin:controlled.runnerOrigin,
                  frameURL:controlled.frameURL,timeoutMs:controlled.frameTimeoutMs});
                attempt.owners!.push(owner);
                if (attempt.resetPending !== pending || attempt.status !== 'active') return;
                if (performance.now() >= pending.deadline) throw new Error('Reset deadline exceeded');
                ports.push({group_id,dataPort:owner.dataPort,lifecyclePort:owner.lifecyclePort});
              }
              if (attempt.resetPending !== pending || attempt.status !== 'active' || !attempt.worker) return;
              pending.phase = 'binding';
              attempt.worker.postMessage({kind:'bind-runners',request_id:pending.id,generation:attempt.generation,ports},
                ports.flatMap(row => [row.dataPort,row.lifecyclePort]));
            } catch (error) {
              if (attempt.resetPending === pending) failReset(attempt, pending,
                error instanceof Error ? error.message : 'Runner reset startup failed');
            }
          })();
          return;
        }
        if (msg.kind === 'reset-ready' && pending.phase === 'binding') {
          if (performance.now() >= pending.deadline ||
              !fields(msg, ['kind','request_id','generation','identity','phase','audit','inspection']) ||
              msg.request_id !== pending.id || msg.generation !== attempt.generation ||
              !sameIdentity(msg.identity, pending.expectedIdentity) || msg.phase !== 'paused' ||
              !validAudit(msg.audit, attempt, policy) || !validInspection(msg.inspection, msg.identity) ||
              !sameData(msg.inspection, pending.expectedInspection) || !sameData(msg.audit, pending.expectedAudit)) {
            failReset(attempt, pending, 'Invalid reset readiness'); return;
          }
          clearTimeout(pending.timer);
          attempt.resetPending = undefined;
          attempt.identity = copyBounded(msg.identity, policy.maxReplyBytes);
          attempt.baseline = copyBounded(msg.inspection, policy.maxReplyBytes);
          attempt.admittedAudit = copyBounded(msg.audit, policy.maxReplyBytes);
          attempt.commandSequence = 0; attempt.targetSequence = 0; attempt.commandEvidence = null;
          pending.resolve({identity:copyBounded(msg.identity, policy.maxReplyBytes)});
          return;
        }
        failReset(attempt, pending, 'Unexpected reset Worker message'); return;
      }
      if (controlled && attempt.status === 'active' && attempt.targetPending) {
        const p=attempt.targetPending, identity=attempt.identity;
        const base=['kind','request_id','generation','identity','status','target_sequence','group_id','field','value'];
        const group=attempt.baseline.commands.groups.find((row:any)=>row.lease.group_id===p.group_id);
        const common=msg.kind==='target-result' && msg.request_id===p.id && msg.generation===attempt.generation &&
          fields(msg.identity,['session_id','project_revision','run_epoch']) && sameIdentity(msg.identity,identity) &&
          msg.target_sequence===p.sequence && msg.group_id===p.group_id && msg.field===p.field && Object.is(msg.value,p.value) && performance.now()<p.deadline;
        const accepted=common && msg.status==='accepted' && fields(msg,[...base,'lease_generation','tick']) && group &&
          msg.lease_generation===group.lease.generation && msg.tick===attempt.baseline.plant.tick;
        const rejected=common && msg.status==='rejected' && fields(msg,[...base,'reason']) && msg.reason==='not_permitted';
        if (!accepted && !rejected) { faultActive(attempt,'Invalid target response'); return; }
        clearTimeout(p.timer);attempt.targetPending=undefined;
        p.resolve(accepted ? {status:'accepted',identity:copyBounded(identity,budget),group_id:p.group_id,field:p.field,value:p.value,lease_generation:msg.lease_generation,tick:msg.tick}
          : {status:'rejected',identity:copyBounded(identity,budget),group_id:p.group_id,field:p.field,value:p.value,reason:'not_permitted'});
        return;
      }
      if (controlled && attempt.status === 'active' && attempt.stepPending) {
        const pending = attempt.stepPending;
        const correlated = msg.request_id === pending.id && msg.generation === attempt.generation &&
          msg.command_sequence === pending.sequence && sameIdentity(msg.identity, attempt.identity) && performance.now() < pending.deadline;
        const combined=pending.recording?.grant.purpose==='channel-recording';
        if (correlated && fields(msg, ['kind','request_id','generation','identity','command_sequence','steps_completed','error'], pending.recording ? ['measurement_batch',...(combined?['command_batch']:[])] : []) &&
            msg.kind === 'step-error' && count(msg.steps_completed) && msg.steps_completed <= pending.steps &&
            typeof msg.error === 'string' && msg.error.length <= 2000) {
          clearTimeout(pending.timer); attempt.stepPending = undefined;
          const error = Object.assign(new StepFault('Controller step failed: ' + msg.error),
            {steps_completed:msg.steps_completed,outcome_unknown:true,...(pending.recording ? {measurement_incomplete:true} : {}),...(combined ? {command_incomplete:true} : {})});
          pending.reject(error); faultActive(attempt, 'Controller step failed', error); return;
        }
        if (!correlated || !fields(msg, ['kind','request_id','generation','identity','command_sequence','steps_completed','inspection',...(pending.recording ? ['measurement_batch'] : []),...(combined?['command_batch']:[])], pending.poseCount === null ? [] : ['forward_pose']) ||
            msg.kind !== 'stepped' || msg.steps_completed !== pending.steps ||
            !validInspection(msg.inspection, attempt.identity) || msg.inspection.plant.tick !== pending.startTick + pending.steps ||
            !validStepProgress(attempt.baseline, msg.inspection, pending.steps, attempt)) {
          faultActive(attempt, 'Invalid step result'); return;
        }
        let measurement: unknown, commandResult:any=null;
        if (pending.recording) {
          try {
            const expected={request_id:pending.id,generation:attempt.generation,command_sequence:pending.sequence,
              identity:attempt.identity,start_tick:pending.startTick,steps:pending.steps,attempt_token:pending.recording.attempt_token,
              authority:pending.recording.authority};
            measurement=pending.recording.grant.purpose==='channel-recording'
              ? validateChannelStepResponse(expected,pending.recording.grant,msg.measurement_batch)
              : validateMeasuredStepResponse(expected,pending.recording.grant,msg.measurement_batch);
            if(combined){
              const plan=pending.commandPlan,before=attempt.baseline.commands.groups.find((row:any)=>row.lease.group_id===plan.authority.group_id),after=msg.inspection.commands.groups.find((row:any)=>row.lease.group_id===plan.authority.group_id);
              commandResult=validateCommandBatch({authority:plan.authority,attempt_token:pending.recording.attempt_token,start_tick:pending.startTick,steps:pending.steps},plan.layout,before,attempt.baseline.commands.control,after,msg.inspection.commands.control,msg.command_batch,plan.prior);
            }
          } catch { faultActive(attempt,'Invalid measurement batch'); return; }
        }
        clearTimeout(pending.timer); attempt.stepPending = undefined;
        attempt.baseline = copyBounded(msg.inspection, policy.maxReplyBytes);
        const result:any = {identity:copyBounded(attempt.identity, policy.maxReplyBytes),steps_completed:pending.steps,
          inspection:copyBounded(msg.inspection, policy.maxReplyBytes)};
        if (pending.recording) {
          if (combined) { result.measurement = (measurement as any).log; result.measurement_channel = (measurement as any).channel; result.commands=commandResult.batch;
            attempt.commandEvidence={token:pending.recording.attempt_token,group_id:pending.commandPlan.authority.group_id,lease_generation:pending.commandPlan.authority.lease_generation,tick:pending.startTick+pending.steps-1,continuation:commandResult.continuation}; }
          else result.measurement = measurement;
        }
        if (pending.poseCount !== null) {
          let pose: unknown;
          if (poseDescriptor && Object.hasOwn(poseDescriptor,'value') && poseDescriptor.enumerable) {
            try { pose = copyBounded({...msg,forward_pose:poseDescriptor.value},budget).forward_pose; }
            catch { /* Only the requested optional presentation data is discarded. */ }
          }
          result.forward_pose = validForwardPose(pose,attempt.identity,msg.inspection,pending.poseCount)
            ? {status:'available',...copyBounded(pose,budget)}
            : {status:'unavailable',identity:copyBounded(attempt.identity,budget),reason:'invalid-or-missing'};
        }
        pending.resolve(result);
        return;
      }
      if (controlled && attempt.status === 'staging' && msg.kind === 'need-runners') {
        const groups = attempt.expectedGroups ?? [];
        if (performance.now() >= attempt.deadline ||
            !fields(msg, ['kind','request_id','generation','identity','phase','audit','inspection','group_ids']) ||
            msg.request_id !== attempt.requestId || msg.generation !== attempt.generation ||
            !fields(msg.identity, ['session_id','project_revision','run_epoch']) ||
            typeof msg.identity.session_id !== 'string' || !msg.identity.session_id ||
            (active !== null && msg.identity.session_id === active.identity.session_id) ||
            msg.identity.project_revision !== attempt.revision || msg.identity.run_epoch !== 0 || msg.phase !== 'paused' ||
            !validAudit(msg.audit, attempt, policy) || !validInspection(msg.inspection, msg.identity) || msg.inspection.plant.tick !== 0 ||
            msg.inspection.plant.time !== 0 ||
            !Array.isArray(msg.group_ids) || msg.group_ids.length !== groups.length || new Set(msg.group_ids).size !== groups.length ||
            msg.group_ids.some((id: unknown) => typeof id !== 'string' || !groups.some(group => group.group_id === id)) ||
            msg.inspection.commands.groups.length !== groups.length || msg.inspection.commands.groups.some((row: any) => {
              const expected = groups.find(group => group.group_id === row.lease.group_id);
              return !expected || row.lease.owner_id !== expected.owner_id || row.lease.control_stride !== expected.control_stride ||
                row.lease.generation !== 1 || row.accepted_sequence !== 0 || row.last_control_tick !== null || row.fresh_at_tick !== null;
            }) || !sameData(msg.inspection.due_group_ids, msg.inspection.commands.groups.map((row: any) => row.lease.group_id))) {
          candidateFailure(attempt, 'Invalid candidate runner request'); return;
        }
        attempt.identity = msg.identity; attempt.baseline = msg.inspection; attempt.admittedAudit = msg.audit; attempt.status = 'opening';
        attempt.opening = (async () => {
          try {
            const ports: Array<{group_id:string;dataPort:MessagePort;lifecyclePort:MessagePort}> = [];
            for (const group_id of msg.group_ids) {
              if (performance.now() >= attempt.deadline) { candidateFailure(attempt, 'Candidate deadline exceeded'); return; }
              const owner = await openRunnerFrame({mount:controlled.mount,runnerOrigin:controlled.runnerOrigin,
                frameURL:controlled.frameURL,timeoutMs:controlled.frameTimeoutMs});
              attempt.owners!.push(owner);
              if (attempt.status !== 'opening' || candidate !== attempt || disposed) { closeOwner(attempt, owner); return; }
              if (performance.now() >= attempt.deadline) { candidateFailure(attempt, 'Candidate deadline exceeded'); return; }
              ports.push({group_id,dataPort:owner.dataPort,lifecyclePort:owner.lifecyclePort});
            }
            if (performance.now() >= attempt.deadline) { candidateFailure(attempt, 'Candidate deadline exceeded'); return; }
            if (attempt.status !== 'opening' || candidate !== attempt || disposed || !attempt.worker) return;
            attempt.status = 'binding';
            attempt.worker.postMessage({kind:'bind-runners',request_id:attempt.requestId,generation:attempt.generation,ports},
              ports.flatMap(row => [row.dataPort,row.lifecyclePort]));
          } catch { if (candidate === attempt && attempt.status !== 'retiring' && attempt.status !== 'retired') candidateFailure(attempt, 'Runner startup failed'); }
        })();
        return;
      }
      if (controlled && attempt.status === 'opening') { candidateFailure(attempt, 'Unexpected candidate message'); return; }
      if (attempt.status === 'staging' || (controlled && attempt.status === 'binding')) {
        if (performance.now() < attempt.deadline && fields(msg, ['kind','request_id','generation','error']) &&
            msg.kind === 'error' && msg.request_id === attempt.requestId && msg.generation === attempt.generation &&
            typeof msg.error === 'string' && msg.error.length <= 2000) {
          candidateFailure(attempt, 'Candidate failed: ' + msg.error); return;
        }
        if (performance.now() >= attempt.deadline || !fields(msg, ['kind','request_id','generation'], ['identity','phase','audit','inspection','error']) ||
            msg.request_id !== attempt.requestId || msg.generation !== attempt.generation || msg.kind !== 'ready' ||
            !fields(msg, ['kind','request_id','generation','identity','phase','audit','inspection']) ||
            !fields(msg.identity, ['session_id','project_revision','run_epoch']) || typeof msg.identity.session_id !== 'string' || !msg.identity.session_id ||
            (active !== null && msg.identity.session_id === active.identity.session_id) ||
            msg.identity.project_revision !== attempt.revision || msg.identity.run_epoch !== 0 || msg.phase !== 'paused' ||
            !validAudit(msg.audit, attempt, policy) || !validInspection(msg.inspection, msg.identity) || msg.inspection.plant.tick !== 0 ||
            (controlled && (attempt.status !== 'binding' || !sameIdentity(msg.identity, attempt.identity) ||
              !sameData(msg.inspection, attempt.baseline) || !sameData(msg.audit, attempt.admittedAudit)))) {
          candidateFailure(attempt, 'Invalid candidate readiness'); return;
        }
        if (attempt.timer !== null) { clearTimeout(attempt.timer); attempt.timer = null; }
        attempt.identity = msg.identity; attempt.baseline = msg.inspection; attempt.admittedAudit = msg.audit; attempt.status = 'ready'; handles.set(attempt.handle, attempt); attempt.pendingResolve(attempt.handle);
      } else if ((attempt.status === 'ready' || attempt.status === 'active') && attempt.inspect) {
        const pending = attempt.inspect;
        const visualResult = pending.visual && msg.kind === 'visual-result' && fields(msg, ['kind','request_id','generation','identity','inspection','model','frame']);
        const visualUnavailable = pending.visual && msg.kind === 'visual-unavailable' && fields(msg, ['kind','request_id','generation','identity','inspection','reason']) && msg.reason === 'capacity';
        const ordinary = !pending.visual && msg.kind === 'inspection' && fields(msg, ['kind','request_id','generation','inspection']);
        let output:any;
        try {
          if (performance.now() >= pending.deadline || !(ordinary || visualResult || visualUnavailable) ||
              msg.request_id !== pending.id || msg.generation !== attempt.generation || !validInspection(msg.inspection, attempt.identity) ||
              (attempt.status === 'active' ? active !== attempt || (controlled && !sameData(msg.inspection, attempt.baseline)) : candidate !== attempt || msg.inspection.plant.tick !== 0 || !sameData(msg.inspection, attempt.baseline)) ||
              (pending.raw && !sameData(msg.inspection,pending.baseline))) throw Error('Invalid inspection');
          if (pending.visual) {
            if (!sameIdentity(msg.identity, attempt.identity)) throw Error('Invalid visual identity');
            if (visualUnavailable) output={identity:copyBounded(attempt.identity,budget),status:'unavailable',reason:'capacity'};
            else {
              if (!msg.frame || !Object.is(msg.frame.tick,msg.inspection.plant.tick) || !Object.is(msg.frame.time,msg.inspection.plant.time)) throw Error('Invalid visual time');
              try {
                if(pending.raw) {
                  if(!validRawVisual(msg.model,msg.frame,attempt.admittedAudit?.model_facts))throw Error('Invalid raw visual facts');
                  output=copyBounded({identity:attempt.identity,status:'partial',model:msg.model,frame:msg.frame,
                    limitations:['groups','mesh-data','sites','materials','textures','skybox','lighting','mesh-normals','uvs']},budget);
                } else output={identity:copyBounded(attempt.identity,budget),status:'available',snapshot:projectVisualSnapshot({model:msg.model,frame:msg.frame})};
              }
              catch(error) {
                if(error instanceof UnsupportedVisualError) output={identity:copyBounded(attempt.identity,budget),status:'unsupported',reason:'unsupported-content'};
                else if(error instanceof VisualCapacityError) output={identity:copyBounded(attempt.identity,budget),status:'unavailable',reason:'capacity'};
                else throw error;
              }
            }
          } else output=msg.inspection;
        } catch {
          clearTimeout(pending.timer); attempt.inspect = null; pending.reject(attempt.status === 'active' && controlled ? new InspectionFault('Invalid inspection or visual result') : new Error('Invalid inspection'));
          if (attempt.status === 'ready') candidateFailure(attempt, 'Invalid candidate challenge');
          else if (controlled && attempt.status === 'active') faultActive(attempt, 'Invalid active inspection');
          return;
        }
        if (controlled && attempt.status === 'active' && pending.visual) {
          attempt.visualBinding = (output.status === 'available' || (pending.raw && output.status === 'partial')) && msg.model.bodies.length <= 64
            ? {identity:copyBounded(attempt.identity,budget),bodyCount:msg.model.bodies.length} : undefined;
        }
        clearTimeout(pending.timer); attempt.inspect = null; pending.resolve(output);
      } else if (attempt.status === 'ready') candidateFailure(attempt, 'Duplicate candidate message');
      else if (controlled && attempt.status === 'active') faultActive(attempt, 'Unexpected active Worker message');
    };
    void (async () => {
      try {
        const admitted = await captureProjectInventory(entries, policy.inventoryLimits);
        if (attempt.status !== 'admitting' || candidate !== attempt || disposed) return;
        if (performance.now() >= attempt.deadline) return candidateFailure(attempt, 'Candidate deadline exceeded');
        attempt.revision = admitted.project_revision;
        const entry = Object.getOwnPropertyDescriptor(admitted.envelope.document.data, 'model');
        if (!entry || !Object.hasOwn(entry, 'value') || typeof entry.value !== 'string') throw new Error('Missing manifest model');
        attempt.entry = safeProjectPath(entry.value);
        if (!/\.xml$/i.test(attempt.entry) || attempt.entry.split('/').some(part => /\.(zip|mjz)$/i.test(part)) ||
            !Object.hasOwn(admitted.files, attempt.entry)) throw new Error('Invalid manifest model');
        attempt.files = new Map(Object.entries(admitted.files).filter(([path]) => path !== 'manifest.json')
          .map(([path, file]) => [path, {bytes:file.bytes,sha256:file.sha256}]));
        const expected = await collectMjcfClosure(admitted, attempt.entry, policy.compileLimits.closure);
        if (attempt.status !== 'admitting' || candidate !== attempt || disposed) return;
        if (performance.now() >= attempt.deadline) return candidateFailure(attempt, 'Candidate deadline exceeded');
        const profileFacts = await validateModelAssets(expected, policy.compileLimits.assets);
        if (attempt.status !== 'admitting' || candidate !== attempt || disposed) return;
        if (performance.now() >= attempt.deadline) return candidateFailure(attempt, 'Candidate deadline exceeded');
        const notices = profileFacts.assets.flatMap(asset => asset.kind === 'obj' && asset.ignored_materials
          ? [{path:asset.path,kind:'obj_materials_ignored',libraries:[...asset.ignored_materials.libraries],names:[...asset.ignored_materials.names]}] : []);
        const recordCap = policy.compileLimits.audit?.max_records, byteCap = policy.compileLimits.audit?.max_bytes;
        if (!Number.isSafeInteger(recordCap) || recordCap < 1 || !Number.isSafeInteger(byteCap) || byteCap < 1 ||
            notices.length > recordCap || notices.length > policy.compileLimits.closure.max_files ||
            new TextEncoder().encode(JSON.stringify(notices)).length > byteCap) throw new Error('Asset notice budget exceeded');
        attempt.expectedNotices = copyBounded(notices, policy.maxReplyBytes);
        if (controlled) {
          const channelCatalog = new Map<string,string>();
          for (const grant of controlled.approvedGrants) channelCatalog.set(grant.channel_id, grant.definition_sha256);
          await prepareProjectControllers(admitted, {required_groups:profile.groups.map((group: any) => group.group_id),
            channels:[...channelCatalog].map(([channel_id,definition_sha256]) => ({channel_id,definition_sha256})), controllers});
        }
        if (attempt.status !== 'admitting' || candidate !== attempt || disposed) return;
        if (performance.now() >= attempt.deadline) return candidateFailure(attempt, 'Candidate deadline exceeded');
        attempt.closure = new Set(Object.keys(expected.files));
        const worker = new Worker(new URL('./workers/world.mjs', import.meta.url), {type:'module'});
        attempt.worker = worker; attempt.status = 'staging';
        worker.addEventListener('message', attempt.message);
        worker.addEventListener('error', attempt.error);
        worker.addEventListener('messageerror', attempt.error);
        worker.postMessage({kind:'stage',request_id:requestId,generation:serial,entries,profile,
          inventoryLimits:policy.inventoryLimits,compileLimits:policy.compileLimits,maxReplyBytes:policy.maxReplyBytes,
          ...(controlled ? {controllers,runnerTimeoutMs:controlled.frameTimeoutMs} : {}),
          ...(policy.wasmUrl === undefined ? {} : {wasmUrl:policy.wasmUrl})});
      } catch { candidateFailure(attempt, 'Candidate admission failed'); }
    })();
    return promise;
  }
  async function promote(handle: object) {
    if (disposed || !handle || typeof handle !== 'object') throw new Error('Invalid candidate handle');
    const next = handles.get(handle);
    if (!next || next !== candidate || next.status !== 'ready' || next.promoting) throw new Error('Invalid candidate handle');
    if (controlled && active && (active.targetPending || active.resetPending || active.stepPending || active.inspect || active.groupPending || runJob || pauseBarrier || meshJob)) throw new Error('Active operation in progress');
    next.promoting = true;
    try { await inspectAttempt(next, true); }
    catch (error) { if (candidate === next) candidateFailure(next, 'Candidate challenge failed'); throw error; }
    if (disposed || candidate !== next || next.status !== 'ready') throw new Error('Candidate changed during promotion');
    const previous = active; candidate = null; active = next; next.status = 'active'; handles.delete(handle);
    if (previous) {
      try {
        stop(previous, 'World replaced');
        if (previous.retirement) await previous.retirement;
      } catch { const e = new Error('Previous worker retirement failed') as Error & {committed:boolean; identity:unknown}; e.committed=true; e.identity=copyBounded(next.identity, policy.maxReplyBytes); throw e; }
    }
    if (controlled && (disposed || active !== next || next.status !== 'active')) {
      const e = new Error('Committed candidate is no longer active') as Error & {committed:boolean; identity:unknown};
      e.committed=true; e.identity=copyBounded(next.identity, policy.maxReplyBytes); throw e;
    }
    const result: any = {identity:copyBounded(next.identity, policy.maxReplyBytes)};
    if (next.expectedNotices?.length) {
      const freeze = (value: any): any => { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; };
      result.asset_notices = freeze(copyBounded(next.expectedNotices, policy.maxReplyBytes));
    }
    return result;
  }
  function inspectAttempt(current: Attempt, challenge: boolean, visual = false, raw = false): Promise<unknown> {
    if (!current.worker || current.inspect) return Promise.reject(new Error('World inspection unavailable'));
    if(raw && (current.rawVisualSequence ?? 0)>=Number.MAX_SAFE_INTEGER)return Promise.reject(new InspectionFault('Visual request sequence exhausted'));
    if(raw)current.rawVisualPrefix ??= 'raw-visual-'+crypto.randomUUID()+'-';
    const id = raw ? current.rawVisualPrefix!+String(current.rawVisualSequence=(current.rawVisualSequence ?? 0)+1) : crypto.randomUUID(), deadline = performance.now() + policy.timeoutMs;
    let resolve!: (value:unknown)=>void, reject!: (reason:Error)=>void;
    const completion = new Promise<unknown>((yes,no) => { resolve=yes; reject=no; });
    const timer = setTimeout(() => {
      if (current.inspect?.id === id) {
        current.inspect = null; reject(!challenge && controlled ? new InspectionFault('Inspection deadline exceeded') : new Error('Inspection deadline exceeded'));
        if (challenge) candidateFailure(current, 'Candidate challenge timed out');
        else if (controlled && current.status === 'active' && !raw) faultActive(current, 'Active inspection timed out');
      }
    }, policy.timeoutMs);
    current.inspect = {id,deadline,timer,resolve,reject,completion,visual,raw,...(raw?{baseline:copyBounded(current.baseline,budget)}:{})};
    try { current.worker.postMessage(visual ? {kind:'visual-read',request_id:id,generation:current.generation,identity:copyBounded(current.identity,budget)} : {kind:'inspect',request_id:id,generation:current.generation}); }
    catch { clearTimeout(timer); current.inspect=null; reject(!challenge && controlled ? new InspectionFault('Inspection failed') : new Error('Inspection failed'));
      if (controlled && current.status === 'active' && !raw) faultActive(current, 'Active inspection failed'); }
    return completion;
  }
  function inspectActive(): Promise<unknown> {
    if (disposed) return Promise.reject(new Error('Manager disposed'));
    if (!active || active.status !== 'active') return Promise.reject(controlled ? new InspectionFault('Active world unavailable') : new Error('Active world unavailable'));
    if (controlled && (active.targetPending || active.resetPending || active.stepPending || active.groupPending || candidate?.promoting || runJob || pauseBarrier || meshJob)) return Promise.reject(new Error('Active operation in progress'));
    return inspectAttempt(active, false);
  }
  function readVisualActive(): Promise<unknown> {
    if (!controlled || disposed) return Promise.reject(new Error('Visual inspection unavailable'));
    if (!active || active.status !== 'active') return Promise.reject(new InspectionFault('Active world unavailable'));
    if (active.targetPending || active.resetPending || active.stepPending || active.groupPending || candidate?.promoting || runJob || pauseBarrier || meshJob) return Promise.reject(new Error('Active operation in progress'));
    active.visualBinding = undefined;
    return inspectAttempt(active, false, true);
  }
  function readVisualFactsActive(): Promise<unknown> {
    if(!controlled || disposed || !active || active.status!=='active')return Promise.reject(new InspectionFault('Active world unavailable'));
    if(active.targetPending || active.resetPending || active.stepPending || active.groupPending || candidate?.promoting || runJob || pauseBarrier || meshJob) return Promise.reject(new OperationBusy('Active operation in progress'));
    return inspectAttempt(active,false,true,true);
  }
  function readVisualGroupsActive(): Promise<unknown> {
    if (!controlled || disposed || !active || active.status!=='active' || !active.worker) return Promise.reject(new InspectionFault('Active world unavailable'));
    const current=active;
    if (current.groupPending || current.targetPending || current.resetPending || current.stepPending || current.inspect || candidate?.promoting || runJob || pauseBarrier || meshJob) return Promise.reject(new OperationBusy('Active operation in progress'));
    if ((current.groupSequence ?? 0)>=Number.MAX_SAFE_INTEGER) return Promise.reject(new InspectionFault('Visual group request sequence exhausted'));
    current.groupPrefix ??= 'groups-'+crypto.randomUUID()+'-';
    const id=current.groupPrefix+String(current.groupSequence=(current.groupSequence ?? 0)+1),deadline=performance.now()+policy.timeoutMs;
    let resolve!:(value:unknown)=>void,reject!:(error:Error)=>void;
    const completion=new Promise<unknown>((yes,no)=>{resolve=yes;reject=no;});
    const timer=setTimeout(()=>{if(current.groupPending?.id===id){current.groupPending=undefined;reject(new InspectionFault('Visual groups deadline exceeded'));}},policy.timeoutMs);
    current.groupPending={id,deadline,timer,resolve,reject};
    try {current.worker!.postMessage({kind:'visual-groups-read',request_id:id,generation:current.generation,identity:copyBounded(current.identity,budget)});}
    catch {clearTimeout(timer);current.groupPending=undefined;reject(new InspectionFault('Visual groups dispatch failed'));}
    return completion;
  }
  function stepCore(inputStep: unknown, internalJob?: RunJob, wantsPose = false, recordingChoice?: any): Promise<unknown> {
    if (!controlled || disposed) return Promise.reject(new Error('Active controlled world unavailable'));
    // An already retired world is terminal but this attempted step was not
    // dispatched, so do not attach an unknown physical outcome to it.
    if (!active || active.status !== 'active') return Promise.reject(new StepFault('Active controlled world unavailable'));
    const current = active;
    if (current.targetPending || current.resetPending || current.stepPending || current.inspect || current.groupPending || candidate?.promoting || pauseBarrier || meshJob || (runJob && runJob !== internalJob)) return Promise.reject(new Error('Active operation in progress'));
    if (!fields(inputStep, ['identity','steps'])) return Promise.reject(new Error('Invalid step request'));
    let value: any;
    try { value = copyBounded(inputStep, policy.maxReplyBytes); }
    catch { return Promise.reject(new Error('Invalid step request')); }
    if (!sameIdentity(value.identity, current.identity) || !Number.isSafeInteger(value.steps) || value.steps < 1 || value.steps > 64 ||
        !Number.isSafeInteger(current.baseline?.plant?.tick) || current.baseline.plant.tick > Number.MAX_SAFE_INTEGER - value.steps ||
        !Number.isSafeInteger((current.commandSequence ?? 0) + 1)) return Promise.reject(new Error('Invalid step request'));
    let recording:any = null;
    if (recordingChoice !== undefined) {
      const grant = controlled.approvedRecordingGrants.find(row => row.project_revision === current.identity.project_revision &&
        row.group_id === recordingChoice.group_id && row.channel_id === recordingChoice.channel_id && row.definition_sha256 === recordingChoice.definition_sha256);
      const group = current.baseline.commands.groups.find((row:any) => row.lease.group_id === recordingChoice.group_id);
      if (!grant || !group || value.steps > grant.max_entries || typeof recordingChoice.attempt_token !== 'string' ||
          !recordingChoice.attempt_token || recordingChoice.attempt_token.length > 256) return Promise.reject(new Error('Recording not authorized'));
      const authority = {...current.identity,group_id:group.lease.group_id,lease_generation:group.lease.generation,
        channel_id:grant.channel_id,definition_sha256:grant.definition_sha256};
      recording={authority,grant:Object.hasOwn(grant,'channel')
        ? {purpose:'channel-recording',authority,channel:grant.channel,max_entries:grant.max_entries}
        : {purpose:'measurement-recording',authority,max_entries:grant.max_entries},attempt_token:recordingChoice.attempt_token};
    }
    if (wantsPose && (!current.visualBinding || !sameIdentity(current.visualBinding.identity,current.identity))) return Promise.reject(new Error('Visual pose is not bound to this epoch'));
    const id = crypto.randomUUID(), sequence = (current.commandSequence ?? 0) + 1;
    const startTick = current.baseline.plant.tick, deadline = performance.now() + policy.timeoutMs;
    let commandPlan:any=null;
    if (recording?.grant.purpose === 'channel-recording') {
      try {
        const measurementBound=channelStepBudget({request_id:id,generation:current.generation,command_sequence:sequence,identity:current.identity,
          start_tick:startTick,steps:value.steps,attempt_token:recording.attempt_token,authority:recording.authority},recording.grant.channel);
        const authority={...current.identity,group_id:recording.authority.group_id,lease_generation:recording.authority.lease_generation};
        const layout=commandGroupLayout(current.expectedBlocks,current.expectedGroups,authority.group_id),commandBound=commandBatchBudget(authority,layout,startTick,value.steps);
        const envelope={kind:'stepped',request_id:id,generation:current.generation,identity:current.identity,command_sequence:sequence,steps_completed:value.steps,inspection:current.baseline};
        const allowance=current.baseline.commands.groups.reduce((n:number,row:any)=>n+new TextEncoder().encode(JSON.stringify(row.lease.group_id)).length+1,0);
        if(stepEnvelopeBudget(envelope)+allowance+measurementBound+commandBound+100>policy.maxReplyBytes)throw Error('Combined response exceeds budget');
        const prior=current.commandEvidence;
        commandPlan={authority,layout,prior:prior&&prior.token===recording.attempt_token&&prior.group_id===authority.group_id&&prior.lease_generation===authority.lease_generation&&prior.tick===startTick-1?prior.continuation:undefined};
      } catch (error) { return Promise.reject(error); }
    } else current.commandEvidence=null;
    current.commandSequence = sequence;
    let resolve!: (value:unknown)=>void, reject!: (reason:Error)=>void;
    const completion = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => {
      if (current.stepPending?.id === id) faultActive(current, 'Step deadline exceeded');
    }, policy.timeoutMs);
    current.stepPending = {id,sequence,steps:value.steps,startTick,deadline,timer,resolve,reject,completion,poseCount:wantsPose ? current.visualBinding!.bodyCount : null,recording,commandPlan};
    try { current.worker!.postMessage({kind:commandPlan?'step-recorded':'step',request_id:id,generation:current.generation,
      identity:copyBounded(current.identity, policy.maxReplyBytes),command_sequence:sequence,steps:value.steps,...(wantsPose ? {capture_forward_pose:true} : {}),...(recording ? {recording} : {})}); }
    catch { faultActive(current, 'Step dispatch failed'); }
    return completion;
  }
  function setTarget(input: unknown): Promise<unknown> {
    if (!controlled || disposed || !active || active.status!=='active') return Promise.reject(new Error('Active world unavailable'));
    const current=active;
    if (current.targetPending || current.resetPending || current.stepPending || current.inspect || current.groupPending || candidate?.promoting || runJob || pauseBarrier || meshJob) return Promise.reject(new OperationBusy('Active operation in progress'));
    let value:any;try { value=copyBounded(input,budget); } catch { return Promise.reject(new Error('Invalid target request')); }
    if (!fields(value,['identity','group_id','field','value']) || !fields(value.identity,['session_id','project_revision','run_epoch']) || !sameIdentity(value.identity,current.identity) ||
        typeof value.group_id!=='string' || !value.group_id || value.group_id.length>256 || typeof value.field!=='string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.field) ||
        typeof value.value!=='number' || !Number.isFinite(value.value) || !Number.isSafeInteger((current.targetSequence??0)+1)) return Promise.reject(new Error('Invalid target request'));
    const id=crypto.randomUUID(),sequence=(current.targetSequence??0)+1,deadline=performance.now()+policy.timeoutMs;
    current.targetSequence=sequence;
    let resolve!:(value:unknown)=>void,reject!:(reason:Error)=>void;
    const completion=new Promise<unknown>((yes,no)=>{resolve=yes;reject=no});
    const timer=setTimeout(()=>{if(current.targetPending?.id===id)faultActive(current,'Target deadline exceeded')},policy.timeoutMs);
    current.targetPending={id,sequence,group_id:value.group_id,field:value.field,value:value.value,deadline,timer,resolve,reject,completion};
    try {current.worker!.postMessage({kind:'set-target',request_id:id,generation:current.generation,identity:copyBounded(current.identity,budget),group_id:value.group_id,field:value.field,value:value.value,target_sequence:sequence})}
    catch {faultActive(current,'Target dispatch failed')}
    return completion;
  }
  function step(inputStep: unknown): Promise<unknown> { return stepCore(inputStep); }
  function stepMeasured(input: unknown): Promise<unknown> {
    if (!fields(input,['identity','steps','group_id','channel_id','definition_sha256','attempt_token'])) return Promise.reject(new Error('Invalid measured step request'));
    let value:any;
    try { value=copyBounded(input,budget); } catch { return Promise.reject(new Error('Invalid measured step request')); }
    return stepCore({identity:value.identity,steps:value.steps},undefined,false,{group_id:value.group_id,channel_id:value.channel_id,
      definition_sha256:value.definition_sha256,attempt_token:value.attempt_token});
  }
  function stepWithForwardPose(inputStep: unknown): Promise<unknown> { return stepCore(inputStep,undefined,true); }
  function authority(input: unknown): Attempt {
    if (!controlled || disposed || !active || active.status !== 'active') throw new Error('Active controlled world unavailable');
    if (!fields(input, ['identity'])) throw new Error('Invalid run authority');
    let value: any;
    try { value = copyBounded(input, budget); } catch { throw new Error('Invalid run authority'); }
    if (!sameIdentity(value.identity, active.identity)) throw new Error('Invalid run authority');
    return active;
  }
  function beginPresentationRead(input: unknown, attributes: boolean) {
    const current = authority(input);
    if (policy.maxReplyBytes < 131072 || !current.worker || orphaned.size || !cleanupHealth.ok || meshJob ||
        current.targetPending || current.resetPending || current.stepPending || current.inspect || current.groupPending || candidate?.promoting || runJob || pauseBarrier) throw new OperationBusy('Visual mesh read unavailable');
    const worker = current.worker;
    if ((current.meshSequence ?? 0) >= Number.MAX_SAFE_INTEGER) throw new Error('Mesh request sequence exhausted');
    current.meshPrefix ??= 'mesh-' + crypto.randomUUID() + '-';
    const requestId = current.meshPrefix + String(current.meshSequence = (current.meshSequence ?? 0) + 1);
    let queued:unknown=null, overflow=false, postFailed=false;
    let install!: (transfer:ReturnType<typeof createVisualMeshTransfer>)=>void;
    const installed=new Promise<ReturnType<typeof createVisualMeshTransfer>>(resolve=>{install=resolve;});
    const relay={receive(value:unknown){
      if(queued!==null){overflow=true;return true;}
      try {queued=copyBounded(value,Math.min(policy.maxReplyBytes,65536));} catch {overflow=true;}
      return true;
    },cancel(){return installed.then(transfer=>transfer.cancel());}} as ReturnType<typeof createVisualMeshTransfer>;
    const job = {attempt:current,requestId,transfer:relay}; meshJob = job;
    const createTransfer = attributes ? createVisualMeshAttributeTransfer : createVisualMeshTransfer;
    const transfer = createTransfer({authority:{request_id:requestId,generation:current.generation,
      identity:copyBounded(current.identity,budget)},replyLimit:policy.maxReplyBytes,timeoutMs:Math.min(policy.timeoutMs,30000),
      post:message => {try {worker.postMessage(message);} catch(error) {postFailed=true;throw error;}}});
    job.transfer=transfer;install(transfer);
    void transfer.done.then(() => {if (meshJob === job) meshJob = null;}, () => {
      if (meshJob === job) {meshJob = null; faultActive(current,'Visual mesh cleanup failed');}
    });
    if (overflow) {void transfer.cancel();faultActive(current,'Visual mesh relay overflow');}
    else if (!postFailed && queued!==null) transfer.receive(queued);
    const result = transfer.done.then(() => transfer.result);
    void result.catch(() => {});
    return Object.freeze({result,cancel:transfer.cancel});
  }
  function beginVisualMeshRead(input: unknown) {return beginPresentationRead(input,false);}
  function beginVisualMeshAttributeRead(input: unknown) {return beginPresentationRead(input,true);}
  function attachPoseSink(input:unknown,callback:(value:unknown)=>void):()=>void {
    const current=authority(input);
    if(typeof callback!=='function'||poseSink||current.resetPending||current.stepPending||current.inspect||current.groupPending||runJob||pauseBarrier||meshJob||candidate?.promoting||
       !current.visualBinding||!sameIdentity(current.visualBinding.identity,current.identity))throw Error('Pose stream unavailable');
    const owner={attempt:current,identity:copyBounded(current.identity,budget),callback,pending:null,raf:null as number|null};poseSink=owner;
    return ()=>{if(poseSink===owner)clearPoseSink();};
  }
  function schedule(job: RunJob) {
    job.timer = setTimeout(() => {
      job.timer = null;
      if (runJob !== job || job.settled) return;
      if (job.stopping) { finishRun(job); return; }
      job.inFlight = true;
      const wantsPose=!!poseSink && poseSink.attempt===job.attempt;
      void stepCore({identity:job.identity,steps:1}, job, wantsPose).then((value:any) => {
        if(wantsPose && poseSink?.attempt===job.attempt)deliverPose(job.attempt,value.forward_pose);
        job.inFlight = false;
        if (runJob !== job || job.settled) return;
        if (job.stopping) finishRun(job); else schedule(job);
      }, error => {
        if (runJob === job && !job.settled) {
          job.settled = true; runJob = null; job.reject(error instanceof Error ? error : new Error('Run failed'));
        }
      });
    }, 0);
  }
  function run(input: unknown): Promise<unknown> {
    let current: Attempt;
    try { current = authority(input); } catch (error) { return Promise.reject(error); }
    if (current.targetPending || current.resetPending || runJob || pauseBarrier || current.stepPending || current.inspect || current.groupPending || candidate?.promoting || meshJob) return Promise.reject(new OperationBusy('Active operation in progress'));
    let resolve!: (value:unknown)=>void, reject!: (reason:Error)=>void;
    const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    discardPendingPose();
    const job: RunJob = {attempt:current,identity:copyBounded(current.identity,budget),stopping:false,inFlight:false,timer:null,promise,resolve,reject,settled:false};
    runJob = job; void promise.catch(() => {}); schedule(job); return promise;
  }
  function pause(input: unknown): Promise<unknown> {
    let current: Attempt;
    try { current = authority(input); } catch (error) { return Promise.reject(error); }
    if (runJob) {
      const job = runJob; job.stopping = true;
      if (!job.inFlight) finishRun(job);
      return job.promise;
    }
    if (pauseBarrier) return pauseBarrier.promise;
    if (current.targetPending || current.resetPending || current.inspect || current.groupPending || candidate?.promoting || meshJob) return Promise.reject(new Error('Active operation in progress'));
    if (current.stepPending) {
      const pending = current.stepPending;
      let promise!: Promise<unknown>;
      promise = pending.completion.then(() => {
        if (disposed || active !== current || current.status !== 'active') throw new Error('Active world unavailable');
        return {identity:copyBounded(current.identity,budget),inspection:copyBounded(current.baseline,budget)};
      }).then(value => { if (pauseBarrier?.promise === promise) pauseBarrier = null; return value; },
        error => { if (pauseBarrier?.promise === promise) pauseBarrier = null; throw error; });
      pauseBarrier = {attempt:current,promise}; return promise;
    }
    return Promise.resolve({identity:copyBounded(current.identity,budget),inspection:copyBounded(current.baseline,budget)});
  }
  function reset(input: unknown): Promise<unknown> {
    if (!controlled || disposed || !active || active.status !== 'active') return Promise.reject(new Error('Active controlled world unavailable'));
    const current = active;
    if (current.targetPending || current.resetPending || current.stepPending || current.inspect || current.groupPending || candidate || runJob || pauseBarrier || meshJob) {
      return Promise.reject(new Error('Active operation in progress'));
    }
    let value: any;
    try {
      if (!fields(input, ['identity'])) throw new Error('Invalid reset authority');
      value = copyBounded(input, budget);
    } catch { return Promise.reject(new Error('Invalid reset authority')); }
    if (!sameIdentity(value.identity, current.identity)) return Promise.reject(new Error('Invalid reset authority'));
    if(poseSink?.attempt===current)clearPoseSink();
    current.visualBinding = undefined;
    const id = crypto.randomUUID(), deadline = performance.now() + policy.timeoutMs;
    let resolve!: (value: unknown) => void, reject!: (reason: Error) => void;
    const completion = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
    let pending!: ResetPending;
    pending = {id,phase:'dispatching',deadline,timer:setTimeout(() => {
      if (current.resetPending === pending) failReset(current, pending, 'Reset deadline exceeded');
    }, policy.timeoutMs),oldIdentity:copyBounded(current.identity,budget),expectedIdentity:null,expectedInspection:null,expectedAudit:null,
      resolve,reject,completion};
    current.resetPending = pending;
    try {
      current.worker!.postMessage({kind:'reset',request_id:id,generation:current.generation,
        identity:copyBounded(current.identity,budget)});
    } catch { failReset(current, pending, 'Reset dispatch failed'); }
    return completion;
  }
  function requestWorkerCleanup(current: Attempt, stage = false): Promise<void> {
    if (!current.worker) return Promise.reject(new Error('Worker unavailable for cleanup'));
    const id = crypto.randomUUID(), deadline = performance.now() + policy.timeoutMs;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (current.cleanup?.id === id) { current.cleanup = undefined; reject(new Error('Worker cleanup deadline exceeded')); }
      }, policy.timeoutMs);
      current.cleanup = {id,stage,deadline,timer,resolve,reject};
      try { current.worker!.postMessage(stage ? {kind:'cancel-stage',request_id:id,generation:current.generation,stage_request_id:current.requestId} : {kind:'dispose',request_id:id,generation:current.generation,identity:copyBounded(current.identity,budget)}); }
      catch { clearTimeout(timer); current.cleanup = undefined; reject(new Error('Worker cleanup dispatch failed')); }
    });
  }
  function dispose(): Promise<void> {
    if (disposal) return disposal;
    if (disposed && orphaned.size === 0) return Promise.resolve();
    const current = active;
    if (current) abortRun(current, 'Manager disposed');
    if (current?.groupPending) {clearTimeout(current.groupPending.timer);current.groupPending.reject(new InspectionFault('Manager disposed'));current.groupPending=undefined;}
    if (current?.inspect?.raw) {clearTimeout(current.inspect.timer);current.inspect.reject(new InspectionFault('Manager disposed'));current.inspect=null;}
    disposed = true;
    const pendingCandidate = candidate;
    const owned = new Set([pendingCandidate, current, ...orphaned]);
    candidate = null;
    disposal = (async () => {
      const errors: unknown[] = [];
      if (meshJob?.attempt === current) {
        try {await meshJob.transfer.cancel();} catch (error) {errors.push(error);}
      }
      if (current?.resetPending) {
        try { await current.resetPending.completion; } catch { /* Disposal preserves the reset failure. */ }
      }
      let candidateCleanup: Promise<void> | null = null;
      let candidateStopped = false;
      if (pendingCandidate && pendingCandidate !== current) {
        if (controlled && (pendingCandidate.status === 'ready' || pendingCandidate.status === 'binding' || pendingCandidate.status === 'opening' || pendingCandidate.status === 'staging') && !pendingCandidate.promoting && !pendingCandidate.inspect && pendingCandidate.worker) {
          if (pendingCandidate.status === 'binding' || pendingCandidate.status === 'opening' || pendingCandidate.status === 'staging') {
            if (pendingCandidate.timer !== null) { clearTimeout(pendingCandidate.timer); pendingCandidate.timer = null; }
            pendingCandidate.pendingReject(new Error('Manager disposed'));
          }
          candidateCleanup = requestWorkerCleanup(pendingCandidate, pendingCandidate.status === 'staging').catch(error => { errors.push(error); });
        } else {
          candidateStopped = true;
          try { stop(pendingCandidate, 'Manager disposed'); } catch (error) { errors.push(error); }
        }
      }
      if (controlled && current && current.status === 'active' && current.worker) {
        try {
          if (current.targetPending) await current.targetPending.completion;
          if (current.stepPending) await current.stepPending.completion;
          if (current.inspect) await current.inspect.completion;
          if (current.status !== 'active' || !current.worker) throw new Error('Worker unavailable for cleanup');
          await requestWorkerCleanup(current);
        } catch (error) { errors.push(error); }
      }
      if (candidateCleanup) await candidateCleanup;
      active = null;
      const pending: Promise<void>[] = [];
      for (const item of owned) if (item) {
        if (!candidateStopped || item !== pendingCandidate || item === current) {
          try { stop(item, 'Manager disposed'); } catch (error) { errors.push(error); }
        }
        if (item.retirement) pending.push(item.retirement);
      }
      const results = await Promise.allSettled(pending);
      if (results.some(result => result.status === 'rejected')) errors.push(new Error('Owner retirement failed'));
      if (errors.length) throw new Error('Worker cleanup failed: ' + errors.map(error => error instanceof Error ? error.message : String(error)).join('; '));
    })().catch(error => {cleanupHealth.ok=false;throw error;});
    const pendingDisposal = disposal;
    void pendingDisposal.catch(() => { if (disposal === pendingDisposal && orphaned.size) disposal = null; });
    return pendingDisposal;
  }
  return controlled ? {stage, promote, inspectActive, readVisualActive, readVisualFactsActive, readVisualGroupsActive, beginVisualMeshRead, beginVisualMeshAttributeRead, attachPoseSink, setTarget, step, stepMeasured, stepWithForwardPose, run, pause, reset, dispose} : {stage, promote, inspectActive, dispose};
}
