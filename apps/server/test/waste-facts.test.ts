import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequestView, Run, RunLoop } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { flightState } from "../src/flight/state.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

let dir: string;
let store: Store;

const config = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/w",
    maxSeats: 4,
    sessions: [
      {
        id: "s",
        repoId: "mc",
        checkout: "/c",
        seats: [
          { id: "flight-1", role: "FLIGHT", accountId: "claude-main", area: [] },
          { id: "guido-1", role: "GUIDO", accountId: "claude-main", area: ["apps/server/**"] },
        ],
      },
    ],
  },
} as unknown as CcConfig;
const session = config.crew?.sessions[0];
if (session === undefined) throw new Error("no session");

const pr = (number: number, state: "open" | "merged" = "open"): PullRequestView => ({
  repoId: "mc",
  number,
  title: `PR ${number}`,
  url: "u",
  branch: `feature/${number}`,
  ticket: `mc#${number}`,
  state,
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: NOW - 5 * HOUR,
  updatedAt: NOW,
  mergedAt: state === "merged" ? NOW : null,
  headSha: "h",
  mergeable: null,
});

const author = (id = "r1"): Run => ({
  id,
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 5 * HOUR,
  endedAt: null,
  status: "ok",
  sessionId: "cli",
  model: "m",
  branch: "feature/7",
  ticket: "mc#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
});

/** A review of PR `number` that reported, failing (blocking findings) or passing. */
const reported = (runId: string, number: number, round: number, blocking: number) => {
  const id = store.requestReview({
    authorRunId: runId,
    repoId: "mc",
    seatId: "retro-1",
    prNumber: number,
    sha: `sha${round}`,
    epoch: 1,
    attempt: 1,
    round,
    at: NOW - 4 * HOUR + round * MIN,
  });
  if (id === null) throw new Error("review not recorded");
  const db = (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): void } } })
    .db;
  db.prepare("UPDATE reviews SET state = 'reported', blocking = ?, ended_at = ? WHERE id = ?").run(
    blocking,
    NOW - 3 * HOUR + round * MIN,
    id,
  );
};

const _awaiting = (): RunLoop =>
  ({ phase: "review", awaitingFlight: "sha1", prNumber: 7 }) as unknown as RunLoop;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-waste-facts-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("failed review rounds", () => {
  it("puts the count of failed rounds on the PR in FLIGHT's state", () => {
    store.upsertPullRequests("mc", [pr(7)], NOW);
    store.upsertRun(author());
    reported("r1", 7, 1, 2);
    reported("r1", 7, 2, 1);
    const state = flightState({ config, store, busy: [], now: NOW });
    expect(state.prs.find((p) => p.pr === 7)?.reviewRounds).toBe(2);
  });
});
