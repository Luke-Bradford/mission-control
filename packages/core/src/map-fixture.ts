import type { MapDelta, MapSnapshot } from "./map.ts";

/** Invented, repo-relative sample data for consumers building against the slice 0 contract. */
export const mapSnapshotFixture = {
  repoId: "sample",
  tree: [
    { path: "src/main.ts", lines: 60 },
    { path: "src/util.ts", lines: 20 },
  ],
  imports: [{ from: "src/main.ts", to: "src/util.ts" }],
  seats: [
    {
      seat: "GUIDO-1",
      state: "running",
      since: 2000,
      ticket: 7,
      title: "Handle empty input",
      branches: ["feature/7-empty-input"],
      tickets: { "feature/7-empty-input": 7 },
      calls: [{ tool: "Read", detail: "src/util.ts", files: ["src/util.ts"], since: 2000 }],
      scope: {
        read: ["src/main.ts", "src/util.ts"],
        modified: [{ file: "src/main.ts", add: 12, rem: 3, source: "churn" }],
      },
      recent: [{ file: "src/main.ts", at: 2000 }],
      context: { total: 12000, window: 64000 },
      badges: {
        questions: [{ id: 1, from: "GUIDO-1", to: "CAPCOM", ticket: 7, since: 1500 }],
        failures: [{ at: 1500, tool: "Write", refused: true, why: "Permission denied" }],
        review: { ticket: 7, round: 1, counts: { Critical: 0, Important: 1, Minor: 0 }, at: 1800 },
        tests: {
          runner: "vitest",
          status: "passed",
          passed: 4,
          failed: 0,
          at: 1000,
          editedSince: true,
        },
        ci: { sha: "aaaaaaaa", checks: [], at: 1900 },
        waiting: null,
      },
    },
  ],
  findings: [
    {
      seat: "GUIDO-1",
      ticket: 7,
      round: 1,
      severity: "Important",
      file: "src/main.ts",
      line: 12,
      summary: "Empty input throws",
      scenario: "An empty list reaches the first item lookup.",
      fix: "Return early for an empty list.",
    },
  ],
  conflicts: [],
  conflictsUnchecked: [],
  seq: 0,
} satisfies MapSnapshot;

/** Ordered frames following mapSnapshotFixture; payload tokens belong to individual calls. */
export const mapDeltaFixture = [
  {
    seq: 1,
    type: "call.start",
    seat: "GUIDO-1",
    tool: "Edit",
    detail: "src/main.ts",
    files: ["src/main.ts"],
    writeTok: 32,
  },
  {
    seq: 2,
    type: "call.end",
    seat: "GUIDO-1",
    files: ["src/main.ts"],
    resultTok: 8,
    error: false,
    refused: false,
    why: null,
    tests: null,
  },
  { seq: 3, type: "edit", seat: "GUIDO-1", file: "src/main.ts", add: 2, rem: 1 },
  { seq: 4, type: "state", seat: "GUIDO-1", state: "running", since: 3000 },
  { seq: 5, type: "message", from: "GUIDO-1", to: "RETRO-1", kind: "review", ticket: 7 },
  {
    seq: 6,
    type: "review",
    seat: "GUIDO-1",
    ticket: 7,
    round: 2,
    counts: { Critical: 0, Important: 0, Minor: 0 },
  },
  { seq: 7, type: "diff", seat: "GUIDO-1", file: "src/main.ts", add: 10, rem: 2 },
] satisfies MapDelta[];
