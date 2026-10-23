import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AccountId,
  type AgentId,
  BUILTIN_ROLES,
  CONFIG_SEAT_MODES,
  type ConfigSeatMode,
  CREW_EFFORTS,
  CREW_LANES,
  CREW_MODES,
  type CrewEffort,
  type CrewLane,
  type CrewMode,
  type CrewRole,
  DEFAULT_CREW_NODE,
  DEFAULT_SEAT_COMMANDS,
  FLIGHT_POWERS,
  FLIGHT_TOOLS,
  type FlightPowers,
  hereOf,
  LOOP_KINDS,
  MC_TOOL_GRANTS,
  MC_TOOL_NAMES,
  type McToolName,
  MODE_LOOPS,
  oneWatchSeatText,
  protectedGlobShapeProblem,
  REVIEW_STATUS_CONTEXT,
  type RepoId,
  ROLE_NAME,
  ROLE_PROMPT,
  ROLE_PROMPT_DIR,
  type RoleDef,
  resolveSeatDef,
  type SeatCommands,
  type SeatDef,
  type SeatInput,
  seatDef,
  seatWordsProblem,
  type TicketState,
  unprotectedRecipeFile,
  watchOnlyToolText,
  watchOrPlanToolText,
} from "@mc/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CLI_UPDATES, type CliUpdates } from "./cli-update.ts";
import { GIT_TIMEOUT_MS, gitEnv } from "./files.ts";
import { SAFE_CONFIG } from "./runtime/git.ts";

export const REPO_AUTONOMIES = ["draft", "merge"] as const;
export type RepoAutonomy = (typeof REPO_AUTONOMIES)[number];

export interface AdoptedLoop {
  id: AgentId;
  repoId: RepoId;
  kind: "ta-loop" | "studio-loop";
  accountId: AccountId;
  stateDir: string;
  worktree: string;
  launchdLabel: string;
  logsDir?: string;
}

/** Editable display metadata stays separate from the seat's stable identity. */
export interface ConfigSeatInput extends SeatInput {
  displayCallSign?: string;
}

export const displayCallSign = z
  .string()
  .min(1)
  .max(64)
  .refine((s) => s.trim().length > 0, "must not be blank")
  .refine((s) => !/\p{Cc}/u.test(s), "must not contain control characters");

export interface CrewSeatConfig {
  displayCallSign?: string;
  id: AgentId;
  role: CrewRole;
  /** The seat's resolved role. Loaded: always set; a hand-built config may omit it (`seatDef`). */
  def?: SeatDef;
  accountId: AccountId;
  model: string;
  /** A review seat's model for small changes (`reviewDepth` light); unset: `model` reviews every change. */
  lightModel?: string;
  /** Unset: the CLI's default. */
  effort?: CrewEffort;
  /** Set only to run a read-only role as a scratch reviewer. */
  mode?: ConfigSeatMode;
  /** Globs the seat may write in; [] = the whole checkout (writers) or nothing (read-only). */
  area: string[];
  /** Set only by the crew reloader: removed from the file, kept until free. */
  retiring?: true;
}

export interface CrewSessionConfig {
  id: string;
  repoId: RepoId;
  /** Mission Control's own clone of the repo. */
  checkout: string;
  seats: CrewSeatConfig[];
}

export interface CrewConfig {
  worktrees: string;
  maxSeats: number;
  /** The node the guard hook runs under: a stable path to an executable file. Loaded: always set. */
  node?: string;
  /**
   * Loaded: set when `crew.node` fails its check (missing, not executable, silent or too old). It
   * depends on the machine, not the file's text, so it is not a config error that would stop the
   * hub: the supervisor leaves crew off with this note, and loop observation runs on.
   */
  nodeNote?: string;
  /**
   * Absolute folders agent-run code may not read (the operator's own working folders), added to every
   * seat's sandbox. None may equal or hold `worktrees`, a session checkout or the temp dir.
   * Loaded: always set (default []).
   */
  denyRead?: string[];
  /** Input + output tokens one run may use. Loaded: always set (default DEFAULT_RUN_TOKEN_BUDGET). */
  runTokenBudget?: number;
  /** Unfinished runs (set aside, not done) a writer seat may hold before it takes no new ticket. Loaded: always set (default DEFAULT_MAX_OPEN_RUNS_PER_SEAT). */
  maxOpenRunsPerSeat?: number;
  /** Start only cards labelled `lane:<lane>`; absent: no lane check. */
  lane?: CrewLane;
  /** Also start cards with no lane label. Loaded: always set (default false). */
  laneDefault?: boolean;
  /** The built-in roles plus `crew.roles`. Loaded: always set. */
  roles?: Record<string, RoleDef>;
  sessions: CrewSessionConfig[];
}

export const TeamsSelection = z
  .array(
    z
      .strictObject({
        kind: z.enum(["chat", "channel"]),
        id: z.string().min(1).max(200),
        teamId: z.string().min(1).max(200).optional(),
        name: z.string().min(1).max(200),
        repoId: z.string().min(1).max(100),
        lane: z.enum(["work", "personal"]).default("work"),
      })
      .refine((s) => s.kind !== "channel" || s.teamId !== undefined, "channel needs teamId"),
  )
  .max(50);

export const TeamsConfig = z.strictObject({
  token_command: z.array(z.string().min(1).max(2000)).min(1).max(32).optional(),
  selected: TeamsSelection.default([]),
  aliases: z.array(z.string().min(1).max(100)).max(50).default([]),
  refs: z.array(z.string().min(1).max(200)).max(200).default([]),
  areas: z
    .array(
      z.strictObject({
        repoId: z.string().min(1).max(100),
        words: z.array(z.string().min(1).max(100)).min(1).max(50),
        keywords: z
          .array(z.string().min(1).max(100))
          .min(1)
          .max(50)
          .default(["bug", "broken", "urgent"]),
      }),
    )
    .max(50)
    .default([]),
});
export type TeamsConfig = z.infer<typeof TeamsConfig>;

export interface CcConfig {
  sources?: { teams?: TeamsConfig };
  operator: { id: string; timezone: string };
  accounts: { id: AccountId; vendor: "claude" | "codex"; alertAt: number; stopAt: number }[];
  repos: {
    id: RepoId;
    github: string;
    project: number;
    statusMap: Record<string, TicketState>;
    /** Labels that mark an open issue as needing the operator; collector default is ['needs-design']. */
    needsYouLabels?: string[];
    /** Commands that run a whole suite (the guard serialises them): each is one of the repo's commands.writer entries or a word-extension of one. */
    fullSuite?: string[];
    /** The checks that decide CI on a PR head, by name. [] = every check but mc/review. Loaded: always set. */
    requiredChecks?: string[];
    /** What the repo's seats may run: `writer` for writers, `review` for read-only and scratch seats. Loaded: always set. */
    commands?: SeatCommands;
    /** Globs seats may not edit or commit, on top of core's PROTECTED_FILES. Loaded: always set (default []). */
    protectedFiles?: string[];
    /** `draft`: the board is only read. `merge`: the hub moves cards between Status columns; needs a crew session. */
    autonomy: RepoAutonomy;
    /** What FLIGHT may do here; only config.yaml sets it. Loaded: always set (default `standard`). */
    flightPowers?: FlightPowers;
  }[];
  loops: AdoptedLoop[];
  poll: {
    usageMinutes: number;
    githubSeconds: number;
    /** Minutes between periodic board reads. Loaded: always set (default 15). Absent (a hand-built config): the board is read on every GitHub poll. */
    boardMinutes?: number;
  };
  /** Absent: no crew. */
  crew?: CrewConfig;
  /**
   * `hub: auto`: the hub runs Update by itself. `cli: between_runs`: the hub keeps the `claude` CLI
   * current without stopping a run. Loaded: always set (default `off` for both).
   */
  updates?: { hub: HubUpdates; cli: CliUpdates };
}

/** `auto`: the hub runs Update by itself when main has moved and Update's refusals do not apply. */
export const HUB_UPDATES = ["off", "auto"] as const;
export type HubUpdates = (typeof HUB_UPDATES)[number];

/** A repo's current `flight_powers`; `standard` for a repo the config does not list. */
export function flightPowersOf(config: CcConfig, repoId: RepoId): FlightPowers {
  return config.repos.find((r) => r.id === repoId)?.flightPowers ?? "standard";
}

/** One configured agent: an observed loop, or a crew seat with its session. */
export type ConfiguredAgent = { id: AgentId; repoId: RepoId; accountId: AccountId } & (
  | { kind: "loop"; loop: AdoptedLoop }
  | { kind: "crew"; seat: CrewSeatConfig; sessionId: string }
);

/** Every configured agent in config order: the loops, then the crew seats session by session. */
export function configuredAgents(config: CcConfig): ConfiguredAgent[] {
  const loops = config.loops.map(
    (loop): ConfiguredAgent => ({
      kind: "loop",
      id: loop.id,
      repoId: loop.repoId,
      accountId: loop.accountId,
      loop,
    }),
  );
  const seats = (config.crew?.sessions ?? []).flatMap((session) =>
    session.seats.map(
      (seat): ConfiguredAgent => ({
        kind: "crew",
        id: seat.id,
        repoId: session.repoId,
        accountId: seat.accountId,
        seat,
        sessionId: session.id,
      }),
    ),
  );
  return [...loops, ...seats];
}

/** The one place that lists agent ids: loops, then seats. */
export function agentIds(config: CcConfig): AgentId[] {
  return configuredAgents(config).map((a) => a.id);
}

export class ConfigError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(path ? `${path}: ${message}` : message);
    this.name = "ConfigError";
    this.path = path;
  }
}

export const DEFAULT_OPERATOR_ID = "operator";

/** The hub's port; `MC_PORT` overrides it (e.g. a second, preview server beside the live one). */
export const DEFAULT_PORT = 7420;

/** A preview server beside the live hub: any port but DEFAULT_PORT, or `MC_NO_LOOP_WRITES=1`. */
export function isPreview(port: number, env: NodeJS.ProcessEnv): boolean {
  return port !== DEFAULT_PORT || env.MC_NO_LOOP_WRITES === "1";
}

/**
 * Whether this server may run crew (it still needs a `crew` section and the lock): never with
 * `MC_NO_CREW=1`, and a preview only with `MC_CREW=1`, so a preview on a copy of the database
 * never resumes the live hub's runs by default.
 */
export function crewAllowed(preview: boolean, env: NodeJS.ProcessEnv): boolean {
  return env.MC_NO_CREW !== "1" && (!preview || env.MC_CREW === "1");
}

/** What anything that is not a configured crew seat is judged as: read-only, no loop, no tools. */
export const UNKNOWN_SEAT_DEF: SeatDef = {
  mode: "read-only",
  loop: "none",
  prompt: "",
  mcTools: [],
  here: "",
};

/** A configured crew seat's resolved role; `UNKNOWN_SEAT_DEF` for anything else (fails closed). */
export function crewSeatDef(config: CcConfig, seatId: string): SeatDef {
  for (const session of config.crew?.sessions ?? []) {
    const seat = session.seats.find((s) => s.id === seatId);
    if (seat !== undefined) return seatDef(seat);
  }
  return UNKNOWN_SEAT_DEF;
}

/** The mode the guard and `/mcp` judge a seat by: its role's, read-only for an unknown seat. */
export function crewSeatMode(config: CcConfig, seatId: string): CrewMode {
  return crewSeatDef(config, seatId).mode;
}

/** The extra mc tools `/mcp` shows a seat: its role's grants. */
export function crewSeatGrants(config: CcConfig, seatId: string): McToolName[] {
  return [...crewSeatDef(config, seatId).mcTools];
}

/** `MC_PORT` as a port: unset or empty → DEFAULT_PORT; else a plain integer 1024–65535. */
export function portFromEnv(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const n = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(n >= 1024 && n <= 65535)) {
    throw new ConfigError(
      "MC_PORT",
      `must be an integer from 1024 to 65535, got ${JSON.stringify(raw)}`,
    );
  }
  return n;
}

/** A board column; also validates `POST /api/repos` status maps. */
export const ticketState = z.enum([
  "planned",
  "in progress",
  "review",
  "blocked",
  "done",
]) satisfies z.ZodType<TicketState>;
export const DEFAULT_MAX_SEATS = 8;
export const DEFAULT_RUN_TOKEN_BUDGET = 400_000;
export const DEFAULT_MAX_OPEN_RUNS_PER_SEAT = 2;
export const SEAT_ID = /^[a-z][a-z0-9-]{0,30}$/;
export const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._[\]-]*$/;
/** A launchd job label: it goes into a `launchctl print gui/<uid>/<label>` argument. */
const LAUNCHD_LABEL = /^[A-Za-z0-9._-]+$/;
const nonEmpty = z.string().min(1);
/** A repo-relative glob: no `/`, `./` or `~` start, no `..` segment, none of `{ [ ? ! , ( ) \\` or whitespace. */
export const areaGlob = nonEmpty.refine(
  (g) =>
    !g.startsWith("/") &&
    !g.startsWith("./") &&
    !g.startsWith("~") &&
    !g.split("/").includes("..") &&
    !/[{[?!,()\\\s]/.test(g),
  "must be a repo-relative glob without .. segments, a leading ~, whitespace or any of { [ ? ! , ( ) \\",
);
/** The default seat commands as fresh arrays: what a repo with no `commands` loads with. */
export const defaultSeatCommands = (): SeatCommands => ({
  writer: [...DEFAULT_SEAT_COMMANDS.writer],
  review: [...DEFAULT_SEAT_COMMANDS.review],
});
const PLAIN_WORDS = /^[A-Za-z0-9._/=+,@-]+( [A-Za-z0-9._/=+,@-]+)*$/;
/** Why `e` may not be a seat command, or null when it may. */
function seatCommandProblem(e: string): string | null {
  if (e.length < 1 || e.length > 120) return `"${e}" must be 1–120 characters`;
  if (!PLAIN_WORDS.test(e)) {
    return `"${e}" must be plain words (letters, digits and . _ / = + , @ -) separated by single spaces`;
  }
  const first = e.split(" ")[0] ?? "";
  if (first.includes("/") || !/^[A-Za-z0-9]/.test(first)) {
    return `"${e}" must start with a program name, not a path`;
  }
  return seatWordsProblem(e);
}
const seatCommand = z.string().superRefine((e, ctx) => {
  const problem = seatCommandProblem(e);
  if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
});
/** A `protected` entry: an area glob in the characters core accepts. */
const protectedGlob = areaGlob
  .refine(
    (g) => /^[A-Za-z0-9._/*@+-]+$/.test(g),
    "must hold only letters, digits and . _ / * @ + -",
  )
  .superRefine((g, ctx) => {
    const problem = protectedGlobShapeProblem(g);
    if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
  });
const percent = z.number().min(0).max(100);
const modelName = z.string().regex(MODEL_NAME, "must match /^[A-Za-z0-9][A-Za-z0-9._\\[\\]-]*$/");
const MC_TOOL_VALUES = Object.values(MC_TOOL_NAMES) as [McToolName, ...McToolName[]];
/** A `crew.roles` entry; `here` is optional and falls back to the `ROLES` row's. */
const roleSchema = z.strictObject({
  prompt: z.string().regex(ROLE_PROMPT, "must be roles/<name>.md"),
  model: modelName,
  mode: z.enum(CREW_MODES),
  loop: z.enum(LOOP_KINDS),
  tools: z.array(z.enum(MC_TOOL_VALUES)).default([]),
  here: z
    .string()
    .refine(
      (v) => v.length >= 1 && v.length <= 120 && !/\p{Cc}/u.test(v),
      "must be 1–120 characters without control characters",
    )
    .optional(),
});

// The file's snake_case shape; transformed to the camelCase CcConfig in one place.
const fileSchema = z
  .strictObject({
    sources: z.strictObject({ teams: TeamsConfig.optional() }).optional(),
    operator: z.preprocess(
      (v) =>
        typeof v === "object" && v !== null && !Array.isArray(v)
          ? Object.fromEntries(Object.entries(v).filter(([key]) => key !== "password_hash"))
          : v,
      z.strictObject({
        id: nonEmpty.default(DEFAULT_OPERATOR_ID),
        timezone: nonEmpty,
      }),
    ),
    accounts: z.array(
      z.strictObject({
        id: nonEmpty,
        vendor: z.enum(["claude", "codex"]),
        alert_at: percent,
        stop_at: percent,
      }),
    ),
    repos: z.array(
      z.strictObject({
        id: nonEmpty,
        github: nonEmpty,
        project: z.number().int().positive(),
        status_map: z.record(z.string(), ticketState),
        needs_you_labels: z.array(nonEmpty).optional(),
        full_suite: z.array(nonEmpty).default([]),
        required_checks: z
          .array(
            nonEmpty.refine(
              (c) => c !== REVIEW_STATUS_CONTEXT,
              "mc/review is Mission Control's review status, not a CI check",
            ),
          )
          .default([]),
        commands: z
          .strictObject({ writer: z.array(seatCommand), review: z.array(seatCommand) })
          .optional(),
        protected: z.array(protectedGlob).default([]),
        autonomy: z.enum(REPO_AUTONOMIES).default("draft"),
        flight_powers: z.enum(FLIGHT_POWERS).default("standard"),
      }),
    ),
    loops: z.array(
      z.strictObject({
        id: nonEmpty,
        repo_id: nonEmpty,
        kind: z.enum(["ta-loop", "studio-loop"]),
        account_id: nonEmpty,
        state_dir: nonEmpty,
        worktree: nonEmpty,
        launchd_label: z.string().regex(LAUNCHD_LABEL, "letters, digits, dot, underscore, hyphen"),
        logs_dir: nonEmpty.optional(),
      }),
    ),
    poll: z.strictObject({
      usage_minutes: z.number().min(5).max(240),
      github_seconds: z.number().min(30).max(3600),
      board_minutes: z.number().min(5).max(60).default(15),
    }),
    updates: z
      .strictObject({
        hub: z.enum(HUB_UPDATES).default("off"),
        cli: z.enum(CLI_UPDATES).default("off"),
      })
      .default({ hub: "off", cli: "off" }),
    crew: z
      .strictObject({
        worktrees: nonEmpty,
        max_seats: z.number().int().min(1).max(32).default(DEFAULT_MAX_SEATS),
        node: nonEmpty.default(DEFAULT_CREW_NODE),
        deny_read: z.array(nonEmpty).default([]),
        run_token_budget: z.number().int().positive().default(DEFAULT_RUN_TOKEN_BUDGET),
        max_open_runs_per_seat: z.number().int().positive().default(DEFAULT_MAX_OPEN_RUNS_PER_SEAT),
        lane: z.enum(CREW_LANES).optional(),
        lane_default: z.boolean().default(false),
        roles: z.record(z.string(), roleSchema).default({}),
        sessions: z.array(
          z.strictObject({
            id: z.string().regex(SEAT_ID, "must match /^[a-z][a-z0-9-]{0,30}$/"),
            repo_id: nonEmpty,
            checkout: nonEmpty,
            seats: z.array(
              z.strictObject({
                id: z.string().regex(SEAT_ID, "must match /^[a-z][a-z0-9-]{0,30}$/"),
                display_call_sign: displayCallSign.optional(),
                role: z.string(),
                account_id: nonEmpty,
                model: modelName.optional(),
                light_model: modelName.optional(),
                effort: z.enum(CREW_EFFORTS).optional(),
                mode: z.enum(CONFIG_SEAT_MODES).optional(),
                area: z.array(areaGlob).optional(),
              }),
            ),
          }),
        ),
      })
      .optional(),
  })
  .transform(
    (f): CcConfig => ({
      ...(f.sources === undefined ? {} : { sources: f.sources }),
      operator: {
        id: f.operator.id,
        timezone: f.operator.timezone,
      },
      accounts: f.accounts.map((a) => ({
        id: a.id,
        vendor: a.vendor,
        alertAt: a.alert_at,
        stopAt: a.stop_at,
      })),
      repos: f.repos.map((r) => ({
        id: r.id,
        github: r.github,
        project: r.project,
        statusMap: r.status_map,
        ...(r.needs_you_labels === undefined ? {} : { needsYouLabels: r.needs_you_labels }),
        fullSuite: r.full_suite,
        requiredChecks: r.required_checks,
        commands: r.commands ?? defaultSeatCommands(),
        protectedFiles: r.protected,
        autonomy: r.autonomy,
        flightPowers: r.flight_powers,
      })),
      loops: f.loops.map((l) => ({
        id: l.id,
        repoId: l.repo_id,
        kind: l.kind,
        accountId: l.account_id,
        stateDir: expandHome(l.state_dir),
        worktree: expandHome(l.worktree),
        launchdLabel: l.launchd_label,
        ...(l.logs_dir === undefined ? {} : { logsDir: expandHome(l.logs_dir) }),
      })),
      poll: {
        usageMinutes: f.poll.usage_minutes,
        githubSeconds: f.poll.github_seconds,
        boardMinutes: f.poll.board_minutes,
      },
      updates: { hub: f.updates.hub, cli: f.updates.cli },
      ...(f.crew === undefined
        ? {}
        : {
            crew: {
              worktrees: expandHome(f.crew.worktrees),
              maxSeats: f.crew.max_seats,
              node: expandHome(f.crew.node),
              denyRead: f.crew.deny_read.map(expandHome),
              runTokenBudget: f.crew.run_token_budget,
              maxOpenRunsPerSeat: f.crew.max_open_runs_per_seat,
              ...(f.crew.lane === undefined ? {} : { lane: f.crew.lane }),
              laneDefault: f.crew.lane_default,
              roles: {
                ...BUILTIN_ROLES,
                ...Object.fromEntries(
                  Object.entries(f.crew.roles).map(([name, r]) => [
                    name,
                    { ...r, here: r.here ?? hereOf(name) },
                  ]),
                ),
              },
              sessions: f.crew.sessions.map((x) => ({
                id: x.id,
                repoId: x.repo_id,
                checkout: expandHome(x.checkout),
                seats: x.seats.map((seat) => ({
                  id: seat.id,
                  ...(seat.display_call_sign === undefined
                    ? {}
                    : { displayCallSign: seat.display_call_sign }),
                  role: seat.role,
                  accountId: seat.account_id,
                  // the role's model when the seat names none; `checkCrew` fills it in
                  model: seat.model ?? "",
                  ...(seat.light_model === undefined ? {} : { lightModel: seat.light_model }),
                  ...(seat.effort === undefined ? {} : { effort: seat.effort }),
                  ...(seat.mode === undefined ? {} : { mode: seat.mode }),
                  area: seat.area ?? [],
                })),
              })),
            },
          }),
    }),
  );

function expandHome(p: string): string {
  if (p === "~") return homedir();
  return p.startsWith("~/") ? homedir() + p.slice(1) : p;
}

/** The most schema issues one config error names; the rest are counted. */
const MAX_SCHEMA_ISSUES_NAMED = 10;

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Render a zod issue path using the camelCase interface names; status_map keys are user data. */
function renderPath(path: PropertyKey[]): string {
  let out = "";
  path.forEach((seg, i) => {
    if (typeof seg === "number") out += `[${seg}]`;
    else {
      const userKey = path[i - 1] === "status_map";
      out += `${out ? "." : ""}${userKey ? String(seg) : camel(String(seg))}`;
    }
  });
  return out;
}

export function loadConfig(path: string): CcConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new ConfigError("", `cannot read config file ${path}: ${(e as Error).message}`);
  }
  return parseConfig(text, path, { hubRoot: findHubRoot() });
}

/**
 * The hub's own checkout: the nearest directory above this module that holds
 * `pnpm-workspace.yaml`. Derived from where the code lives, not from `process.cwd()` or git.
 */
export function findHubRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** Real path of the deepest existing ancestor, with the not-yet-existing suffix re-appended. */
export function realish(p: string): string {
  let cur = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      rest.push(cur.slice(up.length).replace(/^[\\/]+/, ""));
      cur = up;
    }
  }
}

/** Whether `child` is `parent` or lies inside it (paths compared as given). */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel));
}

/**
 * The folders a seat must be able to read, by real path: `crew.worktrees` (its worktree), every
 * session's clone (its clone's git dir), and the temp dirs the CLI works in: the hub's, which the
 * CLI inherits, and `/tmp`, where sandboxed commands keep theirs (`TMPDIR=/tmp/claude-<uid>`,
 * `crewSandboxTmp`). No denial may cover one.
 */
export function crewOwnFolders(crew: CrewConfig): string[] {
  return [
    realish(crew.worktrees),
    ...crew.sessions.map((s) => realish(s.checkout)),
    realish(tmpdir()),
    realish("/tmp"),
  ];
}

/**
 * The real path of `dir`'s git common directory, or null when `dir` is not in a git repo (or git
 * cannot say). Read-only: `rev-parse` with hooks and fsmonitor off, no optional locks, no prompt
 * and none of the server's `GIT_*` settings. It runs in a live loop's worktree too.
 */
export function gitCommonDir(dir: string): string | null {
  try {
    const out = execFileSync(
      "git",
      [
        ...SAFE_CONFIG,
        "--no-optional-locks",
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      {
        cwd: dir,
        encoding: "utf8",
        timeout: GIT_TIMEOUT_MS,
        env: { ...gitEnv(process.env), GIT_TERMINAL_PROMPT: "0" },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return realpathSync.native(out.trim());
  } catch {
    return null;
  }
}

/** The text before a glob's first `*`, cut back to its last `/`: the directory it is rooted in. */
function staticPrefix(glob: string): string {
  const star = glob.indexOf("*");
  const head = star === -1 ? glob : glob.slice(0, star);
  return head.slice(0, head.lastIndexOf("/") + 1);
}

/** Whether two areas are the same globs, in any order, repeats ignored ([] and [] are the same). */
function sameArea(a: readonly string[], b: readonly string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
}

/** Two writers overlap when any pair of their globs is rooted in nested directories. */
function areasOverlap(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return true;
  return a.some((x) => {
    const px = staticPrefix(x);
    return b.some((y) => {
      const py = staticPrefix(y);
      return px.startsWith(py) || py.startsWith(px);
    });
  });
}

/** The first writer pair (by `seatDef`) with different, overlapping areas, or null. */
export function writerAreaConflict(seats: readonly CrewSeatConfig[]): [string, string] | null {
  const writers: CrewSeatConfig[] = [];
  for (const seat of seats) {
    if (seatDef(seat).mode !== "writer") continue;
    for (const w of writers) {
      if (!sameArea(w.area, seat.area) && areasOverlap(w.area, seat.area)) return [w.id, seat.id];
    }
    writers.push(seat);
  }
  return null;
}

/** A seat as config.yaml says it (optional keys only when set). */
export function seatInput(seat: CrewSeatConfig): ConfigSeatInput {
  return {
    id: seat.id,
    ...(seat.displayCallSign === undefined ? {} : { displayCallSign: seat.displayCallSign }),
    role: seat.role,
    accountId: seat.accountId,
    model: seat.model,
    ...(seat.effort !== undefined ? { effort: seat.effort } : {}),
    ...(seat.mode !== undefined ? { mode: seat.mode } : {}),
    area: [...seat.area],
  };
}

/** Whether `prompt` (relative to the hub) is a regular file whose real path lies in the roles folder. */
function isPromptFile(hubRoot: string, prompt: string, rolesDirReal: string): boolean {
  try {
    const real = realpathSync.native(join(hubRoot, prompt));
    return statSync(real).isFile() && real !== rolesDirReal && isInside(real, rolesDirReal);
  } catch {
    return false;
  }
}

function checkCrew(cfg: CcConfig, hubRootPath: string | null): void {
  const crew = cfg.crew;
  if (!crew) return;
  const repoIds = new Set(cfg.repos.map((r) => r.id));
  const claudeAccounts = new Set(
    cfg.accounts.filter((a) => a.vendor === "claude").map((a) => a.id),
  );
  const accountIds = new Set(cfg.accounts.map((a) => a.id));
  if (hubRootPath === null) {
    throw new ConfigError("crew", "cannot locate the hub's own checkout");
  }
  const forbidden: { label: string; dir: string }[] = [
    { label: "the hub's checkout", dir: realish(hubRootPath) },
  ];
  for (const l of cfg.loops) {
    forbidden.push({ label: `loop ${l.id} worktree`, dir: realish(l.worktree) });
    forbidden.push({ label: `loop ${l.id} state_dir`, dir: realish(l.stateDir) });
    if (l.logsDir !== undefined) {
      forbidden.push({ label: `loop ${l.id} logs_dir`, dir: realish(l.logsDir) });
    }
  }
  // Real paths, containment in both directions: a crew path may neither lie inside nor hold one.
  const checkPath = (path: string, value: string) => {
    const abs = realish(value);
    for (const f of forbidden) {
      if (isInside(abs, f.dir) || isInside(f.dir, abs)) {
        throw new ConfigError(path, `${value} is, holds or lies inside ${f.label} (${f.dir})`);
      }
    }
  };
  if (!isAbsolute(crew.worktrees)) {
    throw new ConfigError("crew.worktrees", `${crew.worktrees} is not an absolute path`);
  }
  checkPath("crew.worktrees", crew.worktrees);
  const roles = crew.roles ?? { ...BUILTIN_ROLES };
  const rolesDirReal = realish(join(hubRootPath, ROLE_PROMPT_DIR));
  for (const [name, r] of Object.entries(roles)) {
    if (BUILTIN_ROLES[name] === r) continue;
    const at = `crew.roles.${name}`;
    if (!ROLE_NAME.test(name)) {
      throw new ConfigError(
        at,
        "role names are 2–16 capital letters or digits, starting with a letter",
      );
    }
    if (!MODE_LOOPS[r.mode].includes(r.loop)) {
      throw new ConfigError(
        `${at}.loop`,
        `a ${r.mode} role's loop is ${MODE_LOOPS[r.mode].join(" or ")}, not ${r.loop}`,
      );
    }
    for (const t of r.tools) {
      if (!MC_TOOL_GRANTS[r.mode].grantable.includes(t)) {
        throw new ConfigError(`${at}.tools`, `${t} cannot be granted to a ${r.mode} role`);
      }
      if (t === MC_TOOL_NAMES.readTicket) {
        if (r.loop !== "watch" && r.loop !== "plan") {
          throw new ConfigError(`${at}.tools`, watchOrPlanToolText(t));
        }
      } else if (FLIGHT_TOOLS.includes(t) && r.loop !== "watch") {
        throw new ConfigError(`${at}.tools`, watchOnlyToolText(t));
      }
    }
    if (!isPromptFile(hubRootPath, r.prompt, rolesDirReal)) {
      throw new ConfigError(`${at}.prompt`, `${r.prompt} is not a file in the hub's roles folder`);
    }
  }
  // A checkout elsewhere on disk can still be the same repository (a loop's worktree is a linked
  // worktree of a repo outside it): git in the crew clone (fetch --prune, worktree add) and the
  // seats' sandboxed writes would land in it. Read only when a checkout is a repo at all.
  let repos: { label: string; common: string }[] | null = null;
  const sharedRepo = (checkout: string): string | null => {
    const common = gitCommonDir(checkout);
    if (common === null) return null;
    repos ??= [
      { label: "the hub's checkout", dir: hubRootPath },
      ...cfg.loops.map((l) => ({ label: `loop ${l.id} worktree`, dir: l.worktree })),
    ].flatMap(({ label, dir }) => {
      const c = gitCommonDir(dir);
      return c === null ? [] : [{ label, common: c }];
    });
    return repos.find((r) => r.common === common)?.label ?? null;
  };
  const worktreesReal = realish(crew.worktrees);
  const checkouts: string[] = [];

  const seatIds = new Set<string>(cfg.loops.map((l) => l.id));
  const callSigns = new Set(cfg.loops.map((l) => l.id.toLowerCase()));
  let watchSeat: string | null = null;
  const sessionIds = new Set<string>();
  let seatCount = 0;
  crew.sessions.forEach((session, si) => {
    const at = `crew.sessions[${si}]`;
    if (sessionIds.has(session.id)) {
      throw new ConfigError(`${at}.id`, `duplicate id "${session.id}"`);
    }
    sessionIds.add(session.id);
    if (!repoIds.has(session.repoId)) {
      throw new ConfigError(`${at}.repoId`, `unknown repo "${session.repoId}"`);
    }
    checkPath(`${at}.checkout`, session.checkout);
    const shared = sharedRepo(session.checkout);
    if (shared !== null) {
      throw new ConfigError(
        `${at}.checkout`,
        `${session.checkout} shares its git repository with ${shared}`,
      );
    }
    const checkoutReal = realish(session.checkout);
    for (const other of checkouts) {
      if (isInside(checkoutReal, other) || isInside(other, checkoutReal)) {
        throw new ConfigError(
          `${at}.checkout`,
          `${session.checkout} is, holds or lies inside another session's checkout`,
        );
      }
    }
    checkouts.push(checkoutReal);
    if (isInside(checkoutReal, worktreesReal) || isInside(worktreesReal, checkoutReal)) {
      throw new ConfigError(
        `${at}.checkout`,
        `${session.checkout} and crew.worktrees nest each other`,
      );
    }
    const writers: CrewSeatConfig[] = [];
    session.seats.forEach((seat, i) => {
      const sp = `${at}.seats[${i}]`;
      if (seatIds.has(seat.id)) {
        throw new ConfigError(
          `${sp}.id`,
          `duplicate id "${seat.id}" (seat and loop ids share one namespace)`,
        );
      }
      seatIds.add(seat.id);
      const call = (seat.displayCallSign ?? seat.id).trim().toLowerCase();
      if (callSigns.has(call)) {
        throw new ConfigError(`${sp}.displayCallSign`, "call signs must be unique");
      }
      callSigns.add(call);
      if (!accountIds.has(seat.accountId)) {
        throw new ConfigError(`${sp}.accountId`, `unknown account "${seat.accountId}"`);
      }
      if (!claudeAccounts.has(seat.accountId)) {
        throw new ConfigError(
          `${sp}.accountId`,
          `account "${seat.accountId}" is not a claude account`,
        );
      }
      const role = roles[seat.role];
      if (role === undefined) {
        throw new ConfigError(`${sp}.role`, `unknown role "${seat.role}"`);
      }
      if (seat.mode === "scratch" && role.mode !== "read-only") {
        throw new ConfigError(
          `${sp}.mode`,
          `scratch is for read-only roles (RETRO), not ${seat.role}`,
        );
      }
      const def = resolveSeatDef(role, seat.mode);
      if (def.loop === "watch") {
        if (watchSeat !== null) {
          throw new ConfigError(`${sp}.role`, oneWatchSeatText(watchSeat));
        }
        watchSeat = seat.id;
      }
      seat.def = def;
      seat.model ||= role.model;
      if (def.mode !== "writer") {
        if (seat.area.length > 0) {
          throw new ConfigError(`${sp}.area`, `${seat.role} is ${role.mode} and takes no area`);
        }
        return;
      }
      const conflict = writerAreaConflict([...writers, seat]);
      if (conflict !== null) {
        throw new ConfigError(
          `${sp}.area`,
          `areas overlap: ${conflict[0]} and ${conflict[1]}; writers may share an area only when it is the same list of globs`,
        );
      }
      writers.push(seat);
    });
    seatCount += session.seats.length;
  });
  // A denial over the crew's own folders would leave a seat unable to read its worktree, its clone's
  // git dir, or the temp dirs the CLI works in.
  // Compared lowercased: on a case-insensitive disk a folder that doesn't exist yet keeps whatever
  // case it was written in, and resolves to the crew's own folder once it does.
  const lower = (p: string) => realish(p).toLowerCase();
  const ownFolders = crewOwnFolders(crew).map(lower);
  const crewDirs = [crew.worktrees, ...crew.sessions.map((s) => s.checkout)].map(lower);
  for (const p of crew.denyRead ?? []) {
    if (!isAbsolute(p)) throw new ConfigError("crew.deny_read", `${p} is not an absolute path`);
    const real = lower(p);
    if (ownFolders.some((own) => isInside(own, real))) {
      throw new ConfigError("crew.deny_read", `${p} holds the crew's own folders`);
    }
    if (crewDirs.some((dir) => isInside(real, dir))) {
      throw new ConfigError("crew.deny_read", `${p} is inside the crew's own folders`);
    }
  }
  if (seatCount > crew.maxSeats) {
    throw new ConfigError("crew.maxSeats", `${seatCount} seats exceed max_seats ${crew.maxSeats}`);
  }
  const problem = nodeProblem(crew.node ?? DEFAULT_CREW_NODE);
  if (problem !== null) crew.nodeNote = `crew.node: ${problem}`;
}

/** Why `node` cannot run the guard hook, or null when it can. */
function nodeProblem(node: string): string | null {
  if (!isExecutableFile(node)) return `${node} is not an executable file`;
  const version = nodeVersion(node);
  if (version === null) return `${node} did not report a Node version`;
  const [major = 0, minor = 0] = version.split(".").map(Number);
  if (major < HOOK_NODE_MIN[0] || (major === HOOK_NODE_MIN[0] && minor < HOOK_NODE_MIN[1])) {
    return `${node} is Node ${version}; ${HOOK_NODE_MIN.join(".")} or later is needed`;
  }
  return null;
}

/** The guard hook runs as TypeScript: type stripping arrived in Node 22.6. */
const HOOK_NODE_MIN = [22, 6] as const;
const NODE_VERSION_TIMEOUT_MS = 5000;
/** `<node> --version` per path, read once per process. */
const nodeVersions = new Map<string, string | null>();

/** What `<node> --version` reports (`22.6.0`), or null when it does not run or say so. */
function nodeVersion(node: string): string | null {
  const known = nodeVersions.get(node);
  if (known !== undefined) return known;
  let version: string | null = null;
  try {
    const out = execFileSync(node, ["--version"], {
      encoding: "utf8",
      timeout: NODE_VERSION_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
    version = /^v(\d+\.\d+\.\d+)\s*$/.exec(out)?.[1] ?? null;
  } catch {
    version = null;
  }
  nodeVersions.set(node, version);
  return version;
}

function isExecutableFile(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

const writerOf = (r: { commands?: { writer: readonly string[] } }): readonly string[] =>
  r.commands?.writer ?? DEFAULT_SEAT_COMMANDS.writer;

/** Whether the CLI would let a seat run `cmd`: one of the repo's writer commands is `cmd` or a word-prefix of it. */
function seatsMayRun(writer: readonly string[], cmd: string): boolean {
  return writer.some((p) => cmd === p || cmd.startsWith(`${p} `));
}

/**
 * Validates config.yaml text: the one loader for the file the server starts with and for any text
 * it would write (`config-write.ts`). `source` names the text in errors (a path, or a description).
 * `guard.hubRoot` is the hub's own checkout, which crew paths must stay clear of; with no guard it is
 * found from this module's location. A crew section with no hub root is an error (fails closed).
 */
export function parseConfig(
  text: string,
  source: string,
  guard?: { hubRoot: string | null },
): CcConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ConfigError("", `invalid YAML in ${source}: ${(e as Error).message}`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const [issue, ...rest] = parsed.error.issues;
    if (!issue) throw new ConfigError("", "invalid config");
    const named = rest.slice(0, MAX_SCHEMA_ISSUES_NAMED - 1);
    const more = rest.length - named.length;
    const message =
      issue.message +
      named.map((i) => `; ${renderPath(i.path)}: ${i.message}`).join("") +
      (more > 0 ? ` (and ${more} more)` : "");
    throw new ConfigError(renderPath(issue.path), message);
  }
  const cfg = parsed.data;
  for (const [list, items] of [
    ["accounts", cfg.accounts],
    ["repos", cfg.repos],
    ["loops", cfg.loops],
  ] as const) {
    const seen = new Set<string>();
    items.forEach((x, i) => {
      if (seen.has(x.id)) throw new ConfigError(`${list}[${i}].id`, `duplicate id "${x.id}"`);
      seen.add(x.id);
    });
  }
  // The usage readers use the machine's one login per vendor (Keychain OAuth, `codex
  // app-server`): a second account of a vendor would silently report the first one's usage.
  const vendors = new Set<string>();
  cfg.accounts.forEach((a, i) => {
    if (vendors.has(a.vendor)) {
      throw new ConfigError(
        `accounts[${i}].vendor`,
        `second "${a.vendor}" account: usage is read from the single ${a.vendor} login, so only one account per vendor is supported`,
      );
    }
    vendors.add(a.vendor);
  });
  const repoIds = new Set(cfg.repos.map((r) => r.id));
  const accountIds = new Set(cfg.accounts.map((a) => a.id));
  const crewRepoIds = new Set((cfg.crew?.sessions ?? []).map((s) => s.repoId));
  cfg.repos.forEach((r, i) => {
    if (r.autonomy === "merge" && !crewRepoIds.has(r.id)) {
      throw new ConfigError(
        `repos[${i}].autonomy`,
        `"merge" needs a crew session for repo "${r.id}"`,
      );
    }
  });
  cfg.loops.forEach((l, i) => {
    if (!repoIds.has(l.repoId)) {
      throw new ConfigError(`loops[${i}].repoId`, `unknown repo "${l.repoId}"`);
    }
    if (!accountIds.has(l.accountId)) {
      throw new ConfigError(`loops[${i}].accountId`, `unknown account "${l.accountId}"`);
    }
  });
  // A task runner reads a recipe file: a seat that can edit it can change what the entry runs.
  cfg.repos.forEach((r, i) => {
    for (const list of ["writer", "review"] as const) {
      (r.commands?.[list] ?? []).forEach((cmd, at) => {
        const file = unprotectedRecipeFile(cmd, r.protectedFiles ?? []);
        if (file !== null) {
          throw new ConfigError(
            `repos[${i}].commands.${list}[${at}]`,
            `"${cmd}" runs recipes from ${file}, which must be listed in protected`,
          );
        }
      });
    }
  });
  // A suite the guard would lock for but the CLI then refuses would hold the lock to no purpose.
  cfg.repos.forEach((r, i) => {
    for (const cmd of r.fullSuite ?? []) {
      // a shorter writer command also runs the suite: it must be a full_suite entry itself
      const shorter = writerOf(r).find(
        (w) => cmd.startsWith(`${w} `) && !(r.fullSuite ?? []).includes(w),
      );
      if (shorter !== undefined) {
        throw new ConfigError(
          `repos[${i}].full_suite`,
          `"${cmd}" extends the writer command "${shorter}", which also runs the suite: list "${shorter}" in full_suite too, or name "${cmd}" as the writer command instead`,
        );
      }
      if (!seatsMayRun(writerOf(r), cmd)) {
        throw new ConfigError(
          `repos[${i}].full_suite`,
          `${cmd} is not a command crew seats may run`,
        );
      }
    }
  });
  checkCrew(cfg, guard ? guard.hubRoot : findHubRoot());
  return cfg;
}
