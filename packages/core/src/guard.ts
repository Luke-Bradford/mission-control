/**
 * The guard's pure core: the command rules, the full-suite matcher and the secret scan. The hub
 * route (`POST /api/guard/check`) and Mission Control's push and PR build on these; nothing here does I/O.
 */
import { MC_TOOL_NAMES, MC_TOOLS, type McToolName, mcTool, READ_ONLY_CANNOT_WRITE } from "./mcp.ts";
import type { CrewMode } from "./runtime.ts";

/** Rule id → the text the Guard drawer shows (catalogue §2.7.4). */
export const GUARD_RULES = {
  "git-write":
    "git writes only through the mc commit tool; report with mc report_evidence and Mission Control pushes and opens the PR",
  "github-write":
    "No GitHub comments, labels, board moves or Priority changes without your approval",
  "merge-push":
    "No merging, force-push or pushes to protected branches; a PR leaves draft only for a safe PR in away mode",
  "flight-powers": "Only repos with flight_powers: superuser may use these tools",
  "full-suite": "Full test suites only through Mission Control (one at a time)",
  "read-only": READ_ONLY_CANNOT_WRITE,
  network: "No network from a crew's commands",
  secret: "No secrets in a push",
} as const;

export type GuardRule = keyof typeof GUARD_RULES;

/** The push of a branch that is not the run's own (it cannot come from a tool argument). */
export const MC_PUSH_NOT_OWN_BRANCH = `Not pushed: ${GUARD_RULES["merge-push"]}`;
/** A guard hit an mc tool records: the rule's text plus the tool, never the text. */
export const mcToolHitText = (rule: GuardRule, tool: string): string =>
  `${GUARD_RULES[rule]}: mc ${tool}`;
/** A guard hit Mission Control's own push, draft PR or PR-body edit records: the rule's text plus the action. */
export const engineHitText = (
  rule: GuardRule,
  action: "push" | "draft PR" | "PR body edit",
): string => `${GUARD_RULES[rule]}: Mission Control's ${action}`;

/** One recorded refusal. `text` is the rule's text plus the program and subcommand, never argv. */
export interface GuardHit {
  id: number;
  agentId: string;
  runId: string | null;
  rule: GuardRule;
  text: string;
  at: number;
}

export interface GuardEvent {
  tool: string;
  input: { command?: string; file_path?: string; run_in_background?: boolean };
}

/** What FLIGHT may do on a repo: `superuser` is set only in the user config, never by the repo. */
export const FLIGHT_POWERS = ["standard", "superuser"] as const;
export type FlightPowers = (typeof FLIGHT_POWERS)[number];

/** FLIGHT's mc tools only a superuser repo's seats may call; the power tickets add them. */
export const MC_SUPERUSER_TOOLS: readonly McToolName[] = [
  "merge_pr",
  "settle_park",
  "rerun_ci",
  "edit_card",
  "dismiss_item",
  MC_TOOL_NAMES.ghRead,
];

/** What a power-gated tool says when the repo is not `superuser`. */
export const needsSuperuserText = (repo: string): string =>
  `${repo} has flight_powers: standard; this needs flight_powers: superuser in config.yaml`;

export interface GuardContext {
  mode: CrewMode;
  /** Only "dev" for now; repo permission levels (spec §8c) slot in here. */
  repo: "dev";
  /** The repo's current `flight_powers`, read from the live config on each call. */
  flightPowers: FlightPowers;
  fullSuite: readonly string[];
  /** Extra role grants; FLIGHT shares sync_main with writers through its own tool. */
  mcTools?: readonly string[];
}

export type GuardVerdict =
  | { kind: "allow" }
  /** Take the test lock; `command` is the configured full-suite entry that matched. */
  | { kind: "lock"; command: string }
  | { kind: "deny"; rule: GuardRule; text: string };

/** The node the guard hook runs under: a stable path, never a Cellar one. */
export const DEFAULT_CREW_NODE = "/opt/homebrew/bin/node";

/** What a seat is told to run instead of a full suite. */
export const FREE_SUITE_HINT = "the same command with a test file path";

export const BACKGROUND_SUITE_TEXT =
  "Run the full suite in the foreground: it holds the test lock.";

/**
 * The largest CLI hook `timeout` the spike saw honoured: 660 s waited, no cap found
 * (docs/spikes/2026-10-21-mc-tools-guard.md, "Largest hook timeout").
 */
const HOOK_TIMEOUT_SEEN_MS = 660_000;
/** How long a full suite waits for the test lock before it is told to come back later. */
export const LOCK_WAIT_MS = Math.min(HOOK_TIMEOUT_SEEN_MS - 60_000, 10 * 60_000);
/** The CLI's `timeout` (s) on the guard hook: the lock wait plus room for the round trip. */
export const GUARD_HOOK_TIMEOUT_S = LOCK_WAIT_MS / 1000 + 30;
/** The hook's own deadline, inside the CLI's timeout (which would run the tool): then it denies. */
export const HOOK_DEADLINE_MS = GUARD_HOOK_TIMEOUT_S * 1000 - 10_000;
/**
 * How long the hook keeps retrying a refused or reset connection (a hub restarting), from its first
 * try, before it denies as unreachable. Kept well inside `HOOK_DEADLINE_MS`.
 */
export const HOOK_RETRY_MS = 60_000;
/** An env var that shortens the retry window (ms; tests that run the hook against no hub). */
export const HOOK_RETRY_ENV = "MC_HOOK_RETRY_MS";
/** The pause between the hook's tries while the hub is down. */
export const HOOK_RETRY_EVERY_MS = 1000;
/** The route the guard hook asks, on the hub's loopback port. */
export const GUARD_CHECK_PATH = "/api/guard/check";
/** `POST /api/guard/check`'s body limit; the hook checks its body against it before posting. */
export const GUARD_BODY_LIMIT = 64 * 1024;

/** The hook events the guard route takes (spike: PermissionDenied never fires). */
export const GUARD_HOOK_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"] as const;
export type GuardHookEvent = (typeof GUARD_HOOK_EVENTS)[number];

/** The hook's "no objection" answer: the CLI's own rules still apply after it. */
export const GUARD_ALLOW_OUTPUT = "{}";

/** The PreToolUse deny form the CLI honours (exit 0); the model sees `<reason>`. */
export function guardDenyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}

/** The hook's answer whenever it cannot get a verdict it recognises (with exit 2). */
export const GUARD_UNREACHABLE_TEXT =
  "Mission Control's guard is unreachable; nothing runs until it is back.";
/** The hook's own answer to a call whose check would not fit the route's body limit. */
export const GUARD_TOO_LONG_TEXT = "That command is too long for the guard to check; split it.";
/**
 * A command line the guard could not read to its end (a quote, substitution, bracket or heredoc
 * left open): nothing in it runs.
 */
export const GUARD_UNREADABLE_TEXT =
  "The guard could not read that command (a quote, substitution or heredoc is left open); spell it more simply.";
/** A full suite on a server without a test lock: never run unlocked. */
export const TEST_LOCK_UNAVAILABLE_TEXT = `The test lock is not available on this server. Run ${FREE_SUITE_HINT}, or the full suite later.`;

/** A full suite that waited `LOCK_WAIT_MS` behind `call`'s `command`. */
export function lockBusyText(call: string, command: string): string {
  return `The test lock is busy: ${call} is running ${command}. Run ${FREE_SUITE_HINT}, or the full suite later.`;
}

/** `GET /api/test-lock`. */
export interface TestLockState {
  holder: { runId: string; seatId: string; command: string; since: number } | null;
  waiting: { runId: string; seatId: string; command: string; since: number }[];
}

/** The ack key of a guard hit (the Guard drawer's [Ack]); it ages out with the other acks. */
export const GUARD_ACK_PREFIX = "guard:";
export const guardAckKey = (id: number): string => `${GUARD_ACK_PREFIX}${id}`;

/** The window the Guard drawer and Setup count hits over. */
export const GUARD_WINDOW_DAYS = 7;

/** The most hits `GET /api/guard/hits` lists (the newest); its counts cover the whole window. */
export const GUARD_HITS_LIMIT = 500;

/** `GET /api/guard/hits?days=`: the hits newest first, and the count per rule (every rule). */
export interface GuardHitsView {
  /** Each hit with whether its `guardAckKey` is acknowledged. */
  hits: (GuardHit & { acked: boolean })[];
  counts: Record<GuardRule, number>;
}

/** The writer tools that write through hub-side git; FLIGHT has its own granted sync_main. */
export const MC_WRITER_TOOLS = [MC_TOOLS.commit, MC_TOOLS.syncMain] as const;

/** The mc tools a scratch seat may not call: a review answers with report_findings alone. */
export const MC_SCRATCH_DENIED_TOOLS = [
  MC_TOOLS.askOperator,
  MC_TOOLS.reportEvidence,
  MC_TOOLS.reportPlan,
] as const;

const READ_ONLY_BUILTINS = ["Edit", "Write", "NotebookEdit"] as const;

/**
 * Wrappers the guard looks through to the command they run: the options that take a separate value
 * word, and how many plain words (a duration, a count) come before the command.
 */
const WRAPPERS: Readonly<Record<string, { valued: readonly string[]; operands: number }>> = {
  env: { valued: ["-u", "--unset", "-C", "--chdir", "-S", "--split-string"], operands: 0 },
  command: { valued: [], operands: 0 },
  builtin: { valued: [], operands: 0 },
  exec: { valued: ["-a"], operands: 0 },
  time: { valued: [], operands: 0 },
  nohup: { valued: [], operands: 0 },
  noglob: { valued: [], operands: 0 },
  nocorrect: { valued: [], operands: 0 },
  sudo: { valued: ["-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T"], operands: 0 },
  timeout: { valued: ["-s", "--signal", "-k", "--kill-after"], operands: 1 },
  nice: { valued: ["-n", "--adjustment"], operands: 0 },
  stdbuf: { valued: ["-i", "-o", "-e", "--input", "--output", "--error"], operands: 0 },
  repeat: { valued: [], operands: 1 },
  xargs: {
    valued: [
      "-I",
      "-L",
      "-n",
      "-P",
      "-s",
      "-d",
      "-E",
      "-a",
      "--arg-file",
      "--delimiter",
      "--max-args",
      "--max-procs",
      "--max-chars",
      "--max-lines",
      "--eof",
      "--replace",
    ],
    operands: 0,
  },
  // background runners: see BACKGROUND_WRAPPERS
  coproc: { valued: [], operands: 0 },
  setsid: { valued: [], operands: 0 },
};
/** `env -S <string>`: the string is a command line of its own. */
const ENV_SPLIT = /^(?:-S|--split-string)(?:=?)(.*)$/;
const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);
const SHELL_KEYWORDS = new Set([
  "!",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "{",
  "always",
]);
/** Wrappers that start their command in the background: `coproc cmd`, `setsid cmd`. */
const BACKGROUND_WRAPPERS = new Set(["coproc", "setsid"]);
/** Terminal multiplexers: any command they are given runs detached, in the background. */
const MULTIPLEXERS = new Set(["screen", "tmux"]);
/** Runners whose options are not modelled (`watch`, `flock -c`, `script -c`, `parallel`, `npx -c` take a command line as one word): judged like a multiplexer, in the foreground. */
const RUNNERS = new Set([
  "watch",
  "caffeinate",
  "script",
  "flock",
  "parallel",
  "doas",
  "ionice",
  "taskset",
  "chronic",
  "unbuffer",
  "npx",
  "bunx",
  "uvx",
]);
/** `pnpm exec`, `npm x`, `yarn dlx`: a package manager running a command (the verb may follow options: `pnpm -s exec`). */
const PACKAGE_MANAGERS = new Set(["pnpm", "npm", "yarn"]);
const PACKAGE_RUN_VERBS = new Set(["exec", "dlx", "x"]);

/** Where the words a runner runs start in `rest` (the words after its program), or -1: not a runner. */
function runnerStart(name: string, rest: readonly string[]): number {
  if (RUNNERS.has(name)) return 0;
  if (PACKAGE_MANAGERS.has(name)) {
    const i = rest.findIndex((w) => PACKAGE_RUN_VERBS.has(w));
    return i === -1 ? -1 : i + 1;
  }
  return -1;
}

/**
 * A short-option cluster (`-iu`, `-0n`, `-vS`): the first letter whose `-<letter>` is in `valued`
 * takes the rest of the word as its value, or the next word when nothing follows it (`inline` "").
 * Null when none does, or a character before one is not a letter or digit.
 */
function clusterValue(
  w: string,
  valued: readonly string[],
): { letter: string; inline: string } | null {
  for (let i = 1; i < w.length; i++) {
    const c = w.charAt(i);
    if (valued.includes(`-${c}`)) return { letter: c, inline: w.slice(i + 1) };
    if (!/[A-Za-z0-9]/.test(c)) return null;
  }
  return null;
}
/** What may follow `coproc NAME`: a compound command (with NAME, coproc takes nothing else). */
const COMPOUND_START = new Set(["{", "while", "until", "if", "for", "case", "select", "[[", "(("]);
/**
 * A word bash and zsh brace-expand (`{git,push}`, `{a..z}`): a `{ … }` with a `,` or `..` inside.
 * One pass (a regex for it backtracks quadratically on a long word of commas).
 */
function bracesExpand(w: string): boolean {
  let open = -1;
  let list = false;
  for (let i = 0; i < w.length; i++) {
    const c = w.charAt(i);
    if (c === "{") {
      open = i;
      list = false;
    } else if (open === -1) {
    } else if (c === "}") {
      if (list) return true;
      open = -1;
    } else if (c === "," || (c === "." && w.charAt(i + 1) === ".")) {
      list = true;
    } else if (c === " " || c === "\t" || c === "\n") {
      open = -1;
    }
  }
  return false;
}

/** `-` and letters only, one of them `letter`: an option cluster such as `-ec` (one pass). */
function clusterHas(w: string, letters: string): boolean {
  if (w.length < 2 || w.charAt(0) !== "-") return false;
  let has = false;
  for (let i = 1; i < w.length; i++) {
    const c = w.charAt(i);
    if (!/[A-Za-z]/.test(c)) return false;
    if (letters.includes(c)) has = true;
  }
  return has;
}
/** A pseudo-program for a head word that brace-expands; the guard denies it. */
const BRACE_WORD = "\0brace-expansion";
/** A pseudo-program for a line too long (or nested too deep) to judge; the guard denies it. */
const TOO_LONG = "\0too-long";
/** A pseudo-program for a shell `-c` whose script cannot be found; the guard denies it. */
const UNREADABLE_SCRIPT = "\0unreadable-shell-script";
/** A pseudo-program for a shell running a pipe's content (`… | sh`); the guard denies it. */
const STDIN_SCRIPT = "\0stdin-shell-script";
/** A pseudo-program for a line the tokenizer could not fully read; the guard denies it. */
const UNREADABLE_LINE = "\0unreadable-line";
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** One command a line would run: its argv, and whether something runs it in the background. */
interface Cmd {
  argv: string[];
  /** Under coproc, setsid, screen or tmux (a lone `&` is the line's: `Walk.lineBackground`). */
  background: boolean;
  /** A word after its program brace-expands (an unquoted `{a,b}`). */
  braces?: boolean;
}

/** One decision's walk over a command line. */
interface Walk {
  /** A lone `&` somewhere in the line (or a script inside it). */
  lineBackground: boolean;
  /** Words still to examine; past it the line is too long to judge (fail closed). */
  budget: number;
}

/**
 * The most words one decision examines. A line within the route's body limit is about 32K words;
 * a multiplexer's suffixes are quadratic in its words, so this is what bounds them.
 */
const WORD_BUDGET = 50_000;
/** How deep scripts may nest (`sh -c`, `eval`, `env -S`, `find -exec`). */
const MAX_DEPTH = 16;

/** The line cannot be judged within the budget or the depth: the guard denies it. */
class TooLong extends Error {}

function spend(walk: Walk, words: number): void {
  walk.budget -= words;
  if (walk.budget < 0) throw new TooLong();
}

/** Characters after which a `}` ends its word (zsh closes a group with it). */
const WORD_END = " \t\n;|&()<>`";

/**
 * The line cannot be read the way the shell would read it (a quote, substitution, heredoc or
 * bracket left open at the end of the input): the guard denies the whole call.
 */
class Unreadable extends Error {}

/** One simple command. */
interface Segment {
  argv: string[];
  /** For each word, whether it brace-expands (an unquoted `{a,b}`). */
  braces: boolean[];
  /** The text it reads on stdin: its heredoc bodies and here-strings. */
  stdin: string[];
  /** It reads a pipe (`… | sh`). */
  piped: boolean;
}

/** A command line: its simple commands, and the lines its command substitutions run. */
interface Line {
  segments: Segment[];
  /** Each is judged one level deeper than this line. */
  subs: Line[];
}

/** A heredoc on the current line: its body starts after the line's newline. */
interface Heredoc {
  delim: string;
  /** `<<-`: leading tabs are stripped before a line is compared with the delimiter. */
  tabs: boolean;
  /** An unquoted delimiter: the body's command substitutions run. */
  expands: boolean;
  /** The command it belongs to. */
  seg: Segment;
}

const newSegment = (piped: boolean): Segment => ({ argv: [], braces: [], stdin: [], piped });

/** The escapes `$'…'` decodes (any other `\x` stays as written). */
const ANSI_C: Readonly<Record<string, string>> = {
  a: "\u0007",
  b: "\b",
  e: "\u001b",
  E: "\u001b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
};

/**
 * Arithmetic closers: inside one, a `<<` is a shift, never a heredoc. `$))` is the one a `$((`
 * opened inside `"…"` or a heredoc body owes: paid as `))` it was arithmetic; paid by a lone `)`
 * it was `$(` opening a subshell (`"$((cd x && ls) 2>&1)"`).
 */
const ARITH_CLOSERS = new Set(["))", "]", "$))"]);

/**
 * Reads one string as the shell would, in a single pass (each nesting level once), and throws
 * `Unreadable` whenever it reaches the end in a state it has not resolved. `$( )` and backticks
 * are read as command lines of their own wherever they run: unquoted, inside `"…"` and in an
 * unquoted heredoc body. A heredoc body is data, read up to its delimiter line.
 */
class Reader {
  // plain fields, not parameter properties: the hook runs this file under node's type stripping
  private readonly s: string;
  private readonly walk: Walk;

  constructor(s: string, walk: Walk) {
    this.s = s;
    this.walk = walk;
  }

  /** The whole string as one command line. */
  all(depth: number): Line {
    return this.line(0, false, depth).line;
  }

  /**
   * A command line from `from`: to the end of the string, or (`inSub`) to the `)` that closes a
   * `$(`, whose index is `end`. `arithStart`: it follows a `$((` and owes `$))` first; `arith`
   * says that was paid as `))` (arithmetic, whose commands are none but its substitutions').
   */
  private line(
    from: number,
    inSub: boolean,
    depth: number,
    arithStart = false,
  ): { line: Line; end: number; arith: boolean } {
    if (depth > MAX_DEPTH) throw new TooLong();
    const s = this.s;
    const segments: Segment[] = [];
    const subs: Line[] = [];
    let cur = newSegment(false);
    let word: string | null = null;
    // the word as brace expansion sees it: each quoted or escaped part is one inert `_`
    let mask = "";
    // unquoted `{` (and `${`) opened in this word and not yet closed
    let open = 0;
    // unquoted `${` opened on this line and not yet closed: a `<<` inside is never a heredoc
    let param = 0;
    // the closers still owed, innermost last: `)` (a subshell), `))` (`((`, `$((`), `]` (`$[`)
    const closers: string[] = [];
    let arith = 0;
    // heredocs opened on this line, in order; their bodies follow its newline
    let heredocs: Heredoc[] = [];
    // After a redirection operator the next word is its target: dropped, or (`<<<`) stdin.
    let target: "drop" | "stdin" | null = null;
    // the next command reads a pipe
    let pipe = false;
    // `case` opened on this line with no `esac` yet: a `)` that pays no closer ends a pattern
    let cases = 0;
    // Every unquoted `case` word counts, wherever it stands (`time case …`, `coproc case …`):
    // over-counting leaves the line open, and the backstop denies it. A `case` owns a pattern
    // `)` only after two more words (its subject, then `in` or zsh's `{`), so until then it is
    // pending: `$(echo case)` still closes. Word numbers of pending ones, oldest first.
    const pendingCases: number[] = [];
    let pendingHead = 0;
    let wordCount = 0;
    // every word of this command so far is a keyword (`esac` closes only there)
    let keywords = true;
    const quoted = (text: string) => {
      word = (word ?? "") + text;
      mask += "_";
    };
    const plain = (text: string) => {
      word = (word ?? "") + text;
      mask += text;
    };
    const dropWord = () => {
      word = null;
      mask = "";
      open = 0;
    };
    const endWord = () => {
      if (word !== null) {
        if (target === "stdin") cur.stdin.push(word);
        else if (target === null) {
          wordCount++;
          while (
            pendingHead < pendingCases.length &&
            wordCount - (pendingCases[pendingHead] ?? wordCount) >= 2
          ) {
            cases++;
            pendingHead++;
          }
          if (mask === "case") pendingCases.push(wordCount);
          if (keywords) {
            if (mask === "esac" && cases > 0) cases--;
            keywords = SHELL_KEYWORDS.has(mask);
          }
          cur.argv.push(word);
          cur.braces.push(bracesExpand(mask));
        }
        target = null;
      }
      dropWord();
    };
    const endSegment = () => {
      endWord();
      target = null;
      keywords = true;
      if (cur.argv.length > 0) {
        segments.push(cur);
        cur = newSegment(pipe);
      } else cur.piped ||= pipe;
      pipe = false;
    };
    const push = (closer: string) => {
      closers.push(closer);
      if (ARITH_CLOSERS.has(closer)) arith++;
    };
    const pop = () => {
      const c = closers.pop();
      if (c !== undefined && ARITH_CLOSERS.has(c)) arith--;
    };
    // After the line's newline (at `from`): each pending heredoc's body in turn, up to its
    // delimiter line (none: unreadable). Returns the index after them. Every line is looked at once.
    const bodies = (at: number): number => {
      let pos = at;
      for (const h of heredocs) {
        const start = pos;
        let bodyEnd = -1;
        while (pos < s.length) {
          const nl = s.indexOf("\n", pos);
          const end = nl === -1 ? s.length : nl;
          const next = nl === -1 ? s.length : nl + 1;
          let k = pos;
          if (h.tabs) while (k < end && s.charAt(k) === "\t") k++;
          if (end - k === h.delim.length && s.startsWith(h.delim, k)) {
            bodyEnd = pos;
            pos = next;
            break;
          }
          pos = next;
        }
        if (bodyEnd === -1) throw new Unreadable();
        const body = s.slice(start, bodyEnd);
        h.seg.stdin.push(body);
        if (h.expands) new Reader(body, this.walk).bodySubs(depth, subs);
      }
      heredocs = [];
      return pos;
    };
    // the lines are complete only with nothing left open
    const finish = (end: number, arith = false) => {
      endSegment();
      if (closers.length > 0 || param > 0 || heredocs.length > 0) throw new Unreadable();
      return { line: { segments, subs }, end, arith };
    };
    if (arithStart) push("$))");
    for (let i = from; i < s.length; i++) {
      const c = s.charAt(i);
      const next = s.charAt(i + 1);
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end === -1) throw new Unreadable();
        quoted(s.slice(i + 1, end));
        i = end;
      } else if (c === "$" && next === "'") {
        // ANSI-C quoting: a backslash escapes inside, so `\'` does not end it
        let text = "";
        let j = i + 2;
        for (; j < s.length && s.charAt(j) !== "'"; j++) {
          const d = s.charAt(j);
          if (d === "\\" && j + 1 < s.length) {
            const e = s.charAt(j + 1);
            text += Object.hasOwn(ANSI_C, e) ? ANSI_C[e] : `\\${e}`;
            j++;
          } else text += d;
        }
        if (j >= s.length) throw new Unreadable();
        quoted(text);
        i = j;
      } else if (c === '"') {
        const q = this.doubleQuoted(i, depth, subs);
        quoted(q.text);
        i = q.end;
      } else if (c === "`") {
        const end = this.backtick(i, depth, subs);
        quoted(s.slice(i, end + 1));
        i = end;
      } else if (c === "$" && next === "(" && s.charAt(i + 2) !== "(") {
        const t = this.line(i + 2, true, depth + 1);
        subs.push(t.line);
        quoted(s.slice(i, t.end + 1));
        i = t.end;
      } else if (c === "$" && next === "[") {
        push("]");
        plain("$[");
        i++;
      } else if (c === "$" && next === "{") {
        param++;
        open++;
        plain("${");
        i++;
      } else if (c === "\\") {
        if (next === "\n") i++;
        else if (i + 1 < s.length) {
          quoted(next);
          i++;
        }
      } else if (c === " " || c === "\t") {
        endWord();
      } else if (c === "#" && word === null) {
        while (i < s.length && s.charAt(i) !== "\n") i++;
        endSegment();
        if (i < s.length && heredocs.length > 0) i = bodies(i + 1) - 1;
      } else if (c === ">" || c === "<" || (c === "&" && next === ">")) {
        // A redirection: `N>`, `>>`, `>&`, `<`, `<<`, `<<<`, `&>`. A bare number before it is the fd.
        if (word !== null && /^\d+$/.test(word)) dropWord();
        else endWord();
        if (c === "<" && next === "<" && s.charAt(i + 2) !== "<" && arith === 0 && param === 0) {
          // a heredoc: its delimiter is the next word; the body is read after this line
          const tabs = s.charAt(i + 2) === "-";
          const d = heredocWord(s, i + (tabs ? 3 : 2));
          if (d.delim !== "" || d.quoted) {
            heredocs.push({ delim: d.delim, tabs, expands: !d.quoted, seg: cur });
            i = d.end - 1;
            continue;
          }
        }
        const hereString = c === "<" && next === "<" && s.charAt(i + 2) === "<";
        if (c === "&") i++;
        while (i + 1 < s.length && ">&<|".includes(s.charAt(i + 1))) i++;
        target = hereString ? "stdin" : "drop";
      } else if ("\n;|&()".includes(c)) {
        const top = closers[closers.length - 1];
        if (c === "(") {
          if (next === "(") {
            push("))");
            i++;
          } else push(")");
        } else if (c === ")") {
          // the word before it may be the `esac` that closes a `case`
          endWord();
          if (top === undefined) {
            // a `case` pattern's `)`; else the `)` that closes this `$(` (a stray one at the top
            // level only separates)
            if (cases === 0 && inSub) return finish(i);
          } else if (top === "$))") {
            pop();
            if (next === ")") return finish(i + 1, true);
            // `$((cd x) …)`: that `)` closed the subshell; the `$(` is this line's own
          } else if (top === "))") {
            pop();
            // `((ls) )`: a lone `)` closes one of the two
            if (next === ")") i++;
            else push(")");
          } else if (top === ")") pop();
          else throw new Unreadable();
        }
        const prev = i > 0 ? s.charAt(i - 1) : "";
        // a lone `&` (not `&&`, not `|&`) puts what came before it in the background
        if (c === "&" && next !== "&" && prev !== "&" && prev !== "|") {
          this.walk.lineBackground = true;
        }
        pipe = c === "|" && next !== "|" && prev !== "|";
        endSegment();
        if (c === "\n" && heredocs.length > 0) i = bodies(i + 1) - 1;
      } else if (c === "}" && param > 0) {
        param--;
        if (open > 0) open--;
        plain(c);
      } else if (c === "}" && open === 0 && (i + 1 === s.length || WORD_END.includes(next))) {
        // zsh: an unquoted `}` that closes no `{` of its word ends a group (`{git push}`); it is
        // never a command or an argument, and it ends the simple command (`{ a } always { b }`
        // judges `b`); right after a word holding `${…}` it only ends the word. A quoted `}` is
        // literal and took the branches above.
        if (word === null || !mask.includes("${")) endSegment();
        else endWord();
      } else {
        const top = closers[closers.length - 1];
        if (c === "{") open++;
        else if (c === "}" && open > 0) open--;
        else if (c === "]" && top === "]") pop();
        else if (c === "[" && top === "]") push("]");
        plain(c);
      }
    }
    if (inSub) throw new Unreadable();
    return finish(s.length);
  }

  /** `"…"` from its opening quote at `at`: its text, and the index of its closing quote. */
  private doubleQuoted(at: number, depth: number, subs: Line[]): { text: string; end: number } {
    const s = this.s;
    let text = "";
    let j = at + 1;
    for (;;) {
      if (j >= s.length) throw new Unreadable();
      const d = s.charAt(j);
      const next = s.charAt(j + 1);
      if (d === '"') return { text, end: j };
      if (d === "\\" && next === "\n") {
        j += 2;
      } else if (d === "\\" && next !== "" && '"\\$`'.includes(next)) {
        text += next;
        j += 2;
      } else if (d === "`") {
        const end = this.backtick(j, depth, subs);
        text += s.slice(j, end + 1);
        j = end + 1;
      } else if (d === "$" && next === "(") {
        const t = this.subLine(j, depth, subs);
        text += s.slice(j, t + 1);
        j = t + 1;
      } else {
        text += d;
        j++;
      }
    }
  }

  /**
   * A backtick substitution from its opening backtick at `at`, to the next unescaped one (quotes
   * do not protect it). Its text, unescaped, is read as a line of its own. Returns the closing index.
   */
  private backtick(at: number, depth: number, subs: Line[]): number {
    const s = this.s;
    let k = at + 1;
    while (k < s.length && s.charAt(k) !== "`") k += s.charAt(k) === "\\" ? 2 : 1;
    if (k >= s.length) throw new Unreadable();
    const text = s.slice(at + 1, k).replace(/\\([\\`$])/g, "$1");
    subs.push(new Reader(text, this.walk).all(depth + 1));
    return k;
  }

  /**
   * `$(` or `$((` at `at`, inside `"…"` or a heredoc body, read as a sub-line one level deeper
   * (arithmetic adds only its substitutions). Returns the index of its last `)`.
   */
  private subLine(at: number, depth: number, subs: Line[]): number {
    const arithStart = this.s.charAt(at + 2) === "(";
    const t = this.line(at + (arithStart ? 3 : 2), true, depth + 1, arithStart);
    subs.push(t.arith ? { segments: [], subs: t.line.subs } : t.line);
    return t.end;
  }

  /** The command substitutions an unquoted heredoc body (this string) runs; the rest is data. */
  bodySubs(depth: number, subs: Line[]): void {
    const s = this.s;
    for (let j = 0; j < s.length; j++) {
      const c = s.charAt(j);
      if (c === "\\") j++;
      else if (c === "`") j = this.backtick(j, depth, subs);
      else if (c === "$" && s.charAt(j + 1) === "(") j = this.subLine(j, depth, subs);
    }
  }
}

/**
 * The delimiter word after `<<` / `<<-`, from `from`: bare, or quoted in part or whole (`'EOF'`,
 * `"EOF"`, `\EOF`, `$'EOF'`); a backslash-newline continues it. `end` is the index just past it.
 * An unclosed quote, or a newline inside the delimiter, cannot be read.
 */
function heredocWord(s: string, from: number): { delim: string; quoted: boolean; end: number } {
  let j = from;
  while (s.charAt(j) === " " || s.charAt(j) === "\t") j++;
  let delim = "";
  let quoted = false;
  for (; j < s.length; j++) {
    const c = s.charAt(j);
    if (c === "'" || c === '"') {
      quoted = true;
      const close = s.indexOf(c, j + 1);
      if (close === -1) throw new Unreadable();
      delim += s.slice(j + 1, close);
      j = close;
    } else if (c === "\\" && s.charAt(j + 1) === "\n") {
      j++;
    } else if (c === "\\") {
      quoted = true;
      delim += s.charAt(j + 1);
      j++;
    } else if (c === "$" && (s.charAt(j + 1) === "'" || s.charAt(j + 1) === '"')) {
      // `$'EOF'`: the quotes are what count
    } else if (" \t\n;&|()<>".includes(c)) break;
    else delim += c;
  }
  if (delim.includes("\n")) throw new Unreadable();
  return { delim, quoted, end: j };
}

/** A program name as the guard compares it: basename, lowercase (macOS runs `GIT` and `SH` as git and sh). */
const baseName = (w: string): string =>
  (w.includes("/") ? (w.split("/").pop() ?? w) : w).toLowerCase();

/** `find` actions that run a command, up to `;` or `+`. */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/**
 * Where a command sits relative to a multiplexer: under none; a suffix of a multiplexer's own
 * words (every suffix is judged there, so a multiplexer here needs no look of its own); or inside
 * a command line a multiplexer runs (a word or script it was given), which the guard cannot judge.
 */
type Mux = "none" | "suffix" | "script";

/** A script's position: anything a multiplexer's command runs stays inside it. */
const inScript = (mux: Mux): Mux => (mux === "none" ? "none" : "script");

/** Words a multiplexer or `find -exec` runs: a command with no stdin of its own. */
const wordsOnly = (argv: string[], braces: boolean[]): Segment => ({
  argv,
  braces,
  stdin: [],
  piped: false,
});

/**
 * A shell given no `-c` runs what it reads on stdin: with no script operand (or `-`, or
 * `/dev/stdin`), or with `-s`. `--version` and `--help` run nothing.
 */
function readsStdin(cw: readonly string[]): boolean {
  for (let i = 1; i < cw.length; i++) {
    const w = cw[i] ?? "";
    if (w === "--version" || w === "--help") return false;
    if (w === "--") {
      const op = cw[i + 1];
      return op === undefined || op === "-" || op === "/dev/stdin";
    }
    if (w === "-") return true;
    if (w.startsWith("-") || w.startsWith("+")) {
      if (w.startsWith("-") && clusterHas(w, "s")) return true;
      // `-o pipefail`, `+O extglob`, `--rcfile f`: the next word is the option's value
      if (w === "--rcfile" || w === "--init-file" || clusterHas(`-${w.slice(1)}`, "oO")) i++;
      continue;
    }
    return w === "/dev/stdin";
  }
  return true;
}

function normalise(seg: Segment, walk: Walk, depth: number, background: boolean, mux: Mux): Cmd[] {
  if (depth > MAX_DEPTH) throw new TooLong();
  const { argv, braces } = seg;
  spend(walk, argv.length);
  const words = [...argv];
  let at = 0;
  let bg = background;
  // `… | xargs sh`: xargs takes the stdin; the shell gets file operands
  let viaXargs = false;
  const scripts: string[] = [];
  for (;;) {
    const head = words[at];
    if (head === undefined) break;
    if (ASSIGNMENT.test(head)) {
      at++;
      continue;
    }
    if (braces[at] === true) return [{ argv: [BRACE_WORD], background: bg }];
    const base = baseName(head);
    if (SHELL_KEYWORDS.has(head)) {
      at++;
    } else if (head === "function") {
      // zsh: `function NAME { … }` or `function NAME () { … }`: the keyword, the name, the `()`
      at += words[at + 2] === "()" ? 3 : 2;
    } else if (head.startsWith("{")) {
      // zsh: `{git push; }` is a group running `git push` (all the braces at once: one pass)
      words[at] = head.replace(/^\{+/, "");
    } else if (Object.hasOwn(WRAPPERS, base)) {
      const spec = WRAPPERS[base];
      if (spec === undefined) break;
      if (BACKGROUND_WRAPPERS.has(base)) bg = true;
      if (base === "xargs") viaXargs = true;
      at++;
      // options and their values; a lone `-` is one too (`env -` is `env -i`)
      while (words[at]?.startsWith("-")) {
        const opt = words[at] ?? "";
        at++;
        if (opt === "--") break;
        const split = base === "env" ? ENV_SPLIT.exec(opt) : null;
        if (spec.valued.includes(opt)) {
          if (split !== null && words[at] !== undefined) scripts.push(words[at] ?? "");
          at++;
        } else if (split !== null) {
          if (split[1] !== undefined && split[1] !== "") scripts.push(split[1]);
        } else if (!opt.startsWith("--")) {
          const v = clusterValue(opt, spec.valued);
          if (v !== null) {
            const value = v.inline !== "" ? v.inline : words[at];
            if (v.inline === "") at++;
            if (base === "env" && v.letter === "S" && value !== undefined) scripts.push(value);
          }
        }
      }
      at += spec.operands;
      // `coproc NAME <compound>`: the name is not the command
      if (base === "coproc" && COMPOUND_START.has(words[at + 1] ?? "")) at++;
    } else break;
  }
  const extra = scripts.flatMap((s) => commands(s, walk, depth + 1, bg, inScript(mux)));
  const program = words[at];
  if (program === undefined) return extra;
  const name = baseName(program);
  const rest = words.slice(at + 1);
  const restBraces = braces.slice(at + 1);
  const braced = restBraces.includes(true);
  const out: Cmd[] = [{ argv: [name, ...rest], background: bg, braces: braced }, ...extra];
  const multiplexer = MULTIPLEXERS.has(name);
  const from = multiplexer ? 0 : runnerStart(name, rest);
  if (multiplexer || from !== -1) {
    // `tmux new -d 'pnpm -s test'`, `screen -dmS s pnpm -s test`: which word starts the command is
    // not modelled, so every suffix of its words is judged as a command, in the background, and a
    // word holding a command line is split. A multiplexer that is one of those suffixes is not
    // looked into again (its suffixes are among them). One inside a command line it runs would
    // need its own look, which is not taken: the line is denied as too long to judge. Runners
    // (`watch`, `flock -c`, `npx`, `pnpm exec`…) are judged the same way, but in the foreground.
    if (mux === "suffix") return out;
    if (mux === "script") throw new TooLong();
    const run = rest.slice(from);
    const runBraces = restBraces.slice(from);
    // a multiplexer among a runner's words returns early as a suffix: its command is background
    const runBg = multiplexer || bg || run.some((w) => MULTIPLEXERS.has(baseName(w)));
    if (multiplexer) out[0] = { argv: [name, ...rest], background: true, braces: braced };
    for (let i = 0; i < run.length; i++) {
      const suffix = wordsOnly(run.slice(i), runBraces.slice(i));
      out.push(...normalise(suffix, walk, depth + 1, runBg, "suffix"));
    }
    for (const w of run) {
      if (/[\s;&|]/.test(w)) out.push(...commands(w, walk, depth + 1, runBg, "script"));
    }
    return out;
  }
  if (name === "find") {
    for (let i = 0; i < rest.length; i++) {
      if (!FIND_EXEC.has(rest[i] ?? "")) continue;
      let end = i + 1;
      while (end < rest.length && rest[end] !== ";" && rest[end] !== "+") end++;
      const run = wordsOnly(rest.slice(i + 1, end), restBraces.slice(i + 1, end));
      out.push(...normalise(run, walk, depth + 1, bg, mux));
      i = end;
    }
  }
  // What a shell (or `source /dev/stdin`) reads on stdin is a command line: a heredoc or a
  // here-string is judged one level deeper; a pipe's content cannot be read, so it is denied.
  const stdin = (): Cmd[] => {
    if (viaXargs) return [];
    if (seg.stdin.length > 0) {
      return seg.stdin.flatMap((t) => commands(t, walk, depth + 1, bg, inScript(mux)));
    }
    return seg.piped ? [{ argv: [STDIN_SCRIPT], background: bg }] : [];
  };
  // `sh -c "git push"`: the script is a command line of its own.
  if (SHELLS.has(name)) {
    const cw = [program, ...rest];
    const c = cw.findIndex((w, i) => i > 0 && clusterHas(w, "c"));
    if (c !== -1) {
      // Options after `-c` (`-e`) come before the script; the word right after `--` is the
      // script even when it starts with `-`. A `-c` with no script cannot be read: fail closed.
      // `-o`/`-O` (alone or in a cluster, `-c` included) and `+x` options may take the next word
      // as a value, so which word bash runs is not knowable here: fail closed.
      const valued = (w: string | undefined) =>
        w !== undefined && (w.startsWith("+") || clusterHas(w, "oO"));
      let si = c + 1;
      let unsure = valued(cw[c]);
      while (cw[si]?.startsWith("-") || cw[si]?.startsWith("+")) {
        if (cw[si] === "--") break;
        if (valued(cw[si])) unsure = true;
        si++;
      }
      if (cw[si] === "--") si++;
      const script = unsure ? undefined : cw[si];
      out.push(
        ...(script === undefined
          ? [{ argv: [UNREADABLE_SCRIPT], background: bg }]
          : commands(script, walk, depth + 1, bg, inScript(mux))),
      );
    } else if (readsStdin(cw)) {
      out.push(...stdin());
    }
  } else if ((name === "source" || name === ".") && rest[0] === "/dev/stdin") {
    out.push(...stdin());
  } else if (name === "eval") {
    out.push(...commands(rest.join(" "), walk, depth + 1, bg, inScript(mux)));
  }
  return out;
}

/**
 * A command line as the commands it would run, each as argv. Splits on newlines and `; && || |`
 * (and `&`, parentheses and backticks, so a subshell's commands surface too), respecting quotes
 * (`$'…'` too) with no expansion; a heredoc body is data (only an unquoted one's command
 * substitutions are judged). Drops leading `NAME=value` words, shell keywords and `{ }` (zsh's
 * `{git push}` too), and looks through the wrappers in `WRAPPERS` (their options and option values, a
 * `timeout` duration, a `repeat` count); an absolute program path becomes its basename. `sh -c`,
 * `eval` and `env -S` scripts are split too, and under `screen`/`tmux`, the `RUNNERS` and
 * `pnpm/npm/yarn exec|dlx|x` every suffix is.
 */
export function splitCommands(cmd: string): string[][] {
  return lineCommands(cmd, newWalk()).map((c) => c.argv);
}

const newWalk = (): Walk => ({ lineBackground: false, budget: WORD_BUDGET });

/**
 * The line's commands. One the budget or the depth cannot judge is the `TOO_LONG`
 * pseudo-program; one that cannot be read (something left open) is `UNREADABLE_LINE`.
 */
function lineCommands(cmd: string, walk: Walk): Cmd[] {
  try {
    return commands(cmd, walk, 0, false, "none");
  } catch (e) {
    if (e instanceof TooLong) return [{ argv: [TOO_LONG], background: false }];
    if (e instanceof Unreadable) return [{ argv: [UNREADABLE_LINE], background: false }];
    throw e;
  }
}

function commands(cmd: string, walk: Walk, depth: number, background: boolean, mux: Mux): Cmd[] {
  return judge(new Reader(cmd, walk).all(depth), walk, depth, background, mux);
}

/** A read line's commands, then (one level deeper) those its substitutions run. */
function judge(line: Line, walk: Walk, depth: number, background: boolean, mux: Mux): Cmd[] {
  if (depth > MAX_DEPTH) throw new TooLong();
  const out = line.segments.flatMap((s) => normalise(s, walk, depth, background, mux));
  for (const sub of line.subs) out.push(...judge(sub, walk, depth + 1, background, inScript(mux)));
  return out;
}

const TEST_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx|py)$/;

/**
 * argv starts with an entry's words, and either a later word is `--` or no later non-flag word
 * looks like a single test (one that, with any `::...` suffix cut (pytest's node id), ends
 * `.ts .tsx .mts .cts .js .mjs .cjs .jsx .py`). A folder (`tests/unit`, `./tests`, `apps/`) is not
 * one: it runs a whole suite, so the command keeps the lock. Any folder word keeps the lock, even
 * next to a single test. Flag values (`--reporter dot`) and
 * `-t` filters therefore keep a command a full suite, and so does `-- x.test.ts` (vitest never
 * filters by it).
 */
export function isFullSuite(argv: readonly string[], fullSuite: readonly string[]): boolean {
  return matchedSuite(argv, fullSuite) !== null;
}

/** The first full-suite entry whose program is `program` (a brace word after it may spell that suite). */
function suiteOfProgram(program: string, fullSuite: readonly string[]): string | null {
  return (
    fullSuite.find(
      (entry) => (entry.split(/\s+/).find((w) => w !== "") ?? "").toLowerCase() === program,
    ) ?? null
  );
}

function matchedSuite(argv: readonly string[], fullSuite: readonly string[]): string | null {
  for (const entry of fullSuite) {
    const words = entry.split(/\s+/).filter((w) => w !== "");
    if (words.length === 0 || argv.length < words.length) continue;
    if (!words.every((w, i) => (i === 0 ? argv[i] === w.toLowerCase() : argv[i] === w))) continue;
    const looksLikePath = (a: string) =>
      !a.startsWith("-") && TEST_FILE.test(a.split("::")[0] ?? "");
    const tail = argv.slice(words.length);
    // vitest puts every word after `--` in options["--"], never in its file filters: the whole
    // suite runs, so any `--` makes it a full suite
    const looksLikeFolder = (a: string) =>
      !a.startsWith("-") && !looksLikePath(a) && (a.includes("/") || a === "." || a === "..");
    if (tail.includes("--") || !tail.some(looksLikePath) || tail.some(looksLikeFolder))
      return entry;
  }
  return null;
}

/** git's global options that take a separate value word. */
const GIT_OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--attr-source",
]);

function gitSubcommand(args: readonly string[]): { sub: string; rest: string[] } | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (GIT_OPTIONS_WITH_VALUE.has(a)) i++;
    else if (!a.startsWith("-")) return { sub: a, rest: args.slice(i + 1) };
  }
  return null;
}

/** Subcommands that only read. Anything not here (or not read-only in its form) is a git write. */
const GIT_READ = new Set([
  "status",
  "diff",
  "log",
  "show",
  "rev-parse",
  "ls-files",
  "ls-tree",
  "cat-file",
  "blame",
  "grep",
  "describe",
  "merge-base",
  "rev-list",
  "shortlog",
  "for-each-ref",
  "show-ref",
  "name-rev",
]);

/** Every git subcommand a hit text may name; any other word is never echoed (it may be a secret). */
const GIT_KNOWN = new Set([
  ...GIT_READ,
  ..."branch tag stash worktree remote add stage commit push pull fetch merge rebase reset revert cherry-pick checkout switch restore rm mv clean am apply init clone config notes submodule gc prune repack update-ref update-index symbolic-ref send-pack receive-pack credential bisect filter-branch replace hash-object write-tree commit-tree read-tree mktag mktree fast-import reflog sparse-checkout maintenance format-patch request-pull archive bundle".split(
    " ",
  ),
]);

/** `git tag` options that make or delete a tag: alone, in a short cluster, or with `=value`. */
const TAG_WRITE =
  /^-[A-Za-z]*[dasufmFe]|^--(?:delete|annotate|sign|local-user|force|message|file|edit)(?:=|$)/;
/** `git branch` options that make it list (each implies `--list`), alone or with `=value`. */
const BRANCH_LIST = /^(?:-l|--(?:list|contains|no-contains|merged|no-merged|points-at)(?:=.*)?)$/;

/** Subcommands that read only with these arguments (or none). */
function gitReadOnly(sub: string, rest: readonly string[]): boolean {
  const flags = rest.every((a) => a.startsWith("-"));
  // `--output[=file]` makes diff, log and show write a file.
  if (rest.some((a) => a === "--output" || a.startsWith("--output="))) return false;
  switch (sub) {
    case "branch": {
      const writes = rest.some((a) =>
        /^-(?:[dDmMcCfu])$|^--(?:delete|move|copy|force|set-upstream-to|unset-upstream|edit-description)/.test(
          a,
        ),
      );
      return !writes && (flags || rest.some((a) => BRANCH_LIST.test(a)));
    }
    case "tag":
      return (
        rest.length === 0 ||
        rest.every((a) => ["-l", "--list", "-n"].includes(a)) ||
        (rest.some((a) => a === "-l" || a === "--list") && !rest.some((a) => TAG_WRITE.test(a)))
      );
    case "stash":
      return rest[0] === "list" || rest[0] === "show";
    case "worktree":
      return rest[0] === "list";
    case "remote":
      return (
        rest.length === 0 ||
        (flags && rest.every((a) => a === "-v")) ||
        rest[0] === "show" ||
        rest[0] === "get-url"
      );
    default:
      return GIT_READ.has(sub);
  }
}

/** `gh` group verbs that only read. */
const GH_READ_VERBS = new Set(["view", "list", "diff", "checks", "status", "show"]);
const GH_API_WRITE_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

/** `gh` groups and verbs that may appear in a guard-hit text; anything else is never echoed. */
const GH_GROUPS = new Set([
  "pr",
  "issue",
  "repo",
  "api",
  "search",
  "run",
  "workflow",
  "release",
  "label",
  "project",
  "gist",
  "auth",
  "secret",
  "variable",
  "ssh-key",
  "gpg-key",
  "cache",
  "codespace",
  "extension",
  "alias",
  "config",
  "browse",
  "status",
  "org",
  "ruleset",
  "attestation",
]);
const GH_VERBS = new Set([
  ...GH_READ_VERBS,
  "create",
  "comment",
  "edit",
  "close",
  "reopen",
  "merge",
  "ready",
  "review",
  "delete",
  "lock",
  "unlock",
  "transfer",
  "develop",
  "checkout",
  "set",
  "token",
  "login",
  "logout",
  "refresh",
  "rerun",
  "cancel",
  "download",
  "upload",
  "clone",
  "fork",
  "archive",
  "rename",
  "sync",
  "add",
  "remove",
  "enable",
  "disable",
  "pin",
  "unpin",
]);

/** The first word after a group that is not a flag, skipping `-R/--repo <v>`. */
function ghVerb(rest: readonly string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "-R" || a === "--repo") i++;
    else if (!a.startsWith("-")) return a;
  }
  return undefined;
}

/** `gh <group>` and `<verb>`, each only from the known vocabulary (never argv). */
function ghText(args: readonly string[]): string {
  const [group, ...rest] = args;
  if (group === undefined || !GH_GROUPS.has(group)) return "gh";
  if (group === "api") return "gh api";
  const verb = ghVerb(rest);
  return verb !== undefined && GH_VERBS.has(verb) ? `gh ${group} ${verb}` : `gh ${group}`;
}

function ghReadOnly(args: readonly string[]): boolean {
  const [group, ...rest] = args;
  if (group === undefined) return true;
  if (group === "search") return true;
  if (group === "api") {
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i] ?? "";
      const flag = a.split("=")[0] ?? a;
      if (GH_API_WRITE_FLAGS.has(flag) || /^-[fF]./.test(a)) return false;
      if (flag === "-X" || flag === "--method") {
        const m = a.includes("=") ? a.slice(a.indexOf("=") + 1) : (rest[i + 1] ?? "");
        if (m.toUpperCase() !== "GET") return false;
      }
      if (/^-X./.test(a) && a.slice(2).toUpperCase() !== "GET") return false;
    }
    return !rest.some((a) => a === "graphql");
  }
  const verb = ghVerb(rest);
  return verb !== undefined && GH_READ_VERBS.has(verb) && group !== "auth" && group !== "secret";
}

const deny = (rule: GuardRule, what: string): GuardVerdict => ({
  kind: "deny",
  rule,
  text: `${GUARD_RULES[rule]}: ${what}`,
});

/** The verdict for one tool call. A deny anywhere in a command line beats a lock. */
export function guardDecision(
  e: GuardEvent,
  ctx: GuardContext,
  superuserTools: readonly McToolName[] = MC_SUPERUSER_TOOLS,
): GuardVerdict {
  if (superuserTools.some((name) => mcTool(name) === e.tool) && ctx.flightPowers !== "superuser") {
    return deny("flight-powers", `${e.tool} (needs flight_powers: superuser)`);
  }
  if (ctx.mode === "read-only") {
    if ((READ_ONLY_BUILTINS as readonly string[]).includes(e.tool)) {
      return deny("read-only", e.tool);
    }
    if (
      (MC_WRITER_TOOLS as readonly string[]).includes(e.tool) &&
      !(e.tool === MC_TOOLS.syncMain && ctx.mcTools?.includes(MC_TOOL_NAMES.syncMain))
    ) {
      return deny("read-only", e.tool);
    }
  }
  if (ctx.mode === "scratch" && (MC_WRITER_TOOLS as readonly string[]).includes(e.tool)) {
    return deny("read-only", `${e.tool} (a scratch copy is never committed)`);
  }
  if (ctx.mode === "scratch" && (MC_SCRATCH_DENIED_TOOLS as readonly string[]).includes(e.tool)) {
    return deny("read-only", `${e.tool} (a scratch review answers with report_findings)`);
  }
  if (e.tool !== "Bash") return { kind: "allow" };
  let lock: string | null = null;
  let backgroundSuite = false;
  const walk = newWalk();
  for (const { argv, background, braces } of lineCommands(e.input.command ?? "", walk)) {
    const [program, ...args] = argv;
    if (program === undefined) continue;
    if (program === TOO_LONG) {
      return { kind: "deny", rule: "git-write", text: GUARD_TOO_LONG_TEXT };
    }
    if (program === UNREADABLE_LINE) {
      return { kind: "deny", rule: "git-write", text: GUARD_UNREADABLE_TEXT };
    }
    if (program === UNREADABLE_SCRIPT) return deny("git-write", "shell -c");
    if (program === STDIN_SCRIPT) return deny("git-write", "shell reading stdin");
    if (program === BRACE_WORD) return deny("git-write", "brace expansion");
    if (program === "git") {
      const g = gitSubcommand(args);
      if (g !== null && !gitReadOnly(g.sub, g.rest)) {
        return deny("git-write", GIT_KNOWN.has(g.sub) ? `git ${g.sub}` : "git");
      }
    } else if (program === "gh") {
      if (!ghReadOnly(args)) {
        return deny("github-write", ghText(args));
      }
    } else if (program === "curl" || program === "wget") {
      return deny("network", program);
    }
    const suite =
      matchedSuite(argv, ctx.fullSuite) ??
      (braces === true ? suiteOfProgram(program, ctx.fullSuite) : null);
    if (suite !== null) {
      if (ctx.mode !== "writer") return deny("full-suite", suite);
      if (e.input.run_in_background === true) {
        return { kind: "deny", rule: "full-suite", text: BACKGROUND_SUITE_TEXT };
      }
      if (background) backgroundSuite = true;
      lock ??= suite;
    }
  }
  if (lock === null) return { kind: "allow" };
  // A suite in the background returns at once while it keeps running: it would leave the lock early.
  if (backgroundSuite || walk.lineBackground) {
    return { kind: "deny", rule: "full-suite", text: BACKGROUND_SUITE_TEXT };
  }
  return { kind: "lock", command: lock };
}

export const SECRET_KINDS = [
  "GitHub token",
  "Anthropic key",
  "AWS access key",
  "private key",
  "Slack token",
  "local credential",
] as const;

export interface SecretFinding {
  where: string;
  line: number;
  kind: (typeof SECRET_KINDS)[number];
}

const SECRET_PATTERNS: readonly { kind: SecretFinding["kind"]; re: RegExp }[] = [
  { kind: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { kind: "GitHub token", re: /github_pat_[A-Za-z0-9_]{60,}/ },
  { kind: "Anthropic key", re: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { kind: "private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "Slack token", re: /xox[abposr]-[A-Za-z0-9-]{10,}/ },
];

const MIN_KNOWN_SECRET = 16;

/** The kinds of secret one line holds (each at most once). Never returns the match. */
function kindsIn(line: string, known: readonly string[]): SecretFinding["kind"][] {
  const kinds = new Set<SecretFinding["kind"]>();
  for (const p of SECRET_PATTERNS) if (p.re.test(line)) kinds.add(p.kind);
  for (const k of known) {
    if (k.length >= MIN_KNOWN_SECRET && line.includes(k)) kinds.add("local credential");
  }
  return [...kinds];
}

/** A location that is safe to show: a path that is itself a secret is withheld. */
function safeWhere(where: string, known: readonly string[]): string {
  return kindsIn(where, known).length > 0 ? "(name withheld)" : where;
}

/** Scan free text (a PR title or body); `line` is 1-based. */
export function scanText(where: string, text: string, known: readonly string[]): SecretFinding[] {
  const out: SecretFinding[] = [];
  const shown = safeWhere(where, known);
  text.split("\n").forEach((l, i) => {
    for (const kind of kindsIn(l, known)) out.push({ where: shown, line: i + 1, kind });
  });
  return out;
}

const QUOTED_ESCAPES: Record<string, number> = { t: 9, n: 10, '"': 34, "\\": 92 };

/** A path as a diff header writes it: C-quoted when it holds odd bytes. */
function unquotePath(raw: string): string {
  const s = raw.replace(/\t.*$/, "");
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) return s;
  const bytes: number[] = [];
  const body = s.slice(1, -1);
  for (let i = 0; i < body.length; i++) {
    const c = body.charAt(i);
    if (c !== "\\") {
      bytes.push(...Buffer.from(c, "utf8"));
      continue;
    }
    const oct = /^[0-7]{1,3}/.exec(body.slice(i + 1, i + 4));
    if (oct) {
      bytes.push(Number.parseInt(oct[0], 8));
      i += oct[0].length;
    } else {
      bytes.push(QUOTED_ESCAPES[body.charAt(i + 1)] ?? body.charCodeAt(i + 1));
      i++;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripPrefix(p: string): string {
  return /^[ab]\//.test(p) ? p.slice(2) : p;
}

const HEADER_LINE =
  /^(--- |\+\+\+ |index |new file mode|deleted file mode|old mode|new mode|similarity index|dissimilarity index|rename |copy |remerge CONFLICT |Binary files|GIT binary patch)/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** A commit header: `\0commit ` then a full id (or the commit tool's `staged`) and a newline. */
const COMMIT_HEADER = /\0commit (?=(?:[0-9a-f]{40}|staged)\n)/;

/** The new path of a `diff --git a/old b/new` line (the part after `diff --git `). */
function diffGitNewPath(rest: string): string {
  if (rest.endsWith('"')) {
    const open = rest.lastIndexOf(' "', rest.length - 2);
    return stripPrefix(unquotePath(open < 0 ? rest : rest.slice(open + 1)));
  }
  // With --no-renames both halves are one path, which may itself hold " b/".
  const half = (rest.length - 1) / 2;
  if (rest.startsWith("a/") && rest.slice(half, half + 3) === " b/") {
    if (rest.slice(2, half) === rest.slice(half + 3)) return rest.slice(half + 3);
  }
  return rest;
}

/**
 * Scan `git log -p --text --no-textconv --no-ext-diff --format=%x00commit %H%n%B` output: every
 * added line (the file and its new line number), the path of every file the change adds or
 * modifies (line 0, name withheld) and every commit message (`commit <sha7>`).
 * Findings carry the place and the kind, never the match.
 */
export function scanSecrets(text: string, known: readonly string[]): SecretFinding[] {
  const out: SecretFinding[] = [];
  for (const chunk of text.split(COMMIT_HEADER).slice(1)) {
    const lines = chunk.split("\n");
    const id = (lines.shift() ?? "").trim();
    // a file line can fake a header whose id is a known credential: scan the id too
    for (const kind of kindsIn(id, known)) out.push({ where: "(name withheld)", line: 0, kind });
    const sha7 = id.slice(0, 7);
    const commitWhere = `commit ${sha7}`;
    let messageLine = 0;
    const message = (l: string) => {
      messageLine++;
      for (const kind of kindsIn(l, known)) {
        out.push({ where: commitWhere, line: messageLine, kind });
      }
    };
    let state: "message" | "header" | "hunk" = "message";
    let oldPath = "";
    let file = "";
    let newLine = 0;
    let oldLeft = 0;
    let newLeft = 0;
    // The current file's new path, until it has been scanned (once per file).
    let pendingPath: string | null = null;
    let deleted = false;
    const scanPath = (p: string) => {
      pendingPath = null;
      for (const kind of kindsIn(p, known)) {
        out.push({ where: "(name withheld)", line: 0, kind });
      }
    };
    const flushPath = () => {
      if (pendingPath !== null && !deleted) scanPath(pendingPath);
      pendingPath = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (state === "hunk" && oldLeft <= 0 && newLeft <= 0) state = "header";
      if (state === "hunk") {
        const c = l.charAt(0);
        if (c === "+") {
          for (const kind of kindsIn(l.slice(1), known)) {
            out.push({ where: safeWhere(file, known), line: newLine, kind });
          }
          newLine++;
          newLeft--;
        } else if (c === "-") oldLeft--;
        else if (c === "\\") continue;
        else {
          oldLeft--;
          newLeft--;
          newLine++;
        }
        continue;
      }
      if (l.startsWith("diff --git ")) {
        flushPath();
        state = "header";
        oldPath = "";
        file = "";
        deleted = false;
        pendingPath = diffGitNewPath(l.slice("diff --git ".length));
        continue;
      }
      if (state === "header") {
        const hunk = HUNK.exec(l);
        if (hunk) {
          flushPath();
          oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
          newLine = Number(hunk[2]);
          newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
          state = "hunk";
          continue;
        }
        if (l.startsWith("--- ")) {
          oldPath = stripPrefix(unquotePath(l.slice(4)));
          continue;
        }
        if (l.startsWith("+++ ")) {
          const p = unquotePath(l.slice(4));
          file = p === "/dev/null" ? oldPath : stripPrefix(p);
          if (p === "/dev/null") pendingPath = null;
          else scanPath(file);
          continue;
        }
        if (l.startsWith("deleted file mode")) deleted = true;
        if (HEADER_LINE.test(l)) continue;
        flushPath();
        state = "message";
      }
      message(l);
    }
    flushPath();
  }
  return out;
}

/** A GitHub login, as the mention rule reads it. */
const LOGIN = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
/**
 * `@login` or a team mention `@org/team`, not preceded by a word character. Each form
 * is maximal (a lookahead forbids one more of its characters), so `@mc/core` is read whole, and a
 * `/` after a bare login (`@mc/`) still leaves `@mc` a mention.
 */
const MENTION = new RegExp(
  `(?<!\\w)@${LOGIN}(?:/[A-Za-z0-9][A-Za-z0-9_-]*(?![A-Za-z0-9_-])|(?![A-Za-z0-9-]))`,
  "g",
);
/** `owner/repo#n`, the owner starting at a login boundary (over-matching fails closed). */
const REPO_REF = new RegExp(`(?<![A-Za-z0-9-])(${LOGIN})/([A-Za-z0-9._-]{1,100})#(\\d+)`, "g");
/** A link to an issue, PR or discussion on github.com, scheme optional: owner, repo, number. */
const URL_REF = `(?:https?://)?(?:www\\.)?github\\.com/(${LOGIN})/([A-Za-z0-9._-]+)/(?:issues|pull|discussions)/(\\d+)`;
const ISSUE_URL = new RegExp(URL_REF, "gi");
const ISSUE_REF = /(?<!\w)#(\d+)(?!\w)/g;
const GH_REF = /(?<!\w)GH-(\d+)(?!\w)/gi;
/**
 * A closing keyword before any form of issue: `#n` (1), `GH-n` (2), `owner/repo#n` (3–5), or a
 * URL (6–8). Spaces, `:`, `[`, `(`, `<`, `>`, quotes and emphasis or strike marks may sit
 * between them (`Fixes:#9`, `fixes **#9**`, `closes _#9_`, `Fixes ~~#9~~`): over-matching fails
 * closed.
 */
const CLOSING_REF = new RegExp(
  `\\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)[\\s:*_~\\[(<>"']*(?:#(\\d+)|GH-(\\d+)|(${LOGIN})/([A-Za-z0-9._-]+)#(\\d+)|${URL_REF})(?![A-Za-z0-9])`,
  "gi",
);

/**
 * What GitHub itself links as a closing keyword: the keyword, an optional `:`, blanks, then `#n`,
 * `GH-n`, `owner/repo#n` or an issue URL. Same capture groups as `CLOSING_REF`. For deciding
 * whether the hub still owes a closing line, so it under-matches where `CLOSING_REF` over-matches.
 */
const STRICT_CLOSING_REF = new RegExp(
  `\\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved):?[ \\t]+(?:#(\\d+)|GH-(\\d+)|(${LOGIN})/([A-Za-z0-9._-]+)#(\\d+)|(?:https?://)?(?:www\\.)?github\\.com/(${LOGIN})/([A-Za-z0-9._-]+)/issues/(\\d+))(?![A-Za-z0-9])`,
  "gi",
);

/** Whether a closing match targets the run's own issue in the run's own repo. */
function closesOwn(m: RegExpExecArray, own: string, issue: number | null): boolean {
  const n = Number(m[1] ?? m[2] ?? m[5] ?? m[8]);
  const owner = m[3] ?? m[6];
  const repo = m[4] ?? m[7];
  const sameRepo = owner === undefined || `${owner}/${repo}`.toLowerCase() === own;
  return sameRepo && issue !== null && n === issue;
}

/** The earliest [index, text] match, or null. */
function earliest(found: [number, string][]): [number, string] | null {
  found.sort((a, b) => a[0] - b[0]);
  return found[0] ?? null;
}

const allMatches = (re: RegExp, text: string, keep: (m: RegExpExecArray) => boolean = () => true) =>
  [...text.matchAll(re)].filter(keep).map((m): [number, string] => [m.index, m[0]]);

/**
 * The named character references the notifiers allow: decoded here (each needs its `;`), and
 * passed by `firstNamedRef`. GitHub honours many more names (`&sol;` is `/`); those refuse.
 */
const NAMED_REFS: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00a0",
  commat: "@",
  num: "#",
  grave: "`",
};
const ALLOWED_NAMES = new Set(Object.keys(NAMED_REFS));
/**
 * A numeric character reference, decimal or hex (the `;` optional, as an HTML parser reads it:
 * over-decoding fails closed), or one of `NAMED_REFS`.
 */
const CHAR_REF = new RegExp(
  `&#(?:(\\d+)|[xX]([0-9A-Fa-f]+));?|&(${[...ALLOWED_NAMES].join("|")});`,
  "g",
);
/** Any named reference, `;` or not: a name GitHub might turn into a character. */
const NAMED_REF = /&([A-Za-z][A-Za-z0-9]*);?/g;

/**
 * The first named character reference not in `NAMED_REFS`, as written, or null: `&sol;`,
 * `&period;`, `&lowbar` and the like could spell a reference the notifiers would not see, so they
 * refuse (fails closed). Read on the text as written: `&amp;sol;` is `&amp;` and then text.
 */
export function firstNamedRef(text: string): string | null {
  for (const m of text.matchAll(NAMED_REF)) {
    if (!ALLOWED_NAMES.has(m[1] ?? "")) return m[0];
  }
  return null;
}

/** Decoded text, and for each of its UTF-16 units the index it came from in the text as written. */
interface Decoded {
  text: string;
  /** `from[i]`: where decoded unit i starts as written; `from[text.length]`: the written length. */
  from: number[];
}

/** The character one `CHAR_REF` match stands for. */
function refChar(m: RegExpExecArray): string {
  const [, dec, hex, name] = m;
  if (name !== undefined) return NAMED_REFS[name] ?? "";
  const cp = dec !== undefined ? Number.parseInt(dec, 10) : Number.parseInt(hex ?? "", 16);
  const valid = cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
  return valid ? String.fromCodePoint(cp) : "\uFFFD";
}

/** Text with its character references decoded once, left to right, keeping where each came from. */
function decode(written: string): Decoded {
  let text = "";
  const from: number[] = [];
  let last = 0;
  const copy = (to: number) => {
    for (let i = last; i < to; i++) from.push(i);
    text += written.slice(last, to);
  };
  for (const m of written.matchAll(CHAR_REF)) {
    copy(m.index);
    const c = refChar(m);
    for (let k = 0; k < c.length; k++) from.push(m.index);
    text += c;
    last = m.index + m[0].length;
  }
  copy(written.length);
  from.push(written.length);
  return { text, from };
}

/**
 * Text with its HTML character references decoded, once, left to right: `&#64;`, `&#x40;` and
 * `&commat;` read as `@`, and `&amp;#64;` as `&#64;` (never decoded again). A code point that
 * cannot be one (0, a surrogate, past U+10FFFF) reads as U+FFFD.
 */
export function decodeCharRefs(text: string): string {
  return decode(text).text;
}

/** A match in decoded text as the refusal names it: with the written form when that differs. */
function asWritten(d: Decoded, written: string, hit: [number, string] | null): string | null {
  if (hit === null) return null;
  const [at, text] = hit;
  const raw = written.slice(d.from[at] ?? 0, d.from[at + text.length] ?? written.length);
  return raw === text ? text : `${text} (written as ${raw})`;
}

/** A github.com URL, scheme and `www.` optional, to the first space, quote, `<` or `>`. */
const GITHUB_URL = /(?<![A-Za-z0-9-])(?:https?:\/\/)?(?:www\.)?github\.com[^\s<>"'`]*/gi;
/**
 * A github.com URL holding a `%` (percent-encoding the issue-link rule would not read) or an
 * explicit port (`github.com:443/…`): refused, whatever it points at (fails closed).
 */
const oddGithubUrl = (m: RegExpExecArray): boolean =>
  m[0].includes("%") || /github\.com\.?:[\d/]/i.test(m[0]);

/** CommonMark HTML blocks 1–5, which run to their own end marker (blank lines included). */
const RAW_HTML: readonly { start: RegExp; end: RegExp }[] = [
  {
    start: /^ {0,3}<(?:pre|script|style|textarea)(?=[\s>]|$)/i,
    end: /<\/(?:pre|script|style|textarea)>/i,
  },
  { start: /^ {0,3}<!--/, end: /-->/ },
  { start: /^ {0,3}<\?/, end: /\?>/ },
  { start: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/ },
  { start: /^ {0,3}<![A-Za-z]/, end: />/ },
];
/** Any other HTML block start (6 and 7), which a blank line ends. Over-matching fails closed. */
const HTML_START = /^ {0,3}<[A-Za-z/]/;

/**
 * Whether markdown ends inside a code block or a raw HTML block 1–5 (a comment, `<pre>`…). Lines
 * appended after it would be swallowed. CRLF and lone CR read as LF.
 * - Only a fence at the line's first column, outside any HTML block, opens a code block. Inside
 *   HTML, GitHub shows ``` lines as text.
 * - HTML blocks 1–5 run to their own end marker (blank lines included); any other HTML block start
 *   (6 and 7) runs to a blank line. Over-matching fails closed.
 * - An unclosed block runs to the end (CommonMark).
 */
export function unclosedMarkdown(md: string): boolean {
  let fence: { ch: string; len: number } | null = null;
  let rawEnd: RegExp | null = null;
  let html = false;
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (fence !== null) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (close !== undefined && close.charAt(0) === fence.ch && close.length >= fence.len) {
        fence = null;
      }
      continue;
    }
    if (rawEnd !== null) {
      if (rawEnd.test(line)) rawEnd = null;
      continue;
    }
    if (html) {
      if (line.trim() !== "") continue;
      html = false;
    }
    const open = /^(`{3,}|~{3,})(.*)$/.exec(line);
    const marks = open?.[1];
    if (marks !== undefined && !(marks.charAt(0) === "`" && (open?.[2] ?? "").includes("`"))) {
      fence = { ch: marks.charAt(0), len: marks.length };
      continue;
    }
    const raw = RAW_HTML.find((r) => r.start.test(line));
    if (raw !== undefined) {
      if (!raw.end.test(line.replace(raw.start, ""))) rawEnd = raw.end;
      continue;
    }
    if (HTML_START.test(line)) html = true;
  }
  return fence !== null || rawEnd !== null;
}

/** Link equal-length runs in one scan, then blank spans in opening order without rescanning text. */
function blankCodeSpans(md: string): string {
  type Run = { start: number; end: number; next?: Run };
  const runs: Run[] = [];
  const open = new Map<number, Run>();
  for (const match of md.matchAll(/`+|\r?\n[ \t]*\r?\n/g)) {
    const marks = match[0];
    if (marks.charAt(0) !== "`") {
      open.clear();
      continue;
    }
    const run: Run = { start: match.index, end: match.index + marks.length };
    const previous = open.get(marks.length);
    if (previous !== undefined) previous.next = run;
    open.set(marks.length, run);
    runs.push(run);
  }
  const parts: string[] = [];
  let end = 0;
  for (const run of runs) {
    if (run.start < end || run.next === undefined) continue;
    // A word character preserves boundary blockers on both sides without joining a reference:
    // x is not separator whitespace, starts no closing keyword, and ends no issue number.
    parts.push(md.slice(end, run.start), "x");
    end = run.next.end;
  }
  parts.push(md.slice(end));
  return parts.join("");
}

/**
 * Whether markdown has a closing keyword (`Fixes #n`, `Closes owner/repo#n`, …) aimed at the run's
 * own issue in the run's own repo (character references decoded). A plain mention does not close
 * it, and neither does a keyword GitHub ignores: in a code block or span, an HTML comment,
 * emphasis, or a PR or discussion link. This under-matches on purpose: a duplicate closing line
 * is harmless, a missing one leaves the issue open.
 */
export function closesIssue(md: string, { repo, issue }: { repo: string; issue: number }): boolean {
  const own = repo.toLowerCase();
  const text = blankCodeSpans(
    decodeCharRefs(md).replace(
      /^ {0,3}(?:(`{3,})(?!`)[^\n]*\n[\s\S]*?(?:\n {0,3}\1`*[ \t]*(?=\n|$)|(?![\s\S]))|(~{3,})(?!~)[^\n]*\n[\s\S]*?(?:\n {0,3}\2~*[ \t]*(?=\n|$)|(?![\s\S])))/gm,
      "",
    ),
  ).replace(/<!--[\s\S]*?-->/g, "");
  return [...text.matchAll(STRICT_CLOSING_REF)].some((m) => closesOwn(m, own, issue));
}

/**
 * The first thing in a PR title or body that would notify someone or act on another item, as
 * written once its character references are decoded, or null. PR text is read as plain text:
 * backticks, fences, HTML and links hide nothing. That is any mention (team mentions too), any
 * `#n`, `GH-n`, `owner/repo#n` or issue/PR link but the run's own issue in its own repo, and a
 * closing keyword for anything but that issue, and a github.com URL with a `%` or a port. A match
 * from decoded text is named with its written form too. `repo` is the run's own `owner/name`.
 * Named references outside `NAMED_REFS` are the caller's to refuse first (`firstNamedRef`).
 * With `allowOwnRepoRefs`, a bare `#n` or `GH-n` (an issue of `repo` itself) passes too; mentions,
 * `owner/repo#n`, links, and closing keywords for another issue are still found.
 */
export function firstPrNotifier(
  text: string,
  {
    repo,
    issue,
    allowOwnRepoRefs = false,
  }: { repo: string; issue: number | null; allowOwnRepoRefs?: boolean },
): string | null {
  const d = decode(text);
  const t = d.text;
  const own = repo.toLowerCase();
  const notOwn = (n: string | undefined) => issue === null || Number(n) !== issue;
  const otherItem = (m: RegExpExecArray) => `${m[1]}/${m[2]}`.toLowerCase() !== own || notOwn(m[3]);
  const hit = earliest([
    ...allMatches(MENTION, t),
    ...allMatches(ISSUE_REF, t, (m) => !allowOwnRepoRefs && notOwn(m[1])),
    ...allMatches(GH_REF, t, (m) => !allowOwnRepoRefs && notOwn(m[1])),
    ...allMatches(REPO_REF, t, otherItem),
    ...allMatches(ISSUE_URL, t, otherItem),
    ...allMatches(CLOSING_REF, t, (m) => !closesOwn(m, own, issue)),
    ...allMatches(GITHUB_URL, t, oddGithubUrl),
  ]);
  return asWritten(d, text, hit);
}

/**
 * The first thing in a commit message GitHub would act on once pushed, or null. That is a closing
 * keyword before any issue, or any reference to an item but the run's own issue in its own repo:
 * `#n`, `GH-n`, `owner/repo#n`, an issue or PR link, or a mention. Commit messages are plain
 * text: nothing in them is code. Character references are decoded first, as for PR text, and a
 * github.com URL with a `%` or a port refuses.
 */
export function firstCommitNotifier(
  message: string,
  { repo, issue }: { repo: string; issue: number | null },
): string | null {
  const d = decode(message);
  const t = d.text;
  const own = repo.toLowerCase();
  const notOwn = (n: string | undefined) => issue === null || Number(n) !== issue;
  const hit = earliest([
    ...allMatches(CLOSING_REF, t),
    ...allMatches(ISSUE_REF, t, (m) => notOwn(m[1])),
    ...allMatches(GH_REF, t, (m) => notOwn(m[1])),
    ...allMatches(ISSUE_URL, t, (m) => `${m[1]}/${m[2]}`.toLowerCase() !== own || notOwn(m[3])),
    ...allMatches(REPO_REF, t),
    ...allMatches(MENTION, t),
    ...allMatches(GITHUB_URL, t, oddGithubUrl),
  ]);
  return asWritten(d, message, hit);
}
