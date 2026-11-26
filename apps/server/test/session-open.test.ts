import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSION_FOLDER_TEXT, SESSION_ROLE_TEXT } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openSession,
  SessionOpenError,
  sessionRoles,
  sessionScript,
} from "../src/sessions/open.ts";
import { Store } from "../src/store.ts";

const T0 = Date.parse("2026-11-25T19:55:00Z");
let dir: string;
let roles: string;
let store: Store;
let opened: { name: string; cwd: string; command: string }[];
const cmux = {
  newWorkspace: async (i: { name: string; cwd: string; command: string }) => {
    opened.push(i);
    return `ws-${opened.length}`;
  },
};
const deps = () => ({ cmux, store, rolesDir: roles, now: () => T0 });
/** The script path a workspace command names: the command is that path, single-quoted. */
const scriptOf = (command: string) => readFileSync(command.slice(1, -1), "utf8");

beforeEach(() => {
  // real: git reports /private/tmp where the temp folder is a symlink
  dir = realpathSync(mkdtempSync(join(tmpdir(), "mc-session-open-")));
  roles = join(dir, "roles");
  mkdirSync(roles);
  writeFileSync(join(roles, "GUIDO.md"), "You are GUIDO.");
  writeFileSync(join(roles, "INCO.md"), "You are INCO.");
  writeFileSync(join(roles, "README.md"), "not a role");
  store = new Store(":memory:");
  opened = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("opening a session", () => {
  it("lists the roles without the README", () => {
    expect(sessionRoles(roles)).toEqual(["GUIDO", "INCO"]);
    expect(sessionRoles(join(dir, "none"))).toEqual([]);
  });

  it("a quote and a command substitution stay one literal argument", () => {
    const message = `it's $(touch ${join(dir, "x")}) "here"`;
    const script = sessionScript({ rolePrompt: "role 'r'", message, pidFile: join(dir, "pid") })
      // print each argument on its own line in place of running claude
      .replace(/^exec 'claude'/m, `exec printf '%s\\n'`);
    writeFileSync(join(dir, "s.zsh"), script);
    // the script is POSIX: /bin/sh runs it on CI's Linux, which has no zsh
    const printed = execFileSync("/bin/sh", [join(dir, "s.zsh")]).toString();
    expect(printed.split("\n").slice(0, 3)).toEqual([
      "--append-system-prompt",
      "role 'r'",
      message,
    ]);
    expect(existsSync(join(dir, "x"))).toBe(false);
    expect(Number(readFileSync(join(dir, "pid"), "utf8"))).toBeGreaterThan(0);
  });

  it("opens a workspace in the folder with the role's prompt and the first message", async () => {
    const r = await openSession(
      deps(),
      { folder: dir, worktree: false, role: "GUIDO", message: "Fix the login test" },
      "operator",
    );
    expect(r).toMatchObject({ id: "ws-1", folder: dir });
    expect(opened).toHaveLength(1);
    expect(opened[0]?.cwd).toBe(dir);
    expect(opened[0]?.name).not.toContain(" · ");
    const script = scriptOf(opened[0]?.command ?? "");
    expect(script).toContain("'--append-system-prompt' 'You are GUIDO.' 'Fix the login test'");
    expect(store.hubEvents(0).map((e) => e.text)).toEqual([
      `Opened cmux session "${r.name}" in ${dir} as GUIDO, asked by operator`,
    ]);
    // a seat's ` · ` never reaches the name
    const named = await openSession(
      deps(),
      { folder: dir, worktree: false, role: "INCO", message: "m", name: "guido-1 · #7" },
      "operator",
    );
    expect(named.name).toBe("guido-1 - #7");
  });

  it("refuses a relative or missing folder, an unknown role and an empty message", async () => {
    const refused = async (input: Parameters<typeof openSession>[1]) => {
      const e = await openSession(deps(), input, "operator").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(SessionOpenError);
      return e as SessionOpenError;
    };
    const ok = { folder: dir, worktree: false, role: "GUIDO", message: "m" };
    expect((await refused({ ...ok, folder: "relative/x" })).message).toBe(SESSION_FOLDER_TEXT);
    expect((await refused({ ...ok, folder: join(dir, "none") })).message).toBe(SESSION_FOLDER_TEXT);
    expect((await refused({ ...ok, role: "README" })).message).toBe(SESSION_ROLE_TEXT);
    expect((await refused({ ...ok, role: "../GUIDO" })).message).toBe(SESSION_ROLE_TEXT);
    expect((await refused({ ...ok, message: " " })).status).toBe(400);
    expect(opened).toEqual([]);
  });

  it("a cmux failure is a 503", async () => {
    const e = await openSession(
      {
        ...deps(),
        cmux: {
          newWorkspace: async () => {
            throw new Error("cmux is not running");
          },
        },
      },
      { folder: dir, worktree: false, role: "GUIDO", message: "m" },
      "operator",
    ).catch((x: unknown) => x);
    expect((e as SessionOpenError).status).toBe(503);
    expect(store.hubEvents(0)).toEqual([]);
  });

  it("worktree makes a session/<slug> worktree from origin's default branch", async () => {
    const origin = join(dir, "origin");
    const repo = join(dir, "repo");
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" })
        .toString()
        .trim();
    mkdirSync(origin);
    git(origin, "init", "-q", "-b", "main");
    git(
      origin,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "a",
    );
    execFileSync("git", ["clone", "-q", origin, repo], { stdio: "pipe" });
    mkdirSync(join(repo, "apps"));
    const r = await openSession(
      deps(),
      { folder: join(repo, "apps"), worktree: true, role: "GUIDO", message: "m" },
      "FLIGHT for comms:4",
    );
    const slug = "guido-20261125-195500";
    expect(r.folder).toBe(join(dir, "repo-sessions", slug));
    expect(git(r.folder, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`session/${slug}`);
    expect(opened[0]?.cwd).toBe(r.folder);
    expect(r.name).toBe("apps (GUIDO)");

    const again = await openSession(
      deps(),
      { folder: join(repo, "apps"), worktree: true, role: "GUIDO", message: "m" },
      "operator",
    ).catch((x: unknown) => x);
    expect((again as SessionOpenError).status).toBe(400);
  });
});
