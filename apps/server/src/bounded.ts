/**
 * Long-lived hub maps and sets that gain keys over time hold at most `max`: the oldest key goes
 * first (a Map or Set iterates in insertion order), and setting a key again makes it the newest.
 * The cap is part of the collection's type, so a call site cannot drop it by accident.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  readonly max: number;
  constructor(max: number) {
    super();
    this.max = max;
  }
  override set(key: K, value: V): this {
    this.delete(key);
    super.set(key, value);
    while (this.size > this.max) {
      const oldest = this.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    return this;
  }
}

export class BoundedSet<T> extends Set<T> {
  readonly max: number;
  constructor(max: number) {
    super();
    this.max = max;
  }
  override add(value: T): this {
    this.delete(value);
    super.add(value);
    while (this.size > this.max) {
      const oldest = this.values().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    return this;
  }
}
