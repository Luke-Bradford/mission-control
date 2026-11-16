import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMS_OPEN_PREFIX, REPO_UNWATCHED_REASON, type Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeUnwatchedRepoItems } from "../src/attention/unwatched-repos.ts";
import type { CcConfig } from "../src/config.ts";
import { attentionItems } from "../src/hud/hud.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-07T12:00:00Z");
let dir: string;
let store: Store;

const config = (): CcConfig => ({
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  crew: {
    worktrees: "/tmp/wt",
    maxSeats: 2,
    sessions: [
      {
        id: "mc-1",
        repoId: "mc",
        checkout: "/tmp/co",
        seats: [{ id: "guido-1", role: "GUIDO", accountId: "a", model: "x", area: [] }],
      },
    ],
  },
  poll: { usageMinutes: 30, githubSeconds: 60 },
});

const run = (id: string, repoId: string, ticket: string): Run => ({
  id,
  agentId: "guido-1",
  repoId,
  seq: 1,
  startedAt: NOW - 60_000,
  endedAt: null,
  status: "running",
  sessionId: "cli",
  model: "opus",
  branch: `${repoId}/1`,
  ticket,
  costUsd: null,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
});

/** An open question from a run on `repo#n`. */
function ask(repo: string, n: number, text: string): string {
  const runId = `r-${repo}`;
  store.upsertRun(run(runId, repo, `${repo}#${n}`));
  const id = store.addQuestion({ agentId: "guido-1", runId, text, at: NOW - 60_000 });
  return `ask:${id}`;
}

const openKeys = () =>
  attentionItems(config(), store, NOW, undefined, undefined, null, true).map((i) => i.key);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-unwatched-"));
  store = new Store(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("items from a repo the hub no longer watches", () => {
  it("closes the unwatched one with a reason, keeps the watched one, and does nothing twice", () => {
    const gone = ask("studio", 7, "Switch over to the new studio?");
    const kept = ask("mc", 8, "Which lane?");
    expect(openKeys()).toEqual(expect.arrayContaining([gone, kept]));

    expect(closeUnwatchedRepoItems({ config: config(), store, now: NOW })).toBe(1);

    expect(openKeys()).not.toContain(gone);
    expect(openKeys()).toContain(kept);
    expect(store.questionClosure(gone, NOW - 60_000)).toMatchObject({
      kind: "repo-unwatched",
      reason: REPO_UNWATCHED_REASON,
      by: "hub",
      ticket: "studio#7",
    });
    // FLIGHT's decisions show it
    expect(
      store
        .flightDecisions(0, 10)
        .filter((d) => d.ref === "studio#7" && d.about.includes("studio")),
    ).toHaveLength(1);

    // repeated runs do nothing extra
    expect(closeUnwatchedRepoItems({ config: config(), store, now: NOW + 1 })).toBe(0);
    expect(store.flightDecisions(0, 10).filter((d) => d.ref === "studio#7")).toHaveLength(1);
  });

  it("does not reopen an item when its repo is watched again", () => {
    const gone = ask("studio", 7, "Switch over?");
    closeUnwatchedRepoItems({ config: config(), store, now: NOW });
    const back = config();
    back.repos.push({
      id: "studio",
      github: "o/studio",
      project: 2,
      statusMap: {},
      autonomy: "draft",
    });
    expect(closeUnwatchedRepoItems({ config: back, store, now: NOW + 1 })).toBe(0);
    expect(
      attentionItems(back, store, NOW + 1, undefined, undefined, null, true).map((i) => i.key),
    ).not.toContain(gone);
  });

  it("settles open Comms questions and blockers, and dismisses a held blocker", () => {
    const question = store.addComms({
      at: NOW - 16 * 60_000,
      from: "guido-1",
      to: "flight-1",
      ticket: "studio#7",
      text: "Which studio should run?",
      label: "question",
    });
    const blocker = store.addComms({
      at: NOW - 16 * 60_000,
      from: "guido-1",
      to: "flight-1",
      ticket: "studio#8",
      text: "Studio switch-over is held.",
      label: "blocker",
    });
    if (!question || !blocker) throw new Error("Comms item missing");
    store.raiseNote({
      key: "blocked:studio:9",
      kind: "blocked",
      runId: null,
      seatId: "guido-1",
      repoId: "studio",
      text: "Studio hold",
      at: NOW - 60_000,
    });
    const keys = [
      `${COMMS_OPEN_PREFIX}${question.id}`,
      `${COMMS_OPEN_PREFIX}${blocker.id}`,
      "note:blocked:studio:9",
    ];
    expect(openKeys()).toEqual(expect.arrayContaining(keys));

    expect(closeUnwatchedRepoItems({ config: config(), store, now: NOW })).toBe(3);

    expect(openKeys()).not.toEqual(expect.arrayContaining(keys));
    for (const key of keys)
      expect(
        store.questionClosure(key, key.startsWith("note:") ? NOW - 60_000 : NOW - 16 * 60_000),
      ).toMatchObject({
        kind: "repo-unwatched",
        reason: REPO_UNWATCHED_REASON,
        by: "hub",
      });
    expect(store.commsSettlement(question.id)).toMatchObject({ reason: REPO_UNWATCHED_REASON });
    expect(store.commsSettlement(blocker.id)).toMatchObject({ reason: REPO_UNWATCHED_REASON });
    expect(store.notes().find((n) => n.key === "blocked:studio:9")?.dismissedAt).toBe(NOW);
    expect(
      store.flightDecisions(0, 10).filter((d) => d.basis.includes("studio is not")),
    ).toHaveLength(3);

    expect(closeUnwatchedRepoItems({ config: config(), store, now: NOW + 1 })).toBe(0);
    expect(
      store.flightDecisions(0, 10).filter((d) => d.basis.includes("studio is not")),
    ).toHaveLength(3);
  });
});
