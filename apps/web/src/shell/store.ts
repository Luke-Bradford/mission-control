/** A one-value store for module-level UI state, read with useSyncExternalStore. */
import { useSyncExternalStore } from "react";

export interface Store<T> {
  get(): T;
  set(next: T): void;
  subscribe(fn: () => void): () => void;
}

export function store<T>(initial: T): Store<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const fn of [...listeners]) fn();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export const useStore = <T>(s: Store<T>): T => useSyncExternalStore(s.subscribe, s.get);
