/** Repository floors shared by Claude hooks and Codex approval requests. */
import {
  FLIGHT_APPROVAL_RULES,
  type FlightShellContext,
  flightShellBreakerWrite,
  flightTicketWrites,
  GUARD_RULES,
  type GuardEvent,
  type GuardVerdict,
  globMatches,
  type RepoRules,
} from "@mc/core";
import type { ChangeBus } from "../bus.ts";
import { cleanText } from "../clean.ts";
import { findApproval, useApproval } from "../flight-approvals.ts";
import { realPathOrParent } from "../runtime/codex-floor.ts";
import type { Store } from "../store.ts";
import { runawayTrip } from "./runaway.ts";

export function flightShellContext(store: Store, runId: string, cwd?: string): FlightShellContext {
  const run = store.run(runId);
  const worktree =
    run?.loop?.aside?.worktree ??
    (run ? store.seatSession(run.agentId)?.worktree : undefined) ??
    undefined;
  return { cwd: cwd ?? worktree, worktree, resolvePath: realPathOrParent };
}

export async function flightFloor(i: {
  store: Store;
  bus: ChangeBus;
  repoId: string;
  runId: string;
  seatId: string;
  event: GuardEvent;
  verdict: GuardVerdict;
  now: number;
  cwd?: string;
  rules?: (repo: string) => Promise<RepoRules | Error>;
}): Promise<GuardVerdict> {
  let verdict = i.verdict;
  const command = i.event.tool === "Bash" ? i.event.input.command : undefined;
  if (verdict.kind === "allow" && command !== undefined) {
    const writes = flightTicketWrites(command);
    if (writes.issues.length > 0) {
      const rules = await i.rules?.(i.repoId);
      const held =
        rules === undefined || rules instanceof Error
          ? "the repo's rules could not be read"
          : writes.issues.some((number) =>
                i.store
                  .board(i.repoId)
                  .find((card) => card.issueNumber === number)
                  ?.labels.some((label) =>
                    rules.alwaysAsk.some((pattern) => globMatches(pattern, label, true)),
                  ),
              )
            ? "an always_ask ticket"
            : null;
      if (held !== null)
        verdict = {
          kind: "deny",
          rule: "repo-rules",
          text: `${GUARD_RULES["repo-rules"]}: ${held} is not edited from the shell`,
        };
    }
  }
  if (
    verdict.kind === "deny" &&
    (FLIGHT_APPROVAL_RULES as readonly string[]).includes(verdict.rule)
  ) {
    const scope = (command ?? i.event.input.file_path)?.trim();
    const rule = verdict.rule as (typeof FLIGHT_APPROVAL_RULES)[number];
    const approval = scope ? findApproval(i.store, rule, scope, i.now) : undefined;
    if (approval !== undefined) {
      useApproval(i.store, approval.id, i.now);
      i.store.addFlightDecision({
        at: i.now,
        kind: "approval",
        seatId: i.seatId,
        targetRunId: i.runId,
        ref: null,
        questionId: null,
        about: `${rule}: ${cleanText(scope ?? "", 300)}`,
        decision: "Used a controller's approval for this one call",
        basis: approval.reason,
      });
      i.bus.emit("flight");
      verdict = { kind: "allow" };
    }
  }
  if (
    verdict.kind === "allow" &&
    command !== undefined &&
    flightShellBreakerWrite(command, flightShellContext(i.store, i.runId, i.cwd))
  ) {
    const tripped = runawayTrip(i.store);
    if (tripped !== null)
      verdict = {
        kind: "deny",
        rule: "repo-rules",
        text: `${GUARD_RULES["repo-rules"]}: the runaway breaker is tripped (${tripped.reason}); FLIGHT's shell writes wait until the operator lifts it`,
      };
  }
  return verdict;
}
