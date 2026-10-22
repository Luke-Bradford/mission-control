import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Gql, GqlError, GqlTransportError } from "../src/collectors/github.ts";
import type { CcConfig } from "../src/config.ts";
import { addCard, BOARD_IDS_TTL_MS, clearBoardIds, moveCard } from "../src/github-board.ts";
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
function fakeBoard(opts: { options?: typeof STATUS_OPTIONS; itemStatus?: string | null } = {}) {
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
      user: {
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

describe("addCard", () => {
  /** The fake board, plus the answers for an issue's node id and the add-to-project mutation. */
  function withAdd(b: ReturnType<typeof fakeBoard>, issueId: string | null = "I_31") {
    const added: unknown[] = [];
    const gql: Gql = async (query, vars) => {
      if (query.includes("issue(number: $number) { id }")) {
        return { repository: { issue: issueId === null ? null : { id: issueId } } };
      }
      if (query.includes("addProjectV2ItemById")) {
        added.push(vars.input);
        return { addProjectV2ItemById: { item: { id: "PVTI_1" } } };
      }
      return b.gql(query, vars);
    };
    return { gql, added };
  }
  const add = (gql: Gql, over: Partial<Parameters<typeof addCard>[1]> = {}) =>
    addCard(
      { gql, store, config, now: () => now },
      { runId: "r1", repoId: "mc", issue: 31, column: "Backlog", ...over },
    );

  it("puts the issue on the project, then moves its card to the column", async () => {
    const b = fakeBoard({ itemStatus: "O_prog" });
    const w = withAdd(b);
    expect(await add(w.gql)).toEqual({ ok: true, changed: true });
    expect(w.added).toEqual([{ projectId: "PVT_5", contentId: "I_31" }]);
    expect(b.mutations()).toHaveLength(1);
    expect(sentOption(b.mutations()[0])).toBe("O_todo");
  });

  it("leaves a draft repo alone and fails for an issue it cannot find", async () => {
    const b = fakeBoard();
    const w = withAdd(b);
    expect(await add(w.gql, { repoId: "dr" })).toEqual({ ok: true, changed: false });
    expect(w.added).toEqual([]);
    expect(await add(withAdd(b, null).gql)).toEqual({ ok: false, reason: "issue not found" });
  });
});

describe("moveCard", () => {
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
