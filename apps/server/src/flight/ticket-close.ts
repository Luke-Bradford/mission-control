import {
  type BoardItem,
  dependsOn,
  FLIGHT_CLOSE_DEPENDENT_READ_BATCH,
  FLIGHT_CLOSE_SEARCH_LIMIT,
  globMatches,
  hudColumnOf,
  LANE_LABEL_PREFIX,
  type RepoRules,
  type TicketView,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import type { GhRunner } from "../mcp/gh.ts";
import { crewDir } from "../store/crew-paths.ts";
import type { Store } from "../store.ts";

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const asNum = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface CloseBlockerDeps {
  store: Store;
  gh: GhRunner;
  dbPath: string;
  fetchTicket: (repo: CcConfig["repos"][number], n: number) => Promise<TicketView | null>;
  log?: (line: string) => void;
}

/**
 * Why a ticket may not be closed, or the ticket as GitHub reads it now (open). The refusals of
 * FLIGHT's close_ticket and of the operator's Drop, so the two cannot drift: a live run, an open
 * PR, open tickets blocked by it or depending on it, open sub-issues, a ticket that is not open.
 * Reads only; `tool` names the caller in the log.
 */
export async function closeBlocker(
  d: CloseBlockerDeps,
  tool: string,
  repo: CcConfig["repos"][number],
  card: BoardItem,
  /** A run that waits on the question behind a Drop: it ends with the close, so it is no refusal. */
  waitingRun?: string,
): Promise<{ refusal: string } | { target: TicketView }> {
  const { store } = d;
  const a = { issue: card.issueNumber };
  const ref = `${repo.id}#${a.issue}`;
  const refuse = (refusal: string) => ({ refusal });
  const cards = store.board(repo.id);
  const read = async (n: number): Promise<TicketView | null> => {
    try {
      return await d.fetchTicket(repo, n);
    } catch {
      return null;
    }
  };
  if (
    store.activeTickets().has(ref) &&
    (waitingRun === undefined ||
      store
        .runsOnTicket(repo.id, ref)
        .some((r) => r.endedAt === null && r.reviewId == null && r.id !== waitingRun))
  )
    return refuse("the ticket has a live run");
  if (
    store
      .pullRequests(repo.id)
      .some(
        (p) =>
          p.state === "open" && (p.ticket === ref || p.closingIssues?.includes(a.issue) === true),
      )
  )
    return refuse("the ticket has an open PR");
  const blocked = cards.filter(
    (c) => !c.closed && c.blockedBy.some((b) => !b.closed && b.ref === ref),
  );
  if (blocked.length > 0)
    return refuse(
      `open tickets are blocked by it (${blocked.map((c) => `${repo.id}#${c.issueNumber}`).join(", ")}); closing it would unblock them`,
    );
  if (card.subIssues && card.subIssues.done < card.subIssues.total)
    return refuse("the ticket has open sub-issues");
  // "Depends on #N" in a waiting ticket's body also holds it back; an unreadable body fails closed
  const waiting = cards.filter(
    (c) =>
      !c.closed &&
      c.issueNumber !== a.issue &&
      (["Backlog", "Ready", "Refinement", "Blocked"] as string[]).includes(hudColumnOf(c)),
  );
  // one search for the tickets that mention the number; only those are read
  const searchArgv = [
    "search",
    "issues",
    String(a.issue),
    `--repo=${repo.github}`,
    "--state=open",
    "--match=body",
    "--json=number",
    `--limit=${String(FLIGHT_CLOSE_SEARCH_LIMIT)}`,
  ];
  const searched = await d.gh(searchArgv, { cwd: crewDir(d.dbPath) });
  if (searched.code !== 0)
    d.log?.(`mc ${tool}: gh search issues failed (${String(searched.code)})`);
  let mentioning: Set<number> | null = null;
  if (searched.code === 0) {
    try {
      const found: unknown = JSON.parse(searched.stdout);
      if (Array.isArray(found) && found.length < FLIGHT_CLOSE_SEARCH_LIMIT)
        mentioning = new Set(found.map((f) => asNum(asRecord(f).number)));
    } catch {
      // unreadable: fails closed below
    }
  }
  if (mentioning === null) return refuse("could not search the open tickets for dependents");
  const candidates = waiting.filter((c) => mentioning.has(c.issueNumber));
  const bodies: (TicketView | null)[] = [];
  for (let i = 0; i < candidates.length; i += FLIGHT_CLOSE_DEPENDENT_READ_BATCH)
    bodies.push(
      ...(await Promise.all(
        candidates.slice(i, i + FLIGHT_CLOSE_DEPENDENT_READ_BATCH).map((c) => read(c.issueNumber)),
      )),
    );
  const dependents: string[] = [];
  for (const [i, t] of bodies.entries()) {
    if (t === null || t.bodyTruncated) return refuse("a waiting ticket's body could not be read");
    if (dependsOn(t.body).includes(a.issue))
      dependents.push(`${repo.id}#${candidates[i]?.issueNumber}`);
  }
  if (dependents.length > 0)
    return refuse(
      `open tickets depend on it (${dependents.join(", ")}); closing it would unblock them`,
    );
  let target: TicketView | null;
  try {
    target = await d.fetchTicket(repo, a.issue);
  } catch {
    return refuse("GitHub is unreachable");
  }
  if (target?.state !== "open") return refuse("the ticket is not open");
  if (target.pullRequests.some((pr) => pr.state === "open"))
    return refuse("the ticket has an open PR");
  if (target.subIssues.some((sub) => sub.state === "open"))
    return refuse("the ticket has open sub-issues");
  return { target };
}

/** The always_ask and lane refusals for any card a tool or the operator's Drop names, or null. */
export function cardProblem(
  config: Pick<CcConfig, "crew">,
  card: BoardItem,
  rules: Pick<RepoRules, "alwaysAsk">,
): string | null {
  const lane = config.crew?.lane;
  if (rules.alwaysAsk.some((g) => card.labels.some((l) => globMatches(g, l, true))))
    return "this is an always_ask ticket";
  const lanes = card.labels.filter((l) => l.startsWith(LANE_LABEL_PREFIX));
  if (lanes.length > 1 || (lane && lanes.length === 1 && lanes[0] !== `lane:${lane}`))
    return "this ticket belongs to another lane or has conflicting lanes";
  return null;
}
