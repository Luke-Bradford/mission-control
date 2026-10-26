import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CrewMode,
  type CrewSandboxInput,
  codexLineCommands,
  crewCliArgs,
  DEFAULT_SEAT_COMMANDS,
  GUARD_HOOK_TIMEOUT_S,
  SANDBOX_DENY_READ_HOME,
  type SeatCommands,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexApproval,
  codexCommandAllowed,
  codexEditAllowed,
  codexReadAllowed,
  codexSeatConfig,
  codexVersionAllowed,
} from "../src/runtime/codex-floor.ts";

const sandboxInput: CrewSandboxInput = {
  cwd: "/mc/wt/guido-1",
  gitCommonDir: "/mc/clone/.git",
  worktreeGitDir: "/mc/clone/.git/worktrees/guido-1",
  home: "/home/you",
  dataDir: "/home/you/.local/share/mission-control",
  denyRead: [],
};

/** Read the actual CLI rules, including configured commands and deny precedence. */
function claudeBashAllowed(
  argv: readonly string[],
  mode: CrewMode,
  commands: SeatCommands,
): boolean {
  const args = crewCliArgs({
    mode,
    commands,
    model: "sonnet",
    rolePromptFile: "/mc/roles/GUIDO.md",
    sessionId: "11111111-2222-4333-8444-555555555555",
    resume: false,
    area: [],
    sandbox: sandboxInput,
    mcpConfigFile: "/mc/mcp.json",
    hook: { command: "/mc/guard", timeoutS: GUARD_HOOK_TIMEOUT_S },
  });
  const allowed = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--disallowedTools"));
  const denied = args.slice(
    args.indexOf("--disallowedTools") + 1,
    args.indexOf("--append-system-prompt-file"),
  );
  const matches = (argv: readonly string[], entry: string) => {
    const pattern = /^Bash\((.*)\)$/.exec(entry)?.[1];
    if (pattern === undefined) return false;
    const command = argv.join(" ");
    if (pattern.endsWith(":*")) {
      const prefix = pattern.slice(0, -2);
      return command === prefix || command.startsWith(`${prefix} `);
    }
    return pattern.endsWith("*") ? command.startsWith(pattern.slice(0, -1)) : command === pattern;
  };
  return (
    !denied.some((entry) => matches(argv, entry)) && allowed.some((entry) => matches(argv, entry))
  );
}

interface ReferenceSegment {
  argv: readonly string[];
  piped: boolean;
}

// These are explicit argv fixtures, never parsed from the command under test.
const segment = (words: string | readonly string[], piped = false): ReferenceSegment => ({
  argv: typeof words === "string" ? words.split(" ") : words,
  piped,
});

/** The fixture's confined paths, independent of production filesystem resolution. */
const PARITY_READ_PATHS = new Set(["apps", "apps/web/a.ts", "docs/runbook.md", "inside/a.ts", "x"]);

// The controller's read forms for this table. This oracle imports no production read validators.
const REFERENCE_READ_FORMS = [
  ["pwd", 0],
  ["cat", Infinity],
  ["rg foo", Infinity],
  ["rg --files", Infinity],
  [["rg", "-n", "-C", "2", "Codex|crew seat"], Infinity],
  ["head -n 40", Infinity],
  ["head", Infinity],
  ["tail -n 5", Infinity],
  ["tail", Infinity],
  ["wc -l", Infinity],
  ["wc", Infinity],
  ["sort -k 1,1 -t :", Infinity],
  ["sort", Infinity],
  ["uniq -f 1", 1],
  ["uniq -c", 1],
  ["uniq", 1],
  ["cut -d : -f 1", Infinity],
  ["cut -c 1-20", Infinity],
  ["grep web", Infinity],
] as const;

function referenceAllowed(segments: readonly ReferenceSegment[] | null, mode: CrewMode): boolean {
  if (segments === null) return false;
  return segments.every(({ argv, piped }, index) => {
    const forms = REFERENCE_READ_FORMS.map(([prefix, maxPaths]) => ({
      words: typeof prefix === "string" ? prefix.split(" ") : prefix,
      maxPaths,
    })).filter(({ words }) => words[0] === argv[0]);
    if (forms.length > 0)
      return forms.some(({ words, maxPaths }) => {
        if (!words.every((word, n) => argv[n] === word)) return false;
        const paths = argv.slice(words.length);
        return (
          paths.length <= maxPaths &&
          paths.every((path) => path === "-" || PARITY_READ_PATHS.has(path))
        );
      });
    if (!claudeBashAllowed(argv, mode, DEFAULT_SEAT_COMMANDS)) return false;
    if (
      argv[0] === "git" &&
      argv[1] === "diff" &&
      (argv.includes("--no-index") ||
        argv.some((a) => a === "--output" || a.startsWith("--output=")))
    )
      return false;
    if (!piped && !segments[index + 1]?.piped) return true;
    if (argv[0] === "git") {
      return argv
        .slice(2)
        .every((word) =>
          [
            "--short",
            "--stat",
            "--oneline",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "main",
            "HEAD~1..HEAD",
          ].includes(word),
        );
    }
    return false;
  });
}

describe("codexSeatConfig", () => {
  const url = "http://127.0.0.1:7420/mcp";
  const tmp = "/tmp/claude-501/seat-1";

  it("writes the isolated profile, MCP auth and command environment", () => {
    const config = codexSeatConfig(sandboxInput, "writer", url, tmp);
    expect(config).toContain('approvals_reviewer = "user"');
    expect(config).toContain("project_doc_max_bytes = 0");
    // codex-cli 0.154.0 generate-json-schema: Config.web_search → WebSearchMode.disabled.
    // Config permits extra keys; features.unified_exec is listed but false does not take effect
    // on 0.154.0. Keep the harmless key; refusing & and declining writeStdin enforce the floor.
    expect(config).toContain('web_search = "disabled"');
    expect(config).toContain("[features]\nunified_exec = false\nshell_snapshot = false");
    expect(config).toContain('[shell_environment_policy]\nexclude = ["MC_SEAT_TOKEN"]');
    expect(config).toContain(`[mcp_servers.mc]\nurl = "${url}"`);
    expect(config).toContain('bearer_token_env_var = "MC_SEAT_TOKEN"');
    expect(config).toContain('default_permissions = "mc_seat"');
    expect(config).toContain('[permissions.mc_seat.filesystem]\n":root"="read"');
    for (const path of SANDBOX_DENY_READ_HOME) {
      expect(config).toContain(`"/home/you/${path}"="deny"`);
    }
    expect(config).toContain(`"${sandboxInput.dataDir}"="deny"`);
    expect(config).toContain(`"${tmp}"="write"`);
    expect(config).toContain(
      '[permissions.mc_seat.filesystem.":workspace_roots"]\n"."="write"\n".git"="read"',
    );
    expect(config).toContain("[permissions.mc_seat.network]\nenabled = false");
    expect(config).not.toMatch(/notify|network_proxy|sandbox_mode|dangerously/);
  });

  it("keeps the read-only workspace read-only", () => {
    const config = codexSeatConfig(sandboxInput, "read-only", url, tmp);
    expect(config).toContain('"."="read"');
    expect(config).toContain(`"${tmp}"="write"`);
    expect(config).not.toContain('"."="write"');
  });

  it("lets a scratch seat write its throwaway worktree", () => {
    expect(codexSeatConfig(sandboxInput, "scratch", url, tmp)).toContain('"."="write"');
  });

  it.each(["writer", "read-only", "scratch"] as const)(
    "explicitly keeps both git dirs read-only for %s",
    (mode) => {
      const sandbox = {
        ...sandboxInput,
        gitCommonDir: `${tmp}/clone/.git`,
        worktreeGitDir: `${tmp}/clone/.git/worktrees/seat`,
      };
      const config = codexSeatConfig(sandbox, mode, url, `${tmp}/temp`);
      expect(config).toContain(`"${sandbox.gitCommonDir}"="read"`);
      expect(config).toContain(`"${sandbox.worktreeGitDir}"="read"`);
    },
  );

  it.each([
    "/",
    "/home",
    sandboxInput.home,
    "/mc",
    sandboxInput.cwd,
    sandboxInput.gitCommonDir,
    sandboxInput.worktreeGitDir,
    "/mc/clone",
    "/mc/clone/.git/worktrees",
    "/tmp/..",
  ])("rejects a temp dir containing a seat or operator path: %s", (tmpDir) => {
    expect(() => codexSeatConfig(sandboxInput, "writer", url, tmpDir)).toThrow();
  });

  it("includes additional denies once", () => {
    const config = codexSeatConfig(
      { ...sandboxInput, denyRead: ["/other", "/other"] },
      "writer",
      url,
      tmp,
    );
    expect(config.match(/"\/other"="deny"/g)).toHaveLength(1);
  });

  it.each(['"', "\\", "\0", "\n", "\r", "\t", "\u001f", "\u007f"])(
    "rejects unsafe TOML characters %j",
    (c) => {
      expect(() =>
        codexSeatConfig({ ...sandboxInput, denyRead: [`/other${c}`] }, "writer", url, tmp),
      ).toThrow();
      expect(() => codexSeatConfig(sandboxInput, "writer", `${url}${c}`, tmp)).toThrow();
      expect(() => codexSeatConfig(sandboxInput, "writer", url, `${tmp}${c}`)).toThrow();
    },
  );

  it.each([
    "relative",
    "/home/you/.ssh/seat",
    "/home/you/.ssh",
    `${sandboxInput.dataDir}/tmp`,
    "/other/tmp",
  ])("rejects relative or denied temp dir %s", (tmpDir) => {
    expect(() =>
      codexSeatConfig({ ...sandboxInput, denyRead: ["/other"] }, "writer", url, tmpDir),
    ).toThrow();
  });
});
describe("Codex seat floor", () => {
  let root: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mc-codex-guard-"));
    cwd = join(root, "worktree");
    mkdirSync(join(cwd, "apps/web"), { recursive: true });
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(cwd, "escape"));
    symlinkSync(join(root, "missing"), join(cwd, "dangling"));
    symlinkSync(join(cwd, "apps/web"), join(cwd, "inside"));
    writeFileSync(join(cwd, "apps/web/a.ts"), "");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const request = (params: Record<string, unknown>) => ({
    method: "item/commandExecution/requestApproval",
    params,
  });

  it("maps command approvals and every file-change path", () => {
    const params = {
      kind: "command",
      command: "/bin/zsh -lc ls",
      cwd,
      environmentId: "local",
      proposedExecpolicyAmendment: ["ls"],
    };
    expect(codexApproval(request(params), undefined, { cwd })).toEqual([
      { tool: "Bash", input: { command: "ls" } },
    ]);
    expect(
      codexApproval(
        request({ ...params, cwd: join(cwd, "apps"), environmentId: null }),
        undefined,
        { cwd },
      ),
    ).not.toBeNull();
    expect(
      codexApproval(
        { method: "item/fileChange/requestApproval", params: { grantRoot: null } },
        ["apps/web/a.ts", "apps/web/b.ts"],
        { cwd },
      ),
    ).toEqual([
      { tool: "Edit", input: { file_path: "apps/web/a.ts" } },
      { tool: "Edit", input: { file_path: "apps/web/b.ts" } },
    ]);
  });

  it("declines malformed, nonlocal, network and non-command approvals", () => {
    const params = { kind: "command", command: "/bin/zsh -lc ls", cwd };
    for (const patch of [
      { kind: "writeStdin" },
      { kind: undefined },
      { command: null },
      { networkApprovalContext: {} },
      { environmentId: "remote" },
      { cwd: root },
      { cwd: join(cwd, "escape") },
      { cwd: join(cwd, "missing") },
      { proposedExecpolicyAmendment: ["pwd"] },
      { proposedExecpolicyAmendment: "ls" },
    ])
      expect(codexApproval(request({ ...params, ...patch }), undefined, { cwd })).toBeNull();
    for (const params of [null, [], "x", 1]) {
      expect(
        codexApproval({ method: "item/commandExecution/requestApproval", params }, undefined, {
          cwd,
        }),
      ).toBeNull();
    }
    expect(
      codexApproval(
        { method: "item/fileChange/requestApproval", params: { grantRoot: cwd } },
        ["a.ts"],
        { cwd },
      ),
    ).toBeNull();
    expect(
      codexApproval(
        { method: "item/fileChange/requestApproval", params: { grantRoot: null } },
        undefined,
        { cwd },
      ),
    ).toBeNull();
    for (const method of [
      "item/permissions/requestApproval",
      "item/tool/requestUserInput",
      "mcpServer/elicitation/request",
      "applyPatchApproval",
      "execCommandApproval",
      "unknown",
    ]) {
      expect(codexApproval({ method, params: {} }, [], { cwd })).toBeNull();
    }
  });

  it("accepts an omitted grantRoot but declines an empty file-change list", () => {
    const req = { method: "item/fileChange/requestApproval", params: {} };
    expect(codexApproval(req, ["apps/web/a.ts"], { cwd })).toEqual([
      { tool: "Edit", input: { file_path: "apps/web/a.ts" } },
    ]);
    expect(codexApproval(req, [], { cwd })).toBeNull();
    expect(codexApproval({ ...req, params: { grantRoot: null } }, [], { cwd })).toBeNull();
  });

  it.each(["rg", "grep"])(
    "checks every %s positional when a later option supplies the pattern",
    (program) => {
      for (const option of [
        "-e .",
        "--regexp .",
        "--regexp=.",
        "-e.",
        "-e=.",
        "-ie .",
        "-ie.",
        "-ie=.",
        "-f apps/web/a.ts",
        "--file apps/web/a.ts",
        "--file=apps/web/a.ts",
        "-fapps/web/a.ts",
        "-if apps/web/a.ts",
        "-ifapps/web/a.ts",
        "-f=patterns",
        "-if=patterns",
      ]) {
        for (const path of ["../x", "/etc/passwd", "../x __proto__", "../x constructor"]) {
          const script = `${program} ${path} ${option}`;
          expect(
            codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd),
            script,
          ).toBe(false);
        }
        const script = `${program} apps/web/a.ts ${option}`;
        expect(codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd), script).toBe(
          true,
        );
      }
      expect(
        codexCommandAllowed(
          `${program} /etc/passwd -e root`,
          "writer",
          DEFAULT_SEAT_COMMANDS,
          cwd,
          cwd,
        ),
      ).toBe(false);
      expect(
        codexCommandAllowed(
          `${program} -- ../pattern -e`,
          "writer",
          DEFAULT_SEAT_COMMANDS,
          cwd,
          cwd,
        ),
      ).toBe(true);
    },
  );

  it("distinguishes option values from options in the pattern pre-scan", () => {
    expect(
      codexCommandAllowed("rg -g -e ../pattern apps", "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd),
    ).toBe(true);
    expect(
      codexCommandAllowed(
        "rg -g --files ../pattern apps",
        "writer",
        DEFAULT_SEAT_COMMANDS,
        cwd,
        cwd,
      ),
    ).toBe(true);
  });

  it("resolves relative reads from the approval cwd and confines every command to the root", () => {
    const approvalCwd = join(cwd, "apps/web");
    symlinkSync(join(root, "outside"), join(approvalCwd, "escape"));
    for (const script of ["cat a.ts", "cat ../web/a.ts", "rg . ../../apps", "rg -f a.ts ."]) {
      expect(
        codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, approvalCwd, cwd),
        script,
      ).toBe(true);
    }
    for (const script of [
      "cat escape/secret",
      "cat ../../../outside/secret",
      "rg -f escape/patterns .",
      "grep . --file=escape/patterns",
    ]) {
      expect(
        codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, approvalCwd, cwd),
        script,
      ).toBe(false);
    }
    for (const approvalCwd of [
      join(root, "outside"),
      join(cwd, "escape"),
      join(cwd, "missing"),
      "apps/web",
    ]) {
      for (const script of ["ls", "git status", "pnpm -s test"]) {
        expect(
          codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, approvalCwd, cwd),
          script,
        ).toBe(false);
      }
    }
    expect(
      codexCommandAllowed("cat a.ts", "writer", DEFAULT_SEAT_COMMANDS, join(cwd, "inside"), cwd),
    ).toBe(true);
  });

  it("refuses zsh EQUALS expansion while allowing quoted or escaped equals", () => {
    expect(codexCommandAllowed("cat =zsh", "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd)).toBe(false);
    for (const script of ["cat '=zsh'", 'cat "=zsh"', "cat \\=zsh", "cat a=zsh"]) {
      expect(codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd), script).toBe(
        true,
      );
    }
  });

  describe.each(["writer", "read-only", "scratch"] as const)("%s parity", (mode) => {
    const cases = [
      ["Bash allowlist", "pnpm -s lint", [segment("pnpm -s lint")]],
      ["Bash allowlist", "pnpm -s typecheck", [segment("pnpm -s typecheck")]],
      ["Bash allowlist", "pnpm -s test x.test.ts", [segment("pnpm -s test x.test.ts")]],
      ["Bash allowlist", "pnpm -s build", [segment("pnpm -s build")]],
      ["Bash allowlist", "pnpm -s vitest run x.test.ts", [segment("pnpm -s vitest run x.test.ts")]],
      ["Bash allowlist", "pnpm -s testing", [segment("pnpm -s testing")]],
      [
        "Bash allowlist",
        "git status --short && git diff --stat",
        [segment("git status --short"), segment("git diff --stat")],
      ],
      ["Bash allowlist", "git show HEAD", [segment("git show HEAD")]],
      ["Bash allowlist", "git log --oneline", [segment("git log --oneline")]],
      ["Bash allowlist", "git log --oneline -5", [segment("git log --oneline -5")]],
      [
        "Bash allowlist",
        "git log --format='%h %s' -3",
        [segment(["git", "log", "--format=%h %s", "-3"])],
      ],
      ["Bash allowlist", "git show HEAD:package.json", [segment("git show HEAD:package.json")]],
      ["Bash allowlist", "git log --output=out", [segment("git log --output=out")]],
      ["Bash allowlist", "git diff HEAD --output=out", [segment("git diff HEAD --output=out")]],
      [
        "Codex no-index",
        "git diff --no-index /etc/passwd /etc/hosts",
        [segment("git diff --no-index /etc/passwd /etc/hosts")],
      ],
      ["Bash allowlist", "git commit -m change", [segment("git commit -m change")]],
      ["Bash allowlist", "curl example.com", [segment("curl example.com")]],
      ["confined read", "pwd", [segment("pwd")]],
      ["confined read", "git log main | head", [segment("git log main"), segment("head", true)]],
      [
        "confined read",
        "git diff 'HEAD~1..HEAD' | head",
        [segment(["git", "diff", "HEAD~1..HEAD"]), segment("head", true)],
      ],
      [
        "confined read",
        'pwd && rg -n -C 2 "Codex|crew seat" docs/runbook.md',
        [segment("pwd"), segment(["rg", "-n", "-C", "2", "Codex|crew seat", "docs/runbook.md"])],
      ],
      [
        "confined read",
        "rg foo apps | head -n 40",
        [segment("rg foo apps"), segment("head -n 40", true)],
      ],
      [
        "confined read",
        "git log --oneline | head",
        [segment("git log --oneline"), segment("head", true)],
      ],
      [
        "confined read",
        "rg --files apps | wc -l",
        [segment("rg --files apps"), segment("wc -l", true)],
      ],
      [
        "confined read",
        "cat apps/web/a.ts | tail -n 5",
        [segment("cat apps/web/a.ts"), segment("tail -n 5", true)],
      ],
      [
        "confined read",
        "rg --files apps | sort | uniq -c | cut -c 1-20 | grep web",
        [
          segment("rg --files apps"),
          segment("sort", true),
          segment("uniq -c", true),
          segment("cut -c 1-20", true),
          segment("grep web", true),
        ],
      ],
      [
        "confined read",
        "sort -k 1,1 -t : apps/web/a.ts",
        [segment("sort -k 1,1 -t : apps/web/a.ts")],
      ],
      ["confined read", "uniq -f 1 apps/web/a.ts", [segment("uniq -f 1 apps/web/a.ts")]],
      ["confined read", "cut -d : -f 1 apps/web/a.ts", [segment("cut -d : -f 1 apps/web/a.ts")]],
      [
        "confined read",
        "cat inside/a.ts | head",
        [segment("cat inside/a.ts"), segment("head", true)],
      ],
      [
        "confined read",
        "cat escape/token | head",
        [segment("cat escape/token"), segment("head", true)],
      ],
      [
        "confined read",
        "cat dangling/token | head",
        [segment("cat dangling/token"), segment("head", true)],
      ],
      [
        "confined read",
        "rg foo apps | head ../outside/token",
        [segment("rg foo apps"), segment("head ../outside/token", true)],
      ],
      [
        "confined read",
        "rg foo apps | tail /etc/passwd",
        [segment("rg foo apps"), segment("tail /etc/passwd", true)],
      ],
      [
        "confined read",
        "rg foo apps | wc escape/token",
        [segment("rg foo apps"), segment("wc escape/token", true)],
      ],
      ["confined read", "pwd apps", [segment("pwd apps")]],
      ["never", "rg foo apps | sh", [segment("rg foo apps"), segment("sh", true)]],
      ["never", "rg foo apps | bash", [segment("rg foo apps"), segment("bash", true)]],
      ["never", "rg foo apps | xargs rm", [segment("rg foo apps"), segment("xargs rm", true)]],
      ["never", "rg foo apps | tee out", [segment("rg foo apps"), segment("tee out", true)]],
      ["never", "a | sh", [segment("a"), segment("sh", true)]],
      ["never", "a | xargs rm", [segment("a"), segment("xargs rm", true)]],
      ["never", "cat x > y", null],
      ["never", "cat x | sort -o y", [segment("cat x"), segment("sort -o y", true)]],
      ["never", "cat x | uniq - y", [segment("cat x"), segment("uniq - y", true)]],
      ["never", "cat $(pwd)", null],
      ["never", "rg foo apps &", null],
      ["never", "cat 'unterminated", null],
      [
        "never",
        "pnpm -s vitest run x.test.ts | head",
        [segment("pnpm -s vitest run x.test.ts"), segment("head", true)],
      ],
      [
        "never",
        "cat x | pnpm -s vitest run x.test.ts",
        [segment("cat x"), segment("pnpm -s vitest run x.test.ts", true)],
      ],
      [
        "never",
        "git log --output=out | head",
        [segment("git log --output=out"), segment("head", true)],
      ],
    ] as const;
    it.each(
      cases.map(([rule, script, segments]) => ({
        rule,
        script,
        segments,
        expected: referenceAllowed(segments, mode),
      })),
    )("$rule: $script → $expected", ({ script, segments, expected }) => {
      const parsed = codexLineCommands(script);
      expect(parsed?.map(({ argv, piped }) => ({ argv, piped })) ?? null).toEqual(segments);
      expect(codexCommandAllowed(script, mode, DEFAULT_SEAT_COMMANDS, cwd, cwd)).toBe(expected);
    });
  });

  it.each(["sort", "uniq", "cut -f 1", "grep foo", "head", "tail", "wc"])(
    "confines %s operands in every pipeline position, relative to the approval cwd",
    (command) => {
      const approvalCwd = join(cwd, "apps/web");
      for (const path of [
        "../../../outside/token",
        "../../escape/token",
        "../../dangling/token",
        "/etc/passwd",
      ]) {
        for (const script of [`${command} ${path} | head`, `cat a.ts | ${command} ${path}`]) {
          expect(
            codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, approvalCwd, cwd),
            script,
          ).toBe(false);
        }
      }
      expect(
        codexCommandAllowed(
          `cat a.ts | ${command} a.ts`,
          "writer",
          DEFAULT_SEAT_COMMANDS,
          approvalCwd,
          cwd,
        ),
      ).toBe(true);
    },
  );

  it("refuses write options, extra output operands and unreadable read options", () => {
    for (const script of [
      "sort --output=out x",
      "sort --compress-program=sh x",
      "sort --files0-from=/etc/passwd",
      "sort --random-source=/etc/passwd x",
      "sort --unknown x",
      "sort -k",
      "uniq x out",
      "uniq -- x out",
      "uniq -s",
      "cut -f",
      "cut --unknown x",
      "pwd -",
      "pwd -- .",
    ]) {
      expect(codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd), script).toBe(
        false,
      );
    }
    for (const script of [
      "pwd -P",
      "sort -nr --key=1,1 x",
      "uniq -ci -f1 -s2 -w3 x",
      "cut --delimiter=: --fields=1 --output-delimiter=/ x",
    ]) {
      expect(codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd), script).toBe(
        true,
      );
    }
  });

  it.each(["uniq input -c", "uniq input --count", "uniq input --", "uniq - -c"])(
    "refuses BSD uniq's output operand in standalone and pipeline commands: %s",
    (command) => {
      for (const script of [command, `cat x | ${command}`, `${command} | head`]) {
        expect(codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd), script).toBe(
          false,
        );
      }
    },
  );

  it("confines standalone git diff operands in every mode", () => {
    for (const mode of ["writer", "read-only", "scratch"] as const) {
      for (const command of [
        "git diff /outside/a /outside/b",
        "git diff apps/web/a.ts ../outside/token",
        "git diff escape/token apps/web/a.ts",
        "git diff -- escape/token",
      ]) {
        expect(codexCommandAllowed(command, mode, DEFAULT_SEAT_COMMANDS, cwd, cwd), command).toBe(
          false,
        );
      }
      for (const command of [
        "git status --short",
        "git diff",
        "git diff --stat",
        "git diff HEAD~1..HEAD",
        "git log --oneline -5",
        "git log --oneline -5 | head",
        "git log main",
        "git log -- apps/server",
        "git diff | head",
        "git status | wc -l",
        "git log | grep fix",
      ]) {
        expect(codexCommandAllowed(command, mode, DEFAULT_SEAT_COMMANDS, cwd, cwd), command).toBe(
          true,
        );
      }
      for (const command of [
        "cd /tmp && git diff a b",
        "pushd /tmp; git diff a b",
        "popd; git diff a b",
        "env -C /tmp git diff a b",
        "env --chdir=/tmp git diff a b",
        "unset -m 'GIT_*'; git diff",
        "typeset -m 'GIT_*'; git diff",
        "GIT_CONFIG_GLOBAL=x git diff",
        "env GIT_CONFIG_GLOBAL=x git diff",
        "env -i git diff",
        "env -S 'GIT_CONFIG_GLOBAL=x git diff'",
        "export GIT_CONFIG_COUNT=0; git diff",
        "declare GIT_CONFIG_COUNT=0; git diff",
        "builtin export GIT_CONFIG_COUNT=0; git diff",
        "command env GIT_CONFIG_COUNT=0 git diff",
        "exec -c git diff",
        "git -c diff.external=x diff",
        "git --git-dir=/outside diff",
        "git --work-tree=/outside diff",
        "git -C /outside diff",
      ])
        expect(codexCommandAllowed(command, mode, DEFAULT_SEAT_COMMANDS, cwd, cwd)).toBe(false);
    }
  });
  it("strictly validates Git pipeline options and operands", () => {
    for (const command of [
      "git diff --no-index /etc/passwd /etc/hosts",
      "git log --oneline --output=out",
      "git log --oneline --output out",
      "git diff --stat --output=out",
      "git show HEAD --output=out",
      "git diff --ext-diff",
      "git log --textconv",
      "git show --unknown",
      "git log --max-count",
      "git log -n --output=out",
      "git log --max-count=oops",
      "git log bad..ref..ref",
      "git show HEAD:../../outside/token",
      "git status --short -- /etc/passwd",
      "git diff -- apps/web/a.ts escape/token",
      "git log -- ../outside/token",
      "git log -- ':(top)../outside/token'",
      "git diff --no-index apps/web/a.ts escape/token",
      "git log --oneline -- escape/../outside/token",
    ]) {
      for (const script of [`${command} | head`, `cat x | ${command}`]) {
        expect(codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd), script).toBe(
          false,
        );
      }
    }
    for (const script of [
      "git log --oneline -n 5 | head",
      "git log --max-count=5 -- apps/web/a.ts | wc -l",
      "git status --short -- apps | head",
      "git diff --stat HEAD -- apps/web/a.ts | head",
      "git diff -U3 -- apps/web/a.ts | head",
      "git show --oneline HEAD -- apps/web/a.ts | head",
    ]) {
      expect(codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd), script).toBe(
        true,
      );
    }
  });

  it("refuses git diff --no-index only for Codex, in every mode", () => {
    for (const mode of ["writer", "read-only", "scratch"] as const) {
      for (const command of [
        "git diff --no-index /etc/passwd /etc/hosts",
        "git diff --stat --no-index apps/web/a.ts apps/web/b.ts",
      ]) {
        expect(claudeBashAllowed(command.split(" "), mode, DEFAULT_SEAT_COMMANDS)).toBe(true);
        for (const script of [command, `${command} | head`, `cat x | ${command}`]) {
          expect(codexCommandAllowed(script, mode, DEFAULT_SEAT_COMMANDS, cwd, cwd), script).toBe(
            false,
          );
        }
      }
    }
  });

  it("refuses plain diff directories with matching symlinks to an outside file", () => {
    writeFileSync(join(root, "outside/token"), "secret");
    for (const dir of ["left", "right"]) {
      mkdirSync(join(cwd, dir));
      symlinkSync(join(root, "outside/token"), join(cwd, dir, "token"));
    }
    symlinkSync(join(cwd, "left"), join(cwd, "directory-alias"));
    for (const mode of ["writer", "read-only", "scratch"] as const) {
      for (const script of [
        "diff left right",
        "diff left right | head",
        "diff directory-alias right | head",
        "diff left apps/web/a.ts",
      ]) {
        expect(codexCommandAllowed(script, mode, DEFAULT_SEAT_COMMANDS, cwd, cwd), script).toBe(
          false,
        );
      }
      expect(
        codexCommandAllowed(
          "diff apps/web/a.ts apps/web/b.ts | head",
          mode,
          DEFAULT_SEAT_COMMANDS,
          cwd,
          cwd,
        ),
      ).toBe(true);
    }
  });

  it("resolves symlinks before parent traversal for reads, edits and approval cwd", () => {
    writeFileSync(join(root, "outside/token"), "secret");
    mkdirSync(join(cwd, "outside"));
    symlinkSync("../outside", join(cwd, "relative-escape"));
    for (const link of ["escape", "relative-escape"]) {
      for (const leaf of ["token", "missing/token"]) {
        const path = `${link}/../outside/${leaf}`;
        // Preserve the spelling under test: path.join would erase the traversal.
        for (const operand of [path, `${cwd}/${path}`]) {
          expect(codexReadAllowed(operand, cwd), operand).toBe(false);
          expect(codexEditAllowed(operand, cwd, [], []), operand).toBe(false);
          expect(
            codexCommandAllowed(`cat ${operand} | head`, "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd),
            operand,
          ).toBe(false);
        }
      }
      const approvalCwd = `${cwd}/${link}/../outside`;
      for (const script of ["pwd", "cat token", "cat missing/token", "git status"]) {
        expect(
          codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, approvalCwd, cwd),
          script,
        ).toBe(false);
      }
      expect(
        codexApproval(
          request({ kind: "command", command: "/bin/zsh -lc pwd", cwd: approvalCwd }),
          undefined,
          { cwd },
        ),
      ).toBeNull();
    }
    for (const path of ["inside/../web/a.ts", "inside/../web/missing/file"]) {
      expect(codexReadAllowed(path, cwd), path).toBe(true);
    }
    for (const path of [
      "dangling/../apps/web/a.ts",
      "missing/../apps/web/a.ts",
      "apps/web/a.ts/../b.ts",
    ]) {
      expect(codexReadAllowed(path, cwd), path).toBe(false);
    }
    const approvalCwd = `${cwd}/inside/../web`;
    expect(codexCommandAllowed("cat a.ts", "writer", DEFAULT_SEAT_COMMANDS, approvalCwd, cwd)).toBe(
      true,
    );
  });

  it.each([
    "pwd |",
    "pwd &&",
    "pwd ||",
    "pwd | # pending",
    "pwd &&\n",
    "pwd | ; head",
    "pwd ||| head",
    "| pwd",
    "&& pwd",
    "pwd && && pwd",
    "pnpm -s test 2>&1",
    "cat <&0",
    "cat 0<&-",
    "cat >&2",
    "cat &>out",
    "cat <<'E'\nline1\nE",
    "cat <<E\nline1\nE",
    "cat <<<'text'",
    "cat < x",
    "cat x > y",
    "pwd |& head",
  ])("refuses unfinished commands and every redirection: %j", (script) => {
    expect(codexLineCommands(script)).toBeNull();
    expect(codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd)).toBe(false);
  });

  it.each([
    "pwd |\nhead",
    "pwd &&\ncat x",
    "pwd || # next\ncat x",
    "pwd;\ncat x",
    "cat '>'",
    "cat 'a|b'",
  ])("keeps complete continuations and quoted punctuation readable: %j", (script) => {
    expect(codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd)).toBe(true);
  });

  it.each(["writer", "read-only", "scratch"] as const)(
    "shares configured Bash rules for %s",
    (mode) => {
      const commands = { writer: ["make check"], review: ["make inspect"] };
      for (const script of [
        "make check unit",
        "make inspect",
        "make checkmate",
        "pnpm -s test",
        "git status",
      ]) {
        expect(codexCommandAllowed(script, mode, commands, cwd, cwd), script).toBe(
          claudeBashAllowed(script.split(" "), mode, commands),
        );
      }
      // Configuration cannot turn a pipeline into a writer or bypass read operand checks.
      for (const [command, script] of [
        ["tee", "cat x | tee out"],
        ["xargs rm", "cat x | xargs rm out"],
        ["sort", "cat x | sort /etc/passwd"],
        ["uniq", "cat x | uniq - out"],
        ["cut", "cat x | cut -f 1 /etc/passwd"],
      ]) {
        expect(
          codexCommandAllowed(script, mode, { writer: [command], review: [command] }, cwd, cwd),
          script,
        ).toBe(false);
      }
    },
  );

  it("allows configured commands by mode, git reads and confined read commands", () => {
    for (const script of [
      "pnpm -s test",
      "pnpm -s test x.test.ts",
      "git status --short",
      "git log --oneline",
      "rg foo src",
      "rg -n 'foo bar' src",
      "cat apps/web/a.ts",
      "head -c 5 apps/web/a.ts",
      "tail -n 5 apps/web/a.ts",
      "wc -l apps/web/a.ts",
      "sed -n '1,20p' apps/web/a.ts",
      "find apps -name '*.ts'",
      "diff apps/web/a.ts apps/web/b.ts",
      "stat apps/web/a.ts",
      "ls",
      "git status && rg foo src",
      "pnpm -s test && rg foo src | head -n 40",
      "rg foo src | head; pnpm -s test",
      "git log | head || git status",
      "sed -n 1,5p a && sed -n 1,5p b",
      "sed -n 1,5p a; sed -n 1,5p b",
      "sed -n 1,5p a || sed -n 1,5p b",
      'rg -n "a|b" docs',
      'rg -n "a|b" docs | head',
      "cat apps/web/a.ts | grep foo",
      "nl -ba apps/web/a.ts | sed -n 1,5p",
    ]) {
      expect(codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd), script).toBe(
        true,
      );
    }
    for (const mode of ["read-only", "scratch"] as const) {
      expect(codexCommandAllowed("pnpm -s test", mode, DEFAULT_SEAT_COMMANDS, cwd, cwd)).toBe(
        false,
      );
      expect(
        codexCommandAllowed("pnpm -s vitest run a.test.ts", mode, DEFAULT_SEAT_COMMANDS, cwd, cwd),
      ).toBe(true);
    }
    const custom = { writer: ["make check"], review: ["make inspect"] };
    expect(codexCommandAllowed("make check unit", "writer", custom, cwd, cwd)).toBe(true);
    expect(codexCommandAllowed("pnpm -s test", "writer", custom, cwd, cwd)).toBe(false);
    expect(codexCommandAllowed("make checkmate", "writer", custom, cwd, cwd)).toBe(false);
    expect(codexCommandAllowed("make inspect", "scratch", custom, cwd, cwd)).toBe(true);
  });

  it("declines substitutions, background work, file redirection and allowlist escapes", () => {
    for (const script of [
      "sed -n 1p a && curl x",
      "a; rm -rf /",
      "$(id)",
      "sleep 1 &",
      "sed -n 1p a || curl x",
      "rg -n foo docs | sh",
      "pnpm -s test && rm x",
      "pnpm -s test $(id)",
      "git status; curl x",
      "sleep 20 &",
      "cat ../../etc/passwd",
      "cat /home/you/.ssh/id_rsa",
      "rm -rf /",
      "pnpm -s test &",
      "pnpm -s test $(git status)",
      'cat "$HOME/file"',
      "cat `ls`",
      "cat < /etc/passwd",
      "pnpm -s test > out",
      "git status >> out",
      "cat <(ls)",
      "cat escape/token",
      "cat dangling/token",
      "rg --pre=sh foo src",
      "rg -f /etc/passwd src",
      "grep -f/etc/passwd src",
      "rg -L foo src",
      "sed -n '1e id' apps/web/a.ts",
      "sed -n '1w out' apps/web/a.ts",
      "sed -nf /etc/passwd",
      "find . -exec cat /etc/passwd ';'",
      "find . -delete",
      "find -- . -delete",
      "find -- . -exec cat /etc/passwd ';'",
      "find . -fprint out",
      "find -L .",
      "diff --output=out a b",
      "diff --unified --from-file=/etc/passwd a",
      "stat -f /etc/passwd",
      "cat 'unterminated",
      "cat *",
      "cat apps/{web,other}/a.ts",
      "cat <<E\n$HOME\nE",
      "env PATH=/other pnpm -s test",
      "PATH=/other pnpm -s test",
      "./pnpm -s test",
      "git diff --output=out",
      "git log --output out",
      "git show --output=out",
      "",
    ])
      expect(codexCommandAllowed(script, "writer", DEFAULT_SEAT_COMMANDS, cwd, cwd), script).toBe(
        false,
      );
  });

  it("checks every segment after decoding the CLI's segment amendment", () => {
    for (const [script, amendment, allowed] of [
      ["sed -n 1,5p a && sed -n 1,5p b", ["sed", "-n", "1,5p", "a"], true],
      ['rg -n "a|b" docs && sed -n 1p a', ["rg", "-n", "a|b", "docs"], true],
      ["sed -n 1p a && curl x", ["sed", "-n", "1p", "a"], false],
    ] as const) {
      const events = codexApproval(
        request({
          kind: "command",
          cwd,
          command: `/bin/zsh -lc '${script}'`,
          proposedExecpolicyAmendment: amendment,
        }),
        undefined,
        { cwd },
      );
      expect(events).toEqual([{ tool: "Bash", input: { command: script } }]);
      expect(
        codexCommandAllowed(
          events?.[0]?.input.command ?? "",
          "writer",
          DEFAULT_SEAT_COMMANDS,
          cwd,
          cwd,
        ),
      ).toBe(allowed);
    }
  });

  it("keeps denies and read path checks even for a custom command", () => {
    for (const command of ["git commit", "curl", "gh", "security", "git -c", "cat", "find"]) {
      const script =
        command === "cat"
          ? "cat /etc/passwd"
          : command === "find"
            ? "find . -delete"
            : `${command} x`;
      expect(
        codexCommandAllowed(script, "writer", { writer: [command], review: [] }, cwd, cwd),
        script,
      ).toBe(false);
    }
  });

  it("confines reads and edits through existing and missing parents", () => {
    expect(codexReadAllowed("apps/web/new/deep/a.ts", cwd)).toBe(true);
    expect(codexReadAllowed("inside/a.ts", cwd)).toBe(true);
    expect(codexReadAllowed("../outside/x", cwd)).toBe(false);
    expect(codexReadAllowed("escape/new/x", cwd)).toBe(false);
    expect(codexReadAllowed("dangling/x", cwd)).toBe(false);
    expect(codexEditAllowed("apps/web/new/a.ts", cwd, ["apps/web/**"], [])).toBe(true);
    for (const path of [
      "package.json",
      ".github/workflows/x.yml",
      ".codex/config.toml",
      "apps/web/.codex/config.toml",
      "../outside/x",
      "escape/x",
      "dangling/x",
    ]) {
      expect(codexEditAllowed(path, cwd, ["apps/web/**"], []), path).toBe(false);
    }
    expect(codexEditAllowed(".codex/config.toml", cwd, [], [])).toBe(false);
    expect(codexEditAllowed(".github/workflows/x.yml", cwd, [], [])).toBe(false);
    expect(codexEditAllowed("apps/web/a.ts", cwd, [], ["apps/web/a.ts"])).toBe(false);
    symlinkSync(join(cwd, "package.json"), join(cwd, "apps/web/alias.ts"));
    writeFileSync(join(cwd, "package.json"), "{}");
    expect(codexEditAllowed("apps/web/alias.ts", cwd, ["apps/web/**"], [])).toBe(false);
  });

  it("rejects edits of the root and checks absolute edits against a canonical cwd", () => {
    for (const path of ["", ".", cwd]) {
      expect(codexEditAllowed(path, cwd, [], []), path).toBe(false);
    }
    const alias = join(root, "worktree-alias");
    symlinkSync(cwd, alias);
    const path = join(realpathSync(cwd), "apps/web/a.ts");
    expect(codexEditAllowed(path, alias, ["apps/web/**"], [])).toBe(true);
    expect(codexEditAllowed(path, alias, ["other/**"], [])).toBe(false);
    expect(codexEditAllowed(path, alias, [], ["apps/web/a.ts"])).toBe(false);
  });
});

describe("Codex version floor", () => {
  it.each(["codex-cli 0.154.0", "codex-cli 0.154.1\n", "codex-cli 0.155.0", "codex-cli 1.0.0"])(
    "accepts %s",
    (version) => {
      expect(codexVersionAllowed(version)).toBe(true);
    },
  );
  it.each([
    "",
    "0.154.0",
    "codex-cli 0.153.9",
    "codex-cli 0.154.0-alpha",
    "codex-cli 0.154.0 extra",
  ])("refuses %s", (version) => {
    expect(codexVersionAllowed(version)).toBe(false);
  });
});
