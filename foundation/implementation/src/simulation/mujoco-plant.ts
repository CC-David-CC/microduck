import loadMujoco, { type MjModel, type MjData, type MainModule } from '@mujoco/mujoco';
import type { ProjectInventory } from '../projects/project-inventory.ts';
import {isCapturedProjectInventory} from '../projects/project-inventory.ts';
import {safeProjectPath} from '../projects/project-path.ts';
import {collectMjcfClosure, type MjcfClosureLimits} from '../projects/mjcf-closure.ts';
import {validateModelAssets, type ModelAssetProfileLimits} from '../projects/model-assets-profile.ts';
import {guardProjectMutations} from './project-memfs-guard.ts';
import {readVisualModel, evaluateVisualFrame, readForwardVisualFrame, readVisualMeshCatalog, readVisualGeomGroups, readVisualMeshAttributes} from './mujoco-visual.ts';
import {readCompiledActuators} from './mujoco-actuators.ts';
import {readJointPositionFacts, type JointPositionHandle} from './mujoco-joint-position.ts';
import {readJointVelocityFacts, type JointVelocityHandle} from './mujoco-joint-velocity.ts';

/** Trusted, already validated MJCF only. This adapter is not the import boundary.
 * Each session calls the factory once inside its own authoritative browser worker. */
export async function createMujocoPlant(xml: string, options: {wasmUrl?: string} = {}) {
  try {
    const mj = await loadMujoco(options.wasmUrl ? {locateFile: () => options.wasmUrl} : undefined);
    if (mj.mj_versionString() !== '3.17.0') throw new Error('Unqualified MuJoCo version');
    return constructPlant(mj, mj.MjModel.from_xml_string(xml), () => {});
  } catch (error) { throw new Error(('MuJoCo compilation failed: ' + String(error)).slice(0, 2000)); }
}

export async function createMujocoPlantFromProject(inventory: Readonly<ProjectInventory>, limits: ProjectCompileLimits,
  options: {wasmUrl?: string} = {}) {
  if (!isCapturedProjectInventory(inventory)) throw new Error('Project inventory is not captured');
  const document=inventory.envelope.document.data;let initialKeyframe:string|undefined;
  if(Object.hasOwn(document,'initial_keyframe')) {
    const value=document.initial_keyframe;
    if(typeof value!=='string'||value.length<1||value.length>256||value.includes('\0'))throw new Error('Invalid initial keyframe');
    for(const c of value){const point=c.codePointAt(0)!;if(point>=0xd800&&point<=0xdfff)throw new Error('Invalid initial keyframe');}
    initialKeyframe=value;
  }
  const field = Object.getOwnPropertyDescriptor(options, 'wasmUrl');
  if (field && (!Object.hasOwn(field, 'value') || typeof field.value !== 'string')) throw new Error('Invalid WASM URL');
  const wasmUrl: string | undefined = field?.value;
  const prepared = await prepareProjectCompilation(inventory, limits, wasmUrl);
  try {
    const plant = constructPlant(prepared.mj, prepared.model, prepared.cleanup, initialKeyframe);
    return {plant, audit: prepared.audit};
  } catch (error) {
    let cleanupError: unknown;
    try { prepared.cleanup(); } catch (failed) { cleanupError = failed; }
    throw failure('native_compile_failed', 'native-compile', error, prepared.audit,
      [...cleanupFrom(error), ...(cleanupError ? [cleanupError] : [])]);
  }
}

function constructPlant(mj: MainModule, initialModel: MjModel, cleanup: () => void, initialKeyframe?:string) {
  let model: MjModel | undefined = initialModel;
  let data: MjData | undefined;
  let visualData: MjData | undefined;
  try {
    data = new mj.MjData(model);
    visualData = new mj.MjData(model);
    const compiled = model, physical = data, visual = visualData;
    // These properties are reference-bound C++ members, not owned allocations.
    // Their enclosing model/data owns destruction; never call delete() on them.
    const opt = compiled.opt;
    const warnings = physical.warning;
    const metadata = {version: mj.mj_versionString(), nq: compiled.nq, nv: compiled.nv,
      actuator_count: compiled.nactuator, engine_control_size: compiled.nu, activation_size: compiled.na,
      timestep: opt.timestep, integrator: opt.integrator};
    let state: 'ready' | 'faulted' | 'disposed' = 'ready';
    let tick = 0;
    type CapturedPreForward={tick:number;time:number;stage:'initial-forward'|'post-step-pre-forward';gyro:number[];quaternion:number[]};
    type PreForwardBinding={sensorAddress:number;bodyId:number;sample:CapturedPreForward};
    const preForwardBindings=new Set<PreForwardBinding>();
    function preForwardSample(sensorAddress:number,bodyId:number,sampleTick:number,stage:CapturedPreForward['stage']):CapturedPreForward {
      const gyro=Array.from((physical.sensordata as Float64Array).slice(sensorAddress,sensorAddress+3));
      const quaternion=Array.from((physical.xquat as Float64Array).slice(bodyId*4,bodyId*4+4));
      const time=physical.time;if(gyro.length!==3||quaternion.length!==4||!Number.isFinite(time)||!gyro.every(Number.isFinite)||!quaternion.every(Number.isFinite))throw new Error('Invalid pre-forward sample');
      return {tick:sampleTick,time,stage,gyro,quaternion};
    }
    function capturePreForward(sampleTick:number,stage:CapturedPreForward['stage']) {
      return [...preForwardBindings].map(binding=>({binding,sample:preForwardSample(binding.sensorAddress,binding.bodyId,sampleTick,stage)}));
    }
    function publishPreForward(samples:ReturnType<typeof capturePreForward>) {for(const row of samples)if(preForwardBindings.has(row.binding))row.binding.sample=row.sample;}
    function live() { if (state === 'disposed') throw new Error('Plant is disposed'); }
    function healthy() {
      for (let index = 0; index < warnings.size(); index++) {
        const warning = warnings.get(index);
        if (!warning) throw new Error('Missing engine warning record');
        try {
          if (warning.number > 0) throw new Error(`Engine warning ${index}: count ${warning.number}, detail ${warning.lastinfo}`);
        } finally { warning.delete(); } // vector.get returns an owned value copy.
      }
      for (const values of [physical.qpos, physical.qvel, physical.act, physical.ctrl,
        physical.actuator_force, physical.sensordata] as Float64Array[]) {
        for (const value of values) if (!Number.isFinite(value)) throw new Error('Nonfinite physical state');
      }
      if (!Number.isFinite(physical.time)) throw new Error('Nonfinite engine time');
    }
    if (!Number.isFinite(metadata.timestep) || metadata.timestep <= 0) throw new Error('Invalid engine timestep');
    let initialKeyId:number|null=null;
    if(initialKeyframe!==undefined){initialKeyId=mj.mj_name2id(compiled,mj.mjtObj.mjOBJ_KEY.value,initialKeyframe);if(!Number.isSafeInteger(initialKeyId)||initialKeyId<0||initialKeyId>=compiled.nkey)throw new Error('Initial keyframe not found');mj.mj_resetDataKeyframe(compiled,physical,initialKeyId);}
    mj.mj_forward(compiled, physical);
    healthy();
    const actuatorFacts = readCompiledActuators(mj, compiled, physical);
    const visualFacts = readVisualModel(mj, compiled);
    function visualFrameAt(qpos: readonly number[] | Float64Array) {
      live(); if (state !== 'ready') throw new Error('Visual frame requires a ready plant');
      if (!Array.isArray(qpos) && !(qpos instanceof Float64Array)) throw new Error('Invalid visual coordinates');
      return evaluateVisualFrame(mj, compiled, visual, qpos, physical);
    }
    return {
      get state() { return state; },
      descriptor() { live(); return {...metadata,...(initialKeyframe===undefined?{}:{initial_keyframe:initialKeyframe})}; },
      compiledActuators() { live(); return structuredClone(actuatorFacts); },
      visualModel() { live(); return structuredClone(visualFacts); },
      visualGeomGroups() {
        live(); if (state !== 'ready') throw new Error('Geometry groups require a ready plant');
        return readVisualGeomGroups(mj, compiled);
      },
      visualMeshCatalog(limits: Parameters<typeof readVisualMeshCatalog>[2]) {
        live(); if (state !== 'ready') throw new Error('Mesh catalog requires a ready plant');
        return readVisualMeshCatalog(mj, compiled, limits);
      },
      visualMeshAttributes(limits: Parameters<typeof readVisualMeshAttributes>[2]) {
        live(); if (state !== 'ready') throw new Error('Mesh attributes require a ready plant');
        return readVisualMeshAttributes(mj, compiled, limits);
      },
      visualFrameAt,
      visualFrame() { const frame = visualFrameAt(physical.qpos as Float64Array); return {...frame, tick, time: physical.time}; },
      forwardVisualFrame(maxBodies: number) {
        live(); if (state !== 'ready') throw new Error('Visual frame requires a ready plant');
        return {...readForwardVisualFrame(compiled, physical, maxBodies), tick, time:physical.time};
      },
      bindPreForwardGyroAndOrientation(input:unknown) {
        live();if(state!=='ready'||tick!==0||preForwardBindings.size>=8||!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))throw new Error('Cannot bind pre-forward source');
        const keys=Reflect.ownKeys(input);if(keys.length!==2||!keys.includes('sensor_name')||!keys.includes('body_name'))throw new Error('Invalid pre-forward source');
        const name=(key:string)=>{const d=Object.getOwnPropertyDescriptor(input,key);if(!d||!Object.hasOwn(d,'value')||typeof d.value!=='string'||d.value.length<1||d.value.length>256||d.value.includes('\0'))throw new Error('Invalid pre-forward source');for(const c of d.value){const n=c.codePointAt(0)!;if(n>=0xd800&&n<=0xdfff)throw new Error('Invalid pre-forward source')}return d.value as string;};
        const sensorName=name('sensor_name'),bodyName=name('body_name');
        const sensorId=mj.mj_name2id(compiled,mj.mjtObj.mjOBJ_SENSOR.value,sensorName),bodyId=mj.mj_name2id(compiled,mj.mjtObj.mjOBJ_BODY.value,bodyName);
        if(!Number.isSafeInteger(sensorId)||sensorId<0||sensorId>=compiled.nsensor||!Number.isSafeInteger(bodyId)||bodyId<0||bodyId>=compiled.nbody||compiled.sensor_type[sensorId]!==mj.mjtSensor.mjSENS_GYRO.value||compiled.sensor_dim[sensorId]!==3)throw new Error('Invalid pre-forward source');
        const sensorAddress=compiled.sensor_adr[sensorId];if(!Number.isSafeInteger(sensorAddress)||sensorAddress<0||sensorAddress+3>physical.sensordata.length||bodyId*4+4>physical.xquat.length)throw new Error('Invalid pre-forward source');
        const binding:PreForwardBinding={sensorAddress,bodyId,sample:preForwardSample(sensorAddress,bodyId,0,'initial-forward')};preForwardBindings.add(binding);let closed=false;
        return Object.freeze({read(){live();if(closed||state!=='ready')throw new Error('Pre-forward source unavailable');const s=binding.sample;return {tick:s.tick,time:s.time,stage:s.stage,gyro:[...s.gyro],quaternion:[...s.quaternion]};},close(){if(!closed){closed=true;preForwardBindings.delete(binding);}}});
      },
      bindJointVelocity(jointName: string): JointVelocityHandle {
        live();
        if (state !== 'ready') throw new Error('Joint binding requires a ready plant');
        const facts = readJointVelocityFacts(mj, compiled, jointName);
        return {
          describe() { live(); return {...facts, axis: [...facts.axis]}; },
          read() {
            live();
            if (state !== 'ready') throw new Error('Joint reading requires a ready plant');
            const time = physical.time, value = physical.qvel[facts.qvel_address];
            if (!Number.isFinite(time) || !Number.isFinite(value)) throw new Error('Nonfinite joint velocity reading');
            // Copy only: no forward, integration, sensor history or random draw.
            return {tick, time, value};
          },
        };
      },
      bindJointPosition(jointName: string): JointPositionHandle {
        live();
        if (state !== 'ready') throw new Error('Joint binding requires a ready plant');
        const facts = readJointPositionFacts(mj, compiled, jointName);
        return {
          describe() { live(); return {...facts, axis: [...facts.axis]}; },
          read() {
            live();
            if (state !== 'ready') throw new Error('Joint reading requires a ready plant');
            const time = physical.time, value = physical.qpos[facts.qpos_address];
            if (!Number.isFinite(time) || !Number.isFinite(value)) throw new Error('Nonfinite joint reading');
            // Copy only: no forward, integration, sensor history or random draw.
            return {tick, time, value};
          },
        };
      },
      snapshot() {
        live();
        return {tick, time: physical.time,
          qpos: Array.from(physical.qpos as Float64Array), qvel: Array.from(physical.qvel as Float64Array),
          activation: Array.from(physical.act as Float64Array), control: Array.from(physical.ctrl as Float64Array),
          actuator_force: Array.from(physical.actuator_force as Float64Array),
          sensors: Array.from(physical.sensordata as Float64Array)};
      },
      step(control: readonly number[]) {
        live();
        if (state === 'faulted') throw new Error('Plant is faulted; explicit reset required');
        if (!Array.isArray(control) || control.length !== metadata.engine_control_size) throw new Error('Invalid full control shape');
        for (const value of control) if (!Number.isFinite(value)) throw new Error('Nonfinite control');
        if (!Number.isSafeInteger(tick + 1)) throw new Error('Physical tick limit reached');
        const previousTime = physical.time;
        try {
          // All inputs are validated before the first write. Full stepping keeps
          // the compiled integrator and one frozen command through its substages.
          (physical.ctrl as Float64Array).set(control);
          mj.mj_step(compiled, physical);
          const preForward=capturePreForward(tick+1,'post-step-pre-forward');
          // Bring sensors/forces to S_(k+1), without a new controller evaluation.
          mj.mj_forward(compiled, physical);
          healthy();
          const expectedTime = previousTime + metadata.timestep;
          if (Math.abs(physical.time - expectedTime) > 16 * Number.EPSILON * Math.max(1, Math.abs(expectedTime))) {
            throw new Error('Engine time discontinuity or automatic reset');
          }
          tick++;publishPreForward(preForward);
        } catch (error) {
          state = 'faulted';
          throw new Error(('MuJoCo integration fault: ' + String(error)).slice(0, 2000));
        }
      },
      reset() {
        live();
        try {
          if(initialKeyId===null)mj.mj_resetData(compiled, physical);else mj.mj_resetDataKeyframe(compiled,physical,initialKeyId);
          mj.mj_forward(compiled, physical);
          healthy();
          tick = 0;
          publishPreForward(capturePreForward(0,'initial-forward'));
          state = 'ready';
        } catch (error) {
          state = 'faulted';
          throw new Error(('MuJoCo reset fault: ' + String(error)).slice(0, 2000));
        }
      },
      dispose() {
        state = 'disposed';preForwardBindings.clear();
        const cleanupErrors: unknown[] = [];
        try { if (!visual.isDeleted()) visual.delete(); } catch (failed) { cleanupErrors.push(failed); }
        try { if (!physical.isDeleted()) physical.delete(); } catch (failed) { cleanupErrors.push(failed); }
        try { if (!compiled.isDeleted()) compiled.delete(); } catch (failed) { cleanupErrors.push(failed); }
        try { cleanup(); } catch (failed) { cleanupErrors.push(failed); }
        if (cleanupErrors.length) throw failure('dispose_failed', 'dispose', 'MuJoCo disposal failed', undefined, cleanupErrors);
        return {data_deleted: physical.isDeleted(), model_deleted: compiled.isDeleted()};
      },
    };
  } catch (error) {
    const cleanupErrors: string[] = [];
    try { if (visualData && !visualData.isDeleted()) visualData.delete(); } catch (failed) { cleanupErrors.push(String(failed)); }
    try { if (data && !data.isDeleted()) data.delete(); } catch (failed) { cleanupErrors.push(String(failed)); }
    try { if (model && !model.isDeleted()) model.delete(); } catch (failed) { cleanupErrors.push(String(failed)); }
    try { cleanup(); } catch (failed) { cleanupErrors.push(String(failed)); }
    const result = new Error(('MuJoCo compilation failed: ' + formatPrimaryCleanup(error, cleanupErrors)).slice(0, 2000)) as Error & {cleanup_failures?: readonly string[]};
    if (cleanupErrors.length) result.cleanup_failures = boundedCleanup(cleanupErrors);
    throw result;
  }
}

function boundedCleanup(cleanup: readonly unknown[]): readonly string[] {
  return Object.freeze(cleanup.slice(0, 8).map(item => String(item).slice(0, 100)));
}
function cleanupFrom(error: unknown): readonly string[] {
  if (!error || typeof error !== 'object') return [];
  const field = Object.getOwnPropertyDescriptor(error, 'cleanup_failures');
  return field && Object.hasOwn(field, 'value') && Array.isArray(field.value) &&
    field.value.every((item: unknown) => typeof item === 'string') ? boundedCleanup(field.value) : [];
}
function formatPrimaryCleanup(primary: unknown, cleanup: readonly unknown[]): string {
  const detail = String(primary).slice(0, 1000);
  return cleanup.length ? detail + '; cleanup failed: ' + boundedCleanup(cleanup).join('; ').slice(0, 800) : detail;
}

type Caps = Record<string, number>;
type ProjectCompileLimits = {closure: MjcfClosureLimits; assets: Caps; audit: Caps};
const closureKeys = ['max_files','max_total_bytes','max_references','max_include_depth'];
const scanKeys = ['max_xml_bytes','max_depth','max_elements','max_attributes_per_element','max_attribute_utf16','max_references'];
const assetKeys = ['max_obj_bytes','max_obj_line_bytes','max_obj_vertices','max_obj_faces','max_obj_triangles',
  'max_obj_abs_coordinate','max_png_bytes','max_png_width','max_png_height','max_png_pixels',
  'max_png_decoded_bytes','max_png_chunks'];
const auditKeys = ['max_records','max_bytes'];
function failure(code: string, phase: string, reason: unknown, audit?: unknown, cleanup: readonly unknown[] = []) {
  const e = new Error(formatPrimaryCleanup(reason, cleanup)) as Error & {code: string; phase: string; audit?: unknown; cleanup_failures?: readonly string[]};
  e.code = code; e.phase = phase; if (audit !== undefined) e.audit = audit;
  if (cleanup.length) e.cleanup_failures = boundedCleanup(cleanup);
  return e;
}
function record(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('resource_limit', 'limits', 'Invalid host limits');
  const field = Object.getOwnPropertyDescriptor(value, key);
  if (!field || !Object.hasOwn(field, 'value')) throw failure('resource_limit', 'limits', `Missing own limit ${key}`);
  return field.value;
}
function capture(value: unknown, keys: string[]): Caps {
  const out: Caps = Object.create(null);
  for (const key of keys) {
    const n = record(value, key);
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0 ||
        (key !== 'max_obj_abs_coordinate' && !Number.isSafeInteger(n))) throw failure('resource_limit', 'limits', `Invalid ${key}`);
    out[key] = n;
  }
  return out;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Host-only staging; never returns the module or its filesystem. */
async function prepareProjectCompilation(inventory: Readonly<ProjectInventory>, input: ProjectCompileLimits, wasmUrl?: string) {
  // Capture host policy before the first await, including nested accessors.
  const closureInput = record(input, 'closure');
  const closureCaps = {...capture(closureInput, closureKeys), scan: capture(record(closureInput, 'scan'), scanKeys)} as unknown as MjcfClosureLimits;
  const assetCaps = capture(record(input, 'assets'), assetKeys);
  const auditCaps = capture(record(input, 'audit'), auditKeys);
  if (!isCapturedProjectInventory(inventory)) throw failure('invalid_manifest_model', 'manifest', 'Inventory must be captured in this realm');
  const modelField = Object.getOwnPropertyDescriptor(inventory.envelope.document.data, 'model');
  let entry: string;
  try {
    if (!modelField || !Object.hasOwn(modelField, 'value') || typeof modelField.value !== 'string') throw new Error('Missing manifest model');
    entry = safeProjectPath(modelField.value);
    if (!/\.xml$/i.test(entry) || entry.split('/').some(part => /\.(zip|mjz)$/i.test(part)) || !Object.hasOwn(inventory.files, entry)) throw new Error('Model must name selected XML');
  } catch (error) { throw failure('invalid_manifest_model', 'manifest', error); }
  let closure;
  try { closure = await collectMjcfClosure(inventory, entry, closureCaps); }
  catch (error) {
    const message = String(error);
    const code = /limit|budget|depth/i.test(message) ? 'resource_limit' :
      /missing|absent/i.test(message) ? 'missing_dependency' : 'resource_path_denied';
    throw failure(code, 'closure', error);
  }
  const assetProfile = await validateModelAssets(closure, assetCaps as unknown as ModelAssetProfileLimits);
  const assetNotices = assetProfile.assets.flatMap(asset => asset.kind === 'obj' && asset.ignored_materials
    ? [{path: asset.path, kind: 'obj_materials_ignored', libraries: [...asset.ignored_materials.libraries], names: [...asset.ignored_materials.names]}] : []);
  // Capture the exact Blob contents before native staging; verify byte count and digest again.
  const staged = await Promise.all(Object.values(closure.files).map(async file => {
    const bytes = new Uint8Array(await file.content.arrayBuffer());
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    if (bytes.length !== file.bytes || digest !== file.sha256) throw failure('missing_dependency', 'closure', 'Captured closure content changed');
    return {project_path: file.path, bytes: file.bytes, sha256: file.sha256, content: bytes};
  }));
  const mj = await loadMujoco(wasmUrl ? {locateFile: () => wasmUrl} : undefined);
  if (mj.mj_versionString() !== '3.17.0') throw failure('native_compile_failed', 'native-compile', 'Unqualified MuJoCo version');
  const fs = mj.FS as any;
  const prefix = '/brf-project';
  const allowed = new Map(staged.map(file => [prefix + '/' + file.project_path, file]));
  const candidates = new Set<string>([prefix + '/' + entry]);
  for (const edge of closure.dependencies) for (const path of edge.candidates) candidates.add(prefix + '/' + path);
  const createdFiles: string[] = [], directories = new Set<string>();
  const completedFiles: typeof staged = [];
  const stagingAttempts: Array<{project_path: string; outcome: 'present' | 'write-error'}> = [];
  let model: any;
  const raw: Record<string, any> = Object.create(null);
  const lookups: any[] = [];
  let auditBytes = 0, violation: string | null = null, overflow = false, compileFinished = false;
  const event = (operation: string, path: string, outcome: string) => {
    const file = allowed.get(path);
    const row = {sequence: lookups.length + 1, operation, engine_path: path,
      project_path: file?.project_path ?? null, sha256: file?.sha256 ?? null, outcome};
    const count = new TextEncoder().encode(JSON.stringify(row)).length;
    if (lookups.length + assetNotices.length >= auditCaps.max_records || count > auditCaps.max_bytes - auditBytes) {
      overflow = true; throw new Error('Audit limit exceeded');
    }
    auditBytes += count; lookups.push(row);
  };
  const snapshotAudit = (facts: unknown = null) => {
    if (lookups.length + assetNotices.length > auditCaps.max_records) {
      overflow = true; throw new Error('Audit record limit exceeded');
    }
    const audit = {project_revision: closure.project_revision, entry_path: entry, closure_paths: Object.keys(closure.files),
      staged_files: completedFiles.map(file => ({project_path: file.project_path, engine_path: prefix + '/' + file.project_path,
        bytes: file.bytes, sha256: file.sha256})), staging_attempts: structuredClone(stagingAttempts),
      lookups: structuredClone(lookups), model_facts: facts,
      ...(assetNotices.length ? {asset_notices: structuredClone(assetNotices)} : {})};
    if (new TextEncoder().encode(JSON.stringify(audit)).length > auditCaps.max_bytes) {
      overflow = true; throw new Error('Audit byte limit exceeded');
    }
    return deepFreeze(audit);
  };
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    const failures: unknown[] = [];
    for (const path of [...createdFiles].reverse()) {
      try { (raw.unlink || fs.unlink).call(fs, path); } catch (error) { if ((error as any)?.errno !== 44) failures.push(error); }
    }
    for (const dir of [...directories].sort((a,b) => b.length - a.length)) {
      try { (raw.rmdir || fs.rmdir).call(fs, dir); } catch (error) { if ((error as any)?.errno !== 44) failures.push(error); }
    }
    if (failures.length) throw new Error('Staged filesystem cleanup failed');
    cleaned = true;
  };
  try {
    for (const file of staged) {
      const path = prefix + '/' + file.project_path;
      const components = path.split('/').slice(1, -1); let dir = '';
      for (const part of components) { dir += '/' + part; if (!directories.has(dir)) { directories.add(dir); fs.mkdir(dir); } }
      createdFiles.push(path);
      try {
        fs.writeFile(path, file.content, {canOwn: false});
        completedFiles.push(file); stagingAttempts.push({project_path: file.project_path, outcome: 'present'});
      } catch (error) {
        stagingAttempts.push({project_path: file.project_path, outcome: 'write-error'});
        throw error;
      }
    }
    for (const method of ['stat','lstat','open','read']) raw[method] = fs[method];
    for (const method of ['stat','lstat','open','read']) {
      fs[method] = function(...args: any[]) {
        const path = typeof args[0] === 'string' ? args[0] : args[0]?.path;
        if (compileFinished || typeof path !== 'string' || (!allowed.has(path) && !candidates.has(path)) ||
            (method === 'open' && args[1] !== 0 && args[1] !== 32768)) {
          violation = 'Disallowed native filesystem operation'; event(method, String(path), 'denied'); throw new fs.ErrnoError(44);
        }
        if (!allowed.has(path)) { event(method, path, 'missing-candidate'); throw new fs.ErrnoError(44); }
        try { const result = raw[method].apply(this, args); event(method, path, 'present'); return result; }
        catch (error) { if (!overflow) event(method, path, 'read-error'); throw error; }
      };
    }
    Object.assign(raw, guardProjectMutations(fs, () => { violation = 'Disallowed native filesystem mutation'; }));
    model = mj.MjModel.from_xml_path(prefix + '/' + entry);
    if (overflow) throw failure('audit_overflow', 'native-compile', 'Audit limit exceeded', snapshotAudit());
    if (violation) throw failure('native_compile_failed', 'native-compile', violation, snapshotAudit());
    const facts = {version: mj.mj_versionString(), ngeom: model.ngeom, nmesh: model.nmesh, nmat: model.nmat,
      ntex: model.ntex, texture_width: Array.from(model.tex_width), texture_height: Array.from(model.tex_height)};
    const audit = snapshotAudit(facts);
    compileFinished = true; // No post-compile native filesystem reads are authorized.
    return {mj, model, audit, cleanup};
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    try { if (model && !model.isDeleted()) model.delete(); } catch (failed) { cleanupErrors.push(failed); }
    let audit: unknown;
    try { audit = snapshotAudit(); } catch { overflow = true; }
    try { cleanup(); } catch (failed) { cleanupErrors.push(failed); }
    throw failure(overflow ? 'audit_overflow' : 'native_compile_failed', 'native-compile', error, audit, cleanupErrors);
  }
}
