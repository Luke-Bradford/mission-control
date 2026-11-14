/** The value, or a thrown error naming what was missing: a test's checked stand-in for `value!`. */
export function defined<T>(value: T | null | undefined, what = "value"): T {
  if (value == null) throw new Error(`Test expected ${what} to exist`);
  return value;
}
