import { GUARD_HOOK_EVENTS, type GuardHookEvent } from "./guard.ts";
import { MC_MCP_SERVER, MC_TOOL_NAMES, MC_TOOLS, type McToolName } from "./mcp.ts";
import { ROLES } from "./roles.ts";
import type { AgentId } from "./types.ts";

// What a crew process is started with: the CLI's tool allowlist (in `-p` mode anything not allowed
// is denied, spike 2026-10-20), the guard hook before every tool call, and the OS
// sandbox around every Bash, with `autoAllowBashIfSandboxed` off so the sandbox never widens the
// allowlist. The sandbox writes no git state: commits, pushes and PRs are the mc tools', made by
// the hub in its own clone.

/** A seat's role: a call sign, built in (`BUILTIN_ROLES`) or defined in config (`crew.roles`). */
export type CrewRole = string;
/** What a role's name looks like: 2–16 capital letters or digits, starting with a letter. */
export const ROLE_NAME = /^[A-Z][A-Z0-9]{1,15}$/;
/** A role's prompt file, relative to the hub checkout. */
export const ROLE_PROMPT = /^roles\/[A-Za-z0-9][A-Za-z0-9_-]{0,63}\.md$/;
export const ROLE_PROMPT_DIR = "roles";

/** Claude's `--effort` values. Codex advertises its model-specific values through `model/list`. */
export const CREW_EFFORTS = ["low", "medium", "high", "max"] as const;
/** Codex 0.154's ReasoningEffort is a nonempty string, validated against the model's catalog. */
export type CrewEffort = string;

/** The modes a seat runs in; `scratch` = edits in its own throwaway worktree, no git writes, no PR. */
export const CREW_MODES = ["writer", "read-only", "scratch"] as const;
export type CrewMode = (typeof CREW_MODES)[number];
/** The modes a seat's config may name; every other mode comes from the role. */
export const CONFIG_SEAT_MODES = ["scratch"] as const;
export type ConfigSeatMode = (typeof CONFIG_SEAT_MODES)[number];

/**
 * What a role's loop does with its seat: builds tickets, reviews PRs, plans tickets, runs the crew
 * (`watch`, started with no ticket) or nothing.
 */
export const LOOP_KINDS = ["build", "review", "plan", "watch", "none"] as const;
export type LoopKind = (typeof LOOP_KINDS)[number];
/** The loops each mode may have. */
export const MODE_LOOPS: Readonly<Record<CrewMode, readonly LoopKind[]>> = {
  writer: ["build"],
  "read-only": ["none", "plan", "watch"],
  scratch: ["review"],
};

/** The mc tools FLIGHT holds by grant; writers have a separate sync_main tool of their own. */
export const FLIGHT_TOOLS: readonly McToolName[] = [
  MC_TOOL_NAMES.logDecision,
  MC_TOOL_NAMES.readTicket,
  MC_TOOL_NAMES.answerQuestion,
  MC_TOOL_NAMES.startSeat,
  MC_TOOL_NAMES.messageSeat,
  MC_TOOL_NAMES.flightState,
  MC_TOOL_NAMES.promote,
  MC_TOOL_NAMES.endRun,
  MC_TOOL_NAMES.acceptRuling,
  MC_TOOL_NAMES.mergePr,
  MC_TOOL_NAMES.settlePark,
  MC_TOOL_NAMES.rerunCi,
  MC_TOOL_NAMES.editCard,
  MC_TOOL_NAMES.dismissItem,

  MC_TOOL_NAMES.syncMain,
  MC_TOOL_NAMES.createTicket,
  MC_TOOL_NAMES.commentTicket,
  MC_TOOL_NAMES.briefItem,
  MC_TOOL_NAMES.readPr,
  MC_TOOL_NAMES.readCiLog,
  MC_TOOL_NAMES.ghRead,
  MC_TOOL_NAMES.listTickets,
  MC_TOOL_NAMES.updateBrief,
  MC_TOOL_NAMES.draftReply,
  MC_TOOL_NAMES.track,
  MC_TOOL_NAMES.untrack,
  MC_TOOL_NAMES.ledger,
  MC_TOOL_NAMES.remember,
  MC_TOOL_NAMES.forget,
  MC_TOOL_NAMES.recall,
];

/**
 * The mc tools each mode has. `base`: every seat of the mode (`*_TOOLS` below lists the same);
 * `grantable`: a role may add. Writers commit and sync main; `push` and `draft_pr` are the hub's
 * own and never appear.
 */
export const MC_TOOL_GRANTS: Readonly<
  Record<CrewMode, { base: readonly McToolName[]; grantable: readonly McToolName[] }>
> = {
  writer: { base: ["commit", "sync_main", "ask_operator", "report_evidence"], grantable: [] },
  "read-only": {
    base: ["ask_operator", "report_evidence"],
    grantable: [MC_TOOL_NAMES.reportPlan, ...FLIGHT_TOOLS],
  },
  scratch: { base: [MC_TOOL_NAMES.reportFindings, MC_TOOL_NAMES.restoreFile], grantable: [] },
};

/** A role: what a seat of it runs as, unless its own config says otherwise. */
export interface RoleDef {
  /** Relative to the hub checkout: `roles/<name>.md`. */
  prompt: string;
  /** A seat's model when it names none. */
  model: string;
  mode: CrewMode;
  loop: LoopKind;
  /** Extra mc tools, from `MC_TOOL_GRANTS[mode].grantable`. */
  tools: readonly McToolName[];
  /** The role's one-line description, shown in Setup › Roles. */
  here: string;
}

/** A role's default `here`: its `ROLES` row's, else "crew member". */
export const hereOf = (callSign: string): string =>
  ROLES.find((r) => r.callSign === callSign)?.here ?? "crew member";

/** The roles every hub has; `crew.roles` adds to them or replaces one whole. */
export const BUILTIN_ROLES: Readonly<Record<string, RoleDef>> = {
  GUIDO: {
    prompt: "roles/GUIDO.md",
    model: "sonnet",
    mode: "writer",
    loop: "build",
    tools: [],
    here: hereOf("GUIDO"),
  },
  INCO: {
    prompt: "roles/INCO.md",
    model: "sonnet",
    mode: "writer",
    loop: "build",
    tools: [],
    here: hereOf("INCO"),
  },
  RETRO: {
    prompt: "roles/RETRO.md",
    model: "opus",
    mode: "read-only",
    loop: "none",
    tools: [],
    here: hereOf("RETRO"),
  },
  FLIGHT: {
    prompt: "roles/FLIGHT.md",
    model: "opus",
    mode: "read-only",
    loop: "watch",
    tools: FLIGHT_TOOLS,
    here: hereOf("FLIGHT"),
  },
  FAO: {
    prompt: "roles/FAO.md",
    model: "opus",
    mode: "read-only",
    loop: "plan",
    tools: [MC_TOOL_NAMES.reportPlan, MC_TOOL_NAMES.readTicket],
    here: hereOf("FAO"),
  },
};

/** What a seat runs as: its role with its own config applied. */
export interface SeatDef {
  mode: CrewMode;
  loop: LoopKind;
  prompt: string;
  mcTools: readonly McToolName[];
  here: string;
}

/** A read-only role made a scratch reviewer by its seat's `mode`; else the role as is. */
export function resolveSeatDef(role: RoleDef, seatMode: ConfigSeatMode | undefined): SeatDef {
  if (seatMode === "scratch" && role.mode === "read-only") {
    return { mode: "scratch", loop: "review", prompt: role.prompt, mcTools: [], here: role.here };
  }
  return {
    mode: role.mode,
    loop: role.loop,
    prompt: role.prompt,
    mcTools: role.tools,
    here: role.here,
  };
}

/**
 * A seat's resolved role: `seat.def` if set, else the built-in role. An unknown role is read-only
 * with no loop and no tools, and its prompt is the one its name would give.
 */
export function seatDef(seat: { role: string; mode?: ConfigSeatMode; def?: SeatDef }): SeatDef {
  if (seat.def !== undefined) return seat.def;
  const role = BUILTIN_ROLES[seat.role];
  if (role === undefined) {
    return {
      mode: "read-only",
      loop: "none",
      prompt: `${ROLE_PROMPT_DIR}/${seat.role}.md`,
      mcTools: [],
      here: "",
    };
  }
  return resolveSeatDef(role, seat.mode);
}

/** A configured seat's mode: `scratch` when configured so on a read-only role, else the role's. */
export function modeOfSeat(seat: { role: string; mode?: ConfigSeatMode; def?: SeatDef }): CrewMode {
  return seatDef(seat).mode;
}

/**
 * The operator's hooks, MCP servers, skills and CLAUDE.md never reach the crew (spec §8b.1).
 * `--restricted` ignores user, project and local settings and confines the file tools to the
 * working directory, symlinks included (probe 2026-10-20: Read, Grep and Glob are refused outside
 * the worktree and through a symlink pointing out of it); it drops Bash unless `--tools` names it,
 * so every seat's set is explicit.
 */
export const CREW_ISOLATION_FLAGS = [
  "--restricted",
  "--strict-mcp-config",
  "--disable-slash-commands",
] as const;

export const GIT_READ_TOOLS = [
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
] as const;

/** The commands a seat may run: a writer's gates, and what a read-only or scratch seat may run. */
export interface SeatCommands {
  writer: readonly string[];
  review: readonly string[];
}

export const DEFAULT_SEAT_COMMANDS: SeatCommands = Object.freeze({
  writer: Object.freeze([
    "pnpm -s lint",
    "pnpm -s typecheck",
    "pnpm -s test",
    "pnpm -s build",
    "pnpm -s vitest",
  ]),
  review: Object.freeze(["pnpm -s vitest"]),
});

/** The same command selection and validation for both crew CLIs. */
export function seatCommands(mode: CrewMode, commands: SeatCommands): readonly string[] {
  const mine = mode === "writer" ? commands.writer : commands.review;
  checkSeatCommands(mine);
  return mine;
}

const bashEntries = (cmds: readonly string[]): string[] => cmds.map((c) => `Bash(${c}:*)`);

export const WRITER_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "TodoWrite",
  ...bashEntries(DEFAULT_SEAT_COMMANDS.writer),
  ...GIT_READ_TOOLS,
  MC_TOOLS.commit,
  MC_TOOLS.syncMain,
  MC_TOOLS.askOperator,
  MC_TOOLS.reportEvidence,
] as const;

export const READONLY_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "TodoWrite",
  ...GIT_READ_TOOLS,
  ...bashEntries(DEFAULT_SEAT_COMMANDS.review),
  MC_TOOLS.askOperator,
  MC_TOOLS.reportEvidence,
] as const;

export const SCRATCH_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "TodoWrite",
  ...GIT_READ_TOOLS,
  ...bashEntries(DEFAULT_SEAT_COMMANDS.review),
  MC_TOOLS.reportFindings,
  MC_TOOLS.restoreFile,
] as const;

/** A scratch seat starts only on a review Mission Control hands it. */
export const scratchStartRefusedText = (call: string): string =>
  `${call} reviews the PRs Mission Control hands it; it is not started on a ticket.`;

/** A seat removed from config.yaml while busy: it finishes its run and takes no new one. */
export const retiringText = (call: string): string =>
  `${call} is being removed from the crew; it takes no new work`;

/** The built-in tools a seat has at all (`--tools`); `*_TOOLS` then narrow Bash by pattern. */
export const WRITER_BUILTINS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "TodoWrite",
  "Bash",
] as const;
export const READONLY_BUILTINS = ["Read", "Grep", "Glob", "TodoWrite", "Bash"] as const;

/**
 * Files the Edit and Write tools may not touch: build, install and CI config, git's own pointer,
 * and `.gitattributes` (a `-diff` there would hide a file's content from the hub's diff reads).
 * This stops the tools only; code a seat does get to run (a test it wrote) is contained by the
 * sandbox, not by this list. So `.gitattributes` is guarded here against Edit and Write only; a
 * Bash write to it relies on the commit tool's scan (Tasks 3 and 8). Each entry is denied at the
 * worktree top and at any depth below it (`protectedFileRules`), anchored to the worktree.
 */
export const PROTECTED_FILES = [
  "**/package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "**/vite.config.*",
  "**/vitest.config.*",
  "biome.json",
  "biome.jsonc",
  "**/tsconfig*.json",
  ".github/**",
  ".husky/**",
  ".claude/**",
  ".codex/**",
  ".git",
  "**/.git",
  ".npmrc",
  "**/.npmrc",
  ".pnpmfile.cjs",
  "**/.pnpmfile.cjs",
  ".gitattributes",
  // its `ignore =` hides a staged gitlink from a plain diff, and its `url` repoints a submodule
  ".gitmodules",
] as const;

/**
 * No git writes, no GitHub writes and no network from a crew process: commits, pushes and PRs go
 * through the mc tools. `git add` and `git commit` could only fail in the sandbox now; denying
 * them by name says so before they run.
 */
export const DENIED_TOOLS = [
  "Bash(git add:*)",
  "Bash(git commit:*)",
  "Bash(git push:*)",
  "Bash(gh:*)",
  "Bash(git -c:*)",
  "Bash(git config:*)",
  // `--output=<file>` makes these write a file; the guard (2b) parses argv for the rest.
  "Bash(git diff --output*)",
  "Bash(git log --output*)",
  "Bash(git show --output*)",
  "Bash(curl:*)",
  "Bash(wget:*)",
  // typed calls only; code a seat writes and runs is kept off the login keychain file by the
  // sandbox's denyRead on Library/Keychains
  "Bash(security:*)",
  "Bash(/usr/bin/security:*)",
  "WebFetch",
  "WebSearch",
  "Task",
] as const;

/** Characters with a meaning in permission-rule paths, which the CLI will not scope. */
const RULE_SYNTAX = /[()[\]{}*?!#\\]/;

/**
 * A rule path anchored to the worktree (`//` + absolute path). A relative rule would follow a `cd`
 * in Bash: the CLI resolves it against its current directory (#41, probe 2026-10-20). Throws for a
 * relative worktree, or one whose path has rule syntax or a segment with edge whitespace.
 */
export function anchoredGlob(cwd: string, glob: string): string {
  const root = cwd.replace(/\/+$/, "");
  if (!cwd.startsWith("/")) throw new Error(`crew rules: ${cwd} is not an absolute path`);
  if (RULE_SYNTAX.test(root) || root.split("/").some((s) => s !== s.trim())) {
    throw new Error(`crew rules: ${cwd} has characters a permission rule cannot hold`);
  }
  return `/${root}/${glob}`;
}

/** Plain words with single spaces; the program word has no `/`. */
const SEAT_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._=+,@-]*( [A-Za-z0-9._/=+,@-]+)*$/;

/** Words that run whatever follows them when they END an entry (the guard does not look through them). */
const SEAT_RUNNER_WORDS: ReadonlySet<string> = new Set([
  "run",
  "exec",
  "dlx",
  "x",
  "-m",
  "-c",
  "-e",
  "uvx",
  "npx",
  "bunx",
  "python",
  "python3",
  "node",
  "just",
  "make",
  "sh",
  "bash",
  "zsh",
  "dash",
  "env",
  "xargs",
  "eval",
  "sudo",
  "timeout",
  "nice",
  "nohup",
  "command",
]);
/** Flags that take code (or a module to load) as their value: refused as ANY word of an entry. */
const SEAT_CODE_FLAGS: ReadonlySet<string> = new Set([
  "-c",
  "-e",
  "-E",
  "-p",
  "-r",
  "--eval",
  "--print",
  "--require",
  "--import",
  "--loader",
]);
/**
 * Programs no seat command may start with: shells, interpreters, launchers, and IPC or network
 * tools (all lowercase: a word is lowercased before the lookup, as macOS runs `GIT` as git).
 * `python*` is the one exception, with `-m <module>` (see `seatWordsProblem`).
 */
const SEAT_FIRST_WORD_DENIED: ReadonlySet<string> = new Set([
  "git",
  "gh",
  "curl",
  "wget",
  "security",
  "sh",
  "bash",
  "zsh",
  "dash",
  "fish",
  "ksh",
  "node",
  "bun",
  "deno",
  "perl",
  "ruby",
  "php",
  "osascript",
  "open",
  "launchctl",
  "ssh",
  "scp",
  "rsync",
  "nc",
  "tmux",
  "screen",
  "script",
  "setsid",
  "coproc",
  "watch",
  "find",
  "awk",
  "gawk",
  "xargs",
  "env",
  "sudo",
  "time",
  "stdbuf",
  "builtin",
  "exec",
  "command",
  "eval",
  "timeout",
  "nice",
  "nohup",
  "npx",
  "bunx",
  "uvx",
]);
/** Package managers: an entry of one plus flags alone, or its exec/dlx forms, runs arbitrary programs. */
const SEAT_PACKAGE_MANAGERS: ReadonlySet<string> = new Set([
  "pnpm",
  "npm",
  "yarn",
  "uv",
  "poetry",
  "cargo",
  "go",
  "pip",
  "pipx",
]);
const SEAT_PM_LAUNCH_WORDS: ReadonlySet<string> = new Set(["exec", "dlx", "x"]);
const PYTHON_WORD = /^python[0-9.]*$/;
/** Task runners: the recipe file(s) the entry runs, which must be protected for the entry to load. */
export const SEAT_RECIPE_FILES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  just: ["justfile", ".justfile"],
  make: ["Makefile", "GNUmakefile"],
  task: ["Taskfile.yml", "Taskfile.yaml"],
  tox: ["tox.ini"],
  nox: ["noxfile.py"],
});

/**
 * Why the words of a seat command (already plain words) may not be one, or null. Every word is
 * lowercased before a lookup; the first word may not be a shell, interpreter, launcher or
 * network/IPC tool (`python* -m <module>`, also behind `uv run`, is allowed); no word may be a
 * code-taking flag; a package manager must be followed by a named tool, not exec/dlx/x.
 */
export function seatWordsProblem(e: string): string | null {
  const raw = e.split(" ");
  const words = raw.map((w) => w.toLowerCase());
  const first = words[0] ?? "";
  const last = words[words.length - 1] ?? "";
  if (SEAT_RUNNER_WORDS.has(last)) return `"${e}" ends at ${last}, which runs whatever follows it`;
  const bad = raw.find((w) => SEAT_CODE_FLAGS.has(w));
  if (bad !== undefined) return `"${e}" has ${bad}, which runs code given on the command line`;
  // the program that actually starts: `uv run [flags] <prog>` starts <prog>
  const positional = (from: number) => words.slice(from).findIndex((w) => !w.startsWith("-"));
  const sub1 = positional(1);
  const at =
    first === "uv" && sub1 !== -1 && words[1 + sub1] === "run"
      ? 2 + sub1 + positional(2 + sub1)
      : 0;
  const prog = at > 0 ? (words[at] ?? "") : first;
  for (const w of at > 0 ? [first, prog] : [first]) {
    if (SEAT_FIRST_WORD_DENIED.has(w)) return `"${e}" runs ${w}, which seats may never run`;
  }
  if (PYTHON_WORD.test(prog)) {
    if (words[at + 1] !== "-m" || words[at + 2] === undefined) {
      return `"${e}" runs ${prog} without -m <module>, which runs arbitrary code`;
    }
    return null;
  }
  if (SEAT_PACKAGE_MANAGERS.has(first)) {
    const sub = words.slice(1).find((w) => !w.startsWith("-"));
    if (sub === undefined) return `"${e}" names no tool after ${first}`;
    if (SEAT_PM_LAUNCH_WORDS.has(sub)) {
      return `"${e}" runs ${sub}, which runs whatever follows it`;
    }
  }
  return null;
}

/**
 * The recipe file of an entry's task runner (`just`, `make`, `task`, `tox`, `nox`) that
 * `protectedFiles` (the repo's extras, on top of the built-in list) does not cover, or null.
 */
export function unprotectedRecipeFile(
  entry: string,
  protectedFiles: readonly string[],
): string | null {
  const files = SEAT_RECIPE_FILES[(entry.split(" ")[0] ?? "").toLowerCase()];
  return files?.find((f) => !isProtectedPath(f, protectedFiles)) ?? null;
}

/** Why `g` may not be a protected-file glob (no trailing `/`, empty or `.` segments), or null. */
export function protectedGlobShapeProblem(g: string): string | null {
  if (g.endsWith("/")) return "must not end with /";
  const segs = g.split("/");
  if (segs.some((s) => s === "")) return "must not have an empty segment";
  if (segs.includes(".")) return "must not have a . segment";
  return null;
}

function checkSeatCommands(cmds: readonly string[]): void {
  for (const c of cmds) {
    if (!SEAT_COMMAND.test(c)) throw new Error(`crew rules: ${c} is not a seat command`);
    const problem = seatWordsProblem(c);
    if (problem !== null) throw new Error(`crew rules: ${c} is not a seat command: ${problem}`);
  }
}

/** A repo-relative glob that stays inside the worktree and holds no rule syntax beyond `*`. */
function checkProtectedGlobs(globs: readonly string[]): void {
  for (const g of globs) {
    if (
      g.startsWith("/") ||
      g.startsWith("./") ||
      g.startsWith("~") ||
      g.split("/").includes("..") ||
      !/^[A-Za-z0-9._/*@+-]+$/.test(g) ||
      protectedGlobShapeProblem(g) !== null
    ) {
      throw new Error(`crew rules: ${g} is not a protected-file glob`);
    }
  }
}

/** Every PROTECTED_FILES entry and the repo's extra ones, at the worktree top and at any depth. */
function protectedGlobs(extra: readonly string[]): readonly string[] {
  checkProtectedGlobs(extra);
  return [
    ...new Set(
      [...PROTECTED_FILES, ...extra].flatMap((f) => (f.startsWith("**/") ? [f] : [f, `**/${f}`])),
    ),
  ];
}

/**
 * Whether a repo-relative path matches an area glob as the CLI's Edit and Write rules read it,
 * rooted at the worktree top: `*` within one segment, `**` across any number of them (`a/**\/b`
 * includes `a/b`), and a glob that names a folder covers everything in it (`apps` and `apps/**`
 * both cover `apps/x.ts`). Area globs hold no other syntax (the config loader refuses it).
 */
export function globMatches(glob: string, path: string, ignoreCase = false): boolean {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        re += "(?:.*/)?";
      } else {
        re += ".*";
      }
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}(?:/.*)?$`, ignoreCase ? "si" : "s").test(path);
}

/** Whether a writer with this area may change `path`: no area is the whole checkout. */
export function pathInArea(area: readonly string[], path: string): boolean {
  return area.length === 0 || area.some((g) => globMatches(g, path));
}

/**
 * Whether `path` is a PROTECTED_FILES file, at the top or at any depth (as the Edit denies are).
 * A `X/**` entry also covers the bare path `X` (a symlink or file in the folder's place), and the
 * match folds case (`foldForMatch`): APFS reads `Package.json` as the same file a tool would load
 * as `package.json`.
 */
export function isProtectedPath(path: string, extra: readonly string[] = []): boolean {
  const p = foldForMatch(path);
  return protectedGlobs(extra).some(
    (g) => globMatches(g, p, true) || (g.endsWith("/**") && globMatches(g.slice(0, -3), p, true)),
  );
}

/**
 * A path folded the way APFS compares names, near enough to match protected names: NFKC, then
 * upper and lower case, so `ſ` reads `s`, Kelvin `K` reads `k`, `ß` reads `ss` and `ﬆ` reads `st`.
 * The commit tool refuses non-ASCII paths outright; this is the second layer.
 */
export function foldForMatch(path: string): string {
  return path.normalize("NFKC").toUpperCase().toLowerCase();
}

/** The author and committer name of every commit the mc commit tool makes for a seat. */
export const crewAuthorName = (call: string): string => `${call} (Mission Control)`;

/**
 * Edit and Write denies for every PROTECTED_FILES entry, at the worktree top and at any depth below
 * it (a nested `biome.json` could switch off lint for its folder), anchored to the worktree.
 */
export function protectedFileRules(cwd: string, extra: readonly string[] = []): string[] {
  return protectedGlobs(extra).flatMap((f) => {
    const g = anchoredGlob(cwd, f);
    return [`Edit(${g})`, `Write(${g})`];
  });
}

/**
 * Env every crew process gets:
 * - Bash returns to the worktree after each command, so a `cd` never moves the working directory
 *   the rules and `--restricted` resolve against (#41);
 * - no background Bash: otherwise a Bash timeout moves the command to the background and fires a
 *   successful PostToolUse while it keeps running, which would free the test lock early, and
 *   `run_in_background` returns at once (spike 2026-10-21). With it off, a timeout kills the
 *   command and `run_in_background` is refused before any hook;
 * - no self-update: the hub updates the CLI between runs (`updates.cli`), so a run's CLI never
 *   changes underneath it.
 */
export const CREW_CLI_ENV = {
  CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR: "1",
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
  DISABLE_AUTOUPDATER: "1",
} as const;

/** The folder pnpm makes for a project-local store; the commit tool never stages one. */
export const PNPM_STORE_DIR_NAME = ".pnpm-store";
/**
 * pnpm 11 reads settings from `pnpm_config_*` variables only: it ignores `npm_config_store_dir`
 * (pnpm 11.0.6's config reader; `pnpm store path` under each, 2026-10-21).
 */
export const PNPM_STORE_ENV = "pnpm_config_store_dir";
/**
 * The CLI's temp root for sandboxed commands, which they may write: their `TMPDIR` (CLI 2.1.302,
 * seen from a sandboxed Bash, 2026-10-21).
 */
export const crewSandboxTmp = (uid: number): string => `/tmp/claude-${uid}`;
/**
 * A seat's pnpm store, in the sandbox's temp root. A sandboxed pnpm cannot write the global store
 * in `~/Library`, and with no store set it falls back to `.pnpm-store/` at the top of the worktree,
 * where the commit tool's `add -A` would find it.
 */
export const crewPnpmStoreDir = (uid: number, seatId: string): string =>
  `${crewSandboxTmp(uid)}/mc-pnpm-store/${seatId}`;

/** How long a control request (interrupt, get_context_usage…) may go unanswered. */
export const CONTROL_TIMEOUT_MS = 10_000;
/**
 * After Stop interrupts and closes stdin, how long before the process gets SIGTERM; after a second
 * wait as long, SIGKILL.
 */
export const STOP_GRACE_MS = 10_000;

/** What every crew action answers on a server that runs no crew (`MC_NO_CREW=1`, or no `crew`). */
export const CREW_DISABLED = "crew is disabled on this server";
/**
 * `GET /api/agents/:id/files` for a crew seat (its note; `/files/diff` answers it as the error):
 * no host git runs in a worktree a seat can write until the guard.
 */
export const CREW_FILES_NOTE = "Files for crew seats arrive with the mailbox (phase 2d).";

/** A crew seat's call sign, in every message, refusal and commit: its id upper-cased. */
export const seatCallSign = (seatId: string): string => seatId.toUpperCase();

export const SEAT_STATES = ["idle", "starting", "running", "parked", "stopped", "error"] as const;
export type SeatState = (typeof SEAT_STATES)[number];

export interface CrewSandboxInput {
  /** The seat's working directory (its worktree). */
  cwd: string;
  /** The clone's `.git` directory (shared by every worktree). */
  gitCommonDir: string;
  /** This worktree's own git dir, `<gitCommonDir>/worktrees/<name>`. */
  worktreeGitDir: string;
  /** The operator's home directory, for the credential folders a seat may not read. */
  home: string;
  /**
   * The hub's data directory (the DB's): the DB itself and every seat's transcripts and prompt
   * files, which no seat may read.
   */
  dataDir: string;
  /**
   * Further absolute paths no seat's Bash may read, after the credential folders and the data dir:
   * the hub's checkout, every loop's folders, the other crew sessions' checkouts and
   * `crew.deny_read`, in that order (`seatDenyRead`). Repeats are dropped.
   */
  denyRead: string[];
}

/** Credential files and folders (relative to home) no seat's Bash may read. */
export const SANDBOX_DENY_READ_HOME = [
  ".ssh",
  ".config/gh",
  ".config/mission-control",
  ".aws",
  ".netrc",
  ".gnupg",
  ".git-credentials",
  ".config/git/credentials",
  ".npmrc",
  ".docker",
  ".kube",
  ".claude",
  // the Claude CLI's account and MCP config, a sibling of .claude that the entry above misses
  ".claude.json",
  // the Codex CLI's login (auth.json) and its session transcripts
  ".codex",
  // other CLIs' logins and tokens a dev machine commonly holds
  ".config/gcloud",
  ".azure",
  ".config/op",
  ".pypirc",
  ".cargo/credentials.toml",
  ".gem/credentials",
  ".vault-token",
  ".terraform.d",
  ".copilot",
  // shell history often holds pasted secrets
  ".zsh_history",
  ".bash_history",
  // the login keychain: without this, code a seat runs sees it in `security list-keychains` and
  // opens it; with it, opening fails EPERM and only the System keychain is listed (probe
  // 2026-10-20; no real item was read). The CLI's own login runs outside the sandbox.
  "Library/Keychains",
] as const;

export const CODEX_MIN_VERSION = "0.154.0";
export const CODEX_COMMAND = "codex";
/** The shell the Codex process environment and command approvals must name. */
export const CODEX_SHELL = "/bin/zsh";
export const CODEX_SEAT_PROFILE = "mc_seat";
export const CODEX_SEAT_TOKEN_ENV = "MC_SEAT_TOKEN";
/** Apply at thread start/resume too: the run config alone does not exclude project docs. */
export const CODEX_PROJECT_DOC_CONFIG = Object.freeze({ project_doc_max_bytes: 0 });

/** TOML strings in a seat config never need escaping; refuse input that would. */
export function tomlString(value: string): string {
  if (
    [...value].some(
      (c) => c === '"' || c === "\\" || c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    )
  ) {
    throw new Error("codex seat config: unsafe TOML string");
  }
  return `"${value}"`;
}

/** The guard hook as a seat's settings name it: its command line and the CLI's timeout on it. */
export interface CrewHook {
  /** From `guardHookCommand`: paths only, never the token. */
  command: string;
  /** Seconds; past it the CLI runs the tool, so the hook's own deadline is shorter. */
  timeoutS: number;
}

/** The tools whose Post events the hook sees: only a Bash call can hold the test lock. */
const POST_HOOK_MATCHER = "Bash";

/**
 * The `hooks` block (spike 2026-10-21): the guard before every tool call
 * (PreToolUse, matcher `*`), and after each Bash call ends (PostToolUse, PostToolUseFailure), when
 * a call that holds the test lock releases it.
 */
function guardHooks(hook: CrewHook): Record<GuardHookEvent, unknown[]> {
  const entry = (matcher: string) => [
    { matcher, hooks: [{ type: "command", command: hook.command, timeout: hook.timeoutS }] },
  ];
  const out = {} as Record<GuardHookEvent, unknown[]>;
  for (const e of GUARD_HOOK_EVENTS) out[e] = entry(e === "PreToolUse" ? "*" : POST_HOOK_MATCHER);
  return out;
}

/** Absolute sandbox inputs and the shared credential, data and extra read denies. */
export function sandboxReadDenies(i: CrewSandboxInput): string[] {
  // A relative path would be resolved against the CLI's cwd, not mean what the rules below say.
  for (const [k, v] of [
    ["cwd", i.cwd],
    ["home", i.home],
    ["gitCommonDir", i.gitCommonDir],
    ["worktreeGitDir", i.worktreeGitDir],
    ["dataDir", i.dataDir],
  ] as const) {
    if (!v.startsWith("/")) throw new Error(`crew sandbox: ${k} must be absolute`);
  }
  for (const p of i.denyRead) {
    if (!p.startsWith("/")) throw new Error("crew sandbox: denyRead must be absolute");
  }
  return [
    ...new Set([...SANDBOX_DENY_READ_HOME.map((d) => `${i.home}/${d}`), i.dataDir, ...i.denyRead]),
  ];
}

/**
 * The `--settings` JSON for a seat: the guard hook, and the sandbox around every Bash it runs. The
 * sandbox writes only inside the working directory (a writer's) and temp dirs, never the clone's
 * or the worktree's git dir; no network, and no escape hatch. `failIfUnavailable` stops the seat
 * rather than run unsandboxed.
 */
export function crewSandboxSettings(i: CrewSandboxInput, mode: CrewMode, hook: CrewHook): string {
  const writes = mode !== "read-only";
  const denyRead = sandboxReadDenies(i);
  return JSON.stringify({
    hooks: guardHooks(hook),
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      // Defaults to true: every Bash not explicitly denied would be allowed, bypassing the allowlist.
      autoAllowBashIfSandboxed: false,
      network: { allowedDomains: [] },
      filesystem: {
        // Nothing under a git dir. When the cwd is a linked worktree the CLI itself opens most of
        // the clone's git dir to sandboxed Bash; an explicit denyWrite on the whole
        // of it closes that (spike 2026-10-21: commit, add, update-ref, objects and
        // config.worktree all fail; git reads and the full suite still work). That also covers
        // other seats' refs and objects (#31 R19, R24) and every file inside either git dir.
        allowWrite: [],
        // The worktree's `.git` pointer (a writer's worktree is otherwise writable), which
        // rewriting would send the host's own git calls elsewhere; the clone's whole git dir; and
        // the worktree's own git dir (inside it, named so the grant reads plainly). A read-only
        // seat's whole worktree. In every mode the hub's data dir: the default one is outside
        // every write grant, but a DB under a temp dir (a preview's) would not be, and a rewritten
        // token, MCP, prompt or transcript file would reach the hub (a prompt file becomes the
        // system prompt on resume, R28).
        denyWrite: [writes ? `${i.cwd}/.git` : i.cwd, i.gitCommonDir, i.worktreeGitDir, i.dataDir],
        // Credentials and the hub's data dir, then what else on this Mac agent-run code may not
        // read: the hub, the loops, the other crew clones and the operator's own working folders.
        denyRead,
      },
    },
  });
}

export interface CrewCliInput {
  model: string;
  mode: CrewMode;
  /** Absolute path of the role brief, `roles/<CALL>.md`. */
  rolePromptFile: string;
  sessionId: string;
  /** Passed as `--effort`; absent or null: the CLI's own default. */
  effort?: CrewEffort | null;
  /** true: reattach to `sessionId` with `--resume`; false: start it with `--session-id`. */
  resume: boolean;
  /**
   * A writer's globs; Edit and Write are scoped to them, rooted at the worktree top (a slash-less
   * `apps` is the top-level folder only, as `staticPrefix` in the config loader reads it).
   * [] = the whole checkout.
   */
  area: string[];
  sandbox: CrewSandboxInput;
  /** The 0600 file holding the mc server's config and the run's token (`crewMcpConfig`). */
  mcpConfigFile: string;
  hook: CrewHook;
  /** Extra mc tools the seat's role holds, after the mode's own; each must be grantable. Default []. */
  mcTools?: readonly McToolName[];
  /** The repo's own commands; they replace the default pnpm entries. Default DEFAULT_SEAT_COMMANDS. */
  commands?: SeatCommands;
  /** Extra Edit and Write denies, on top of PROTECTED_FILES. Default []. */
  protectedFiles?: readonly string[];
}

/** What `guardHookCommand` builds the seat's hook command from. */
export interface GuardHookInput {
  /** `crew.node`: a stable path, never a Cellar one. */
  node: string;
  /** `<hub root>/apps/server/src/guard/hook-cli.ts`. */
  entry: string;
  /** The run's 0600 token file: the hook reads the token from it, so only the path is here. */
  tokenFile: string;
  /** `http://127.0.0.1:<port>/api/guard/check`. */
  url: string;
}

/**
 * The guard hook's command line. The CLI runs it through `/bin/sh`: each part is single-quoted,
 * and `|| exit 2` turns a failure before the hook can answer (node missing, an import that fails,
 * a crash) into exit 2, which blocks the tool (spike 2026-10-21). A part holding a quote or a line
 * break could not be quoted this way: refused, as is a relative path.
 */
export function guardHookCommand(i: GuardHookInput): string {
  for (const [k, v] of Object.entries(i)) {
    if (/['\n\r]/.test(v)) throw new Error(`crew hook: ${k} holds a quote or a line break`);
    if (k !== "url" && !v.startsWith("/")) throw new Error(`crew hook: ${k} must be absolute`);
  }
  const q = (v: string) => `'${v}'`;
  return `${q(i.node)} --experimental-strip-types ${q(i.entry)} ${q(i.tokenFile)} ${q(i.url)} || exit 2`;
}

/** The argv (after `claude`) for one seat's long-lived stream-json process. */
export function crewCliArgs(i: CrewCliInput): string[] {
  const base: readonly string[] =
    i.mode === "writer" ? WRITER_TOOLS : i.mode === "scratch" ? SCRATCH_TOOLS : READONLY_TOOLS;
  const cmds = i.commands ?? DEFAULT_SEAT_COMMANDS;
  const mine = seatCommands(i.mode, cmds);
  const defaults = bashEntries(
    i.mode === "writer" ? DEFAULT_SEAT_COMMANDS.writer : DEFAULT_SEAT_COMMANDS.review,
  );
  const granted = i.mcTools ?? [];
  for (const t of granted) {
    if (!MC_TOOL_GRANTS[i.mode].grantable.includes(t)) {
      throw new Error(`crew rules: ${t} cannot be granted to a ${i.mode} seat`);
    }
  }
  const globs = i.area.length > 0 ? i.area : ["**"];
  // the repo's commands take the place of the default pnpm entries, in the same position
  let placed = false;
  const allowed = base.flatMap((t) => {
    if (t === "Edit" || t === "Write") {
      return globs.map((g) => `${t}(${anchoredGlob(i.sandbox.cwd, g)})`);
    }
    if (!defaults.includes(t)) return [t];
    if (placed) return [];
    placed = true;
    return bashEntries(mine);
  });
  allowed.push(...granted.map((t) => `mcp__${MC_MCP_SERVER}__${t}`));
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    i.model,
    ...(i.effort ? ["--effort", i.effort] : []),
    ...CREW_ISOLATION_FLAGS,
    "--tools",
    (i.mode === "read-only" ? READONLY_BUILTINS : WRITER_BUILTINS).join(","),
    "--settings",
    crewSandboxSettings(i.sandbox, i.mode, i.hook),
    "--mcp-config",
    i.mcpConfigFile,
    "--allowedTools",
    ...allowed,
    "--disallowedTools",
    ...DENIED_TOOLS,
    ...protectedFileRules(i.sandbox.cwd, i.protectedFiles ?? []),
    "--append-system-prompt-file",
    i.rolePromptFile,
    i.resume ? "--resume" : "--session-id",
    i.sessionId,
  ];
}

/**
 * What a crew session's driver reports.
 * - `turn-start`: the first `assistant` line, or `tool_progress` line without `heartbeat: true`,
 *   since the session started, the last `result`, or the last user line written. So a message
 *   written mid-turn gives a second `turn-start` before the turn's one `result`.
 * - `rate-limit`: every `rate_limit_event` (the CLI sends one per turn, usually `allowed`);
 *   `resetsAt` is epoch ms.
 * - `tool-result`: one per `tool_result` in a `user` line: that tool call has ended, however it
 *   ended (done, failed, interrupted, or refused by the CLI after the guard let it through).
 * - `output`: any complete stdout line. `stderr`: one cleaned line cut at STDERR_TEXT_MAX.
 * - `exit`: once, after the last line; `close()` resolves with its `code`.
 */
export type SessionEvent =
  | { kind: "init"; sessionId: string; model: string | null }
  | { kind: "turn-start" }
  /** A rejected request is not evidence that any executing turn has ended. */
  | { kind: "turn-refused"; active: boolean }
  | { kind: "result"; isError: boolean; stopReason: string | null }
  | { kind: "rate-limit"; status: string; resetsAt: number | null }
  | { kind: "tool-result"; toolUseId: string }
  | { kind: "output"; at: number }
  | { kind: "stderr"; text: string }
  | { kind: "exit"; code: number | null; signal: string | null; reason?: string }
  /** The hub attached to a running keeper and has every line it missed; `awaiting`: a turn is on. */
  | { kind: "attached"; awaiting: boolean };

export const CANNOT_START = "could not start the CLI";

/** Where operator-facing stderr and failure reasons are cut. */
export const STDERR_TEXT_MAX = 2000;

/** The control requests a crew session sends (spike 2026-10-20). */
export type ControlSubtype = "interrupt" | "get_context_usage" | "get_usage";

const BRANCH_SLUG_MAX = 40;

/**
 * `feature/{issue}-{slug}`: the title lower-cased, runs outside `[a-z0-9]` as `-`, trimmed of `-`,
 * cut to 40 characters at a word boundary. An empty slug gives `feature/{issue}`.
 */
export function branchFor(issue: number, title: string): string {
  let slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > BRANCH_SLUG_MAX) {
    const cut = slug.lastIndexOf("-", BRANCH_SLUG_MAX);
    slug = cut > 0 ? slug.slice(0, cut) : slug.slice(0, BRANCH_SLUG_MAX);
  }
  return slug ? `feature/${issue}-${slug}` : `feature/${issue}`;
}

/**
 * Whether a seat with this area owns a top-level folder (for the Sessions tiles): no area is the
 * whole checkout, else a glob owns the folder its first segment names when that segment is
 * literal (`apps/**` and `apps/web/**` both own `apps`, and so does a slash-less `apps`). A first
 * segment holding a wildcard (`**`, `*.md`, `ap*\/**`) owns no folder. The config loader's overlap
 * check (`staticPrefix`) differs: it roots a wildcard-first glob, and a slash-less one, at the
 * checkout's top, so such a writer overlaps every other.
 */
export function areaOwnsFolder(area: readonly string[], folder: string): boolean {
  if (area.length === 0) return true;
  return area.some((g) => {
    const first = g.split("/")[0] ?? "";
    return !first.includes("*") && first === folder;
  });
}

/**
 * `GET /api/crew/sessions`: one crew session's top-level folders and who owns each. `owners` lists
 * every writer whose area lies under the folder, in config order; empty when the folder is free.
 */
export interface CrewSessionFolders {
  id: string;
  /** false: the checkout could not be read (missing, say), so `folders` is empty for that reason. */
  readable: boolean;
  folders: { name: string; owners: AgentId[] }[];
}

/** `POST /api/crew/sessions`: the name/id is independent of the repo, branch and strategy. */
export const SESSION_CHECKOUT_STRATEGIES = ["shared", "separate"] as const;
export interface NewCrewSession {
  id: string;
  repoId: string;
  source: string;
  branch: string;
  checkoutStrategy: (typeof SESSION_CHECKOUT_STRATEGIES)[number];
}

/** `POST /api/crew/sessions/:id/close`: what happened to the checkout after closing. */
export type SessionCheckoutOutcome =
  | "unmanaged"
  | "removed"
  | "retained-dirty"
  | "retained-unpushed"
  | "retained-unproven"
  | "removal-failed-partway";

/** The process protocol recorded with a crew run. */
export type CrewVendor = "claude" | "codex";
