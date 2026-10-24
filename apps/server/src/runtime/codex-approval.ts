/** The same Codex approval path for supervisor runs and the controller's live check. */
import {
  type CrewMode,
  DEFAULT_SEAT_COMMANDS,
  GUARD_RULES,
  type GuardRule,
  isObj,
  LOCK_WAIT_MS,
  lockBusyText,
  type McToolName,
  seatCallSign,
} from "@mc/core";
import { type CcConfig, crewSeatGrants } from "../config.ts";
import { crewGuardDecision } from "../guard/decision.ts";
import type { TestLock } from "../guard/lock.ts";
import { codexApproval, codexCommandAllowed, codexEditAllowed } from "./codex-floor.ts";
import type { CodexSessionInput } from "./codex-session.ts";

export function createCodexApprover(i: {
  config: CcConfig;
  repoId: string;
  seatId: string;
  runId: string;
  mode: CrewMode;
  area: readonly string[];
  cwd: string;
  lock: TestLock;
  record: (rule: GuardRule, text: string) => void;
  superuserTools?: readonly McToolName[];
  seatGrants?: (seatId: string) => readonly string[];
}): CodexSessionInput["approve"] {
  return async (req, paths, signal) => {
    const refuse = (rule: GuardRule, text: string = GUARD_RULES[rule]): "decline" => {
      i.record(rule, text);
      return "decline";
    };
    // The driver also calls here with an already-aborted signal to audit forced refusals.
    if (signal.aborted) return refuse("codex-allowlist");
    const repo = i.config.repos.find((r) => r.id === i.repoId);
    const events = codexApproval(req, paths, { cwd: i.cwd });
    if (!repo || events === null) return refuse("codex-allowlist");
    const params = isObj(req.params) ? req.params : {};
    for (const event of events) {
      if (
        event.tool === "Bash" &&
        !codexCommandAllowed(
          event.input.command ?? "",
          i.mode,
          repo.commands ?? DEFAULT_SEAT_COMMANDS,
          typeof params.cwd === "string" ? params.cwd : "",
          i.cwd,
        )
      )
        return refuse("codex-allowlist");
      if (
        event.tool === "Edit" &&
        !codexEditAllowed(event.input.file_path ?? "", i.cwd, i.area, repo.protectedFiles ?? [])
      )
        return refuse("codex-allowlist");
    }
    for (const event of events) {
      const verdict = crewGuardDecision(
        i.config,
        i.repoId,
        i.mode,
        event,
        i.superuserTools,
        i.seatGrants?.(i.seatId) ?? crewSeatGrants(i.config, i.seatId),
      );
      if (verdict.kind === "deny") return refuse(verdict.rule, verdict.text);
      if (verdict.kind === "lock") {
        const id = params.approvalId ?? params.itemId;
        if (typeof id !== "string" && typeof id !== "number") return refuse("codex-allowlist");
        const key = { runId: i.runId, toolUseId: String(id) };
        const granted = await i.lock.acquire(key, i.seatId, verdict.command, LOCK_WAIT_MS, signal);
        if (!granted || signal.aborted) {
          if (granted) i.lock.release(key);
          const h = i.lock.state().holder;
          return refuse(
            "full-suite",
            lockBusyText(
              h === null ? "another seat" : seatCallSign(h.seatId),
              h?.command ?? "a full suite",
            ),
          );
        }
      }
    }
    return signal.aborted ? refuse("codex-allowlist") : "accept";
  };
}
