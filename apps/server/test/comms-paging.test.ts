import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type Msg = { id: string; text: string };
type Page = { messages: Msg[]; hasMore: boolean; unread: number; count?: number };

it("pages Comms: the conversation list first, newest 50 per conversation, older on request", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mc-comms-page-"));
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
          seats: [seat("guido-1", "GUIDO"), seat("retro-1", "RETRO"), seat("inco-1", "INCO")],
        },
      ],
    },
  };
  for (let i = 1; i <= 120; i++)
    store.addComms({ from: "guido-1", to: "retro-1", text: `peer ${i}`, at: i, ticket: null });
  store.addComms({ from: "guido-1", to: "inco-1", text: "hello inco", at: 500, ticket: null });
  const app = buildApp({ config, store, bus: new ChangeBus() });
  const get = async <T>(url: string) => {
    const res = await app.inject({ url });
    expect(res.statusCode).toBe(200);
    return res.json() as T;
  };
  try {
    const agent = await get<
      Page & {
        inbox: Msg[];
        contacts: { id: string; count: number; unread: number; lastMessage: Msg | null }[];
      }
    >("/api/comms/agents/guido-1");
    expect(agent.messages).toHaveLength(50);
    expect(agent.messages.at(-1)?.text).toBe("hello inco");
    expect(agent.hasMore).toBe(true);
    expect(agent.unread).toBe(121);
    const retro = agent.contacts.find((c) => c.id === "retro-1");
    expect(retro).toMatchObject({ count: 120, unread: 120 });
    expect(retro?.lastMessage?.text).toBe("peer 120");

    const contact = await get<Page>("/api/comms/agents/guido-1/contacts/retro-1");
    expect(contact.messages.map((m) => m.text)).toEqual(
      Array.from({ length: 50 }, (_, i) => `peer ${71 + i}`),
    );
    expect(contact.hasMore).toBe(true);
    expect(contact.unread).toBe(120);

    const older = await get<Page>(
      `/api/comms/agents/guido-1/contacts/retro-1?limit=50&before=${contact.messages[0]?.id}`,
    );
    expect(older.messages.map((m) => m.text)[0]).toBe("peer 21");
    expect(older.messages).toHaveLength(50);
    const oldest = await get<Page>(
      `/api/comms/agents/guido-1/contacts/retro-1?before=${older.messages[0]?.id}`,
    );
    expect(oldest.messages.map((m) => m.text)).toEqual(
      Array.from({ length: 20 }, (_, i) => `peer ${1 + i}`),
    );
    expect(oldest.hasMore).toBe(false);

    const bad = await app.inject({ url: "/api/comms/agents/guido-1?limit=0" });
    expect(bad.statusCode).toBe(400);
  } finally {
    await app.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
