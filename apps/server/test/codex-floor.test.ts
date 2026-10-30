import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CrewSandboxInput,
  codexLineCommands,
  PNPM_STORE_ENV,
  SANDBOX_DENY_READ_HOME,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codexPnpmStoreDir } from "../src/runtime/checkouts.ts";
import {
  CODEX_PROJECT_DIR,
  codexApproval,
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
  pnpmStoreDir: "/mc/crew/.mc-pnpm-store/shared",
};

/** The installed Codex CLI, when this machine has one (the probe below runs only then). */
const installedCodex = (() => {
  if (process.platform !== "darwin") return null;
  try {
    return execFileSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
})();

describe.skipIf(installedCodex === null)("Codex seat profile under the real codex sandbox", () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each(["writer", "scratch"] as const)(
    "lets a %s seat write its worktree but not create or write .codex",
    (mode) => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "mc-codex-project-")));
      const cwd = join(root, "worktree");
      const home = join(root, "codex-home");
      const seatTmp = join(root, "seat-tmp");
      for (const path of [cwd, home, seatTmp, join(root, "operator")]) mkdirSync(path);
      execFileSync("git", ["init", "-q", cwd]);
      writeFileSync(
        join(home, "config.toml"),
        codexSeatConfig(
          {
            cwd,
            gitCommonDir: join(cwd, ".git"),
            worktreeGitDir: join(cwd, ".git"),
            home: join(root, "operator"),
            dataDir: join(root, "data"),
            denyRead: [],
            pnpmStoreDir: join(root, "pnpm-store"),
          },
          mode,
          "http://127.0.0.1:1/mcp",
          seatTmp,
        ),
      );
      const run = (script: string) => {
        try {
          execFileSync(
            installedCodex as string,
            ["sandbox", "-C", cwd, "-P", "mc_seat", "--", "/bin/sh", "-c", script],
            {
              cwd,
              env: { PATH: process.env.PATH, HOME: join(root, "operator"), CODEX_HOME: home },
              stdio: "ignore",
              timeout: 30_000,
            },
          );
          return true;
        } catch {
          return false;
        }
      };
      expect(run("echo x > ok.txt")).toBe(true);
      expect(existsSync(join(cwd, "ok.txt"))).toBe(true);
      expect(run(`mkdir ${CODEX_PROJECT_DIR}`)).toBe(false);
      expect(run(`ln -s . ${CODEX_PROJECT_DIR}`)).toBe(false);
      mkdirSync(join(cwd, CODEX_PROJECT_DIR));
      expect(run(`echo x > ${CODEX_PROJECT_DIR}/config.toml`)).toBe(false);
      expect(existsSync(join(cwd, CODEX_PROJECT_DIR, "config.toml"))).toBe(false);
    },
    60_000,
  );
});

describe("codexSeatConfig", () => {
  const url = "http://127.0.0.1:7420/mcp";
  const tmp = "/tmp/claude-501/seat-1";

  it("requires the hub-owned pnpm store instead of falling back to a worktree store", () => {
    expect(() =>
      codexSeatConfig(
        { ...sandboxInput, pnpmStoreDir: undefined } as unknown as CrewSandboxInput,
        "writer",
        url,
        tmp,
      ),
    ).toThrow("codex seat config: pnpmStoreDir must be absolute");
  });

  it("writes the isolated profile, MCP auth and command environment", () => {
    const config = codexSeatConfig(sandboxInput, "writer", url, tmp);
    expect(config).toContain('approvals_reviewer = "user"');
    expect(config).toContain("project_doc_max_bytes = 0");
    // codex-cli 0.154.0 generate-json-schema: Config.web_search → WebSearchMode.disabled.
    // Config permits extra keys; features.unified_exec is listed but false does not take effect
    // on 0.154.0. Keep the harmless key; refusing & and declining writeStdin enforce the floor.
    expect(config).toContain('web_search = "disabled"');
    expect(config).toContain(
      "[features]\nremote_plugin = false\nunified_exec = false\nshell_snapshot = false\nshell_zsh_fork = false",
    );
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
      '[permissions.mc_seat.filesystem.":workspace_roots"]\n"."="write"\n".git"="read"\n".codex"="read"',
    );
    expect(config).toContain("[permissions.mc_seat.network]\nenabled = false");
    expect(config).not.toMatch(/notify|network_proxy|sandbox_mode|dangerously/);
  });

  it.each(["writer", "read-only"] as const)(
    "refuses writes to Codex's pnpm store for %s seats",
    (mode) => {
      const store = "/mc/crew/.mc-pnpm-store/shared";
      const config = codexSeatConfig({ ...sandboxInput, pnpmStoreDir: store }, mode, url, tmp);
      expect(config).toContain('":root"="read"');
      expect(config).toContain(`"${tmp}"="write"`);
      expect(config).toContain(`"${store}"="read"`);
      // An attempted write has an explicit read-only rule, outside the writable workspace root.
      expect(config).not.toContain(`"${store}"="write"`);
      expect(config).toContain(`"."="${mode === "read-only" ? "read" : "write"}"`);
    },
  );

  it.each(["writer", "read-only", "scratch"] as const)(
    "never lets a %s seat write the worktree's .codex project config",
    (mode) => {
      const config = codexSeatConfig(sandboxInput, mode, url, tmp);
      const roots = config.slice(config.indexOf('.filesystem.":workspace_roots"]'));
      expect(roots).toContain(`"${CODEX_PROJECT_DIR}"="read"`);
      expect(config).not.toContain(`"${CODEX_PROJECT_DIR}"="write"`);
    },
  );

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

describe.skipIf(process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec"))(
  "Codex seat Seatbelt store confinement",
  () => {
    let root: string;
    let cwd: string;
    let seatTmp: string;

    beforeEach(() => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "mc-codex-store-")));
      cwd = join(root, "worktree");
      seatTmp = join(root, "seat-tmp");
      const store = codexPnpmStoreDir(cwd);
      for (const path of [cwd, seatTmp, store]) mkdirSync(path, { recursive: true });
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it.each(["writer", "read-only"] as const)(
      "refuses a launched %s seat writing under $pnpm_config_store_dir",
      (mode) => {
        const store = codexPnpmStoreDir(cwd);
        const config = codexSeatConfig(
          {
            cwd,
            gitCommonDir: join(root, "clone", ".git"),
            worktreeGitDir: join(root, "clone", ".git", "worktrees", "seat"),
            home: join(root, "operator"),
            dataDir: join(root, "data"),
            denyRead: [],
            pnpmStoreDir: store,
          },
          mode,
          "http://127.0.0.1:7420/mcp",
          seatTmp,
        );
        expect(config).toContain(`${JSON.stringify(store)}="read"`);
        const profile = [
          "(version 1)",
          "(allow default)",
          "(deny file-write*)",
          ...(mode === "writer" ? [`(allow file-write* (subpath ${JSON.stringify(cwd)}))`] : []),
          `(allow file-write* (subpath ${JSON.stringify(seatTmp)}))`,
          `(deny file-write* (subpath ${JSON.stringify(store)}))`,
        ].join("\n");
        const target = join(store, "seat-write");

        expect(() =>
          execFileSync(
            "/usr/bin/sandbox-exec",
            [
              "-p",
              profile,
              process.execPath,
              "-e",
              "require('node:fs').writeFileSync(require('node:path').join(process.env.pnpm_config_store_dir, 'seat-write'), 'x')",
            ],
            {
              cwd,
              env: { ...process.env, [PNPM_STORE_ENV]: store },
              stdio: "ignore",
            },
          ),
        ).toThrow();
        expect(existsSync(target)).toBe(false);
      },
    );
  },
);

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
        }
      }
      const approvalCwd = `${cwd}/${link}/../outside`;
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
    expect(
      codexApproval(
        request({ kind: "command", command: "/bin/zsh -lc pwd", cwd: approvalCwd }),
        undefined,
        { cwd },
      ),
    ).toEqual([{ tool: "Bash", input: { command: "pwd" } }]);
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
  });

  it("passes the whole script on when the CLI's amendment names one segment", () => {
    for (const [script, amendment] of [
      ["sed -n 1,5p a && sed -n 1,5p b", ["sed", "-n", "1,5p", "a"]],
      ['rg -n "a|b" docs && sed -n 1p a', ["rg", "-n", "a|b", "docs"]],
      ["sed -n 1p a && curl x", ["sed", "-n", "1p", "a"]],
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
