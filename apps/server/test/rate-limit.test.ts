import {
  type BoardItem,
  GITHUB_BACKOFF_MAX,
  GITHUB_POINTS_PER_HOUR,
  GITHUB_RATE_SETTING,
  type PullRequestView,
  RATE_LIMIT_SELECTION,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { githubRate } from "../src/api.ts";
import { collectFlow } from "../src/collectors/flow.ts";
import {
  collectGithub,
  fetchTicket,
  type Gql,
  GqlError,
  makeGql,
  sweepPullRequests,
} from "../src/collectors/github.ts";
import {
  EXHAUSTED_MIN_RESET_MS,
  isLow,
  nextBackoff,
  parseRateLimit,
  queryName,
  RateLimits,
} from "../src/collectors/rate-limit.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const RESET = Date.parse("2026-10-17T12:40:00Z");
const repo: CcConfig["repos"][number] = {
  id: "shop-app",
  github: "octo-org/shop-app",
  project: 2,
  statusMap: {},
  autonomy: "draft",
};
const reading = (remaining: number, over: object = {}) => ({
  cost: 1,
  limit: 5000,
  remaining,
  resetAt: RESET,
  at: NOW,
  ...over,
});

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

describe("rateLimit parsing", () => {
  it("names a query by its operation and parses the rateLimit block of a response", () => {
    expect(queryName("query Board($a: Int) { x }")).toBe("Board");
    expect(queryName("query { x }")).toBe("anonymous");
    const data = {
      rateLimit: { cost: 2, limit: 12500, remaining: 4990, resetAt: "2026-10-17T12:40:00Z" },
    };
    expect(parseRateLimit(data, NOW)).toEqual({
      cost: 2,
      limit: 12500,
      remaining: 4990,
      resetAt: RESET,
      at: NOW,
    });
    // a response without a limit is read against the standard hourly budget
    const noLimit = { rateLimit: { cost: 2, remaining: 4990, resetAt: "2026-10-17T12:40:00Z" } };
    expect(parseRateLimit(noLimit, NOW)?.limit).toBe(GITHUB_POINTS_PER_HOUR);
    expect(parseRateLimit({ x: 1 }, NOW)).toBeNull();
    expect(parseRateLimit({ rateLimit: { cost: "2" } }, NOW)).toBeNull();
  });

  it("makeGql hands each answer's rateLimit to the sink under the query's name, data unchanged", async () => {
    const seen: [string, unknown][] = [];
    const f = (async () =>
      new Response(
        JSON.stringify({
          data: {
            ok: 1,
            rateLimit: { cost: 1, limit: 5000, remaining: 4000, resetAt: "2026-10-17T12:40:00Z" },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const gql = makeGql("tok", f, { record: (q, rl) => seen.push([q, rl]) }, () => NOW);
    const data = await gql("query Board($a: Int) { x }", {});
    expect((data as { ok: number }).ok).toBe(1);
    expect(seen).toEqual([["Board", reading(4000)]]);
  });

  it("every query the collectors send is named and selects rateLimit", async () => {
    const sent: string[] = [];
    const more = { hasNextPage: true, endCursor: "T1" };
    const gql: Gql = async (q) => {
      sent.push(q);
      switch (queryName(q)) {
        case "Escalations":
          return {
            search: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  number: 7,
                  title: "[operator-decision] x",
                  labels: { nodes: [] },
                  comments: {
                    nodes: [{ body: "chatter", createdAt: "2026-10-06T00:00:00Z" }],
                    pageInfo: { hasPreviousPage: true, startCursor: "c0" },
                  },
                },
              ],
            },
          };
        case "Comments":
          return {
            repository: {
              issue: { comments: { nodes: [], pageInfo: { hasPreviousPage: false } } },
            },
          };
        case "FlowBatch":
          // the issue batch carries a timeline with more pages; the PR batch has none
          return q.includes("timelineItems")
            ? { repository: { a0: { timelineItems: { nodes: [], pageInfo: more } } } }
            : { repository: { a0: { commits: { nodes: [] } } } };
        case "FlowTimeline":
          return {
            repository: {
              a0: {
                timelineItems: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            },
          };
        default:
          return {};
      }
    };
    await collectGithub(repo, store, gql, NOW);
    await sweepPullRequests(repo, store, gql, NOW);
    await fetchTicket(repo, 1, gql);
    store.replaceBoard("shop-app", [
      {
        repoId: "shop-app",
        issueNumber: 1,
        title: "t",
        status: "Done",
        state: "done",
        labels: [],
        priority: null,
        prioritySource: null,
        closed: false,
        updatedAt: NOW,
        url: "u",
        stage: null,
        owner: null,
        size: null,
        parent: null,
        subIssues: null,
        blockedBy: [],
        milestone: null,
        createdAt: 1,
        itemId: null,
        projectId: null,
      } satisfies BoardItem,
    ]);
    store.upsertPullRequests(
      "shop-app",
      [
        {
          repoId: "shop-app",
          number: 2,
          title: "t",
          url: "u",
          branch: "b",
          ticket: null,
          state: "merged",
          isDraft: false,
          review: null,
          ci: null,
          createdAt: 1,
          updatedAt: NOW,
          mergedAt: NOW,
          headSha: null,
          mergeable: null,
        } satisfies PullRequestView,
      ],
      NOW,
    );
    await collectFlow(repo, store, gql, NOW);
    const names = new Set(sent.map(queryName));
    for (const n of ["Comments", "FlowBatch", "FlowTimeline"]) expect(names).toContain(n);
    for (const q of sent) {
      expect(q).toContain(RATE_LIMIT_SELECTION);
      expect(queryName(q)).not.toBe("anonymous");
    }
  });

  it("selects the token's own limit", () => {
    expect(RATE_LIMIT_SELECTION).toContain("limit");
  });
});

describe("RateLimits", () => {
  it("keeps the last reading per query, the latest overall, and the poll's cost", () => {
    const rates = new RateLimits(store);
    const start = rates.startPoll();
    rates.record("Board", reading(4000, { cost: 1, at: NOW }));
    rates.record("Escalations", reading(3990, { cost: 3, at: NOW + 1 }));
    rates.record("Escalations", reading(3980, { cost: 3, at: NOW + 2 }));
    rates.record("Ticket", reading(3979, { cost: 1, at: NOW + 3 })); // not a poll query
    rates.endPoll(start);
    expect(rates.latest()?.remaining).toBe(3979);
    expect(rates.state()).toEqual({
      queries: {
        Board: reading(4000),
        Escalations: reading(3980, { cost: 3, at: NOW + 2 }),
        Ticket: reading(3979, { at: NOW + 3 }),
      },
      pollCost: 7,
    });
    expect(new RateLimits(store).state()).toEqual(rates.state()); // survives a restart
  });

  it("is a per-poll delta: the second poll's cost does not include the first's", () => {
    const rates = new RateLimits(store);
    let start = rates.startPoll();
    rates.record("Board", reading(4000, { cost: 2 }));
    rates.record("Comments", reading(3990, { cost: 3 }));
    rates.endPoll(start);
    expect(rates.state().pollCost).toBe(5);
    start = rates.startPoll();
    rates.record("Board", reading(3980, { cost: 2 }));
    rates.endPoll(start);
    expect(rates.state().pollCost).toBe(2);
  });

  it("backs off below 10% of the token's own limit, not a fixed 5000", () => {
    expect(isLow(reading(1249, { limit: 12500 }))).toBe(true);
    expect(isLow(reading(1250, { limit: 12500 }))).toBe(false);
    expect(isLow(reading(1000, { limit: 12500 }))).toBe(true); // not low against 5000
    expect(isLow(reading(499, { limit: 1000 }))).toBe(false); // low against 5000
    expect(nextBackoff(1, reading(1249, { limit: 12500 }), NOW)).toBe(2);
    expect(nextBackoff(1, reading(1250, { limit: 12500 }), NOW)).toBe(1);
  });

  it("a low reading without a reset time backs off at the cap, a healthy one does not", () => {
    expect(nextBackoff(1, reading(100, { resetAt: 0 }), NOW)).toBe(GITHUB_BACKOFF_MAX);
    expect(nextBackoff(1, reading(4000, { resetAt: 0 }), NOW)).toBe(1);
  });

  it("backs off only below 10% of 5000, doubling to the cap, and ends at the reset", () => {
    expect(isLow(reading(499))).toBe(true);
    expect(isLow(reading(500))).toBe(false);
    expect(nextBackoff(1, null, NOW)).toBe(1);
    expect(nextBackoff(1, reading(500), NOW)).toBe(1);
    expect(nextBackoff(1, reading(499), NOW)).toBe(2);
    expect(nextBackoff(2, reading(499), NOW)).toBe(4);
    expect(nextBackoff(GITHUB_BACKOFF_MAX, reading(499), NOW)).toBe(GITHUB_BACKOFF_MAX);
    expect(nextBackoff(4, reading(499), RESET)).toBe(1);
  });
});

describe("an exhausted budget", () => {
  const sink = () => {
    const seen: [string, unknown][] = [];
    return { seen, rates: { record: (q: string, rl: unknown) => void seen.push([q, rl]) } };
  };
  const exhausted = (remaining: number) => ({
    cost: 0,
    limit: 5000,
    remaining,
    at: NOW,
  });

  it("an HTTP 403 records remaining 0 with the reset from x-ratelimit-reset, and still fails", async () => {
    const { seen, rates } = sink();
    const f = (async () =>
      new Response("{}", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(RESET / 1000) },
      })) as unknown as typeof fetch;
    const gql = makeGql("tok", f, rates, () => NOW);
    await expect(gql("query Board { x }", {})).rejects.toThrow("github: HTTP 403");
    expect(seen).toEqual([["Board", { ...exhausted(0), resetAt: RESET }]]);
  });

  it("a 403 that is not about the rate limit (permissions, SAML, a revoked token) records nothing", async () => {
    const { seen, rates } = sink();
    const f = (async () =>
      new Response("{}", {
        status: 403,
        headers: { "x-ratelimit-remaining": "5000", "x-ratelimit-reset": String(RESET / 1000) },
      })) as unknown as typeof fetch;
    const gql = makeGql("tok", f, rates, () => NOW);
    await expect(gql("query Board { x }", {})).rejects.toThrow("github: HTTP 403");
    expect(seen).toEqual([]);
    const bare = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    await expect(makeGql("tok", bare, rates, () => NOW)("query Board { x }", {})).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("a secondary limit (retry-after) resets that many seconds from now", async () => {
    const { seen, rates } = sink();
    const f = (async () =>
      new Response("{}", {
        status: 403,
        headers: { "retry-after": "90", "x-ratelimit-remaining": "4000" },
      })) as unknown as typeof fetch;
    const gql = makeGql("tok", f, rates, () => NOW);
    await expect(gql("query Board { x }", {})).rejects.toThrow("HTTP 403");
    expect(seen).toEqual([["Board", { ...exhausted(0), resetAt: NOW + 90_000 }]]);
  });

  it("a reset time already past still backs off for a minimum window", async () => {
    const { seen, rates } = sink();
    const f = (async () =>
      new Response("{}", {
        status: 429,
        headers: { "x-ratelimit-reset": String((NOW - 5000) / 1000) },
      })) as unknown as typeof fetch;
    const gql = makeGql("tok", f, rates, () => NOW);
    await expect(gql("query Board { x }", {})).rejects.toThrow("HTTP 429");
    expect(seen).toEqual([["Board", { ...exhausted(0), resetAt: NOW + EXHAUSTED_MIN_RESET_MS }]]);
  });

  it("an HTTP 429 without a reset header records a reset an hour from now", async () => {
    const { seen, rates } = sink();
    const f = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    const gql = makeGql("tok", f, rates, () => NOW);
    await expect(gql("query Comments { x }", {})).rejects.toThrow("github: HTTP 429");
    expect(seen).toEqual([["Comments", { ...exhausted(0), resetAt: NOW + 3_600_000 }]]);
  });

  it("other HTTP failures record nothing", async () => {
    const { seen, rates } = sink();
    const f = (async () => new Response("{}", { status: 502 })) as unknown as typeof fetch;
    const gql = makeGql("tok", f, rates, () => NOW);
    await expect(gql("query Board { x }", {})).rejects.toThrow("HTTP 502");
    expect(seen).toEqual([]);
  });

  it("a RATE_LIMITED GraphQL error records remaining 0 and throws as before", async () => {
    const { seen, rates } = sink();
    const f = (async () =>
      new Response(
        JSON.stringify({
          data: null,
          errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
        }),
        { status: 200, headers: { "x-ratelimit-reset": String(RESET / 1000) } },
      )) as unknown as typeof fetch;
    const gql = makeGql("tok", f, rates, () => NOW);
    const err = await gql("query Board { x }", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GqlError);
    expect(seen).toEqual([["Board", { ...exhausted(0), resetAt: RESET }]]);
  });

  it("another GraphQL error records nothing", async () => {
    const { seen, rates } = sink();
    const f = (async () =>
      new Response(JSON.stringify({ errors: [{ type: "NOT_FOUND", message: "no" }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const gql = makeGql("tok", f, rates, () => NOW);
    await gql("query Board { x }", {}).catch(() => undefined);
    expect(seen).toEqual([]);
  });

  it("is low whatever the limit, so the poll backs off", () => {
    expect(isLow({ ...exhausted(0), resetAt: RESET })).toBe(true);
    expect(nextBackoff(1, { ...exhausted(0), resetAt: RESET }, NOW)).toBe(2);
  });
});

describe("githubRate view", () => {
  it("is empty before any reading and returns remaining and the per-poll cost after", () => {
    expect(githubRate(store)).toEqual({ queries: {}, pollCost: null });
    const rates = new RateLimits(store);
    const start = rates.startPoll();
    rates.record("Board", reading(1234));
    rates.endPoll(start);
    expect(githubRate(store)).toEqual({ queries: { Board: reading(1234) }, pollCost: 1 });
    expect(store.getSetting(GITHUB_RATE_SETTING)).not.toBeNull();
  });
});
