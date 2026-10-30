import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copySkillsToCodexHome, readRepoSkills, writeSkillPlugin } from "../src/runtime/skills.ts";

describe("the repo's skills reach a seat (#1051)", () => {
  let dir: string;
  let out: string;
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
      { cwd: dir, encoding: "utf8" },
    ).trim();
  const put = (path: string, text: string | Buffer, mode?: number) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text, mode === undefined ? undefined : { mode });
  };
  const snapshot = () => {
    git("add", "-A");
    git("commit", "-qm", "fixture", "--allow-empty");
    return git("rev-parse", "HEAD");
  };
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-skills-")));
    out = realpathSync(mkdtempSync(join(tmpdir(), "mc-skills-out-")));
    git("init", "-q", "-b", "main");
    put(".claude/skills/hud-design/SKILL.md", "---\nname: hud-design\n---\nWeb checklist\n");
    put(".claude/skills/hud-design/notes/rules.md", "rules\n");
    put(".claude/skills/plain-talk/SKILL.md", "---\nname: plain-talk\n---\nWrite plainly\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("reads each skill from the run's base commit, not the writable worktree", async () => {
    const base = snapshot();
    put(".claude/skills/hud-design/SKILL.md", "INJECTED");
    put(".claude/skills/extra/SKILL.md", "worktree only");
    const { skills, refused } = await readRepoSkills(dir, base);
    expect(refused).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(["hud-design", "plain-talk"]);
    const hud = skills[0];
    expect(hud?.files.map((f) => f.path)).toEqual(["SKILL.md", "notes/rules.md"]);
    expect(hud?.files[0]?.body.toString()).toBe("---\nname: hud-design\n---\nWeb checklist\n");
  });

  it("has no skills when the repo has none", async () => {
    rmSync(join(dir, ".claude"), { recursive: true });
    put("README.md", "hi");
    expect(await readRepoSkills(dir, snapshot())).toEqual({ skills: [], refused: [] });
  });

  it("leaves out a whole skill that holds a script, a binary, an executable or a link", async () => {
    put(".claude/skills/script/SKILL.md", "ok");
    put(".claude/skills/script/run.sh", "#!/bin/sh\n");
    put(".claude/skills/binary/SKILL.md", "ok");
    put(".claude/skills/binary/pic.md", Buffer.from([0, 1, 2]));
    put(".claude/skills/exec/SKILL.md", "ok", 0o755);
    put(".claude/skills/link/SKILL.md", "ok");
    symlinkSync("/etc/passwd", join(dir, ".claude/skills/link/notes.md"));
    put(".claude/skills/nomain/notes.md", "no SKILL.md here");
    const { skills, refused } = await readRepoSkills(dir, snapshot());
    expect(skills.map((s) => s.name)).toEqual(["hud-design", "plain-talk"]);
    expect(refused.map((r) => r.split(":")[0]).sort()).toEqual([
      "binary",
      "exec",
      "link",
      "nomain",
      "script",
    ]);
    expect(refused.join("\n")).toMatch(/run\.sh/);
    expect(refused.join("\n")).toMatch(/SKILL\.md/);
  });

  it("passes no skill when the repo has more files than the cap, so none is half-checked", async () => {
    put(".claude/skills/zzz/SKILL.md", "ok");
    put(".claude/skills/zzz/run.sh", "#!/bin/sh\n");
    const base = snapshot();
    // 5 files in all: a cap of 4 would cut `run.sh` off and pass `zzz` with only its SKILL.md
    const cut = await readRepoSkills(dir, base, 4);
    expect(cut.skills).toEqual([]);
    expect(cut.refused).toEqual([".claude/skills: more than 4 files"]);
    const whole = await readRepoSkills(dir, base);
    expect(whole.skills.map((s) => s.name)).toEqual(["hud-design", "plain-talk"]);
    expect(whole.refused.join()).toMatch(/zzz/);
  });

  it("builds a read-only plugin folder with skills only: no hooks, bin or MCP", async () => {
    const { skills } = await readRepoSkills(dir, snapshot());
    const plugin = join(out, "plugin");
    writeSkillPlugin(plugin, "Luke-Bradford/mission-control", skills);
    expect(readdirSync(plugin).sort()).toEqual([".claude-plugin", "skills"]);
    expect(readdirSync(join(plugin, ".claude-plugin"))).toEqual(["plugin.json"]);
    expect(JSON.parse(readFileSync(join(plugin, ".claude-plugin/plugin.json"), "utf8"))).toEqual({
      name: "mission-control",
      description: "Skills from Luke-Bradford/mission-control's .claude/skills",
    });
    expect(readFileSync(join(plugin, "skills/hud-design/SKILL.md"), "utf8")).toContain(
      "Web checklist",
    );
    expect(readFileSync(join(plugin, "skills/hud-design/notes/rules.md"), "utf8")).toBe("rules\n");
    expect(existsSync(join(plugin, "hooks"))).toBe(false);
    expect(existsSync(join(plugin, "bin"))).toBe(false);
    expect(existsSync(join(plugin, ".mcp.json"))).toBe(false);
    expect(lstatSync(join(plugin, "skills/plain-talk/SKILL.md")).mode & 0o777).toBe(0o444);
  });

  it("rebuilds a folder from scratch, so an older run's file does not linger", async () => {
    const { skills } = await readRepoSkills(dir, snapshot());
    const plugin = join(out, "plugin");
    mkdirSync(join(plugin, "hooks"), { recursive: true });
    writeFileSync(join(plugin, "hooks/hooks.json"), "{}");
    writeSkillPlugin(plugin, "o/r", skills);
    expect(existsSync(join(plugin, "hooks"))).toBe(false);
    writeSkillPlugin(plugin, "o/r", skills);
  });

  it("copies the same skills into a Codex home's skills folder", async () => {
    const { skills } = await readRepoSkills(dir, snapshot());
    const home = join(out, "codex-home");
    mkdirSync(home);
    copySkillsToCodexHome(home, skills);
    expect(readdirSync(join(home, "skills")).sort()).toEqual(["hud-design", "plain-talk"]);
    expect(readFileSync(join(home, "skills/plain-talk/SKILL.md"), "utf8")).toContain(
      "Write plainly",
    );
    expect(readFileSync(join(home, "skills/hud-design/notes/rules.md"), "utf8")).toBe("rules\n");
  });
});
