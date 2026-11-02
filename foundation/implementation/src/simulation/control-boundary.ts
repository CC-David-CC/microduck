import type { ActionEnvelope, ControlBlock, ControllerLease, GroupBinding, RunIdentity } from '../../../contracts/runtime.ts';
import { partitionControlInputs } from './control-layout.ts';

export interface GroupAuthority {
  lease: ControllerLease;
  accepted_sequence: number;
  last_control_tick: number | null;
  fresh_at_tick: number | null;
}

function counter(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error('invalid ' + label);
}

/** Phase zero is unchanged by a fresh action requested at a paused takeover. */
export function dueGroupIds(tick: number, groups: readonly GroupAuthority[]): string[] {
  counter(tick, 'tick');
  const ids = new Set<string>();
  const due: string[] = [];
  for (const group of groups) {
    const lease = group.lease;
    if (typeof lease.group_id !== 'string' || !lease.group_id || ids.has(lease.group_id) ||
        typeof lease.owner_id !== 'string' || !lease.owner_id) throw new Error('invalid or duplicate authority');
    ids.add(lease.group_id);
    counter(lease.generation, 'lease generation');
    counter(lease.control_stride, 'control stride', 1);
    counter(group.accepted_sequence, 'accepted sequence');
    if (group.last_control_tick !== null) counter(group.last_control_tick, 'last control tick');
    if (group.fresh_at_tick !== null) counter(group.fresh_at_tick, 'fresh tick');
    if (tick % lease.control_stride === 0 || group.fresh_at_tick === tick) {
      if (group.last_control_tick !== null && group.last_control_tick >= tick) {
        throw new Error('control boundary already committed');
      }
      due.push(lease.group_id);
    }
  }
  return due;
}

function sameBlock(compiled: ControlBlock, bound: ControlBlock): boolean {
  return compiled.validation_rule_id === bound.validation_rule_id &&
    Array.isArray(bound.engine_indices) && bound.engine_indices.length === compiled.engine_indices.length &&
    compiled.engine_indices.every((index, i) => index === bound.engine_indices[i]) &&
    Array.isArray(bound.inputs) && bound.inputs.length === compiled.inputs.length &&
    compiled.inputs.every((input, i) => {
      const other = bound.inputs[i];
      return other && input.actuator_name === other.actuator_name && input.component === other.component &&
        input.unit === other.unit && input.semantic === other.semantic &&
        (input.input_range === null ? other.input_range === null :
          Array.isArray(other.input_range) && other.input_range.length === 2 &&
          input.input_range[0] === other.input_range[0] && input.input_range[1] === other.input_range[1]);
    });
}

/** Validate the declared metadata of whole input blocks before they are exposed. */
export function validateControlBlockMetadata(blocks: readonly ControlBlock[]): void {
  for (const block of blocks) {
    if (block.validation_rule_id !== 'independent-scalar-ranges') throw new Error('unsupported block rule');
    for (let component = 0; component < block.inputs.length; component++) {
      const input = block.inputs[component];
      counter(input.component, 'input component');
      if (input.component !== component || input.actuator_name !== block.actuator_name ||
          typeof input.unit !== 'string' || typeof input.semantic !== 'string') {
        throw new Error('invalid compiled input metadata');
      }
      const range = input.input_range;
      if (range !== null && (!Array.isArray(range) || range.length !== 2 ||
          !Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[0] > range[1])) {
        throw new Error('invalid input range');
      }
    }
  }
}

/** Pure staging only: the host commits these results and candidate memories together
 * before its one engine step. On failure the host discards all candidates. */
export function stageControlBoundary(identity: RunIdentity, tick: number,
  blocks: readonly ControlBlock[], bindings: readonly GroupBinding[],
  groups: readonly GroupAuthority[], previousControl: readonly number[], actions: readonly ActionEnvelope[]): {
    control: number[];
    updates: Array<{ group_id: string; sequence: number; last_control_tick: number; fresh_at_tick: null }>;
    applied: Array<{ group_id: string; requested: number[]; applied: number[]; clipped: boolean[] }>;
  } {
  counter(identity.run_epoch, 'run epoch');
  if (typeof identity.session_id !== 'string' || !identity.session_id ||
      typeof identity.project_revision !== 'string' || !/^[a-f0-9]{64}$/.test(identity.project_revision)) {
    throw new Error('invalid run identity');
  }
  const due = new Set(dueGroupIds(tick, groups));
  if (!Array.isArray(previousControl)) throw new Error('invalid previous control');
  for (const value of previousControl) {
    if (!Number.isFinite(value)) throw new Error('nonfinite previous control');
  }
  const layouts = partitionControlInputs(previousControl.length, blocks, bindings.map(binding => ({
    group_id: binding.group_id, actuator_names: binding.blocks.map(block => block.actuator_name),
  })));
  const compiled = new Map(blocks.map(block => [block.actuator_name, block]));
  validateControlBlockMetadata(blocks);
  const layoutById = new Map(layouts.map(layout => [layout.group_id, layout]));
  const bindingById = new Map(bindings.map(binding => [binding.group_id, binding]));
  for (const binding of bindings) {
    for (const block of binding.blocks) {
      if (!sameBlock(compiled.get(block.actuator_name)!, block)) throw new Error('binding differs from compiled block');
    }
  }
  if (groups.length !== layouts.length || groups.some(group => !layoutById.has(group.lease.group_id))) {
    throw new Error('missing or extra group authority');
  }
  const authorityById = new Map(groups.map(group => [group.lease.group_id, group]));
  const byGroup = new Map<string, ActionEnvelope>();
  if (!Array.isArray(actions) || actions.length !== due.size) throw new Error('incomplete or duplicate action barrier');
  // Validate the entire barrier before even assembling a private candidate buffer.
  for (const action of actions) {
    if (!due.has(action.group_id) || byGroup.has(action.group_id)) throw new Error('unexpected or duplicate action');
    const group = authorityById.get(action.group_id)!;
    if (action.session_id !== identity.session_id || action.project_revision !== identity.project_revision ||
        action.run_epoch !== identity.run_epoch || action.owner_id !== group.lease.owner_id ||
        action.lease_generation !== group.lease.generation || action.observed_tick !== tick || action.apply_tick !== tick) {
      throw new Error('action authority or boundary mismatch');
    }
    counter(action.sequence, 'action sequence', 1);
    if (action.sequence !== group.accepted_sequence + 1) throw new Error('action sequence is not strictly next');
    if (!Array.isArray(action.control) || action.control.length !== layoutById.get(action.group_id)!.engine_indices.length) {
      throw new Error('invalid group control shape');
    }
    for (const value of action.control) {
      if (!Number.isFinite(value)) throw new Error('nonfinite requested control');
    }
    byGroup.set(action.group_id, action);
  }
  const control = [...previousControl];
  const updates: Array<{ group_id: string; sequence: number; last_control_tick: number; fresh_at_tick: null }> = [];
  const applied: Array<{ group_id: string; requested: number[]; applied: number[]; clipped: boolean[] }> = [];
  // Authority order, not reply arrival order, determines the returned records.
  for (const groupId of due) {
    const action = byGroup.get(groupId)!;
    const inputs = bindingById.get(groupId)!.blocks.flatMap(block => compiled.get(block.actuator_name)!.inputs);
    const requested = [...action.control];
    const values = requested.map((value, i) => {
      const range = inputs[i].input_range;
      return range === null ? value : value < range[0] ? range[0] : value > range[1] ? range[1] : value;
    });
    const indices = layoutById.get(groupId)!.engine_indices;
    values.forEach((value, i) => { control[indices[i]] = value; });
    updates.push({ group_id: groupId, sequence: action.sequence, last_control_tick: tick, fresh_at_tick: null });
    applied.push({ group_id: groupId, requested, applied: values, clipped: values.map((value, i) => value !== requested[i]) });
  }
  return { control, updates, applied };
}
