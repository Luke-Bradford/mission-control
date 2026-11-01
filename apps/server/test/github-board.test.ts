import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BoardItem, PullRequestView, Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Gql, GqlError, GqlTransportError } from "../src/collectors/github.ts";
import type { CcConfig, CrewSeatConfig } from "../src/config.ts";
import {
  BOARD_IDS_TTL_MS,
  checkCardFieldOptions,
  clearBoardIds,
  editCardFields,
  followPrs,
  moveCard,
} from "../src/github-board.ts";
import { Store } from "../src/store.ts";

const NOW = 1_000_000_000;

const STATUS_OPTIONS = [
  { id: "O_todo", name: "Todo" },
  { id: "O_prog", name: "In Progress" },
  { id: "O_qa", name: "Ready for QA" },
  { id: "O_review", name: "In Review" },
  { id: "O_blocked", name: "Blocked" },
  { id: "O_done", name: "Done" },
];
const STATUS_MAP = {
  Todo: "planned",
  "In Progress": "in progress",
  "Ready for QA": "review",
  "In Review": "review",
  Blocked: "blocked",
  Done: "done",
};

const config = {
  repos: [
    { id: "mc", github: "octo-org/mc", project: 5, statusMap: STATUS_MAP, autonomy: "merge" },
    { id: "dr", github: "octo-org/dr", project: 6, statusMap: STATUS_MAP, autonomy: "draft" },
  ],
} as unknown as CcConfig;

/** A fake GitHub: one project with a Status field, and one issue card on it (or none yet). */
function fakeBoard(
  opts: { options?: typeof STATUS_OPTIONS; itemStatus?: string | null; ownerType?: string } = {},
) {
  const state = {
    options: opts.options ?? STATUS_OPTIONS,
    /** The card's current Status option id; `undefined`: the card is not on the board. */
    card: opts.itemStatus === undefined ? ("O_todo" as string | null) : opts.itemStatus,
    fieldId: "F_status",
    onBoard: true,
    mutationFailures: [] as Error[],
  };
  const calls: { query: string; vars: Record<string, unknown> }[] = [];
  const of = (kind: string) => calls.filter((c) => c.query.includes(kind));
  const gql: Gql = async (query, vars) => {
    calls.push({ query, vars });
    if (query.includes("updateProjectV2ItemFieldValue")) {
      const fail = state.mutationFailures.shift();
      if (fail) throw fail;
      const input = vars.input as { fieldId: string; value: { singleSelectOptionId: string } };
      // GitHub refuses ids of a deleted field or option.
      if (
        input.fieldId !== state.fieldId ||
        !state.options.some((o) => o.id === input.value.singleSelectOptionId)
      ) {
        throw new GqlError("github: Could not resolve to a node", [], null);
      }
      state.card = input.value.singleSelectOptionId;
      return { updateProjectV2ItemFieldValue: { projectV2Item: { id: "PVTI_1" } } };
    }
    if (query.includes("projectItems")) {
      return {
        repository: {
          issue: {
            projectItems: {
              nodes: state.onBoard
                ? [
                    { id: "PVTI_other", project: { id: "PVT_other" }, status: null },
                    {
                      id: "PVTI_1",
                      project: { id: "PVT_5" },
                      status: state.card === null ? null : { optionId: state.card },
                    },
                  ]
                : [{ id: "PVTI_other", project: { id: "PVT_other" }, status: null }],
            },
          },
        },
      };
    }
    return {
      repositoryOwner: {
        __typename: opts.ownerType ?? "User",
        projectV2: {
          id: "PVT_5",
          fields: {
            pageInfo: { hasNextPage: false },
            nodes: [
              { id: "F_title", name: "Title" },
              { id: state.fieldId, name: "Status", options: state.options },
            ],
          },
        },
      },
    };
  };
  return { gql, calls, state, mutations: () => of("updateProjectV2ItemFieldValue"), of };
}

/** The option id a recorded mutation set. */
const sentOption = (call: { vars: Record<string, unknown> } | undefined): string | undefined =>
  (call?.vars.input as { value?: { singleSelectOptionId?: string } } | undefined)?.value
    ?.singleSelectOptionId;

let dir: string;
let store: Store;
let now: number;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-board-"));
  store = new Store(join(dir, "mc.sqlite"));
  now = NOW;
  clearBoardIds();
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const move = (gql: Gql, over: Partial<Parameters<typeof moveCard>[1]> = {}) =>
  moveCard(
    { gql, store, config, now: () => now },
    { runId: "r1", repoId: "mc", issue: 7, column: "In review", ...over },
  );

describe("moveCard", () => {
  it("resolves Done to its Status option for a merge repo and sends nothing for a draft repo", async () => {
    const b = fakeBoard();
    expect(await move(b.gql, { column: "Done" })).toEqual({ ok: true, changed: true });
    expect(b.mutations()).toHaveLength(1);
    expect(sentOption(b.mutations()[0])).toBe("O_done");
    expect(b.state.card).toBe("O_done");

    const draft = fakeBoard();
    expect(await move(draft.gql, { repoId: "dr", column: "Done" })).toEqual({
      ok: true,
      changed: false,
    });
    expect(draft.calls).toEqual([]);
    expect(store.boardMovesOfRun("r1").filter((m) => m.repoId === "dr")).toEqual([]);
  });

  it("sends one mutation with the fixture ids and records a done row", async () => {
    const b = fakeBoard();
    expect(await move(b.gql)).toEqual({ ok: true, changed: true });
    expect(b.mutations()).toHaveLength(1);
    expect(b.mutations()[0]?.vars).toEqual({
      input: {
        projectId: "PVT_5",
        itemId: "PVTI_1",
        fieldId: "F_status",
        value: { singleSelectOptionId: "O_review" },
      },
    });
    expect(b.state.card).toBe("O_review");
    expect(store.boardMovesOfRun("r1")).toEqual([
      {
        id: 1,
        runId: "r1",
        repoId: "mc",
        issue: 7,
        column: "In review",
        state: "done",
        detail: null,
        at: NOW,
      },
    ]);
  });

  it("moves a card on an organisation's project", async () => {
    const b = fakeBoard({ ownerType: "Organization" });
    expect(await move(b.gql)).toEqual({ ok: true, changed: true });
    expect(b.mutations()).toHaveLength(1);
    expect(b.mutations()[0]?.vars).toMatchObject({ input: { projectId: "PVT_5" } });
    expect(b.state.card).toBe("O_review");
  });

  it("looks the card up by the repository's owner, name and the issue number", async () => {
    const b = fakeBoard();
    await move(b.gql);
    expect(b.of("projectItems")[0]?.vars).toEqual({
      owner: "octo-org",
      name: "mc",
      number: 7,
    });
    expect(b.calls[0]?.vars).toEqual({ owner: "octo-org", number: 5 });
  });

  it("sends nothing and records nothing when the card is already in the column", async () => {
    const b = fakeBoard({ itemStatus: "O_review" });
    expect(await move(b.gql)).toEqual({ ok: true, changed: false });
    expect(b.mutations()).toHaveLength(0);
    expect(store.boardMovesOfRun("r1")).toEqual([]);
  });

  it("makes no call and no row for a draft repo", async () => {
    const b = fakeBoard();
    expect(await move(b.gql, { repoId: "dr" })).toEqual({ ok: true, changed: false });
    expect(b.calls).toEqual([]);
    expect(store.boardMovesOfRun("r1")).toEqual([]);
  });

  it("answers an unknown repo with a reason and no call", async () => {
    const b = fakeBoard();
    expect(await move(b.gql, { repoId: "nope" })).toEqual({ ok: false, reason: "unknown repo" });
    expect(b.calls).toEqual([]);
  });

  it("with two review options, moves to the one named In review", async () => {
    const b = fakeBoard();
    expect(STATUS_OPTIONS.findIndex((o) => o.name === "Ready for QA")).toBeLessThan(
      STATUS_OPTIONS.findIndex((o) => o.name === "In Review"),
    );
    await move(b.gql, { column: "In review" });
    expect(sentOption(b.mutations()[0])).toBe("O_review");
  });

  it("answers card not on the project, with a failed row, when the issue has no item there", async () => {
    const b = fakeBoard();
    b.state.onBoard = false;
    expect(await move(b.gql)).toEqual({ ok: false, reason: "card not on the project" });
    expect(b.of("projectItems")).toHaveLength(1);
    expect(b.mutations()).toHaveLength(0);
    expect(store.boardMovesOfRun("r1")).toMatchObject([
      { state: "failed", detail: "card not on the project", column: "In review" },
    ]);
  });

  it("retries a lost request or a 5xx once, then records the move as failed", async () => {
    const b = fakeBoard();
    b.state.mutationFailures = [
      new GqlTransportError("github: HTTP 502", 502),
      new GqlTransportError("github: HTTP 502", 502),
    ];
    expect(await move(b.gql)).toEqual({ ok: false, reason: "github: HTTP 502" });
    expect(b.mutations()).toHaveLength(2);
    expect(store.boardMovesOfRun("r1")).toMatchObject([
      { state: "failed", detail: "github: HTTP 502" },
    ]);
  });

  it("is done when the retry succeeds", async () => {
    const b = fakeBoard();
    b.state.mutationFailures = [new GqlTransportError("github: request failed", null)];
    expect(await move(b.gql)).toEqual({ ok: true, changed: true });
    expect(b.mutations()).toHaveLength(2);
    expect(store.boardMovesOfRun("r1")).toMatchObject([{ state: "done", detail: null }]);
  });

  it("does not retry a 401, 403 or 429", async () => {
    for (const status of [401, 403, 429]) {
      clearBoardIds();
      const b = fakeBoard();
      b.state.mutationFailures = [new GqlTransportError(`github: HTTP ${status}`, status)];
      expect(await move(b.gql)).toEqual({ ok: false, reason: `github: HTTP ${status}` });
      expect(b.mutations()).toHaveLength(1);
    }
  });

  it("does not resend when GitHub refuses a request whose ids have not changed", async () => {
    const b = fakeBoard();
    b.state.mutationFailures = [new GqlError("github: forbidden", [], null)];
    expect(await move(b.gql)).toEqual({ ok: false, reason: "github: forbidden" });
    expect(b.mutations()).toHaveLength(1);
  });

  it("re-reads the field and sends once more when the cached ids are stale", async () => {
    const b = fakeBoard();
    await move(b.gql, { column: "In progress" });
    expect(b.of("projectV2(number")).toHaveLength(1);
    // The Status field and its options are deleted and recreated under the same names.
    b.state.fieldId = "F_status2";
    b.state.options = STATUS_OPTIONS.map((o) => ({ ...o, id: `${o.id}2` }));
    expect(await move(b.gql, { column: "In review" })).toEqual({ ok: true, changed: true });
    expect(b.mutations()).toHaveLength(3);
    expect(b.mutations().at(-1)?.vars).toEqual({
      input: {
        projectId: "PVT_5",
        itemId: "PVTI_1",
        fieldId: "F_status2",
        value: { singleSelectOptionId: "O_review2" },
      },
    });
    expect(b.of("projectV2(number")).toHaveLength(2);
    expect(store.boardMovesOfRun("r1").map((r) => r.state)).toEqual(["done", "done"]);
    // the new ids are cached: no further read
    await move(b.gql, { column: "Blocked" });
    expect(b.of("projectV2(number")).toHaveLength(2);
  });

  it("drops the stale ids even when the re-read fails, so the next move reads first", async () => {
    const b = fakeBoard();
    await move(b.gql, { column: "In progress" });
    b.state.fieldId = "F_status2";
    b.state.options = STATUS_OPTIONS.map((o) => ({ ...o, id: `${o.id}2` }));
    const flaky: Gql = async (query, vars) => {
      if (query.includes("projectV2(number") && b.of("projectV2(number").length === 1) {
        b.calls.push({ query, vars });
        throw new GqlTransportError("github: HTTP 401", 401);
      }
      return b.gql(query, vars);
    };
    expect(await move(flaky, { column: "In review" })).toEqual({
      ok: false,
      reason: "github: HTTP 401",
    });
    expect(await move(b.gql, { column: "In review" })).toEqual({ ok: true, changed: true });
    // one refused mutation in the failed move; the next move read fresh ids first
    expect(b.mutations()).toHaveLength(3);
    expect(b.of("projectV2(number")).toHaveLength(3);
  });

  it("fails after a stale-id refresh that finds no option for the column", async () => {
    const b = fakeBoard();
    await move(b.gql, { column: "In progress" });
    b.state.fieldId = "F_status2";
    b.state.options = STATUS_OPTIONS.filter((o) => o.name !== "In Review");
    expect(await move(b.gql, { column: "In review" })).toEqual({
      ok: false,
      reason: "no Status option for In review",
    });
    expect(b.mutations()).toHaveLength(2);
    expect(store.boardMovesOfRun("r1").map((r) => r.state)).toEqual(["done", "failed"]);
  });

  it("records a failed row when the lookup itself fails", async () => {
    const gql: Gql = async () => {
      throw new Error("github: HTTP 502");
    };
    expect(await move(gql)).toEqual({ ok: false, reason: "github: HTTP 502" });
    expect(store.boardMovesOfRun("r1")).toMatchObject([
      { state: "failed", detail: "github: HTTP 502" },
    ]);
  });

  it("fails, writing nothing, when the repo has no option for the column", async () => {
    const b = fakeBoard({ options: STATUS_OPTIONS.filter((o) => o.name !== "Blocked") });
    const res = await move(b.gql, { column: "Blocked" });
    expect(res).toEqual({ ok: false, reason: "no Status option for Blocked" });
    expect(b.mutations()).toHaveLength(0);
    // ids just read are not read again for the same miss
    expect(b.of("projectV2(number")).toHaveLength(1);
    expect(store.boardMovesOfRun("r1")).toMatchObject([
      { state: "failed", detail: "no Status option for Blocked", column: "Blocked" },
    ]);
  });

  it("caches the ids for an hour and refreshes them on a miss", async () => {
    const b = fakeBoard({ options: STATUS_OPTIONS.filter((o) => o.name !== "Blocked") });
    await move(b.gql, { column: "In progress" });
    await move(b.gql, { column: "In review" });
    expect(b.of("projectV2(number")).toHaveLength(1);
    b.state.options = STATUS_OPTIONS;
    await move(b.gql, { column: "Blocked" });
    expect(b.of("projectV2(number")).toHaveLength(2);
    expect(sentOption(b.mutations().at(-1))).toBe("O_blocked");
    now += BOARD_IDS_TTL_MS + 1;
    await move(b.gql, { column: "In progress" });
    expect(b.of("projectV2(number")).toHaveLength(3);
  });
});

describe("followPrs", () => {
  const card = (status: string): BoardItem => ({
    repoId: "mc",
    issueNumber: 7,
    title: "t",
    status,
    state: (STATUS_MAP as Record<string, BoardItem["state"]>)[status] ?? "planned",
    labels: [],
    assignees: [],
    priority: null,
    updatedAt: NOW,
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
  });
  const pr = (over: Partial<PullRequestView> = {}): PullRequestView => ({
    repoId: "mc",
    number: 91,
    title: "t",
    url: "u",
    branch: "work/7-x",
    ticket: "mc#7",
    closingIssues: [7],
    state: "open",
    isDraft: false,
    review: null,
    ci: null,
    createdAt: 1,
    updatedAt: 1,
    mergedAt: null,
    headSha: null,
    mergeable: null,
    ...over,
  });
  const run = (over: Partial<Run> = {}): Run => ({
    id: "r1",
    agentId: "a1",
    repoId: "mc",
    seq: 1,
    startedAt: 1000,
    endedAt: null,
    status: "running",
    sessionId: null,
    model: null,
    branch: null,
    ticket: "mc#7",
    costUsd: null,
    tokens: null,
    transcriptPath: "/x/y.log",
    prs: [],
    summary: null,
    reviewId: null,
    ...over,
  });
  /** A board with one card in `status` and the fake GitHub to match, then one follow. */
  async function follow(
    status: string,
    optionId: string,
    prs: PullRequestView[],
    cfg = config,
    closed = false,
  ) {
    const b = fakeBoard({ itemStatus: optionId });
    store.replaceBoard("mc", [{ ...card(status), closed }]);
    store.upsertPullRequests("mc", prs, NOW);
    await followPrs({ gql: b.gql, store, config: cfg, now: () => now }, "mc");
    return b;
  }

  it("moves a Backlog card to In review for an open PR no run owns", async () => {
    const b = await follow("", "O_todo", [pr()]);
    expect(b.state.card).toBe("O_review");
    expect(store.boardMoves(0)).toMatchObject([
      { runId: "pr:mc#91", issue: 7, column: "In review", state: "done" },
    ]);
  });

  it("leaves a card that is already later alone", async () => {
    const b = await follow("Ready for QA", "O_qa", [pr()]);
    expect(b.mutations()).toHaveLength(0);
    const done = await follow("Done", "O_done", [pr()]);
    expect(done.mutations()).toHaveLength(0);
  });

  it("moves the card to Done when the PR merged", async () => {
    const b = await follow("In Review", "O_review", [pr({ state: "merged", mergedAt: 5 })]);
    expect(b.state.card).toBe("O_done");
  });

  it("leaves an open parent unfinished when a branch-only contribution merges", async () => {
    const b = await follow("In Review", "O_review", [
      pr({ state: "merged", closingIssues: [], mergedAt: 5 }),
    ]);
    expect(b.mutations()).toHaveLength(0);
    expect(b.state.card).toBe("O_review");
    expect(store.boardMoves(0)).toEqual([]);
  });

  it("finishes a closed parent even when old PRs have no closing-issue metadata", async () => {
    const b = await follow(
      "In Review",
      "O_review",
      [pr({ state: "merged", closingIssues: [], mergedAt: 5 })],
      config,
      true,
    );
    expect(b.state.card).toBe("O_done");
  });

  it("keeps a closed issue Done when a follow-up PR is open", async () => {
    const b = await follow("Todo", "O_todo", [pr()], config, true);
    expect(b.state.card).toBe("O_done");
  });

  it("records completion against the closing PR rather than an earlier partial contribution", async () => {
    const b = await follow("In Review", "O_review", [
      pr({ number: 90, state: "merged", closingIssues: [] }),
      pr({ number: 91, state: "merged" }),
    ]);
    expect(b.state.card).toBe("O_done");
    expect(store.boardMoves(0)[0]?.runId).toBe("pr:mc#91");
  });

  it("moves a card to a column once per PR; a later move by hand is left alone", async () => {
    await follow("In Review", "O_review", [pr({ state: "merged", mergedAt: 5 })]);
    const again = await follow("Todo", "O_todo", [pr({ state: "merged", mergedAt: 5 })]);
    expect(again.mutations()).toHaveLength(0);
  });

  it("moves an In review card back to Ready when the PR closed unmerged", async () => {
    const b = await follow("In Review", "O_review", [pr({ state: "closed" })]);
    expect(b.state.card).toBe("O_todo");
    const other = await follow("Blocked", "O_blocked", [pr({ state: "closed" })]);
    expect(other.mutations()).toHaveLength(0);
  });

  it("does not send a closed PR's card back while another PR on the ticket is open", async () => {
    const b = await follow("In Review", "O_review", [
      pr({ number: 90, state: "closed" }),
      pr({ number: 91 }),
    ]);
    expect(b.mutations()).toHaveLength(0);
  });

  it("leaves a card whose run is live to the engine", async () => {
    store.upsertRun(run());
    const b = await follow("", "O_todo", [pr()]);
    expect(b.mutations()).toHaveLength(0);
  });

  it.each([
    ["open", "", "O_todo", "O_review"],
    ["merged", "In Review", "O_review", "O_done"],
    ["closed", "In Review", "O_review", "O_todo"],
  ] as const)(
    "follows closing references for a %s PR, independent of its branch",
    async (state, status, from, to) => {
      const b = await follow(status, from, [pr({ state, ticket: "mc#99", closingIssues: [6, 7] })]);
      expect(b.state.card).toBe(to);
      expect(store.boardMoves(0)).toMatchObject([{ issue: 7, state: "done" }]);
    },
  );

  it.each(["open", "merged", "closed"] as const)(
    "follows a branch-named ticket without closing references for a %s PR",
    async (state) => {
      const b = await follow(
        state === "open" ? "" : "In Review",
        state === "open" ? "O_todo" : "O_review",
        [pr({ state, closingIssues: [] })],
        config,
        state === "merged",
      );
      expect(b.state.card).toBe(
        state === "open" ? "O_review" : state === "merged" ? "O_done" : "O_todo",
      );
      expect(b.mutations()).toHaveLength(1);
    },
  );

  it("moves a migrated merged PR's ticket to Done with closing_issues defaulted to []", async () => {
    store.close();
    const old = join(dir, "old-prs.sqlite");
    const db = new DatabaseSync(old);
    db.exec(`CREATE TABLE pull_requests (
      repo_id TEXT NOT NULL, number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
      branch TEXT NOT NULL, ticket TEXT, state TEXT NOT NULL, is_draft INTEGER NOT NULL,
      review TEXT, ci TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      merged_at INTEGER, PRIMARY KEY (repo_id, number))`);
    db.exec(
      "INSERT INTO pull_requests VALUES ('mc', 91, 't', 'u', 'loop/7-fix', 'mc#7', 'merged', 0, NULL, NULL, 1, 2, 3)",
    );
    db.close();
    store = new Store(old);
    expect(store.pullRequests("mc")[0]).toMatchObject({ closingIssues: [], ticket: "mc#7" });
    const b = fakeBoard({ itemStatus: "O_review" });
    store.replaceBoard("mc", [{ ...card("In Review"), closed: true }]);
    expect(await followPrs({ gql: b.gql, store, config, now: () => now }, "mc")).toBe(true);
    expect(b.state.card).toBe("O_done");
  });

  it.each(["open", "merged", "closed"] as const)(
    "leaves a planner's card alone for a %s PR, even after its run ended",
    async (state) => {
      const seats: CrewSeatConfig[] = [
        { id: "fao", role: "FAO", accountId: "a", model: "m", area: [] },
        {
          id: "custom",
          role: "planner",
          accountId: "a",
          model: "m",
          area: [],
          def: { mode: "read-only", loop: "plan", prompt: "p", mcTools: [], here: "" },
        },
        {
          id: "no-build",
          role: "research",
          accountId: "a",
          model: "m",
          area: [],
          def: { mode: "read-only", loop: "none", prompt: "p", mcTools: [], here: "" },
        },
      ];
      const cfg = {
        ...config,
        crew: {
          worktrees: dir,
          maxSeats: 3,
          sessions: [{ id: "s", repoId: "mc", checkout: dir, seats }],
        },
      } as CcConfig;
      for (const seat of seats) {
        store.upsertRun(run({ agentId: seat.id, status: "ok", endedAt: NOW }));
        const b = await follow(
          state === "open" ? "Todo" : "In Review",
          state === "open" ? "O_todo" : "O_review",
          [pr({ state })],
          cfg,
        );
        expect(b.calls).toEqual([]);
      }
    },
  );

  it("retries a failed move after five minutes, but not before", async () => {
    const b = fakeBoard();
    b.state.mutationFailures = [new GqlTransportError("github: HTTP 403", 403)];
    store.replaceBoard("mc", [card("Todo")]);
    store.upsertPullRequests("mc", [pr()], NOW);
    const deps = { gql: b.gql, store, config, now: () => now };
    expect(await followPrs(deps, "mc")).toBe(false);
    expect(store.boardMovesOfRun("pr:mc#91")).toMatchObject([{ state: "failed", at: NOW }]);
    const calls = b.calls.length;
    now += 5 * 60_000 - 1;
    expect(await followPrs(deps, "mc")).toBe(false);
    expect(b.calls).toHaveLength(calls);
    now += 1;
    expect(await followPrs(deps, "mc")).toBe(true);
    expect(b.state.card).toBe("O_review");
    expect(store.boardMovesOfRun("pr:mc#91").map((m) => m.state)).toEqual(["failed", "done"]);
    b.state.card = "O_todo";
    now += 5 * 60_000;
    expect(await followPrs(deps, "mc")).toBe(false);
    expect(b.mutations()).toHaveLength(2);
  });

  it("leaves a pending move alone even after five minutes", async () => {
    store.addBoardMove({
      runId: "pr:mc#91",
      repoId: "mc",
      issue: 7,
      column: "In review",
      state: "pending",
      detail: null,
      at: NOW,
    });
    now += 5 * 60_000;
    const b = await follow("Todo", "O_todo", [pr()]);
    expect(b.calls).toEqual([]);
  });

  it("leaves a draft PR's card out of In review until it is ready", async () => {
    const b = await follow("Todo", "O_todo", [pr({ isDraft: true })]);
    expect(b.calls).toEqual([]);
    store.upsertPullRequests("mc", [pr()], NOW);
    expect(await followPrs({ gql: b.gql, store, config, now: () => now }, "mc")).toBe(true);
    expect(b.state.card).toBe("O_review");
  });

  it("follows a ready PR when another PR on the ticket is a draft", async () => {
    const b = await follow("Todo", "O_todo", [pr({ number: 92, isDraft: true }), pr()]);
    expect(b.state.card).toBe("O_review");
    expect(store.boardMoves(0)[0]?.runId).toBe("pr:mc#91");
  });

  it("does not treat an open draft as a closed PR", async () => {
    const b = await follow("In Review", "O_review", [pr({ isDraft: true })]);
    expect(b.calls).toEqual([]);
  });

  it("moves a Blocked card after its run was parked", async () => {
    store.upsertRun(run({ status: "blocked", endedAt: NOW }));
    const b = await follow("Blocked", "O_blocked", [pr()]);
    expect(b.state.card).toBe("O_review");
  });

  it("moves nothing in a draft repo", async () => {
    const b = fakeBoard();
    store.replaceBoard("dr", [{ ...card(""), repoId: "dr" }]);
    store.upsertPullRequests("dr", [pr({ repoId: "dr", ticket: "dr#7" })], NOW);
    await followPrs({ gql: b.gql, store, config, now: () => now }, "dr");
    expect(b.mutations()).toHaveLength(0);
  });
});

it("edits Size and Priority through the existing project field mutation", async () => {
  const c = {
    ...config,
    repos: config.repos.map((r) => ({ ...r, flightPowers: "superuser" as const })),
  };
  const writes: unknown[] = [];
  const gql: Gql = async (query, vars) => {
    if (query.includes("updateProjectV2ItemFieldValue")) {
      writes.push(vars.input);
      return {};
    }
    if (query.includes("projectItems"))
      return {
        repository: {
          issue: { projectItems: { nodes: [{ id: "item", project: { id: "project" } }] } },
        },
      };
    return {
      repositoryOwner: {
        __typename: "User",
        projectV2: {
          id: "project",
          fields: {
            pageInfo: { hasNextPage: false },
            nodes: [
              { id: "size", name: "Size", options: [{ id: "small", name: "S" }] },
              { id: "priority", name: "Priority", options: [{ id: "high", name: "P0" }] },
            ],
          },
        },
      },
    };
  };
  expect(
    await editCardFields({ config: c, store, gql }, "mc", 7, { size: "S", priority: "P0" }),
  ).toEqual({ ok: true, changed: true });
  expect(writes).toEqual([
    {
      projectId: "project",
      itemId: "item",
      fieldId: "size",
      value: { singleSelectOptionId: "small" },
    },
    {
      projectId: "project",
      itemId: "item",
      fieldId: "priority",
      value: { singleSelectOptionId: "high" },
    },
  ]);
});

describe("checkCardFieldOptions", () => {
  const c = {
    ...config,
    repos: config.repos.map((r) => ({ ...r, flightPowers: "superuser" as const })),
  } as unknown as CcConfig;
  const project = (
    fields: { id: string; name: string; options: { id: string; name: string }[] }[],
  ) => {
    const calls: string[] = [];
    const gql: Gql = async (query) => {
      calls.push(query);
      return {
        repositoryOwner: {
          __typename: "User",
          projectV2: { id: "project", fields: { pageInfo: { hasNextPage: false }, nodes: fields } },
        },
      };
    };
    return { gql, calls };
  };
  const SIZE = { id: "size", name: "Size", options: [{ id: "small", name: "S" }] };
  const PRIORITY = { id: "priority", name: "Priority", options: [{ id: "high", name: "P0" }] };

  it("is ok for options the project has, and mutates nothing", async () => {
    const { gql, calls } = project([SIZE, PRIORITY]);
    expect(
      await checkCardFieldOptions({ config: c, gql }, "mc", { size: "S", priority: "P0" }),
    ).toEqual({ ok: true, changed: false });
    expect(calls.some((q) => q.includes("updateProjectV2ItemFieldValue"))).toBe(false);
  });
  it("refuses a Size or Priority option the project lacks", async () => {
    const { gql } = project([SIZE, PRIORITY]);
    expect(await checkCardFieldOptions({ config: c, gql }, "mc", { size: "XL" })).toEqual({
      ok: false,
      reason: "No Size option XL.",
    });
    expect(await checkCardFieldOptions({ config: c, gql }, "mc", { priority: "P2" })).toEqual({
      ok: false,
      reason: "No Priority option P2.",
    });
  });
  it("refuses when the project has no such field", async () => {
    const { gql } = project([PRIORITY]);
    const r = await checkCardFieldOptions({ config: c, gql }, "mc", { size: "S" });
    expect(r.ok).toBe(false);
  });
  it("refuses a repo that is not superuser", async () => {
    const { gql, calls } = project([SIZE]);
    expect(await checkCardFieldOptions({ config, gql }, "mc", { size: "S" })).toEqual({
      ok: false,
      reason: "Superuser required.",
    });
    expect(calls).toEqual([]);
  });
});
