import {
  type BoardItem,
  FLOW_BATCH,
  FLOW_DAYS,
  FLOW_TIMELINE_MAX_PAGES,
  flowCollector,
  type PullRequestView,
} from "@mc/core";
import { beforeEach, describe, expect, it } from "vitest";
import { collectFlow } from "../src/collectors/flow.ts";
import { type Gql, GqlError, makeGql } from "../src/collectors/github.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const DAY = 86_400_000;
const at = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();
const repo: CcConfig["repos"][number] = {
  id: "shop-app",
  github: "octo-org/shop-app",
  project: 2,
  statusMap: {
    Todo: "planned",
    Backlog: "planned",
    "In Progress": "in progress",
    "In Review": "review",
    Done: "done",
  },
  autonomy: "draft",
};

const board = (n: number, over: Partial<BoardItem> = {}): BoardItem => ({
  repoId: "shop-app",
  issueNumber: n,
  title: `t${n}`,
  status: "Done",
  state: "done",
  labels: [],
  priority: null,
  updatedAt: NOW - DAY,
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
  ...over,
});

const pr = (n: number, over: Partial<PullRequestView> = {}): PullRequestView => ({
  repoId: "shop-app",
  number: n,
  title: "t",
  url: "u",
  branch: "b",
  ticket: null,
  state: "merged",
  isDraft: false,
  review: null,
  ci: null,
  createdAt: 1,
  updatedAt: 2,
  mergedAt: NOW - DAY,
  headSha: null,
  mergeable: null,
  ...over,
});

const ev = (status: string, daysAgo: number, project = 2) => ({
  createdAt: at(daysAgo),
  status,
  project: { number: project },
});
const timeline = (...nodes: unknown[]) => ({ timelineItems: { nodes } });
const commits = (...states: (string | null)[]) => ({
  commits: {
    nodes: states.map((s) => ({ commit: { statusCheckRollup: s === null ? null : { state: s } } })),
  },
});

/** Answers aliased issue/PR queries from number -> payload maps and records every call. */
function stub(
  issues: Record<number, unknown>,
  prs: Record<number, unknown> = {},
  fail?: (q: string) => boolean,
) {
  const calls: { q: string; v: Record<string, unknown> }[] = [];
  const gql: Gql = async (q, v) => {
    calls.push({ q, v });
    if (fail?.(q)) throw new Error("github: HTTP 502");
    const isIssue = q.includes("timelineItems");
    const table = isIssue ? issues : prs;
    const field = isIssue ? "issue" : "pullRequest";
    const repository: Record<string, unknown> = {};
    for (const m of q.matchAll(new RegExp(`(\\w+): ${field}\\(number: (\\d+)\\)`, "g"))) {
      repository[m[1] as string] = table[Number(m[2])] ?? null;
    }
    return { repository };
  };
  return { gql, calls };
}

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
const status = () => store.status().find((s) => s.collector === flowCollector("shop-app"));
const since = NOW - FLOW_DAYS * DAY;
const run = (gql: Gql) => collectFlow(repo, store, gql, NOW);

describe("collectFlow issues", () => {
  it("starts at In Progress for shop-app's '' -> In Progress -> In Review -> Done", async () => {
    store.replaceBoard("shop-app", [board(1, { size: "M" })]);
    const { gql } = stub({
      1: timeline(ev("", 6), ev("In Progress", 5), ev("In Review", 3), ev("Done", 1)),
    });
    await run(gql);
    expect(store.flowIssues(since)).toEqual([
      {
        repoId: "shop-app",
        number: 1,
        size: "M",
        startAt: Date.parse(at(5)),
        doneAt: Date.parse(at(1)),
      },
    ]);
    expect(status()).toMatchObject({ ok: true, error: null });
  });

  it("does not start at Todo (planned), and keeps the first In Progress across a bounce", async () => {
    store.replaceBoard("shop-app", [board(1), board(2)]);
    const { gql } = stub({
      1: timeline(ev("", 9), ev("Todo", 8), ev("In Progress", 6), ev("Done", 1)),
      2: timeline(
        ev("In Progress", 9),
        ev("Todo", 8),
        ev("In Progress", 7),
        ev("In Review", 5),
        ev("Done", 2),
      ),
    });
    await run(gql);
    const by = new Map(store.flowIssues(since).map((i) => [i.number, i]));
    expect(by.get(1)?.startAt).toBe(Date.parse(at(6)));
    expect(by.get(2)?.startAt).toBe(Date.parse(at(9)));
  });

  it("starts at a status literally named Ready, any case", async () => {
    store.replaceBoard("shop-app", [board(1)]);
    const { gql } = stub({ 1: timeline(ev("Todo", 5), ev("ready", 4), ev("Done", 1)) });
    await run(gql);
    expect(store.flowIssues(since)[0]?.startAt).toBe(Date.parse(at(4)));
  });

  it("stores Backlog -> Done with startAt null and counts it in the status note", async () => {
    store.replaceBoard("shop-app", [board(1)]);
    const { gql } = stub({ 1: timeline(ev("Backlog", 5), ev("Done", 1)) });
    await run(gql);
    expect(store.flowIssues(since)).toEqual([
      { repoId: "shop-app", number: 1, size: null, startAt: null, doneAt: Date.parse(at(1)) },
    ]);
    expect(status()).toMatchObject({ ok: true });
    expect(status()?.error).toContain("1 done issue(s) without a start");
  });

  it("uses the last move into Done and ignores events on another project", async () => {
    store.replaceBoard("shop-app", [board(1)]);
    const { gql } = stub({
      1: timeline(
        ev("In Progress", 9, 7),
        ev("Done", 8, 7),
        ev("In Progress", 6),
        ev("Done", 4),
        ev("In Review", 3),
        ev("Done", 2),
      ),
    });
    await run(gql);
    const [i] = store.flowIssues(since);
    expect(i?.startAt).toBe(Date.parse(at(6)));
    expect(i?.doneAt).toBe(Date.parse(at(2)));
  });

  it("does not store an issue with no move into Done", async () => {
    store.replaceBoard("shop-app", [board(1)]);
    const { gql } = stub({ 1: timeline(ev("In Progress", 5)) });
    await run(gql);
    expect(store.flowIssues(0)).toEqual([]);
  });

  it("reads only Done items updated within FLOW_DAYS, batched 20 aliases per query", async () => {
    const items = Array.from({ length: 45 }, (_, k) => board(k + 1));
    store.replaceBoard("shop-app", [
      ...items,
      board(100, { updatedAt: NOW - (FLOW_DAYS + 1) * DAY }),
      board(101, { status: "In Progress", state: "in progress" }),
    ]);
    const { gql, calls } = stub({});
    await run(gql);
    const issueCalls = calls.filter((c) => c.q.includes("timelineItems"));
    const counts = issueCalls.map((c) => [...c.q.matchAll(/: issue\(number:/g)].length);
    expect(FLOW_BATCH).toBe(20);
    expect(counts).toEqual([20, 20, 5]);
    expect(issueCalls.every((c) => c.q.includes("PROJECT_V2_ITEM_STATUS_CHANGED_EVENT"))).toBe(
      true,
    );
    expect(calls.some((c) => c.q.includes("(number: 100)"))).toBe(false);
    expect(calls.some((c) => c.q.includes("(number: 101)"))).toBe(false);
    expect(issueCalls[0]?.v).toEqual({ owner: "octo-org", name: "shop-app" });
  });
});

describe("collectFlow pull requests", () => {
  it("takes the rollup of the earliest commit that has one", async () => {
    store.upsertPullRequests("shop-app", [pr(10), pr(11), pr(12), pr(13)], 0);
    const { gql } = stub(
      {},
      {
        10: commits(null, "FAILURE", "SUCCESS"),
        11: commits("SUCCESS"),
        12: commits(null, null),
        13: commits("PENDING"),
      },
    );
    await run(gql);
    const by = new Map(store.flowPrs(since).map((p) => [p.number, p.firstPushCi]));
    expect(by.get(10)).toBe("failing");
    expect(by.get(11)).toBe("passing");
    expect(by.get(12)).toBeNull();
    expect(by.get(13)).toBe("pending");
    expect(store.flowPrs(since)[0]).toMatchObject({ repoId: "shop-app", mergedAt: NOW - DAY });
  });

  it("reads only PRs merged within FLOW_DAYS, 20 aliases per query", async () => {
    store.upsertPullRequests(
      "shop-app",
      [
        ...Array.from({ length: 25 }, (_, k) => pr(k + 1)),
        pr(100, { mergedAt: NOW - (FLOW_DAYS + 1) * DAY }),
        pr(101, { state: "open", mergedAt: null }),
      ],
      0,
    );
    const { gql, calls } = stub(
      {},
      Object.fromEntries(Array.from({ length: 25 }, (_, k) => [k + 1, commits("SUCCESS")])),
    );
    await run(gql);
    const prCalls = calls.filter((c) => c.q.includes("statusCheckRollup"));
    expect(prCalls.map((c) => [...c.q.matchAll(/: pullRequest\(number:/g)].length)).toEqual([
      20, 5,
    ]);
    expect(prCalls.some((c) => c.q.includes("first: 20"))).toBe(true);
    expect(store.flowPrs(0)).toHaveLength(25);
  });
});

describe("collectFlow failure", () => {
  it("keeps the old rows and records not-ok when a batch fails", async () => {
    store.replaceBoard("shop-app", [board(1)]);
    await run(stub({ 1: timeline(ev("In Progress", 3), ev("Done", 1)) }).gql);
    expect(store.flowIssues(since)).toHaveLength(1);

    store.upsertPullRequests("shop-app", [pr(10)], 0);
    await run(stub({}, {}, (q) => q.includes("statusCheckRollup")).gql);
    expect(store.flowIssues(since)).toHaveLength(1);
    expect(status()).toMatchObject({ ok: false });
    expect(status()?.error).toContain("github: HTTP 502");

    await run(stub({}, {}, () => true).gql);
    expect(store.flowIssues(since)).toHaveLength(1);
    expect(status()?.ok).toBe(false);
  });

  it("records a failure from the next successful run as ok again", async () => {
    store.replaceBoard("shop-app", [board(1)]);
    await run(stub({}, {}, () => true).gql);
    expect(status()?.ok).toBe(false);
    await run(stub({ 1: timeline(ev("In Progress", 3), ev("Done", 1)) }).gql);
    expect(status()).toMatchObject({ ok: true, error: null });
  });
});

describe("collectFlow with a missing item", () => {
  /** The real makeGql over a fake fetch: `inner` answers the data, `errorsFor` adds GraphQL errors. */
  const viaHttp = (inner: Gql, errorsFor: (q: string) => unknown[]): Gql =>
    makeGql("tok", (async (_url: string, init: RequestInit) => {
      const { query, variables } = JSON.parse(String(init.body)) as {
        query: string;
        variables: Record<string, unknown>;
      };
      const data = await inner(query, variables);
      const errors = errorsFor(query);
      return new Response(JSON.stringify(errors.length > 0 ? { data, errors } : { data }), {
        status: 200,
      });
    }) as unknown as typeof fetch);
  /** GitHub's answer for an alias whose issue/PR is gone: NOT_FOUND at that alias. */
  const notFound = (q: string, n: number, path?: unknown[]) => {
    const m = new RegExp(`(\\w+): (?:issue|pullRequest)\\(number: ${n}\\)`).exec(q);
    return m
      ? [
          {
            type: "NOT_FOUND",
            path: path ?? ["repository", m[1]],
            message: `Could not resolve to an Issue with the number of ${n}.`,
          },
        ]
      : [];
  };
  const done = timeline(ev("In Progress", 3), ev("Done", 1));

  it("skips a deleted or transferred issue and keeps the rest of its batch", async () => {
    store.replaceBoard("shop-app", [board(1), board(2), board(3)]);
    const { gql } = stub({ 1: done, 3: done });
    await run(viaHttp(gql, (q) => notFound(q, 2)));
    expect(store.flowIssues(since).map((i) => i.number)).toEqual([1, 3]);
    expect(status()).toMatchObject({ ok: true, error: null });
  });

  it("skips a missing PR and keeps the rest of its batch", async () => {
    store.upsertPullRequests("shop-app", [pr(10), pr(11), pr(12)], 0);
    const { gql } = stub({}, { 10: commits("SUCCESS"), 12: commits("FAILURE") });
    await run(viaHttp(gql, (q) => notFound(q, 11)));
    expect(store.flowPrs(since).map((p) => p.number)).toEqual([10, 12]);
    expect(status()?.ok).toBe(true);
  });

  it("still fails the batch on an error whose path is not exactly one alias of it", async () => {
    store.replaceBoard("shop-app", [board(1), board(2), board(3)]);
    const { gql } = stub({ 1: done, 3: done });
    const cases: ((q: string) => unknown[])[] = [
      // deeper than the alias
      (q) => notFound(q, 2, ["repository", "a1", "timelineItems"]),
      // an alias this batch does not have
      (q) => notFound(q, 2, ["repository", "a7"]),
      // no path at all, beside a tolerable one
      (q) => [...notFound(q, 2), { type: "RATE_LIMITED", message: "API rate limit exceeded" }],
      (q) => notFound(q, 2, ["repository"]),
      // the right path, but not NOT_FOUND
      (q) =>
        notFound(q, 2).map((e) => ({
          ...e,
          type: "FORBIDDEN",
          message: "Resource not accessible",
        })),
      (q) => notFound(q, 2).map(({ type: _type, ...e }) => e),
    ];
    for (const errorsFor of cases) {
      await run(viaHttp(gql, errorsFor));
      expect(status()?.ok).toBe(false);
      expect(store.flowIssues(since)).toEqual([]);
    }
  });
});

describe("collectFlow timeline paging", () => {
  const filler = (n: number) => Array.from({ length: n }, () => ev("", 9));
  const page = (nodes: unknown[], next: string | null) => ({
    timelineItems: { nodes, pageInfo: { hasNextPage: next !== null, endCursor: next } },
  });
  /** Issue 1's timeline in pages keyed by the `after` cursor in the query ("first": none). */
  const paged = (pages: Record<string, unknown>) => {
    const calls = Object.assign([] as string[], { vars: [] as Record<string, unknown>[] });
    const gql: Gql = async (q, v) => {
      calls.push(q);
      calls.vars.push(v);
      const answer = pages[typeof v.after === "string" ? v.after : "first"];
      if (answer instanceof Error) throw answer;
      return { repository: { a0: answer } };
    };
    return { gql, calls };
  };

  it("pages past the first 100 events and reads a Done on a later page", async () => {
    store.replaceBoard("shop-app", [board(1)]);
    const { gql, calls } = paged({
      first: page([...filler(99), ev("In Progress", 5)], "C1"),
      C1: page(filler(100), "C2"),
      C2: page([ev("Done", 1)], null),
    });
    await run(gql);
    expect(calls).toHaveLength(3);
    // The cursor travels as the $after variable, never spliced into the query text.
    expect(calls.vars.slice(1).map((v) => [v.number, v.after])).toEqual([
      [1, "C1"],
      [1, "C2"],
    ]);
    for (const q of calls.slice(1)) {
      expect(q).toContain("$after: String");
      expect(q).not.toMatch(/C[12]/);
    }
    expect(store.flowIssues(since)).toEqual([
      expect.objectContaining({ startAt: Date.parse(at(5)), doneAt: Date.parse(at(1)) }),
    ]);
    expect(status()).toMatchObject({ ok: true, error: null });
  });

  it("stops at the page bound and flags the truncated timeline", async () => {
    store.replaceBoard("shop-app", [board(1)]);
    const pages: Record<string, unknown> = { first: page(filler(100), "C1") };
    for (let i = 1; i <= 9; i++) pages[`C${i}`] = page(filler(100), `C${i + 1}`);
    const { gql, calls } = paged(pages);
    await run(gql);
    expect(calls).toHaveLength(FLOW_TIMELINE_MAX_PAGES);
    expect(status()).toMatchObject({ ok: true });
    expect(status()?.error).toContain("timeline truncated");
  });

  it("a malformed later page fails the collection and keeps the old rows", async () => {
    store.replaceBoard("shop-app", [board(1)]);
    store.replaceFlow(
      "shop-app",
      [{ repoId: "shop-app", number: 9, size: null, startAt: 1, doneAt: 2 }],
      [],
    );
    const { gql } = paged({
      first: page(filler(100), "C1"),
      C1: { timelineItems: { pageInfo: { hasNextPage: false, endCursor: null } } },
    });
    await run(gql);
    expect(status()).toMatchObject({ ok: false });
    expect(store.flowIssues(0).map((i) => i.number)).toEqual([9]);
  });

  it("an issue gone by its later page is skipped, as on the first page", async () => {
    store.replaceBoard("shop-app", [board(1)]);
    const gone = new GqlError("not found", [{ type: "NOT_FOUND", path: ["repository", "a0"] }], {
      repository: { a0: null },
    });
    // Its first page alone would store it (a Done event); it is dropped because it is gone.
    const { gql } = paged({
      first: page([...filler(98), ev("In Progress", 5), ev("Done", 1)], "C1"),
      C1: gone,
    });
    await run(gql);
    expect(status()).toMatchObject({ ok: true, error: null });
    expect(store.flowIssues(0)).toEqual([]);
  });

  it("any other error on a later page fails the collection", async () => {
    store.replaceBoard("shop-app", [board(1)]);
    const denied = new GqlError("denied", [{ type: "FORBIDDEN", path: ["repository", "a0"] }], {});
    const { gql } = paged({ first: page(filler(100), "C1"), C1: denied });
    await run(gql);
    expect(status()).toMatchObject({ ok: false });
  });
});
