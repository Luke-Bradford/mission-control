import type { AgentDetailView, CrewRow } from "@mc/core";
import { crewRow } from "./fixtures.ts";

/** A route response fixture; the server's subject joins have their own DB-backed tests. */
export function agentView(row: CrewRow = crewRow()): AgentDetailView {
  return {
    row,
    awaiting: {
      label: row.hudState[0]?.toUpperCase() + row.hudState.slice(1),
      reason: row.note,
      since: row.stateSince,
    },
    health: { label: "Running", blocking: null, failedTools: row.digest ? 0 : null },
    tools: { total: row.digest?.toolCalls ?? null, failed: row.digest ? 0 : null, byTool: [] },
    cost: {
      totalUsd: row.run?.costUsd ?? null,
      meanPerReportedTurnUsd: null,
      turns: row.digest?.turns ?? null,
      estimated: false,
    },
    context: {
      tokens: row.digest?.contextTokens ?? null,
      window: row.contextWindow,
      percent: null,
      compactions: row.digest?.compactions ?? null,
      prompt: null,
    },
    story: {
      title: row.ticketTitle,
      ticketHref: row.ticket ? `/tickets/${row.repoId}/${row.ticket.split("#").at(-1)}` : null,
      original: [],
      report: row.summary,
      reportedAt: null,
      doneWhen: [],
      left: [],
    },
    nextMove: null,
    deliverables: [],
    related: [],
    steps: [],
  };
}

export function populatedAgentView(): AgentDetailView {
  const row = crewRow({
    id: "guido-1",
    kind: "crew",
    role: "GUIDO",
    mode: "writer",
    sessionId: "s1",
    hudState: "idle",
    loop: {
      phase: "parked",
      text: "Review findings remain",
      prNumber: 77,
      parked: "One keyboard check remains",
      profile: "feature",
    },
  });
  const view = agentView(row);
  view.awaiting = {
    label: "Parked",
    reason: "Review round 2 of 3: one keyboard check remains",
    since: row.stateSince,
  };
  view.health = { label: "Review findings", blocking: 1, failedTools: 1 };
  view.tools = {
    total: 37,
    failed: 1,
    byTool: [
      { name: "Read", calls: 20, failed: 0 },
      { name: "Bash", calls: 12, failed: 1 },
      { name: "Edit", calls: 5, failed: 0 },
    ],
  };
  view.cost = { totalUsd: 2.4, meanPerReportedTurnUsd: 0.12, turns: 20, estimated: true };
  view.context = { tokens: 104000, window: 200000, percent: 52, compactions: 2, prompt: null };
  view.story = {
    ...view.story,
    original: [
      { line: 1, text: "Make the Agent page answer what it awaits and what happens next." },
    ],
    report: "The new page is implemented. The keyboard check remains.",
    reportedAt: row.stateSince,
    doneWhen: [
      {
        line: 1,
        text: "Keyboard navigation",
        status: "not_met",
        evidence: "Check the More menu after review.",
      },
    ],
    left: ["Check the More menu after review."],
  };
  view.nextMove = {
    owner: "controller",
    text: "Complete the keyboard check and request a fresh whole-branch review.",
    recommendation: "Run the focused browser check first.",
    label: "Open conversation",
    href: "/comms/crew",
  };
  view.steps = ["plan", "go/no-go", "build", "checks", "review", "draft PR"].map(
    (label, index) => ({
      id: label,
      label,
      state: index < 4 ? "done" : index === 4 ? "held" : "unknown",
      tries: index === 4 ? 2 : null,
      failures: index === 3 ? 1 : null,
      limit: index === 3 || index === 4 ? 3 : null,
      durationMs: index < 4 ? 60000 : null,
      since: null,
      reason: index === 4 ? "Keyboard check remains" : null,
    }),
  );
  view.deliverables = [
    {
      id: "pr:77",
      kind: "pr",
      label: "PR #77 · Agent page v2",
      href: "https://github.com/o/repo/pull/77",
    },
    {
      id: "shot:77",
      kind: "screenshot",
      label: "Agent · dark · after",
      href: "/api/prs/77/evidence/head/agent-dark-after.png",
    },
    {
      id: "file:77",
      kind: "file",
      label: "apps/web/src/pages/Agent.tsx",
      href: "https://github.com/o/repo/blob/head/apps/web/src/pages/Agent.tsx",
    },
  ];
  view.related = [
    {
      id: "review:1",
      kind: "review",
      title: "RETRO-1 · round 2",
      status: "reported",
      href: null,
      detail: "1 blocking · 0 minor",
    },
    {
      id: "sub:1",
      kind: "subagent",
      title: "Explore · locate the keyboard handlers",
      status: "completed",
      href: null,
      detail: "12 tool calls",
    },
  ];
  return view;
}
