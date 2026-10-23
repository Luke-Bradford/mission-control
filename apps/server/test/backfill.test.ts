import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Run, RunDigest } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKFILL_BATCH,
  backfillRuns,
  fillTicketTitles,
  rewriteCrewSummaries,
  SUMMARY_REWRITE_DONE,
  TITLES_FILLED_DONE,
} from "../src/backfill.ts";
import { FOLD_WINDOW_MS, foldPath } from "../src/collectors/common.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

// The real foldPath, counted: no run's transcript may be read twice.
vi.mock("../src/collectors/common.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/collectors/common.ts")>();
  return { ...actual, foldPath: vi.fn(actual.foldPath) };
});

const NOW = Date.parse("2026-10-17T12:00:00Z");
const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

let dir: string;
let dbPath: string;
let store: Store;
let config: CcConfig;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-backfill-"));
  mkdirSync(join(dir, "t"));
  mkdirSync(join(dir, "crew"));
  dbPath = join(dir, "mc.sqlite");
  store = new Store(dbPath);
  vi.mocked(foldPath).mockClear();
  config = {
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [{ id: "claude-main", vendor: "claude", alertAt: 85, stopAt: 95 }],
    repos: [{ id: "shop-app", github: "o/shop-app", project: 2, statusMap: {}, autonomy: "draft" }],
    loops: [
      {
        id: "shop-app-ta",
        repoId: "shop-app",
        kind: "ta-loop",
        accountId: "claude-main",
        stateDir: join(dir, "ta"),
        worktree: join(dir, "wt"),
        launchdLabel: "x",
      },
    ],
    poll: { usageMinutes: 30, githubSeconds: 60 },
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const line = (o: unknown) => `${JSON.stringify(o)}\n`;

/** A whole transcript: init, one assistant turn with usage, a branch, a PR and a result. */
const transcript = (n: number, branch: string | null = `fix/${n}-x`) =>
  line({ type: "system", subtype: "init", session_id: `s-${n}`, model: "claude-opus-5-5" }) +
  line({
    type: "assistant",
    message: { id: `m-${n}`, usage: { input_tokens: 10, output_tokens: 5 }, content: [] },
  }) +
  (branch === null
    ? ""
    : line({ type: "system", subtype: "vcs_state_changed", kind: "push", branch })) +
  line({
    type: "system",
    subtype: "code_change_published",
    provider: "github",
    repo: "o/shop-app",
    identifier: String(1000 + n),
    action: "created",
  }) +
  line({ type: "result", total_cost_usd: 0.5, result: `Run ${n} done. More text.` });

/** An ended, unfolded run of `shop-app-ta` started `ageMs` before NOW, with its transcript written. */
function seed(
  n: number,
  ageMs: number,
  over: Partial<Run> = {},
  text = transcript(n),
  sub = "t",
): Run {
  const path = join(dir, sub, `run-${n}.log`);
  writeFileSync(path, text);
  const r: Run = {
    id: `shop-app-ta:${n}`,
    agentId: "shop-app-ta",
    repoId: "shop-app",
    seq: n,
    startedAt: NOW - ageMs,
    endedAt: NOW - ageMs + HOUR,
    status: "ok",
    sessionId: null,
    model: null,
    branch: null,
    ticket: null,
    costUsd: null,
    tokens: null,
    transcriptPath: path,
    prs: [],
    summary: null,
    reviewId: null,
    ...over,
  };
  store.upsertRun(r);
  return r;
}

const get = (s: Store, id: string) => s.runs("shop-app-ta", 1000).find((r) => r.id === id);

/** Runs the backfill with a clock that advances 100 ms for every run written. */
function withRunClock(s: Store, budgetMs = 1500) {
  let t = 0;
  const upsert = s.upsertRun.bind(s);
  vi.spyOn(s, "upsertRun").mockImplementation((r, folded) => {
    t += 100;
    upsert(r, folded);
  });
  return () => backfillRuns({ config, store: s, now: NOW, budgetMs, clock: () => t });
}

const foldedPaths = () => vi.mocked(foldPath).mock.calls.map((c) => c[1]);

describe("backfillRuns", () => {
  it("folds within its budget, then continues where it stopped without reading a run twice", () => {
    for (let n = 1; n <= 50; n++) seed(n, 2 * DAY + n * HOUR);
    const step = withRunClock(store);
    expect(step()).toEqual({ folded: 15, left: 35, failed: 0 });
    expect(foldedPaths()).toHaveLength(15);
    // Newest first: runs 1..15 started most recently.
    expect(get(store, "shop-app-ta:15")?.summary).toBe("Run 15 done. More text.");
    expect(get(store, "shop-app-ta:16")?.summary).toBeNull();
    expect(step()).toEqual({ folded: 15, left: 20, failed: 0 });
    expect(step()).toEqual({ folded: 15, left: 5, failed: 0 });
    expect(step()).toEqual({ folded: 5, left: 0, failed: 0 });
    expect(step()).toEqual({ folded: 0, left: 0, failed: 0 });
    const paths = foldedPaths();
    expect(paths).toHaveLength(50);
    expect(new Set(paths).size).toBe(50);
  });

  it("takes runs in batches of 20 started before the fold window", () => {
    expect(BACKFILL_BATCH).toBe(20);
    for (let n = 1; n <= 45; n++) seed(n, 2 * DAY + n * HOUR);
    const take = vi.spyOn(store, "runsToFold");
    expect(backfillRuns({ config, store, now: NOW, budgetMs: 60_000 })).toEqual({
      folded: 45,
      left: 0,
      failed: 0,
    });
    for (const call of take.mock.calls) expect(call).toEqual([20, NOW - FOLD_WINDOW_MS]);
  });

  it("writes the transcript's facts, a re-derived ticket and the folded mark", () => {
    seed(1, 3 * DAY);
    backfillRuns({ config, store, now: NOW, budgetMs: 1500 });
    expect(get(store, "shop-app-ta:1")).toMatchObject({
      sessionId: "s-1",
      model: "claude-opus-5-5",
      branch: "fix/1-x",
      ticket: "shop-app#1",
      costUsd: 0.5,
      tokens: { input: 10, output: 5, cacheRead: 0, cacheCreate: 0 },
      prs: [{ repo: "o/shop-app", number: 1001 }],
      summary: "Run 1 done. More text.",
    });
    expect(store.countToFold(NOW - FOLD_WINDOW_MS)).toBe(0);
  });

  it("reads a read-only transcript, and leaves its size and mtime alone", () => {
    const r = seed(1, 3 * DAY);
    chmodSync(r.transcriptPath, 0o444);
    const before = statSync(r.transcriptPath);
    expect(backfillRuns({ config, store, now: NOW, budgetMs: 1500 })).toEqual({
      folded: 1,
      left: 0,
      failed: 0,
    });
    expect(get(store, r.id)).toMatchObject({ costUsd: 0.5, sessionId: "s-1" });
    const after = statSync(r.transcriptPath);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("keeps a stored branch, whether or not the transcript names one", () => {
    seed(
      1,
      3 * DAY,
      { branch: "feature/7-y", sessionId: "s-kept", model: "m-kept" },
      line({ type: "result", result: "Only a result." }),
    );
    seed(2, 3 * DAY, { branch: "feature/8-z" }, transcript(2, null));
    seed(3, 3 * DAY, { branch: "feature/9-w" }, transcript(3, "fix/3-x"));
    backfillRuns({ config, store, now: NOW, budgetMs: 1500 });
    expect(get(store, "shop-app-ta:1")).toMatchObject({
      branch: "feature/7-y",
      ticket: "shop-app#7",
      sessionId: "s-kept",
      model: "m-kept",
      summary: "Only a result.",
    });
    expect(get(store, "shop-app-ta:2")).toMatchObject({
      branch: "feature/8-z",
      ticket: "shop-app#8",
    });
    expect(get(store, "shop-app-ta:3")).toMatchObject({
      branch: "feature/9-w",
      ticket: "shop-app#9",
    });
  });

  it("marks a missing, empty-path or unreadable transcript done, unchanged, and never reads it again", () => {
    const missing = seed(1, 3 * DAY, { costUsd: 1.25 });
    rmSync(missing.transcriptPath);
    const noPath = seed(2, 3 * DAY, { transcriptPath: "" });
    const locked = seed(3, 3 * DAY, { summary: "kept" });
    chmodSync(locked.transcriptPath, 0o000);
    const aDir = seed(4, 3 * DAY, { transcriptPath: join(dir, "t") });
    expect(backfillRuns({ config, store, now: NOW, budgetMs: 1500 })).toEqual({
      folded: 4,
      left: 0,
      failed: 0,
    });
    for (const r of [missing, noPath, locked, aDir]) expect(get(store, r.id)).toEqual(r);
    expect(foldedPaths()).toEqual([]);
    expect(backfillRuns({ config, store, now: NOW, budgetMs: 1500 })).toEqual({
      folded: 0,
      left: 0,
      failed: 0,
    });
    expect(foldedPaths()).toEqual([]);
  });

  it("marks an empty transcript, or one with no session, usage or result, done and unchanged", () => {
    const empty = seed(1, 3 * DAY, {}, "");
    const cut = seed(2, 3 * DAY, { summary: "kept" }, '{"type":"system","subtype":"init","sess');
    const noFacts = seed(3, 3 * DAY, {}, line({ type: "user", message: { content: [] } }));
    expect(backfillRuns({ config, store, now: NOW, budgetMs: 1500 })).toEqual({
      folded: 3,
      left: 0,
      failed: 0,
    });
    for (const r of [empty, cut, noFacts]) expect(get(store, r.id)).toEqual(r);
    expect(get(store, empty.id)?.tokens).toBeNull();
    expect(store.digest(empty.id)).toBeNull();
  });

  it("marks a run whose fold throws done and unchanged, counts it, and reads the next run", () => {
    const bad = seed(1, 2 * DAY + HOUR);
    seed(2, 2 * DAY + 2 * HOUR);
    vi.mocked(foldPath).mockImplementationOnce(() => {
      throw new Error("bad transcript");
    });
    expect(backfillRuns({ config, store, now: NOW, budgetMs: 1500 })).toEqual({
      folded: 2,
      left: 0,
      failed: 1,
    });
    expect(get(store, bad.id)).toEqual(bad);
    expect(get(store, "shop-app-ta:2")?.summary).toBe("Run 2 done. More text.");
    expect(foldedPaths()).toHaveLength(2);
    expect(backfillRuns({ config, store, now: NOW, budgetMs: 1500 })).toEqual({
      folded: 0,
      left: 0,
      failed: 0,
    });
    expect(foldedPaths()).toHaveLength(2);
  });

  it("restores the row of a run whose write throws after its facts were applied", () => {
    const bad = seed(1, 3 * DAY, { summary: "before" });
    const setDigest = vi.spyOn(store, "setDigest").mockImplementationOnce(() => {
      throw new Error("digest write failed");
    });
    expect(backfillRuns({ config, store, now: NOW, budgetMs: 1500 })).toEqual({
      folded: 1,
      left: 0,
      failed: 1,
    });
    expect(setDigest).toHaveBeenCalledTimes(1);
    expect(get(store, bad.id)).toEqual(bad);
  });

  it("lets a failure to mark a run done propagate, so the next tick retries it", () => {
    seed(1, 3 * DAY);
    vi.mocked(foldPath).mockImplementationOnce(() => {
      throw new Error("bad transcript");
    });
    vi.spyOn(store, "upsertRun").mockImplementation(() => {
      throw new Error("SQLITE_BUSY");
    });
    expect(() => backfillRuns({ config, store, now: NOW, budgetMs: 1500 })).toThrow("SQLITE_BUSY");
    vi.mocked(store.upsertRun).mockRestore();
    expect(store.countToFold(NOW - FOLD_WINDOW_MS)).toBe(1);
  });

  it("folds every complete line of a transcript truncated mid-line", () => {
    seed(1, 3 * DAY, {}, `${transcript(1)}{"type":"result","result":"Cut off`);
    expect(backfillRuns({ config, store, now: NOW, budgetMs: 1500 })).toEqual({
      folded: 1,
      left: 0,
      failed: 0,
    });
    expect(get(store, "shop-app-ta:1")).toMatchObject({
      summary: "Run 1 done. More text.",
      prs: [{ repo: "o/shop-app", number: 1001 }],
    });
  });

  it("leaves runs started within the fold window, and running runs, to the collectors", () => {
    seed(1, FOLD_WINDOW_MS - HOUR);
    seed(2, 3 * DAY, { endedAt: null, status: "running" });
    expect(backfillRuns({ config, store, now: NOW, budgetMs: 1500 })).toEqual({
      folded: 0,
      left: 0,
      failed: 0,
    });
    expect(foldedPaths()).toEqual([]);
    expect(get(store, "shop-app-ta:1")?.summary).toBeNull();
  });

  it("stores the digest of a run started within the digest retention, not of an older one", () => {
    seed(1, 10 * DAY);
    seed(2, 40 * DAY);
    backfillRuns({ config, store, now: NOW, budgetMs: 1500 });
    expect(store.digest("shop-app-ta:1")).toMatchObject({ model: "claude-opus-5-5" });
    expect(store.digest("shop-app-ta:2")).toBeNull();
    expect(get(store, "shop-app-ta:2")?.summary).toBe("Run 2 done. More text.");
  });

  it("marks a run of a loop that is no longer configured done without reading it", () => {
    const r = seed(1, 3 * DAY, { agentId: "gone-loop", id: "gone-loop:1" });
    expect(backfillRuns({ config, store, now: NOW, budgetMs: 1500 })).toEqual({
      folded: 1,
      left: 0,
      failed: 0,
    });
    expect(foldedPaths()).toEqual([]);
    expect(store.runs("gone-loop", 1)[0]).toEqual(r);
  });

  it("folds a crew seat's ended run like a loop's (it is not marked done unread)", () => {
    config.crew = {
      worktrees: join(dir, "crew"),
      maxSeats: 8,
      sessions: [
        {
          id: "mc",
          repoId: "shop-app",
          checkout: join(dir, "clone"),
          seats: [
            { id: "guido-1", role: "GUIDO", accountId: "claude-main", model: "haiku", area: [] },
          ],
        },
      ],
    };
    seed(1, 3 * DAY, { agentId: "guido-1", id: "guido-1:1" }, transcript(1), "crew");
    expect(backfillRuns({ config, store, now: NOW, budgetMs: 1500 })).toEqual({
      folded: 1,
      left: 0,
      failed: 0,
    });
    expect(foldedPaths()).toEqual([join(dir, "crew", "run-1.log")]);
    expect(store.runs("guido-1", 1)[0]).toMatchObject({ model: "claude-opus-5-5", costUsd: 0.5 });
  });

  it("resumes from the database after a restart", () => {
    for (let n = 1; n <= 30; n++) seed(n, 2 * DAY + n * HOUR);
    expect(withRunClock(store)()).toEqual({ folded: 15, left: 15, failed: 0 });
    const reopened = new Store(dbPath);
    expect(withRunClock(reopened)()).toEqual({ folded: 15, left: 0, failed: 0 });
    const paths = foldedPaths();
    expect(paths).toHaveLength(30);
    expect(new Set(paths).size).toBe(30);
  });
});

describe("rewriteCrewSummaries", () => {
  beforeEach(() => {
    config.crew = {
      worktrees: join(dir, "crew"),
      maxSeats: 8,
      sessions: [
        {
          id: "mc",
          repoId: "shop-app",
          checkout: join(dir, "clone"),
          seats: [
            { id: "guido-1", role: "GUIDO", accountId: "claude-main", model: "haiku", area: [] },
          ],
        },
      ],
    };
  });

  const crewRun = (n: number, over: Partial<Run> = {}, text?: string) =>
    seed(
      n,
      3 * DAY + n * HOUR,
      { agentId: "guido-1", id: `guido-1:${n}`, summary: "DONE.", ...over },
      text ?? transcript(n).replace("Run", "DONE. The draft PR is up. Run"),
      "crew",
    );
  const summaryOf = (id: string) => store.runs("guido-1", 100).find((r) => r.id === id)?.summary;

  it("gives a past crew run, already folded with a DONE summary, the new one; a second run changes nothing", () => {
    const r = crewRun(1);
    store.upsertRun(r, true); // folded: nothing refolds it
    expect(rewriteCrewSummaries({ config, store, budgetMs: 1500 })).toEqual({
      rewritten: 1,
      done: true,
    });
    expect(summaryOf("guido-1:1")).toBe("The draft PR is up. Run 1 done. More text.");
    expect(store.getSetting(SUMMARY_REWRITE_DONE)).not.toBeNull();
    // Changed back by hand: a later call must not touch it.
    store.setRunSummary("guido-1:1", "kept");
    expect(rewriteCrewSummaries({ config, store, budgetMs: 1500 })).toEqual({
      rewritten: 0,
      done: true,
    });
    expect(summaryOf("guido-1:1")).toBe("kept");
  });

  it("leaves loop runs, running runs and runs whose transcript is gone as they are", () => {
    seed(1, 3 * DAY, { summary: "DONE." }); // shop-app-ta, a loop
    crewRun(2, { endedAt: null });
    crewRun(3, { transcriptPath: join(dir, "t", "nope.log") });
    crewRun(4, { summary: null }, "");
    expect(rewriteCrewSummaries({ config, store, budgetMs: 1500 })).toMatchObject({
      rewritten: 0,
      done: true,
    });
    expect(get(store, "shop-app-ta:1")?.summary).toBe("DONE.");
    expect(summaryOf("guido-1:2")).toBe("DONE.");
    expect(summaryOf("guido-1:3")).toBe("DONE.");
  });

  it("is bounded by its budget and continues where it stopped, across a restart", () => {
    for (let n = 1; n <= 30; n++) crewRun(n);
    let t = 0;
    const clock = () => t;
    const setSummary = store.setRunSummary.bind(store);
    vi.spyOn(store, "setRunSummary").mockImplementation((id, s) => {
      t += 100;
      setSummary(id, s);
    });
    expect(rewriteCrewSummaries({ config, store, budgetMs: 1500, clock })).toEqual({
      rewritten: 15,
      done: false,
    });
    expect(store.getSetting(SUMMARY_REWRITE_DONE)).toBeNull();
    const first = foldedPaths();
    expect(first).toHaveLength(15);
    vi.mocked(foldPath).mockClear();
    const reopened = new Store(dbPath);
    expect(rewriteCrewSummaries({ config, store: reopened, budgetMs: 1500 })).toEqual({
      rewritten: 15,
      done: true,
    });
    // The cursor, not the equal summaries, is what stops a run being read twice.
    const second = foldedPaths();
    expect(second).toHaveLength(15);
    expect(second.filter((p) => first.includes(p))).toEqual([]);
    for (let n = 1; n <= 30; n++) expect(summaryOf(`guido-1:${n}`)).not.toBe("DONE.");
  });

  it("is not marked done when the config has no crew seats", () => {
    crewRun(1);
    config.crew = undefined;
    expect(rewriteCrewSummaries({ config, store, budgetMs: 1500 })).toEqual({
      rewritten: 0,
      done: true,
    });
    expect(store.getSetting(SUMMARY_REWRITE_DONE)).toBeNull();
    expect(foldedPaths()).toEqual([]);
  });

  it("reads only inside the crew transcript dir, not a path stored in the DB", () => {
    crewRun(1, { transcriptPath: join(dir, "t", "outside.log") });
    writeFileSync(
      join(dir, "t", "outside.log"),
      transcript(1).replace("Run", "DONE. Outside. Run"),
    );
    writeFileSync(join(dir, "t", "target.log"), transcript(2).replace("Run", "DONE. Linked. Run"));
    symlinkSync(join(dir, "t", "target.log"), join(dir, "crew", "link.log"));
    crewRun(2, { transcriptPath: join(dir, "crew", "link.log") });
    crewRun(3, { transcriptPath: join(dir, "crew", "..", "t", "outside.log") });
    expect(rewriteCrewSummaries({ config, store, budgetMs: 1500 })).toMatchObject({
      rewritten: 0,
      done: true,
    });
    expect(foldedPaths()).toEqual([]);
    expect(summaryOf("guido-1:1")).toBe("DONE.");
    expect(summaryOf("guido-1:2")).toBe("DONE.");
    expect(summaryOf("guido-1:3")).toBe("DONE.");
  });

  it("backfillRuns marks a crew run with a transcript outside the crew dir folded, unread", () => {
    crewRun(1, { transcriptPath: join(dir, "t", "outside.log") });
    writeFileSync(join(dir, "t", "outside.log"), transcript(1));
    expect(backfillRuns({ config, store, now: NOW, budgetMs: 1500 })).toMatchObject({ left: 0 });
    expect(foldedPaths()).toEqual([]);
    expect(summaryOf("guido-1:1")).toBe("DONE.");
  });

  it("refreshes a kept digest from the transcript", () => {
    crewRun(1);
    store.setDigest("guido-1:1", {
      ...foldPath(new Map(), join(dir, "crew", "run-1.log"))?.digest,
      lastText: "DONE.",
    } as RunDigest);
    rewriteCrewSummaries({ config, store, budgetMs: 1500 });
    expect(store.digest("guido-1:1")?.lastText).not.toBe("DONE.");
  });
});

describe("fillTicketTitles", () => {
  beforeEach(() => {
    config.crew = {
      worktrees: join(dir, "crew"),
      maxSeats: 8,
      sessions: [
        {
          id: "mc",
          repoId: "shop-app",
          checkout: join(dir, "clone"),
          seats: [
            { id: "guido-1", role: "GUIDO", accountId: "claude-main", model: "haiku", area: [] },
          ],
        },
      ],
    };
  });

  const crewRun = (n: number, over: Partial<Run> = {}) =>
    seed(n, 3 * DAY + n * HOUR, { agentId: "guido-1", id: `guido-1:${n}`, ...over });
  const titleOf = (id: string) => store.runs("guido-1", 100).find((r) => r.id === id)?.ticketTitle;

  it("fills a null title from GitHub for each ticket once, and is done after", async () => {
    crewRun(1, { ticket: "shop-app#7" });
    crewRun(2, { ticket: "shop-app#7" });
    crewRun(3, { ticket: "shop-app#8", ticketTitle: "Kept" });
    crewRun(4, { ticket: "shop-app#9" }); // GitHub has no such issue
    crewRun(5, { ticket: "other#1" }); // not a configured repo
    crewRun(6); // no ticket
    const fetchTicket = vi.fn(async (_repo: unknown, n: number) =>
      n === 9 ? null : { title: `Title ${n}` },
    );
    expect(await fillTicketTitles({ config, store, fetchTicket })).toEqual({
      filled: 2,
      done: true,
    });
    expect(titleOf("guido-1:1")).toBe("Title 7");
    expect(titleOf("guido-1:2")).toBe("Title 7");
    expect(titleOf("guido-1:3")).toBe("Kept");
    expect(titleOf("guido-1:4")).toBeUndefined();
    expect(fetchTicket).toHaveBeenCalledTimes(2); // #7 once for both runs, and #9
    expect(store.getSetting(TITLES_FILLED_DONE)).not.toBeNull();
    await fillTicketTitles({ config, store, fetchTicket });
    expect(fetchTicket).toHaveBeenCalledTimes(2);
  });

  it("is bounded per call and continues where it stopped; a failed read is retried", async () => {
    for (let n = 1; n <= 5; n++) crewRun(n, { ticket: `shop-app#${n}` });
    const fetchTicket = vi.fn(async (_repo: unknown, n: number) => {
      if (n === 3) throw new Error("rate limited");
      return { title: `T${n}` };
    });
    expect(await fillTicketTitles({ config, store, fetchTicket, max: 2 })).toEqual({
      filled: 2,
      done: false,
    });
    expect(await fillTicketTitles({ config, store, fetchTicket, max: 5 })).toEqual({
      filled: 0,
      done: false,
    });
    expect(titleOf("guido-1:3")).toBeUndefined();
    fetchTicket.mockImplementation(async (_repo: unknown, n: number) => ({ title: `T${n}` }));
    expect(await fillTicketTitles({ config, store, fetchTicket, max: 5 })).toEqual({
      filled: 3,
      done: true,
    });
    for (let n = 1; n <= 5; n++) expect(titleOf(`guido-1:${n}`)).toBe(`T${n}`);
  });

  it("is not marked done when the config has no crew seats", async () => {
    crewRun(1, { ticket: "shop-app#7" });
    config.crew = undefined;
    const fetchTicket = vi.fn(async () => ({ title: "x" }));
    expect(await fillTicketTitles({ config, store, fetchTicket })).toEqual({
      filled: 0,
      done: true,
    });
    expect(store.getSetting(TITLES_FILLED_DONE)).toBeNull();
    expect(fetchTicket).not.toHaveBeenCalled();
  });
});
