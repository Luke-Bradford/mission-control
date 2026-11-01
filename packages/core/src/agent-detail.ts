import type { AttentionOwner } from "./hud-model.ts";
import type { DoneWhenEntry } from "./mcp.ts";
import type { PromptWakeCost } from "./prompt-cost.ts";
import type { CrewRow } from "./types.ts";

/** GET /api/agents/:id: saved facts for the Agent page, with no client-side subject joins. */
export interface AgentDetailView {
  row: CrewRow;
  awaiting: { label: string; reason: string | null; since: number | null };
  health: { label: string; blocking: number | null; failedTools: number | null };
  tools: {
    total: number | null;
    failed: number | null;
    byTool: { name: string; calls: number; failed: number }[];
  };
  cost: {
    totalUsd: number | null;
    meanPerReportedTurnUsd: number | null;
    turns: number | null;
    estimated: boolean;
  };
  context: {
    tokens: number | null;
    window: number | null;
    percent: number | null;
    compactions: number | null;
    prompt: PromptWakeCost | null;
  };
  story: {
    title: string | null;
    ticketHref: string | null;
    original: { line: number; text: string }[];
    report: string | null;
    reportedAt: number | null;
    doneWhen: DoneWhenEntry[];
    left: string[];
  };
  nextMove: {
    owner: AttentionOwner;
    text: string;
    recommendation: string | null;
    label: string;
    href: string;
  } | null;
  deliverables: { id: string; kind: "pr" | "screenshot" | "file"; label: string; href: string }[];
  related: {
    id: string;
    kind: "review" | "subagent" | "aside";
    title: string;
    status: string;
    href: string | null;
    detail: string | null;
  }[];
  steps: {
    id: string;
    label: string;
    state: "done" | "current" | "held" | "todo" | "unknown";
    tries: number | null;
    failures: number | null;
    limit: number | null;
    durationMs: number | null;
    since: number | null;
    reason: string | null;
  }[];
}
