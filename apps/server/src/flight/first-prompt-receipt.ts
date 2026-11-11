import { pathToFileURL } from "node:url";
import { PROMPT_SECTIONS, type PromptSectionCost, type PromptWakeCost } from "@mc/core";
import { Store } from "../store.ts";

/** FLIGHT's first prompt is meant to stay under this many estimated tokens. */
export const FIRST_PROMPT_LIMIT_TOKENS = 100_000;

export interface FirstPromptReceipt {
  runId: string;
  at: number;
  sections: PromptSectionCost[];
  bytes: number;
  tokens: number;
  underLimit: boolean;
}

/** The run's start (wake 0) as a receipt, or null when its sections were never recorded. */
export function firstPromptReceipt(wakes: readonly PromptWakeCost[]): FirstPromptReceipt | null {
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
    underLimit: tokens < FIRST_PROMPT_LIMIT_TOKENS,
  };
}

/** One table: each section's estimated tokens before and after, the totals, and the verdict. */
export function formatReceipt(before: FirstPromptReceipt, after: FirstPromptReceipt): string {
  const tokens = (r: FirstPromptReceipt, section: string): number =>
    r.sections.find((s) => s.section === section)?.tokens ?? 0;
  const rows = PROMPT_SECTIONS.filter((s) => tokens(before, s) + tokens(after, s) > 0).map(
    (s) =>
      `${s.padEnd(14)}${String(tokens(before, s)).padStart(10)}${String(tokens(after, s)).padStart(10)}`,
  );
  const verdict = (r: FirstPromptReceipt): string => (r.underLimit ? "under" : "OVER");
  return [
    `${"section".padEnd(14)}${"before".padStart(10)}${"after".padStart(10)}  (estimated tokens, ${FIRST_PROMPT_LIMIT_TOKENS} limit)`,
    ...rows,
    `${"total".padEnd(14)}${String(before.tokens).padStart(10)}${String(after.tokens).padStart(10)}`,
    `${"verdict".padEnd(14)}${verdict(before).padStart(10)}${verdict(after).padStart(10)}`,
    `before: run ${before.runId}; after: run ${after.runId}. Counts the text Mission Control sends, not the provider's own tool list.`,
  ].join("\n");
}

/** A seat's recorded first prompts on one database, newest first. */
export function firstPrompts(store: Store, agentId: string, since = 0): FirstPromptReceipt[] {
  const byRun = new Map<string, PromptWakeCost[]>();
  for (const w of store.agentPromptWakes(agentId, since, 1000)) {
    byRun.set(w.runId, [...(byRun.get(w.runId) ?? []), w]);
  }
  return [...byRun.values()]
    .map(firstPromptReceipt)
    .filter((r): r is FirstPromptReceipt => r !== null)
    .sort((a, b) => b.at - a.at);
}

/** `node --experimental-strip-types first-prompt-receipt.ts <copied.db> <seat id>`: oldest vs newest start. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [dbCopy, seatId = "flight-1"] = process.argv.slice(2);
  if (!dbCopy) {
    console.error("usage: first-prompt-receipt.ts <copy of the database> [seat id]");
    process.exit(2);
  }
  const store = new Store(dbCopy);
  const starts = firstPrompts(store, seatId);
  store.close();
  const newest = starts[0];
  const oldest = starts.at(-1);
  if (!newest || !oldest || newest === oldest) {
    console.error(`${seatId}: need at least two recorded starts on this database`);
    process.exit(1);
  }
  console.log(formatReceipt(oldest, newest));
}
