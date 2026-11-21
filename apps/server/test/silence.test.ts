import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardItem, PullRequestView, Run, SilenceWatchedEventKind } from "@mc/core";
import { SILENCE_WATCHED_EVENTS } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeCrewPause } from "../src/config/crew-pause.ts";
import type { CcConfig } from "../src/config.ts";
import { recordingShotSaves, runSilenceCheck } from "../src/engine/silence.ts";
import { Store } from "../src/store.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 8, 12);

let store: Store;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-silence-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const config = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [
    { id: "a1", vendor: "claude", alertAt: 80, stopAt: 95 },
    { id: "a2", vendor: "claude", alertAt: 80, stopAt: 95 },
  ],
  repos: [{ id: "repo", github: "o/r", project: 1, statusMap: {}, autonomy: "merge" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/w",
    maxSeats: 8,
    sessions: [
      {
        id: "s",
        repoId: "repo",
        checkout: "/c",
        seats: [
          { id: "guido-1", role: "GUIDO", accountId: "a1", model: "opus", area: ["x"] },
          { id: "inco-1", role: "INCO", accountId: "a2", model: "opus", area: ["y"] },
          { id: "flight-1", role: "FLIGHT", accountId: "a1", model: "opus", area: [] },
        ],
      },
    ],
  },
} as unknown as CcConfig;

const gap = (kind: SilenceWatchedEventKind) => {
  const e = SILENCE_WATCHED_EVENTS.find((x) => x.kind === kind);
  if (e === undefined) throw new Error(kind);
  return e.gapMs;
};
const run = (over: Partial<Run>): Run => ({
  id: "r1",
  agentId: "guido-1",
  repoId: "repo",
  seq: 1,
  startedAt: NOW - HOUR,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: "opus",
  branch: null,
  ticket: "repo#7",
  costUsd: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
  transcriptPath: "/x.jsonl",
  prs: [],
  summary: null,
  ...over,
});
const card = (over: Partial<BoardItem> = {}): BoardItem => ({
  repoId: "repo",
  issueNumber: 7,
  title: "Ready work",
  status: "Ready",
  state: "planned",
  labels: ["area:server"],
  assignees: [],
  priority: null,
  updatedAt: NOW,
  url: "u",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: "S",
  closed: false,
  prioritySource: null,
  createdAt: NOW - HOUR,
  itemId: "I7",
  projectId: "P1",
  ...over,
});
const seat = (r: Run) => {
  store.upsertRun(r);
  store.setSeatSession({
    seatId: r.agentId,
    runId: r.id,
    cliSessionId: "c",
    state: "running",
    reason: null,
    worktree: null,
    updatedAt: NOW,
  });
};
const budgetPark = { hold: { kind: "budget", reason: "limit", ended: false, worktree: null, wake: false } };
const parked = (id: string, agentId: string) =>
  run({ id, agentId, loop: budgetPark as unknown as Run["loop"] });
const silent = () => {
  store.recordSilenceEvent("screenshot-captured", NOW - gap("screenshot-captured") - 1);
  runSilenceCheck({ store, config, now: () => NOW });
};
const alarms = () => store.audit(NOW - 7 * 24 * HOUR, NOW).items?.filter((i) => i.state === "open");

describe("the silence timer's quiet periods", () => {
  it("raises an alarm while a seat works a ticket", () => {
    seat(run({}));
    silent();
    expect(alarms()).toHaveLength(1);
  });
  it("raises none while only FLIGHT's run is open", () => {
    seat(run({ id: "rf", agentId: "flight-1", ticket: null }));
    silent();
    expect(alarms()).toEqual([]);
  });
  it("raises an alarm when Ready work fits an idle seat", () => {
    store.replaceBoard("repo", [card()]);
    silent();
    expect(alarms()).toHaveLength(1);
  });
  it("raises none when the only run has ended", () => {
    store.upsertRun(run({ endedAt: NOW - HOUR, status: "ok" }));
    silent();
    expect(alarms()).toEqual([]);
  });
  it("raises none while the crew is paused", () => {
    seat(run({}));
    writeCrewPause(store, { seats: [], reason: "pause", at: NOW, by: "operator" }, NOW);
    silent();
    expect(alarms()).toEqual([]);
  });
  it("raises none when every working seat is parked on its budget", () => {
    seat(parked("r1", "guido-1"));
    seat(parked("r2", "inco-1"));
    silent();
    expect(alarms()).toEqual([]);
  });
  it("raises none when the working seat's account is at its stop", () => {
    seat(run({}));
    store.addUsage({
      accountId: "a1",
      window: "5h",
      at: NOW,
      pct: 99,
      resetAt: NOW + HOUR,
      source: "t",
    });
    silent();
    expect(alarms()).toEqual([]);
  });
  it("raises an alarm when one seat is budget-parked and another still works", () => {
    seat(parked("r1", "guido-1"));
    seat(run({ id: "r2", agentId: "inco-1" }));
    silent();
    expect(alarms()).toHaveLength(1);
  });
  it("ignores an ended budget park", () => {
    store.upsertRun({ ...parked("r1", "guido-1"), endedAt: NOW - HOUR, status: "ok" });
    seat(run({ id: "r2", agentId: "inco-1" }));
    silent();
    expect(alarms()).toHaveLength(1);
  });
});

describe("the watched events' hooks", () => {
  it("records a screenshot when a shot is saved", () => {
    const save = recordingShotSaves(
      store,
      () => "id1",
      () => NOW,
    );
    expect(store.silenceEventLastSeen("screenshot-captured")).toBeNull();
    expect(save(Buffer.from("x"))).toBe("id1");
    expect(store.silenceEventLastSeen("screenshot-captured")).toBe(NOW);
  });

  const pr = (checks: PullRequestView["checks"]): PullRequestView => ({
    repoId: "repo",
    number: 1,
    title: "t",
    url: "u",
    branch: "b",
    ticket: null,
    state: "open",
    isDraft: false,
    review: null,
    ci: "passing",
    createdAt: 1,
    updatedAt: 1,
    mergedAt: null,
    headSha: "sha1",
    mergeCommitSha: null,
    mergeable: null,
    author: "a",
    assignees: [],
    checks,
    closingIssues: [],
  });
  it("records a CI result only when a PR is stored with checks", () => {
    store.upsertPullRequests("repo", [pr([])], NOW);
    expect(store.silenceEventLastSeen("ci-result-observed")).toBeNull();
    store.upsertPullRequests(
      "repo",
      [
        pr([
          {
            name: "web",
            kind: "check",
            state: "passing",
            conclusion: "SUCCESS",
            attempt: 1,
            url: null,
            startedAt: 1,
            completedAt: 2,
          },
        ]),
      ],
      NOW + 5,
    );
    expect(store.silenceEventLastSeen("ci-result-observed")).toBe(NOW + 5);
  });

  const raw = (sql: string, ...a: (string | number | null)[]) =>
    (store as unknown as { db: { prepare(s: string): { run(...x: unknown[]): unknown } } }).db
      .prepare(sql)
      .run(...a);
  const merged = (n: number) =>
    raw(
      `INSERT INTO pull_requests (repo_id, number, title, url, branch, state, is_draft, created_at,
        updated_at, merged_at, head_sha) VALUES ('repo', ?, 't', 'u', ?, 'merged', 0, 1, 1, 1, ?)`,
      n,
      `b${n}`,
      `sha${n}`,
    );
  it("records a merged-PR review only when a merged PR has a review", () => {
    merged(1);
    expect(store.silenceEventLastSeen("merged-pr-review-recorded")).toBeNull();
    raw(
      `INSERT INTO reviews (id, author_run_id, repo_id, seat_id, pr_number, sha, epoch, attempt,
        round, state, run_id, created_at, started_at) VALUES (1, 'a', 'repo', 'retro', 1, 'sha1', 0, 1, 1,
        'running', 'review-run', 1, 1)`,
    );
    expect(
      store.recordFindings(1, "review-run", {
        verdict: { spec: "pass", quality: "pass" },
        summary: "clean",
        findings: [],
        at: NOW + 7,
      }),
    ).toBe(true);
    expect(store.silenceEventLastSeen("merged-pr-review-recorded")).toBe(NOW + 7);
  });
});
