import type { Run } from "@mc/core";
import { afterEach, expect, it } from "vitest";
import {
  FIRST_PROMPT_LIMIT_TOKENS,
  firstPromptReceipt,
  firstPrompts,
  formatReceipt,
} from "../src/flight/first-prompt-receipt.ts";
import { Store } from "../src/store.ts";

const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});
const cost = (section: "role" | "rules" | "orders" | "lessons" | "digest", tokens: number) => ({
  section,
  bytes: tokens * 4,
  tokens,
});
const wake = (runId: string, at: number, ...sections: ReturnType<typeof cost>[]) => ({
  runId,
  wake: 0,
  at,
  sections,
});

it("names each section, totals them and gives the 100k verdict", () => {
  const before = firstPromptReceipt([
    wake("old", 1, cost("role", 6000), cost("rules", 20000), cost("digest", 131000)),
  ]);
  const after = firstPromptReceipt([
    wake("new", 2, cost("digest", 60000), cost("rules", 15000), cost("role", 4000)),
  ]);
  if (!before || !after) throw new Error("receipt missing");
  expect(before.sections.map((s) => s.section)).toEqual(["role", "rules", "digest"]);
  expect(after.sections.map((s) => s.section)).toEqual(["role", "rules", "digest"]);
  expect([before.tokens, before.underLimit]).toEqual([157000, false]);
  expect([after.tokens, after.underLimit]).toEqual([79000, true]);
  expect(after.tokens).toBeLessThan(FIRST_PROMPT_LIMIT_TOKENS);
  const table = formatReceipt(before, after);
  expect(table).toMatch(/role\s+6000\s+4000/);
  expect(table).toMatch(/digest\s+131000\s+60000/);
  expect(table).toMatch(/total\s+157000\s+79000/);
  expect(table).toMatch(/verdict\s+OVER\s+under/);
});

it("ignores later wakes and runs with no recorded start", () => {
  expect(
    firstPromptReceipt([{ runId: "r", wake: 3, at: 1, sections: [cost("digest", 5)] }]),
  ).toBeNull();
});

it("reads the starts of one seat from a database, newest first", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const run = (id: string, startedAt: number): Run =>
    ({
      id,
      agentId: "flight-1",
      repoId: "repo",
      seq: 1,
      startedAt,
      endedAt: null,
      status: "running",
      sessionId: null,
      model: "opus",
      branch: "main",
      ticket: null,
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
      loop: "watch",
    }) as Run;
  for (const [id, at, digest] of [
    ["old", 1000, 130000],
    ["new", 2000, 40000],
  ] as const) {
    store.upsertRun(run(id, at));
    store.recordPromptSections(id, 0, at, [cost("role", 5000), cost("digest", digest)]);
    store.recordPromptSections(id, 1, at + 1, [cost("digest", 900)]);
  }
  const starts = firstPrompts(store, "flight-1");
  expect(starts.map((r) => [r.runId, r.tokens, r.underLimit])).toEqual([
    ["new", 45000, true],
    ["old", 135000, false],
  ]);
});
