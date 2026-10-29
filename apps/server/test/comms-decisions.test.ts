import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMS_CAPCOM,
  COMMS_CAPCOM_ESCALATION_MS,
  COMMS_FLIGHT_ESCALATION_MS,
  COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT,
  DECISION_DEFAULT_WAIT_MS,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { raiseStalledCommsDecisions } from "../src/comms-decisions.ts";
import type { CcConfig } from "../src/config.ts";
import { applyDecisionDefaults } from "../src/decision-defaults.ts";
import { attentionItems } from "../src/hud.ts";
import { Store } from "../src/store.ts";

const SENT = COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT + 60 * 60_000;
const STALLED = SENT + COMMS_FLIGHT_ESCALATION_MS + COMMS_CAPCOM_ESCALATION_MS;
let dir: string;
let store: Store;

const config = (): CcConfig => ({
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "repo", github: "o/repo", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  crew: {
    worktrees: "/tmp/wt",
    maxSeats: 2,
    sessions: [
      {
        id: "repo-1",
        repoId: "repo",
        checkout: "/tmp/co",
        seats: [
          { id: "GUIDO-1", role: "GUIDO", accountId: "a", model: "x", area: [] },
          { id: "FLIGHT-1", role: "FLIGHT", accountId: "a", model: "x", area: [] },
        ],
      },
    ],
  },
  poll: { usageMinutes: 30, githubSeconds: 60 },
});

function send(label: "question" | "blocker" = "question", to = "FLIGHT-1") {
  const message = store.addComms({
    at: SENT,
    from: "GUIDO-1",
    to,
    ticket: "repo#906",
    text: "Which behaviour should the sweep keep?",
    label,
  });
  if (message === null) throw new Error("message was not stored");
  return message;
}
const keyOf = (id: string) => `comms-open:${id}`;
const find = (id: string, now: number) =>
  attentionItems(config(), store, now).find((item) => item.key === keyOf(id));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-comms-decision-"));
  store = new Store(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a stalled Comms question or blocker becomes a CAPCOM decision", () => {
  it("is raised once, at 45 minutes, with a recommended option and a default", () => {
    const { id } = send();
    expect(raiseStalledCommsDecisions({ config: config(), store, now: STALLED - 1 })).toBe(0);
    expect(store.briefs().has(keyOf(id))).toBe(false);

    expect(raiseStalledCommsDecisions({ config: config(), store, now: STALLED })).toBe(1);
    const brief = store.briefs().get(keyOf(id));
    expect(brief).toMatchObject({
      for: "operator",
      recommendedOptionId: "proceed",
      defaultAt: STALLED + DECISION_DEFAULT_WAIT_MS,
    });
    expect(brief?.options.map((o) => o.id)).toEqual(["proceed", "hold"]);
    expect(find(id, STALLED)).toMatchObject({ owner: "operator", kind: "question" });

    expect(raiseStalledCommsDecisions({ config: config(), store, now: STALLED + 1 })).toBe(0);
    expect(raiseStalledCommsDecisions({ config: config(), store, now: STALLED + 60_000 })).toBe(0);
    expect(store.briefs().get(keyOf(id))?.at).toBe(STALLED);
  });

  it("carries FLIGHT's recommendation when it has briefed the item for itself", () => {
    const { id } = send("blocker");
    store.addBrief({
      key: keyOf(id),
      for: "flight",
      context: "c",
      recommendation: "Keep the newer behaviour.",
      options: [],
      basis: "b",
      at: SENT + 60_000,
    });
    expect(raiseStalledCommsDecisions({ config: config(), store, now: STALLED })).toBe(1);
    expect(store.briefs().get(keyOf(id))).toMatchObject({
      for: "operator",
      recommendation: "Keep the newer behaviour.",
    });
    expect(find(id, STALLED)).toMatchObject({ owner: "operator", kind: "blocked" });
    // FLIGHT taking it back does not raise a second decision
    store.addBrief({
      key: keyOf(id),
      for: "flight",
      context: "c",
      recommendation: "Still looking.",
      options: [],
      basis: "b",
      at: STALLED + 1,
    });
    expect(raiseStalledCommsDecisions({ config: config(), store, now: STALLED + 2 })).toBe(0);
  });

  it("is not raised when FLIGHT settles it first", () => {
    const reacted = send();
    store.addCommsReaction(reacted.id, "FLIGHT-1", "on_it", undefined, STALLED - 1);
    const replied = send();
    store.addComms({
      at: STALLED - 1,
      from: "FLIGHT-1",
      to: "GUIDO-1",
      ticket: "repo#906",
      text: "Keep the old one.",
      replyTo: replied.id,
    });
    const settled = send("blocker");
    store.settleCommsItem(settled.id, "FLIGHT-1", "Stale: the seat moved on.", STALLED - 1);
    expect(raiseStalledCommsDecisions({ config: config(), store, now: STALLED })).toBe(0);
    expect(store.briefs().size).toBe(0);
  });

  it("is not raised for a message to CAPCOM, a message before the rollout, or without FLIGHT", () => {
    send("question", COMMS_CAPCOM);
    store.addComms({
      at: COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT - 1,
      from: "GUIDO-1",
      to: "FLIGHT-1",
      ticket: "repo#1",
      text: "Old question?",
      label: "question",
    });
    expect(raiseStalledCommsDecisions({ config: config(), store, now: STALLED })).toBe(0);
    send();
    const noFlight = config();
    noFlight.crew?.sessions[0]?.seats.splice(1, 1);
    expect(raiseStalledCommsDecisions({ config: noFlight, store, now: STALLED })).toBe(0);
    expect(store.briefs().size).toBe(0);
  });

  it("is not raised for an item the operator holds", () => {
    const budget = send("blocker");
    vi.spyOn(store, "seatRun").mockReturnValue({
      id: "run",
      repoId: "repo",
      agentId: "GUIDO-1",
      prs: [],
      loop: { parked: { kind: "budget" } },
    } as never);
    expect(raiseStalledCommsDecisions({ config: config(), store, now: STALLED })).toBe(0);
    vi.restoreAllMocks();

    store.setSeatSession({
      seatId: "GUIDO-1",
      runId: null,
      cliSessionId: null,
      state: "stopped",
      reason: null,
      worktree: null,
      updatedAt: SENT,
    });
    vi.spyOn(store, "seatRun").mockReturnValue({
      id: "run",
      repoId: "repo",
      agentId: "GUIDO-1",
      prs: [],
    } as never);
    expect(raiseStalledCommsDecisions({ config: config(), store, now: STALLED })).toBe(0);
    expect(store.briefs().has(keyOf(budget.id))).toBe(false);
  });

  it("applies its default through the sweep only after the operator's wait", async () => {
    const { id } = send("blocker");
    store.setSeatSession({
      seatId: "GUIDO-1",
      runId: "run",
      cliSessionId: null,
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: SENT,
    });
    raiseStalledCommsDecisions({ config: config(), store, now: STALLED });
    const deliver = vi.fn(async () => {});
    const due = STALLED + DECISION_DEFAULT_WAIT_MS;
    expect(await applyDecisionDefaults({ config: config(), store, now: due - 1, deliver })).toBe(0);
    expect(await applyDecisionDefaults({ config: config(), store, now: due, deliver })).toBe(1);
    expect(deliver).toHaveBeenCalledWith("GUIDO-1", expect.stringContaining(keyOf(id)));
    expect(find(id, due)?.acked).toBe(true);
    expect(await applyDecisionDefaults({ config: config(), store, now: due + 1, deliver })).toBe(0);
  });
});
