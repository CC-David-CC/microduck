import type { ControlBlock } from '../../../contracts/runtime.ts';

export interface GroupSelection { readonly group_id: string; readonly actuator_names: readonly string[]; }
export interface CompiledGroupLayout { readonly group_id: string; engine_indices: number[]; }

/** Whole-block partitioning over engine metadata, never a second robot graph. */
export function partitionControlInputs(controlSize: number, blocks: readonly ControlBlock[],
  groups: readonly GroupSelection[]): CompiledGroupLayout[] {
  if (!Number.isSafeInteger(controlSize) || controlSize < 0) throw new Error('invalid control size');
  const byName = new Map<string, ControlBlock>();
  const storage = new Set<number>();
  for (const block of blocks) {
    if (typeof block.actuator_name !== 'string' || !block.actuator_name || byName.has(block.actuator_name)) {
      throw new Error('invalid or duplicate compiled actuator');
    }
    if (!Array.isArray(block.engine_indices) || !block.engine_indices.length ||
        !Array.isArray(block.inputs) || block.inputs.length !== block.engine_indices.length) {
      throw new Error('invalid block shape');
    }
    for (const index of block.engine_indices) {
      if (!Number.isSafeInteger(index) || index < 0 || index >= controlSize) {
        throw new Error('invalid engine input address');
      }
      if (storage.has(index)) throw new Error('overlapping engine input');
      storage.add(index);
    }
    byName.set(block.actuator_name, block);
  }
  if (storage.size !== controlSize) throw new Error('unmapped control input');
  const groupIds = new Set<string>();
  const owners = new Set<string>();
  const result: CompiledGroupLayout[] = [];
  for (const group of groups) {
    if (typeof group.group_id !== 'string' || !group.group_id || groupIds.has(group.group_id)) {
      throw new Error('invalid or duplicate group');
    }
    if (!Array.isArray(group.actuator_names) || !group.actuator_names.length) {
      throw new Error('empty group');
    }
    groupIds.add(group.group_id);
    const indices: number[] = [];
    for (const name of group.actuator_names) {
      const block = byName.get(name);
      if (!block) throw new Error('unknown actuator: ' + name);
      if (owners.has(name)) throw new Error('actuator owned more than once: ' + name);
      owners.add(name);
      indices.push(...block.engine_indices);
    }
    result.push({ group_id: group.group_id, engine_indices: indices });
  }
  if (owners.size !== byName.size) throw new Error('unowned actuator');
  return result;
}
