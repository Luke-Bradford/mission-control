import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequestView, Run, RunPlan } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { runPrs, runTicket, runView } from "../src/runview.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-runview-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const config = {
  repos: [
    { id: "shop-app", github: "octo-org/shop-app", project: 2, statusMap: {} },
    { id: "site-builder", github: "octo-org/site-builder", project: 3, statusMap: {} },
  ],
} as unknown as CcConfig;

const run = (over: Partial<Run> = {}): Run => ({
  id: "r1",
  agentId: "a1",
  repoId: "shop-app",
  seq: 1,
  startedAt: 1000,
  endedAt: 2000,
  status: "ok",
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

const pr = (over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "shop-app",
  number: 41,
  title: "Quote cache",
  url: "https://github.com/octo-org/shop-app/pull/41",
  branch: "chore/cache",
  ticket: "shop-app#3349",
  state: "merged",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: 1,
  updatedAt: 2,
  mergedAt: 3,
  headSha: null,
  mergeable: null,
  ...over,
});

describe("runPrs", () => {
  it("maps the repo to a configured id case-insensitively and joins the stored PR row", () => {
    store.upsertPullRequests("shop-app", [pr()], 0);
    const r = run({
      prs: [
        { repo: "OCTO-ORG/SHOP-APP", number: 41 },
        { repo: "Someone-Else/shop-app", number: 41 },
        { repo: "octo-org/shop-app", number: 42 },
      ],
    });
    expect(runPrs(config, store, r)).toEqual([
      {
        repoId: "shop-app",
        number: 41,
        title: "Quote cache",
        url: "https://github.com/octo-org/shop-app/pull/41",
        state: "merged",
        ticket: "shop-app#3349",
      },
      {
        repoId: "shop-app",
        number: 42,
        title: null,
        url: "https://github.com/octo-org/shop-app/pull/42",
        state: null,
        ticket: null,
      },
    ]);
  });

  it("reads each repo's PRs once per cache, not once per run", () => {
    store.upsertPullRequests("shop-app", [pr()], 0);
    const read = vi.spyOn(store, "pullRequests");
    const cache = new Map();
    const r = run({ prs: [{ repo: "octo-org/shop-app", number: 41 }] });
    runPrs(config, store, r, cache);
    runPrs(config, store, { ...r, id: "r2" }, cache);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads nothing for a run without PRs", () => {
    const read = vi.spyOn(store, "pullRequests");
    expect(runPrs(config, store, run())).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});

describe("runTicket", () => {
  it("is the run's own ticket, else the first PR ticket, else null", () => {
    store.upsertPullRequests("shop-app", [pr({ number: 40, ticket: null }), pr()], 0);
    const r = run({
      prs: [
        { repo: "octo-org/shop-app", number: 40 },
        { repo: "octo-org/shop-app", number: 41 },
      ],
    });
    const prs = runPrs(config, store, r);
    expect(runTicket(r, prs)).toBe("shop-app#3349");
    expect(runTicket({ ...r, ticket: "shop-app#1" }, prs)).toBe("shop-app#1");
    expect(runTicket(run(), [])).toBeNull();
  });
});

describe("run plan", () => {
  it.each([
    { by: "fao-1", at: 100, ref: "shop-app#42" },
    { by: null, at: null, ref: "shop-app#42" },
    { skipped: "Size S" },
  ] satisfies RunPlan[])("persists and serves %j unchanged after a fold", (plan) => {
    store.upsertRun(run({ plan }));
    store.upsertRun(run({ status: "failed" }), true);
    const stored = store.run("r1");
    expect(stored).not.toBeNull();
    if (stored === null) throw new Error("missing run");
    expect(stored.plan).toEqual(plan);
    expect(runView(config, store, stored, new Map()).plan).toEqual(plan);
  });

  it("keeps older runs without a plan fact", () => {
    store.upsertRun(run());
    const stored = store.run("r1");
    if (stored === null) throw new Error("missing run");
    expect(runView(config, store, stored, new Map())).not.toHaveProperty("plan");
  });

  it("uses the latest report for the same repo and ticket, not other loop events", () => {
    expect(store.ticketPlan("shop-app", "shop-app#42")).toBeNull();
    for (const [id, agentId, repoId, ticket, at, kind] of [
      ["old", "fao-1", "shop-app", "shop-app#42", 100, "plan"],
      ["new", "fao-2", "shop-app", "shop-app#42", 200, "plan"],
      ["other-ticket", "fao-3", "shop-app", "shop-app#43", 300, "plan"],
      ["other-repo", "fao-4", "site-builder", "shop-app#42", 400, "plan"],
      ["build", "guido-1", "shop-app", "shop-app#42", 500, "build"],
    ] as const) {
      store.upsertRun(run({ id, agentId, repoId, ticket }));
      store.addLoopEvent(`${id}:${kind}`, id, "Reported", at);
    }
    expect(store.ticketPlan("shop-app", "shop-app#42")).toEqual({
      by: "fao-2",
      at: 200,
      ref: "shop-app#42",
    });
  });
});
