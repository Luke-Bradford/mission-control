import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BoardItem,
  DEFAULT_REPO_RULES,
  freezeRules,
  type RepoRules,
  type TicketView,
} from "@mc/core";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import type { CliHold } from "../src/cli-update.ts";
import type { CcConfig, CrewSeatConfig } from "../src/config.ts";
import { TestLock } from "../src/guard/lock.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { endKeeper } from "../src/runtime/keeper.ts";
import {
  createSupervisor,
  type Supervisor,
  type SupervisorDeps,
  SupervisorError,
} from "../src/runtime/supervisor.ts";
import { Store } from "../src/store.ts";
import { expectNoLeftovers } from "./leftovers.ts";

const authReads = vi.hoisted(() => [] as string[]);
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const os = await vi.importActual<typeof import("node:os")>("node:os");
  const path = await vi.importActual<typeof import("node:path")>("node:path");
  const url = await vi.importActual<typeof import("node:url")>("node:url");
  return {
    ...real,
    readFileSync: (...args: Parameters<typeof real.readFileSync>) => {
      const file = args[0];
      if (typeof file !== "number") {
        const name = path.resolve(file instanceof URL ? url.fileURLToPath(file) : file.toString());
        const home = path.join(os.homedir(), ".codex");
        if (name === home || name.startsWith(`${home}${path.sep}`)) {
          authReads.push(name);
          throw new Error("test attempted to read the operator's Codex home");
        }
      }
      return real.readFileSync(...args);
    },
  };
});

/** prepareCheckout calls in flight at once, per clone (R22: they must queue). */
const prep = vi.hoisted(() => ({
  inFlight: 0,
  maxInFlight: 0,
  /** Set: every prepareCheckout waits for it (a start held in its checkout). */
  gate: null as Promise<void> | null,
  /** Set: every removeCheckout fails (a worktree that will not go). */
  failRemove: false,
  /** Set: every line written to a CLI session throws, as to one whose process is gone. */
  failWrite: false,
  sessions: [] as import("../src/runtime/session.ts").CrewSession[],
  /** Set: every existingCheckout (a resume's) waits for it. */
  resumeGate: null as Promise<void> | null,
  resumeChecks: 0,
  /** Set: every attachSession (a restart's take-back) waits for it. */
  attachGate: null as Promise<void> | null,
  attaches: [] as string[],
  /** Set: every attach hears the hello of a keeper from before #798 (awaiting, no parsedResults). */
  oldKeeperHello: false,
  closeGate: null as Promise<void> | null,
  closing: 0,
  /** The `peers` each prepare call was given, in order. */
  peers: [] as unknown[],
}));
vi.mock("../src/runtime/checkouts.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/runtime/checkouts.ts")>();
  return {
    ...real,
    existingCheckout: async (...a: Parameters<typeof real.existingCheckout>) => {
      prep.resumeChecks++;
      if (prep.resumeGate) await prep.resumeGate;
      return real.existingCheckout(...a);
    },
    removeCheckout: async (...a: Parameters<typeof real.removeCheckout>) => {
      if (prep.failRemove) throw new Error("worktree is locked");
      return real.removeCheckout(...a);
    },
    preparePlanCheckout: async (i: Parameters<typeof real.preparePlanCheckout>[0]) => {
      prep.peers.push(i.peers);
      return real.preparePlanCheckout(i);
    },
    prepareDetachedCheckout: async (i: Parameters<typeof real.prepareDetachedCheckout>[0]) => {
      prep.peers.push(i.peers);
      return real.prepareDetachedCheckout(i);
    },
    prepareScratch: async (i: Parameters<typeof real.prepareScratch>[0]) => {
      prep.peers.push(i.peers);
      return real.prepareScratch(i);
    },
    prepareCheckout: async (i: Parameters<typeof real.prepareCheckout>[0]) => {
      prep.peers.push(i.peers);
      prep.inFlight++;
      prep.maxInFlight = Math.max(prep.maxInFlight, prep.inFlight);
      try {
        await new Promise<void>((r) => setImmediate(r));
        if (prep.gate) await prep.gate;
        return await real.prepareCheckout(i);
      } finally {
        prep.inFlight--;
      }
    },
    prepareReadOnlyCheckout: async (i: Parameters<typeof real.prepareReadOnlyCheckout>[0]) => {
      prep.peers.push(i.peers);
      prep.inFlight++;
      prep.maxInFlight = Math.max(prep.maxInFlight, prep.inFlight);
      try {
        await new Promise<void>((r) => setImmediate(r));
        if (prep.gate) await prep.gate;
        return await real.prepareReadOnlyCheckout(i);
      } finally {
        prep.inFlight--;
      }
    },
  };
});

vi.mock("../src/runtime/session.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/runtime/session.ts")>();
  return {
    ...real,
    attachSession: async (...a: Parameters<typeof real.attachSession>) => {
      prep.attaches.push(a[0].dir);
      if (prep.attachGate) await prep.attachGate;
      const [i] = a;
      const asked = i.awaiting;
      const found = await real.attachSession(
        prep.oldKeeperHello && asked !== undefined
          ? {
              ...i,
              awaiting: (h) => asked({ ...h, awaiting: true, parsedResults: undefined }),
            }
          : i,
      );
      if (found.kind === "attached") {
        const close = found.session.close.bind(found.session);
        found.session.close = async () => {
          prep.closing++;
          if (prep.closeGate) await prep.closeGate;
          return close();
        };
      }
      return found;
    },
    startSession: (...a: Parameters<typeof real.startSession>) => {
      const session = real.startSession(...a);
      prep.sessions.push(session);
      return new Proxy(session, {
        get(target, key) {
          if (key === "send" && prep.failWrite) {
            return () => {
              throw new Error("session ended");
            };
          }
          const v = Reflect.get(target, key);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    },
  };
});

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const OLD_KEEPER = fileURLToPath(new URL("./fixtures/old-keeper-cli.mjs", import.meta.url));
const HUB_ROLES = fileURLToPath(new URL("../../../roles", import.meta.url));
const HUB_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
/** The port seats are told the hub is on: nothing listens on 1, so a hook run here gets no verdict. */
const HUB_PORT = 1;

let dir: string;
let clone: string;
let root: string;
let dbPath: string;
let store: Store;
let bus: ChangeBus;
let recordFile: string;
const sups: Supervisor[] = [];

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=a@b", "-c", "user.name=n", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const TICKET: TicketView = {
  number: 42,
  title: "Fix the stop race",
  url: "https://github.com/o/mc/issues/42",
  state: "open",
  body: "The adapter's stop() races the exit handler.",
  bodyTruncated: false,
  labels: [],
  milestone: null,
  subIssues: [],
  pullRequests: [],
};
/** No area labels, and nothing the card must have: only the checks a test sets up apply. */
const START_RULES: RepoRules = freezeRules({ ...DEFAULT_REPO_RULES, needs: [] });
const boardCard = (n: number, over: Partial<BoardItem> = {}): BoardItem => ({
  repoId: "mc",
  issueNumber: n,
  title: `Ticket ${n}`,
  status: "Ready",
  state: "planned",
  labels: [],
  assignees: [],
  priority: null,
  updatedAt: 0,
  url: "u",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: "S",
  closed: false,
  prioritySource: null,
  createdAt: 0,
  itemId: `I${n}`,
  projectId: "P1",
  ...over,
});
const BRANCH = "feature/42-fix-the-stop-race";
const TZ = "Europe/London";

function config(): CcConfig {
  return {
    operator: { id: "op", timezone: TZ },
    accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
    repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
    loops: [],
    poll: { usageMinutes: 30, githubSeconds: 60 },
    crew: {
      worktrees: root,
      maxSeats: 8,
      node: process.execPath,
      sessions: [
        {
          id: "mc-crew",
          repoId: "mc",
          checkout: clone,
          seats: [
            {
              id: "guido-1",
              role: "GUIDO",
              accountId: "claude-main",
              model: "haiku",
              effort: "high",
              area: ["apps/**"],
            },
            { id: "retro", role: "RETRO", accountId: "claude-main", model: "haiku", area: [] },
            { id: "fao-1", role: "FAO", accountId: "claude-main", model: "haiku", area: [] },
          ],
        },
      ],
    },
  };
}

type FetchTicket = (repo: CcConfig["repos"][number], n: number) => Promise<TicketView | null>;
const anyTicket: FetchTicket = async (_repo, n) =>
  n === TICKET.number ? TICKET : { ...TICKET, number: n, title: `Other ticket ${n}` };

function make(
  over: {
    enabled?: boolean;
    fetchTicket?: FetchTicket;
    command?: string;
    codexCommand?: string;
    codexAuthPath?: string;
    worktrees?: string;
    extraArgs?: string[];
    resumeWindowMs?: number;
    tokens?: RunTokens;
    lock?: TestLock;
    hubRoot?: string;
    rolesDir?: string;
    node?: string;
    nodeNote?: string;
    scratchRetro?: boolean;
    retroLightModel?: string;
    extraSeat?: CrewSeatConfig;
    /** A second, seatless session "other". */
    secondSession?: boolean;
    autonomy?: "merge" | "draft";
    claim?: SupervisorDeps["claim"];
    repo?: Partial<CcConfig["repos"][number]>;
    cliHold?: CliHold;
    cliVersion?: SupervisorDeps["cliVersion"];
    rules?: SupervisorDeps["rules"];
    login?: string | null;
    profiles?: SupervisorDeps["profiles"];
    inbox?: SupervisorDeps["inbox"];
    processStart?: SupervisorDeps["processStart"];
    controlTimeoutMs?: number;
    now?: () => number;
    checks?: SupervisorDeps["checks"];
  } = {},
) {
  const fetchTicket = vi.fn(over.fetchTicket ?? anyTicket);
  const log = vi.fn((_msg: string) => {});
  const cfg = config();
  if (over.autonomy !== undefined && cfg.repos[0]) cfg.repos[0].autonomy = over.autonomy;
  if (over.repo && cfg.repos[0]) Object.assign(cfg.repos[0], over.repo);
  if (over.worktrees !== undefined && cfg.crew) cfg.crew.worktrees = over.worktrees;
  if (over.node !== undefined && cfg.crew) cfg.crew.node = over.node;
  if (over.nodeNote !== undefined && cfg.crew) cfg.crew.nodeNote = over.nodeNote;
  if (over.scratchRetro) {
    const retro = cfg.crew?.sessions[0]?.seats.find((s) => s.id === "retro");
    if (retro) retro.mode = "scratch";
  }
  if (over.retroLightModel !== undefined) {
    const retro = cfg.crew?.sessions[0]?.seats.find((s) => s.id === "retro");
    if (retro) retro.lightModel = over.retroLightModel;
  }
  if (over.extraSeat) cfg.crew?.sessions[0]?.seats.push(over.extraSeat);
  if (over.secondSession) {
    cfg.crew?.sessions.push({
      id: "other",
      repoId: "mc",
      checkout: join(dir, "clone2"),
      seats: [],
    });
  }
  const tokens = over.tokens ?? new RunTokens();
  const lock = over.lock ?? new TestLock();
  const codexAuthPath = over.codexAuthPath ?? join(dir, "fake-codex-auth.json");
  if (over.codexAuthPath === undefined && !existsSync(codexAuthPath))
    writeFileSync(codexAuthPath, '{"fake":"account"}', { mode: 0o600 });
  const sup = createSupervisor({
    config: cfg,
    store,
    bus,
    dbPath,
    rules: over.rules ?? (async () => START_RULES),
    login: () => (over.login === undefined ? "me" : over.login),
    command: over.command ?? process.execPath,
    codexCommand: over.codexCommand,
    codexAuthPath,
    commandArgs:
      over.command === undefined ? [FAKE, "--record", recordFile, ...(over.extraArgs ?? [])] : [],
    resumeWindowMs: over.resumeWindowMs ?? 500,
    fetchTicket,
    ...(over.claim === undefined ? {} : { claim: over.claim }),
    ...(over.profiles === undefined ? {} : { profiles: over.profiles }),
    ...(over.inbox === undefined ? {} : { inbox: over.inbox }),
    ...(over.cliHold === undefined ? {} : { cliHold: over.cliHold }),
    cliVersion: over.cliVersion ?? (async () => null),
    enabled: over.enabled ?? true,
    stopGraceMs: 300,
    processStart: over.processStart,
    controlTimeoutMs: over.controlTimeoutMs ?? 500,
    now: over.now,
    log,
    tokens,
    lock,
    ...(over.checks === undefined ? {} : { checks: over.checks }),
    hubPort: HUB_PORT,
    hubRoot: over.hubRoot ?? HUB_ROOT,
    ...(over.rolesDir === undefined ? {} : { rolesDir: over.rolesDir }),
  });
  sups.push(sup);
  return { sup, fetchTicket, log, tokens, lock, cfg };
}

/**
 * What the fake CLI received: its start line, then every stdin line, parsed. Only complete
 * lines count: the fake may be mid-write, so a tail with no newline is not a record yet.
 */
const recorded = () => {
  if (!existsSync(recordFile)) return [];
  const text = readFileSync(recordFile, "utf8");
  return text
    .slice(0, text.lastIndexOf("\n") + 1)
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l));
};
const userLines = () =>
  recorded()
    .filter((l) => l.type === "user")
    .map((l) => l.message.content as string);

const seatState = (seatId: string) => store.seatSession(seatId)?.state;
const until = (fn: () => unknown) => vi.waitFor(fn, { timeout: 5000, interval: 10 });
/**
 * A run's private directories are removed asynchronously (after its keeper exits); under CI load
 * that can take seconds, so wait for the path to go rather than asserting at once (#689). Kept under
 * the 15 s test timeout so a real cleanup failure reports here.
 */
const CLEANUP_WAIT_MS = 8000;
const untilGone = (path: string) =>
  vi.waitFor(() => expect(existsSync(path)).toBe(false), {
    timeout: CLEANUP_WAIT_MS,
    interval: 25,
  });

async function refusal(p: Promise<unknown> | (() => unknown)): Promise<SupervisorError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(SupervisorError);
    return e as SupervisorError;
  }
  throw new Error("expected a SupervisorError");
}

/** One tmp root for every folder this file makes: `afterAll` looks for processes that name it. */
let tmpRoot: string;
beforeAll(() => {
  tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "mc-sv-")));
});
afterAll(async () => {
  try {
    await expectNoLeftovers(tmpRoot);
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

beforeEach(() => {
  prep.failRemove = false;
  prep.resumeGate = null;
  prep.attachGate = null;
  prep.attaches = [];
  prep.oldKeeperHello = false;
  prep.closeGate = null;
  prep.closing = 0;
  prep.failWrite = false;
  prep.sessions = [];
  prep.peers = [];
  dir = realpathSync(mkdtempSync(join(tmpRoot, "t-")));
  const origin = join(dir, "origin.git");
  const seed = join(dir, "seed");
  clone = join(dir, "clone");
  root = join(dir, "worktrees");
  recordFile = join(dir, "record.jsonl");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "init", "-q", "-b", "main", seed);
  writeFileSync(join(seed, "README.md"), "hi\n");
  writeFileSync(join(seed, "CLAUDE.md"), "Repo rule: keep tests green.\n");
  git(seed, "add", "-A");
  git(seed, "commit", "-qm", "init");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(dir, "clone", "-q", origin, clone);
  dbPath = join(dir, "db", "mc.sqlite");
  mkdirSync(join(dir, "db"));
  store = new Store(dbPath);
  store.replaceBoard(
    "mc",
    [7, 42, 43, 44].map((n) => boardCard(n)),
  );
  bus = new ChangeBus();
});

/**
 * Ends every keeper (and its CLI) left in the crew folder, and removes their folders: what a reboot
 * does to them. `stopAll` leaves them running, so a test that wants a restart to find no keeper
 * (the resume path), and every test at its end, calls this.
 */
async function noKeepers(): Promise<void> {
  const crewFolder = join(dirname(dbPath), "crew");
  if (!existsSync(crewFolder)) return;
  for (const name of readdirSync(crewFolder)) {
    if (!/^k-[0-9a-f]{12}$/.test(name)) continue;
    await endKeeper(join(crewFolder, name), 500);
    rmSync(join(crewFolder, name), { recursive: true, force: true });
  }
}

afterEach(async () => {
  await Promise.all(sups.splice(0).map((s) => s.stopAll()));
  await noKeepers();
  rmSync(dir, { recursive: true, force: true });
  expect(authReads.splice(0), "tests must never read the operator's Codex home").toEqual([]);
});

function reopenStore(): void {
  store.close();
  store = new Store(dbPath);
}

const live = () => new AbortController().signal;

export {
  anyTicket,
  BRANCH,
  boardCard,
  bus,
  clone,
  config,
  dbPath,
  dir,
  FAKE,
  type FetchTicket,
  git,
  HUB_PORT,
  HUB_ROLES,
  HUB_ROOT,
  live,
  make,
  noKeepers,
  OLD_KEEPER,
  prep,
  recorded,
  recordFile,
  refusal,
  reopenStore,
  root,
  START_RULES,
  seatState,
  store,
  sups,
  TICKET,
  TZ,
  tmpRoot,
  until,
  untilGone,
  userLines,
};
