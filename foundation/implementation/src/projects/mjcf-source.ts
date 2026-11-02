import { SaxesParser } from 'saxes';
import { safeProjectPath } from './project-path.ts';

export interface MjcfScanLimits {
  max_xml_bytes: number;
  max_depth: number;
  max_elements: number;
  max_attributes_per_element: number;
  max_attribute_utf16: number;
  max_references: number;
}
export interface MjcfLocation {
  offset_utf16: number;
  line: number;
  column: number;
}
export interface LocatedProjectReference { value: string; at: MjcfLocation; }
export interface MjcfReference extends LocatedProjectReference {
  kind: 'include' | 'mesh' | 'texture';
}
export interface MjcfScan {
  source_path: string;
  role: 'model' | 'include';
  root: 'mujoco' | 'mujocoinclude';
  references: readonly MjcfReference[];
  compiler: Readonly<Partial<Record<'assetdir' | 'meshdir' | 'texturedir', LocatedProjectReference>>> | null;
}

type Directory = 'assetdir' | 'meshdir' | 'texturedir';
function projectPath(value: unknown): string {
  const path = safeProjectPath(value);
  if (path.split('/').some(part => /\.(zip|mjz)$/i.test(part))) throw new Error('Archive-looking path segment');
  return path;
}
function includePath(value: string): string {
  if ([...value].length > 240 || value.normalize('NFC') !== value) throw new Error('Invalid include path');
  // Validate each original ordinary component under the inventory policy while
  // retaining parent components for the root-confined closure resolver.
  projectPath(value.split('/').map(part => part === '..' ? 'x' : part).join('/'));
  return value;
}

/** Scan the bounded dependency profile without resolving or compiling resources.
 * The unchanged input Blob remains source authority; this is not run admission. */
export async function scanMjcfXml(
  source_path: unknown, content: Blob, role: 'model' | 'include',
  limits: Readonly<MjcfScanLimits>,
): Promise<Readonly<MjcfScan>> {
  let path: string;
  try { path = projectPath(source_path); }
  catch { throw new Error('source_path: expected a canonical non-archive project path'); }
  let cursor: (() => MjcfLocation) | undefined;
  try {
    if (role !== 'model' && role !== 'include') throw new Error('Invalid XML role');
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('Expected host limits');
    const budget = { max_xml_bytes: limits.max_xml_bytes, max_depth: limits.max_depth,
      max_elements: limits.max_elements, max_attributes_per_element: limits.max_attributes_per_element,
      max_attribute_utf16: limits.max_attribute_utf16, max_references: limits.max_references };
    if (Object.values(budget).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('Invalid host limit');
    const sizeOf = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')?.get;
    const bufferSize = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
    const read = Blob.prototype.arrayBuffer, clone = globalThis.structuredClone;
    if (!(content instanceof Blob) || !sizeOf || !bufferSize || typeof read !== 'function' || typeof clone !== 'function') {
      throw new Error('Native Blob/read/clone capability is unavailable');
    }
    const size: number = sizeOf.call(content);
    if (size > budget.max_xml_bytes) throw new Error('XML byte budget exceeded');
    const owned = clone.call(globalThis, content);
    if (!(owned instanceof Blob) || sizeOf.call(owned) !== size) throw new Error('Native Blob clone mismatch');
    const bytes = await read.call(owned);
    if (!(bytes instanceof ArrayBuffer) || bufferSize.call(bytes) !== size) throw new Error('Native Blob read mismatch');
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const parser = new SaxesParser({ xmlns: false, fragment: false, position: true,
      defaultXMLVersion: '1.0', forceXMLVersion: true });
    const location = (): MjcfLocation => Object.freeze({ offset_utf16: parser.position, line: parser.line, column: parser.column });
    cursor = location;
    const references: MjcfReference[] = [];
    const stack: { name: string; attributes: number }[] = [];
    let root: MjcfScan['root'] | undefined, elements = 0;
    let compiler: Partial<Record<Directory, LocatedProjectReference>> | null = null;
    const forbidden = new Set(['model', 'attach', 'extension', 'plugin', 'replicate', 'composite', 'flexcomp']);
    const extensions = { include: '.xml', mesh: '.obj', texture: '.png' } as const;
    const nameAllowed = (name: string): boolean => /^[a-z][a-z0-9_]*$/.test(name);
    function located(value: string, include = false): LocatedProjectReference {
      // The public cursor follows a parser-validated closing quote; encoded
      // quotes are not literal delimiters. This does not tokenize XML again.
      const end = parser.position, quote = source[end - 1];
      const start = source.lastIndexOf(quote, end - 2);
      if ((quote !== '"' && quote !== "'") || start < 0) throw new Error('Unavailable quoted attribute span');
      if (/[\t\r\n]/.test(source.slice(start + 1, end - 1))) throw new Error('Literal resource whitespace differs from the native engine');
      return Object.freeze({ value: include ? includePath(value) : projectPath(value), at: location() });
    }
    parser.on('error', error => { throw error; });
    parser.on('xmldecl', declaration => {
      if (declaration.version !== '1.0' || (declaration.encoding !== undefined && !/^[Uu][Tt][Ff]-8$/.test(declaration.encoding))) {
        throw new Error('Only XML 1.0 with UTF-8 encoding is supported');
      }
    });
    for (const event of ['doctype', 'processinginstruction', 'cdata'] as const) {
      parser.on(event, () => { throw new Error('Unsupported XML declaration or content construct'); });
    }
    parser.on('text', text => {
      if (/[^ \t\r\n]/.test(text)) throw new Error('Non-whitespace element text is unsupported');
    });
    parser.on('opentagstart', tag => {
      if (!nameAllowed(tag.name) || forbidden.has(tag.name)) throw new Error('Unsupported element name');
      if (++elements > budget.max_elements || stack.length + 1 > budget.max_depth) throw new Error('XML element/depth budget exceeded');
      if (stack.length === 0) {
        if (tag.name !== 'mujoco' && !(role === 'include' && tag.name === 'mujocoinclude')) throw new Error('Invalid root for XML role');
        root = tag.name as MjcfScan['root'];
      }
      if (tag.name === 'compiler') {
        if (stack.length !== 1 || compiler !== null) throw new Error('Only one top-level compiler per document is supported');
        compiler = Object.create(null) as Partial<Record<Directory, LocatedProjectReference>>;
      }
      stack.push({ name: tag.name, attributes: 0 });
    });
    parser.on('attribute', attribute => {
      const frame = stack[stack.length - 1], { name, value } = attribute;
      if (!frame) throw new Error('Attribute without an element');
      if (++frame.attributes > budget.max_attributes_per_element || value.length > budget.max_attribute_utf16) {
        throw new Error('XML attribute budget exceeded');
      }
      if (!nameAllowed(name) || name === 'xmlns') throw new Error('Unsupported attribute name or namespace');
      if (role === 'include' && stack.length === 1 && name !== 'model') throw new Error('Include wrapper attributes are unsupported');
      if (frame.name === 'include' && name !== 'file') throw new Error('Include supports only file');
      if ((frame.name === 'mesh' || frame.name === 'texture') && name === 'content_type') throw new Error('Resource content_type overrides are unsupported');
      if (frame.name === 'compiler' && name === 'strippath' && value !== 'false') throw new Error('Compiler strippath must be false');
      if (frame.name === 'compiler' && ['assetdir', 'meshdir', 'texturedir'].includes(name)) {
        compiler![name as Directory] = located(value);
      }
      if (name.startsWith('file')) {
        if (name !== 'file' || !Object.hasOwn(extensions, frame.name)) throw new Error('Unsupported file attribute');
        const kind = frame.name as keyof typeof extensions;
        const reference = located(value, kind === 'include');
        if (!value.replace(/[A-Z]/g, letter => letter.toLowerCase()).endsWith(extensions[kind]) && !(kind === 'mesh' && value.replace(/[A-Z]/g, letter => letter.toLowerCase()).endsWith('.stl'))) throw new Error('Unsupported resource extension');
        if (references.length >= budget.max_references) throw new Error('XML reference budget exceeded');
        references.push(Object.freeze({ kind, ...reference }));
      }
    });
    parser.on('opentag', tag => {
      if (tag.name === 'include' && (!tag.isSelfClosing || !Object.hasOwn(tag.attributes, 'file'))) {
        throw new Error('Include requires file and a self-closing element');
      }
    });
    parser.on('closetag', () => { stack.pop(); });
    parser.write(source).close();
    if (!root || stack.length !== 0) throw new Error('Incomplete XML document');
    return Object.freeze({ source_path: path, role, root, references: Object.freeze(references),
      compiler: compiler === null ? null : Object.freeze(compiler) });
  } catch (error) {
    const at = cursor?.();
    const prefix = at ? `${path}:${at.line}:${at.column} (UTF-16 offset ${at.offset_utf16}): ` : `${path}: `;
    const reason = error instanceof Error ? error.message : 'XML scan failed';
    throw new Error((prefix + reason).slice(0, 2000));
  }
}
