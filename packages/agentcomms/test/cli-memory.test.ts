import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RoomCore, RoomState } from "../src/relay-core.ts";
import type { createRelaySession, RelayPeer } from "../src/relay-session.ts";

const transport = vi.hoisted(() => ({
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
          queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify(message)), false)),
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
  await cli(a, "room", "create", "ws://memory", "room");
  const invite = await cli(a, "invite", "room");
  // join only needs the public member directory, never its private key.
  const configB = JSON.parse(await readFile(join(b, "config.json"), "utf8"));
  await rm(join(b, "keys", `${configB.member.id}.json`));
  const bob = await cli(b, "join", invite);
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
  await cli(a, "remove", "room", bob);
  expect(core?.members()).toHaveLength(1);
  expect(core?.grantsFor(configB.member.agents[0].id)).toEqual([]);
  const newKey = await unwrapRoomKey(core.grantsFor(ownerAgent.id)[1], ownerAgent);
  expect(newKey).not.toEqual(oldKey);
  expect(saved?.directory).toHaveLength(2);
});
