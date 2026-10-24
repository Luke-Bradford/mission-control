import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { z } from "zod";
import { startApi } from "./api.ts";
import { controlPayload, sign, signDirectory, signGrant, signMember, verifyGrant } from "./auth.ts";
import { startDaemon } from "./daemon.ts";
import { delegate, loadIdentity, newIdentity, saveIdentity } from "./keys.ts";
import { readOptional, writePrivate } from "./local-files.ts";
import { runMcp } from "./mcp.ts";
import {
  decodeInvite,
  encodeInvite,
  type Invite,
  type KeyGrant,
  newRoomKey,
  rotate,
  unwrapRoomKey,
  wrapMemberKeys,
} from "./membership.ts";
import { memberSchema } from "./protocol.ts";
import { relayControl, relayUrl } from "./relay-client.ts";
import { validateMember } from "./relay-core.ts";
import { startNodeRelay } from "./relay-node.ts";
import { readRoomKeys, saveRoomKeys } from "./room-keys.ts";
import { acceptDirectory, readTrust } from "./trust.ts";

const configSchema = z.strictObject({
  member: memberSchema,
  github: z.string().optional(),
  rooms: z.array(
    z.strictObject({ ownerId: z.string(), relay: z.string(), room: z.string(), token: z.string() }),
  ),
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

// Every option is long (`--name`), so an argument with one leading dash is never an option. Member and agent
// ids are 43-character base64url keys and can start with "-" (about one in 64) or "--" (one in 4096);
// parseArgs would refuse them, so both shapes are masked as positionals before parsing.
const SINGLE_DASH = /^-[^-]/;
const KEY_ID = /^[A-Za-z0-9_-]{43}$/;

/** parseArgs over long options only; does not support `multiple` options. */
export function parseCliArgs<const O extends ParseArgsOptionsConfig>(args: string[], options: O) {
  const masks = new Map<string, string>();
  const masked = args.map((arg, i) => {
    if (!SINGLE_DASH.test(arg) && !(arg.startsWith("--") && KEY_ID.test(arg))) return arg;
    const token = `\u0000${i}`;
    masks.set(token, arg);
    return token;
  });
  const restore = (arg: string): string => masks.get(arg) ?? arg;
  const { values, positionals } = parseArgs({ args: masked, allowPositionals: true, options });
  return {
    values: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, typeof v === "string" ? restore(v) : v]),
    ) as typeof values,
    positionals: positionals.map(restore),
  };
}

export async function runCli(
  args: string[],
  home = defaultHome(),
  print: (text: string) => void = console.log,
): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    member: { type: "string" },
    github: { type: "string" },
    subscription: { type: "string" },
    answer: { type: "string" },
    agent: { type: "string" },
    port: { type: "string" },
    data: { type: "string" },
    help: { type: "boolean" },
    "create-secret": { type: "string" },
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
    const relay = await startNodeRelay({
      port,
      dataDir: values.data ?? join(home, "relay"),
      createSecret: values["create-secret"] ?? process.env.AGENTCOMMS_CREATE_SECRET,
    });
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
      member: signMember(
        {
          sig: "",
          id: identity.id,
          kind: "human",
          label: identity.label,
          signPublicKey: identity.id,
          boxPublicKey: Buffer.from(identity.box.publicKey).toString("base64url"),
          agents: [],
        },
        identity,
      ),
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
      headers: {
        "content-type": "application/json",
        ...(method === "PUT"
          ? {
              authorization: `Bearer ${values["create-secret"] ?? process.env.AGENTCOMMS_CREATE_SECRET ?? ""}`,
            }
          : {}),
      },
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
    config.member = signMember(config.member, member);
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
    const grants = (await wrapMemberKeys(key, 0, config.member)).map((g) =>
      signGrant(room, g, owner),
    );
    const directory = signDirectory(room, 0, 0, [config.member], owner);
    const payload = { owner: config.member, grants, directory };
    await http(relayUrl(relay, room, true), "PUT", {
      ...payload,
      sig: sign(controlPayload("create", room, payload), owner),
    });
    const invite = { relay, room, token: "", ownerId: owner.id };
    await acceptDirectory(home, invite, directory);
    await saveRoomKeys(home, room, new Map([[0, key]]));
    await addRoom(invite);
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
    if (identity.id !== room.ownerId) throw new Error("Owner only");
    const payload = {
      memberId: identity.id,
      at: Date.now(),
      nonce: randomBytes(32).toString("base64url"),
    };
    const result = await http(`${relayUrl(room.relay, room.room, true)}/tokens`, "POST", {
      ...payload,
      sig: sign(controlPayload("token", room.room, payload), identity),
    });
    print(encodeInvite({ ...room, token: required(result.token, "invite token") }));
    return;
  }
  if (command === "approve" || command === "remove") {
    arity(2);
    const room = roomFor(rest[0]);
    const identity = await memberIdentity();
    if (identity.id !== room.ownerId) throw new Error("Owner only");
    // The owner's disk is authoritative. Never rotate or approve using relay copies of active records.
    const directory = await readTrust(home, room);
    if (!directory) throw new Error("Missing locally pinned owner directory");
    const control = await relayControl(room, identity);
    try {
      if (!control.directory) throw new Error("Missing room directory");
      const verified = await acceptDirectory(home, room, control.directory, directory);
      if (verified.version !== directory.version)
        throw new Error("Owner state changed; retry using persisted state");
      const keys = await readRoomKeys(home, room.room);
      for (const grant of control.grants) {
        if (!verifyGrant(room.room, grant, room.ownerId) || grant.keyEpoch > directory.keyEpoch)
          throw new Error("Invalid owner grant");
        const key = await unwrapRoomKey(grant, identity);
        const old = keys.get(grant.keyEpoch);
        if (old && !Buffer.from(old).equals(key)) throw new Error("Conflicting room key grant");
        if (!old) keys.set(grant.keyEpoch, key);
      }
      const memberId = rest[1];
      let members = directory.members;
      let epoch = directory.keyEpoch;
      let grants: KeyGrant[];
      if (command === "approve") {
        const candidate = control.pending.find((m) => m.id === memberId);
        if (!candidate) throw new Error("Unknown pending member");
        validateMember(candidate);
        // Pin the self-signed record selected by the human's member id before using any box key.
        const pinPath = join(home, `member-${memberId}.json`);
        const pinned = await readOptional(pinPath);
        if (pinned && pinned !== JSON.stringify(candidate))
          throw new Error("Member record changed");
        if (!pinned) await writePrivate(pinPath, JSON.stringify(candidate));
        const member = memberSchema.parse(JSON.parse((await readOptional(pinPath)) as string));
        validateMember(member);
        const key = keys.get(epoch);
        if (!key) throw new Error("Current room key unavailable");
        members = [...members, member];
        // Approval shares the current epoch, including its retained history.
        grants = await wrapMemberKeys(key, epoch, member);
      } else {
        if (memberId === identity.id || !members.some((m) => m.id === memberId))
          throw new Error("Cannot remove member");
        const rotation = await rotate(members, memberId, ++epoch);
        grants = rotation.grants;
        members = members.filter((m) => m.id !== memberId);
        keys.set(epoch, rotation.roomKey);
      }
      grants = grants.map((g) => signGrant(room.room, g, identity));
      const next = signDirectory(room.room, epoch, directory.version + 1, members, identity);
      const payload = { memberId, grants, directory: next };
      // Persist before publishing: a lost acknowledgement must not roll local state backwards.
      await saveRoomKeys(home, room.room, keys);
      await acceptDirectory(home, room, next, directory);
      await control.change({
        t: command,
        ...payload,
        sig: sign(controlPayload(command, room.room, payload), identity),
      });
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
