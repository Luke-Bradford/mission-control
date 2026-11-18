/** A small seeded generator (mulberry32): the same seed always gives the same run of numbers. */
export type Random = () => number;

export function seeded(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One of `items`, chosen by `rand`. */
export const pick = <T>(rand: Random, items: readonly T[]): T =>
  items[Math.min(items.length - 1, Math.floor(rand() * items.length))] as T;

/** The scene's seed the address names (`?seed=7`); 1 when it names none or something else. */
export function seedFromSearch(search: string): number {
  const value = new URLSearchParams(search).get("seed");
  return value !== null && /^\d{1,9}$/.test(value) ? Number(value) : 1;
}
