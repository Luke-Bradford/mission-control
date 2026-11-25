import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { readSessionSpend, sessionSpendFor, sessionSpendSplit } from "../src/spend/sessions.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-25T15:00:00Z");
const TZ = "Europe/London";
const FIXTURE = join(import.meta.dirname, "fixtures", "session-spend", "transcript.jsonl");

let dir: string;
let root: string;
let store: Store;
let config: CcConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-spend-"));
  root = join(dir, "projects");
  mkdirSync(root, { recursive: true });
  store = new Store(join(dir, "mc.sqlite"));
  config = {
    operator: { id: "operator", timezone: TZ },
    accounts: [{ id: "claude-main", vendor: "claude", alertAt: 85, stopAt: 95 }],
    repos: [{ id: "shop-app", github: "o/shop-app", project: 2, statusMap: {}, autonomy: "draft" }],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    crew: {
      worktrees: join(dir, "wt"),
      maxSeats: 4,
      sessions: [
        {
          id: "s1",
          repoId: "shop-app",
          checkout: join(dir, "co"),
          seats: [
            { id: "guido-1", role: "GUIDO", accountId: "claude-main", model: "sonnet", area: [] },
            { id: "flight-1", role: "FLIGHT", accountId: "claude-main", model: "opus", area: [] },
          ],
        },
      ],
    },
  } as CcConfig;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const read = (now = NOW) => readSessionSpend({ store, root, tz: TZ, now });

/** One assistant turn, as Claude Code writes it. */
const turn = (
  sessionId: string,
  cwd: string,
  id: string,
  at: number,
  usage: Record<string, unknown>,
  model = "claude-opus-5-5",
): string =>
  `${JSON.stringify({
    type: "assistant",
    sessionId,
    cwd,
    timestamp: new Date(at).toISOString(),
    message: { id, model, role: "assistant", content: [{ type: "text", text: "hi" }], usage },
  })}\n`;

const run = (over: Partial<Run>): Run => ({
  id: "r1",
  agentId: "guido-1",
  repoId: "shop-app",
  seq: 1,
  startedAt: NOW - 3_600_000,
  endedAt: NOW - 60_000,
  status: "ok",
  sessionId: null,
  model: "sonnet",
  branch: "feature/1-x",
  ticket: "shop-app#1",
  costUsd: 1,
  tokens: { input: 1, output: 1, cacheRead: 0, cacheCreate: 0 },
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

describe("session spend", () => {
  it("today's cost matches the hand total", () => {
    const project = join(root, "-nonexistent-proj");
    mkdirSync(project);
    copyFileSync(FIXTURE, join(project, "sess-fixture.jsonl"));
    read();
    // USD per million: Opus 5.5 4 in / 20 out / 5 5m write / 8 1h write / 0.2 read;
    // Sonnet 5.5 2 in / 10 out / 0.1 read; fast doubles. Each message counted once.
    const msgA = 1000 * 4 + 500 * 20 + 2000 * 5 + 1000 * 8 + 10000 * 0.2;
    const msgB = 200 * 4 + 300 * 20 + 4000 * 5 + 50000 * 0.2;
    const msgC = 3000 * 2 + 1500 * 10 + 20000 * 0.1;
    const msgD = (100 * 4 + 1000 * 20) * 2;
    const today = (msgA + msgB + msgC + msgD) / 1e6;
    const week = today + (1000 * 4 + 1000 * 20) / 1e6;
    const cell = sessionSpendFor(store, ["sess-fixture"], NOW, TZ).get("sess-fixture");
    expect(cell).toBeDefined();
    expect(Math.abs((cell?.today.costUsd ?? 0) - today) / today).toBeLessThan(0.01);
    expect(cell?.today.tokens).toBe(1500 + 500 + 4500 + 1100);
    expect(Math.abs((cell?.week.costUsd ?? 0) - week) / week).toBeLessThan(0.01);
    expect(cell?.week.tokens).toBe(7600 + 2000);
    expect(cell?.unpriced).toBe(false);
  });

  it("keeps numbers only, never transcript text", () => {
    const project = join(root, "p");
    mkdirSync(project);
    copyFileSync(FIXTURE, join(project, "sess-fixture.jsonl"));
    read();
    store.close();
    const bytes = readFileSync(join(dir, "mc.sqlite")).toString("latin1");
    expect(bytes).not.toContain("not kept");
    expect(bytes).not.toContain("secret");
    store = new Store(join(dir, "mc.sqlite"));
  });

  it("a new turn appears on the next pass and is never counted twice", () => {
    const project = join(root, "-Users-me-notes");
    mkdirSync(project);
    const file = join(project, "sess-op.jsonl");
    writeFileSync(
      file,
      turn("sess-op", "/nowhere/notes", "m1", NOW - 60_000, {
        input_tokens: 1000,
        output_tokens: 1000,
      }),
    );
    read();
    const before = sessionSpendFor(store, ["sess-op"], NOW, TZ).get("sess-op");
    appendFileSync(
      file,
      turn("sess-op", "/nowhere/notes", "m2", NOW - 1_000, {
        input_tokens: 500,
        output_tokens: 100,
      }),
    );
    read(NOW + 30_000);
    const after = sessionSpendFor(store, ["sess-op"], NOW + 30_000, TZ).get("sess-op");
    expect((after?.today.tokens ?? 0) - (before?.today.tokens ?? 0)).toBe(600);
    expect((after?.today.costUsd ?? 0) - (before?.today.costUsd ?? 0)).toBeCloseTo(
      (500 * 4 + 100 * 20) / 1e6,
      9,
    );
    const split = sessionSpendSplit(config, store, NOW + 30_000);
    expect(split.total.tokens).toBe(2600);
    expect(split.rows.every((r) => r.operator.tokens === r.total.tokens)).toBe(true);

    expect(read(NOW + 60_000).added).toBe(0);
    expect(readSessionSpend({ store, root, tz: TZ, now: NOW + 90_000 }).added).toBe(0);
    expect(sessionSpendFor(store, ["sess-op"], NOW + 90_000, TZ).get("sess-op")?.today.tokens).toBe(
      2600,
    );
  });

  it("a partial last line waits for its newline", () => {
    const project = join(root, "p");
    mkdirSync(project);
    const file = join(project, "s.jsonl");
    const line = turn("s", "/x", "m1", NOW - 1000, { input_tokens: 10, output_tokens: 10 });
    writeFileSync(file, line.slice(0, 40));
    read();
    expect(sessionSpendFor(store, ["s"], NOW, TZ).get("s")).toBeUndefined();
    appendFileSync(file, line.slice(40));
    read();
    expect(sessionSpendFor(store, ["s"], NOW, TZ).get("s")?.today.tokens).toBe(20);
  });

  it("the split adds up to the account total", () => {
    // the operator's own session in a git checkout of a repo the hub does not watch
    const mine = join(dir, "code", "notes-app");
    mkdirSync(join(mine, ".git"), { recursive: true });
    mkdirSync(join(mine, "src"));
    // a crew worktree with no run on record, under crew.worktrees: a .git file naming the main checkout
    const wt = join(dir, "wt", "guido-2-9");
    mkdirSync(wt, { recursive: true });
    writeFileSync(
      join(wt, ".git"),
      `gitdir: ${join(dir, "co", ".git", "worktrees", "guido-2-9")}\n`,
    );
    store.upsertRun(run({ id: "r-crew", sessionId: "sess-crew" }));
    store.setSeatSession({
      seatId: "flight-1",
      runId: null,
      cliSessionId: "sess-flight",
      state: "running",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    });
    const p = join(root, "p");
    mkdirSync(p);
    const yesterday = NOW - 24 * 3_600_000;
    const u = (i: number, o: number) => ({ input_tokens: i, output_tokens: o });
    writeFileSync(
      join(p, "sess-mine.jsonl"),
      turn("sess-mine", join(mine, "src"), "a1", NOW - 5000, u(100, 10)) +
        turn("sess-mine", join(mine, "src"), "a2", yesterday, u(200, 20)),
    );
    writeFileSync(
      join(p, "sess-crew.jsonl"),
      turn("sess-crew", "/anywhere", "b1", NOW - 4000, u(1000, 100)),
    );
    writeFileSync(join(p, "sess-wt.jsonl"), turn("sess-wt", wt, "c1", NOW - 3000, u(50, 5)));
    writeFileSync(
      join(p, "sess-flight.jsonl"),
      turn("sess-flight", "/elsewhere", "d1", NOW - 2000, u(3000, 300), "claude-mystery-1"),
    );
    read();
    const split = sessionSpendSplit(config, store, NOW);
    for (const r of split.rows) {
      expect(r.operator.tokens + r.crew.tokens + r.flight.tokens).toBe(r.total.tokens);
      expect(r.operator.costUsd + r.crew.costUsd + r.flight.costUsd).toBeCloseTo(
        r.total.costUsd,
        12,
      );
    }
    const sum = split.rows.reduce((n, r) => n + r.total.tokens, 0);
    expect(split.total.tokens).toBe(sum);
    expect(split.total.tokens).toBe(110 + 220 + 1100 + 55 + 3300);
    expect(split.total.costUsd).toBeCloseTo(
      split.rows.reduce((n, r) => n + r.total.costUsd, 0),
      12,
    );
    expect(split.unpricedTokens).toBe(3300);
    expect(split.readAt).toBe(NOW);
    const find = (day: string, repo: string | null) =>
      split.rows.find((r) => r.day === day && r.repo === repo);
    expect(find("2026-11-25", "notes-app")?.operator.tokens).toBe(110);
    expect(find("2026-11-24", "notes-app")?.operator.tokens).toBe(220);
    expect(find("2026-11-25", "shop-app")?.crew.tokens).toBe(1100);
    // the watch seat's session takes its seat's repo
    expect(find("2026-11-25", "shop-app")?.flight.tokens).toBe(3300);
    expect(find("2026-11-25", "co")?.crew.tokens).toBe(55);
    // newest day first, then the biggest total first
    expect(split.rows.map((r) => [r.day, r.repo])).toEqual([
      ["2026-11-25", "shop-app"],
      ["2026-11-25", "notes-app"],
      ["2026-11-25", "co"],
      ["2026-11-24", "notes-app"],
    ]);
  });

  it("measuring starts no run, wake or process", () => {
    const p = join(root, "p");
    mkdirSync(p);
    writeFileSync(
      join(p, "s.jsonl"),
      turn("s", "/x", "m1", NOW - 1000, { input_tokens: 1, output_tokens: 1 }),
    );
    const runsBefore = store.runsActiveSince(0).length;
    const wakesBefore = store.flightWakes(0).length;
    read();
    read(NOW + 30_000);
    expect(store.runsActiveSince(0).length).toBe(runsBefore);
    expect(store.flightWakes(0).length).toBe(wakesBefore);
    const src = readFileSync(
      join(import.meta.dirname, "..", "src", "spend", "sessions.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from "\.\.\/(flight|runtime|run)\//);
    expect(src).not.toMatch(/\b(spawn|execFile|exec|fetch)\(/);
    expect(src).not.toMatch(/node:child_process/);
  });

  it("a missing root adds nothing", () => {
    expect(readSessionSpend({ store, root: join(dir, "gone"), tz: TZ, now: NOW })).toEqual({
      files: 0,
      added: 0,
    });
  });
});
