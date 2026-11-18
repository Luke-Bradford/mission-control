import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMS_CAPCOM, type ItemThread, OPERATOR_HEADER, type Run } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { itemThread } from "../src/attention/item-thread.ts";
import { ChangeBus } from "../src/bus.ts";
import { sendComms } from "../src/comms/index.ts";
import type { CcConfig } from "../src/config.ts";
import { FLIGHT_OPERATOR_ACTOR_HEADER } from "../src/flight/operator-call.ts";
import type { Supervisor } from "../src/runtime/supervisor.ts";
import type { CommsRow } from "../src/store/types.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-13T18:00:00Z");
const HOUR = 3_600_000;
const HEADERS = { [OPERATOR_HEADER]: "test-token" };
const KEY = "note:hub-update-held";
let dir: string;
let store: Store;
let apps: ReturnType<typeof buildApp>[];

const config = (): CcConfig => ({
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "merge" }],
  loops: [],
  crew: {
    worktrees: "/tmp/wt",
    maxSeats: 2,
    sessions: [
      {
        id: "mc-1",
        repoId: "mc",
        checkout: "/tmp/co",
        seats: [
          { id: "guido-1", role: "GUIDO", accountId: "a", model: "x", area: [] },
          { id: "flight-1", role: "FLIGHT", accountId: "a", model: "x", area: [] },
        ],
      },
    ],
  },
  poll: { usageMinutes: 30, githubSeconds: 60 },
});

const supervisor = {
  status: () => ({ enabled: true, note: null }),
  busy: () => [],
  seat: () => ({ runId: null }),
  message: async () => {},
} as unknown as Supervisor;

/** An app for one test; afterEach closes it before the store, so no timer reads a closed store. */
const app = () => {
  const a = buildApp({
    config: config(),
    store,
    bus: new ChangeBus(),
    operatorToken: "test-token",
    supervisor,
    knownSecrets: async () => [],
    now: () => NOW,
  });
  apps.push(a);
  return a;
};

const say = (a: ReturnType<typeof app>, text: string, itemKey = KEY, seat = "flight-1") =>
  a.inject({
    method: "POST",
    url: `/api/seats/${seat}/message`,
    headers: HEADERS,
    payload: { text, itemKey },
  });

const read = async (a: ReturnType<typeof app>, key = KEY) =>
  (
    await a.inject({
      method: "GET",
      url: `/api/attention/${encodeURIComponent(key)}/thread`,
      headers: HEADERS,
    })
  ).json() as ItemThread;

/** A seat answers a message through Comms, as its comms tool does. */
const replies = (from: string, replyTo: string, text: string, label?: "question") =>
  sendComms(
    {
      store,
      crew: () => ["guido-1", "flight-1"],
      knownSecrets: async () => [],
      now: () => NOW + 180_000,
      senderKind: from === "flight-1" ? "flight" : "seat",
    },
    from,
    { to: COMMS_CAPCOM, text, replyTo, ...(label ? { label } : {}) },
  );

const raise = (key: string, at: number, text = "A new version is waiting.") =>
  store.raiseNote({ key, kind: "blocked", runId: null, seatId: null, repoId: null, text, at });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-item-thread-"));
  store = new Store(join(dir, "db.sqlite"));
  apps = [];
});
afterEach(async () => {
  for (const a of apps) await a.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a Needs-you item's conversation", () => {
  it("keeps the operator's reply and FLIGHT's answer on the item", async () => {
    raise("hub-update-held", NOW - HOUR);
    const a = app();
    const sent = await say(a, `Re: ${KEY} · A new version\n\nwho is asking for this?`);
    expect(sent.statusCode).toBe(200);
    const mine = store.itemThread(KEY);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ from: COMMS_CAPCOM, to: "flight-1", itemKey: KEY });
    // the reply names only the message; it joins the same item
    const reply = await replies("flight-1", mine[0]?.id as string, "Nobody is asking.");
    expect(store.commsMessage(reply.id)?.itemKey).toBe(KEY);
    const thread = await read(a);
    expect(thread.messages.map((m) => [m.operator, m.text])).toEqual([
      [true, `Re: ${KEY} · A new version\n\nwho is asking for this?`],
      [false, "Nobody is asking."],
    ]);
    expect(thread.messages[0]?.state).toBe("answered");
    expect(thread.messages[1]?.state).toBeUndefined();
  });

  it("says whether the operator's message was taken and answered by its recipient", () => {
    const row = (over: Partial<CommsRow>): CommsRow =>
      ({
        id: "comms:1",
        at: NOW,
        from: COMMS_CAPCOM,
        to: "flight-1",
        text: "t",
        deliveredAt: null,
        ...over,
      }) as CommsRow;
    expect(itemThread([row({})]).messages[0]?.state).toBe("stored");
    expect(itemThread([row({ deliveredAt: NOW + 1 })]).messages[0]).toMatchObject({
      state: "delivered",
      deliveredAt: NOW + 1,
    });
    const taken = row({ deliveredAt: NOW + 1 });
    expect(itemThread([taken, row({ id: "comms:2", from: "flight-1" })]).messages[0]?.state).toBe(
      "answered",
    );
    // another seat writing in the thread is not the recipient's answer
    expect(
      itemThread([taken, row({ id: "comms:2", from: "guido-1", to: "flight-1" })]).messages[0]
        ?.state,
    ).toBe("delivered");
  });

  it("answers the seat's latest message there, so a question asked in it closes", async () => {
    raise("plain", NOW - HOUR, "Something is held.");
    const a = app();
    expect((await say(a, "Why?", "note:plain")).statusCode).toBe(200);
    const mine = store.itemThread("note:plain")[0]?.id as string;
    const asked = (await replies("flight-1", mine, "Do you want it gone?", "question")).id;
    expect(store.openCommsItems().some((m) => m.id === asked)).toBe(true);
    expect((await say(a, "Yes.", "note:plain")).statusCode).toBe(200);
    const answer = store.itemThread("note:plain").find((m) => m.text === "Yes.");
    expect(answer?.replyTo).toBe(asked);
    expect(store.openCommsItems().some((m) => m.id === asked)).toBe(false);
  });
});

describe("an option picked on a brief the choose route does not take", () => {
  /** An older brief: its options carry no id and it names no reader. */
  const OPTIONS = [
    { label: "5174", answer: "Use port 5174." },
    { label: "5180", answer: "Use port 5180." },
  ];
  const BRIEF_AT = NOW - HOUR;
  const briefOn = (key: string) =>
    store.addBrief({
      key,
      context: "The dev seat asks which port to preview on.",
      recommendation: "Use 5174.",
      options: OPTIONS,
      basis: "read config",
      at: BRIEF_AT,
    });
  const pick = (
    a: ReturnType<typeof app>,
    seat: string,
    itemKey: string,
    option: number,
    over: Record<string, unknown> = {},
  ) =>
    a.inject({
      method: "POST",
      url: `/api/seats/${seat}/message`,
      headers: HEADERS,
      payload: {
        text: OPTIONS[option]?.answer,
        itemKey,
        choice: { briefAt: BRIEF_AT, option },
        ...over,
      },
    });
  const conversation = async (a: ReturnType<typeof app>) =>
    (
      (await a.inject({ method: "GET", url: "/api/comms/flight", headers: HEADERS })).json() as {
        messages: { text: string; itemKey?: string; choice?: { label: string } }[];
      }
    ).messages;

  it("stores a seat question's pick with its message, so the FLIGHT conversation draws it once", async () => {
    const q = store.addQuestion({
      agentId: "guido-1",
      runId: "r-guido",
      text: "Which port?",
      at: NOW - 2 * HOUR,
    });
    const key = `ask:${q}`;
    briefOn(key);
    const a = app();
    // the page reads the item first: its options carry no id, so the choose route cannot take them
    const listed = (
      (await a.inject({ method: "GET", url: "/api/attention", headers: HEADERS })).json() as {
        key: string;
        brief?: { at: number; options: { id?: string; label: string }[] };
      }[]
    ).find((i) => i.key === key);
    expect(listed?.brief?.at).toBe(BRIEF_AT);
    expect(listed?.brief?.options.map((o) => [o.id, o.label])).toEqual([
      [undefined, "5174"],
      [undefined, "5180"],
    ]);
    expect((await conversation(a)).filter((m) => m.choice)).toEqual([]);

    expect((await pick(a, "guido-1", key, 0, { question: q })).statusCode).toBe(200);
    const picks = (await conversation(a)).filter((m) => m.choice);
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({ choice: { label: "5174" }, itemKey: key });
    // the seat still gets the answer as typed, and its question closes
    expect(store.itemThread(key).map((m) => [m.to, m.text])).toEqual([
      ["guido-1", "Use port 5174."],
    ]);
    expect(store.question(q)?.answeredAt).toBe(NOW);
    const receipt = (
      await a.inject({
        method: "GET",
        url: `/api/attention/${encodeURIComponent(key)}/choice`,
        headers: HEADERS,
      })
    ).json();
    expect(receipt).toMatchObject({ key, label: "5174", to: "guido-1", target: "seat" });
  });

  it("sends a pick once: a second pick on the same brief stores no second message", async () => {
    raise("plain", BRIEF_AT, "Something is held.");
    briefOn("note:plain");
    const a = app();
    expect((await pick(a, "flight-1", "note:plain", 1)).statusCode).toBe(200);
    expect((await pick(a, "flight-1", "note:plain", 0)).statusCode).toBe(200);
    expect(store.itemThread("note:plain").map((m) => m.text)).toEqual(["Use port 5180."]);
    const picks = (await conversation(a)).filter((m) => m.choice);
    expect(picks.map((m) => m.choice?.label)).toEqual(["5180"]);
    expect(store.latestChoice("note:plain")).toMatchObject({
      label: "5180",
      target: "flight-1",
      targetKind: "flight",
      chosenBy: "the operator",
    });
  });

  it("refuses a pick that is not the brief's option as shown, and stores nothing", async () => {
    raise("plain", BRIEF_AT, "Something is held.");
    briefOn("note:plain");
    const a = app();
    const refused = async (res: ReturnType<typeof pick>, status: number, error: string) => {
      const r = await res;
      expect(r.statusCode).toBe(status);
      expect(r.json()).toEqual({ error });
    };
    await refused(
      pick(a, "flight-1", "note:plain", 0, { text: "Use port 9999." }),
      400,
      "That is not one of the options.",
    );
    await refused(
      pick(a, "flight-1", "note:plain", 2, { text: "Use port 5174." }),
      400,
      "That is not one of the options.",
    );
    await refused(
      pick(a, "flight-1", "note:plain", 0, { choice: { briefAt: BRIEF_AT - 1, option: 0 } }),
      409,
      "The question changed since you opened it. Reload and choose again.",
    );
    await refused(pick(a, "flight-1", "note:gone", 0), 404, "That question is no longer open.");
    await refused(
      pick(a, "flight-1", "note:plain", 0, { itemKey: undefined }),
      400,
      "A picked option names its item.",
    );
    expect(store.itemThread("note:plain")).toEqual([]);
    expect(store.latestChoice("note:plain")).toBeNull();
    // the option is still open to pick
    expect((await pick(a, "flight-1", "note:plain", 0)).statusCode).toBe(200);
    expect(store.latestChoice("note:plain")?.label).toBe("5174");
  });
});

describe("who may pick with a message, and for which seat", () => {
  const OPTIONS = [
    { label: "5174", answer: "Use port 5174." },
    { label: "5180", answer: "Use port 5180." },
  ];
  const BRIEF_AT = NOW - HOUR;
  const briefOn = (key: string) =>
    store.addBrief({
      key,
      context: "The dev seat asks which port to preview on.",
      recommendation: "Use 5174.",
      options: OPTIONS,
      basis: "read config",
      at: BRIEF_AT,
    });
  const asks = (agentId: string) => {
    const q = store.addQuestion({
      agentId,
      runId: `r-${agentId}`,
      text: "Which port?",
      at: BRIEF_AT,
    });
    briefOn(`ask:${q}`);
    return q;
  };
  const post = (
    a: ReturnType<typeof app>,
    seat: string,
    payload: Record<string, unknown>,
    headers: Record<string, string> = HEADERS,
  ) => a.inject({ method: "POST", url: `/api/seats/${seat}/message`, headers, payload });
  const picking = (itemKey: string, more: Record<string, unknown> = {}) => ({
    text: "Use port 5174.",
    itemKey,
    choice: { briefAt: BRIEF_AT, option: 0 },
    ...more,
  });

  it("refuses FLIGHT's message that carries a pick, and still takes the same message without one", async () => {
    raise("plain", BRIEF_AT, "Something is held.");
    briefOn("note:plain");
    store.upsertRun({
      id: "flight-run",
      agentId: "flight-1",
      repoId: "mc",
      seq: 1,
      startedAt: NOW - HOUR,
      endedAt: null,
      status: "running",
      sessionId: null,
      model: null,
      branch: null,
      ticket: null,
      costUsd: null,
      tokens: null,
      transcriptPath: "/x",
      prs: [],
      summary: null,
    } as Run);
    const asFlight = {
      ...HEADERS,
      [FLIGHT_OPERATOR_ACTOR_HEADER]: JSON.stringify({ seatId: "flight-1", runId: "flight-run" }),
    };
    const a = app();
    const refused = await post(a, "guido-1", picking("note:plain"), asFlight);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({
      error: "FLIGHT cannot pick an option with a message. Send the text without `choice`.",
    });
    expect(store.latestChoice("note:plain")).toBeNull();
    expect(store.itemThread("note:plain")).toEqual([]);
    // the route stays open to FLIGHT for a message
    const plain = await post(
      a,
      "guido-1",
      { text: "Use port 5174.", itemKey: "note:plain" },
      asFlight,
    );
    expect(plain.statusCode).toBe(200);
    expect(store.itemThread("note:plain").map((m) => [m.from, m.text])).toEqual([
      ["flight-1", "Use port 5174."],
    ]);
    expect(store.latestChoice("note:plain")).toBeNull();
  });

  it("refuses a pick sent to a seat that did not ask, and one that does not name the seat's question", async () => {
    const q = asks("guido-1");
    const key = `ask:${q}`;
    const a = app();
    const refused = async (res: ReturnType<typeof post>, status: number, error: string) => {
      const r = await res;
      expect([r.statusCode, r.json()]).toEqual([status, { error }]);
    };
    // FLIGHT did not ask, and the seat that asked is in the crew
    await refused(post(a, "flight-1", picking(key)), 409, "That question belongs to another seat.");
    await refused(
      post(a, "guido-1", picking(key)),
      400,
      "A pick on a seat's question names that question.",
    );
    // a note is FLIGHT's to answer: a seat cannot be given its pick
    raise("plain", BRIEF_AT, "Something is held.");
    briefOn("note:plain");
    await refused(
      post(a, "guido-1", picking("note:plain")),
      409,
      "That question belongs to another seat.",
    );
    expect(store.question(q)?.answeredAt).toBeNull();
    expect(store.latestChoice(key)).toBeNull();
    expect(store.latestChoice("note:plain")).toBeNull();
    expect(store.itemThread(key)).toEqual([]);
    expect(store.itemThread("note:plain")).toEqual([]);
  });

  it("closes FLIGHT's own question with the pick, though the page names no question for FLIGHT", async () => {
    const q = asks("flight-1");
    const key = `ask:${q}`;
    const a = app();
    expect((await post(a, "flight-1", picking(key))).statusCode).toBe(200);
    expect(store.question(q)?.answeredAt).toBe(NOW);
    expect(store.latestChoice(key)).toMatchObject({ label: "5174", targetKind: "flight" });
  });
});

describe("a note raised again", () => {
  it("keeps its unbroken run's conversation, open or cleared, and drops an earlier run's", async () => {
    const a = app();
    // an earlier run, then a gap with no note
    const sent = (text: string, at: number) =>
      store.addComms({
        at,
        from: COMMS_CAPCOM,
        senderKind: "operator",
        to: "flight-1",
        ticket: null,
        text,
        itemKey: KEY,
      });
    raise("hub-update-held", NOW - 10 * HOUR, "old");
    sent("old run", NOW - 9.5 * HOUR);
    store.clearNote("hub-update-held", NOW - 9 * HOUR);
    raise("hub-update-held", NOW - 3 * HOUR);
    sent("this run", NOW - 2 * HOUR);
    // main moves: cleared and raised again at once with new words
    store.clearNote("hub-update-held", NOW - HOUR);
    raise("hub-update-held", NOW - HOUR, "newer");
    expect((await read(a)).messages.map((m) => m.text)).toEqual(["this run"]);
    // Update clears it: the item's last run still owns its conversation
    store.clearNote("hub-update-held", NOW);
    expect((await read(a)).messages.map((m) => m.text)).toEqual(["this run"]);
  });
});
