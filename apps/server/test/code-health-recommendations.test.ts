import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { RecommendationMutation } from "../src/code-health/recommendations.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 2),
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
  function review(id: number, pr: number, round = 1) {
    db.prepare(
      `INSERT INTO reviews(id,author_run_id,repo_id,seat_id,pr_number,sha,epoch,attempt,round,state,created_at,ended_at)VALUES(?,?,'sample','reviewer',?,?,0,1,?,'reported',?,?)`,
    ).run(id, `run-${id}`, pr, "a".repeat(40), round, NOW - 1000, NOW - 1000);
  }
  function finding(
    review: number,
    pos: number,
    file = "src/example.ts",
    category: string | null = "spec",
  ) {
    db.prepare(
      `INSERT INTO review_findings(review_id,author_run_id,pos,severity,file,line,summary,scenario,fix,category,state)VALUES(?,?,?,'Minor',?,1,'Example','Example','Example',?,'open')`,
    ).run(review, `run-${review}`, pos, file, category);
  }
  function proposal() {
    store.refreshCodeHealthRecommendations("sample", NOW);
    return present(store.codeHealthRecommendations("sample")[0]);
  }
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
    expect(rows.find((r) => r.rule === "recurring-correction")?.target.baseline).toBe(4);
    expect(store.codeHealthRecommendations("other")).toEqual([]);
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
  it("narrows recurring-correction evidence to the actual category/file", async () => {
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
      expect(page.rows).toHaveLength(3);
      expect(
        page.rows.every(
          (r: { file: string; category: string }) =>
            r.file === "src/example.ts" && r.category === "spec",
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
