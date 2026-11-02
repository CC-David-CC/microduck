export class DataBudgetExceeded extends Error {}

/** Bounded inert host/Worker data, never a capability transport. */
export function copyBounded(value: unknown, limit: number): any {
  let remaining = limit;
  const ancestors = new Set<object>();
  function charge(n: number) { remaining -= n; if (remaining < 0) throw new DataBudgetExceeded('Reply budget exceeded'); }
  function walk(input: unknown, depth: number): any {
    if (depth > 64) throw new Error('Data depth exceeded');
    if (input === null) { charge(4); return null; }
    if (typeof input === 'boolean') { charge(input ? 4 : 5); return input; }
    if (typeof input === 'number') { if (!Number.isFinite(input)) throw new Error('Nonfinite data'); charge(JSON.stringify(input).length); return input; }
    if (typeof input === 'string') {
      if (input.length > remaining) throw new DataBudgetExceeded('Reply budget exceeded');
      charge(new TextEncoder().encode(JSON.stringify(input)).length); return input;
    }
    if (typeof input !== 'object') throw new Error('Non-data value');
    const proto = Object.getPrototypeOf(input), array = Array.isArray(input);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new Error('Non-data object');
    if (ancestors.has(input)) throw new Error('Cyclic data');
    const keys = Reflect.ownKeys(input);
    if (array) {
      const length = Object.getOwnPropertyDescriptor(input, 'length')?.value;
      if (!Number.isSafeInteger(length) || keys.length !== length + 1 ||
          keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length))) throw new Error('Invalid array');
    }
    ancestors.add(input); charge(2);
    try {
      const out: any = array ? [] : {};
      let first = true;
      for (const key of keys) {
        if (typeof key !== 'string') throw new Error('Invalid key');
        if (array && key === 'length') continue;
        const field = Object.getOwnPropertyDescriptor(input, key);
        if (!field || !Object.hasOwn(field, 'value') || !field.enumerable) throw new Error('Accessor or hidden property');
        if (!first) charge(1); first = false;
        if (!array) {
          if (key.length > remaining) throw new DataBudgetExceeded('Reply budget exceeded');
          charge(new TextEncoder().encode(JSON.stringify(key)).length + 1);
        }
        Object.defineProperty(out, key, {value: walk(field.value, depth + 1), enumerable: true, configurable: true, writable: true});
      }
      return out;
    } finally { ancestors.delete(input); }
  }
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid data budget');
  return walk(value, 0);
}

/** Compare already-owned, acyclic data without erasing numeric signed zero. */
export function sameBoundedData(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && a.length !== b.length) return false;
  const keys = Object.keys(a), other = Object.keys(b);
  return keys.length === other.length && keys.every(key => Object.hasOwn(b, key) && sameBoundedData(a[key], b[key]));
}
