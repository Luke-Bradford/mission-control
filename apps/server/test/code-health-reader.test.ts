import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CodeHealthView } from "@mc/core";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { CodeHealthReader } from "../src/code-health/read.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 1, 12);
const TOKEN = `operator-fixture-${"a".repeat(48)}`;
const SECRET = `known-fixture-${"b".repeat(48)}`;
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

describe("bounded code-health reads", () => {
  let root: string;
  let store: Store;
  let db: DatabaseSync;
  let app: FastifyInstance;
  let at: number;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mc-code-health-reader-"));
    const path = join(root, "fixture.sqlite");
    store = new Store(path);
    db = new DatabaseSync(path);
    at = NOW;
    app = buildApp({
      config,
      store,
      bus: new ChangeBus(),
      operatorToken: TOKEN,
      knownSecrets: async () => [SECRET],
      now: () => at,
    });
  });
  afterEach(async () => {
    await app.close();
    db.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const headers = { "x-mc-operator": TOKEN };
  function review(id: number, repo = "sample", round = 1, time = NOW - 1000) {
    db.prepare(`INSERT INTO reviews (id, author_run_id, repo_id, seat_id, pr_number, sha,
      epoch, attempt, round, state, created_at, ended_at)
      VALUES (?, ?, ?, 'reviewer', ?, ?, 0, 1, ?, 'reported', ?, ?)`).run(
      id,
      `author-${id}`,
      repo,
      id,
      "a".repeat(40),
      round,
      time,
      time,
    );
  }
  const get = (path: string) => app.inject({ method: "GET", url: path, headers });

  it("requires the operator token and a valid configured repo/window/tab", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/code-health?repo=sample" })).statusCode,
    ).toBe(401);
    expect((await get("/api/code-health?repo=missing")).statusCode).toBe(404);
    for (const suffix of ["&window=365d", "&tab=arbitrary", "&extra=1"])
      expect((await get(`/api/code-health?repo=sample${suffix}`)).statusCode).toBe(400);
    const response = await get("/api/code-health?repo=sample");
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    const view = response.json<CodeHealthView>();
    expect(view.data.tab).toBe("overview");
    expect(view.coverage.map((row) => row.state)).toEqual(["empty", "available"]);
  });

  it("keeps repo/window cohorts separate and unknown denominators explicit", async () => {
    review(1);
    review(2, "sample", 3);
    review(3, "other", 4);
    review(4, "sample", 4, NOW - 31 * 86_400_000);
    const response = await get("/api/code-health?repo=sample&tab=review&window=30d");
    const view = response.json<CodeHealthView>();
    if (view.data.tab !== "review") throw new Error("Wrong tab");
    expect(view.data.review.reviewedPrs).toBe(2);
    expect(view.data.review.rework).toEqual({ numerator: 1, denominator: 2, percent: 50 });
    expect(view.data.review.uncategorised.percent).toBeNull();
    expect(view.coverage[0].complete).toBe(false);
    expect(
      (await get("/api/code-health?repo=other&tab=review")).json().data.review.reviewedPrs,
    ).toBe(1);
  });

  it("fetches only the selected tab and caches across unrelated writes and clock ticks", () => {
    review(1);
    const reader = new CodeHealthReader(store, config, () => at);
    const reviews = vi.spyOn(store, "codeHealthReviews");
    const ci = vi.spyOn(store, "codeHealthCi");
    const first = reader.read("sample", "30d", "review");
    at += 1000;
    store.setSetting("unrelated", "sample");
    expect(reader.read("sample", "30d", "review")).toEqual(first);
    expect(reviews).toHaveBeenCalledTimes(1);
    expect(ci).not.toHaveBeenCalled();
    review(2);
    expect(reader.read("sample", "30d", "review").generatedAt).toBe(at);
    expect(reviews).toHaveBeenCalledTimes(2);
    reader.read("sample", "30d", "test");
    expect(ci).toHaveBeenCalledTimes(1);
  });

  it("pages issued evidence fifty rows at a time without accepting another repo's reference", async () => {
    for (let id = 1; id <= 55; id++) review(id);
    const view = (await get("/api/code-health?repo=sample&tab=review")).json<CodeHealthView>();
    const id = view.evidence[0].id;
    const path = `/api/code-health/evidence/${id}?repo=sample`;
    const first = (await get(path)).json();
    expect(first.rows).toHaveLength(50);
    expect(first.rows[0].pr).toBe(1);
    expect(first.nextCursor).toBe("50");
    const second = (await get(`${path}&cursor=50`)).json();
    expect(second.rows).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect((await get(`/api/code-health/evidence/${id}?repo=other`)).statusCode).toBe(404);
    expect((await get(`${path}&cursor=-1`)).statusCode).toBe(400);
    expect((await get(`${path}&cursor=19999`)).statusCode).toBe(400);
    expect((await get(`${path}&cursor=20000`)).statusCode).toBe(400);
    expect((await get("/api/code-health/evidence/not-issued?repo=sample")).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: path })).statusCode).toBe(401);
  });

  it("refuses stale evidence when its source changed", async () => {
    review(1);
    const view = (await get("/api/code-health?repo=sample&tab=review")).json<CodeHealthView>();
    review(2);
    const response = await get(`/api/code-health/evidence/${view.evidence[0].id}?repo=sample`);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("Refresh");
  });

  it("returns a named collection failure instead of publishing a truncated review denominator", async () => {
    db.exec("BEGIN");
    for (let id = 1; id <= 20_001; id++) review(id);
    db.exec("COMMIT");
    const response = await get("/api/code-health?repo=sample&tab=review");
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toContain("shorter window");
    expect(response.body).not.toContain("reviewedPrs");
  });

  it("redacts known secrets and the operator token from evidence before returning it", async () => {
    review(1);
    db.prepare(`INSERT INTO review_findings (review_id, author_run_id, pos, severity,
      file, line, summary, scenario, fix, state)
      VALUES (1, 'author-1', 0, 'Minor', 'src/example.ts', 1, ?, 'Example', 'Example', 'logged')`).run(
      `${SECRET} ${TOKEN}`,
    );
    const view = (await get("/api/code-health?repo=sample&tab=review")).json<CodeHealthView>();
    const response = await get(`/api/code-health/evidence/${view.evidence[1].id}?repo=sample`);
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain(SECRET);
    expect(response.body).not.toContain(TOKEN);
    expect(response.json().rows[0].summary).toBe("[redacted] [redacted]");
  });

  it("names missing histories and test collection instead of manufacturing zero rates", async () => {
    const risk = (await get("/api/code-health?repo=sample&tab=risk")).json<CodeHealthView>();
    expect(risk.coverage.every((row) => ["not-collected", "empty"].includes(row.state))).toBe(true);
    const test = (await get("/api/code-health?repo=sample&tab=test")).json<CodeHealthView>();
    if (test.data.tab !== "test") throw new Error("Wrong tab");
    expect(test.data.namedTestRate).toBeNull();
    expect(test.data.mixedJobCandidates).toBeNull();
    expect(test.coverage.some((row) => row.note.includes("undocumented duration units"))).toBe(
      true,
    );
  });

  it("fails closed when the known-secret provider cannot be read", async () => {
    const broken = buildApp({
      config,
      store,
      bus: new ChangeBus(),
      operatorToken: TOKEN,
      knownSecrets: async () => {
        throw new Error("private provider detail");
      },
      now: () => at,
    });
    try {
      const response = await broken.inject({
        method: "GET",
        url: "/api/code-health?repo=sample",
        headers,
      });
      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("private provider detail");
      expect(response.body).not.toContain('"data"');
    } finally {
      await broken.close();
    }
  });

  it("gives each file's counted findings their own repo/window/path-scoped evidence", () => {
    review(1);
    review(2, "other");
    const insert = db.prepare(`INSERT INTO review_findings (review_id, author_run_id, pos,
      severity, file, line, summary, scenario, fix, state)
      VALUES (?, ?, ?, 'Minor', ?, 1, 'Example', 'Example', 'Example', 'logged')`);
    insert.run(1, "author-1", 0, "src/example.ts");
    insert.run(1, "author-1", 1, "src/other.ts");
    insert.run(2, "author-2", 0, "src/example.ts");
    const checkout = "/example/checkouts/sample";
    store.mapCachePut(
      "tree",
      checkout,
      "a".repeat(40),
      JSON.stringify({
        tree: [{ path: "src/example.ts", lines: 100 }],
        imports: [],
      }),
      true,
    );
    const reader = new CodeHealthReader(
      store,
      {
        ...config,
        crew: {
          worktrees: "/example/worktrees",
          maxSeats: 4,
          sessions: [{ id: "sample", repoId: "sample", checkout, seats: [] }],
        },
      },
      () => at,
    );
    const view = reader.read("sample", "30d", "risk");
    if (view.data.tab !== "risk") throw new Error("Wrong tab");
    const file = view.data.files[0];
    expect(file.findings).toBe(1);
    const pages = file.evidence.map((ref) => reader.evidence("sample", ref.id, undefined));
    const findings = pages.find((page) => page.kind === "findings");
    expect(findings?.rows).toHaveLength(1);
    expect(findings?.rows[0]).toMatchObject({ file: "src/example.ts", pr: 1 });
  });

  it("refreshes cached summaries after nested evidence references are evicted", () => {
    const repos = Array.from({ length: 14 }, (_, i) => ({ ...config.repos[0], id: `repo-${i}` }));
    const sessions = repos.map((repo) => ({
      id: repo.id,
      repoId: repo.id,
      checkout: `/example/checkouts/${repo.id}`,
      seats: [],
    }));
    for (const [i, session] of sessions.entries()) {
      review(i + 1, session.repoId);
      store.mapCachePut(
        "tree",
        session.checkout,
        "a".repeat(40),
        JSON.stringify({
          tree: Array.from({ length: 50 }, (_, n) => ({
            path: `src/file-${n}.ts`,
            lines: 100 - n,
          })),
        }),
        true,
      );
    }
    const reader = new CodeHealthReader(
      store,
      {
        ...config,
        repos,
        crew: {
          worktrees: "/example/worktrees",
          maxSeats: 4,
          sessions,
        },
      },
      () => at,
    );
    const first = reader.read("repo-0", "7d", "risk");
    if (first.data.tab !== "risk") throw new Error("Wrong tab");
    const old = first.data.files[0].evidence[1].id;
    for (const repo of repos)
      for (const window of ["7d", "30d", "90d"] as const) reader.read(repo.id, window, "risk");
    expect(() => reader.evidence("repo-0", old, undefined)).toThrow(/unavailable/);
    const refreshed = reader.read("repo-0", "7d", "risk");
    if (refreshed.data.tab !== "risk") throw new Error("Wrong tab");
    const current = refreshed.data.files[0].evidence[1].id;
    expect(current).not.toBe(old);
    expect(() => reader.evidence("repo-0", current, undefined)).not.toThrow();
  });
});
