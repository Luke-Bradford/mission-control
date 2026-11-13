import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import {
  type Proposal,
  RecommendationMutation,
  upsertRecommendation,
} from "../src/code-health/recommendations.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 2),
  DAY = 86_400_000,
  TOKEN = `operator-fixture-${"x".repeat(48)}`;
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  loops: [],
  repos: [
    {
      id: "sample",
      github: "example/sample",
      project: 1,
      statusMap: { Todo: "planned" },
      autonomy: "draft",
      runCommand: "pnpm dev",
    },
  ],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};
function present<T>(value: T | null | undefined): T {
  if (value == null) throw Error("Missing fixture record");
  return value;
}
describe("durable code-health decisions", () => {
  let dir: string, store: Store, db: DatabaseSync;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mc-recommendations-"));
    const file = join(dir, "fixture.sqlite");
    store = new Store(file);
    db = new DatabaseSync(file);
  });
  afterEach(() => {
    db.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  function review(id: number, pr: number, round = 1, sha = "a".repeat(40)) {
    db.prepare(
      `INSERT INTO reviews(id,author_run_id,repo_id,seat_id,pr_number,sha,epoch,attempt,round,state,created_at,ended_at)VALUES(?,?,'sample','reviewer',?,?,0,1,?,'reported',?,?)`,
    ).run(id, `run-${id}`, pr, sha, round, NOW - 1000, NOW - 1000);
  }
  function finding(
    review: number,
    pos: number,
    file = "src/example.ts",
    category: string | null = "spec",
    summary = "Example",
    fix = "Example",
  ) {
    db.prepare(
      `INSERT INTO review_findings(review_id,author_run_id,pos,severity,file,line,summary,scenario,fix,category,state)VALUES(?,?,?,'Minor',?,1,?,'Example',?,?,'open')`,
    ).run(review, `run-${review}`, pos, file, summary, fix, category);
  }
  function proposal() {
    store.refreshCodeHealthRecommendations("sample", NOW);
    return present(store.codeHealthRecommendations("sample")[0]);
  }
  function currentHead(number: number, headSha: string) {
    store.upsertPullRequests(
      "sample",
      [
        {
          repoId: "sample",
          number,
          title: `PR ${number}`,
          url: `https://github.com/example/sample/pull/${number}`,
          branch: `fixture/${number}`,
          base: "main",
          ticket: null,
          state: "open",
          isDraft: false,
          review: null,
          ci: "passing",
          createdAt: NOW - 1000,
          updatedAt: NOW,
          mergedAt: null,
          headSha,
          mergeable: null,
        } as never,
      ],
      NOW,
    );
  }
  it("updates collection gaps from imported metadata without materialising named attempts on Overview", () => {
    const full = vi.spyOn(store, "codeHealthTestAttempts").mockImplementation(() => {
      throw new Error("Overview must not load the attempt payload");
    });
    store.refreshCodeHealthRecommendations("sample", NOW);
    expect(
      store.codeHealthRecommendations("sample").find((row) => row.rule === "collection")
        ?.observation,
    ).toContain("named-test results");
    store.importCodeHealthTestReport(
      {
        version: 1,
        repo: "sample",
        headSha: "a".repeat(40),
        workflow: "fixture",
        workflowRun: "101",
        job: "unit",
        jobRun: "201",
        runAttempt: 1,
        environment: "fixture-environment",
        completedAt: NOW - 1,
        expectedAttempts: 1,
        cases: [
          {
            testId: "test-a",
            attemptId: "test-a:1",
            file: "test/example.test.ts",
            suite: "example",
            name: "does the work",
            executionOrder: 0,
            state: "passed",
            completedAt: NOW - 2,
            duration: 10,
            durationUnit: "ms",
          },
        ],
      },
      "operator",
      NOW,
      [],
    );
    store.refreshCodeHealthRecommendations("sample", NOW);
    const collection = store
      .codeHealthRecommendations("sample")
      .find((row) => row.rule === "collection");
    expect(collection?.observation).not.toContain("named-test results");
    expect(collection?.observation).not.toContain("test execution-order metadata");
    expect(collection?.observation).toContain("1 imported test reports");
    expect(full).not.toHaveBeenCalled();
    full.mockRestore();
  });
  function request(
    row = proposal(),
    change: unknown = { action: "accept", owner: "owner", reviewAt: NOW + 1000 },
  ) {
    return RecommendationMutation.parse({
      requestId: randomUUID(),
      basis: "Observed fixture evidence",
      expectedUpdatedAt: row.updatedAt,
      change,
    });
  }
  it("uses finding identity, file/category and distinct PR thresholds", () => {
    review(1, 10);
    finding(1, 0);
    finding(1, 1);
    finding(1, 2);
    store.refreshCodeHealthRecommendations("sample", NOW);
    expect(store.codeHealthRecommendations("sample").map((r) => r.rule)).toEqual(["collection"]);
    review(2, 11, 3);
    finding(2, 0);
    finding(2, 1, "src/other.ts");
    finding(2, 2, "src/example.ts", null);
    store.refreshCodeHealthRecommendations("sample", NOW);
    const rows = store.codeHealthRecommendations("sample");
    expect(rows.map((r) => r.rule).sort()).toEqual([
      "collection",
      "recurring-correction",
      "repeated-rounds",
    ]);
    expect(rows.find((r) => r.rule === "recurring-correction")?.target.baseline).toBeNull();
    expect(store.codeHealthRecommendations("other")).toEqual([]);
  });
  it("groups one recorded cause across files and publishes its measured decision fields", () => {
    review(1, 10);
    review(2, 11);
    review(3, 12);
    finding(1, 0, "src/first.ts", "boundary-check");
    finding(1, 1, "src/first.ts", "boundary-check");
    finding(2, 0, "src/second.ts", "boundary-check");
    finding(2, 1, "src/second.ts", "boundary-check");
    finding(2, 2, "src/second.ts", "other-cause");
    finding(2, 3, "src/second.ts", "other-cause");
    finding(3, 0, "src/second.ts", "other-cause");
    finding(3, 1, "src/second.ts", "other-cause");
    currentHead(10, "a".repeat(40));
    currentHead(11, "a".repeat(40));
    currentHead(12, "a".repeat(40));

    store.refreshCodeHealthRecommendations("sample", NOW);

    const rows = store
      .codeHealthRecommendations("sample")
      .filter((row) => row.rule === "recurring-correction");
    expect(rows).toHaveLength(2);
    const boundary = present(rows.find((row) => row.scope?.files?.length === 2));
    expect(boundary.scope?.files).toEqual(["src/first.ts", "src/second.ts"]);
    expect(boundary.title).toContain("boundary-check");
    expect(boundary.measure).toMatchObject({ current: 4, unit: "findings", window: "30d" });
    expect(boundary.target).toMatchObject({ value: 0, source: "clean-review target" });
    expect(boundary.decision).toEqual({ owner: "operator", tier: "operator" });
  });
  it("names the missing prerequisite instead of inventing a target for unsupported rules", () => {
    review(1, 10, 3);

    store.refreshCodeHealthRecommendations("sample", NOW);

    const rows = store.codeHealthRecommendations("sample");
    const rounds = present(rows.find((row) => row.rule === "repeated-rounds"));
    const collection = present(rows.find((row) => row.rule === "collection"));
    for (const row of [rounds, collection]) {
      expect(row.target.value).toBeNull();
      expect(row.target.source).toMatch(/^Missing /);
      expect(row.target.policy).toBeTruthy();
      expect(row.title).not.toMatch(/Inspect the shared cause/);
    }
    expect(rounds.measure?.current).toBe(3);
    expect(rounds.decision).toEqual({ owner: "operator", tier: "operator" });
  });
  it("reports an unreviewed changed head as an unknown current measure", () => {
    review(1, 10);
    review(2, 11);
    for (let pos = 0; pos < 3; pos++) {
      finding(1, pos, "src/a.ts", "boundary-check");
      finding(2, pos, "src/b.ts", "boundary-check");
    }
    currentHead(10, "b".repeat(40));
    currentHead(11, "a".repeat(40));

    store.refreshCodeHealthRecommendations("sample", NOW);

    const row = present(
      store
        .codeHealthRecommendations("sample")
        .find((value) => value.rule === "recurring-correction"),
    );
    expect(row.measure?.current).toBeNull();
    expect(row.measure?.coverage).toContain("newer PR head");
    expect(row.target.value).toBe(0);
  });
  it("keeps resolved historical findings as evidence but excludes them from the current measure", () => {
    review(1, 10);
    review(2, 11);
    for (let pos = 0; pos < 2; pos++) {
      finding(1, pos, "src/a.ts", "boundary-check");
      finding(2, pos, "src/b.ts", "boundary-check");
    }
    currentHead(10, "a".repeat(40));
    currentHead(11, "a".repeat(40));
    db.prepare("UPDATE review_findings SET resolution='fixed' WHERE review_id IN (?,?)").run(1, 2);

    store.refreshCodeHealthRecommendations("sample", NOW);

    const row = present(
      store
        .codeHealthRecommendations("sample")
        .find((value) => value.rule === "recurring-correction"),
    );
    expect(row.observation).toContain("4 recorded");
    expect(row.measure?.current).toBe(0);
    expect(row.target.value).toBe(0);
  });
  it("keeps distinct causes in one category and file as separate stored recommendations", () => {
    review(1, 10);
    review(2, 11);
    for (let pos = 0; pos < 2; pos++) {
      finding(1, pos, "src/shared.ts", "boundary", "Range check", "Validate bounds");
      finding(2, pos, "src/shared.ts", "boundary", "Range check", "Validate bounds");
      finding(1, pos + 2, "src/shared.ts", "boundary", "Null check", "Reject null input");
      finding(2, pos + 2, "src/shared.ts", "boundary", "Null check", "Reject null input");
    }
    currentHead(10, "a".repeat(40));
    currentHead(11, "a".repeat(40));

    store.refreshCodeHealthRecommendations("sample", NOW);

    const rows = store
      .codeHealthRecommendations("sample")
      .filter((row) => row.rule === "recurring-correction");
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(new Set(rows.map((row) => row.causeId)).size).toBe(2);
  });
  it.each(["dismiss", "accept"] as const)(
    "keeps a legacy %s decision on its original ID across a reader restart and repeated refresh",
    (decision) => {
      const legacy: Proposal = {
        id: `chr_legacy_${decision}`,
        repoId: "sample",
        rule: "recurring-correction",
        ruleVersion: 1,
        scope: {
          file: "src/a.ts",
          category: "boundary-check",
          from: NOW - 30 * 86400000,
          until: NOW,
          observedFrom: NOW - 1000,
          observedUntil: NOW - 1000,
        },
        evidenceFingerprint: "legacy-fingerprint",
        observation: "Legacy observed finding",
        proposal: "Legacy proposal",
        uncertainty: "Legacy uncertainty",
        rankingReason: "Legacy ranking",
        target: { metric: "findings", direction: "decrease", baseline: 4 },
      };
      upsertRecommendation(db, legacy, NOW);
      const old = present(store.codeHealthRecommendation("sample", legacy.id));
      const decided = store.decideCodeHealthRecommendation(
        "sample",
        old.id,
        request(
          old,
          decision === "dismiss"
            ? { action: "dismiss", reason: "Already handled" }
            : { action: "accept", owner: "operator", reviewAt: NOW + DAY },
        ),
        "operator",
        NOW,
      );
      review(1, 10);
      review(2, 11);
      for (let pos = 0; pos < 2; pos++) {
        finding(1, pos, "src/a.ts", "boundary-check");
        finding(2, pos, "src/b.ts", "boundary-check");
      }
      currentHead(10, "a".repeat(40));
      currentHead(11, "a".repeat(40));

      store.refreshCodeHealthRecommendations("sample", NOW + 1);

      // A new reader must find the durable identity selected during the legacy
      // migration, rather than materialising a canonical-ID duplicate.
      store.close();
      db.close();
      const file = join(dir, "fixture.sqlite");
      store = new Store(file);
      db = new DatabaseSync(file);
      store.refreshCodeHealthRecommendations("sample", NOW + 2);

      const replacement = present(
        store
          .codeHealthRecommendations("sample")
          .find((row) => row.rule === "recurring-correction" && row.id === legacy.id),
      );
      expect(replacement.id).toBe(legacy.id);
      expect(replacement.state.kind).toBe(decision === "dismiss" ? "dismissed" : "accepted");
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM code_health_recommendations WHERE repo_id='sample' AND json_extract(proposal,'$.rule')='recurring-correction'",
          )
          .get(),
      ).toEqual({ n: 1 });
      if (decision === "accept") {
        expect(replacement.owner).toBe("operator");
        expect(replacement.reviewAt).toBe(NOW + DAY);
        expect(replacement.baseline).toEqual(decided.baseline);
        expect(store.remeasureCodeHealth("sample", NOW + DAY + 1)).toEqual([legacy.id]);
        expect(store.remeasureCodeHealth("sample", NOW + DAY + 2)).toEqual([]);
      }
    },
  );
  it("does not carry a legacy decision to a later different cause in the same file and category", () => {
    const legacy: Proposal = {
      id: "chr_legacy_later",
      repoId: "sample",
      rule: "recurring-correction",
      ruleVersion: 1,
      scope: {
        file: "src/a.ts",
        category: "boundary-check",
        from: NOW - 30 * DAY,
        until: NOW,
        observedFrom: NOW - 1000,
        observedUntil: NOW - 1000,
      },
      evidenceFingerprint: "legacy-fingerprint",
      observation: "Legacy observed finding",
      proposal: "Legacy proposal",
      uncertainty: "Legacy uncertainty",
      rankingReason: "Legacy ranking",
      target: { metric: "findings", direction: "decrease", baseline: 4 },
    };
    upsertRecommendation(db, legacy, NOW);
    const old = present(store.codeHealthRecommendation("sample", legacy.id));
    store.decideCodeHealthRecommendation(
      "sample",
      old.id,
      request(old, { action: "dismiss", reason: "Already handled" }),
      "operator",
      NOW,
    );
    review(1, 10);
    review(2, 11);
    for (let pos = 0; pos < 2; pos++) {
      finding(1, pos, "src/a.ts", "boundary-check", "New cause", "New fix");
      finding(2, pos, "src/a.ts", "boundary-check", "New cause", "New fix");
    }
    db.prepare("UPDATE reviews SET ended_at=? WHERE id IN (?,?)").run(NOW + 1, 1, 2);
    currentHead(10, "a".repeat(40));
    currentHead(11, "a".repeat(40));

    store.refreshCodeHealthRecommendations("sample", NOW + 2);

    const newCause = present(
      store
        .codeHealthRecommendations("sample")
        .find((row) => row.rule === "recurring-correction" && row.id !== legacy.id),
    );
    expect(newCause.state).toEqual({ kind: "proposed" });
  });
  it("clears an unknown changed head only after a review records that head", () => {
    review(1, 10);
    review(2, 11);
    for (let pos = 0; pos < 2; pos++) {
      finding(1, pos, "src/a.ts", "boundary-check");
      finding(2, pos, "src/b.ts", "boundary-check");
    }
    currentHead(10, "b".repeat(40));
    currentHead(11, "a".repeat(40));
    store.refreshCodeHealthRecommendations("sample", NOW);
    expect(
      store.codeHealthRecommendations("sample").find((row) => row.rule === "recurring-correction")
        ?.measure?.current,
    ).toBeNull();

    review(3, 10, 2, "b".repeat(40));
    store.refreshCodeHealthRecommendations("sample", NOW + 1);
    expect(
      store.codeHealthRecommendations("sample").find((row) => row.rule === "recurring-correction")
        ?.measure?.current,
    ).toBe(2);
  });
  it("keeps eight distinct real-shaped causes with measured targets in a busy fixture", () => {
    for (let cause = 1; cause <= 8; cause++) {
      const first = cause * 10,
        second = first + 1,
        category = `boundary-${cause}`;
      review(first, first);
      review(second, second);
      finding(first, 0, `src/feature-${cause}.ts`, category);
      finding(first, 1, `src/feature-${cause}.ts`, category);
      finding(second, 0, `src/feature-${cause}.spec.ts`, category);
      finding(second, 1, `src/feature-${cause}.spec.ts`, category);
      currentHead(first, "a".repeat(40));
      currentHead(second, "a".repeat(40));
    }

    store.refreshCodeHealthRecommendations("sample", NOW);

    const causes = store
      .codeHealthRecommendations("sample")
      .filter((row) => row.rule === "recurring-correction");
    expect(new Set(causes.map((row) => row.causeId)).size).toBe(8);
    expect(
      causes.filter(
        (row) => typeof row.measure?.current === "number" && typeof row.target.value === "number",
      ),
    ).toHaveLength(8);
    expect(causes.every((row) => row.title && row.decision && row.state.kind === "proposed")).toBe(
      true,
    );
  });
  it("refresh deduplicates and retains accepted owner and immutable baseline after evidence changes", () => {
    review(1, 10, 3);
    const row = proposal();
    const req = request(row);
    store.decideCodeHealthRecommendation("sample", row.id, req, "operator", NOW);
    const accepted = present(store.codeHealthRecommendation("sample", row.id));
    review(2, 10, 4);
    store.refreshCodeHealthRecommendations("sample", NOW + 1);
    store.refreshCodeHealthRecommendations("sample", NOW + 2);
    const refreshed = present(store.codeHealthRecommendation("sample", row.id));
    expect(refreshed.state).toEqual(accepted.state);
    expect(refreshed.baseline).toEqual(accepted.baseline);
    expect(store.codeHealthRecommendations("sample").filter((r) => r.id === row.id)).toHaveLength(
      1,
    );
  });
  it("replays idempotent Accept exactly once and rejects conflicting reuse or concurrent stale decisions", () => {
    const row = proposal(),
      req = request(row);
    const first = store.decideCodeHealthRecommendation("sample", row.id, req, "operator", NOW);
    expect(
      store.decideCodeHealthRecommendation("sample", row.id, req, "operator", NOW + 1),
    ).toEqual(first);
    expect(store.flightDecisions(0, 100)).toHaveLength(1);
    expect(() =>
      store.decideCodeHealthRecommendation(
        "sample",
        row.id,
        { ...req, basis: "Changed" },
        "operator",
        NOW + 1,
      ),
    ).toThrow(/already used/);
    expect(() =>
      store.decideCodeHealthRecommendation(
        "sample",
        row.id,
        { ...req, requestId: randomUUID() },
        "operator",
        NOW + 1,
      ),
    ).toThrow(/changed/);
  });
  it("rejects blank owner/reason, expired dates and cross-repo IDs", () => {
    const row = proposal();
    for (const change of [
      { action: "accept", owner: " ", reviewAt: NOW + 1 },
      { action: "dismiss", reason: " " },
    ])
      expect(() => request(row, change)).toThrow();
    for (const change of [
      { action: "accept", owner: "owner", reviewAt: NOW },
      { action: "snooze", until: NOW - 1 },
    ])
      expect(() =>
        store.decideCodeHealthRecommendation(
          "sample",
          row.id,
          request(row, change),
          "operator",
          NOW,
        ),
      ).toThrow(/future/);
    expect(() =>
      store.decideCodeHealthRecommendation("other", row.id, request(row), "operator", NOW),
    ).toThrow(/Unknown/);
  });
  it("preserves Dismiss and Snooze on refresh", () => {
    const row = proposal();
    store.decideCodeHealthRecommendation(
      "sample",
      row.id,
      request(row, { action: "snooze", until: NOW + 100 }),
      "operator",
      NOW,
    );
    store.refreshCodeHealthRecommendations("sample", NOW + 1);
    const snoozed = present(store.codeHealthRecommendation("sample", row.id));
    expect(snoozed.state).toEqual({ kind: "snoozed", until: NOW + 100 });
    store.decideCodeHealthRecommendation(
      "sample",
      row.id,
      request(snoozed, { action: "dismiss", reason: "  Already tracked  " }),
      "operator",
      NOW + 101,
    );
    store.refreshCodeHealthRecommendations("sample", NOW + 102);
    expect(store.codeHealthRecommendation("sample", row.id)?.state).toEqual({
      kind: "dismissed",
      reason: "Already tracked",
    });
  });
  it("requires a later explicit baseline comparison and keeps linked work after assessment", () => {
    const row = proposal();
    store.decideCodeHealthRecommendation("sample", row.id, request(row), "operator", NOW);
    store.linkCodeHealthRecommendation(
      "sample",
      row.id,
      "https://github.com/example/sample/issues/1",
      "flight",
      NOW + 1,
    );
    const accepted = present(store.codeHealthRecommendation("sample", row.id));
    const assess = request(accepted, {
      action: "assess",
      outcome: "no-effect",
      reason: "No observed improvement",
      evidenceId: "issued-fixture",
      comparison: "Baseline and later count both equal three",
    });
    expect(() =>
      store.decideCodeHealthRecommendation("sample", row.id, assess, "operator", NOW + 2),
    ).toThrow(/review date/);
    const assessed = store.decideCodeHealthRecommendation(
      "sample",
      row.id,
      assess,
      "operator",
      NOW + 1001,
    );
    expect(assessed.state.kind).toBe("no-effect");
    expect(assessed.linkedWork).toContain("/issues/1");
    expect(assessed.baseline).toBeTruthy();
  });
  it("expires old proposals while retaining the original accepted baseline", () => {
    review(1, 10, 3);
    store.refreshCodeHealthRecommendations("sample", NOW);
    const row = store.codeHealthRecommendations("sample").find((r) => r.rule === "repeated-rounds");
    if (!row) throw Error("missing repeated round");
    store.decideCodeHealthRecommendation("sample", row.id, request(row), "operator", NOW);
    const baseline = store.codeHealthRecommendation("sample", row.id)?.baseline;
    store.refreshCodeHealthRecommendations("sample", NOW + 31 * 86400000);
    const expired = store.codeHealthRecommendation("sample", row.id);
    expect(expired?.active).toBe(false);
    expect(expired?.state.kind).toBe("accepted");
    expect(expired?.baseline).toEqual(baseline);
  });
  it("returns at most three ranked open proposals and pages retained decisions", async () => {
    for (let i = 1; i <= 8; i++) review(i, i, 3);
    const app = buildApp({
      config,
      store,
      bus: new ChangeBus(),
      operatorToken: TOKEN,
      now: () => NOW,
    });
    try {
      const overview = (
        await app.inject({
          url: "/api/code-health?repo=sample",
          headers: { "x-mc-operator": TOKEN },
        })
      ).json();
      expect(overview.data.recommendations).toHaveLength(3);
      expect(
        overview.data.recommendations.every((r: { rule: string }) => r.rule === "repeated-rounds"),
      ).toBe(true);
      const history = await app.inject({
        url: "/api/code-health/recommendations?repo=sample",
        headers: { "x-mc-operator": TOKEN },
      });
      expect(history.statusCode).toBe(200);
      expect(history.json().recommendations).toHaveLength(9);
      expect(
        (
          await app.inject({
            url: "/api/code-health/recommendations?repo=sample&cursor=1",
            headers: { "x-mc-operator": TOKEN },
          })
        ).statusCode,
      ).toBe(400);
    } finally {
      await app.close();
    }
  });
  it("keeps 30-day recommendation evidence independent of selected dashboard range", async () => {
    review(1, 10, 3);
    db.prepare("UPDATE reviews SET ended_at=? WHERE id=1").run(NOW - 15 * 86400000);
    const app = buildApp({
      config,
      store,
      bus: new ChangeBus(),
      operatorToken: TOKEN,
      now: () => NOW,
    });
    const headers = { "x-mc-operator": TOKEN };
    try {
      for (const window of ["7d", "90d"]) {
        const view = (
          await app.inject({ url: `/api/code-health?repo=sample&window=${window}`, headers })
        ).json();
        const row = view.data.recommendations.find(
          (r: { rule: string }) => r.rule === "repeated-rounds",
        );
        expect(row.evidence[0].coverage.requestedWindow).toBe("30d");
        const page = (
          await app.inject({
            url: `/api/code-health/evidence/${row.evidence[0].id}?repo=sample`,
            headers,
          })
        ).json();
        expect(page.rows.map((r: { pr: number }) => r.pr)).toEqual([10]);
      }
    } finally {
      await app.close();
    }
  });
  it("narrows recurring-correction evidence to the recorded cause across its files", async () => {
    review(1, 10);
    review(2, 11);
    finding(1, 0);
    finding(1, 1);
    finding(2, 0);
    finding(2, 1, "src/other.ts");
    finding(2, 2, "src/example.ts", "correctness");
    const app = buildApp({
        config,
        store,
        bus: new ChangeBus(),
        operatorToken: TOKEN,
        now: () => NOW,
      }),
      headers = { "x-mc-operator": TOKEN };
    try {
      const view = (
        await app.inject({ url: "/api/code-health?repo=sample&window=7d", headers })
      ).json();
      const row = view.data.recommendations.find(
        (r: { rule: string }) => r.rule === "recurring-correction",
      );
      const page = (
        await app.inject({
          url: `/api/code-health/evidence/${row.evidence[0].id}?repo=sample`,
          headers,
        })
      ).json();
      expect(page.rows).toHaveLength(4);
      expect(
        page.rows.every(
          (r: { file: string; category: string }) =>
            ["src/example.ts", "src/other.ts"].includes(r.file) && r.category === "spec",
        ),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
  it("finds current proposals behind more than 200 newer inactive history rows", async () => {
    review(1, 10, 3);
    const row = proposal();
    const insert = db.prepare(
      "INSERT INTO code_health_recommendations(id,repo_id,proposal,active,created_at,updated_at)VALUES(?,'sample',?,0,?,?)",
    );
    for (let i = 0; i < 210; i++)
      insert.run(
        `history-${i}`,
        JSON.stringify({ ...row, id: `history-${i}` }),
        NOW + i + 1,
        NOW + i + 1,
      );
    const app = buildApp({
      config,
      store,
      bus: new ChangeBus(),
      operatorToken: TOKEN,
      now: () => NOW,
    });
    try {
      const view = (
        await app.inject({
          url: "/api/code-health?repo=sample",
          headers: { "x-mc-operator": TOKEN },
        })
      ).json();
      expect(
        view.data.recommendations.some((r: { rule: string }) => r.rule === "repeated-rounds"),
      ).toBe(true);
    } finally {
      await app.close();
    }
  });
  it("replays a successful HTTP assessment after its own source revision changes", async () => {
    let at = NOW;
    review(1, 10, 3);
    const row = proposal(),
      acceptedRequest = request(row, { action: "accept", owner: "owner", reviewAt: NOW + 10 });
    store.decideCodeHealthRecommendation("sample", row.id, acceptedRequest, "operator", NOW);
    const app = buildApp({
        config,
        store,
        bus: new ChangeBus(),
        operatorToken: TOKEN,
        now: () => at,
      }),
      headers = { "x-mc-operator": TOKEN };
    try {
      at = NOW + 20;
      const view = (await app.inject({ url: "/api/code-health?repo=sample", headers })).json(),
        current = present(store.codeHealthRecommendation("sample", row.id));
      const payload = request(current, {
          action: "assess",
          outcome: "paid-off",
          reason: "Observed improvement",
          comparison: "Compared with saved metric baseline",
          evidenceId: view.evidence[0].id,
        }),
        url = `/api/code-health/recommendations/${row.id}?repo=sample`;
      const first = await app.inject({ method: "POST", url, headers, payload });
      expect(first.statusCode).toBe(200);
      const retry = await app.inject({ method: "POST", url, headers, payload });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(first.json());
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers,
            payload: { ...payload, basis: "conflicting retry" },
          })
        ).statusCode,
      ).toBe(409);
      expect(first.json().state.assessment).toContain("\nComparison");
    } finally {
      await app.close();
    }
  });
  it("protects HTTP decisions, fails closed on secret-provider failure and validates issued assessment evidence", async () => {
    const row = proposal();
    let fail = false;
    const app = buildApp({
      config,
      store,
      bus: new ChangeBus(),
      operatorToken: TOKEN,
      knownSecrets: async () => {
        if (fail) throw Error("fixture");
        return [];
      },
      now: () => NOW,
    });
    try {
      const url = `/api/code-health/recommendations/${row.id}?repo=sample`,
        payload = request(row);
      expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
      fail = true;
      expect(
        (await app.inject({ method: "POST", url, payload, headers: { "x-mc-operator": TOKEN } }))
          .statusCode,
      ).toBe(503);
      expect(store.codeHealthRecommendation("sample", row.id)?.state.kind).toBe("proposed");
      fail = false;
      expect(
        (await app.inject({ method: "POST", url, payload, headers: { "x-mc-operator": TOKEN } }))
          .statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });
});
