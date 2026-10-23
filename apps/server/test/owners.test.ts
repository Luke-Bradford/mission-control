import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoardItem,
  type Escalation,
  hardRulesBySettingKey,
  type PullRequestView,
  type Run,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { attentionItems, NO_LOCK } from "../src/hud.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-22T12:00:00Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const HUB = "hub-login";

let dir: string;
let store: Store;

const base: CcConfig = {
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "claude-main", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "shop-app", github: "o/shop-app", project: 2, statusMap: {}, autonomy: "merge" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};

const crewWith = (seats: string[]): CcConfig => ({
  ...base,
  crew: {
    worktrees: "/tmp/mc-owners-wt",
    maxSeats: 4,
    sessions: [
      {
        id: "shop-app-1",
        repoId: "shop-app",
        checkout: "/tmp/mc-owners-co",
        seats: seats.map((id) => ({
          id,
          role: id.split("-")[0] ?? "GUIDO",
          accountId: "claude-main",
          model: "sonnet",
          area: id.startsWith("FLIGHT") ? [] : ["apps/**"],
        })),
      },
    ],
  },
});

const run = (over: Partial<Run>): Run => ({
  id: "r1",
  agentId: "GUIDO-1",
  repoId: "shop-app",
  seq: 1,
  startedAt: NOW - 60 * MIN,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: null,
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

const boardItem = (over: Partial<BoardItem>): BoardItem => ({
  repoId: "shop-app",
  issueNumber: 42,
  title: "Fix the fence",
  status: "In progress",
  state: "in progress",
  labels: [],
  priority: null,
  updatedAt: NOW,
  url: "https://github.com/o/shop-app/issues/42",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: null,
  closed: false,
  prioritySource: null,
  createdAt: 1,
  itemId: null,
  projectId: null,
  ...over,
});

const escalation = (over: Partial<Escalation>): Escalation => ({
  id: "shop-app#9",
  repoId: "shop-app",
  issueNumber: 9,
  title: "[operator-decision] pick one",
  kind: "operator-decision",
  source: "title",
  openedAt: NOW - DAY,
  url: "https://github.com/o/shop-app/issues/9",
  question: null,
  ...over,
});

const pr = (over: Partial<PullRequestView>): PullRequestView => ({
  repoId: "shop-app",
  number: 7,
  title: "spec",
  url: "https://github.com/o/shop-app/pull/7",
  branch: "docs/42-spec",
  ticket: "shop-app#42",
  state: "open",
  isDraft: true,
  review: null,
  ci: null,
  createdAt: NOW - 9 * DAY,
  updatedAt: NOW - 9 * DAY,
  mergedAt: null,
  headSha: null,
  mergeable: null,
  ...over,
});

const owners = (c: CcConfig = base, login: string | null = HUB): Record<string, unknown> =>
  Object.fromEntries(
    attentionItems(c, store, NOW, NO_LOCK, undefined, login).map((i) => [i.key, i.owner]),
  );

const note = (key: string, kind: "blocked" | "flag" | "review") =>
  store.raiseNote({
    key,
    kind,
    runId: null,
    seatId: null,
    repoId: "shop-app",
    text: key,
    at: NOW - MIN,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-owners-"));
  store = new Store(join(dir, "mc.sqlite"));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Needs-you owners", () => {
  it("a seat's question is held back while a watch seat is live in its session, else the operator's", () => {
    const c = crewWith(["GUIDO-1", "FLIGHT-1"]);
    const id = store.addQuestion({ agentId: "GUIDO-1", runId: "c1", text: "Q?", at: NOW - MIN });
    const key = `ask:${id}`;
    // no watch seat in the session
    expect(owners(crewWith(["GUIDO-1"]))[key]).toBe("operator");
    // a watch seat that is not running leaves it to the operator
    expect(owners(c)[key]).toBe("operator");
    store.upsertRun(run({ id: "f1", agentId: "FLIGHT-1" }));
    store.setSeatSession({
      seatId: "FLIGHT-1",
      runId: "f1",
      cliSessionId: null,
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    expect(owners(c)[key]).toBeUndefined();
    // FLIGHT passed it on
    store.passQuestion(id, NOW);
    expect(owners(c)[key]).toBe("operator");
  });

  it("a hard-rule flag is the operator's, or the controller's where the rules say it merges", () => {
    note("flag:r1:hard-rules:abc", "flag");
    expect(owners()["note:flag:r1:hard-rules:abc"]).toBe("operator");
    store.setSetting(hardRulesBySettingKey("shop-app"), "controller");
    expect(owners()["note:flag:r1:hard-rules:abc"]).toBe("controller");
  });

  it("a cleanup note is the controller's, and a review note the operator's", () => {
    note("review:r1:abc", "review");
    note("cleanup-branch:r1", "blocked");
    note("cleanup:r2", "blocked");
    const o = owners();
    expect(o["note:review:r1:abc"]).toBe("operator");
    expect(o["note:cleanup-branch:r1"]).toBe("controller");
    expect(o["note:cleanup:r2"]).toBe("controller");
  });

  it("a flake note is the controller's", () => {
    note("flake:r1:abc", "flag");
    expect(owners()["note:flake:r1:abc"]).toBe("controller");
  });

  it("a draft PR from another login's run is that lane's; the hub's own is the operator's", () => {
    store.replaceBoard("shop-app", [boardItem({})]);
    const key = `pr:shop-app#7:${NOW - 9 * DAY}`;
    store.replacePullRequests("shop-app", [pr({ author: "someone" })], 0);
    expect(owners()[key]).toBe("lane:someone");
    store.replacePullRequests("shop-app", [pr({ author: HUB, assignees: ["other"] })], 0);
    expect(owners()[key]).toBe("lane:other");
    store.replacePullRequests("shop-app", [pr({ author: HUB, assignees: [HUB] })], 0);
    expect(owners()[key]).toBe("operator");
    // the hub's login unknown: nothing can be said to be another's
    store.replacePullRequests("shop-app", [pr({ author: "someone" })], 0);
    expect(owners(base, null)[key]).toBe("operator");
  });

  it("an escalation is the loop's, unless it names the operator", () => {
    store.replaceEscalations("shop-app", [
      escalation({}),
      escalation({
        id: "shop-app#10",
        issueNumber: 10,
        kind: "loop-blocked",
        title: "[loop-blocked] x",
      }),
      escalation({
        id: "shop-app#11",
        issueNumber: 11,
        kind: "autonomy-question",
        source: "label",
        title: "x",
      }),
    ]);
    const o = owners();
    expect(o["esc:shop-app#9"]).toBe("operator");
    expect(o["esc:shop-app#10"]).toBe("loop");
    expect(o["esc:shop-app#11"]).toBe("operator");
  });

  it("a crew error and a stray are the operator's", () => {
    store.addCrewError({ agentId: "GUIDO-1", runId: null, text: "boom", at: NOW - MIN });
    store.addStrays([
      { sessionId: "shop-app-1", path: "x.md", agentId: "GUIDO-1", kind: "outside", at: NOW },
    ]);
    const all = attentionItems(crewWith(["GUIDO-1"]), store, NOW);
    expect(all.map((i) => i.kind).sort()).toEqual(["error", "stray"]);
    expect(all.every((i) => i.owner === "operator")).toBe(true);
  });
});

describe("Needs-you items clear themselves", () => {
  it("an escalation goes once its issue is closed", () => {
    store.replaceEscalations("shop-app", [
      escalation({
        id: "shop-app#10",
        issueNumber: 10,
        kind: "loop-blocked",
        title: "[loop-blocked] x",
      }),
    ]);
    store.replaceBoard("shop-app", [boardItem({ issueNumber: 10 })]);
    expect(owners()["esc:shop-app#10"]).toBe("loop");
    store.replaceBoard("shop-app", [boardItem({ issueNumber: 10, closed: true })]);
    expect(owners()["esc:shop-app#10"]).toBeUndefined();
  });

  it("a PR item goes once the PR is merged or closed, or leaves draft", () => {
    store.replaceBoard("shop-app", [boardItem({})]);
    const texts = () =>
      attentionItems(base, store, NOW, NO_LOCK, undefined, HUB)
        .filter((i) => i.kind === "pr")
        .map((i) => i.text);
    store.replacePullRequests("shop-app", [pr({ author: "someone" })], 0);
    expect(texts()).toEqual(["PR #7 · You: decide on the draft"]);
    store.replacePullRequests("shop-app", [pr({ author: "someone", isDraft: false })], 0);
    expect(texts()).not.toContain("PR #7 · You: decide on the draft");
    store.replacePullRequests("shop-app", [pr({ state: "merged" })], 0);
    expect(texts()).toEqual([]);
    store.replacePullRequests("shop-app", [pr({ state: "closed" })], 0);
    expect(texts()).toEqual([]);
  });
});
