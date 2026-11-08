import type { AttentionBrief, AttentionItem, Run } from "@mc/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChoiceRefused, choiceReceipt, chooseOption } from "../src/choose.ts";
import type { CcConfig } from "../src/config.ts";
import { attentionItems, NO_LOCK } from "../src/hud.ts";
import { Store } from "../src/store.ts";
import { ticketHistory } from "../src/ticket-history.ts";

const seat = (id: string, role: string) => ({
  id,
  role,
  accountId: "claude-main",
  model: "opus",
  area: [],
});
const config: CcConfig = {
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
  repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/none",
    maxSeats: 8,
    sessions: [
      {
        id: "s1",
        repoId: "mc",
        checkout: "/tmp/none/clone",
        seats: [seat("flight-1", "FLIGHT"), seat("guido-1", "GUIDO"), seat("inco-1", "INCO")],
      },
    ],
  },
};
const crew = () => ["flight-1", "guido-1", "inco-1"];
const run = (over: Partial<Run>): Run => ({
  id: "r1",
  agentId: "guido-1",
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
const BRIEF_AT = 5_000;
const brief: AttentionBrief = {
  for: "operator",
  ask: "Ship the plan as is?",
  context: "c",
  recommendation: "r",
  basis: "b",
  at: BRIEF_AT,
  options: [
    { id: "yes", label: "Ship it", answer: "Go ahead and ship." },
    { id: "no", label: "Hold", answer: "Wait for me." },
    { label: "No id", answer: "unbound" },
  ],
};
const item = (key: string, over: Partial<AttentionItem> = {}): AttentionItem => ({
  key,
  kind: "question",
  agentId: "guido-1",
  repoId: "mc",
  text: "Ship the plan?",
  tool: null,
  at: 1,
  url: null,
  escalationId: null,
  ticket: "mc#7",
  brief,
  acked: false,
  ...over,
});

let store: Store;
let wake: ReturnType<typeof vi.fn>;
let reconcile: ReturnType<typeof vi.fn>;
let nowMs: number;
const deps = () => ({
  config,
  store,
  now: () => nowMs,
  sender: { from: "CAPCOM", kind: "operator" as const },
  crew,
  knownSecrets: async () => [],
  wake,
  reconcileRun: reconcile,
});
const seatSession = (seatId: string, runId: string | null) =>
  store.setSeatSession({
    seatId,
    runId,
    cliSessionId: null,
    state: runId === null ? "idle" : "running",
    reason: null,
    worktree: null,
    updatedAt: 1,
  });

beforeEach(() => {
  store = new Store(":memory:");
  wake = vi.fn();
  reconcile = vi.fn(async () => {});
  nowMs = 10_000;
});

const ask = () => {
  store.upsertRun(run({ id: "r1" }));
  seatSession("guido-1", "r1");
  return store.addQuestion({ agentId: "guido-1", runId: "r1", text: "Ship the plan?", at: 2 });
};

it("delivers a seat's answer to the run that asked, wakes it and tells FLIGHT in one line", async () => {
  const q = ask();
  const receipt = await chooseOption(deps(), item(`ask:${q}`), `ask:${q}`, {
    optionId: "yes",
    briefAt: BRIEF_AT,
  });
  expect(receipt).toMatchObject({
    label: "Ship it",
    to: "guido-1",
    target: "seat",
    chosenAt: 10_000,
    deliveredAt: null,
    alreadyChosen: false,
  });
  const [msg] = store.comms(0).filter((m) => m.to === "guido-1");
  expect(msg?.text).toContain("Go ahead and ship.");
  const sentId = store.latestChoice(`ask:${q}`)?.messageId ?? "";
  expect(store.commsRun(sentId)?.id).toBe("r1");
  expect(store.isChoiceAnswer(sentId)).toBe(true);
  expect(store.isChoiceAnswer("comms:999")).toBe(false);
  // a hub-built answer is not a message the seat owes a reply to
  store.markCommsInboxRead("guido-1", [sentId], 12_000);
  expect(store.owedCommsFrom("CAPCOM", "guido-1", 0)).toEqual([]);
  expect(wake).toHaveBeenCalledWith("guido-1");
  expect(store.question(q)?.answeredAt).toBe(10_000);
  // FLIGHT is told, but not woken
  const note = store.comms(0).filter((m) => m.to === "flight-1");
  expect(note).toHaveLength(1);
  expect(note[0]?.label ?? null).toBeNull();
  expect(wake).not.toHaveBeenCalledWith("flight-1");
  // the seat takes it at its turn: the receipt then shows when
  store.markCommsInboxRead("guido-1", [sentId], 12_000);
  expect(choiceReceipt(store, `ask:${q}`)?.deliveredAt).toBe(12_000);
});

it("writes the question, the choice and the time into the ticket's history", async () => {
  const q = ask();
  await chooseOption(deps(), item(`ask:${q}`), `ask:${q}`, { optionId: "no", briefAt: BRIEF_AT });
  const history = ticketHistory({
    store,
    repoId: "mc",
    number: 7,
    github: "o/mc",
    issue: null,
    githubError: null,
    singleRepo: true,
    repoOfSender: () => null,
    before: null,
    limit: 50,
  });
  const row = history?.timeline.find((e) => e.kind === "decision" && e.decisionKind === "choice");
  expect(row).toMatchObject({ at: 10_000, about: "Ship the plan as is?" });
  expect(row?.kind === "decision" && row.decision).toContain("Hold");
});

it("sends FLIGHT's own question to FLIGHT and wakes it", async () => {
  const key = "note:flight-own";
  const receipt = await chooseOption(
    deps(),
    item(key, { agentId: "flight-1", kind: "blocked" }),
    key,
    {
      optionId: "yes",
      briefAt: BRIEF_AT,
    },
  );
  expect(receipt).toMatchObject({ to: "flight-1", target: "flight" });
  expect(wake).toHaveBeenCalledWith("flight-1");
  expect(store.comms(0).filter((m) => m.to === "flight-1")).toHaveLength(1);
});

it("sends the answer to FLIGHT when the asking run has ended, never to the run now on the seat", async () => {
  store.upsertRun(run({ id: "r1", endedAt: 3_000, status: "ok" }));
  store.upsertRun(run({ id: "r2", seq: 2 }));
  seatSession("guido-1", "r2");
  const q = store.addQuestion({ agentId: "guido-1", runId: "r1", text: "Ship?", at: 2 });
  const receipt = await chooseOption(deps(), item(`ask:${q}`), `ask:${q}`, {
    optionId: "yes",
    briefAt: BRIEF_AT,
  });
  expect(receipt).toMatchObject({ to: "flight-1", target: "flight-for-next-run" });
  expect(store.comms(0).filter((m) => m.to === "guido-1")).toHaveLength(0);
  const toFlight = store.comms(0).filter((m) => m.to === "flight-1");
  expect(toFlight).toHaveLength(1);
  expect(toFlight[0]?.text).toContain("Pass this on to the next run on mc#7");
  expect(wake).toHaveBeenCalledWith("flight-1");
  expect(wake).not.toHaveBeenCalledWith("guido-1");
  expect(store.question(q)?.answeredAt).toBe(10_000);
});

it("wakes a set-aside run through the engine, not the run on its seat", async () => {
  store.upsertRun(run({ id: "r1" }));
  store.upsertRun(run({ id: "r2", seq: 2 }));
  seatSession("guido-1", "r2");
  const q = store.addQuestion({ agentId: "guido-1", runId: "r1", text: "Ship?", at: 2 });
  await chooseOption(deps(), item(`ask:${q}`), `ask:${q}`, { optionId: "yes", briefAt: BRIEF_AT });
  expect(reconcile).toHaveBeenCalledWith("r1");
  // the engine wakes a set-aside run; nothing wakes the run now on the seat
  expect(wake).not.toHaveBeenCalled();
  expect(store.comms(0).find((m) => m.to === "guido-1")).toBeDefined();
});

it("refuses what the bound ids do not name, and a second pick returns the first receipt", async () => {
  const q = ask();
  const key = `ask:${q}`;
  const go = (optionId: string, briefAt = BRIEF_AT, it_: AttentionItem | null = item(key)) =>
    chooseOption(deps(), it_ ?? undefined, key, { optionId, briefAt });
  await expect(go("missing")).rejects.toBeInstanceOf(ChoiceRefused);
  await expect(go("")).rejects.toBeInstanceOf(ChoiceRefused);
  // an option with no id cannot be picked, and chat text is not an id
  await expect(go("No id")).rejects.toBeInstanceOf(ChoiceRefused);
  await expect(go("Ship it")).rejects.toBeInstanceOf(ChoiceRefused);
  await expect(go("yes", BRIEF_AT - 1)).rejects.toMatchObject({ status: 409 });
  await expect(go("yes", BRIEF_AT, null)).rejects.toMatchObject({ status: 404 });
  await expect(go("yes", BRIEF_AT, item(key, { escalationId: "e1" }))).rejects.toMatchObject({
    status: 409,
  });
  await expect(
    go("yes", BRIEF_AT, item(key, { brief: { ...brief, for: "flight" } })),
  ).rejects.toMatchObject({ status: 409 });
  expect(store.comms(0)).toHaveLength(0);
  const first = await go("yes");
  const second = await go("no");
  expect(second).toMatchObject({ optionId: "yes", alreadyChosen: true, chosenAt: first.chosenAt });
  expect(store.comms(0).filter((m) => m.to === "guido-1")).toHaveLength(1);
});

it("two picks on one brief at the same moment deliver once, and both receipts name the first pick", async () => {
  const q = ask();
  const key = `ask:${q}`;
  const go = (optionId: string) =>
    chooseOption(deps(), item(key), key, { optionId, briefAt: BRIEF_AT });
  const [a, b] = await Promise.all([go("yes"), go("no")]);
  expect(store.comms(0).filter((m) => m.to === "guido-1")).toHaveLength(1);
  expect(b.optionId).toBe(a.optionId);
  expect(wake).toHaveBeenCalledTimes(1);
});

it("lets the operator choose again when the answer could not be sent", async () => {
  const q = ask();
  const key = `ask:${q}`;
  const failing = { ...deps(), knownSecrets: async () => ["Go ahead and ship."] };
  await expect(
    chooseOption(failing, item(key), key, { optionId: "yes", briefAt: BRIEF_AT }),
  ).rejects.toBeInstanceOf(ChoiceRefused);
  expect(store.choice(key, BRIEF_AT)).toBeNull();
  const receipt = await chooseOption(deps(), item(key), key, {
    optionId: "yes",
    briefAt: BRIEF_AT,
  });
  expect(receipt.alreadyChosen).toBe(false);
});

it("refuses a brief the hub wrote, which acts through its own buttons, and changes nothing", async () => {
  const key = "note:queue-swap";
  await expect(
    chooseOption(
      deps(),
      item(key, { agentId: "flight-1", kind: "blocked", brief: { ...brief, by: "hub" } }),
      key,
      { optionId: "yes", briefAt: BRIEF_AT },
    ),
  ).rejects.toMatchObject({ status: 409 });
  expect(store.comms(0)).toHaveLength(0);
  expect(store.choice(key, BRIEF_AT)).toBeNull();
  expect(wake).not.toHaveBeenCalled();
});

it("names the asking seat when the run that asked has ended", async () => {
  store.upsertRun(run({ id: "r1", endedAt: 3_000, status: "ok" }));
  const q = store.addQuestion({ agentId: "guido-1", runId: "r1", text: "Ship?", at: 2 });
  await chooseOption(deps(), item(`ask:${q}`), `ask:${q}`, { optionId: "yes", briefAt: BRIEF_AT });
  expect(store.comms(0).find((m) => m.to === "flight-1")?.text).toContain(
    "guido-1's run that asked",
  );
});

it("keeps the choice when waking a set-aside run fails, and releases it only when nothing was sent", async () => {
  store.upsertRun(run({ id: "r1" }));
  store.upsertRun(run({ id: "r2", seq: 2 }));
  seatSession("guido-1", "r2");
  const q = store.addQuestion({ agentId: "guido-1", runId: "r1", text: "Ship?", at: 2 });
  const key = `ask:${q}`;
  reconcile.mockRejectedValueOnce(new Error("engine busy"));
  const receipt = await chooseOption(deps(), item(key), key, {
    optionId: "yes",
    briefAt: BRIEF_AT,
  });
  expect(receipt.alreadyChosen).toBe(false);
  expect(store.choice(key, BRIEF_AT)).not.toBeNull();
  expect(store.comms(0).filter((m) => m.to === "guido-1")).toHaveLength(1);
});

it("takes a chosen note out of Needs you at its source", async () => {
  store.raiseNote({
    key: "blocked:demo",
    kind: "blocked",
    runId: null,
    seatId: null,
    repoId: null,
    text: "Choose",
    at: 1,
  });
  const key = "note:blocked:demo";
  const before = attentionItems(config, store, nowMs, NO_LOCK);
  expect(before.some((i) => i.key === key)).toBe(true);
  await chooseOption(deps(), item(key, { agentId: "flight-1", kind: "blocked" }), key, {
    optionId: "yes",
    briefAt: BRIEF_AT,
  });
  const after = attentionItems(config, store, nowMs, NO_LOCK);
  expect(after.some((i) => i.key === key)).toBe(false);
});

it("closes the question before it asks the engine to wake a set-aside run", async () => {
  store.upsertRun(run({ id: "r1" }));
  store.upsertRun(run({ id: "r2", seq: 2 }));
  seatSession("guido-1", "r2");
  const q = store.addQuestion({ agentId: "guido-1", runId: "r1", text: "Ship?", at: 2 });
  store.passQuestion(q, 3);
  let seen: number | null | undefined;
  reconcile = vi.fn(async () => {
    seen = store.question(q)?.answeredAt;
  });
  await chooseOption(deps(), item(`ask:${q}`), `ask:${q}`, { optionId: "yes", briefAt: BRIEF_AT });
  expect(seen).toBe(10_000);
});

describe("a seat's question that reached Needs you as an open Comms item", () => {
  const asked = (runId: string) => {
    const m = store.addComms({
      at: 2,
      from: "guido-1",
      to: "CAPCOM",
      ticket: "mc#7",
      text: "Which way?",
      label: "question",
      fromRunId: runId,
    });
    if (m === null) throw new Error("not stored");
    return `comms-open:${m.id}`;
  };

  it("goes to the seat's live run, which is woken", async () => {
    store.upsertRun(run({ id: "r1" }));
    seatSession("guido-1", "r1");
    const key = asked("r1");
    const receipt = await chooseOption(deps(), item(key, { kind: "message" }), key, {
      optionId: "yes",
      briefAt: BRIEF_AT,
    });
    expect(receipt).toMatchObject({ to: "guido-1", target: "seat" });
    expect(wake).toHaveBeenCalledWith("guido-1");
    expect(store.commsRun(store.latestChoice(key)?.messageId ?? "")?.id).toBe("r1");
    expect(store.comms(0).filter((m) => m.to === "flight-1")).toHaveLength(1);
  });

  it("goes to FLIGHT to pass on when that run has ended, naming the seat", async () => {
    store.upsertRun(run({ id: "r1", endedAt: 3_000, status: "ok" }));
    const key = asked("r1");
    const receipt = await chooseOption(deps(), item(key, { kind: "message" }), key, {
      optionId: "yes",
      briefAt: BRIEF_AT,
    });
    expect(receipt).toMatchObject({ to: "flight-1", target: "flight-for-next-run" });
    const toFlight = store.comms(0).filter((m) => m.to === "flight-1");
    expect(toFlight[0]?.text).toContain("Pass this on");
    expect(toFlight[0]?.text).toContain("guido-1");
    expect(store.comms(0).filter((m) => m.to === "guido-1")).toHaveLength(0);
  });
});

it("sends an item that is not a seat's question (a crew error) to FLIGHT as its own", async () => {
  store.upsertRun(run({ id: "r1" }));
  seatSession("guido-1", "r1");
  const key = "crew-error:1";
  const r = await chooseOption(deps(), item(key, { kind: "error" }), key, {
    optionId: "yes",
    briefAt: BRIEF_AT,
  });
  expect(r).toMatchObject({ to: "flight-1", target: "flight" });
  const text = store.comms(0).find((m) => m.to === "flight-1")?.text ?? "";
  expect(text).not.toContain("Pass this on");
  expect(store.comms(0).filter((m) => m.to === "guido-1")).toHaveLength(0);
});

describe("a seat's tag or message item", () => {
  const written = (runId: string) => {
    const m = store.addComms({
      at: 2,
      from: "guido-1",
      to: "CAPCOM",
      ticket: "mc#7",
      text: "@CAPCOM which way?",
      fromRunId: runId,
    });
    if (m === null) throw new Error("not stored");
    return `tag:guido-1:${m.id}`;
  };

  it("goes to the seat's live run, read from the key", async () => {
    store.upsertRun(run({ id: "r1" }));
    seatSession("guido-1", "r1");
    const key = written("r1");
    const r = await chooseOption(deps(), item(key, { kind: "tag" }), key, {
      optionId: "yes",
      briefAt: BRIEF_AT,
    });
    expect(r).toMatchObject({ to: "guido-1", target: "seat" });
    expect(wake).toHaveBeenCalledWith("guido-1");
    expect(store.commsRun(store.latestChoice(key)?.messageId ?? "")?.id).toBe("r1");
  });

  it("goes to FLIGHT to pass on, naming the seat, when that run has ended", async () => {
    store.upsertRun(run({ id: "r1", endedAt: 3_000, status: "ok" }));
    const key = written("r1");
    const r = await chooseOption(deps(), item(key, { kind: "tag" }), key, {
      optionId: "yes",
      briefAt: BRIEF_AT,
    });
    expect(r).toMatchObject({ to: "flight-1", target: "flight-for-next-run" });
    const text = store.comms(0).find((m) => m.to === "flight-1")?.text ?? "";
    expect(text).toContain("Pass this on");
    expect(text).toContain("guido-1");
  });

  it("does not say the run has ended when the run is not known", async () => {
    const key = "message:guido-1:comms:999";
    await chooseOption(deps(), item(key, { kind: "message" }), key, {
      optionId: "yes",
      briefAt: BRIEF_AT,
    });
    const text = store.comms(0).find((m) => m.to === "flight-1")?.text ?? "";
    expect(text).toContain("not known");
    expect(text).not.toContain("has ended");
  });
});
