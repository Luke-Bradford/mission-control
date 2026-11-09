import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BriefChoiceRequest,
  COMMS_CAPCOM_ESCALATION_MS,
  COMMS_FLIGHT_ESCALATION_MS,
  COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT,
  DECISION_DEFAULT_WAIT_MS,
  FLIGHT_RUNAWAY,
  type Run,
} from "@mc/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { chooseBrief, retainedBriefChoice } from "../src/brief-choices.ts";
import { bindCompleteBrief } from "../src/brief-prepare.ts";
import { routineBriefChoices } from "../src/brief-routine.ts";
import { briefReadState, briefSourceRevision } from "../src/brief-source.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { applyDecisionDefaults } from "../src/decision-defaults.ts";
import { recordWrite, runawayTrip } from "../src/flight/runaway.ts";
import { attentionItems } from "../src/hud.ts";
import { Store } from "../src/store.ts";
import { prepareFixtureGuidance } from "./brief-fixture.ts";

const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error("Missing fixture value");
  return value;
};

const SENT = COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT + 60_000;
const AT = SENT + COMMS_FLIGHT_ESCALATION_MS + COMMS_CAPCOM_ESCALATION_MS;
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "repo", github: "o/repo", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/wt",
    maxSeats: 2,
    sessions: [
      {
        id: "s",
        repoId: "repo",
        checkout: "/tmp/co",
        seats: [
          { id: "FLIGHT-1", role: "FLIGHT", accountId: "a", model: "x", area: [] },
          { id: "GUIDO-1", role: "GUIDO", accountId: "a", model: "x", area: [] },
        ],
      },
    ],
  },
};
let store: Store;
let dir: string;
let now: number;
function live(seatId: string, id: string) {
  const run: Run = {
    id,
    agentId: seatId,
    repoId: "repo",
    seq: 1,
    startedAt: SENT,
    endedAt: null,
    status: "running",
    sessionId: "cli",
    model: "x",
    branch: null,
    ticket: "repo#1",
    costUsd: null,
    tokens: null,
    transcriptPath: "/fixture",
    prs: [],
    summary: null,
  };
  store.upsertRun(run);
  store.setSeatSession({
    seatId,
    runId: id,
    cliSessionId: "cli",
    state: "idle",
    reason: null,
    worktree: null,
    updatedAt: SENT,
  });
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-brief-choice-"));
  store = new Store(join(dir, "db"));
  now = AT;
  live("FLIGHT-1", "flight-run");
  live("GUIDO-1", "target-run");
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
function source() {
  const message = store.addComms({
    at: SENT,
    from: "GUIDO-1",
    to: "FLIGHT-1",
    ticket: "repo#1",
    text: "Which reversible detail should I choose?",
    label: "question",
  });
  if (!message) throw new Error("missing message");
  const key = `comms-open:${message.id}`;
  prepareFixtureGuidance(config, store, now, key);
  return key;
}
function flightSource() {
  const message = store.addComms({
    at: SENT,
    from: "FLIGHT-1",
    to: "CAPCOM",
    ticket: "repo#1",
    text: "@CAPCOM approve this direction?",
    label: "question",
  });
  if (!message) throw new Error("missing message");
  const key = `comms-open:${message.id}`;
  prepareFixtureGuidance(config, store, now, key);
  return { key, message };
}
function request(key: string, requestId = "choice-one"): BriefChoiceRequest {
  const brief = store.briefs().get(key);
  if (!brief?.binding || !brief.id) throw new Error("missing bound brief");
  return {
    briefId: brief.id,
    sourceRevision: brief.binding.sourceRevision,
    optionId: "proceed",
    requestId,
  };
}
function choices(message = vi.fn(async () => {})) {
  return routineBriefChoices({
    config,
    store,
    now: () => now,
    knownSecrets: async () => [],
    supervisor: { message },
  });
}

it("dispatches a displayed exact-run choice once and retains the real receipt", async () => {
  const key = source(),
    req = request(key),
    message = vi.fn(async () => {}),
    deps = choices(message);
  expect(await chooseBrief(deps, key, req, { operator: true })).toMatchObject({
    state: "applied",
    actor: { operator: true },
  });
  expect(message).toHaveBeenCalledOnce();
  expect(message.mock.calls[0]).toMatchObject([
    "GUIDO-1",
    expect.stringContaining("existing authority"),
    { interrupt: false, questions: "none", enforcePause: true, expectedRunId: "target-run" },
  ]);
  expect(await chooseBrief(deps, key, req, { operator: true })).toMatchObject({ state: "applied" });
  expect(message).toHaveBeenCalledOnce();
  await expect(
    chooseBrief(deps, key, { ...req, optionId: "hold" }, { operator: true }),
  ).rejects.toThrow(/different choice/);
});
it("settles FLIGHT's labelled Comms question when its canonical choice is applied", async () => {
  const { key, message } = flightSource();
  expect(await chooseBrief(choices(), key, request(key), { operator: true })).toMatchObject({
    state: "applied",
  });
  expect(store.commsSettlement(message.id)).toMatchObject({ settledBy: "CAPCOM" });
  expect(attentionItems(config, store, now).find((item) => item.key === key)).toBeUndefined();
});
it("refuses replacement runs before any provider delivery or acknowledgment", async () => {
  const key = source(),
    req = request(key),
    message = vi.fn(async () => {});
  live("GUIDO-1", "replacement-run");
  await expect(chooseBrief(choices(message), key, req, { operator: true })).rejects.toThrow(
    /changed/,
  );
  expect(message).not.toHaveBeenCalled();
  expect(store.acks().has(key)).toBe(false);
});
it("rechecks the bound run inside a queued provider write and records uncertainty without replay", async () => {
  const key = source(),
    req = request(key);
  let delivered = 0;
  const message = vi.fn(async (_seat, _text, options) => {
    live("GUIDO-1", "replacement-run");
    options.beforeWrite();
    delivered++;
  });
  const deps = choices(message);
  expect(await chooseBrief(deps, key, req, { operator: true })).toMatchObject({ state: "unknown" });
  expect(delivered).toBe(0);
  expect(store.acks().has(key)).toBe(false);
  expect(await chooseBrief(deps, key, req, { operator: true })).toMatchObject({ state: "unknown" });
  expect(message).toHaveBeenCalledOnce();
});
it("does not reuse a declared FLIGHT actor after its run ends", async () => {
  const key = source(),
    req = request(key),
    message = vi.fn(async () => {});
  store.setRunEnded("flight-run", now, "ok", "engine");
  await expect(
    chooseBrief(choices(message), key, req, { seatId: "FLIGHT-1", runId: "flight-run" }),
  ).rejects.toThrow(/changed|ended/);
  expect(message).not.toHaveBeenCalled();
});
it("preserves the forty-minute clock for a cosmetic rebrief and replaces the epoch for changed direction", async () => {
  const key = source();
  const original = required(store.briefs().get(key));
  const item = required(attentionItems(config, store, now).find((item) => item.key === key));
  now += 60_000;
  const deps = choices();
  const cosmetic = await bindCompleteBrief(
    deps,
    item,
    { ...original, at: now, recommendation: "Same action, clearer explanation." },
    { seatId: "FLIGHT-1", runId: "flight-run" },
  );
  store.addBrief({ key, ...cosmetic });
  expect(store.briefs().get(key)).toMatchObject({
    binding: { epoch: original.binding?.epoch },
    defaultAt: AT + DECISION_DEFAULT_WAIT_MS,
  });
  store.instructions.create(
    null,
    { kind: "text", text: "Changed standing direction" },
    "operator",
    now,
  );
  const changed = await bindCompleteBrief(
    deps,
    item,
    { ...cosmetic, at: now },
    { seatId: "FLIGHT-1", runId: "flight-run" },
  );
  store.addBrief({ key, ...changed });
  expect(changed.binding?.epoch).not.toBe(original.binding?.epoch);
  expect(store.briefs().get(key)?.defaultAt).toBe(now + DECISION_DEFAULT_WAIT_MS);
});
it("keeps read metadata out of source identity", () => {
  const key = source(),
    brief = required(store.briefs().get(key));
  const item = required(attentionItems(config, store, now).find((item) => item.key === key));
  const revision = briefSourceRevision(
    config,
    store,
    item,
    required(brief.binding).actions.map((entry) => entry.action),
  );
  store.markCommsInboxRead("FLIGHT-1", [key.slice("comms-open:".length)]);
  expect(
    briefSourceRevision(
      config,
      store,
      item,
      required(brief.binding).actions.map((entry) => entry.action),
    ),
  ).toBe(revision);
});

it("keeps ordinary guidance current when the target commits and applies its default once", async () => {
  const key = source();
  const bound = required(store.briefs().get(key));
  store.addRunCommit({
    runId: "target-run",
    repoId: "repo",
    branch: "feature/1",
    sha: "b".repeat(40),
    at: now + 1,
  });
  const deps = choices();
  expect(briefReadState(config, store, required(deps.item(key)), bound).freshness).toBe("current");
  now += DECISION_DEFAULT_WAIT_MS;
  expect(await applyDecisionDefaults({ config, store, now, choices: deps })).toBe(1);
  expect(await applyDecisionDefaults({ config, store, now, choices: deps })).toBe(0);
  expect(
    store.commsForPair("FLIGHT-1", "GUIDO-1").filter((m) => m.from === "FLIGHT-1"),
  ).toContainEqual(expect.objectContaining({ senderKind: "flight", to: "GUIDO-1" }));
});

it("applies authorized guidance on its own aged question after forty minutes", async () => {
  const id = store.addQuestion({
    agentId: "GUIDO-1",
    runId: "target-run",
    text: "Which reversible detail?",
    at: now,
  });
  const key = `ask:${id}`;
  const original = source();
  const content = required(store.briefs().get(original));
  store.ack([original], now);
  const item = required(attentionItems(config, store, now).find((i) => i.key === key));
  const bound = await bindCompleteBrief(
    { config, store, now: () => now },
    item,
    { ...content, id: undefined, binding: undefined, state: undefined, choice: undefined },
    { seatId: "FLIGHT-1", runId: "flight-run" },
  );
  store.addBrief({ key, ...bound });
  now += DECISION_DEFAULT_WAIT_MS;
  const delivery = vi.fn(async () => {});
  expect(await applyDecisionDefaults({ config, store, now, choices: choices(delivery) })).toBe(1);
  expect(delivery).toHaveBeenCalledOnce();
  expect(await applyDecisionDefaults({ config, store, now, choices: choices(delivery) })).toBe(0);
});
it("defaults only after the server deadline through the exact-run guarded adapter", async () => {
  const key = source(),
    message = vi.fn(async () => {}),
    deps = choices(message);
  expect(await applyDecisionDefaults({ config, store, now, choices: deps })).toBe(0);
  now += DECISION_DEFAULT_WAIT_MS;
  expect(await applyDecisionDefaults({ config, store, now, choices: deps })).toBe(1);
  expect(message).toHaveBeenCalledOnce();
  expect(
    store.decisionDeliveryState(key, required(required(store.briefs().get(key)).binding).epochId)
      ?.state,
  ).toBe("delivered");
  expect(await applyDecisionDefaults({ config, store, now, choices: deps })).toBe(0);
  expect(message).toHaveBeenCalledOnce();
});
it("keeps a paused overdue FYI open and performs no claim or delivery", async () => {
  const key = source(),
    message = vi.fn(async () => {});
  now += DECISION_DEFAULT_WAIT_MS;
  store.setSetting(
    "crew.paused",
    JSON.stringify({ seats: ["GUIDO-1"], by: "operator", at: now, reason: "Pause fixture" }),
  );
  expect(await applyDecisionDefaults({ config, store, now, choices: choices(message) })).toBe(0);
  expect(message).not.toHaveBeenCalled();
  expect(store.acks().has(key)).toBe(false);
  expect(
    retainedBriefChoice({ store }, required(required(store.briefs().get(key)).binding).epoch),
  ).toBeNull();
});
it("does not let an old successful claim hide a changed same-key source", async () => {
  const key = source(),
    deps = choices();
  expect((await chooseBrief(deps, key, request(key), { operator: true })).state).toBe("applied");
  expect(attentionItems(config, store, now).find((entry) => entry.key === key)?.acked).toBe(true);
  store.instructions.create(
    null,
    { kind: "text", text: "New operator direction" },
    "operator",
    now + 1,
  );
  expect(attentionItems(config, store, now + 1).find((entry) => entry.key === key)).toMatchObject({
    acked: false,
    brief: { state: { freshness: "stale" } },
  });
});
it("serializes competing manual and timer choices to one durable epoch", async () => {
  const key = source(),
    req = request(key);
  now += DECISION_DEFAULT_WAIT_MS;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const message = vi.fn(async () => {
    await barrier;
  });
  const deps = choices(message);
  const manual = chooseBrief(deps, key, req, { operator: true });
  await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
  expect(await applyDecisionDefaults({ config, store, now, choices: deps })).toBe(0);
  release();
  expect((await manual).state).toBe("applied");
  expect(message).toHaveBeenCalledOnce();
});
it("retains unknown external outcomes across a fresh Store handle and never retries them", async () => {
  const key = source(),
    req = request(key),
    message = vi.fn(async () => {
      throw new Error("Transport outcome unavailable");
    });
  expect((await chooseBrief(choices(message), key, req, { operator: true })).state).toBe("unknown");
  const epoch = required(required(store.briefs().get(key)).binding).epoch;
  store.close();
  store = new Store(join(dir, "db"));
  expect(retainedBriefChoice({ store }, epoch)?.state).toBe("unknown");
  expect((await chooseBrief(choices(message), key, req, { operator: true })).state).toBe("unknown");
  expect(message).toHaveBeenCalledOnce();
});
it("an explicit acknowledgement cancels a due default without dispatching", async () => {
  const key = source(),
    message = vi.fn(async () => {});
  now += DECISION_DEFAULT_WAIT_MS;
  store.ack([key], now);
  expect(await applyDecisionDefaults({ config, store, now, choices: choices(message) })).toBe(0);
  expect(message).not.toHaveBeenCalled();
});

/** Stop immediately after the real atomic claim callback, before dispatch can begin. */
async function interruptedDefault(key: string, afterDispatch = false): Promise<void> {
  now = AT + DECISION_DEFAULT_WAIT_MS;
  const current = store.briefs().get(key);
  if (!current?.binding || !current.id) throw new Error("Missing fixture brief");
  const binding = current.binding;
  const req = { ...request(key), requestId: `default:${binding.epoch}` };
  const deps = choices();
  const originalSet = store.setSetting.bind(store);
  if (afterDispatch) {
    vi.spyOn(store, "setSetting").mockImplementation((key, value) => {
      if (key === `brief-choice:${binding.epoch}` && JSON.parse(value).receipt.state === "unknown")
        throw new Error("Fixture process stopped before result retention");
      originalSet(key, value);
    });
    deps.dispatch = async () => {
      throw new Error("Fixture external transport outcome unknown");
    };
  }
  await expect(
    chooseBrief(
      deps,
      key,
      req,
      { seatId: "FLIGHT-1", runId: "flight-run" },
      "default",
      (item, brief, choice) => {
        const claimed = store.claimDecisionDefault(
          {
            key,
            briefAt: binding.epochId,
            optionId: "proceed",
            label: "Proceed",
            dueAt: now,
            target: "GUIDO-1",
            answer: brief.options[0]?.answer ?? "",
            choice,
            binding: JSON.stringify({ epoch: binding.epoch, request: req }),
          },
          {
            at: now,
            from: "FLIGHT-1",
            to: "CAPCOM",
            ticket: item.ticket,
            text: "Fixture pending default",
          },
          now,
        );
        if (!afterDispatch && claimed)
          throw new Error("Fixture process stopped after atomic claim");
        return claimed;
      },
    ),
  ).rejects.toThrow(/Fixture process stopped/);
  vi.restoreAllMocks();
  expect(store.decisionDeliveryState(key, binding.epochId)?.state).toBe("pending");
  store.close();
  store = new Store(join(dir, "db"));
}
it("resumes a durable pre-dispatch claim after restart only through fresh run checks", async () => {
  const key = source();
  await interruptedDefault(key);
  const message = vi.fn(async () => {});
  expect(await applyDecisionDefaults({ config, store, now, choices: choices(message) })).toBe(0);
  expect(message).toHaveBeenCalledOnce();
  expect(
    store.decisionDeliveryState(key, required(required(store.briefs().get(key)).binding).epochId)
      ?.state,
  ).toBe("delivered");
});
it("retains a claimed default pending through an operator pause and revalidates on explicit unpause", async () => {
  const key = source();
  await interruptedDefault(key);
  const message = vi.fn(async () => {}),
    epochId = required(required(store.briefs().get(key)).binding).epochId;
  store.setSetting(
    "crew.paused",
    JSON.stringify({ seats: ["GUIDO-1"], by: "operator", at: now, reason: "Paused while offline" }),
  );
  await applyDecisionDefaults({ config, store, now, choices: choices(message) });
  expect(store.decisionDeliveryState(key, epochId)?.state).toBe("pending");
  expect(message).not.toHaveBeenCalled();
  store.setSetting("crew.paused", "null");
  await applyDecisionDefaults({ config, store, now, choices: choices(message) });
  expect(message).toHaveBeenCalledOnce();
  expect(store.decisionDeliveryState(key, epochId)?.state).toBe("delivered");
});
it("cancels a retained pending claim when the original target run was replaced", async () => {
  const key = source();
  await interruptedDefault(key);
  live("GUIDO-1", "different-run");
  const message = vi.fn(async () => {}),
    epochId = required(required(store.briefs().get(key)).binding).epochId;
  await applyDecisionDefaults({ config, store, now, choices: choices(message) });
  expect(message).not.toHaveBeenCalled();
  expect(store.decisionDeliveryState(key, epochId)?.state).toBe("canceled");
  expect(attentionItems(config, store, now).find((item) => item.key === key)?.acked).toBe(false);
});
it("persists interrupted dispatch as unknown after restart and never retries its external effect", async () => {
  const key = source();
  await interruptedDefault(key, true);
  const message = vi.fn(async () => {}),
    binding = required(required(store.briefs().get(key)).binding);
  await applyDecisionDefaults({ config, store, now, choices: choices(message) });
  expect(message).not.toHaveBeenCalled();
  expect(store.decisionDeliveryState(key, binding.epochId)).toMatchObject({
    state: "unknown",
    deliveredAt: null,
  });
  expect(retainedBriefChoice({ store }, binding.epoch)?.state).toBe("unknown");
});
it("keeps legacy operator content readable with unknown binding and no invented timer or authority", () => {
  const key = source(),
    old = required(store.briefs().get(key));
  const { binding: _binding, id: _id, ...legacy } = old;
  store.addBrief({ key, ...legacy });
  const saved = required(store.briefs().get(key));
  const write = vi.spyOn(store, "setSetting");
  const item = attentionItems(config, store, now).find((entry) => entry.key === key);
  expect(item?.brief).toMatchObject({
    id: saved.id,
    context: legacy.context,
    state: { completeness: "incomplete", freshness: "unknown" },
  });
  expect(item?.brief?.defaultAt).toBeUndefined();
  expect(item?.brief?.binding).toBeUndefined();
  expect(write).not.toHaveBeenCalled();
});

it("applies the existing runaway write accounting after a default and stops subsequent defaults", async () => {
  const first = source(),
    second = source();
  now += DECISION_DEFAULT_WAIT_MS;
  for (let n = 0; n < FLIGHT_RUNAWAY.writesPerHour; n++)
    recordWrite(store, { at: now, action: "fixture-prior-write", target: String(n) });
  const message = vi.fn(async () => {});
  const deps = routineBriefChoices({
    config,
    store,
    now: () => now,
    knownSecrets: async () => [],
    supervisor: { message },
    bus: new ChangeBus(),
  });
  expect(await applyDecisionDefaults({ config, store, now, choices: deps })).toBe(1);
  expect(message).toHaveBeenCalledOnce();
  expect(runawayTrip(store)).not.toBeNull();
  expect([first, second].filter((key) => store.acks().has(key))).toHaveLength(1);
});
it("settles an already-confirmed outbox receipt after restart without needing a new actor or delivery", async () => {
  const key = source();
  now += DECISION_DEFAULT_WAIT_MS;
  const message = vi.fn(async () => {}),
    completion = now;
  const stopped = vi.spyOn(store, "markDecisionDeliveryDone").mockImplementationOnce(() => {
    throw new Error("Fixture stopped before outbox bookkeeping");
  });
  expect(await applyDecisionDefaults({ config, store, now, choices: choices(message) })).toBe(1);
  expect(message).toHaveBeenCalledOnce();
  const epochId = required(required(store.briefs().get(key)).binding).epochId;
  expect(store.decisionDeliveryState(key, epochId)?.state).toBe("pending");
  stopped.mockRestore();
  store.setRunEnded("flight-run", now, "ok", "engine");
  now += 1000;
  await applyDecisionDefaults({ config, store, now, choices: choices(message) });
  expect(message).toHaveBeenCalledOnce();
  expect(store.decisionDeliveryState(key, epochId)).toMatchObject({
    state: "delivered",
    deliveredAt: completion,
  });
});
it("keeps an interrupted dispatch unknown when its original actor and target have both ended", async () => {
  const key = source();
  await interruptedDefault(key, true);
  store.setRunEnded("flight-run", now, "ok", "engine");
  store.setRunEnded("target-run", now, "ok", "engine");
  const message = vi.fn(async () => {}),
    epochId = required(required(store.briefs().get(key)).binding).epochId;
  await applyDecisionDefaults({ config, store, now, choices: choices(message) });
  expect(message).not.toHaveBeenCalled();
  expect(store.decisionDeliveryState(key, epochId)).toMatchObject({
    state: "unknown",
    deliveredAt: null,
  });
});
it("resolves the actual same-session FLIGHT actor for a second session's default", async () => {
  const cfg = structuredClone(config);
  required(cfg.crew).maxSeats = 4;
  required(cfg.crew).sessions.push({
    id: "second-session",
    repoId: "repo",
    checkout: "/tmp/co2",
    seats: [
      { id: "FLIGHT-2", role: "FLIGHT", accountId: "a", model: "x", area: [] },
      { id: "GUIDO-2", role: "GUIDO", accountId: "a", model: "x", area: [] },
    ],
  });
  live("FLIGHT-2", "flight-run-2");
  live("GUIDO-2", "target-run-2");
  const message = required(
    store.addComms({
      at: SENT,
      from: "GUIDO-2",
      to: "FLIGHT-2",
      ticket: "repo#2",
      text: "A reversible within-scope detail?",
      label: "question",
    }),
  );
  prepareFixtureGuidance(cfg, store, now, `comms-open:${message.id}`);
  const key = `comms-open:${message.id}`,
    delivery = vi.fn(async () => {});
  const deps = routineBriefChoices({
    config: cfg,
    store,
    now: () => now,
    knownSecrets: async () => [],
    supervisor: { message: delivery },
  });
  await expect(
    chooseBrief(deps, key, request(key), { seatId: "FLIGHT-1", runId: "flight-run" }),
  ).rejects.toThrow(/outside FLIGHT's session/);
  expect(delivery).not.toHaveBeenCalled();
  now += DECISION_DEFAULT_WAIT_MS;
  expect(await applyDecisionDefaults({ config: cfg, store, now, choices: deps })).toBe(1);
  expect(delivery).toHaveBeenCalledWith(
    "GUIDO-2",
    expect.any(String),
    expect.objectContaining({ expectedRunId: "target-run-2" }),
  );
  const epoch = required(required(store.briefs().get(key)).binding).epoch;
  expect(retainedBriefChoice({ store }, epoch)).toMatchObject({
    state: "applied",
    actor: { seatId: "FLIGHT-2", runId: "flight-run-2" },
  });
});
