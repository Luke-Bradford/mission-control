import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import type { Message } from "../src/envelope.ts";
import { createRoomCore } from "../src/relay-core.ts";
import { startNodeRelay } from "../src/relay-node.ts";
import { fixture } from "./relay-fixtures.ts";

export const draft = (body = "Hello"): Omit<Message, "id" | "sentAt" | "auto"> => ({
  room: "test-room",
  thread: "thread",
  kind: "fyi",
  body,
});
export async function daemonFixture(home: string, answer?: string) {
  const f = await fixture();
  const dataDir = join(home, "relay");
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, `${createHash("sha256").update("test-room").digest("hex")}.json`);
  let saved = "";
  const core = createRoomCore({
    room: "test-room",
    owner: f.a.member,
    directory: f.directory,
    now: Date.now,
    storage: {
      load: () => undefined,
      save: (state) => {
        saved = JSON.stringify(state);
      },
    },
  });
  const token = core.issueToken(f.a.identity.id);
  core.requestJoin(token, f.b.member);
  core.approve(
    f.a.identity.id,
    f.b.identity.id,
    await f.grants(f.key, 0, f.b.member),
    f.nextDirectory(core),
  );
  await writeFile(path, saved);
  const relay = await startNodeRelay({ port: 0, dataDir });
  const daemons: Daemon[] = [];
  try {
    for (const [name, person] of [
      ["a", f.a],
      ["b", f.b],
    ] as const) {
      daemons.push(
        await startDaemon({
          home: join(home, name),
          agent: person.agent,
          delegation: person.delegation,
          member: person.member,
          answer,
          rooms: [
            {
              invite: { ownerId: f.a.identity.id, relay: relay.url, room: "test-room", token },
              roomKey: f.key,
            },
          ],
        }),
      );
    }
  } catch (error) {
    await Promise.all(daemons.map((d) => d.stop()));
    await relay.close();
    throw error;
  }
  await expect.poll(() => daemons.every((d) => d.rooms()[0].status === "connected")).toBe(true);
  return {
    ...f,
    aDaemon: daemons[0],
    bDaemon: daemons[1],
    relay,
    dataDir,
    async stop() {
      await Promise.all(daemons.map((d) => d.stop()));
      await relay.close();
    },
  };
}
