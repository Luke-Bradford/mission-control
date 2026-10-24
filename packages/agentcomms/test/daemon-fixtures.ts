import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Daemon, startDaemon } from "../src/daemon.ts";
import type { Message } from "../src/envelope.ts";
import { wrapMemberKeys } from "../src/membership.ts";
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
  core.approve(f.a.identity.id, f.b.identity.id, await wrapMemberKeys(f.key, 0, f.b.member));
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
          rooms: [{ invite: { relay: relay.url, room: "test-room", token }, roomKey: f.key }],
        }),
      );
    }
  } catch (error) {
    await Promise.all(daemons.map((d) => d.stop()));
    await relay.close();
    throw error;
  }
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
