import { type ChildProcessWithoutNullStreams, execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import type { InboxEntry } from "../src/inbox.ts";
import { startNodeRelay } from "../src/relay-node.ts";

const exec = promisify(execFile);
const shim = resolve("packages/agentcomms/bin/agentcomms");
const children: ChildProcessWithoutNullStreams[] = [];
let root: string;
let relay: Awaited<ReturnType<typeof startNodeRelay>> | undefined;
const cli = (home: string, ...args: string[]) =>
  exec(shim, args, {
    env: { ...process.env, AGENTCOMMS_CREATE_SECRET: "test-secret", AGENTCOMMS_HOME: home },
    timeout: 10000,
  });

afterEach(async () => {
  await Promise.all(
    children.splice(0).map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) return resolve();
          child.once("exit", () => resolve());
          child.kill();
        }),
    ),
  );
  await relay?.close();
  relay = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

function start(home: string, ...args: string[]) {
  const child = spawn(shim, args, {
    env: { ...process.env, AGENTCOMMS_CREATE_SECRET: "test-secret", AGENTCOMMS_HOME: home },
  });
  children.push(child);
  return child;
}

it("connects home and work through CLI, agent grants, daemons and stdio MCP", async () => {
  root = await mkdtemp(join(tmpdir(), "comms-two-sides-"));
  const home = join(root, "home");
  const work = join(root, "work");
  const room = "home-work";
  relay = await startNodeRelay({
    createSecret: "test-secret",
    port: 0,
    dataDir: join(root, "relay"),
  });
  const homeMember = (await cli(home, "init", "--member", "Luke home")).stdout.trim();
  const homeAgent = (
    await cli(home, "agent", "add", "FLIGHT-comms", "--subscription", "Claude · home")
  ).stdout.trim();
  const workMember = (await cli(work, "init", "--member", "Luke work")).stdout.trim();
  await cli(work, "agent", "add", "work-comms", "--subscription", "Claude · work");
  await cli(home, "room", "create", relay.url, room);
  const invite = (await cli(home, "invite", room)).stdout.trim();
  expect((await cli(work, "join", invite)).stdout.trim()).toBe(workMember);
  await cli(home, "approve", room, workMember);

  // Neither daemon nor MCP may load a member key. Work has no cached room key;
  // it must unwrap the grant addressed to its approved agent.
  for (const [directory, member] of [
    [home, homeMember],
    [work, workMember],
  ]) {
    const path = join(directory, "keys", `${member}.json`);
    await rename(path, `${path}.hidden`);
  }
  const answer = JSON.stringify({
    body: "I cannot confirm ownership from the shared notes.",
    knowledge: { kind: "cannot-confirm" },
  });
  start(home, "daemon", "--answer", `cat >/dev/null; printf '%s' '${answer}'`);
  // Giving work a hook too makes an accidental automatic-answer loop visible.
  start(work, "daemon", "--answer", "cat >/dev/null; echo unexpected-answer");
  for (const directory of [home, work]) {
    await expect
      .poll(
        async () => {
          try {
            const url = (await readFile(join(directory, "api-url"), "utf8")).trim();
            const token = (await readFile(join(directory, "api-token"), "utf8")).trim();
            const response = await fetch(`${url}/rooms`, {
              headers: { authorization: `Bearer ${token}` },
            });
            const rooms = (await response.json()) as { status: string }[];
            return response.ok && rooms.every((room) => room.status === "connected");
          } catch {
            return false;
          }
        },
        { timeout: 15000 },
      )
      .toBe(true);
  }

  const mcp = start(work, "mcp");
  type Reply = {
    id: number;
    result?: { content: { text: string }[]; isError?: boolean };
    error?: { message: string };
  };
  const replies: Reply[] = [];
  const lines = createInterface({ input: mcp.stdout });
  lines.on("line", (line) => replies.push(JSON.parse(line)));
  let id = 0;
  async function call(name: string, args: unknown) {
    const requestId = ++id;
    mcp.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method: "tools/call",
        params: { name, arguments: args },
      })}\n`,
    );
    await expect
      .poll(() => replies.find((r) => r.id === requestId), { timeout: 5000 })
      .toBeDefined();
    const reply = replies.find((r) => r.id === requestId);
    expect(reply?.error).toBeUndefined();
    if (!reply?.result) throw new Error("Missing MCP result");
    return reply.result;
  }
  async function read(): Promise<InboxEntry[]> {
    const result = await call("comms_read", { room });
    expect(result.isError).not.toBe(true);
    return JSON.parse(result.content[0].text);
  }

  expect(
    await call("comms_send", {
      room,
      kind: "request",
      body: "FLIGHT-comms, take #506",
    }),
  ).toEqual({ isError: true, content: [{ type: "text", text: "a request needs a reason" }] });
  expect(await read()).toEqual([]);
  expect(
    await call("comms_send", {
      room,
      kind: "question",
      body: "FLIGHT-comms, is #506 yours?",
      thread: "first-test",
    }),
  ).toMatchObject({ content: [{ text: '{"seq":1}' }] });
  await expect.poll(read, { timeout: 5000 }).toHaveLength(2);
  const [question, response] = await read();
  expect(response).toMatchObject({
    seq: 2,
    msg: {
      kind: "answer",
      body: "I cannot confirm ownership from the shared notes.",
      knowledge: { kind: "cannot-confirm" },
      auto: true,
      thread: "first-test",
      inReplyTo: question.msg?.id,
    },
    sender: {
      kind: "agent",
      id: homeAgent,
      delegation: {
        agentName: "FLIGHT-comms",
        subscription: "Claude · home",
        memberId: homeMember,
      },
      member: { id: homeMember, label: "Luke home" },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect((await read()).map((entry) => entry.seq)).toEqual([1, 2]);
  lines.close();
}, 45000);
