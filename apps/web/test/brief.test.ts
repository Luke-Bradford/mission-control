import type { CrewRow, PullRequestView } from "@mc/core";
import { describe, expect, it } from "vitest";
import { type BriefCtx, standup, weekly } from "../src/board/brief.ts";
import { boardItem, crewRow, item, NOW } from "./fixtures.ts";

const DAY = 86_400_000;
const RUN = crewRow().run as NonNullable<CrewRow["run"]>;
const TZ = "Europe/London";

const pr = (n: number, ticket: string, state: PullRequestView["state"]): PullRequestView => ({
  repoId: "shop-app",
  number: n,
  title: "t",
  url: "https://github.com/octo-org/shop-app/pull/1",
  branch: "fix/x",
  ticket,
  state,
  isDraft: false,
  review: null,
  ci: null,
  createdAt: NOW - DAY,
  updatedAt: NOW,
  mergedAt: null,
  headSha: null,
  mergeable: null,
});

const ctx = (over: Partial<BriefCtx> = {}): BriefCtx => ({
  laneName: "shop-app",
  prs: [],
  crew: [],
  needsYou: [],
  ...over,
});

const mk = (n: number, status: string, over = {}) =>
  boardItem({
    issueNumber: n,
    title: `Ticket ${n}`,
    status,
    state: status === "Done" ? "done" : "in progress",
    priority: "P1",
    ...over,
  });

describe("standup", () => {
  it("golden string: sections in order, no agent id, current loop step and held state", () => {
    const items = [
      mk(1, "Done", { updatedAt: NOW - 3600_000 }),
      mk(2, "Done", { updatedAt: NOW - 5 * DAY }),
      mk(3, "Ready for QA"),
      mk(4, "In progress"),
      mk(5, "In progress", { priority: "P0" }),
      mk(6, "Ready", { priority: "P2" }),
      mk(7, "Ready", { priority: "P0" }),
      mk(8, "Ready", { priority: "P1" }),
      mk(9, "Blocked", { blockedBy: [{ ref: "shop-app#2", closed: false }] }),
      mk(10, "In review"),
      mk(11, "In review"),
    ];
    const c = ctx({
      prs: [pr(50, "shop-app#1", "merged"), pr(51, "shop-app#10", "open")],
      crew: [
        crewRow({
          ticket: "shop-app#4",
          hudState: "running",
          loop: {
            phase: "working",
            step: "implement",
            text: "Working",
            prNumber: null,
            parked: null,
          },
        }),
        crewRow({
          id: "shop-app-2",
          ticket: "shop-app#5",
          hudState: "stalled",
          run: { ...RUN, seq: 7 },
          loop: { phase: "ci", step: null, text: "CI", prNumber: null, parked: null },
        }),
      ],
      needsYou: [item({ escalationId: "shop-app#11", ticket: "shop-app#11", agentId: null })],
    });
    expect(standup(items, c, NOW, TZ)).toBe(
      [
        "Standup, Saturday 17 October (shop-app)",
        "Since yesterday\n- shop-app#1 (PR #50): Ticket 1 (merged)\n- shop-app#3: Ticket 3 (merged, with QA)",
        "Today\n- shop-app#5: Ticket 5 (CI, held up)\n- shop-app#4: Ticket 4 (implement)\n- shop-app#7: Ticket 7 (up next)\n- shop-app#8: Ticket 8 (up next)",
        "Blocked or waiting on me\n- shop-app#9: Ticket 9 (blocked by shop-app#2)\n- shop-app#11: Ticket 11 (waiting on me)",
        "In review\n- shop-app#10 (PR #51): Ticket 10 (PR open)",
      ].join("\n\n"),
    );
    expect(standup(items, c, NOW, TZ)).not.toContain("shop-app-");
  });

  it("omits empty sections", () => {
    expect(standup([], ctx(), NOW, TZ)).toBe("Standup, Saturday 17 October (shop-app)");
  });
});

describe("weekly", () => {
  it.each([
    { isDraft: true, review: null, action: "decide on the draft" },
    { isDraft: false, review: null, action: "review" },
    { isDraft: false, review: "approved" as const, action: "merge" },
  ])(
    "names the In review action from its Needs-you item: $action",
    ({ isDraft, review, action }) => {
      const c = ctx({
        prs: [{ ...pr(51, "shop-app#10", "open"), isDraft, review, updatedAt: NOW - 9 * DAY }],
        needsYou: [
          item({
            key: "pr:shop-app#51:1",
            kind: "pr",
            text: `PR #51 · You: ${action}`,
            agentId: null,
            escalationId: null,
            ticket: "shop-app#10",
          }),
        ],
      });
      expect(weekly([mk(10, "In review")], c, 14, NOW, TZ)).toContain(
        `In review\n- shop-app#10 (PR #51): Ticket 10 (waiting for me to ${action})`,
      );
    },
  );
  it("a PR the Needs-you set does not hold waits on nobody", () => {
    const c = ctx({
      prs: [{ ...pr(51, "shop-app#10", "open"), isDraft: true, updatedAt: NOW - 9 * DAY }],
    });
    expect(weekly([mk(10, "In review")], c, 14, NOW, TZ)).toContain(
      "In review\n- shop-app#10 (PR #51): Ticket 10 (PR open)",
    );
  });
  it("golden string", () => {
    const items = [
      mk(1, "Done", { updatedAt: NOW - 1000 }),
      mk(2, "Done", { updatedAt: NOW - 3 * DAY }),
      mk(3, "Done", { updatedAt: NOW - DAY }),
      mk(4, "Ready for QA"),
      mk(5, "In review"),
      mk(6, "In review"),
      mk(7, "In progress"),
      mk(8, "Blocked", { blockedBy: [{ ref: "shop-app#2", closed: false }] }),
      mk(9, "Ready", { priority: "P2" }),
      mk(10, "Ready", { priority: "P0" }),
    ];
    const c = ctx({
      prs: [pr(60, "shop-app#2", "merged")],
      needsYou: [item({ escalationId: "shop-app#6", ticket: "shop-app#6", agentId: null })],
    });
    expect(weekly(items, c, 14, NOW, TZ)).toBe(
      [
        "Update: shop-app, last 14 days",
        "Done\n- shop-app#1: Ticket 1 (closed today)\n- shop-app#3: Ticket 3 (closed 1 day ago)\n- shop-app#2 (PR #60): Ticket 2 (merged 3 days ago)",
        "Ready for QA\n- shop-app#4: Ticket 4",
        "In review\n- shop-app#5: Ticket 5 (PR open)\n- shop-app#6: Ticket 6 (PR open)",
        "In progress\n- shop-app#7: Ticket 7",
        "Blocked\n- shop-app#8: Ticket 8 (blocked by shop-app#2)",
        "Coming up next\n- shop-app#10: Ticket 10 (P0)\n- shop-app#9: Ticket 9 (P2)",
      ].join("\n\n"),
    );
  });
});

describe("standup: a PR waiting on me", () => {
  it("goes under Blocked or waiting on me with what I need to do", () => {
    const items = [mk(10, "In review")];
    const draft = { ...pr(51, "shop-app#10", "open"), isDraft: true, updatedAt: NOW - 9 * DAY };
    const c = ctx({
      prs: [draft],
      needsYou: [
        item({
          key: "pr:shop-app#51:1",
          kind: "pr",
          text: "PR #51 · You: decide on the draft",
          agentId: null,
          escalationId: null,
          ticket: "shop-app#10",
        }),
      ],
    });
    const out = standup(items, c, NOW, TZ);
    expect(out).toContain(
      "Blocked or waiting on me\n- shop-app#10 (PR #51): Ticket 10 (I need to decide on the draft)",
    );
    expect(out).not.toContain("In review");
  });
});
