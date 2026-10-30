/**
 * Re-runs the 29 Oct skills probe against the installed `claude` with the plugin folder the hub
 * builds (docs/spikes/2026-10-29-seat-skills.md): node --experimental-strip-types apps/server/test/live/skills-live-check.ts
 * Needs a Claude login and makes one short model call per probe.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREW_ISOLATION_FLAGS } from "@mc/core";
import { readRepoSkills, writeSkillPlugin } from "../../src/runtime/skills.ts";

const repo = realpathSync(join(import.meta.dirname, "../../../.."));
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const out = realpathSync(mkdtempSync(join(tmpdir(), "mc-skills-live-")));
try {
  const { skills, refused } = await readRepoSkills(repo, head);
  if (!skills.some((s) => s.name === "hud-design")) throw new Error(`no hud-design: ${refused}`);
  const plugin = join(out, "plugin");
  writeSkillPlugin(plugin, "Luke-Bradford/mission-control", skills);
  const ask = (...flags: string[]) =>
    execFileSync(
      "claude",
      [
        "-p",
        "Invoke the hud-design skill, then reply with the first heading of its text.",
        ...CREW_ISOLATION_FLAGS,
        ...flags,
      ],
      { cwd: out, encoding: "utf8", timeout: 180_000 },
    );
  const withPlugin = ask("--plugin-dir", plugin, "--tools", "Skill");
  console.log(`with --plugin-dir and Skill:\n${withPlugin}`);
  const without = ask("--tools", "Skill");
  console.log(`without --plugin-dir:\n${without}`);
  if (!/hud/i.test(withPlugin)) throw new Error("the seat did not invoke hud-design");
} finally {
  rmSync(out, { recursive: true, force: true });
}
