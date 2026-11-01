import type { MapSnapshot } from "@mc/core";

/** Preserve each unchanged input across a refetch so a live overlay never rebuilds the tree/graph. */
export function shareMap(previous: MapSnapshot | undefined, next: MapSnapshot): MapSnapshot {
  if (!previous || previous.repoId !== next.repoId) return next;
  const out = { ...next };
  for (const key of [
    "tree",
    "rules",
    "imports",
    "hist",
    "seats",
    "findings",
    "conflicts",
    "conflictsUnchecked",
  ] as const) {
    if (
      previous[key] === next[key] ||
      JSON.stringify(previous[key]) === JSON.stringify(next[key])
    ) {
      // Each selected property is copied to the same property, retaining its concrete type.
      Object.assign(out, { [key]: previous[key] });
    }
  }
  return Object.keys(out).every(
    (key) => out[key as keyof MapSnapshot] === previous[key as keyof MapSnapshot],
  )
    ? previous
    : out;
}
