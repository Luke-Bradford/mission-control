import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import type { Supervisor } from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";

const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/example",
    maxSeats: 1,
    sessions: [
      {
        id: "demo",
        repoId: "demo",
        checkout: "/example",
        seats: [{ id: "flight", role: "FLIGHT", accountId: "demo", model: "opus", area: [] }],
      },
    ],
  },
};
let dir: string;
let store: Store;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-discussion-"));
  store = new Store(join(dir, "mc.sqlite"));
  store.raiseNote({
    key: "blocked:demo",
    kind: "blocked",
    runId: null,
    seatId: null,
    repoId: null,
    text: "Choose a route",
    at: 1,
  });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it("opens stable threads, refuses stale versions and keeps ended threads readable", async () => {
  const app = buildApp({ config, store, bus: new ChangeBus() });
  const key = "note:blocked:demo";
  const url = `/api/attention/${key}/discussion`;
  const first = (await app.inject(url)).json();
  expect(first.id).toEqual(expect.any(String));
  expect((await app.inject(url)).json()).toEqual(first);
  const post = (payload: Record<string, string>) => app.inject({ method: "POST", url, payload });
  expect((await post({ version: "old", messageId: "ask", text: "Why?" })).statusCode).toBe(409);
  store.dismissNote("blocked:demo", 2);
  expect((await post({ version: first.version, messageId: "ask", text: "Why?" })).statusCode).toBe(
    409,
  );
  expect((await app.inject(`${url}?id=${first.id}`)).json()).toEqual(first);
  expect((await app.inject(url)).statusCode).toBe(404);
  await app.close();
});

it("retries failed sends once and does not resend a successful message", async () => {
  const message = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(undefined);
  const supervisor = {
    status: () => ({ enabled: true, note: null }),
    message,
  } as unknown as Supervisor;
  const app = buildApp({ config, store, bus: new ChangeBus(), supervisor });
  const url = "/api/attention/note:blocked:demo/discussion";
  const first = (await app.inject(url)).json();
  const payload = { version: first.version, messageId: "ask", text: "Why?" };
  const send = () => app.inject({ method: "POST", url, payload });
  expect((await send()).statusCode).toBe(503);
  expect((await send()).statusCode).toBe(200);
  expect((await send()).statusCode).toBe(200);
  expect(message).toHaveBeenCalledTimes(2);
  expect((await app.inject(url)).json().messages).toHaveLength(2);
  expect(
    (await app.inject({ method: "POST", url, payload: { ...payload, text: "Different" } }))
      .statusCode,
  ).toBe(409);
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        headers: { origin: "https://example.invalid" },
        payload,
      })
    ).statusCode,
  ).toBe(403);
  await app.close();
});

it("opens with the catalogue recommendation and replaces a changed brief", async () => {
  const key = "note:blocked:demo";
  const brief = {
    key,
    context: "Choose the scope",
    recommendation: "The rules are scoped",
    checked: [{ source: "Code", finding: "Rules have a scope key" }],
    options: [
      { id: "scoped", label: "Per customer", description: "Reuse the scope key", answer: "scope" },
      { id: "shared", label: "Shared", answer: "shared" },
    ],
    recommendedOptionId: "scoped",
    basis: "Read the code",
    at: 2,
  };
  store.addBrief(brief);
  const app = buildApp({ config, store, bus: new ChangeBus() });
  const url = `/api/attention/${key}/discussion`;
  const first = (await app.inject(url)).json();
  expect(first.messages[0]?.text).toBe(
    'Short version: The rules are scoped I lean towards "Per customer": Reuse the scope key. What would help you decide? I can pull the Teams thread or the code.',
  );
  store.addBrief({ ...brief, context: "Updated scope", at: 3 });
  const next = (await app.inject(url)).json();
  expect(next.id).not.toBe(first.id);
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        payload: { version: first.version, messageId: "old", text: "scope", optionId: "scoped" },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await app.inject({
        method: "POST",
        url,
        payload: { version: first.version, messageId: "old", text: "Why?" },
      })
    ).statusCode,
  ).toBe(409);
  expect((await app.inject(`${url}?id=${first.id}`)).json()).toEqual(first);
  await app.close();
});
