import { useBuildStatus } from "./overlays.ts";

/**
 * How buildable each panel is today (catalogue §4, verbatim). `proven`: tested against the real
 * thing; `build`: standard work; `later`: waits on an engine not built yet; `check`: a small test
 * before relying on it. `panel` is the mockup's element id (`setup-{tab}` for a Setup tab,
 * `boardToolbar` for the Board's toolbar); the chip label varies per row and the note is its tooltip.
 */
export type BuildClass = "proven" | "build" | "later" | "check";

export interface BuildNote {
  panel: string;
  cls: BuildClass;
  label: string;
  note: string;
}

export const BUILD_NOTES: BuildNote[] = [
  {
    panel: "agentsP",
    cls: "proven",
    label: "Proven",
    note: "State, live tool and timer, tokens, context and quota come from events P1a already maps (spike and P1a tests).",
  },
  {
    panel: "agentsP",
    cls: "later",
    label: "Loop step: P2",
    note: "The loop-step column needs the loop engine.",
  },
  {
    panel: "agentsP",
    cls: "build",
    label: "~cost",
    note: "Claude cost is the difference between run totals (P1a). Codex sends no cost, so a price table gives an estimate.",
  },
  {
    panel: "actP",
    cls: "proven",
    label: "Proven",
    note: "Every row is an event the P1a store already keeps.",
  },
  {
    panel: "actP",
    cls: "later",
    label: "Steps: P2",
    note: "Step and check rows arrive with the loop engine. The current test-lock holder and queue show in the lock box and on Telemetry.",
  },
  {
    panel: "machP",
    cls: "build",
    label: "Buildable",
    note: "CPU, memory and disk from Node (os, fs.statfs); per-process memory from ps on the Mac.",
  },
  {
    panel: "machP",
    cls: "proven",
    label: "Test lock",
    note: "Live: agents' full suites take the test lock one at a time; one in the background is refused with a hint to run it in the foreground, and one still waiting after 10 minutes is refused with a hint to run a single test file.",
  },
  {
    panel: "quotaP",
    cls: "proven",
    label: "Proven",
    note: "Claude rate-limit events and Codex account rate limits are both mapped in P1a.",
  },
  {
    panel: "quotaP",
    cls: "build",
    label: "7-day",
    note: "The Claude adapter keeps one window per event; it must keep every window for the 7-day one to show.",
  },
  {
    panel: "quotaP",
    cls: "build",
    label: "Estimates",
    note: '"Full in ~3h" is our projection. Claude figures only update while a Claude agent runs; a richer Claude usage report exists but is marked experimental.',
  },
  {
    panel: "sitP",
    cls: "later",
    label: "P2",
    note: "FLIGHT writes the summary from the store whenever something changes.",
  },
  {
    panel: "askP",
    cls: "proven",
    label: "GitHub",
    note: "Mentions, review requests and comments come from your GitHub notifications (checked 16 Oct); each points at the comment, whose html_url and body give the link and the snippet.",
  },
  {
    panel: "askP",
    cls: "check",
    label: "Teams",
    note: "A Teams message carries its webUrl and a mentions list. Reading works (9 Oct); unattended polling needs the token check.",
  },
  {
    panel: "askP",
    cls: "later",
    label: "Take: P2",
    note: "FLIGHT's assessment and suggested replies need FLIGHT.",
  },
  {
    panel: "askP",
    cls: "build",
    label: "Catch-up",
    note: "New or follow-up comes from the store and the source's own history (GitHub timeline, Teams thread); the story and what to be aware of are FLIGHT's summary.",
  },
  {
    panel: "wifP",
    cls: "later",
    label: "P2",
    note: "Built from loop run records: step, try, outcome, tokens, time.",
  },
  {
    panel: "incP",
    cls: "proven",
    label: "GitHub",
    note: "Your notifications read through gh on 16 Oct: assign, mention, review_requested, comment, ci_activity, state_change.",
  },
  {
    panel: "incP",
    cls: "check",
    label: "Teams",
    note: "Reading chats and channels worked on 9 Oct. Polling unattended needs a refresh token that lasts days; AP's Entra sign-in rules decide that.",
  },
  {
    panel: "incP",
    cls: "later",
    label: "Triage: P2",
    note: "What FLIGHT did with each item needs FLIGHT.",
  },
  {
    panel: "watchP",
    cls: "later",
    label: "P2",
    note: "A list FLIGHT keeps, with next-check times Mission Control runs.",
  },
  {
    panel: "watchP",
    cls: "proven",
    label: "Signals",
    note: "Time in a Status (field updatedAt) and PR ready/review/merge times read from GitHub on 16 Oct.",
  },
  {
    panel: "watchP",
    cls: "build",
    label: "Judgement",
    note: "Linking a Teams report to a ticket is FLIGHT's judgement: best effort, improved over time.",
  },
  {
    panel: "draftsP",
    cls: "build",
    label: "Buildable",
    note: "FLIGHT writes drafts. Post uses gh, with your click as the approval. Teams is copy only: the app has read scopes by design.",
  },
  {
    panel: "decidedP",
    cls: "later",
    label: "P2",
    note: "FLIGHT answers ask_flight questions and records its basis; Overturn messages the agent.",
  },
  {
    panel: "decidedP",
    cls: "build",
    label: "Quality",
    note: "How often FLIGHT gets it right is tuning, not a blocker; the escalation rules and Overturn are the safety net.",
  },
  {
    panel: "boardToolbar",
    cls: "proven",
    label: "Proven",
    note: "The delivery board's Status, Priority, Size and board order read through GraphQL on 16 Oct.",
  },
  {
    panel: "boardToolbar",
    cls: "build",
    label: "Overlay",
    note: "The agent, PR and CI line comes from Mission Control and gh.",
  },
  {
    panel: "boardToolbar",
    cls: "check",
    label: "GitHub link",
    note: "The filterQuery parameter on the board link is unverified; worst case the link opens the board unfiltered.",
  },
  {
    panel: "ahead",
    cls: "proven",
    label: "Proven",
    note: "Context %, tokens, cost, time to first token and quota are mapped in P1a.",
  },
  {
    panel: "ahead",
    cls: "check",
    label: "Context split",
    note: "Claude's getContextUsage is documented but untested here; Codex only reports a total.",
  },
  {
    panel: "streamP",
    cls: "proven",
    label: "Proven",
    note: "Messages, thinking summaries and tool calls (spike). Messages mid-turn: Claude folds them in, Codex steers; both spiked. Haiku ignored mid-turn notes, hence Interrupt and send.",
  },
  {
    panel: "loopP",
    cls: "later",
    label: "P2",
    note: "Steps, tries, tokens and time come from loop run records.",
  },
  {
    panel: "sideP",
    cls: "check",
    label: "Plan",
    note: "Claude's task tools need an opt-in on newer models and are untested; Codex plan updates are in its schema but not yet seen.",
  },
  {
    panel: "sideP",
    cls: "build",
    label: "Subagents",
    note: "The spike saw the task frames, and the SDK types give each a token total; P1a needs to map them.",
  },
  { panel: "sideP", cls: "build", label: "Files", note: "git diff from Mission Control." },
  {
    panel: "sideP",
    cls: "later",
    label: "Queue: P2",
    note: "Queues come from FLIGHT and the board.",
  },
  {
    panel: "cNeedsP",
    cls: "build",
    label: "Buildable",
    note: "Built from stored items; decisions and approvals need FLIGHT (P2).",
  },
  {
    panel: "cThreadsP",
    cls: "later",
    label: "P2",
    note: "send_message worked in the spike; threads need the mailbox. @CAPCOM is a prompt convention Mission Control parses.",
  },
  {
    panel: "dock",
    cls: "later",
    label: "P2",
    note: "FLIGHT itself, with structured decision briefs.",
  },
  {
    panel: "discuss",
    cls: "later",
    label: "P2",
    note: "FLIGHT's ask_operator call carries the brief: question, why, sources checked, options, recommendation.",
  },
  {
    panel: "awayBody",
    cls: "build",
    label: "Buildable",
    note: "Safe-ticket rules, gh pr ready, labels and review requests are standard.",
  },
  {
    panel: "awayBody",
    cls: "check",
    label: "AP on the Mac",
    note: "Proving a test fails on the base commit, the full suite and the reviewer's browser check all need the AP stack running on the Mac.",
  },
  { panel: "tThru", cls: "proven", label: "Proven", note: "Merged PRs from GitHub." },
  {
    panel: "tCycle",
    cls: "proven",
    label: "Proven",
    note: "Each issue's timeline records every Status change with the old and new value (checked 16 Oct).",
  },
  {
    panel: "tQual",
    cls: "proven",
    label: "Review wait",
    note: "Ready-for-review, review and merge events read from GitHub on 16 Oct.",
  },
  {
    panel: "tQual",
    cls: "later",
    label: "Verify: P2",
    note: "First-pass rate and fix rounds come from loop records.",
  },
  {
    panel: "tCapcom",
    cls: "build",
    label: "Buildable",
    note: "When each ask was raised and answered, from the store.",
  },
  { panel: "tTok", cls: "proven", label: "Proven", note: "Usage events per agent." },
  {
    panel: "tUtil",
    cls: "build",
    label: "Buildable",
    note: "Time in each state, from state events.",
  },
  { panel: "tTurn", cls: "proven", label: "Proven", note: "Per-turn usage (P1a)." },
  { panel: "tLat", cls: "proven", label: "Proven", note: "Tool durations (P1a)." },
  {
    panel: "tSubs",
    cls: "build",
    label: "Buildable",
    note: "Task frames with token totals (spike); not mapped yet.",
  },
  { panel: "tQuota", cls: "proven", label: "Proven", note: "Quota events are stored." },
  { panel: "tMach", cls: "build", label: "Buildable", note: "Sampled by mc-server." },
  {
    panel: "tLock",
    cls: "build",
    label: "Buildable",
    note: "Lock runs recorded by Mission Control.",
  },
  {
    panel: "tTicketBars",
    cls: "later",
    label: "P2/P3",
    note: "Usage keyed by ticket and step once loops and the board exist.",
  },
  { panel: "tStepBars", cls: "later", label: "P2", note: "Usage keyed by loop step." },
  { panel: "tTotals", cls: "proven", label: "Proven", note: "Usage totals per agent." },
  {
    panel: "setup-sessions",
    cls: "proven",
    label: "Proven",
    note: "Sessions and areas are built in P1a, with tests; crew agents each work in their own checkout and commit, push and open draft PRs through Mission Control; stray changes are refused at commit and shown in Needs you.",
  },
  {
    panel: "setup-repos",
    cls: "build",
    label: "Buildable",
    note: "Repos are read from config.yaml and the stored boards. Adding one reads the GitHub project, then writes config.yaml with a backup; nothing is written to GitHub.",
  },
  {
    panel: "setup-loops",
    cls: "later",
    label: "P2",
    note: "Loop templates are YAML read by the loop engine.",
  },
  { panel: "setup-accounts", cls: "proven", label: "Proven", note: "Profiles and logins are P1a." },
  {
    panel: "setup-roles",
    cls: "proven",
    label: "Proven",
    note: "Guard rules and the test lock are live; the guard drawer on Comms lists each block.",
  },
  {
    panel: "setup-sources",
    cls: "check",
    label: "Teams token",
    note: "GitHub is proven; Teams needs the refresh-token check.",
  },
  {
    panel: "setup-access",
    cls: "check",
    label: "Tailscale",
    note: "Needs IT to allow Tailscale on the work laptop; otherwise notifications go to your phone.",
  },
];

/**
 * Panels whose chips sit somewhere other than the panel header, placed by the page itself: the
 * Board toolbar, the Agent header's ID row, each Setup tab's toolbar, and the dock, Item panel and
 * Away modal (which are not `Panel`s).
 */
export const OWN_CHIPS: ReadonlySet<string> = new Set(
  BUILD_NOTES.map((n) => n.panel).filter(
    (p) =>
      p === "boardToolbar" ||
      p === "ahead" ||
      p === "dock" ||
      p === "discuss" ||
      p === "awayBody" ||
      p.startsWith("setup-"),
  ),
);

/** The chips for `panel` while "Show build status" is on; nothing otherwise. */
export function BuildChips({ panel }: { panel: string }) {
  const [on] = useBuildStatus();
  if (!on) return null;
  return BUILD_NOTES.filter((n) => n.panel === panel).map((n) => (
    <span key={`${n.label}|${n.note}`} className={`bs bs-${n.cls}`} title={n.note}>
      {n.label}
    </span>
  ));
}
