import { describe, expect, it } from "vitest";
import {
  isTestPath,
  linkEscapedDefect,
  parseDefectRefs,
  QA_FLOW_METRICS,
  reviewTimings,
  reworkRatios,
  testsTouched,
} from "../src/index.ts";

const pr = (
  number: number,
  mergedAt: number,
  extra: { shas?: string[]; files?: string[] } = {},
) => ({
  number,
  mergedAt,
  shas: extra.shas ?? [],
  files: extra.files ?? [],
});

describe("parseDefectRefs", () => {
  it("reads PR numbers, URLs, shas and file paths from a bug body", () => {
    const refs = parseDefectRefs(
      "Broke after #12 and https://github.com/o/r/pull/34. See abc1234 and `apps/server/src/store.ts`.",
    );
    expect(refs.prs).toEqual([12, 34]);
    expect(refs.shas).toEqual(["abc1234"]);
    expect(refs.paths).toEqual(["apps/server/src/store.ts"]);
  });

  it("does not take plain words as shas", () => {
    expect(parseDefectRefs("defaced decade effaced").shas).toEqual([]);
  });
});

describe("linkEscapedDefect", () => {
  const bug = (refs: Partial<ReturnType<typeof parseDefectRefs>>, createdAt = 1000) => ({
    createdAt,
    refs: { prs: [], shas: [], paths: [], ...refs },
  });

  it("links a bug that names the PR", () => {
    expect(linkEscapedDefect(bug({ prs: [7] }), [pr(7, 500), pr(8, 600)])).toEqual([
      { prNumber: 7, via: "pr" },
    ]);
  });

  it("links a bug that names a commit of the PR, by prefix", () => {
    const prs = [pr(7, 500, { shas: ["abc1234def5678"] })];
    expect(linkEscapedDefect(bug({ shas: ["abc1234"] }), prs)).toEqual([
      { prNumber: 7, via: "commit" },
    ]);
  });

  it("links a file path that exactly one PR changed", () => {
    const prs = [pr(7, 500, { files: ["a.ts", "b.ts"] }), pr(8, 600, { files: ["c.ts"] })];
    expect(linkEscapedDefect(bug({ paths: ["b.ts"] }), prs)).toEqual([
      { prNumber: 7, via: "file" },
    ]);
  });

  it("leaves out a path two PRs changed", () => {
    const prs = [pr(7, 500, { files: ["a.ts"] }), pr(8, 600, { files: ["a.ts"] })];
    expect(linkEscapedDefect(bug({ paths: ["a.ts"] }), prs)).toEqual([]);
  });

  it("leaves out a bug filed before the merge", () => {
    expect(linkEscapedDefect(bug({ prs: [7] }, 400), [pr(7, 500)])).toEqual([]);
  });

  it("keeps the strongest route when one PR is named twice", () => {
    const prs = [pr(7, 500, { shas: ["abc1234def"], files: ["a.ts"] })];
    expect(linkEscapedDefect(bug({ prs: [7], shas: ["abc1234"], paths: ["a.ts"] }), prs)).toEqual([
      { prNumber: 7, via: "pr" },
    ]);
  });
});

describe("reviewTimings", () => {
  it("measures wait and review time per head and summarises them", () => {
    const t = reviewTimings([
      { reviewId: 1, createdAt: 0, startedAt: 100, endedAt: 400 },
      { reviewId: 2, createdAt: 0, startedAt: 300, endedAt: 400 },
      { reviewId: 3, createdAt: 0, startedAt: null, endedAt: 400 },
    ]);
    expect(t.heads).toEqual([
      { reviewId: 1, reviewWaitMs: 100, reviewMs: 300 },
      { reviewId: 2, reviewWaitMs: 300, reviewMs: 100 },
    ]);
    expect(t.wait).toMatchObject({ n: 2, medianMs: 200 });
    expect(t.review).toMatchObject({ n: 2, medianMs: 200 });
  });

  it("reports nothing for no heads", () => {
    expect(reviewTimings([]).wait).toEqual({ n: 0, medianMs: null, p85Ms: null });
  });
});

describe("reworkRatios", () => {
  it("is rounds with a blocking finding over rounds, per seat and per model", () => {
    const r = reworkRatios([
      { seat: "guido-1", model: "opus", blocking: 2 },
      { seat: "guido-1", model: "opus", blocking: 0 },
      { seat: "guido-1", model: "sonnet", blocking: 1 },
      { seat: "inco-1", model: "sonnet", blocking: 0 },
    ]);
    expect(r.bySeat).toEqual([
      { key: "guido-1", rounds: 3, reworked: 2, ratio: 2 / 3, enough: true },
      { key: "inco-1", rounds: 1, reworked: 0, ratio: 0, enough: false },
    ]);
    expect(r.byModel.map((g) => [g.key, g.rounds, g.reworked])).toEqual([
      ["opus", 2, 1],
      ["sonnet", 2, 1],
    ]);
  });
});

describe("tests per PR", () => {
  it("knows test paths", () => {
    expect(isTestPath("apps/server/test/store.test.ts")).toBe(true);
    expect(isTestPath("packages/core/src/a.spec.ts")).toBe(true);
    expect(isTestPath("apps/web/__tests__/x.tsx")).toBe(true);
    expect(isTestPath("apps/server/src/store.ts")).toBe(false);
  });

  it("splits added from changed test files and ignores deletions", () => {
    expect(
      testsTouched([
        { path: "a/test/x.test.ts", changeType: "ADDED" },
        { path: "a/test/y.test.ts", changeType: "MODIFIED" },
        { path: "a/test/z.test.ts", changeType: "RENAMED" },
        { path: "a/test/gone.test.ts", changeType: "DELETED" },
        { path: "a/src/x.ts", changeType: "ADDED" },
      ]),
    ).toEqual({ added: 1, changed: 2 });
  });
});

describe("QA flow metrics", () => {
  it("defines every figure with a window, unit and definition", () => {
    for (const def of Object.values(QA_FLOW_METRICS)) {
      expect(def.window).not.toBe("");
      expect(def.definition.length).toBeGreaterThan(20);
    }
    expect(Object.keys(QA_FLOW_METRICS).sort()).toEqual([
      "escapedDefects",
      "reviewTime",
      "reviewWait",
      "reworkRatio",
      "testsPerPr",
    ]);
  });
});
