/** The same Codex approval path for supervisor runs and the controller's live check. */
import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import {
  type CrewMode,
  codexCommand,
  GUARD_RULES,
  type GuardEvent,
  type GuardRule,
  type GuardVerdict,
  isObj,
  LOCK_WAIT_MS,
  lockBusyText,
  MC_MCP_SERVER,
  MC_TOOL_GRANTS,
  MC_TOOL_NAMES,
  type McToolName,
  mcTool,
  seatCallSign,
} from "@mc/core";
import { type CcConfig, crewSeatGrants } from "../config.ts";
import { type CheckRecorder, testCommand } from "../guard/check-runs.ts";
import { crewGuardDecision } from "../guard/decision.ts";
import type { TestLock } from "../guard/lock.ts";
import { codexApproval, codexEditAllowed } from "./codex-floor.ts";
import { CODEX_MCP_ELICITATION, type CodexSessionInput } from "./codex-session.ts";

const REFUSAL_DETAIL_MAX = 200;

/** Whether `a` and `b` are the same folder once symlinks are resolved. */
function sameDir(a: unknown, b: string): boolean {
  if (typeof a !== "string") return false;
  try {
    return realpathSync.native(a) === realpathSync.native(b);
  } catch {
    return false;
  }
}

/** Whether `path` is the checkout itself or a directory below it once symlinks are resolved. */
function withinDir(path: unknown, root: string): boolean {
  if (typeof path !== "string") return false;
  try {
    const child = realpathSync.native(path);
    const parent = realpathSync.native(root);
    const fromRoot = relative(parent, child);
    return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
  } catch {
    return false;
  }
}

/**
 * Codex's request to run a command outside the seat's sandbox. On codex-cli 0.154.0 the command
 * approval params (`codex app-server generate-ts`: `CommandExecutionRequestApprovalParams`) carry
 * no sandbox or escalation field. Probed through app-server with a local fake model
 * (docs/spikes/2026-10-24-codex-seat-confinement.md, "Escalation probe"): an ordinary command's
 * approval has no `reason`; a model call with `sandbox_permissions: "require_escalated"` arrives as
 * an otherwise identical first approval whose `reason` is the model's own free-text justification;
 * and the binary holds a sandbox-retry prompt, "command failed; retry without sandbox?", for a
 * further approval of the same item (the probe's denied commands never raised one). The only other
 * source of a reason is an execpolicy prompt rule ("`…` requires
 * approval by policy"), and a seat's CODEX_HOME has no rules. So the hub refuses any command
 * approval that carries a reason, and any second command approval for an item (or zsh-exec-bridge
 * callback) it was already asked about.
 */
const CODEX_COMMAND_APPROVAL = "item/commandExecution/requestApproval";
export const CODEX_ESCALATION_TEXT = "Codex asked to run a command outside the seat's sandbox";

export function createCodexApprover(i: {
  config: CcConfig;
  repoId: string;
  seatId: string;
  runId: string;
  mode: CrewMode;
  fullAccess?: boolean;
  floor?: (event: GuardEvent, verdict: GuardVerdict, cwd?: string) => Promise<GuardVerdict>;
  area: readonly string[];
  /** Files outside the area that FLIGHT approved for this run alone. */
  granted?: readonly string[];
  cwd: string;
  lock: TestLock;
  record: (rule: GuardRule, text: string) => void;
  superuserTools?: readonly McToolName[];
  seatGrants?: (seatId: string) => readonly string[];
  runGrants?: () => readonly string[];
  /** Notes the clone a shell command starts on, for the push gate's check record. */
  checks?: CheckRecorder;
}): CodexSessionInput["approve"] {
  // Command approvals (approvalId, else itemId) this approver was asked about: a second request
  // for one is a sandbox retry.
  const commandItems = new Set<string>();
  return async (req, paths, signal) => {
    const params = isObj(req.params) ? req.params : {};
    const detail =
      typeof params.command === "string"
        ? (codexCommand(params.command, null) ?? params.command)
        : (paths?.join(", ") ??
          (req.mcpCall ? `${req.mcpCall.server} ${req.mcpCall.tool}` : req.method));
    const excerpt = [...detail]
      .filter((c) => c.charCodeAt(0) >= 32 && (c.charCodeAt(0) < 127 || c.charCodeAt(0) > 159))
      .join("")
      .slice(0, REFUSAL_DETAIL_MAX);
    const refuse = (rule: GuardRule, text: string = GUARD_RULES[rule]): "decline" => {
      i.record(rule, `${text}: ${excerpt}`);
      return "decline";
    };
    // The driver also calls here with an already-aborted signal to audit forced refusals.
    if (signal.aborted) return refuse("codex-allowlist");
    if (req.method === CODEX_COMMAND_APPROVAL) {
      // zsh-exec-bridge callbacks share one itemId and differ by approvalId (the generated
      // CommandExecutionRequestApprovalParams); the seat config also pins shell_zsh_fork off
      const key = params.approvalId ?? params.itemId;
      const item = typeof key === "string" ? key : null;
      const again = item !== null && commandItems.has(item);
      if (item !== null) commandItems.add(item);
      if (!i.fullAccess && (again || params.reason != null))
        return refuse("codex-allowlist", CODEX_ESCALATION_TEXT);
    }
    const repo = i.config.repos.find((r) => r.id === i.repoId);
    const seatGrants =
      i.runGrants?.() ?? i.seatGrants?.(i.seatId) ?? crewSeatGrants(i.config, i.seatId);
    if (req.method === CODEX_MCP_ELICITATION) {
      const call = req.mcpCall;
      const grants = MC_TOOL_GRANTS[i.mode];
      const schema = params.requestedSchema;
      // The CLI's tool approval is an empty form. Never invent answers for server forms.
      if (
        !repo ||
        call?.server !== MC_MCP_SERVER ||
        params.serverName !== MC_MCP_SERVER ||
        params.mode !== "form" ||
        !isObj(schema) ||
        schema.type !== "object" ||
        !isObj(schema.properties) ||
        Object.keys(schema.properties).length !== 0 ||
        (schema.required != null &&
          (!Array.isArray(schema.required) || schema.required.length !== 0)) ||
        !(
          i.fullAccess ||
          grants.base.some((tool) => tool === call.tool) ||
          (grants.grantable.some((tool) => tool === call.tool) && seatGrants.includes(call.tool)) ||
          (i.runGrants !== undefined &&
            call.tool === MC_TOOL_NAMES.reportPlan &&
            seatGrants.includes(call.tool))
        )
      )
        return refuse("codex-allowlist");
      const verdict = crewGuardDecision(
        i.config,
        i.repoId,
        i.mode,
        { tool: mcTool(call.tool as McToolName), input: {} },
        i.superuserTools,
        seatGrants,
        i.cwd,
        undefined,
        i.fullAccess,
      );
      return verdict.kind === "deny" ? refuse(verdict.rule, verdict.text) : "accept";
    }
    const events: GuardEvent[] | null = i.fullAccess
      ? req.method === "item/fileChange/requestApproval" && paths?.length
        ? paths.map((file_path) => ({ tool: "Edit", input: { file_path } }))
        : req.method === CODEX_COMMAND_APPROVAL &&
            typeof params.command === "string" &&
            typeof params.cwd === "string"
          ? [
              {
                tool: "Bash",
                input: { command: codexCommand(params.command, null) ?? params.command },
              },
            ]
          : null
      : codexApproval(req, paths, { cwd: i.cwd });
    if (!repo || events === null) return refuse("codex-allowlist");
    let admitted: { runId: string; toolUseId: string } | undefined;
    for (const event of events) {
      if (
        !i.fullAccess &&
        event.tool === "Edit" &&
        !codexEditAllowed(
          event.input.file_path ?? "",
          i.cwd,
          i.area,
          repo.protectedFiles ?? [],
          i.granted,
        )
      )
        return refuse("codex-allowlist");
    }
    for (const event of events) {
      let verdict = crewGuardDecision(
        i.config,
        i.repoId,
        i.mode,
        event,
        i.superuserTools,
        seatGrants,
        i.cwd,
        typeof params.cwd === "string" ? params.cwd : undefined,
        i.fullAccess,
      );
      if (i.fullAccess && i.floor)
        verdict = await i.floor(
          event,
          verdict,
          typeof params.cwd === "string" ? params.cwd : undefined,
        );
      // a configured check (lint, typecheck) is as heavy as the suite: it takes the lock too
      if (verdict.kind === "allow" && event.tool === "Bash" && event.input.command !== undefined) {
        const inCheckout = withinDir(params.cwd, i.cwd);
        const tracked =
          inCheckout &&
          i.checks !== undefined &&
          (testCommand(event.input.command) ||
            (await i.checks.lockedBy(i.runId, event.input.command)) !== null);
        if (tracked) {
          const id = params.approvalId ?? params.itemId;
          if (typeof id !== "string" && typeof id !== "number") return refuse("codex-allowlist");
          const key = { runId: i.runId, toolUseId: String(id) };
          const running = i.checks?.admit
            ? await i.checks.admit(key, event.input.command)
            : await i.checks?.running?.(i.runId, event.input.command);
          admitted = i.checks?.admit !== undefined && running === null ? key : undefined;
          if (running !== null && running !== undefined)
            verdict = {
              kind: "deny",
              rule: "full-suite",
              text: `A check is already running in this checkout: ${running}. Wait for it to finish.`,
            };
        }
      }
      if (verdict.kind === "allow" && event.tool === "Bash" && event.input.command !== undefined) {
        const check = await i.checks?.lockedBy(i.runId, event.input.command);
        if (check) verdict = { kind: "lock", command: check };
      }
      if (verdict.kind === "deny") {
        if (admitted !== undefined) i.checks?.cancel?.(admitted);
        return refuse(verdict.rule, verdict.text);
      }
      // the same check on the same commit with nothing changed is not run again (waste alarm)
      if (verdict.kind === "lock" && event.tool === "Bash" && event.input.command !== undefined) {
        const rerun = await i.checks?.rerun?.(i.runId, event.input.command);
        if (rerun) {
          if (admitted !== undefined) i.checks?.cancel?.(admitted);
          return refuse("full-suite", rerun);
        }
      }
      if (verdict.kind === "lock") {
        const id = params.approvalId ?? params.itemId;
        if (typeof id !== "string" && typeof id !== "number") return refuse("codex-allowlist");
        const key = { runId: i.runId, toolUseId: String(id) };
        const granted = await i.lock.acquire(key, i.seatId, verdict.command, LOCK_WAIT_MS, signal);
        if (!granted || signal.aborted) {
          if (granted) i.lock.release(key);
          if (admitted !== undefined) i.checks?.cancel?.(admitted);
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
    if (signal.aborted) {
      if (admitted !== undefined) i.checks?.cancel?.(admitted);
      return refuse("codex-allowlist");
    }
    // the lock's key: the completion event names the same one (see codex-session's tool-result)
    const id = params.approvalId ?? params.itemId;
    // Commands below the worktree root still reserve this checkout, but cannot create a root receipt.
    if (
      i.checks !== undefined &&
      (typeof id === "string" || typeof id === "number") &&
      withinDir(params.cwd, i.cwd)
    ) {
      for (const event of events) {
        if (event.tool === "Bash" && event.input.command !== undefined) {
          const itemId = typeof params.itemId === "string" ? params.itemId : null;
          await i.checks.begin(
            { runId: i.runId, toolUseId: String(id) },
            event.input.command,
            itemId === null || itemId === String(id) ? [] : [{ runId: i.runId, toolUseId: itemId }],
            { receiptEligible: sameDir(params.cwd, i.cwd) },
          );
        }
      }
    }
    if (signal.aborted) {
      // declined after the call was noted: nothing will run, so nothing may keep waiting for it
      if (typeof id === "string" || typeof id === "number") {
        const key = { runId: i.runId, toolUseId: String(id) };
        i.checks?.abandon?.(key);
        i.lock.release(key);
      }
      return refuse("codex-allowlist");
    }
    return "accept";
  };
}
