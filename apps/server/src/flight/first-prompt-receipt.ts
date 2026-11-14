import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { PROMPT_SECTIONS, type PromptSectionCost, type PromptWakeCost } from "@mc/core";
import { Store } from "../store.ts";

/** FLIGHT's first prompt is meant to stay under this many tokens. */
export const FIRST_PROMPT_LIMIT_TOKENS = 100_000;

export interface FirstPromptReceipt {
  runId: string;
  at: number;
  sections: PromptSectionCost[];
  bytes: number;
  /** Estimate of the text Mission Control sends (bytes / 4). */
  tokens: number;
  /** The context the provider reported on the run's first assistant reply, or null when unread. */
  measuredTokens: number | null;
  /** True when the measured figure is under the limit; the estimate decides only when unmeasured. */
  underLimit: boolean;
}

/** The first top-level assistant reply's input + cache read + cache creation tokens, or null. */
export function measuredFirstContext(transcriptPath: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(transcriptPath, "utf8");
  } catch {
    return null;
  }
  for (const line of raw.split("\n")) {
    if (!line.includes('"usage"')) continue;
    try {
      const ev = JSON.parse(line) as {
        type?: string;
        parent_tool_use_id?: unknown;
        isSidechain?: unknown;
        message?: { usage?: Record<string, unknown> };
      };
      const u = ev.message?.usage;
      if (ev.type !== "assistant" || !u || ev.parent_tool_use_id || ev.isSidechain) continue;
      const n = (k: string): number => (typeof u[k] === "number" ? (u[k] as number) : 0);
      return n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens");
    } catch {}
  }
  return null;
}

/** The run's start (wake 0) as a receipt, or null when its sections were never recorded. */
export function firstPromptReceipt(
  wakes: readonly PromptWakeCost[],
  measuredTokens: number | null = null,
): FirstPromptReceipt | null {
  const start = wakes.find((w) => w.wake === 0);
  if (!start) return null;
  const sections = [...start.sections].sort(
    (a, b) => PROMPT_SECTIONS.indexOf(a.section) - PROMPT_SECTIONS.indexOf(b.section),
  );
  const bytes = sections.reduce((n, s) => n + s.bytes, 0);
  const tokens = sections.reduce((n, s) => n + s.tokens, 0);
  return {
    runId: start.runId,
    at: start.at,
    sections,
    bytes,
    tokens,
    measuredTokens,
    underLimit: (measuredTokens ?? tokens) < FIRST_PROMPT_LIMIT_TOKENS,
  };
}

/** One table: each section's estimated tokens before and after, the measured first context, the verdict. */
export function formatReceipt(before: FirstPromptReceipt, after: FirstPromptReceipt): string {
  const tokens = (r: FirstPromptReceipt, section: string): number =>
    r.sections.find((s) => s.section === section)?.tokens ?? 0;
  const col = (v: string | number): string => String(v).padStart(10);
  const rows = PROMPT_SECTIONS.filter((s) => tokens(before, s) + tokens(after, s) > 0).map(
    (s) => `${s.padEnd(14)}${col(tokens(before, s))}${col(tokens(after, s))}`,
  );
  const verdict = (r: FirstPromptReceipt): string =>
    `${r.underLimit ? "under" : "OVER"}${r.measuredTokens === null ? "*" : ""}`;
  return [
    `${"section".padEnd(14)}${col("before")}${col("after")}  (estimated tokens, ${FIRST_PROMPT_LIMIT_TOKENS} limit)`,
    ...rows,
    `${"estimate".padEnd(14)}${col(before.tokens)}${col(after.tokens)}`,
    `${"measured".padEnd(14)}${col(before.measuredTokens ?? "n/a")}${col(after.measuredTokens ?? "n/a")}  (first reply's context, from the transcript)`,
    `${"verdict".padEnd(14)}${col(verdict(before))}${col(verdict(after))}  (* = no measured figure, estimate used)`,
    `before: run ${before.runId}; after: run ${after.runId}. The estimate counts the text Mission Control sends, not the provider's own tool list.`,
  ].join("\n");
}

/** A seat's recorded first prompts on one database, newest first. */
export function firstPrompts(store: Store, agentId: string): FirstPromptReceipt[] {
  const out: FirstPromptReceipt[] = [];
  for (const w of store.agentPromptStarts(agentId)) {
    const path = store.run(w.runId)?.transcriptPath;
    const r = firstPromptReceipt([w], path ? measuredFirstContext(path) : null);
    if (r) out.push(r);
  }
  return out;
}

/** Picks the baseline: a run id, the last start before an ISO date, or else the oldest. */
export function pickBefore(
  starts: FirstPromptReceipt[],
  before?: string,
): FirstPromptReceipt | undefined {
  if (!before) return starts.at(-1);
  const byId = starts.find((r) => r.runId === before);
  if (byId) return byId;
  const t = Date.parse(before);
  return Number.isNaN(t) ? undefined : starts.find((r) => r.at < t);
}

/** `first-prompt-receipt.ts <copied.db> [seat] [--before <runId|ISO date>] [--after <runId>]`. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const beforeArg = flag("--before");
  const afterArg = flag("--after");
  const [dbCopy, seatId = "flight-1"] = args;
  if (!dbCopy) {
    console.error(
      "usage: first-prompt-receipt.ts <copy of the database> [seat id] [--before <run id|ISO date>] [--after <run id>]",
    );
    process.exit(2);
  }
  const store = new Store(dbCopy);
  const starts = firstPrompts(store, seatId);
  store.close();
  const after = afterArg ? starts.find((r) => r.runId === afterArg) : starts[0];
  const before = pickBefore(starts, beforeArg);
  if (!after || !before || after === before) {
    console.error(`${seatId}: need two different recorded starts on this database`);
    process.exit(1);
  }
  console.log(formatReceipt(before, after));
}
