/**
 * Long-lived hub maps and sets that gain keys over time keep at most `max`, oldest first out
 * (a Map or Set iterates in insertion order), so a hub left running for weeks does not grow.
 */
export function setBounded<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

export function addBounded<T>(set: Set<T>, value: T, max: number): void {
  set.delete(value);
  set.add(value);
  while (set.size > max) {
    const oldest = set.values().next();
    if (oldest.done) break;
    set.delete(oldest.value);
  }
}
