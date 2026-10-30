/**
 * Re-runs the 29 Oct skills probe against the installed `claude` with the plugin folder the hub
 * builds (docs/spikes/2026-10-29-seat-skills.md): node --experimental-strip-types apps/server/test/live/skills-live-check.ts
 * Needs a Claude login and makes two short model calls. Each probe reads the stream-json output and
 * asserts a real `Skill` tool call with a successful result, not what the model says about it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREW_ISOLATION_FLAGS, plainTalkProblems } from "@mc/core";
import { readRepoSkills, writeSkillPlugin } from "../../src/runtime/skills.ts";

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: { skill?: string };
  tool_use_id?: string;
  is_error?: boolean;
  text?: string;
}

/** The skills the stream invoked (with whether each call succeeded), and the final reply text. */
function readStream(out: string) {
  const calls = new Map<string, { skill: string; ok: boolean | null }>();
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
      if (b.type === "tool_use" && b.name === "Skill" && b.id !== undefined) {
        calls.set(b.id, { skill: b.input?.skill ?? "", ok: null });
      }
      if (b.type === "tool_result" && b.tool_use_id !== undefined) {
        const call = calls.get(b.tool_use_id);
        if (call !== undefined) call.ok = b.is_error !== true;
      }
    }
  }
  return { calls: [...calls.values()], reply };
}

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
        ],
        { cwd: out, encoding: "utf8", timeout: 180_000 },
      ),
    );
  const invoked = (s: ReturnType<typeof readStream>, name: string) =>
    s.calls.some((c) => c.skill.endsWith(name) && c.ok === true);

  // a web ticket: the seat loads hud-design and returns a heading from its text
  const web = ask(
    "You are starting a ticket under apps/web. Invoke the hud-design skill, then reply with the first heading of its text.",
  );
  if (!invoked(web, "hud-design"))
    throw new Error(`no successful hud-design call: ${JSON.stringify(web)}`);
  if (!/^#/m.test(web.reply)) throw new Error(`no heading in the reply: ${web.reply}`);

  // a report: the seat loads plain-talk first, and the report passes the plain-talk check
  const report = ask(
    "Invoke the plain-talk skill, then write a run report for a seat that added a README line. Reply with only the report.",
  );
  if (!invoked(report, "plain-talk"))
    throw new Error(`no successful plain-talk call: ${JSON.stringify(report)}`);
  const problems = plainTalkProblems(report.reply);
  if (problems.length > 0)
    throw new Error(`report fails plain-talk: ${problems.join("; ")}\n${report.reply}`);
  console.log("hud-design and plain-talk invoked; the report passes the plain-talk check");
} finally {
  rmSync(out, { recursive: true, force: true });
}
