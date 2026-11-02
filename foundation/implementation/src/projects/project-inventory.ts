import { snapshotProjectFile } from './file-snapshot.ts';
import type { OwnedProjectFile } from './file-snapshot.ts';
import { readManifestEnvelope } from './manifest-envelope.ts';
import type { ManifestEnvelope } from './manifest-envelope.ts';
import { safeProjectPath } from './project-path.ts';
import { unicodeDefaultCaseFold17 } from './unicode-casefold.ts';

const capturedInventories = new WeakSet<object>();

/** Realm-local proof; transferred bytes must be captured again in the receiving worker. */
export function isCapturedProjectInventory(value: unknown): value is Readonly<ProjectInventory> {
  return typeof value === 'object' && value !== null && capturedInventories.has(value);
}

export type ProjectInventoryLimits = {
  max_files: number;
  max_total_bytes: number;
  max_file_bytes: number;
  max_manifest_bytes: number;
  max_manifest_depth: number;
};

export interface ProjectInventory {
  readonly project_revision: string;
  readonly manifest: Readonly<OwnedProjectFile>;
  readonly envelope: Readonly<ManifestEnvelope>;
  readonly files: Readonly<Record<string, Readonly<OwnedProjectFile>>>;
  readonly total_bytes: number;
}

function plainRecord(value: unknown): asserts value is object {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('Expected a plain host data record');
  }
}

function ownValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw new Error(`Expected own data property: ${key}`);
  }
  return descriptor.value;
}

/** Selected-file admission only: acquisition, dependency closure and run
 * readiness remain separate. Caller records are trusted-host data, not proxies
 * or an imported-code isolation boundary. Accepted paths are never rewritten. */
export async function captureProjectInventory(
  entries: readonly { readonly path: unknown; readonly data: Uint8Array }[],
  limits: ProjectInventoryLimits,
): Promise<Readonly<ProjectInventory>> {
  try {
    plainRecord(limits);
    const caps = Object.create(null) as ProjectInventoryLimits;
    for (const key of ['max_files', 'max_total_bytes', 'max_file_bytes',
      'max_manifest_bytes', 'max_manifest_depth'] as const) {
      const value = ownValue(limits, key);
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Expected positive safe integer: ${key}`);
      }
      caps[key] = value;
    }
    if (caps.max_manifest_depth > 64) throw new Error('Manifest depth exceeds 64');
    if (!Array.isArray(entries) || Object.getPrototypeOf(entries) !== Array.prototype) {
      throw new Error('Expected an ordinary same-realm selected-file array');
    }
    const count = ownValue(entries, 'length') as number;
    if (count > caps.max_files) throw new Error('Selected file count exceeds limit');
    const captured: {path: string; data: Uint8Array}[] = [];
    const namespace = new Map<string, {path: string; directory: boolean}>();
    const nativeView = Object.getPrototypeOf(Uint8Array.prototype);
    let total_bytes = 0, hasManifest = false;
    for (let index = 0; index < count; index++) {
      const entry = ownValue(entries, String(index));
      plainRecord(entry);
      const path = safeProjectPath(ownValue(entry, 'path'));
      const data = ownValue(entry, 'data') as Uint8Array;
      const segments = path.split('/');
      let prefix = '';
      for (let part = 0; part < segments.length; part++) {
        prefix += (part ? '/' : '') + segments[part];
        const key = unicodeDefaultCaseFold17(prefix.normalize('NFD')).normalize('NFD');
        const directory = part < segments.length - 1;
        const previous = namespace.get(key);
        if (previous && (previous.path !== prefix || !previous.directory || !directory)) {
          throw new Error(`Conflicting project path: ${prefix}`);
        }
        if (!previous) namespace.set(key, {path: prefix, directory});
      }
      // No content copy or digest has started. Native getters ignore subclass
      // decorations; P02 below owns full byte-kind/buffer admission and copying.
      const bytes: number = Reflect.get(nativeView, 'byteLength', data);
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > caps.max_file_bytes) {
        throw new Error(`Actual file size exceeds limit: ${path}`);
      }
      if (path === 'manifest.json') {
        hasManifest = true;
        if (bytes > caps.max_manifest_bytes) throw new Error('Manifest byte limit exceeded');
      }
      // Subtraction stays exact: both operands and the resulting total are safe
      // nonnegative integers, including when the supplied cap is MAX_SAFE_INTEGER.
      if (bytes > caps.max_total_bytes - total_bytes) throw new Error('Total byte limit exceeded');
      total_bytes += bytes;
      captured.push({path, data});
    }
    if (!hasManifest) throw new Error('Exactly one literal manifest.json is required');

    // P02 is async but captures bytes before its first await. Start every capture
    // synchronously, then observe every rejection together before publication.
    const pending = captured.map(entry => snapshotProjectFile(entry.path, entry.data, caps.max_file_bytes));
    const snapshots = await Promise.all(pending);
    const files: Record<string, Readonly<OwnedProjectFile>> = Object.create(null);
    for (const file of snapshots) files[file.path] = file;
    const manifest = files['manifest.json'];
    const envelope = await readManifestEnvelope(manifest.content,
      {max_bytes: caps.max_manifest_bytes, max_depth: caps.max_manifest_depth});
    if (Object.keys(envelope.files).length !== snapshots.length - 1) {
      throw new Error('Selected files differ from manifest inventory');
    }
    for (const [path, expected] of Object.entries(envelope.files)) {
      const actual = files[path];
      if (!actual || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
        throw new Error(`Manifest file missing or content mismatch: ${path}`);
      }
    }
    const inventory = Object.freeze({project_revision: manifest.sha256, manifest, envelope,
      files: Object.freeze(files), total_bytes});
    capturedInventories.add(inventory);
    return inventory;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Inventory capture failed';
    throw new Error(reason.slice(0, 1000) || 'Inventory capture failed');
  }
}
