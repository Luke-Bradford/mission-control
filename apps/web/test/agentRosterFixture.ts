import { type CrewRow, crewRowSummary, type OverviewTimeline } from "@mc/core";
import { agentView } from "./agentV2Fixture.ts";
import { CONFIG, crewRow, MIN, NOW } from "./fixtures.ts";

const TITLES = [
  "Agents page, slice 1a: the roster of every seat and choosing a seat",
  "Server module split, slice 20: the run supervisor",
  "Fix the dependencies page when a ticket has no parent",
];
const KINDS = [
  { role: "FLIGHT", mode: "read-only", stem: "flight" },
  { role: "FAO", mode: "read-only", stem: "fao" },
  { role: "GUIDO", mode: "writer", stem: "guido" },
  { role: "INCO", mode: "writer", stem: "inco" },
  { role: "RETRO", mode: "read-only", stem: "retro" },
] as const;

/** `count` crew seats over `repos`, a mix of working, waiting and free, with long tickets. */
export function rosterRows(count: number, repos: readonly string[] = ["mission-control"]) {
  const rows: CrewRow[] = [];
  for (let i = 0; i < count; i++) {
    const kind = KINDS[i % KINDS.length] as (typeof KINDS)[number];
    const repoId = repos[i % repos.length] as string;
    const free = i % 3 === 2 && kind.role !== "FLIGHT";
    rows.push(
      crewRow({
        id: `${kind.stem}-${i + 1}`,
        repoId,
        index: i,
        kind: "crew",
        loopKind: "crew",
        role: kind.role,
        mode: kind.mode,
        sessionId: `s-${repoId}`,
        hudState: free ? "idle" : i % 3 === 1 ? "waiting" : "running",
        stateSince: NOW - (i + 1) * 7 * MIN,
        run: free ? null : crewRow().run,
        ticket: free ? null : `${repoId}#${1700 + i}`,
        ticketTitle: free ? null : TITLES[i % TITLES.length],
        digest: free
          ? null
          : {
              ...(crewRow().digest ?? {
                toolCalls: 3,
                turns: 2,
                lastEventAt: NOW,
                model: null,
                contextTokens: null,
                contextWindow: null,
                liveTool: null,
                tools: {},
                subagents: [],
                minuteTokens: [],
                turnUsage: [],
                background: [],
                compactions: 0,
              }),
              contextTokens: 40_000 + i * 11_000,
              contextWindow: 200_000,
            },
        contextWindow: 200_000,
      }),
    );
  }
  return rows;
}

/** Each working seat's last hour, as `/api/overview/timeline` serves it. */
export function rosterTimeline(rows: CrewRow[]): OverviewTimeline {
  return {
    from: NOW - 60 * MIN,
    to: NOW,
    lanes: rows
      .filter((r) => r.run !== null)
      .map((r) => ({
        agentId: r.id,
        spans: [
          { kind: "turn", from: NOW - 50 * MIN, to: NOW - 40 * MIN },
          { kind: "checks", from: NOW - 12 * MIN, to: NOW - 9 * MIN },
        ],
        ticks: [NOW - 45 * MIN, NOW - 20 * MIN, NOW - 3 * MIN],
      })),
  };
}

/** The API answers the real shell needs to show `rows` and open any of their pages. */
export function rosterApi(rows: CrewRow[]) {
  const api: Record<string, unknown> = {
    "/api/config": CONFIG,
    "/api/crew?shape=summary": { rows: rows.map(crewRowSummary), firstRunToday: null },
    "/api/overview/timeline": rosterTimeline(rows),
    "/api/attention": [],
  };
  for (const r of rows) {
    api[`/api/agents/${r.id}`] = agentView(r);
    api[`/api/agents/${r.id}/stream?limit=20`] = {
      runId: null,
      events: [],
      tasks: [],
      truncated: false,
      more: false,
    };
  }
  return api;
}
