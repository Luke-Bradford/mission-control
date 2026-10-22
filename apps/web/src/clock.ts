/** The shared clocks (1 s and 5 s) and the operator's timezone. */
import type { ConfigView } from "@mc/core";
import { useSyncExternalStore } from "react";
import { RESOURCES, useResource } from "./data.ts";

/**
 * A shared clock ticking every `ms`: one timer however many components read it, running only
 * while something does.
 */
function ticker(ms: number): () => number {
  const listeners = new Set<() => void>();
  let value = Date.now();
  let timer: ReturnType<typeof setInterval> | undefined;
  const subscribe = (fn: () => void): (() => void) => {
    listeners.add(fn);
    if (!timer) {
      value = Date.now(); // useSyncExternalStore re-reads the snapshot after subscribing
      timer = setInterval(() => {
        value = Date.now();
        for (const l of [...listeners]) l();
      }, ms);
    }
    return () => {
      listeners.delete(fn);
      if (listeners.size === 0) {
        clearInterval(timer);
        timer = undefined;
      }
    };
  };
  const get = () => value;
  return () => useSyncExternalStore(subscribe, get);
}

/** Every second: the MET clock and every `m:ss` timer. */
export const useSecond: () => number = ticker(1000);

/** Every 5 s: relative times ("25 min ago") and state ages such as a stall. */
export const useNow: () => number = ticker(5000);

/**
 * `config.operator.timezone`, the zone of every day boundary and clock time on the HUD; null while
 * the config loads, when components show `—` instead of calling a formatter (the doing line shows
 * its text without the time).
 */
export function useTz(): string | null {
  return useResource<ConfigView>(RESOURCES.config).data?.operator.timezone ?? null;
}
