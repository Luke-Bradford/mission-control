/**
 * What a run was about, as the API serves it: the PRs the run published joined to the stored PR
 * rows, and the run's ticket resolved through them (#26 A3).
 */
import type { PullRequestView, RepoId, Run, RunPr, RunSummary, RunUsage, RunView } from "@mc/core";
import type { CcConfig } from "./config.ts";
import type { Store } from "./store.ts";

/** Compact list diagnostics without mutating the single-run record. */
export function runSummary(run: Run): RunSummary {
  if (!run.noReport) return run;
  const { lastAssistantText: _, ...noReport } = run.noReport;
  return { ...run, noReport };
}

/** A repo's stored PRs by number, read once per request: pass one cache to every call. */
export type PrCache = Map<RepoId, Map<number, PullRequestView>>;

/**
 * The run's PRs in configured repos (matched to `github` case-insensitively; others are dropped),
 * joined to the stored row by number. A PR with no stored row has a null title, state and ticket,
 * and its URL is built from the configured `owner/name`.
 */
export function runPrs(
  config: CcConfig,
  store: Store,
  run: Run,
  cache: PrCache = new Map(),
): RunPr[] {
  const out: RunPr[] = [];
  for (const { repo, number } of run.prs) {
    const configured = config.repos.find((c) => c.github.toLowerCase() === repo.toLowerCase());
    if (!configured) continue;
    if (out.some((p) => p.repoId === configured.id && p.number === number)) continue;
    let rows = cache.get(configured.id);
    if (!rows) {
      rows = new Map(store.pullRequests(configured.id).map((p) => [p.number, p]));
      cache.set(configured.id, rows);
    }
    const row = rows.get(number);
    out.push({
      repoId: configured.id,
      number,
      title: row?.title ?? null,
      url: row?.url ?? `https://github.com/${configured.github}/pull/${number}`,
      state: row?.state ?? null,
      ticket: row?.ticket ?? null,
    });
  }
  return out;
}

/** The run's own ticket, else the first of its PRs' tickets, else null. */
export const runTicket = (run: Run, prs: RunPr[]): string | null =>
  run.ticket ?? prs.find((p) => p.ticket)?.ticket ?? null;

/**
 * A run's ticket title, the same wherever it is shown: the board's for the resolved ticket, else
 * the one the run began with, but only when the run's own ticket is the resolved one (a ticket
 * taken from a PR is not the one the stored title is of).
 */
export const runTicketTitle = (
  run: Run,
  ticket: string | null,
  boardTitle: string | null,
): string | null => boardTitle ?? (run.ticket === ticket ? run.ticketTitle : null) ?? null;

/** `repo#number` → the repo id and issue number, or null. */
export function parseTicket(ticket: string): { repoId: string; number: number } | null {
  const i = ticket.lastIndexOf("#");
  if (i <= 0) return null;
  const number = Number(ticket.slice(i + 1));
  return Number.isInteger(number) && number > 0 ? { repoId: ticket.slice(0, i), number } : null;
}

/** A repo's board items by issue number, read once per request: pass one cache to every call. */
export type BoardTitleCache = Map<RepoId, Map<number, string>>;

/**
 * The `/api/agents/:id/runs` row. The title is runTicketTitle's: the board's for the run's resolved
 * ticket, else the stored one (see there), else null.
 */
export function runView(
  config: CcConfig,
  store: Store,
  run: Run,
  cache: PrCache,
  boards: BoardTitleCache = new Map(),
): RunView {
  const prs = runPrs(config, store, run, cache);
  const ticket = runTicket(run, prs);
  const t = ticket === null ? null : parseTicket(ticket);
  let boardTitle: string | null = null;
  if (t !== null && config.repos.some((r) => r.id === t.repoId)) {
    let titles = boards.get(t.repoId);
    if (!titles) {
      titles = new Map(store.board(t.repoId).map((i) => [i.issueNumber, i.title]));
      boards.set(t.repoId, titles);
    }
    boardTitle = titles.get(t.number) ?? null;
  }
  return {
    ...runSummary(run),
    usage: runUsage(store, run),
    prs,
    ticket,
    ticketTitle: runTicketTitle(run, ticket, boardTitle),
  };
}

/** Full run measurements, independent of a template's illustrative budget. */
export function runUsage(store: Store, run: Run, now = Date.now()): RunUsage {
  const digest = store.digest(run.id);
  return {
    input: run.tokens?.input ?? null,
    output: run.tokens?.output ?? null,
    cacheRead: run.tokens?.cacheRead ?? null,
    cacheCreate: run.tokens?.cacheCreate ?? null,
    costUsd: run.costUsd,
    model: run.model ?? digest?.model ?? null,
    turns: digest?.turns ?? null,
    durationMs: Math.max(0, (run.endedAt ?? now) - run.startedAt),
  };
}
