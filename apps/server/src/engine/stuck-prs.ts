/**
 * Stuck PRs: an open crew PR that conflicts with main, or has red CI, with no run on it. It is
 * found from the stored PRs and runs with no model tokens, on the engine's tick. A conflict that
 * merges cleanly is settled by the hub (main merged into the branch, pushed as a seat's `mc push`
 * does); anything else goes to a free seat in the ticket's area before any Ready ticket starts.
 * FLIGHT hears of a stuck PR only when no seat can take it.
 */

import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  areaLabelsFor,
  areaLabelsOf,
  type BoardItem,
  COMMS_MC,
  eligibleToStart,
  FLIGHT_STUCK_PR_MS,
  FLIGHT_WAITS_SETTING,
  type FlightPrFlow,
  NEW_LOOP,
  type RepoId,
  type RepoRules,
  seatCallSign,
  seatDef,
  WAITING_OPERATOR_LABEL,
} from "@mc/core";
import { holds } from "../attention/holds-read.ts";
import { activeAway } from "../away.ts";
import { type CcConfig, type CrewSeatConfig, seatUnavailable } from "../config.ts";
import { pausedSeat } from "../crew-pause.ts";
import { waitReader } from "../dependencies.ts";
import { MACHINE_CAPACITY_DEFAULTS, storedMachineCapacity } from "../machine-capacity.ts";
import { prFlow } from "../pr/flow.ts";
import { CREW_GIT_SLOW_MS, gitIdentity, MC_MERGE_AUTHOR } from "../runtime/checkouts.ts";
import { crewGit } from "../runtime/git.ts";
import { originHeads } from "../runtime/origin-heads.ts";
import type { Supervisor } from "../runtime/supervisor.ts";
import { restartHold, ticketParked } from "../spend/waste.ts";
import type { Store } from "../store.ts";
import { mergeTree, yes } from "./hub-merges.ts";
import { accountHoldsNewWork, maxOpenRunsOf, seatMayTake } from "./queue.ts";
import { RepoRulesError } from "./rules.ts";

/** The setting that keeps when each stuck state was first seen, so the 30 minutes survive a restart. */
export const STUCK_PRS_SETTING = "stuck-prs";
/** The operator's two-attempt rule: a PR that has failed this many reviews is not taken again by the hub. */
export const STUCK_PR_MAX_FAILED_REVIEWS = 2;
/** After a start the supervisor refused, a PR is not offered again for this long. */
export const STUCK_PR_RETRY_MS = 10 * 60_000;

export type StuckKind = "conflict" | "ci";

export interface StuckPr {
  repoId: RepoId;
  number: number;
  /** `repo#n`. */
  ticket: string;
  issue: number;
  branch: string;
  headSha: string;
  kind: StuckKind;
  /** The red checks, for `ci`. */
  failing: string[];
  /** When the PR was last owned by anyone, or first seen stuck on this head, whichever is later. */
  since: number;
}

const stuckKey = (repoId: string, pr: number, sha: string, kind: StuckKind): string =>
  `${repoId}#${pr}:${sha}:${kind}`;

const readSeen = (store: Store): Record<string, number> => {
  try {
    const v = JSON.parse(store.getSetting(STUCK_PRS_SETTING) || "{}") as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number"),
    );
  } catch {
    return {};
  }
};

/** Whether the hub takes work for this repo's PRs (only a `merge` repo with a build seat). */
export const stuckPrRepo = (config: CcConfig, repoId: RepoId): boolean =>
  config.repos.find((r) => r.id === repoId)?.autonomy === "merge" &&
  (config.crew?.sessions ?? []).some(
    (s) => s.repoId === repoId && s.seats.some((x) => seatDef(x).loop === "build"),
  );

/** The FLIGHT wait on any name this PR or its ticket goes by, if one is still running. */
function flightWaitsOn(store: Store, targets: string[], now: number): boolean {
  let waits: Record<string, { until?: number }> = {};
  try {
    waits = JSON.parse(store.getSetting(FLIGHT_WAITS_SETTING) || "{}");
  } catch {
    return false;
  }
  return targets.some((t) => (waits[t]?.until ?? 0) > now);
}

/**
 * The open crew PRs that are stuck now, whatever the wait: conflicting with main, or with red CI,
 * with no run working on them and nobody holding them. `since` says how long.
 */
export function stuckPrs(i: {
  store: Store;
  config: CcConfig;
  repoId: RepoId;
  flow: Pick<FlightPrFlow, "rows">;
  now: number;
}): StuckPr[] {
  const { store, repoId, flow, now } = i;
  if (!stuckPrRepo(i.config, repoId)) return [];
  const seen = readSeen(store);
  const open = store.openPullRequests(repoId);
  const board = store.board(repoId);
  const ticketHolds = new Set(store.activeHolds().map((h) => h.ref));
  const attentionHolds = Object.entries(holds(store)).filter(([, h]) => h.releasedAt === undefined);
  const out: StuckPr[] = [];
  for (const pr of open) {
    const kind: StuckKind | null =
      pr.mergeable === "CONFLICTING" ? "conflict" : pr.ci === "failing" ? "ci" : null;
    if (kind === null || pr.headSha === null || pr.ticket === null) continue;
    const issue = Number(pr.ticket.slice(repoId.length + 1));
    if (!Number.isInteger(issue)) continue;
    // a crew PR is one a run of this hub made; a stacked PR waits on the one under it
    if (!store.hasRunOnBranch(repoId, pr.branch)) continue;
    if (open.some((o) => o.number !== pr.number && o.branch === pr.base)) continue;
    const row = flow.rows.find((r) => r.pr === pr.number);
    if (row === undefined || row.ownerKind !== "nobody") continue;
    const runs = store.runsOnTicket(repoId, pr.ticket);
    if (runs.some((r) => r.endedAt === null)) continue;
    // a merge hold from the operator or FLIGHT outlives the run that made it
    const latest = [...runs].sort((a, b) => b.startedAt - a.startedAt)[0];
    if (latest?.loop?.mergeHold) continue;
    // two failed reviews, or a run FLIGHT ended: the call is FLIGHT's, however long its wait ran
    if (
      store
        .reviewsOfPr(repoId, pr.number)
        .filter((r) => r.state === "reported" && (r.blocking ?? 0) > 0).length >=
      STUCK_PR_MAX_FAILED_REVIEWS
    )
      continue;
    if (
      store
        .flightDecisionsOnTicket(
          pr.ticket,
          runs.map((r) => r.id),
          50,
        )
        .some((d) => d.kind === "end")
    )
      continue;
    if (ticketHolds.has(pr.ticket)) continue;
    if (attentionHolds.some(([key]) => key.startsWith(`pr:${repoId}#${pr.number}:`))) continue;
    if (
      flightWaitsOn(
        store,
        [
          pr.ticket,
          `${repoId}#${pr.number}`,
          `PR ${pr.number}`,
          `PR #${pr.number}`,
          `#${pr.number}`,
        ],
        now,
      )
    )
      continue;
    const card = board.find((c) => c.issueNumber === issue);
    if (card === undefined || card.closed || card.labels.includes(WAITING_OPERATOR_LABEL)) continue;
    if (ticketParked(store, pr.ticket) !== null) continue;
    out.push({
      repoId,
      number: pr.number,
      ticket: pr.ticket,
      issue,
      branch: pr.branch,
      headSha: pr.headSha,
      kind,
      failing: (pr.checks ?? []).filter((c) => c.state === "failing").map((c) => c.name),
      since: Math.max(
        seen[stuckKey(repoId, pr.number, pr.headSha, kind)] ?? now,
        row.ownerSince ?? 0,
      ),
    });
  }
  return out.sort((a, b) => a.since - b.since || a.number - b.number);
}

/** The stuck PRs that have stood the 30 minutes. */
export const dueStuckPrs = (all: readonly StuckPr[], now: number): StuckPr[] =>
  all.filter((p) => now - p.since >= FLIGHT_STUCK_PR_MS);

/**
 * Keeps when each stuck state was first seen (the engine calls it on each tick), and drops the
 * ones that are no longer stuck. Reads of the state never write.
 */
export function trackStuckPrs(store: Store, config: CcConfig, now: number): void {
  const before = readSeen(store);
  const after: Record<string, number> = {};
  for (const session of config.crew?.sessions ?? []) {
    if (!stuckPrRepo(config, session.repoId)) continue;
    const flow = prFlow(store, session.repoId, now);
    for (const p of stuckPrs({ store, config, repoId: session.repoId, flow, now })) {
      const key = stuckKey(p.repoId, p.number, p.headSha, p.kind);
      after[key] = before[key] ?? now;
    }
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  store.setSetting(STUCK_PRS_SETTING, Object.keys(after).length === 0 ? "" : JSON.stringify(after));
}

/** Whether a seat with this area may take a ticket with these labels: its one area label is the seat's. */
export function seatFitsLabels(
  rules: Pick<RepoRules, "areas"> | null,
  seatArea: string[],
  card: Pick<BoardItem, "labels">,
): boolean {
  if (rules === null || Object.keys(rules.areas).length === 0) return true;
  const label = areaLabelsOf(rules, card);
  return label.length === 1 && areaLabelsFor(rules, seatArea).includes(label[0] ?? "");
}

export const conflictLineText = (pr: number): string =>
  `PR #${pr} conflicts with main and the conflict does not merge cleanly. Merge main into your branch, resolve it, run the checks and push.`;
export const ciLineText = (pr: number, failing: readonly string[]): string =>
  `PR #${pr} has red CI${failing.length > 0 ? `: ${failing.join(", ")}` : ""}. Fix it, run the checks and push.`;
export const stuckLineText = (p: StuckPr): string =>
  p.kind === "conflict" ? conflictLineText(p.number) : ciLineText(p.number, p.failing);
export const stuckLineKey = (p: StuckPr): string => `stuck-pr:${p.repoId}#${p.number}:${p.headSha}`;

type Git = typeof crewGit;

export interface StuckDeps {
  config: CcConfig;
  store: Store;
  supervisor: Pick<Supervisor, "startRun">;
  /** The hub's own `gh` login; null when it could not be read, and then nothing is taken. */
  login: string | null;
  rules: (repoId: RepoId) => Promise<RepoRules | RepoRulesError>;
  /** Runs `fn` while holding the clone, as the supervisor does for the engine's git work. */
  inClone: <T>(checkout: string, fn: () => Promise<T>) => Promise<T>;
  /** Git in the clone (default `crewGit`); tests fake it. */
  git?: Git;
  enabled: boolean;
  now: () => number;
  log?: (line: string) => void;
}

/** When a refused PR may be offered again; one map for the hub's life. */
const retryAt = new WeakMap<Store, Map<string, number>>();

/** The result of the hub's own attempt to merge main into a conflicting PR's branch. */
export type SettleResult = "merged" | "conflict" | "moved";

/**
 * Merges main into a PR's branch without a model: a clean merge becomes a `Merge main into
 * <branch>` commit by the hub's merge author, pushed plain (never forced) as `mc push` does.
 * `conflict`: a real conflict, for a seat. `moved`: the branch or main is not what the poll saw,
 * or main is already in; nothing was pushed.
 */
export async function settleCleanConflict(
  deps: Pick<StuckDeps, "config" | "inClone" | "git">,
  pr: Pick<StuckPr, "repoId" | "branch" | "headSha">,
): Promise<SettleResult> {
  const session = deps.config.crew?.sessions.find((s) => s.repoId === pr.repoId);
  if (session === undefined) return "moved";
  const git = deps.git ?? crewGit;
  const checkout = session.checkout;
  return deps.inClone(checkout, async () => {
    const common = await realpath(join(checkout, ".git"));
    const g = (args: string[], env?: NodeJS.ProcessEnv): Promise<string> =>
      git(checkout, args, common, { gitDir: common, timeoutMs: CREW_GIT_SLOW_MS, env });
    const heads = originHeads(
      await g(["ls-remote", "--symref", "origin", "HEAD", `refs/heads/${pr.branch}`]),
      pr.branch,
    );
    if (heads.branchSha !== pr.headSha || pr.branch === heads.defaultBranch) return "moved";
    await g([
      "fetch",
      "--no-tags",
      "origin",
      `refs/heads/${heads.defaultBranch}`,
      `refs/heads/${pr.branch}`,
    ]);
    if (await yes(g, ["merge-base", "--is-ancestor", heads.defaultSha, pr.headSha])) return "moved";
    const tree = await mergeTree(g, [pr.headSha, heads.defaultSha]);
    if (tree === null) return "conflict";
    const commit = (
      await g(
        [
          "commit-tree",
          tree,
          "-p",
          pr.headSha,
          "-p",
          heads.defaultSha,
          "-m",
          `Merge main into ${pr.branch}`,
        ],
        gitIdentity(MC_MERGE_AUTHOR),
      )
    ).trim();
    try {
      await g([
        "push",
        "--porcelain",
        "--no-follow-tags",
        "--no-recurse-submodules",
        "origin",
        `${commit}:refs/heads/${pr.branch}`,
      ]);
    } catch (e) {
      const out = (e as { stdout?: unknown } | null)?.stdout;
      if (typeof out === "string" && /^!\t[^\t]*\t\[rejected\]/m.test(out)) return "moved";
      throw e;
    }
    return "merged";
  });
}

/** The free build seats of the repo that may take this ticket now, in config order. */
function freeSeats(
  deps: StuckDeps,
  repoId: RepoId,
  rules: RepoRules,
  card: BoardItem,
): CrewSeatConfig[] {
  const { config, store } = deps;
  const out: CrewSeatConfig[] = [];
  for (const session of config.crew?.sessions ?? []) {
    if (session.repoId !== repoId) continue;
    for (const seat of session.seats) {
      if (seat.retiring || seatUnavailable(seat) || seatDef(seat).loop !== "build") continue;
      if (pausedSeat(store, seat.id, null) || restartHold(store, seat.id) !== null) continue;
      if (!seatMayTake(store, seat.id, maxOpenRunsOf(config))) continue;
      if (accountHoldsNewWork(config, store, seat.accountId, deps.now())) continue;
      if (!seatFitsLabels(rules, seat.area, card)) continue;
      out.push(seat);
    }
  }
  return out;
}

/**
 * The engine's step before it deals Ready tickets: each stuck PR (oldest first) that has stood
 * 30 minutes is merged by the hub when its conflict is clean, else started on a free seat in its
 * area. A PR no seat is free for waits for the next tick.
 */
export async function takeStuckPrs(deps: StuckDeps): Promise<void> {
  const { config, store, now } = deps;
  if (!deps.enabled || deps.login === null) return;
  // a conflict the hub settles costs no seat; only the starts wait on the machine and the operator
  const at = now();
  trackStuckPrs(store, config, at);
  const retries = retryAt.get(store) ?? new Map<string, number>();
  retryAt.set(store, retries);
  for (const session of config.crew?.sessions ?? []) {
    const repoId = session.repoId;
    if (!stuckPrRepo(config, repoId)) continue;
    const due = dueStuckPrs(
      stuckPrs({ store, config, repoId, flow: prFlow(store, repoId, at), now: at }),
      at,
    );
    if (due.length === 0) continue;
    const rules = await deps.rules(repoId);
    if (rules instanceof RepoRulesError) continue;
    for (const pr of due) {
      const key = stuckKey(pr.repoId, pr.number, pr.headSha, pr.kind);
      if ((retries.get(key) ?? 0) > now()) continue;
      if (pr.kind === "conflict") {
        try {
          const settled = await settleCleanConflict(deps, pr);
          if (settled === "merged") {
            deps.log?.(`stuck PR #${pr.number} (${pr.ticket}): merged main into ${pr.branch}`);
            continue;
          }
          if (settled === "moved") continue;
        } catch (e) {
          deps.log?.(
            `stuck PR #${pr.number} (${pr.ticket}): could not merge main: ${e instanceof Error ? e.message : String(e)}`,
          );
          retries.set(key, now() + STUCK_PR_RETRY_MS);
          continue;
        }
      }
      if (!(await startOnStuckPr(deps, rules, pr))) retries.set(key, now() + STUCK_PR_RETRY_MS);
    }
  }
}

/** Starts a free seat on the stuck PR's ticket; false when none was started. */
async function startOnStuckPr(deps: StuckDeps, rules: RepoRules, pr: StuckPr): Promise<boolean> {
  const { config, store } = deps;
  const capacity = storedMachineCapacity(
    store,
    deps.now(),
    config.crew?.machineCapacity ?? MACHINE_CAPACITY_DEFAULTS,
  );
  if (capacity.blocked) return true;
  // a stuck PR waits for the operator's return: FLIGHT works the board while they are away
  if (activeAway(store, deps.now(), config.operator.timezone)) return true;
  const card = store.board(pr.repoId).find((c) => c.issueNumber === pr.issue);
  if (card === undefined) return true;
  const board = store.board(pr.repoId);
  const waitsOf = waitReader(store, pr.repoId);
  for (const seat of freeSeats(deps, pr.repoId, rules, card)) {
    const refusal = eligibleToStart({
      repoId: pr.repoId,
      issue: pr.issue,
      card,
      rules,
      seat: { call: seatCallSign(seat.id), area: seat.area, loop: seatDef(seat).loop },
      login: deps.login,
      hasRun: store.activeTickets().has(pr.ticket),
      lane: config.crew?.lane,
      laneDefault: config.crew?.laneDefault ?? false,
      body: null,
      closed: (n) => board.find((b) => b.issueNumber === n)?.closed,
      waits: waitsOf(card),
    });
    if (refusal !== null) continue;
    const text = stuckLineText(pr);
    try {
      await deps.supervisor.startRun(seat.id, pr.issue, {
        loop: { ...NEW_LOOP, pendingLine: { key: stuckLineKey(pr), text } },
      });
    } catch (e) {
      deps.log?.(
        `stuck PR #${pr.number} (${pr.ticket}): ${seat.id} could not take it: ${e instanceof Error ? e.message : String(e)}`,
      );
      return false;
    }
    store.addComms({
      at: deps.now(),
      from: COMMS_MC,
      senderKind: "hub",
      to: seat.id,
      ticket: pr.ticket,
      text,
    });
    deps.log?.(`stuck PR #${pr.number} (${pr.ticket}): ${seat.id} took it (${pr.kind})`);
    return true;
  }
  return true;
}

/** Whether the PR is a stuck one a seat of this area would take: the signals' reading, from board cards. */
export function prFitsSeat(
  rules: Pick<RepoRules, "areas"> | null,
  seatArea: string[],
  board: readonly Pick<BoardItem, "issueNumber" | "labels">[],
  pr: Pick<StuckPr, "issue">,
): boolean {
  const card = board.find((c) => c.issueNumber === pr.issue);
  return card !== undefined && seatFitsLabels(rules, seatArea, card);
}
