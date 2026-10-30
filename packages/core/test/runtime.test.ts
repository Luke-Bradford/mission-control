import { describe, expect, it } from "vitest";
import {
  GUARD_HOOK_EVENTS,
  GUARD_HOOK_TIMEOUT_S,
  GUARD_RULES,
  MC_WRITER_TOOLS,
} from "../src/guard.ts";
import {
  crewMcpConfig,
  MC_MCP_SERVER,
  MC_MCP_TIMEOUT_MS,
  MC_READ_ONLY_COMMIT,
  MC_TOOL_NAMES,
  MC_TOOLS,
  READ_ONLY_CANNOT_WRITE,
} from "../src/mcp.ts";
import { ROLES } from "../src/roles.ts";
import {
  anchoredGlob,
  areaOwnsFolder,
  BUILTIN_ROLES,
  branchFor,
  CONTROL_TIMEOUT_MS,
  CREW_CLI_ENV,
  CREW_ISOLATION_FLAGS,
  type CrewCliInput,
  crewAuthorName,
  crewCliArgs,
  crewPnpmStoreDir,
  crewSandboxSettings,
  crewSandboxTmp,
  DEFAULT_SEAT_COMMANDS,
  DENIED_TOOLS,
  FLIGHT_TOOLS,
  foldForMatch,
  globMatches,
  guardHookCommand,
  isProtectedPath,
  LOOP_KINDS,
  MC_TMP_DIR_NAME,
  MC_TOOL_GRANTS,
  MODE_LOOPS,
  modeOfSeat,
  PNPM_STORE_DIR_NAME,
  PNPM_STORE_ENV,
  PROTECTED_FILES,
  pathInArea,
  protectedFileRules,
  READONLY_TOOLS,
  SCRATCH_TOOLS,
  SEAT_STATES,
  SKILL_FILE_MAX,
  SKILLS_DIR,
  STOP_GRACE_MS,
  seatDef,
  skillFileProblem,
  skillPluginManifest,
  trimHookCommand,
  WRITER_TOOLS,
} from "../src/runtime.ts";

const base: CrewCliInput = {
  model: "sonnet",
  mode: "writer",
  rolePromptFile: "/mc/roles/GUIDO.md",
  sessionId: "11111111-2222-4333-8444-555555555555",
  resume: false,
  area: [] as string[],
  sandbox: {
    cwd: "/mc/wt/guido-1",
    gitCommonDir: "/mc/clone/.git",
    worktreeGitDir: "/mc/clone/.git/worktrees/guido-1",
    home: "/home/you",
    dataDir: "/home/you/.local/share/mission-control",
    denyRead: [],
    pnpmStoreDir: "/mc/crew/.mc-pnpm-store/shared",
  },
  mcpConfigFile: "/home/you/.local/share/mission-control/crew/guido-1:1.mcp.json",
  hook: {
    command:
      "'/opt/homebrew/bin/node' --experimental-strip-types '/hub/apps/server/src/guard/hook-cli.ts' '/home/you/.local/share/mission-control/crew/guido-1:1.token' 'http://127.0.0.1:7420/api/guard/check' || exit 2",
    timeoutS: GUARD_HOOK_TIMEOUT_S,
  },
};

const count = (args: string[], x: string) => args.filter((a) => a === x).length;

/** The allowlist as it reaches argv: Edit and Write come out anchored to the worktree (#41). */
const asArgv = (tools: readonly string[]) =>
  tools.map((t) => (t === "Edit" || t === "Write" ? `${t}(//mc/wt/guido-1/**)` : t));

describe("crewCliArgs", () => {
  it("allows a watch seat to prepare drafts through its CLI allowlist", () => {
    expect(FLIGHT_TOOLS).toContain("draft_reply");
    const argv = crewCliArgs({ ...base, mode: "read-only", mcTools: ["draft_reply"] });
    const allowed = argv.slice(
      argv.indexOf("--allowedTools") + 1,
      argv.indexOf("--disallowedTools"),
    );
    expect(allowed).toContain("mcp__mc__draft_reply");
    expect(allowed).not.toContain("mcp__mc__post_draft");
  });

  it("starts a new writer session with isolation, the allow and deny lists, and --session-id", () => {
    const a = crewCliArgs(base);
    expect(a.slice(0, 6)).toEqual([
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
    ]);
    expect(a[a.indexOf("--model") + 1]).toBe("sonnet");
    const joined = a.join("\u0000");
    expect(joined).toContain(CREW_ISOLATION_FLAGS.join("\u0000"));
    for (const t of asArgv(WRITER_TOOLS)) expect(count(a, t)).toBe(1);
    for (const t of DENIED_TOOLS) expect(count(a, t)).toBe(1);
    expect(a[a.indexOf("--append-system-prompt-file") + 1]).toBe("/mc/roles/GUIDO.md");
    expect(a[a.indexOf("--session-id") + 1]).toBe(base.sessionId);
    expect(a).not.toContain("--resume");
  });

  it("uses --restricted, not --setting-sources, and names the built-in tools", () => {
    const w = crewCliArgs(base);
    expect(w).toContain("--restricted");
    expect(w).not.toContain("--setting-sources");
    expect(w[w.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Edit,Write,TodoWrite,Bash,Skill");
    const r = crewCliArgs({ ...base, mode: "read-only" });
    expect(r[r.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,TodoWrite,Bash,Skill");
  });

  it("lets every seat invoke the repo's skills from a read-only plugin folder (#1051)", () => {
    for (const mode of ["writer", "read-only", "scratch"] as const) {
      const a = crewCliArgs({ ...base, mode, pluginDir: "/data/crew/skills-abc" });
      expect(a[a.indexOf("--plugin-dir") + 1]).toBe("/data/crew/skills-abc");
      expect(count(a, "--plugin-dir")).toBe(1);
      // the flag removes the Skill tool; the plugin carries skills only, so nothing else loads
      expect(a).not.toContain("--disable-slash-commands");
      expect(a[a.indexOf("--tools") + 1].split(",")).toContain("Skill");
      const allowed = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
      expect(allowed).toContain("Skill");
    }
    expect(crewCliArgs(base)).not.toContain("--plugin-dir");
    expect(CREW_ISOLATION_FLAGS).toEqual(["--restricted", "--strict-mcp-config"]);
  });

  it("denies git's --output file writers", () => {
    for (const c of ["diff", "log", "show"]) {
      expect(DENIED_TOOLS).toContain(`Bash(git ${c} --output*)`);
    }
  });

  it("denies the keychain tool by name and by path", () => {
    expect(DENIED_TOOLS).toContain("Bash(security:*)");
    expect(DENIED_TOOLS).toContain("Bash(/usr/bin/security:*)");
  });

  it("puts the tools after their flags and never mixes the lists", () => {
    const a = crewCliArgs(base);
    const allowAt = a.indexOf("--allowedTools");
    const denyAt = a.indexOf("--disallowedTools");
    expect(allowAt).toBeGreaterThan(-1);
    expect(denyAt).toBeGreaterThan(-1);
    for (const t of asArgv(WRITER_TOOLS)) {
      expect(a.indexOf(t)).toBeGreaterThan(allowAt);
      expect(a.indexOf(t)).toBeLessThan(denyAt);
    }
    for (const t of DENIED_TOOLS) expect(a.indexOf(t)).toBeGreaterThan(denyAt);
    for (const t of DENIED_TOOLS) expect(WRITER_TOOLS as readonly string[]).not.toContain(t);
    for (const t of DENIED_TOOLS) expect(READONLY_TOOLS as readonly string[]).not.toContain(t);
  });

  it("passes the mc tools' config as a file path, never inline JSON (it holds the token)", () => {
    for (const mode of ["writer", "read-only"] as const) {
      const a = crewCliArgs({ ...base, mode });
      expect(count(a, "--mcp-config")).toBe(1);
      expect(a[a.indexOf("--mcp-config") + 1]).toBe(base.mcpConfigFile);
      expect(a.some((x) => x.includes("mcpServers"))).toBe(false);
    }
  });

  it("passes --effort only when the seat has one", () => {
    const a = crewCliArgs({ ...base, effort: "max" });
    expect(count(a, "--effort")).toBe(1);
    expect(a[a.indexOf("--effort") + 1]).toBe("max");
    expect(crewCliArgs(base)).not.toContain("--effort");
    expect(crewCliArgs({ ...base, effort: null })).not.toContain("--effort");
  });

  it("resumes with --resume instead of --session-id", () => {
    const a = crewCliArgs({ ...base, resume: true });
    expect(a[a.indexOf("--resume") + 1]).toBe(base.sessionId);
    expect(a).not.toContain("--session-id");
  });

  it("uses the read-only tools for a read-only seat", () => {
    const a = crewCliArgs({ ...base, mode: "read-only" });
    for (const t of READONLY_TOOLS) expect(count(a, t)).toBe(1);
    expect(a).not.toContain("Edit");
    expect(a).not.toContain("Write");
    for (const t of DENIED_TOOLS) expect(count(a, t)).toBe(1);
    // the anchored protected-file denies come after --disallowedTools, never as allows
    const allowed = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
    expect(allowed).not.toContain("Bash(git commit:*)");
    expect(allowed.filter((t) => t.startsWith("Edit(") || t.startsWith("Write("))).toEqual([]);
  });
});

describe("the allowlist in phase 2b", () => {
  it("a writer commits and reports through the mc tools, never git, and has no push or draft PR tool", () => {
    expect(WRITER_TOOLS).not.toContain("Bash(git add:*)");
    expect(WRITER_TOOLS).not.toContain("Bash(git commit:*)");
    for (const t of [
      MC_TOOLS.commit,
      MC_TOOLS.syncMain,
      MC_TOOLS.askFlight,
      MC_TOOLS.reportEvidence,
    ]) {
      expect(WRITER_TOOLS).toContain(t);
    }
    // Mission Control pushes and opens the PR (the engine); a seat has neither tool
    expect(WRITER_TOOLS).not.toContain(MC_TOOLS.push);
    expect(WRITER_TOOLS).not.toContain(MC_TOOLS.draftPr);
    expect(DENIED_TOOLS).toContain("Bash(git add:*)");
    expect(DENIED_TOOLS).toContain("Bash(git commit:*)");
    const a = crewCliArgs(base);
    const allowed = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
    expect(allowed).toContain("mcp__mc__commit");
    expect(allowed).not.toContain("mcp__mc__push");
    expect(allowed).not.toContain("mcp__mc__draft_pr");
    expect(allowed).toContain("mcp__mc__report_evidence");
    expect(allowed).toContain("mcp__mc__ask_flight");
  });

  it("a read-only seat may ask FLIGHT and send Comms, with no git writes", () => {
    expect(READONLY_TOOLS).toContain(MC_TOOLS.askFlight);
    for (const t of MC_WRITER_TOOLS) expect(READONLY_TOOLS as readonly string[]).not.toContain(t);
    const a = crewCliArgs({ ...base, mode: "read-only" });
    const allowed = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
    expect(allowed.filter((t) => t.startsWith("mcp__"))).toEqual([
      "mcp__mc__ask_flight",
      "mcp__mc__report_evidence",
      "mcp__mc__comms_read",
      "mcp__mc__comms_inbox",
      "mcp__mc__comms_send",
      "mcp__mc__comms_react",
    ]);
  });

  it("a read-only seat reports a plan only when its role is granted report_plan", () => {
    expect(READONLY_TOOLS).not.toContain(MC_TOOLS.reportPlan);
    const a = crewCliArgs({ ...base, mode: "read-only", mcTools: ["report_plan"] });
    const allowed = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
    expect(allowed.at(-1)).toBe(MC_TOOLS.reportPlan);
  });

  it("a planless build run may report its own plan", () => {
    const a = crewCliArgs({ ...base, runTools: ["report_plan"] });
    const allowed = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
    expect(allowed).toContain(MC_TOOLS.reportPlan);
  });

  it("names the mc tools as the CLI shows them: mcp__<server>__<tool>", () => {
    expect(MC_MCP_SERVER).toBe("mc");
    expect(MC_TOOLS).toEqual({
      commit: "mcp__mc__commit",
      push: "mcp__mc__push",
      draftPr: "mcp__mc__draft_pr",
      draftReply: "mcp__mc__draft_reply",
      track: "mcp__mc__track",
      untrack: "mcp__mc__untrack",
      ledger: "mcp__mc__ledger",
      remember: "mcp__mc__remember",
      forget: "mcp__mc__forget",
      recall: "mcp__mc__recall",
      holdItem: "mcp__mc__hold_item",
      releaseHold: "mcp__mc__release_hold",
      screenshotHud: "mcp__mc__screenshot_hud",
      askFlight: "mcp__mc__ask_flight",
      reportEvidence: "mcp__mc__report_evidence",
      reportFindings: "mcp__mc__report_findings",
      restoreFile: "mcp__mc__restore_file",
      reportPlan: "mcp__mc__report_plan",
      logDecision: "mcp__mc__log_decision",
      readTicket: "mcp__mc__read_ticket",
      answerQuestion: "mcp__mc__answer_question",
      startSeat: "mcp__mc__start_seat",
      messageSeat: "mcp__mc__message_seat",
      commsRead: "mcp__mc__comms_read",
      commsInbox: "mcp__mc__comms_inbox",
      commsSend: "mcp__mc__comms_send",
      commsReact: "mcp__mc__comms_react",
      commsPin: "mcp__mc__comms_pin",
      flightState: "mcp__mc__flight_state",
      promote: "mcp__mc__promote",
      endRun: "mcp__mc__end_run",
      resumeSeat: "mcp__mc__resume_seat",
      acceptRuling: "mcp__mc__accept_ruling",
      mergePr: "mcp__mc__merge_pr",
      settlePark: "mcp__mc__settle_park",
      holdPr: "mcp__mc__hold_pr",
      rerunCi: "mcp__mc__rerun_ci",
      editCard: "mcp__mc__edit_card",
      dismissItem: "mcp__mc__dismiss_item",
      syncMain: "mcp__mc__sync_main",
      createTicket: "mcp__mc__create_ticket",
      commentTicket: "mcp__mc__comment_ticket",
      closeTicket: "mcp__mc__close_ticket",
      addControllerCheck: "mcp__mc__add_controller_check",
      briefItem: "mcp__mc__brief_item",
      readPr: "mcp__mc__read_pr",
      readCiLog: "mcp__mc__read_ci_log",
      ghRead: "mcp__mc__gh_read",
      listTickets: "mcp__mc__list_tickets",
      updateBrief: "mcp__mc__update_brief",
      editIssue: "mcp__mc__edit_issue",
      setFields: "mcp__mc__set_fields",
    });
    expect(MC_WRITER_TOOLS).toEqual([MC_TOOLS.commit, MC_TOOLS.syncMain]);
  });

  it("protects .gitattributes, at the top and below it", () => {
    expect(PROTECTED_FILES).toContain(".gitattributes");
    expect(protectedFileRules("/mc/wt/guido-1")).toContain("Edit(//mc/wt/guido-1/.gitattributes)");
    expect(protectedFileRules("/mc/wt/guido-1")).toContain(
      "Write(//mc/wt/guido-1/**/.gitattributes)",
    );
  });

  it("turns background Bash off, so a timed-out suite is killed rather than kept running", () => {
    expect(CREW_CLI_ENV).toEqual({
      CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
      DISABLE_AUTOUPDATER: "1",
    });
  });

  it("keeps Claude pnpm stores private", () => {
    expect(crewSandboxTmp(501)).toBe("/tmp/claude-501");
    expect(crewPnpmStoreDir("/tmp/mc-test", "guido-1")).toBe("/tmp/mc-test/mc-pnpm-store/guido-1");
    expect(crewPnpmStoreDir("/tmp/mc-test", "guido-2")).not.toBe(
      crewPnpmStoreDir("/tmp/mc-test", "guido-1"),
    );
    expect(PNPM_STORE_ENV).toBe("pnpm_config_store_dir");
    expect(PNPM_STORE_DIR_NAME).toBe(".pnpm-store");
    expect(MC_TMP_DIR_NAME).toBe(".mc-tmp");
  });
});

describe("guardHookCommand", () => {
  const ok = {
    node: "/opt/homebrew/bin/node",
    entry: "/hub/apps/server/src/guard/hook-cli.ts",
    tokenFile: "/data/crew/guido-1:20261020T000000Z.token",
    url: "http://127.0.0.1:7420/api/guard/check",
  };

  it("single-quotes each part and ends with || exit 2, so a load failure still blocks", () => {
    expect(guardHookCommand(ok)).toBe(
      "'/opt/homebrew/bin/node' --experimental-strip-types '/hub/apps/server/src/guard/hook-cli.ts' '/data/crew/guido-1:20261020T000000Z.token' 'http://127.0.0.1:7420/api/guard/check' || exit 2",
    );
  });

  it("refuses a part holding a quote or a line break", () => {
    for (const k of ["node", "entry", "tokenFile", "url"] as const) {
      for (const bad of ["'", "\n", "\r"]) {
        expect(() => guardHookCommand({ ...ok, [k]: `${ok[k]}${bad}x` }), `${k} ${bad}`).toThrow(
          "a quote or a line break",
        );
      }
    }
  });

  it("refuses a relative node, entry or token file", () => {
    for (const k of ["node", "entry", "tokenFile"] as const) {
      expect(() => guardHookCommand({ ...ok, [k]: "rel/path" }), k).toThrow("must be absolute");
    }
  });
});

describe("trimHookCommand", () => {
  const ok = {
    node: "/opt/homebrew/bin/node",
    entry: "/hub/apps/server/src/guard/trim-cli.ts",
    dir: "/tmp/mc-runs/seat/tool-output",
  };

  it("single-quotes each part", () => {
    expect(trimHookCommand(ok)).toBe(
      "'/opt/homebrew/bin/node' --experimental-strip-types '/hub/apps/server/src/guard/trim-cli.ts' '/tmp/mc-runs/seat/tool-output'",
    );
  });

  it("refuses a quote, a line break or a relative path", () => {
    for (const k of ["node", "entry", "dir"] as const) {
      expect(() => trimHookCommand({ ...ok, [k]: `${ok[k]}'x` }), k).toThrow("quote");
      expect(() => trimHookCommand({ ...ok, [k]: "rel" }), k).toThrow("absolute");
    }
  });
});

describe("crewMcpConfig", () => {
  it("is the mc server over HTTP with the bearer header and a 10-minute tool timeout", () => {
    expect(JSON.parse(crewMcpConfig("http://127.0.0.1:7420/mcp", "ab".repeat(32)))).toEqual({
      mcpServers: {
        mc: {
          type: "http",
          url: "http://127.0.0.1:7420/mcp",
          headers: { Authorization: `Bearer ${"ab".repeat(32)}` },
          timeout: 600_000,
        },
      },
    });
    expect(MC_MCP_TIMEOUT_MS).toBe(600_000);
  });
});

describe("a repo's own commands and protected files", () => {
  const commands = {
    writer: ["uv run pytest", "uv run ruff check"],
    review: ["uv run pytest"],
  };
  const bashEntries = (a: string[]) =>
    a.filter((x) => x.startsWith("Bash(") && !x.includes("git "));

  it("gives a writer plain Bash, never the repo's commands as an allowlist", () => {
    const a = crewCliArgs({ ...base, commands });
    const allowed = a.slice(a.indexOf("--allowedTools"), a.indexOf("--disallowedTools"));
    expect(allowed).toContain("Bash");
    expect(bashEntries(allowed)).toEqual([]);
  });

  it.each(["read-only", "scratch"] as const)("gives a %s seat plain Bash too", (mode) => {
    const a = crewCliArgs({ ...base, mode, commands });
    const allowed = a.slice(a.indexOf("--allowedTools"), a.indexOf("--disallowedTools"));
    expect(allowed).toContain("Bash");
    expect(bashEntries(allowed)).toEqual([]);
  });

  it("keeps the default argv without inputs", () => {
    expect(crewCliArgs({ ...base, commands: DEFAULT_SEAT_COMMANDS })).toEqual(crewCliArgs(base));
    expect(DEFAULT_SEAT_COMMANDS.writer).toEqual([
      "pnpm -s lint",
      "pnpm -s typecheck",
      "pnpm -s test",
      "pnpm -s build",
      "pnpm -s vitest",
    ]);
    expect(DEFAULT_SEAT_COMMANDS.review).toEqual(["pnpm -s vitest"]);
  });

  it("adds extra protected files to the denies", () => {
    const a = crewCliArgs({ ...base, protectedFiles: ["pyproject.toml"] });
    expect(a).toContain("Edit(//mc/wt/guido-1/**/pyproject.toml)");
    expect(a).toContain("Write(//mc/wt/guido-1/pyproject.toml)");
  });

  it("protectedFileRules and isProtectedPath take extra globs", () => {
    const rules = protectedFileRules("/w/x", ["pyproject.toml"]);
    for (const r of [
      "Edit(//w/x/pyproject.toml)",
      "Edit(//w/x/**/pyproject.toml)",
      "Write(//w/x/pyproject.toml)",
      "Write(//w/x/**/pyproject.toml)",
    ]) {
      expect(rules).toContain(r);
    }
    expect(rules).toEqual(expect.arrayContaining(protectedFileRules("/w/x")));
    expect(isProtectedPath("pkg/Pyproject.toml", ["pyproject.toml"])).toBe(true);
    expect(isProtectedPath("pkg/Pyproject.toml")).toBe(false);
    expect(isProtectedPath("ci", ["ci/**"])).toBe(true);
    expect(isProtectedPath("package.json", ["pyproject.toml"])).toBe(true);
  });

  it.each(["pnpm/x", "/usr/bin/uv", "uv  run", "uv run;ls", "", " uv", "uv run $X", "-x"])(
    "refuses the command %j",
    (c) => {
      expect(() => crewCliArgs({ ...base, commands: { writer: [c], review: [] } })).toThrow(
        `crew rules: ${c} is not a seat command`,
      );
    },
  );

  it.each([
    "pnpm -s",
    "pnpm -s exec x",
    "npm exec foo",
    "GIT -C .",
    "SH",
    "Bash",
    "node -e x",
    "python3 -c x",
    "python3 script.py",
    "python3.12 x.py",
    "uv run python x.py",
    "uv run bash x",
    "osascript",
    "ssh host",
    "pytest -c x",
    "tool a -p b",
    "cargo",
  ])("refuses the first-word, case, flag or package-manager rule: %j", (c) => {
    expect(() => crewCliArgs({ ...base, commands: { writer: [c], review: [] } })).toThrow(
      `crew rules: ${c} is not a seat command`,
    );
  });

  it.each(["uv run python -m pytest", "python3 -m pytest", "pnpm -s vitest", "uv run ruff check"])(
    "allows the seat command %j",
    (c) => {
      expect(() => crewCliArgs({ ...base, commands: { writer: [c], review: [] } })).not.toThrow();
    },
  );

  it.each(["a/", "a//b", "./a", "a/./b", "."])("refuses the glob shape %j (M2)", (g) => {
    const msg = `crew rules: ${g} is not a protected-file glob`;
    expect(() => protectedFileRules("/w/x", [g])).toThrow(msg);
    expect(() => crewCliArgs({ ...base, protectedFiles: [g] })).toThrow(msg);
  });

  it.each(["/etc/x", "./x", "~/x", "../x", "a/../x", "a b", "a(b)", "a\\b", "x?"])(
    "refuses the glob %j",
    (g) => {
      const msg = `crew rules: ${g} is not a protected-file glob`;
      expect(() => protectedFileRules("/w/x", [g])).toThrow(msg);
      expect(() => isProtectedPath("a", [g])).toThrow(msg);
      expect(() => crewCliArgs({ ...base, protectedFiles: [g] })).toThrow(msg);
    },
  );
});

describe("protectedFileRules", () => {
  it("covers every protected entry at any depth, not just the worktree top (#42 review)", () => {
    const rules = protectedFileRules("/mc/wt/guido-1");
    for (const f of PROTECTED_FILES) {
      const nested = f.startsWith("**/") ? f : `**/${f}`;
      expect(rules, f).toContain(`Edit(//mc/wt/guido-1/${nested})`);
      expect(rules, f).toContain(`Write(//mc/wt/guido-1/${nested})`);
    }
    expect(new Set(rules).size).toBe(rules.length);
  });

  it("protects Biome's other config name", () => {
    expect(PROTECTED_FILES).toContain("biome.jsonc");
  });
});

describe("anchoredGlob", () => {
  it("anchors a glob to an absolute worktree, trailing slash or not", () => {
    expect(anchoredGlob("/mc/wt/guido-1", "apps/**")).toBe("//mc/wt/guido-1/apps/**");
    expect(anchoredGlob("/mc/wt/guido-1/", "apps/**")).toBe("//mc/wt/guido-1/apps/**");
  });

  it("refuses a relative worktree or one with rule-syntax characters", () => {
    for (const bad of [
      "mc/wt/guido-1",
      "/mc/wt (copy)/x",
      "/mc/wt/[x]",
      "/mc/wt/{a,b}",
      "/mc/wt/*",
      "/mc/wt/a?",
      "/mc/wt/a!",
      "/mc/wt/a#",
      "/mc/wt\\x",
      "/mc/ wt/x",
      "/mc/wt /x",
    ]) {
      expect(() => anchoredGlob(bad, "**"), bad).toThrow();
    }
  });
});

describe("crew constants", () => {
  it("built-in roles reproduce today", () => {
    expect(BUILTIN_ROLES).toEqual({
      GUIDO: {
        prompt: "roles/GUIDO.md",
        model: "sonnet",
        mode: "writer",
        loop: "build",
        tools: [],
        here: "backend developer, test-first in its area",
      },
      INCO: {
        prompt: "roles/INCO.md",
        model: "sonnet",
        mode: "writer",
        loop: "build",
        tools: [],
        here: "frontend developer",
      },
      RETRO: {
        prompt: "roles/RETRO.md",
        model: "opus",
        mode: "read-only",
        loop: "none",
        tools: [],
        here: "reviewer: findings with file and line",
      },
      FAO: {
        prompt: "roles/FAO.md",
        model: "opus",
        mode: "read-only",
        loop: "plan",
        tools: ["report_plan", "read_ticket"],
        here: "planner: writes each ticket's plan for the developers",
      },
      FLIGHT: {
        prompt: "roles/FLIGHT.md",
        model: "opus",
        mode: "read-only",
        loop: "watch",
        tools: [
          "log_decision",
          "read_ticket",
          "answer_question",
          "start_seat",
          "message_seat",
          "comms_pin",
          "flight_state",
          "screenshot_hud",
          "promote",
          "end_run",
          "resume_seat",
          "accept_ruling",
          "merge_pr",
          "settle_park",
          "hold_pr",
          "rerun_ci",
          "edit_card",
          "dismiss_item",
          "sync_main",
          "create_ticket",
          "comment_ticket",
          "close_ticket",
          "add_controller_check",
          "brief_item",
          "read_pr",
          "read_ci_log",
          "gh_read",
          "list_tickets",
          "update_brief",
          "draft_reply",
          "track",
          "untrack",
          "ledger",
          "remember",
          "forget",
          "recall",
          "hold_item",
          "release_hold",
          "edit_issue",
          "set_fields",
        ],
        here: "head agent: assigns, unblocks, brings you decisions",
      },
    });
    for (const [name, r] of Object.entries(BUILTIN_ROLES)) {
      expect(r.here).toBe(ROLES.find((x) => x.callSign === name)?.here);
    }
  });

  it("keeps the timeouts and seat states", () => {
    expect(CONTROL_TIMEOUT_MS).toBe(10_000);
    expect(STOP_GRACE_MS).toBe(10_000);
    expect(SEAT_STATES).toEqual(["idle", "starting", "running", "parked", "stopped", "error"]);
  });
});

describe("seatDef", () => {
  it("reads a built-in role", () => {
    expect(seatDef({ role: "GUIDO" })).toMatchObject({ mode: "writer", loop: "build" });
    expect(seatDef({ role: "RETRO" })).toMatchObject({ mode: "read-only", loop: "none" });
    expect(seatDef({ role: "FAO" })).toMatchObject({
      loop: "plan",
      mcTools: ["report_plan", "read_ticket"],
    });
  });

  it("scratch turns a read-only role into a reviewer, and leaves a writer", () => {
    expect(seatDef({ role: "RETRO", mode: "scratch" })).toMatchObject({
      mode: "scratch",
      loop: "review",
      mcTools: [],
    });
    expect(seatDef({ role: "GUIDO", mode: "scratch" })).toMatchObject({ mode: "writer" });
  });

  it("an unknown role is read-only with no loop and no tools", () => {
    expect(seatDef({ role: "X" })).toEqual({
      mode: "read-only",
      loop: "none",
      prompt: "roles/X.md",
      mcTools: [],
      here: "",
    });
  });

  it("returns a set def as it is", () => {
    const def = { mode: "scratch", loop: "review", prompt: "roles/Z.md", mcTools: [], here: "z" };
    expect(seatDef({ role: "GUIDO", def } as Parameters<typeof seatDef>[0])).toBe(def);
  });
});

describe("mc tool grants", () => {
  it("hold no git writes", () => {
    for (const g of Object.values(MC_TOOL_GRANTS)) {
      for (const t of ["commit", "push", "draft_pr"] as const) expect(g.grantable).not.toContain(t);
      for (const t of ["push", "draft_pr"] as const) expect(g.base).not.toContain(t);
    }
  });

  it("seats ask FLIGHT, never the operator: ask_flight in writer and read-only, no ask_operator anywhere (#758)", () => {
    expect(MC_TOOL_GRANTS.writer.base).toContain("ask_flight");
    expect(MC_TOOL_GRANTS["read-only"].base).toContain("ask_flight");
    // a scratch review answers with report_findings alone
    expect(MC_TOOL_GRANTS.scratch.base).not.toContain("ask_flight");
    expect(Object.values(MC_TOOL_NAMES)).not.toContain("ask_operator");
    for (const g of Object.values(MC_TOOL_GRANTS)) {
      expect([...g.base, ...g.grantable] as string[]).not.toContain("ask_operator");
    }
    for (const tools of [WRITER_TOOLS, READONLY_TOOLS, SCRATCH_TOOLS]) {
      expect(tools as readonly string[]).not.toContain("mcp__mc__ask_operator");
    }
  });

  it("watch is a read-only loop only", () => {
    expect(LOOP_KINDS).toContain("watch");
    for (const [mode, loops] of Object.entries(MODE_LOOPS)) {
      expect(loops.includes("watch"), mode).toBe(mode === "read-only");
    }
  });

  it("a read-only seat may be granted FLIGHT's tools, and no git write", () => {
    expect(FLIGHT_TOOLS).toEqual([
      "log_decision",
      "read_ticket",
      "answer_question",
      "start_seat",
      "message_seat",
      "comms_pin",
      "flight_state",
      "screenshot_hud",
      "promote",
      "end_run",
      "resume_seat",
      "accept_ruling",
      "merge_pr",
      "settle_park",
      "hold_pr",
      "rerun_ci",
      "edit_card",
      "dismiss_item",
      "sync_main",
      "create_ticket",
      "comment_ticket",
      "close_ticket",
      "add_controller_check",
      "brief_item",
      "read_pr",
      "read_ci_log",
      "gh_read",
      "list_tickets",
      "update_brief",
      "draft_reply",
      "track",
      "untrack",
      "ledger",
      "remember",
      "forget",
      "recall",
      "hold_item",
      "release_hold",
      "edit_issue",
      "set_fields",
    ]);
    expect(MC_TOOL_GRANTS["read-only"].grantable).toEqual(["report_plan", ...FLIGHT_TOOLS]);
    expect(MC_TOOL_GRANTS["read-only"].grantable).not.toContain("commit");
    expect(MC_TOOL_GRANTS.writer.grantable).toEqual([]);
    expect(MC_TOOL_GRANTS.writer.grantable).not.toContain("log_decision");
  });

  it("base is the mc tail of each mode's tool list", () => {
    const tail = (tools: readonly string[]) => tools.filter((t) => t.startsWith("mcp__mc__"));
    const named = (m: keyof typeof MC_TOOL_GRANTS) =>
      MC_TOOL_GRANTS[m].base.map((t) => `mcp__mc__${t}`);
    expect(named("writer")).toEqual(tail(WRITER_TOOLS));
    expect(named("read-only")).toEqual(tail(READONLY_TOOLS));
    expect(named("scratch")).toEqual(tail(SCRATCH_TOOLS));
  });

  it("crewCliArgs refuses an ungrantable tool", () => {
    expect(() => crewCliArgs({ ...base, mode: "read-only", mcTools: ["commit"] })).toThrow(
      "crew rules: commit cannot be granted to a read-only seat",
    );
  });
});

describe("modeOfSeat", () => {
  it("modeOfSeat: scratch only on a read-only role", () => {
    expect(modeOfSeat({ role: "RETRO" })).toBe("read-only");
    expect(modeOfSeat({ role: "RETRO", mode: "scratch" })).toBe("scratch");
    expect(modeOfSeat({ role: "GUIDO", mode: "scratch" })).toBe("writer");
  });
});

describe("scratch mode", () => {
  const scratch: CrewCliInput = {
    ...base,
    mode: "scratch",
    sandbox: { ...base.sandbox, cwd: "/w/retro-1-review-3" },
  };

  it("crewCliArgs for scratch", () => {
    const a = crewCliArgs(scratch);
    const allowed = a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"));
    expect(allowed).toContain("Edit(//w/retro-1-review-3/**)");
    expect(allowed).toContain("Write(//w/retro-1-review-3/**)");
    expect(allowed).toContain("Bash");
    expect(allowed).toContain("mcp__mc__report_findings");
    for (const t of [
      "mcp__mc__commit",
      "mcp__mc__ask_flight",
      "mcp__mc__report_evidence",
      "Bash(pnpm -s test:*)",
    ]) {
      expect(allowed).not.toContain(t);
    }
    expect(a[a.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Edit,Write,TodoWrite,Bash,Skill");
  });

  it("scratch allows exactly its tools, Edit and Write anchored to the worktree", () => {
    const a = crewCliArgs(scratch);
    expect(a.slice(a.indexOf("--allowedTools") + 1, a.indexOf("--disallowedTools"))).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Edit(//w/retro-1-review-3/**)",
      "Write(//w/retro-1-review-3/**)",
      "TodoWrite",
      "Bash",
      "Skill",
      "mcp__mc__report_findings",
      "mcp__mc__restore_file",
      "mcp__mc__comms_read",
      "mcp__mc__comms_inbox",
      "mcp__mc__comms_send",
      "mcp__mc__comms_react",
    ]);
  });

  it("scratch keeps the denied tools and the protected-file rules", () => {
    const a = crewCliArgs(scratch);
    expect(
      a.slice(a.indexOf("--disallowedTools") + 1, a.indexOf("--append-system-prompt-file")),
    ).toEqual([...DENIED_TOOLS, ...protectedFileRules("/w/retro-1-review-3")]);
    expect(protectedFileRules("/w/retro-1-review-3").length).toBeGreaterThan(0);
  });

  it("scratch sandbox writes like a writer", () => {
    const deny = (mode: "writer" | "scratch") =>
      JSON.parse(crewSandboxSettings(scratch.sandbox, mode, base.hook)).sandbox.filesystem
        .denyWrite;
    expect(deny("scratch")).toEqual(deny("writer"));
  });
});

describe("crew sandbox and scoped edits", () => {
  it("denies the shared temp parent and sibling runs, allowing only the seat's own root", () => {
    for (const mode of ["writer", "read-only", "scratch"] as const) {
      for (const parent of ["/tmp/mc-runs", "/private/tmp/mc-runs", "/custom/temp/mc-runs"]) {
        const tempRoot = `${parent}/mc-own-run`;
        const siblingRoot = `${parent}/mc-other-run`;
        const f = JSON.parse(crewSandboxSettings({ ...base.sandbox, tempRoot }, mode, base.hook))
          .sandbox.filesystem;
        expect(f.denyRead).toContain(parent);
        expect(
          f.denyRead.some((p: string) => siblingRoot === p || siblingRoot.startsWith(`${p}/`)),
        ).toBe(true);
        expect(f.allowRead).toEqual([tempRoot, base.sandbox.pnpmStoreDir]);
        expect(f.denyRead).not.toContain("/tmp");
        expect(f.denyRead).not.toContain("/private/tmp");
      }
    }
  });

  it("keeps a checkout and both git dirs under /tmp readable in every mode", () => {
    for (const mode of ["writer", "read-only", "scratch"] as const) {
      for (const parent of ["/tmp", "/private/tmp", "/tmp/mc-runs"]) {
        const sandbox = {
          ...base.sandbox,
          tempRoot: `${parent.endsWith("/mc-runs") ? parent : `${parent}/mc-runs`}/mc-own-run`,
          cwd: `${parent}/crew/worktree`,
          gitCommonDir: `${parent}/crew/clone/.git`,
          worktreeGitDir: `${parent}/crew/clone/.git/worktrees/seat`,
        };
        const f = JSON.parse(crewSandboxSettings(sandbox, mode, base.hook)).sandbox.filesystem;
        for (const path of [sandbox.cwd, sandbox.gitCommonDir, sandbox.worktreeGitDir]) {
          if (parent.endsWith("/mc-runs")) expect(f.allowRead).toContain(path);
          else
            expect(
              f.denyRead.some((denied: string) => path === denied || path.startsWith(`${denied}/`)),
            ).toBe(false);
        }
      }
    }
  });

  it("isolates the run temp root from the operator's Claude sessions in every mode", () => {
    for (const mode of ["writer", "read-only", "scratch"] as const) {
      const tempRoot = "/tmp/mc-runs/seat-test";
      const f = JSON.parse(crewSandboxSettings({ ...base.sandbox, tempRoot }, mode, base.hook))
        .sandbox.filesystem;
      expect(f.allowWrite).toEqual([tempRoot]);
      expect(f.allowRead).toEqual([tempRoot, base.sandbox.pnpmStoreDir]);
      expect(f.denyRead).toContain("/tmp/claude-*");
      expect(f.denyRead).toContain("/private/tmp/claude-*");
      expect(f.denyWrite).toContain(`${"/tmp/mc-runs/seat-test"}/tool-output`);
      expect(f.denyWrite).toContain("/tmp/claude-*");
      expect(f.denyWrite).toContain("/private/tmp/claude-*");
    }
  });

  it.each(["writer", "read-only", "scratch"] as const)(
    "lets a %s seat read but never write the hub-owned pnpm store",
    (mode) => {
      const store = "/mc/crew/.mc-pnpm-store/shared";
      const f = JSON.parse(
        crewSandboxSettings(
          { ...base.sandbox, tempRoot: "/tmp/mc-runs/seat-test", pnpmStoreDir: store },
          mode,
          base.hook,
        ),
      ).sandbox.filesystem;
      expect(f.allowRead).toContain(store);
      expect(f.allowWrite).not.toContain(store);
      expect(f.denyWrite).toContain(store);
    },
  );

  it("builds the sandbox settings JSON: no git dir writable, the whole clone's .git denied", () => {
    const j = JSON.parse(crewSandboxSettings(base.sandbox, "writer", base.hook));
    expect(j.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [] },
    });
    // commits are the hub's (the mc commit tool): nothing in either git dir is granted (#31 R19/R24)
    expect(j.sandbox.filesystem.allowWrite).toEqual([]);
    expect(j.sandbox.filesystem.denyWrite).toEqual([
      "/mc/wt/guido-1/.git",
      "/mc/clone/.git",
      "/mc/clone/.git/worktrees/guido-1",
      "/home/you/.local/share/mission-control",
      base.sandbox.pnpmStoreDir,
    ]);
  });

  it("allows no write under either git dir, in any mode", () => {
    for (const mode of ["writer", "read-only"] as const) {
      const f = JSON.parse(crewSandboxSettings(base.sandbox, mode, base.hook)).sandbox.filesystem;
      for (const p of f.allowWrite as string[]) {
        expect(p.startsWith("/mc/clone/.git")).toBe(false);
        expect(p.startsWith("/mc/wt/guido-1/.git")).toBe(false);
      }
      expect(f.denyWrite).toContain("/mc/clone/.git");
      expect(f.denyWrite).toContain("/mc/clone/.git/worktrees/guido-1");
      // the token, MCP, prompt and transcript files: no seat rewrites them, whatever the grants
      expect(f.denyWrite).toContain("/home/you/.local/share/mission-control");
    }
  });

  it("grants no Unix socket inside the hub's data dir, in any mode", () => {
    // a keeper's socket lives there: a seat that could connect to it could drive any seat's CLI
    for (const mode of ["writer", "read-only"] as const) {
      const j = JSON.parse(crewSandboxSettings(base.sandbox, mode, base.hook)).sandbox;
      const sockets = [
        ...((j.network?.allowUnixSockets as string[] | undefined) ?? []),
        ...((j.allowUnixSockets as string[] | undefined) ?? []),
      ];
      for (const p of sockets) {
        expect(p.startsWith(base.sandbox.dataDir)).toBe(false);
      }
      expect(JSON.stringify(j)).not.toContain("allowUnixSockets");
    }
  });

  it("turns off auto-allow for sandboxed Bash, so the sandbox never widens the allowlist", () => {
    for (const mode of ["writer", "read-only"] as const) {
      expect(
        JSON.parse(crewSandboxSettings(base.sandbox, mode, base.hook)).sandbox
          .autoAllowBashIfSandboxed,
      ).toBe(false);
    }
  });

  it("a read-only seat gets no allowWrite, and its worktree and both git dirs are denyWrite", () => {
    const f = JSON.parse(crewSandboxSettings(base.sandbox, "read-only", base.hook)).sandbox
      .filesystem;
    expect(f.allowWrite).toEqual([]);
    expect(f.denyWrite).toEqual([
      "/mc/wt/guido-1",
      "/mc/clone/.git",
      "/mc/clone/.git/worktrees/guido-1",
      "/home/you/.local/share/mission-control",
      base.sandbox.pnpmStoreDir,
    ]);
  });

  it("registers the guard hook: every tool before it runs, Bash after it ends (Task 1's shape)", () => {
    for (const mode of ["writer", "read-only"] as const) {
      const j = JSON.parse(crewSandboxSettings(base.sandbox, mode, base.hook));
      const entry = (matcher: string) => [
        { matcher, hooks: [{ type: "command", command: base.hook.command, timeout: 630 }] },
      ];
      expect(j.hooks).toEqual({
        PreToolUse: entry("*"),
        PostToolUse: entry("Bash"),
        PostToolUseFailure: entry("Bash"),
      });
      expect(Object.keys(j.hooks)).toEqual([...GUARD_HOOK_EVENTS]);
    }
  });

  it("adds the trim hook after every tool's call, beside the Bash one, when given", () => {
    const trim = { command: "trim-cmd", timeoutS: 10 };
    const j = JSON.parse(crewSandboxSettings(base.sandbox, "writer", { ...base.hook, trim }));
    expect(j.hooks.PostToolUse).toEqual([
      { matcher: "Bash", hooks: [{ type: "command", command: base.hook.command, timeout: 630 }] },
      { matcher: "*", hooks: [{ type: "command", command: "trim-cmd", timeout: 10 }] },
    ]);
    expect(j.hooks.PreToolUse).toHaveLength(1);
    expect(j.hooks.PostToolUseFailure).toHaveLength(1);
  });

  it("denies reading credential folders and the hub's data dir, in every mode", () => {
    for (const mode of ["writer", "read-only"] as const) {
      expect(
        JSON.parse(crewSandboxSettings(base.sandbox, mode, base.hook)).sandbox.filesystem.denyRead,
      ).toEqual([
        "/home/you/.ssh",
        "/home/you/.config/gh",
        "/home/you/.config/mission-control",
        "/home/you/.aws",
        "/home/you/.netrc",
        "/home/you/.gnupg",
        "/home/you/.git-credentials",
        "/home/you/.config/git/credentials",
        "/home/you/.npmrc",
        "/home/you/.docker",
        "/home/you/.kube",
        "/home/you/.claude",
        "/home/you/.claude.json",
        "/home/you/.codex",
        "/home/you/.config/gcloud",
        "/home/you/.azure",
        "/home/you/.config/op",
        "/home/you/.pypirc",
        "/home/you/.cargo/credentials.toml",
        "/home/you/.gem/credentials",
        "/home/you/.vault-token",
        "/home/you/.terraform.d",
        "/home/you/.copilot",
        "/home/you/.zsh_history",
        "/home/you/.bash_history",
        "/home/you/Library/Keychains",
        // the DB, and every seat's transcripts and prompt files
        "/home/you/.local/share/mission-control",
      ]);
    }
  });

  it("adds the granted-folder denials after the credential ones, in order and deduped", () => {
    const denyRead = [
      "/Users/you/code/mission-control",
      "/Users/you/code/.shop-app-autonomy",
      "/Users/you/code/mission-control",
      "/Users/you/Work",
      "/home/you/.ssh",
    ];
    for (const mode of ["writer", "read-only"] as const) {
      const f = JSON.parse(crewSandboxSettings({ ...base.sandbox, denyRead }, mode, base.hook))
        .sandbox.filesystem;
      expect(f.denyRead.slice(-4)).toEqual([
        "/home/you/.local/share/mission-control",
        "/Users/you/code/mission-control",
        "/Users/you/code/.shop-app-autonomy",
        "/Users/you/Work",
      ]);
      expect(new Set(f.denyRead).size).toBe(f.denyRead.length);
      expect(f.denyRead.filter((p: string) => p === "/home/you/.ssh")).toHaveLength(1);
    }
  });

  it("refuses a relative granted-folder denial", () => {
    for (const bad of ["Work", "~/Work", ""]) {
      expect(() =>
        crewSandboxSettings({ ...base.sandbox, denyRead: ["/ok", bad] }, "writer", base.hook),
      ).toThrow("crew sandbox: denyRead must be absolute");
    }
  });

  it("refuses a relative cwd, home, git dir or data dir", () => {
    for (const bad of [
      { cwd: "wt/guido-1" },
      { home: "~" },
      { home: "" },
      { gitCommonDir: "clone/.git" },
      { worktreeGitDir: ".git/worktrees/guido-1" },
      { dataDir: "mc-data" },
      { dataDir: "" },
    ]) {
      expect(() => crewSandboxSettings({ ...base.sandbox, ...bad }, "writer", base.hook)).toThrow(
        "must be absolute",
      );
    }
  });

  it("passes the sandbox and the hook as --settings", () => {
    const a = crewCliArgs(base);
    expect(a[a.indexOf("--settings") + 1]).toBe(
      crewSandboxSettings(base.sandbox, "writer", base.hook),
    );
  });

  it("scopes Edit and Write to the area globs, anchored to the worktree", () => {
    const scoped = crewCliArgs({ ...base, area: ["apps/server/**", "packages/core/**"] });
    for (const g of ["apps/server/**", "packages/core/**"]) {
      expect(scoped).toContain(`Edit(//mc/wt/guido-1/${g})`);
      expect(scoped).toContain(`Write(//mc/wt/guido-1/${g})`);
      // a relative rule would follow a `cd` in Bash (#41)
      expect(scoped).not.toContain(`Edit(${g})`);
    }
    expect(scoped).not.toContain("Edit");
    expect(scoped).not.toContain("Write");
    expect(scoped).toContain("Read");
  });

  it("gives a whole-checkout writer the worktree, anchored, not a bare Edit", () => {
    const a = crewCliArgs(base);
    expect(a).toContain("Edit(//mc/wt/guido-1/**)");
    expect(a).toContain("Write(//mc/wt/guido-1/**)");
    expect(a).not.toContain("Edit");
    expect(a).not.toContain("Write");
  });

  it("denies Edit and Write on build, CI and config files in every mode", () => {
    for (const f of [
      "**/package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "**/vite.config.*",
      "**/vitest.config.*",
      "biome.json",
      "**/tsconfig*.json",
      ".github/**",
      ".husky/**",
      ".claude/**",
      ".git",
      "**/.git",
      ".npmrc",
      "**/.npmrc",
      ".pnpmfile.cjs",
      "**/.pnpmfile.cjs",
      ".gitattributes",
      "**/.gitattributes",
    ]) {
      for (const mode of ["writer", "read-only"] as const) {
        const a = crewCliArgs({ ...base, mode });
        const deniedAt = a.indexOf("--disallowedTools");
        expect(a.indexOf(`Edit(//mc/wt/guido-1/${f})`)).toBeGreaterThan(deniedAt);
        expect(a.indexOf(`Write(//mc/wt/guido-1/${f})`)).toBeGreaterThan(deniedAt);
      }
      expect(protectedFileRules("/mc/wt/guido-1")).toContain(`Edit(//mc/wt/guido-1/${f})`);
      // never relative: it would shift with a `cd` (#41)
      expect(crewCliArgs(base)).not.toContain(`Edit(${f})`);
    }
  });
});

describe("branchFor", () => {
  it("slugs the title and cuts it at a word boundary", () => {
    expect(branchFor(42, "Fix: the Stop race!")).toBe("feature/42-fix-the-stop-race");
    expect(branchFor(7, "Make the supervisor reattach every active run after a hub restart")).toBe(
      "feature/7-make-the-supervisor-reattach-every",
    );
    expect(branchFor(9, "!!! ")).toBe("feature/9");
    expect(branchFor(9, "")).toBe("feature/9");
    // one word longer than the cut has no boundary: cut at 40 characters
    expect(branchFor(7, "x".repeat(60))).toBe(`feature/7-${"x".repeat(40)}`);
  });
});

describe("areaOwnsFolder", () => {
  it("a whole-checkout writer owns every folder; a glob owns the folder it is rooted in", () => {
    expect(areaOwnsFolder([], "docs")).toBe(true);
    expect(areaOwnsFolder(["apps/**"], "apps")).toBe(true);
    expect(areaOwnsFolder(["apps/web/**"], "apps")).toBe(true);
    expect(areaOwnsFolder(["apps/**"], "docs")).toBe(false);
    expect(areaOwnsFolder(["**/*.md"], "docs")).toBe(false);
    expect(areaOwnsFolder(["ap*/**"], "apps")).toBe(false);
    expect(areaOwnsFolder(["*"], "apps")).toBe(false);
  });
});

describe("globMatches, pathInArea and isProtectedPath", () => {
  it.each([
    ["apps/**", "apps/a.ts", true],
    ["apps/**", "apps/x/y/a.ts", true],
    ["apps/**", "apps", false],
    ["apps/**", "appsx/a.ts", false],
    ["apps/**", "web/apps/a.ts", false],
    ["apps", "apps/a.ts", true],
    ["apps", "apps", true],
    ["apps", "apps2/a.ts", false],
    ["apps/web/**", "apps/web/src/a.tsx", true],
    ["apps/web/**", "apps/server/a.ts", false],
    ["*.md", "README.md", true],
    ["*.md", "docs/README.md", false],
    ["**/*.md", "docs/README.md", true],
    ["**/*.md", "README.md", true],
    ["ap*/**", "apps/a.ts", true],
    ["ap*/**", "web/a.ts", false],
    ["docs/**/x.md", "docs/x.md", true],
    ["docs/**/x.md", "docs/a/b/x.md", true],
    ["a.b", "axb", false],
    ["**", "anything/at/all", true],
  ])("%s matches %s: %s", (glob, path, want) => {
    expect(globMatches(glob, path)).toBe(want);
  });

  it.each([
    ["\u017f", "s"],
    ["\u212a", "k"],
    ["\u00df", "ss"],
    ["\ufb06", "st"],
    ["Package.JSON", "package.json"],
    // fullwidth: case mapping keeps it fullwidth; only NFKC makes it ASCII
    ["\uff50ackage.json", "package.json"],
  ])("folds %s to %s before matching a protected name", (from, to) => {
    expect(foldForMatch(from)).toBe(to);
  });

  it("matches case-sensitively unless asked not to", () => {
    expect(globMatches("apps/**", "Apps/a.ts")).toBe(false);
    expect(globMatches("apps/**", "Apps/a.ts", true)).toBe(true);
    expect(pathInArea(["apps/**"], "APPS/a.ts")).toBe(false);
  });

  it("no area is the whole checkout; otherwise any glob", () => {
    expect(pathInArea([], "x/y")).toBe(true);
    expect(pathInArea(["apps/**", "docs/**"], "docs/a.md")).toBe(true);
    expect(pathInArea(["apps/**"], "docs/a.md")).toBe(false);
  });

  it.each([
    ["package.json", true],
    ["apps/web/package.json", true],
    ["pnpm-lock.yaml", true],
    ["apps/pnpm-lock.yaml", true],
    ["biome.json", true],
    ["apps/biome.jsonc", true],
    ["apps/web/vite.config.ts", true],
    ["vitest.config.ts", true],
    ["tsconfig.json", true],
    ["apps/server/tsconfig.build.json", true],
    [".github/workflows/ci.yml", true],
    ["apps/.github/x", true],
    [".husky/pre-commit", true],
    [".claude/settings.json", true],
    [".npmrc", true],
    [".pnpmfile.cjs", true],
    [".gitattributes", true],
    ["apps/.gitattributes", true],
    [".claude", true],
    ["apps/.claude", true],
    ["apps/.github", true],
    [".husky", true],
    ["apps/x/Package.json", true],
    ["Vitest.config.ts", true],
    [".NPMRC", true],
    ["PNPM-LOCK.yaml", true],
    [".gitmodules", true],
    ["apps/.gitmodules", true],
    ["apps/x/package.j\u017fon", true],
    [".hu\u017fky/pre-commit", true],
    [".hus\u212ay/pre-commit", true],
    ["apps/vite\ufb06.config.ts", true],
    ["apps/\uff50ackage.json", true],
    ["apps/a.ts", false],
    ["apps/.claudex", false],
    ["docs/package.json.md", false],
    [".gitignore", false],
    ["README.md", false],
  ])("%s is protected: %s", (path, want) => {
    expect(isProtectedPath(path)).toBe(want);
  });

  it("names a seat's commits after its call sign", () => {
    expect(crewAuthorName("GUIDO-1")).toBe("GUIDO-1 (Mission Control)");
  });
});

describe("the read-only text", () => {
  it("is one string: the guard rule and the commit tool's refusal both build on it", () => {
    expect(GUARD_RULES["read-only"]).toBe(READ_ONLY_CANNOT_WRITE);
    expect(MC_READ_ONLY_COMMIT).toBe(`${READ_ONLY_CANNOT_WRITE}: commit is for writer seats.`);
  });
});

describe("skill files a seat's plugin may carry (#1051)", () => {
  const ok = (path: string, text = "# Skill\n", mode = "100644") =>
    skillFileProblem(path, mode, Buffer.from(text));

  it("takes SKILL.md and plain text files under a skill's folder", () => {
    expect(SKILLS_DIR).toBe(".claude/skills");
    expect(ok(".claude/skills/hud-design/SKILL.md")).toBeNull();
    expect(ok(".claude/skills/hud-design/notes/checklist.md")).toBeNull();
    expect(ok(".claude/skills/plain-talk/examples.txt")).toBeNull();
    expect(ok(".claude/skills/x/data.json", "{}")).toBeNull();
  });

  it.each([
    ["a script", ".claude/skills/x/run.sh", "#!/bin/sh\n", "100644"],
    ["an executable bit", ".claude/skills/x/notes.md", "hi", "100755"],
    ["a symlink", ".claude/skills/x/notes.md", "../../../etc/passwd", "120000"],
    ["a submodule", ".claude/skills/x", "", "160000"],
    ["a binary", ".claude/skills/x/pic.md", "a\u0000b", "100644"],
    ["bytes that are not UTF-8", ".claude/skills/x/n.txt", "\ufffd", "100644"],
    ["a loose file", ".claude/skills/README.md", "hi", "100644"],
    ["a hidden folder", ".claude/skills/x/.hooks/SKILL.md", "hi", "100644"],
    ["a path outside skills", ".claude/settings.json", "{}", "100644"],
    ["a dot-dot step", ".claude/skills/x/../y/SKILL.md", "hi", "100644"],
  ])("refuses %s", (_what, path, text, mode) => {
    const raw = text === "\ufffd" ? Buffer.from([0xff, 0xfe]) : Buffer.from(text);
    expect(skillFileProblem(path, mode, raw)).toEqual(expect.any(String));
  });

  it("refuses a file over the size cap", () => {
    const big = Buffer.alloc(SKILL_FILE_MAX + 1, "a");
    expect(skillFileProblem(".claude/skills/x/SKILL.md", "100644", big)).toMatch(/too big/);
  });

  it("the plugin manifest names the repo and carries nothing executable", () => {
    const m = JSON.parse(skillPluginManifest("Luke-Bradford/mission-control"));
    expect(m).toEqual({
      name: "mission-control",
      description: "Skills from Luke-Bradford/mission-control's .claude/skills",
    });
    expect(JSON.parse(skillPluginManifest("My Repo!!")).name).toBe("my-repo");
    expect(JSON.parse(skillPluginManifest("///")).name).toBe("repo");
  });
});
