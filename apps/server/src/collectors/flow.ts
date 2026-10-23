import {
  ciVerdict,
  FLOW_BATCH,
  FLOW_DAYS,
  FLOW_TIMELINE_MAX_PAGES,
  FLOW_TIMELINE_PAGE_SIZE,
  type FlowIssue,
  type FlowPr,
  flowCollector,
  hudColumnOf,
  RATE_LIMIT_SELECTION,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import type { Store } from "../store.ts";
import {
  CHECK_CONTEXTS,
  call,
  errMsg,
  type Gql,
  GqlError,
  isObj,
  ms,
  parseChecks,
  path,
} from "./github.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** The timeline field; a later page continues from the query's `$after` variable. */
const timelineFields = (paged: boolean) => `timelineItems(first: ${FLOW_TIMELINE_PAGE_SIZE}${
  paged ? ", after: $after" : ""
}, itemTypes: [PROJECT_V2_ITEM_STATUS_CHANGED_EVENT]) {
  nodes { ... on ProjectV2ItemStatusChangedEvent { createdAt status project { number } } }
  pageInfo { hasNextPage endCursor }
}`;
const ISSUE_FIELDS = timelineFields(false);
const PR_FIELDS = `commits(first: 20) { nodes { commit { ${CHECK_CONTEXTS} } } }`;

type Repo = CcConfig["repos"][number];

/**
 * The aliases a failed query's errors name, when every error is a `NOT_FOUND` whose path is
 * exactly one alias of this batch (`["repository", "aN"]`: GitHub's answer for an issue or PR
 * deleted or transferred since it was listed); null when any error is something else (another
 * type such as FORBIDDEN or INTERNAL, another path, no path), which then fails the batch.
 */
function aliasErrors(e: GqlError, aliases: Set<string>): Set<string> | null {
  if (e.errors.length === 0 || !isObj(e.data)) return null;
  const named = new Set<string>();
  for (const err of e.errors) {
    if (!isObj(err) || err.type !== "NOT_FOUND") return null;
    const p = err.path;
    const alias = Array.isArray(p) && p.length === 2 && p[0] === "repository" ? p[1] : undefined;
    if (typeof alias !== "string" || !aliases.has(alias)) return null;
    named.add(alias);
  }
  return named;
}

/**
 * One query of up to FLOW_BATCH aliased lookups; returns number -> node (null when GitHub has
 * none). An item GitHub reports missing is skipped (null); any other error throws.
 */
async function batch(
  gql: Gql,
  repo: Repo,
  field: "issue" | "pullRequest",
  fields: string,
  numbers: number[],
): Promise<Map<number, unknown>> {
  const [owner = "", name = ""] = repo.github.split("/");
  const aliasOf = (i: number) => `a${i}`;
  const lookups = numbers.map((n, i) => `${aliasOf(i)}: ${field}(number: ${n}) { ${fields} }`);
  let data: unknown;
  let missing = new Set<string>();
  try {
    data = await call(
      gql,
      `query FlowBatch($owner: String!, $name: String!) { ${RATE_LIMIT_SELECTION} repository(owner: $owner, name: $name) { ${lookups.join(" ")} } }`,
      { owner, name },
    );
  } catch (e) {
    if (!(e instanceof GqlError)) throw e;
    const named = aliasErrors(e, new Set(numbers.map((_, i) => aliasOf(i))));
    if (!named) throw e;
    data = e.data;
    missing = named;
  }
  const out = new Map<number, unknown>();
  for (const [i, n] of numbers.entries()) {
    out.set(n, missing.has(aliasOf(i)) ? null : path(data, "repository", aliasOf(i)));
  }
  return out;
}

async function readAll(
  gql: Gql,
  repo: Repo,
  field: "issue" | "pullRequest",
  fields: string,
  numbers: number[],
): Promise<Map<number, unknown>> {
  const out = new Map<number, unknown>();
  for (let i = 0; i < numbers.length; i += FLOW_BATCH) {
    const got = await batch(gql, repo, field, fields, numbers.slice(i, i + FLOW_BATCH));
    for (const [n, v] of got) out.set(n, v);
  }
  return out;
}

/**
 * Follows each issue's timeline past its first page, up to FLOW_TIMELINE_MAX_PAGES pages in all,
 * appending the events to the issue's node. An issue GitHub no longer has (NOT_FOUND on a later
 * page, as on the first) is set to null, which skips it. Returns how many issues still had more
 * events after the bound (their start and done times may be wrong).
 */
async function pageTimelines(
  gql: Gql,
  repo: Repo,
  timelines: Map<number, unknown>,
): Promise<number> {
  const [owner = "", name = ""] = repo.github.split("/");
  const query = `query FlowTimeline($owner: String!, $name: String!, $number: Int!, $after: String) { ${RATE_LIMIT_SELECTION} repository(owner: $owner, name: $name) { a0: issue(number: $number) { ${timelineFields(true)} } } }`;
  let truncated = 0;
  for (const [number, node] of timelines) {
    const first = path(node, "timelineItems");
    if (!isObj(first) || !Array.isArray(first.nodes)) continue;
    let info = path(first, "pageInfo");
    for (let p = 1; p < FLOW_TIMELINE_MAX_PAGES; p++) {
      if (!isObj(info) || info.hasNextPage !== true || typeof info.endCursor !== "string") break;
      let data: unknown;
      try {
        data = await call(gql, query, { owner, name, number, after: info.endCursor });
      } catch (e) {
        if (!(e instanceof GqlError) || !aliasErrors(e, new Set(["a0"]))) throw e;
        timelines.set(number, null);
        info = null;
        break;
      }
      const next = path(data, "repository", "a0", "timelineItems");
      if (!isObj(next) || !Array.isArray(next.nodes)) {
        throw new Error("unexpected timeline response");
      }
      first.nodes.push(...next.nodes);
      info = path(next, "pageInfo");
    }
    if (isObj(info) && info.hasNextPage === true) truncated += 1;
  }
  return truncated;
}

/** Only an observed Ready entry starts the board journey; planned alone may be a backlog. */
function startsWork(status: string): boolean {
  return status.trim().toLowerCase() === "ready";
}

function isDone(repo: Repo, status: string): boolean {
  const state = Object.hasOwn(repo.statusMap, status) ? repo.statusMap[status] : "planned";
  return hudColumnOf({ status, state: state ?? "planned", closed: false }) === "Done";
}

/** Start and done times from one issue's Status-change events on the repo's own project. */
function issueFlow(repo: Repo, node: unknown): { startAt: number | null; doneAt: number | null } {
  const raw = path(node, "timelineItems", "nodes");
  const events = (Array.isArray(raw) ? raw : [])
    .filter(isObj)
    .filter((e) => path(e, "project", "number") === repo.project)
    .map((e) => ({ at: ms(e.createdAt), status: typeof e.status === "string" ? e.status : "" }))
    .filter((e) => e.at > 0)
    .sort((a, b) => a.at - b.at);
  let startAt: number | null = null;
  let doneAt: number | null = null;
  for (const e of events) {
    if (startAt === null && startsWork(e.status)) startAt = e.at;
    if (isDone(repo, e.status)) doneAt = e.at;
  }
  return { startAt, doneAt };
}

/** The rollup of the earliest commit that has one; CI runs on pushed heads, so most have none. */
function firstPushCi(node: unknown, required: readonly string[]): FlowPr["firstPushCi"] {
  const nodes = path(node, "commits", "nodes");
  if (!Array.isArray(nodes)) return null;
  for (const n of nodes) {
    const ci = ciVerdict(parseChecks(path(n, "commit", "statusCheckRollup")), required).ci;
    if (ci !== null) return ci;
  }
  return null;
}

/**
 * Hourly, read-only: for issues that reached Done and PRs merged in the last FLOW_DAYS, reads the
 * Status-change timeline and the first commits' CI. Rows are replaced only when every batch
 * succeeded; a failure keeps the old rows, is recorded as the flow collector's status, never throws.
 */
export async function collectFlow(repo: Repo, store: Store, gql: Gql, now: number): Promise<void> {
  const since = now - FLOW_DAYS * DAY_MS;
  try {
    const done = store
      .board(repo.id)
      .filter((i) => hudColumnOf(i) === "Done" && i.updatedAt >= since);
    const merged = store
      .pullRequests(repo.id)
      .filter((p) => p.mergedAt !== null && p.mergedAt >= since);

    const timelines = await readAll(
      gql,
      repo,
      "issue",
      ISSUE_FIELDS,
      done.map((i) => i.issueNumber),
    );
    const truncated = await pageTimelines(gql, repo, timelines);
    const checks = await readAll(
      gql,
      repo,
      "pullRequest",
      PR_FIELDS,
      merged.map((p) => p.number),
    );

    const issues: FlowIssue[] = [];
    for (const i of done) {
      const node = timelines.get(i.issueNumber);
      if (!isObj(node)) continue;
      issues.push({
        repoId: repo.id,
        number: i.issueNumber,
        size: i.size,
        ...issueFlow(repo, node),
      });
    }
    const prs: FlowPr[] = [];
    for (const p of merged) {
      const node = checks.get(p.number);
      if (!isObj(node) || p.mergedAt === null) continue;
      prs.push({
        repoId: repo.id,
        number: p.number,
        mergedAt: p.mergedAt,
        firstPushCi: firstPushCi(node, repo.requiredChecks ?? []),
      });
    }
    store.replaceFlow(repo.id, issues, prs);
    const stored = issues.filter((i) => i.doneAt !== null);
    const unstarted = stored.filter((i) => i.startAt === null).length;
    const notes = [
      unstarted > 0 ? `${unstarted} done issue(s) without a start excluded from cycle time` : null,
      truncated > 0
        ? `${truncated} issue(s) with over ${FLOW_TIMELINE_MAX_PAGES * FLOW_TIMELINE_PAGE_SIZE} status events: timeline truncated`
        : null,
    ].filter((n) => n !== null);
    store.setStatus(flowCollector(repo.id), true, notes.length > 0 ? notes.join("; ") : null);
  } catch (e) {
    store.setStatus(
      flowCollector(repo.id),
      false,
      `${errMsg(e)} at ${new Date(now).toISOString()}`,
    );
  }
}
