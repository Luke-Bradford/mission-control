import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { newRoomKey, wrapMemberKeys } from "../src/membership.ts";
import type { RelayMessage } from "../src/protocol.ts";
import type { RoomCore, RoomState } from "../src/relay-core.ts";
import type { createRelaySession, RelayPeer } from "../src/relay-session.ts";
import { readRoomKeys } from "../src/room-keys.ts";

const transport = vi.hoisted(() => ({
  mutate: (message: RelayMessage): RelayMessage => message,
  session: undefined as ReturnType<typeof createRelaySession> | undefined,
}));
vi.mock("ws", async () => {
  const { EventEmitter } = await import("node:events");
  class Socket extends EventEmitter {
    static OPEN = 1;
    readyState = 0;
    peer: RelayPeer;
    constructor() {
      super();
      this.peer = {
        send: (message) =>
          queueMicrotask(() =>
            this.emit(
              "message",
              Buffer.from(JSON.stringify(transport.mutate(structuredClone(message)))),
              false,
            ),
          ),
        close: () => this.close(),
      };
      queueMicrotask(() => {
        this.readyState = 1;
        transport.session?.connect(this.peer);
        this.emit("open");
      });
    }
    send(raw: string) {
      transport.session?.receive(this.peer, raw);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      transport.session?.disconnect(this.peer);
      this.emit("close");
    }
    terminate() {
      this.close();
    }
  }
  return { WebSocket: Socket, WebSocketServer: class {} };
});

import { runCli } from "../src/cli.ts";
import { loadIdentity } from "../src/keys.ts";
import { unwrapRoomKey } from "../src/membership.ts";
import { roomHttp, createRelaySession as sessionFor } from "../src/relay-session.ts";

let home: string;
afterEach(async () => {
  vi.unstubAllGlobals();
  if (home) await rm(home, { recursive: true, force: true });
  transport.session = undefined;
  transport.mutate = (message) => message;
});
it("runs human provisioning through the real core/session and wraps all recipients, including multiple agents", async () => {
  home = await mkdtemp(join(tmpdir(), "comms-cli-memory-"));
  let core: RoomCore | undefined;
  let saved: RoomState | undefined;
  const storage = {
    load: () => saved,
    save: (state: RoomState) => {
      saved = state;
    },
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const result = roomHttp({
        room: "room",
        createSecret: "test-secret",
        authorization: new Headers(init.headers).get("authorization") ?? undefined,
        tokens: input.endsWith("/tokens"),
        method: init.method ?? "GET",
        body: JSON.parse(String(init.body)),
        storage,
        core,
      });
      if (result.core) {
        core = result.core;
        transport.session = sessionFor("room", core);
      }
      return new Response(JSON.stringify(result.body), { status: result.status });
    }),
  );
  const a = join(home, "a");
  const b = join(home, "b");
  const cli = async (dir: string, ...args: string[]) => {
    const lines: string[] = [];
    await runCli(args, dir, (line) => {
      lines.push(line);
    });
    return lines.join("\n");
  };
  for (const [dir, label] of [
    [a, "Alice"],
    [b, "Bob"],
  ]) {
    await cli(dir, "init", "--member", label);
    await cli(dir, "agent", "add", "helper", "--subscription", label);
  }
  await cli(b, "agent", "add", "other", "--subscription", "Bob");
  await cli(a, "room", "create", "ws://memory", "room", "--create-secret", "test-secret");
  const invite = await cli(a, "invite", "room");
  // join only needs the public member directory, never its private key.
  const configB = JSON.parse(await readFile(join(b, "config.json"), "utf8"));
  await rm(join(b, "keys", `${configB.member.id}.json`));
  const bob = await cli(b, "join", invite);
  const initialKeys = await readRoomKeys(a, "room");
  for (const field of ["boxPublicKey", "label"] as const) {
    transport.mutate = (message) => {
      if (message.t === "pending")
        message.members[0][field] = field === "label" ? "fake label" : configB.member.signPublicKey;
      return message;
    };
    await expect(cli(a, "approve", "room", bob)).rejects.toThrow("Invalid member signature");
    expect(await readRoomKeys(a, "room")).toEqual(initialKeys);
  }
  const ownerRecord = JSON.parse(await readFile(join(a, "config.json"), "utf8")).member;
  const forged = await wrapMemberKeys(await newRoomKey(), 0, ownerRecord);
  transport.mutate = (message) =>
    message.t === "grants"
      ? { t: "grants", grants: forged.filter((g) => g.memberId === ownerRecord.id) }
      : message;
  await expect(cli(a, "approve", "room", bob)).rejects.toThrow("Invalid owner grant");
  expect(await readRoomKeys(a, "room")).toEqual(initialKeys);
  transport.mutate = (message) => message;
  await cli(a, "approve", "room", bob);
  expect(core?.members()).toHaveLength(2);
  if (!core) throw new Error("Missing core");
  for (const agent of configB.member.agents) {
    const identity = await loadIdentity(b, agent.id);
    const grants = core.grantsFor(agent.id);
    expect(grants).toHaveLength(1);
    expect(await unwrapRoomKey(grants[0], identity)).toHaveLength(32);
  }
  const configA = JSON.parse(await readFile(join(a, "config.json"), "utf8"));
  const ownerAgent = await loadIdentity(a, configA.member.agents[0].id);
  const oldKey = await unwrapRoomKey(core.grantsFor(ownerAgent.id)[0], ownerAgent);
  const beforeRemove = await readRoomKeys(a, "room");
  transport.mutate = (message) => {
    if (message.t === "directory") message.members[0].boxPublicKey = configB.member.boxPublicKey;
    return message;
  };
  await expect(cli(a, "remove", "room", bob)).rejects.toThrow("Invalid owner-signed directory");
  expect(await readRoomKeys(a, "room")).toEqual(beforeRemove);
  transport.mutate = (message) => message;
  await cli(a, "remove", "room", bob);
  expect(core?.members()).toHaveLength(1);
  expect(core?.grantsFor(configB.member.agents[0].id)).toEqual([]);
  const newKey = await unwrapRoomKey(core.grantsFor(ownerAgent.id)[1], ownerAgent);
  expect(newKey).not.toEqual(oldKey);
  expect(saved?.directory).toHaveLength(2);
});
