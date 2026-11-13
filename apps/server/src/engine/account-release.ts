/**
 * A seat at its account's usage stop with an unfinished ticket: the ticket is released, not the
 * seat's to hold. The run ends (its branch, PR and handoff stay), the reason is written on the
 * ticket, and a free seat in the same area on an account that can work resumes the ticket on the
 * same branch and PR in the same pass. With none free the ticket waits, owned by no seat, and
 * each later pass offers it again, so the wait clears when any account can work.
 */
import { NEW_LOOP, type RepoId, type RepoRules, seatCallSign, seatDef } from "@mc/core";
import { activeAway } from "../away.ts";
import { type CcConfig, type CrewSeatConfig, seatUnavailable } from "../config.ts";
import { pausedSeat } from "../crew-pause.ts";
import type { Supervisor } from "../runtime/supervisor.ts";
import { restartHold } from "../spend/waste.ts";
import type { Store } from "../store.ts";
import { accountAtStop, accountHoldsNewWork, maxOpenRunsOf, seatMayTake } from "./queue.ts";
import { RepoRulesError } from "./rules.ts";
import { seatFitsLabels } from "./stuck-prs.ts";

export const ACCOUNT_STOP_FREES_WHEN = "an account in the ticket's area is under its limit";
export const accountStopWaitText = (call: string, account: string): string =>
  `${call}'s account ${account} reached its usage limit`;

export interface ReleaseDeps {
  config: CcConfig;
  store: Store;
  supervisor: Pick<Supervisor, "startRun" | "endRunByEngine" | "seat" | "seatFacts">;
  rules: (repoId: RepoId) => Promise<RepoRules | RepoRulesError>;
  enabled: boolean;
  now: () => number;
  log?: (line: string) => void;
}

const refOf = (repoId: RepoId, issue: number) => `${repoId}#${issue}`;

/** Ends each idle seat's unfinished run when its account is at the stop, and records the ticket's wait. */
async function releaseStoppedRuns(deps: ReleaseDeps): Promise<void> {
  const { config, store, supervisor, now } = deps;
  // away mode refuses new pick-ups, and the resume is one: the run stays on its seat and the
  // engine wakes it when the window resets
  const away = activeAway(store, now(), config.operator.timezone);
  if (away !== null && !away.may.pickUp) return;
  for (const session of config.crew?.sessions ?? []) {
    for (const seat of session.seats) {
      if (seatDef(seat).loop !== "build" || !accountAtStop(config, store, seat.accountId, now()))
        continue;
      const row = supervisor.seat(seat.id);
      const run = row?.runId == null ? null : store.run(row.runId);
      const loop = run?.loop;
      const facts = supervisor.seatFacts(seat.id);
      // a turn under way finishes; the seat is released once it sits idle (or parked by the
      // CLI's own rate limit) and cannot be woken
      const sitting =
        row?.state === "idle" ||
        (row?.state === "parked" && (facts?.rateLimitedUntil ?? null) !== null);
      if (
        run == null ||
        run.endedAt !== null ||
        !sitting ||
        facts?.inTurn === true ||
        run.ticket == null ||
        run.branch === null ||
        run.reviewId != null ||
        loop == null ||
        loop.phase === "done" ||
        loop.phase === "parked"
      )
        continue;
      const issue = Number(run.ticket.slice(run.ticket.lastIndexOf("#") + 1));
      store.setTicketWait({
        repoId: run.repoId,
        issue,
        reason: accountStopWaitText(seatCallSign(seat.id), seat.accountId),
        freesWhen: ACCOUNT_STOP_FREES_WHEN,
        at: now(),
      });
      await supervisor.endRunByEngine(run.id);
      deps.log?.(`${seat.id}: ${run.ticket} released at its account's stop`);
    }
  }
}

/** The free build seats of the repo whose area covers the ticket and whose account can work. */
function resumers(
  deps: ReleaseDeps,
  repoId: RepoId,
  rules: RepoRules | null,
  labels: string[],
): CrewSeatConfig[] {
  const { config, store, now } = deps;
  const out: CrewSeatConfig[] = [];
  for (const session of config.crew?.sessions ?? []) {
    if (session.repoId !== repoId) continue;
    for (const seat of session.seats) {
      if (seat.retiring || seatUnavailable(seat) || seatDef(seat).loop !== "build") continue;
      if (pausedSeat(store, seat.id, null) || restartHold(store, seat.id) !== null) continue;
      if (!seatMayTake(store, seat.id, maxOpenRunsOf(config))) continue;
      if (accountHoldsNewWork(config, store, seat.accountId, now())) continue;
      if (!seatFitsLabels(rules, seat.area, { labels })) continue;
      out.push(seat);
    }
  }
  return out;
}

/**
 * Each cycle: releases runs stuck at an account's stop, then offers every waiting ticket to a free
 * seat. A ticket that is closed, or already has a run, has its wait dropped.
 */
export async function releaseAtAccountStop(deps: ReleaseDeps): Promise<void> {
  if (!deps.enabled) return;
  const { config, store, supervisor } = deps;
  await releaseStoppedRuns(deps);
  const away = activeAway(store, deps.now(), config.operator.timezone);
  if (away !== null && !away.may.pickUp) return;
  for (const session of config.crew?.sessions ?? []) {
    const repoId = session.repoId;
    const rules = await deps.rules(repoId);
    if (rules instanceof RepoRulesError) continue;
    for (const wait of store.ticketWaits(repoId)) {
      const ref = refOf(repoId, wait.issue);
      const card = store.board(repoId).find((c) => c.issueNumber === wait.issue);
      if (card === undefined || card.closed || store.activeTickets().has(ref)) {
        store.clearTicketWait(repoId, wait.issue);
        continue;
      }
      for (const seat of resumers(deps, repoId, rules, card.labels)) {
        try {
          await supervisor.startRun(seat.id, wait.issue, { loop: NEW_LOOP });
        } catch (e) {
          deps.log?.(
            `${ref}: ${seat.id} could not resume it: ${e instanceof Error ? e.message : String(e)}`,
          );
          continue;
        }
        store.clearTicketWait(repoId, wait.issue);
        deps.log?.(`${ref}: ${seat.id} resumed it after ${wait.reason}`);
        break;
      }
    }
  }
}
