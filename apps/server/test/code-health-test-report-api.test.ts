import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { FLIGHT_OPERATOR_ACTOR_HEADER } from "../src/flight/operator-call.ts";
import { RunTokens } from "../src/mcp/tokens.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 2, 12),
  TOKEN = `operator-fixture-${"a".repeat(48)}`,
  SECRET = `known-fixture-${"b".repeat(48)}`;
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  loops: [],
  repos: [{ id: "sample", github: "example/sample", project: 1, statusMap: {}, autonomy: "draft" }],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};
const headers = { "x-mc-operator": TOKEN };
function report() {
  return {
    version: 1,
    repo: "sample",
    headSha: "a".repeat(40),
    workflow: "CI",
    workflowRun: "101",
    job: "unit",
    jobRun: "201",
    runAttempt: 1,
    environment: "linux-node25",
    completedAt: NOW - 1,
    expectedAttempts: 1,
    cases: [
      {
        testId: "test-a",
        file: "test/example.test.ts",
        suite: "example",
        name: "does the work",
        attemptId: "test-a:1",
        executionOrder: 1,
        state: "passed",
        completedAt: NOW - 2,
        duration: 100,
        durationUnit: "ms",
      },
    ],
  };
}
describe("authenticated result-data import", () => {
  let app: FastifyInstance, store: Store, bus: ChangeBus, events: string[];
  let known: () => Promise<readonly string[]>;
  beforeEach(() => {
    store = new Store(":memory:");
    bus = new ChangeBus();
    events = [];
    bus.subscribe((topic) => events.push(topic));
    known = async () => [SECRET];
    app = buildApp({
      config,
      store,
      bus,
      operatorToken: TOKEN,
      knownSecrets: () => known(),
      now: () => NOW,
    });
  });
  afterEach(async () => {
    await app.close();
    store.close();
  });
  const send = (payload: unknown, auth = headers) =>
    app.inject({
      method: "POST",
      url: "/api/code-health/test-reports",
      headers: auth,
      payload: payload as object,
    });
  const count = () => store.codeHealthTestAttempts("sample", NOW - 1000, NOW).reports;
  it("requires operator authentication before ingesting a configured repo's data", async () => {
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/code-health/test-reports",
          payload: report(),
        })
      ).statusCode,
    ).toBe(401);
    expect((await send({ ...report(), repo: "other" })).statusCode).toBe(404);
    expect(count()).toBe(0);
  });
  it("records the authenticated actor, emits one invalidation and returns a durable replay", async () => {
    const first = await send(report());
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ attempts: 1, reused: false });
    const replay = await send(report());
    expect(replay.statusCode).toBe(200);
    expect(replay.json().id).toBe(first.json().id);
    expect(events.filter((topic) => topic === "health")).toHaveLength(1);
    expect(store.codeHealthTestAttempts("sample", NOW - 1000, NOW).rows[0].actor).toBe("operator");
  });
  it("refuses malformed and oversized payloads without a file or URL import path", async () => {
    expect(
      (await send({ ...report(), url: "https://example.test/untrusted-report" })).statusCode,
    ).toBe(400);
    expect((await send({ blob: "x".repeat(1024 * 1024) })).statusCode).toBe(413);
    expect(count()).toBe(0);
  });
  it("fails closed when known-secret lookup fails and returns no private error text", async () => {
    known = async () => {
      throw new Error(SECRET);
    };
    const result = await send(report());
    expect(result.statusCode).toBe(503);
    expect(result.body).not.toContain(SECRET);
    expect(count()).toBe(0);
  });
  it("redacts source labels before durable storage", async () => {
    const value = report();
    value.workflow = SECRET;
    value.cases[0].name = SECRET;
    expect((await send(value)).statusCode).toBe(201);
    const source = store.codeHealthTestAttempts("sample", NOW - 1000, NOW);
    expect(JSON.stringify(source)).not.toContain(SECRET);
    expect(source.rows[0].name).toBe("[redacted]");
  });
  it.each(["operator", "flight"])(
    "links exact-head reviewer evidence with authenticated %s attribution",
    async (actor) => {
      const actorHeaders =
        actor === "flight"
          ? {
              ...headers,
              [FLIGHT_OPERATOR_ACTOR_HEADER]: JSON.stringify({
                seatId: "flight",
                runId: "flight-run",
              }),
            }
          : headers;
      if (actor === "flight") {
        await app.close();
        const flightConfig: CcConfig = {
          ...config,
          crew: {
            maxSeats: 1,
            worktrees: "/fixture/worktrees",
            sessions: [
              {
                id: "sample",
                repoId: "sample",
                checkout: "/fixture/clone",
                seats: [
                  { id: "flight", role: "FLIGHT", accountId: "account", model: "opus", area: [] },
                ],
              },
            ],
          },
        };
        store.upsertRun({
          id: "flight-run",
          agentId: "flight",
          repoId: "sample",
          seq: 1,
          startedAt: NOW - 10,
          endedAt: null,
          status: "running",
          sessionId: null,
          model: "opus",
          branch: null,
          ticket: null,
          costUsd: 0,
          tokens: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
          transcriptPath: "/fixture/transcript.jsonl",
          prs: [],
          summary: null,
        });
        app = buildApp({
          config: flightConfig,
          store,
          bus,
          operatorToken: TOKEN,
          knownSecrets: () => known(),
          now: () => NOW,
        });
      }
      expect((await send(report(), actorHeaders)).statusCode).toBe(201);
      expect(store.codeHealthTestAttempts("sample", NOW - 1000, NOW).rows[0].actor).toBe(actor);
      const observed = store.codeHealthTestAttempts("sample", NOW - 1000, NOW).rows[0];
      const reviewId = store.requestReview({
        authorRunId: "fixture-author",
        repoId: "sample",
        seatId: "fixture-reviewer",
        prNumber: 7,
        sha: "a".repeat(40),
        epoch: 0,
        attempt: 1,
        round: 1,
        at: NOW - 10,
      });
      if (!reviewId) throw new Error("Missing review fixture");
      store.setReviewState(reviewId, ["queued"], "running", {
        runId: "fixture-review",
        at: NOW - 9,
      });
      store.recordFindings(reviewId, "fixture-review", {
        verdict: { spec: "fail", quality: "fail" },
        summary: "The expected response no longer matches the specified behavior.",
        findings: [
          {
            severity: "Important",
            category: "test-stale",
            file: "test/example.test.ts",
            line: 8,
            summary: "The assertion describes a removed response field.",
            scenario: "The current API omits that field, while this assertion still requires it.",
            fix: "Assert the documented replacement field and keep the authorization case.",
          },
        ],
        at: NOW - 8,
      });
      const body = {
        repo: "sample",
        testId: observed.test_id,
        headSha: "a".repeat(40),
        reviewId,
        findingPosition: 0,
        judgement: "stale",
        specEvidence:
          "The documented response replaced the old field; the test still asserts that removed field.",
      };
      const qa = (payload: object, auth = actorHeaders) =>
        app.inject({ method: "POST", url: "/api/code-health/test-qa", headers: auth, payload });
      expect((await qa(body, {} as typeof headers)).statusCode).toBe(401);
      expect((await qa({ ...body, headSha: "b".repeat(40) })).statusCode).toBe(400);
      expect((await qa({ ...body, repo: "other" })).statusCode).toBe(404);
      expect((await qa({ ...body, reviewer: "caller-supplied-reviewer" })).statusCode).toBe(400);
      const saved = await qa(body);
      expect(saved.statusCode).toBe(201);
      expect((await qa(body)).statusCode).toBe(200);
      expect(store.codeHealthTestQa("sample", NOW - 1000, NOW + 1).rows[0]).toMatchObject({
        reviewer: "fixture-reviewer",
        actor,
        review_id: reviewId,
        finding_position: 0,
        file: "test/example.test.ts",
        line: 8,
      });
      expect(store.codeHealthTestAttempts("sample", NOW - 1000, NOW).rows).toHaveLength(1);
      expect(store.codeHealthTestAttempts("sample", NOW - 1000, NOW).rows[0].state).toBe("passed");
    },
  );
  it("does not accept a seat bearer or an unconfigured operator identity for ingestion", async () => {
    const tokens = new RunTokens();
    const bearer = tokens.issue("fixture-seat", "fixture-run");
    const keyed = buildApp({
      config,
      store,
      bus,
      operatorToken: TOKEN,
      tokens,
      knownSecrets: async () => [],
    });
    const unkeyed = buildApp({ config, store, bus });
    try {
      expect(
        (
          await keyed.inject({
            method: "POST",
            url: "/api/code-health/test-reports",
            headers: { ...headers, authorization: `Bearer ${bearer}` },
            payload: report(),
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await unkeyed.inject({
            method: "POST",
            url: "/api/code-health/test-reports",
            payload: report(),
          })
        ).statusCode,
      ).toBe(401);
      expect(count()).toBe(0);
    } finally {
      await keyed.close();
      await unkeyed.close();
    }
  });
});
