import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it } from "vitest";
import { startNodeRelay } from "../src/relay-node.ts";

const exec = promisify(execFile);
const shim = resolve("packages/agentcomms/bin/agentcomms");
let root: string;
let relay: Awaited<ReturnType<typeof startNodeRelay>> | undefined;
const children: ChildProcess[] = [];
const cli = (home: string, ...args: string[]) =>
  exec(shim, args, { env: { ...process.env, AGENTCOMMS_HOME: home }, timeout: 10000 });
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "comms-cli-"));
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
  await rm(root, { recursive: true, force: true });
});
it("initializes private keys and refuses duplicate agent names within a subscription", async () => {
  await cli(root, "init", "--member", "Alice", "--github", "alice");
  await cli(root, "agent", "add", "helper", "--subscription", "home");
  await expect(cli(root, "agent", "add", "helper", "--subscription", "home")).rejects.toThrow(
    /already exists/,
  );
  const keys = await readdir(join(root, "keys"));
  expect(keys).toHaveLength(2);
  for (const name of keys) expect((await stat(join(root, "keys", name))).mode & 0o777).toBe(0o600);
  const config = await readFile(join(root, "config.json"), "utf8");
  expect(config).not.toContain("privateKey");
  await expect(cli(root, "init", "--member", "Overwrite")).rejects.toThrow(/already initialized/);
});
it("rejects an agent entry pointing to the member identity before loading that key file", async () => {
  await cli(root, "init", "--member", "Alice");
  await cli(root, "agent", "add", "helper", "--subscription", "home");
  const path = join(root, "config.json");
  const config = JSON.parse(await readFile(path, "utf8"));
  config.member.agents[0].id = config.member.id;
  config.member.agents[0].signPublicKey = config.member.id;
  await writeFile(path, JSON.stringify(config));
  await rm(join(root, "keys", `${config.member.id}.json`));
  await expect(cli(root, "daemon")).rejects.toThrow(/Invalid agent delegation/);
});
it("creates, invites, joins, approves, exchanges, and rotates on removal", async () => {
  const a = join(root, "a");
  const b = join(root, "b");
  relay = await startNodeRelay({ port: 0, dataDir: join(root, "relay") });
  for (const [home, label] of [
    [a, "Alice"],
    [b, "Bob"],
  ]) {
    await cli(home, "init", "--member", label);
    await cli(home, "agent", "add", "helper", "--subscription", label);
  }
  await cli(a, "room", "create", relay.url, "test-room");
  const invite = (await cli(a, "invite", "test-room")).stdout.trim();
  expect(invite).toMatch(/^ac1\./);
  const bob = (await cli(b, "join", invite)).stdout.trim();
  await cli(a, "approve", "test-room", bob);
  // Provisioning is done: daemons must work without access to either member identity file.
  for (const home of [a, b]) {
    const config = JSON.parse(await readFile(join(home, "config.json"), "utf8"));
    const memberPath = join(home, "keys", `${config.member.id}.json`);
    await rename(memberPath, `${memberPath}.hidden`);
    const child = spawn(shim, ["daemon"], {
      env: { ...process.env, AGENTCOMMS_HOME: home },
      stdio: "pipe",
    });
    children.push(child);
  }
  async function api(home: string, path: string, body?: object) {
    const url = (await readFile(join(home, "api-url"), "utf8")).trim();
    const token = (await readFile(join(home, "api-token"), "utf8")).trim();
    const response = await fetch(`${url}${path}`, {
      method: body ? "POST" : "GET",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
  for (const home of [a, b])
    await expect
      .poll(
        async () => {
          try {
            return await api(home, "/rooms");
          } catch {
            return undefined;
          }
        },
        { timeout: 5000 },
      )
      .toBeDefined();
  expect(
    await api(a, "/rooms/test-room/messages", { kind: "fyi", body: "before removal" }),
  ).toEqual({ seq: 1 });
  await expect
    .poll(() => api(b, "/rooms/test-room/messages"))
    .toMatchObject([{ msg: { body: "before removal" } }]);
  expect(await api(b, "/rooms/test-room/messages", { kind: "fyi", body: "reply" })).toEqual({
    seq: 2,
  });
  const owner = JSON.parse(await readFile(join(a, "config.json"), "utf8"));
  await rename(
    join(a, "keys", `${owner.member.id}.json.hidden`),
    join(a, "keys", `${owner.member.id}.json`),
  );
  await cli(a, "remove", "test-room", bob);
  expect(await api(a, "/rooms/test-room/messages", { kind: "fyi", body: "after removal" })).toEqual(
    { seq: 3 },
  );
  expect(await api(b, "/rooms/test-room/messages")).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ msg: expect.objectContaining({ body: "after removal" }) }),
    ]),
  );
}, 30000);
