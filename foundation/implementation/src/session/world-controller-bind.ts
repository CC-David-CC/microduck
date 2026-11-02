import {captureProjectTargets} from '../projects/project-target-admission.ts';
import {prepareProjectControllers} from '../projects/project-controller-admission.ts';
import {connectRunner} from '../isolation/runner-client.ts';
import {createMeasuredControllerSupervisor} from '../simulation/mujoco-controller-boundary.ts';
import {copyBounded, sameBoundedData} from './project-world-wire.ts';
import {isCapturedProjectInventory, type ProjectInventory} from '../projects/project-inventory.ts';

// This module is for trusted simulation Worker code. Handles and ports must never
// be exposed to package code or transferred to the view. The Window owns frames.
const handles = new WeakMap<object, {world: any; baseline: ReturnType<typeof snapshotWorld>; admitted: any; groups: any[]; targets: readonly any[]}>();
const consumedPorts = new WeakSet<object>();
// Failed native close leaves ownership in this Worker until the host retires it.
const unresolvedPorts = new Set<MessagePort>();
let poisoned = false;
const portGetter = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage')?.get;
const closePort = MessagePort.prototype.close;

function snapshotWorld(world: any) {
  const view = copyBounded(world.inspect(), 1048576);
  const channel = copyBounded(world.describeMeasurementChannel(), 1048576);
  if (view.phase !== 'paused' || view.plant?.tick !== 0 || !view.identity ||
      !Number.isSafeInteger(view.identity.run_epoch) || view.identity.run_epoch < 0 ||
      !Array.isArray(view.commands?.groups) || view.commands.groups.length > 64 ||
      view.commands.groups.some((group: any) => group.accepted_sequence !== 0) ||
      !channel || (channel.kind !== 'measurement' && channel.kind !== 'truth') || typeof channel.id !== 'string' ||
      typeof channel.definition_sha256 !== 'string') throw new Error('World is not ready for controller binding');
  const groups = view.commands.groups.map((group: any) => ({lease:group.lease,
    description:copyBounded(world.describeControlGroup(group.lease.group_id), 1048576)}));
  if (new Set(groups.map((group: any) => group.lease.group_id)).size !== groups.length) throw new Error('Invalid world groups');
  const measurement = copyBounded(world.readMeasurement(), 1048576);
  const boundary = copyBounded(world.lastBoundary(), 1048576);
  const observationFailure = copyBounded(world.lastObservationFailure(), 1048576);
  return {view,channel,groups,measurement,boundary,observationFailure};
}
function current(world: any, baseline: ReturnType<typeof snapshotWorld>): void {
  if (!sameBoundedData(snapshotWorld(world), baseline)) throw new Error('World changed during controller binding');
}
function fields(value: unknown, keys: readonly string[]): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Invalid port mapping');
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || own.some(key => typeof key !== 'string' || !keys.includes(key))) throw new Error('Invalid port mapping');
  const out: Record<string, any> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw new Error('Invalid port mapping');
    out[key] = descriptor.value;
  }
  return out;
}
function nativePort(value: unknown): value is MessagePort {
  if (!value || typeof value !== 'object' || typeof portGetter !== 'function') return false;
  try { Reflect.apply(portGetter, value, []); return true; } catch { return false; }
}
function closeOwned(ports: MessagePort[]): boolean {
  let failed = false;
  for (const port of ports) {
    try { Reflect.apply(closePort, port, []); }
    catch { unresolvedPorts.add(port); failed = true; }
  }
  return failed;
}

/** Controllers and their grants must be explicitly approved by the trusted host.
 * Actual world descriptors only constrain that policy; they do not grant access. */
export async function prepareWorldControllerBindings(inventory: Readonly<ProjectInventory>, world: any, controllers: unknown) {
  if (poisoned) throw new Error('Controller binding cleanup failed; retire Worker');
  if (!isCapturedProjectInventory(inventory)) throw new Error('Project inventory is not captured');
  const initial = snapshotWorld(world);
  if (initial.view.identity.project_revision !== inventory.project_revision) throw new Error('Project revision mismatch');
  const baseline = initial;
  const admission = prepareProjectControllers(inventory, {required_groups:initial.groups.map((x: any) => x.lease.group_id),
    channels:[{channel_id:initial.channel.id,definition_sha256:initial.channel.definition_sha256}], controllers});
  let admitted: Awaited<ReturnType<typeof prepareProjectControllers>>;
  try { admitted = await admission; }
  catch (error) {
    if (poisoned) throw new Error('Controller binding cleanup failed; retire Worker');
    throw error;
  }
  if (poisoned) throw new Error('Controller binding cleanup failed; retire Worker');
  current(world, baseline);
  if (admitted.project_revision !== initial.view.identity.project_revision) throw new Error('Project revision mismatch');
  const policy = await captureProjectTargets(inventory, admitted.controllers.map((c: any) => ({group_id:c.group_id,intent:c.intent})));
  current(world, baseline);
  const handle = Object.freeze({});
  handles.set(handle, {world, baseline, admitted, groups:initial.groups, targets:policy.targets});
  return Object.freeze({handle,targets:policy.targets,group_ids:Object.freeze(initial.groups.map((x: any) => x.lease.group_id))});
}

/** Consumes a worker-private handle and transferred ports once. The caller owns
 * Window frame teardown and must cancel late publication when its deadline expires. */
export async function bindWorldControllers(handle: object, ports: unknown, timeoutMs: number) {
  const context = handle && typeof handle === 'object' ? handles.get(handle) : undefined;
  if (context) handles.delete(handle);
  const acquired: MessagePort[] = [], clients: Awaited<ReturnType<typeof connectRunner>>[] = [];
  try {
    // Discover every visible, newly transferred native port before validating
    // the handle or mapping. Never close a port consumed by an earlier bind.
    if (Array.isArray(ports)) {
      for (let index=0; index<Math.min(ports.length, 64); index++) {
        const slot = Object.getOwnPropertyDescriptor(ports, String(index));
        const row = slot && Object.hasOwn(slot, 'value') ? slot.value : null;
        if (!row || typeof row !== 'object') continue;
        for (const key of ['dataPort','lifecyclePort']) {
          const field = Object.getOwnPropertyDescriptor(row, key);
          const port = field && Object.hasOwn(field, 'value') ? field.value : undefined;
          if (nativePort(port) && !consumedPorts.has(port) && !acquired.includes(port)) acquired.push(port);
        }
      }
    }
    for (const port of acquired) consumedPorts.add(port);
    if (poisoned) throw new Error('Controller binding cleanup failed; retire Worker');
    if (!context) throw new Error('Invalid controller binding handle');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) throw new Error('Invalid runner timeout');
    if (!Array.isArray(ports) || Object.getPrototypeOf(ports) !== Array.prototype ||
        ports.length !== context.groups.length || Reflect.ownKeys(ports).length !== ports.length + 1) throw new Error('Invalid port mappings');
    const mapping = new Map<string, {dataPort:MessagePort;lifecyclePort:MessagePort}>();
    const used = new Set<MessagePort>();
    for (let index=0; index<ports.length; index++) {
      const slot = Object.getOwnPropertyDescriptor(ports, String(index));
      if (!slot || !Object.hasOwn(slot, 'value') || !slot.enumerable) throw new Error('Invalid port mappings');
      const row = fields(slot.value, ['group_id','dataPort','lifecyclePort']);
      for (const port of [row.dataPort, row.lifecyclePort]) {
        if (!nativePort(port) || !acquired.includes(port) || used.has(port)) throw new Error('Invalid or reused runner port');
        used.add(port);
      }
      if (typeof row.group_id !== 'string' || mapping.has(row.group_id) ||
          !context.groups.some(group => group.lease.group_id === row.group_id)) throw new Error('Invalid runner group');
      mapping.set(row.group_id, {dataPort:row.dataPort, lifecyclePort:row.lifecyclePort});
    }
    if (mapping.size !== context.groups.length) throw new Error('Missing runner group');
    current(context.world, context.baseline);
    const identity = context.world.inspect().identity;
    const registrations = [];
    for (const group of context.groups) {
      const selected = context.admitted.controllers.find((row: any) => row.group_id === group.lease.group_id);
      const pair = mapping.get(group.lease.group_id)!;
      const client = await connectRunner({dataPort:pair.dataPort,lifecyclePort:pair.lifecyclePort,
        source:selected.source,sourceId:selected.source_path,identity,groupId:group.lease.group_id,
        ownerId:group.lease.owner_id,leaseGeneration:group.lease.generation,timeoutMs});
      clients.push(client);
      if (poisoned) throw new Error('Controller binding cleanup failed; retire Worker');
      registrations.push({group_id:group.lease.group_id,runner:client,grants:selected.grants,
        parameters:selected.parameters,intent:selected.intent});
    }
    current(context.world, context.baseline);
    // The factory reserves the world synchronously before its first await.
    const supervisor = await createMeasuredControllerSupervisor(context.world, registrations, context.targets);
    if (poisoned) {
      await supervisor.dispose();
      throw new Error('Controller binding cleanup failed; retire Worker');
    }
    return supervisor;
  } catch (error) {
    const outcomes = await Promise.allSettled(clients.map(client => client.close()));
    const portFailure = closeOwned(acquired);
    if (portFailure || outcomes.some(result => result.status === 'rejected')) {
      poisoned = true;
      throw new Error('Controller binding cleanup failed; retire Worker');
    }
    if (poisoned) throw new Error('Controller binding cleanup failed; retire Worker');
    throw error;
  }
}
