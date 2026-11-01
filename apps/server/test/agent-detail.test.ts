import { type CrewRow, NEW_LOOP, type Run, type RunDigest, type RunLoopView } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { crewRow, item, NOW, prView, seatRow } from "../../web/test/fixtures.ts";
import { agentDetail } from "../src/agent-detail.ts";
import { Store } from "../src/store.ts";

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());
function save(row: CrewRow): Run {
  const r: Run = {
    id: row.run?.id ?? "run",
    agentId: row.id,
    repoId: row.repoId,
    seq: 1,
    startedAt: NOW - 600_000,
    endedAt: null,
    status: "running",
    sessionId: null,
    model: "sonnet",
    branch: row.run?.branch ?? "feature/7",
    ticket: row.ticket,
    costUsd: row.run?.costUsd ?? null,
    tokens: row.run?.tokens ?? null,
    transcriptPath: "",
    prs: [],
    summary: null,
    loop: NEW_LOOP,
  };
  store.upsertRun(r);
  return r;
}
const view = (
  row: CrewRow,
  loop: RunLoopView | null = null,
  items: Parameters<typeof agentDetail>[0]["items"] = [],
) => agentDetail({ row, store, loop, items, github: () => "o/shop-app" });
it.each([
  ["waiting", "permission prompt", "Waiting"],
  ["stopped", "Interrupted by CAPCOM", "Stopped"],
  ["error", "CLI exited", "Error"],
  ["idle", null, "Idle"],
] as const)("names %s and its saved reason", (hudState, note, label) => {
  const row = seatRow({ hudState, note, loop: null });
  save(row);
  expect(view(row).awaiting).toMatchObject({ label, reason: note });
});
it("keeps a stopped operator reason and an acknowledged but still open decision", () => {
  const row = seatRow({ hudState: "stopped", note: null });
  const r = save(row);
  store.setSeatSession({
    seatId: row.id,
    runId: r.id,
    cliSessionId: null,
    vendor: "claude",
    state: "stopped",
    reason: "Stopped",
    worktree: "/unused",
    updatedAt: NOW,
    stop: { by: "CAPCOM", reason: "Wait for acceptance", at: NOW },
  });
  const detail = view(row, null, [
    item({ agentId: row.id, owner: "operator", acked: true, text: "Acceptance is pending" }),
  ]);
  expect(detail.awaiting.reason).toBe("Wait for acceptance");
  expect(detail.nextMove?.owner).toBe("operator");
  expect(detail.nextMove?.text).toBe("Acceptance is pending");
});
it("shows every configured step, review tries/cap and the actual held phase", () => {
  const row = seatRow({
    hudState: "idle",
    loop: {
      phase: "parked",
      text: "Held",
      prNumber: 7,
      parked: "Findings remain",
      steps: [
        { name: "plan", phase: null },
        { name: "Build", phase: "working" },
        { name: "Checks", phase: "ci" },
        { name: "Review", phase: "review" },
        { name: "Done", phase: null },
      ],
      planned: true,
    },
  });
  const r = save(row);
  const loop: RunLoopView = {
    runId: r.id,
    loop: {
      ...NEW_LOOP,
      phase: "parked",
      parked: { kind: "review", reason: "Findings remain", ended: false },
    },
    events: [],
    tries: [
      {
        step: "review",
        fix: false,
        n: 3,
        startedAt: NOW - 300_000,
        endedAt: NOW - 100_000,
        outcome: "parked",
        reason: "Findings remain",
      },
    ],
    round: 3,
    budget: null,
    review: null,
    limits: { tries: 3, rounds: 3 },
  };
  const detail = view(row, loop);
  expect(detail.awaiting.reason).toContain("Review round 3 of 3");
  expect(detail.steps.map((s) => s.label)).toEqual(["plan", "Build", "Checks", "Review", "Done"]);
  expect(detail.steps[3]).toMatchObject({
    state: "held",
    tries: 3,
    limit: 3,
    since: NOW - 300_000,
  });
  expect(detail.steps[0]?.state).toBe("done");
});
it("preserves unknowns and distinguishes a zero cost from a missing one", () => {
  const row = seatRow({
    digest: null,
    run: { ...(crewRow().run as NonNullable<CrewRow["run"]>), costUsd: null, tokens: null },
  });
  save(row);
  const unknown = view(row);
  expect(unknown.tools.total).toBeNull();
  expect(unknown.cost.meanPerReportedTurnUsd).toBeNull();
  expect(unknown.context.percent).toBeNull();
  const digest = sampleDigest();
  const zero = seatRow({
    digest: { ...digest, turns: 2 },
    run: { ...(row.run as NonNullable<CrewRow["run"]>), costUsd: 0 },
  });
  expect(view(zero).cost.meanPerReportedTurnUsd).toBe(0);
});
it("uses the same recorded-call scope for totals, the tool breakdown and failures", () => {
  const digest = sampleDigest();
  const row = seatRow({
    digest: {
      ...digest,
      toolCalls: 2,
      tools: {
        Read: { calls: 3, failed: 0, durationsMs: [] },
        Bash: { calls: 4, failed: 1, durationsMs: [] },
      },
    },
  });
  save(row);
  const detail = view(row);
  expect(detail.tools.total).toBe(7);
  expect(detail.tools.failed).toBe(1);
  expect(detail.tools.byTool.map((t) => t.name)).toEqual(["Bash", "Read"]);
});
it("keeps reported acceptance answers separate from the original ask and redacts the report", () => {
  const row = seatRow();
  const r = save(row);
  store.setRunDoneWhen(r.id, ["First check", "Second check"]);
  store.addEvidence(r.id, `Done npm_${"a".repeat(36)}`, NOW, {
    doneWhen: [
      { line: 1, text: "First check", status: "met", evidence: "Unit test" },
      { line: 2, text: "Second check", status: "not_met", evidence: "Keyboard work remains" },
    ],
  });
  const detail = view(row);
  expect(detail.story.original).toEqual([
    { line: 1, text: "First check" },
    { line: 2, text: "Second check" },
  ]);
  expect(detail.story.report).not.toContain(`npm_${"a".repeat(36)}`);
  expect(detail.story.left).toEqual(["Keyboard work remains"]);
  expect(detail.story.doneWhen[0]?.status).toBe("met");
});
it("does not adopt an old PR merely because a new run reuses its branch", () => {
  const row = seatRow({ prs: [] });
  const r = save(row);
  store.upsertPullRequests(
    row.repoId,
    [prView({ repoId: row.repoId, branch: r.branch as string, state: "closed", number: 7 })],
    NOW,
  );
  expect(view(row).deliverables).toEqual([]);
});
it("names the non-operator owner instead of inventing an operator task", () => {
  const row = seatRow();
  save(row);
  const detail = view(row, null, [
    item({ agentId: row.id, owner: "loop", text: "Loop-owned question" }),
  ]);
  expect(detail.nextMove).toMatchObject({ owner: "loop", label: "Open conversation" });
});

function sampleDigest(): RunDigest {
  return {
    toolCalls: 0,
    turns: 2,
    lastEventAt: NOW,
    model: "sonnet",
    contextTokens: null,
    contextWindow: null,
    liveTool: null,
    tools: {},
    subagents: [],
    minuteTokens: [],
    turnUsage: [],
    background: [],
    compactions: 0,
  };
}

it("scopes an acknowledged question to the current ticket while retaining repo escalations", () => {
  const row = seatRow({ ticket: "shop-app#22" });
  save(row);
  expect(
    view(row, null, [
      item({ agentId: row.id, ticket: "shop-app#11", escalationId: null, kind: "question" }),
    ]).nextMove,
  ).toBeNull();
  expect(
    view(row, null, [item({ agentId: row.id, ticket: "shop-app#11", escalationId: "9" })]).nextMove,
  ).not.toBeNull();
});
it("redacts original asks and every saved acceptance answer", () => {
  const row = seatRow();
  const r = save(row);
  const credential = `npm_${"b".repeat(36)}`;
  store.setRunDoneWhen(r.id, [`Check ${credential}`]);
  store.addEvidence(r.id, "Report", NOW, {
    doneWhen: [{ line: 1, text: credential, evidence: credential, status: "not_met" }],
  });
  expect(JSON.stringify(view(row).story)).not.toContain(credential);
});
it("preserves cross-repo and unknown PRs, reading changed files from their stored table", () => {
  const pr = prView({
    repoId: "other",
    number: 12,
    headSha: "abc123",
    files: [{ path: "src/a b.ts", changeType: "modified" }],
  });
  const row = seatRow({
    prs: [
      {
        repoId: "other",
        number: 12,
        title: "Other repo",
        url: pr.url,
        state: "open",
        ticket: null,
      },
      {
        repoId: "unknown",
        number: 9,
        title: null,
        url: "https://github.com/o/unknown/pull/9",
        state: null,
        ticket: null,
      },
    ],
  });
  save(row);
  store.upsertPullRequests("other", [pr], NOW);
  expect(store.pullRequests("other")[0]?.files).toBeUndefined();
  const detail = agentDetail({
    row,
    store,
    loop: null,
    items: [],
    github: (repoId) => (repoId === "other" ? "o/other" : null),
  });
  expect(detail.deliverables.filter((d) => d.kind === "pr")).toHaveLength(2);
  expect(detail.deliverables.find((d) => d.kind === "file")?.href).toBe(
    "https://github.com/o/other/blob/abc123/src/a%20b.ts",
  );
});
it("does not invent completion or a pending verdict for unmeasured profile gates", () => {
  const row = seatRow({
    loop: {
      phase: "review",
      text: "Review",
      prNumber: 9,
      parked: null,
      steps: [
        { name: "go/no-go", phase: null },
        { name: "reproduce", phase: null },
        { name: "Review", phase: "review" },
      ],
    },
  });
  save(row);
  expect(
    view(row)
      .steps.slice(0, 2)
      .map((s) => s.state),
  ).toEqual(["unknown", "unknown"]);
});
it.each(["ci", "retro", "main", "operator", "seat"] as const)(
  "names waiting on %s while the driver is idle",
  (wait) => {
    const row = seatRow({
      hudState: "idle",
      loop: { phase: "ci", text: "Checks", prNumber: 9, parked: null, wait },
    });
    save(row);
    expect(view(row).awaiting.label).not.toBe("Idle");
  },
);

it("does not divide current tokens by a window inherited from an earlier run", () => {
  const row = seatRow({
    contextWindow: 200000,
    digest: { ...sampleDigest(), contextTokens: 100000, contextWindow: null },
  });
  save(row);
  expect(view(row).context).toMatchObject({ tokens: 100000, window: null, percent: null });
});

it("reads only the latest prompt wake without loading its history", () => {
  const row = seatRow();
  const r = save(row);
  for (let wake = 0; wake < 50; wake++)
    store.recordPromptSections(r.id, wake, NOW + wake, [
      { section: "role", bytes: wake * 4, tokens: wake },
    ]);
  expect(store.latestPromptWake(r.id)?.wake).toBe(49);
  expect(view(row).context.prompt?.wake).toBe(49);
});

it.each([true, false])("keeps Error ahead of a review or parked loop (%s)", (parked) => {
  const row = seatRow({
    hudState: "error",
    sourceError: "CLI failed",
    reviewing: parked ? null : { prNumber: 7, sha: "abc", ref: null },
    loop: parked ? { phase: "parked", text: "Held", prNumber: 7, parked: "Review" } : null,
  });
  save(row);
  const detail = view(row);
  expect(detail.awaiting).toMatchObject({ label: "Error", reason: "CLI failed" });
  expect(detail.health.label).toBe("Error");
});

function reviewSubject() {
  const row = seatRow({
    review: { prNumber: 7, state: "open" },
    loop: { phase: "review", text: "Review", prNumber: 7, parked: null },
  });
  const run = save(row);
  store.setRunLoop(run.id, { ...NEW_LOOP, phase: "review", prNumber: 7, epoch: 2 });
  store.upsertPullRequests(
    row.repoId,
    [prView({ repoId: row.repoId, number: 7, state: "open", headSha: "head", ticket: row.ticket })],
    NOW,
  );
  return { row, run };
}
function reviewed(
  run: Run,
  { sha = "head", epoch = 2, pr = 7, attempt = 1, blocking = true, queued = false } = {},
) {
  const id = store.requestReview({
    authorRunId: run.id,
    repoId: run.repoId,
    seatId: "retro",
    prNumber: pr,
    sha,
    epoch,
    attempt,
    round: 1,
    at: NOW,
  });
  if (id === null) throw Error("review not queued");
  if (!queued) {
    store.setReviewState(id, ["queued"], "running", { runId: `review-${id}`, at: NOW });
    store.recordFindings(id, `review-${id}`, {
      verdict: { spec: blocking ? "fail" : "pass", quality: "pass" },
      summary: "Review",
      findings: blocking
        ? [
            {
              severity: "Important",
              file: "src/a.ts",
              line: 1,
              summary: "Issue",
              scenario: "Example",
              fix: "Repair",
            },
          ]
        : [],
      at: NOW,
    });
  }
  return id;
}
it.each(["epoch", "pr"] as const)("ignores a same-SHA review from another %s", (other) => {
  const { row, run } = reviewSubject();
  reviewed(run, other === "epoch" ? { epoch: 1 } : { pr: 8 });
  expect(view(row).health.blocking).toBeNull();
});
it("does not show an earlier reported count after the current review queues again", () => {
  const { row, run } = reviewSubject();
  reviewed(run);
  expect(view(row).health.blocking).toBe(1);
  reviewed(run, { attempt: 2, queued: true });
  expect(view(row).health.blocking).toBeNull();
});
it("carries an approved review across the recorded main merge and keeps a waiver distinct", () => {
  const { row, run } = reviewSubject();
  reviewed(run, { sha: "before-merge", blocking: false });
  store.setRunLoop(run.id, {
    ...NEW_LOOP,
    phase: "review",
    prNumber: 7,
    epoch: 2,
    carry: { from: "before-merge", to: "head" },
  });
  expect(view(row).health.blocking).toBe(0);
  store.setRunLoop(run.id, {
    ...NEW_LOOP,
    phase: "review",
    prNumber: 7,
    epoch: 2,
    reviewWaivedSha: "head",
  });
  expect(view(row).health.blocking).toBeNull();
});
