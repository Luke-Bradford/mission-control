import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMS_NOTICE } from "@mc/core";
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

type Page = { messages: { text: string; kind?: string | null }[]; unread: number };

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
          seats: [seat("guido-1", "GUIDO"), seat("retro-1", "RETRO")],
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
  const app = buildApp({ config, store, bus: new ChangeBus() });
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
