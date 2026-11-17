/**
 * A seat at its account's usage stop with an unfinished ticket: the run stops, with the reason
 * written on its timeline, and the seat is free for the next ticket. The branch and PR stay.
 */
import { seatCallSign, seatDef } from "@mc/core";
import { runAccountId } from "../accounts/bindings.ts";
import { activeAway } from "../away.ts";
import type { CcConfig } from "../config.ts";
import type { Supervisor } from "../runtime/supervisor.ts";
import type { Store } from "../store.ts";
import { accountAtStop } from "./queue.ts";

export const accountStopReasonText = (call: string, account: string): string =>
  `stopped: ${call}'s account ${account} reached its usage limit`;

export interface ReleaseDeps {
  config: CcConfig;
  store: Store;
  supervisor: Pick<Supervisor, "endRunByEngine" | "seat" | "seatFacts">;
  enabled: boolean;
  now: () => number;
  log?: (line: string) => void;
}

/** Stops each idle seat's unfinished run when its account is at the stop. */
export async function releaseAtAccountStop(deps: ReleaseDeps): Promise<void> {
  if (!deps.enabled) return;
  const { config, store, supervisor, now } = deps;
  // away mode refuses new pick-ups, and the resume is one: the run stays on its seat and the
  // engine wakes it when the window resets
  const away = activeAway(store, now(), config.operator.timezone);
  if (away !== null && !away.may.pickUp) return;
  for (const session of config.crew?.sessions ?? []) {
    for (const seat of session.seats) {
      if (seatDef(seat).loop !== "build") continue;
      const row = supervisor.seat(seat.id);
      const run = row?.runId == null ? null : store.run(row.runId);
      // the run's own account: a completed transfer moves it off the seat's configured one
      const accountId = runAccountId(store, run?.id ?? null, seat.accountId);
      if (!accountAtStop(config, store, accountId, now())) continue;
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
      store.addLoopEvent(
        `${run.id}:account-stop`,
        run.id,
        accountStopReasonText(seatCallSign(seat.id), accountId),
        now(),
      );
      await supervisor.endRunByEngine(run.id);
      deps.log?.(`${seat.id}: ${run.ticket} stopped at its account's stop`);
    }
  }
}
