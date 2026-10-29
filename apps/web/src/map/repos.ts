import type { ConfigView, Crew, RepoView } from "@mc/core";

/** One entry in the Map's repo picker: only a repo with a crew session can be mapped. */
export interface MapRepoOption {
  id: string;
  /** Crew seats on this repo, FLIGHT not counted. */
  seats: number;
  mapped: boolean;
  label: string;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const pickRepo = (
  ids: string[],
  running: { repoId: string; started: number }[],
  last: string,
): string => {
  const ranked = ids.map((id) => ({ id, rows: running.filter((row) => row.repoId === id) }));
  ranked.sort(
    (left, right) =>
      right.rows.length - left.rows.length ||
      Math.max(0, ...right.rows.map((row) => row.started)) -
        Math.max(0, ...left.rows.map((row) => row.started)),
  );
  return ranked[0]?.rows.length ? ranked[0].id : ids.includes(last) ? last : (ids[0] ?? "");
};

/**
 * Every configured repo, in config order. The hub maps a repo from its crew session's checkout, so
 * a repo watched only by an observed loop, or with no session at all, is listed but not selectable.
 */
export function mapRepoOptions(
  repos: RepoView[],
  config: ConfigView | undefined,
  crew: Crew | undefined,
): MapRepoOption[] {
  return repos.map((repo) => {
    const sessions = config?.crew?.sessions.filter((s) => s.repoId === repo.id) ?? [];
    const rows = crew?.rows.filter(
      (r) => r.kind === "crew" && r.role !== "FLIGHT" && r.repoId === repo.id,
    );
    const seats =
      rows?.length ??
      sessions.reduce(
        (n, s) => n + s.seats.filter((seat) => !seat.retiring && seat.loop !== "watch").length,
        0,
      );
    const mapped = sessions.length > 0;
    const observed = config?.loops.some((l) => l.repoId === repo.id) ?? false;
    const label = mapped
      ? `${repo.id} · ${plural(seats, "crew seat")}`
      : `${repo.id} · ${observed ? "observed loop, not mapped yet" : "no crew session"}`;
    return { id: repo.id, seats, mapped, label };
  });
}

/**
 * Where `/map` goes: the selected session's repo when it is mapped; else the mapped repo with the
 * most running crew seats (the latest start breaking ties), the last one picked, or the first.
 */
export function defaultMapRepo(
  options: MapRepoOption[],
  crew: Crew | undefined,
  sessionRepo: string,
  last: string,
): string | null {
  const ids = options.filter((o) => o.mapped).map((o) => o.id);
  if (ids.includes(sessionRepo)) return sessionRepo;
  const running = (crew?.rows ?? [])
    .filter((r) => r.kind === "crew" && r.role !== "FLIGHT" && r.hudState === "running")
    .map((r) => ({ repoId: r.repoId, started: r.run?.startedAt ?? r.stateSince }));
  return pickRepo(ids, running, last) || null;
}
