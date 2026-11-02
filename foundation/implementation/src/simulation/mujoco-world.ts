import {createWorldMicroduckTruth} from '../observations/microduck-truth-world.ts';
import type {ActionEnvelope, ControlBlock, RunIdentity} from '../../../contracts/runtime.ts';
import {createMujocoPlant, createMujocoPlantFromProject} from './mujoco-plant.ts';
import {isCapturedProjectInventory, type ProjectInventory} from '../projects/project-inventory.ts';
import {createHingeMeasurement, type HingeMeasurementRequest} from '../observations/hinge-measurement.ts';
import {partitionControlInputs} from './control-layout.ts';
import {dueGroupIds, stageControlBoundary, validateControlBlockMetadata, type GroupAuthority} from './control-boundary.ts';
import {assertWorldNotInitializing, assertWorldOperationIdle, createWorldOperationFence, registerWorldOperationFence} from './world-operation-fence.ts';

type PlantSnapshot = ReturnType<Awaited<ReturnType<typeof createMujocoPlant>>['snapshot']>;
type WorldConfig = {project_revision: string; wasmUrl?: string; blocks: readonly ControlBlock[];
  groups: readonly {group_id: string; owner_id: string; control_stride: number;
    actuator_names: readonly string[]}[];
  hinge_measurement?: {joint_name: string; request: HingeMeasurementRequest};
  microduck_truth?: {sensor_name:string;body_name:string;joint_names:string[];channel_id:string};
};
type BoundaryReceipt = {
  identity: RunIdentity; boundary_tick: number;
  status: 'committed' | 'integrated' | 'engine-fault' | 'aborted';
  committed_control: number[];
  commits: Array<{group_id: string; owner_id: string; lease_generation: number; sequence: number;
    requested: number[]; committed: number[]; clipped: boolean[]}>;
  held_group_ids: string[]; plant_before: PlantSnapshot; plant_after: PlantSnapshot | null; error: string | null;
};
type Fault = {kind: 'engine-step' | 'commit-abort' | 'reset' | 'observation' | 'measurement-reset'; message: string};
type ObservationFailure = {identity: RunIdentity; boundary_tick: number;
  stage: 'advance' | 'snapshot' | 'publication';
  preceding_integration: {identity: RunIdentity; boundary_tick: number} | null; message: string};

/** Trusted host seam over one actual plant. Inputs have prequalified semantics.
 * Only the host may complete a boundary, after real runner memory acknowledgments. */
export async function createMujocoWorld(xml: string, config: WorldConfig) {
  const owned = structuredClone(config); // Capture caller data before the first await.
  if (typeof owned.project_revision !== 'string' || !/^[a-f0-9]{64}$/.test(owned.project_revision)) throw new Error('Invalid project revision');
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('Secure randomUUID is required');
  const plant = await createMujocoPlant(xml, {wasmUrl: owned.wasmUrl});
  return constructWorld(plant, owned);
}

type ProjectWorldProfile = Omit<WorldConfig, 'project_revision' | 'wasmUrl'>;
/** Capture ordinary host-owned data without executing profile getters. */
function captureHostData(value: unknown, ancestors = new Set<object>()): any {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object') throw new Error('Invalid host profile data');
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('Invalid host profile record');
  const keys = Reflect.ownKeys(value);
  if (array) {
    const length = Object.getOwnPropertyDescriptor(value, 'length')?.value;
    if (!Number.isSafeInteger(length) || keys.length !== length + 1 || !keys.includes('length') ||
        keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) {
      throw new Error('Host profile arrays must be dense and contain only indexed elements');
    }
  }
  if (ancestors.has(value)) throw new Error('Cyclic host profile');
  ancestors.add(value);
  try {
    const output: any = array ? [] : Object.create(null);
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('Invalid host profile key');
      if (array && key === 'length') continue;
      const field = Object.getOwnPropertyDescriptor(value, key);
      if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) throw new Error('Host profile accessors are unsupported');
      Object.defineProperty(output, key, {value: captureHostData(field.value, ancestors), enumerable: true, writable: true, configurable: true});
    }
    return output;
  } finally { ancestors.delete(value); }
}

/** Construct a world only from this realm's admitted project and explicit host profile. */
export async function createMujocoWorldFromProject(inventory: Readonly<ProjectInventory>, profile: ProjectWorldProfile,
  limits: Parameters<typeof createMujocoPlantFromProject>[1], options: {wasmUrl?: string} = {}) {
  if (!isCapturedProjectInventory(inventory)) throw new Error('Inventory must be captured in this realm');
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new Error('Invalid host profile');
  const keys = Reflect.ownKeys(profile);
  if (keys.some(key => typeof key !== 'string' || !['blocks', 'groups', 'hinge_measurement', 'microduck_truth'].includes(key)) ||
      !Object.hasOwn(profile, 'blocks') || !Object.hasOwn(profile, 'groups')) throw new Error('Invalid host profile fields');
  const owned = captureHostData(profile) as ProjectWorldProfile;
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      Reflect.ownKeys(options).some(key => key !== 'wasmUrl')) throw new Error('Invalid host options');
  const option = Object.getOwnPropertyDescriptor(options, 'wasmUrl');
  if (option && (!Object.hasOwn(option, 'value') || typeof option.value !== 'string')) throw new Error('Invalid WASM URL');
  const wasmUrl: string | undefined = option?.value;
  const revision = inventory.project_revision;
  // The compiler synchronously captures its own host limits before its first await.
  const prepared = await createMujocoPlantFromProject(inventory, limits, wasmUrl === undefined ? {} : {wasmUrl});
  if (prepared.audit.project_revision !== revision) {
    throwWorldSetupFailure(prepared.plant, new Error('Compiled project revision mismatch'));
  }
  const world = await constructWorld(prepared.plant, {...owned, project_revision: revision});
  return {world, audit: prepared.audit};
}

async function constructWorld(plant: Awaited<ReturnType<typeof createMujocoPlant>>, owned: WorldConfig) {
  try {
    const operationFence = createWorldOperationFence();
    if (typeof globalThis.crypto?.randomUUID !== 'function') throw new Error('Secure randomUUID is required');
    let identity: RunIdentity = {session_id: globalThis.crypto.randomUUID(),
      project_revision: owned.project_revision, run_epoch: 0};
    const facts = plant.compiledActuators();
    if (owned.blocks.length !== facts.actuator_count) throw new Error('Compiled actuator set mismatch');
    for (const actuator of facts.actuators) {
      const block = owned.blocks.find(item => item.actuator_name === actuator.name);
      if (!block || block.engine_indices.length !== actuator.control.size ||
          block.engine_indices.some((index, i) => index !== actuator.control.address + i)) {
        throw new Error('Compiled actuator name or whole input span mismatch');
      }
    }
    partitionControlInputs(facts.control_size, owned.blocks, owned.groups);
    validateControlBlockMetadata(owned.blocks);
    const owners = new Set(owned.groups.map(group => group.owner_id));
    if (owners.size !== owned.groups.length) throw new Error('Groups require distinct owner instances');
    const initialGroups: GroupAuthority[] = owned.groups.map(group => ({
      lease: {group_id: group.group_id, owner_id: group.owner_id, generation: 1,
        control_stride: group.control_stride},
      accepted_sequence: 0, last_control_tick: null, fresh_at_tick: null,
    }));
    dueGroupIds(0, initialGroups); // Validate owners and cadence even before the first commit.
    const byName = new Map(owned.blocks.map(block => [block.actuator_name, block]));
    const bindings = owned.groups.map(group => ({group_id: group.group_id,
      blocks: group.actuator_names.map(name => byName.get(name)!)}));
    if (owned.hinge_measurement !== undefined && owned.microduck_truth !== undefined) throw new Error('Choose one observation source');
    const measurement = owned.microduck_truth !== undefined ? await createWorldMicroduckTruth(identity,plant,owned.microduck_truth) :
      owned.hinge_measurement === undefined ? null :
      await createHingeMeasurement(identity, plant.bindJointPosition(owned.hinge_measurement.joint_name),
        owned.hinge_measurement.request);
    let commands = {identity, control: plant.snapshot().control, groups: initialGroups};
    let phase: 'paused' | 'committed' | 'faulted' | 'disposed' = 'paused';
    let token: object | null = null;
    let last: BoundaryReceipt | null = null;
    let fault: Fault | null = null;
    let prepared: ReturnType<NonNullable<typeof measurement>['read']> | null = null;
    type IntegratedMeasurement = {identity: RunIdentity; boundary_tick: number;
      measurement: ReturnType<NonNullable<typeof measurement>['read']>};
    let pendingMeasurement: IntegratedMeasurement | null = null;
    let integratedMeasurement: IntegratedMeasurement | null = null;
    let observationFailure: ObservationFailure | null = null;
    const bounded = (error: unknown, prefix = '') => {
      let detail = 'operation failed';
      try { if (error instanceof Error && typeof error.message === 'string') detail = error.message; } catch {}
      return new Error((prefix + detail).slice(0, 2000) || 'operation failed');
    }
    const copy = <T>(value: T): T => structuredClone(value);
    const identityCopy = (value: RunIdentity): RunIdentity => ({session_id: value.session_id,
      project_revision: value.project_revision, run_epoch: value.run_epoch});
    const current = (view = prepared, snapshot = plant.snapshot()) => Boolean(view &&
      view.observed_tick === snapshot.tick && view.identity.session_id === identity.session_id &&
      view.identity.project_revision === identity.project_revision && view.identity.run_epoch === identity.run_epoch);
    const observationCopy = <T>(value: T): T => {
      try { return copy(value); }
      catch (error) { throw bounded(error, 'Measurement output: '); }
    };
    function preceding(tick: number) {
      return last?.status === 'integrated' && last.identity.session_id === identity.session_id &&
        last.identity.project_revision === identity.project_revision && last.identity.run_epoch === identity.run_epoch &&
        last.boundary_tick + 1 === tick ? {identity: identityCopy(identity), boundary_tick: last.boundary_tick} : null;
    }
    function live() { if (phase === 'disposed') throw new Error('World is disposed'); }
    function pending(candidate: unknown): BoundaryReceipt {
      live();
      if (phase !== 'committed' || token === null || candidate !== token || last === null) {
        throw new Error('No matching pending boundary');
      }
      return last;
    }
    function inspect() {
      live();
      const snapshot = plant.snapshot();
      return structuredClone({identity, phase, plant: snapshot, commands,
        due_group_ids: phase === 'paused' ? dueGroupIds(snapshot.tick, commands.groups) : null, fault});
    }
    const world = {
      prepareBoundary() {
        assertWorldNotInitializing(operationFence);
        live();
        if (!measurement) throw new Error('World has no hinge measurement');
        if (phase !== 'paused') throw new Error('World must be paused to prepare a measurement');
        let before: PlantSnapshot;
        try { before = plant.snapshot(); }
        catch (error) { throw bounded(error, 'Measurement boundary: '); }
        if (fault) throw new Error('World is faulted');
        if (current(prepared, before)) return observationCopy(prepared);
        let stage: ObservationFailure['stage'] = 'advance';
        try {
          measurement.advanceBoundary(identity);
          stage = 'snapshot';
          const snapshot = measurement.read();
          stage = 'publication';
          const returned = copy(snapshot);
          const retained = copy(snapshot);
          prepared = retained;
          return returned;
        } catch (error) {
          const failure = bounded(error, 'Observation: ');
          prepared = null;
          fault = {kind: 'observation', message: failure.message};
          phase = 'faulted';
          observationFailure = {identity: identityCopy(identity), boundary_tick: before.tick, stage,
            preceding_integration: preceding(before.tick), message: failure.message};
          throw failure;
        }
      },
      readMeasurement() {
        live();
        if (!measurement || phase !== 'paused') return null;
        try { return current() ? observationCopy(prepared) : null; }
        catch (error) { throw bounded(error, 'Measurement output: '); }
      },
      lastObservationFailure() { live(); return observationFailure ? observationCopy(observationFailure) : null; },
      // Historical measurement for the last successful physical boundary; this
      // does not sample, imply controller consumption, or represent current truth.
      lastIntegratedMeasurement() { live(); return integratedMeasurement ? observationCopy(integratedMeasurement) : null; },
      inspect,
      forwardVisualFrame(maxBodies: number) {
        assertWorldOperationIdle(operationFence);
        live();
        if (phase !== 'paused' || fault) throw new Error('World must be paused for visual snapshot');
        return {identity:identityCopy(identity), frame:plant.forwardVisualFrame(maxBodies)};
      },
      visualSnapshot() {
        assertWorldOperationIdle(operationFence);
        live();
        if (phase !== 'paused' || fault) throw new Error('World must be paused for visual snapshot');
        const model = plant.visualModel(), frame = plant.visualFrame();
        return {identity: identityCopy(identity), model, frame};
      },
      visualMeshCatalog(limits: Parameters<typeof plant.visualMeshCatalog>[0]) {
        assertWorldOperationIdle(operationFence);
        live();
        if (phase !== 'paused' || fault) throw new Error('World must be paused for mesh catalog');
        return {identity: identityCopy(identity), catalog: plant.visualMeshCatalog(limits)};
      },
      visualMeshAttributes(limits: Parameters<typeof plant.visualMeshAttributes>[0]) {
        assertWorldOperationIdle(operationFence);
        live();
        if (phase !== 'paused' || fault) throw new Error('World must be paused for mesh attributes');
        return {identity: identityCopy(identity), attributes: plant.visualMeshAttributes(limits)};
      },
      visualGeomGroups() {
        assertWorldOperationIdle(operationFence);
        live();
        if (phase !== 'paused' || fault) throw new Error('World must be paused for geometry groups');
        return {identity: identityCopy(identity), groups: plant.visualGeomGroups()};
      },
      fixedTimestep() { live(); return plant.descriptor().timestep; },
      describeControlGroup(groupId: string) {
        live();
        if (typeof groupId !== 'string') throw new Error('Invalid control group');
        const group = commands.groups.find(item => item.lease.group_id === groupId);
        const binding = bindings.find(item => item.group_id === groupId);
        if (!group || !binding) throw new Error('Unknown control group');
        return copy({group_id: groupId, control_stride: group.lease.control_stride,
          control_size: binding.blocks.reduce((size, block) => size + block.inputs.length, 0),
          blocks: binding.blocks});
      },
      describeMeasurementChannel() { live(); return measurement ? copy(measurement.describe().channel) : null; },
      describeMeasurementDefinition() { live(); return measurement && 'describeDefinition' in measurement ? copy(measurement.describeDefinition()) : null; },
      lastBoundary() { live(); return structuredClone(last); },
      commitBoundary(actions: readonly ActionEnvelope[]) {
        assertWorldNotInitializing(operationFence);
        live();
        if (phase !== 'paused') throw new Error('World must be paused with no pending boundary');
        const before = plant.snapshot();
        if (measurement && !current(prepared, before)) throw new Error('Measurement boundary must be prepared before commit');
        const staged = stageControlBoundary(identity, before.tick, owned.blocks, bindings,
          commands.groups, commands.control, actions);
        const updates = new Map(staged.updates.map(update => [update.group_id, update]));
        const groups = commands.groups.map(group => {
          const update = updates.get(group.lease.group_id);
          return update ? {...group, accepted_sequence: update.sequence,
            last_control_tick: update.last_control_tick, fresh_at_tick: update.fresh_at_tick} : group;
        });
        const authorities = new Map(groups.map(group => [group.lease.group_id, group]));
        const receipt: BoundaryReceipt = {identity, boundary_tick: before.tick, status: 'committed',
          committed_control: staged.control, commits: staged.applied.map(row => {
            const group = authorities.get(row.group_id)!;
            return {group_id: row.group_id, owner_id: group.lease.owner_id,
              lease_generation: group.lease.generation, sequence: group.accepted_sequence,
              requested: row.requested, committed: row.applied, clipped: row.clipped};
          }), held_group_ids: groups.filter(group => !updates.has(group.lease.group_id))
            .map(group => group.lease.group_id), plant_before: before, plant_after: null, error: null};
        const nextToken = Object.freeze({});
        const result = {token: nextToken, receipt: structuredClone(receipt)};
        // `prepared` is the private detached copy retained at preparation. Keep
        // it with this commit until the plant actually completes the boundary.
        const nextMeasurement: IntegratedMeasurement | null = prepared ?
          {identity: identityCopy(identity), boundary_tick: before.tick, measurement: prepared} : null;
        // Publish together only after validation and construction of the complete result.
        commands = {identity, control: staged.control, groups};
        pendingMeasurement = nextMeasurement;
        prepared = null;
        last = receipt;
        token = nextToken;
        phase = 'committed';
        return result;
      },
      integrateCommitted(candidate: unknown) {
        assertWorldNotInitializing(operationFence);
        const receipt = pending(candidate);
        token = null;
        try {
          plant.step(commands.control);
          last = {...receipt, status: 'integrated', plant_after: plant.snapshot()};
          integratedMeasurement = pendingMeasurement;
          pendingMeasurement = null;
          phase = 'paused';
        } catch (error) {
          pendingMeasurement = null;
          fault = {kind: 'engine-step', message: String(error).slice(0, 2000)};
          phase = 'faulted';
          last = {...receipt, status: 'engine-fault', plant_after: plant.snapshot(), error: fault.message};
          throw new Error(fault.message);
        }
        return structuredClone(last);
      },
      abortCommitted(candidate: unknown, reason: string) {
        assertWorldNotInitializing(operationFence);
        const receipt = pending(candidate);
        if (typeof reason !== 'string' || !reason.length) throw new Error('Abort reason is required');
        const message = reason.slice(0, 2000);
        token = null;
        pendingMeasurement = null;
        fault = {kind: 'commit-abort', message};
        phase = 'faulted';
        last = {...receipt, status: 'aborted', error: message};
        return structuredClone(last);
      },
      reset() {
        assertWorldOperationIdle(operationFence);
        live();
        if (fault?.kind === 'measurement-reset') throw new Error('Measurement reset is terminal; dispose this world');
        const epoch = identity.run_epoch + 1;
        if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error('Run epoch limit reached');
        // Fence old replies before physical reset, even when physical reset fails.
        if (token !== null && last !== null) last = {...last, status: 'aborted', error: 'Explicit reset'};
        token = null;
        prepared = null;
        pendingMeasurement = null;
        integratedMeasurement = null;
        identity = {...identity, run_epoch: epoch};
        phase = 'faulted';
        try {
          try {
            measurement?.reset(identity);
          } catch (error) {
            fault = {kind: 'measurement-reset', message: bounded(error, 'Measurement reset: ').message};
            throw new Error(fault.message);
          }
          plant.reset();
          commands = {identity, control: plant.snapshot().control,
            groups: commands.groups.map(group => ({lease: group.lease, accepted_sequence: 0,
              last_control_tick: null, fresh_at_tick: null}))};
          fault = null;
          phase = 'paused';
        } catch (error) {
          if (fault?.kind !== 'measurement-reset') fault = {kind: 'reset', message: String(error).slice(0, 2000)};
          throw new Error(fault.message);
        }
        return inspect();
      },
      dispose() {
        assertWorldOperationIdle(operationFence);
        token = null;
        prepared = null;
        pendingMeasurement = null;
        integratedMeasurement = null;
        phase = 'disposed';
        try { if (measurement && 'close' in measurement) measurement.close(); }
        finally { plant.dispose(); }
      },
    };
    registerWorldOperationFence(world, operationFence);
    return world;
  } catch (error) {
    throwWorldSetupFailure(plant, error);
  }
}

function throwWorldSetupFailure(plant: Awaited<ReturnType<typeof createMujocoPlant>>, error: unknown): never {
  try { plant.dispose(); }
  catch (cleanup) {
    const field = cleanup && typeof cleanup === 'object' ? Object.getOwnPropertyDescriptor(cleanup, 'cleanup_failures') : undefined;
    const prior = field && Object.hasOwn(field, 'value') && Array.isArray(field.value) &&
      field.value.every((item: unknown) => typeof item === 'string') ? field.value : [String(cleanup)];
    const failures = Object.freeze(prior.slice(0, 8).map((item: string) => item.slice(0, 100)));
    const message = String(error).slice(0, 1000) + '; cleanup failed: ' + failures.join('; ').slice(0, 800);
    const result = new Error(message) as Error & {cleanup_failures: readonly string[]};
    result.cleanup_failures = failures;
    throw result;
  }
  throw error;
}
