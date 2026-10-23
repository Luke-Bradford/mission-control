import { type BoardItem, columnOf, hudColumnOf } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  call,
  collectGithub,
  describeGqlErrors,
  EMPTY_BOARD_GRACE_MS,
  fetchCardNow,
  fetchTicket,
  GqlError,
  GqlTransportError,
  isTransient,
  makeGql,
  missingScopeLine,
  projectUrlOf,
  sweepPullRequests,
} from "../src/collectors/github.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const DAY = 86_400_000;
const repo: CcConfig["repos"][number] = {
  id: "shop-app",
  github: "octo-org/shop-app",
  project: 2,
  statusMap: { Todo: "planned", "In Progress": "in progress", Done: "done" },
  autonomy: "draft",
};

const Q = {
  question: "Ship it?",
  recommendation: "yes",
  reasoning_quote: "because",
  effort_sunk: "2 sessions",
  default_if_ignored: "hold",
  answers: ["yes", "no"],
};

function item(
  n: number,
  status: string | null,
  o: {
    priority?: string;
    updatedAt?: string;
    labels?: string[];
    content?: boolean;
    stage?: string;
    owner?: string;
    issueState?: string;
    extra?: Record<string, unknown>;
  } = {},
) {
  return {
    id: `PVTI_${n}`,
    updatedAt: o.updatedAt ?? "2026-10-16T00:00:00Z",
    status: status === null ? null : { name: status },
    priority: o.priority === undefined ? null : { name: o.priority },
    stage: o.stage === undefined ? null : { name: o.stage },
    owner: o.owner === undefined ? null : { name: o.owner },
    content:
      o.content === false
        ? {}
        : {
            number: n,
            title: `issue ${n}`,
            url: `https://github.com/octo-org/shop-app/issues/${n}`,
            state: o.issueState ?? "OPEN",
            updatedAt: o.updatedAt ?? "2026-10-16T00:00:00Z",
            createdAt: "2026-10-01T00:00:00Z",
            labels: { nodes: (o.labels ?? []).map((name) => ({ name })) },
            repository: { name: "shop-app", owner: { login: "octo-org" } },
            ...o.extra,
          },
  };
}

describe("fetchCardNow", () => {
  const answer =
    (issue: unknown): Gql =>
    async () => ({ repository: { issue } });
  const onProject = (status: string | null, number = repo.project) => ({
    state: "OPEN",
    assignees: { nodes: [{ login: "luke" }] },
    projectItems: {
      nodes: [{ project: { number }, status: status === null ? null : { name: status } }],
    },
  });

  it("reads the Status, the issue state and the assignees of the card on the repo's project", async () => {
    expect(await fetchCardNow(repo, 7, answer(onProject("Todo")))).toEqual({
      status: "Todo",
      state: "planned",
      closed: false,
      assignees: ["luke"],
    });
  });

  it("is null for a missing issue, a card on another project, or an unmapped Status", async () => {
    expect(await fetchCardNow(repo, 7, answer(null))).toBeNull();
    expect(await fetchCardNow(repo, 7, answer(onProject("Todo", 99)))).toBeNull();
    expect(await fetchCardNow(repo, 7, answer(onProject("Parked")))).toBeNull();
  });
});

describe("fetchTicket repos", () => {
  const other: CcConfig["repos"][number] = {
    id: "site-builder",
    github: "octo-org/Site-Builder",
    project: 3,
    statusMap: {},
    autonomy: "draft",
  };
  const at = (owner: string, name: string) => ({ name, owner: { login: owner } });
  const gqlWith =
    (issueNode: unknown): Gql =>
    async () => ({ repository: { issue: issueNode } });

  it("maps a cross-repo sub-issue and PR to their configured repo, else null", async () => {
    const gql = gqlWith({
      number: 5,
      title: "t",
      url: "u",
      state: "OPEN",
      body: "",
      subIssues: {
        nodes: [
          { number: 6, title: "same", state: "OPEN", repository: at("octo-org", "shop-app") },
          // case differs from the config, as GitHub's login casing may
          {
            number: 2,
            title: "cross",
            state: "OPEN",
            repository: at("Octo-Org", "site-builder"),
          },
          { number: 9, title: "unconfigured", state: "OPEN", repository: at("someone", "else") },
          { number: 10, title: "unknown", state: "OPEN" },
        ],
      },
      closedByPullRequestsReferences: {
        nodes: [
          {
            number: 30,
            title: "p",
            url: "u",
            state: "OPEN",
            repository: at("octo-org", "Site-Builder"),
          },
          { number: 31, title: "q", url: "u", state: "OPEN", repository: at("someone", "else") },
        ],
      },
    });
    const t = await fetchTicket(repo, 5, gql, [repo, other]);
    expect(t?.subIssues.map((s) => [s.number, s.repoId])).toEqual([
      [6, "shop-app"],
      [2, "site-builder"],
      [9, null],
      [10, null],
    ]);
    expect(t?.pullRequests.map((p) => [p.number, p.repoId])).toEqual([
      [30, "site-builder"],
      [31, null],
    ]);
  });

  it("asks GitHub for each item's repository", async () => {
    let query = "";
    await fetchTicket(repo, 5, async (q) => {
      query = q;
      return { repository: { issue: null } };
    });
    expect(query).toMatch(
      /subIssues\([^)]*\) \{ nodes \{[^}]*repository \{ name owner \{ login \} \}/,
    );
    expect(query).toMatch(
      /closedByPullRequestsReferences\([^)]*\) \{ nodes \{[^}]*repository \{ name owner \{ login \} \}/,
    );
  });
});

function issue(n: number, title: string, labels: string[], comments: unknown[] = []) {
  return {
    number: n,
    title,
    url: `https://github.com/octo-org/shop-app/issues/${n}`,
    createdAt: "2026-10-05T10:00:00Z",
    labels: { nodes: labels.map((name) => ({ name })) },
    comments: { nodes: comments },
  };
}

function pull(n: number, o: Record<string, unknown> = {}) {
  return {
    number: n,
    title: `pr ${n}`,
    url: `https://github.com/octo-org/shop-app/pull/${n}`,
    state: "OPEN",
    isDraft: false,
    reviewDecision: null,
    createdAt: "2026-10-16T00:00:00Z",
    updatedAt: "2026-10-16T01:00:00Z",
    mergedAt: null,
    headRefName: `fix/${n}-thing`,
    closingIssuesReferences: { nodes: [] },
    mergeable: "MERGEABLE",
    commits: {
      nodes: [{ commit: { oid: `${n}`.repeat(40), statusCheckRollup: { state: "SUCCESS" } } }],
    },
    ...o,
  };
}

const prPage = (nodes: unknown[], next: string | null = null) => ({
  repository: {
    pullRequests: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes },
  },
});

const page = (nodes: unknown[], next: string | null = null, typename = "User") => ({
  repositoryOwner: {
    __typename: typename,
    projectV2: {
      id: "PVT_1",
      url: "https://github.com/users/octo/projects/2",
      items: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes },
    },
  },
});

type Gql = (q: string, v: Record<string, unknown>) => Promise<unknown>;
interface Call {
  q: string;
  v: Record<string, unknown>;
}

/** Routes by whether the document is the board or the search query. */
function stub(opts: {
  pages?: unknown[];
  /** The repo's open issues, each with its own project cards. */
  issues?: unknown[];
  /** The open issues page by page; overrides `issues`. */
  issuePages?: unknown[][];
  search?: (v: Record<string, unknown>) => unknown[];
  boardError?: Error;
  searchError?: Error;
  milestones?: unknown[];
  milestoneError?: Error;
  prPages?: unknown[];
  prError?: Error;
}) {
  const calls: Call[] = [];
  let p = 0;
  let pr = 0;
  let ip = 0;
  const gql: Gql = async (q, v) => {
    calls.push({ q, v });
    if (q.includes("pullRequests")) {
      if (opts.prError) throw opts.prError;
      return opts.prPages?.[pr++] ?? prPage([]);
    }
    if (q.includes("projectV2")) {
      if (opts.boardError) throw opts.boardError;
      return opts.pages?.[p++] ?? page([]);
    }
    if (q.includes("OpenIssues")) {
      const nodes = opts.issuePages?.[ip] ?? opts.issues ?? [];
      const more = opts.issuePages !== undefined && ip < opts.issuePages.length - 1;
      ip++;
      return {
        repository: {
          issues: { pageInfo: { hasNextPage: more, endCursor: more ? `ic${ip}` : null }, nodes },
        },
      };
    }
    if (q.includes("milestones")) {
      if (opts.milestoneError) throw opts.milestoneError;
      return { repository: { milestones: { nodes: opts.milestones ?? [] } } };
    }
    if (opts.searchError) throw opts.searchError;
    return { search: { nodes: opts.search?.(v) ?? [] } };
  };
  return { gql, calls };
}

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

const statusOf = () => store.status().find((s) => s.collector === "github:shop-app");

describe("collectGithub board, an empty answer", () => {
  const full = () => stub({ pages: [page([item(1, "Todo"), item(2, "Todo")])] }).gql;
  const empty = () => stub({ pages: [page([])] }).gql;
  const MIN = 60_000;

  it("keeps the last board for an empty poll and marks the row not ok", async () => {
    await collectGithub(repo, store, full(), NOW);
    await collectGithub(repo, store, empty(), NOW + MIN);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([1, 2]);
    expect(statusOf()?.ok).toBe(false);
    expect(statusOf()?.error).toContain("board poll returned no items; kept the last board (2)");
  });

  it("keeps it through empty answers that flap, for up to the grace period", async () => {
    await collectGithub(repo, store, full(), NOW);
    await collectGithub(repo, store, empty(), NOW + MIN);
    await collectGithub(repo, store, empty(), NOW + 2 * MIN);
    await collectGithub(repo, store, stub({ boardError: new Error("boom") }).gql, NOW + 3 * MIN);
    await collectGithub(repo, store, empty(), NOW + MIN + EMPTY_BOARD_GRACE_MS - 1);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([1, 2]);
  });

  it("believes empty answers once they have lasted the grace period", async () => {
    await collectGithub(repo, store, full(), NOW);
    await collectGithub(repo, store, empty(), NOW + MIN);
    await collectGithub(repo, store, empty(), NOW + MIN + EMPTY_BOARD_GRACE_MS);
    expect(store.board("shop-app")).toEqual([]);
    expect(statusOf()).toMatchObject({ ok: true, error: null });
  });

  it("stores at once a poll whose items are all filtered out (GitHub did answer)", async () => {
    await collectGithub(repo, store, full(), NOW);
    await collectGithub(repo, store, stub({ pages: [page([item(4, "Weird")])] }).gql, NOW + MIN);
    expect(store.board("shop-app")).toEqual([]);
  });

  it("stores a full poll after empty ones, and starts the grace period afresh", async () => {
    await collectGithub(repo, store, full(), NOW);
    await collectGithub(repo, store, empty(), NOW + MIN);
    await collectGithub(repo, store, stub({ pages: [page([item(3, "Todo")])] }).gql, NOW + 2 * MIN);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([3]);
    expect(statusOf()).toMatchObject({ ok: true, error: null });
    await collectGithub(repo, store, empty(), NOW + 2 * MIN + EMPTY_BOARD_GRACE_MS - 1);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([3]);
  });
});

describe("collectGithub board, a stale project item list", () => {
  /** An open issue as the issues query returns it, with cards on the given projects. */
  const issue = (n: number, cards: { project: number; status: string | null }[]) => ({
    ...item(n, null).content,
    projectItems: {
      nodes: cards.map((c) => ({
        ...item(n, c.status, { priority: "P1" }),
        content: undefined,
        project: { id: `PVT_${c.project}`, number: c.project },
      })),
    },
  });
  const MISSED = "project list missed 1 items; read them from the issues";

  it("puts an issue the item list left out on the board with its Status", async () => {
    const { gql } = stub({
      pages: [page([item(1, "Todo")])],
      issues: [
        issue(1, [{ project: 2, status: "Todo" }]),
        issue(5, [{ project: 2, status: "In Progress" }]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    const added = store.board("shop-app").find((i) => i.issueNumber === 5);
    expect(added).toMatchObject({ status: "In Progress", state: "in progress", priority: "P1" });
    expect(added?.itemId).toBe("PVTI_5");
    expect(statusOf()).toMatchObject({ ok: true, error: MISSED });
  });

  it("leaves out an issue whose cards are all on another project", async () => {
    const { gql } = stub({
      pages: [page([item(1, "Todo")])],
      issues: [issue(6, [{ project: 9, status: "Todo" }]), issue(7, [])],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([1]);
  });

  it("adds nothing twice when both sources return an issue, and says nothing", async () => {
    const { gql } = stub({
      pages: [page([item(1, "Todo"), item(2, "Todo")])],
      issues: [
        issue(1, [{ project: 2, status: "Todo" }]),
        issue(2, [{ project: 2, status: "Todo" }]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([1, 2]);
    expect(statusOf()).toMatchObject({ ok: true, error: null });
  });

  it("recovers an issue whose number another repo's card on the list shares", async () => {
    const { gql } = stub({
      pages: [
        page([
          item(1, "Todo"),
          item(5, "Todo", {
            extra: { repository: { name: "other", owner: { login: "octo-org" } } },
          }),
        ]),
      ],
      issues: [issue(5, [{ project: 2, status: "Todo" }])],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([1, 5]);
  });

  it("pages the open issues by cursor", async () => {
    const { gql, calls } = stub({
      pages: [page([item(1, "Todo")])],
      issuePages: [
        [issue(5, [{ project: 2, status: "Todo" }])],
        [issue(6, [{ project: 2, status: "Todo" }])],
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([1, 5, 6]);
    expect(calls.filter((c) => c.q.includes("OpenIssues")).map((c) => c.v.after)).toEqual([
      null,
      "ic1",
    ]);
  });

  it("counts an unmapped item once when both sources return it", async () => {
    const { gql } = stub({
      pages: [page([item(1, "Weird")])],
      issues: [issue(1, [{ project: 2, status: "Weird" }])],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(statusOf()?.error).toBe("skipped 1 board item(s) with unmapped status");
  });

  it("counts recovered items towards the empty-board guard", async () => {
    await collectGithub(repo, store, stub({ pages: [page([item(1, "Todo")])] }).gql, NOW);
    const { gql } = stub({
      pages: [page([])],
      issues: [issue(5, [{ project: 2, status: "Todo" }])],
    });
    await collectGithub(repo, store, gql, NOW + 60_000);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([5]);
  });
});

describe("collectGithub board", () => {
  it("maps status via statusMap, priority from the Priority field, and keeps labels", async () => {
    const { gql } = stub({
      pages: [page([item(1, "In Progress", { priority: "P1", labels: ["bug"] }), item(2, "Todo")])],
    });
    await collectGithub(repo, store, gql, NOW);
    const b = store.board("shop-app");
    expect(b.map((i) => i.issueNumber).sort()).toEqual([1, 2]);
    const one = b.find((i) => i.issueNumber === 1);
    expect(one).toMatchObject({
      repoId: "shop-app",
      title: "issue 1",
      status: "In Progress",
      state: "in progress",
      labels: ["bug"],
      priority: "P1",
      updatedAt: Date.parse("2026-10-16T00:00:00Z"),
    });
    expect(b.find((i) => i.issueNumber === 2)?.priority).toBeNull();
    expect(statusOf()).toMatchObject({ ok: true, error: null });
  });

  it("skips unmapped status and non-issue content, counts only unmapped, keeps no-Status issues", async () => {
    const { gql } = stub({
      pages: [
        page([
          item(1, "Todo"),
          item(2, "Weird"),
          item(3, null),
          item(4, "Todo", { content: false }),
        ]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    const b = store.board("shop-app");
    expect(b.map((i) => i.issueNumber)).toEqual([1, 3]);
    expect(b.find((i) => i.issueNumber === 3)).toMatchObject({
      status: "",
      state: "planned",
      closed: false,
    });
    expect(hudColumnOf(b.find((i) => i.issueNumber === 3) as BoardItem)).toBe("Backlog");
    const s = statusOf();
    expect(s?.ok).toBe(true);
    expect(s?.error).toContain("skipped 1");
    expect(s?.error).toContain("unmapped");
  });

  it("keeps a closed issue only while it is recent, and marks it closed", async () => {
    const { gql } = stub({
      pages: [
        page([
          item(1, "In Progress", {
            issueState: "CLOSED",
            updatedAt: new Date(NOW - 2 * DAY).toISOString(),
          }),
          item(2, "In Progress", {
            issueState: "CLOSED",
            updatedAt: new Date(NOW - 40 * DAY).toISOString(),
          }),
          item(3, "In Progress"),
        ]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    const b = store.board("shop-app");
    expect(b.map((i) => [i.issueNumber, i.closed])).toEqual([
      [1, true],
      [3, false],
    ]);
    expect(hudColumnOf(b[0] as BoardItem)).toBe("Done");
  });

  it("priority: the field wins over a label; a label fills in when the field is unset", async () => {
    const { gql } = stub({
      pages: [
        page([
          item(1, "Todo", { priority: "P1", labels: ["p3"] }),
          item(2, "Todo", { labels: ["bug", "p2"] }),
          item(3, "Todo", { labels: ["p7"] }),
        ]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    const by = (n: number) => store.board("shop-app").find((i) => i.issueNumber === n);
    expect(by(1)).toMatchObject({ priority: "P1", prioritySource: "field" });
    expect(by(2)).toMatchObject({ priority: "P2", prioritySource: "label" });
    expect(by(3)).toMatchObject({ priority: null, prioritySource: null });
  });

  it("keeps done items updated within 30 days, drops older done, keeps open old items", async () => {
    const recent = new Date(NOW - 29 * DAY).toISOString();
    const old = new Date(NOW - 31 * DAY).toISOString();
    const { gql } = stub({
      pages: [
        page([
          item(1, "Done", { updatedAt: recent }),
          item(2, "Done", { updatedAt: old }),
          item(3, "Todo", { updatedAt: old }),
        ]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(
      store
        .board("shop-app")
        .map((i) => i.issueNumber)
        .sort(),
    ).toEqual([1, 3]);
  });

  it("paginates with first 100 and after cursor until done", async () => {
    const { gql, calls } = stub({
      pages: [
        page([item(1, "Todo")], "CUR1"),
        page([item(2, "Todo")], "CUR2"),
        page([item(3, "Todo")]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    const boardCalls = calls.filter((c) => c.q.includes("projectV2"));
    expect(boardCalls.map((c) => c.v.after ?? null)).toEqual([null, "CUR1", "CUR2"]);
    expect(boardCalls[0]?.v).toMatchObject({ owner: "octo-org", number: 2 });
    expect(boardCalls[0]?.q).toContain("first: 100");
    expect(store.board("shop-app")).toHaveLength(3);
  });
});

describe("collectGithub board ids", () => {
  it("stores each item's created time, project item id and the project id", async () => {
    const { gql } = stub({ pages: [page([item(1, "Todo"), item(2, null)])] });
    await collectGithub(repo, store, gql, NOW);
    const by = new Map(store.board("shop-app").map((i) => [i.issueNumber, i]));
    expect(by.get(1)).toMatchObject({
      createdAt: Date.parse("2026-10-01T00:00:00Z"),
      itemId: "PVTI_1",
      projectId: "PVT_1",
    });
    expect(by.get(2)).toMatchObject({ itemId: "PVTI_2", projectId: "PVT_1" });
  });

  it("takes the project id from any page and applies it to every item", async () => {
    const first = page([item(1, "Todo")], "c1");
    // the first page carries no project id; the second does
    const noId = {
      repositoryOwner: { projectV2: { items: first.repositoryOwner.projectV2.items } },
    };
    const { gql } = stub({ pages: [noId, page([item(2, "Todo")])] });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app").map((i) => [i.issueNumber, i.projectId])).toEqual([
      [1, "PVT_1"],
      [2, "PVT_1"],
    ]);
  });

  it("asks GitHub for the project id and each item's id", async () => {
    const { gql, calls } = stub({ pages: [page([])] });
    await collectGithub(repo, store, gql, NOW);
    const q = calls.find((c) => c.q.includes("projectV2"))?.q ?? "";
    expect(q).toMatch(/projectV2\(number: \$number\) \{\s*id\b/);
    expect(q).toMatch(/nodes \{\s*id\b/);
  });

  it("reads an organisation's project", async () => {
    const { gql } = stub({ pages: [page([item(1, "Todo")], null, "Organization")] });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([1]);
    expect(statusOf()).toMatchObject({ ok: true, error: null });
  });

  it("reads a user's project", async () => {
    const { gql } = stub({ pages: [page([item(1, "Todo")], null, "User")] });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([1]);
    expect(statusOf()).toMatchObject({ ok: true, error: null });
  });

  it("asks repositoryOwner for the project and its url", async () => {
    const { gql, calls } = stub({ pages: [page([])] });
    await collectGithub(repo, store, gql, NOW);
    const q = calls.find((c) => c.q.includes("projectV2"))?.q ?? "";
    expect(q).toContain("repositoryOwner(login:");
    expect(q).toContain("... on ProjectV2Owner");
    expect(q).toMatch(/projectV2\(number: \$number\) \{\s*id\s+url\b/);
    expect(q).not.toContain("user(login");
  });
});

describe("projectUrlOf", () => {
  it("is null before a read, the last read's url after, and kept when a poll fails", async () => {
    expect(projectUrlOf(store, "shop-app")).toBeNull();
    await collectGithub(repo, store, stub({ pages: [page([item(1, "Todo")])] }).gql, NOW);
    expect(projectUrlOf(store, "shop-app")).toBe("https://github.com/users/octo/projects/2");
    await collectGithub(repo, store, stub({ boardError: new Error("x") }).gql, NOW + 1);
    expect(projectUrlOf(store, "shop-app")).toBe("https://github.com/users/octo/projects/2");
  });
});

describe("collectGithub board, SAML single sign-on", () => {
  const SSO = "required; url=https://github.com/orgs/octo-org/sso?authorization_request=x";
  const fetchWith = (status: number, headers: Record<string, string>, body: unknown = {}) =>
    (async () =>
      new Response(JSON.stringify(body), { status, headers })) as unknown as typeof fetch;
  const run = async (f: typeof fetch) => {
    await collectGithub(repo, store, makeGql("t", f), NOW);
    return statusOf()?.error ?? "";
  };

  it("names a 403 with X-GitHub-SSO and its url", async () => {
    const e = await run(fetchWith(403, { "X-GitHub-SSO": SSO }));
    expect(e).toContain(
      "board: the gh token is not authorised for octo-org's single sign-on (SAML). Authorise it at https://github.com/orgs/octo-org/sso?authorization_request=x",
    );
    expect(e.split("; escalations:")[0]).not.toContain("HTTP 403");
  });

  it("names a GraphQL SAML enforcement error, without a url", async () => {
    const e = await run(
      fetchWith(
        200,
        {},
        {
          errors: [
            {
              type: "FORBIDDEN",
              message:
                "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.",
            },
          ],
        },
      ),
    );
    expect(e).toContain(
      "board: the gh token is not authorised for octo-org's single sign-on (SAML). Authorise the token for octo-org in GitHub settings (Applications), then run gh auth refresh",
    );
  });

  it("keeps other failures' text", async () => {
    expect(await run(fetchWith(403, {}))).toContain("board: github: HTTP 403");
    await collectGithub(repo, store, stub({ boardError: new Error("board boom") }).gql, NOW);
    expect(statusOf()?.error).toContain("board: board boom");
  });

  it("keeps the header on GqlTransportError", async () => {
    const err = await makeGql("t", fetchWith(403, { "X-GitHub-SSO": SSO }))("q", {}).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GqlTransportError);
    expect((err as GqlTransportError).sso).toBe(SSO);
    const plain = await makeGql("t", fetchWith(401, {}))("q", {}).catch((e: unknown) => e);
    expect((plain as GqlTransportError).sso).toBeNull();
  });
});

describe("collectGithub board fields", () => {
  it("maps Stage, Owner, parent, sub-issues, blockers and milestone", async () => {
    const { gql } = stub({
      pages: [
        page([
          item(1, "Todo", {
            stage: "Needs detail",
            owner: "PM",
            extra: {
              parent: { number: 9, repository: { name: "shop-app" } },
              subIssuesSummary: { total: 4, completed: 1 },
              blockedBy: {
                nodes: [
                  { number: 12, state: "OPEN", repository: { name: "otherRepo" } },
                  { number: 3, state: "CLOSED", repository: { name: "shop-app" } },
                ],
              },
              milestone: { title: "MVP" },
            },
          }),
        ]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app")[0]).toMatchObject({
      stage: "Needs detail",
      owner: "PM",
      parent: 9,
      subIssues: { done: 1, total: 4 },
      blockedBy: [
        { ref: "otherRepo#12", closed: false },
        { ref: "shop-app#3", closed: true },
      ],
      milestone: "MVP",
    });
  });

  it("skips items whose issue belongs to another repository (name or owner)", async () => {
    const other = { name: "other", owner: { login: "octo-org" } };
    const fork = { name: "shop-app", owner: { login: "someone-else" } };
    const { gql } = stub({
      pages: [
        page([
          item(1, "Todo"),
          item(2, "Todo", { extra: { repository: other } }),
          item(3, "Todo", { extra: { repository: fork } }),
        ]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([1]);
  });

  it("reads each card's assignee logins", async () => {
    const assignees = { assignees: { nodes: [{ login: "luke" }, { login: "sam" }] } };
    const { gql } = stub({
      pages: [page([item(1, "Todo", { extra: assignees }), item(2, "Todo")])],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app").map((i) => i.assignees)).toEqual([["luke", "sam"], []]);
  });

  it("a project without Stage/Owner fields maps to null and counts as Ready", async () => {
    const { gql } = stub({ pages: [page([item(1, "Todo")])] });
    await collectGithub(repo, store, gql, NOW);
    const one = store.board("shop-app")[0];
    expect(one).toMatchObject({
      stage: null,
      owner: null,
      parent: null,
      subIssues: null,
      blockedBy: [],
      milestone: null,
    });
    expect(columnOf(one as NonNullable<typeof one>)).toBe("ready");
    expect(statusOf()).toMatchObject({ ok: true });
  });

  it("maps an unknown Stage or Owner option to null; zero sub-issues is null", async () => {
    const { gql } = stub({
      pages: [
        page([
          item(1, "Todo", {
            stage: "Backlog",
            owner: "Robot",
            extra: { subIssuesSummary: { total: 0, completed: 0 } },
          }),
        ]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app")[0]).toMatchObject({ stage: null, owner: null, subIssues: null });
  });

  it("queries the new fields built from the constants", async () => {
    const { gql, calls } = stub({ pages: [page([])] });
    await collectGithub(repo, store, gql, NOW);
    const q = calls.find((c) => c.q.includes("projectV2"))?.q ?? "";
    expect(q).toContain('fieldValueByName(name: "Stage")');
    expect(q).toContain('fieldValueByName(name: "Owner")');
    expect(q).toContain("subIssuesSummary");
    expect(q).toContain("blockedBy(first: 10)");
  });
});

describe("collectGithub goal", () => {
  const ms = (title: string, dueOn: string | null, open: number, closed: number) => ({
    title,
    dueOn,
    openIssues: { totalCount: open },
    closedIssues: { totalCount: closed },
  });

  it("picks the first open milestone with a due date", async () => {
    const { gql } = stub({
      milestones: [ms("Big", null, 20, 0), ms("Soon", "2026-11-01T00:00:00Z", 3, 2)],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(store.goal("shop-app")).toEqual({
      repoId: "shop-app",
      title: "Soon",
      dueOn: Date.parse("2026-11-01T00:00:00Z"),
      open: 3,
      closed: 2,
    });
  });

  it("else picks the open milestone with the most issues", async () => {
    const { gql } = stub({
      milestones: [ms("A", null, 2, 1), ms("B", null, 5, 4), ms("C", null, 1, 0)],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(store.goal("shop-app")).toMatchObject({ title: "B", dueOn: null, open: 5, closed: 4 });
  });

  it("clears the goal when there is no open milestone", async () => {
    store.replaceGoal("shop-app", {
      repoId: "shop-app",
      title: "old",
      dueOn: null,
      open: 1,
      closed: 0,
    });
    const { gql } = stub({ milestones: [] });
    await collectGithub(repo, store, gql, NOW);
    expect(store.goal("shop-app")).toBeNull();
  });

  it("keeps the previous goal and records the failure when the milestone query fails", async () => {
    store.replaceGoal("shop-app", {
      repoId: "shop-app",
      title: "old",
      dueOn: null,
      open: 1,
      closed: 0,
    });
    const { gql } = stub({ milestoneError: new Error("boom") });
    await collectGithub(repo, store, gql, NOW);
    expect(store.goal("shop-app")?.title).toBe("old");
    expect(statusOf()).toMatchObject({ ok: false });
    expect(statusOf()?.error).toContain("goal: boom");
  });
});

describe("collectGithub escalations", () => {
  const all = [
    issue(10, "[operator-decision] pick a vendor", []),
    issue(11, "[loop-blocked] CI red", []),
    issue(12, "[mvp-ready] ship", []),
    issue(13, "[loop-paused] taking a break", []),
    issue(14, "unrelated", []),
    issue(15, "needs a design", ["needs-design"]),
    issue(
      16,
      "triaged design",
      ["needs-design"],
      [
        {
          body: `\`\`\`autonomy-question\n${JSON.stringify(Q)}\n\`\`\``,
          createdAt: "2026-10-06T00:00:00Z",
        },
      ],
    ),
    issue(
      17,
      "[operator-decision] with question",
      [],
      [
        {
          body: `\`\`\`autonomy-question\n${JSON.stringify(Q)}\n\`\`\``,
          createdAt: "2026-10-06T00:00:00Z",
        },
      ],
    ),
  ];

  it("classifies by marker and needs-you label; excludes loop-paused and unrelated", async () => {
    const { gql } = stub({ search: () => all });
    await collectGithub(repo, store, gql, NOW);
    const e = Object.fromEntries(store.escalations().map((x) => [x.issueNumber, x]));
    expect(Object.keys(e).sort()).toEqual(["10", "11", "12", "15", "16", "17"]);
    expect(e[10]).toMatchObject({
      id: "shop-app#10",
      repoId: "shop-app",
      kind: "operator-decision",
      title: "[operator-decision] pick a vendor",
      openedAt: Date.parse("2026-10-05T10:00:00Z"),
      url: "https://github.com/octo-org/shop-app/issues/10",
      question: null,
    });
    expect(e[11]?.kind).toBe("loop-blocked");
    expect(e[12]?.kind).toBe("mvp-ready");
    expect(e[15]?.kind).toBe("operator-decision");
    expect(e[15]?.question).toBeNull();
    expect(e[16]?.kind).toBe("autonomy-question");
    expect(e[16]?.question).toEqual(Q);
    expect(e[17]?.kind).toBe("operator-decision");
    expect(e[17]?.question).toEqual(Q);
  });

  it("records whether a title marker or only a label made the issue an escalation", async () => {
    const { gql } = stub({ search: () => all });
    await collectGithub(repo, store, gql, NOW);
    const src = Object.fromEntries(store.escalations().map((x) => [x.issueNumber, x.source]));
    expect(src).toEqual({
      10: "title",
      11: "title",
      12: "title",
      15: "label",
      16: "label",
      17: "title",
    });
  });

  it("dedupes candidates returned by several searches", async () => {
    const { gql } = stub({ search: () => [issue(10, "[loop-blocked] x", ["needs-design"])] });
    await collectGithub(repo, store, gql, NOW);
    expect(store.escalations()).toHaveLength(1);
    expect(store.escalations()[0]?.kind).toBe("loop-blocked");
    expect(store.escalations()[0]?.source).toBe("title"); // the marker wins over the label
  });

  it("honours needsYouLabels and passes search as a variable", async () => {
    const { gql, calls } = stub({
      search: () => [issue(20, "hm", ["needs-human"]), issue(21, "no", ["needs-design"])],
    });
    await collectGithub({ ...repo, needsYouLabels: ["needs-human"] }, store, gql, NOW);
    expect(store.escalations().map((x) => x.issueNumber)).toEqual([20]);
    for (const c of calls.filter((c) => c.v.q !== undefined)) {
      expect(c.q).not.toContain("octo-org");
      expect(String(c.v.q)).toContain("repo:octo-org/shop-app is:issue is:open");
    }
  });
});

describe("collectGithub failure", () => {
  const seed = () => {
    store.replaceBoard("shop-app", [
      {
        repoId: "shop-app",
        issueNumber: 99,
        title: "old",
        status: "Todo",
        state: "planned",
        labels: [],
        priority: null,
        updatedAt: 1,
        url: "u",
        stage: null,
        owner: null,
        parent: null,
        subIssues: null,
        blockedBy: [],
        milestone: null,
        size: null,
        closed: false,
        prioritySource: null,
        createdAt: 1,
        itemId: null,
        projectId: null,
      },
    ]);
    store.replaceEscalations("shop-app", [
      {
        id: "shop-app#98",
        repoId: "shop-app",
        issueNumber: 98,
        title: "[loop-blocked] old",
        kind: "loop-blocked",
        source: "title",
        openedAt: 1,
        url: "u",
        question: null,
      },
    ]);
  };

  it("keeps existing rows, records ok=false with message and time, never throws when gql rejects", async () => {
    seed();
    const gql: Gql = async () => {
      throw new Error("network down");
    };
    await expect(collectGithub(repo, store, gql, NOW)).resolves.toEqual({
      boards: false,
      escalations: false,
    });
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([99]);
    expect(store.escalations().map((i) => i.issueNumber)).toEqual([98]);
    const s = statusOf();
    expect(s?.ok).toBe(false);
    expect(s?.error).toContain("network down");
    expect(s?.error).toContain(` at ${new Date(NOW).toISOString()}`);
  });

  it("treats a response with errors as failure", async () => {
    seed();
    const gql: Gql = async () => ({ errors: [{ message: "Could not resolve to a User" }] });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([99]);
    expect(statusOf()?.error).toContain("Could not resolve");
  });

  it("board and escalations fail independently", async () => {
    seed();
    const { gql } = stub({
      pages: [page([item(1, "Todo")])],
      searchError: new Error("search boom"),
    });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([1]);
    expect(store.escalations().map((i) => i.issueNumber)).toEqual([98]);
    expect(statusOf()).toMatchObject({ ok: false });
    expect(statusOf()?.error).toContain("search boom");

    seed();
    const b = stub({
      boardError: new Error("board boom"),
      search: () => [issue(10, "[mvp-ready] a", [])],
    });
    await collectGithub(repo, store, b.gql, NOW);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([99]);
    expect(store.escalations().map((i) => i.issueNumber)).toEqual([10]);
    expect(statusOf()?.error).toContain("board boom");
  });
});

describe("describeGqlErrors", () => {
  const scopeErr = (field: string) => ({
    type: "INSUFFICIENT_SCOPES",
    path: ["repositoryOwner", "projectV2", field],
    message:
      "Your token has not been granted the required scopes to execute this query. The 'projectV2' field requires one of the following scopes: ['read:project'], but your token has only been granted the: ['repo'] scopes.",
  });

  it("collapses several INSUFFICIENT_SCOPES errors into one line with the fix", () => {
    expect(describeGqlErrors(["id", "updatedAt", "name"].map(scopeErr))).toBe(
      "gh token lacks the read:project scope: run gh auth refresh -s project",
    );
  });

  it("names the scope a card move needs", () => {
    const e = {
      type: "INSUFFICIENT_SCOPES",
      message: "requires one of the following scopes: ['project'], but",
    };
    expect(describeGqlErrors([e, e])).toBe(
      "gh token lacks the project scope: run gh auth refresh -s project",
    );
  });

  it("collapses identical non-scope messages into one", () => {
    expect(
      describeGqlErrors([{ message: "Could not resolve" }, { message: "Could not resolve" }]),
    ).toBe("Could not resolve");
    expect(describeGqlErrors([{ message: "a" }, { message: "b" }, { message: "a" }])).toBe("a; b");
  });

  it("keeps the text when the errors are mixed", () => {
    expect(describeGqlErrors([scopeErr("id"), { message: "other" }])).toContain("other");
  });

  it("reaches the GqlError message through makeGql", async () => {
    const f = (async () =>
      new Response(JSON.stringify({ errors: [scopeErr("id"), scopeErr("name")] }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(makeGql("t", f)("q", {})).rejects.toMatchObject({
      message: "gh token lacks the read:project scope: run gh auth refresh -s project",
    });
  });

  it("falls back to read:project when the message names no scope", () => {
    expect(describeGqlErrors([{ type: "INSUFFICIENT_SCOPES", message: "nope" }])).toBe(
      "gh token lacks the read:project scope: run gh auth refresh -s project",
    );
  });

  it("call() describes a response's errors the same way", async () => {
    const gql = async () => ({
      errors: [scopeErr("id"), scopeErr("name")],
    });
    await expect(call(gql, "q", {})).rejects.toMatchObject({
      message: "gh token lacks the read:project scope: run gh auth refresh -s project",
    });
    const plain = async () => ({ errors: [{ message: "a" }, { message: "a" }, { message: "b" }] });
    await expect(call(plain, "q", {})).rejects.toMatchObject({ message: "a; b" });
  });

  it("missingScopeLine picks the scope line out of a health-row status", () => {
    expect(
      missingScopeLine(
        "board: gh token lacks the project scope: run gh auth refresh -s project; prs: boom at 2026-01-01T00:00:00.000Z",
      ),
    ).toBe("gh token lacks the project scope: run gh auth refresh -s project");
    expect(missingScopeLine("board: boom at x")).toBeNull();
  });
});

describe("makeGql", () => {
  it("posts the query and variables with a bearer token and returns data", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ data: { ok: 1 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const gql = makeGql("sekret", f);
    expect(await gql("query { x }", { a: 1 })).toEqual({ ok: 1 });
    expect(seen?.url).toBe("https://api.github.com/graphql");
    expect((seen?.init.headers as Record<string, string> | undefined)?.Authorization).toBe(
      "bearer sekret",
    );
    expect(JSON.parse(String(seen?.init.body))).toEqual({
      query: "query { x }",
      variables: { a: 1 },
    });
  });

  it("throws without leaking the token on HTTP or GraphQL errors", async () => {
    const http = makeGql(
      "sekret",
      (async () => new Response("bad sekret", { status: 401 })) as unknown as typeof fetch,
    );
    await expect(http("q", {})).rejects.toThrow(/401/);
    await http("q", {}).catch((e: Error) => expect(e.message).not.toContain("sekret"));
    const gerr = makeGql(
      "sekret",
      (async () =>
        new Response(JSON.stringify({ errors: [{ message: "nope" }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    );
    await expect(gerr("q", {})).rejects.toThrow(/nope/);
    const partial = makeGql(
      "sekret",
      (async () =>
        new Response(
          JSON.stringify({
            data: { repository: { a0: null } },
            errors: [{ type: "NOT_FOUND", path: ["repository", "a0"], message: "gone" }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    );
    const err = await partial("q", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GqlError);
    expect((err as GqlError).message).toBe("github: gone");
    expect((err as GqlError).data).toEqual({ repository: { a0: null } });
    expect((err as GqlError).errors).toEqual([
      { type: "NOT_FOUND", path: ["repository", "a0"], message: "gone" },
    ]);
    const boom = makeGql("sekret", (async () => {
      throw new Error("connect sekret");
    }) as unknown as typeof fetch);
    await boom("q", {}).catch((e: Error) => expect(e.message).not.toContain("sekret"));
  });
});

describe("isTransient", () => {
  const statusGql = (status: number) =>
    makeGql("t", (async () => new Response("x", { status })) as unknown as typeof fetch);

  it("is true for a lost request and a 5xx, false for a 4xx and a GraphQL error", async () => {
    const lost = makeGql("t", (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch);
    expect(isTransient(await lost("q", {}).catch((e: unknown) => e))).toBe(true);
    for (const status of [500, 502, 503]) {
      expect(isTransient(await statusGql(status)("q", {}).catch((e: unknown) => e))).toBe(true);
    }
    for (const status of [401, 403, 404, 429]) {
      const e = await statusGql(status)("q", {}).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(GqlTransportError);
      expect(isTransient(e)).toBe(false);
    }
    expect(isTransient(new GqlError("github: nope", [], null))).toBe(false);
    expect(isTransient(new Error("github: HTTP 502"))).toBe(false);
  });
});

describe("collectGithub size", () => {
  it("maps the Size field and is null when the project has none", async () => {
    const withSize = { ...item(1, "Todo"), size: { name: "M" } };
    const { gql, calls } = stub({ pages: [page([withSize, item(2, "Todo")])] });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app").map((i) => [i.issueNumber, i.size])).toEqual([
      [1, "M"],
      [2, null],
    ]);
    expect(calls.find((c) => c.q.includes("projectV2"))?.q).toContain(
      'fieldValueByName(name: "Size")',
    );
  });

  it("keeps a done item 20 days old, drops one 31 days old", async () => {
    const { gql } = stub({
      pages: [
        page([
          item(1, "Done", { updatedAt: new Date(NOW - 20 * DAY).toISOString() }),
          item(2, "Done", { updatedAt: new Date(NOW - 31 * DAY).toISOString() }),
        ]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(store.board("shop-app").map((i) => i.issueNumber)).toEqual([1]);
  });
});

describe("collectGithub pull requests", () => {
  const prs = () => store.pullRequests("shop-app");

  it("stores each PR's author and assignees", async () => {
    const { gql } = stub({
      prPages: [
        prPage([
          pull(20, {
            author: { login: "octo" },
            assignees: { nodes: [{ login: "a" }, { login: "b" }] },
          }),
          pull(21, { author: null }),
        ]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    const by = new Map(prs().map((p) => [p.number, p]));
    expect(
      [by.get(20), by.get(21)].map((p) => ({ author: p?.author, assignees: p?.assignees })),
    ).toEqual([
      { author: "octo", assignees: ["a", "b"] },
      { author: null, assignees: [] },
    ]);
  });

  it("maps state, review, ci, branch and links the ticket by branch", async () => {
    const { gql } = stub({
      prPages: [
        prPage([
          pull(10, {
            state: "MERGED",
            mergedAt: "2026-10-16T02:00:00Z",
            reviewDecision: "APPROVED",
            headRefName: "fix/3227-quote-cache",
          }),
          pull(11, {
            isDraft: true,
            reviewDecision: "CHANGES_REQUESTED",
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }] },
          }),
          pull(12, {
            state: "CLOSED",
            reviewDecision: "REVIEW_REQUIRED",
            commits: { nodes: [{ commit: { statusCheckRollup: { state: "EXPECTED" } } }] },
          }),
        ]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    const by = new Map(prs().map((p) => [p.number, p]));
    expect(by.get(10)).toMatchObject({
      repoId: "shop-app",
      state: "merged",
      review: "approved",
      ci: "passing",
      branch: "fix/3227-quote-cache",
      ticket: "shop-app#3227",
      mergedAt: Date.parse("2026-10-16T02:00:00Z"),
      createdAt: Date.parse("2026-10-16T00:00:00Z"),
      updatedAt: Date.parse("2026-10-16T01:00:00Z"),
      url: "https://github.com/octo-org/shop-app/pull/10",
    });
    expect(by.get(11)).toMatchObject({
      isDraft: true,
      review: "changes",
      ci: "failing",
      state: "open",
    });
    expect(by.get(12)).toMatchObject({ state: "closed", review: "requested", ci: "pending" });
  });

  it("stores the head commit's sha and the mergeable state, null when GitHub gives neither", async () => {
    const { gql } = stub({
      prPages: [
        prPage([
          pull(1),
          pull(2, { mergeable: "CONFLICTING" }),
          pull(3, { mergeable: "UNKNOWN", commits: { nodes: [] } }),
          pull(4, { mergeable: "SOMETHING_NEW", commits: { nodes: [{ commit: {} }] } }),
          pull(5, { mergeable: null, commits: { nodes: [{ commit: { oid: 42 } }] } }),
        ]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    const by = new Map(prs().map((p) => [p.number, p]));
    expect(by.get(1)).toMatchObject({ headSha: "1".repeat(40), mergeable: "MERGEABLE" });
    expect(by.get(2)).toMatchObject({ headSha: "2".repeat(40), mergeable: "CONFLICTING" });
    expect(by.get(3)).toMatchObject({ headSha: null, mergeable: "UNKNOWN" });
    expect(by.get(4)).toMatchObject({ headSha: null, mergeable: null });
    expect(by.get(5)).toMatchObject({ headSha: null, mergeable: null });
  });

  it("asks GitHub for the head oid and mergeable", async () => {
    const { gql, calls } = stub({ prPages: [prPage([])] });
    await collectGithub(repo, store, gql, NOW);
    const q = calls.find((c) => c.q.includes("pullRequests("))?.q ?? "";
    expect(q).toMatch(/\bmergeable\b/);
    expect(q).toMatch(/commit \{ oid statusCheckRollup/);
  });

  it("a PR with no commits or rollup has ci null, no reviewDecision has review null, no ticket is null", async () => {
    const { gql } = stub({
      prPages: [
        prPage([
          pull(1, { commits: { nodes: [] }, headRefName: "chore/tidy" }),
          pull(2, {
            commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
            headRefName: "chore/tidy2",
          }),
        ]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(prs().map((p) => [p.ci, p.review, p.ticket])).toEqual([
      [null, null, null],
      [null, null, null],
    ]);
  });

  it("falls back to the first closing reference when the branch names no ticket; the branch wins otherwise", async () => {
    const { gql } = stub({
      prPages: [
        prPage([
          pull(1, {
            headRefName: "chore/tidy",
            closingIssuesReferences: { nodes: [{ number: 77 }, { number: 78 }] },
          }),
          pull(2, { headRefName: "fix/5-x", closingIssuesReferences: { nodes: [{ number: 77 }] } }),
        ]),
      ],
    });
    await collectGithub(repo, store, gql, NOW);
    const by = new Map(prs().map((p) => [p.number, p.ticket]));
    expect(by.get(1)).toBe("shop-app#77");
    expect(by.get(2)).toBe("shop-app#5");
  });

  it("stores two PRs for one ticket", async () => {
    const { gql } = stub({
      prPages: [prPage([pull(1, { headRefName: "fix/9-a" }), pull(2, { headRefName: "fix/9-b" })])],
    });
    await collectGithub(repo, store, gql, NOW);
    expect(prs().filter((p) => p.ticket === "shop-app#9")).toHaveLength(2);
  });

  it("a poll reads one page with first 100 and keeps older rows", async () => {
    store.upsertPullRequests(
      "shop-app",
      [
        { ...(await one(pull(1))), number: 1 },
        { ...(await one(pull(2))), number: 2 },
      ],
      0,
    );
    const { gql, calls } = stub({ prPages: [prPage([pull(2, { title: "new" })], "CUR")] });
    await collectGithub(repo, store, gql, NOW);
    const prCalls = calls.filter((c) => c.q.includes("pullRequests"));
    expect(prCalls).toHaveLength(1);
    expect(prCalls[0]?.q).toContain("first: 100");
    expect(prCalls[0]?.v).toMatchObject({ owner: "octo-org", name: "shop-app", after: null });
    expect(prs().map((p) => [p.number, p.title])).toEqual([
      [2, "new"],
      [1, "pr 1"],
    ]);
  });

  it("the PR part failing keeps old rows and reports prs: ...", async () => {
    store.upsertPullRequests("shop-app", [await one(pull(1))], 0);
    const { gql } = stub({ pages: [page([item(1, "Todo")])], prError: new Error("pr boom") });
    await collectGithub(repo, store, gql, NOW);
    expect(prs().map((p) => p.number)).toEqual([1]);
    expect(store.board("shop-app")).toHaveLength(1);
    expect(statusOf()).toMatchObject({ ok: false });
    expect(statusOf()?.error).toContain("prs: pr boom");
    expect([...store.stalePullRequests("shop-app")]).toEqual([1]);
  });
});

/** A stored-shape PR built through the collector's own mapping. */
async function one(node: unknown) {
  const s = new Store(":memory:");
  try {
    await collectGithub(repo, s, stub({ prPages: [prPage([node])] }).gql, NOW);
    const [p] = s.pullRequests("shop-app");
    if (!p) throw new Error("no pr");
    return p;
  } finally {
    s.close();
  }
}

describe("sweepPullRequests", () => {
  const sweepStatus = () => store.status().find((s) => s.collector === "github:shop-app:prs");
  const recent = (n: number) => pull(n, { updatedAt: new Date(NOW - 2 * DAY).toISOString() });
  const old = (n: number) => pull(n, { updatedAt: new Date(NOW - 31 * DAY).toISOString() });

  it("stops after the page whose nodes pass 30 days and keeps only nodes within 30 days", async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => recent(1000 - i));
    const { gql, calls } = stub({
      prPages: [prPage(hundred, "C1"), prPage([recent(500), old(400)], "C2"), prPage([recent(1)])],
    });
    store.upsertPullRequests("shop-app", [await one(pull(7))], 0);
    await sweepPullRequests(repo, store, gql, NOW);
    const prCalls = calls.filter((c) => c.q.includes("pullRequests"));
    expect(prCalls.map((c) => c.v.after ?? null)).toEqual([null, "C1"]);
    const numbers = store.pullRequests("shop-app").map((p) => p.number);
    expect(numbers).toHaveLength(101);
    expect(numbers).toContain(500);
    expect(numbers).not.toContain(400);
    expect(numbers).not.toContain(7); // replaced, not merged
    expect(sweepStatus()).toMatchObject({ ok: true, error: null });
  });

  it("stops at PR_MAX_PAGES on a source that never ends", async () => {
    let n = 0;
    const calls: number[] = [];
    const gql: Gql = async () => {
      calls.push(n);
      return prPage([recent(++n)], `C${n}`);
    };
    await sweepPullRequests(repo, store, gql, NOW);
    expect(calls).toHaveLength(10);
    expect(store.pullRequests("shop-app")).toHaveLength(10);
  });

  // GitHub does not bump a PR's updatedAt when its CI finishes: the sweep read `pending`, the
  // poll then read `passing`, and both carry the same updatedAt.
  const ciRevert = async (pollStartedAt: number, readPrsAt: () => number) => {
    const rollup = (state: string) => ({ nodes: [{ commit: { statusCheckRollup: { state } } }] });
    const same = "2026-10-16T01:00:00Z";
    const swept = pull(1, { updatedAt: same, commits: rollup("PENDING") });
    const polled = pull(1, { updatedAt: same, commits: rollup("SUCCESS") });
    const opened = pull(2, { title: "opened" });
    const inner = stub({ prPages: [prPage([swept, recent(3)])] }).gql;
    const gql: Gql = async (q, v) => {
      const data = await inner(q, v);
      // A poll lands while the sweep is still reading.
      const poll = stub({ prPages: [prPage([polled, opened])] }).gql;
      await collectGithub(repo, store, poll, pollStartedAt, readPrsAt);
      return data;
    };
    await sweepPullRequests(repo, store, gql, NOW);
    expect(store.pullRequests("shop-app").map((p) => [p.number, p.title, p.ci])).toEqual([
      [3, "pr 3", "passing"],
      [2, "opened", "passing"],
      [1, "pr 1", "passing"],
    ]);
  };

  it("never reverts a row a poll refreshed after the sweep's read began, even at the same updatedAt", () =>
    ciRevert(NOW + 1000, () => NOW + 1000));

  it("stamps a poll's PR rows when its PR read happens, not when the poll started", () =>
    // The poll started before the sweep (NOW - 1000) but read the PRs after it began.
    ciRevert(NOW - 1000, () => NOW + 1000));

  it("takes the PR read's clock reading after the board reads and before the PR page", async () => {
    const { gql, calls } = stub({ pages: [page([item(1, "Todo")])], prPages: [prPage([pull(1)])] });
    let seen: string[] = [];
    await collectGithub(repo, store, gql, NOW, () => {
      seen = calls.map((c) => c.q);
      return NOW;
    });
    expect(seen.some((q) => q.includes("projectV2"))).toBe(true);
    expect(seen.some((q) => q.includes("pullRequests"))).toBe(false);
  });

  it("prunes stored rows when GitHub returned only nodes older than 30 days", async () => {
    store.upsertPullRequests("shop-app", [await one(pull(7))], 0);
    const { gql } = stub({ prPages: [prPage([old(8)])] });
    await sweepPullRequests(repo, store, gql, NOW);
    expect(store.pullRequests("shop-app")).toEqual([]);
    expect(sweepStatus()).toMatchObject({ ok: true, error: null });
  });

  it("treats an empty read as no data: keeps the rows and reports no change", async () => {
    store.upsertPullRequests("shop-app", [await one(pull(7))], 0);
    const { gql } = stub({ prPages: [prPage([])] });
    await expect(sweepPullRequests(repo, store, gql, NOW)).resolves.toEqual({
      boards: false,
      escalations: false,
    });
    expect(store.pullRequests("shop-app").map((p) => p.number)).toEqual([7]);
    expect(sweepStatus()).toMatchObject({ ok: true, error: null });
  });

  it("keeps the old rows and records the failure when a page fails", async () => {
    store.upsertPullRequests("shop-app", [await one(pull(7))], 0);
    const { gql } = stub({ prError: new Error("sweep boom") });
    await expect(sweepPullRequests(repo, store, gql, NOW)).resolves.toEqual({
      boards: false,
      escalations: false,
    });
    expect(store.pullRequests("shop-app").map((p) => p.number)).toEqual([7]);
    expect(sweepStatus()).toMatchObject({ ok: false });
    expect(sweepStatus()?.error).toContain("sweep boom");
  });
});

// #26 A1: the scheduler emits `boards` / `escalations` only when a poll changed a row.
describe("change reporting", () => {
  const milestone = { title: "MVP", dueOn: null, openIssues: { totalCount: 2 } };
  /** The same GitHub answers every time, except for what `over` changes. */
  const answers = (
    over: { status2?: string; search?: readonly unknown[]; closed?: number; draft?: boolean } = {},
  ) =>
    stub({
      pages: [page([item(1, "Todo"), item(2, over.status2 ?? "Done")])],
      search: () => [...(over.search ?? [issue(10, "[mvp-ready] a", [])])],
      milestones: [{ ...milestone, closedIssues: { totalCount: over.closed ?? 1 } }],
      prPages: [prPage([pull(1, { isDraft: over.draft ?? false })])],
    }).gql;

  it("a poll with the same answers as the last one changes nothing", async () => {
    expect(await collectGithub(repo, store, answers(), NOW)).toEqual({
      boards: true,
      escalations: true,
    });
    expect(await collectGithub(repo, store, answers(), NOW)).toEqual({
      boards: false,
      escalations: false,
    });
  });

  it("reports boards for a board, goal or PR change, and escalations for an escalation change", async () => {
    await collectGithub(repo, store, answers(), NOW);
    const changes = [
      [{ status2: "In Progress" }, { boards: true, escalations: false }],
      [
        { status2: "In Progress", closed: 2 },
        { boards: true, escalations: false },
      ],
      [
        { status2: "In Progress", closed: 2, draft: true },
        { boards: true, escalations: false },
      ],
      [
        { status2: "In Progress", closed: 2, draft: true, search: [] },
        { boards: false, escalations: true },
      ],
    ] as const;
    for (const [over, expected] of changes) {
      expect(await collectGithub(repo, store, answers(over), NOW), JSON.stringify(over)).toEqual(
        expected,
      );
    }
  });

  it("the sweep reports boards only when it changed a PR row", async () => {
    const sweep = () => stub({ prPages: [prPage([pull(1)])] }).gql;
    expect(await sweepPullRequests(repo, store, sweep(), NOW)).toEqual({
      boards: true,
      escalations: false,
    });
    expect(await sweepPullRequests(repo, store, sweep(), NOW)).toEqual({
      boards: false,
      escalations: false,
    });
  });
});
