import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { startApi } from "./api.ts";
import { startDaemon } from "./daemon.ts";
import { delegate, loadIdentity, newIdentity, saveIdentity } from "./keys.ts";
import { readOptional, writePrivate } from "./local-files.ts";
import { runMcp } from "./mcp.ts";
import {
  decodeInvite,
  encodeInvite,
  type Invite,
  newRoomKey,
  rotate,
  unwrapRoomKey,
  wrapMemberKeys,
} from "./membership.ts";
import { memberSchema } from "./protocol.ts";
import { makeHello, relayControl, relayUrl } from "./relay-client.ts";
import { validateMember } from "./relay-core.ts";
import { startNodeRelay } from "./relay-node.ts";
import { readRoomKeys, saveRoomKeys } from "./room-keys.ts";

const configSchema = z.strictObject({
  member: memberSchema,
  github: z.string().optional(),
  rooms: z.array(z.strictObject({ relay: z.string(), room: z.string(), token: z.string() })),
});
type Config = z.infer<typeof configSchema>;
const defaultHome = () =>
  process.env.AGENTCOMMS_HOME ?? join(homedir(), ".local", "share", "agentcomms");
const usage =
  "Commands: init --member <label>; agent add <name> --subscription <label>; room create <relayUrl> <room>; invite <room>; join <code>; approve/remove <room> <memberId>; daemon [--agent <id>] [--answer <cmd>]; mcp; relay --port <n> --data <dir>";

async function waitForSignal(stop: () => Promise<void>): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.once("SIGINT", done);
    process.once("SIGTERM", done);
  });
  await stop();
}

export async function runCli(
  args: string[],
  home = defaultHome(),
  print: (text: string) => void = console.log,
): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      member: { type: "string" },
      github: { type: "string" },
      subscription: { type: "string" },
      answer: { type: "string" },
      agent: { type: "string" },
      port: { type: "string" },
      data: { type: "string" },
      help: { type: "boolean" },
    },
  });
  const [command, ...rest] = positionals;
  const required = (value: string | undefined, name: string): string => {
    if (!value?.trim()) throw new Error(`Missing ${name}`);
    return value;
  };
  const arity = (count: number) => {
    if (rest.length !== count) throw new Error(usage);
  };
  if (values.help || !command) {
    print(usage);
    return;
  }
  if (command === "mcp") {
    arity(0);
    await runMcp(home);
    return;
  }
  if (command === "relay") {
    arity(0);
    const port = Number(values.port ?? "7480");
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid port");
    const relay = await startNodeRelay({ port, dataDir: values.data ?? join(home, "relay") });
    print(relay.url);
    await waitForSignal(() => relay.close());
    return;
  }
  const path = join(home, "config.json");
  const raw = await readOptional(path);
  const save = (config: Config) => writePrivate(path, JSON.stringify(config));
  if (command === "init") {
    arity(0);
    if (raw !== undefined) throw new Error("Home is already initialized");
    const identity = await newIdentity("human", required(values.member, "--member"));
    await saveIdentity(home, identity);
    await save({
      member: {
        id: identity.id,
        kind: "human",
        label: identity.label,
        signPublicKey: identity.id,
        boxPublicKey: Buffer.from(identity.box.publicKey).toString("base64url"),
        agents: [],
      },
      github: values.github,
      rooms: [],
    });
    print(identity.id);
    return;
  }
  if (raw === undefined) throw new Error("Run agentcomms init first");
  const config = configSchema.parse(JSON.parse(raw));
  validateMember(config.member);
  // This helper is called only by the human-run setup commands below.
  const memberIdentity = async () => {
    const identity = await loadIdentity(home, config.member.id);
    if (identity.kind !== "human") throw new Error("Expected member identity");
    return identity;
  };
  const roomFor = (name: string): Invite => {
    const room = config.rooms.find((r) => r.room === name);
    if (!room) throw new Error("Unknown room");
    return room;
  };
  const addRoom = async (invite: Invite) => {
    if (config.rooms.some((r) => r.room === invite.room))
      throw new Error("Room already configured");
    config.rooms.push(invite);
    await save(config);
  };
  const http = async (url: string, method: string, body: unknown) => {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
      redirect: "error",
    });
    const result = (await response.json()) as { error?: string; token?: string };
    if (!response.ok) throw new Error(result.error ?? `Relay HTTP ${response.status}`);
    return result;
  };
  if (command === "agent" && rest[0] === "add") {
    arity(2);
    const name = required(rest[1], "agent name");
    const subscription = required(values.subscription, "--subscription");
    if (config.member.agents.some((a) => a.name === name && a.subscription === subscription))
      throw new Error("Agent already exists in this subscription");
    if (config.rooms.length)
      throw new Error(
        "Add agents before creating or joining rooms; updating an approved delegation is not supported in phase 1",
      );
    const member = await memberIdentity();
    const agent = await newIdentity("agent", name);
    const delegation = await delegate(member, agent, subscription, name);
    await saveIdentity(home, agent);
    config.member.agents.push({
      id: agent.id,
      name,
      subscription,
      signPublicKey: agent.id,
      boxPublicKey: Buffer.from(agent.box.publicKey).toString("base64url"),
      delegation,
    });
    await save(config);
    print(agent.id);
    return;
  }
  if (command === "room" && rest[0] === "create") {
    arity(3);
    const relay = required(rest[1], "relay URL");
    const room = required(rest[2], "room name");
    if (config.rooms.some((r) => r.room === room)) throw new Error("Room already configured");
    const owner = await memberIdentity();
    const key = await newRoomKey();
    const grants = await wrapMemberKeys(key, 0, config.member);
    await http(relayUrl(relay, room, true), "PUT", {
      owner: config.member,
      hello: await makeHello(room, owner),
      grants,
    });
    await saveRoomKeys(home, room, new Map([[0, key]]));
    await addRoom({ relay, room, token: "" });
    print(room);
    return;
  }
  if (command === "join") {
    arity(1);
    const invite = decodeInvite(rest[0]);
    if (config.rooms.some((r) => r.room === invite.room))
      throw new Error("Room already configured");
    const control = await relayControl(invite, {
      t: "join",
      token: invite.token,
      member: config.member,
    });
    control.close();
    await addRoom(invite);
    print(config.member.id);
    return;
  }
  if (command === "invite") {
    arity(1);
    const room = roomFor(rest[0]);
    const identity = await memberIdentity();
    const result = await http(
      `${relayUrl(room.relay, room.room, true)}/tokens`,
      "POST",
      await makeHello(room.room, identity),
    );
    print(encodeInvite({ ...room, token: required(result.token, "invite token") }));
    return;
  }
  if (command === "approve" || command === "remove") {
    arity(2);
    const room = roomFor(rest[0]);
    const identity = await memberIdentity();
    const control = await relayControl(room, await makeHello(room.room, identity));
    try {
      const directory = control.directory;
      if (!directory) throw new Error("Missing room directory");
      if (directory.activeMemberIds[0] !== identity.id) throw new Error("Owner only");
      const keys = await readRoomKeys(home, room.room);
      for (const grant of control.grants)
        keys.set(grant.keyEpoch, await unwrapRoomKey(grant, identity));
      const memberId = rest[1];
      if (command === "approve") {
        const member = control.pending.find((m) => m.id === memberId);
        if (!member) throw new Error("Unknown pending member");
        const key = keys.get(directory.keyEpoch);
        if (!key) throw new Error("Current room key unavailable");
        await control.change({
          t: "approve",
          memberId,
          grants: await wrapMemberKeys(key, directory.keyEpoch, member),
        });
      } else {
        const members = directory.members.filter((m) => directory.activeMemberIds.includes(m.id));
        const rotation = await rotate(members, memberId, directory.keyEpoch + 1);
        await control.change({ t: "remove", memberId, grants: rotation.grants });
        keys.set(directory.keyEpoch + 1, rotation.roomKey);
      }
      await saveRoomKeys(home, room.room, keys);
      print(`${command === "approve" ? "Approved" : "Removed"} ${memberId}`);
    } finally {
      control.close();
    }
    return;
  }
  if (command === "daemon") {
    arity(0);
    const entry = values.agent
      ? config.member.agents.find((a) => a.id === values.agent)
      : config.member.agents.length === 1
        ? config.member.agents[0]
        : undefined;
    if (!entry) throw new Error("Choose one registered agent with --agent <id>");
    const agent = await loadIdentity(home, entry.id);
    if (agent.kind !== "agent") throw new Error("Expected agent identity");
    const daemon = await startDaemon({
      home,
      agent,
      delegation: entry.delegation,
      member: config.member,
      rooms: config.rooms.map((invite) => ({ invite })),
      answer: values.answer,
    });
    try {
      const api = await startApi({ home, daemon });
      print(api.url);
      try {
        await waitForSignal(() => api.stop());
      } finally {
        await daemon.stop();
      }
    } catch (error) {
      await daemon.stop();
      throw error;
    }
    return;
  }
  throw new Error(usage);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
