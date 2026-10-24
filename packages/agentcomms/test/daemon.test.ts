import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { BODY_MAX, BodyTooLarge } from "../src/envelope.ts";
import { daemonFixture, draft } from "./daemon-fixtures.ts";

let home: string;
let f: Awaited<ReturnType<typeof daemonFixture>> | undefined;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "comms-daemon-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await f?.stop();
  f = undefined;
  await rm(home, { recursive: true, force: true });
});
it("delivers verified, decrypted messages and merges an open duplicate", async () => {
  f = await daemonFixture(home);
  expect(
    await f.aDaemon.send("test-room", { ...draft("Is #506 yours?"), kind: "question" }),
  ).toEqual({ seq: 1 });
  await expect.poll(() => f?.bDaemon.read("test-room").length).toBe(1);
  expect(f.bDaemon.read("test-room")[0]).toMatchObject({
    seq: 1,
    msg: { body: "Is #506 yours?" },
    sender: { id: f.a.agent.id, kind: "agent", delegation: f.a.delegation },
  });
  expect(
    await f.aDaemon.send("test-room", { ...draft("is   #506 YOURS?"), kind: "question" }),
  ).toEqual({ merged: "thread" });
});
it("holds secrets and refuses oversized UTF-8 bodies without transmitting anything", async () => {
  f = await daemonFixture(home);
  const send = vi.spyOn(WebSocket.prototype, "send");
  expect(await f.aDaemon.send("test-room", draft(`ghp_${"a".repeat(36)}`))).toHaveProperty("held");
  await expect(f.aDaemon.send("test-room", draft("a".repeat(BODY_MAX + 1)))).rejects.toBeInstanceOf(
    BodyTooLarge,
  );
  await expect(f.aDaemon.send("test-room", draft("😀".repeat(8001)))).rejects.toBeInstanceOf(
    BodyTooLarge,
  );
  expect(send.mock.calls.filter(([raw]) => JSON.parse(String(raw)).t === "post")).toHaveLength(0);
  expect(f.bDaemon.read("test-room")).toEqual([]);
});
it("answers once automatically with hooks on both sides", async () => {
  f = await daemonFixture(home, "cat >/dev/null; echo ok");
  await f.aDaemon.send("test-room", { ...draft("Bob-agent, is this yours?"), kind: "question" });
  await expect.poll(() => f?.aDaemon.read("test-room").length).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const messages = f.aDaemon.read("test-room");
  expect(messages).toHaveLength(2);
  expect(messages[1].msg).toMatchObject({
    kind: "answer",
    body: "ok",
    auto: true,
    inReplyTo: messages[0].msg?.id,
  });
});
it("resumes every sequence exactly once after B's socket is killed mid-stream", async () => {
  const sockets: WebSocket[] = [];
  const original = WebSocket.prototype.send;
  vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
    this: WebSocket,
    ...args: Parameters<typeof original>
  ) {
    if (JSON.parse(String(args[0])).t === "hello") sockets.push(this);
    return original.apply(this, args);
  });
  f = await daemonFixture(home);
  await f.aDaemon.send("test-room", draft("one"));
  await expect.poll(() => f?.bDaemon.read("test-room").length).toBe(1);
  sockets[1].terminate();
  await f.aDaemon.send("test-room", draft("two"));
  await f.aDaemon.send("test-room", draft("three"));
  await expect
    .poll(() => f?.bDaemon.read("test-room").map((entry) => entry.seq), { timeout: 5000 })
    .toEqual([1, 2, 3]);
});
