import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { COMMS_CAPCOM, COMMS_CREW, COMMS_NOTICE } from "@mc/core";
import { expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const seat = (id: string, role: string) => ({
  id,
  role,
  accountId: "demo",
  model: "opus",
  area: [],
});

type Page = {
  messages: { text: string; kind?: string | null }[];
  inbox: { text: string }[];
  unread: number;
  hasEarlier?: boolean;
};

it("a hub message is a notice; notices are never unread and ?notices=hide leaves them out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-comms-notice-"));
  const store = new Store(join(dir, "db.sqlite"));
  const config: CcConfig = {
    operator: { id: "operator", timezone: "UTC" },
    accounts: [],
    repos: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    loops: [],
    crew: {
      worktrees: join(dir, "worktrees"),
      maxSeats: 3,
      sessions: [
        {
          id: "demo",
          repoId: "demo",
          checkout: join(dir, "checkout"),
          seats: [seat("guido-1", "GUIDO"), seat("retro-1", "RETRO"), seat("flight-1", "FLIGHT")],
        },
      ],
    },
  };
  store.addComms({ from: "retro-1", to: "guido-1", text: "a finding", at: 1, ticket: null });
  const hub = store.addComms({
    from: "MC",
    senderKind: "hub",
    to: "guido-1",
    text: "CI failed on 341f108 in job web-core.",
    at: 2,
    ticket: null,
  });
  expect(hub?.kind).toBe(COMMS_NOTICE);
  // only the hub writes notices: a seat's message has no kind
  expect(store.commsForAgent("guido-1")[0]?.kind).toBeNull();
  store.addComms({
    from: "MC",
    senderKind: "hub",
    to: COMMS_CREW,
    text: "old crew notice",
    at: 1,
    ticket: null,
  });
  store.addComms({
    from: "retro-1",
    to: COMMS_CREW,
    text: "current crew message",
    at: 100_000_000,
    ticket: null,
  });
  store.addComms({
    from: COMMS_CAPCOM,
    to: "flight-1",
    text: "operator request",
    at: 1,
    ticket: null,
  });
  store.addComms({
    from: "flight-1",
    kind: COMMS_NOTICE,
    to: COMMS_CAPCOM,
    text: "flight notice",
    at: 2,
    ticket: null,
  });
  const app = buildApp({ config, store, bus: new ChangeBus(), now: () => 100_000_000 });
  try {
    const get = async (url: string) => {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(200);
      return res.json() as Page;
    };
    const all = await get("/api/comms/agents/guido-1");
    expect(all.messages.map((m) => m.kind ?? null)).toEqual([null, COMMS_NOTICE]);
    // two messages after the cursor, one of them a notice: one unread
    expect(all.unread).toBe(1);
    const shown = await get("/api/comms/agents/guido-1?notices=hide");
    expect(shown.messages.map((m) => m.text)).toEqual(["a finding"]);
    expect(shown.unread).toBe(1);
    expect(shown.inbox.map((m) => m.text)).toEqual(["a finding"]);
    expect((await get("/api/comms/crew?notices=hide")).hasEarlier).toBeUndefined();
    expect(
      (await get("/api/comms/crew?history=1&notices=hide")).messages.map((m) => m.text),
    ).toEqual(["current crew message"]);
    expect((await get("/api/comms/flight?notices=hide")).messages.map((m) => m.text)).toEqual([
      "operator request",
    ]);
    // the hub's conversation holds only notices: it leaves the contact list too
    const contacts = (page: unknown) => (page as { contacts: { id: string }[] }).contacts;
    expect(contacts(all).map((c) => c.id)).toContain("MC");
    expect(contacts(shown).map((c) => c.id)).not.toContain("MC");
    expect((await app.inject({ url: "/api/comms/agents/guido-1?notices=no" })).statusCode).toBe(
      400,
    );
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("classifies retained hub rows as notices on reopen without changing seat rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-notice-upgrade-"));
  const path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    store.addComms({
      from: "MC",
      senderKind: "hub",
      to: "guido-1",
      text: "old notice",
      at: 1,
      ticket: null,
    });
    store.addComms({ from: "retro-1", to: "guido-1", text: "seat message", at: 2, ticket: null });
    store.close();
    const old = new DatabaseSync(path);
    old.prepare("UPDATE comms SET kind = NULL").run();
    old.close();
    store = new Store(path);
    expect(store.commsPage({ agent: "guido-1" }, 10).rows.map((m) => m.kind)).toEqual([
      COMMS_NOTICE,
      null,
    ]);
    expect(
      store.commsPage({ agent: "guido-1" }, 10, undefined, undefined, true).rows.map((m) => m.text),
    ).toEqual(["seat message"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
