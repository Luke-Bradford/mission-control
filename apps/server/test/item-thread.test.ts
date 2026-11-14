import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMS_CAPCOM, type ItemThread, OPERATOR_HEADER } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { sendComms } from "../src/comms/index.ts";
import type { CcConfig } from "../src/config.ts";
import { itemThread } from "../src/item-thread.ts";
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
