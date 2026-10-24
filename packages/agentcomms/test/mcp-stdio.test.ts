import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("serves MCP over the executable shim without any config or identity files", async () => {
  const home = await mkdtemp(join(tmpdir(), "comms-stdio-"));
  const child = spawn(resolve("packages/agentcomms/bin/agentcomms"), ["mcp"], {
    env: { ...process.env, AGENTCOMMS_HOME: home },
    stdio: "pipe",
  });
  try {
    let stdout = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    const exited = once(child, "close");
    child.stdin.end(
      [
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2024-11-05" },
        }),
        JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
        "bad json",
        "",
      ].join("\n"),
    );
    expect((await exited)[0]).toBe(0);
    const replies = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(replies).toHaveLength(3);
    expect(replies[0]).toMatchObject({ id: 1, result: { capabilities: { tools: {} } } });
    expect(replies[1].result.tools.map((t: { name: string }) => t.name)).toEqual([
      "comms_rooms",
      "comms_read",
      "comms_send",
      "comms_presence",
      "comms_threads",
    ]);
    expect(replies[2]).toMatchObject({ id: null, error: { code: -32700 } });
  } finally {
    child.kill();
    await rm(home, { recursive: true, force: true });
  }
});
