import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CrewSandboxInput, DEFAULT_SEAT_COMMANDS, SANDBOX_DENY_READ_HOME } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexApproval,
  codexCommandAllowed,
  codexEditAllowed,
  codexReadAllowed,
  codexSeatConfig,
} from "../src/runtime/codex-floor.ts";

const sandboxInput: CrewSandboxInput = {
  cwd: "/mc/wt/guido-1",
  gitCommonDir: "/mc/clone/.git",
  worktreeGitDir: "/mc/clone/.git/worktrees/guido-1",
  home: "/home/you",
  dataDir: "/home/you/.local/share/mission-control",
  denyRead: [],
};

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
    expect(config).toContain("[features]\nunified_exec = false");
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
      "pnpm -s test 2>&1",
      "cat <<'E'\nline1\nE",
      "cat apps/web/a.ts | grep foo",
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
