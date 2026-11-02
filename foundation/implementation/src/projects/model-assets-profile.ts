import {BinaryStlError,inspectBinaryStl} from './binary-stl.ts';
import {safeProjectPath} from './project-path.ts';
import type {MjcfClosure} from './mjcf-closure.ts';

export interface ModelAssetProfileLimits {
  max_obj_bytes: number;
  max_obj_line_bytes: number;
  max_obj_vertices: number;
  max_obj_faces: number;
  max_obj_triangles: number;
  max_obj_abs_coordinate: number;
  max_png_bytes: number;
  max_png_width: number;
  max_png_height: number;
  max_png_pixels: number;
  max_png_decoded_bytes: number;
  max_png_chunks: number;
}
export interface ObjProfileFacts {
  readonly path: string;
  readonly kind: 'obj';
  readonly bytes: number;
  readonly sha256: string;
  readonly vertices: number;
  readonly faces: number;
  readonly triangles: number;
  readonly ignored_materials?: Readonly<{libraries: readonly string[]; names: readonly string[]}>;
}
export interface PngProfileFacts {
  readonly path: string;
  readonly kind: 'png';
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly decoded_bytes: number;
  readonly chunks: number;
}
export interface StlProfileFacts {readonly path:string;readonly kind:'stl';readonly bytes:number;readonly sha256:string;readonly vertices:number;readonly faces:number;readonly triangles:number;}
export type ModelAssetFacts = ObjProfileFacts | StlProfileFacts | PngProfileFacts;
export interface ModelAssetsProfileSummary {
  readonly project_revision: string;
  readonly entry_path: string;
  readonly assets: readonly ModelAssetFacts[];
}
type ErrorCode = 'unsupported_asset' | 'resource_limit';
type ProfileError = Error & {readonly code: ErrorCode; readonly phase: 'asset-preflight'};

class AssetProfileError extends Error implements ProfileError {
  readonly code: ErrorCode;
  readonly phase = 'asset-preflight' as const;
  constructor(code: ErrorCode, message: string) {
    super(message.slice(0, 2000));
    this.code = code;
    this.name = 'AssetProfileError';
  }
}
function fail(code: ErrorCode, message: string, path?: string): never {
  throw new AssetProfileError(code, (path ? path + ': ' : '') + message);
}
function unsupported(message: string, path?: string): never {
  return fail('unsupported_asset', message, path);
}
function overLimit(message: string, path?: string): never {
  return fail('resource_limit', message, path);
}
function plainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    unsupported(label + ': expected a plain record');
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    unsupported(label + ': expected a plain record');
  }
}
const limitKeys = [
  'max_obj_bytes', 'max_obj_line_bytes', 'max_obj_vertices', 'max_obj_faces',
  'max_obj_triangles', 'max_obj_abs_coordinate', 'max_png_bytes', 'max_png_width',
  'max_png_height', 'max_png_pixels', 'max_png_decoded_bytes', 'max_png_chunks',
] as const;
type CapturedLimits = ModelAssetProfileLimits;
function captureLimits(value: unknown): CapturedLimits {
  try {
    plainRecord(value, 'limits');
    const result: Record<string, number> = Object.create(null);
    for (const key of limitKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') ||
          typeof descriptor.value !== 'number' || !Number.isFinite(descriptor.value)) {
        overLimit('limits: invalid own numeric cap ' + key);
      }
      const number = descriptor.value as number;
      if (key === 'max_obj_abs_coordinate') {
        if (number <= 0) overLimit('limits: cap must be positive ' + key);
      } else if (!Number.isSafeInteger(number) || number <= 0) {
        overLimit('limits: cap must be a positive safe integer ' + key);
      }
      result[key] = number;
    }
    return Object.freeze(result) as unknown as CapturedLimits;
  } catch (error) {
    if (error instanceof AssetProfileError) throw error;
    return overLimit('limits: invalid host caps');
  }
}
interface FileSnapshot {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly content: Blob;
  readonly kind: 'obj' | 'stl' | 'png';
}
interface ClosureSnapshot {
  readonly project_revision: string;
  readonly entry_path: string;
  readonly assets: readonly FileSnapshot[];
}
const blobSizeGetter = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')?.get;
const blobArrayBuffer = Blob.prototype.arrayBuffer;
const arrayBufferByteLengthGetter = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;

function ownData(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    unsupported(label + ': expected own data field ' + key);
  }
  return descriptor.value;
}
function captureClosure(closure: unknown, caps: CapturedLimits): ClosureSnapshot {
  try {
    plainRecord(closure, 'closure');
    const revision = ownData(closure, 'project_revision', 'closure');
    const entry = ownData(closure, 'entry_path', 'closure');
    const filesValue = ownData(closure, 'files', 'closure');
    if (typeof revision !== 'string' || !/^[0-9a-f]{64}$/.test(revision)) {
      unsupported('closure: invalid project revision');
    }
    if (typeof entry !== 'string') unsupported('closure: invalid entry path');
    try { safeProjectPath(entry); } catch { unsupported('closure: invalid entry path'); }
    plainRecord(filesValue, 'closure files');
    const keys = Reflect.ownKeys(filesValue);
    const assets: FileSnapshot[] = [];
    let hasEntry = false;
    for (const key of keys) {
      if (typeof key !== 'string') unsupported('closure files: symbol key is unsupported');
      const descriptor = Object.getOwnPropertyDescriptor(filesValue, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) unsupported('closure files: accessor is unsupported');
      const path = safeProjectPath(key);
      if (path === entry) hasEntry = true;
      const file = descriptor.value;
      plainRecord(file, 'closure file ' + path);
      const filePath = ownData(file, 'path', path);
      const byteCount = ownData(file, 'bytes', path);
      const sha256 = ownData(file, 'sha256', path);
      const content = ownData(file, 'content', path);
      if (filePath !== path) unsupported('closure path and file path differ', path);
      if (typeof byteCount !== 'number' || !Number.isSafeInteger(byteCount) || byteCount < 0) {
        unsupported('invalid owned file byte count', path);
      }
      if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
        unsupported('invalid owned file SHA-256', path);
      }
      if (!(content instanceof Blob) || !blobSizeGetter || typeof blobArrayBuffer !== 'function') {
        unsupported('native Blob capability unavailable', path);
      }
      let nativeSize: number;
      try { nativeSize = blobSizeGetter.call(content) as number; } catch { unsupported('invalid owned Blob', path); }
      if (nativeSize !== byteCount) unsupported('owned Blob size differs from file record', path);
      if (path.toLowerCase().endsWith('.obj')) {
        if (byteCount > caps.max_obj_bytes) overLimit('OBJ byte limit exceeded', path);
        assets.push(Object.freeze({path, bytes: byteCount, sha256, content, kind: 'obj'}));
      } else if (path.toLowerCase().endsWith('.stl')) {
        // Existing OBJ host caps conservatively bound all admitted mesh data until a reviewed mesh-budget contract replaces them.
        if (byteCount > caps.max_obj_bytes) overLimit('STL byte limit exceeded', path);
        assets.push(Object.freeze({path, bytes: byteCount, sha256, content, kind: 'stl'}));
      } else if (path.toLowerCase().endsWith('.png')) {
        if (byteCount > caps.max_png_bytes) overLimit('PNG byte limit exceeded', path);
        assets.push(Object.freeze({path, bytes: byteCount, sha256, content, kind: 'png'}));
      } else if (!path.toLowerCase().endsWith('.xml')) {
        unsupported('unsupported file type in selected closure', path);
      }
    }
    if (!hasEntry) unsupported('closure entry is absent from closure files');
    return Object.freeze({project_revision: revision, entry_path: entry, assets: Object.freeze(assets)});
  } catch (error) {
    if (error instanceof AssetProfileError) throw error;
    return unsupported('invalid accepted MJCF closure');
  }
}
async function readOwnedBytes(file: FileSnapshot): Promise<Uint8Array> {
  try {
    const clone = globalThis.structuredClone;
    if (typeof clone !== 'function') unsupported('native Blob cloning unavailable', file.path);
    const copy = clone.call(globalThis, file.content);
    if (!(copy instanceof Blob) || !blobSizeGetter || blobSizeGetter.call(copy) !== file.bytes) {
      unsupported('owned Blob clone mismatch', file.path);
    }
    const buffer = await blobArrayBuffer.call(copy);
    if (!(buffer instanceof ArrayBuffer) || !arrayBufferByteLengthGetter ||
        arrayBufferByteLengthGetter.call(buffer) !== file.bytes) {
      unsupported('owned Blob read mismatch', file.path);
    }
    const digestApi = globalThis.crypto?.subtle;
    if (!digestApi || typeof digestApi.digest !== 'function') unsupported('native SHA-256 unavailable', file.path);
    const bytes = new Uint8Array(buffer);
    const digest = await digestApi.digest('SHA-256', bytes);
    const digestText = Array.from(new Uint8Array(digest),
      item => item.toString(16).padStart(2, '0')).join('');
    if (digestText !== file.sha256) unsupported('owned bytes differ from closure SHA-256', file.path);
    return bytes;
  } catch (error) {
    if (error instanceof AssetProfileError) throw error;
    return unsupported('could not read and verify owned asset bytes', file.path);
  }
}
interface RemainingAggregateCaps {
  readonly obj_vertices: number;
  readonly obj_normals: number;
  readonly obj_texcoords: number;
  readonly obj_triangles: number;
  readonly png_decoded_bytes: number;
}
function parseObj(bytes: Uint8Array, caps: CapturedLimits, remaining: RemainingAggregateCaps, path: string): {
  vertices: number; faces: number; triangles: number; normalCount: number; texcoordCount: number;
  ignored_materials?: Readonly<{libraries: readonly string[]; names: readonly string[]}>;
} {
  for (const byte of bytes) {
    if (byte > 0x7f || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d)) {
      unsupported('OBJ v1 requires printable ASCII text', path);
    }
  }
  let source: string;
  try { source = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes); }
  catch { return unsupported('OBJ v1 requires ASCII text', path); }
  // OBJ v1 uses one supported shape only. Every declared vertex must belong to
  // an accepted face, so native import cannot silently count unused geometry.
  let vertices = 0, normals = 0, texcoords = 0, faces = 0, triangles = 0;
  let form: string | null = null, geometryStarted = false;
  const libraries: string[] = [], names: string[] = [];
  const referencedVertices = new Set<number>();
  const referencedNormals = new Set<number>(), referencedTexcoords = new Set<number>();
  const lines = source.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.includes('\r')) unsupported('OBJ line contains a bare carriage return', path);
    if (line.length > caps.max_obj_line_bytes) overLimit('OBJ line byte limit exceeded', path);
    const content = line.split('#', 1)[0].trim();
    if (!content) continue;
    const tokens = content.split(/[ \t]+/);
    if (tokens[0] === 'mtllib' || tokens[0] === 'usemtl') {
      const library = tokens[0] === 'mtllib', target = library ? libraries : names;
      if (geometryStarted || target.length || tokens.length !== 2 || tokens[1].length > 128 ||
          !(library ? /^[A-Za-z0-9_][A-Za-z0-9_-]*\.mtl$/ : /^[A-Za-z0-9_][A-Za-z0-9_-]*$/).test(tokens[1])) {
        unsupported('unsupported OBJ material declaration', path);
      }
      target.push(tokens[1]); continue;
    }
    if (tokens[0] === 'v' || tokens[0] === 'vn' || tokens[0] === 'vt') {
      geometryStarted = true;
      const kind = tokens[0], expected = kind === 'vt' ? 3 : 4;
      if (tokens.length !== expected) unsupported('OBJ attribute has incorrect coordinate count', path);
      for (const token of tokens.slice(1)) {
        if (!/^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$/.test(token)) {
          unsupported('invalid OBJ coordinate', path);
        }
        const coordinate = Number(token);
        if (!Number.isFinite(coordinate)) unsupported('nonfinite OBJ coordinate', path);
        const mantissa = token.split(/[eE]/, 1)[0];
        if (coordinate === 0 && /[1-9]/.test(mantissa)) unsupported('OBJ coordinate underflow', path);
        if (Math.abs(coordinate) > caps.max_obj_abs_coordinate) {
          overLimit('OBJ coordinate limit exceeded', path);
        }
      }
      const count = kind === 'v' ? vertices : kind === 'vn' ? normals : texcoords;
      const available = kind === 'v' ? remaining.obj_vertices : kind === 'vn' ? remaining.obj_normals : remaining.obj_texcoords;
      if (count >= caps.max_obj_vertices || count >= available) overLimit('OBJ attribute limit exceeded', path);
      if (kind === 'v') vertices++; else if (kind === 'vn') normals++; else texcoords++;
      continue;
    }
    if (tokens[0] === 'f') {
      geometryStarted = true;
      if (tokens.length !== 4 && tokens.length !== 5) {
        unsupported('OBJ faces must have three or four vertices', path);
      }
      const indices: number[] = [];
      for (const token of tokens.slice(1)) {
        const match = /^([1-9][0-9]*)(?:\/([1-9][0-9]*)?(?:\/([1-9][0-9]*))?)?$/.exec(token);
        if (!match || (token.includes('/') && !match[2] && !match[3])) unsupported('OBJ face index form is unsupported', path);
        const cornerForm = match[2] ? (match[3] ? 'v/vt/vn' : 'v/vt') : match[3] ? 'v//vn' : 'v';
        if (form !== null && form !== cornerForm) unsupported('OBJ face index forms must match', path);
        form = cornerForm;
        const index = Number(match[1]);
        if (!Number.isSafeInteger(index) || index > vertices) {
          unsupported('OBJ face index must refer to a preceding vertex', path);
        }
        indices.push(index);
        referencedVertices.add(index);
        if (match[2]) { const i = Number(match[2]); if (!Number.isSafeInteger(i) || i > texcoords) unsupported('OBJ texture index must refer to a preceding record', path); referencedTexcoords.add(i); }
        if (match[3]) { const i = Number(match[3]); if (!Number.isSafeInteger(i) || i > normals) unsupported('OBJ normal index must refer to a preceding record', path); referencedNormals.add(i); }
      }
      if (new Set(indices).size !== indices.length) unsupported('OBJ face repeats a vertex', path);
      if (faces >= caps.max_obj_faces) overLimit('OBJ face limit exceeded', path);
      const addedTriangles = indices.length - 2;
      if (addedTriangles > caps.max_obj_triangles - triangles) {
        overLimit('OBJ triangle limit exceeded', path);
      }
      if (addedTriangles > remaining.obj_triangles - triangles) {
        overLimit('aggregate OBJ triangle limit exceeded', path);
      }
      faces++;
      triangles += addedTriangles;
      continue;
    }
    unsupported('unsupported OBJ directive ' + tokens[0], path);
  }
  if (vertices < 3 || faces < 1) unsupported('OBJ requires at least three vertices and one face', path);
  if (referencedVertices.size !== vertices) unsupported('OBJ contains unreferenced vertices', path);
  if (referencedNormals.size !== normals || referencedTexcoords.size !== texcoords) unsupported('OBJ contains unreferenced attributes', path);
  return {vertices, faces, triangles, normalCount: normals, texcoordCount: texcoords,
    ...(libraries.length || names.length ? {ignored_materials: Object.freeze({libraries: Object.freeze(libraries), names: Object.freeze(names)})} : {})};
}
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();
function readU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] * 0x1000000 + (bytes[offset + 1] << 16) +
    (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
}
function checkPngCrc(bytes: Uint8Array, typeStart: number, dataEnd: number, expected: number): boolean {
  let crc = 0xffffffff;
  for (let offset = typeStart; offset < dataEnd; offset++) {
    crc = crcTable[(crc ^ bytes[offset]) & 0xff] ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0) === expected;
}
interface PngParsed {
  readonly width: number;
  readonly height: number;
  readonly pixels: number;
  readonly row_bytes: number;
  readonly decoded_bytes: number;
  readonly chunk_count: number;
  readonly idat: readonly Uint8Array[];
}
function parsePng(bytes: Uint8Array, caps: CapturedLimits, remaining: RemainingAggregateCaps, path: string): PngParsed {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < signature.length) unsupported('truncated PNG signature', path);
  for (let index = 0; index < signature.length; index++) {
    if (bytes[index] !== signature[index]) unsupported('invalid PNG signature', path);
  }
  let offset = 8, chunks = 0, width = 0, height = 0, pixels = 0, rowBytes = 0;
  let hasHeader = false, hasData = false, hasEnd = false;
  const idat: Uint8Array[] = [];
  while (offset < bytes.length) {
    if (hasEnd) unsupported('trailing bytes after PNG IEND', path);
    if (bytes.length - offset < 12) unsupported('truncated PNG chunk', path);
    chunks++;
    if (chunks > caps.max_png_chunks) overLimit('PNG chunk count limit exceeded', path);
    const length = readU32(bytes, offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    if (length > bytes.length - offset - 12) unsupported('PNG chunk length exceeds input', path);
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    const chunkEnd = crcOffset + 4;
    let type = '';
    for (let index = 0; index < 4; index++) {
      const byte = bytes[typeStart + index];
      if (!((byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) {
        unsupported('invalid PNG chunk type', path);
      }
      type += String.fromCharCode(byte);
    }
    if (!checkPngCrc(bytes, typeStart, dataEnd, readU32(bytes, crcOffset))) {
      unsupported('PNG chunk CRC mismatch', path);
    }
    if (!hasHeader) {
      if (type !== 'IHDR' || chunks !== 1 || length !== 13) {
        unsupported('PNG must begin with one 13-byte IHDR', path);
      }
      width = readU32(bytes, dataStart);
      height = readU32(bytes, dataStart + 4);
      if (width === 0 || height === 0) unsupported('PNG dimensions must be positive', path);
      if (width > caps.max_png_width || height > caps.max_png_height) {
        overLimit('PNG dimension limit exceeded', path);
      }
      const bitDepth = bytes[dataStart + 8], colorType = bytes[dataStart + 9];
      const compression = bytes[dataStart + 10], filter = bytes[dataStart + 11], interlace = bytes[dataStart + 12];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || compression !== 0 || filter !== 0 || interlace !== 0) {
        unsupported('PNG supports only noninterlaced 8-bit RGB or RGBA', path);
      }
      if (width > Math.floor(caps.max_png_pixels / height)) overLimit('PNG pixel limit exceeded', path);
      pixels = width * height;
      rowBytes = width * (colorType === 6 ? 4 : 3) + 1;
      if (!Number.isSafeInteger(rowBytes) ||
          rowBytes > Math.floor(caps.max_png_decoded_bytes / height)) {
        overLimit('PNG decoded-byte limit exceeded', path);
      }
      hasHeader = true;
    } else if (type === 'IDAT') {
      hasData = true;
      idat.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      if (!hasData || length !== 0) unsupported('PNG IEND requires data and zero length', path);
      hasEnd = true;
    } else {
      unsupported('unsupported PNG chunk ' + type, path);
    }
    offset = chunkEnd;
  }
  if (!hasHeader || !hasData || !hasEnd) unsupported('incomplete PNG chunk sequence', path);
  if (offset !== bytes.length) unsupported('trailing PNG data', path);
  const decodedBytes = rowBytes * height;
  if (!Number.isSafeInteger(decodedBytes)) overLimit('PNG decoded-byte size is unsafe', path);
  if (decodedBytes > caps.max_png_decoded_bytes) overLimit('PNG decoded-byte limit exceeded', path);
  if (decodedBytes > remaining.png_decoded_bytes) {
    overLimit('aggregate PNG decoded-byte limit exceeded', path);
  }
  return Object.freeze({width, height, pixels, row_bytes: rowBytes,
    decoded_bytes: decodedBytes, chunk_count: chunks, idat: Object.freeze(idat)});
}
async function validatePngData(png: PngParsed, path: string): Promise<void> {
  if (typeof globalThis.DecompressionStream !== 'function' || typeof globalThis.ReadableStream !== 'function') {
    unsupported('validated streaming deflate decoder unavailable', path);
  }
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let outputBytes = 0, rowPosition = 0;
  try {
    const compressed = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of png.idat) controller.enqueue(chunk);
        controller.close();
      },
    });
    const decoder = new DecompressionStream('deflate') as unknown as TransformStream<Uint8Array, Uint8Array>;
    const inflated = compressed.pipeThrough(decoder);
    reader = inflated.getReader();
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const chunk = item.value;
      if (!(chunk instanceof Uint8Array)) unsupported('deflate decoder returned invalid bytes', path);
      if (chunk.byteLength > png.decoded_bytes - outputBytes) {
        unsupported('PNG decompressed output exceeds exact expected bytes', path);
      }
      for (const value of chunk) {
        if (rowPosition === 0 && value > 4) unsupported('invalid PNG row filter', path);
        rowPosition++;
        if (rowPosition === png.row_bytes) rowPosition = 0;
      }
      outputBytes += chunk.byteLength;
    }
    if (outputBytes !== png.decoded_bytes || rowPosition !== 0) {
      unsupported('PNG zlib output length does not match scanlines', path);
    }
  } catch (error) {
    if (reader) {
      try { await reader.cancel(error); } catch {}
    }
    if (error instanceof AssetProfileError) throw error;
    unsupported('invalid, truncated, or trailing PNG zlib stream', path);
  } finally {
    if (reader) reader.releaseLock();
  }
}
async function validateOne(
  file: FileSnapshot, caps: CapturedLimits, remaining: RemainingAggregateCaps,
): Promise<{facts: ModelAssetFacts; normals: number; texcoords: number}> {
  const bytes = await readOwnedBytes(file);
  if (file.kind === 'obj') {
    const {normalCount, texcoordCount, ...facts} = parseObj(bytes, caps, remaining, file.path);
    return {facts: Object.freeze({path: file.path, kind: 'obj', bytes: file.bytes, sha256: file.sha256, ...facts}),
      normals: normalCount, texcoords: texcoordCount};
  }
  if(file.kind==='stl') {
    const maxTriangles=Math.min(caps.max_obj_faces,caps.max_obj_triangles,Math.floor(caps.max_obj_vertices/3),remaining.obj_triangles,Math.floor(remaining.obj_vertices/3),remaining.obj_normals);
    if(maxTriangles<1)overLimit('aggregate STL geometry limit exceeded',file.path);
    let stl:ReturnType<typeof inspectBinaryStl>;try{stl=inspectBinaryStl(bytes,{maxBytes:caps.max_obj_bytes,maxTriangles,maxAbsCoordinate:caps.max_obj_abs_coordinate});}catch(error){if(error instanceof BinaryStlError&&error.code==='limit')overLimit('STL geometry limit exceeded',file.path);unsupported('invalid binary STL',file.path);}
    return {facts:Object.freeze({path:file.path,kind:'stl',bytes:file.bytes,sha256:file.sha256,vertices:stl.triangles*3,faces:stl.triangles,triangles:stl.triangles}),normals:stl.triangles,texcoords:0};
  }
  const png = parsePng(bytes, caps, remaining, file.path);
  await validatePngData(png, file.path);
  return {facts: Object.freeze({path: file.path, kind: 'png', bytes: file.bytes, sha256: file.sha256,
    width: png.width, height: png.height, pixels: png.pixels,
    decoded_bytes: png.decoded_bytes, chunks: png.chunk_count}), normals: 0, texcoords: 0};
}

/** Validate an accepted closure's selected OBJ/PNG bytes; returns facts, not compile authority. */
export async function validateModelAssets(
  closure: Readonly<MjcfClosure>,
  limits: Readonly<ModelAssetProfileLimits>,
): Promise<Readonly<ModelAssetsProfileSummary>> {
  try {
    // Capture every limit and all referenced closure metadata before the first await.
    const caps = captureLimits(limits);
    const snapshot = captureClosure(closure, caps);
    // Process one asset at a time. The same host caps also bound aggregate
    // decoded geometry across the complete selected closure, not each file
    // independently. This keeps peak parser/decode work from scaling with the
    // number of simultaneously validated assets.
    const assets: ModelAssetFacts[] = [];
    let totalObjVertices = 0;
    let totalObjNormals = 0, totalObjTexcoords = 0;
    let totalObjTriangles = 0;
    let totalPngDecodedBytes = 0;
    for (const file of snapshot.assets) {
      const remaining = Object.freeze({
        obj_vertices: caps.max_obj_vertices - totalObjVertices,
        obj_normals: caps.max_obj_vertices - totalObjNormals,
        obj_texcoords: caps.max_obj_vertices - totalObjTexcoords,
        obj_triangles: caps.max_obj_triangles - totalObjTriangles,
        png_decoded_bytes: caps.max_png_decoded_bytes - totalPngDecodedBytes,
      });
      const checked = await validateOne(file, caps, remaining), facts = checked.facts;
      if (facts.kind === 'obj' || facts.kind === 'stl') {
        totalObjVertices += facts.vertices;
        totalObjNormals += checked.normals;
        totalObjTexcoords += checked.texcoords;
        totalObjTriangles += facts.triangles;
      } else {
        totalPngDecodedBytes += facts.decoded_bytes;
      }
      assets.push(facts);
    }
    return Object.freeze({project_revision: snapshot.project_revision, entry_path: snapshot.entry_path,
      assets: Object.freeze(assets)});
  } catch (error) {
    if (error instanceof AssetProfileError) throw error;
    unsupported('model asset validation failed');
  }
}
