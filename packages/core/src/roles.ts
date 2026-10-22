/** Call signs from the Apollo control room (catalogue §0), shown in Setup › Roles. */
export interface RoleRow {
  callSign: string;
  position: string;
  here: string;
  /** null for CAPCOM, who is the operator. */
  mode: "read-only" | "writer" | null;
}

export const ROLES: readonly RoleRow[] = [
  {
    callSign: "CAPCOM",
    position: "Capsule Communicator, the one voice to the crew",
    here: "you: decisions, approvals and anything tagged @CAPCOM",
    mode: null,
  },
  {
    callSign: "FLIGHT",
    position: "Flight Director",
    here: "head agent: assigns, unblocks, brings you decisions",
    mode: "read-only",
  },
  {
    callSign: "FIDO",
    position: "Flight Dynamics Officer",
    here: "architect: plans changes across areas",
    mode: "read-only",
  },
  {
    callSign: "GUIDO",
    position: "Guidance Officer",
    here: "backend developer, test-first in its area",
    mode: "writer",
  },
  {
    callSign: "INCO",
    position: "Instrumentation and Communications",
    here: "frontend developer",
    mode: "writer",
  },
  {
    callSign: "BOOSTER",
    position: "Booster Systems Engineer",
    here: "devops: CI, builds and releases",
    mode: "writer",
  },
  {
    callSign: "SURGEON",
    position: "Flight Surgeon",
    here: "QA: writes and runs tests",
    mode: "writer",
  },
  {
    callSign: "RETRO",
    position: "Retrofire Officer",
    here: "reviewer: findings with file and line",
    mode: "read-only",
  },
  {
    callSign: "NETWORK",
    position: "Network Controller",
    here: "researcher: code, docs, the web and Teams",
    mode: "read-only",
  },
  {
    callSign: "FAO",
    position: "Flight Activities Officer",
    here: "planner: writes each ticket's plan for the developers",
    mode: "read-only",
  },
];
