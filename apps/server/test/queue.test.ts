import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoardItem,
  freezeRules,
  NEW_LOOP,
  QUEUE_DEPTH,
  type RepoRules,
  type Run,
  type SeatState,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CardNow } from "../src/collectors/github.ts";
import type { CcConfig } from "../src/config.ts";
import {
  dealQueues,
  refillQueues,
  seatMayTake,
  type TakeDeps,
  takeNext,
} from "../src/engine/queue.ts";
import { RepoRulesError } from "../src/engine/rules.ts";
import { CheckoutError } from "../src/runtime/checkouts.ts";
import { SupervisorError } from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-21T12:00:00Z");
const DAY = 24 * 60 * 60_000;
const REPO = "mc";
const SERVER = "guido-1";
const WEB = "inco-1";

const RULES: RepoRules = freezeRules({
  pickFrom: ["Ready"],
  promoteBacklog: false,
  areas: {
    "area:server": ["apps/server/**"],
    "area:web": ["apps/web/**"],
    "area:core": ["packages/core/**"],
  },
  hardRules: [],
  alwaysAsk: [],
});

let dir: string;
let store: Store;
let config: CcConfig;
let rules: RepoRules | RepoRulesError;
let started: { seatId: string; issue: number; loop: unknown }[];
/** The error a start of this issue throws, if any. */
let startFails: (issue: number) => Error | null;
let noteCalls: number;
let enabled: boolean;
let logs: string[];
let transientTakes: Map<string, number>;
/** This hub's login. */
const ME = "me";
/** What the fresh read of a card finds; by default the stored card as it is. */
let fresh: (issue: number) => CardNow | null;
let readFails: boolean;
let myLogin: string | null;

function makeConfig(autonomy: "merge" | "draft" = "merge"): CcConfig {
  return {
    operator: { id: "op", timezone: "Europe/London" },
    accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
    repos: [{ id: REPO, github: "o/mc", project: 1, statusMap: {}, autonomy }],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    crew: {
      worktrees: join(dir, "worktrees"),
      maxSeats: 8,
      sessions: [
        {
          id: "mc-crew",
          repoId: REPO,
          checkout: join(dir, "clone"),
          seats: [
            {
              id: SERVER,
              role: "GUIDO",
              accountId: "claude-main",
              model: "haiku",
              area: ["apps/server/**", "packages/core/**"],
            },
            {
              id: WEB,
              role: "INCO",
              accountId: "claude-main",
              model: "haiku",
              area: ["apps/web/**"],
            },
            { id: "retro", role: "RETRO", accountId: "claude-main", model: "haiku", area: [] },
          ],
        },
      ],
    },
  } as CcConfig;
}

const card = (n: number, over: Partial<BoardItem> = {}): BoardItem => ({
  repoId: REPO,
  issueNumber: n,
  title: `Ticket ${n}`,
  status: "Ready",
  state: "planned",
  labels: ["area:server"],
  assignees: [],
  priority: null,
  updatedAt: NOW,
  url: "u",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: null,
  closed: false,
  prioritySource: null,
  // a lower number is older
  createdAt: NOW - DAY + n * 1000,
  itemId: `I${n}`,
  projectId: "P1",
  ...over,
});

const refill = (rulesOf: () => Promise<RepoRules | RepoRulesError> = async () => rules) =>
  refillQueues({
    config,
    store,
    rules: rulesOf,
    login: ME,
    now: () => NOW,
    onNotes: () => void noteCalls++,
  });
const takeDeps = (): TakeDeps => ({
  config,
  store,
  enabled,
  login: myLogin,
  readCard: async (_repoId, issue) => {
    if (readFails) throw new Error("GitHub is down");
    return fresh(issue);
  },
  transientTakes,
  now: () => NOW,
  log: (l) => logs.push(l),
  onNotes: () => void noteCalls++,
  supervisor: {
    async startRun(seatId, issue, opts) {
      const fail = startFails(issue);
      if (fail !== null) throw fail;
      started.push({ seatId, issue, loop: opts?.loop });
      return { runId: `${seatId}:1`, branch: "b" };
    },
  },
});
const take = (seatId = SERVER) => takeNext(takeDeps(), seatId);
const issues = (seatId: string) => store.queue(seatId).map((q) => q.issue);

const seatRow = (state: SeatState, runId: string | null = null) =>
  store.setSeatSession({
    seatId: SERVER,
    runId,
    cliSessionId: "cli",
    state,
    reason: null,
    worktree: null,
    updatedAt: NOW,
  });

const run = (over: Partial<Run>): Run => ({
  id: "guido-2:1",
  agentId: "guido-2",
  repoId: REPO,
  seq: 1,
  startedAt: NOW - 1000,
  endedAt: null,
  status: "running",
  sessionId: "s",
  model: "haiku",
  branch: "feature/1-x",
  ticket: `${REPO}#1`,
  ticketTitle: "x",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-queue-"));
  store = new Store(join(dir, "mc.sqlite"));
  config = makeConfig();
  rules = RULES;
  started = [];
  startFails = () => null;
  noteCalls = 0;
  enabled = true;
  logs = [];
  transientTakes = new Map();
  readFails = false;
  myLogin = ME;
  fresh = (issue) => {
    const c = store.board(REPO).find((x) => x.issueNumber === issue);
    return c === undefined ? null : c;
  };
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("refillQueues", () => {
  it("leaves out a Ready card assigned to another login and keeps one assigned to the hub", async () => {
    store.replaceBoard(REPO, [
      card(1, { assignees: ["other"] }),
      card(2, { assignees: [ME] }),
      card(3, { assignees: [ME, "other"] }),
      card(4),
    ]);
    await refill();
    expect(issues(SERVER)).toEqual([2, 4]);
  });

  it("queues a Ready area:server card for the server seat only", async () => {
    store.replaceBoard(REPO, [card(1)]);
    await refill();
    expect(issues(SERVER)).toEqual([1]);
    expect(issues(WEB)).toEqual([]);
    expect(issues("retro")).toEqual([]);
  });

  it("queues each area's card for the seat whose area holds it", async () => {
    store.replaceBoard(REPO, [
      card(1),
      card(2, { labels: ["area:web"] }),
      card(3, { labels: ["area:core"] }),
    ]);
    await refill();
    expect(issues(SERVER)).toEqual([1, 3]);
    expect(issues(WEB)).toEqual([2]);
  });

  it("skips a card with no area label, a card that is not Ready and a closed one", async () => {
    store.replaceBoard(REPO, [
      card(1, { labels: [] }),
      card(2, { status: "In progress", state: "in progress" }),
      card(3, { status: "Blocked", state: "blocked" }),
      card(4, { closed: true }),
      card(5, { labels: ["bug"] }),
      card(6),
    ]);
    await refill();
    expect(issues(SERVER)).toEqual([6]);
  });

  it("queues no card with two area labels, and raises one question, cleared when it is relabelled", async () => {
    store.replaceBoard(REPO, [card(1, { labels: ["area:server", "area:web"] })]);
    await refill();
    await refill();
    expect(issues(SERVER)).toEqual([]);
    expect(issues(WEB)).toEqual([]);
    expect(store.notes().map((n) => [n.key, n.kind, n.text, n.repoId])).toEqual([
      [
        `question:two-areas:${REPO}#1`,
        "question",
        "mc#1 spans two areas (area:server, area:web); split it",
        REPO,
      ],
    ]);
    store.replaceBoard(REPO, [card(1)]);
    await refill();
    expect(store.notes()).toEqual([]);
    expect(issues(SERVER)).toEqual([1]);
  });

  it("clears the two-areas question when the card leaves Ready", async () => {
    store.replaceBoard(REPO, [card(1, { labels: ["area:server", "area:web"] })]);
    await refill();
    expect(store.notes()).toHaveLength(1);
    store.replaceBoard(REPO, [
      card(1, { labels: ["area:server", "area:web"], status: "In progress", state: "in progress" }),
    ]);
    await refill();
    expect(store.notes()).toEqual([]);
  });

  it("skips a research ticket", async () => {
    store.replaceBoard(REPO, [card(1, { labels: ["area:server", "research"] }), card(2)]);
    await refill();
    expect(issues(SERVER)).toEqual([2]);
  });

  it("orders by Priority P0, P1, P2, unset, then by age", async () => {
    store.replaceBoard(REPO, [
      card(1, { priority: null, createdAt: NOW - 9 * DAY }),
      card(2, { priority: "P2", createdAt: NOW - 8 * DAY }),
      card(3, { priority: "P1", createdAt: NOW - 1 * DAY }),
      card(4, { priority: "P1", createdAt: NOW - 5 * DAY }),
      card(5, { priority: "P0", createdAt: NOW - 2 * DAY }),
    ]);
    await refill();
    expect(issues(SERVER)).toEqual([5, 4, 3]);
    expect(QUEUE_DEPTH).toBe(3);
    // the next three in the order, were the first ones gone
    store.replaceBoard(REPO, [
      card(1, { priority: null, createdAt: NOW - 9 * DAY }),
      card(2, { priority: "P2", createdAt: NOW - 8 * DAY }),
    ]);
    await refill();
    expect(issues(SERVER)).toEqual([2, 1]);
  });

  it("leaves out the ticket of an active run", async () => {
    store.upsertRun(run({ ticket: `${REPO}#1` }));
    store.replaceBoard(REPO, [card(1), card(2)]);
    await refill();
    expect(issues(SERVER)).toEqual([2]);
    store.upsertRun(run({ endedAt: NOW, status: "ok" }));
    await refill();
    expect(issues(SERVER)).toEqual([1, 2]);
  });

  it("keeps a taken row at the head and puts the rest after it", async () => {
    store.replaceBoard(REPO, [card(1), card(2)]);
    await refill();
    store.takeQueued(SERVER, NOW);
    store.replaceBoard(REPO, [card(1), card(2), card(3)]);
    await refill();
    expect(issues(SERVER)).toEqual([1, 2, 3]);
    expect(store.queue(SERVER)[0]?.takenAt).toBe(NOW);
  });

  it("queues a card for one seat only when two seats' areas hold it", async () => {
    config.crew?.sessions[0]?.seats.push({
      id: "guido-2",
      role: "GUIDO",
      accountId: "claude-main",
      model: "haiku",
      area: [],
    });
    store.replaceBoard(REPO, [card(1), card(2)]);
    await refill();
    await refill();
    const both = [...issues(SERVER), ...issues("guido-2")].sort();
    expect(both).toEqual([1, 2]);
  });

  describe("with a second seat in the same area", () => {
    beforeEach(() => {
      const first = config.crew?.sessions[0]?.seats[0];
      if (first === undefined) throw new Error("no seat");
      config.crew?.sessions[0]?.seats.push({ ...first, id: "guido-2" });
    });

    it("deals a shared area round-robin", async () => {
      store.replaceBoard(REPO, [card(1), card(2)]);
      await refill();
      expect(issues(SERVER)).toEqual([1]);
      expect(issues("guido-2")).toEqual([2]);
    });

    it("deals an idle seat before a busy one", async () => {
      store.upsertRun(run({ id: "r9", agentId: SERVER, ticket: `${REPO}#9` }));
      seatRow("running", "r9");
      store.replaceBoard(REPO, [card(1), card(2)]);
      await refill();
      expect(issues("guido-2")).toEqual([1]);
      expect(issues(SERVER)).toEqual([2]);
    });

    it("never deals one card to two seats, and leaves a taken card with its taker", async () => {
      store.replaceBoard(REPO, [card(1), card(2), card(3), card(4)]);
      await refill();
      expect(issues(SERVER)).toEqual([1, 3]);
      expect(issues("guido-2")).toEqual([2, 4]);
      store.takeQueued(SERVER, NOW);
      await refill();
      expect(issues(SERVER)).toEqual([1, 2, 4]);
      expect(store.queue(SERVER)[0]?.takenAt).toBe(NOW);
      expect(issues("guido-2")).toEqual([3]);
    });
  });

  it("dealQueues deals in turn, skips a seat without the label, and stops at the depth", () => {
    const hands = dealQueues(
      [
        { id: "a", labels: ["x"] },
        { id: "b", labels: ["x", "y"] },
      ],
      [
        { issue: 1, label: "x" },
        { issue: 2, label: "y" },
        { issue: 3, label: "x" },
        { issue: 4, label: "x" },
        { issue: 5, label: "x" },
      ],
      2,
    );
    expect(hands.get("a")).toEqual([1, 3]);
    expect(hands.get("b")).toEqual([2, 4]);
  });

  it("does nothing for a draft repo", async () => {
    config = makeConfig("draft");
    store.replaceBoard(REPO, [card(1), card(2, { labels: ["area:server", "area:web"] })]);
    await refill();
    expect(issues(SERVER)).toEqual([]);
    expect(store.notes()).toEqual([]);
  });

  it("builds no queue while the repo's rules cannot be read, and leaves what is queued", async () => {
    store.replaceBoard(REPO, [card(1)]);
    await refill();
    rules = new RepoRulesError("bad block");
    store.replaceBoard(REPO, [card(1), card(2)]);
    await refill();
    expect(issues(SERVER)).toEqual([1]);
  });
});

describe("takeNext", () => {
  const queued = async (...cards: BoardItem[]) => {
    store.replaceBoard(REPO, cards);
    await refill();
  };

  it("starts nothing when the fresh read finds the card In progress, and untakes the row", async () => {
    await queued(card(1));
    fresh = () => ({ status: "In progress", state: "in progress", closed: false, assignees: [] });
    await take();
    expect(started).toEqual([]);
    expect(store.queue(SERVER).map((q) => [q.issue, q.takenAt])).toEqual([[1, null]]);
  });

  it("starts nothing when the fresh read finds another login assigned", async () => {
    await queued(card(1));
    fresh = () => ({ status: "Ready", state: "planned", closed: false, assignees: ["other"] });
    await take();
    expect(started).toEqual([]);
    expect(store.queue(SERVER).map((q) => q.takenAt)).toEqual([null]);
  });

  it("starts nothing when the fresh read finds no card, or cannot be made", async () => {
    await queued(card(1));
    fresh = () => null;
    await take();
    expect(started).toEqual([]);
    readFails = true;
    await take();
    expect(started).toEqual([]);
    expect(store.queue(SERVER).map((q) => q.takenAt)).toEqual([null]);
  });

  it("starts a card the fresh read finds Ready and assigned to the hub", async () => {
    await queued(card(1));
    fresh = () => ({ status: "Ready", state: "planned", closed: false, assignees: [ME] });
    await take();
    expect(started).toHaveLength(1);
  });

  it("starts nothing when the hub does not know its own login", async () => {
    await queued(card(1));
    myLogin = null;
    await take();
    expect(started).toEqual([]);
  });

  it("starts the head of the queue as a looped run and drops the row", async () => {
    await queued(card(1), card(2));
    await take();
    expect(started).toEqual([{ seatId: SERVER, issue: 1, loop: NEW_LOOP }]);
    expect(issues(SERVER)).toEqual([2]);
  });

  it("counts a seat with no seat row as idle", async () => {
    expect(store.seatSession(SERVER)).toBeNull();
    await queued(card(1));
    await take();
    expect(started).toHaveLength(1);
  });

  it("takes for an idle seat whose last run has ended", async () => {
    store.upsertRun(run({ id: "r-old", agentId: SERVER, ticket: `${REPO}#9`, endedAt: NOW }));
    seatRow("idle", "r-old");
    await queued(card(1));
    await take();
    expect(started).toHaveLength(1);
  });

  it("rework first: an idle seat with a run waiting on rework takes nothing", async () => {
    const aside = (wake: boolean) => ({ ...NEW_LOOP, aside: { worktree: "/w/x", wake } });
    store.upsertRun(
      run({ id: "r-aside", agentId: SERVER, ticket: `${REPO}#9`, loop: aside(false) }),
    );
    seatRow("idle");
    await queued(card(1));
    // a run in review, nothing due: the seat is free
    expect(seatMayTake(store, SERVER)).toBe(true);
    store.setRunLoop("r-aside", aside(true));
    expect(seatMayTake(store, SERVER)).toBe(false);
    await take();
    expect(started).toEqual([]);
    expect(store.queue(SERVER)[0]?.takenAt).toBeNull();
    // another seat's rework does not hold this one
    store.upsertRun(run({ id: "r-other", agentId: WEB, ticket: `${REPO}#8`, loop: aside(true) }));
    store.setRunLoop("r-aside", aside(false));
    expect(seatMayTake(store, SERVER)).toBe(true);
  });

  it.each(["stopped", "error", "starting", "running", "parked"] as const)(
    "never takes for a %s seat",
    async (state) => {
      await queued(card(1));
      seatRow(state);
      await take();
      expect(started).toEqual([]);
      expect(store.queue(SERVER)[0]?.takenAt).toBeNull();
    },
  );

  it("never takes for an idle seat that holds a live run", async () => {
    store.upsertRun(run({ id: "r-live", agentId: SERVER, ticket: `${REPO}#9` }));
    seatRow("idle", "r-live");
    await queued(card(1));
    await take();
    expect(started).toEqual([]);
  });

  it("takes nothing for a read-only seat or an unknown one", async () => {
    await queued(card(1));
    await take("retro");
    await take("nobody");
    expect(started).toEqual([]);
  });

  it("untakes and drops a ticket that has left Ready since the poll", async () => {
    await queued(card(1), card(2));
    store.replaceBoard(REPO, [card(1, { status: "Blocked", state: "blocked" }), card(2)]);
    await take();
    expect(started).toEqual([]);
    expect(issues(SERVER)).toEqual([2]);
    expect(store.queue(SERVER)[0]?.takenAt).toBeNull();
    // and a card that is gone from the board, or closed
    store.replaceBoard(REPO, [card(2, { closed: true })]);
    await take();
    expect(started).toEqual([]);
    expect(issues(SERVER)).toEqual([]);
  });

  it("gives the row back when the supervisor refuses the start", async () => {
    await queued(card(1));
    startFails = () => new SupervisorError(409, "GUIDO-1 already has a run");
    await take();
    expect(started).toEqual([]);
    expect(store.queue(SERVER).map((q) => [q.issue, q.takenAt])).toEqual([[1, null]]);
    expect(logs).toEqual(["guido-1: could not take mc#1: GUIDO-1 already has a run"]);
    startFails = () => null;
    await take();
    expect(started).toHaveLength(1);
  });

  it("does nothing for a draft repo", async () => {
    await queued(card(1));
    config = makeConfig("draft");
    await take();
    expect(started).toEqual([]);
    expect(store.queue(SERVER)[0]?.takenAt).toBeNull();
  });

  it("does nothing when disabled (a preview, or loop writes off)", async () => {
    await queued(card(1));
    enabled = false;
    await take();
    expect(started).toEqual([]);
  });

  it("does nothing when the account is at its quota stop in either window", async () => {
    await queued(card(1));
    for (const window of ["5h", "7d"] as const) {
      store.addUsage({
        accountId: "claude-main",
        window,
        at: NOW - 1000,
        pct: 95,
        resetAt: NOW + DAY,
        source: "test",
      });
      await take();
      expect(started).toEqual([]);
      store.addUsage({
        accountId: "claude-main",
        window,
        at: NOW - 500,
        pct: 40,
        resetAt: NOW + DAY,
        source: "test",
      });
    }
    await take();
    expect(started).toHaveLength(1);
  });

  it("ignores a quota sample whose window has reset", async () => {
    await queued(card(1));
    store.addUsage({
      accountId: "claude-main",
      window: "5h",
      at: NOW - DAY,
      pct: 99,
      resetAt: NOW - 1000,
      source: "test",
    });
    await take();
    expect(started).toHaveLength(1);
  });

  it("two seats, one card: one take", async () => {
    config.crew?.sessions[0]?.seats.push({
      id: "guido-2",
      role: "GUIDO",
      accountId: "claude-main",
      model: "haiku",
      area: [],
    });
    await queued(card(1));
    await Promise.all([take(SERVER), take("guido-2")]);
    expect(started.map((s) => s.issue)).toEqual([1]);
  });

  it("does not take twice while the first take is starting", async () => {
    await queued(card(1), card(2));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deps = takeDeps();
    deps.supervisor = {
      async startRun(seatId, issue, opts) {
        started.push({ seatId, issue, loop: opts?.loop });
        await gate;
        return { runId: "r", branch: "b" };
      },
    };
    const first = takeNext(deps, SERVER);
    await takeNext(deps, SERVER);
    release();
    await first;
    expect(started.map((s) => s.issue)).toEqual([1]);
  });

  it("untakes and drops a head that is gone from the board", async () => {
    await queued(card(1), card(2));
    store.replaceBoard(REPO, [card(2)]);
    await take();
    expect(started).toEqual([]);
    expect(issues(SERVER)).toEqual([2]);
    expect(store.queue(SERVER)[0]?.takenAt).toBeNull();
  });

  it("counts an unknown run in an idle seat's row as live", async () => {
    seatRow("idle", "no-such-run");
    await queued(card(1));
    await take();
    expect(started).toEqual([]);
  });

  it("drops a ticket another seat was started on since the queue was built", async () => {
    await queued(card(1), card(2));
    // The operator hand-started guido-2 on it; the board has not been polled since
    store.upsertRun(run({ ticket: `${REPO}#1` }));
    await take();
    expect(started).toEqual([]);
    expect(issues(SERVER)).toEqual([2]);
    await take();
    expect(started.map((s) => s.issue)).toEqual([2]);
  });

  describe("a start that fails", () => {
    const worktreeClash = () =>
      new CheckoutError(
        "path",
        "the worktree path for guido-1-1 exists and is not this ticket's checkout",
        {
          detail: "/w/guido-1-1",
        },
      );

    it("drops a card that fails for its own sake, notes it, and takes the rest", async () => {
      await queued(card(1), card(2), card(3));
      startFails = (issue) => (issue === 1 ? worktreeClash() : null);
      await take();
      expect(started).toEqual([]);
      expect(issues(SERVER)).toEqual([2, 3]);
      expect(store.notes().map((n) => [n.key, n.kind, n.seatId, n.repoId, n.text])).toEqual([
        [
          "question:take-failed:mc#1",
          "question",
          SERVER,
          REPO,
          "GUIDO-1 could not start mc#1: the worktree path for guido-1-1 exists and is not this ticket's checkout. Fix that, then move the card out of Ready and back.",
        ],
      ]);
      expect(store.notes()[0]?.text).not.toContain("/w/");
      expect(logs).toEqual([
        `guido-1: dropped ${REPO}#1: the worktree path for guido-1-1 exists and is not this ticket's checkout (/w/guido-1-1)`,
      ]);
      expect(noteCalls).toBe(1);
      await take();
      expect(started.map((s) => s.issue)).toEqual([2]);
      await take();
      expect(started.map((s) => s.issue)).toEqual([2, 3]);
    });

    it("treats an unknown issue and a protected branch as the card's own", async () => {
      await queued(card(1), card(2));
      startFails = (issue) =>
        issue === 1
          ? new SupervisorError(404, "unknown issue")
          : new CheckoutError(
              "protected",
              "branch feature/2-x changes package.json; Mission Control won't install from it",
            );
      await take();
      await take();
      expect(issues(SERVER)).toEqual([]);
      expect(store.notes().map((n) => n.key)).toEqual([
        "question:take-failed:mc#1",
        "question:take-failed:mc#2",
      ]);
    });

    it("retries what is the machine's: a busy seat, GitHub, the fetch, the install, anything else", async () => {
      for (const err of [
        new SupervisorError(409, "busy"),
        new SupervisorError(502, "could not read o/mc#1 from GitHub"),
        new CheckoutError("fetch", "could not fetch"),
        new CheckoutError("checkout", "the crew checkout is missing"),
        new CheckoutError("install", "pnpm install failed for b (ERR_PNPM_META_FETCH_FAIL)"),
        new CheckoutError("install", "pnpm install failed for b (timed out)"),
        new CheckoutError("base", "could not read origin's default branch"),
        new CheckoutError("worktree", "git worktree add failed"),
        new Error("fatal: not a git repository"),
      ]) {
        transientTakes.clear();
        await queued(card(1));
        startFails = () => err;
        await take();
        expect(store.queue(SERVER).map((q) => [q.issue, q.takenAt])).toEqual([[1, null]]);
        expect(store.notes().filter((n) => n.key.startsWith("question:take-failed:"))).toEqual([]);
      }
    });

    it("keeps every card when the install always fails, and raises one note for the seat", async () => {
      store.replaceBoard(
        REPO,
        [1, 2, 3, 4, 5, 6].map((n) => card(n)),
      );
      startFails = () => new CheckoutError("install", "pnpm install failed for b (timed out)");
      for (let i = 0; i < 10; i++) {
        await refill();
        await take();
      }
      expect(started).toEqual([]);
      expect(issues(SERVER)).toEqual([1, 2, 3]);
      expect(store.notes().map((n) => n.key)).toEqual(["question:take-stuck:guido-1"]);
    });

    describe("a seat whose takes keep failing", () => {
      const checkoutMissing = () =>
        new CheckoutError("checkout", "the crew checkout is missing or has uncommitted changes");

      it("raises one note on the third failure in a row, and clears it on a success", async () => {
        await queued(card(1));
        startFails = () => checkoutMissing();
        await take();
        await take();
        expect(store.notes()).toEqual([]);
        await take();
        expect(store.notes().map((n) => n.text)).toEqual([
          "GUIDO-1 has failed to take a ticket 3 times in a row: the crew checkout is missing or has uncommitted changes. It keeps trying each tick; this clears when a take succeeds.",
        ]);
        expect(noteCalls).toBe(1);
        await take();
        expect(noteCalls).toBe(1);
        startFails = () => null;
        await take();
        expect(store.notes()).toEqual([]);
        expect(noteCalls).toBe(2);
      });

      it("counts neither a busy seat", async () => {
        await queued(card(1));
        startFails = () => new SupervisorError(409, "busy");
        for (let i = 0; i < 5; i++) await take();
        expect(store.notes()).toEqual([]);
      });

      it("nor a CLI that would not start, which the seat shows itself", async () => {
        await queued(card(1));
        startFails = () => new SupervisorError(500, "could not start the CLI");
        for (let i = 0; i < 4; i++) await take();
        expect(store.queue(SERVER).map((q) => [q.issue, q.takenAt])).toEqual([[1, null]]);
        expect(store.notes()).toEqual([]);
        expect(noteCalls).toBe(0);
      });

      it("keeps raw error text out of the note and puts it in the log", async () => {
        await queued(card(1));
        startFails = () => new Error("fatal: /Users/x/secret-path");
        for (let i = 0; i < 3; i++) await take();
        const text = store.notes()[0]?.text ?? "";
        expect(text).toContain("crew action failed (Error)");
        expect(text).not.toContain("/Users/x");
        expect(logs[0]).toBe(
          `guido-1: could not take ${REPO}#1: crew action failed (Error): fatal: /Users/x/secret-path`,
        );
      });

      it("clears when the repo is no longer taken by rule", async () => {
        await queued(card(1));
        startFails = () => checkoutMissing();
        for (let i = 0; i < 3; i++) await take();
        expect(store.notes()).toHaveLength(1);
        config = makeConfig("draft");
        await refill();
        expect(store.notes()).toEqual([]);
      });
    });

    it("deals a card again when it was moved out of Ready and back since its failure", async () => {
      await queued(card(1), card(2));
      startFails = (issue) => (issue === 1 ? worktreeClash() : null);
      await take();
      await refill();
      expect(issues(SERVER)).toEqual([2]);
      store.replaceBoard(REPO, [card(1, { updatedAt: NOW + 30_000 }), card(2)]);
      await refill();
      expect(store.notes()).toEqual([]);
      expect(issues(SERVER)).toEqual([1, 2]);
    });

    it("keeps the dropped card out of later refills until it leaves Ready, then clears the note", async () => {
      await queued(card(1), card(2));
      startFails = (issue) => (issue === 1 ? worktreeClash() : null);
      await take();
      await refill();
      expect(issues(SERVER)).toEqual([2]);
      expect(store.notes()).toHaveLength(1);
      store.replaceBoard(REPO, [card(1, { status: "In progress", state: "in progress" }), card(2)]);
      await refill();
      expect(store.notes()).toEqual([]);
      store.replaceBoard(REPO, [card(1), card(2)]);
      await refill();
      expect(issues(SERVER)).toEqual([1, 2]);
    });
  });
});

describe("refillQueues: notes and races", () => {
  it("queues nothing for a card with three area labels and names all three", async () => {
    store.replaceBoard(REPO, [card(1, { labels: ["area:server", "area:web", "area:core"] })]);
    await refill();
    expect(issues(SERVER)).toEqual([]);
    expect(store.notes().map((n) => n.text)).toEqual([
      "mc#1 spans two areas (area:server, area:web, area:core); split it",
    ]);
  });

  it("skips the type:research label the setup creates", async () => {
    store.replaceBoard(REPO, [card(1, { labels: ["area:server", "type:research"] }), card(2)]);
    await refill();
    expect(issues(SERVER)).toEqual([2]);
  });

  it("does not queue a ticket whose run began while the rules were being read", async () => {
    store.replaceBoard(REPO, [card(1), card(2)]);
    await refill(async () => {
      store.upsertRun(run({ ticket: `${REPO}#1` }));
      return rules;
    });
    expect(issues(SERVER)).toEqual([2]);
  });

  it("calls onNotes when a note is raised or cleared, not on every pass while it stays", async () => {
    store.replaceBoard(REPO, [card(1, { labels: ["area:server", "area:web"] })]);
    await refill();
    expect(noteCalls).toBe(1);
    await refill();
    await refill();
    expect(noteCalls).toBe(1);
    store.replaceBoard(REPO, [card(1)]);
    await refill();
    expect(noteCalls).toBe(2);
    await refill();
    expect(noteCalls).toBe(2);
  });

  describe("the two-areas question when the repo is out of reach", () => {
    const raised = async () => {
      store.replaceBoard(REPO, [card(1, { labels: ["area:server", "area:web"] })]);
      await refill();
      expect(store.notes()).toHaveLength(1);
    };

    it("clears when the repo leaves merge", async () => {
      await raised();
      config = makeConfig("draft");
      await refill();
      expect(store.notes()).toEqual([]);
    });

    it("clears when no crew session covers the repo", async () => {
      await raised();
      config = {
        ...config,
        crew: { ...(config.crew as NonNullable<CcConfig["crew"]>), sessions: [] },
      };
      await refill();
      expect(store.notes()).toEqual([]);
    });

    it("keeps while the rules cannot be read, and decides when they can", async () => {
      await raised();
      rules = new RepoRulesError("bad block");
      await refill();
      expect(store.notes()).toHaveLength(1);
      rules = RULES;
      store.replaceBoard(REPO, [card(1)]);
      await refill();
      expect(store.notes()).toEqual([]);
    });
  });
});
