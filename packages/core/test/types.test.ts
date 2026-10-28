import { describe, expect, it } from "vitest";
import type {
  AgentView,
  ChangedFiles,
  CliAccountStatus,
  ConfigView,
  CrewRow,
  LiveTask,
  LoopTry,
  NotificationEvent,
  NotificationPreferences,
  Run,
} from "../src/index.ts";

describe("core types", () => {
  it("accepts literal Run and AgentView objects", () => {
    const run = {
      id: "r1",
      agentId: "a1",
      repoId: "repo",
      seq: 1,
      startedAt: 1_700_000_000_000,
      endedAt: null,
      status: "running",
      sessionId: null,
      model: null,
      branch: null,
      ticket: null,
      costUsd: null,
      tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 },
      transcriptPath: "/tmp/t.jsonl",
      prs: [{ repo: "owner/repo", number: 7 }],
      summary: "Merged PR #7.",
    } satisfies Run;

    const view = {
      id: "a1",
      repoId: "repo",
      kind: "loop",
      role: null,
      mode: null,
      area: [],
      model: null,
      sessionId: null,
      loopKind: "ta-loop",
      accountId: "acc",
      state: "working",
      stateSince: run.startedAt,
      currentRun: run,
      paused: false,
      sourceError: null,
      note: null,
      stop: null,
      lastOutputAt: null,
    } satisfies AgentView;

    expect(view.currentRun?.id).toBe("r1");
  });
});

describe("recorded measurements", () => {
  it("distinguishes unknown and zero and file commits from response snapshots", () => {
    const attempts: Pick<LoopTry, "tokens">[] = [{}, { tokens: null }, { tokens: 0 }];
    const tasks: [LiveTask] = [{ id: "verify", text: "Verify changes", status: "pending" }];
    const updated: LiveTask = { ...tasks[0], status: "done" };
    const files: ChangedFiles = {
      sha: "snapshot",
      note: null,
      files: [{ path: "sample.ts", add: 1, del: 0, state: "committed", commitSha: "file-commit" }],
    };
    const seat: Pick<CrewRow, "id" | "focus" | "displayCallSign"> = {
      id: "guido-1",
      focus: "Measurements",
      displayCallSign: "GUIDO-2",
    };
    expect(attempts.map((t) => t.tokens)).toEqual([undefined, null, 0]);
    expect(updated.id).toBe(tasks[0]?.id);
    expect(files.files[0]?.commitSha).not.toBe(files.sha);
    expect(seat.id).toBe("guido-1");
  });
});

it("accepts complete setup contracts while legacy records omit additions", () => {
  const status = {
    accountId: "primary",
    provider: "codex",
    binding: "machine",
    identity: null,
    plan: null,
    status: "unknown",
    checkedAt: 10,
    detail: null,
  } satisfies CliAccountStatus;
  const preferences = {
    categories: {
      asks: true,
      flightDown: true,
      people: false,
      decisions: false,
      stalls: false,
      prs: false,
      capcom: false,
      awayDigest: true,
      quota: false,
    },
    quietHours: { start: "19:00", end: "08:00", timezone: "UTC", stallsBypass: true },
    softChime: true,
  } satisfies NotificationPreferences;
  const event = {
    id: "notice",
    category: "stalls",
    at: 10,
    text: "Run is stuck",
  } satisfies NotificationEvent;
  const legacy = {
    id: "primary",
    vendor: "codex",
    alertAt: 80,
    stopAt: 100,
  } satisfies ConfigView["accounts"][number];
  const complete = {
    ...legacy,
    binding: "machine",
    canCheck: true,
    signInHint: "Sign in with the Codex CLI on this machine.",
  } satisfies ConfigView["accounts"][number];
  const session = {
    id: "work",
    repoId: "repo",
    checkout: "checkout",
    seats: [],
    branch: "feat/work",
    managedCheckout: true,
  } satisfies NonNullable<ConfigView["crew"]>["sessions"][number];
  expect([
    status.plan,
    preferences.softChime,
    event.category,
    complete.canCheck,
    session.managedCheckout,
  ]).toEqual([null, true, "stalls", true, true]);
});
