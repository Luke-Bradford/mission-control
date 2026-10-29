import { type CrewVendor, isObj, MC_MCP_SERVER } from "@mc/core";
import { cleanText } from "./clean.ts";
import { cutBytes, str } from "./util.ts";

export { CODEX_APPROVAL_DECISION } from "./runtime/codex-wire.ts";

/** Bookkeeping and unknown objects do not establish a transcript's format. */
export function transcriptVendor(
  ev: Record<string, unknown>,
  vendor?: CrewVendor,
): CrewVendor | undefined {
  if (vendor !== undefined) return vendor;
  if (
    typeof ev.method === "string" ||
    "jsonrpc" in ev ||
    ("id" in ev && ("result" in ev || "error" in ev))
  )
    return "codex";
  if (
    ev.type === "assistant" ||
    ev.type === "user" ||
    ev.type === "system" ||
    ev.type === "result" ||
    ev.type === "rate_limit_event" ||
    ev.type === "stream_event"
  )
    return "claude";
  return undefined;
}

export function codexTool(item: Record<string, unknown>) {
  let name: string;
  let input: unknown;
  let result: string;
  if (item.type === "commandExecution") {
    name = "Bash";
    input = { command: item.command };
    result = str(item.aggregatedOutput) ?? "";
  } else if (item.type === "fileChange") {
    name = "Edit";
    const paths = Array.isArray(item.changes)
      ? item.changes
          .filter(isObj)
          .map((change) => change.path)
          .filter((p) => typeof p === "string")
      : [];
    input = { file_path: paths[0], paths };
    result = JSON.stringify(item.changes ?? []);
  } else if (item.type === "mcpToolCall") {
    name = `mcp__${str(item.server) ?? MC_MCP_SERVER}__${str(item.tool) ?? "unknown"}`;
    input = item.arguments;
    result = JSON.stringify(item.result ?? item.error ?? null);
  } else return null;
  return {
    name: cleanText(name),
    input: input === undefined ? "" : JSON.stringify(input),
    result,
    /** Bytes the transcript's compaction cut from `result`, whose own length is the kept part. */
    cutBytes: cutBytes(item),
    status: str(item.status) ?? undefined,
    exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
    ms: typeof item.durationMs === "number" ? Math.max(0, item.durationMs) : null,
    error:
      item.status === "failed" ||
      item.status === "declined" ||
      (typeof item.exitCode === "number" && item.exitCode !== 0) ||
      item.error != null,
  };
}

export function codexPlan(params: Record<string, unknown>): string | null {
  if (
    !Array.isArray(params.plan) ||
    !params.plan.every(
      (step) => isObj(step) && typeof step.step === "string" && typeof step.status === "string",
    )
  )
    return null;
  return [
    ...(typeof params.explanation === "string" && params.explanation !== ""
      ? [params.explanation]
      : []),
    ...params.plan.map((step) => `[${step.status}] ${step.step}`),
  ].join("\n");
}
