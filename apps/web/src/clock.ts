/** The shared clocks (1 s and 5 s) and the operator's timezone. */
import type { ConfigView } from "@mc/core";
import { useSyncExternalStore } from "react";
import { RESOURCES, useResource } from "./data.ts";

/**
 * A shared clock ticking every `ms`: one timer however many components read it, running only
 * while something does.
 */
function ticker(ms: number) {
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
  return { subscribe, get };
}

const second = ticker(1000);
const fiveSeconds = ticker(5000);

/** Every second: the MET clock and every `m:ss` timer. */
export const useSecond: () => number = () => useSyncExternalStore(second.subscribe, second.get);

/** Every 5 s: relative times ("25 min ago") and state ages such as a stall. */
export const useNow: () => number = () =>
  useSyncExternalStore(fiveSeconds.subscribe, fiveSeconds.get);

const unsubscribed = () => () => {};

/**
 * The second clock while `ticking`, else `coarse` unchanged: a component that shows seconds only
 * some of the time (a row with a live timer) renders every second only then.
 */
export function useSecondWhile(ticking: boolean, coarse: number): number {
  return useSyncExternalStore(
    ticking ? second.subscribe : unsubscribed,
    ticking ? second.get : () => coarse,
  );
}

/**
 * `config.operator.timezone`, the zone of every day boundary and clock time on the HUD; null while
 * the config loads, when components show `—` instead of calling a formatter (the doing line shows
 * its text without the time).
 */
export function useTz(): string | null {
  return useResource<ConfigView>(RESOURCES.config).data?.operator?.timezone ?? null;
}
