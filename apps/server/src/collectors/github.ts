import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  BOARD_KEEP_DONE_MS,
  type BoardItem,
  COMMENTS_MAX_PAGES,
  COMMENTS_PAGE_SIZE,
  type Escalation,
  type GithubRateLimit,
  githubCollector,
  inferTicket,
  labelPriority,
  OWNER_FIELD,
  OWNERS,
  type Owner,
  PR_KEEP_MS,
  PR_MAX_PAGES,
  type PullRequestView,
  prSweepCollector,
  RATE_LIMIT_SELECTION,
  type RepoGoal,
  type RepoId,
  SEARCH_MAX_PAGES,
  SEARCH_PAGE_SIZE,
  SIZE_FIELD,
  STAGE_FIELD,
  STAGES,
  type Stage,
  TITLE_MARKER_RE,
  TITLE_MARKERS,
  type TicketState,
  type TicketView,
  type TitleMarker,
} from "@mc/core";
import type { CcConfig } from "../config.ts";
import { hasQuestionFence, parseAutonomyQuestion } from "../sd32.ts";
import type { Store } from "../store.ts";
import {
  exhaustedReading,
  isRateLimitedError,
  isRateLimitedResponse,
  parseRateLimit,
  queryName,
} from "./rate-limit.ts";

const execFileAsync = promisify(execFile);

export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
export const DEFAULT_NEEDS_YOU_LABELS = ["needs-design"];
/** Done items stay on the board this long after their last update. */
export const DONE_VISIBLE_MS = BOARD_KEEP_DONE_MS;
const HTTP_TIMEOUT_MS = 20_000;
const MAX_BOARD_PAGES = 50;

export type Gql = (query: string, vars: Record<string, unknown>) => Promise<unknown>;

const singleSelectField = (alias: string, name: string) =>
  `${alias}: fieldValueByName(name: "${name}") { ... on ProjectV2ItemFieldSingleSelectValue { name } }`;

const BOARD_QUERY = `query Board($owner: String!, $number: Int!, $after: String) {
  ${RATE_LIMIT_SELECTION}
  user(login: $owner) {
    projectV2(number: $number) {
      id
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          updatedAt
          status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }
          ${singleSelectField("stage", STAGE_FIELD)}
          ${singleSelectField("owner", OWNER_FIELD)}
          ${singleSelectField("size", SIZE_FIELD)}
          content {
            ... on Issue {
              number title url state updatedAt createdAt labels(first: 20) { nodes { name } }
              repository { name owner { login } }
              parent { number repository { name } }
              subIssuesSummary { total completed }
              blockedBy(first: 10) { nodes { number state repository { name } } }
              milestone { title }
            }
          }
        }
      }
    }
  }
}`;

const MILESTONES_QUERY = `query Milestones($owner: String!, $name: String!) {
  ${RATE_LIMIT_SELECTION}
  repository(owner: $owner, name: $name) {
    milestones(first: 10, states: OPEN, orderBy: {field: DUE_DATE, direction: ASC}) {
      nodes {
        title dueOn
        openIssues: issues(states: OPEN) { totalCount }
        closedIssues: issues(states: CLOSED) { totalCount }
      }
    }
  }
}`;

const ISSUE_QUERY = `query Ticket($owner: String!, $name: String!, $number: Int!) {
  ${RATE_LIMIT_SELECTION}
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number title url state body
      labels(first: 20) { nodes { name } }
      milestone { title }
      subIssues(first: 50) { nodes { number title state repository { name owner { login } } } }
      closedByPullRequestsReferences(first: 10) { nodes { number title url state merged repository { name owner { login } } } }
    }
  }
}`;

/** A longer issue body is cut here; the pane links to GitHub for the rest. */
export const TICKET_BODY_MAX = 20_000;

const PRS_QUERY = `query PullRequests($owner: String!, $name: String!, $after: String) {
  ${RATE_LIMIT_SELECTION}
  repository(owner: $owner, name: $name) {
    pullRequests(first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number title url state isDraft reviewDecision createdAt updatedAt mergedAt headRefName mergeable
        closingIssuesReferences(first: 3) { nodes { number } }
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
      }
    }
  }
}`;

const SEARCH_QUERY = `query Escalations($q: String!, $after: String) {
  ${RATE_LIMIT_SELECTION}
  search(query: $q, type: ISSUE, first: ${SEARCH_PAGE_SIZE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        number title url createdAt
        labels(first: 20) { nodes { name } }
        comments(last: ${COMMENTS_PAGE_SIZE}) {
          pageInfo { hasPreviousPage startCursor }
          nodes { body createdAt }
        }
      }
    }
  }
}`;

/** An issue's older comments, one page back from `$before` (a previous page's startCursor). */
const COMMENTS_QUERY = `query Comments($owner: String!, $name: String!, $number: Int!, $before: String) {
  ${RATE_LIMIT_SELECTION}
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      comments(last: ${COMMENTS_PAGE_SIZE}, before: $before) {
        pageInfo { hasPreviousPage startCursor }
        nodes { body createdAt }
      }
    }
  }
}`;

/**
 * A response that carried GraphQL `errors`. `data` is what GitHub sent beside them (a missing
 * aliased node is a NOT_FOUND error at its alias plus `null` in its place), so a caller that can
 * tolerate one error may still use the rest; every other caller just sees the thrown message.
 */
export class GqlError extends Error {
  readonly errors: unknown[];
  readonly data: unknown;
  constructor(message: string, errors: unknown[], data: unknown) {
    super(message);
    this.name = "GqlError";
    this.errors = errors;
    this.data = data;
  }
}

/**
 * The request never got an answer (`status` null: fetch failed) or got an HTTP error status. A
 * caller may retry a lost request or a 5xx (`isTransient`), never a 401/403/429.
 */
export class GqlTransportError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "GqlTransportError";
    this.status = status;
  }
}

export const isTransient = (e: unknown): boolean =>
  e instanceof GqlTransportError && (e.status === null || e.status >= 500);

/** Starts the one line a token missing a scope gets; the scheduler looks for it to log at start-up. */
export const MISSING_SCOPE_PREFIX = "gh token lacks the ";
/** The scope GitHub asks for when its message does not name one (a board read). */
const DEFAULT_SCOPE = "read:project";
const INSUFFICIENT_SCOPES = "INSUFFICIENT_SCOPES";

const errorMessage = (e: unknown): string => (isObj(e) ? String(e.message) : String(e));

/**
 * One line for a GraphQL `errors` list. When every error is INSUFFICIENT_SCOPES (GitHub sends one
 * per queried field) it names the missing scope and the fix; otherwise the messages, each once.
 */
export function describeGqlErrors(errors: unknown[]): string {
  if (errors.length > 0 && errors.every((e) => isObj(e) && e.type === INSUFFICIENT_SCOPES)) {
    // "requires one of the following scopes: ['read:project']": a card move names `project`.
    const named = errors
      .map((e) => /following scopes: \['([^']+)'/.exec(errorMessage(e))?.[1])
      .find((s) => s !== undefined);
    return `${MISSING_SCOPE_PREFIX}${named ?? DEFAULT_SCOPE} scope: run gh auth refresh -s project`;
  }
  return [...new Set(errors.map(errorMessage))].join("; ");
}

/**
 * GraphQL over plain fetch. The token stays inside this closure: it is never logged and never
 * placed in an error message (errors carry fixed text, the HTTP status, or GitHub's own messages).
 */
export function makeGql(
  token: string,
  doFetch: typeof fetch = fetch,
  rates?: { record(query: string, rl: GithubRateLimit): void },
  now: () => number = Date.now,
): Gql {
  return async (query, variables) => {
    let res: Response;
    try {
      res = await doFetch(GITHUB_GRAPHQL_URL, {
        method: "POST",
        headers: {
          Authorization: `bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "mission-control",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
    } catch {
      throw new GqlTransportError("github: request failed", null);
    }
    // An exhausted budget answers with no rateLimit block: record it, or the poll never slows.
    if (!res.ok && isRateLimitedResponse(res.status, res.headers)) {
      rates?.record(queryName(query), exhaustedReading(res.headers, now()));
    }
    if (!res.ok) throw new GqlTransportError(`github: HTTP ${res.status}`, res.status);
    let body: { data?: unknown; errors?: { message?: unknown }[] };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new Error("github: response was not JSON");
    }
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      if (body.errors.some(isRateLimitedError)) {
        rates?.record(queryName(query), exhaustedReading(res.headers, now()));
      }
      const line = describeGqlErrors(body.errors);
      throw new GqlError(
        line.startsWith(MISSING_SCOPE_PREFIX) ? line : `github: ${line}`,
        body.errors,
        body.data ?? null,
      );
    }
    const rl = parseRateLimit(body.data, now());
    if (rl) rates?.record(queryName(query), rl);
    return body.data;
  };
}

/**
 * `gh auth token`, run once and kept in memory by the caller. Never logged. `timeoutMs`: kill gh
 * after this long (default: no limit).
 */
export async function githubToken(timeoutMs?: number): Promise<string> {
  try {
    const token = (
      await execFileAsync(
        "gh",
        ["auth", "token"],
        timeoutMs === undefined ? {} : { timeout: timeoutMs },
      )
    ).stdout.trim();
    if (token !== "") return token;
  } catch {
    // fall through to the fixed message
  }
  throw new Error("gh: could not read a GitHub token (run `gh auth login`)");
}

export const path = (v: unknown, ...keys: string[]): unknown =>
  keys.reduce<unknown>((acc, k) => (isObj(acc) ? acc[k] : undefined), v);
export const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const ms = (v: unknown): number => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? 0 : t;
};
const names = (v: unknown): string[] =>
  isObj(v) && Array.isArray(v.nodes)
    ? v.nodes.flatMap((n) => (isObj(n) && typeof n.name === "string" ? [n.name] : []))
    : [];
const singleSelect = (v: unknown): string | null =>
  isObj(v) && typeof v.name === "string" ? v.name : null;

/** An option name that is not one of the known options (or a missing field) maps to null. */
function option<T extends string>(v: unknown, known: readonly T[]): T | null {
  const name = singleSelect(v);
  return known.find((k) => k === name) ?? null;
}

const num = (v: unknown): number => (typeof v === "number" ? v : 0);

function blockers(v: unknown): BoardItem["blockedBy"] {
  const nodes = isObj(v) && Array.isArray(v.nodes) ? v.nodes : [];
  return nodes.flatMap((n) =>
    isObj(n) && typeof n.number === "number"
      ? [{ ref: `${str(path(n, "repository", "name"))}#${n.number}`, closed: n.state === "CLOSED" }]
      : [],
  );
}

/** A rejected gql, or a response that carries GraphQL `errors`, is a failure. */
export async function call(
  gql: Gql,
  query: string,
  vars: Record<string, unknown>,
): Promise<unknown> {
  const res = await gql(query, vars);
  if (isObj(res) && Array.isArray(res.errors) && res.errors.length > 0) {
    throw new Error(describeGqlErrors(res.errors));
  }
  return res;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface BoardResult {
  items: BoardItem[];
  unmapped: number;
}

async function fetchBoard(
  repo: CcConfig["repos"][number],
  gql: Gql,
  now: number,
): Promise<BoardResult> {
  const [owner = "", repoName = ""] = repo.github.split("/");
  const items: BoardItem[] = [];
  let unmapped = 0;
  // Any page may carry the project id; it is applied to every item once the pages are read.
  let projectId: string | null = null;
  let after: string | null = null;
  for (let p = 0; p < MAX_BOARD_PAGES; p++) {
    const data = await call(gql, BOARD_QUERY, { owner, number: repo.project, after });
    const conn = path(data, "user", "projectV2", "items");
    if (!isObj(conn) || !Array.isArray(conn.nodes)) {
      throw new Error(`project ${repo.project} not found for ${owner}`);
    }
    const projectNodeId = path(data, "user", "projectV2", "id");
    if (typeof projectNodeId === "string") projectId = projectNodeId;
    for (const node of conn.nodes) {
      if (!isObj(node) || !isObj(node.content) || typeof node.content.number !== "number") continue;
      const c = node.content;
      // a project can hold issues from other repos; their numbers would open the wrong ticket here
      if (
        str(path(c, "repository", "name")).toLowerCase() !== repoName.toLowerCase() ||
        str(path(c, "repository", "owner", "login")).toLowerCase() !== owner.toLowerCase()
      ) {
        continue;
      }
      const status = singleSelect(node.status);
      const state: TicketState | undefined =
        status !== null && Object.hasOwn(repo.statusMap, status)
          ? repo.statusMap[status]
          : undefined;
      // An item with no Status is kept (Backlog); one whose Status is not mapped is skipped.
      if (status !== null && state === undefined) {
        unmapped++;
        continue;
      }
      const closed = c.state === "CLOSED";
      const updatedAt = Math.max(ms(node.updatedAt), ms(c.updatedAt));
      if ((closed || state === "done") && now - updatedAt > DONE_VISIBLE_MS) continue;
      const labels = names(c.labels);
      const field = singleSelect(node.priority);
      const fromLabel = field === null ? labelPriority(labels) : null;
      items.push({
        repoId: repo.id,
        issueNumber: c.number as number,
        title: str(c.title),
        status: status ?? "",
        state: state ?? "planned",
        labels,
        priority: field ?? fromLabel,
        prioritySource: field !== null ? "field" : fromLabel !== null ? "label" : null,
        closed,
        updatedAt,
        createdAt: ms(c.createdAt),
        itemId: typeof node.id === "string" ? node.id : null,
        projectId: null,
        url: str(c.url),
        stage: option<Stage>(node.stage, STAGES),
        owner: option<Owner>(node.owner, OWNERS),
        size: singleSelect(node.size),
        // Only a parent in this repo is shown; a cross-repo parent has no card here.
        parent:
          path(c, "parent", "repository", "name") === repoName &&
          typeof path(c, "parent", "number") === "number"
            ? (path(c, "parent", "number") as number)
            : null,
        subIssues:
          num(path(c, "subIssuesSummary", "total")) > 0
            ? {
                done: num(path(c, "subIssuesSummary", "completed")),
                total: num(path(c, "subIssuesSummary", "total")),
              }
            : null,
        blockedBy: blockers(c.blockedBy),
        milestone:
          typeof path(c, "milestone", "title") === "string"
            ? str(path(c, "milestone", "title"))
            : null,
      });
    }
    const pi = isObj(conn.pageInfo) ? conn.pageInfo : {};
    if (pi.hasNextPage !== true || typeof pi.endCursor !== "string") {
      return { items: items.map((i) => ({ ...i, projectId })), unmapped };
    }
    after = pi.endCursor;
  }
  throw new Error("project board has too many pages");
}

const openClosed = (v: unknown): "open" | "closed" => (v === "OPEN" ? "open" : "closed");

/** The configured repo a GraphQL `repository { name owner { login } }` names (case-insensitive), else null. */
function repoIdOf(repos: CcConfig["repos"], node: Record<string, unknown>): RepoId | null {
  const name = path(node, "repository", "name");
  const owner = path(node, "repository", "owner", "login");
  if (typeof name !== "string" || typeof owner !== "string") return null;
  const slug = `${owner}/${name}`.toLowerCase();
  return repos.find((r) => r.github.toLowerCase() === slug)?.id ?? null;
}

/**
 * One issue's detail, or null when GitHub has no such issue in the repo. `repos` are the configured
 * repos its sub-issues and PRs are matched to (default: just `repo`).
 */
export async function fetchTicket(
  repo: CcConfig["repos"][number],
  number: number,
  gql: Gql,
  repos: CcConfig["repos"] = [repo],
): Promise<TicketView | null> {
  const [owner = "", name = ""] = repo.github.split("/");
  let data: unknown;
  try {
    data = await call(gql, ISSUE_QUERY, { owner, name, number });
  } catch (e) {
    // GitHub reports a missing issue as a GraphQL error (NOT_FOUND), which makeGql throws
    if (/could not resolve to an issue/i.test(errMsg(e))) return null;
    throw e;
  }
  const issue = path(data, "repository", "issue");
  if (!isObj(issue) || typeof issue.number !== "number") return null;
  const nodes = (v: unknown): Record<string, unknown>[] =>
    isObj(v) && Array.isArray(v.nodes) ? v.nodes.filter(isObj) : [];
  const chars = Array.from(str(issue.body));
  return {
    number: issue.number,
    title: str(issue.title),
    url: str(issue.url),
    state: openClosed(issue.state),
    body: chars.slice(0, TICKET_BODY_MAX).join(""),
    bodyTruncated: chars.length > TICKET_BODY_MAX,
    bodyLength: chars.length,
    labels: names(issue.labels),
    milestone:
      typeof path(issue, "milestone", "title") === "string"
        ? str(path(issue, "milestone", "title"))
        : null,
    subIssues: nodes(issue.subIssues).flatMap((n) =>
      typeof n.number === "number"
        ? [
            {
              number: n.number,
              title: str(n.title),
              state: openClosed(n.state),
              repoId: repoIdOf(repos, n),
            },
          ]
        : [],
    ),
    pullRequests: nodes(issue.closedByPullRequestsReferences).flatMap((n) =>
      typeof n.number === "number"
        ? [
            {
              number: n.number,
              title: str(n.title),
              url: str(n.url),
              state: n.merged === true ? ("merged" as const) : openClosed(n.state),
              repoId: repoIdOf(repos, n),
            },
          ]
        : [],
    ),
  };
}

/** The repo's goal: the first open milestone with a due date, else the one with the most issues. */
async function fetchGoal(repo: CcConfig["repos"][number], gql: Gql): Promise<RepoGoal | null> {
  const [owner = "", name = ""] = repo.github.split("/");
  const data = await call(gql, MILESTONES_QUERY, { owner, name });
  const nodes = path(data, "repository", "milestones", "nodes");
  if (!Array.isArray(nodes)) throw new Error("unexpected milestones response");
  const all = nodes.filter(isObj).map((n) => ({
    title: str(n.title),
    dueOn: typeof n.dueOn === "string" ? ms(n.dueOn) : null,
    open: num(path(n, "openIssues", "totalCount")),
    closed: num(path(n, "closedIssues", "totalCount")),
  }));
  let best = all.find((m) => m.dueOn !== null);
  if (!best) {
    for (const m of all) {
      if (!best || m.open + m.closed > best.open + best.closed) best = m;
    }
  }
  return best ? { repoId: repo.id, ...best } : null;
}

const quote = (s: string) => `"${s.replace(/["\\]/g, "")}"`;

type RawComment = { body: string; createdAt: string };

const rawComments = (conn: unknown): RawComment[] =>
  isObj(conn) && Array.isArray(conn.nodes)
    ? conn.nodes.flatMap((c) =>
        isObj(c) && typeof c.body === "string"
          ? [{ body: c.body, createdAt: str(c.createdAt) }]
          : [],
      )
    : [];

/**
 * An issue's comments, paged backwards from the newest page the search carried until one holds an
 * SD-32 marker (the newest fence is authoritative, so older pages are moot after that) or
 * COMMENTS_MAX_PAGES pages in all. `truncated`: older comments remained and no marker was found.
 */
export async function fetchComments(
  repo: CcConfig["repos"][number],
  gql: Gql,
  number: number,
  first: unknown,
): Promise<{ comments: RawComment[]; truncated: boolean }> {
  const [owner = "", name = ""] = repo.github.split("/");
  let comments = rawComments(first);
  let info = path(first, "pageInfo");
  const more = () => isObj(info) && info.hasPreviousPage === true;
  for (let p = 1; p < COMMENTS_MAX_PAGES; p++) {
    if (hasQuestionFence(comments) || !more()) break;
    const before = path(info, "startCursor");
    if (typeof before !== "string") break;
    const data = await call(gql, COMMENTS_QUERY, { owner, name, number, before });
    const conn = path(data, "repository", "issue", "comments");
    if (!isObj(conn)) throw new Error("unexpected comments response");
    comments = [...rawComments(conn), ...comments];
    info = conn.pageInfo;
  }
  return { comments, truncated: !hasQuestionFence(comments) && more() };
}

async function fetchEscalations(
  repo: CcConfig["repos"][number],
  gql: Gql,
): Promise<{ escalations: Escalation[]; truncated: string[] }> {
  const labels = repo.needsYouLabels ?? DEFAULT_NEEDS_YOU_LABELS;
  const base = `repo:${repo.github} is:issue is:open`;
  const queries = [
    ...TITLE_MARKERS.map((m) => `${base} in:title ${m}`),
    ...labels.map((l) => `${base} label:${quote(l)}`),
  ];
  const truncated: string[] = [];
  const seen = new Map<number, Record<string, unknown>>();
  for (const q of queries) {
    let after: string | null = null;
    for (let p = 0; p < SEARCH_MAX_PAGES; p++) {
      const data = await call(gql, SEARCH_QUERY, { q, after });
      const nodes = path(data, "search", "nodes");
      if (!Array.isArray(nodes)) throw new Error("unexpected search response");
      for (const n of nodes) {
        if (isObj(n) && typeof n.number === "number" && !seen.has(n.number)) seen.set(n.number, n);
      }
      const pi = path(data, "search", "pageInfo");
      if (!isObj(pi) || pi.hasNextPage !== true) break;
      // more results but no cursor to reach them, or the page bound: either way the list is short
      if (typeof pi.endCursor !== "string" || p === SEARCH_MAX_PAGES - 1) {
        if (!truncated.includes("search")) truncated.push("search");
        if (typeof pi.endCursor !== "string") break;
      }
      after = pi.endCursor;
    }
  }
  const out: Escalation[] = [];
  for (const [number, n] of seen) {
    const title = str(n.title);
    const marker = TITLE_MARKER_RE.exec(title)?.[1] as TitleMarker | undefined;
    const hasLabel = names(n.labels).some((l) => labels.includes(l));
    if (!marker && !hasLabel) continue;
    // Only a title marker is worth the extra queries: a label-only match shows the comments the
    // search carried, and says when older ones were left unread.
    let paged: { comments: RawComment[]; truncated: boolean };
    if (marker) {
      paged = await fetchComments(repo, gql, number, n.comments);
    } else {
      const carried = rawComments(n.comments);
      paged = {
        comments: carried,
        truncated:
          !hasQuestionFence(carried) && path(n.comments, "pageInfo", "hasPreviousPage") === true,
      };
    }
    if (paged.truncated) truncated.push(`comments of #${number}`);
    const comments = paged.comments;
    const question = parseAutonomyQuestion(comments);
    out.push({
      id: `${repo.id}#${number}`,
      repoId: repo.id,
      issueNumber: number,
      title,
      kind: marker ?? (question ? "autonomy-question" : "operator-decision"),
      source: marker ? "title" : "label",
      openedAt: ms(n.createdAt),
      url: str(n.url),
      question,
    });
  }
  return { escalations: out.sort((a, b) => a.issueNumber - b.issueNumber), truncated };
}

const REVIEWS: Record<string, PullRequestView["review"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  REVIEW_REQUIRED: "requested",
};
export const CHECKS: Record<string, PullRequestView["ci"]> = {
  SUCCESS: "passing",
  FAILURE: "failing",
  ERROR: "failing",
  PENDING: "pending",
  EXPECTED: "pending",
};
const PR_STATES: Record<string, PullRequestView["state"]> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
};
const MERGEABLE: Record<string, NonNullable<PullRequestView["mergeable"]>> = {
  MERGEABLE: "MERGEABLE",
  CONFLICTING: "CONFLICTING",
  UNKNOWN: "UNKNOWN",
};
const lookup = <T>(table: Record<string, T>, key: unknown): T | null =>
  typeof key === "string" && Object.hasOwn(table, key) ? (table[key] as T) : null;

function mapPr(
  repo: CcConfig["repos"][number],
  n: Record<string, unknown>,
): PullRequestView | null {
  if (typeof n.number !== "number") return null;
  const branch = str(n.headRefName);
  const closing = path(n, "closingIssuesReferences", "nodes");
  const first = Array.isArray(closing) ? path(closing[0], "number") : undefined;
  const rollup = path(n, "commits", "nodes");
  const last = Array.isArray(rollup) ? rollup[0] : undefined;
  const headOid = path(last, "commit", "oid");
  return {
    repoId: repo.id,
    number: n.number,
    title: str(n.title),
    url: str(n.url),
    branch,
    // The loops name the ticket in the branch and almost never write "Closes #n".
    ticket:
      inferTicket(branch, repo.id) ?? (typeof first === "number" ? `${repo.id}#${first}` : null),
    state: lookup(PR_STATES, n.state) ?? "closed",
    isDraft: n.isDraft === true,
    review: lookup(REVIEWS, n.reviewDecision),
    ci: lookup(CHECKS, path(last, "commit", "statusCheckRollup", "state")),
    createdAt: ms(n.createdAt),
    updatedAt: ms(n.updatedAt),
    mergedAt: typeof n.mergedAt === "string" ? ms(n.mergedAt) : null,
    headSha: typeof headOid === "string" && headOid !== "" ? headOid : null,
    mergeable: lookup(MERGEABLE, n.mergeable),
  };
}

/**
 * Pull requests, newest update first. `all: false` reads page 1 only (every poll); `all: true`
 * pages until a node is older than PR_KEEP_MS or PR_MAX_PAGES, returning only nodes within it.
 * `nodes` is how many nodes GitHub returned, before that filter: 0 means it returned none.
 */
async function fetchPrs(
  repo: CcConfig["repos"][number],
  gql: Gql,
  now: number,
  all: boolean,
): Promise<{ prs: PullRequestView[]; nodes: number }> {
  const [owner = "", name = ""] = repo.github.split("/");
  const out: PullRequestView[] = [];
  let nodes = 0;
  let after: string | null = null;
  for (let p = 0; p < (all ? PR_MAX_PAGES : 1); p++) {
    const data = await call(gql, PRS_QUERY, { owner, name, after });
    const conn = path(data, "repository", "pullRequests");
    if (!isObj(conn) || !Array.isArray(conn.nodes))
      throw new Error("unexpected pull requests response");
    let reachedOld = false;
    nodes += conn.nodes.length;
    for (const n of conn.nodes) {
      if (!isObj(n)) continue;
      const pr = mapPr(repo, n);
      if (!pr) continue;
      if (all && now - pr.updatedAt > PR_KEEP_MS) {
        reachedOld = true;
        continue;
      }
      out.push(pr);
    }
    const pi = isObj(conn.pageInfo) ? conn.pageInfo : {};
    if (reachedOld || pi.hasNextPage !== true || typeof pi.endCursor !== "string") break;
    after = pi.endCursor;
  }
  return { prs: out, nodes };
}

/** Which change topics a GitHub read changed: the scheduler emits only those (#26 A1). */
export interface GithubChanges {
  /** Board rows, the goal, or pull requests. */
  boards: boolean;
  escalations: boolean;
}

/**
 * The hourly sweep: reads up to PR_MAX_PAGES pages and replaces the repo's PR rows with what it
 * read (dropping rows older than PR_KEEP_DAYS), except rows a poll read after this read began
 * (`now`, taken just before the first page; a poll stamps its rows with its own clock just before
 * its PR read). A failure, or GitHub returning no nodes, keeps the old rows; it never throws.
 */
export async function sweepPullRequests(
  repo: CcConfig["repos"][number],
  store: Store,
  gql: Gql,
  now: number,
): Promise<GithubChanges> {
  const collector = prSweepCollector(repo.id);
  let boards = false;
  try {
    const { prs, nodes } = await fetchPrs(repo, gql, now, true);
    // GitHub returning no nodes at all is no data, not "no PRs": it must not wipe the rows until
    // the next poll. Nodes that are all older than the keep window do prune.
    if (nodes > 0) boards = store.sweepPullRequests(repo.id, prs, now);
    store.setStatus(collector, true, null);
  } catch (e) {
    store.setStatus(collector, false, `${errMsg(e)} at ${new Date(now).toISOString()}`);
  }
  return { boards, escalations: false };
}

/**
 * Read-only refresh of one repo's board and escalations. Each part replaces its rows only when it
 * fully succeeded; a failure keeps the previous rows, is recorded in collector status, and never throws.
 * `now` is when the poll started; `clock` is read just before the PR read, to stamp those rows.
 */
export async function collectGithub(
  repo: CcConfig["repos"][number],
  store: Store,
  gql: Gql,
  now: number,
  clock: () => number = () => now,
): Promise<GithubChanges> {
  const failures: string[] = [];
  const changes: GithubChanges = { boards: false, escalations: false };
  let unmapped = 0;
  let truncated: string[] = [];
  try {
    const board = await fetchBoard(repo, gql, now);
    changes.boards = store.replaceBoard(repo.id, board.items);
    unmapped = board.unmapped;
  } catch (e) {
    failures.push(`board: ${errMsg(e)}`);
  }
  try {
    const found = await fetchEscalations(repo, gql);
    changes.escalations = store.replaceEscalations(repo.id, found.escalations);
    truncated = found.truncated;
  } catch (e) {
    failures.push(`escalations: ${errMsg(e)}`);
  }
  try {
    if (store.replaceGoal(repo.id, await fetchGoal(repo, gql))) changes.boards = true;
  } catch (e) {
    failures.push(`goal: ${errMsg(e)}`);
  }
  try {
    // Page 1 only, merged into what the sweep stored; the sweep does the paging and the pruning.
    // Stamped just before the read, not at the poll's start: the board and escalation reads above
    // can take seconds, and a sweep that began in between must not count as newer than this read.
    const readAt = clock();
    if (store.upsertPullRequests(repo.id, (await fetchPrs(repo, gql, now, false)).prs, readAt)) {
      changes.boards = true;
    }
  } catch (e) {
    failures.push(`prs: ${errMsg(e)}`);
  }
  const collector = githubCollector(repo.id);
  if (failures.length > 0) {
    store.setStatus(collector, false, `${failures.join("; ")} at ${new Date(now).toISOString()}`);
  } else {
    const notes = [
      ...(unmapped > 0 ? [`skipped ${unmapped} board item(s) with unmapped status`] : []),
      ...(truncated.length > 0 ? [`truncated: ${truncated.join(", ")} hit the page bound`] : []),
    ];
    store.setStatus(collector, true, notes.length > 0 ? notes.join("; ") : null);
  }
  return changes;
}
