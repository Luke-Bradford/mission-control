import type { TokenAuditView } from "@mc/core";

/** A week of token audit as the hub sends it: fictional runs, roles and commands. */
export function tokenAuditFixture(over: Partial<TokenAuditView> = {}): TokenAuditView {
  const named = (rows: [string, number, number][]) => {
    const total = rows.reduce((s, r) => s + r[2], 0);
    return rows.map(([name, added, reread]) => ({
      name,
      added,
      reread,
      events: Math.round(added / 1500),
      share: reread / total,
    }));
  };
  return {
    days: 7,
    since: 0,
    runs: 412,
    calls: 31_850,
    output: 2_400_000,
    cacheRead: 2_706_000_000,
    cacheWrite: 61_000_000,
    reread: 2_100_000_000,
    rewrites: 64,
    readAfterReportShare: 0.62,
    byRole: [
      ["developer", 117, 80, 330_000_000, 31, 121_000],
      ["flight", 111, 40, 836_000_000, 12, 117_000],
      ["reviewer", 278, 22, 410_000_000, 8, 94_000],
      ["planner", 11, 60, 90_000_000, 2, 88_000],
    ].map(([role, runs, calls, reread, rewrites, peak]) => ({
      role: role as string,
      runs: runs as number,
      calls: (runs as number) * (calls as number),
      output: 400_000,
      cacheRead: (reread as number) * 1.2,
      cacheWrite: 9_000_000,
      reread: reread as number,
      rewrites: rewrites as number,
      medianPeakContext: peak as number,
    })),
    bySource: named([
      ["Bash", 40_000_000, 1_150_000_000],
      ["start of run", 12_000_000, 420_000_000],
      ["own earlier output", 9_000_000, 210_000_000],
      ["Read", 3_000_000, 110_000_000],
      ["hub line", 2_000_000, 80_000_000],
      ["Grep", 1_000_000, 40_000_000],
    ]),
    byCommand: named([
      ["sed", 18_000_000, 380_000_000],
      ["grep", 9_000_000, 230_000_000],
      ["pnpm lint", 5_000_000, 150_000_000],
      ["cat", 4_000_000, 100_000_000],
      ["python3", 3_000_000, 90_000_000],
    ]),
    topRuns: [
      {
        runId: "run-4821",
        agentId: "inco-1",
        role: "developer",
        calls: 310,
        peakContext: 317_000,
        medianContext: 190_000,
        output: 120_000,
        reread: 61_000_000,
        rewrites: 3,
        readAfterReportShare: 0.71,
        costUsd: 14.2,
      },
      {
        runId: "run-4790",
        agentId: "flight-1",
        role: "flight",
        calls: 88,
        peakContext: 150_000,
        medianContext: 118_000,
        output: 30_000,
        reread: 12_000_000,
        rewrites: 1,
        readAfterReportShare: null,
        costUsd: null,
      },
    ],
    hubSections: [
      { section: "role", tokens: 180_000 },
      { section: "orders", tokens: 90_000 },
    ] as TokenAuditView["hubSections"],
    flightStart: { usd: 357, totalUsd: 701, share: 0.51 },
    controller: null,
    ...over,
  };
}
