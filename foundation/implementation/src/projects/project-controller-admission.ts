import {isCapturedProjectInventory, type ProjectInventory} from './project-inventory.ts';
import {safeProjectPath} from './project-path.ts';
import {prepareJsModule} from '../isolation/js-module-source.ts';
import {copyBounded} from '../session/project-world-wire.ts';

// This consumes trusted host profile data, not authority from imported code.
// The session worker must still derive group/lease and grant authority from its actual world.
const MAX_GROUPS = 64, MAX_CHANNELS = 256, MAX_SOURCE_BYTES = 131072;
const MAX_PROFILE_BYTES = 2 * 1024 * 1024;
const prepared = new WeakSet<object>();
// Pin the native Blob operation before any project data is inspected.
const readBlob = Blob.prototype.arrayBuffer;

function record(value: unknown, keys: readonly string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Invalid controller profile');
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(name => typeof name !== 'string' || !keys.includes(name)) ||
      keys.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid controller profile');
}
function id(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
function boundedObject(value: unknown, limit: number): Record<string, unknown> {
  const clone = copyBounded(value, limit);
  if (!clone || typeof clone !== 'object' || Array.isArray(clone)) throw new Error('Invalid controller data');
  let nodes = 0;
  function walk(item: any, depth: number): void {
    if (++nodes > 4096 || depth > 12) throw new Error('Controller data complexity limit');
    if (item && typeof item === 'object') for (const value of Object.values(item)) walk(value, depth + 1);
  }
  walk(clone, 0);
  return clone;
}
function freeze(value: any): any {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

/** Realm-local brand only; transferred data must be captured/admitted again. */
export function isPreparedProjectControllers(value: unknown): boolean {
  return !!value && typeof value === 'object' && prepared.has(value);
}

/** Bind inert source from one captured project to explicitly provided host group/grant descriptions.
 * This does not execute source or prove that supplied descriptions match a compiled world. */
export async function prepareProjectControllers(inventory: Readonly<ProjectInventory>, profile: unknown) {
  if (!isCapturedProjectInventory(inventory)) throw new Error('Project inventory is not captured');
  // Snapshot every host-supplied field before the first asynchronous file read.
  const owned = copyBounded(profile, MAX_PROFILE_BYTES);
  record(owned, ['required_groups', 'channels', 'controllers']);
  if (!Array.isArray(owned.required_groups) || owned.required_groups.length > MAX_GROUPS ||
      !Array.isArray(owned.controllers) || owned.controllers.length > MAX_GROUPS ||
      !Array.isArray(owned.channels) || owned.channels.length > MAX_CHANNELS) throw new Error('Controller profile size limit');
  const groups = new Set<string>();
  for (const group of owned.required_groups) {
    if (!id(group) || groups.has(group)) throw new Error('Invalid required groups');
    groups.add(group);
  }
  const channels = new Map<string, string>();
  for (const channel of owned.channels) {
    record(channel, ['channel_id', 'definition_sha256']);
    if (!id(channel.channel_id) || !hash(channel.definition_sha256) || channels.has(channel.channel_id)) throw new Error('Invalid channel catalog');
    channels.set(channel.channel_id, channel.definition_sha256);
  }
  const seen = new Set<string>();
  const captured = owned.controllers.map((row: unknown) => {
    record(row, ['group_id', 'source_path', 'parameters', 'intent', 'grants']);
    if (!id(row.group_id) || !groups.has(row.group_id) || seen.has(row.group_id)) throw new Error('Invalid controller group');
    seen.add(row.group_id);
    const path = safeProjectPath(row.source_path);
    if (path.length > 256) throw new Error('Controller source path too long');
    const file = inventory.files[path];
    if (!file || path === 'manifest.json') throw new Error('Controller source missing');
    if (file.bytes > MAX_SOURCE_BYTES) throw new Error('Controller source exceeds byte limit');
    const parameters = boundedObject(row.parameters, 16384), intent = boundedObject(row.intent, 1024);
    if (!Array.isArray(row.grants) || row.grants.length > MAX_CHANNELS) throw new Error('Invalid grants');
    const granted = new Set<string>();
    const grants = row.grants.map((grant: unknown) => {
      record(grant, ['channel_id', 'definition_sha256']);
      if (!id(grant.channel_id) || !hash(grant.definition_sha256) || granted.has(grant.channel_id) ||
          channels.get(grant.channel_id) !== grant.definition_sha256) throw new Error('Invalid grant');
      granted.add(grant.channel_id);
      return {channel_id:grant.channel_id, definition_sha256:grant.definition_sha256};
    });
    return {group_id: row.group_id, source_path:path, file, parameters, intent, grants};
  });
  if (seen.size !== groups.size) throw new Error('Missing controller group');
  const controllers = [];
  for (const row of captured) {
    let bytes: ArrayBuffer;
    try { bytes = await Reflect.apply(readBlob, row.file.content, []); }
    catch { throw new Error('Controller source read failed'); }
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== row.file.bytes || bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new Error('Controller source size mismatch');
    }
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const actualHash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    if (actualHash !== row.file.sha256) throw new Error('Controller source hash mismatch');
    let source: string;
    try { source = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes); }
    catch { throw new Error('Invalid controller source encoding'); }
    const result = prepareJsModule(source, row.source_path);
    if (!result.ok) throw new Error('Controller source rejected: ' + result.diagnostic.code);
    controllers.push({group_id:row.group_id, source_path:row.source_path, source_sha256:row.file.sha256,
      source, parameters:row.parameters, intent:row.intent, grants:row.grants});
  }
  const result = freeze({project_revision:inventory.project_revision, controllers});
  prepared.add(result);
  return result;
}
