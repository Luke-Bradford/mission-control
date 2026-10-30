/**
 * The routes a HUD page asks for on arrival, as pure path builders: the web's resource refs and the
 * server's page-load budget test (`apps/server/test/response-budget.test.ts`) both build from
 * these, so what the budget measures is what a page requests. Forms and limits are in
 * `docs/hud-response-budgets.md`.
 */

/** The FLIGHT dock's first load of its stream; older events page in with `before`. */
export const DOCK_STREAM_LIMIT = 20;

const enc = encodeURIComponent;

/** The Overview's and Board's crew read, and Comms' nav: summary rows. */
export const crewSummaryPath = (): string => "/api/crew?shape=summary";
/** The Agent page's crew row, in full. */
export const crewDetailPath = (id: string): string => `/api/crew/${enc(id)}`;
/** A repo's PR list as a page lists it (`linked`: only those on a ticket, for the Board). */
export const prListPath = (repoId: string, linked = false): string =>
  `/api/repos/${enc(repoId)}/prs?${linked ? "linked=1&" : ""}shape=summary`;
/** A Comms nav row: the conversation list and counts, no messages. */
export const commsNavPath = (agentId: string): string =>
  `/api/comms/agents/${enc(agentId)}?summary=1`;
/** The selected agent's conversations: its newest messages, older ones by `before`. */
export const commsAgentPath = (agentId: string): string => `/api/comms/agents/${enc(agentId)}`;
/** The FLIGHT dock's stream, and an agent page's, as first loaded. */
export const dockStreamPath = (agentId: string): string =>
  `/api/agents/${enc(agentId)}/stream?limit=${DOCK_STREAM_LIMIT}`;

export interface FirstLoadContext {
  repoIds: readonly string[];
  /** Every crew seat, in config order. */
  seatIds: readonly string[];
  flightId: string;
  /** The seat the Agent page shows. */
  agentId: string;
}

/** What each page requests on arrival (the pages' other, small reads are not listed). */
export function firstLoadPaths(page: string, c: FirstLoadContext): string[] {
  const repo = c.repoIds[0] ?? "";
  switch (page) {
    case "Overview":
      return [
        crewSummaryPath(),
        ...c.repoIds.map((r) => prListPath(r)),
        dockStreamPath(c.flightId),
        "/api/flight",
        "/api/activity",
        "/api/overview",
      ];
    case "Comms":
      return [
        ...c.seatIds.map(commsNavPath),
        commsAgentPath(c.agentId),
        "/api/comms/crew",
        "/api/comms/flight",
        crewSummaryPath(),
      ];
    case "Board":
      return [
        ...c.repoIds.map((r) => prListPath(r, true)),
        crewSummaryPath(),
        `/api/boards/${enc(repo)}`,
      ];
    case "Audit":
      return ["/api/audit?range=30d"];
    case "Agent":
      return [
        prListPath(repo),
        `/api/agents/${enc(c.agentId)}/runs`,
        "/api/activity",
        dockStreamPath(c.agentId),
        crewDetailPath(c.agentId),
      ];
    default:
      throw new Error(`unknown page ${page}`);
  }
}

export const FIRST_LOAD_PAGES = ["Overview", "Comms", "Board", "Audit", "Agent"] as const;
