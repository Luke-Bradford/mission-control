import {
  type AttentionBrief,
  type AttentionItem,
  COMMS_CAPCOM_ESCALATION_MS,
  COMMS_FLIGHT_ESCALATION_MS,
  COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT,
  FLIGHT_DOWN_NOTE_KEY,
  FLIGHT_NOT_TRIAGING_KEY,
  FLIGHT_RUNAWAY_NOTE_KEY,
  type Run,
} from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import * as defaults from "../src/decision-defaults.ts";
import { createScheduler } from "../src/scheduler.ts";
import { Store } from "../src/store.ts";

const SENT = COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT + 60 * 60_000;
const NOW = SENT + COMMS_FLIGHT_ESCALATION_MS + COMMS_CAPCOM_ESCALATION_MS + 60_000;
const config: CcConfig = {
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "repo", github: "o/repo", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  crew: {
    worktrees: "/fixture/worktrees",
    maxSeats: 2,
    sessions: [
      {
        id: "repo",
        repoId: "repo",
        checkout: "/fixture/clone",
        seats: [
          { id: "guido-1", role: "GUIDO", accountId: "a", model: "x", area: [] },
          { id: "flight-1", role: "FLIGHT", accountId: "a", model: "x", area: [] },
        ],
      },
    ],
  },
  poll: { usageMinutes: 30, githubSeconds: 60 },
};
let store: Store;
let bus: ChangeBus;
let app: FastifyInstance;

beforeEach(() => {
  store = new Store(":memory:");
  bus = new ChangeBus();
  app = buildApp({ config, store, bus, now: () => NOW });
});
afterEach(async () => {
  await app.close();
  store.close();
  vi.restoreAllMocks();
});

function flight(live: boolean) {
  if (!live) {
    store.raiseNote({
      key: FLIGHT_DOWN_NOTE_KEY,
      kind: "blocked",
      runId: null,
      seatId: "flight-1",
      repoId: "repo",
      text: "FLIGHT could not start. Your message is saved.",
      at: SENT,
    });
    return;
  }
  store.upsertRun({
    id: "r-flight",
    agentId: "flight-1",
    repoId: "repo",
    seq: 1,
    startedAt: SENT - 1000,
    endedAt: null,
    status: "running",
    sessionId: "cli",
    model: "x",
    branch: null,
    ticket: null,
    costUsd: null,
    tokens: null,
    transcriptPath: "",
    prs: [],
    summary: null,
  } satisfies Run);
  store.setSeatSession({
    seatId: "flight-1",
    runId: "r-flight",
    cliSessionId: "cli",
    state: "idle",
    reason: null,
    worktree: null,
    updatedAt: SENT - 1000,
  });
}

function message(label: "question" | "blocker", n = 0) {
  const row = store.addComms({
    at: SENT,
    from: "guido-1",
    to: "flight-1",
    ticket: "repo#906",
    text: `Which behavior should the sweep keep (${n})?`,
    label,
  });
  if (!row) throw new Error("message missing");
  return `comms-open:${row.id}`;
}

function brief(key: string, by: "hub" | "flight") {
  const value: AttentionBrief = {
    for: "operator",
    by,
    at: SENT + 1,
    ticket: "repo#906",
    ask: "Should the sweep keep the older behavior?",
    context: "Two behaviors fit the request. The crew needs a choice before continuing.",
    recommendation: "Keep the older behavior because it preserves existing results.",
    options: [
      { id: "keep", label: "Keep it", answer: "Keep the older behavior." },
      { id: "change", label: "Change it", answer: "Use the newer behavior." },
    ],
    basis: "The existing behavior is documented.",
  };
  store.addBrief({ key, ...value });
  return value;
}

async function attention(): Promise<AttentionItem[]> {
  const response = await app.inject({ method: "GET", url: "/api/attention" });
  expect(response.statusCode).toBe(200);
  return response.json();
}

/** Exercise the real periodic decision pass without starting providers or network collectors. */
async function pollDecisions() {
  const reachedDefaults = vi.spyOn(defaults, "applyDecisionDefaults");
  const scheduler = createScheduler({ config, store, bus, now: () => NOW });
  try {
    await scheduler.tick("ta"); // no loops configured; still runs the normal decision pass
    await vi.waitFor(() => expect(reachedDefaults).toHaveBeenCalled());
  } finally {
    await scheduler.stop();
    reachedDefaults.mockRestore();
  }
}

describe("crew Comms questions stay with FLIGHT", () => {
  it.each([true, false])(
    "does not invent a hub brief after the timeout, FLIGHT live=%s",
    async (live) => {
      flight(live);
      const key = message("question");
      await pollDecisions();
      expect(store.briefs().has(key)).toBe(false);
      expect((await attention()).find((item) => item.key === key)).toMatchObject({
        owner: "flight",
      });
    },
  );

  it("three overdue blockers with FLIGHT down produce one operator alert", async () => {
    flight(false);
    const keys = [0, 1, 2].map((n) => message("blocker", n));
    await pollDecisions();
    const items = await attention();
    expect(items.filter((item) => item.owner === "operator").map((item) => item.key)).toEqual([
      FLIGHT_NOT_TRIAGING_KEY,
    ]);
    for (const key of keys) expect(items.find((item) => item.key === key)?.owner).toBe("flight");
    expect(store.briefs().size).toBe(0);
  });

  it.each([true, false])(
    "ignores a legacy hub brief without deleting its history, FLIGHT live=%s",
    async (live) => {
      flight(live);
      const key = message("blocker");
      const original = brief(key, "hub");
      await pollDecisions();
      const item = (await attention()).find((candidate) => candidate.key === key);
      expect(item).toMatchObject({ owner: "flight" });
      expect(item?.brief).toBeUndefined();
      expect(store.briefs().get(key)).toMatchObject(original);
      expect(store.countBriefs(0)).toBe(1);
    },
  );

  it.each([true, false])("preserves a real complete FLIGHT brief, FLIGHT live=%s", async (live) => {
    flight(live);
    const key = message("question");
    brief(key, "flight");
    await pollDecisions();
    expect((await attention()).find((item) => item.key === key)).toMatchObject({
      owner: "operator",
      brief: { by: "flight", for: "operator" },
    });
  });

  it("keeps the protected runaway alert beside the single outage alert", async () => {
    flight(false);
    message("blocker");
    store.raiseNote({
      key: FLIGHT_RUNAWAY_NOTE_KEY,
      kind: "flag",
      runId: null,
      seatId: "flight-1",
      repoId: "repo",
      text: "FLIGHT is held for repeated writes.",
      at: SENT,
    });
    await pollDecisions();
    expect(
      (await attention()).find((item) => item.key === `note:${FLIGHT_RUNAWAY_NOTE_KEY}`)?.owner,
    ).toBe("operator");
  });
});
