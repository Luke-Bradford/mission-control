import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NEW_LOOP, type Run } from "@mc/core";
import { afterEach, expect, it } from "vitest";
import {
  FIRST_PROMPT_LIMIT_TOKENS,
  firstPromptReceipt,
  firstPrompts,
  formatReceipt,
  measuredFirstContext,
  pickBefore,
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
  expect(table).toMatch(/estimate\s+157000\s+79000/);
  expect(table).toMatch(/verdict\s+OVER\*\s+under\*/);
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
      loop: NEW_LOOP,
    }) satisfies Run;
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

it("keeps the old run as the baseline after 1,100 later wakes", () => {
  const store = new Store(":memory:");
  stores.push(store);
  const mk = (id: string, startedAt: number): Run =>
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
      loop: NEW_LOOP,
    }) satisfies Run;
  store.upsertRun(mk("old", 1000));
  store.recordPromptSections("old", 0, 1000, [cost("digest", 130000)]);
  store.upsertRun(mk("new", 5000));
  store.recordPromptSections("new", 0, 5000, [cost("digest", 1000)]);
  for (let w = 1; w <= 1100; w++)
    store.recordPromptSections("new", w, 5000 + w, [cost("digest", 1)]);
  const starts = firstPrompts(store, "flight-1");
  expect(starts.map((r) => r.runId)).toEqual(["new", "old"]);
  expect(pickBefore(starts)?.runId).toBe("old");
  expect(pickBefore(starts, "new")?.runId).toBe("new");
  expect(pickBefore(starts, new Date(3000).toISOString())?.runId).toBe("old");
});

it("bases the verdict on the measured first context, not the estimate", () => {
  const dir = mkdtempSync(join(tmpdir(), "receipt-"));
  try {
    const path = join(dir, "t.jsonl");
    const usage = {
      input_tokens: 5,
      cache_read_input_tokens: 150000,
      cache_creation_input_tokens: 10,
    };
    writeFileSync(
      path,
      `${JSON.stringify({ type: "user" })}\n${JSON.stringify({ type: "assistant", message: { usage } })}\n`,
    );
    expect(measuredFirstContext(path)).toBe(150015);
    expect(measuredFirstContext(join(dir, "missing"))).toBeNull();
    const small = [wake("r", 1, cost("digest", 1000))];
    expect(firstPromptReceipt(small, 150015)?.underLimit).toBe(false);
    expect(firstPromptReceipt(small, 90000)?.underLimit).toBe(true);
    expect(firstPromptReceipt(small)?.underLimit).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
