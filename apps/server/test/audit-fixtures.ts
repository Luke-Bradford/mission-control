import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditReportFinding, BoardItem, Run } from "@mc/core";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

export const NOW = Date.parse("2026-11-22T12:00:00Z");
export const HOUR = 3_600_000;

/** A session with FLIGHT, four build seats and an AUDIT seat. */
export const auditConfig = (over: Partial<CcConfig> = {}): CcConfig => ({
  operator: { id: "op", timezone: "Europe/London" },
  accounts: [{ id: "main", vendor: "claude", alertAt: 80, stopAt: 95 }],
  repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/none",
    maxSeats: 8,
    sessions: [
      {
        id: "s1",
        repoId: "mc",
        checkout: "/tmp/none/clone",
        seats: [
          { id: "flight-1", role: "FLIGHT", accountId: "main", model: "opus", area: [] },
          ...[1, 2, 3, 4].map((n) => ({
            id: `guido-${n}`,
            role: "GUIDO",
            accountId: "main",
            model: "sonnet",
            area: [],
          })),
          { id: "audit-1", role: "AUDIT", accountId: "main", model: "opus", area: [] },
        ],
      },
    ],
  },
  ...over,
});

export const newStore = (): Store =>
  new Store(join(mkdtempSync(join(tmpdir(), "audit-")), "mc.sqlite"));

export const finding = (
  rank: number,
  over: Partial<AuditReportFinding> = {},
): AuditReportFinding => ({
  rank,
  area: "flow",
  problem: `problem ${rank}`,
  evidence: "numbers",
  cause: "cause",
  links: [],
  owner: "flight",
  ...over,
});

export const runRow = (id: string, agentId: string, over: Partial<Run> = {}): Run => ({
  id,
  agentId,
  repoId: "mc",
  seq: 1,
  startedAt: NOW - 60_000,
  endedAt: null,
  status: "running",
  sessionId: null,
  model: "opus",
  branch: null,
  ticket: null,
  costUsd: null,
  tokens: null,
  transcriptPath: "/x",
  prs: [],
  summary: null,
  ...over,
});

export const card = (n: number, status: string, createdAt: number): BoardItem => ({
  repoId: "mc",
  issueNumber: n,
  title: `Ticket ${n}`,
  status,
  state: "planned",
  labels: [],
  assignees: [],
  priority: null,
  updatedAt: NOW,
  url: "",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: null,
  closed: false,
  prioritySource: null,
  createdAt,
  itemId: null,
  projectId: null,
});
