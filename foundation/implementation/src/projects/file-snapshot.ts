import {safeProjectPath} from './project-path.ts';

export interface ExpectedFile { readonly bytes: number; readonly sha256: string; }
export interface OwnedProjectFile {
  readonly path: string; readonly bytes: number; readonly sha256: string; readonly content: Blob;
}

/** Capture selected bytes, not a folder or an admitted project. The trusted host
 * owns acquisition/aggregate limits; this boundary owns only one exact file. */
export async function snapshotProjectFile(
  path: unknown, data: Uint8Array, max_bytes: number, expected?: ExpectedFile,
): Promise<Readonly<OwnedProjectFile>> {
  const canonical = safeProjectPath(path);
  try {
    if (!Number.isSafeInteger(max_bytes) || max_bytes < 0) throw new Error('Invalid byte budget');
    if (!(data instanceof Uint8Array) || !ArrayBuffer.isView(data)) throw new Error('Expected a native Uint8Array');
    // Borrow native getters so a subclass property cannot substitute its buffer
    // or length. Proxy and prototype-spoofed objects have no typed-array slots.
    const prototype = Object.getPrototypeOf(Uint8Array.prototype);
    if (Reflect.get(prototype, Symbol.toStringTag, data) !== 'Uint8Array') throw new Error('Unsupported native array element kind');
    const buffer = Reflect.get(prototype, 'buffer', data);
    const bytes: number = Reflect.get(prototype, 'byteLength', data);
    if (!(buffer instanceof ArrayBuffer)) throw new Error('Expected an ordinary same-realm ArrayBuffer');
    // Prototype identity alone cannot distinguish a relabeled SharedArrayBuffer.
    Reflect.get(ArrayBuffer.prototype, 'byteLength', buffer);
    if (bytes > max_bytes) throw new Error(`Actual size ${bytes} exceeds byte budget ${max_bytes}`);
    let expectedBytes: number | undefined, expectedHash: string | undefined;
    if (expected !== undefined) {
      if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('Invalid expected file record');
      expectedBytes = expected.bytes;
      expectedHash = expected.sha256;
      if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new Error('Invalid expected byte count');
      if (typeof expectedHash !== 'string' || expectedHash.length !== 64 || !/^[0-9a-f]{64}$/.test(expectedHash)) {
        throw new Error('Expected SHA-256 must be 64 lowercase hexadecimal characters');
      }
      if (expectedBytes !== bytes) throw new Error(`Size mismatch: expected ${expectedBytes}, received ${bytes}`);
    }
    // Typed-array construction copies internal bytes, respects the source view,
    // ignores subclass iterators/species, and rejects detached/out-of-bounds views.
    const owned = new Uint8Array(data);
    const content = new Blob([owned]);
    if (!globalThis.crypto?.subtle || typeof globalThis.crypto.subtle.digest !== 'function') {
      throw new Error('Native WebCrypto SHA-256 is unavailable');
    }
    // Source bytes and expected assertions are captured before this first await.
    const digest = await globalThis.crypto.subtle.digest('SHA-256', owned);
    const sha256 = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
    if (expectedHash !== undefined && sha256 !== expectedHash) throw new Error('SHA-256 mismatch');
    return Object.freeze({path: canonical, bytes, sha256, content});
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 500) : 'File capture failed';
    throw new Error(`Project file ${canonical}: ${reason}`);
  }
}
