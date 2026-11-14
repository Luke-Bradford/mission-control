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
    const child = () => items().find((i) => i.key.endsWith(asked.slice("comms:".length)));
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
