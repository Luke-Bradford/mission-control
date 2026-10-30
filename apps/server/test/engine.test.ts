import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  AWAY_BUG_VERIFIED,
  AWAY_SETTING,
  type AwayDiff,
  asideEventText,
  asideInCiEventText,
  awayBugDecisionAbout,
  type BoardItem,
  CI_EXCERPT_MAX,
  COMMS_TEXT_MAX,
  CONTROLLER_CHECK_HEADING,
  CONTROLLER_CHECK_PARK,
  cleanupBranchNoteKey,
  closedIssueText,
  commsCutMarker,
  conflictKey,
  controllerCheckFailText,
  controllerCheckParkText,
  DEFAULT_AWAY,
  DEFAULT_PROFILES,
  DEFAULT_REPO_RULES,
  deletedLocalText,
  deletedRemoteText,
  ENGINE_TICK_MS,
  EVIDENCE_REMIND_MS,
  EVIDENCE_RULING_PREFIX,
  FINDING_FIX_MAX,
  FIX_TEXT_MAX,
  fixSentText,
  globMatches,
  hardRulesBySettingKey,
  hardRulesFlagKey,
  hardRulesUnsetNoteKey,
  hardRulesUnsetText,
  localNotDeletedText,
  MC_PR_UNCLOSED,
  MC_PUSH_FAILED,
  MC_PUSH_MERGE,
  MC_PUSH_NO_COMMIT,
  MC_PUSH_ROOT,
  MC_RUN_ENDED,
  MC_SYNC_DIRTY,
  MC_SYNC_NOT_WORKING,
  MC_SYNC_OFF,
  MC_SYNC_UP_TO_DATE,
  MERGE_HOLD_PARK,
  MINOR_POSTED,
  mergedMainText,
  mergedText,
  mergeStepFailedText,
  minorNotPostedText,
  NEW_LOOP,
  NO_CI_AFTER_MS,
  originMovedText,
  type Profile,
  type PullRequestView,
  parkedEventText,
  prNamedRefText,
  prNotifyText,
  prSecretText,
  pushChecksText,
  pushReferenceText,
  pushSecretText,
  REFUSAL_TRIES,
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
  reviewCarriedText,
  reviewDroppedText,
  reviewFailedText,
  reviewQueuedText,
  reviewStartedText,
  type SeatSessionRow,
  SYNC_MAIN_GAP_MS,
  seatDef,
  syncFailedText,
  syncMergedText,
  syncTooSoonText,
  type TicketView,
  wakeFailedText,
  wokenEventText,
  writerSyncConflictText,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig, CrewSeatConfig } from "../src/config.ts";
import { writeCrewPause } from "../src/crew-pause.ts";
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
  ReviewPrSnapshot,
  UpdateBranchResult,
} from "../src/engine/publish.ts";
import {
  createPublisher,
  MERGE_CONFLICTING,
  MERGE_HEAD_MOVED,
  MERGE_WAITS_ON_MAIN,
  READY_UNDO_FAILED,
  UPDATE_UP_TO_DATE,
} from "../src/engine/publish.ts";
import { seatMayTake } from "../src/engine/queue.ts";
import { resolveRepoRules } from "../src/engine/rule-config.ts";
import { parseRepoRules, RepoRulesError } from "../src/engine/rules.ts";
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
const KNOWN_SEATS = [SEAT, RETRO, "guido-2", "retro-2", "retro-cx"];
const RUN = "guido-1:20261021T100000Z";
const BRANCH = "feature/7-fix-the-thing";
const SHA = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);
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
  touchesByRun?: Record<string, string[]>;
  duringTouches?: (runId: string) => void;
  reviewPrOverride?: (number: number) => ReviewPrSnapshot | null | Promise<ReviewPrSnapshot | null>;
  awayDiff?: AwayDiff | null;
  descends?: boolean;
  hardRuleLists: string[][];
  /** The merge gate's facts (null: unreadable), and the gate reads made. */
  gate: GateFacts | null;
  duringDescendant?: (ancestor: string, head: string) => void;
  gateReads: { sha: string; known: boolean }[];
  duringGate?: () => void;
  /** The merge steps the publisher was asked for, in order, with the ended runs seen at the time. */
  steps: string[];
  stepEnded: Record<string, string[]>;
  /** The next results of each merge step, oldest first; empty: success. */
  stepResults: Record<string, PublishResult[]>;
  minorIssueCalls: (number | undefined)[];
  /** The branch updates asked for, and their next results, oldest first; empty: wait. */
  tip: string;
  mergeHead?: string;
  duringUpdate?: () => void;
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
  noSession: boolean;
  resumes: string[];
  resumeDeferred: (() => Promise<void>) | null;
  resumeFails: boolean;
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
    minorIssueCalls: [],
    tip: "d".repeat(40),
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
    noSession: false,
    resumes: [],
    resumeDeferred: null,
    resumeFails: false,
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
        async reviewPr(r, number) {
          if (x.reviewPrOverride) return x.reviewPrOverride(number);
          const pr = store.pullRequests(r.repoId).find((p) => p.number === number);
          return pr?.headSha
            ? {
                state: pr.state,
                headSha: pr.headSha,
                baseSha: "c".repeat(40),
                mergeCommitSha: pr.mergeCommitSha ?? null,
              }
            : null;
        },
        awayDiff: async () =>
          h.awayDiff === undefined
            ? { base: SHA_B, changes: [{ path: "apps/docs/guide.md", status: "A" }] }
            : h.awayDiff,
        isDescendant: async (_run, ancestor, head) => {
          x.duringDescendant?.(ancestor, head);
          return x.descends ?? ancestor === head;
        },
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
        async hardRuleTouches(run, _sha, rules) {
          x.hardRuleLists.push([...rules]);
          x.duringTouches?.(run.id);
          return (x.touchesByRun?.[run.id] ?? x.touches).filter((path) =>
            rules.some((rule) => globMatches(rule, path, true)),
          );
        },
        async gateFacts(_r, sha, known): Promise<GateResult> {
          x.gateReads.push({ sha, known: known != null });
          x.duringGate?.();
          if (x.gate === null) return { ok: false, text: "git is down", transient: true };
          return { ok: true, facts: { ...x.gate, strays: [...x.gate.strays] } };
        },
        mergeHead: async () => x.mergeHead ?? null,
        mainTip: async () => ({ ok: true, sha: x.tip }),
        async updateBranch(r, mainSha, worktree): Promise<UpdateBranchResult> {
          x.updates.push({ mainSha, worktree });
          x.duringUpdate?.();
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
        markDraft: (r) => step("draft", r),
        merge: (r) => step("merge", r),
        closeIssue: (r) => step("close", r),
        fileMinorFindings: async (r, _pr, techDebtIssue) => {
          x.minorIssueCalls.push(techDebtIssue);
          return {
            ...(await step("file-minor", r)),
            ...(r.loop?.minorIssueNumber ? { issueNumber: r.loop.minorIssueNumber } : {}),
          };
        },
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
            if (x.noSession) return "no-session";
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
          async resumeDeferredRuns() {
            await x.resumeDeferred?.();
          },
          async resumeRun(runId) {
            x.resumes.push(runId);
            if (x.resumeFails) {
              store.setRunEnded(runId, clock, "failed", "exit");
              const row = store.seatSession(SEAT);
              if (row !== null) {
                store.setSeatSession({
                  ...row,
                  state: "error",
                  reason: "could not resume the session",
                });
              }
              return;
            }
            x.noSession = false;
            x.facts = { inTurn: false, resumedAt: clock, rateLimitedUntil: null };
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
            return { runId: retroRun(id, seat) };
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
        rules: (repoId, mainSha) => x.rules(repoId, mainSha),
        refillQueues: async () => void x.refills.push(x.taken.length),
        takeNext: async (seatId) => void x.taken.push(seatId),
        pollGithub: () => void x.polls++,
        fetchTicket: async () => ticketView(""),
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

/** A ticket as the reader returns it, with this body. */
const ticketView = (text: string): TicketView => ({
  number: 7,
  title: "t",
  url: "",
  state: "open",
  body: text,
  bodyTruncated: false,
  labels: [],
  milestone: null,
  subIssues: [],
  pullRequests: [],
});

/** A review run for review `id`, held by the review seat (what the supervisor's start does). */
function retroRun(id: number, seatId = RETRO): string {
  const runId = `${seatId}:${id}`;
  store.upsertRun(
    run({ id: runId, agentId: seatId, seq: id, reviewId: id, branch: null, loop: null }),
  );
  seatIdle(runId, seatId);
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
/** Whether the operator message lifted the park; `h.engine.onOperatorMessage` itself says why not. */
const operate = async (...args: Parameters<typeof h.engine.onOperatorMessage>) =>
  (await h.engine.onOperatorMessage(...args)).lifted;
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

describe("idle-seat wakes", () => {
  it("wakes once when failing findings arrived during the turn", async () => {
    store.setSeatTurnStarted(SEAT, clock);
    const id = store.requestReview({
      authorRunId: RUN,
      repoId: REPO,
      seatId: RETRO,
      prNumber: 12,
      sha: SHA,
      epoch: 0,
      attempt: 1,
      round: 2,
      at: clock,
    }) as number;
    store.setReviewState(id, ["queued"], "running", { at: clock, runId: "retro-run" });
    clock += 9 * MIN;
    expect(
      store.recordFindings(id, "retro-run", {
        verdict: { spec: "fail", quality: "pass" },
        summary: "broken",
        findings: [
          {
            severity: "Important",
            file: "apps/a.ts",
            line: 1,
            summary: "bad",
            scenario: "breaks",
            fix: "fix",
          },
        ],
        at: clock,
      }),
    ).toBe(true);
    expect(store.seatSession(SEAT)?.lastTurnStartedAt).toBe(START + 10 * MIN);
    expect(store.reviewsOfRun(RUN)[0]?.endedAt).toBe(clock);
    for (const listener of h.listeners)
      listener({ kind: "idle", seatId: SEAT, runId: RUN, resumed: false });
    await vi.waitFor(() =>
      expect(h.sent.filter((x) => x.key.startsWith(`wake:${RUN}:`))).toHaveLength(1),
    );
    expect(h.sent.at(-1)?.text).toContain("RETRO round 2 findings");
    for (const listener of h.listeners)
      listener({ kind: "idle", seatId: SEAT, runId: RUN, resumed: false });
    await Promise.resolve();
    expect(h.sent.filter((x) => x.key.startsWith(`wake:${RUN}:`))).toHaveLength(1);
  });

  it("reminds once for a green head without evidence, then raises Needs-you", async () => {
    setLoop({
      phase: "working",
      parked: null,
      prNumber: 12,
    });
    setPr({ ci: "passing", headSha: SHA });
    store.addLoopEvent(`${RUN}:ci-passed:${SHA}`, RUN, `CI passed on ${SHA.slice(0, 7)}`, clock);
    await h.engine.tick();
    expect(sentKeys()).not.toContain(`evidence-remind:${RUN}:${SHA}`);
    clock += EVIDENCE_REMIND_MS;
    await h.engine.tick();
    expect(sentKeys()).toContain(`evidence-remind:${RUN}:${SHA}`);
    expect(store.claimedKeys(RUN)[`evidence-remind:${RUN}:${SHA}`]).toBe(clock);
    expect(store.run(RUN)?.endedAt).toBeNull();
    expect(store.evidenceCount(RUN)).toBe(0);
    expect(store.run(RUN)?.loop).not.toBeNull();
    h.facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
    clock += EVIDENCE_REMIND_MS + 1;
    await h.engine.tick();
    expect(
      store.notes().some((n) => n.key === `evidence:${RUN}:${SHA}` && n.clearedAt === null),
    ).toBe(true);
    await h.engine.tick();
    expect(sentKeys().filter((key) => key === `evidence-remind:${RUN}:${SHA}`)).toHaveLength(1);
  });

  it("does not wake or remind a rate-limited, account-stopped, or parked seat", async () => {
    const setup = () => {
      store.setSeatTurnStarted(SEAT, clock);
      store.addLoopEvent(`${RUN}:ci-failed`, RUN, `CI failed on ${SHA.slice(0, 7)}`, clock);
      store.addLoopEvent(
        `${RUN}:ci-passed:${SHA}`,
        RUN,
        `CI passed on ${SHA.slice(0, 7)}`,
        clock - EVIDENCE_REMIND_MS - 1,
      );
      setLoop({ phase: "working", parked: null, prNumber: 12 });
      setPr({ ci: "passing", headSha: SHA });
    };
    const noWakeOrReminder = () => {
      expect(sentKeys().some((key) => key.startsWith(`wake:${RUN}:`))).toBe(false);
      expect(sentKeys()).not.toContain(`evidence-remind:${RUN}:${SHA}`);
    };

    setup();
    h.facts = { inTurn: false, resumedAt: null, rateLimitedUntil: clock + MIN };
    await h.engine.tick();
    noWakeOrReminder();

    h.facts = { inTurn: false, resumedAt: null, rateLimitedUntil: null };
    store.addUsage({
      accountId: "claude-main",
      window: "5h",
      at: clock,
      pct: 96,
      resetAt: clock + MIN,
      source: "test",
    });
    await h.engine.tick();
    noWakeOrReminder();

    clock += MIN + 1;
    store.setSeatSession({ ...(store.seatSession(SEAT) as SeatSessionRow), state: "idle" });
    setLoop({
      phase: "parked",
      parked: { kind: "stuck", reason: "waiting", ended: false },
    });
    await h.engine.tick();
    noWakeOrReminder();
  });

  it("tracks reminders by head and clears stale evidence flags", async () => {
    setLoop({ phase: "working", parked: null, prNumber: 12 });
    setPr({ ci: "passing", headSha: SHA });
    store.addLoopEvent(
      `${RUN}:ci-passed:${SHA}`,
      RUN,
      `CI passed on ${SHA.slice(0, 7)}`,
      clock - EVIDENCE_REMIND_MS - 1,
    );
    await h.engine.tick();
    expect(sentKeys()).toContain(`evidence-remind:${RUN}:${SHA}`);

    clock += EVIDENCE_REMIND_MS + 1;
    await h.engine.tick();
    expect(
      store.notes().some((n) => n.key === `evidence:${RUN}:${SHA}` && n.clearedAt === null),
    ).toBe(true);

    setPr({ ci: "passing", headSha: SHA_B });
    store.addLoopEvent(
      `${RUN}:ci-passed:${SHA_B}`,
      RUN,
      `CI passed on ${SHA_B.slice(0, 7)}`,
      clock - EVIDENCE_REMIND_MS - 1,
    );
    await h.engine.tick();
    expect(
      store.notes().some((n) => n.key === `evidence:${RUN}:${SHA}` && n.clearedAt === null),
    ).toBe(false);
    expect(sentKeys()).toContain(`evidence-remind:${RUN}:${SHA_B}`);

    clock += EVIDENCE_REMIND_MS + 1;
    await h.engine.tick();
    expect(
      store.notes().some((n) => n.key === `evidence:${RUN}:${SHA_B}` && n.clearedAt === null),
    ).toBe(true);
  });
});

describe("sync_main", () => {
  const merged: UpdateBranchResult = {
    ok: true,
    kind: "merged",
    sha: SHA_B,
    parent: SHA,
    prSame: true,
  };

  it("merges main into a working run's branch and records it", async () => {
    h.updateResults.push(merged);
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: syncMergedText(h.tip, SHA_B) });
    expect(h.updates).toEqual([{ mainSha: h.tip, worktree: join(dir, "wt") }]);
    expect(store.runCommits(RUN)).toContain(SHA_B);
    expect(loopOf().phase).toBe("working");
    expect(loopTexts()).toContain(mergedMainText(h.tip));
    expect(h.pushes).toEqual([]);
    expect(h.steps).toEqual([]);
  });

  it("leaves a conflict for the seat and records mainMerge", async () => {
    const files = ["apps/a.ts"];
    h.updateResults.push({ ok: true, kind: "conflict", files });
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: writerSyncConflictText(files) });
    expect(loopOf().mainMerge).toEqual({ mainSha: h.tip, files });
    expect(store.claimedKeys(RUN)[conflictKey(RUN, h.tip)]).toBe(clock);
    await h.engine.reconcileRun(RUN);
    expect(h.sent).toEqual([]);
    expect(loopOf().phase).toBe("working");
  });

  it("repeats pending conflict instructions before the cap and origin tip read", async () => {
    const files = ["apps/a.ts"];
    h.updateResults.push({ ok: true, kind: "conflict", files });
    await h.engine.writerSyncMain(RUN);
    h.mergeHead = h.tip;
    h.tip = SHA_B;
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: writerSyncConflictText(files) });
    expect(h.updates).toHaveLength(1);
  });

  it("preserves loop edits made while the sync is in flight and reports install refusal", async () => {
    const installNote = "dependencies changed; install refused: branch changes package.json";
    h.duringUpdate = () => setLoop({ flightClearedSha: SHA });
    h.updateResults.push({ ...merged, installNote });
    expect(await h.engine.writerSyncMain(RUN)).toEqual({
      text: `${syncMergedText(h.tip, SHA_B)}\n${installNote}`,
    });
    expect(loopOf().flightClearedSha).toBe(SHA);
  });

  it("does not spend the cap on an up-to-date answer", async () => {
    h.updateResults.push({ ok: false, text: UPDATE_UP_TO_DATE, transient: true }, merged);
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: MC_SYNC_UP_TO_DATE });
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: syncMergedText(h.tip, SHA_B) });
  });

  it("leaves the rate cap unused when the worktree is dirty", async () => {
    h.updateResults.push({ ok: true, kind: "wait" }, merged);
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: MC_SYNC_DIRTY, isError: true });
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: syncMergedText(h.tip, SHA_B) });
    expect(h.updates).toHaveLength(2);
  });

  it("refuses a run waiting for CI", async () => {
    setLoop({ phase: "ci" });
    expect(await h.engine.writerSyncMain(RUN)).toEqual({
      text: MC_SYNC_NOT_WORKING,
      isError: true,
    });
    expect(h.updates).toEqual([]);
  });

  it("allows one sync per 10 minutes", async () => {
    h.updateResults.push(merged, { ok: false, text: UPDATE_UP_TO_DATE, transient: true });
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: syncMergedText(h.tip, SHA_B) });
    clock += SYNC_MAIN_GAP_MS - MIN;
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: syncTooSoonText(1), isError: true });
    expect(h.updates).toHaveLength(1);
    clock += MIN;
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: MC_SYNC_UP_TO_DATE });
    expect(h.updates).toHaveLength(2);
    h.updateResults.push(merged);
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: syncMergedText(h.tip, SHA_B) });
  });

  it("does not park or use the cap on a merge refusal", async () => {
    h.updateResults.push({ ok: false, text: "git failed", transient: false }, merged);
    expect(await h.engine.writerSyncMain(RUN)).toEqual({
      text: syncFailedText("git failed"),
      isError: true,
    });
    expect(loopOf().phase).toBe("working");
    expect(loopOf().parked).toBeNull();
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: syncMergedText(h.tip, SHA_B) });
  });

  it("refuses when the engine is off or the seat no longer holds the run", async () => {
    seatIdle(null);
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: MC_RUN_ENDED, isError: true });
    h.engine.stop();
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: MC_SYNC_OFF, isError: true });
    expect(h.updates).toEqual([]);
  });

  it("only merges locally in away mode, without marking ready or merging the PR", async () => {
    store.setSetting(AWAY_SETTING, JSON.stringify({ ...DEFAULT_AWAY, on: true }));
    h.updateResults.push(merged);
    expect(await h.engine.writerSyncMain(RUN)).toEqual({ text: syncMergedText(h.tip, SHA_B) });
    await h.engine.reconcileRun(RUN);
    expect(h.pushes).toEqual([]);
    expect(h.steps).toEqual([]);
    expect(loopOf().phase).toBe("working");
  });
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

  it("raises one hard-rule flag per file set across pushes, replacing it when files change", async () => {
    h.touches = [".github/ci.yml"];
    report();
    await h.engine.reconcileRun(RUN);
    expect(loopOf().touches).toEqual({
      sha: SHA,
      paths: [".github/ci.yml"],
      flightPowers: "standard",
      hardRulesHash: createHash("sha256")
        .update(JSON.stringify(DEFAULT_REPO_RULES.hardRules))
        .digest("hex"),
    });
    const firstFlag = hardRulesFlagKey(RUN, h.touches);
    expect(noteKeys()).toContain(firstFlag);

    report("A second commit", SHA_B);
    await h.engine.reconcileRun(RUN);
    expect(noteKeys().filter((key) => key.startsWith(`flag:${RUN}:hard-rules:`))).toEqual([
      firstFlag,
    ]);

    h.touches = [".github/ci.yml", ".github/workflows/ci.yml"];
    report("A third commit", SHA_C);
    await h.engine.reconcileRun(RUN);
    expect(noteKeys().filter((key) => key.startsWith(`flag:${RUN}:hard-rules:`))).toEqual([
      hardRulesFlagKey(RUN, h.touches),
    ]);
    expect(store.notes().find((note) => note.key === hardRulesFlagKey(RUN, h.touches))?.text).toBe(
      `${REPO}#7 touches hard-rule files: .github/ci.yml, .github/workflows/ci.yml`,
    );
  });

  it("clears the hard-rule flag once its run has ended", async () => {
    h.touches = [".github/ci.yml"];
    report();
    await h.engine.reconcileRun(RUN);
    expect(noteKeys()).toContain(hardRulesFlagKey(RUN, h.touches));
    store.setRunEnded(RUN, clock, "ok", "engine");
    await h.engine.tick();
    expect(noteKeys()).not.toContain(hardRulesFlagKey(RUN, h.touches));
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

  it("does not resume a missing CLI while its loop is parked", async () => {
    h.facts = null;
    h.noSession = true;
    setLoop({ phase: "parked", parked: { kind: "ruling", reason: "wait", ended: false } });
    await h.engine.reconcileRun(RUN);
    await h.engine.tick();
    expect(h.resumes).toEqual([]);
    expect(loopOf().phase).toBe("parked");
  });

  it("ends a run whose PR merged without resuming its missing CLI", async () => {
    await inCi();
    h.facts = null;
    h.noSession = true;
    setPr({ state: "merged", mergedAt: clock, ci: "passing" });
    await h.engine.reconcileRun(RUN);
    expect(h.ended).toEqual([RUN]);
    expect(h.resumes).toEqual([]);
  });

  it("updates PR state without resuming a missing CLI", async () => {
    await inCi();
    h.facts = null;
    h.noSession = true;
    setPr({ ci: "passing" });
    await h.engine.reconcileRun(RUN);
    expect(loopOf().phase).toBe("review");
    expect(h.resumes).toEqual([]);
  });

  it("does not resume a missing CLI when its account is at a stop", async () => {
    await inCi();
    await failCi();
    h.facts = null;
    h.noSession = true;
    store.addUsage({
      accountId: "claude-main",
      window: "5h",
      at: clock,
      pct: 96,
      resetAt: clock + 60 * MIN,
      source: "test",
    });
    await h.engine.reconcileRun(RUN);
    await h.engine.tick();
    expect(h.resumes).toEqual([]);
  });

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

  it.each([CI_EXCERPT_MAX, COMMS_TEXT_MAX + 1])(
    "delivers a %i-character CI excerpt whole without parking and bounds only its stored copy",
    async (length) => {
      await inCi();
      await failCi();
      const excerpt = "x".repeat(length);
      h.excerptTexts = [excerpt];
      await h.engine.reconcileRun(RUN);
      expect(h.sent).toHaveLength(1);
      const text = h.sent[0]?.text ?? "";
      expect(text.endsWith(excerpt)).toBe(true);
      expect(store.comms(0)[0]?.text).toBe(
        text.length <= COMMS_TEXT_MAX
          ? text
          : `${text.slice(0, COMMS_TEXT_MAX)}${commsCutMarker(COMMS_TEXT_MAX, text.length)}`,
      );
      expect(loopOf()).toMatchObject({ phase: "working", parked: null, relayedSha: SHA });
      await h.engine.reconcileRun(RUN);
      expect(h.sent).toHaveLength(1);
      expect(store.comms(0)).toHaveLength(1);
    },
  );

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
  it("keeps a 1000-character refusal in CI through to the park, note and loop event", async () => {
    const stderr = "x".repeat(1000 - "gh run list failed: ".length);
    const text = `gh run list failed: ${stderr}`;
    expect(text).toHaveLength(1000);
    const refused = await createPublisher({
      config,
      store,
      bus: new ChangeBus(),
      dbPath: store.path,
      inClone: (_checkout, fn) => fn(),
      knownSecrets: async () => [],
      checks: async () => [],
      gh: async () => ({ code: 1, stdout: "", stderr }),
    }).rerunRuling("o/mc", SHA);
    expect(refused).toEqual({ ok: false, text, transient: true });
    h.pushResults = [refused, refused, refused];
    report();
    for (let i = 0; i < 3; i++) {
      await h.engine.reconcileRun(RUN);
      clock += ENGINE_TICK_MS;
    }
    expect(loopOf().parked?.reason).toBe(text);
    expect(store.notes()[0]?.text).toContain(text);
    expect(loopTexts().some((line) => line.includes(text))).toBe(true);
  });

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

  it("a push refused for its checks goes to the seat as a hand-off, once, and does not park the run", async () => {
    const text = pushChecksText("a".repeat(40), [{ command: "pnpm -s lint", state: "missing" }]);
    h.pushResults = [
      { ok: false, text, transient: false },
      { ok: false, text, transient: false },
    ];
    report();
    await h.engine.reconcileRun(RUN);
    clock += ENGINE_TICK_MS;
    await h.engine.reconcileRun(RUN);
    expect(loopOf().phase).not.toBe("parked");
    expect(loopOf().parked ?? null).toBeNull();
    expect(h.sent.filter((s) => s.text === text)).toHaveLength(1);
    expect(store.comms(0).map((c) => c.text)).toEqual([text]);
    expect(store.notes()).toEqual([]);
    expect(h.moves.map((m) => m.column)).not.toContain("Blocked");
  });

  it("a checks hand-off restarts the push clock; with no progress after a full window the park names the checks", async () => {
    const text = pushChecksText("a".repeat(40), [{ command: "pnpm -s lint", state: "missing" }]);
    const refusal = { ok: false, text, transient: false } as const;
    h.pushResults = Array.from({ length: 8 }, () => refusal);
    report();
    h.noSession = true; // the seat cannot be told yet: ci was entered, the message not sent
    await h.engine.reconcileRun(RUN);
    h.noSession = false;
    clock += NO_CI_AFTER_MS - 1000;
    await h.engine.reconcileRun(RUN); // hand-off: the window restarts here
    clock += NO_CI_AFTER_MS - 1000; // over NO_CI_AFTER_MS since entering ci, under it since the message
    await h.engine.reconcileRun(RUN);
    expect(loopOf().phase).not.toBe("parked");
    clock += 2000;
    await h.engine.reconcileRun(RUN);
    expect(loopOf()).toMatchObject({ phase: "parked", parked: { kind: "stuck" } });
    expect(loopOf().parked?.reason).toContain(text);
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

  it("display gates, checks and max tries cannot bypass the executable CI gate", async () => {
    giveProfile({
      tries: 1,
      steps: [
        {
          name: "verify",
          phase: "ci",
          gate: false,
          max: 10,
          checks: [{ kind: "agent", text: "Finished" }],
        },
      ],
    });
    report();
    await h.engine.reconcileRun(RUN);
    await failCi();
    await h.engine.reconcileRun(RUN);
    expect(store.run(RUN)?.loop?.parked).toMatchObject({
      kind: "ci",
      reason: "CI failed 1 times; last on aaaaaaa",
    });
    expect(h.steps).not.toContain("merge");
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
    const waiting = operate(RUN, "FLIGHT", { kinds: ["ci"] });
    setLoop({ phase: "parked", parked: { kind: "budget", reason: "over", ended: false } });
    expect(await waiting).toBe(false);
    expect(loopOf()).toMatchObject({ phase: "parked", epoch: 0, budgetExtra: 0 });
    // FLIGHT never lifts a budget park, even when it names no kinds
    expect(await operate(RUN, "FLIGHT")).toBe(false);
    expect(loopOf().phase).toBe("parked");
    // a kind it names is lifted, and the call says so
    setLoop({ phase: "parked", parked: { kind: "ci", reason: "x", ended: false } });
    expect(await operate(RUN, "FLIGHT", { kinds: ["ci"] })).toBe(true);
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

  it.each(["ruling", "review-failed"] as const)(
    "a %s park resumes without a review waiver",
    async (kind) => {
      setLoop({ phase: "parked", parked: { kind, reason: "held", ended: false } });
      await h.engine.onOperatorMessage(RUN);
      expect(loopOf()).toMatchObject({ phase: "review", reviewWaivedSha: null });
    },
  );

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
  it("clears missing-report notes at the hub time before notifying attention", async () => {
    const key = `no_report:${RUN}`;
    store.raiseNote({
      key,
      kind: "flag",
      runId: RUN,
      seatId: SEAT,
      repoId: REPO,
      text: "Missing report",
      at: clock - 1000,
    });
    setPr({ state: "merged", mergedAt: clock });
    setLoop({
      prNumber: 12,
      phase: "parked",
      parked: { kind: "silent", reason: "no report", ended: true },
    });
    const cleared: unknown[] = [];
    const db = new DatabaseSync(join(dir, "mc.sqlite"));
    const emit = vi.spyOn(ChangeBus.prototype, "emit").mockImplementation((topic) => {
      if (topic === "attention")
        cleared.push(
          db.prepare("SELECT cleared_at FROM attention_notes WHERE key = ?").get(key)?.cleared_at,
        );
    });
    try {
      await h.engine.reconcileRun(RUN);
      expect(loopOf().phase).toBe("done");
      expect(cleared.length).toBeGreaterThan(0);
      expect(cleared.every((at) => at === clock)).toBe(true);
      expect(noteKeys()).not.toContain(key);
    } finally {
      emit.mockRestore();
      db.close();
    }
  });

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

  it("paused seats wait through a restart; other seats take and unpausing resumes", async () => {
    seatIdle(null);
    config.crew?.sessions[0]?.seats.push({
      id: "guido-2",
      role: "GUIDO",
      accountId: "claude-main",
      model: "haiku",
      area: [],
    });
    store.setSetting(
      "crew.paused",
      JSON.stringify({ seats: [SEAT], reason: "Save tokens", at: clock, by: "operator" }),
    );
    h.engine.stop();
    store.close();
    store = new Store(join(dir, "mc.sqlite"));
    h.engine = h.make();
    h.engine.start();
    await h.engine.tick();
    expect(h.taken).toEqual(["guido-2"]);
    h.taken.length = 0;
    store.setSetting("crew.paused", "null");
    await h.engine.tick();
    expect(h.taken).toEqual([SEAT, "guido-2"]);
  });

  it("an all-seat pause starts no tickets", async () => {
    seatIdle(null);
    store.setSetting(
      "crew.paused",
      JSON.stringify({ seats: "all", reason: "Save tokens", at: clock, by: "operator" }),
    );
    await h.engine.tick();
    expect(h.taken).toEqual([]);
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

    it("recovers a CLI lost before the CI line and keeps its excerpt for delivery", async () => {
      await failedAndBusy();
      h.busy = false;
      h.noSession = true;
      await h.engine.reconcileRun(RUN);
      expect(h.resumes).toEqual([RUN]);
      expect(h.sent).toEqual([]);
      await h.engine.reconcileRun(RUN);
      expect(h.excerpts).toHaveLength(1);
      expect(h.sent[0]?.text.endsWith("EXCERPT")).toBe(true);
      expect(h.engine.excerptsHeld()).toBe(0);
    });

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
  const SHA_C = "c".repeat(40);
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
  it("a paused reviewer keeps its queued review until unpaused", async () => {
    store.setSetting(
      "crew.paused",
      JSON.stringify({ seats: [RETRO], reason: "Save tokens", at: clock, by: "operator" }),
    );
    await toReview();
    await h.engine.tick();
    expect(first().state).toBe("queued");
    expect(first().runId).toBeNull();
    store.setSetting("crew.paused", "null");
    await h.engine.tick();
    expect(first().state).toBe("running");
  });

  it("suspends running review supervision and its deadline across an engine restart", async () => {
    await toReview();
    await h.engine.tick();
    store.setSetting(
      "crew.paused",
      JSON.stringify({
        seats: [RETRO],
        reason: "Save tokens",
        at: clock,
        by: "operator",
      }),
    );
    await h.engine.tick();
    clock += 90 * MIN;
    h.engine.stop();
    h.engine = h.make();
    h.engine.start();
    await h.engine.tick();
    expect(first().state).toBe("running");
    store.setSetting("crew.paused", "null");
    await h.engine.tick();
    expect(first().state).toBe("running");
    clock += 61 * MIN;
    await h.engine.tick();
    expect(first().state).toBe("failed");
  });

  it("a paused author starts no rework; unpausing resumes the pending findings", async () => {
    await toReview();
    await h.engine.tick();
    store.setSetting(
      "crew.paused",
      JSON.stringify({ seats: [SEAT], reason: "Save tokens", at: clock, by: "operator" }),
    );
    reported(first().id, [finding("Important")]);
    await h.engine.tick();
    expect(h.sent.filter((s) => s.key.startsWith("fix:"))).toEqual([]);
    store.setSetting("crew.paused", "null");
    await h.engine.tick();
    expect(h.sent.some((s) => s.key.startsWith("fix:"))).toBe(true);
  });

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

  it("a younger PR waits for an older open PR sharing a hard-rule file", async () => {
    h.touches = ["packages/core/src/guard.ts"];
    await secondAuthor();
    expect(h.starts).toEqual([]);
    expect(store.reviewsOfRun(RUN2)[0]?.state).toBe("queued");
    expect(
      store
        .loopEvents(0)
        .filter((e) => e.runId === RUN2)
        .map((e) => e.text),
    ).toContain("waits for #12 (shared: packages/core/src/guard.ts)");
  });

  it("does not make a newer PR wait for the same author's older PR", async () => {
    h.touches = ["packages/core/src/guard.ts"];
    const upsert = store.upsertPullRequests.bind(store);
    vi.spyOn(store, "upsertPullRequests").mockImplementation((repo, prs, at) =>
      upsert(
        repo,
        prs.map((pr) => ({ ...pr, author: "same-author" })),
        at,
      ),
    );
    await secondAuthor();
    expect(h.starts).toHaveLength(1);
    expect(
      store
        .loopEvents(0)
        .filter((e) => e.runId === RUN2)
        .map((e) => e.text),
    ).not.toContain("waits for #12 (shared: packages/core/src/guard.ts)");
  });

  it("ignores older manual PRs without a run", async () => {
    h.touches = ["packages/core/src/guard.ts"];
    const upsert = store.upsertPullRequests.bind(store);
    vi.spyOn(store, "upsertPullRequests").mockImplementation((repo, prs, at) =>
      upsert(
        repo,
        prs.map((p) => (p.number === 12 ? { ...p, branch: "manual" } : p)),
        at,
      ),
    );
    await secondAuthor();
    expect(h.starts).toHaveLength(1);
  });

  it("does not update for an unrelated older merged PR", async () => {
    h.touchesByRun = { [RUN]: ["CLAUDE.md"], [RUN2]: ["packages/core/src/guard.ts"] };
    const upsert = store.upsertPullRequests.bind(store);
    vi.spyOn(store, "upsertPullRequests").mockImplementation((repo, prs, at) =>
      upsert(
        repo,
        prs.map((p) => (p.number === 12 ? { ...p, state: "merged", mergeCommitSha: SHA_C } : p)),
        at,
      ),
    );
    await secondAuthor();
    expect(h.starts).toHaveLength(1);
    expect(h.updates).toEqual([]);
  });

  it("batches authoritative reads and revalidation of mutable older PRs", async () => {
    h.touches = ["packages/core/src/guard.ts"];
    const upsert = store.upsertPullRequests.bind(store);
    vi.spyOn(store, "upsertPullRequests").mockImplementation((repo, prs, at) =>
      upsert(repo, [...prs, prRow({ number: 10 })], at),
    );
    let active = 0;
    const concurrency: number[] = [];
    h.reviewPrOverride = async (number) => {
      if (number !== 13) {
        concurrency.push(++active);
        await Promise.resolve();
        active--;
      }
      return {
        state: "open",
        headSha: number === 13 ? SHA_B : SHA,
        baseSha: SHA_C,
        mergeCommitSha: null,
      };
    };
    await secondAuthor();
    expect(h.starts).toEqual([]);
    expect(concurrency).toEqual([1, 2, 1, 2]);
  });

  it("persists terminal merged snapshots across queued checks", async () => {
    h.touches = ["packages/core/src/guard.ts"];
    const reads = vi.fn(
      (number: number): ReviewPrSnapshot => ({
        state: number === 12 ? "merged" : "open",
        headSha: number === 12 ? SHA : SHA_B,
        baseSha: SHA_C,
        mergeCommitSha: number === 12 ? SHA_C : null,
      }),
    );
    h.reviewPrOverride = reads;
    await secondAuthor();
    expect(h.starts).toEqual([]);
    reads.mockClear();
    await h.engine.tick();
    expect(reads.mock.calls.filter(([number]) => number === 12)).toEqual([]);
  });

  it("excludes a contained merge before computing its overlap", async () => {
    h.touches = ["packages/core/src/guard.ts"];
    h.descends = true;
    h.reviewPrOverride = (number) => ({
      state: number === 12 ? "merged" : "open",
      headSha: number === 12 ? SHA : SHA_B,
      baseSha: SHA_C,
      mergeCommitSha: number === 12 ? SHA_C : null,
    });
    const touched = vi.fn();
    h.duringTouches = touched;
    await secondAuthor();
    expect(h.starts).toHaveLength(1);
    expect(touched.mock.calls.some(([id]) => id === RUN)).toBe(false);
  });

  it("refreshes authoritative state after a diff while SQLite still says open", async () => {
    h.touchesByRun = { [RUN]: [], [RUN2]: ["packages/core/src/guard.ts"] };
    let merged = false;
    h.reviewPrOverride = (number) => ({
      state: number === 12 && merged ? "merged" : "open",
      headSha: number === 12 ? SHA : SHA_B,
      baseSha: SHA_C,
      mergeCommitSha: number === 12 && merged ? SHA_C : null,
    });
    h.duringTouches = (id) => {
      if (id === RUN) merged = true;
    };
    await secondAuthor();
    expect(store.pullRequests(REPO).find((p) => p.number === 12)?.state).toBe("open");
    expect(h.starts).toEqual([]);
    h.touchesByRun[RUN] = ["packages/core/src/guard.ts"];
    h.duringTouches = undefined;
    const ancestry = vi.fn();
    h.duringDescendant = ancestry;
    await h.engine.tick();
    expect(ancestry).toHaveBeenCalled();
    expect(h.starts).toEqual([]);
  });

  it("invalidates an empty open-PR cache when the collector reports a merge", async () => {
    h.touchesByRun = { [RUN]: [], [RUN2]: ["packages/core/src/guard.ts"] };
    let diffRead = false;
    h.duringTouches = (id) => {
      if (id === RUN) diffRead = true;
    };
    h.reviewPrOverride = (number) =>
      number === 13 && diffRead
        ? null
        : {
            state: "open",
            headSha: number === 12 ? SHA : SHA_B,
            baseSha: SHA_C,
            mergeCommitSha: null,
          };
    await secondAuthor();
    h.touchesByRun[RUN] = ["packages/core/src/guard.ts"];
    store.upsertPullRequests(
      REPO,
      store
        .pullRequests(REPO)
        .map((p) => (p.number === 12 ? { ...p, state: "merged", mergeCommitSha: SHA_C } : p)),
      clock,
    );
    h.reviewPrOverride = undefined;
    h.duringTouches = undefined;
    await h.engine.tick();
    expect(h.starts).toEqual([]);
    expect(store.reviewsOfRun(RUN2)[0]?.state).toBe("queued");
  });

  it("recomputes overlap when the older open head changes", async () => {
    h.touches = ["packages/core/src/guard.ts"];
    await secondAuthor();
    h.touchesByRun = { [RUN]: ["CLAUDE.md"], [RUN2]: h.touches };
    store.upsertPullRequests(
      REPO,
      store.pullRequests(REPO).map((p) => (p.number === 12 ? { ...p, headSha: SHA_C } : p)),
      clock,
    );
    await h.engine.tick();
    expect(h.starts).toHaveLength(1);
  });

  it.each(["merged", "head changed"] as const)(
    "keeps review queued if the older PR %s during its diff",
    async (change) => {
      h.touchesByRun = { [RUN]: [], [RUN2]: ["packages/core/src/guard.ts"] };
      h.duringTouches = (id) => {
        if (id !== RUN) return;
        h.duringTouches = undefined;
        store.upsertPullRequests(
          REPO,
          store.pullRequests(REPO).map((p) =>
            p.number === 12
              ? {
                  ...p,
                  headSha: change === "merged" ? p.headSha : SHA_C,
                  ...(change === "merged"
                    ? { state: "merged" as const, mergeCommitSha: SHA_C }
                    : {}),
                }
              : p,
          ),
          clock,
        );
      };
      await secondAuthor();
      expect(h.starts).toEqual([]);
      expect(store.reviewsOfRun(RUN2)[0]?.state).toBe("queued");
    },
  );

  it("updates before review when the older PR merged before the first overlap check", async () => {
    h.touchesByRun = {
      [RUN]: ["packages/core/src/guard.ts"],
      [RUN2]: ["packages/core/src/guard.ts"],
    };
    // secondAuthor refreshes the PR snapshot before its first reconciliation.
    const upsert = store.upsertPullRequests.bind(store);
    vi.spyOn(store, "upsertPullRequests").mockImplementation((repo, prs, at) =>
      upsert(
        repo,
        prs.map((p) => (p.number === 12 ? { ...p, state: "merged", mergeCommitSha: SHA_C } : p)),
        at,
      ),
    );
    h.tip = SHA_C;
    h.gate = { ...need(h.gate), containsMain: false, mainSha: SHA_C };
    await secondAuthor();
    expect(store.loopEvents(0).some((e) => e.text.startsWith("waits for #12"))).toBe(false);
    expect(h.starts).toEqual([]);
    expect(store.reviewsOfRun(RUN2)[0]?.state).toBe("queued");
    await vi.waitFor(() => expect(h.updates).toHaveLength(1));
    expect(store.runPush(RUN2)?.sha).toBe(SHA_B);
  });

  it("updates before review when the merged predecessor run has ended", async () => {
    h.touchesByRun = {
      [RUN]: ["packages/core/src/guard.ts"],
      [RUN2]: ["packages/core/src/guard.ts"],
    };
    const upsert = store.upsertPullRequests.bind(store);
    vi.spyOn(store, "upsertPullRequests").mockImplementation((repo, prs, at) =>
      upsert(
        repo,
        prs.map((p) => (p.number === 12 ? { ...p, state: "merged", mergeCommitSha: SHA_C } : p)),
        at,
      ),
    );
    const first = need(store.run(RUN));
    store.upsertRun({ ...first, endedAt: clock - 1000 });
    clock += 5000;
    h.tip = SHA_C;
    h.gate = { ...need(h.gate), containsMain: false, mainSha: SHA_C };
    await secondAuthor();
    expect(h.starts).toEqual([]);
    await vi.waitFor(() => expect(h.updates).toHaveLength(1));
    expect(store.reviewsOfRun(RUN2)[0]?.state).toBe("queued");
  });

  it("keeps a mergeable head queued until it includes the older merge", async () => {
    h.touches = ["packages/core/src/guard.ts"];
    await secondAuthor();
    store.upsertPullRequests(
      REPO,
      store
        .pullRequests(REPO)
        .map((p) => (p.number === 12 ? { ...p, state: "merged", mergeCommitSha: SHA_C } : p)),
      clock,
    );
    h.tip = SHA_C;
    // The merged diff is reconstructed against its immutable first parent.
    h.touchesByRun = { [RUN]: h.touches, [RUN2]: h.touches };
    h.gate = { ...need(h.gate), containsMain: false, mainSha: SHA_C };
    await h.engine.tick();
    await h.engine.reconcileRun(RUN2);
    expect(h.starts).toEqual([]);
    await vi.waitFor(() => expect(h.updates).toHaveLength(1));
    expect(store.reviewsOfRun(RUN2)[0]?.state).toBe("queued");
  });

  it.each(["stopped", "lock lost", "author in turn"] as const)(
    "defers the older-merge update when %s during the ancestry read",
    async (condition) => {
      let crewOn = true;
      h.engine.stop();
      h.engine = h.make({ crewOn: () => crewOn });
      h.engine.start();
      h.touches = ["packages/core/src/guard.ts"];
      await secondAuthor();
      store.upsertPullRequests(
        REPO,
        store
          .pullRequests(REPO)
          .map((p) => (p.number === 12 ? { ...p, state: "merged", mergeCommitSha: SHA_C } : p)),
        clock,
      );
      h.gate = { ...need(h.gate), containsMain: false, mainSha: SHA_C };
      let ancestryRead = false;
      h.duringDescendant = (ancestor, head) => {
        if (ancestor !== SHA_C || head !== SHA_C) return;
        ancestryRead = true;
        if (condition === "stopped") h.engine.stop();
        if (condition === "lock lost") crewOn = false;
        if (condition === "author in turn")
          h.facts = { inTurn: true, resumedAt: null, rateLimitedUntil: null };
      };
      await h.engine.tick();
      await h.engine.reconcileRun(RUN2);
      expect(ancestryRead).toBe(true);
      expect(h.updates).toEqual([]);
      expect(store.runPush(RUN2)?.sha).toBe(SHA_B);
      expect(store.reviewsOfRun(RUN2)[0]?.state).toBe("queued");
    },
  );

  it("an older PR with a removed seat still blocks review", async () => {
    h.touchesByRun = { [RUN]: [], [RUN2]: ["packages/core/src/guard.ts"] };
    const session = need(config.crew?.sessions[0]);
    session.seats = session.seats.filter((s) => s.id !== "guido-1");
    await secondAuthor();
    expect(h.starts).toEqual([]);
    expect(store.reviewsOfRun(RUN2)[0]?.state).toBe("queued");
  });

  it.each([
    { mergeable: "CONFLICTING", prSame: false },
    { mergeable: "MERGEABLE", prSame: false },
    { mergeable: "MERGEABLE", prSame: true },
  ] as const)(
    "reviews the updated head after the older shared-hard-rule PR merges ($mergeable, prSame: $prSame)",
    async ({ mergeable, prSame }) => {
      h.touches = ["packages/core/src/guard.ts"];
      await secondAuthor();
      expect(h.starts).toEqual([]);
      const prs = store.pullRequests(REPO);
      store.upsertPullRequests(
        REPO,
        prs.map((p) =>
          p.number === 12 ? { ...p, state: "merged", mergeCommitSha: SHA_C } : { ...p, mergeable },
        ),
        clock,
      );
      h.gate = { ...need(h.gate), containsMain: false, mainSha: SHA_C };
      h.tip = SHA_C;
      h.updateResults = [{ ok: true, kind: "merged", sha: SHA_C, parent: SHA_B, prSame }];
      await h.engine.tick();
      await h.engine.reconcileRun(RUN2);
      await h.engine.reconcileRun(RUN2);
      expect(store.runPush(RUN2)?.sha).toBe(SHA_C);
      h.gate = { ...need(h.gate), containsMain: true };
      store.upsertPullRequests(
        REPO,
        store.pullRequests(REPO).map((p) =>
          p.number === 13
            ? {
                ...p,
                headSha: SHA_C,
                ci: "passing",
                mergeable: "MERGEABLE",
                checks: prRow().checks,
              }
            : p,
        ),
        clock,
      );
      await h.engine.reconcileRun(RUN2);
      await h.engine.reconcileRun(RUN2);
      await h.engine.tick();
      expect(store.reviewsOfRun(RUN2).find((r) => r.state === "running")?.sha).toBe(
        prSame ? SHA_B : SHA_C,
      );
    },
  );

  it.each(["apps/a.ts", "packages/core/src/loop.ts"])(
    "does not hold a PR for unrelated or non-hard-rule files (%s)",
    async (path) => {
      h.touchesByRun = { [RUN]: ["apps/a.ts", "packages/core/src/guard.ts"], [RUN2]: [path] };
      await secondAuthor();
      expect(h.starts).toHaveLength(1);
      expect(store.reviewsOfRun(RUN2)[0]?.state).toBe("running");
    },
  );

  it("keeps a long review-start failure in the review row and loop event", async () => {
    const failure = "x".repeat(1000);
    h.startError = new Error(failure);
    await toReview();
    expect(first()).toMatchObject({ state: "failed", failure });
    expect(loopTexts().some((line) => line.includes(failure))).toBe(true);
  });

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

  it("holds a queued review on constrained capacity", async () => {
    store.addMachineSample({
      at: clock,
      cpuPct: null,
      cores: 8,
      memUsedBytes: 1,
      memTotalBytes: 2,
      diskFreeBytes: 14 * 1024 ** 3,
      diskTotalBytes: 100 * 1024 ** 3,
      agents: null,
    });
    await toReview();
    expect(first()).toMatchObject({ state: "queued", runId: null });
    expect(h.starts).toEqual([]);
    expect(store.run(RUN)?.endedAt).toBeNull();
  });

  it("leaves an already-running review alone when capacity becomes constrained", async () => {
    await toReview();
    const before = first();
    store.addMachineSample({
      at: clock,
      cpuPct: null,
      cores: 8,
      memUsedBytes: 1,
      memTotalBytes: 2,
      diskFreeBytes: 14 * 1024 ** 3,
      diskTotalBytes: 100 * 1024 ** 3,
      agents: null,
    });
    await h.engine.tick();
    expect(first()).toMatchObject({ state: "running", runId: before.runId });
    expect(h.starts).toHaveLength(1);
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

  describe("a review seat whose account is at its stop", () => {
    const stopAccount = (accountId: string): void => {
      store.addUsage({
        accountId,
        window: "7d",
        at: clock,
        pct: 100,
        resetAt: clock + 60 * MIN,
        source: "test",
      });
    };
    const addCodexReviewer = (): void => {
      config.accounts.push({ id: "codex-main", vendor: "codex", alertAt: 80, stopAt: 95 });
      seats().splice(
        seats().findIndex((s) => s.id === RETRO),
        0,
        { ...retroSeat(), id: "retro-cx", accountId: "codex-main" },
      );
    };

    it("reviewerOf gives the next reviewer when the first one's account is at its stop", () => {
      addCodexReviewer();
      const at = { store, now: clock };
      expect(reviewerOf(config, "guido-1", undefined, at)?.id).toBe("retro-cx");
      stopAccount("codex-main");
      expect(reviewerOf(config, "guido-1", undefined, at)?.id).toBe(RETRO);
    });

    it("reviewerOf keeps the first reviewer when every account is at its stop", () => {
      addCodexReviewer();
      stopAccount("codex-main");
      stopAccount("claude-main");
      expect(reviewerOf(config, "guido-1", undefined, { store, now: clock })?.id).toBe("retro-cx");
    });

    it("a queued review moves to an available reviewer when its seat's account stops", async () => {
      addCodexReviewer();
      h.busyList = [{ seatId: "retro-cx", state: "running" }];
      await toReview();
      const old = first();
      expect(old).toMatchObject({ state: "queued", seatId: "retro-cx" });
      stopAccount("codex-main");
      h.busyList = [];
      await h.engine.tick();
      expect(store.review(old.id)?.state).toBe("superseded");
      await vi.waitFor(() => expect(h.starts).toEqual([{ seat: RETRO, id: expect.any(Number) }]));
      expect(reviewRows()[1]).toMatchObject({ seatId: RETRO, sha: SHA });
    });
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

  it("starts two queued reviews on free seats and routes the next one to the first seat freed", async () => {
    const RETRO2 = "retro-2";
    seats().push({ ...retroSeat(), id: RETRO2 });
    await toReview();
    await secondAuthor();
    expect(h.starts.map((start) => start.seat)).toEqual([RETRO, RETRO2]);
    const second = need(store.reviewsOfRun(RUN2)[0]);
    reported(second.id, []);
    expect(reviewerOf(config, SEAT, undefined, { store, now: clock })?.id).toBe(RETRO2);
  });

  it.each(["missing", "lost during send"])(
    "resumes a CLI %s and delivers the fix on a later pass",
    async (when) => {
      await toReview();
      const id = first().id;
      h.noSession = true;
      if (when === "missing") h.facts = null;
      reported(id, [finding("Important")]);
      await h.engine.reconcileRun(RUN);
      await h.engine.tick();
      expect(h.resumes).toEqual([RUN]);
      expect(sentKeys()).toEqual([`fix:${RUN}:0:${id}`]);
      expect(h.sent[0]?.text).toContain("a Important thing");
      await h.engine.tick();
      expect(sentKeys()).toEqual([`fix:${RUN}:0:${id}`]);
    },
  );

  it("a failed resume raises one blocked note across ticks and an engine restart", async () => {
    await toReview();
    const id = first().id;
    h.noSession = true;
    h.facts = null;
    h.resumeFails = true;
    reported(id, [finding("Important")]);
    await h.engine.reconcileRun(RUN);
    await h.engine.tick();
    expect(h.resumes).toEqual([RUN]);
    expect(h.sent).toEqual([]);
    expect(store.notes()).toHaveLength(1);
    const note = store.notes()[0];
    expect(note).toMatchObject({ kind: "blocked", runId: RUN });
    for (let i = 0; i < 3; i++) {
      clock += MIN;
      await h.engine.tick();
    }
    h.engine.stop();
    h.engine = h.make();
    h.engine.start();
    await h.engine.tick();
    expect(h.resumes).toEqual([RUN]);
    expect(store.notes()).toEqual([note]);
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

  it("stores a long review hand-off whole without parking the author", async () => {
    await toReview();
    const findings = Array.from({ length: 6 }, () => ({
      ...finding("Important"),
      fix: "x".repeat(FINDING_FIX_MAX),
    }));
    reported(first().id, findings);
    await vi.waitFor(() => expect(h.sent).toHaveLength(1));
    const text = need(h.sent[0]).text;
    expect(text.length).toBeGreaterThan(CI_EXCERPT_MAX);
    expect(text.length).toBeLessThanOrEqual(FIX_TEXT_MAX);
    expect(FIX_TEXT_MAX).toBeLessThan(COMMS_TEXT_MAX);
    expect(store.comms(0)[0]?.text).toBe(text);
    expect(loopOf().parked).toBeNull();
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
    const ALL = ["ready", "merge", "close", "file-minor", "delete-remote", "delete-local"];
    const authorEnded = () => h.ended.filter((id) => id === RUN);
    it("puts the filed issue in Backlog once and completes the step", async () => {
      setLoop({ minorIssueNumber: 81 });
      await gateOpen();
      await vi.waitFor(() => expect(authorEnded()).toHaveLength(1));
      expect(h.moves).toContainEqual({ runId: RUN, repoId: REPO, issue: 81, column: "Backlog" });
      await h.engine.reconcileRun(RUN);
      expect(h.steps.filter((s) => s === "file-minor")).toHaveLength(1);
      expect(loopOf().merging?.done).toContain("file-minor");
    });
    it("passes the repo's rolling tech-debt issue to the publisher", async () => {
      h.rules = async () => ({ ...DEFAULT_REPO_RULES, hardRulesSet: true, techDebtIssue: 656 });
      await gateOpen();
      await vi.waitFor(() => expect(authorEnded()).toHaveLength(1));
      expect(h.minorIssueCalls).toEqual([656]);
    });
    it("flags a failed minor issue create naming the PR and still ends the run", async () => {
      h.stepResults["file-minor"] = [{ ok: false, text: "create denied", transient: true }];
      await gateOpen();
      await vi.waitFor(() => expect(authorEnded()).toHaveLength(1));
      expect(store.notes()).toContainEqual(
        expect.objectContaining({
          kind: "flag",
          text: expect.stringMatching(/PR #12.*create denied/),
        }),
      );
      expect(loopOf().merging?.done).toContain("file-minor");
      await h.engine.reconcileRun(RUN);
      expect(h.steps.filter((s) => s === "file-minor")).toHaveLength(1);
      await h.engine.tick();
      expect(store.notes().some((n) => n.key === `${RUN}:file-minor`)).toBe(true);
      h.engine.stop();
      h.engine = h.make();
      h.engine.start();
      await h.engine.tick();
      expect(store.notes().some((n) => n.key === `${RUN}:file-minor`)).toBe(true);
      store.clearNote(`${RUN}:file-minor`, clock);
      await h.engine.tick();
      expect(store.notes().some((n) => n.key === `${RUN}:file-minor`)).toBe(false);
    });

    /** A clean review of the pushed sha, with CI passing: the gate is open. */
    async function gateOpen(): Promise<void> {
      await toReview();
      await h.engine.reconcileRun(RUN);
      reported(first().id, []);
    }

    describe("a hold on the merge", () => {
      it("parks a clean, green run instead of merging, and merges once released", async () => {
        await toReview();
        expect(await h.engine.holdMerge(RUN, "FLIGHT", "design not approved")).toEqual({
          ok: true,
        });
        expect(loopOf().mergeHold).toMatchObject({ by: "FLIGHT", reason: "design not approved" });
        await h.engine.reconcileRun(RUN);
        reported(first().id, []);
        await vi.waitFor(() => expect(loopOf().parked?.kind).toBe(MERGE_HOLD_PARK));
        expect(loopOf().parked?.reason).toContain("design not approved");
        expect(h.steps).not.toContain("merge");
        await h.engine.reconcileRun(RUN);
        await h.engine.tick();
        expect(h.steps).not.toContain("merge");
        expect(await h.engine.releaseMergeHold(RUN, "FLIGHT")).toEqual({ ok: true });
        expect(loopOf().mergeHold ?? null).toBeNull();
        await vi.waitFor(() => expect(h.steps).toContain("merge"));
      });

      it("a run held while parked on the hold is not lifted by a resume", async () => {
        await h.engine.holdMerge(RUN, "CAPCOM", "wait");
        await gateOpen();
        await vi.waitFor(() => expect(loopOf().parked?.kind).toBe(MERGE_HOLD_PARK));
        expect(await h.engine.onOperatorMessage(RUN, "CAPCOM")).toEqual({
          lifted: false,
          reason: "use-merge-hold",
        });
        expect(await h.engine.onOperatorMessage(RUN, "FLIGHT")).toEqual({
          lifted: false,
          reason: "use-merge-hold",
        });
        expect(h.steps).not.toContain("merge");
      });

      it("FLIGHT cannot release a hold the controller set; the controller can", async () => {
        await toReview();
        await h.engine.holdMerge(RUN, "CAPCOM", "veto");
        const refused = await h.engine.releaseMergeHold(RUN, "FLIGHT");
        expect(refused.ok).toBe(false);
        expect(loopOf().mergeHold).toMatchObject({ by: "CAPCOM", reason: "veto" });
        expect(await h.engine.releaseMergeHold(RUN, "CAPCOM")).toEqual({ ok: true });
        expect(loopOf().mergeHold ?? null).toBeNull();
      });

      it("FLIGHT cannot replace the controller's hold, the controller can replace FLIGHT's", async () => {
        await toReview();
        await h.engine.holdMerge(RUN, "CAPCOM", "veto");
        expect((await h.engine.holdMerge(RUN, "FLIGHT", "mine")).ok).toBe(false);
        expect(loopOf().mergeHold?.by).toBe("CAPCOM");
        await h.engine.releaseMergeHold(RUN, "CAPCOM");
        await h.engine.holdMerge(RUN, "FLIGHT", "mine");
        expect(await h.engine.holdMerge(RUN, "CAPCOM", "theirs")).toEqual({ ok: true });
        expect(loopOf().mergeHold).toMatchObject({ by: "CAPCOM", reason: "theirs" });
      });

      it("a hold replaced while parked names the new holder and releases to the phase it left", async () => {
        await h.engine.holdMerge(RUN, "FLIGHT", "mine");
        await gateOpen();
        await vi.waitFor(() => expect(loopOf().parked?.kind).toBe(MERGE_HOLD_PARK));
        expect(loopOf().mergeHold?.from).toBe("review");
        expect(await h.engine.holdMerge(RUN, "CAPCOM", "theirs")).toEqual({ ok: true });
        expect(loopOf().parked?.reason).toBe("merge held by CAPCOM: theirs");
        expect(loopOf().mergeHold).toMatchObject({
          by: "CAPCOM",
          reason: "theirs",
          from: "review",
        });
        await h.engine.reconcileRun(RUN);
        expect(loopOf().parked?.reason).toBe("merge held by CAPCOM: theirs");
        expect(h.steps).not.toContain("merge");
        expect(await h.engine.releaseMergeHold(RUN, "CAPCOM")).toEqual({ ok: true });
        await vi.waitFor(() => expect(h.steps).toContain("merge"));
      });

      it("refuses to hold or release when there is nothing to do", async () => {
        expect((await h.engine.releaseMergeHold(RUN, "CAPCOM")).ok).toBe(false);
        expect((await h.engine.holdMerge("nope", "CAPCOM", "x")).ok).toBe(false);
      });
    });

    describe("a ticket's controller check", () => {
      const CHECK = "Open the swatches in a browser, light and dark.";
      const withTicket = (text: string) => {
        h.engine.stop();
        h.engine = h.make({ fetchTicket: async () => ticketView(text) });
        h.engine.start();
      };
      const parkedOnCheck = async () => {
        withTicket(`## Done when\n- x\n\n${CONTROLLER_CHECK_HEADING}\n${CHECK}\n\n## Other\ny`);
        await gateOpen();
        await vi.waitFor(() => expect(loopOf().parked?.kind).toBe(CONTROLLER_CHECK_PARK));
      };

      it("parks the merge with the section's text", async () => {
        await parkedOnCheck();
        expect(h.steps).not.toContain("merge");
        expect(loopOf().parked?.reason).toBe(controllerCheckParkText(SHA, CHECK));
        expect(loopOf().controllerCheck).toEqual({ sha: SHA, from: "review", pass: false });
        expect(loopOf().controllerCheckRequired).toBe(true);
        await h.engine.reconcileRun(RUN);
        expect(h.steps).not.toContain("merge");
      });

      it("a pass merges", async () => {
        await parkedOnCheck();
        expect(await h.engine.controllerCheck(RUN, "pass", SHA.slice(0, 7))).toEqual({
          lifted: true,
        });
        await vi.waitFor(() => expect(h.steps).toContain("merge"));
      });

      it("a pass on a moved head or another sha is refused", async () => {
        await parkedOnCheck();
        expect(await h.engine.controllerCheck(RUN, "pass", SHA_B.slice(0, 7))).toEqual({
          lifted: false,
          reason: "head-moved",
        });
        setPr({ headSha: "f".repeat(40) });
        expect(await h.engine.controllerCheck(RUN, "pass", SHA)).toEqual({
          lifted: false,
          reason: "head-moved",
        });
        expect(loopOf().parked?.kind).toBe(CONTROLLER_CHECK_PARK);
        expect(h.steps).not.toContain("merge");
      });

      it("a pass on another head does not release this one", async () => {
        await parkedOnCheck();
        setLoop({
          phase: "review",
          parked: null,
          controllerCheck: { sha: SHA_B, from: "review", pass: true },
        });
        await h.engine.reconcileRun(RUN);
        expect(loopOf().parked?.kind).toBe(CONTROLLER_CHECK_PARK);
        expect(h.steps).not.toContain("merge");
      });

      it("a fail sends the note to the seat as rework and ends the park", async () => {
        await parkedOnCheck();
        expect(await h.engine.controllerCheck(RUN, "fail", SHA, "swatch 3 is unreadable")).toEqual({
          lifted: true,
        });
        expect(h.sent.at(-1)?.text).toBe(controllerCheckFailText(SHA, "swatch 3 is unreadable"));
        expect(loopOf().phase).toBe("working");
        expect(h.steps).not.toContain("merge");
      });

      it("a fail is recorded for a paused seat", async () => {
        await parkedOnCheck();
        h.noSession = true;
        writeCrewPause(store, { seats: "all", reason: "x", at: clock, by: "operator" }, clock);
        expect(await h.engine.controllerCheck(RUN, "fail", SHA, "bad")).toEqual({ lifted: true });
        expect(loopOf().phase).toBe("working");
      });

      it("a verdict on a run that is not parked on a check is refused", async () => {
        await gateOpen();
        expect(await h.engine.controllerCheck(RUN, "pass", SHA)).toMatchObject({ lifted: false });
      });

      it.each(["FLIGHT", "CAPCOM"] as const)("%s cannot lift it with a resume", async (by) => {
        need(config.repos[0]).flightPowers = "superuser";
        await parkedOnCheck();
        expect(await h.engine.onOperatorMessage(RUN, by)).toEqual({
          lifted: false,
          reason: "use-controller-check",
        });
        expect(loopOf().parked?.kind).toBe(CONTROLLER_CHECK_PARK);
      });

      it("a ticket without a heading merges as before", async () => {
        withTicket("## Done when\n- x\n\nsome Controller check text");
        await gateOpen();
        await vi.waitFor(() => expect(h.steps).toContain("merge"));
        expect(loopOf().parked).toBeNull();
      });

      it.each(["### Controller check", "## Controller checks", "## Controller check (browser)"])(
        "the variant %s holds the merge",
        async (heading) => {
          withTicket(`${heading}\n${CHECK}`);
          await gateOpen();
          await vi.waitFor(() => expect(loopOf().parked?.kind).toBe(CONTROLLER_CHECK_PARK));
          expect(h.steps).not.toContain("merge");
        },
      );

      it("a heading that went from the ticket still needs a pass", async () => {
        await parkedOnCheck();
        withTicket("## Done when\n- x");
        await h.engine.reconcileRun(RUN);
        setLoop({ phase: "review", parked: null });
        await h.engine.reconcileRun(RUN);
        expect(loopOf().parked?.kind).toBe(CONTROLLER_CHECK_PARK);
        expect(h.steps).not.toContain("merge");
      });

      it("a ticket the reader marks as having a check (past the cut) holds", async () => {
        h.engine.stop();
        h.engine = h.make({
          fetchTicket: async () => ({
            ...ticketView("short"),
            bodyTruncated: true,
            controllerCheck: CHECK,
          }),
        });
        h.engine.start();
        await gateOpen();
        await vi.waitFor(() => expect(loopOf().parked?.kind).toBe(CONTROLLER_CHECK_PARK));
      });

      it("a cut body the reader could not read holds", async () => {
        h.engine.stop();
        h.engine = h.make({
          fetchTicket: async () => ({ ...ticketView("short"), bodyTruncated: true }),
        });
        h.engine.start();
        await gateOpen();
        await vi.waitFor(() => expect(loopOf().parked?.kind).toBe(CONTROLLER_CHECK_PARK));
      });

      it("a reader that throws or finds no ticket never merges; the operator can pass it", async () => {
        h.engine.stop();
        h.engine = h.make({
          fetchTicket: async () => {
            throw new Error("gh is down");
          },
        });
        h.engine.start();
        await gateOpen();
        await h.engine.reconcileRun(RUN);
        expect(h.steps).not.toContain("merge");
        expect(loopOf().lastRefusal).toBe("ticket could not be read: gh is down");
        for (let i = 0; i < 4 && loopOf().parked === null; i++) {
          clock += ENGINE_TICK_MS;
          await h.engine.reconcileRun(RUN);
        }
        expect(loopOf().parked?.kind).toBe(CONTROLLER_CHECK_PARK);
        expect(loopOf().parked?.reason).toContain("ticket could not be read: gh is down");
        expect(h.steps).not.toContain("merge");
        expect(await h.engine.controllerCheck(RUN, "pass", SHA)).toEqual({ lifted: true });
        await vi.waitFor(() => expect(h.steps).toContain("merge"));
      });

      it("a ticket that is not found holds", async () => {
        h.engine.stop();
        h.engine = h.make({ fetchTicket: async () => null });
        h.engine.start();
        await gateOpen();
        await h.engine.reconcileRun(RUN);
        expect(h.steps).not.toContain("merge");
      });
    });

    it.each([false, true])(
      "away never merges a ready PR; off or expiry restores merging (%s)",
      async (expired) => {
        store.setSetting(AWAY_SETTING, JSON.stringify({ ...DEFAULT_AWAY, on: true }));
        await gateOpen();
        setPr({ isDraft: false, ci: "passing" });
        await h.engine.reconcileRun(RUN);
        expect(h.steps).not.toContain("merge");
        expect(loopOf().phase).toBe("review");
        store.setSetting(
          AWAY_SETTING,
          JSON.stringify({ ...DEFAULT_AWAY, on: expired, until: expired ? "2026-10-20" : "" }),
        );
        await h.engine.reconcileRun(RUN);
        expect(h.steps).toContain("merge");
      },
    );

    it.each(["draft", "merge"] as const)(
      "away respects %s repo autonomy when a PR is safe",
      async (autonomy) => {
        need(config.repos[0]).autonomy = autonomy;
        store.replaceBoard(REPO, [item({ labels: ["docs"], size: "S" })]);
        store.setSetting(AWAY_SETTING, JSON.stringify({ ...DEFAULT_AWAY, on: true }));
        await gateOpen();
        await h.engine.reconcileRun(RUN);
        expect(h.steps).toEqual(autonomy === "merge" ? ["ready"] : []);
      },
    );

    it.each(["metadata", "toggle", "diff", "unreadable", "minor", "unset", "pickUp", "area"])(
      "away holds a PR with unsafe %s",
      async (reason) => {
        store.replaceBoard(REPO, [
          item({ labels: ["docs"], size: reason === "metadata" ? "M" : "S" }),
        ]);
        store.setSetting(
          AWAY_SETTING,
          JSON.stringify({
            ...DEFAULT_AWAY,
            on: true,
            may: { ...DEFAULT_AWAY.may, safePr: reason !== "toggle", pickUp: reason !== "pickUp" },
          }),
        );
        if (reason === "unset") h.rules = async () => DEFAULT_REPO_RULES;
        if (reason === "area")
          h.awayDiff = { base: SHA_B, changes: [{ path: "docs/outside.md", status: "A" }] };
        if (reason === "diff")
          h.awayDiff = { base: SHA_B, changes: [{ path: "src/main.ts", status: "M" }] };
        if (reason === "unreadable") h.awayDiff = null;
        await toReview();
        await h.engine.reconcileRun(RUN);
        reported(first().id, reason === "minor" ? [finding("Minor")] : []);
        await h.engine.reconcileRun(RUN);
        expect(h.steps).toEqual([]);
      },
    );

    it.each(["sha", "test"])(
      "away requires a bug decision for the current base and head with %s evidence",
      async (evidence) => {
        store.replaceBoard(REPO, [item({ labels: ["bug"], size: "S" })]);
        h.awayDiff = {
          base: SHA_B,
          changes: [{ path: "apps/server/test/reproduce.test.ts", status: "A" }],
        };
        store.setSetting(AWAY_SETTING, JSON.stringify({ ...DEFAULT_AWAY, on: true }));
        await gateOpen();
        await h.engine.reconcileRun(RUN);
        expect(h.steps).toEqual([]);
        const decision = {
          at: clock,
          kind: "note" as const,
          seatId: null,
          targetRunId: null,
          ref: null,
          questionId: null,
          decision: AWAY_BUG_VERIFIED,
          basis:
            evidence === "sha"
              ? `${SHA}: fails on base, passes on branch`
              : "apps/server/test/reproduce.test.ts fails on base, passes on branch",
        };
        store.addFlightDecision({
          ...decision,
          about: awayBugDecisionAbout(`${REPO}#7`, SHA, SHA),
        });
        await h.engine.reconcileRun(RUN);
        expect(h.steps).toEqual([]);
        expect(loopOf().awayBugDecision?.about).toBe(awayBugDecisionAbout(`${REPO}#7`, SHA_B, SHA));
        store.addFlightDecision({
          ...decision,
          basis: "generic assertions",
          about: awayBugDecisionAbout(`${REPO}#7`, SHA_B, SHA),
        });
        await h.engine.reconcileRun(RUN);
        expect(h.steps).toEqual([]);
        store.addFlightDecision({
          ...decision,
          about: awayBugDecisionAbout(`${REPO}#7`, SHA_B, SHA),
        });
        await h.engine.reconcileRun(RUN);
        expect(h.steps).toEqual(evidence === "test" ? ["ready"] : []);
      },
    );

    it.each([
      ["apps/server/src/feature.ts", "M"],
      ["apps/server/test/helpers.ts", "A"],
      ["apps/server/test/fixtures/reproduce.ts", "A"],
      ["apps/server/test/fixtures/reproduce.test.ts", "A"],
      ["apps/server/test/reproduce.test.md", "A"],
      ["apps/server/test/reproduce.test.ts", "M"],
      ["apps/server/test/reproduce.test.ts", "D"],
    ])("a bug without an added reproducing test stays draft: %s %s", async (path, status) => {
      store.replaceBoard(REPO, [item({ labels: ["bug"], size: "S" })]);
      h.awayDiff = { base: SHA_B, changes: [{ path, status }] };
      store.setSetting(AWAY_SETTING, JSON.stringify({ ...DEFAULT_AWAY, on: true }));
      store.addFlightDecision({
        at: clock,
        kind: "note",
        seatId: null,
        targetRunId: null,
        ref: null,
        questionId: null,
        about: awayBugDecisionAbout(`${REPO}#7`, SHA_B, SHA),
        decision: AWAY_BUG_VERIFIED,
        basis: `${path} at ${SHA}: fails on base, passes on branch`,
      });
      await gateOpen();
      await h.engine.reconcileRun(RUN);
      expect(h.steps).toEqual([]);
      expect(loopOf().awayBugDecision?.testPaths ?? []).toEqual([]);
    });

    it.each([false, true])(
      "retries a failed ready rollback with a stale PR cache: %s",
      async (moved) => {
        store.replaceBoard(REPO, [item({ labels: ["docs"], size: "S" })]);
        store.setSetting(AWAY_SETTING, JSON.stringify({ ...DEFAULT_AWAY, on: true }));
        h.stepResults.ready = [{ ok: false, transient: true, text: READY_UNDO_FAILED }];
        // Reporting the review also queues passes: keep rollback failing through those.
        h.stepResults.draft = Array.from({ length: 10 }, () => ({
          ok: false,
          transient: true,
          text: "GitHub unavailable",
        }));
        await gateOpen();
        await h.engine.reconcileRun(RUN);
        expect(loopOf().merging).toEqual({ sha: SHA, done: ["ready"] });
        expect(loopOf().lastRefusal).toBe(READY_UNDO_FAILED);
        expect(h.steps.filter((step) => step === "ready")).toHaveLength(1);
        h.steps.length = 0;
        // The poll may still have the original draft and head, or the new ready head.
        setPr({ isDraft: !moved, headSha: moved ? SHA_B : SHA, ci: "passing" });
        h.stepResults.draft = [{ ok: false, transient: true, text: "GitHub unavailable" }];
        await h.engine.reconcileRun(RUN);
        expect(h.steps).toEqual(["draft"]);
        expect(loopOf().merging).toEqual({ sha: SHA, done: ["ready"] });
        await h.engine.reconcileRun(RUN);
        expect(h.steps).toEqual(["draft", "draft"]);
        expect(loopOf().merging).toBeNull();
        expect(loopOf().lastRefusal).toBeNull();
      },
    );

    it("restores draft on the next pass when an away-ready head moves", async () => {
      store.replaceBoard(REPO, [item({ labels: ["docs"], size: "S" })]);
      store.setSetting(AWAY_SETTING, JSON.stringify({ ...DEFAULT_AWAY, on: true }));
      await gateOpen();
      await h.engine.reconcileRun(RUN);
      expect(h.steps).toEqual(["ready"]);
      setPr({ isDraft: false, headSha: SHA_B, ci: "passing" });
      await h.engine.reconcileRun(RUN);
      expect(h.steps).toEqual(["ready", "draft"]);
      expect(loopOf().merging).toBeNull();
    });

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
        done: ["ready", "merge", "close", "file-minor", "delete-remote", "delete-local"],
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

    it("merges without resuming the author's missing CLI", async () => {
      await toReview();
      await h.engine.reconcileRun(RUN);
      h.facts = null;
      h.noSession = true;
      reported(first().id, []);
      await h.engine.reconcileRun(RUN);
      await vi.waitFor(() => expect(h.steps).toEqual(ALL));
      expect(authorEnded()).toEqual([RUN]);
      expect(h.resumes).toEqual([]);
    });

    it("does not merge while the rules leave hard_rules unset, and says which key to add", async () => {
      h.rules = async () => parseRepoRules(null);
      await gateOpen();
      await vi.waitFor(() => expect(noteKeys()).toContain(hardRulesUnsetNoteKey(REPO)));
      await vi.waitFor(() => expect(noteKeys()).toContain(`ready:${RUN}:${SHA}`));
      expect(h.steps).toEqual([]);
      const unset = store.notes().filter((n) => n.key === hardRulesUnsetNoteKey(REPO));
      expect(unset.map((n) => n.text)).toEqual([hardRulesUnsetText(REPO)]);
      expect(unset[0]?.text).toContain("~/.config/mission-control/config.yaml");
      expect(unset[0]?.text).toContain("repos[].rules.hard_rules");
      // user config alone enables the merge and clears the note
      h.rules = async () => parseRepoRules(null, resolveRepoRules({ hard_rules: [] }));
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
      await vi.waitFor(() =>
        expect(h.steps).toEqual(["close", "file-minor", "delete-remote", "delete-local"]),
      );
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

      it.each([true, false])(
        "carries FLIGHT clearance only for an unchanged main-merge diff (%s)",
        async (prSame) => {
          need(config.repos[0]).flightPowers = "superuser";
          h.touches = ["apps/server/src/flight/tools.ts"];
          h.gate = { ...need(h.gate), strays: h.touches };
          behindMain();
          h.updateResults = [{ ok: true, kind: "merged", sha: SHA_B, parent: SHA, prSame }];
          await toReview();
          await h.engine.reconcileRun(RUN);
          setLoop({ flightClearedSha: SHA });
          setPr({ ci: "passing", mergeable: "CONFLICTING" });
          reported(first().id, []);
          await vi.waitFor(() => expect(store.runPush(RUN)?.sha).toBe(SHA_B));
          await h.engine.reconcileRun(RUN);
          expect(loopOf().flightClearedSha).toBe(prSame ? SHA : null);
        },
      );

      it.each([true, false])(
        "carries an accepted review ruling only across an unchanged diff (%s)",
        async (prSame) => {
          await toReview();
          await h.engine.reconcileRun(RUN);
          setLoop({ phase: "review", reviewWaivedSha: SHA });
          behindMain();
          h.updateResults = [{ ok: true, kind: "merged", sha: SHA_B, parent: SHA, prSame }];
          setPr({ ci: "passing", mergeable: "CONFLICTING" });
          await h.engine.reconcileRun(RUN);
          expect(store.runPush(RUN)?.sha).toBe(SHA_B);
          expect(loopOf().reviewWaivedSha).toBe(prSame ? SHA_B : SHA);
        },
      );

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

    it("FLIGHT clears a hard-rule run, and the engine merges it", async () => {
      need(config.repos[0]).flightPowers = "superuser";
      h.touches = ["apps/server/src/flight/tools.ts"];
      h.gate = { ...need(h.gate), strays: [] };
      await gateOpen();
      await vi.waitFor(() => expect(loopOf().awaitingFlight).toBe(SHA));
      expect(h.steps).toEqual([]);
      expect(await h.engine.clearFlight(RUN)).toBe(true);
      expect(h.steps).toContain("merge");
    });

    it.each(["apps/web/src/x.ts", "apps/server/src/guard/x.ts"])(
      "accept keeps RETRO independent on %s",
      async (path) => {
        need(config.repos[0]).flightPowers = "superuser";
        h.touches = [path];
        await toReview();
        await h.engine.reconcileRun(RUN);
        reported(first().id, [finding("Critical")]);
        await h.engine.reconcileRun(RUN);
        setLoop({
          phase: "parked",
          parked: { kind: "review", reason: "Blocked review", ended: false },
        });
        const accepted = await operate(RUN, "FLIGHT", {
          kinds: ["review"],
          action: "accept",
        });
        expect(accepted).toBe(path.startsWith("apps/web"));
        if (accepted) {
          expect(loopOf().reviewWaivedSha).toBe(SHA);
          expect(h.statusCalls.at(-1)).toMatchObject({
            state: "success",
            description: REVIEW_STATUS_WAIVED,
          });
          setPr({
            ci: "passing",
            checks: [
              {
                name: "mc/review",
                kind: "status",
                conclusion: "SUCCESS",
                state: "passing",
                attempt: null,
                url: null,
              },
            ],
          });
          await h.engine.reconcileRun(RUN);
          expect(h.steps).toContain("merge");
        } else expect(loopOf().phase).toBe("parked");
      },
    );

    it.each(["review", "review-ruling", "ruling", "review-failed"])(
      "accept requires a reported floor review (%s)",
      async (kind) => {
        need(config.repos[0]).flightPowers = "superuser";
        h.touches = ["apps/server/src/guard/x.ts"];
        await toReview();
        await h.engine.reconcileRun(RUN);
        setLoop({ phase: "parked", parked: { kind, reason: "held", ended: false } });
        expect(await operate(RUN, "FLIGHT", { kinds: [kind], action: "accept" })).toBe(false);
      },
    );
    it.each(["ruling", "review-failed"])(
      "accept refuses %s even with a passing RETRO review",
      async (kind) => {
        need(config.repos[0]).flightPowers = "superuser";
        h.touches = ["apps/server/src/guard/x.ts"];
        await toReview();
        await h.engine.reconcileRun(RUN);
        reported(first().id, []);
        await h.engine.reconcileRun(RUN);
        setLoop({ phase: "parked", parked: { kind, reason: "held", ended: false } });
        expect(await operate(RUN, "FLIGHT", { kinds: [kind], action: "accept" })).toBe(false);
      },
    );
    it("accept permits floor code after a reported unblocked RETRO review", async () => {
      need(config.repos[0]).flightPowers = "superuser";
      h.touches = ["apps/server/src/guard/x.ts"];
      await toReview();
      await h.engine.reconcileRun(RUN);
      reported(first().id, []);
      await h.engine.reconcileRun(RUN);
      setLoop({ phase: "parked", parked: { kind: "review", reason: "held", ended: false } });
      expect(await operate(RUN, "FLIGHT", { kinds: ["review"], action: "accept" })).toBe(true);
    });

    it("a plain FLIGHT message cannot lift a failed review", async () => {
      need(config.repos[0]).flightPowers = "superuser";
      await toReview();
      await h.engine.reconcileRun(RUN);
      setLoop({
        phase: "parked",
        parked: { kind: "review-failed", reason: "failed", ended: false },
      });
      expect(await operate(RUN, "FLIGHT")).toBe(false);
    });

    it("caps fresh RETRO requests at two per head", async () => {
      need(config.repos[0]).flightPowers = "superuser";
      await toReview();
      for (let i = 0; i < 3; i++) {
        await h.engine.reconcileRun(RUN);
        setLoop({
          phase: "parked",
          parked: { kind: "review-failed", reason: "failed", ended: false },
        });
        const result = await operate(RUN, "FLIGHT", {
          kinds: ["review-failed"],
          action: "rereview",
        });
        expect(result).toBe(i < 2);
      }
    });
    it("a refused CI rerun costs no per-head attempt", async () => {
      need(config.repos[0]).flightPowers = "superuser";
      await toReview();
      setPr({ ci: "failing" });
      h.rerunResults = [{ ok: false, text: "no failed jobs", transient: false }];
      expect((await h.engine.rerunCi(RUN)).ok).toBe(false);
      expect((await h.engine.rerunCi(RUN)).ok).toBe(true);
      expect((await h.engine.rerunCi(RUN)).ok).toBe(true);
      expect((await h.engine.rerunCi(RUN)).ok).toBe(false);
    });

    it("an accepted head waits until the waived status has been written", async () => {
      need(config.repos[0]).flightPowers = "superuser";
      await toReview();
      await h.engine.reconcileRun(RUN);
      setLoop({ phase: "parked", parked: { kind: "review", reason: "Findings", ended: false } });
      setPr({
        ci: "passing",
        checks: [
          {
            name: "mc/review",
            kind: "status",
            conclusion: "SUCCESS",
            state: "passing",
            attempt: null,
            url: null,
          },
        ],
      });
      h.statusThrows = new Error("GitHub unavailable");
      expect(await operate(RUN, "FLIGHT", { kinds: ["review"], action: "accept" })).toBe(true);
      expect(h.steps).not.toContain("merge");
      h.statusThrows = null;
      await h.engine.reconcileRun(RUN);
      expect(h.statusCalls.at(-1)).toMatchObject({
        state: "success",
        description: REVIEW_STATUS_WAIVED,
      });
      expect(h.steps).toContain("merge");
    });

    it.each(["rereview", "rework"] as const)(
      "settle %s uses the existing review and seat paths",
      async (action) => {
        need(config.repos[0]).flightPowers = "superuser";
        await toReview();
        await h.engine.reconcileRun(RUN);
        reported(first().id, [finding("Important")]);
        await h.engine.reconcileRun(RUN);
        setLoop({ phase: "parked", parked: { kind: "review", reason: "Findings", ended: false } });
        expect(await operate(RUN, "FLIGHT", { kinds: ["review"], action })).toBe(true);
        expect(loopOf().reviewWaivedSha).toBeNull();
        if (action === "rereview") expect(reviewRows().some((r) => r.epoch === 1)).toBe(true);
        else
          expect(
            h.sent.some(
              (line) => line.key.includes("flight-rework") && line.text.includes("Important"),
            ),
          ).toBe(true);
      },
    );

    it("grants one capped rework per head and appends FLIGHT's fix list", async () => {
      need(config.repos[0]).flightPowers = "superuser";
      await toReview();
      await h.engine.reconcileRun(RUN);
      reported(first().id, [finding("Important")]);
      await h.engine.reconcileRun(RUN);
      setLoop({
        phase: "parked",
        parked: { kind: "review", reason: "review round cap", ended: false },
      });

      expect(
        await operate(RUN, "FLIGHT", {
          kinds: ["review"],
          action: "rework",
          note: "Exercise the invalid input branch before reporting again.",
        }),
      ).toBe(true);
      expect(loopOf()).toMatchObject({
        phase: "working",
        flightReworks: { [SHA]: 1 },
      });
      expect(h.sent.at(-1)?.text).toContain(
        "FLIGHT fix list: Exercise the invalid input branch before reporting again.",
      );

      setLoop({ phase: "parked", parked: { kind: "review", reason: "again", ended: false } });
      expect(await operate(RUN, "FLIGHT", { kinds: ["review"], action: "rework" })).toBe(false);
      expect(loopOf().parked).not.toBeNull();
    });

    it("lift verifies that the current head descends from the push", async () => {
      need(config.repos[0]).flightPowers = "superuser";
      await toReview();
      await h.engine.reconcileRun(RUN);
      setLoop({ phase: "parked", parked: { kind: "stuck", reason: "stuck", ended: false } });
      clock += 1000;
      commit(SHA_B);
      expect(await operate(RUN, "FLIGHT", { kinds: ["stuck"], action: "lift" })).toBe(false);
      h.descends = true;
      expect(await operate(RUN, "FLIGHT", { kinds: ["stuck"], action: "lift" })).toBe(true);
    });

    describe("names the check that refused", () => {
      const refusal = async (
        by: "CAPCOM" | "FLIGHT",
        opts: NonNullable<Parameters<typeof h.engine.onOperatorMessage>[2]>,
      ) => {
        const result = await h.engine.onOperatorMessage(RUN, by, opts);
        expect(result.lifted).toBe(false);
        return result.lifted ? null : result.reason;
      };
      const parkedReview = async () => {
        need(config.repos[0]).flightPowers = "superuser";
        await toReview();
        await h.engine.reconcileRun(RUN);
        setLoop({ phase: "parked", parked: { kind: "review", reason: "Findings", ended: false } });
      };

      it("not parked", async () => {
        need(config.repos[0]).flightPowers = "superuser";
        await toReview();
        expect(await refusal("FLIGHT", { action: "rework" })).toBe("not-parked");
      });

      it("PR closed", async () => {
        await parkedReview();
        setLoop({ phase: "parked", parked: { kind: "pr-closed", reason: "closed", ended: false } });
        expect(await refusal("CAPCOM", { action: "accept" })).toBe("pr-closed");
      });

      it("held by a stopped seat", async () => {
        await parkedReview();
        store.setSeatSession({ ...(store.seatSession(SEAT) as SeatSessionRow), state: "stopped" });
        expect(await refusal("FLIGHT", { kinds: ["review"], action: "rework" })).toBe("held");
      });

      it("a budget park is never FLIGHT's", async () => {
        await parkedReview();
        setLoop({ phase: "parked", parked: { kind: "budget", reason: "budget", ended: false } });
        expect(await refusal("FLIGHT", { action: "rework" })).toBe("held");
      });

      it("an action that does not fit the park", async () => {
        await parkedReview();
        expect(await refusal("FLIGHT", { kinds: ["stuck"], action: "lift" })).toBe("wrong-action");
        setLoop({ phase: "parked", parked: { kind: "review-failed", reason: "x", ended: false } });
        expect(await refusal("FLIGHT", {})).toBe("wrong-action");
      });

      it("an action CAPCOM may not take", async () => {
        await parkedReview();
        expect(await refusal("CAPCOM", { action: "rework" })).toBe("not-permitted");
      });

      it("head moved", async () => {
        await parkedReview();
        setPr({ headSha: SHA_B });
        expect(await refusal("CAPCOM", { action: "accept" })).toBe("head-moved");
      });

      it("a lift whose head does not descend from the push", async () => {
        need(config.repos[0]).flightPowers = "superuser";
        await toReview();
        await h.engine.reconcileRun(RUN);
        setLoop({ phase: "parked", parked: { kind: "stuck", reason: "stuck", ended: false } });
        clock += 1000;
        commit(SHA_B);
        expect(await refusal("FLIGHT", { kinds: ["stuck"], action: "lift" })).toBe("head-moved");
      });

      it("PR not open", async () => {
        await parkedReview();
        setPr({ state: "closed" });
        expect(await refusal("CAPCOM", { action: "accept" })).toBe("pr-not-open");
      });

      it("round already granted on this head", async () => {
        await parkedReview();
        expect(await operate(RUN, "FLIGHT", { action: "rework" })).toBe(true);
        setLoop({ phase: "parked", parked: { kind: "review", reason: "again", ended: false } });
        expect(await refusal("FLIGHT", { action: "rework" })).toBe("round-granted");
      });

      it("a blocking review on floor-enforcing paths", async () => {
        need(config.repos[0]).flightPowers = "superuser";
        h.touches = ["apps/server/src/guard/x.ts"];
        await toReview();
        await h.engine.reconcileRun(RUN);
        reported(first().id, [finding("Critical")]);
        await h.engine.reconcileRun(RUN);
        setLoop({ phase: "parked", parked: { kind: "review", reason: "Blocked", ended: false } });
        expect(await refusal("FLIGHT", { kinds: ["review"], action: "accept" })).toBe(
          "floor-enforced",
        );
      });

      it("the operator's message could not be stored", async () => {
        await parkedReview();
        expect(await refusal("CAPCOM", { beforeLift: async () => false })).toBe("before-lift");
      });

      it("the rework could not be delivered, and the run stays parked", async () => {
        await parkedReview();
        h.busy = true;
        expect(await refusal("FLIGHT", { kinds: ["review"], action: "rework" })).toBe(
          "rework-undelivered",
        );
        expect(loopOf().parked).not.toBeNull();
      });

      it("the engine failed while lifting", async () => {
        await parkedReview();
        const spy = vi.spyOn(store, "setRunLoop").mockImplementationOnce(() => {
          throw new Error("disk full");
        });
        expect(await refusal("CAPCOM", {})).toBe("engine-error");
        spy.mockRestore();
      });

      it("the engine is off", async () => {
        await parkedReview();
        h.engine.stop();
        expect(await refusal("CAPCOM", {})).toBe("engine-off");
      });
    });

    it("FLIGHT's CI reruns stop at two per head", async () => {
      need(config.repos[0]).flightPowers = "superuser";
      await toReview();
      setPr({ ci: "failing" });
      expect((await h.engine.rerunCi(RUN)).ok).toBe(true);
      expect((await h.engine.rerunCi(RUN)).ok).toBe(true);
      expect((await h.engine.rerunCi(RUN)).ok).toBe(false);
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
      expect(
        attentionItems(config, store, clock).find((i) => i.key === `note:ready:${RUN}:${SHA}`)
          ?.owner,
      ).toBe("operator");
      expect(loopOf().touches).toEqual({
        sha: SHA,
        paths: h.touches,
        flightPowers: "superuser",
        hardRulesHash: createHash("sha256")
          .update(JSON.stringify(["x/**"]))
          .digest("hex"),
      });
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
      expect(loopOf().touches).toEqual({
        sha: SHA,
        paths: h.touches,
        flightPowers: "superuser",
        hardRulesHash: createHash("sha256")
          .update(JSON.stringify(["x/**"]))
          .digest("hex"),
      });
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
      expect(loopOf().touches).toEqual({
        sha: SHA,
        paths: [],
        flightPowers: "standard",
        hardRulesHash: createHash("sha256")
          .update(JSON.stringify(["x/**"]))
          .digest("hex"),
      });
    });

    it("re-reads touches when hard rules change for the same sha", async () => {
      h.rules = async () => ({ ...DEFAULT_REPO_RULES, hardRulesSet: true, hardRules: ["x/**"] });
      h.touches = ["docs/new.md"];
      await toReview();
      await h.engine.reconcileRun(RUN);
      const reads = h.hardRuleLists.length;
      h.rules = async () => ({ ...DEFAULT_REPO_RULES, hardRulesSet: true, hardRules: ["docs/**"] });
      await h.engine.reconcileRun(RUN);
      expect(h.hardRuleLists).toHaveLength(reads + 1);
      expect(loopOf().touches?.paths).toEqual(["docs/new.md"]);
    });

    it("re-reads touches when fetching main introduces a matching hard rule", async () => {
      h.rules = async () => ({ ...DEFAULT_REPO_RULES, hardRulesSet: true, hardRules: [] });
      h.touches = ["docs/new.md"];
      await toReview();
      await h.engine.reconcileRun(RUN);
      expect(loopOf().touches?.paths).toEqual([]);
      const mainSha = need(h.gate).mainSha;
      const reads = h.hardRuleLists.length;
      const pinnedReads: (string | undefined)[] = [];
      h.duringGate = () => {
        h.rules = async (_repoId, sha) => {
          pinnedReads.push(sha);
          return { ...DEFAULT_REPO_RULES, hardRulesSet: true, hardRules: ["docs/**"] };
        };
      };
      reported(first().id, []);
      await h.engine.reconcileRun(RUN);
      expect(h.steps).not.toContain("merge");
      expect(pinnedReads).toContain(mainSha);
      expect(h.hardRuleLists.length).toBeGreaterThan(reads);
      expect(loopOf().touches?.paths).toEqual(["docs/new.md"]);
    });

    it("does not merge when fetching introduces a hard rule and the gate read fails", async () => {
      h.rules = async () => ({ ...DEFAULT_REPO_RULES, hardRulesSet: true, hardRules: [] });
      h.touches = ["docs/new.md"];
      await toReview();
      await h.engine.reconcileRun(RUN);
      expect(loopOf().touches?.paths).toEqual([]);
      expect(loopOf().gate).not.toBeNull();
      h.duringGate = () => {
        h.rules = async () => ({
          ...DEFAULT_REPO_RULES,
          hardRulesSet: true,
          hardRules: ["docs/**"],
        });
        h.gate = null;
      };
      reported(first().id, []);
      await h.engine.reconcileRun(RUN);
      expect(h.steps).not.toContain("merge");
      expect(loopOf().gate).toBeNull();
    });

    it("re-reads strays when the seat area changes for the same sha and main tip", async () => {
      await toReview();
      await h.engine.reconcileRun(RUN);
      expect(h.gateReads.at(-1)?.known).toBe(true);
      const seat = need(config.crew?.sessions.flatMap((s) => s.seats).find((s) => s.id === SEAT));
      seat.area = ["docs/**"];
      await h.engine.reconcileRun(RUN);
      expect(h.gateReads.at(-1)?.known).toBe(false);
    });

    it("discards cached strays if the new area cannot be read", async () => {
      await toReview();
      await h.engine.reconcileRun(RUN);
      const seat = need(config.crew?.sessions.flatMap((s) => s.seats).find((s) => s.id === SEAT));
      seat.area = ["docs/**"];
      h.gate = null;
      await h.engine.reconcileRun(RUN);
      expect(loopOf().gate).toBeNull();
      expect(h.steps).toEqual([]);
    });

    it.each(["close", "delete-remote"])(
      "retries transient %s failures past three ticks",
      async (step) => {
        const down = { ok: false, text: "gh is down", transient: true } as const;
        h.stepResults[step] = [down, down, down, down];
        await gateOpen();
        await vi.waitFor(() => expect(h.steps).toContain(step));
        for (let n = 0; n < 3; n++) {
          clock += ENGINE_TICK_MS;
          await h.engine.reconcileRun(RUN);
          expect(loopOf().parked).toBeNull();
        }
        clock += ENGINE_TICK_MS;
        await h.engine.reconcileRun(RUN);
        expect(loopOf().phase).toBe("done");
        expect(h.steps.filter((s) => s === "merge")).toHaveLength(1);
      },
    );

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
      expect(h.steps).toEqual(["ready", "merge", "close", "file-minor", "delete-remote"]);
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

    it("parks post-merge housekeeping on the tenth transient tick", async () => {
      const down = { ok: false, text: "gh is down", transient: true } as const;
      h.stepResults.close = Array.from({ length: 10 }, () => down);
      await gateOpen();
      await vi.waitFor(() => expect(h.steps).toContain("close"));
      for (let n = 2; n <= 10; n++) {
        clock += ENGINE_TICK_MS;
        await h.engine.reconcileRun(RUN);
        expect(h.steps.filter((s) => s === "close")).toHaveLength(n);
        if (n < 10) expect(loopOf().parked).toBeNull();
      }
      expect(loopOf().parked).toEqual({
        kind: "merge-step",
        reason: mergeStepFailedText("close the issue", "gh is down"),
        ended: false,
      });
      expect(h.steps).not.toContain("delete-remote");
    });

    it.each([
      [0, "ready"],
      [ENGINE_TICK_MS, "ready"],
      [0, "merge"],
      [ENGINE_TICK_MS, "merge"],
    ] as const)(
      "gives housekeeping ten fresh transient ticks after an operator merge delayed by %s ms following %s failures",
      async (delay, failedStep) => {
        const mergeDown = { ok: false, text: "gh is down", transient: true } as const;
        h.stepResults[failedStep] = [mergeDown, mergeDown];
        if (failedStep === "ready") setLoop({ merging: null });
        await gateOpen();
        await vi.waitFor(() =>
          expect(h.steps).toEqual(failedStep === "ready" ? ["ready"] : ["ready", "merge"]),
        );
        expect(loopOf().merging).toEqual(
          failedStep === "ready" ? null : { sha: SHA, done: ["ready"] },
        );
        clock += ENGINE_TICK_MS;
        await h.engine.reconcileRun(RUN);
        expect(loopOf().transient).toBe(2);
        clock += delay;
        const down = { ok: false, text: "gh is down", transient: true } as const;
        h.stepResults.close = Array.from({ length: 10 }, () => down);
        setPr({ state: "merged", isDraft: false, ci: "passing", mergedAt: clock });
        await h.engine.reconcileRun(RUN);
        expect(loopOf().merging).toEqual({
          sha: SHA,
          done: failedStep === "ready" ? ["merge"] : ["ready", "merge"],
        });
        expect(loopOf().transient).toBe(1);
        expect(loopOf().parked).toBeNull();
        for (let n = 2; n <= 10; n++) {
          clock += ENGINE_TICK_MS;
          await h.engine.reconcileRun(RUN);
          expect(h.steps.filter((s) => s === "close")).toHaveLength(n);
          if (n < 10) expect(loopOf().parked).toBeNull();
        }
        expect(loopOf().parked).toEqual({
          kind: "merge-step",
          reason: mergeStepFailedText("close the issue", "gh is down"),
          ended: false,
        });
        expect(h.steps.filter((s) => s === "merge")).toHaveLength(failedStep === "ready" ? 0 : 2);
        expect(h.steps).not.toContain("delete-remote");
      },
    );

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

    it.each(["MERGEABLE", "UNKNOWN"] as const)(
      "refreshes a stale %s PR after a merge conflict without counting refusals",
      async (mergeable) => {
        const refusal = { ok: false, text: MERGE_CONFLICTING, transient: true } as const;
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
      for (let n = 1; n < REFUSAL_TRIES; n++) {
        clock += ENGINE_TICK_MS;
        await h.engine.reconcileRun(RUN);
      }
      expect(loopOf().phase).toBe("parked");
      expect(loopOf().parked?.kind).toBe("merge-step");
      expect(loopTexts()).not.toContain(MERGE_WAITS_ON_MAIN);
    });

    it("leaves one Activity line while a merge waits on a conflict", async () => {
      h.stepResults.merge = Array(3).fill({ ok: false, text: MERGE_CONFLICTING, transient: true });
      await toReview();
      await h.engine.reconcileRun(RUN);
      setPr({ ci: "passing", mergeable: "MERGEABLE" });
      reported(first().id, []);
      await vi.waitFor(() => expect(h.steps).toEqual(["ready", "merge"]));
      clock += ENGINE_TICK_MS;
      await h.engine.reconcileRun(RUN);
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
      setLoop({
        merging: { sha: SHA, done: ["ready", "merge", "close", "file-minor", "delete-remote"] },
      });
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
    // Drain the review-start pass before reporting findings.
    await h.engine.reconcileRun(RUN);
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

  it.each(["review", "review-ruling"] as const)(
    "The operator's message after a %s park sends the findings back for rework",
    async (kind) => {
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
      setLoop({ parked: { kind, reason: "Blocked review", ended: false } });
      await h.engine.onOperatorMessage(RUN);
      expect(loopOf()).toMatchObject({ phase: "working", reviewWaivedSha: null });
      expect(store.notes().find((n) => n.key === `ready:${RUN}:${SHA}`)).toBeUndefined();
    },
  );

  it.each(["review", "review-ruling"] as const)(
    "The explicit accept action after a %s park waives its findings",
    async (kind) => {
      await toReview();
      reported(first().id, [finding("Critical")]);
      setLoop({ phase: "parked", parked: { kind, reason: "Blocked review", ended: false } });
      await h.engine.onOperatorMessage(RUN, "CAPCOM", { action: "accept" });
      expect(loopOf()).toMatchObject({ phase: "review", reviewWaivedSha: SHA });
    },
  );

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
      need(config.repos[0]).flightPowers = "superuser";
      await h.engine.onOperatorMessage(RUN, "FLIGHT", { kinds: ["review"], action: "accept" });
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

    it("waits for pause-deferred recovery before supervising a running review", async () => {
      await toReview();
      const runId = need(first().runId);
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const recovering = vi.fn(async () => {
        await gate;
        h.retroFacts = { inTurn: false, resumedAt: HUB + 1000, rateLimitedUntil: null };
      });
      h.resumeDeferred = recovering;
      const tick = h.engine.tick();
      try {
        await vi.waitFor(() => expect(recovering).toHaveBeenCalled());
        expect(sentKeys().filter((key) => key.startsWith("rv-resume:"))).toEqual([]);
      } finally {
        release();
        await tick;
      }
      expect(sentKeys().filter((key) => key.startsWith("rv-resume:"))).toEqual([
        `rv-resume:${runId}:${HUB}`,
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
      // Drain the review-start pass before changing the seat or findings.
      await h.engine.reconcileRun(RUN);
    }

    it("resumes a parked aside run while its seat holds another run, deferring the wake", async () => {
      await setAside();
      setLoop({
        phase: "parked",
        parked: { kind: "review", reason: "review findings", ended: false },
      });
      const other = "guido-1:other";
      store.upsertRun(run({ id: other, seq: 2 }));
      seatIdle(other);
      h.wakeError = new SupervisorError(409, "GUIDO-1 already has a run");
      await h.engine.onOperatorMessage(RUN);
      await h.engine.reconcileRun(RUN);
      expect(loopOf()).toMatchObject({
        phase: "working",
        parked: null,
        reviewWaivedSha: null,
        aside: { worktree: WT, wake: true },
      });
      expect(store.seatSession(SEAT)?.runId).toBe(other);
      expect(h.sent).toEqual([]);
      h.wakeError = null;
      h.asideOn = false;
      store.setRunEnded(other, clock, "ok", "operator");
      store.setSeatSession({ ...need(store.seatSession(SEAT)), runId: null });
      emit({ kind: "run-ended", seatId: SEAT, runId: other, endedBy: "operator" });
      await vi.waitFor(() => expect(loopOf().aside).toBeNull());
      expect(store.seatSession(SEAT)?.runId).toBe(RUN);
    });

    it("a controller check keeps the run aside, and a fail is recorded while the seat is busy", async () => {
      h.engine.stop();
      h.engine = h.make({
        fetchTicket: async () => ticketView("## Controller check\nOpen the page."),
      });
      h.engine.start();
      await setAside();
      reported(first().id, []);
      await vi.waitFor(() => expect(loopOf().parked?.kind).toBe(CONTROLLER_CHECK_PARK));
      // parked on the controller, the run stays off its seat: nothing wakes it
      expect(h.wakes).toEqual([]);
      expect(asideRun()).toEqual({ worktree: WT, wake: false });
      const other = "guido-1:other";
      store.upsertRun(run({ id: other, seq: 2 }));
      seatIdle(other);
      h.wakeError = new SupervisorError(409, "GUIDO-1 already has a run");
      expect(await h.engine.controllerCheck(RUN, "fail", SHA, "swatch 3 is unreadable")).toEqual({
        lifted: true,
      });
      expect(loopOf()).toMatchObject({ phase: "working", aside: { worktree: WT, wake: true } });
      expect(h.sent).toEqual([]);
      const note = store.comms(0, RUN).at(-1);
      expect(note?.text).toBe(controllerCheckFailText(SHA, "swatch 3 is unreadable"));
      h.wakeError = null;
      h.asideOn = false;
      store.setRunEnded(other, clock, "ok", "operator");
      store.setSeatSession({ ...need(store.seatSession(SEAT)), runId: null });
      emit({ kind: "run-ended", seatId: SEAT, runId: other, endedBy: "operator" });
      await vi.waitFor(() => expect(loopOf().aside).toBeNull());
      expect(store.seatSession(SEAT)?.runId).toBe(RUN);
      // the woken run is sent the note, once; the inbox does not repeat it
      const text = controllerCheckFailText(SHA, "swatch 3 is unreadable");
      await vi.waitFor(() => expect(h.sent.at(-1)?.text).toBe(text));
      await h.engine.reconcileRun(RUN);
      expect(h.sent.filter((m) => m.text === text)).toHaveLength(1);
      expect(loopOf().pendingLine ?? null).toBeNull();
      const noted = store.commsInbox(SEAT).filter((m) => m.text === text);
      expect(noted.every((m) => store.commsInboxRead(SEAT, m.id))).toBe(true);
    });

    it("stores rework before waking a free aside run, and leaves a failed write parked", async () => {
      await setAside();
      setLoop({
        phase: "parked",
        parked: { kind: "review", reason: "review findings", ended: false },
      });
      let storedWhileParked = false;
      expect(
        await operate(RUN, "CAPCOM", {
          kinds: ["review"],
          beforeLift: async () => {
            storedWhileParked = loopOf().phase === "parked";
            store.addComms({
              at: clock,
              from: "CAPCOM",
              to: SEAT,
              ticket: `${REPO}#7`,
              text: "Please rework this.",
              targetRunId: RUN,
            });
            return true;
          },
        }),
      ).toBe(true);
      expect(storedWhileParked).toBe(true);
      expect(loopOf().phase).toBe("working");
      expect(store.comms(0, RUN).map((message) => message.text)).toContain("Please rework this.");
      expect(h.wakes).toContain(RUN);

      setLoop({
        phase: "parked",
        parked: { kind: "review", reason: "review findings", ended: false },
      });
      expect(
        await operate(RUN, "CAPCOM", {
          kinds: ["review"],
          beforeLift: async () => false,
        }),
      ).toBe(false);
      expect(loopOf().phase).toBe("parked");
    });

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
      const failure = `could not resume: ${"x".repeat(1000)}`;
      h.wakeError = new SupervisorError(500, failure);
      reported(first().id, [finding("Important")]);
      await vi.waitFor(() => expect(loopTexts()).toContain(wakeFailedText(failure)));
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

    it("wakes a transferred run using destination quota", async () => {
      await setAside();
      config.accounts.push({ id: "destination", vendor: "claude", alertAt: 80, stopAt: 95 });
      store.setSetting(
        `account-transfer:${RUN}`,
        JSON.stringify({ source: "claude-main", target: "destination", pending: false }),
      );
      store.addUsage({
        accountId: "claude-main",
        window: "5h",
        at: clock,
        pct: 96,
        resetAt: clock + 60 * MIN,
        source: "test",
      });
      reported(first().id, [finding("Important")]);
      await vi.waitFor(() => expect(h.wakes).toEqual([RUN]));
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
