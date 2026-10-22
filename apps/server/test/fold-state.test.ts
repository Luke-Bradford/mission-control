import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FOLD_WINDOW_MS, type FoldState, pruneFoldState } from "../src/collectors/common.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-fold-state-"));
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (over: Partial<Run>): Run => ({
  id: "r",
  agentId: "a1",
  repoId: "repo",
  seq: 1,
  startedAt: NOW - HOUR,
  endedAt: NOW - HOUR / 2,
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

describe("pruneFoldState", () => {
  it("keeps the state of runs the collectors can still fold, drops the rest", () => {
    const old = NOW - FOLD_WINDOW_MS - HOUR;
    let seq = 0;
    const seed = (id: string, over: Partial<Run>) =>
      store.upsertRun(run({ id, seq: ++seq, transcriptPath: `/t/${id}`, ...over }));
    seed("h23", { startedAt: NOW - 23 * HOUR, endedAt: NOW - 22 * HOUR });
    seed("h25-ended-1h", { startedAt: NOW - 25 * HOUR, endedAt: NOW - HOUR });
    seed("unknown-in", { status: "unknown", startedAt: NOW - 2 * HOUR, endedAt: null });
    seed("live", { status: "running", startedAt: old, endedAt: null });
    seed("old", { startedAt: old - DAY, endedAt: old - DAY + HOUR });
    seed("unknown-old", { status: "unknown", startedAt: old, endedAt: null });
    const ids = ["h23", "h25-ended-1h", "unknown-in", "live", "old", "unknown-old", "gone"];
    const fold = (): FoldState => ({ facts: {} as FoldState["facts"], offset: 1 });
    const state = {
      transcripts: new Map(ids.map((id) => [`/t/${id}`, fold()])),
      digests: new Map(ids.map((id) => [id, "{}"])),
    };
    pruneFoldState(store, state, NOW);
    const kept = ["h23", "h25-ended-1h", "live", "unknown-in"];
    expect([...state.transcripts.keys()].sort()).toEqual(kept.map((id) => `/t/${id}`).sort());
    expect([...state.digests.keys()].sort()).toEqual([...kept].sort());
  });
});
