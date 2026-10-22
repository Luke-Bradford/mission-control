import type { AgentState, RepoId, Run, TokenUsage } from "./types.ts";

/** Total tokens of a run: all four kinds (a run without counts is 0). */
export const tokenTotal = (t: TokenUsage | null): number =>
  t ? t.input + t.output + t.cacheRead + t.cacheCreate : 0;

/** Cache hit %: cacheRead ÷ (input + cacheRead + cacheCreate); null when that sum is 0. */
export const cacheHitPct = (t: Pick<TokenUsage, "input" | "cacheRead" | "cacheCreate">) => {
  const denom = t.input + t.cacheRead + t.cacheCreate;
  return denom === 0 ? null : (t.cacheRead / denom) * 100;
};

/** `20261019T120000Z`: an instant in UTC to the second, as text that sorts by time. */
export const compactUtc = (ms: number): string =>
  new Date(ms)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");

// feature/3822-x, fix/3349-x, feat/studio-1745-x, fix/loop-812-x
const BRANCH_TICKET = /^(?:fix|feature|feat|docs|chore)\/(?:studio-|loop-)?(\d+)(?:-|$)/;
const NO_RUNS_SINCE = 0;

export function inferTicket(branch: string | null, repoId: RepoId): string | null {
  if (branch === null) return null;
  const m = BRANCH_TICKET.exec(branch);
  return m ? `${repoId}#${m[1]}` : null;
}

function latestByStart(runs: Run[]): Run | undefined {
  let best: Run | undefined;
  for (const r of runs) if (!best || r.startedAt > best.startedAt) best = r;
  return best;
}

// 'waiting-agent' is not produced in Plan 1: the adopted loops have no parked runs yet.
export function agentState(input: {
  runs: Run[];
  paused: boolean;
  sourceError: string | null;
  waitingOnOperator: boolean;
}): { state: AgentState; since: number } {
  const latest = latestByStart(input.runs);
  const latestSince = latest ? (latest.endedAt ?? latest.startedAt) : NO_RUNS_SINCE;

  if (input.sourceError !== null) return { state: "error", since: latestSince };

  const running = latestByStart(input.runs.filter((r) => r.status === "running"));
  if (running) return { state: "working", since: running.startedAt };

  if (latest?.status === "blocked" || input.waitingOnOperator) {
    return { state: "waiting-you", since: latestSince };
  }
  return { state: "idle", since: latestSince };
}
