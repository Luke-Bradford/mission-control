/**
 * The one place the old park and set-aside fields are filled: the web app still reads a run
 * loop's `parked` and `aside`, a crew loop's `parked` and a crew row's `asideRuns`, while the
 * server and core keep one `hold`. Applied to every API response; goes when the web reads `hold`.
 * Nothing here is stored: it copies what it changes.
 */

import type { CrewHold, RunHold } from "@mc/core";

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** @deprecated The run loop's old `parked`, from its hold. */
export const oldParked = (hold: RunHold | null | undefined) =>
  hold?.kind != null ? { kind: hold.kind, reason: hold.reason ?? "", ended: hold.ended } : null;

/** @deprecated The run loop's old `aside`, from its hold. */
export const oldAside = (hold: RunHold | null | undefined) =>
  hold?.worktree
    ? {
        worktree: hold.worktree,
        wake: hold.wake,
        ...(hold.ask !== undefined ? { ask: hold.ask } : {}),
      }
    : null;

/** @deprecated Copies `value` with the old fields filled from `hold`, at any depth. */
export function withLegacyHoldFields<T>(value: T): T {
  return fill(value) as T;
}

function fill(value: unknown): unknown {
  if (Array.isArray(value)) {
    let out: unknown[] | null = null;
    value.forEach((item, i) => {
      const next = fill(item);
      if (next === item) return;
      out ??= value.slice();
      out[i] = next;
    });
    return out ?? value;
  }
  if (!isObject(value)) return value;
  let out: Json | null = null;
  for (const [key, item] of Object.entries(value)) {
    const next = fill(item);
    if (next === item) continue;
    out ??= { ...value };
    out[key] = next;
  }
  const obj = out ?? value;
  if (!("hold" in obj) || typeof obj.phase !== "string") {
    return "offSeatRuns" in obj && Array.isArray(obj.offSeatRuns) && !("asideRuns" in obj)
      ? { ...obj, asideRuns: obj.offSeatRuns }
      : obj;
  }
  if ("epoch" in obj) {
    // a run loop
    const hold = (obj.hold ?? null) as RunHold | null;
    return { ...obj, parked: oldParked(hold), aside: oldAside(hold) };
  }
  if ("text" in obj) {
    // a crew loop
    const hold = (obj.hold ?? null) as CrewHold | null;
    return { ...obj, parked: obj.phase === "parked" ? (hold?.reason ?? null) : null };
  }
  return obj;
}
