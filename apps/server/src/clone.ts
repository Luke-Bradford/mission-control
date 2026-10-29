/**
 * A deep copy of plain data (objects, arrays, Maps, primitives), several times faster than
 * `structuredClone`, which matters when a memoised answer is copied per caller. Anything else
 * (a Set, a Date, a typed array) goes to `structuredClone`.
 */
export function cloneData<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = cloneData(value[i]);
    return out as T;
  }
  if (value instanceof Map) {
    const out = new Map();
    for (const [k, v] of value) out.set(k, cloneData(v));
    return out as T;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return structuredClone(value);
  const out: Record<string, unknown> = proto === null ? Object.create(null) : {};
  for (const k of Object.keys(value)) out[k] = cloneData((value as Record<string, unknown>)[k]);
  return out as T;
}
