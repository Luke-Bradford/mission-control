import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AttentionItem,
  AWAY_SETTING,
  DEFAULT_AWAY,
  NEW_LOOP,
  type PullRequestView,
  type Run,
} from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  AWAY_CORRUPT_LOG,
  AWAY_DIGEST_DECISIONS_MAX,
  AWAY_DIGEST_LOOKBACK_MS,
  AWAY_STARTED_SETTING,
  awayDigest,
  CLOSED_AWAY,
  readAwaySettings,
} from "../src/away.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
const NOW = Date.parse("2026-10-24T12:00:00Z");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-away-"));
  store = new Store(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});
it("missing means off, corrupt rows fail closed and log only once per store", () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(readAwaySettings(store)).toEqual(DEFAULT_AWAY);
  expect(log).not.toHaveBeenCalled();
  for (const raw of ["{", "null", "[]", '{"on":true}', '{"on":true,"until":"bad","may":{}}']) {
    store.setSetting(AWAY_SETTING, raw);
    expect(readAwaySettings(store)).toEqual(CLOSED_AWAY);
    expect(readAwaySettings(store)).toEqual(CLOSED_AWAY);
  }
  expect(log).toHaveBeenCalledExactlyOnceWith(AWAY_CORRUPT_LOG);
  store.setSetting(AWAY_SETTING, JSON.stringify(DEFAULT_AWAY));
  expect(readAwaySettings(store)).toEqual(DEFAULT_AWAY);
});
const decision = (at: number) =>
  store.addFlightDecision({
    at,
    kind: "note",
    seatId: null,
    targetRunId: null,
    ref: null,
    questionId: null,
    about: "mc#1",
    decision: "checked",
    basis: "evidence",
  });
it("bounds decisions by since, away start or seven days, and caps the result", () => {
  decision(NOW - AWAY_DIGEST_LOOKBACK_MS - 1);
  decision(NOW - 100);
  decision(NOW);
  const read = (since?: number) => awayDigest(store, true, [], [], NOW, since).groups[4].items;
  expect(read()).toHaveLength(2);
  store.setSetting(AWAY_STARTED_SETTING, String(NOW));
  expect(read()).toHaveLength(1);
  expect(read(NOW - 101)).toHaveLength(2);
  for (let i = 0; i < AWAY_DIGEST_DECISIONS_MAX + 5; i++) decision(NOW);
  expect(read()).toHaveLength(AWAY_DIGEST_DECISIONS_MAX);
});
const run = (id: string, over: Partial<Run> = {}): Run => ({
  id,
  agentId: "guido-1",
  repoId: "mc",
  seq: 1,
  startedAt: NOW,
  endedAt: null,
  status: "running",
  sessionId: "s",
  model: "haiku",
  branch: "feature/1",
  ticket: "mc#1",
  ticketTitle: "x",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});
const pr = (number: number, headSha: string): PullRequestView => ({
  repoId: "mc",
  number,
  headSha,
  title: "x",
  url: "https://github.com/o/mc/pull/1",
  branch: "feature/1",
  ticket: "mc#1",
  state: "open",
  isDraft: false,
  review: null,
  ci: "passing",
  createdAt: NOW,
  updatedAt: NOW,
  mergedAt: null,
  mergeable: null,
});
it("only reports PRs whose ready step covers the current head and outstanding parks", () => {
  store.upsertPullRequests("mc", [pr(1, "same"), pr(2, "new"), pr(3, "manual")], NOW);
  store.upsertRun(
    run("safe", {
      endedAt: NOW,
      loop: { ...NEW_LOOP, prNumber: 1, merging: { sha: "same", done: ["ready"] } },
    }),
  );
  store.upsertRun(
    run("moved", { loop: { ...NEW_LOOP, prNumber: 2, merging: { sha: "old", done: ["ready"] } } }),
  );
  store.upsertRun(run("manual", { loop: { ...NEW_LOOP, prNumber: 3 } }));
  for (const id of ["live", "ended", "park-ended"])
    store.upsertRun(
      run(id, {
        endedAt: id === "ended" ? NOW : null,
        loop: { ...NEW_LOOP, parked: { kind: "stuck", reason: id, ended: id === "park-ended" } },
      }),
    );
  const digest = awayDigest(store, true, [], ["mc"], NOW);
  expect(digest.groups[1].items.map((p) => p.number)).toEqual([1]);
  expect(digest.groups[3].items.map((r) => r.runId)).toEqual(["live"]);
});
it("includes FLIGHT-triaged operator items and drops acknowledgements", () => {
  const base: AttentionItem = {
    key: "one",
    kind: "question",
    owner: "operator",
    text: "help",
    at: NOW,
    acked: false,
    agentId: null,
    repoId: "mc",
    ticket: null,
    tool: null,
    url: null,
    escalationId: null,
  };
  const items: AttentionItem[] = [
    base,
    { ...base, key: "triaged", owner: "flight", flightTriage: "handling" },
    { ...base, key: "acked", acked: true },
    { ...base, key: "loop", owner: "loop" },
  ];
  expect(awayDigest(store, true, items, [], NOW).groups[0].items.map((i) => i.key)).toEqual([
    "one",
    "triaged",
  ]);
});

it("loads only unended runs or runs with merge state for the digest", () => {
  store.upsertRun(run("active"));
  store.upsertRun(run("ended-no-loop", { endedAt: NOW }));
  store.upsertRun(run("ended-null-merge", { endedAt: NOW, loop: { ...NEW_LOOP, merging: null } }));
  store.upsertRun(run("ended-missing-merge", { endedAt: NOW, loop: { ...NEW_LOOP } }));
  store.upsertRun(
    run("ended-ready", {
      endedAt: NOW,
      loop: { ...NEW_LOOP, merging: { sha: "head", done: ["ready"] } },
    }),
  );
  expect(
    store
      .runsForAwayDigest()
      .map((r) => r.id)
      .sort(),
  ).toEqual(["active", "ended-ready"]);
});
