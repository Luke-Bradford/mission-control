import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  asideEventText,
  asideInCiEventText,
  type BoardItem,
  cleanupBranchNoteKey,
  closedIssueText,
  DEFAULT_PROFILES,
  DEFAULT_REPO_RULES,
  deletedLocalText,
  deletedRemoteText,
  ENGINE_TICK_MS,
  EVIDENCE_RULING_PREFIX,
  fixSentText,
  globMatches,
  hardRulesBySettingKey,
  hardRulesUnsetNoteKey,
  hardRulesUnsetText,
  localNotDeletedText,
  MC_PR_UNCLOSED,
  MC_PUSH_FAILED,
  MC_PUSH_MERGE,
  MC_PUSH_NO_COMMIT,
  MC_PUSH_ROOT,
  MINOR_POSTED,
  mergedText,
  mergeStepFailedText,
  minorNotPostedText,
  NEW_LOOP,
  originMovedText,
  type Profile,
  type PullRequestView,
  parkedEventText,
  prNamedRefText,
  prNotifyText,
  prSecretText,
  pushReferenceText,
  pushSecretText,
  REVIEW_STATUS_BLOCKED,
  REVIEW_STATUS_PASSED,
  REVIEW_STATUS_QUEUED,
  REVIEW_STATUS_RUNNING,
  REVIEW_STATUS_WAIVED,
  type ReviewFinding,
  type Run,
  type RunLoop,
  readyHardRuleText,
  readyMarkedText,
  readyRuledText,
  readyText,
  readyWaivedText,
  reviewCarriedText,
  reviewDroppedText,
  reviewFailedText,
  reviewQueuedText,
  reviewStartedText,
  type SeatSessionRow,
  seatDef,
  wakeFailedText,
  wokenEventText,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig, CrewSeatConfig } from "../src/config.ts";
import {
  createEngine,
  type Engine,
  type EngineDeps,
  reviewerOf,
  TIP_MOVED,
} from "../src/engine/engine.ts";
import type {
  GateFacts,
  GateResult,
  OpenPrResult,
  Publisher,
  PublishResult,
  RerunResult,
  RerunStateResult,
  UpdateBranchResult,
} from "../src/engine/publish.ts";
import { MERGE_CONFLICTING, MERGE_HEAD_MOVED, MERGE_WAITS_ON_MAIN } from "../src/engine/publish.ts";
import { seatMayTake } from "../src/engine/queue.ts";
import { RepoRulesError } from "../src/engine/rules.ts";
import type { Move } from "../src/github-board.ts";
import { attentionItems } from "../src/hud.ts";
import {
  type SeatBusy,
  type SeatFacts,
  type SendResult,
  SupervisorError,
  type SupervisorEvent,
} from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";
import { activity } from "../src/views.ts";

const START = Date.parse("2026-10-21T10:00:00Z");
const HUB = START + 30 * 60_000;
const REPO = "mc";
const SEAT = "guido-1";
const RETRO = "retro-1";
const KNOWN_SEATS = [SEAT, RETRO, "guido-2", "retro-2"];
const RUN = "guido-1:20261021T100000Z";
const BRANCH = "feature/7-fix-the-thing";
const SHA = "a".repeat(40);
const SHA_B = "b".repeat(40);
const MIN = 60_000;

let dir: string;
let store: Store;
let clock: number;
let config: CcConfig;
let h: Harness;

function makeConfig(): CcConfig {
  return {
    operator: { id: "op", timezone: "Europe/London" },
    accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
    repos: [
      {
        id: REPO,
        github: "o/mc",
        project: 1,
        statusMap: {},
        autonomy: "merge",
      },
    ],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    crew: {
      worktrees: join(dir, "worktrees"),
      maxSeats: 8,
      runTokenBudget: 1000,
      sessions: [
        {
          id: "mc-crew",
          repoId: REPO,
          checkout: join(dir, "clone"),
          seats: [
            {
              id: SEAT,
              role: "GUIDO",
              accountId: "claude-main",
              model: "haiku",
              area: ["apps/**"],
            },
          ],
        },
      ],
    },
  } as CcConfig;
}

const run = (over: Partial<Run> = {}): Run => ({
  id: RUN,
  agentId: SEAT,
  repoId: REPO,
  seq: 1,
  startedAt: START,
  endedAt: null,
  status: "running",
  sessionId: "cli-1",
  model: "haiku",
  branch: BRANCH,
  ticket: `${REPO}#7`,
  ticketTitle: "Fix the thing",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  loop: { ...NEW_LOOP },
  ...over,
});

const item = (over: Partial<BoardItem> = {}): BoardItem => ({
  repoId: REPO,
  issueNumber: 7,
  title: "Fix the thing",
  status: "In progress",
  state: "in progress",
  labels: [],
  priority: null,
  updatedAt: START,
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
  createdAt: START,
  itemId: "PVTI_1",
  projectId: "PVT_1",
  ...over,
});

const prRow = (over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: REPO,
  number: 12,
  title: "t",
  url: "https://github.com/o/mc/pull/12",
  branch: BRANCH,
  ticket: `${REPO}#7`,
  state: "open",
  isDraft: true,
  review: null,
  ci: "pending",
  createdAt: START + 5 * MIN,
  updatedAt: START + 5 * MIN,
  mergedAt: null,
  headSha: SHA,
  mergeable: "MERGEABLE",
  checks: [
    {
      name: "mc/review",
      kind: "status",
      state: "passing",
      conclusion: "SUCCESS",
      attempt: null,
      url: null,
    },
  ],
  ...over,
});

interface Harness {
  engine: Engine;
  logs: string[];
  /** The supervisor has not taken the crew lock yet: its seat() refuses. */
  seatThrows: boolean;
  sent: { runId: string; key: string; text: string }[];
  pushes: string[];
  prs: { title: string; note: string }[];
  excerpts: string[];
  moves: Move[];
  ended: string[];
  taken: string[];
  /** Calls to the queue refill, and what it saw of `taken` each time (order checks). */
  refills: number[];
  listeners: Set<(e: SupervisorEvent) => void>;
  /** The next results of push and openPr, oldest first; empty: success. */
  pushResults: PublishResult[];
  prResults: OpenPrResult[];
  touches: string[];
  hardRuleLists: string[][];
  /** The merge gate's facts (null: unreadable), and the gate reads made. */
  gate: GateFacts | null;
  gateReads: { sha: string; known: boolean }[];
  /** The merge steps the publisher was asked for, in order, with the ended runs seen at the time. */
  steps: string[];
  stepEnded: Record<string, string[]>;
  /** The next results of each merge step, oldest first; empty: success. */
  stepResults: Record<string, PublishResult[]>;
  /** The branch updates asked for, and their next results, oldest first; empty: wait. */
  updates: { mainSha: string; worktree: string }[];
  updateResults: UpdateBranchResult[];
  /** The paths of a polled-after-merge request. */
  polls: number;
  moveFails: boolean;
  /** A push that never answers (a crash in the middle of a pass). */
  pushHang: boolean;
  /** Runs inside openPr, before it looks at the branch (a commit made meanwhile). */
  duringOpenPr: (() => void) | null;
  openCalls: number;
  /** The next answers of ciExcerpt, oldest first; empty: a real excerpt. */
  excerptTexts: string[];
  /** The shas whose failed runs were re-run, and what rerunFailed answers. */
  reruns: string[];
  /** Runs inside rerunFailed (a poll landing mid-call). */
  duringRerun: (() => void) | null;
  rerunRuns: { id: number; name: string }[] | null | "running";
  busy: boolean;
  facts: SeatFacts | null;
  /** The review seat's process facts. */
  retroFacts: SeatFacts | null;
  /** What the supervisor's busy() names. */
  busyList: SeatBusy[];
  /** Review starts, oldest first. */
  starts: { seat: string; id: number }[];
  /** Makes the next startReview throw. */
  startError: Error | null;
  /** Runs inside startReview, before it answers. */
  duringStart: (() => void) | null;
  /** PR-body edits, and the next results of postMinorFindings (empty: success). */
  minorCalls: { id: number; sha: string; retro: string }[];
  minorResults: PublishResult[];
  /** Commit-status writes, and the next results of setReviewStatus (empty: success). */
  statusCalls: { sha: string; state: string; description: string }[];
  statusResults: PublishResult[];
  /** Makes setReviewStatus throw (null: it answers). */
  statusThrows: Error | null;
  /** setAside answers a worktree (else null, the 7b-1 behaviour), and records its calls. */
  asideOn: boolean;
  /** The end of a run does not take (the seat still holds it). */
  endBlocked: boolean;
  asides: string[];
  /** wakeRun's calls, and what it throws (null: it puts the run back on its seat). */
  wakes: string[];
  wakeError: Error | null;
  /** The run's local branch no longer exists (localBranchGone answers true). */
  branchGone: boolean;
  /** FLIGHT's CI re-runs asked for, and the next answers of rerunRuling and rerunState (empty: one run, pending). */
  rulingReruns: { repo: string; sha: string }[];
  rerunResults: RerunResult[];
  rerunStates: RerunStateResult[];
  /** What worktreeChanges answers (a path list, or a refusal). */
  changes: string[] | { ok: false; text: string; transient: boolean };
  rules: EngineDeps["rules"];
  make: (over?: Partial<EngineDeps>) => Engine;
}

function harness(): Harness {
  const x: Harness = {
    engine: undefined as unknown as Engine,
    logs: [],
    seatThrows: false,
    sent: [],
    pushes: [],
    prs: [],
    excerpts: [],
    moves: [],
    ended: [],
    taken: [],
    refills: [],
    listeners: new Set(),
    pushResults: [],
    prResults: [],
    touches: [],
    hardRuleLists: [],
    gate: { mainSha: "d".repeat(40), containsMain: true, hubOnly: true, strays: [] },
    gateReads: [],
    steps: [],
    stepEnded: {},
    stepResults: {},
    updates: [],
    updateResults: [],
    polls: 0,
    moveFails: false,
    pushHang: false,
    duringOpenPr: null,
    openCalls: 0,
    excerptTexts: [],
    reruns: [],
    duringRerun: null,
    rerunRuns: [{ id: 77, name: "CI" }],
    busy: false,
    facts: { inTurn: false, resumedAt: null, rateLimitedUntil: null },
    retroFacts: { inTurn: false, resumedAt: null, rateLimitedUntil: null },
    busyList: [],
    starts: [],
    startError: null,
    duringStart: null,
    minorCalls: [],
    minorResults: [],
    statusCalls: [],
    statusResults: [],
    statusThrows: null,
    asideOn: false,
    endBlocked: false,
    asides: [],
    wakes: [],
    wakeError: null,
    branchGone: false,
    rulingReruns: [],
    rerunResults: [],
    rerunStates: [],
    changes: [],
    rules: async () => ({ ...DEFAULT_REPO_RULES, hardRulesSet: true }),
    make: (over = {}) => {
      const publisher: Publisher = {
        async push(r) {
          x.pushes.push(r.id);
          if (x.pushHang) return new Promise<PublishResult>(() => {});
          const res = x.pushResults.shift() ?? { ok: true };
          const sha = store.newestRunCommit(r.id)?.sha;
          if (res.ok && sha !== undefined) store.setRunPush({ runId: r.id, sha, at: clock });
          return res;
        },
        async openPr(r, ticket, note) {
          x.openCalls++;
          x.duringOpenPr?.();
          const res = x.prResults.shift();
          if (res !== undefined) return res;
          // like the real one: a branch that has moved past the push opens nothing yet
          if (store.runPush(r.id)?.sha !== store.newestRunCommit(r.id)?.sha) {
            return { ok: true, prNumber: null, tipMoved: true };
          }
          // like the real one, a repeat finds the PR it opened
          if (x.prs.length === 0) x.prs.push({ title: ticket.title, note });
          return { ok: true, prNumber: 12 };
        },
        async postMinorFindings(_r, review) {
          x.minorCalls.push(review);
          return x.minorResults.shift() ?? { ok: true };
        },
        async setReviewStatus(_r, sha, state, description) {
          x.statusCalls.push({ sha, state, description });
          if (x.statusThrows !== null) throw x.statusThrows;
          return x.statusResults.shift() ?? { ok: true };
        },
        async ciExcerpt(_repo, sha) {
          x.excerpts.push(sha);
          return x.excerptTexts.shift() ?? "EXCERPT";
        },
        async rerunFailed(_repo, sha) {
          x.reruns.push(sha);
          x.duringRerun?.();
          return x.rerunRuns;
        },
        async rerunRuling(repo, sha) {
          x.rulingReruns.push({ repo, sha });
          return x.rerunResults.shift() ?? { ok: true, runs: [{ id: 11, attempt: 1 }] };
        },
        async rerunState() {
          return x.rerunStates.shift() ?? { ok: true, outcome: "pending" };
        },
        async worktreeChanges() {
          return x.changes;
        },
        async hardRuleTouches(_run, _sha, rules) {
          x.hardRuleLists.push([...rules]);
          return x.touches.filter((path) => rules.some((rule) => globMatches(rule, path, true)));
        },
        async gateFacts(_r, sha, known): Promise<GateResult> {
          x.gateReads.push({ sha, known: known != null });
          if (x.gate === null) return { ok: false, text: "git is down", transient: true };
          return { ok: true, facts: { ...x.gate, strays: [...x.gate.strays] } };
        },
        async updateBranch(r, mainSha, worktree): Promise<UpdateBranchResult> {
          x.updates.push({ mainSha, worktree });
          const res = x.updateResults.shift() ?? { ok: true, kind: "wait" };
          // like the real one, a clean merge is recorded
          if (res.ok && res.kind === "merged") {
            store.addRunCommit({
              runId: r.id,
              repoId: r.repoId,
              branch: BRANCH,
              sha: res.sha,
              at: clock,
            });
          }
          return res;
        },
        markReady: (r) => step("ready", r),
        merge: (r) => step("merge", r),
        closeIssue: (r) => step("close", r),
        deleteRemoteBranch: (r) => step("delete-remote", r),
        deleteLocalBranch: (r) => step("delete-local", r),
        localBranchGone: async () => x.branchGone,
      };
      async function step(name: string, _r: Run): Promise<PublishResult> {
        x.steps.push(name);
        x.stepEnded[name] = x.ended.filter((id) => id === RUN);
        return x.stepResults[name]?.shift() ?? { ok: true };
      }
      return createEngine({
        config,
        store,
        bus: new ChangeBus(),
        supervisor: {
          on(fn) {
            x.listeners.add(fn);
            return () => void x.listeners.delete(fn);
          },
          async send(runId, key, text): Promise<SendResult> {
            if (x.busy) return "busy";
            const r = store.run(runId);
            if (r === null || r.endedAt !== null) return "gone";
            const claimed = store.claimLine(key, {
              runId,
              seatId: r.agentId,
              origin: "engine",
              text,
              at: clock,
            });
            if (!claimed) return "dup";
            x.sent.push({ runId, key, text });
            return "sent";
          },
          seat: (id) => {
            // like the real one: a refusal before the lock is held, and for a seat not in the config
            if (x.seatThrows || !KNOWN_SEATS.includes(id)) throw new Error(`no seat ${id}`);
            return store.seatSession(id);
          },
          seatFacts: (id) => (id === RETRO ? x.retroFacts : x.facts),
          async endRunByEngine(runId) {
            const r = store.run(runId);
            if (r === null || r.endedAt !== null || x.endBlocked) return;
            x.ended.push(runId);
            store.setRunEnded(runId, clock, "ok", "engine");
            if (store.seatSession(r.agentId)?.runId === runId) seatIdle(null, r.agentId);
          },
          async setAside(runId) {
            x.asides.push(runId);
            const r = store.run(runId);
            const row = r === null ? null : store.seatSession(r.agentId);
            if (!x.asideOn || r === null || row?.runId !== runId || row.worktree === null) {
              return null;
            }
            store.setSeatSession({ ...row, runId: null, cliSessionId: null, worktree: null });
            return { worktree: row.worktree };
          },
          async wakeRun(runId) {
            x.wakes.push(runId);
            if (x.wakeError !== null) throw x.wakeError;
            const r = store.run(runId);
            const aside = r?.loop?.aside;
            if (r === null || !aside) throw new SupervisorError(409, "the run is not waiting");
            seatIdle(runId, r.agentId);
          },
          busy: () => x.busyList,
          async startReview(seat, id) {
            x.starts.push({ seat, id });
            x.duringStart?.();
            if (x.startError !== null) throw x.startError;
            return { runId: retroRun(id) };
          },
        },
        publisher,
        board: {
          move: async (m) => {
            x.moves.push(m);
            if (x.moveFails) throw new Error("gh is down");
            return { ok: true, changed: true };
          },
        },
        rules: (repoId) => x.rules(repoId),
        refillQueues: async () => void x.refills.push(x.taken.length),
        takeNext: async (seatId) => void x.taken.push(seatId),
        pollGithub: () => void x.polls++,
        enabled: true,
        hubStartedAt: HUB,
        now: () => clock,
        log: (line) => x.logs.push(line),
        ...over,
      });
    },
  };
  x.engine = x.make();
  x.engine.start();
  return x;
}

/** A review run for review `id`, held by the review seat (what the supervisor's start does). */
function retroRun(id: number): string {
  const runId = `${RETRO}:${id}`;
  store.upsertRun(
    run({ id: runId, agentId: RETRO, seq: id, reviewId: id, branch: null, loop: null }),
  );
  seatIdle(runId, RETRO);
  return runId;
}

/** The seat row: idle, holding `runId` (null: no run). */
function seatIdle(runId: string | null, seatId = SEAT) {
  store.setSeatSession({
    seatId,
    runId,
    cliSessionId: "cli-1",
    state: "idle",
    reason: null,
    worktree: join(dir, "wt"),
    updatedAt: clock,
  });
}

const loopOf = (): RunLoop => {
  const l = store.run(RUN)?.loop;
  if (l === undefined || l === null) throw new Error("no loop");
  return l;
};
const setLoop = (over: Partial<RunLoop>) => store.setRunLoop(RUN, { ...loopOf(), ...over });
const commit = (sha = SHA) =>
  store.addRunCommit({ runId: RUN, repoId: REPO, branch: BRANCH, sha, at: clock });
const report = (note = "Changed the thing", sha = SHA) => {
  commit(sha);
  clock += 1000;
  store.addEvidence(RUN, note, clock);
  clock += 1000;
};
/** Gives RUN a profile snapshot; `upsertRun` never rewrites one, so this writes the row directly. */
const giveProfile = (over: Partial<Profile>): void => {
  const feature = DEFAULT_PROFILES.find((p) => p.name === "feature") as Profile;
  const snapshot = {
    profile: { ...feature, ...over },
    route: { by: "size", size: "M" },
  };
  const db = new DatabaseSync(join(dir, "mc.sqlite"));
  try {
    db.prepare("UPDATE runs SET profile = ?, profile_hash = ? WHERE id = ?").run(
      JSON.stringify(snapshot),
      "h",
      RUN,
    );
  } finally {
    db.close();
  }
};
const setPr = (over: Partial<PullRequestView> = {}) =>
  store.upsertPullRequests(REPO, [prRow(over)], clock);
/** CI fails on the pushed sha, is re-run once, and fails again on a later poll: the real failure. */
async function failCi(): Promise<void> {
  setPr({ ci: "failing" });
  await h.engine.reconcileRun(RUN);
  clock += 1000;
  setPr({ ci: "failing" });
}
const noteKeys = () => store.notes().map((n) => n.key);
const loopTexts = () => store.loopEvents(0).map((e) => e.text);
const sentKeys = () => h.sent.map((s) => s.key);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-engine-"));
  store = new Store(join(dir, "mc.sqlite"));
  clock = START + 10 * MIN;
  config = makeConfig();
  store.replaceBoard(REPO, [item()]);
  store.upsertRun(run());
  seatIdle(RUN);
  h = harness();
  // the run's first pass moves its card to In progress; the tests start from there
  await h.engine.tick();
  h.moves.length = 0;
});

afterEach(() => {
  h.engine.stop();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("report to a draft PR", () => {
  it("pushes once and opens one PR, with the latest note", async () => {
    report("Changed the thing; deploy by updating");
    await h.engine.reconcileRun(RUN);
    expect(h.pushes).toEqual([RUN]);
    expect(h.prs).toEqual([
      { title: "Fix the thing", note: "Changed the thing; deploy by updating" },
    ]);
    expect(loopOf()).toMatchObject({ phase: "ci", prNumber: 12, transient: 0, pushFor: SHA });
    expect(loopTexts()).toEqual(
      expect.arrayContaining(["reported; pushing", `pushed ${SHA.slice(0, 7)}`, "PR #12 opened"]),
    );
    expect(h.moves).toEqual([{ runId: RUN, repoId: REPO, issue: 7, column: "In progress" }]);
  });

  it("a successful open-pr clears a stale refusal count", async () => {
    report();
    store.setRunPush({ runId: RUN, sha: SHA, at: clock });
    setLoop({
      phase: "ci",
      reportedEvidenceId: 1,
      pushFor: SHA,
      pushStartedAt: clock,
      transient: 2,
      lastRefusal: "gh hiccup",
      cardFor: "ci:0",
    });
    await h.engine.reconcileRun(RUN);
    expect(h.pushes).toEqual([]);
    expect(loopOf()).toMatchObject({ transient: 0, lastRefusal: null, prNumber: 12 });
  });

  it("stores the hard-rule files of a new pushed sha and flags them", async () => {
    h.touches = [".github/ci.yml"];
    report();
    await h.engine.reconcileRun(RUN);
    expect(loopOf().touches).toEqual({
      sha: SHA,
      paths: [".github/ci.yml"],
      flightPowers: "standard",
    });
    expect(noteKeys()).toContain(`flag:${RUN}:hard-rules:${SHA}`);
  });

  it("clears the hard-rule flag once its run has ended", async () => {
    h.touches = [".github/ci.yml"];
    report();
    await h.engine.reconcileRun(RUN);
    expect(noteKeys()).toContain(`flag:${RUN}:hard-rules:${SHA}`);
    store.setRunEnded(RUN, clock, "ok", "engine");
    await h.engine.tick();
    expect(noteKeys()).not.toContain(`flag:${RUN}:hard-rules:${SHA}`);
  });

  it("keeps the repo's hard_rules_by for Needs you", async () => {
    h.rules = async () => ({
      ...DEFAULT_REPO_RULES,
      hardRulesSet: true,
      hardRulesBy: "controller",
    });
    h.engine.stop();
    h.engine = h.make();
    h.engine.start();
    h.touches = [".github/ci.yml"];
    report();
    await h.engine.reconcileRun(RUN);
    expect(store.getSetting(hardRulesBySettingKey(REPO))).toBe("controller");
  });
});

describe("CI and review", () => {
  async function inCi(): Promise<void> {
    report();
    await h.engine.reconcileRun(RUN);
    h.moves.length = 0;
  }

  it("passing CI on the pushed sha moves the card to In review and raises one review note", async () => {
    await inCi();
    setPr({ ci: "passing" });
    await h.engine.reconcileRun(RUN);
    expect(loopOf().phase).toBe("review");
    expect(h.moves.map((m) => m.column)).toEqual(["In review"]);
    expect(noteKeys()).toEqual([`review:${RUN}:${SHA}`]);
    expect(store.notes()[0]?.kind).toBe("review");
    // a second poll changes nothing
    const before = JSON.stringify(store.run(RUN)?.loop);
    await h.engine.reconcileRepo(REPO);
    await h.engine.reconcileRun(RUN);
    expect(h.moves).toHaveLength(1);
    expect(store.notes()).toHaveLength(1);
    expect(JSON.stringify(store.run(RUN)?.loop)).toBe(before);
  });

  it("failing CI sends one line with the excerpt, again while the seat was busy, never once claimed", async () => {
    await inCi();
    await failCi();
    h.busy = true;
    await h.engine.reconcileRun(RUN);
    expect(loopOf()).toMatchObject({
      phase: "working",
      ciFails: 1,
      ciFailedSha: SHA,
      relayedSha: null,
    });
    expect(h.sent).toEqual([]);
    h.busy = false;
    await h.engine.reconcileRun(RUN);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.key).toBe(`ci:${RUN}:${SHA}`);
    expect(h.sent[0]?.text).toMatch(/^CI failed on aaaaaaa\./);
    expect(h.sent[0]?.text.endsWith("EXCERPT")).toBe(true);
    expect(loopOf().relayedSha).toBe(SHA);
    const excerpts = h.excerpts.length;
    await h.engine.reconcileRun(RUN);
    await h.engine.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.excerpts).toHaveLength(excerpts);
    expect(store.comms(0)).toEqual([
      {
        at: expect.any(Number),
        from: "MC",
        to: SEAT,
        ticket: `${REPO}#7`,
        text: expect.stringMatching(/^CI failed on aaaaaaa\./),
      },
    ]);
  });

  it("a PR that shows up seconds after its push is not parked as missing ten minutes later", async () => {
    await inCi();
    expect(loopOf()).toMatchObject({ phase: "ci", prNumber: 12 });
    // the poll reads the PR, with the pushed sha as head, two seconds on
    clock += 2000;
    setPr({ ci: "pending" });
    await h.engine.reconcileRun(RUN);
    // and the minute polls and ticks go on while CI is still running
    for (let i = 0; i < 11; i++) {
      clock += MIN;
      setPr({ ci: "pending" });
      await h.engine.tick();
    }
    expect(loopOf().parked).toBeNull();
    setPr({ ci: "passing" });
    await h.engine.reconcileRun(RUN);
    expect(loopOf().phase).toBe("review");
  });

  it("a failing check is named in the CI failed event", async () => {
    await inCi();
    const failing = {
      ci: "failing" as const,
      checks: [
        {
          name: "check",
          kind: "check" as const,
          state: "failing" as const,
          conclusion: "FAILURE",
          attempt: 1,
          url: null,
        },
      ],
    };
    setPr(failing);
    await h.engine.reconcileRun(RUN);
    clock += 1000;
    setPr(failing);
    await h.engine.reconcileRun(RUN);
    expect(loopTexts()).toContain("CI failed on aaaaaaa (failing: check)");
  });

  it("a first CI failure is re-run once, without a word to the seat", async () => {
    await inCi();
    setPr({ ci: "failing" });
    await h.engine.reconcileRun(RUN);
    await h.engine.reconcileRun(RUN);
    expect(h.reruns).toEqual([SHA]);
    expect(h.sent).toEqual([]);
    expect(h.excerpts).toEqual([]);
    expect(loopOf()).toMatchObject({ phase: "ci", ciFails: 0, rerun: { sha: SHA } });
    expect(loopTexts()).toContain("CI failed on aaaaaaa; re-ran CI");
  });

  it("a poll that lands while gh re-runs still shows the old failure and is waited out", async () => {
    await inCi();
    h.duringRerun = () => {
      clock += 500;
      setPr({ ci: "failing" });
      clock += 500;
    };
    setPr({ ci: "failing" });
    await h.engine.reconcileRun(RUN);
    await h.engine.reconcileRun(RUN);
    expect(h.sent).toEqual([]);
    expect(loopOf().ciFails).toBe(0);
  });

  it("a pass on the re-run is recorded as a flake, owned by the controller, and the run goes on", async () => {
    await inCi();
    setPr({ ci: "failing" });
    await h.engine.reconcileRun(RUN);
    clock += 1000;
    setPr({ ci: "passing" });
    await h.engine.reconcileRun(RUN);
    expect(loopOf().phase).toBe("review");
    expect(h.sent).toEqual([]);
    expect(h.reruns).toEqual([SHA]);
    expect(loopTexts()).toContain("CI flaked on aaaaaaa: passed on re-run");
    const flake = store.notes().find((n) => n.key === `flake:${RUN}:${SHA}`);
    expect(flake?.text).toContain("CI run 77");
  });

  it("a second failure reaches the seat, and the sha is not re-run again", async () => {
    await inCi();
    await failCi();
    await h.engine.reconcileRun(RUN);
    expect(h.reruns).toEqual([SHA]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text).toMatch(/^CI failed on aaaaaaa\./);
    expect(loopOf()).toMatchObject({ ciFails: 1, ciFailedSha: SHA });
  });

  it("a re-run gh refused is not tried again; the next failure is the real one", async () => {
    h.rerunRuns = null;
    await inCi();
    await failCi();
    await h.engine.reconcileRun(RUN);
    expect(h.reruns).toEqual([SHA]);
    expect(h.sent).toHaveLength(1);
    expect(loopTexts()).toContain("CI failed on aaaaaaa; no run could be re-run");
  });

  it("a failure seen while the run still has jobs going spends no re-run", async () => {
    h.rerunRuns = "running";
    await inCi();
    await failCi();
    expect(loopOf().rerun).toBeNull();
    expect(h.sent).toEqual([]);
    h.rerunRuns = [{ id: 77, name: "CI" }];
    clock += 1000;
    setPr({ ci: "failing" });
    await h.engine.reconcileRun(RUN);
    expect(h.reruns).toEqual([SHA, SHA]);
    expect(h.sent).toEqual([]);
  });

  it("a seat in a turn is not written to", async () => {
    await inCi();
    await failCi();
    h.facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
    await h.engine.reconcileRun(RUN);
    expect(h.sent).toEqual([]);
    expect(h.excerpts).toEqual([]);
  });
});

describe("refusals", () => {
  it("a refusal that cannot clear parks with its text, the card Blocked and one note", async () => {
    h.pushResults = [{ ok: false, text: "Push refused: the branch moved.", transient: false }];
    report();
    await h.engine.reconcileRun(RUN);
    expect(loopOf()).toMatchObject({
      phase: "parked",
      parked: { kind: "refused", reason: "Push refused: the branch moved.", ended: false },
    });
    expect(h.moves.map((m) => m.column)).toEqual(["In progress", "Blocked"]);
    expect(noteKeys()).toEqual([`blocked:${RUN}:0`]);
    expect(store.notes()[0]?.text).toContain("Push refused: the branch moved.");
    expect(h.prs).toEqual([]);
  });

  describe("the note's text is written for the operator", () => {
    const speaksToTheSeat =
      /ask the operator|ask them|tell the operator|the operator has been|Try again|your branch|your reply/;
    const parkedOn = async (text: string, transient: boolean) => {
      const r = { ok: false, text, transient } as const;
      h.pushResults = [r, r, r];
      report();
      for (let i = 0; i < 3; i++) {
        await h.engine.reconcileRun(RUN);
        clock += ENGINE_TICK_MS;
      }
      expect(loopOf().phase).toBe("parked");
      expect(noteKeys()).toEqual([`blocked:${RUN}:0`]);
      return store.notes()[0]?.text ?? "";
    };

    it.each([
      [
        "a secret",
        pushSecretText("apps/x.ts", 2, "GitHub token"),
        false,
        "only you can take it out",
      ],
      [
        "a commit message that would notify",
        pushReferenceText(SHA, "@octocat"),
        false,
        "only you can reword it",
      ],
      ["a push that failed", MC_PUSH_FAILED, true, "Check the connection"],
      ["a branch with no commit", MC_PUSH_NO_COMMIT, false, "Look at the branch"],
      ["a commit with no parent", MC_PUSH_ROOT, false, "Look at the branch"],
      ["a merge commit", MC_PUSH_MERGE, false, "Look at the branch"],
      ["origin having moved", originMovedText("feature/1-x"), false, "reset origin's branch"],
      [
        "a secret in the PR",
        prSecretText("PR body", 2, "GitHub token"),
        false,
        "report its evidence again",
      ],
      ["a named reference in the PR", prNamedRefText("&sol;"), false, "report its evidence again"],
      ["a mention in the PR", prNotifyText("@octocat"), false, "report its evidence again"],
      ["an unclosed block in the PR", MC_PR_UNCLOSED, false, "report its evidence again"],
    ])("for %s: what was refused and what they can do", async (_what, text, transient, does) => {
      const note = await parkedOn(text, transient);
      expect(note).toContain(text);
      expect(note).toContain(does);
      expect(note.toLowerCase()).toContain("message the seat");
      expect(note).not.toMatch(speaksToTheSeat);
    });
  });

  it("a transient refusal is retried and parks on the third", async () => {
    const down = { ok: false, text: "The push failed.", transient: true } as const;
    h.pushResults = [down, down, down];
    report();
    await h.engine.reconcileRun(RUN);
    expect(loopOf()).toMatchObject({ phase: "ci", transient: 1, lastRefusal: "The push failed." });
    clock += ENGINE_TICK_MS;
    await h.engine.reconcileRun(RUN);
    expect(loopOf()).toMatchObject({ phase: "ci", transient: 2 });
    clock += ENGINE_TICK_MS;
    await h.engine.reconcileRun(RUN);
    expect(h.pushes).toHaveLength(3);
    expect(loopOf()).toMatchObject({
      phase: "parked",
      parked: { kind: "refused", reason: "The push failed." },
    });
    expect(noteKeys()).toEqual([`blocked:${RUN}:0`]);
  });

  it("counts one transient refusal per tick, however often it is tried", async () => {
    const down = { ok: false, text: "The push failed.", transient: true } as const;
    h.pushResults = [down, down, down, down, down];
    report();
    for (let i = 0; i < 5; i++) await h.engine.reconcileRun(RUN);
    // five tries inside one tick: a minute of outage costs one of the three
    expect(h.pushes).toHaveLength(5);
    expect(loopOf()).toMatchObject({ phase: "ci", transient: 1 });
    clock += ENGINE_TICK_MS;
    h.pushResults = [down];
    await h.engine.reconcileRun(RUN);
    expect(loopOf().transient).toBe(2);
  });

  it("counts a tick that arrives a little short of the minute", async () => {
    const down = { ok: false, text: "The push failed.", transient: true } as const;
    h.pushResults = [down, down, down, down];
    report();
    await h.engine.reconcileRun(RUN);
    clock += ENGINE_TICK_MS / 2 - 1;
    await h.engine.reconcileRun(RUN);
    expect(loopOf().transient).toBe(1);
    clock += 1;
    await h.engine.reconcileRun(RUN);
    expect(loopOf().transient).toBe(2);
    clock += ENGINE_TICK_MS - 1000;
    await h.engine.reconcileRun(RUN);
    expect(loopOf().transient).toBe(3);
  });

  it("counts a new commit's first refusal at once, however recent the last was", async () => {
    const down = { ok: false, text: "The push failed.", transient: true } as const;
    h.pushResults = [down, down];
    report();
    await h.engine.reconcileRun(RUN);
    expect(loopOf().transient).toBe(1);
    clock += 1000;
    report("Changed it again", SHA_B);
    await h.engine.reconcileRun(RUN);
    expect(loopOf()).toMatchObject({ pushFor: SHA_B, transient: 1 });
  });

  it("counts the first refusal after the operator's message at once", async () => {
    const down = { ok: false, text: "The push failed.", transient: true } as const;
    h.pushResults = [down, down];
    report();
    await h.engine.reconcileRun(RUN);
    expect(loopOf().transient).toBe(1);
    setLoop({ phase: "parked", parked: { kind: "stuck", reason: "stuck", ended: false } });
    clock += 1000;
    await h.engine.onOperatorMessage(RUN);
    // working again; the seat reports the same commit once more
    clock += 1000;
    store.addEvidence(RUN, "Changed the thing again", clock);
    await h.engine.reconcileRun(RUN);
    expect(loopOf()).toMatchObject({ phase: "ci", transient: 1 });
  });

  it("a push that succeeds clears the count before the PR step", async () => {
    report();
    setLoop({
      phase: "ci",
      reportedEvidenceId: 1,
      pushFor: SHA,
      pushStartedAt: clock,
      transient: 2,
      lastRefusal: "old",
      cardFor: "ci:0",
    });
    h.prResults = [{ ok: false, text: "The PR failed.", transient: true }];
    await h.engine.reconcileRun(RUN);
    // 0 from the push, then 1 for the PR: without the reset it would be 3, and parked
    expect(loopOf()).toMatchObject({ phase: "ci", transient: 1, lastRefusal: "The PR failed." });
  });

  it("looks again at once after a PR step that named no PR", async () => {
    h.prResults = [{ ok: true, prNumber: null }];
    report();
    await h.engine.reconcileRun(RUN);
    expect(loopOf().prNumber).toBe(12);
  });

  it("stops the pass at a park: no line goes out after it", async () => {
    h.pushResults = [{ ok: false, text: "Push refused.", transient: false }];
    // rate-limited, and past its reset: a Carry on is due in ci
    store.setSeatSession({ ...(store.seatSession(SEAT) as SeatSessionRow), state: "parked" });
    h.facts = { inTurn: false, resumedAt: null, rateLimitedUntil: clock - 1 };
    report();
    await h.engine.reconcileRun(RUN);
    expect(loopOf().phase).toBe("parked");
    expect(h.sent).toEqual([]);
  });

  it("a commit that lands inside the PR step is pushed next, not parked", async () => {
    h.duringOpenPr = () => {
      h.duringOpenPr = null;
      clock += 1000;
      commit(SHA_B);
    };
    report();
    await h.engine.reconcileRun(RUN);
    // push A, the PR step sees the branch has moved (no number), push B, then the PR
    expect(h.pushes).toHaveLength(2);
    expect(h.openCalls).toBe(2);
    expect(store.runPush(RUN)?.sha).toBe(SHA_B);
    expect(loopOf()).toMatchObject({ phase: "ci", prNumber: 12, transient: 0, parked: null });
    expect(h.prs).toHaveLength(1);
  });

  it("when the PR step keeps finding the tip wrong, the stuck park says so", async () => {
    report();
    store.setRunPush({ runId: RUN, sha: SHA, at: clock });
    setLoop({ phase: "ci", reportedEvidenceId: 1, pushFor: SHA, pushStartedAt: clock });
    h.prResults = Array.from({ length: 10 }, () => ({
      ok: true as const,
      prNumber: null,
      tipMoved: true,
    }));
    await h.engine.reconcileRun(RUN);
    expect(loopOf().lastRefusal).toBe(TIP_MOVED);
    clock += 11 * MIN;
    await h.engine.reconcileRun(RUN);
    expect(loopOf().parked).toMatchObject({
      kind: "stuck",
      reason: expect.stringContaining(`after 10 minutes (${TIP_MOVED})`),
    });
  });

  it("stops looking again after four passes", async () => {
    h.prResults = Array.from({ length: 10 }, () => ({
      ok: true as const,
      prNumber: null,
      tipMoved: true,
    }));
    report();
    await h.engine.reconcileRun(RUN);
    // pass 1 pushes, passes 2 to 4 try the PR
    expect(h.pushes).toHaveLength(1);
    expect(h.openCalls).toBe(3);
  });

  it("a PR refusal parks the same way", async () => {
    h.prResults = [{ ok: false, text: "an earlier PR is open on this branch", transient: false }];
    report();
    await h.engine.reconcileRun(RUN);
    expect(loopOf().parked?.reason).toBe("an earlier PR is open on this branch");
  });
});

describe("restarts lose nothing", () => {
  const inCiState = (over: Partial<RunLoop> = {}) =>
    setLoop({
      phase: "ci",
      reportedEvidenceId: 1,
      pushFor: SHA,
      pushStartedAt: clock,
      cardFor: "ci:0",
      ...over,
    });

  it("after the report, before the push: the next pass pushes", async () => {
    report();
    // the loop was stored by a pass that died before its actions ran
    inCiState();
    h.engine.stop();
    h.engine = h.make();
    h.engine.start();
    await h.engine.tick();
    expect(h.pushes).toEqual([RUN]);
    expect(h.prs).toHaveLength(1);
  });

  it("after the push, before the PR: opens the PR without pushing again", async () => {
    report();
    store.setRunPush({ runId: RUN, sha: SHA, at: clock });
    inCiState();
    h.engine.stop();
    h.engine = h.make();
    h.engine.start();
    await h.engine.tick();
    expect(h.pushes).toEqual([]);
    expect(h.prs).toHaveLength(1);
  });

  it("after the PR opened, before its number was stored: finds it by branch and start time", async () => {
    report();
    store.setRunPush({ runId: RUN, sha: SHA, at: clock });
    inCiState();
    setPr({ ci: "pending" });
    h.engine.stop();
    h.engine = h.make();
    h.engine.start();
    await h.engine.tick();
    expect(h.pushes).toEqual([]);
    expect(h.prs).toEqual([]);
    expect(loopOf().prNumber).toBe(12);
  });

  it("an earlier run's merged PR on the same branch is not this run's", async () => {
    setPr({ state: "merged", mergedAt: START - MIN, createdAt: START - 60 * MIN, ci: "passing" });
    await h.engine.reconcileRun(RUN);
    await h.engine.tick();
    expect(h.ended).toEqual([]);
    expect(h.taken).toEqual([]);
    expect(loopOf()).toMatchObject({ phase: "working", prNumber: null });
  });

  it("a resumed seat gets one carry-on line per hub start", async () => {
    h.facts = { inTurn: false, resumedAt: HUB + 1000, rateLimitedUntil: null };
    await h.engine.reconcileRun(RUN);
    await h.engine.reconcileRun(RUN);
    await h.engine.tick();
    expect(sentKeys()).toEqual([`resume:${RUN}:${HUB}`]);
    expect(h.sent[0]?.text).toContain("Carry on with mc#7");
  });

  it("restarting while rate-limited sends one Carry on, however the limit resets", async () => {
    store.setSeatSession({ ...(store.seatSession(SEAT) as SeatSessionRow), state: "parked" });
    h.facts = { inTurn: false, resumedAt: HUB + 1000, rateLimitedUntil: null };
    await h.engine.reconcileRun(RUN);
    await h.engine.reconcileRun(RUN);
    expect(sentKeys()).toEqual([`resume:${RUN}:${HUB}`]);
    expect(noteKeys()).toContain(`ratelimit:${RUN}`);
    expect(store.notes().find((n) => n.key === `ratelimit:${RUN}`)?.kind).toBe("ratelimit");
  });

  it("untakes a queue row whose run never began, and keeps one whose run is active", () => {
    store.replaceQueue(SEAT, [
      { repoId: REPO, issue: 7 },
      { repoId: REPO, issue: 8 },
    ]);
    store.takeQueued(SEAT, clock - 10 * MIN);
    h.engine.stop();
    // the seat's active run is on issue 7: the take is real
    h.engine = h.make();
    h.engine.start();
    expect(store.queue(SEAT)[0]?.takenAt).not.toBeNull();
    // a take for an issue the seat is not running is given back
    store.dropQueued(SEAT, REPO, 7);
    store.replaceQueue(SEAT, [{ repoId: REPO, issue: 9 }]);
    store.untake(SEAT, REPO, 7);
    store.takeQueued(SEAT, clock - 10 * MIN);
    h.engine.stop();
    h.engine = h.make();
    h.engine.start();
    expect(store.queue(SEAT).every((q) => q.takenAt === null)).toBe(true);
  });
});

describe("The operator's message", () => {
  async function parkOnCi(): Promise<void> {
    report();
    await h.engine.reconcileRun(RUN);
    await failCi();
    await h.engine.reconcileRun(RUN);
    setLoop({
      phase: "parked",
      parked: { kind: "ci", reason: "CI failed 3 times; last on aaaaaaa", ended: false },
      ciFails: 3,
    });
    await h.engine.reconcileRun(RUN);
  }

  it("the run's profile try limit parks CI on the first real failure at tries 1", async () => {
    giveProfile({ tries: 1 });
    report();
    await h.engine.reconcileRun(RUN);
    // the first failure is re-run; the second is the real one
    await failCi();
    await h.engine.reconcileRun(RUN);
    expect(store.run(RUN)?.loop?.parked).toMatchObject({
      kind: "ci",
      reason: "CI failed 1 times; last on aaaaaaa",
    });
  });

  it("un-parks a parked run, and its next park has a new blocked key", async () => {
    await parkOnCi();
    expect(noteKeys()).toContain(`blocked:${RUN}:0`);
    clock += MIN;
    await h.engine.onOperatorMessage(RUN);
    expect(loopOf()).toMatchObject({
      epoch: 1,
      parked: null,
      ciFails: 0,
      transient: 0,
      lastRefusal: null,
      unparkedAt: clock,
    });
    expect(loopOf().phase).not.toBe("parked");
    expect(loopTexts()).toContain("resumed by CAPCOM");
    expect(noteKeys()).not.toContain(`blocked:${RUN}:0`);
    // it parks again: the key is new
    setPr({ state: "closed" });
    await h.engine.reconcileRun(RUN);
    expect(loopOf().parked?.kind).toBe("pr-closed");
    expect(noteKeys()).toEqual([`blocked:${RUN}:1`]);
  });

  it("FLIGHT's un-park records resumed by FLIGHT", async () => {
    await parkOnCi();
    clock += MIN;
    await h.engine.onOperatorMessage(RUN, "FLIGHT");
    expect(loopOf().parked).toBeNull();
    expect(loopTexts()).toContain("resumed by FLIGHT");
    expect(loopTexts()).not.toContain("resumed by CAPCOM");
  });

  it("FLIGHT's un-park is limited to the kinds it names, re-checked after waiting", async () => {
    await parkOnCi();
    // the park changes to budget while the call waits its turn on the run's chain
    const waiting = h.engine.onOperatorMessage(RUN, "FLIGHT", { kinds: ["ci"] });
    setLoop({ phase: "parked", parked: { kind: "budget", reason: "over", ended: false } });
    expect(await waiting).toBe(false);
    expect(loopOf()).toMatchObject({ phase: "parked", epoch: 0, budgetExtra: 0 });
    // FLIGHT never lifts a budget park, even when it names no kinds
    expect(await h.engine.onOperatorMessage(RUN, "FLIGHT")).toBe(false);
    expect(loopOf().phase).toBe("parked");
    // a kind it names is lifted, and the call says so
    setLoop({ phase: "parked", parked: { kind: "ci", reason: "x", ended: false } });
    expect(await h.engine.onOperatorMessage(RUN, "FLIGHT", { kinds: ["ci"] })).toBe(true);
    expect(loopOf().parked).toBeNull();
  });

  it("a parked run whose push is on origin with its PR open goes back to ci, from now", async () => {
    await parkOnCi();
    clock += 40 * MIN;
    setPr({ ci: "pending" });
    await h.engine.onOperatorMessage(RUN);
    // pushed 40 minutes ago and still pending: the clocks run from the message
    expect(loopOf()).toMatchObject({ phase: "ci", pushStartedAt: clock, unparkedAt: clock });
  });

  it("a parked run whose push landed but whose PR never opened goes to ci and tries the PR again", async () => {
    report();
    store.setRunPush({ runId: RUN, sha: SHA, at: clock });
    setLoop({
      phase: "parked",
      parked: { kind: "stuck", reason: "gh pr create failed", ended: false },
      reportedEvidenceId: 1,
      pushFor: SHA,
    });
    h.sent.length = 0;
    clock += 40 * MIN;
    await h.engine.onOperatorMessage(RUN);
    expect(h.openCalls).toBe(1);
    expect(h.sent).toEqual([]);
    expect(loopOf()).toMatchObject({ phase: "ci", prNumber: 12, pushFor: SHA, unparkedAt: clock });
  });

  it("a parked run whose newest commit is not pushed goes back to working", async () => {
    report();
    setLoop({
      phase: "parked",
      parked: { kind: "stuck", reason: "gone quiet", ended: false },
      reportedEvidenceId: 1,
    });
    await h.engine.onOperatorMessage(RUN);
    expect(h.openCalls).toBe(0);
    expect(loopOf().phase).toBe("working");
  });

  it("a ruling park resumes into review, a budget park raises the ceiling", async () => {
    setLoop({ phase: "parked", parked: { kind: "ruling", reason: "ruled", ended: false } });
    await h.engine.onOperatorMessage(RUN);
    expect(loopOf().phase).toBe("review");
    setLoop({ phase: "parked", parked: { kind: "budget", reason: "over", ended: false } });
    await h.engine.onOperatorMessage(RUN);
    expect(loopOf()).toMatchObject({ phase: "working", budgetExtra: 1000 });
  });

  it("does nothing to a run that is not parked, has ended, or whose PR was closed", async () => {
    const before = JSON.stringify(loopOf());
    await h.engine.onOperatorMessage(RUN);
    expect(JSON.stringify(loopOf())).toBe(before);

    setLoop({ phase: "parked", parked: { kind: "pr-closed", reason: "closed", ended: false } });
    await h.engine.onOperatorMessage(RUN);
    expect(loopOf()).toMatchObject({ phase: "parked", epoch: 0 });

    setLoop({ phase: "parked", parked: { kind: "ci", reason: "x", ended: true } });
    await h.engine.onOperatorMessage(RUN);
    expect(loopOf()).toMatchObject({ phase: "parked", epoch: 0 });

    setLoop({ phase: "parked", parked: { kind: "ci", reason: "x", ended: false } });
    store.setRunEnded(RUN, clock, "ok", "operator");
    await h.engine.onOperatorMessage(RUN);
    expect(loopOf()).toMatchObject({ phase: "parked", epoch: 0 });
  });
});

describe("a run that ends", () => {
  const stop = () => {
    store.setRunEnded(RUN, clock, "ok", "operator");
    seatIdle(null);
  };

  it("Stop parks the run as ended, with no line, its card Blocked and its note raised", async () => {
    stop();
    for (const fn of h.listeners) {
      fn({ kind: "run-ended", seatId: SEAT, runId: RUN, endedBy: "operator" });
    }
    await h.engine.tick();
    expect(loopOf()).toMatchObject({
      phase: "parked",
      parked: { kind: "ended", reason: "run ended (stopped)", ended: true },
    });
    expect(h.sent).toEqual([]);
    expect(h.moves.map((m) => m.column)).toEqual(["Blocked"]);
    expect(noteKeys()).toEqual([`blocked:${RUN}:0`]);
  });

  it("a crash parks it the same way, naming the crash", async () => {
    store.setRunEnded(RUN, clock, "failed", "exit");
    await h.engine.tick();
    expect(loopOf().parked?.reason).toBe("run ended (the process crashed)");
  });

  it("keeps trying until the Blocked move and the note have landed, then stops", async () => {
    stop();
    h.moveFails = true;
    await h.engine.tick();
    expect(loopOf().cardFor).not.toBe("parked:0");
    // the note is lost too
    store.clearNote(`blocked:${RUN}:0`, clock);
    h.moveFails = false;
    await h.engine.tick();
    expect(loopOf().cardFor).toBe("parked:0");
    expect(noteKeys()).toEqual([`blocked:${RUN}:0`]);
    const moves = h.moves.length;
    await h.engine.tick();
    await h.engine.tick();
    expect(h.moves).toHaveLength(moves);
    expect(noteKeys()).toEqual([`blocked:${RUN}:0`]);
  });

  it("a merged PR found after Stop ends nothing and starts nothing while the seat is busy", async () => {
    stop();
    seatIdle("other-run");
    setPr({ state: "merged", mergedAt: clock, ci: "passing" });
    setLoop({ prNumber: 12 });
    await h.engine.tick();
    expect(h.taken).toEqual([]);
  });
});

describe("merged", () => {
  it("ends the run once and starts the next ticket once", async () => {
    report();
    await h.engine.reconcileRun(RUN);
    setPr({ ci: "passing" });
    await h.engine.reconcileRun(RUN);
    setPr({ state: "merged", ci: "passing", mergedAt: clock });
    await h.engine.reconcileRun(RUN);
    expect(h.ended).toEqual([RUN]);
    expect(h.taken).toEqual([SEAT]);
    expect(loopOf().phase).toBe("done");
    expect(loopTexts()).toContain("merged");
    expect(noteKeys()).toEqual([]);
    // the end is the engine's own: no second pass, however often it ticks
    for (const fn of h.listeners) {
      fn({ kind: "run-ended", seatId: SEAT, runId: RUN, endedBy: "engine" });
    }
    await h.engine.tick();
    await h.engine.tick();
    expect(h.ended).toHaveLength(1);
    // the seat is idle with no run now, so each tick asks it to take again (the real takeNext
    // does nothing without a queued ticket)
    expect(h.taken).toEqual([SEAT, SEAT, SEAT]);
  });
});

describe("taking by rule", () => {
  // the shared beforeEach has ticked once, with the seat holding a live run
  beforeEach(() => {
    h.refills.length = 0;
    h.taken.length = 0;
  });

  it("a tick refills the queues, then asks each idle writer seat with no run to take", async () => {
    seatIdle(null);
    await h.engine.tick();
    expect(h.refills).toEqual([0]);
    expect(h.taken).toEqual([SEAT]);
  });

  it("asks a seat with no seat row, and one whose run has ended", async () => {
    config.crew?.sessions[0]?.seats.push({
      id: "guido-2",
      role: "GUIDO",
      accountId: "claude-main",
      model: "haiku",
      area: ["apps/**"],
    });
    await h.engine.tick();
    expect(h.taken).toEqual(["guido-2"]);
    h.taken.length = 0;
    store.setRunEnded(RUN, clock, "ok", "engine");
    await h.engine.tick();
    // the seat row still names the run, which has ended
    expect(h.taken).toEqual([SEAT, "guido-2"]);
  });

  it("gives back a stale take before the seats take", async () => {
    seatIdle(null);
    const seen: (number | null | undefined)[] = [];
    h.engine.stop();
    h.engine = h.make({
      takeNext: async () => void seen.push(store.queue(SEAT)[0]?.takenAt),
    });
    h.engine.start();
    // (after start, which gives every take back itself)
    store.replaceQueue(SEAT, [{ repoId: REPO, issue: 9 }]);
    store.takeQueued(SEAT, clock - 10 * MIN);
    await h.engine.tick();
    expect(seen).toEqual([null]);
  });

  it("asks only writer seats", async () => {
    config.crew?.sessions[0]?.seats.push({
      id: "retro",
      role: "RETRO",
      accountId: "claude-main",
      model: "haiku",
      area: [],
    });
    store.setRunEnded(RUN, clock, "ok", "engine");
    seatIdle(null);
    await h.engine.tick();
    expect(h.taken).toEqual([SEAT]);
  });

  it.each(["stopped", "error", "starting", "running", "parked"] as const)(
    "never asks a %s seat",
    async (state) => {
      store.setSeatSession({
        seatId: SEAT,
        runId: null,
        cliSessionId: "cli-1",
        state,
        reason: null,
        worktree: join(dir, "wt"),
        updatedAt: clock,
      });
      await h.engine.tick();
      expect(h.taken).toEqual([]);
    },
  );

  it("never asks an idle seat that holds a live run", async () => {
    store.upsertRun(run());
    seatIdle(RUN);
    await h.engine.tick();
    expect(h.taken).toEqual([]);
  });

  it("a refill that throws is logged and takes nothing", async () => {
    seatIdle(null);
    h.engine = h.make({
      refillQueues: async () => {
        throw new Error("rules unreadable");
      },
    });
    h.engine.start();
    await h.engine.tick();
    expect(h.taken).toEqual([]);
    expect(h.logs.some((l) => l.includes("refill: rules unreadable"))).toBe(true);
  });
});

describe("the note sweep", () => {
  const note = (key: string, kind: "blocked" | "review" | "flag" | "ratelimit") =>
    store.raiseNote({ key, kind, runId: RUN, seatId: SEAT, repoId: REPO, text: key, at: clock });

  it("clears an ended run's review, flag and rate-limit notes, and its blocked note once its PR is done", async () => {
    setLoop({
      phase: "parked",
      parked: { kind: "ended", reason: "run ended (stopped)", ended: true },
      cardFor: "parked:0",
    });
    store.setRunEnded(RUN, clock, "ok", "operator");
    seatIdle(null);
    note(`blocked:${RUN}:0`, "blocked");
    note(`review:${RUN}:${SHA}`, "review");
    note(`flag:${RUN}:hard-rules:${SHA}`, "flag");
    note(`ratelimit:${RUN}`, "ratelimit");
    await h.engine.tick();
    expect(noteKeys()).toEqual([`blocked:${RUN}:0`]);
    setLoop({ prNumber: 12 });
    setPr({ state: "closed" });
    await h.engine.tick();
    expect(noteKeys()).toEqual([]);
  });

  describe("an ended run's blocked note", () => {
    beforeEach(async () => {
      store.setRunEnded(RUN, clock, "ok", "operator");
      seatIdle(null);
      await h.engine.tick();
      expect(noteKeys()).toEqual([`blocked:${RUN}:0`]);
    });

    it("stays while the card is where the hub could not move it", async () => {
      // the move failed (or the repo is a draft one): the card was never in Blocked
      store.replaceBoard(REPO, [item({ status: "In progress" })]);
      await h.engine.tick();
      expect(noteKeys()).toEqual([`blocked:${RUN}:0`]);
    });

    it("clears once the card the hub moved to Blocked has left it", async () => {
      const id = store.addBoardMove({
        runId: RUN,
        repoId: REPO,
        issue: 7,
        column: "Blocked",
        state: "pending",
        detail: null,
        at: clock,
      });
      store.finishBoardMove(id, "done", null, clock);
      store.replaceBoard(REPO, [item({ status: "Blocked", state: "blocked" })]);
      await h.engine.tick();
      expect(noteKeys()).toEqual([`blocked:${RUN}:0`]);
      store.replaceBoard(REPO, [item({ status: "In progress" })]);
      await h.engine.tick();
      expect(noteKeys()).toEqual([]);
    });

    it("clears once another run has taken the ticket", async () => {
      store.upsertRun(run({ id: "later", seq: 2, startedAt: START + 20 * MIN, loop: undefined }));
      await h.engine.tick();
      expect(noteKeys()).toEqual([]);
    });
  });

  it("leaves a live run's notes alone", async () => {
    report();
    await h.engine.reconcileRun(RUN);
    setPr({ ci: "passing" });
    await h.engine.reconcileRun(RUN);
    expect(noteKeys()).toEqual([`review:${RUN}:${SHA}`]);
    await h.engine.tick();
    expect(noteKeys()).toEqual([`review:${RUN}:${SHA}`]);
  });
});

describe("off", () => {
  it("does nothing when disabled", async () => {
    h.engine.stop();
    h.listeners.clear();
    h.engine = h.make({ enabled: false });
    h.engine.start();
    report();
    await h.engine.reconcileRun(RUN);
    await h.engine.reconcileRepo(REPO);
    await h.engine.tick();
    await h.engine.onOperatorMessage(RUN);
    expect(h.listeners.size).toBe(0);
    expect(h.pushes).toEqual([]);
    expect(h.moves).toEqual([]);
    expect(h.sent).toEqual([]);
    expect(store.notes()).toEqual([]);
    expect(loopOf()).toMatchObject({ phase: "working" });
    expect(h.engine.status()).toEqual({ on: false, note: null });
  });

  it("does nothing while another process holds the crew lock", async () => {
    h.engine.stop();
    h.engine = h.make({ crewOn: () => false });
    h.engine.start();
    report();
    await h.engine.reconcileRun(RUN);
    expect(h.pushes).toEqual([]);
  });

  it("reports a repo whose rules cannot be read", async () => {
    h.rules = async () => new RepoRulesError("mc: the Mission Control section has no yaml block");
    await h.engine.tick();
    expect(h.engine.status()).toEqual({
      on: true,
      note: "mc: the Mission Control section has no yaml block",
    });
  });
});

describe("boot", () => {
  const staleTake = () => {
    store.replaceQueue(SEAT, [{ repoId: REPO, issue: 9 }]);
    store.takeQueued(SEAT, clock - 10 * MIN);
  };

  it("never throws or writes while the supervisor does not hold the lock", async () => {
    staleTake();
    h.engine.stop();
    h.seatThrows = true;
    h.engine = h.make({ crewOn: () => false });
    expect(() => h.engine.start()).not.toThrow();
    await expect(h.engine.tick()).resolves.toBeUndefined();
    expect(store.queue(SEAT)[0]?.takenAt).not.toBeNull();
    expect(h.pushes).toEqual([]);
    expect(h.logs).toEqual([]);
  });

  it("does its work once the lock is held: start() reconciles, and the next tick untakes", async () => {
    report();
    staleTake();
    h.engine.stop();
    h.engine = h.make();
    h.engine.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.pushes).toEqual([RUN]);
    expect(store.queue(SEAT)[0]?.takenAt).toBeNull();
  });

  it("start() untakes a take of any age, where a tick leaves a fresh one", async () => {
    store.replaceQueue(SEAT, [{ repoId: REPO, issue: 9 }]);
    store.takeQueued(SEAT, clock - 1000);
    await h.engine.tick();
    expect(store.queue(SEAT)[0]?.takenAt).not.toBeNull();
    h.engine.stop();
    h.engine = h.make();
    h.engine.start();
    expect(store.queue(SEAT)[0]?.takenAt).toBeNull();
  });

  it("start() keeps the take of a run that is active on the ticket", () => {
    store.upsertRun(run({ ticket: `${REPO}#9` }));
    store.replaceQueue(SEAT, [{ repoId: REPO, issue: 9 }]);
    store.takeQueued(SEAT, clock - 1000);
    h.engine.stop();
    h.engine = h.make();
    h.engine.start();
    expect(store.queue(SEAT)[0]?.takenAt).not.toBeNull();
  });

  it("start() survives a read that fails", () => {
    staleTake();
    h.engine.stop();
    h.seatThrows = true;
    h.engine = h.make();
    expect(() => h.engine.start()).not.toThrow();
    expect(h.logs.join("\n")).toContain("start:");
  });

  it("sweeps an ended run's stale notes at start", () => {
    store.setRunEnded(RUN, clock, "ok", "operator");
    seatIdle(null);
    store.raiseNote({
      key: `review:${RUN}:${SHA}`,
      kind: "review",
      runId: RUN,
      seatId: SEAT,
      repoId: REPO,
      text: "old",
      at: clock,
    });
    h.engine.stop();
    h.engine = h.make();
    h.engine.start();
    expect(noteKeys()).toEqual([]);
  });

  it("leaves a stale take of a seat that is not configured alone, quietly", () => {
    store.replaceQueue("ghost", [{ repoId: REPO, issue: 9 }]);
    store.takeQueued("ghost", clock - 10 * MIN);
    h.engine.stop();
    h.engine = h.make();
    h.engine.start();
    expect(h.logs).toEqual([]);
    expect(store.queue("ghost")[0]?.takenAt).not.toBeNull();
  });

  it("gives a stale take back on the tick, not only at start", async () => {
    store.replaceQueue(SEAT, [{ repoId: REPO, issue: 9 }]);
    store.takeQueued(SEAT, clock - 10 * MIN);
    await h.engine.tick();
    expect(store.queue(SEAT)[0]?.takenAt).toBeNull();
  });

  it("leaves a run whose seat is no longer configured alone, quietly", async () => {
    store.upsertRun(run({ id: "ghost-run", agentId: "ghost", seq: 2, ticket: `${REPO}#8` }));
    await h.engine.tick();
    await h.engine.reconcileRun("ghost-run");
    expect(h.logs).toEqual([]);
    expect(loopOf()).toMatchObject({ phase: "working" });
  });
});

describe("FLIGHT settles a ruling", () => {
  /** The author ruled on the CI failure on SHA: parked as `ruling`, PR 12 open with head SHA. */
  async function ruled(): Promise<void> {
    commit();
    store.setRunPush({ runId: RUN, sha: SHA, at: clock });
    setPr({ ci: "failing" });
    setLoop({
      phase: "parked",
      prNumber: 12,
      ciFailedSha: SHA,
      ciFails: 1,
      relayedSha: SHA,
      cardFor: "working:0",
      parked: { kind: "ruling", reason: "ruled", ended: false },
    });
  }
  const accept = (mayRerun = true) => h.engine.acceptRuling(RUN, { mayRerun });

  it("re-runs once, waits while it runs, then accepts a pass and clears the failure", async () => {
    await ruled();
    expect(await accept()).toEqual({ kind: "rerun", sha: SHA });
    expect(h.rulingReruns).toEqual([{ repo: "o/mc", sha: SHA }]);
    expect(loopOf().rulingRerun).toEqual({
      sha: SHA,
      runs: [{ id: 11, attempt: 1 }],
      outcome: "pending",
    });
    expect(await accept()).toEqual({ kind: "pending", sha: SHA });
    h.rerunStates = [{ ok: true, outcome: "passed" }];
    expect(await accept()).toEqual({ kind: "accepted", sha: SHA });
    expect(loopOf()).toMatchObject({
      phase: "review",
      ciFailedSha: null,
      parked: null,
      ciFails: 0,
      epoch: 1,
      unparkedAt: clock,
    });
    expect(h.rulingReruns).toHaveLength(1);
    expect(h.polls).toBeGreaterThan(0);
    expect(sentKeys()).toEqual([]);
  });

  it("sends the author the failure when the re-run fails, and refuses", async () => {
    await ruled();
    await accept();
    h.rerunStates = [{ ok: true, outcome: "failed" }];
    expect(await accept()).toEqual({ kind: "refused", sha: SHA });
    expect(loopOf()).toMatchObject({ phase: "working", ciFailedSha: SHA, parked: null });
    expect(sentKeys()).toEqual([`rerun:${RUN}:${SHA}`]);
    expect(h.sent[0]?.text).toBe(
      `CI failed again on ${SHA.slice(0, 7)} when FLIGHT re-ran it, so your ruling was not accepted. Fix it, commit, and report again. The failing output:\nEXCERPT`,
    );
    // the line is sent once
    await h.engine.reconcileRun(RUN);
    expect(h.sent).toHaveLength(1);
  });

  it("re-runs a sha only once: a second ruling on it goes to the operator", async () => {
    await ruled();
    await accept();
    h.rerunStates = [{ ok: true, outcome: "failed" }];
    await accept();
    // the author rules again on the same sha
    setLoop({ phase: "parked", parked: { kind: "ruling", reason: "ruled again", ended: false } });
    const r = await accept();
    expect(r).toEqual({
      kind: "not",
      text: `${SHA.slice(0, 7)} was already re-run once; pass this ruling to the operator`,
    });
    expect(h.rulingReruns).toHaveLength(1);
  });

  it("does not re-run when the hourly cap is used, and says so", async () => {
    await ruled();
    expect(await accept(false)).toEqual({ kind: "capped" });
    expect(h.rulingReruns).toEqual([]);
  });

  it("refuses a run that is not parked on a ruling, or whose ruled commit is not the PR's head", async () => {
    await ruled();
    setLoop({ parked: { kind: "ci", reason: "x", ended: false } });
    expect(await accept()).toEqual({
      kind: "not",
      text: "the run is not parked on a CI ruling",
    });
    setLoop({ parked: { kind: "ruling", reason: "x", ended: true } });
    expect(await accept()).toMatchObject({ kind: "not" });
    setLoop({ parked: { kind: "ruling", reason: "x", ended: false } });
    setPr({ ci: "failing", headSha: SHA_B });
    expect(await accept()).toEqual({
      kind: "not",
      text: "the ruled commit is no longer its open PR's head",
    });
    expect(h.rulingReruns).toEqual([]);
  });

  it("refuses a rerun gh would not start, leaving no re-run recorded", async () => {
    await ruled();
    h.rerunResults = [{ ok: false, text: "no failed Actions run", transient: false }];
    expect(await accept()).toEqual({ kind: "not", text: "no failed Actions run" });
    expect(loopOf().rulingRerun ?? null).toBeNull();
  });

  it("does nothing while the engine is off", async () => {
    await ruled();
    h.engine.stop();
    expect(await accept()).toEqual({ kind: "not", text: "the loop engine is off" });
  });
});

describe("the paths a run's worktree holds uncommitted", () => {
  it("reads the seat's worktree, and null when there is none or it cannot be read", async () => {
    h.changes = ["apps/a.ts"];
    expect(await h.engine.uncommitted(RUN)).toEqual(["apps/a.ts"]);
    h.changes = { ok: false, text: "git failed", transient: true };
    expect(await h.engine.uncommitted(RUN)).toBeNull();
    h.changes = [];
    seatIdle(null);
    expect(await h.engine.uncommitted(RUN)).toBeNull();
    expect(await h.engine.uncommitted("no-such-run")).toBeNull();
  });
});

describe("review round", () => {
  it("reads a Ruling: report as a ruling on the failed sha, and parks", async () => {
    commit();
    setLoop({ ciFailedSha: SHA, ciFails: 1, relayedSha: SHA, cardFor: "working:0" });
    clock += 1000;
    store.addEvidence(RUN, `${EVIDENCE_RULING_PREFIX} the test is flaky, not mine`, clock);
    await h.engine.reconcileRun(RUN);
    expect(loopOf().parked?.kind).toBe("ruling");
  });

  it("fetches a failure's CI log once while the seat is busy", async () => {
    report();
    await h.engine.reconcileRun(RUN);
    await failCi();
    h.busy = true;
    for (let i = 0; i < 3; i++) await h.engine.reconcileRun(RUN);
    expect(h.excerpts).toHaveLength(1);
    expect(h.sent).toEqual([]);
    h.busy = false;
    await h.engine.reconcileRun(RUN);
    expect(h.excerpts).toHaveLength(1);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.text.endsWith("EXCERPT")).toBe(true);
  });

  describe("held CI excerpts", () => {
    async function failedAndBusy(): Promise<void> {
      report();
      await h.engine.reconcileRun(RUN);
      await failCi();
      h.busy = true;
    }

    it("keeps only a real excerpt: a failed read or an empty answer is asked for again", async () => {
      await failedAndBusy();
      h.excerptTexts = [
        "(the CI log could not be read)",
        "(no failed Actions run to read)",
        "(the failed run's log was empty)",
        "THE LOG",
      ];
      for (let i = 0; i < 4; i++) await h.engine.reconcileRun(RUN);
      expect(h.excerpts).toHaveLength(4);
      expect(h.engine.excerptsHeld()).toBe(1);
      await h.engine.reconcileRun(RUN);
      expect(h.excerpts).toHaveLength(4);
      h.busy = false;
      await h.engine.reconcileRun(RUN);
      expect(h.sent[0]?.text.endsWith("THE LOG")).toBe(true);
      expect(h.engine.excerptsHeld()).toBe(0);
    });

    it("lets go of it when the seat reports a new commit", async () => {
      await failedAndBusy();
      await h.engine.reconcileRun(RUN);
      expect(h.engine.excerptsHeld()).toBe(1);
      clock += 1000;
      report("Fixed it", SHA_B);
      await h.engine.reconcileRun(RUN);
      expect(h.engine.excerptsHeld()).toBe(0);
    });

    it("lets go of it when the run ends", async () => {
      await failedAndBusy();
      await h.engine.reconcileRun(RUN);
      expect(h.engine.excerptsHeld()).toBe(1);
      store.setRunEnded(RUN, clock, "ok", "operator");
      seatIdle(null);
      await h.engine.tick();
      expect(h.engine.excerptsHeld()).toBe(0);
    });
  });

  it("writes nothing to a seat that has moved on to another run", async () => {
    report();
    await h.engine.reconcileRun(RUN);
    await failCi();
    h.busy = true;
    await h.engine.reconcileRun(RUN);
    h.busy = false;
    seatIdle("another-run");
    await h.engine.reconcileRun(RUN);
    expect(h.sent).toEqual([]);
  });

  it("saves the new loop before it acts: a pass cut short leaves it stored", async () => {
    report();
    h.pushHang = true;
    void h.engine.reconcileRun(RUN);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(h.pushes).toEqual([RUN]);
    expect(loopOf()).toMatchObject({ phase: "ci", reportedEvidenceId: 1 });
  });

  describe("an ended run settles only when both the move and the note have landed", () => {
    const stop = () => {
      store.setRunEnded(RUN, clock, "ok", "operator");
      seatIdle(null);
    };

    it("a note without its move still gets the move", async () => {
      stop();
      h.moveFails = true;
      await h.engine.tick();
      expect(noteKeys()).toEqual([`blocked:${RUN}:0`]);
      h.moveFails = false;
      h.moves.length = 0;
      await h.engine.tick();
      expect(h.moves.map((m) => m.column)).toEqual(["Blocked"]);
      expect(loopOf().cardFor).toBe("parked:0");
    });

    it("a move without its note still gets the note", async () => {
      stop();
      await h.engine.tick();
      expect(loopOf().cardFor).toBe("parked:0");
      store.clearNote(`blocked:${RUN}:0`, clock);
      await h.engine.tick();
      expect(noteKeys()).toEqual([`blocked:${RUN}:0`]);
    });

    it("a closed PR does not settle a run whose card has not reached Blocked", async () => {
      setLoop({ prNumber: 12 });
      setPr({ state: "open" });
      stop();
      h.moveFails = true;
      await h.engine.tick();
      expect(noteKeys()).toEqual([`blocked:${RUN}:0`]);
      expect(loopOf().cardFor).not.toBe("parked:0");
      // The operator closes the PR; the move works again
      setPr({ state: "closed" });
      h.moveFails = false;
      h.moves.length = 0;
      await h.engine.tick();
      expect(h.moves.map((m) => m.column)).toEqual(["Blocked"]);
      expect(loopOf().cardFor).toBe("parked:0");
      // the note is not wanted any more, and goes
      expect(noteKeys()).toEqual([]);
    });

    it("a run that ended with its PR already closed still gets its card to Blocked", async () => {
      store.addRunCommit({ runId: RUN, repoId: REPO, branch: BRANCH, sha: SHA, at: clock });
      store.setRunPush({ runId: RUN, sha: SHA, at: clock });
      setLoop({ phase: "ci", reportedEvidenceId: 1, prNumber: 12, pushFor: SHA, cardFor: "ci:0" });
      setPr({ state: "closed" });
      const raised = vi.spyOn(store, "raiseNote");
      stop();
      await h.engine.tick();
      expect(loopOf()).toMatchObject({ phase: "parked", cardFor: "parked:0" });
      expect(loopOf().parked?.ended).toBe(true);
      expect(h.moves.map((m) => m.column)).toEqual(["Blocked"]);
      expect(raised).not.toHaveBeenCalled();
      const moves = h.moves.length;
      await h.engine.tick();
      expect(h.moves).toHaveLength(moves);
    });

    it("a run another run has taken the ticket from moves no card", async () => {
      stop();
      store.upsertRun(run({ id: "later", seq: 2, startedAt: START + 20 * MIN, loop: undefined }));
      await h.engine.tick();
      // the event path reaches the pass itself: it must not move the newer run's card
      for (const fn of h.listeners) {
        fn({ kind: "run-ended", seatId: SEAT, runId: RUN, endedBy: "operator" });
      }
      await h.engine.reconcileRun(RUN);
      expect(h.moves).toEqual([]);
      expect(noteKeys()).toEqual([]);
    });

    it("a note that was swept is not raised again on the event path either", async () => {
      stop();
      h.moveFails = true;
      setLoop({ prNumber: 12 });
      setPr({ state: "closed" });
      for (const fn of h.listeners) {
        fn({ kind: "run-ended", seatId: SEAT, runId: RUN, endedBy: "operator" });
      }
      await h.engine.reconcileRun(RUN);
      // no sweep has run: the note is simply never raised
      expect(noteKeys()).toEqual([]);
    });

    it("a note that was swept is not raised again while the move keeps failing", async () => {
      stop();
      h.moveFails = true;
      setLoop({ prNumber: 12 });
      setPr({ state: "closed" });
      const raised = vi.spyOn(store, "raiseNote");
      for (let i = 0; i < 3; i++) await h.engine.tick();
      expect(raised).not.toHaveBeenCalled();
      expect(noteKeys()).toEqual([]);
    });
  });
});

describe("what the operator sees", () => {
  it("writes Activity rows for the loop's steps", async () => {
    report();
    await h.engine.reconcileRun(RUN);
    const rows = activity(config, store, clock).filter((e) => e.kind === "loop");
    expect(rows.map((r) => r.text)).toEqual(
      expect.arrayContaining(["reported; pushing", `pushed ${SHA.slice(0, 7)}`, "PR #12 opened"]),
    );
    expect(rows.every((r) => r.who === SEAT && r.ref === `${REPO}#7`)).toBe(true);
  });

  it("raises Needs-you items from the notes, and drops them when the notes clear", async () => {
    report();
    await h.engine.reconcileRun(RUN);
    setPr({ ci: "passing" });
    await h.engine.reconcileRun(RUN);
    const items = () =>
      attentionItems(config, store, clock).filter((i) => i.key.startsWith("note:"));
    expect(items().map((i) => i.kind)).toEqual(["review"]);
    expect(items()[0]?.text).toContain("is ready for review");
    // merged: the review note clears with the run
    setPr({ state: "merged", ci: "passing", mergedAt: clock });
    await h.engine.reconcileRun(RUN);
    expect(items()).toEqual([]);
  });

  it("a parked run is a Blocked item", async () => {
    h.pushResults = [{ ok: false, text: "Push refused.", transient: false }];
    report();
    await h.engine.reconcileRun(RUN);
    const blocked = attentionItems(config, store, clock).filter((i) => i.kind === "blocked");
    expect(blocked.map((i) => i.text)).toEqual([expect.stringContaining("Push refused.")]);
  });
});

describe("the engine runs reviews", () => {
  const CALL = "RETRO-1";
  const RUN2 = "guido-2:20261021T100000Z";
  const BRANCH2 = "feature/8-other";
  const retroSeat = (): CrewSeatConfig => ({
    id: RETRO,
    role: "RETRO",
    mode: "scratch",
    accountId: "claude-main",
    model: "opus",
    area: [],
  });
  const seats = (): CrewSeatConfig[] => config.crew?.sessions[0]?.seats ?? [];
  /** The repo is a draft workspace: a clean review raises the ready note and the operator merges. */
  const draftWorkspace = (): void => {
    const repo = config.repos[0];
    if (repo !== undefined) repo.autonomy = "draft";
  };

  beforeEach(() => {
    seats().push(retroSeat());
  });

  const need = <T>(v: T | null | undefined): T => {
    if (v === null || v === undefined) throw new Error("missing");
    return v;
  };
  const emit = (e: SupervisorEvent) => {
    for (const l of h.listeners) l(e);
  };
  const reviewRows = () => store.reviewsOfRun(RUN);
  const first = () => need(reviewRows()[0]);
  const finding = (severity: ReviewFinding["severity"]): ReviewFinding => ({
    severity,
    file: "apps/a.ts",
    line: 3,
    summary: `a ${severity} thing`,
    scenario: "it breaks",
    fix: "change it",
  });
  /** The review run reports `findings`, and the event reaches the engine. */
  function reported(id: number, findings: ReviewFinding[]): void {
    const rv = need(store.review(id));
    const ok = store.recordFindings(id, need(rv.runId), {
      verdict: { spec: "pass", quality: "pass" },
      summary: "done",
      findings,
      at: clock,
    });
    expect(ok).toBe(true);
    emit({ kind: "findings", seatId: RETRO, runId: need(rv.runId) });
  }
  /** The review run dies: its row, its seat, the event. */
  function crash(runId: string): void {
    store.setRunEnded(runId, clock, "failed", "exit");
    seatIdle(null, RETRO);
    emit({ kind: "run-ended", seatId: RETRO, runId, endedBy: "exit" });
  }
  async function toReview(): Promise<void> {
    report();
    await h.engine.reconcileRun(RUN);
    setPr({ ci: "passing" });
    await h.engine.reconcileRun(RUN);
  }
  /** Another author run in review on its own PR 13, not yet reviewed. */
  async function secondAuthor(): Promise<void> {
    seats().push({
      id: "guido-2",
      role: "GUIDO",
      accountId: "claude-main",
      model: "haiku",
      area: ["apps/**"],
    });
    store.replaceBoard(REPO, [item(), item({ issueNumber: 8, itemId: "PVTI_2" })]);
    store.upsertRun(
      run({
        id: RUN2,
        agentId: "guido-2",
        branch: BRANCH2,
        ticket: `${REPO}#8`,
        ticketTitle: "Other",
      }),
    );
    seatIdle(RUN2, "guido-2");
    store.addRunCommit({ runId: RUN2, repoId: REPO, branch: BRANCH2, sha: SHA_B, at: clock });
    store.setRunPush({ runId: RUN2, sha: SHA_B, at: clock });
    store.addEvidence(RUN2, "done", clock);
    store.upsertPullRequests(
      REPO,
      [
        prRow({ ci: "passing" }),
        prRow({
          number: 13,
          branch: BRANCH2,
          ticket: `${REPO}#8`,
          headSha: SHA_B,
          ci: "passing",
        }),
      ],
      clock,
    );
    store.setRunLoop(RUN2, {
      ...NEW_LOOP,
      phase: "ci",
      prNumber: 13,
      reportedEvidenceId: 1,
      pushFor: SHA_B,
      pushStartedAt: clock,
    });
    await h.engine.reconcileRun(RUN2);
  }

  it("queues and starts one review", async () => {
    await toReview();
    const rv = first();
    expect(h.starts).toEqual([{ seat: RETRO, id: rv.id }]);
    expect(rv).toMatchObject({
      state: "running",
      runId: `${RETRO}:${rv.id}`,
      round: 1,
      attempt: 1,
      sha: SHA,
      prNumber: 12,
    });
    expect(loopTexts()).toEqual(
      expect.arrayContaining([reviewQueuedText(SHA, CALL), reviewStartedText(CALL, SHA)]),
    );
    expect(noteKeys().filter((k) => k.startsWith("review:"))).toEqual([]);
  });

  it("no scratch seat: 7a unchanged", async () => {
    seats().splice(
      seats().findIndex((s) => s.id === RETRO),
      1,
    );
    await toReview();
    expect(noteKeys()).toContain(`review:${RUN}:${SHA}`);
    expect(reviewRows()).toEqual([]);
    expect(h.starts).toEqual([]);
  });

  it("reviewerOf skips a retiring seat", () => {
    seats().push({ ...retroSeat(), id: "retro-2" });
    expect(reviewerOf(config, "guido-1")?.id).toBe(RETRO);
    const first = need(seats().find((s) => s.id === RETRO));
    first.retiring = true;
    expect(reviewerOf(config, "guido-1")?.id).toBe("retro-2");
    need(seats().find((s) => s.id === "retro-2")).retiring = true;
    expect(reviewerOf(config, "guido-1")).toBeNull();
  });

  it("requests the review from the seat with the run's profile reviewer role", async () => {
    seats().push({ ...retroSeat(), id: "other-1", role: "AUDIT", def: seatDef(retroSeat()) });
    giveProfile({ reviewer: { role: "AUDIT", depth: "light" } });
    await toReview();
    expect(reviewRows().map((r) => r.seatId)).toEqual(["other-1"]);
  });

  it("reviewerOf prefers the review seat with the profile's role, else the first", () => {
    seats().push({ ...retroSeat(), id: "other-1", role: "AUDIT", def: seatDef(retroSeat()) });
    expect(reviewerOf(config, "guido-1", "AUDIT")?.id).toBe("other-1");
    expect(reviewerOf(config, "guido-1", "RETRO")?.id).toBe(RETRO);
    expect(reviewerOf(config, "guido-1", "NOBODY")?.id).toBe(RETRO);
    expect(reviewerOf(config, "guido-1")?.id).toBe(RETRO);
  });

  it("a queued review for a removed reviewer is re-requested for the new one", async () => {
    h.busyList = [{ seatId: RETRO, state: "running" }];
    await toReview();
    const old = first();
    expect(old.state).toBe("queued");
    seats().splice(
      seats().findIndex((s) => s.id === RETRO),
      1,
      { ...retroSeat(), id: "retro-2" },
    );
    h.busyList = [];
    await h.engine.tick();
    expect(store.review(old.id)?.state).toBe("superseded");
    await vi.waitFor(() => expect(h.starts).toEqual([{ seat: "retro-2", id: expect.any(Number) }]));
    const rows = reviewRows();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ seatId: "retro-2", sha: SHA });
  });

  it("a seat removed while an earlier seat's review starts is skipped, not failed", async () => {
    seats().push({ ...retroSeat(), id: "retro-2" });
    h.busyList = [{ seatId: RETRO, state: "running" }];
    await toReview();
    const one = first();
    let two = 0;
    h.busyList = [];
    // while retro-1's start awaits, retro-2 is given a queued review and then removed
    h.duringStart = () => {
      h.duringStart = null;
      two = need(
        store.requestReview({
          authorRunId: one.authorRunId,
          repoId: one.repoId,
          seatId: "retro-2",
          prNumber: one.prNumber,
          sha: one.sha,
          epoch: one.epoch,
          attempt: one.attempt + 1,
          round: one.round,
          at: clock,
        }),
      );
      seats().splice(
        seats().findIndex((s) => s.id === "retro-2"),
        1,
      );
    };
    await h.engine.tick();
    expect(h.starts).toEqual([{ seat: RETRO, id: one.id }]);
    expect(store.review(two)?.state).toBe("queued");
  });

  describe("boot recovery", () => {
    it("a starting row with no run goes back to queued, then starts once", async () => {
      h.busyList = [{ seatId: RETRO, state: "running" }];
      await toReview();
      const id = first().id;
      expect(first().state).toBe("queued");
      expect(store.setReviewState(id, ["queued"], "starting", { at: clock })).toBe(true);
      h.busyList = [];
      h.engine.stop();
      h.engine = h.make();
      h.engine.start();
      await h.engine.tick();
      expect(h.starts).toEqual([{ seat: RETRO, id }]);
      expect(first().state).toBe("running");
    });

    it("a starting row with a run row becomes running, with no start", async () => {
      h.busyList = [{ seatId: RETRO, state: "running" }];
      await toReview();
      const id = first().id;
      store.setReviewState(id, ["queued"], "starting", { at: clock });
      retroRun(id);
      h.busyList = [];
      h.engine.stop();
      h.engine = h.make();
      h.engine.start();
      await h.engine.tick();
      expect(h.starts).toEqual([]);
      expect(first()).toMatchObject({ state: "running", runId: `${RETRO}:${id}` });
    });
  });

  it("two PRs, one RETRO: the second starts when the first run ends", async () => {
    await toReview();
    await secondAuthor();
    const one = first();
    expect(h.starts).toHaveLength(1);
    const two = need(store.reviewsOfRun(RUN2)[0]);
    expect(two.state).toBe("queued");
    reported(one.id, []);
    await vi.waitFor(() => expect(h.starts).toHaveLength(2));
    expect(h.starts[1]).toEqual({ seat: RETRO, id: two.id });
    expect(h.ended).toContain(`${RETRO}:${one.id}`);
  });

  it("blocking findings go to the author once, and the review run ends", async () => {
    await toReview();
    const id = first().id;
    // a busy seat is offered the line again, and nothing is recorded until it goes through
    h.busy = true;
    reported(id, [finding("Critical"), finding("Important"), finding("Minor")]);
    await vi.waitFor(() => expect(store.review(id)?.state).toBe("reported"));
    await h.engine.tick();
    expect(sentKeys()).toEqual([]);
    expect(store.comms(0)).toEqual([]);
    h.busy = false;
    await h.engine.tick();
    await vi.waitFor(() => expect(sentKeys()).toEqual([`fix:${RUN}:0:${id}`]));
    expect(loopTexts()).toContain(fixSentText(2, "GUIDO-1"));
    expect(h.ended).toContain(`${RETRO}:${id}`);
    await h.engine.reconcileRun(RUN);
    await h.engine.tick();
    expect(sentKeys()).toEqual([`fix:${RUN}:0:${id}`]);
    // RETRO's findings to the author: recorded once, though the line was offered again
    expect(store.comms(0)).toEqual([
      {
        at: expect.any(Number),
        from: RETRO,
        to: SEAT,
        ticket: `${REPO}#7`,
        text: expect.stringMatching(/^RETRO-1 reviewed aaaaaaa and found 2 issues/),
      },
    ]);
  });

  it("a fix round: the new push is reviewed as round 2", async () => {
    await toReview();
    reported(first().id, [finding("Important")]);
    await vi.waitFor(() => expect(sentKeys()).toHaveLength(1));
    report("Fixed it", SHA_B);
    await h.engine.reconcileRun(RUN);
    setPr({ ci: "passing", headSha: SHA_B });
    await h.engine.reconcileRun(RUN);
    await h.engine.reconcileRun(RUN);
    expect(reviewRows()).toHaveLength(2);
    expect(reviewRows()[1]).toMatchObject({ round: 2, sha: SHA_B, state: "running" });
    expect(h.starts).toHaveLength(2);
  });

  it("a clean review raises the ready note and lists the minor findings once", async () => {
    draftWorkspace();
    await toReview();
    const id = first().id;
    reported(id, [finding("Minor")]);
    await vi.waitFor(() => expect(noteKeys()).toContain(`ready:${RUN}:${SHA}`));
    await vi.waitFor(() => expect(h.minorCalls).toHaveLength(1));
    expect(h.minorCalls[0]).toEqual({ id, sha: SHA, retro: CALL });
    expect(store.notes().find((n) => n.key === `ready:${RUN}:${SHA}`)?.text).toBe(
      readyText(`${REPO}#7`, 12, CALL, SHA, 1),
    );
    expect(loopOf().prBody).toEqual({ reviewId: id, minor: 1 });
    expect(loopTexts()).toContain(MINOR_POSTED);
    await h.engine.reconcileRun(RUN);
    await h.engine.tick();
    expect(h.minorCalls).toHaveLength(1);
    const ready = attentionItems(config, store, clock).filter((i) => i.key.startsWith("note:"));
    expect(ready.map((i) => i.kind)).toEqual(["ready"]);
  });

  it("a clean review after a ruling on the CI failure does not say CI passed", async () => {
    await toReview();
    // the review start queued a pass of its own: let it finish before the loop is written here
    await h.engine.reconcileRun(RUN);
    setLoop({ ciFailedSha: SHA });
    reported(first().id, []);
    await vi.waitFor(() => expect(noteKeys()).toContain(`ready:${RUN}:${SHA}`));
    expect(store.notes().find((n) => n.key === `ready:${RUN}:${SHA}`)?.text).toBe(
      readyRuledText(`${REPO}#7`, 12, CALL, SHA),
    );
  });

  describe("the merge", () => {
    const ALL = ["ready", "merge", "close", "delete-remote", "delete-local"];
    const authorEnded = () => h.ended.filter((id) => id === RUN);
    /** A clean review of the pushed sha, with CI passing: the gate is open. */
    async function gateOpen(): Promise<void> {
      await toReview();
      await h.engine.reconcileRun(RUN);
      reported(first().id, []);
    }

    it("a merge workspace merges, then closes, deletes and takes the next ticket", async () => {
      await gateOpen();
      await vi.waitFor(() => expect(h.steps).toEqual(ALL));
      expect(authorEnded()).toEqual([RUN]);
      expect(h.taken).toEqual([SEAT]);
      expect(h.stepEnded["delete-remote"]).toEqual([]);
      expect(h.stepEnded["delete-local"]).toEqual([RUN]);
      expect(h.polls).toBeGreaterThan(0);
      expect(loopOf().phase).toBe("done");
      expect(loopOf().merging).toEqual({
        sha: SHA,
        done: ["ready", "merge", "close", "delete-remote", "delete-local"],
      });
      const texts = loopTexts();
      for (const t of [
        readyMarkedText(12),
        mergedText(12),
        closedIssueText(7),
        deletedRemoteText(BRANCH),
        deletedLocalText(BRANCH),
      ]) {
        expect(texts.filter((x) => x === t)).toHaveLength(1);
      }
      expect(noteKeys().filter((k) => k.startsWith("ready:"))).toEqual([]);
      // nothing is done twice
      await h.engine.tick();
      await h.engine.tick();
      expect(h.steps).toEqual(ALL);
    });

    it("does not merge while the rules leave hard_rules unset, and says which key to add", async () => {
      h.rules = async () => DEFAULT_REPO_RULES;
      await gateOpen();
      await vi.waitFor(() => expect(noteKeys()).toContain(hardRulesUnsetNoteKey(REPO)));
      await vi.waitFor(() => expect(noteKeys()).toContain(`ready:${RUN}:${SHA}`));
      expect(h.steps).toEqual([]);
      const unset = store.notes().filter((n) => n.key === hardRulesUnsetNoteKey(REPO));
      expect(unset.map((n) => n.text)).toEqual([hardRulesUnsetText(REPO)]);
      // once the rules set the key the run merges and the note clears
      h.rules = async () => ({ ...DEFAULT_REPO_RULES, hardRulesSet: true });
      await h.engine.tick();
      await h.engine.reconcileRun(RUN);
      await vi.waitFor(() => expect(h.steps).toEqual(ALL));
      expect(noteKeys()).not.toContain(hardRulesUnsetNoteKey(REPO));
    });

    it("with hard_rules unset, a PR the operator merged still gets its close and deletes", async () => {
      h.rules = async () => DEFAULT_REPO_RULES;
      await gateOpen();
      await vi.waitFor(() => expect(noteKeys()).toContain(`ready:${RUN}:${SHA}`));
      setPr({ state: "merged", ci: "passing", mergedAt: clock });
      await h.engine.reconcileRun(RUN);
      await vi.waitFor(() => expect(h.steps).toEqual(["close", "delete-remote", "delete-local"]));
      expect(h.steps).not.toContain("merge");
    });

    it("a draft repo with hard_rules unset gets no note", async () => {
      draftWorkspace();
      h.rules = async () => DEFAULT_REPO_RULES;
      await toReview();
      reported(first().id, []);
      await vi.waitFor(() => expect(noteKeys()).toContain(`ready:${RUN}:${SHA}`));
      await h.engine.tick();
      expect(noteKeys()).not.toContain(hardRulesUnsetNoteKey(REPO));
    });

    it("a branch that is only behind main merges without updating or a hold note", async () => {
      h.gate = { ...need(h.gate), containsMain: false };
      await gateOpen();
      await h.engine.reconcileRun(RUN);
      await vi.waitFor(() => expect(h.steps).toEqual(ALL));
      expect(h.updates).toEqual([]);
      expect(noteKeys().some((k) => k.startsWith("behind:"))).toBe(false);
    });

    it("mc/review not passing on GitHub is not merged", async () => {
      report();
      await h.engine.reconcileRun(RUN);
      setPr({
        ci: "passing",
        checks: [
          {
            name: "mc/review",
            kind: "status",
            state: "pending",
            conclusion: "PENDING",
            attempt: null,
            url: null,
          },
        ],
      });
      await h.engine.reconcileRun(RUN);
      reported(first().id, []);
      await h.engine.reconcileRun(RUN);
      expect(h.steps).toEqual([]);
    });

    describe("main moves", () => {
      const MAIN = "d".repeat(40);
      const behindMain = () => {
        h.gate = { ...need(h.gate), mainSha: MAIN, containsMain: false };
      };

      async function conflictingReview(): Promise<void> {
        await toReview();
        await h.engine.reconcileRun(RUN);
        setPr({ ci: "passing", mergeable: "CONFLICTING" });
        reported(first().id, []);
      }

      it("a clean update moves the run to ci, pushes the merge, and reviews the new sha", async () => {
        behindMain();
        h.updateResults = [{ ok: true, kind: "merged", sha: SHA_B, parent: SHA, prSame: false }];
        await conflictingReview();
        await vi.waitFor(() => expect(h.pushes.length).toBeGreaterThanOrEqual(2));
        expect(h.updates).toEqual([{ mainSha: MAIN, worktree: join(dir, "wt") }]);
        expect(loopOf()).toMatchObject({ phase: "ci", pushFor: SHA_B });
        expect(loopOf().mainMerge ?? null).toBeNull();
        expect(store.runPush(RUN)?.sha).toBe(SHA_B);
        expect(loopTexts()).toContain(`merged main ${MAIN.slice(0, 7)} into the branch`);
        // the branch now has main: CI passes on the new sha, and it is reviewed
        h.gate = { ...need(h.gate), containsMain: true };
        setPr({ ci: "passing", headSha: SHA_B });
        await h.engine.reconcileRun(RUN);
        await h.engine.reconcileRun(RUN);
        expect(reviewRows().map((r) => r.sha)).toContain(SHA_B);
        // nothing is merged into the branch twice
        expect(h.updates).toHaveLength(1);
      });

      describe("FLIGHT asks for it", () => {
        const parkedOnConflict = async () => {
          await toReview();
          await h.engine.reconcileRun(RUN);
          setLoop({
            phase: "parked",
            parked: { kind: "conflict", reason: "PR #12 conflicts with main", ended: false },
          });
        };

        it("syncMain merges main with the engine's own merge", async () => {
          behindMain();
          h.updateResults = [{ ok: true, kind: "merged", sha: SHA_B, parent: SHA, prSame: false }];
          await parkedOnConflict();
          const before = loopOf().epoch;
          expect(await h.engine.syncMain(RUN)).toEqual({
            kind: "merged",
            sha: SHA_B,
            mainSha: MAIN,
          });
          expect(h.updates).toEqual([{ mainSha: MAIN, worktree: join(dir, "wt") }]);
          expect(loopOf()).toMatchObject({
            phase: "ci",
            pushFor: SHA_B,
            parked: null,
            epoch: before + 1,
            unparkedAt: clock,
          });
          expect(store.branchCommits(REPO, BRANCH).has(SHA_B)).toBe(true);
          expect(loopTexts()).toContain(`merged main ${MAIN.slice(0, 7)} into the branch`);
        });

        it("a conflicting merge goes back to the author", async () => {
          behindMain();
          h.updateResults = [{ ok: true, kind: "conflict", files: ["apps/a.ts"] }];
          await parkedOnConflict();
          expect(await h.engine.syncMain(RUN)).toEqual({ kind: "conflict", files: ["apps/a.ts"] });
          expect(loopOf()).toMatchObject({
            phase: "working",
            mainMerge: { mainSha: MAIN, files: ["apps/a.ts"] },
          });
        });

        it("a branch that has main already is current, and nothing is merged", async () => {
          await parkedOnConflict();
          expect(await h.engine.syncMain(RUN)).toEqual({ kind: "current", mainSha: MAIN });
          expect(h.updates).toEqual([]);
        });

        it("a run in review that is behind is merged without a park", async () => {
          behindMain();
          h.updateResults = [{ ok: true, kind: "merged", sha: SHA_B, parent: SHA, prSame: true }];
          await toReview();
          await h.engine.reconcileRun(RUN);
          const before = loopOf().epoch;
          expect(await h.engine.syncMain(RUN)).toMatchObject({ kind: "merged" });
          expect(loopOf().epoch).toBe(before);
        });

        it("refuses a seat in a turn, a worktree with changes, a run in the wrong place", async () => {
          behindMain();
          await parkedOnConflict();
          h.facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
          expect(await h.engine.syncMain(RUN)).toEqual({
            kind: "refused",
            text: "its seat is in a turn",
          });
          h.facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
          // updateBranch answers wait (its default): the worktree has changes
          expect(await h.engine.syncMain(RUN)).toEqual({
            kind: "refused",
            text: "the worktree has uncommitted changes",
          });
          expect(loopOf().phase).toBe("parked");
          setLoop({ parked: { kind: "ci", reason: "x", ended: false } });
          expect(await h.engine.syncMain(RUN)).toMatchObject({ kind: "refused" });
          setLoop({ phase: "working", parked: null });
          expect(await h.engine.syncMain(RUN)).toEqual({
            kind: "refused",
            text: "the run is not in CI or review, or parked on a conflict",
          });
        });

        it("refuses a branch with unpushed commits, and a draft repo", async () => {
          behindMain();
          await parkedOnConflict();
          commit("e".repeat(40));
          expect(await h.engine.syncMain(RUN)).toEqual({
            kind: "refused",
            text: "the branch has unpushed commits",
          });
          draftWorkspace();
          expect(await h.engine.syncMain(RUN)).toEqual({
            kind: "refused",
            text: "its repo is a draft workspace",
          });
          expect(h.updates).toEqual([]);
        });
      });

      it("a clean update that leaves the PR's diff as it was carries the review", async () => {
        behindMain();
        h.updateResults = [{ ok: true, kind: "merged", sha: SHA_B, parent: SHA, prSame: true }];
        await conflictingReview();
        await vi.waitFor(() => expect(h.pushes.length).toBeGreaterThanOrEqual(2));
        h.gate = { ...need(h.gate), containsMain: true };
        setPr({ ci: "passing", headSha: SHA_B });
        await h.engine.reconcileRun(RUN);
        await h.engine.reconcileRun(RUN);
        expect(reviewRows().map((r) => r.sha)).not.toContain(SHA_B);
        expect(loopOf().carry).toEqual({ from: SHA, to: SHA_B });
        expect(loopTexts()).toContain(reviewCarriedText(SHA, SHA_B));
        expect(h.statusCalls).toContainEqual({
          sha: SHA_B,
          state: "success",
          description: "QA review passed (carried from aaaaaaa, main merged)",
        });
        await vi.waitFor(() => expect(h.steps).toContain("merge"));
      });

      it("a second clean update carries the first review on", async () => {
        const SHA_C = "f".repeat(40);
        behindMain();
        h.updateResults = [
          { ok: true, kind: "merged", sha: SHA_B, parent: SHA, prSame: true },
          { ok: true, kind: "merged", sha: SHA_C, parent: SHA_B, prSame: true },
        ];
        await conflictingReview();
        await vi.waitFor(() => expect(store.runPush(RUN)?.sha).toBe(SHA_B));
        setPr({ ci: "passing", headSha: SHA_B, mergeable: "CONFLICTING" });
        // main moves again and conflicts before the first merge is judged
        h.gate = { ...need(h.gate), mainSha: "9".repeat(40), containsMain: false };
        await vi.waitFor(async () => {
          await h.engine.reconcileRun(RUN);
          expect(h.updates).toHaveLength(2);
          expect(store.runPush(RUN)?.sha).toBe(SHA_C);
        });
        expect(loopOf().carry).toEqual({ from: SHA, to: SHA_C });
        expect(reviewRows().map((r) => r.sha)).not.toContain(SHA_B);
        expect(reviewRows().map((r) => r.sha)).not.toContain(SHA_C);
        expect(loopTexts()).toContain(reviewCarriedText(SHA, SHA_C));
      });

      it("a queued review of the reviewed sha survives a carried update and starts", async () => {
        h.busyList = [{ seatId: RETRO, state: "running" }];
        await toReview();
        await h.engine.reconcileRun(RUN);
        expect(first().sha).toBe(SHA);
        // a PR GitHub calls conflicting is brought up to date while its review waits
        setPr({ ci: "passing", mergeable: "CONFLICTING" });
        behindMain();
        h.updateResults = [{ ok: true, kind: "merged", sha: SHA_B, parent: SHA, prSame: true }];
        await vi.waitFor(async () => {
          await h.engine.reconcileRun(RUN);
          expect(store.runPush(RUN)?.sha).toBe(SHA_B);
        });
        h.gate = { ...need(h.gate), containsMain: true };
        setPr({ ci: "passing", headSha: SHA_B });
        // the reviewer comes free: the queued review is wanted still, and starts
        h.busyList = [];
        await h.engine.tick();
        expect(first().state).not.toBe("superseded");
        expect(reviewRows().map((r) => r.sha)).not.toContain(SHA_B);
        expect(h.statusCalls).toContainEqual({
          sha: SHA_B,
          state: "pending",
          description: `${REVIEW_STATUS_QUEUED} (carried from aaaaaaa, main merged)`,
        });
      });

      it("a carried blocking review sends its findings in the fix line", async () => {
        h.busyList = [{ seatId: RETRO, state: "running" }];
        await toReview();
        await h.engine.reconcileRun(RUN);
        setPr({ ci: "passing", mergeable: "CONFLICTING" });
        behindMain();
        h.updateResults = [{ ok: true, kind: "merged", sha: SHA_B, parent: SHA, prSame: true }];
        await vi.waitFor(async () => {
          await h.engine.reconcileRun(RUN);
          expect(store.runPush(RUN)?.sha).toBe(SHA_B);
        });
        h.gate = { ...need(h.gate), containsMain: true };
        setPr({ ci: "passing", headSha: SHA_B });
        h.busyList = [];
        await h.engine.tick();
        reported(first().id, [finding("Important")]);
        await h.engine.reconcileRun(RUN);
        expect(reviewRows().map((r) => r.sha)).not.toContain(SHA_B);
        expect(h.steps).not.toContain("merge");
        await vi.waitFor(() =>
          expect(h.sent.some((s) => s.text.includes("a Important thing"))).toBe(true),
        );
      });

      it("a conflict is left for the seat, and the line goes once", async () => {
        behindMain();
        h.updateResults = [{ ok: true, kind: "conflict", files: ["apps/a.ts", "apps/b.ts"] }];
        // a busy seat is offered the line again, and nothing is recorded until it goes through
        h.busy = true;
        await conflictingReview();
        await vi.waitFor(() => expect(loopOf()?.mainMerge).toBeTruthy());
        await h.engine.tick();
        expect(sentKeys()).toEqual([]);
        expect(store.comms(0)).toEqual([]);
        h.busy = false;
        await h.engine.tick();
        await vi.waitFor(() => expect(sentKeys()).toContain(`conflict:${RUN}:${MAIN}`));
        expect(loopOf()).toMatchObject({
          phase: "working",
          mainMerge: { mainSha: MAIN, files: ["apps/a.ts", "apps/b.ts"] },
        });
        expect(loopTexts()).toContain(`merging main ${MAIN.slice(0, 7)} conflicted in 2 files`);
        expect(h.sent.find((s) => s.key.startsWith("conflict:"))?.text).toContain(
          "conflicted in: apps/a.ts, apps/b.ts",
        );
        await h.engine.tick();
        expect(sentKeys().filter((k) => k.startsWith("conflict:"))).toHaveLength(1);
        expect(h.updates).toHaveLength(1);
        expect(store.comms(0)).toEqual([
          {
            at: expect.any(Number),
            from: "MC",
            to: SEAT,
            ticket: `${REPO}#7`,
            text: expect.stringContaining("conflicted in: apps/a.ts, apps/b.ts"),
          },
        ]);
      });

      it("a conflicting PR in ci is merged with main", async () => {
        report();
        await h.engine.reconcileRun(RUN);
        h.gate = { ...need(h.gate), mainSha: MAIN, containsMain: false };
        setPr({ mergeable: "CONFLICTING", ci: null });
        h.updateResults = [{ ok: true, kind: "conflict", files: ["apps/a.ts"] }];
        await h.engine.reconcileRun(RUN);
        expect(h.updates).toEqual([{ mainSha: MAIN, worktree: join(dir, "wt") }]);
        expect(loopOf()).toMatchObject({
          phase: "working",
          mainMerge: { mainSha: MAIN, files: ["apps/a.ts"] },
        });
        expect(loopOf().parked).toBeNull();
      });

      it("with hard_rules unset, a conflicting PR in ci is still merged with main", async () => {
        h.rules = async () => DEFAULT_REPO_RULES;
        report();
        await h.engine.reconcileRun(RUN);
        h.gate = { ...need(h.gate), mainSha: MAIN, containsMain: false };
        setPr({ mergeable: "CONFLICTING", ci: null });
        h.updateResults = [{ ok: true, kind: "conflict", files: ["apps/a.ts"] }];
        await h.engine.reconcileRun(RUN);
        expect(h.updates).toEqual([{ mainSha: MAIN, worktree: join(dir, "wt") }]);
        expect(loopOf().parked).toBeNull();
      });

      it("waits while the worktree has changes, and asks again on the next pass", async () => {
        behindMain();
        await conflictingReview();
        await vi.waitFor(() => expect(h.updates).toHaveLength(1));
        expect(loopOf().phase).toBe("review");
        await h.engine.tick();
        expect(h.updates.length).toBeGreaterThanOrEqual(2);
        expect(loopOf().phase).toBe("review");
      });

      it("a final refusal parks the run", async () => {
        behindMain();
        h.updateResults = [
          { ok: false, text: "merging main into the branch failed", transient: false },
        ];
        await conflictingReview();
        await vi.waitFor(() => expect(loopOf().phase).toBe("parked"));
        expect(loopOf().parked).toMatchObject({
          kind: "refused",
          reason: "merging main into the branch failed",
        });
      });
    });

    it("reads origin's tip every pass but reuses the rest while sha and tip are unchanged", async () => {
      await toReview();
      await h.engine.reconcileRun(RUN);
      await h.engine.reconcileRun(RUN);
      expect(h.gateReads.length).toBeGreaterThanOrEqual(2);
      expect(h.gateReads[0]?.known).toBe(false);
      expect(h.gateReads.slice(1).every((g) => g.known)).toBe(true);
    });

    it("a run that touches a hard-rule file is not marked ready or merged", async () => {
      h.touches = [".github/ci.yml"];
      h.gate = { ...need(h.gate), strays: [".github/ci.yml"] };
      await gateOpen();
      await vi.waitFor(() => expect(noteKeys()).toContain(`ready:${RUN}:${SHA}`));
      expect(h.steps).toEqual([]);
      expect(store.notes().find((n) => n.key === `ready:${RUN}:${SHA}`)?.text).toBe(
        readyHardRuleText(`${REPO}#7`, 12, [".github/ci.yml"]),
      );
    });

    it("a superuser repo cannot omit the rules and CI from its merge floor", async () => {
      for (const repo of config.repos) repo.flightPowers = "superuser";
      h.rules = async () => ({ ...DEFAULT_REPO_RULES, hardRulesSet: true, hardRules: ["x/**"] });
      h.touches = ["CLAUDE.md", ".github/workflows/ci.yml"];
      await gateOpen();
      await vi.waitFor(() => expect(noteKeys()).toContain(`ready:${RUN}:${SHA}`));
      expect(h.hardRuleLists).toEqual([
        expect.arrayContaining(["x/**", "CLAUDE.md", ".github/**"]),
      ]);
      expect(loopOf().touches).toEqual({ sha: SHA, paths: h.touches, flightPowers: "superuser" });
      expect(h.steps).toEqual([]);
      expect(store.notes().find((n) => n.key === `ready:${RUN}:${SHA}`)?.text).toBe(
        readyHardRuleText(`${REPO}#7`, 12, h.touches),
      );
    });

    it("rechecks floor 7 when a repo is raised during review of the same sha", async () => {
      h.rules = async () => ({ ...DEFAULT_REPO_RULES, hardRulesSet: true, hardRules: ["x/**"] });
      h.touches = ["claude.md", ".github/workflows/ci.yml"];
      await toReview();
      await h.engine.reconcileRun(RUN);
      expect(loopOf().touches?.paths).toEqual([]);
      for (const repo of config.repos) repo.flightPowers = "superuser";
      reported(first().id, []);
      await vi.waitFor(() => expect(noteKeys()).toContain(`ready:${RUN}:${SHA}`));
      expect(loopOf().touches).toEqual({ sha: SHA, paths: h.touches, flightPowers: "superuser" });
      expect(h.steps).toEqual([]);
      expect(store.notes().find((n) => n.key === `ready:${RUN}:${SHA}`)?.text).toBe(
        readyHardRuleText(`${REPO}#7`, 12, h.touches),
      );
    });

    it("a standard repo uses only its own hard-rule list at the merge step", async () => {
      for (const repo of config.repos) repo.flightPowers = "standard";
      h.rules = async () => ({ ...DEFAULT_REPO_RULES, hardRulesSet: true, hardRules: ["x/**"] });
      h.touches = ["CLAUDE.md", ".github/workflows/ci.yml"];
      await gateOpen();
      await vi.waitFor(() => expect(h.steps).toEqual(ALL));
      expect(h.hardRuleLists).toEqual([["x/**"]]);
      expect(loopOf().touches).toEqual({ sha: SHA, paths: [], flightPowers: "standard" });
    });

    it("a merge refused finally parks the run as merge-step and runs no later step", async () => {
      h.stepResults.merge = [{ ok: false, text: "the head moved", transient: false }];
      await gateOpen();
      await vi.waitFor(() => expect(loopOf().phase).toBe("parked"));
      const reason = mergeStepFailedText("merge", "the head moved");
      expect(reason).toBe("merge failed: the head moved");
      expect(loopOf().parked).toEqual({ kind: "merge-step", reason, ended: false });
      expect(h.steps).toEqual(["ready", "merge"]);
      expect(loopTexts()).toContain(parkedEventText(reason));
      await h.engine.tick();
      expect(h.steps).toEqual(["ready", "merge"]);
      expect(authorEnded()).toEqual([]);
    });

    it("a failed step after the merge parks the run naming the step", async () => {
      h.stepResults["delete-remote"] = [{ ok: false, text: "the branch moved", transient: false }];
      await gateOpen();
      await vi.waitFor(() => expect(loopOf().parked?.kind).toBe("merge-step"));
      expect(loopOf().parked?.reason).toBe(
        mergeStepFailedText("delete the remote branch", "the branch moved"),
      );
      expect(h.steps).toEqual(["ready", "merge", "close", "delete-remote"]);
      expect(authorEnded()).toEqual([]);
    });

    it("a transient refusal on three ticks in a row parks it", async () => {
      const down = { ok: false, text: "gh is down", transient: true } as const;
      h.stepResults.merge = [down, down, down];
      await gateOpen();
      await vi.waitFor(() => expect(h.steps).toEqual(["ready", "merge"]));
      expect(loopOf().phase).toBe("review");
      for (const n of [2, 3]) {
        clock += ENGINE_TICK_MS;
        await h.engine.reconcileRun(RUN);
        expect(h.steps.filter((s) => s === "merge")).toHaveLength(n);
      }
      expect(loopOf().parked).toEqual({
        kind: "merge-step",
        reason: mergeStepFailedText("merge", "gh is down"),
        ended: false,
      });
    });

    it("a local branch that cannot be deleted raises a note and does not park the run", async () => {
      h.stepResults["delete-local"] = [{ ok: false, text: "not merged", transient: false }];
      await gateOpen();
      await vi.waitFor(() => expect(noteKeys()).toContain(cleanupBranchNoteKey(RUN)));
      const note = store.notes().find((n) => n.key === cleanupBranchNoteKey(RUN));
      expect(note?.kind).toBe("blocked");
      expect(note?.text).toContain(BRANCH);
      expect(loopTexts()).toContain(localNotDeletedText(BRANCH, "not merged"));
      expect(loopOf().phase).toBe("done");
      expect(h.taken).toEqual([SEAT]);
      // a later pass of the done run keeps it
      await h.engine.reconcileRun(RUN);
      expect(noteKeys()).toContain(cleanupBranchNoteKey(RUN));
      // the sweep keeps it while the branch is there, though the PR is done
      setPr({ state: "merged", ci: "passing", mergedAt: clock });
      await h.engine.tick();
      expect(noteKeys()).toContain(cleanupBranchNoteKey(RUN));
      // and clears it once the branch is gone
      h.branchGone = true;
      await h.engine.tick();
      expect(noteKeys()).not.toContain(cleanupBranchNoteKey(RUN));
    });

    it("a transient refusal to delete the local branch is retried, and raises a note after 3 tries", async () => {
      const gone = { ok: false as const, text: "git failed: fetch", transient: true };
      h.stepResults["delete-local"] = [gone, gone, gone, gone, gone];
      await gateOpen();
      await vi.waitFor(() => expect(h.steps).toContain("delete-local"));
      expect(noteKeys()).not.toContain(cleanupBranchNoteKey(RUN));
      expect(loopOf().merging?.done ?? []).not.toContain("delete-local");
      // reconciles within the same tick count no further
      await h.engine.reconcileRun(RUN);
      await h.engine.reconcileRun(RUN);
      expect(noteKeys()).not.toContain(cleanupBranchNoteKey(RUN));
      clock += ENGINE_TICK_MS;
      await h.engine.reconcileRun(RUN);
      expect(noteKeys()).not.toContain(cleanupBranchNoteKey(RUN));
      expect(loopOf().merging?.done ?? []).not.toContain("delete-local");
      clock += ENGINE_TICK_MS;
      await h.engine.reconcileRun(RUN);
      expect(noteKeys()).toContain(cleanupBranchNoteKey(RUN));
      expect(loopOf().merging?.done).toContain("delete-local");
    });

    it("a transient refusal of a step stops the pass, and the step is retried next tick", async () => {
      h.stepResults.close = [{ ok: false, text: "gh is down", transient: true }];
      await gateOpen();
      await vi.waitFor(() => expect(h.steps).toEqual(["ready", "merge", "close"]));
      expect(h.steps).toEqual(["ready", "merge", "close"]);
      expect(authorEnded()).toEqual([]);
      expect(h.taken).toEqual([]);
      clock += ENGINE_TICK_MS;
      await h.engine.reconcileRun(RUN);
      expect(h.steps).toEqual(ALL.slice(0, 3).concat(ALL.slice(2)));
      expect(authorEnded()).toEqual([RUN]);
      expect(h.taken).toEqual([SEAT]);
    });

    it("a transient refusal to mark ready sends no merge in that pass", async () => {
      h.stepResults.ready = [{ ok: false, text: "gh is down", transient: true }];
      await gateOpen();
      await vi.waitFor(() => expect(h.steps).toEqual(["ready"]));
      expect(h.steps).not.toContain("merge");
    });

    it("a PR head that moved since the gate parks nothing and clears the gate's facts", async () => {
      h.stepResults.merge = [{ ok: false, text: MERGE_HEAD_MOVED, transient: false }];
      await gateOpen();
      await vi.waitFor(() => expect(h.steps).toEqual(["ready", "merge"]));
      await vi.waitFor(() => expect(h.polls).toBeGreaterThan(0));
      expect(loopOf().parked ?? null).toBeNull();
      expect(loopOf().phase).toBe("review");
      expect(loopOf().lastRefusal ?? null).toBeNull();
      expect(loopOf().gate ?? null).toBeNull();
      expect(loopOf().touches ?? null).toBeNull();
      expect(loopTexts().some((t) => t.includes(MERGE_HEAD_MOVED))).toBe(false);
    });

    it.each([
      ["MERGEABLE", MERGE_CONFLICTING],
      ["UNKNOWN", MERGE_CONFLICTING],
    ] as const)(
      "refreshes a stale %s PR after a merge conflict without counting refusals",
      async (mergeable, text) => {
        const refusal = { ok: false, text, transient: true } as const;
        h.stepResults.merge = Array(4).fill(refusal);
        await toReview();
        await h.engine.reconcileRun(RUN);
        setPr({ ci: "passing", mergeable });
        reported(first().id, []);
        await vi.waitFor(() => expect(h.steps).toEqual(["ready", "merge"]));
        for (const n of [1, 2, 3, 4]) {
          if (n > 1) {
            clock += ENGINE_TICK_MS;
            await h.engine.reconcileRun(RUN);
          }
          expect(h.steps.filter((s) => s === "merge")).toHaveLength(n);
          expect(h.polls).toBe(n);
          expect(loopOf()).toMatchObject({
            phase: "review",
            parked: null,
            gate: null,
            transient: 0,
            lastRefusal: null,
          });
        }
        expect(authorEnded()).toEqual([]);
        expect(h.steps).not.toContain("close");
        // The refreshed GitHub and gate facts route the next pass to an update.
        setPr({ ci: "passing", mergeable: "CONFLICTING" });
        h.gate = { ...need(h.gate), containsMain: false };
        await h.engine.reconcileRun(RUN);
        expect(h.gateReads.at(-1)?.known).toBe(false);
        expect(h.updates).toEqual([{ mainSha: need(h.gate).mainSha, worktree: join(dir, "wt") }]);
        expect(h.steps.filter((s) => s === "merge")).toHaveLength(4);
      },
    );

    it("counts a merge refused for another reason (a branch policy), as before", async () => {
      const refusal = {
        ok: false,
        text: "gh pr merge: Pull request is not mergeable: the base branch policy prohibits the merge.",
        transient: true,
      } as const;
      h.stepResults.merge = Array(4).fill(refusal);
      await toReview();
      await h.engine.reconcileRun(RUN);
      setPr({ ci: "passing", mergeable: "MERGEABLE" });
      reported(first().id, []);
      await vi.waitFor(() => expect(h.steps).toEqual(["ready", "merge"]));
      expect(loopOf().transient).toBe(1);
      expect(loopOf().lastRefusal).not.toBeNull();
    });

    it("leaves one Activity line while a merge waits on a conflict", async () => {
      h.stepResults.merge = Array(2).fill({ ok: false, text: MERGE_CONFLICTING, transient: true });
      await toReview();
      await h.engine.reconcileRun(RUN);
      setPr({ ci: "passing", mergeable: "MERGEABLE" });
      reported(first().id, []);
      await vi.waitFor(() => expect(h.steps).toEqual(["ready", "merge"]));
      clock += ENGINE_TICK_MS;
      await h.engine.reconcileRun(RUN);
      expect(loopTexts().filter((t) => t === MERGE_WAITS_ON_MAIN)).toHaveLength(1);
    });

    it("a repo that is not a merge workspace takes no merge step, whatever was planned", async () => {
      await toReview();
      await h.engine.reconcileRun(RUN);
      // the loop plans from the repo as it reads it for the snapshot; `act` reads it again
      const repo = need(config.repos[0]);
      let reads = 0;
      Object.defineProperty(repo, "autonomy", {
        configurable: true,
        get: () => (++reads <= 2 ? "merge" : "draft"),
      });
      reported(first().id, []);
      await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(3));
      await h.engine.reconcileRun(RUN);
      expect(h.steps).toEqual([]);
    });

    it("a merged run that crashed before deleting its local branch still finishes it", async () => {
      await gateOpen();
      await vi.waitFor(() => expect(h.steps).toEqual(ALL));
      setLoop({ merging: { sha: SHA, done: ["ready", "merge", "close", "delete-remote"] } });
      h.steps.length = 0;
      await h.engine.tick();
      await vi.waitFor(() => expect(h.steps).toEqual(["delete-local"]));
      expect(loopOf().merging?.done).toContain("delete-local");
    });

    it("the local branch is not deleted, nor the step recorded, while the run has not ended", async () => {
      h.endBlocked = true;
      await gateOpen();
      await vi.waitFor(() => expect(h.steps).toContain("delete-remote"));
      await h.engine.reconcileRun(RUN);
      expect(h.steps).not.toContain("delete-local");
      expect(loopOf().merging?.done ?? []).not.toContain("delete-local");
      h.endBlocked = false;
      await h.engine.reconcileRun(RUN);
      await vi.waitFor(() => expect(h.steps).toContain("delete-local"));
      expect(loopOf().merging?.done).toContain("delete-local");
    });

    it("the sweep leaves a merged run's cleanup note", async () => {
      await gateOpen();
      await vi.waitFor(() => expect(h.steps).toEqual(ALL));
      store.raiseNote({
        key: `cleanup:${RUN}`,
        kind: "blocked",
        runId: RUN,
        seatId: SEAT,
        repoId: REPO,
        text: "worktree left behind",
        at: clock,
      });
      setPr({ state: "merged", ci: "passing", mergedAt: clock });
      await h.engine.tick();
      expect(noteKeys()).toContain(`cleanup:${RUN}`);
    });

    it("a draft workspace makes no ready, merge, close or delete call", async () => {
      draftWorkspace();
      await gateOpen();
      await vi.waitFor(() => expect(noteKeys()).toContain(`ready:${RUN}:${SHA}`));
      setPr({ state: "merged", ci: "passing", mergedAt: clock });
      await h.engine.reconcileRun(RUN);
      expect(h.steps).toEqual([]);
      expect(h.gateReads).toEqual([]);
      expect(authorEnded()).toEqual([RUN]);
      expect(h.taken).toEqual([SEAT]);
    });
  });

  it("a transient PR-body failure is tried three times, then given up", async () => {
    const down = { ok: false, text: "gh is down", transient: true } as const;
    h.minorResults = [down, down, down];
    draftWorkspace();
    await toReview();
    reported(first().id, [finding("Minor")]);
    await vi.waitFor(() => expect(h.minorCalls).toHaveLength(1));
    await h.engine.reconcileRun(RUN);
    await h.engine.reconcileRun(RUN);
    expect(h.minorCalls).toHaveLength(3);
    expect(loopTexts()).toContain(minorNotPostedText("gh is down"));
    await h.engine.reconcileRun(RUN);
    expect(h.minorCalls).toHaveLength(3);
  });

  it("a review run that crashes is retried once, then the author is parked", async () => {
    await toReview();
    const one = first();
    crash(need(one.runId));
    await vi.waitFor(() => expect(h.starts).toHaveLength(2));
    expect(first().state).toBe("failed");
    expect(loopTexts()).toContain(
      reviewFailedText(CALL, SHA, "the review run ended (the process crashed)"),
    );
    const two = need(reviewRows()[1]);
    expect(two).toMatchObject({ attempt: 2, state: "running" });
    crash(need(two.runId));
    await vi.waitFor(() => expect(loopOf().phase).toBe("parked"));
    expect(loopOf().parked?.kind).toBe("review-failed");
    expect(h.moves.at(-1)?.column).toBe("Blocked");
  });

  it("the PR head moving supersedes the review and ends its run", async () => {
    await toReview();
    const rv = first();
    setPr({ ci: "passing", headSha: SHA_B });
    await h.engine.reconcileRun(RUN);
    expect(first().state).toBe("superseded");
    expect(h.ended).toContain(need(rv.runId));
    expect(loopTexts()).toContain(reviewDroppedText(SHA));
    expect(noteKeys()).toContain(`headmoved:${RUN}:${SHA_B}`);
  });

  it("the author's run ending supersedes the review and ends its run", async () => {
    await toReview();
    const rv = first();
    store.setRunEnded(RUN, clock, "ok", "operator");
    emit({ kind: "run-ended", seatId: SEAT, runId: RUN, endedBy: "operator" });
    await vi.waitFor(() => expect(first().state).toBe("superseded"));
    await vi.waitFor(() => expect(h.ended).toContain(need(rv.runId)));
  });

  it("The operator's message after a review park waives the findings", async () => {
    await toReview();
    for (const n of [901, 902]) {
      store.claimLine(`fix:${RUN}:0:${n}`, {
        runId: RUN,
        seatId: SEAT,
        origin: "engine",
        text: "x",
        at: clock,
      });
    }
    reported(first().id, [finding("Critical")]);
    await vi.waitFor(() => expect(loopOf().phase).toBe("parked"));
    expect(loopOf().parked?.kind).toBe("review");
    await h.engine.onOperatorMessage(RUN);
    expect(loopOf()).toMatchObject({ phase: "review", reviewWaivedSha: SHA });
    const ready = store.notes().find((n) => n.key === `ready:${RUN}:${SHA}`);
    expect(ready?.text).toBe(readyWaivedText(`${REPO}#7`, 12, SHA));
  });

  describe("the mc/review commit status", () => {
    const status = (state: string, description: string) => ({ sha: SHA, state, description });

    it("review requested: mc/review is pending", async () => {
      h.busyList = [{ seatId: RETRO, state: "running" }];
      await toReview();
      expect(h.statusCalls).toEqual([status("pending", REVIEW_STATUS_QUEUED)]);
      await h.engine.reconcileRun(RUN);
      expect(h.statusCalls).toHaveLength(1);
    });

    it("a clean review: mc/review is success", async () => {
      await toReview();
      reported(first().id, []);
      await vi.waitFor(() =>
        expect(h.statusCalls.at(-1)).toEqual(status("success", REVIEW_STATUS_PASSED)),
      );
      expect(h.statusCalls).toContainEqual(status("pending", REVIEW_STATUS_RUNNING));
    });

    it("blocking findings: mc/review is failure", async () => {
      await toReview();
      reported(first().id, [finding("Important")]);
      await vi.waitFor(() =>
        expect(h.statusCalls.at(-1)).toEqual(status("failure", REVIEW_STATUS_BLOCKED)),
      );
    });

    it("waived: mc/review is success, waived", async () => {
      await toReview();
      for (const n of [901, 902]) {
        store.claimLine(`fix:${RUN}:0:${n}`, {
          runId: RUN,
          seatId: SEAT,
          origin: "engine",
          text: "x",
          at: clock,
        });
      }
      reported(first().id, [finding("Critical")]);
      await vi.waitFor(() => expect(loopOf().phase).toBe("parked"));
      await h.engine.onOperatorMessage(RUN);
      expect(h.statusCalls.at(-1)).toEqual(status("success", REVIEW_STATUS_WAIVED));
    });

    it("no review seat: no status", async () => {
      await toReview();
      expect(h.statusCalls.length).toBeGreaterThan(0);
      // the review is in the store, and would be a status, were the seat still in the config
      seats().splice(
        seats().findIndex((s) => s.id === RETRO),
        1,
      );
      reported(first().id, []);
      h.statusCalls.length = 0;
      await h.engine.tick();
      await h.engine.reconcileRun(RUN);
      expect(h.statusCalls).toEqual([]);
    });

    it("a PR that is not open: no status", async () => {
      await toReview();
      reported(first().id, []);
      setPr({ ci: "passing", state: "closed" });
      h.statusCalls.length = 0;
      await h.engine.reconcileRun(RUN);
      expect(h.statusCalls).toEqual([]);
    });

    it("a status write that throws is logged and tried again", async () => {
      h.statusThrows = new Error("boom");
      h.busyList = [{ seatId: RETRO, state: "running" }];
      await expect(toReview()).resolves.toBeUndefined();
      expect(h.logs).toContain(`${RUN}: review status not set: boom`);
      await h.engine.tick();
      expect(h.statusCalls.length).toBeGreaterThan(1);
      expect(loopOf().phase).toBe("review");
    });

    it("a lasting failure is logged once, though tried on every pass", async () => {
      h.statusResults = Array.from({ length: 4 }, () => ({
        ok: false as const,
        text: "gh is down",
        transient: true,
      }));
      h.busyList = [{ seatId: RETRO, state: "running" }];
      await toReview();
      await h.engine.tick();
      await h.engine.tick();
      expect(h.statusCalls.length).toBeGreaterThan(2);
      expect(h.logs.filter((l) => l.includes("review status not set"))).toEqual([
        `${RUN}: review status not set: gh is down`,
      ]);
    });

    it("an ended run keeps no status of its own and writes none", async () => {
      await toReview();
      reported(first().id, []);
      await vi.waitFor(() =>
        expect(h.statusCalls.at(-1)).toEqual(status("success", REVIEW_STATUS_PASSED)),
      );
      await h.engine.reconcileRun(RUN);
      const kept = h.statusCalls.length;
      store.setRunEnded(RUN, clock, "ok", "operator");
      await h.engine.reconcileRun(RUN);
      expect(h.statusCalls.length).toBe(kept);
      // its later ended passes write nothing either: the status is final once the run ends
      await h.engine.reconcileRun(RUN);
      await h.engine.reconcileRun(RUN);
      expect(h.statusCalls.length).toBe(kept);
    });

    it("a failed status write is logged and tried again on the next tick", async () => {
      h.statusResults = [{ ok: false, text: "gh is down", transient: true }];
      h.busyList = [{ seatId: RETRO, state: "running" }];
      await expect(toReview()).resolves.toBeUndefined();
      expect(h.logs).toContain(`${RUN}: review status not set: gh is down`);
      expect(h.statusCalls).toHaveLength(1);
      await h.engine.tick();
      expect(h.statusCalls).toEqual([
        status("pending", REVIEW_STATUS_QUEUED),
        status("pending", REVIEW_STATUS_QUEUED),
      ]);
      expect(loopOf().phase).toBe("review");
    });
  });

  describe("keeping RETRO's run going", () => {
    it("a parked seat gets one line after its reset, none before", async () => {
      await toReview();
      const runId = need(first().runId);
      store.setSeatSession({ ...need(store.seatSession(RETRO)), state: "parked" });
      const until = clock + 10 * MIN;
      h.retroFacts = { inTurn: false, resumedAt: null, rateLimitedUntil: until };
      await h.engine.tick();
      expect(sentKeys().filter((k) => k.startsWith("rv-limit:"))).toEqual([]);
      clock += 11 * MIN;
      await h.engine.tick();
      await h.engine.tick();
      expect(sentKeys().filter((k) => k.startsWith("rv-limit:"))).toEqual([
        `rv-limit:${runId}:${until}`,
      ]);
      expect(first().state).toBe("running");
    });

    it("a resumed seat gets one resume line", async () => {
      await toReview();
      const runId = need(first().runId);
      h.retroFacts = { inTurn: false, resumedAt: HUB + 1000, rateLimitedUntil: null };
      await h.engine.tick();
      await h.engine.tick();
      expect(sentKeys().filter((k) => k.startsWith("rv-resume:"))).toEqual([
        `rv-resume:${runId}:${HUB}`,
      ]);
    });

    it("idle twice after a nudge fails the review", async () => {
      await toReview();
      const runId = need(first().runId);
      clock += 1000;
      store.setSeatTurnEnded(RETRO, clock);
      await h.engine.tick();
      expect(sentKeys().filter((k) => k.startsWith("rv-nudge:"))).toEqual([`rv-nudge:${runId}`]);
      clock += 5000;
      store.setSeatTurnEnded(RETRO, clock);
      await h.engine.tick();
      expect(first()).toMatchObject({
        state: "failed",
        failure: "stopped twice without reporting findings",
      });
      expect(h.ended).toContain(runId);
    });
  });

  it("a review superseded while it starts has its run ended", async () => {
    h.duringStart = () => {
      for (const r of store.reviewsIn(["starting"])) {
        store.setReviewState(r.id, ["starting"], "superseded", { at: clock });
      }
    };
    await toReview();
    const rv = first();
    expect(rv.state).toBe("superseded");
    expect(h.ended).toEqual([`${RETRO}:${rv.id}`]);
  });

  it("an account at its stop starts nothing", async () => {
    for (const window of ["5h", "7d"] as const) {
      store.addUsage({
        accountId: "claude-main",
        window,
        at: clock - 1000,
        pct: 96,
        resetAt: clock + 60 * MIN,
        source: "test",
      });
    }
    await toReview();
    expect(first().state).toBe("queued");
    expect(h.starts).toEqual([]);
  });

  describe("a run set aside in review", () => {
    const WT = join("/", "wt-aside");
    const asideRun = () => loopOf().aside;
    const wakeDue = (id: number) => `fix:${RUN}:0:${id}`;
    /** In review and off its seat. */
    async function setAside(): Promise<void> {
      h.asideOn = true;
      seatIdle(RUN);
      store.setSeatSession({ ...need(store.seatSession(SEAT)), worktree: WT });
      await toReview();
      expect(h.asides).toEqual([RUN]);
    }

    it("freed at review", async () => {
      await setAside();
      expect(asideRun()).toEqual({ worktree: WT, wake: false });
      expect(store.seatSession(SEAT)?.runId).toBeNull();
      expect(loopTexts()).toContain(asideEventText("GUIDO-1"));
      expect(store.run(RUN)?.endedAt).toBeNull();
      expect(h.ended).toEqual([]);
      // one open run, nothing sent to a seat that has no process
      await h.engine.reconcileRun(RUN);
      expect(h.asides).toEqual([RUN]);
      expect(h.sent).toEqual([]);
    });

    it("keeps the run on its seat when the supervisor does not set it aside", async () => {
      h.asideOn = false;
      await toReview();
      await h.engine.reconcileRun(RUN);
      expect(h.asides.length).toBeGreaterThan(0);
      expect(asideRun()).toBeNull();
      expect(store.seatSession(SEAT)?.runId).toBe(RUN);
    });

    it("no review seat: nothing changes", async () => {
      seats().splice(
        seats().findIndex((s) => s.id === RETRO),
        1,
      );
      h.asideOn = true;
      await toReview();
      expect(h.asides).toEqual([]);
      expect(store.seatSession(SEAT)?.runId).toBe(RUN);
    });

    it("findings come back first: one wake, then one fix line", async () => {
      await setAside();
      reported(first().id, [finding("Important")]);
      await vi.waitFor(() => expect(sentKeys()).toEqual([wakeDue(first().id)]));
      expect(h.wakes).toEqual([RUN]);
      expect(asideRun()).toBeNull();
      expect(store.seatSession(SEAT)?.runId).toBe(RUN);
      expect(loopTexts()).toContain(wokenEventText("GUIDO-1"));
      await h.engine.reconcileRun(RUN);
      expect(h.wakes).toEqual([RUN]);
      expect(sentKeys()).toEqual([wakeDue(first().id)]);
    });

    it("waits for a busy seat, and comes back when the other run ends", async () => {
      await setAside();
      h.wakeError = new SupervisorError(409, "GUIDO-1 already has a run");
      reported(first().id, [finding("Important")]);
      await vi.waitFor(() => expect(h.wakes).toHaveLength(1));
      await h.engine.reconcileRun(RUN);
      expect(asideRun()).toEqual({ worktree: WT, wake: true });
      expect(sentKeys()).toEqual([]);
      h.wakeError = null;
      emit({ kind: "run-ended", seatId: SEAT, runId: "guido-1:other", endedBy: "operator" });
      await vi.waitFor(() => expect(h.wakes.length).toBeGreaterThan(1));
      await vi.waitFor(() => expect(sentKeys()).toEqual([wakeDue(first().id)]));
      expect(asideRun()).toBeNull();
    });

    it("the oldest run waiting on a seat goes back first", async () => {
      await setAside();
      store.upsertRun(
        run({
          id: "guido-1:older",
          startedAt: START - MIN,
          seq: 0,
          ticket: `${REPO}#6`,
          loop: { ...NEW_LOOP, phase: "review", aside: { worktree: "/w/older", wake: true } },
        }),
      );
      reported(first().id, [finding("Important")]);
      await vi.waitFor(() => expect(asideRun()?.wake).toBe(true));
      await h.engine.reconcileRun(RUN);
      expect(h.wakes).toEqual([]);
      expect(asideRun()?.wake).toBe(true);
    });

    it("merged while aside: the engine ends the run", async () => {
      await setAside();
      setPr({ state: "merged", ci: "passing" });
      await h.engine.reconcileRun(RUN);
      expect(h.ended).toContain(RUN);
      expect(h.wakes).toEqual([]);
    });

    it("a failed wake is an Activity row, and the ended run is parked ended", async () => {
      await setAside();
      h.wakeError = new SupervisorError(500, "could not resume: checkout missing");
      reported(first().id, [finding("Important")]);
      await vi.waitFor(() =>
        expect(loopTexts()).toContain(wakeFailedText("could not resume: checkout missing")),
      );
      // the supervisor ended the run
      store.setRunEnded(RUN, clock, "failed", "exit");
      await h.engine.reconcileRun(RUN);
      expect(loopOf().parked).toMatchObject({ kind: "ended", ended: true });
    });

    it("a park wakes it", async () => {
      await setAside();
      setPr({ ci: "passing", state: "closed" });
      await h.engine.reconcileRun(RUN);
      expect(h.wakes).toEqual([RUN]);
      expect(loopOf().phase).toBe("parked");
    });

    it("an account at its stop: no wake", async () => {
      await setAside();
      for (const window of ["5h", "7d"] as const) {
        store.addUsage({
          accountId: "claude-main",
          window,
          at: clock - 1000,
          pct: 96,
          resetAt: clock + 60 * MIN,
          source: "test",
        });
      }
      reported(first().id, [finding("Important")]);
      await vi.waitFor(() => expect(asideRun()?.wake).toBe(true));
      await h.engine.reconcileRun(RUN);
      expect(h.wakes).toEqual([]);
      expect(sentKeys()).toEqual([]);
    });

    it("a restart mid set-aside finds the run on its seat and clears the mark", async () => {
      await setAside();
      seatIdle(RUN);
      await h.engine.reconcileRun(RUN);
      expect(asideRun()).toBeNull();
      expect(h.wakes).toEqual([]);
      // the run is still in review on its seat: the next pass sets it aside again
      expect(h.asides).toEqual([RUN]);
      await h.engine.reconcileRun(RUN);
      expect(h.asides).toEqual([RUN, RUN]);
      expect(asideRun()).toMatchObject({ wake: false });
      expect(store.seatSession(SEAT)?.runId).toBeNull();
    });

    it("the seat's free after B merged (ended by the engine): the waiting run is woken", async () => {
      await setAside();
      h.wakeError = new SupervisorError(409, "GUIDO-1 already has a run");
      reported(first().id, [finding("Important")]);
      await vi.waitFor(() => expect(h.wakes).toHaveLength(1));
      expect(asideRun()).toEqual({ worktree: WT, wake: true });
      h.wakeError = null;
      emit({ kind: "run-ended", seatId: SEAT, runId: "guido-1:b", endedBy: "engine" });
      await vi.waitFor(() => expect(h.wakes.length).toBeGreaterThan(1));
      await vi.waitFor(() => expect(asideRun()).toBeNull());
    });

    it("a stale wake flag on a run the loop cannot read is cleared", async () => {
      await setAside();
      store.upsertRun({ ...need(store.run(RUN)), ticket: null });
      store.setRunLoop(RUN, { ...loopOf(), aside: { worktree: WT, wake: true } });
      await h.engine.reconcileRun(RUN);
      expect(asideRun()).toEqual({ worktree: WT, wake: false });
    });

    it("an older run already done does not hold up a younger rework", async () => {
      await setAside();
      store.upsertRun(
        run({
          id: "guido-1:older",
          startedAt: START - MIN,
          seq: 0,
          ticket: `${REPO}#6`,
          loop: { ...NEW_LOOP, phase: "done", aside: { worktree: "/w/older", wake: true } },
        }),
      );
      reported(first().id, [finding("Important")]);
      await vi.waitFor(() => expect(h.wakes).toEqual([RUN]));
    });
  });

  describe("a run set aside in CI", () => {
    /** PR open on the pushed sha, CI pending: off its seat. */
    async function inCi(): Promise<void> {
      h.asideOn = true;
      report();
      await h.engine.reconcileRun(RUN);
      setPr({ ci: "pending" });
      await h.engine.reconcileRun(RUN);
    }

    it("freed in CI: the seat takes its next ticket", async () => {
      await inCi();
      expect(h.asides).toEqual([RUN]);
      expect(loopOf().phase).toBe("ci");
      expect(loopOf().aside).toEqual({ worktree: join(dir, "wt"), wake: false });
      expect(store.seatSession(SEAT)?.runId).toBeNull();
      expect(loopTexts()).toContain(asideInCiEventText("GUIDO-1"));
      await vi.waitFor(() => expect(h.taken).toEqual([SEAT]));
    });

    it("the first CI failure is re-run: the seat is not held", async () => {
      await inCi();
      setPr({ ci: "failing" });
      await h.engine.reconcileRun(RUN);
      expect(loopOf().rerun?.sha).toBe(SHA);
      expect(loopOf().aside?.wake).toBe(false);
      expect(seatMayTake(store, SEAT)).toBe(true);
    });

    it("CI passes while set aside: in review, still set aside", async () => {
      await inCi();
      setPr({ ci: "passing" });
      await h.engine.reconcileRun(RUN);
      expect(loopOf().phase).toBe("review");
      expect(loopOf().aside?.wake).toBe(false);
      expect(h.wakes).toEqual([]);
    });

    it("a CI failure wakes the run first, then its excerpt goes", async () => {
      await inCi();
      // the first failure on a sha is re-run; the seat hears of the failure on a later poll
      setPr({ ci: "failing" });
      await h.engine.reconcileRun(RUN);
      clock += 1000;
      setPr({ ci: "failing" });
      await h.engine.reconcileRun(RUN);
      await vi.waitFor(() => expect(sentKeys()).toEqual([`ci:${RUN}:${SHA}`]));
      expect(h.wakes).toEqual([RUN]);
      expect(loopOf().aside).toBeNull();
      expect(store.seatSession(SEAT)?.runId).toBe(RUN);
      expect(h.taken).toEqual([SEAT]);
    });
  });
});
