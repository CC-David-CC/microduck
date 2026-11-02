import { safeProjectPath } from './project-path.ts';
import { scanMjcfXml } from './mjcf-source.ts';
import type { MjcfLocation, MjcfReference, MjcfScan, MjcfScanLimits } from './mjcf-source.ts';
import type { OwnedProjectFile } from './file-snapshot.ts';
import type { ProjectInventory } from './project-inventory.ts';

export interface MjcfClosureLimits {
  max_files: number;
  max_total_bytes: number;
  max_references: number;
  max_include_depth: number;
  scan: Readonly<MjcfScanLimits>;
}
export interface MjcfDependency {
  source_path: string;
  kind: MjcfReference['kind'];
  value: string;
  at: MjcfLocation;
  candidates: readonly string[];
  target_path: string;
}
export interface MjcfClosure {
  project_revision: string;
  entry_path: string;
  files: Readonly<Record<string, Readonly<OwnedProjectFile>>>;
  sources: Readonly<Record<string, Readonly<MjcfScan>>>;
  dependencies: readonly Readonly<MjcfDependency>[];
  total_bytes: number;
}

const outerKeys = ['max_files', 'max_total_bytes', 'max_references', 'max_include_depth'] as const;
const scanKeys = ['max_xml_bytes', 'max_depth', 'max_elements', 'max_attributes_per_element',
  'max_attribute_utf16', 'max_references'] as const;

function record(value: unknown): asserts value is object {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error('Expected plain closure limits');
  }
}
function capture(value: unknown, keys: readonly string[]): Record<string, number> {
  record(value);
  const result: Record<string, number> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'number' ||
        !Number.isSafeInteger(descriptor.value) || descriptor.value <= 0) {
      throw new Error(`Invalid closure limit: ${key}`);
    }
    result[key] = descriptor.value;
  }
  return result;
}
function directory(path: string): string {
  const at = path.lastIndexOf('/');
  return at < 0 ? '' : path.slice(0, at);
}
function join(...parts: string[]): string {
  return parts.filter(Boolean).join('/');
}
function includeCandidate(base: string, value: string): string {
  const parts = base ? base.split('/') : [];
  for (const part of value.split('/')) {
    if (part === '..') {
      if (!parts.length) throw new Error('Include reference escapes project root');
      parts.pop();
    } else parts.push(part);
  }
  return safeProjectPath(parts.join('/'));
}
function located(path: string, at: MjcfLocation, reason: string): Error {
  return new Error(`${path}:${at.line}:${at.column} (UTF-16 offset ${at.offset_utf16}): ${reason}`.slice(0, 2000));
}

/** Collect the selected lexical dependency graph, without validating or compiling assets. */
export async function collectMjcfClosure(
  inventory: Readonly<ProjectInventory>,
  entry_path: unknown,
  limits: Readonly<MjcfClosureLimits>,
): Promise<Readonly<MjcfClosure>> {
  try {
    const caps = capture(limits, outerKeys);
    const scanField = Object.getOwnPropertyDescriptor(limits, 'scan');
    if (!scanField || !Object.hasOwn(scanField, 'value')) throw new Error('closure: scan must be an own data field');
    const scanCaps = capture(scanField.value, scanKeys);
    if (typeof entry_path !== 'string') {
      throw new Error('entry_path: expected an exact selected XML path');
    }
    let path: string;
    try {
      path = safeProjectPath(entry_path);
    } catch (error) {
      throw new Error(`entry_path: ${error instanceof Error ? error.message : 'invalid path'}`);
    }
    if (!/\.xml$/i.test(path) || path.split('/').some(part => /\.(zip|mjz)$/i.test(part))) {
      throw new Error('entry_path: expected a nonarchive .xml path');
    }
    const selected = inventory.files;
    if (!Object.hasOwn(selected, path)) throw new Error('entry_path: selected XML file is absent');

    const files: Record<string, Readonly<OwnedProjectFile>> = Object.create(null);
    const sources: Record<string, Readonly<MjcfScan>> = Object.create(null);
    const edges: Readonly<MjcfDependency>[] = [];
    let total = 0;
    const admit = (target: string, at?: MjcfLocation, source?: string): void => {
      if (Object.hasOwn(files, target)) return;
      const file = selected[target];
      if (!file) {
        throw at && source
          ? located(source, at, `Missing dependency; tried ${target}`)
          : new Error(`entry_path: missing ${target}`);
      }
      if (Object.keys(files).length >= caps.max_files) throw new Error('Closure file limit exceeded');
      if (file.bytes > caps.max_total_bytes - total) throw new Error('Closure byte limit exceeded');
      files[target] = file;
      total += file.bytes;
    };
    const directories = new Set<string>();
    for (const selectedPath of Object.keys(selected)) {
      let prefix = '';
      const segments = selectedPath.split('/');
      for (let i = 0; i < segments.length - 1; i++) {
        prefix = join(prefix, segments[i]);
        directories.add(prefix);
      }
    }
    const root = directory(path);
    type Pending = {source: string; role: 'model' | 'include'; ref: MjcfReference; edge?: Readonly<MjcfDependency>};
    const pending: Pending[] = [];
    const effective: Partial<Record<'assetdir' | 'meshdir' | 'texturedir', string>> = Object.create(null);
    const choose = (source: string, reference: MjcfReference, candidates: string[]): string => {
      for (const candidate of candidates) {
        if (Object.hasOwn(selected, candidate)) return candidate;
        if (directories.has(candidate)) throw located(source, reference.at, `Dependency resolves to selected directory: ${candidate}`);
      }
      throw located(source, reference.at, `Missing ${reference.kind} dependency; tried ${candidates.join(', ')}`);
    };
    const visit = async (xmlPath: string, role: 'model' | 'include', depth: number): Promise<void> => {
      if (depth > caps.max_include_depth) throw new Error('Closure include depth exceeded');
      if (Object.hasOwn(sources, xmlPath)) {
        throw new Error(`Repeated selected XML dependency: ${xmlPath}`);
      }
      const scan = await scanMjcfXml(
        xmlPath, files[xmlPath].content, role, scanCaps as unknown as MjcfScanLimits,
      );
      sources[xmlPath] = scan;
      const events: ({kind: 'reference'; at: number; ref: MjcfReference} |
        {kind: 'compiler'; at: number; key: 'assetdir' | 'meshdir' | 'texturedir'; value: string})[] =
        scan.references.map(ref => ({kind: 'reference', at: ref.at.offset_utf16, ref}));
      for (const key of ['assetdir', 'meshdir', 'texturedir'] as const) {
        const field = scan.compiler?.[key];
        if (field) events.push({kind: 'compiler', at: field.at.offset_utf16, key, value: field.value});
      }
      events.sort((a, b) => a.at - b.at);
      for (const event of events) {
        if (event.kind === 'compiler') { effective[event.key] = event.value; continue; }
        const reference = event.ref;
        if (pending.length >= caps.max_references) {
          throw located(xmlPath, reference.at, 'Closure reference limit exceeded');
        }
        const item: Pending = {source: xmlPath, role, ref: reference};
        pending.push(item);
        if (reference.kind !== 'include') continue;
        let ordered: string[];
        try { ordered = [...new Set([includeCandidate(root, reference.value), includeCandidate(directory(xmlPath), reference.value)])]; }
        catch (error) { throw located(xmlPath, reference.at, error instanceof Error ? error.message : 'Invalid include path'); }
        const target = choose(xmlPath, reference, ordered);
        if (Object.hasOwn(sources, target)) {
          throw located(xmlPath, reference.at, `Repeated selected XML include: ${target}`);
        }
        item.edge = Object.freeze({
          source_path: xmlPath, kind: reference.kind, value: reference.value, at: reference.at,
          candidates: Object.freeze(ordered), target_path: target,
        });
        admit(target, reference.at, xmlPath);
        await visit(target, 'include', depth + 1);
      }
    };
    admit(path);
    await visit(path, 'model', 1);
    for (const item of pending) {
      if (item.edge) { edges.push(item.edge); continue; }
      const reference = item.ref;
      const key = reference.kind === 'mesh' ? 'meshdir' : 'texturedir';
      const assetDir = effective[key] ?? effective.assetdir ?? '';
      const candidates = item.role === 'model' ? [join(root, assetDir, reference.value)] :
        [join(root, assetDir, reference.value), join(directory(item.source), reference.value)];
      const ordered = [...new Set(candidates)];
      const target = choose(item.source, reference, ordered);
      edges.push(Object.freeze({source_path: item.source, kind: reference.kind, value: reference.value,
        at: reference.at, candidates: Object.freeze(ordered), target_path: target}));
      admit(target, reference.at, item.source);
    }
    // Expose the original depth-first first-use ordering, even though asset
    // selection waits until all compiler settings have been discovered.
    const orderedFiles: Record<string, Readonly<OwnedProjectFile>> = Object.create(null);
    orderedFiles[path] = files[path];
    for (const edge of edges) orderedFiles[edge.target_path] = files[edge.target_path];
    Object.freeze(orderedFiles);
    Object.freeze(sources);
    Object.freeze(edges);
    return Object.freeze({
      project_revision: inventory.project_revision, entry_path: path,
      files: orderedFiles, sources, dependencies: edges, total_bytes: total,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Closure failed';
    const prefix = /^(?:entry_path:|closure:|[^:\r\n]+\.xml:)/i.test(message) ? '' : 'closure: ';
    throw new Error((prefix + message).slice(0, 2000) || 'closure: failed');
  }
}
