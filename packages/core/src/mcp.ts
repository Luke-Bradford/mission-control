/** MCP protocol versions the hub's `/mcp` endpoint speaks, newest first (spike 2026-10-21). */
export const MCP_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const;
/** The MCP server key in the seat's `--mcp-config`; its tools reach the model as `mcp__mc__<tool>`. */
export const MC_MCP_SERVER = "mc";
/** The `_meta` key the CLI puts the model's tool_use id under on a `tools/call`. */
export const TOOL_USE_ID_META = "claudecode/toolUseId";

/** The mc tools as the hub's `/mcp` endpoint serves them; the CLI prefixes each (`MC_TOOLS`). */
export const MC_TOOL_NAMES = {
  commit: "commit",
  syncMain: "sync_main",
  push: "push",
  draftPr: "draft_pr",
  askFlight: "ask_flight",
  reportEvidence: "report_evidence",
  reportFindings: "report_findings",
  restoreFile: "restore_file",
  reportPlan: "report_plan",
  logDecision: "log_decision",
  readTicket: "read_ticket",
  answerQuestion: "answer_question",
  startSeat: "start_seat",
  messageSeat: "message_seat",
  commsRead: "comms_read",
  commsSend: "comms_send",
  commsReact: "comms_react",
  commsPin: "comms_pin",
  flightState: "flight_state",
  promote: "promote",
  endRun: "end_run",
  acceptRuling: "accept_ruling",
  mergePr: "merge_pr",
  settlePark: "settle_park",
  rerunCi: "rerun_ci",
  editCard: "edit_card",
  dismissItem: "dismiss_item",

  createTicket: "create_ticket",
  commentTicket: "comment_ticket",
  briefItem: "brief_item",
  readPr: "read_pr",
  readCiLog: "read_ci_log",
  ghRead: "gh_read",
  listTickets: "list_tickets",
  updateBrief: "update_brief",
  draftReply: "draft_reply",
  track: "track",
  untrack: "untrack",
  ledger: "ledger",
  remember: "remember",
  forget: "forget",
  recall: "recall",
  holdItem: "hold_item",
  releaseHold: "release_hold",
} as const;

export type McToolName = (typeof MC_TOOL_NAMES)[keyof typeof MC_TOOL_NAMES];

/** The name the CLI gives one mc tool. */
export const mcTool = <T extends McToolName>(name: T) => `mcp__${MC_MCP_SERVER}__${name}` as const;

/** The mc tools as the model, the allowlist and the guard name them: `mcp__mc__<tool>`. */
export const MC_TOOLS = {
  commit: mcTool(MC_TOOL_NAMES.commit),
  syncMain: mcTool(MC_TOOL_NAMES.syncMain),
  push: mcTool(MC_TOOL_NAMES.push),
  draftPr: mcTool(MC_TOOL_NAMES.draftPr),
  askFlight: mcTool(MC_TOOL_NAMES.askFlight),
  reportEvidence: mcTool(MC_TOOL_NAMES.reportEvidence),
  reportFindings: mcTool(MC_TOOL_NAMES.reportFindings),
  restoreFile: mcTool(MC_TOOL_NAMES.restoreFile),
  reportPlan: mcTool(MC_TOOL_NAMES.reportPlan),
  logDecision: mcTool(MC_TOOL_NAMES.logDecision),
  readTicket: mcTool(MC_TOOL_NAMES.readTicket),
  answerQuestion: mcTool(MC_TOOL_NAMES.answerQuestion),
  startSeat: mcTool(MC_TOOL_NAMES.startSeat),
  messageSeat: mcTool(MC_TOOL_NAMES.messageSeat),
  commsRead: mcTool(MC_TOOL_NAMES.commsRead),
  commsSend: mcTool(MC_TOOL_NAMES.commsSend),
  commsReact: mcTool(MC_TOOL_NAMES.commsReact),
  commsPin: mcTool(MC_TOOL_NAMES.commsPin),
  flightState: mcTool(MC_TOOL_NAMES.flightState),
  promote: mcTool(MC_TOOL_NAMES.promote),
  endRun: mcTool(MC_TOOL_NAMES.endRun),
  acceptRuling: mcTool(MC_TOOL_NAMES.acceptRuling),
  mergePr: mcTool(MC_TOOL_NAMES.mergePr),
  settlePark: mcTool(MC_TOOL_NAMES.settlePark),
  rerunCi: mcTool(MC_TOOL_NAMES.rerunCi),
  editCard: mcTool(MC_TOOL_NAMES.editCard),
  dismissItem: mcTool(MC_TOOL_NAMES.dismissItem),

  createTicket: mcTool(MC_TOOL_NAMES.createTicket),
  commentTicket: mcTool(MC_TOOL_NAMES.commentTicket),
  briefItem: mcTool(MC_TOOL_NAMES.briefItem),
  readPr: mcTool(MC_TOOL_NAMES.readPr),
  readCiLog: mcTool(MC_TOOL_NAMES.readCiLog),
  ghRead: mcTool(MC_TOOL_NAMES.ghRead),
  listTickets: mcTool(MC_TOOL_NAMES.listTickets),
  updateBrief: mcTool(MC_TOOL_NAMES.updateBrief),
  draftReply: mcTool(MC_TOOL_NAMES.draftReply),
  track: mcTool(MC_TOOL_NAMES.track),
  untrack: mcTool(MC_TOOL_NAMES.untrack),
  ledger: mcTool(MC_TOOL_NAMES.ledger),
  remember: mcTool(MC_TOOL_NAMES.remember),
  forget: mcTool(MC_TOOL_NAMES.forget),
  recall: mcTool(MC_TOOL_NAMES.recall),
  holdItem: mcTool(MC_TOOL_NAMES.holdItem),
  releaseHold: mcTool(MC_TOOL_NAMES.releaseHold),
} as const;

/** The longest commit message and operator question the mc tools take. */
export const MC_TEXT_MAX = 2000;
/**
 * The most JSON `comms_read` returns, the same bound as FLIGHT's gh_read response
 * (`FLIGHT_GH_READ_MAX`): past it the oldest messages are left out, and the result says how many.
 */
export const MC_COMMS_READ_MAX = 20_000;
/** The longest note `report_evidence` takes. */
export const MC_EVIDENCE_MAX = 4000;
/** An mc tool call whose arguments fail validation: this, then the first problem. */
export const MC_BAD_ARGS = "Invalid arguments: ";
/** A call from a run that is no longer the seat's live one (it ended, or the seat moved on). */
export const MC_RUN_ENDED = "This run has ended.";

export const SYNC_MAIN_GAP_MIN = 10;
export const SYNC_MAIN_GAP_MS = SYNC_MAIN_GAP_MIN * 60_000;
export const MC_SYNC_UP_TO_DATE = "Already up to date: your branch contains main.";
export const syncMergedText = (mainSha: string, sha: string): string =>
  `Merged main ${mainSha.slice(0, 7)} into your branch as ${sha.slice(0, 7)}.`;
export const writerSyncConflictText = (files: readonly string[]): string =>
  `Conflicts in: ${files.join(", ")}. Resolve the conflict markers in those files, keeping what both sides meant, then call mc commit.`;
export const MC_SYNC_DIRTY =
  "Not merged: your worktree has uncommitted changes. Commit them with mc commit, then call mc sync_main again.";
export const MC_SYNC_NOT_WORKING =
  "Not merged: your run is waiting for CI or review, and Mission Control brings main into the branch itself then.";
export const MC_SYNC_OFF =
  "Not merged: Mission Control's engine is off, so main cannot be brought into your branch now. Ask FLIGHT with mc ask_flight.";
export const syncTooSoonText = (minutes: number): string =>
  `Not merged: main was brought into your branch less than ${SYNC_MAIN_GAP_MIN} minutes ago. Try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
export const syncFailedText = (why: string): string =>
  `Not merged: ${why}. Ask FLIGHT with mc ask_flight if it keeps happening.`;

export const NOTHING_TO_COMMIT = "Nothing to commit.";
/** The last line of every refused commit that names paths. */
export const REVERT_STRAYS = "Revert what you didn't mean to change.";
/** A refused commit names at most this many paths per group, then "and {n} more". */
export const COMMIT_PATHS_NAMED = 10;

export const notOnBranchText = (branch: string): string =>
  `Not committed: your worktree is not on ${branch}.`;

export const committedText = (sha: string, branch: string, subject: string): string =>
  `Committed ${sha.slice(0, 7)} on ${branch}: ${subject}`;

/** `a`, `a and b`, `a, b and c`; past COMMIT_PATHS_NAMED, the first ten then `and {n} more`. */
function pathList(paths: readonly string[]): string {
  if (paths.length > COMMIT_PATHS_NAMED) {
    const rest = paths.length - COMMIT_PATHS_NAMED;
    return `${paths.slice(0, COMMIT_PATHS_NAMED).join(", ")} and ${rest} more`;
  }
  if (paths.length <= 1) return paths.join("");
  return `${paths.slice(0, -1).join(", ")} and ${paths[paths.length - 1]}`;
}

const isAre = (paths: readonly string[]) => (paths.length === 1 ? "is" : "are");

export const clashText = (paths: readonly string[], call: string, ticket: string): string =>
  `Note: ${pathList(paths)} ${isAre(paths)} also changed by ${call} on ${ticket}, which is still open; the two PRs may conflict when the second one is merged, and the operator or the controller will resolve it.`;

/** The most paths one commit may remove, and the longest path. */
export const MC_REMOVE_MAX = 50;
export const MC_REMOVE_PATH_MAX = 1024;
export const removedText = (paths: readonly string[]): string => `Removed ${pathList(paths)}.`;
export const removeNotFileText = (paths: readonly string[]): string =>
  `Not removed: ${pathList(paths)} ${isAre(paths)} a folder or a nested repository; remove takes files only.`;
export const removeLinkedText = (paths: readonly string[]): string =>
  `Not removed: ${pathList(paths)} ${isAre(paths)} inside a symlinked folder in your worktree; Mission Control removes nothing through a symlink.`;
export const removeMissingText = (paths: readonly string[]): string =>
  `Not removed: ${pathList(paths)} ${isAre(paths)} neither in your worktree nor on your branch.`;
/** The last line of a refused remove: nothing was deleted. */
export const MC_REMOVE_REFUSED =
  "Nothing was removed. Take those paths out of remove, then commit again.";
export const MC_REMOVE_FAILED =
  "Not committed: a file to remove changed while Mission Control was removing it, so some files may already be removed. Check git status, then commit again.";

export const outsideAreaText = (paths: readonly string[], globs: readonly string[]): string =>
  `Not committed: ${pathList(paths)} ${isAre(paths)} outside your area (${globs.join(", ")}).`;

export const otherAreaText = (paths: readonly string[], call: string): string =>
  `Not committed: ${pathList(paths)} ${isAre(paths)} in ${call}'s area.`;

export const protectedPathsText = (paths: readonly string[]): string =>
  `Not committed: ${pathList(paths)} ${isAre(paths)} protected (build, install and CI files); ask FLIGHT with mc ask_flight if the ticket needs ${paths.length === 1 ? "it" : "them"}.`;

/** New or changed symlinks (mode 120000) and gitlinks (160000), which the commit tool refuses. */
export const specialPathsText = (paths: readonly string[]): string =>
  `Not committed: ${pathList(paths)} ${isAre(paths)} a symlink or a nested repository; the crew commits plain files only.`;

/** `git add` or `git commit` passed the commit tool's slow timeout. */
export const MC_COMMIT_TOO_SLOW =
  "Not committed: git took too long to stage or commit your changes, so the index was reset. Try again; if it keeps happening, tell FLIGHT with mc ask_flight.";

/** The read-only rule's words: the guard's rule text, and the commit tool's refusal, build on it. */
export const READ_ONLY_CANNOT_WRITE = "Read-only roles cannot write";

/** A read-only seat calling commit (the MCP server hides it from them; this backs that up). */
export const MC_READ_ONLY_COMMIT = `${READ_ONLY_CANNOT_WRITE}: commit is for writer seats.`;

/**
 * Staged paths holding anything but printable ASCII: refused outright (APFS folds some non-ASCII
 * names onto ASCII ones, and control characters would reach the refusal text raw).
 */
export const nonAsciiPathsText = (paths: readonly string[]): string =>
  `Not committed: ${pathList(paths)} ${isAre(paths)} not plain ASCII paths; the crew commits ASCII paths only.`;

/** Folders HEAD holds as a gitlink that the worktree has as a plain folder with files in it. */
export const formerSubmoduleText = (paths: readonly string[]): string =>
  `Not committed: ${pathList(paths)} ${isAre(paths)} a former submodule folder; the files in it cannot be committed here (this check covers the whole repository, not only your paths).`;

/** The index listing the former-submodule check reads passed its own output cap. */
export const MC_INDEX_UNLISTABLE =
  "Not committed: the commit tool could not list the index; ask FLIGHT with mc ask_flight.";

/**
 * A secret in the staged changes (`where` is the file) or the message (`commit message`). Refused
 * before committing, so the seat can take it out; the push's scan is the backstop. Never the secret.
 */
export const commitSecretText = (where: string, line: number, kind: string): string =>
  `Not committed: ${where}:${line} looks like a ${kind}. Take it out, then commit again.`;

/** The staged changes' listing passed the commit tool's output cap. */
export const MC_COMMIT_TOO_BIG =
  "Not committed: the change is too large for the commit tool to check, so the index was reset. Commit fewer files at once; if it keeps happening, tell FLIGHT with mc ask_flight.";

export const ASKED_FLIGHT =
  "Asked FLIGHT. It answers, or takes the question to the operator with its brief; the answer arrives as a message. Carry on with what you can meanwhile.";
/** ask_flight from FLIGHT itself: it takes decisions to the operator with a brief, never a bare question. */
export const ASK_FLIGHT_SELF =
  'Not asked: you are FLIGHT. Take a decision to the operator with mc brief_item { for: "operator" } on its Needs-you item, or an @CAPCOM question in your reply.';

/** The hub's address: loopback only. The guard hook sends its token nowhere else. */
export const LOOPBACK_HOST = "127.0.0.1";
/** Every API route is under this prefix. */
export const API_PREFIX = "/api";
/** The header carrying the per-boot operator token on every mutating /api request. */
export const OPERATOR_HEADER = "x-mc-operator";
/** Where the HUD reads the operator token at page load. */
export const OPERATOR_BOOTSTRAP_PATH = "/api/operator/bootstrap";
/** The 401 answer to a mutating /api request without the operator token. */
export const OPERATOR_TOKEN_REQUIRED = "operator token required";
/** The hub's MCP endpoint. */
export const MCP_PATH = "/mcp";
/**
 * The CLI's per-server tool-call timeout in the seat's MCP config (ms). Its default is 60 s
 * (spike 2026-10-21), too short for a push or a draft PR.
 */
export const MC_MCP_TIMEOUT_MS = 600_000;

/**
 * A seat's `--mcp-config` file: the mc server over HTTP with the run's bearer token. Written to a
 * 0600 file and passed by path, never inline: inline JSON would put the token in argv.
 */
export function crewMcpConfig(url: string, token: string): string {
  return JSON.stringify({
    mcpServers: {
      [MC_MCP_SERVER]: {
        type: "http",
        url,
        headers: { Authorization: `Bearer ${token}` },
        timeout: MC_MCP_TIMEOUT_MS,
      },
    },
  });
}

/** A read-only seat calling a writer tool other than commit (hidden from them; this backs it up). */
export const readOnlyToolText = (tool: string): string =>
  `${READ_ONLY_CANNOT_WRITE}: ${tool} is for writer seats.`;

// ---------- push ----------

export const pushedText = (sha: string, branch: string): string =>
  `Pushed ${sha.slice(0, 7)} to ${branch}.`;
/** origin's branch is already at the run's tip: a push cut off by a restart, or nothing new. */
export const alreadyOnOriginText = (sha: string): string =>
  `Already on origin: ${sha.slice(0, 7)}.`;
export const NOTHING_TO_PUSH = "Nothing to push.";
/**
 * The push texts below are written for the operator: the engine pushes, and a refusal reaches them as the
 * Blocked note's reason (the one Needs-you item), never the seat. Each says what was refused and
 * what they can do; a message to the seat resumes the run.
 */
export const pushForeignText = (shas: readonly string[]): string =>
  `Not pushed: ${shas.map((s) => s.slice(0, 7)).join(", ")} ${shas.length === 1 ? "was" : "were"} not made by the commit tool, so the branch cannot be pushed. Look at the branch in the seat's worktree, then message the seat.`;
/** origin's branch has commits the local branch lacks; also git's own non-fast-forward refusal. */
export const originMovedText = (branch: string): string =>
  `Not pushed: origin's ${branch} has commits this run doesn't have. If they are not wanted, reset origin's branch to the run's last push, then message the seat; if they are, end the run.`;
export const MC_PUSH_MERGE =
  "Not pushed: the branch has a merge commit Mission Control did not make, so the branch cannot be pushed. Look at the branch in the seat's worktree, then message the seat.";
/** The worktree has a merge in progress that the engine did not start. */
export const MC_COMMIT_MERGE_UNKNOWN =
  "Not committed: your worktree has a merge in progress that Mission Control did not start. Ask FLIGHT with mc ask_flight.";
export const commitUnresolvedText = (paths: readonly string[]): string =>
  `Not committed: ${pathList(paths)} ${isAre(paths)} still unmerged. Resolve the conflict, then commit again.`;
export const commitMarkersText = (paths: readonly string[]): string =>
  `Not committed: ${pathList(paths)} still ${paths.length === 1 ? "has" : "have"} conflict markers (lines starting <<<<<<< or >>>>>>>). Resolve them, then commit again.`;
/** A new commit with no parent (a root commit): never made by the commit tool. */
export const MC_PUSH_ROOT =
  "Not pushed: a new commit has no parent, which the commit tool never makes, so the branch cannot be pushed. Look at the branch in the seat's worktree, then message the seat.";
/** The run's branch has no commit in the session clone. */
export const MC_PUSH_NO_COMMIT =
  "Not pushed: the run's branch has no commit in the session clone. Look at the branch in the seat's worktree, then message the seat.";
export const MC_PUSH_FSCK =
  "Not pushed: the session clone failed git fsck. Check the clone's health, then message the seat.";
/**
 * A secret in what the push would send. The commit is already made and a seat cannot rewrite
 * history (no git writes; the commit tool only adds commits), so only the operator can fix it. Never the
 * secret.
 */
export const pushSecretText = (where: string, line: number, kind: string): string =>
  `Not pushed: ${where}:${line} looks like a ${kind}. The commit is already made and the seat cannot rewrite history, so only you can take it out of the branch; then message the seat to carry on.`;
/**
 * How to word text the hub posts to GitHub so it notifies no one: backticks hide nothing there,
 * so a package scope and another issue's number are written without their `@` and `#`.
 */
export const REFERENCE_ADVICE =
  "Write package names without the @ (mc/core, not @mc/core) and describe other issues in words, without # or links.";
/**
 * A message names something GitHub would notify or close (a closing keyword, another issue,
 * another repo's issue, a mention). The commit tool refuses it before committing, so the seat can
 * reword it.
 */
/** Why a named character reference outside the short allow-list refuses, and the way out. */
const NAMED_REF_ADVICE = "is an HTML character reference GitHub would turn into another character";
/** A commit message holds a named reference such as `&sol;`: the seat writes the character. */
export const commitNamedRefText = (ref: string): string =>
  `Not committed: ${ref} ${NAMED_REF_ADVICE}; write the character itself, then commit again.`;
export const commitReferenceText = (what: string): string =>
  `Not committed: the message would notify or close something on GitHub (${what}); reword it, then commit again. ${REFERENCE_ADVICE}`;
/**
 * The push's backstop for the same check, on a commit already made (before the commit tool checked
 * messages). The seat cannot rewrite a commit, so only the operator can reword it.
 */
export const pushReferenceText = (sha: string, what: string): string =>
  `Not pushed: commit ${sha.slice(0, 7)}'s message would notify or close something on GitHub (${what}). The seat cannot rewrite a commit, so only you can reword it; then message the seat to carry on.`;
/** The secret scan's log passed its output cap: nothing is pushed unread. */
export const MC_PUSH_TOO_BIG =
  "Not pushed: the new commits are too large for the secret scan to read, so nothing was pushed unread. Push them yourself if they are fine, then message the seat.";
/** git could not reach origin, or origin refused the push for a reason of its own. */
export const MC_PUSH_FAILED =
  "Not pushed: git could not push to origin. Check the connection and your GitHub access, then message the seat to try again.";
/** The secret scan's log and git's own diff output cap (64 MiB). */
export const PUSH_SCAN_MAX_BUFFER = 64 * 1024 * 1024;

// ---------- the draft PR ----------

export const MC_PR_TITLE_MAX = 200;
export const MC_PR_BODY_MAX = 20_000;
export const MC_PUSH_FIRST = "Push first: the PR shows what is on origin.";
export const prSecretText = (where: string, line: number, kind: string): string =>
  `Not opened: ${where}:${line} looks like a ${kind}. The PR is made from the ticket's title and the seat's evidence note: take it out of the ticket, or message the seat to report its evidence again without it.`;
/** PR text holds a named reference such as `&sol;`: the seat writes the character. */
export const prNamedRefText = (ref: string): string =>
  `Not opened: ${ref} ${NAMED_REF_ADVICE}. The PR is made from the ticket's title and the seat's evidence note: edit the ticket, or message the seat to report its evidence again with the character itself.`;
/** PR text names someone or another item; backticks, code blocks and HTML hide nothing. */
export const prNotifyText = (first: string): string =>
  `Not opened: mentions and references to other issues notify people, inside backticks too, and the PR would hold ${first}. The PR is made from the ticket's title and the seat's evidence note: edit the ticket, or message the seat to report its evidence again without it.`;
/** A body ending in an open code or HTML block would swallow the closing and signature lines. */
export const MC_PR_UNCLOSED =
  "Not opened: the PR body would end inside an unclosed code block or HTML block. Message the seat to report its evidence again with every block closed.";
export const prAlreadyOpenText = (url: string): string => `A PR is already open: ${url}`;
/** Added to a PR body that does not name the run's issue. */
export const prClosesLine = (issue: number): string => `Closes #${issue}.`;
/** The last line of every PR body the hub opens. */
export const prOpenedByLine = (call: string): string => `Opened by ${call} (Mission Control).`;
/** gh failed (or timed out) listing or opening the PR. */
export const MC_PR_FAILED =
  "Not opened: GitHub could not be reached through gh. Check the connection and your GitHub access, then message the seat to try again.";

// ---------- the plan ----------

/** The longest plan `report_plan` takes. */
export const MC_PLAN_MAX = 12_000;
/** The heading `report_plan` appends to the issue body. */
export const PLAN_HEADING = "## Plan";
/** The last line of every plan the hub writes into a ticket. */
export const planByLine = (call: string): string => `Planned by ${call} (Mission Control).`;
export const MC_PLAN_WRITTEN =
  "Written to the ticket under ## Plan. Mission Control ends this run now; stop.";
export const MC_PLAN_WRITTEN_CONTINUE =
  "Written to the ticket under ## Plan. Continue this build run now.";
export const MC_PLAN_NOT_FAO = "Not written: report_plan is for planner or build seats.";
export const MC_PLAN_PROFILE_ONLY =
  "Not written: profile and profile_reason are for planner seats.";
export const MC_PLAN_ALREADY =
  "Not written: the ticket already has a ## Plan section. Ask FLIGHT with mc ask_flight if it needs replacing.";
export const MC_PLAN_ISSUE_CLOSED = "Not written: the ticket is closed.";
export const MC_PLAN_BODY_UNCLOSED =
  "Not written: the ticket body ends inside an unclosed code or HTML block, which would swallow the plan. Ask FLIGHT with mc ask_flight to have it closed.";
export const planTooLongText = (max: number, room: number): string =>
  `Not written: the ticket and the plan together would pass ${max.toLocaleString("en-US")} characters, so the developer's brief would be cut. Shorten the plan to ${room.toLocaleString("en-US")} characters or fewer, then call mc report_plan again.`;
export const MC_PLAN_NO_ROOM =
  "Not written: the ticket is already too long for a plan to fit the developer's brief. Ask FLIGHT with mc ask_flight.";
export const planTextText = (what: string): string =>
  `Not written: the plan is posted to GitHub and must not notify anyone, reference another item or hold a secret (${what}); reword it, then call mc report_plan again. ${REFERENCE_ADVICE}`;
export const MC_PLAN_GH_FAILED =
  "Not written: GitHub could not be reached through gh. Try again in a minute; if it keeps failing, ask FLIGHT with mc ask_flight.";
export const planWrittenText = (ref: string): string => `plan written to ${ref}`;

/** The most missing paths a refusal lists. */
export const PLAN_PATHS_LISTED = 5;
export const MC_PLAN_NO_TESTS =
  "Not added: the plan has no ### Tests part; name the test to write first for each Done when item.";
export const planFewTestsText = (tests: number, doneWhen: number): string =>
  `Not added: the plan's ### Tests part has ${tests} ${tests === 1 ? "entry" : "entries"} but the ticket's ## Done when has ${doneWhen} ${doneWhen === 1 ? "item" : "items"}; name the test to write first, and the file it goes in, for each Done when item.`;
export const planMissingPathsText = (paths: readonly string[]): string =>
  `Not added: these paths are not in the checkout: ${paths.slice(0, PLAN_PATHS_LISTED).join(", ")}${paths.length > PLAN_PATHS_LISTED ? ` (and ${paths.length - PLAN_PATHS_LISTED} more)` : ""}. Fix them, or say the plan creates them.`;

/** A top-level list item: it starts at column 0 or 1, so nested detail lines are not counted. */
const LIST_ITEM = /^ {0,1}(?:[-*+]|\d+[.)])[ \t]+\S/;

/** The lines under the first heading `title` (at `level`), up to the next heading of that level or higher. */
function sectionLines(text: string, level: number, title: RegExp): string[] | null {
  const out: string[] = [];
  let inside = false;
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h = /^(#{1,6})[ \t]+(.*?)[ \t]*$/.exec(line);
    if (h !== null) {
      if (inside && (h[1] ?? "").length <= level) break;
      if (!inside && (h[1] ?? "").length === level && title.test(h[2] ?? "")) {
        inside = true;
        continue;
      }
    }
    if (inside) out.push(line);
  }
  return inside ? out : null;
}

/** How many bullets the ticket's `## Done when` holds. */
export function doneWhenCount(body: string): number {
  return (sectionLines(body, 2, /^done when$/i) ?? []).filter((l) => LIST_ITEM.test(l)).length;
}

/** How many entries the plan's `### Tests` part holds, or null when it has no such part. */
export function planTestCount(plan: string): number | null {
  const lines = sectionLines(plan, 3, /^tests$/i);
  return lines === null ? null : lines.filter((l) => LIST_ITEM.test(l)).length;
}

/** A plan path that leaves the checkout: absolute, `~`, or with a `..` segment (the `protected` glob rule). */
const unsafePlanPath = (p: string): boolean =>
  p.startsWith("/") || p.startsWith("~") || p.split("/").includes("..");

/** The inline-code paths of a plan outside fenced blocks, each with whether its line creates it. */
function planPathMentions(plan: string): { path: string; creates: boolean }[] {
  const out: { path: string; creates: boolean }[] = [];
  let fenced = false;
  for (const line of plan.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    for (const m of line.matchAll(/`([^`\s]+)`/g)) {
      const p = (m[1] ?? "").replace(/^\.\//, "").replace(/:\d+(?:-\d+)?$/, "");
      if (!/^[\w.@/~-]*\/[\w.@-]*\.[A-Za-z0-9]+$/.test(p)) continue;
      const before = line.slice(0, m.index);
      out.push({
        path: p,
        creates:
          /\b(?:creat(?:e|es|ed|ing)|new files?)[*_]*\s*:?[*_]*\s*(?:`[^`\s]+`\s*(?:(?:,|and|&)\s*)?)*$/i.test(
            before,
          ),
      });
    }
  }
  return out;
}

/**
 * The repo-relative paths a plan names in inline code (a `/` and a file ending), but those the same
 * line says it creates (`create <path>`, `new file <path>`) and those that leave the checkout.
 */
export function planPaths(plan: string): string[] {
  const mentions = planPathMentions(plan);
  // a path the plan creates on one line is not checked where a later line names it again
  const created = new Set(mentions.filter((m) => m.creates).map((m) => m.path));
  const found = mentions
    .filter((m) => !created.has(m.path) && !unsafePlanPath(m.path))
    .map((m) => m.path);
  return [...new Set(found)];
}

/** The paths a plan names that leave the checkout: absolute, starting `~`, or with a `..` segment. */
export function planUnsafePaths(plan: string): string[] {
  const found = planPathMentions(plan)
    .map((m) => m.path)
    .filter(unsafePlanPath);
  return [...new Set(found)];
}

export const planUnsafePathsText = (paths: readonly string[]): string =>
  `Not added: ${paths.slice(0, PLAN_PATHS_LISTED).join(", ")}${paths.length > PLAN_PATHS_LISTED ? ` (and ${paths.length - PLAN_PATHS_LISTED} more)` : ""} ${isAre(paths)} outside the checkout (absolute, starting ~, or with ..). Name paths relative to the repo root.`;

export const MC_PR_BODY_REFUSED =
  "Not edited: the new PR body would notify someone, reference another item, hold a secret or end inside an open block.";
export const prNotRunsText = (n: number): string =>
  `Not edited: PR #${n} is not this run's open PR.`;
export const MC_PR_EDIT_FAILED =
  "Not edited: GitHub could not be reached through gh. Mission Control tries again on its next pass.";
export const prEditedText = (n: number): string => `Edited PR #${n}.`;
