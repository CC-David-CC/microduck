export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject { readonly [key: string]: JsonValue; }
export interface ManifestJsonLimits { readonly max_bytes: number; readonly max_depth: number; }
export interface NumberSpan { readonly start: number; readonly end: number; }
export interface ManifestJsonDocument {
  readonly source: string;
  readonly data: JsonObject;
  numberSpan(path: readonly (string | number)[]): NumberSpan | undefined;
}

/** Read inert JSON from P02's immutable Blob. This is not manifest admission,
 * inventory integrity, origin isolation, or a hard resident-memory quota. */
export async function readManifestJson(
  content: Blob, limits: ManifestJsonLimits,
): Promise<Readonly<ManifestJsonDocument>> {
  try {
    if (!limits || typeof limits !== 'object' || Array.isArray(limits)) throw new Error('Expected host limits');
    const { max_bytes, max_depth } = limits;
    if (!Number.isSafeInteger(max_bytes) || max_bytes < 0) throw new Error('Invalid byte budget');
    if (!Number.isSafeInteger(max_depth) || max_depth < 1 || max_depth > 64) throw new Error('Invalid depth budget');
    // Conventional realm check plus native brand, not allocation-realm authentication.
    if (!(content instanceof Blob)) throw new Error('Expected a native Blob');
    const nativeSize = Object.getOwnPropertyDescriptor(Blob.prototype, 'size')!.get!;
    const nativeRead = Blob.prototype.arrayBuffer;
    const clone = globalThis.structuredClone;
    const size: number = nativeSize.call(content);
    if (size > max_bytes) throw new Error('Manifest exceeds byte budget');
    if (typeof clone !== 'function') throw new Error('Native Blob cloning is unavailable');
    // Node Blob methods accept transparent proxies; native cloning rejects them.
    const owned = clone.call(globalThis, content);
    if (!(owned instanceof Blob) || nativeSize.call(owned) !== size) throw new Error('Blob clone size/brand mismatch');
    const bytes = await nativeRead.call(owned);
    if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== size) throw new Error('Blob read size/type mismatch');
    const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    const spans = new WeakMap<object, Map<string | number, NumberSpan>>();
    const numeric = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    const literals = [['true', true], ['false', false], ['null', null]] as const;
    let position = 0;

    function fail(reason: string): never {
      throw new Error(`${reason} at UTF-16 offset ${position}`);
    }
    function space(): void {
      while (position < source.length && /[ \t\r\n]/.test(source[position])) position++;
    }
    function string(): string {
      const start = position++;
      while (position < source.length) {
        const character = source[position++];
        if (character === '\\') {
          position++;
          continue;
        }
        if (character === '"') {
          let value: string;
          try { value = JSON.parse(source.slice(start, position)); }
          catch { fail('Invalid JSON string'); }
          for (const scalar of value) {
            const point = scalar.codePointAt(0)!;
            if (point >= 0xd800 && point <= 0xdfff) fail('Unpaired surrogate in string');
          }
          return value;
        }
        if (character.charCodeAt(0) < 32) fail('Unescaped control in string');
      }
      return fail('Unterminated JSON string');
    }
    function parse(depth: number, parent?: object, key?: string | number): JsonValue {
      space();
      const start = position, character = source[position];
      if (character === '{' || character === '[') {
        if (depth >= max_depth) fail('JSON depth budget exceeded');
        const array = character === '[';
        const container: JsonValue[] | Record<string, JsonValue> = array ? [] : Object.create(null);
        const closing = array ? ']' : '}';
        position++;
        space();
        if (source[position] === closing) {
          position++;
          return Object.freeze(container);
        }
        while (true) {
          space();
          let member: string | number;
          if (array) member = (container as JsonValue[]).length;
          else {
            if (source[position] !== '"') fail('Expected object key');
            member = string();
            if (Object.hasOwn(container, member)) fail('Duplicate decoded object key');
            space();
            if (source[position] !== ':') fail('Expected colon');
            position++;
          }
          const child = parse(depth + 1, container, member);
          if (array) (container as JsonValue[]).push(child);
          else (container as Record<string, JsonValue>)[member] = child;
          space();
          const separator = source[position++];
          if (separator === closing) return Object.freeze(container);
          if (separator !== ',') fail('Expected comma or closing delimiter');
        }
      }
      if (character === '"') return string();
      for (const [token, value] of literals) {
        if (source.startsWith(token, position)) {
          position += token.length;
          return value;
        }
      }
      numeric.lastIndex = position;
      const match = numeric.exec(source);
      if (!match) return fail('Expected JSON value');
      const token = match[0], value = Number(token);
      position = numeric.lastIndex;
      // Unsafe plain integer tokens also produce unsafe integers or infinity.
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
        fail('Nonfinite or unsafe integer number');
      }
      if (value === 0 && /[1-9]/.test(token.split(/[eE]/, 1)[0])) fail('Nonzero number underflow');
      if (parent && key !== undefined) {
        let members = spans.get(parent);
        if (!members) spans.set(parent, members = new Map());
        members.set(key, { start, end: position });
      }
      return value;
    }

    space();
    if (source[position] !== '{') fail('Expected object root');
    const data = parse(0) as JsonObject;
    space();
    if (position !== source.length) fail('Unexpected trailing content');
    function numberSpan(path: readonly (string | number)[]): NumberSpan | undefined {
      if (!Array.isArray(path)) throw new Error('Expected a span path array');
      // Capture indexed values once; a caller iterator cannot define another path.
      const length = path.length, segments: (string | number)[] = [];
      for (let index = 0; index < length; index++) {
        const part = path[index];
        if (typeof part !== 'string' && !(typeof part === 'number' && Number.isSafeInteger(part) && part >= 0)) {
          throw new Error('Invalid span path segment');
        }
        segments.push(part);
      }
      let value: JsonValue = data;
      for (let index = 0; index < segments.length; index++) {
        if (value === null || typeof value !== 'object') return undefined;
        const part = segments[index], array = Array.isArray(value);
        if (typeof part !== (array ? 'number' : 'string') || !Object.hasOwn(value, part)) return undefined;
        if (index === segments.length - 1) {
          const span = spans.get(value)?.get(part);
          return span ? { ...span } : undefined;
        }
        value = array ? (value as readonly JsonValue[])[part as number] : (value as JsonObject)[part as string];
      }
      return undefined;
    }
    return Object.freeze({ source, data, numberSpan });
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'Manifest JSON read failed';
    throw new Error(`Manifest JSON: ${reason}`.slice(0, 500));
  }
}
