/**
 * Re-runs the 29 Oct skills probe against the installed `claude` with the plugin folder the hub
 * builds (docs/spikes/2026-10-29-seat-skills.md): node --experimental-strip-types apps/server/test/live/skills-live-check.ts
 * Needs a Claude login and makes two short model calls. Each probe reads the stream-json output and
 * asserts real tool calls, not what the model says about them:
 * - a web ticket: a successful `Skill` call for hud-design, and a heading from its text;
 * - a report: a successful `Skill` call for plain-talk, then a `report_evidence` call (a stub MCP
 *   tool that only records its input) whose note passes `plainTalkProblems`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREW_ISOLATION_FLAGS, MC_MCP_SERVER, plainTalkProblems } from "@mc/core";
import { readRepoSkills, writeSkillPlugin } from "../../src/runtime/skills.ts";

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: { skill?: string; note?: string };
  tool_use_id?: string;
  is_error?: boolean;
}

interface Call {
  name: string;
  skill: string;
  note: string;
  ok: boolean | null;
}

/** The tool calls in stream order, and the final reply text. */
function readStream(out: string) {
  const calls = new Map<string, Call>();
  let reply = "";
  for (const line of out.split("\n")) {
    if (!line.startsWith("{")) continue;
    const msg = JSON.parse(line) as {
      type?: string;
      result?: string;
      message?: { content?: Block[] };
    };
    if (msg.type === "result") reply = msg.result ?? "";
    for (const b of msg.message?.content ?? []) {
      if (b.type === "tool_use" && b.id !== undefined) {
        calls.set(b.id, {
          name: b.name ?? "",
          skill: b.input?.skill ?? "",
          note: b.input?.note ?? "",
          ok: null,
        });
      }
      if (b.type === "tool_result" && b.tool_use_id !== undefined) {
        const call = calls.get(b.tool_use_id);
        if (call !== undefined) call.ok = b.is_error !== true;
      }
    }
  }
  return { calls: [...calls.values()], reply };
}

/** A stdio MCP server with one `report_evidence` tool that accepts any note. */
const STUB_MCP = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
rl.on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } });
  else if (m.method === "tools/list") send(m.id, { tools: [{ name: "report_evidence", description: "Report the finished work.", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } }] });
  else if (m.method === "tools/call") send(m.id, { content: [{ type: "text", text: "Recorded." }] });
});
`;

const repo = realpathSync(join(import.meta.dirname, "../../../.."));
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const out = realpathSync(mkdtempSync(join(tmpdir(), "mc-skills-live-")));
try {
  const { skills, refused } = await readRepoSkills(repo, head);
  for (const name of ["hud-design", "plain-talk"]) {
    if (!skills.some((s) => s.name === name)) throw new Error(`no ${name}: ${refused}`);
  }
  const plugin = join(out, "plugin");
  writeSkillPlugin(plugin, "Luke-Bradford/mission-control", skills);
  const stub = join(out, "stub-mcp.cjs");
  writeFileSync(stub, STUB_MCP);
  const mcpConfig = join(out, "mcp.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: { [MC_MCP_SERVER]: { command: process.execPath, args: [stub] } },
    }),
  );
  const reportTool = `mcp__${MC_MCP_SERVER}__report_evidence`;
  const ask = (prompt: string) =>
    readStream(
      execFileSync(
        "claude",
        [
          "-p",
          prompt,
          "--output-format",
          "stream-json",
          "--verbose",
          ...CREW_ISOLATION_FLAGS,
          "--plugin-dir",
          plugin,
          "--tools",
          "Skill",
          "--mcp-config",
          mcpConfig,
          "--allowedTools",
          "Skill",
          reportTool,
        ],
        { cwd: out, encoding: "utf8", timeout: 180_000 },
      ),
    );
  const indexOfCall = (s: ReturnType<typeof readStream>, test: (c: Call) => boolean) =>
    s.calls.findIndex((c) => test(c) && c.ok === true);

  // a web ticket: the seat loads hud-design and returns a heading from its text
  const web = ask(
    "You are starting a ticket under apps/web. Invoke the hud-design skill, then reply with the first heading of its text.",
  );
  if (indexOfCall(web, (c) => c.name === "Skill" && c.skill.endsWith("hud-design")) < 0) {
    throw new Error(`no successful hud-design call: ${JSON.stringify(web)}`);
  }
  if (!/^#/m.test(web.reply)) throw new Error(`no heading in the reply: ${web.reply}`);

  // a report: plain-talk loads first, then the seat's report_evidence note passes the check
  const report = ask(
    `Invoke the plain-talk skill. Then call ${reportTool} with a note that reports a seat finished adding a README line.`,
  );
  const skillAt = indexOfCall(report, (c) => c.name === "Skill" && c.skill.endsWith("plain-talk"));
  const reportAt = indexOfCall(report, (c) => c.name === reportTool);
  if (skillAt < 0) throw new Error(`no successful plain-talk call: ${JSON.stringify(report)}`);
  if (reportAt < 0) throw new Error(`no report_evidence call: ${JSON.stringify(report)}`);
  if (skillAt > reportAt) throw new Error("report_evidence was called before plain-talk loaded");
  const note = report.calls[reportAt]?.note ?? "";
  const problems = plainTalkProblems(note);
  if (note === "" || problems.length > 0) {
    throw new Error(`report_evidence note fails plain-talk: ${problems.join("; ")}\n${note}`);
  }
  console.log("hud-design and plain-talk invoked; the report_evidence note passes the check");
} finally {
  rmSync(out, { recursive: true, force: true });
}
