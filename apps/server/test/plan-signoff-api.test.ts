import "./temp-home.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type BoardItem, DEFAULT_REPO_RULES, type PlanSignoff } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { RepoRulesError } from "../src/engine/rules.ts";
import type { Move, MoveResult } from "../src/github/board.ts";
import { keepMockups, stageReviewMockups } from "../src/plans/assets.ts";
import { Store } from "../src/store.ts";

const EXAMPLE = resolve(import.meta.dirname, "../../../config.example.yaml");
const NOW = Date.parse("2026-11-17T12:00:00Z");
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16, 2)]);

let dir: string;
let store: Store;
let setting: PlanSignoff;
let rulesFail = false;
let moves: Move[];
let moveResult: MoveResult;
let emitted: string[];

const card = (n: number, status = "Backlog"): BoardItem => ({
  repoId: "shop-app",
  issueNumber: n,
  title: `Ticket ${n}`,
  status,
  state: "planned",
  labels: [],
  priority: null,
  updatedAt: NOW,
  url: "u",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: "M",
  closed: false,
  prioritySource: null,
  createdAt: NOW,
  itemId: `I${n}`,
  projectId: "P1",
});

const parts = (over: Record<string, unknown> = {}) => ({
  asks: "Show plans.",
  proposal: "Add a tab.",
  sizeEstimate: "M",
  risks: "Big page.",
  mockups: [],
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-plan-api-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(
    configPath,
    readFileSync(EXAMPLE, "utf8").replace("\ncrew:\n", `\ncrew:\n  node: ${process.execPath}\n`),
  );
  store = new Store(join(dir, "mc.sqlite"));
  setting = "every";
  rulesFail = false;
  moves = [];
  moveResult = { ok: true, changed: true };
  emitted = [];
  store.replaceBoard("shop-app", [card(7), card(8, "Ready")]);
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const app = () => {
  const bus = new ChangeBus();
  bus.subscribe((t) => emitted.push(t));
  return buildApp({
    config: loadConfig(join(dir, "config.yaml")),
    store,
    bus,
    now: () => NOW,
    githubGql: async () => {
      throw new Error("no gh in tests");
    },
    repoRules: async () =>
      rulesFail ? new RepoRulesError("no rules") : { ...DEFAULT_REPO_RULES, planSignoff: setting },
    ticketMove: async (m) => {
      moves.push(m);
      return moveResult;
    },
  });
};

describe("the Planner tab's data", () => {
  it("GET /api/plans splits waiting from signed-off history", async () => {
    store.plans.request("shop-app", 7, NOW - 3000);
    store.plans.file("shop-app", 8, parts(), true, NOW - 2000);
    store.plans.file("shop-app", 9, parts(), true, NOW - 4000);
    store.plans.approve("shop-app", 9, NOW - 1000);
    const a = app();
    const view = (await a.inject("/api/plans")).json();
    expect(view.waiting.map((p: { ref: string; state: string }) => [p.ref, p.state])).toEqual([
      ["shop-app#7", "awaiting-plan"],
      ["shop-app#8", "awaiting-signoff"],
    ]);
    expect(view.waiting[0]).toMatchObject({ title: "Ticket 7", asks: null, mockups: [] });
    expect(view.history.map((p: { ref: string }) => p.ref)).toEqual(["shop-app#9"]);
    expect(view.history[0]).toMatchObject({ proposal: "Add a tab.", sizeEstimate: "M" });
    await a.close();
  });

  it("is empty with no plans, and shows a plan sent back with its note", async () => {
    const a = app();
    expect((await a.inject("/api/plans")).json()).toEqual({ waiting: [], history: [] });
    store.plans.file("shop-app", 7, parts(), true, NOW);
    store.plans.sendBack("shop-app", 7, "Too big.");
    const view = (await a.inject("/api/plans")).json();
    expect(view.waiting[0]).toMatchObject({ state: "sent-back", note: "Too big." });
    await a.close();
  });

  it("GET /api/plan-assets/:id returns the image bytes, and refuses anything else", async () => {
    const checkout = join(dir, "checkout");
    rmSync(checkout, { recursive: true, force: true });
    writeFileSync(join(dir, "pic.png"), PNG);
    const kept = await keepMockups({
      worktree: dir,
      dbPath: store.path,
      inputs: [{ path: "pic.png", caption: "Pic" }],
      known: [],
    });
    if (!kept.ok) throw new Error(kept.text);
    const a = app();
    const ok = await a.inject(kept.mockups[0]?.url ?? "");
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(ok.rawPayload).toEqual(PNG);
    expect((await a.inject("/api/plan-assets/nope")).statusCode).toBe(404);
    expect((await a.inject(`/api/plan-assets/${"0".repeat(64)}`)).statusCode).toBe(404);
    await a.close();
  });
});

describe("the reviewer's copy of the mockups", () => {
  it("stageReviewMockups refuses, and stages nothing, when a kept picture is missing", async () => {
    writeFileSync(join(dir, "pic.png"), PNG);
    const kept = await keepMockups({
      worktree: dir,
      dbPath: store.path,
      inputs: [{ path: "pic.png", caption: "The tab" }],
      known: [],
    });
    if (!kept.ok) throw new Error(kept.text);
    const gone = { id: "f".repeat(64), caption: "Gone", mediaType: "image/png" as const, url: "u" };
    const scratch = join(dir, "scratch-2");
    await expect(stageReviewMockups(store.path, scratch, [...kept.mockups, gone])).rejects.toThrow(
      /missing/,
    );
    expect(existsSync(join(scratch, ".mc-review/plan-mockups"))).toBe(false);
  });

  it("stageReviewMockups puts each signed-off picture in the scratch copy by path", async () => {
    writeFileSync(join(dir, "pic.png"), PNG);
    const kept = await keepMockups({
      worktree: dir,
      dbPath: store.path,
      inputs: [{ path: "pic.png", caption: "The tab" }],
      known: [],
    });
    if (!kept.ok) throw new Error(kept.text);
    const scratch = join(dir, "scratch");
    const staged = await stageReviewMockups(store.path, scratch, kept.mockups);
    expect(staged).toHaveLength(1);
    expect(staged[0]?.caption).toBe("The tab");
    expect(readFileSync(join(scratch, staged[0]?.path ?? ""))).toEqual(PNG);
  });
});

describe("sign-off", () => {
  it("approve moves the card to Ready and records the sign-off", async () => {
    store.plans.file("shop-app", 7, parts(), true, NOW - 5);
    const a = app();
    const res = await a.inject({
      method: "POST",
      url: "/api/plans/shop-app/7/approve",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      moved: true,
      moveError: null,
      plan: { state: "signed-off" },
    });
    expect(moves).toEqual([
      { runId: "plan:shop-app#7", repoId: "shop-app", issue: 7, column: "Ready" },
    ]);
    expect(store.plans.get("shop-app", 7)).toMatchObject({ state: "signed-off", decidedAt: NOW });
    expect(emitted).toEqual(expect.arrayContaining(["plans", "boards"]));
    // it is not signed twice
    expect(
      (await a.inject({ method: "POST", url: "/api/plans/shop-app/7/approve", payload: {} }))
        .statusCode,
    ).toBe(409);
    await a.close();
  });

  it("a card that cannot be moved leaves the plan waiting, with a retryable error", async () => {
    store.plans.file("shop-app", 7, parts(), true, NOW);
    moveResult = { ok: false, reason: "card not on the project" };
    const a = app();
    const res = await a.inject({
      method: "POST",
      url: "/api/plans/shop-app/7/approve",
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toContain("card not on the project");
    expect(store.plans.get("shop-app", 7)?.state).toBe("awaiting-signoff");
    moveResult = { ok: true, changed: true };
    expect(
      (await a.inject({ method: "POST", url: "/api/plans/shop-app/7/approve", payload: {} }))
        .statusCode,
    ).toBe(200);
    await a.close();
  });

  it("two approvals at once move the card once and sign off once", async () => {
    store.plans.file("shop-app", 7, parts(), true, NOW);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const config = loadConfig(join(dir, "config.yaml"));
    const a = buildApp({
      config,
      store,
      bus: new ChangeBus(),
      now: () => NOW,
      repoRules: async () => ({ ...DEFAULT_REPO_RULES, planSignoff: "every" }),
      ticketMove: async (m) => {
        moves.push(m);
        await gate;
        return { ok: true, changed: true };
      },
    });
    const post = () =>
      a.inject({ method: "POST", url: "/api/plans/shop-app/7/approve", payload: {} });
    const both = Promise.all([post(), post()]);
    await new Promise((r) => setTimeout(r, 50));
    release();
    const codes = (await both).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    expect(moves).toHaveLength(1);
    await a.close();
  });

  it("when the repo's rules cannot be read the plan stays waiting and FLIGHT is not told", async () => {
    store.plans.file("shop-app", 7, parts(), false, NOW);
    rulesFail = true;
    const a = app();
    const res = await a.inject({
      method: "POST",
      url: "/api/plans/shop-app/7/approve",
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(store.plans.get("shop-app", 7)?.state).toBe("awaiting-signoff");
    expect(moves).toEqual([]);
    expect(store.commsOnTicket("shop-app#7", "#7", [], 10)).toEqual([]);
    await a.close();
  });

  it("an approve racing a send back: one wins, the other is refused, one decision stands", async () => {
    store.plans.file("shop-app", 7, parts(), false, NOW);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const a = buildApp({
      config: loadConfig(join(dir, "config.yaml")),
      store,
      bus: new ChangeBus(),
      now: () => NOW,
      repoRules: async () => ({ ...DEFAULT_REPO_RULES, planSignoff: "every" }),
      ticketMove: async (m) => {
        moves.push(m);
        await gate;
        return { ok: true, changed: true };
      },
    });
    const approve = a.inject({ method: "POST", url: "/api/plans/shop-app/7/approve", payload: {} });
    await new Promise((r) => setTimeout(r, 50));
    const back = a.inject({
      method: "POST",
      url: "/api/plans/shop-app/7/send-back",
      payload: { note: "No." },
    });
    await new Promise((r) => setTimeout(r, 20));
    release();
    const codes = [(await approve).statusCode, (await back).statusCode];
    expect(codes).toEqual([200, 409]);
    expect(store.plans.get("shop-app", 7)).toMatchObject({ state: "signed-off", note: null });
    const told = store
      .comms(0)
      .filter((c) => c.ticket === "shop-app#7")
      .map((c) => c.text);
    expect(told.some((t) => t.includes("sent the plan"))).toBe(false);
    await a.close();
  });

  it("a plan that holds nothing is recorded and the card stays", async () => {
    setting = "never";
    store.plans.file("shop-app", 7, parts(), false, NOW);
    const a = app();
    const res = await a.inject({
      method: "POST",
      url: "/api/plans/shop-app/7/approve",
      payload: {},
    });
    expect(res.json()).toMatchObject({ moved: false, plan: { state: "signed-off" } });
    expect(moves).toEqual([]);
    await a.close();
  });

  it("a card further along than Ready is not moved back", async () => {
    store.replaceBoard("shop-app", [card(7), card(8, "In progress")]);
    store.plans.file("shop-app", 8, parts(), true, NOW);
    const a = app();
    await a.inject({ method: "POST", url: "/api/plans/shop-app/8/approve", payload: {} });
    expect(moves).toEqual([]);
    expect(store.plans.get("shop-app", 8)?.state).toBe("signed-off");
    await a.close();
  });

  it("a card missing from the cached board is confirmed live before the plan is signed off", async () => {
    store.plans.file("shop-app", 12, parts(), true, NOW);
    moveResult = { ok: false, reason: "card not on the project" };
    const a = app();
    const res = await a.inject({
      method: "POST",
      url: "/api/plans/shop-app/12/approve",
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(moves).toHaveLength(1);
    expect(store.plans.get("shop-app", 12)?.state).toBe("awaiting-signoff");
    await a.close();
  });

  it("a cached Ready card is still confirmed by the mover, which may find it elsewhere", async () => {
    store.plans.file("shop-app", 8, parts(), true, NOW);
    moveResult = { ok: false, reason: "card is in Backlog" };
    const a = app();
    const res = await a.inject({
      method: "POST",
      url: "/api/plans/shop-app/8/approve",
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    expect(moves).toHaveLength(1);
    expect(store.plans.get("shop-app", 8)?.state).toBe("awaiting-signoff");
    await a.close();
  });

  it("send back keeps the note, returns the ticket to the planner, and tells FLIGHT", async () => {
    store.plans.file("shop-app", 7, parts(), true, NOW);
    const a = app();
    const none = await a.inject({
      method: "POST",
      url: "/api/plans/shop-app/7/send-back",
      payload: {},
    });
    expect(none.statusCode).toBe(400);
    const res = await a.inject({
      method: "POST",
      url: "/api/plans/shop-app/7/send-back",
      payload: { note: "Make it smaller." },
    });
    expect(res.statusCode).toBe(200);
    expect(store.plans.get("shop-app", 7)).toMatchObject({
      state: "sent-back",
      note: "Make it smaller.",
    });
    expect(moves).toEqual([]);
    const view = (await a.inject("/api/plans")).json();
    expect(view.waiting[0]).toMatchObject({ state: "sent-back", note: "Make it smaller." });
    await a.close();
  });

  it("unknown tickets and repos answer 404, and a plan not waiting answers 409", async () => {
    const a = app();
    for (const url of [
      "/api/plans/shop-app/7/approve",
      "/api/plans/nope/7/approve",
      "/api/plans/shop-app/x/approve",
    ])
      expect((await a.inject({ method: "POST", url, payload: {} })).statusCode).toBe(404);
    store.plans.request("shop-app", 7, NOW);
    expect(
      (await a.inject({ method: "POST", url: "/api/plans/shop-app/7/approve", payload: {} }))
        .statusCode,
    ).toBe(409);
    await a.close();
  });

  it("GET /api/tickets/:repoId/:number carries the plan", async () => {
    store.plans.file("shop-app", 7, parts(), true, NOW);
    store.plans.approve("shop-app", 7, NOW);
    const a = app();
    const res = await a.inject("/api/tickets/shop-app/7");
    expect(res.statusCode).toBe(200);
    expect(res.json().plan).toMatchObject({
      ref: "shop-app#7",
      state: "signed-off",
      asks: "Show plans.",
      proposal: "Add a tab.",
      risks: "Big page.",
    });
    await a.close();
  });
});
