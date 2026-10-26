/** The same Codex approval path for supervisor runs and the controller's live check. */
import {
  type CrewMode,
  codexCommand,
  DEFAULT_SEAT_COMMANDS,
  GUARD_RULES,
  type GuardRule,
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
import { crewGuardDecision } from "../guard/decision.ts";
import type { TestLock } from "../guard/lock.ts";
import { codexApproval, codexCommandAllowed, codexEditAllowed } from "./codex-floor.ts";
import { CODEX_MCP_ELICITATION, type CodexSessionInput } from "./codex-session.ts";

const REFUSAL_DETAIL_MAX = 200;

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
  runGrants?: () => readonly string[];
}): CodexSessionInput["approve"] {
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
      );
      return verdict.kind === "deny" ? refuse(verdict.rule, verdict.text) : "accept";
    }
    const events = codexApproval(req, paths, { cwd: i.cwd });
    if (!repo || events === null) return refuse("codex-allowlist");
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
        seatGrants,
        i.cwd,
        typeof params.cwd === "string" ? params.cwd : undefined,
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
