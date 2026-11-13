import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CODE_HEALTH_OVERVIEW_TTL_MS,
  type CodeHealthOverview,
  type CodeHealthView,
  type Topic,
} from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { CodeHealthReader } from "../src/code-health/read.ts";
import { type Proposal, upsertRecommendation } from "../src/code-health/recommendations.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 10, 12);
const TOKEN = `operator-fixture-${"c".repeat(48)}`;
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  loops: [],
  repos: ["sample", "other"].map((id) => ({
    id,
    github: `example/${id}`,
    project: 1,
    statusMap: { Todo: "planned" },
    autonomy: "draft",
    runCommand: "pnpm dev",
  })),
  poll: { usageMinutes: 30, githubSeconds: 60 },
};

describe("Audit first-screen summary", () => {
  let root: string;
  let store: Store;
  let db: DatabaseSync;
  let app: FastifyInstance;
  let bus: ChangeBus;
  let topics: Topic[];
  let at: number;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mc-code-health-overview-"));
    const path = join(root, "fixture.sqlite");
    store = new Store(path);
    db = new DatabaseSync(path);
    at = NOW;
    bus = new ChangeBus();
    topics = [];
    bus.subscribe((topic) => topics.push(topic));
    app = buildApp({ config, store, bus, operatorToken: TOKEN, now: () => at });
  });
  afterEach(async () => {
    await app.close();
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const headers = { "x-mc-operator": TOKEN };
  const get = (url: string) => app.inject({ method: "GET", url, headers });
  const overview = async (query = "repo=sample") =>
    (await get(`/api/code-health/overview?${query}`)).json<CodeHealthOverview>();

  let reviewId = 100;
  /** A reported review of one PR; returns its id. */
  function review(pr: number, round: number, repo = "sample", time = NOW - DAY) {
    const id = ++reviewId;
    db.prepare(`INSERT INTO reviews (id, author_run_id, repo_id, seat_id, pr_number, sha,
      epoch, attempt, round, state, created_at, ended_at)
      VALUES (?, ?, ?, 'reviewer', ?, ?, 0, ?, ?, 'reported', ?, ?)`).run(
      id,
      `author-${pr}`,
      repo,
      pr,
      String(pr).padStart(40, "a"),
      round,
      round,
      time,
      time,
    );
    return id;
  }
  function merged(pr: number, mergedAt: number, reviewIdOrNull: number | null, repo = "sample") {
    db.prepare(`INSERT INTO code_health_merged_reviews
      (repo_id, pr_number, merged_at, merge_kind, review_id, recorded_at) VALUES (?, ?, ?, 'hand', ?, ?)`).run(
      repo,
      pr,
      mergedAt,
      reviewIdOrNull,
      mergedAt,
    );
    db.prepare(`INSERT OR IGNORE INTO pull_requests (repo_id, number, title, url, branch, state,
      is_draft, created_at, updated_at, merged_at) VALUES (?, ?, 't', 'u', ?, 'merged', 0, ?, ?, ?)`).run(
      repo,
      pr,
      `branch-${pr}`,
      mergedAt,
      mergedAt,
      mergedAt,
    );
  }
  let findingPos = 0;
  function finding(
    reviewRow: number,
    file: string,
    summary: string,
    category: string | null = "correctness",
  ) {
    db.prepare(`INSERT INTO review_findings (review_id, author_run_id, pos, severity, file, line,
      summary, scenario, fix, category, state) VALUES (?, 'a', ?, 'blocking', ?, 1, ?, 's', 'fix it', ?, 'open')`).run(
      reviewRow,
      ++findingPos,
      file,
      summary,
      category,
    );
  }
  function touch(pr: number, path: string, repo = "sample") {
    db.prepare(
      "INSERT INTO pr_files (repo_id, pr_number, path, change_type) VALUES (?, ?, ?, 'modified')",
    ).run(repo, pr, path);
  }
  let runSeq = 0;
  function run(pr: number, cost: number | null, repo = "sample") {
    db.prepare(`INSERT INTO runs (id, agent_id, repo_id, seq, started_at, status, branch, cost_usd, transcript_path)
      VALUES (?, 'seat', ?, ?, ?, 'ended', ?, ?, 't')`).run(
      `run-${++runSeq}`,
      repo,
      runSeq,
      NOW - DAY,
      `branch-${pr}`,
      cost,
    );
  }
  function proposal(id: string, state: string, extra: Partial<Proposal> = {}) {
    const value: Proposal = {
      id,
      repoId: "sample",
      rule: "repeated-rounds",
      ruleVersion: 1,
      evidenceFingerprint: `fp-${id}`,
      causeId: `cause-${id}`,
      title: `Title ${id}`,
      observation: "Seen",
      uncertainty: "Unsure",
      proposal: `Proposal ${id}`,
      rankingReason: "Because",
      target: { metric: "rounds", direction: "decrease", baseline: 3, value: 2 },
      createdAt: NOW,
      scope: null,
      ...extra,
    } as Proposal;
    upsertRecommendation(db as never, value, NOW);
    if (state !== "proposed")
      db.prepare("UPDATE code_health_recommendations SET state=? WHERE id=?").run(
        JSON.stringify({ kind: state }),
        id,
      );
  }

  it("is one protected route; other routes answer as before; repos stay apart", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/code-health/overview?repo=sample" }))
        .statusCode,
    ).toBe(401);
    expect((await get("/api/code-health/overview?repo=missing")).statusCode).toBe(404);
    for (const suffix of ["&window=365d", "&extra=1"])
      expect((await get(`/api/code-health/overview?repo=sample${suffix}`)).statusCode).toBe(400);
    const a = review(1, 2),
      b = review(2, 1, "other");
    merged(1, NOW - DAY, a);
    merged(2, NOW - DAY, b, "other");
    proposal("p1", "proposed");
    const response = await get("/api/code-health/overview?repo=sample");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const view = response.json<CodeHealthOverview>();
    for (const key of [
      "verdict",
      "rows",
      "figures",
      "outside",
      "wasteAlarms",
      "build",
      "landing",
      "past",
    ])
      expect(view).toHaveProperty(key);
    expect(view.repoId).toBe("sample");
    expect(view.build.merged.value).toBe(1);
    expect((await overview("repo=other")).build.merged.value).toBe(1);
    // The hub derives its own proposals when it rebuilds; the fixture's hand-made one is not kept active.
    expect(view.rows.every((row) => row.repoId === "sample" && row.evidence.length === 0)).toBe(
      true,
    );
    expect(view.outside.state).toBe("not-collected");
    expect(view.wasteAlarms.state).toBe("not-available");
    // The existing routes keep their shapes.
    const old = (await get("/api/code-health?repo=sample")).json<CodeHealthView>();
    expect(old.data.tab).toBe("overview");
    expect((await get("/api/code-health/recommendations?repo=sample")).statusCode).toBe(200);
  });

  it("splits merged-per-day by stored merge time into no-hub-review and reported rounds", async () => {
    const day = Date.UTC(2026, 10, 8, 3);
    merged(1, day, null);
    merged(2, day + 1000, review(2, 1));
    merged(3, day + 2000, review(3, 2));
    merged(4, day + 3000, review(4, 5));
    merged(5, day - 40 * DAY, null);
    const view = await overview();
    expect(view.build.mergedPerDay).toEqual([
      { day: "2026-11-08", noHubReview: 1, round1: 1, round2: 1, round3Plus: 1 },
    ]);
    expect(view.build.merged.value).toBe(4);
    expect(view.build.hubReview).toMatchObject({ numerator: 3, denominator: 4 });
  });

  it("counts rework over reported PRs with an explicit denominator and window", async () => {
    merged(1, NOW - DAY, review(1, 1));
    merged(2, NOW - DAY, review(2, 2));
    merged(3, NOW - DAY, review(3, 3));
    merged(4, NOW - DAY, null);
    const { rework } = (await overview()).build;
    expect(rework).toMatchObject({ numerator: 2, denominator: 3, unit: "% of reviewed PRs" });
    expect(rework.value).toBeCloseTo(66.67, 1);
    expect(rework.window.until - rework.window.from).toBe(30 * DAY);
    for (const key of ["unit", "window", "comparison", "source", "coverage", "updatedAt"])
      expect(rework).toHaveProperty(key);
    const empty = (await overview("repo=other")).build.rework;
    expect(empty.value).toBeNull();
    expect(empty.denominator).toBe(0);
  });

  it("counts a finding repeated across rounds once and leaves a zero-touch file undefined", async () => {
    const first = review(1, 1),
      second = review(1, 2);
    merged(1, NOW - DAY, second);
    touch(1, "src/a.ts");
    finding(first, "src/a.ts", "same cause");
    finding(second, "src/a.ts", "same cause");
    finding(second, "src/a.ts", "another cause");
    finding(second, "src/gone.ts", "orphan");
    const files = (await overview()).landing.files;
    const a = files.find((row) => row.path === "src/a.ts");
    expect(a).toMatchObject({ findings: 2, touches: 1 });
    expect(a?.ratio.value).toBe(2);
    const gone = files.find((row) => row.path === "src/gone.ts");
    expect(gone).toMatchObject({ findings: 1, touches: 0 });
    expect(gone?.ratio.value).toBeNull();
    expect(gone?.ratio.state).toBe("unknown");
  });

  it("counts the funnel by scoped SQL beyond the 200-row history cap", async () => {
    db.exec("BEGIN");
    for (let n = 0; n < 250; n++) proposal(`d${n}`, "dismissed");
    db.exec("COMMIT");
    proposal("o1", "proposed");
    const funnel = (await overview()).past.funnel;
    expect(funnel).toContainEqual({ kind: "dismissed", count: 250 });
    expect(funnel).toContainEqual({ kind: "proposed", count: 1 });
  });

  it("shows after-date results only from stored remeasure records", async () => {
    proposal("w", "accepted");
    proposal("m", "accepted");
    db.prepare("UPDATE code_health_recommendations SET review_at=? WHERE id=?").run(NOW + DAY, "w");
    const result = { at: NOW - 1000, baseline: 3, current: 1, change: "improved", note: "n" };
    db.prepare("UPDATE code_health_recommendations SET remeasure=?, review_at=? WHERE id=?").run(
      JSON.stringify(result),
      NOW - DAY,
      "m",
    );
    const { items, measured } = (await overview()).past;
    expect(items.find((row) => row.id === "w")).toMatchObject({ after: null, outcome: "waiting" });
    expect(items.find((row) => row.id === "m")).toMatchObject({
      after: { current: 1, change: "improved" },
      outcome: "worked",
    });
    expect(measured.improved).toBe(1);
  });

  it("treats missing cost as unknown or partial, never zero", async () => {
    merged(1, NOW - DAY, review(1, 1));
    merged(2, NOW - DAY, review(2, 1));
    merged(3, NOW - DAY, review(3, 1));
    run(1, 2);
    run(2, 4);
    run(2, null);
    run(3, null);
    const cost = (await overview()).build.cost;
    expect(cost.value).toBe(2);
    expect(cost.state).toBe("partial");
    expect(cost.numerator).toBe(1);
    expect(cost.denominator).toBe(3);
    const none = (await overview("repo=other")).build.cost;
    expect(none.value).toBeNull();
    expect(none.state).not.toBe("available");
  });

  it("rebuilds after a relevant change, not on unrelated events, and a new reader serves the stored summary", () => {
    merged(1, NOW - DAY, review(1, 1));
    const reader = new CodeHealthReader(store, config, () => at);
    const first = reader.overview("sample", "30d");
    expect(first.rebuilt).toBe(true);
    at += 1000;
    store.setSetting("unrelated", "x");
    const again = reader.overview("sample", "30d");
    expect(again.rebuilt).toBe(false);
    expect(again.view).toEqual(first.view);
    const fresh = new CodeHealthReader(store, config, () => at);
    expect(fresh.overview("sample", "30d")).toMatchObject({ rebuilt: false, view: first.view });
    merged(2, NOW - DAY, review(2, 2));
    const changed = reader.overview("sample", "30d");
    expect(changed.rebuilt).toBe(true);
    expect(changed.view.sourceRevision).not.toBe(first.view.sourceRevision);
    expect(changed.view.build.merged.value).toBe(2);
    at += CODE_HEALTH_OVERVIEW_TTL_MS;
    expect(reader.overview("sample", "30d").rebuilt).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM code_health_overview").get()).toEqual({ n: 1 });
    reader.overview("sample", "7d");
    reader.overview("sample", "90d");
    reader.overview("sample", "7d");
    expect(db.prepare("SELECT COUNT(*) n FROM code_health_overview").get()).toEqual({ n: 3 });
  });

  it("publishes a summary change only when the derived revision changes", async () => {
    merged(1, NOW - DAY, review(1, 1));
    await get("/api/code-health/overview?repo=sample");
    await get("/api/code-health/overview?repo=sample");
    expect(topics).not.toContain("health");
    // A relevant write that does not alter what the page shows rebuilds without publishing.
    db.prepare("UPDATE pull_requests SET title='renamed' WHERE number=1").run();
    await get("/api/code-health/overview?repo=sample");
    expect(topics).not.toContain("health");
    merged(2, NOW - DAY, review(2, 2));
    await get("/api/code-health/overview?repo=sample");
    expect(topics.filter((topic) => topic === "health")).toHaveLength(1);
  });

  it("answers the first read and a repeat each in under a second on a large history", async () => {
    db.exec("BEGIN");
    for (let pr = 1; pr <= 4000; pr++) {
      const id = review(pr, (pr % 3) + 1);
      merged(pr, NOW - (pr % 28) * DAY - 1000, id);
      touch(pr, `src/f${pr % 50}.ts`);
      finding(id, `src/f${pr % 50}.ts`, `cause ${pr % 7}`);
      run(pr, 1.5);
      run(pr, 1.5);
    }
    for (let n = 0; n < 10_000; n++) run(10_000 + n, 1, "other");
    db.exec("COMMIT");
    const timed = async () => {
      const started = performance.now();
      const response = await get("/api/code-health/overview?repo=sample");
      expect(response.statusCode).toBe(200);
      return performance.now() - started;
    };
    expect(await timed()).toBeLessThan(1000);
    expect(await timed()).toBeLessThan(1000);
  });
});
