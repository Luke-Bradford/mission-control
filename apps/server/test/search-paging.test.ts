import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectGithub, fetchComments, type Gql } from "../src/collectors/github.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const repo: CcConfig["repos"][number] = {
  id: "shop-app",
  github: "octo-org/shop-app",
  project: 2,
  statusMap: {},
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
const fence = `\`\`\`autonomy-question\n${JSON.stringify(Q)}\n\`\`\``;
const prose = (n: number) => ({ body: `chatter ${n}`, createdAt: "2026-10-06T00:00:00Z" });
const thirty = Array.from({ length: 30 }, (_, i) => prose(i));

function issue(n: number, title: string, labels: string[], comments: unknown = { nodes: [] }) {
  return {
    number: n,
    title,
    url: `https://github.com/octo-org/shop-app/issues/${n}`,
    createdAt: "2026-10-05T10:00:00Z",
    labels: { nodes: labels.map((name) => ({ name })) },
    comments,
  };
}
const commentPage = (nodes: unknown[], hasPreviousPage: boolean, startCursor: string | null) => ({
  nodes,
  pageInfo: { hasPreviousPage, startCursor },
});

interface Call {
  q: string;
  v: Record<string, unknown>;
}
const isSearch = (c: Call) => c.q.includes("search(");
const isCommentsPage = (c: Call) => !isSearch(c) && c.q.includes("comments(last");

/** `pages(q, n)` is page n (0-based) of the search for `q`; `comments(v)` answers a backwards page. */
function searching(
  pages: (q: string, n: number) => { nodes: unknown[]; more: boolean },
  comments?: (v: Record<string, unknown>) => unknown,
) {
  const calls: Call[] = [];
  const gql: Gql = async (q, v) => {
    calls.push({ q, v });
    if (q.includes("search(")) {
      const n = typeof v.after === "string" ? Number(v.after) : 0;
      const { nodes, more } = pages(String(v.q), n);
      return {
        search: {
          nodes,
          pageInfo: { hasNextPage: more, endCursor: more ? String(n + 1) : null },
        },
      };
    }
    if (q.includes("comments(last")) return comments?.(v);
    if (q.includes("milestones")) return { repository: { milestones: { nodes: [] } } };
    if (q.includes("pullRequests")) {
      return {
        repository: {
          pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        },
      };
    }
    return {
      repositoryOwner: {
        __typename: "User",
        projectV2: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } },
      },
    };
  };
  return { gql, calls };
}

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());
const note = () => store.status().find((s) => s.collector === "github:shop-app")?.error ?? "";

describe("search paging", () => {
  const marker = (q: string) => q.includes("in:title operator-decision");

  it("reads every page of a search that has more, and sets no flag", async () => {
    const { gql, calls } = searching((q, n) => ({
      nodes: marker(q) ? [issue(10 + n, "[operator-decision] x", [])] : [],
      more: marker(q) && n < 2,
    }));
    await collectGithub(repo, store, gql, NOW);
    expect(store.escalations().map((e) => e.issueNumber)).toEqual([10, 11, 12]);
    expect(calls.filter(isSearch)).toHaveLength(3 + 3); // three pages for one marker, one each for the rest
    expect(calls.filter(isSearch)[0]?.q).toContain("first: 50");
    expect(note()).not.toContain("truncated");
  });

  it("stops at 5 pages of a search that never ends and says it is truncated", async () => {
    const { gql, calls } = searching((q, n) => ({
      nodes: q.includes("loop-blocked") ? [issue(100 + n, "[loop-blocked] x", [])] : [],
      more: true,
    }));
    await collectGithub(repo, store, gql, NOW);
    const forMarker = calls.filter((c) => isSearch(c) && String(c.v.q).includes("loop-blocked"));
    expect(forMarker).toHaveLength(5);
    expect(store.escalations()).toHaveLength(5);
    expect(store.status().find((s) => s.collector === "github:shop-app")?.ok).toBe(true);
    expect(note()).toContain("truncated");
    expect(note()).toContain("search");
  });

  it("says it is truncated when GitHub has more pages but sends no cursor", async () => {
    const { gql } = searching((q) => ({
      nodes: marker(q) ? [issue(10, "[operator-decision] x", [])] : [],
      more: false,
    }));
    let asked = 0;
    await collectGithub(
      repo,
      store,
      async (q, v) => {
        const out = await gql(q, v);
        if (q.includes("search(") && marker(String(v.q))) asked++;
        if (!q.includes("search(") || !marker(String(v.q))) return out;
        return {
          search: {
            nodes: (out as { search: { nodes: unknown[] } }).search.nodes,
            pageInfo: { hasNextPage: true, endCursor: null },
          },
        };
      },
      NOW,
    );
    expect(asked).toBe(1); // no cursor to follow: it does not ask again
    expect(store.escalations().map((e) => e.issueNumber)).toEqual([10]);
    expect(note()).toContain("truncated");
    expect(note()).toContain("search");
  });
});

describe("comment paging", () => {
  const onlyTitleSearch = (node: unknown) => (q: string, n: number) => ({
    nodes: q.includes("in:title operator-decision") && n === 0 ? [node] : [],
    more: false,
  });
  const onlyLabelSearch = (node: unknown) => (q: string, n: number) => ({
    nodes: q.includes("label:") && n === 0 ? [node] : [],
    more: false,
  });

  it("pages comments backwards until the marker is found", async () => {
    const { gql, calls } = searching(
      onlyTitleSearch(
        issue(16, "[operator-decision] triaged", ["needs-design"], commentPage(thirty, true, "c0")),
      ),
      (v) => ({
        repository: {
          issue: {
            comments:
              v.before === "c0"
                ? commentPage([{ body: fence, createdAt: "2026-10-01T00:00:00Z" }], false, null)
                : commentPage([], false, null),
          },
        },
      }),
    );
    await collectGithub(repo, store, gql, NOW);
    expect(store.escalations()[0]?.question).toEqual(Q);
    const back = calls.filter(isCommentsPage);
    expect(back).toHaveLength(1);
    expect(back[0]?.q).toContain("last: 30");
    expect(back[0]?.v).toMatchObject({ number: 16, before: "c0" });
    expect(note()).not.toContain("truncated");
  });

  it("does not page comments when the first page already holds the marker", async () => {
    const first = commentPage(
      [prose(1), { body: fence, createdAt: "2026-10-06T00:00:00Z" }],
      true,
      "c0",
    );
    const { gql, calls } = searching(
      onlyTitleSearch(issue(16, "[operator-decision] t", ["needs-design"], first)),
    );
    await collectGithub(repo, store, gql, NOW);
    expect(store.escalations()[0]?.question).toEqual(Q);
    expect(calls.filter(isCommentsPage)).toHaveLength(0);
  });

  it("stops at 5 comment pages in all when no marker turns up, and says it is truncated", async () => {
    const { gql, calls } = searching(
      onlyTitleSearch(
        issue(16, "[operator-decision] t", ["needs-design"], commentPage(thirty, true, "c0")),
      ),
      (v) => ({
        repository: { issue: { comments: commentPage(thirty, true, `${String(v.before)}x`) } },
      }),
    );
    await collectGithub(repo, store, gql, NOW);
    // the search carried page 1; four more make 5
    expect(calls.filter(isCommentsPage)).toHaveLength(4);
    expect(store.escalations()[0]?.question).toBeNull();
    expect(note()).toContain("truncated");
    expect(note()).toContain("#16");
  });

  it("is not truncated when the history ends exactly at the bound", async () => {
    let served = 0;
    const { gql } = searching(
      onlyTitleSearch(
        issue(16, "[operator-decision] t", ["needs-design"], commentPage(thirty, true, "c0")),
      ),
      () => ({
        repository: { issue: { comments: commentPage(thirty, ++served < 4, `c${served}`) } },
      }),
    );
    await collectGithub(repo, store, gql, NOW);
    expect(served).toBe(4);
    expect(note()).not.toContain("truncated");
  });

  it("puts comments paged backwards in oldest-first order", async () => {
    const c = (n: number) => ({ body: `c${n}`, createdAt: "2026-10-06T00:00:00Z" });
    const pages: Record<string, unknown> = {
      p1: commentPage([c(3), c(4)], true, "p2"),
      p2: commentPage([c(1), c(2)], false, null),
    };
    const { gql } = searching(
      () => ({ nodes: [], more: false }),
      (v) => ({ repository: { issue: { comments: pages[String(v.before)] } } }),
    );
    const got = await fetchComments(repo, gql, 16, commentPage([c(5), c(6)], true, "p1"));
    expect(got.comments.map((x) => x.body)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
    expect(got.truncated).toBe(false);
  });

  it("does not page comments of an issue with no title marker, whatever its length", async () => {
    const forty = Array.from({ length: 40 }, (_, i) => prose(i));
    const { gql, calls } = searching(
      onlyLabelSearch(
        issue(17, "needs a decision", ["needs-design"], commentPage(forty, true, "c0")),
      ),
      () => ({ repository: { issue: { comments: commentPage(thirty, true, "c1") } } }),
    );
    await collectGithub(repo, store, gql, NOW);
    expect(store.escalations().map((e) => e.issueNumber)).toEqual([17]);
    expect(calls.filter(isCommentsPage)).toHaveLength(0);
    // older comments exist and were not read: the note says so
    expect(note()).toContain("truncated");
    expect(note()).toContain("#17");
  });

  it("a label-only issue is not truncated when its carried comments are all of them, or hold the fence", async () => {
    const whole = searching(
      onlyLabelSearch(issue(17, "d", ["needs-design"], commentPage(thirty, false, null))),
    );
    await collectGithub(repo, store, whole.gql, NOW);
    expect(note()).not.toContain("truncated");
    const fenced = searching(
      onlyLabelSearch(
        issue(
          17,
          "d",
          ["needs-design"],
          commentPage([{ body: fence, createdAt: "2026-10-06T00:00:00Z" }], true, "c0"),
        ),
      ),
    );
    await collectGithub(repo, store, fenced.gql, NOW);
    expect(note()).not.toContain("truncated");
    expect(store.escalations()[0]?.question).toEqual(Q);
  });
});
