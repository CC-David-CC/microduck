const forbidden = /[\u0000-\u001f\u007f\\:*?"<>|]/;
const reserved = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/;

/** Validate lexical identity only. Inventory, filesystem and resource confinement
 * are separate pipeline obligations. Accepted names are never rewritten. */
export function safeProjectPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('path must be a nonempty string');
  let length = 0;
  for (const character of value) {
    const point = character.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) throw new Error('unpaired surrogate in path');
    if (++length > 240) throw new Error('path exceeds 240 Unicode code points');
  }
  if (value.normalize('NFC') !== value) throw new Error('path must already be NFC');
  if (forbidden.test(value)) throw new Error('forbidden path character');
  for (const segment of value.split('/')) {
    if (!segment || segment === '.' || segment === '..') throw new Error('path must be canonical relative POSIX');
    if (segment.endsWith(' ') || segment.endsWith('.')) throw new Error('trailing segment space or dot');
    const basename = segment.split('.')[0].replace(/[A-Z]/g, character => character.toLowerCase());
    if (reserved.test(basename)) throw new Error('reserved path basename');
  }
  return value;
}

/** The host supplies an owned/copied same-realm byte view; this is not an atomic
 * snapshot of concurrently writable shared memory. BOM is a literal name character. */
export function decodeProjectPath(bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('path bytes must be a Uint8Array');
  if (bytes.byteLength > 960) throw new Error('path exceeds 960 UTF-8 bytes');
  const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  return safeProjectPath(value);
}
