import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMS_CAPCOM, DECISION_DEFAULT_WAIT_MS } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { holdItem, releaseHold } from "../src/attention-holds.ts";
import type { CcConfig } from "../src/config.ts";
import { applyDecisionDefaults } from "../src/decision-defaults.ts";
import { attentionItems } from "../src/hud.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const MIN = 60_000;
const ASKED = NOW - 10 * MIN;
const DUE = ASKED + DECISION_DEFAULT_WAIT_MS;

let dir: string;
let dbPath: string;
let store: Store;
let config: CcConfig;
let key: string;

const seatDef = (id: string, role: string) => ({
  id,
  role,
  accountId: "claude-main",
  model: "sonnet",
  area: [],
});

/** Brief the question `ask:<id>` for the operator, recommending the "acme" option. */
const brief = (id: number, ask = "Pick a vendor?") =>
  store.addBrief({
    key: `ask:${id}`,
    for: "operator",
    context: "c",
    ask,
    recommendation: "Acme",
    recommendedOptionId: "acme",
    options: [
      { id: "acme", label: "Acme", answer: "Go with Acme." },
      { id: "beta", label: "Beta", answer: "Go with Beta." },
    ],
    basis: "b",
    at: ASKED,
  });

const question = (agentId: string) =>
  store.addQuestion({ agentId, runId: `r-${agentId}`, text: "Which vendor?", at: ASKED - MIN });

const seatUp = (seatId: string) => {
  store.setSeatSession({
    seatId,
    runId: `r-${seatId}`,
    cliSessionId: null,
    state: "idle",
    reason: null,
    worktree: null,
    updatedAt: NOW - 60 * MIN,
  });
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-defaults-"));
  dbPath = join(dir, "mc.sqlite");
  store = new Store(dbPath);
  config = {
    operator: { id: "operator", timezone: "Europe/London" },
    accounts: [{ id: "claude-main", vendor: "claude", alertAt: 85, stopAt: 95 }],
    repos: [{ id: "shop-app", github: "o/shop-app", project: 2, statusMap: {}, autonomy: "draft" }],
    loops: [],
    crew: {
      worktrees: join(dir, "wt"),
      maxSeats: 4,
      sessions: [
        {
          id: "shop-app-1",
          repoId: "shop-app",
          checkout: join(dir, "co"),
          seats: [
            seatDef("GUIDO-1", "GUIDO"),
            seatDef("GUIDO-2", "GUIDO"),
            seatDef("FLIGHT-1", "FLIGHT"),
          ],
        },
      ],
    },
    poll: { usageMinutes: 30, githubSeconds: 60 },
  };
  seatUp("GUIDO-1");
  key = `ask:${question("GUIDO-1")}`;
  brief(Number(key.slice(4)));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const sweep = (now: number, s = store, deliver?: (id: string, text: string) => Promise<void>) =>
  applyDecisionDefaults({ config, store: s, now, deliver });
const outcomes = () => store.commsForPair(COMMS_CAPCOM, "FLIGHT-1").map((m) => m.text);

describe("decision defaults", () => {
  it("shows the deadline on the card", () => {
    expect(attentionItems(config, store, NOW).find((i) => i.key === key)?.defaultDueAt).toBe(DUE);
  });

  it("applies the default at the deadline: the card leaves and the outcome is in Comms", async () => {
    const deliver = vi.fn(async () => {});
    expect(await sweep(DUE - 1, store, deliver)).toBe(0);
    expect(await sweep(DUE, store, deliver)).toBe(1);
    expect(attentionItems(config, store, DUE).find((i) => i.key === key)?.acked).toBe(true);
    expect(outcomes()).toEqual(["Default applied: Acme (Pick a vendor?)"]);
  });

  it("delivers the answer to the seat that asked", async () => {
    const deliver = vi.fn(async () => {});
    await sweep(DUE, store, deliver);
    expect(deliver).toHaveBeenCalledExactlyOnceWith("GUIDO-1", "Go with Acme.");
  });

  it("delivers to FLIGHT when the asker has no seat session", async () => {
    const id = question("GUIDO-9");
    brief(id, "Other?");
    store.ack([key], NOW);
    const deliver = vi.fn(async () => {});
    await sweep(DUE, store, deliver);
    expect(deliver).toHaveBeenCalledExactlyOnceWith("FLIGHT-1", "Go with Acme.");
  });

  it("leaves an escalation alone: it is answered on GitHub", async () => {
    store.replaceEscalations("shop-app", [
      {
        id: "shop-app#9",
        repoId: "shop-app",
        issueNumber: 9,
        title: "[operator-decision] pick one",
        kind: "operator-decision",
        source: "title",
        openedAt: ASKED - MIN,
        url: "https://github.com/o/shop-app/issues/9",
        question: null,
      },
    ]);
    const esc = attentionItems(config, store, NOW).find((i) => i.kind === "decision");
    store.addBrief({ ...store.briefs().get(key)!, key: esc?.key ?? "" });
    store.ack([key], NOW);
    const deliver = vi.fn(async () => {});
    expect(await sweep(DUE, store, deliver)).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(attentionItems(config, store, DUE).find((i) => i.key === esc?.key)).toMatchObject({
      acked: false,
    });
  });

  it("applies once: a second sweep and a restarted store do nothing", async () => {
    expect(await sweep(DUE)).toBe(1);
    expect(await sweep(DUE + MIN)).toBe(0);
    store.close();
    store = new Store(dbPath);
    expect(await sweep(DUE + 2 * MIN)).toBe(0);
    expect(outcomes()).toHaveLength(1);
  });

  it("applies an overdue default after a restart", async () => {
    store.close();
    store = new Store(dbPath);
    expect(await sweep(DUE + 5 * MIN)).toBe(1);
  });

  it("a failed outcome write rolls the claim back, so a later sweep applies it", async () => {
    const spy = vi
      .spyOn(store as unknown as { insertComms: () => number }, "insertComms")
      .mockImplementationOnce(() => {
        throw new Error("disk full");
      });
    await expect(sweep(DUE)).rejects.toThrow("disk full");
    spy.mockRestore();
    expect(outcomes()).toEqual([]);
    expect(attentionItems(config, store, DUE).find((i) => i.key === key)?.acked).toBe(false);
    expect(await sweep(DUE + MIN)).toBe(1);
    expect(outcomes()).toHaveLength(1);
  });

  it("an answer before the deadline cancels it", async () => {
    store.ack([key], DUE - MIN);
    expect(await sweep(DUE + MIN)).toBe(0);
    expect(outcomes()).toHaveLength(0);
  });

  it("Held stops the clock: nothing applies while held, and the wait restarts on release", async () => {
    holdItem(store, key, "later", { kind: "manual" }, "operator", DUE - MIN);
    expect(await sweep(DUE + MIN)).toBe(0);
    releaseHold(store, key, DUE + 5 * MIN);
    expect(await sweep(DUE + 6 * MIN)).toBe(0);
    expect(await sweep(DUE + 5 * MIN + DECISION_DEFAULT_WAIT_MS)).toBe(1);
  });
});
