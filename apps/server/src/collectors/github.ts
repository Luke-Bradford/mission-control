import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  BOARD_KEEP_DONE_MS,
  type BoardItem,
  COMMENTS_MAX_PAGES,
  COMMENTS_PAGE_SIZE,
  ciVerdict,
  type Escalation,
  type GithubRateLimit,
  githubCollector,
  inferTicket,
  isObj,
  labelPriority,
  OWNER_FIELD,
  OWNERS,
  type Owner,
  PR_KEEP_MS,
  PR_MAX_PAGES,
  type PrCheck,
  type PullRequestView,
  prSweepCollector,
  RATE_LIMIT_SELECTION,
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
import { observeFlightChecks, observeFlightMain } from "../flight/signals.ts";
import { singleSelectField } from "../github-fields.ts";
import { hasQuestionFence, parseAutonomyQuestion } from "../sd32.ts";
import type { Store } from "../store.ts";
import { str } from "../util.ts";
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
export const HTTP_TIMEOUT_MS = 20_000;
const MAX_BOARD_PAGES = 50;

export type Gql = (query: string, vars: Record<string, unknown>) => Promise<unknown>;

/** What the board reads from a project item; the item list and an issue's own cards share it. */
const ITEM_FIELDS = `
          id
          updatedAt
          ${singleSelectField("status", "Status")}
          ${singleSelectField("priority", "Priority")}
          ${singleSelectField("stage", STAGE_FIELD)}
          ${singleSelectField("owner", OWNER_FIELD)}
          ${singleSelectField("size", SIZE_FIELD)}`;

/** What the board reads from an issue. */
const ISSUE_FIELDS = `
              author { login }
              number title url state updatedAt createdAt labels(first: 20) { nodes { name } }
              assignees(first: 10) { nodes { login } }
              repository { name owner { login } }
              parent { number repository { name } }
              subIssuesSummary { total completed }
              blockedBy(first: 10) { nodes { number state repository { name } } }
              milestone { title }`;

const BOARD_QUERY = `query Board($owner: String!, $number: Int!, $after: String) {
  ${RATE_LIMIT_SELECTION}
  repositoryOwner(login: $owner) {
    __typename
    ... on ProjectV2Owner {
    projectV2(number: $number) {
      id
      url
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ${ITEM_FIELDS}
          content {
            ... on Issue {
              ${ISSUE_FIELDS}
            }
          }
        }
      }
    }
    }
  }
}`;

/** The repo's open issues with their cards, for those the Project's item list leaves out. */
const OPEN_ISSUES_QUERY = `query OpenIssues($owner: String!, $name: String!, $after: String) {
  ${RATE_LIMIT_SELECTION}
  repository(owner: $owner, name: $name) {
    issues(states: OPEN, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        ${ISSUE_FIELDS}
        projectItems(first: 10) {
          nodes {
            project { id number }
            ${ITEM_FIELDS}
          }
        }
      }
    }
  }
}`;

const ISSUE_QUERY = `query Ticket($owner: String!, $name: String!, $number: Int!) {
  ${RATE_LIMIT_SELECTION}
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      number title url state body
      author { login }
      labels(first: 20) { nodes { name } }
      milestone { title }
      subIssues(first: 50) { nodes { number title state repository { name owner { login } } } }
      closedByPullRequestsReferences(first: 10) { nodes { number title url state merged repository { name owner { login } } } }
    }
  }
}`;

const CARD_NOW_QUERY = `query CardNow($owner: String!, $name: String!, $number: Int!) {
  ${RATE_LIMIT_SELECTION}
  repository(owner: $owner, name: $name) {
    issue(number: $number) {
      state
      assignees(first: 10) { nodes { login } }
      projectItems(first: 20) {
        nodes {
          project { number }
          ${singleSelectField("status", "Status")}
        }
      }
    }
  }
}`;

/** A longer issue body is cut here; the pane links to GitHub for the rest. */
export const TICKET_BODY_MAX = 20_000;

/** A PR head's checks read per poll; a required check past them reads as missing. */
export const PR_CHECKS_MAX = 50;
/** The head commit's rollup: its state and each check run or commit status by name. */
export const CHECK_CONTEXTS = `statusCheckRollup { state contexts(first: ${PR_CHECKS_MAX}) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { runAttempt workflow { name } } } } ... on StatusContext { context state targetUrl } } } }`;

/** What the board reads from a pull request; the page query and the one-PR query share it. */
const PR_FIELDS = `
        number title url state isDraft reviewDecision createdAt updatedAt mergedAt headRefName mergeable
        mergeCommit { oid }
        author { login }
        assignees(first: 10) { nodes { login } }
        closingIssuesReferences(first: 100) { nodes { number repository { nameWithOwner } } }
        commits(last: 1) { nodes { commit { oid ${CHECK_CONTEXTS} } } }
      `;

const MAIN_SELECTION = `defaultBranchRef {
      target { ... on Commit { oid committedDate statusCheckRollup { state contexts(first: 10) { nodes { ... on CheckRun { name conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } } } }
    }`;
const prsQuery = (
  observe: boolean,
) => `query PullRequests($owner: String!, $name: String!, $after: String) {
  ${RATE_LIMIT_SELECTION}
  repository(owner: $owner, name: $name) {
    ${observe ? MAIN_SELECTION : ""}
    pullRequests(first: 100, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {${PR_FIELDS}}
    }
  }
}`;

const PR_QUERY = `query PullRequest($owner: String!, $name: String!, $number: Int!) {
  ${RATE_LIMIT_SELECTION}
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PR_FIELDS} } }
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
 * caller may retry a lost request or a 5xx (`isTransient`), never a rate-limited answer.
 */
export class GqlTransportError extends Error {
  readonly status: number | null;
  /** The response's X-GitHub-SSO header (SAML single sign-on), or null. */
  readonly sso: string | null;
  readonly rateLimited: boolean;
  constructor(
    message: string,
    status: number | null,
    sso: string | null = null,
    rateLimited = false,
  ) {
    super(message);
    this.name = "GqlTransportError";
    this.status = status;
    this.sso = sso;
    this.rateLimited = rateLimited;
  }
}

export const isTransient = (e: unknown): boolean =>
  e instanceof GqlTransportError && !e.rateLimited && (e.status === null || e.status >= 500);

/** Read the body separately from parsing so an interrupted response keeps its cause. */
export async function readGithubJson(res: Response): Promise<unknown> {
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (isObj(e) && e.name === "TimeoutError") {
      throw new GqlTransportError(
        `github: response timed out after ${HTTP_TIMEOUT_MS / 1000} s`,
        null,
      );
    }
    throw new GqlTransportError(`github: response cut off (${errMsg(e)})`, null);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `github: response was not JSON (${res.headers.get("content-type") ?? "unknown"})`,
    );
  }
}

/** Starts the one line a token missing a scope gets; the scheduler looks for it to log at start-up. */
export const MISSING_SCOPE_PREFIX = "gh token lacks the ";
/** The scope GitHub asks for when its message does not name one (a board read). */
const DEFAULT_SCOPE = "read:project";
const INSUFFICIENT_SCOPES = "INSUFFICIENT_SCOPES";

/** The missing-scope line inside a health-row status (which may carry other failures and a time), or null. */
export function missingScopeLine(status: string): string | null {
  const i = status.indexOf(MISSING_SCOPE_PREFIX);
  if (i < 0) return null;
  const m = /^[^;]*? scope: run gh auth refresh -s project/.exec(status.slice(i));
  return m?.[0] ?? null;
}

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
    } catch (e) {
      throw new GqlTransportError(
        isObj(e) && e.name === "TimeoutError"
          ? `github: response timed out after ${HTTP_TIMEOUT_MS / 1000} s`
          : "github: request failed",
        null,
      );
    }
    // An exhausted budget answers with no rateLimit block: record it, or the poll never slows.
    if (!res.ok && isRateLimitedResponse(res.status, res.headers)) {
      rates?.record(queryName(query), exhaustedReading(res.headers, now()));
    }
    if (!res.ok) {
      throw new GqlTransportError(
        `github: HTTP ${res.status}`,
        res.status,
        res.headers.get("x-github-sso"),
        isRateLimitedResponse(res.status, res.headers),
      );
    }
    const body = (await readGithubJson(res)) as {
      data?: unknown;
      errors?: { message?: unknown }[];
    };
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
export const ms = (v: unknown): number => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? 0 : t;
};
const names = (v: unknown): string[] =>
  isObj(v) && Array.isArray(v.nodes)
    ? v.nodes.flatMap((n) => (isObj(n) && typeof n.name === "string" ? [n.name] : []))
    : [];
const logins = (v: unknown): string[] =>
  isObj(v) && Array.isArray(v.nodes)
    ? v.nodes.flatMap((n) => (isObj(n) && typeof n.login === "string" ? [n.login] : []))
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
      ? [
          {
            ref: `${str(path(n, "repository", "name"), "")}#${n.number}`,
            closed: n.state === "CLOSED",
          },
        ]
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

/** The one health line for a read GitHub refused for SAML single sign-on; `url` from X-GitHub-SSO. */
export function ssoRefusalText(owner: string, url: string | null): string {
  const head = `the gh token is not authorised for ${owner}'s single sign-on (SAML).`;
  return url !== null
    ? `${head} Authorise it at ${url}`
    : `${head} Authorise the token for ${owner} in GitHub settings (Applications), then run gh auth refresh`;
}

/** That line when `e` is an SSO refusal, else null. */
export function ssoRefusal(e: unknown, owner: string): string | null {
  if (e instanceof GqlTransportError && e.status === 403 && e.sso !== null) {
    return ssoRefusalText(owner, /(?:^|;)\s*url=([^;\s]+)/.exec(e.sso)?.[1] ?? null);
  }
  if (errMsg(e).includes("SAML enforcement")) return ssoRefusalText(owner, null);
  return null;
}

/** Per store, each repo's Project address from its last successful board read. */
const projectUrls = new WeakMap<Store, Map<string, string>>();

/** The Project's address as GitHub last reported it, or null before the first successful board read. */
export function projectUrlOf(store: Store, repoId: string): string | null {
  return projectUrls.get(store)?.get(repoId) ?? null;
}

interface BoardResult {
  /** The Project's address from any page, or null when GitHub sent none. */
  url: string | null;
  items: BoardItem[];
  unmapped: number;
  /** Every item GitHub returned, before any is filtered out. */
  raw: number;
  /** Items read from the open issues' own cards because the item list left them out; in `items`. */
  recovered: number;
}

async function fetchBoard(
  repo: CcConfig["repos"][number],
  gql: Gql,
  now: number,
): Promise<BoardResult> {
  const [owner = "", repoName = ""] = repo.github.split("/");
  const items: BoardItem[] = [];
  // Every issue number the item list returned, mapped or not, so the issues pass skips them all.
  const listed = new Set<number>();
  let unmapped = 0;
  let raw = 0;
  // Any page may carry the project id; it is applied to every item once the pages are read.
  let projectId: string | null = null;
  let projectUrl: string | null = null;
  let after: string | null = null;
  for (let p = 0; p < MAX_BOARD_PAGES; p++) {
    const data = await call(gql, BOARD_QUERY, { owner, number: repo.project, after });
    const conn = path(data, "repositoryOwner", "projectV2", "items");
    if (!isObj(conn) || !Array.isArray(conn.nodes)) {
      throw new Error(`project ${repo.project} not found for ${owner}`);
    }
    const projectNodeId = path(data, "repositoryOwner", "projectV2", "id");
    if (typeof projectNodeId === "string") projectId = projectNodeId;
    const projectNodeUrl = path(data, "repositoryOwner", "projectV2", "url");
    if (typeof projectNodeUrl === "string") projectUrl = projectNodeUrl;
    raw += conn.nodes.length;
    for (const node of conn.nodes) {
      // another repo's card can share a number with an issue of this repo the list left out
      const content = path(node, "content");
      if (
        isObj(content) &&
        typeof content.number === "number" &&
        inRepo(content, owner, repoName)
      ) {
        listed.add(content.number);
      }
      const mapped = boardItem(repo, node, now);
      if (mapped === "unmapped") unmapped++;
      else if (mapped !== null) items.push(mapped);
    }
    const pi = isObj(conn.pageInfo) ? conn.pageInfo : {};
    if (pi.hasNextPage !== true || typeof pi.endCursor !== "string") break;
    if (p === MAX_BOARD_PAGES - 1) throw new Error("project board has too many pages");
    after = pi.endCursor;
  }
  // The item list can be stale (22 Oct: frozen for hours); an issue's own cards are not.
  const recovered: BoardItem[] = [];
  let issueAfter: string | null = null;
  for (let p = 0; p < MAX_BOARD_PAGES; p++) {
    const data = await call(gql, OPEN_ISSUES_QUERY, { owner, name: repoName, after: issueAfter });
    const conn = path(data, "repository", "issues");
    if (!isObj(conn) || !Array.isArray(conn.nodes)) {
      throw new Error(`open issues not found for ${repo.github}`);
    }
    for (const issue of conn.nodes) {
      if (!isObj(issue) || typeof issue.number !== "number" || listed.has(issue.number)) continue;
      const cards = path(issue, "projectItems", "nodes");
      const card = (Array.isArray(cards) ? cards : []).find(
        (n) => isObj(n) && path(n, "project", "number") === repo.project,
      );
      if (!isObj(card)) continue;
      const mapped = boardItem(repo, { ...card, content: issue }, now);
      if (mapped === "unmapped") unmapped++;
      else if (mapped !== null) recovered.push(mapped);
      raw++;
    }
    const pi = isObj(conn.pageInfo) ? conn.pageInfo : {};
    if (pi.hasNextPage !== true || typeof pi.endCursor !== "string") {
      return {
        url: projectUrl,
        items: [...items, ...recovered].map((i) => ({ ...i, projectId })),
        unmapped,
        raw,
        recovered: recovered.length,
      };
    }
    issueAfter = pi.endCursor;
  }
  throw new Error("open issues have too many pages");
}

/** Whether an issue node (with `repository { name owner { login } }`) belongs to owner/repoName. */
const inRepo = (issue: Record<string, unknown>, owner: string, repoName: string): boolean =>
  str(path(issue, "repository", "name"), "").toLowerCase() === repoName.toLowerCase() &&
  str(path(issue, "repository", "owner", "login"), "").toLowerCase() === owner.toLowerCase();

/**
 * One board item from a project item node whose `content` is its issue; null when the node is not
 * an issue of this repo or is a stale done card, "unmapped" when its Status is not mapped.
 */
function boardItem(
  repo: CcConfig["repos"][number],
  node: unknown,
  now: number,
): BoardItem | "unmapped" | null {
  const [owner = "", repoName = ""] = repo.github.split("/");
  if (!isObj(node) || !isObj(node.content) || typeof node.content.number !== "number") return null;
  const c = node.content;
  // a project can hold issues from other repos; their numbers would open the wrong ticket here
  if (!inRepo(c, owner, repoName)) return null;
  const status = singleSelect(node.status);
  const state: TicketState | undefined =
    status !== null && Object.hasOwn(repo.statusMap, status) ? repo.statusMap[status] : undefined;
  // An item with no Status is kept (Backlog); one whose Status is not mapped is skipped.
  if (status !== null && state === undefined) return "unmapped";
  const closed = c.state === "CLOSED";
  const updatedAt = Math.max(ms(node.updatedAt), ms(c.updatedAt));
  if ((closed || state === "done") && now - updatedAt > DONE_VISIBLE_MS) return null;
  const labels = names(c.labels);
  const field = singleSelect(node.priority);
  const fromLabel = field === null ? labelPriority(labels) : null;
  return {
    repoId: repo.id,
    issueNumber: c.number as number,
    ...(typeof path(c, "author", "login") === "string"
      ? { author: str(path(c, "author", "login"), "") }
      : {}),
    title: str(c.title, ""),
    status: status ?? "",
    state: state ?? "planned",
    labels,
    assignees: logins(c.assignees),
    priority: field ?? fromLabel,
    prioritySource: field !== null ? "field" : fromLabel !== null ? "label" : null,
    closed,
    updatedAt,
    createdAt: ms(c.createdAt),
    itemId: typeof node.id === "string" ? node.id : null,
    projectId: null,
    url: str(c.url, ""),
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
        ? str(path(c, "milestone", "title"), "")
        : null,
  };
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
  const chars = Array.from(str(issue.body, ""));
  return {
    number: issue.number,
    ...(typeof path(issue, "author", "login") === "string"
      ? { author: str(path(issue, "author", "login"), "") }
      : {}),
    title: str(issue.title, ""),
    url: str(issue.url, ""),
    state: openClosed(issue.state),
    body: chars.slice(0, TICKET_BODY_MAX).join(""),
    bodyTruncated: chars.length > TICKET_BODY_MAX,
    bodyLength: chars.length,
    labels: names(issue.labels),
    milestone:
      typeof path(issue, "milestone", "title") === "string"
        ? str(path(issue, "milestone", "title"), "")
        : null,
    subIssues: nodes(issue.subIssues).flatMap((n) =>
      typeof n.number === "number"
        ? [
            {
              number: n.number,
              title: str(n.title, ""),
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
              title: str(n.title, ""),
              url: str(n.url, ""),
              state: n.merged === true ? ("merged" as const) : openClosed(n.state),
              repoId: repoIdOf(repos, n),
            },
          ]
        : [],
    ),
  };
}

/** What GitHub says of one card right now: enough to tell whether it is still Ready and unclaimed. */
export type CardNow = Pick<BoardItem, "status" | "state" | "closed" | "assignees">;

/**
 * One issue and its card on the repo's project, read fresh. Null when GitHub has no such issue, the
 * issue is not on the project, or its Status is not one the repo maps (the board skips those too).
 */
export async function fetchCardNow(
  repo: CcConfig["repos"][number],
  number: number,
  gql: Gql,
): Promise<CardNow | null> {
  const [owner = "", name = ""] = repo.github.split("/");
  let data: unknown;
  try {
    data = await call(gql, CARD_NOW_QUERY, { owner, name, number });
  } catch (e) {
    if (/could not resolve to an issue/i.test(errMsg(e))) return null;
    throw e;
  }
  const issue = path(data, "repository", "issue");
  if (!isObj(issue)) return null;
  const items = path(issue, "projectItems", "nodes");
  const onProject = Array.isArray(items)
    ? items.find((i) => isObj(i) && path(i, "project", "number") === repo.project)
    : undefined;
  if (!isObj(onProject)) return null;
  const status = singleSelect(onProject.status);
  const state: TicketState | undefined =
    status !== null && Object.hasOwn(repo.statusMap, status) ? repo.statusMap[status] : undefined;
  if (status !== null && state === undefined) return null;
  return {
    status: status ?? "",
    state: state ?? "planned",
    closed: issue.state === "CLOSED",
    assignees: logins(issue.assignees),
  };
}

const quote = (s: string) => `"${s.replace(/["\\]/g, "")}"`;

type RawComment = { body: string; createdAt: string };

const rawComments = (conn: unknown): RawComment[] =>
  isObj(conn) && Array.isArray(conn.nodes)
    ? conn.nodes.flatMap((c) =>
        isObj(c) && typeof c.body === "string"
          ? [{ body: c.body, createdAt: str(c.createdAt, "") }]
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
    const title = str(n.title, "");
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
      url: str(n.url, ""),
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

const PASSING_CONCLUSIONS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** A PR head's checks by name, from its `statusCheckRollup`: check runs and commit statuses. */
export function parseChecks(rollup: unknown): PrCheck[] {
  const nodes = path(rollup, "contexts", "nodes");
  if (!Array.isArray(nodes)) return [];
  const out: PrCheck[] = [];
  for (const n of nodes) {
    if (!isObj(n)) continue;
    if (n.__typename === "CheckRun") {
      const name = str(n.name, "");
      if (name === "") continue;
      const attempt = path(n, "checkSuite", "workflowRun", "runAttempt");
      out.push({
        name,
        ...(typeof path(n, "checkSuite", "workflowRun", "workflow", "name") === "string"
          ? { workflow: path(n, "checkSuite", "workflowRun", "workflow", "name") as string }
          : {}),
        kind: "check",
        state:
          n.status !== "COMPLETED"
            ? "pending"
            : PASSING_CONCLUSIONS.has(str(n.conclusion, ""))
              ? "passing"
              : "failing",
        conclusion: str(n.conclusion, "") || str(n.status, ""),
        attempt: typeof attempt === "number" ? attempt : null,
        url: str(n.detailsUrl, "") || null,
      });
    } else if (n.__typename === "StatusContext") {
      const name = str(n.context, "");
      if (name === "") continue;
      out.push({
        name,
        kind: "status",
        state: lookup(CHECKS, n.state) ?? "pending",
        conclusion: str(n.state, ""),
        attempt: null,
        url: str(n.targetUrl, "") || null,
      });
    }
  }
  return out;
}

function mapPr(
  repo: CcConfig["repos"][number],
  n: Record<string, unknown>,
): PullRequestView | null {
  if (typeof n.number !== "number") return null;
  const branch = str(n.headRefName, "");
  const closing = path(n, "closingIssuesReferences", "nodes");
  const closingIssues = Array.isArray(closing)
    ? closing.flatMap((issue) =>
        isObj(issue) &&
        typeof issue.number === "number" &&
        str(path(issue, "repository", "nameWithOwner"), "").toLowerCase() ===
          repo.github.toLowerCase()
          ? [issue.number]
          : [],
      )
    : [];
  const first = closingIssues[0];
  const rollup = path(n, "commits", "nodes");
  const last = Array.isArray(rollup) ? rollup[0] : undefined;
  const headOid = path(last, "commit", "oid");
  const checks = parseChecks(path(last, "commit", "statusCheckRollup"));
  return {
    repoId: repo.id,
    number: n.number,
    title: str(n.title, ""),
    url: str(n.url, ""),
    branch,
    // The loops name the ticket in the branch and almost never write "Closes #n".
    ticket:
      inferTicket(branch, repo.id) ?? (typeof first === "number" ? `${repo.id}#${first}` : null),
    closingIssues,
    state: lookup(PR_STATES, n.state) ?? "closed",
    isDraft: n.isDraft === true,
    review: lookup(REVIEWS, n.reviewDecision),
    ci: ciVerdict(checks, repo.requiredChecks ?? []).ci,
    checks,
    createdAt: ms(n.createdAt),
    updatedAt: ms(n.updatedAt),
    mergedAt: typeof n.mergedAt === "string" ? ms(n.mergedAt) : null,
    mergeCommitSha: str(path(n, "mergeCommit", "oid"), "") || null,
    headSha: typeof headOid === "string" && headOid !== "" ? headOid : null,
    mergeable: lookup(MERGEABLE, n.mergeable),
    author: str(path(n, "author", "login"), "") || null,
    assignees: logins(n.assignees),
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
  store: Store,
  observe: boolean,
): Promise<{ prs: PullRequestView[]; nodes: number }> {
  const [owner = "", name = ""] = repo.github.split("/");
  const out: PullRequestView[] = [];
  let nodes = 0;
  let after: string | null = null;
  for (let p = 0; p < (all ? PR_MAX_PAGES : 1); p++) {
    const data = await call(gql, prsQuery(observe && p === 0), { owner, name, after });
    if (observe && p === 0) {
      const head = path(data, "repository", "defaultBranchRef", "target");
      const sha = path(head, "oid");
      if (typeof sha === "string" && sha !== "") {
        observeFlightMain(store, repo.id, {
          sha,
          ci: lookup(CHECKS, path(head, "statusCheckRollup", "state")),
          at: now,
          committedAt:
            typeof path(head, "committedDate") === "string"
              ? Date.parse(path(head, "committedDate") as string)
              : undefined,
          checks: mainFailures(path(head, "statusCheckRollup", "contexts", "nodes")),
        });
      }
    }
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
  if (observe) observeFlightChecks(store, repo.id, out, now);
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
  observe = false,
): Promise<GithubChanges> {
  const collector = prSweepCollector(repo.id);
  let boards = false;
  try {
    const read = () => fetchPrs(repo, gql, now, true, store, observe);
    const { prs, nodes } = await read().catch(async (e: unknown) => {
      if (!isTransient(e)) throw e;
      await new Promise((resolve) => setTimeout(resolve, 15_000));
      return read();
    });
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
 * Re-reads only the PRs the engine waits on (CI, a merge), one query each, merged into the stored
 * rows. A failure keeps what was read so far, marks the repo's collector with `prs:`; it never throws.
 * A success leaves the status alone: the next board read rewrites it.
 */
export async function collectWaitedPrs(
  repo: CcConfig["repos"][number],
  store: Store,
  gql: Gql,
  numbers: number[],
  clock: () => number,
  observe = false,
): Promise<GithubChanges> {
  const [owner = "", name = ""] = repo.github.split("/");
  const readAt = clock();
  const prs: PullRequestView[] = [];
  let failure: string | null = null;
  try {
    for (const number of numbers) {
      const node = path(
        await call(gql, PR_QUERY, { owner, name, number }),
        "repository",
        "pullRequest",
      );
      const pr = isObj(node) ? mapPr(repo, node) : null;
      if (pr) prs.push(pr);
    }
  } catch (e) {
    failure = errMsg(e);
  }
  if (observe) observeFlightChecks(store, repo.id, prs, readAt);
  const boards = prs.length > 0 && store.upsertPullRequests(repo.id, prs, readAt);
  if (failure !== null) {
    store.setStatus(
      githubCollector(repo.id),
      false,
      `prs: ${failure} at ${new Date(clock()).toISOString()}`,
    );
  }
  return { boards, escalations: false };
}

/**
 * How long a board that had cards is kept while every board read comes back with no items. GitHub's
 * project reads can flap between full and empty while it is degraded (22 Oct: one in six full).
 */
export const EMPTY_BOARD_GRACE_MS = 15 * 60_000;
/** Per store, when each repo's board reads started coming back empty over a board that had cards. */
const emptyBoards = new WeakMap<Store, Map<string, number>>();

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
  observe = false,
): Promise<GithubChanges> {
  const failures: string[] = [];
  const changes: GithubChanges = { boards: false, escalations: false };
  let unmapped = 0;
  let recovered = 0;
  let truncated: string[] = [];
  try {
    const board = await fetchBoard(repo, gql, now);
    if (board.url !== null) {
      const urls = projectUrls.get(store) ?? new Map<string, string>();
      projectUrls.set(store, urls);
      urls.set(repo.id, board.url);
    }
    // GitHub can answer a board read with no items while it is degraded. Over a board that had
    // cards, empty answers keep the board and say so until they have lasted EMPTY_BOARD_GRACE_MS.
    const empties = emptyBoards.get(store) ?? new Map<string, number>();
    emptyBoards.set(store, empties);
    const kept = store.board(repo.id).length;
    const since = empties.get(repo.id) ?? now;
    if (board.raw === 0 && kept > 0 && now - since < EMPTY_BOARD_GRACE_MS) {
      empties.set(repo.id, since);
      failures.push(`board: board poll returned no items; kept the last board (${kept})`);
    } else {
      empties.delete(repo.id);
      changes.boards = store.replaceBoard(repo.id, board.items);
      unmapped = board.unmapped;
      recovered = board.recovered;
    }
  } catch (e) {
    const [owner = ""] = repo.github.split("/");
    failures.push(`board: ${ssoRefusal(e, owner) ?? errMsg(e)}`);
  }
  try {
    const found = await fetchEscalations(repo, gql);
    changes.escalations = store.replaceEscalations(repo.id, found.escalations);
    truncated = found.truncated;
  } catch (e) {
    failures.push(`escalations: ${errMsg(e)}`);
  }
  try {
    // Page 1 only, merged into what the sweep stored; the sweep does the paging and the pruning.
    // Stamped just before the read, not at the poll's start: the board and escalation reads above
    // can take seconds, and a sweep that began in between must not count as newer than this read.
    const readAt = clock();
    if (
      store.upsertPullRequests(
        repo.id,
        (await fetchPrs(repo, gql, readAt, false, store, observe)).prs,
        readAt,
      )
    ) {
      changes.boards = true;
    }
  } catch (e) {
    // Keep the rows, but say they are the last good read.
    store.markPullRequestsStale(repo.id);
    failures.push(`prs: ${errMsg(e)}`);
  }
  const collector = githubCollector(repo.id);
  if (failures.length > 0) {
    store.setStatus(collector, false, `${failures.join("; ")} at ${new Date(now).toISOString()}`);
  } else {
    const notes = [
      ...(unmapped > 0 ? [`skipped ${unmapped} board item(s) with unmapped status`] : []),
      ...(recovered > 0
        ? [`project list missed ${recovered} items; read them from the issues`]
        : []),
      ...(truncated.length > 0 ? [`truncated: ${truncated.join(", ")} hit the page bound`] : []),
    ];
    store.setStatus(collector, true, notes.length > 0 ? notes.join("; ") : null);
  }
  return changes;
}

export { isObj } from "@mc/core";

/** The default branch query deliberately fetches only the evidence needed by FLIGHT. */
function mainFailures(nodes: unknown): { name: string; url: string | null }[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.flatMap((node) => {
    if (!isObj(node)) return [];
    if (
      typeof node.name === "string" &&
      typeof node.conclusion === "string" &&
      ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(
        node.conclusion,
      )
    ) {
      return [{ name: node.name, url: str(node.detailsUrl, "") || null }];
    }
    if (typeof node.context === "string" && ["FAILURE", "ERROR"].includes(str(node.state, ""))) {
      return [{ name: node.context, url: str(node.targetUrl, "") || null }];
    }
    return [];
  });
}
