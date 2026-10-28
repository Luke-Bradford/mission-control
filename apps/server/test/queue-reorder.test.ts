import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoardItem,
  DEFAULT_PROFILES,
  freezeRules,
  OPERATOR_HEADER,
  type TicketView,
} from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { refillQueues } from "../src/engine/queue.ts";
import {
  proposeQueueReorder,
  type QueueReorderDeps,
  reorderQueue,
  resolveQueueReorder,
} from "../src/queue-reorder.ts";
import { Store } from "../src/store.ts";

let dir: string;
let store: Store;
let config: CcConfig;
let board: BoardItem[];
let deps: QueueReorderDeps;
const required = <T>(value: T | undefined | null): T => {
  if (value == null) throw new Error("Missing fixture value");
  return value;
};
const configuredSeat = () => required(config.crew?.sessions[0]?.seats[0]);
const rules = freezeRules({
  pickFrom: ["Ready"],
  promoteBacklog: false,
  needs: ["done_when", "size"],
  areas: { "area:server": ["apps/server/**"], "area:web": ["apps/web/**"] },
  hardRules: [],
  hardRulesSet: true,
  hardRulesBy: "operator",
  alwaysAsk: [],
});
const card = (issue: number, priority: string): BoardItem => ({
  repoId: "demo",
  issueNumber: issue,
  title: `Ticket ${issue}`,
  status: "Ready",
  state: "planned",
  labels: ["area:server", "lane:work"],
  assignees: [],
  priority,
  prioritySource: "field",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: "S",
  url: "https://example.test/ticket",
  closed: false,
  createdAt: issue,
  updatedAt: 10,
  itemId: `I${issue}`,
  projectId: "P1",
});
const ticket = async (_repo: unknown, n: number) =>
  ({
    number: n,
    title: "Ticket",
    body: "## Done when\n- Verified",
    bodyTruncated: false,
    url: "https://example.test/ticket",
    state: "open",
    labels: [],
    milestone: null,
    subIssues: [],
    pullRequests: [],
  }) as TicketView;
const refill = () =>
  refillQueues({
    config,
    store,
    rules: deps.rules,
    fetchTicket: ticket,
    login: "hub",
    now: () => 100,
    profiles: () => DEFAULT_PROFILES,
  });
const propose = () => proposeQueueReorder(deps, "guido-1", "demo#2", "demo#1");
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-reorder-"));
  store = new Store(join(dir, "test.sqlite"));
  config = {
    operator: { id: "operator", timezone: "UTC" },
    accounts: [],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    repos: [
      {
        id: "demo",
        github: "example/demo",
        project: 1,
        statusMap: {},
        autonomy: "merge",
        flightPowers: "superuser",
      },
    ],
    crew: {
      worktrees: dir,
      maxSeats: 4,
      lane: "work",
      sessions: [
        {
          id: "demo",
          repoId: "demo",
          checkout: dir,
          seats: [
            {
              id: "guido-1",
              role: "GUIDO",
              accountId: "account",
              model: "sonnet",
              area: ["apps/server/**"],
            },
          ],
        },
      ],
    },
  } as CcConfig;
  board = [card(1, "P1"), card(2, "P2")];
  store.replaceBoard("demo", board);
  deps = {
    config,
    store,
    rules: async () => rules,
    fetchTicket: ticket,
    login: "hub",
    now: () => 100,
    enabled: () => true,
    readCard: async (_repo, issue) => board.find((c) => c.issueNumber === issue) ?? null,
    readBoard: async () => board.map((c) => ({ ...c })),
    edit: vi.fn(async (_repo, issue, fields) => {
      board = board.map((c) => (c.issueNumber === issue ? { ...c, priority: fields.priority } : c));
      return { ok: true as const, changed: true };
    }),
  };
  await refill();
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it("proposes an approval with stable refs and catalogue options, with no board write", async () => {
  const result = await propose();
  expect(result.item.kind).toBe("approval");
  expect(result.item.text).toBe(
    "Move demo#2 above demo#1 in GUIDO-1's queue? That swaps their Priority on the delivery board (P2 ↔ P1).",
  );
  expect(result.item.brief?.options.map((o) => o.label)).toEqual(["Approve", "Deny"]);
  expect(deps.edit).not.toHaveBeenCalled();
});

it("applies FLIGHT's reorder directly without leaving an approval item", async () => {
  const result = await reorderQueue(deps, "guido-1", "demo#2", "demo#1");
  expect(result).toMatchObject({ ok: true });
  expect(deps.edit).toHaveBeenCalledTimes(2);
  expect(store.notes().filter((item) => item.key.startsWith("queue-reorder:"))).toEqual([]);
});

it("leaves no approval note or pending record when the direct reorder is refused after saving", async () => {
  let fetches = 0;
  deps.fetchTicket = async (repo, n) => {
    if (++fetches > 2) throw new Error("GitHub down");
    return ticket(repo, n);
  };
  await expect(reorderQueue(deps, "guido-1", "demo#2", "demo#1")).rejects.toThrow("GitHub down");
  expect(deps.edit).not.toHaveBeenCalled();
  expect(store.notes().filter((item) => item.key.includes("queue-reorder:"))).toEqual([]);
  const rows = (store as unknown as { db: { prepare: (q: string) => { all: () => unknown[] } } }).db
    .prepare("SELECT key FROM settings WHERE key LIKE 'queue-reorder:%'")
    .all();
  expect(rows).toEqual([]);
});

it.each(["reorder", "propose"] as const)("refuses an always_ask card (%s)", async (how) => {
  deps.rules = async () => ({ ...rules, alwaysAsk: ["approval:*"] });
  board = [card(1, "P1"), { ...card(2, "P2"), labels: ["area:server", "lane:work", "approval:x"] }];
  store.replaceBoard("demo", board);
  const act = how === "reorder" ? reorderQueue : proposeQueueReorder;
  await expect(act(deps, "guido-1", "demo#2", "demo#1")).rejects.toThrow(/always_ask/);
  expect(deps.edit).not.toHaveBeenCalled();
});

it("never exposes an operator approval while a direct reorder waits for the writer", async () => {
  const { item } = await propose();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(deps.edit).mockImplementationOnce(async (_repo, issue, fields) => {
    entered();
    await blocked;
    board = board.map((c) => (c.issueNumber === issue ? { ...c, priority: fields.priority } : c));
    return { ok: true, changed: true };
  });
  const first = resolveQueueReorder(deps, item.key, "approve");
  await writing;
  const direct = reorderQueue(deps, "guido-1", "demo#2", "demo#1");
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(store.notes().filter((note) => note.key.startsWith("queue-reorder:"))).toHaveLength(1);
  release();
  await first;
  await expect(direct).rejects.toThrow(/stale|changed/i);
});
it("deny and replay never write, including after reopening the store", async () => {
  const { item } = await propose();
  expect((await resolveQueueReorder(deps, item.key, "deny")).text).toBe("Left the order as it is.");
  store.close();
  store = new Store(join(dir, "test.sqlite"));
  deps.store = store;
  await expect(resolveQueueReorder(deps, item.key, "approve")).rejects.toThrow(/already/);
  expect(deps.edit).not.toHaveBeenCalled();
});
it("approved swaps change the actual board-driven queue and cannot be replayed", async () => {
  const { item } = await propose();
  const result = await resolveQueueReorder(deps, item.key, "approve");
  expect(result.text).toBe("Changed Priority on the board. GUIDO-1 takes demo#2 first now.");
  expect(deps.edit).toHaveBeenNthCalledWith(1, "demo", 2, { priority: "P1" });
  expect(deps.edit).toHaveBeenNthCalledWith(2, "demo", 1, { priority: "P2" });
  expect(store.queue("guido-1").map((q) => q.issue)).toEqual([2, 1]);
  await refill();
  expect(store.queue("guido-1").map((q) => q.issue)).toEqual([2, 1]);
  await expect(resolveQueueReorder(deps, item.key, "approve")).rejects.toThrow(/already/);
  expect(deps.edit).toHaveBeenCalledTimes(2);
});
it.each([
  "priority",
  "area",
  "lane",
  "status",
  "identity",
  "focus",
  "retiring",
  "active",
  "disabled",
])("rejects a stale %s proposal without writing", async (change) => {
  const { item } = await propose();
  const c = required(board[1]);
  if (change === "priority") c.priority = "P3";
  if (change === "area") c.labels = ["area:web", "lane:work"];
  if (change === "lane") c.labels = ["area:server", "lane:home"];
  if (change === "status") c.status = "Backlog";
  if (change === "identity") c.itemId = "replacement";
  if (change === "focus") configuredSeat().focus = "demo#1";
  if (change === "retiring") configuredSeat().retiring = true;
  if (change === "active") store.takeQueued("guido-1", 100);
  if (change === "disabled") deps.enabled = () => false;
  await expect(resolveQueueReorder(deps, item.key, "approve")).rejects.toThrow();
  expect(deps.edit).not.toHaveBeenCalled();
});
it("equal priorities cannot promise an order the queue ignores", async () => {
  required(board[1]).priority = "P1";
  await expect(propose()).rejects.toThrow(/equal|distinct/i);
  expect(deps.edit).not.toHaveBeenCalled();
});
it("a second write failure is visible and recoverable, with no success or replay", async () => {
  const { item } = await propose();
  vi.mocked(deps.edit)
    .mockImplementationOnce(async (_r, issue, fields) => {
      board = board.map((c) => (c.issueNumber === issue ? { ...c, priority: fields.priority } : c));
      return { ok: true as const, changed: true };
    })
    .mockResolvedValueOnce({ ok: false, reason: "Unavailable" });
  const result = await resolveQueueReorder(deps, item.key, "approve");
  expect(result.ok).toBe(false);
  expect(store.notes().find((n) => n.key.endsWith(":recovery"))?.seatId).toBeNull();
  expect(result.text).toMatch(/partial|incomplete/i);
  expect(store.notes().some((n) => /Refresh.*Priority/.test(n.text))).toBe(true);
  await expect(resolveQueueReorder(deps, item.key, "approve")).rejects.toThrow(/already/);
  expect(deps.edit).toHaveBeenCalledTimes(2);
});
it("concurrent approval calls write once", async () => {
  const { item } = await propose();
  const results = await Promise.allSettled([
    resolveQueueReorder(deps, item.key, "approve"),
    resolveQueueReorder(deps, item.key, "approve"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(deps.edit).toHaveBeenCalledTimes(2);
});

it("API returns the approval item, enforces JSON/origin guards and keeps approval operator-only", async () => {
  const app = buildApp({ config, store, bus: new ChangeBus(), queueReorder: deps });
  const url = "/api/seats/guido-1/queue/reorder";
  const post = (path: string, payload: object) =>
    app.inject({ method: "POST", url: path, payload });
  try {
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { "content-type": "text/plain" },
          payload: "{}",
        })
      ).statusCode,
    ).toBe(415);
    expect(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { origin: "https://example.test" },
          payload: { move: "demo#2", above: "demo#1" },
        })
      ).statusCode,
    ).toBe(403);
    const response = await post(url, { move: "demo#2", above: "demo#1" });
    expect(response.statusCode).toBe(200);
    const item = response.json().item;
    expect(item.kind).toBe("approval");
    const attention = await app.inject({ method: "GET", url: "/api/attention" });
    expect(attention.json().find((i: { key: string }) => i.key === item.key)?.kind).toBe(
      "approval",
    );
    const resolveUrl = `/api/queue/reorder/${encodeURIComponent(item.key)}`;
    expect((await post(resolveUrl, { action: "deny" })).json().text).toBe(
      "Left the order as it is.",
    );
    expect((await post(resolveUrl, { action: "approve" })).statusCode).toBe(409);
    expect(deps.edit).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});

it("an approval survives restart and still revalidates before writing", async () => {
  const { item } = await propose();
  store.close();
  store = new Store(join(dir, "test.sqlite"));
  deps.store = store;
  expect((await resolveQueueReorder(deps, item.key, "approve")).ok).toBe(true);
  expect(store.queue("guido-1").map((q) => q.issue)).toEqual([2, 1]);
});

it("operator token guards approval before any board write", async () => {
  const { item } = await propose();
  const app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    queueReorder: deps,
    operatorToken: "fictional-operator-token",
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: `/api/queue/reorder/${encodeURIComponent(item.key)}`,
      payload: { action: "approve" },
    });
    expect(response.statusCode).toBe(401);
    expect(deps.edit).not.toHaveBeenCalled();
    const approved = await app.inject({
      method: "POST",
      url: `/api/queue/reorder/${encodeURIComponent(item.key)}`,
      headers: { [OPERATOR_HEADER]: "fictional-operator-token" },
      payload: { action: "approve" },
    });
    expect(approved.statusCode).toBe(200);
    expect(deps.edit).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
  }
});

it("unconfirmed writes leave a recovery item across reload and never report success", async () => {
  const { item } = await propose();
  vi.mocked(deps.edit).mockResolvedValue({ ok: true, changed: true });
  const result = await resolveQueueReorder(deps, item.key, "approve");
  expect(result.ok).toBe(false);
  expect(result.text).toContain("unconfirmed");
  store.close();
  store = new Store(join(dir, "test.sqlite"));
  deps.store = store;
  expect(store.notes().some((n) => n.key.endsWith(":recovery"))).toBe(true);
  await expect(resolveQueueReorder(deps, item.key, "approve")).rejects.toThrow(/already/);
  expect(deps.edit).toHaveBeenCalledTimes(2);
});

it("first write failure stops the second write", async () => {
  const { item } = await propose();
  vi.mocked(deps.edit).mockRejectedValueOnce(new Error("Unavailable"));
  expect((await resolveQueueReorder(deps, item.key, "approve")).ok).toBe(false);
  expect(deps.edit).toHaveBeenCalledTimes(1);
});

it.each(["priority", "area", "lane", "status"])(
  "also revalidates the card being overtaken: %s",
  async (change) => {
    const { item } = await propose();
    const c = required(board[0]);
    if (change === "priority") c.priority = "P0";
    if (change === "area") c.labels = ["area:web", "lane:work"];
    if (change === "lane") c.labels = ["area:server", "lane:home"];
    if (change === "status") c.status = "Backlog";
    await expect(resolveQueueReorder(deps, item.key, "approve")).rejects.toThrow();
    expect(deps.edit).not.toHaveBeenCalled();
  },
);

it("rejects swaps that allocate the promoted card to another seat before writing", async () => {
  config.crew?.sessions[0]?.seats.push({ ...configuredSeat(), id: "guido-2" });
  board = [card(1, "P1"), card(2, "P1"), card(3, "P2")];
  store.replaceBoard("demo", board);
  await refill();
  expect(store.queue("guido-1").map((q) => q.issue)).toEqual([1, 3]);
  await expect(proposeQueueReorder(deps, "guido-1", "demo#3", "demo#1")).rejects.toThrow(
    /allocation/i,
  );
  expect(deps.edit).not.toHaveBeenCalled();
});

it("uses direct issue snapshots despite a stale project list throughout approval", async () => {
  const stale = board.map((c) => ({ ...c, priority: "P4" }));
  deps.readBoard = async () => stale;
  const { item } = await propose();
  expect(item.text).toContain("P2 ↔ P1");
  expect((await resolveQueueReorder(deps, item.key, "approve")).ok).toBe(true);
  expect(store.queue("guido-1").map((q) => q.issue)).toEqual([2, 1]);
});
it("rejects changed direct issue priorities even when the project list still matches", async () => {
  const stale = board.map((c) => ({ ...c }));
  deps.readBoard = async () => stale;
  const { item } = await propose();
  required(board[1]).priority = "P3";
  await expect(resolveQueueReorder(deps, item.key, "approve")).rejects.toThrow(/stale/i);
  expect(deps.edit).not.toHaveBeenCalled();
});

it("rechecks allocation at approval if another seat joins after the proposal", async () => {
  const { item } = await propose();
  config.crew?.sessions[0]?.seats.push({ ...configuredSeat(), id: "guido-2" });
  await expect(resolveQueueReorder(deps, item.key, "approve")).rejects.toThrow(/allocation/i);
  expect(deps.edit).not.toHaveBeenCalled();
  expect(store.notes().some((n) => n.key.endsWith(":recovery"))).toBe(false);
});
