import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMS_CAPCOM, type ItemThread, OPERATOR_HEADER } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { sendComms } from "../src/comms/index.ts";
import type { CcConfig } from "../src/config.ts";
import { attentionItems } from "../src/hud.ts";
import { itemThread } from "../src/item-thread.ts";
import type { Supervisor } from "../src/runtime/supervisor.ts";
import type { CommsRow } from "../src/store/types.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-13T18:00:00Z");
const HEADERS = { [OPERATOR_HEADER]: "test-token" };
const KEY = "note:hub-update-held";
let dir: string;
let store: Store;

const config = (powers: "standard" | "superuser" = "standard"): CcConfig => ({
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [
    {
      id: "mc",
      github: "o/mc",
      project: 1,
      statusMap: {},
      autonomy: "merge",
      flightPowers: powers,
    },
  ],
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

const app = () =>
  buildApp({
    config: config(),
    store,
    bus: new ChangeBus(),
    operatorToken: "test-token",
    supervisor,
    knownSecrets: async () => [],
    now: () => NOW,
  });

/** FLIGHT answers a message through Comms, as its comms tool does. */
const flightReplies = (replyTo: string, text: string, label?: "question") =>
  sendComms(
    {
      store,
      crew: () => ["guido-1", "flight-1"],
      knownSecrets: async () => [],
      now: () => NOW + 180_000,
      senderKind: "flight",
    },
    "flight-1",
    { to: COMMS_CAPCOM, text, replyTo, ...(label ? { label } : {}) },
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-item-thread-"));
  store = new Store(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("a Needs-you item's conversation", () => {
  it("keeps the operator's reply and FLIGHT's answer on the item", async () => {
    const a = app();
    const sent = await a.inject({
      method: "POST",
      url: "/api/seats/flight-1/message",
      headers: HEADERS,
      payload: { text: `Re: ${KEY} · A new version\n\nwho is asking for this?`, itemKey: KEY },
    });
    expect(sent.statusCode).toBe(200);
    const mine = store.itemThread(KEY);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ from: COMMS_CAPCOM, to: "flight-1", itemKey: KEY });
    // the reply names only the message; it joins the same item
    const reply = await flightReplies(mine[0]?.id as string, "Nobody is asking.");
    expect(store.commsMessage(reply.id)?.itemKey).toBe(KEY);
    const res = await a.inject({
      method: "GET",
      url: `/api/attention/${encodeURIComponent(KEY)}/thread`,
      headers: HEADERS,
    });
    const thread = res.json() as ItemThread;
    expect(thread.messages.map((m) => [m.operator, m.text])).toEqual([
      [true, `Re: ${KEY} · A new version\n\nwho is asking for this?`],
      [false, "Nobody is asking."],
    ]);
    expect(thread.messages[0]?.state).toBe("answered");
    expect(thread.messages[1]?.state).toBeUndefined();
  });

  it("says whether the operator's message was taken and answered", () => {
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
    expect(
      itemThread([row({ deliveredAt: NOW + 1 }), row({ id: "comms:2", from: "flight-1" })])
        .messages[0]?.state,
    ).toBe("answered");
  });

  it("shows FLIGHT's question in the item's conversation, not as a second item", async () => {
    const asked = await askInsideItem();
    const items = () => attentionItems(config(), store, NOW + 600_000);
    const parent = () => items().find((i) => i.key === "note:plain");
    const child = () =>
      items().find((i) => i.key === `comms-open:${asked}` || i.key === `tag:${asked}`);
    expect(parent()).toBeDefined();
    expect(child()).toBeUndefined();
    // the item it belongs to has gone: the question stands on its own again
    store.clearNote("plain", NOW + 1);
    expect(parent()).toBeUndefined();
    expect(child()).toBeDefined();
  });
});

/** An operator note, a reply from it, and FLIGHT's question back; returns the question's id. */
async function askInsideItem(): Promise<string> {
  store.raiseNote({
    key: "plain",
    kind: "blocked",
    runId: null,
    seatId: null,
    repoId: "mc",
    text: "Something is held.",
    at: NOW - 60_000,
  });
  const res = await app().inject({
    method: "POST",
    url: "/api/seats/flight-1/message",
    headers: HEADERS,
    payload: { text: "Why?", itemKey: "note:plain" },
  });
  expect(res.statusCode).toBe(200);
  const mine = store.itemThread("note:plain")[0]?.id as string;
  const q = await flightReplies(mine, "Do you want it gone?", "question");
  return q.id;
}

/** FLIGHT running a turn, so it triages. */
function flightLive(): void {
  store.upsertRun({
    id: "r-flight",
    agentId: "flight-1",
    repoId: "mc",
    seq: 1,
    startedAt: NOW - 60_000,
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
  } as unknown as Parameters<Store["upsertRun"]>[0]);
  store.setSeatSession({
    seatId: "flight-1",
    runId: "r-flight",
    cliSessionId: null,
    state: "idle",
    reason: null,
    worktree: null,
    updatedAt: NOW - 60_000,
  } as unknown as Parameters<Store["setSeatSession"]>[0]);
}

const raiseHeld = (at = NOW - 60_000) =>
  store.raiseNote({
    key: "hub-update-held",
    kind: "blocked",
    runId: null,
    seatId: null,
    repoId: null,
    text: "A new version is waiting.",
    at,
  });

describe("a held Update", () => {
  const owner = (powers: "standard" | "superuser", at = NOW) => {
    return attentionItems(config(powers), store, at).find((x) => x.key === KEY)?.owner;
  };

  it("is FLIGHT's while FLIGHT triages with superuser powers", () => {
    flightLive();
    raiseHeld();
    expect(owner("superuser")).toBe("flight");
  });

  it("stays the operator's when FLIGHT may not run Update", () => {
    flightLive();
    raiseHeld();
    // FLIGHT has its triage window, then the operator has it as an alert
    expect(owner("standard", NOW + 3_600_000)).toBe("operator");
  });

  it("stays the operator's while FLIGHT is stopped", () => {
    raiseHeld();
    expect(owner("superuser", NOW + 3_600_000)).toBe("operator");
  });
});

describe("a note raised again", () => {
  it("keeps the conversation of its unbroken run, and drops an earlier run's", async () => {
    raiseHeld(NOW - 3 * 3_600_000);
    const a = app();
    const say = (text: string) =>
      a.inject({
        method: "POST",
        url: "/api/seats/flight-1/message",
        headers: HEADERS,
        payload: { text, itemKey: KEY },
      });
    // an earlier run of the note, then a two-hour gap with no note
    store.raiseNote({
      key: "hub-update-held",
      kind: "blocked",
      runId: null,
      seatId: null,
      repoId: null,
      text: "old",
      at: NOW - 10 * 3_600_000,
    });
    store.clearNote("hub-update-held", NOW - 9 * 3_600_000);
    store.addComms({
      at: NOW - 9.5 * 3_600_000,
      from: COMMS_CAPCOM,
      senderKind: "operator",
      to: "flight-1",
      ticket: null,
      text: "last week's question",
      itemKey: KEY,
    });
    raiseHeld(NOW - 3 * 3_600_000);
    expect((await say("this run's question")).statusCode).toBe(200);
    // main moves: the note is cleared and raised again at once with new words
    store.clearNote("hub-update-held", NOW - 60_000);
    raiseHeld(NOW - 60_000);
    const thread = (
      await a.inject({
        method: "GET",
        url: `/api/attention/${encodeURIComponent(KEY)}/thread`,
        headers: HEADERS,
      })
    ).json() as ItemThread;
    expect(thread.messages.map((m) => m.text)).toEqual(["this run's question"]);
  });
});

describe("answering inside the item", () => {
  it("closes the question FLIGHT asked in that conversation", async () => {
    const asked = await askInsideItem();
    const res = await app().inject({
      method: "POST",
      url: "/api/seats/flight-1/message",
      headers: HEADERS,
      payload: { text: "Yes.", itemKey: "note:plain" },
    });
    expect(res.statusCode).toBe(200);
    const mine = store.itemThread("note:plain").find((m) => m.text === "Yes.");
    expect(mine?.replyTo).toBe(asked);
    store.clearNote("plain", NOW + 1);
    const keys = attentionItems(config(), store, NOW + 600_000).map((i) => i.key);
    expect(keys).not.toContain(`comms-open:${asked}`);
    expect(keys).not.toContain(`tag:${asked}`);
  });

  it("keeps a seat's blocker to FLIGHT as its own item, though it is in the item's conversation", async () => {
    store.raiseNote({
      key: "other",
      kind: "blocked",
      runId: null,
      seatId: null,
      repoId: "mc",
      text: "Held.",
      at: NOW - 60_000,
    });
    const res = await app().inject({
      method: "POST",
      url: "/api/seats/guido-1/message",
      headers: HEADERS,
      payload: { text: "Why?", itemKey: "note:other" },
    });
    expect(res.statusCode).toBe(200);
    const mine = store.itemThread("note:other")[0]?.id as string;
    const blocker = await sendComms(
      {
        store,
        crew: () => ["guido-1", "flight-1"],
        knownSecrets: async () => [],
        now: () => NOW,
        senderKind: "seat",
      },
      "guido-1",
      { to: "flight-1", text: "I am stuck on this.", label: "blocker", replyTo: mine },
    );
    const all = attentionItems(config(), store, NOW + 3_600_000);
    const parent = all.find((i) => i.key === "note:other");
    const child = all.find((i) => i.key.endsWith(`:${blocker.id}`));
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
  });
});
