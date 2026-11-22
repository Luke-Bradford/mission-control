import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 22, 12);

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

type Db = {
  exec(sql: string): void;
  prepare(s: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] };
};
const db = () => (store as unknown as { db: Db }).db;

/** A database the shape of the live one: many runs, and many old `run` snapshots per run. */
function seed(runs: number, snapshotsPerRun: number) {
  db().exec("BEGIN");
  const addRun = db().prepare(
    `INSERT INTO runs (id, agent_id, repo_id, seq, started_at, ended_at, status, ticket, transcript_path,
       model, prompt_hash, tokens, cost_usd)
     VALUES (?, ?, 'repo', ?, ?, ?, 'done', ?, '/x', ?, ?, '{"input":100,"output":50}', 1)`,
  );
  const addAttempt = db().prepare(
    "INSERT INTO run_attempts (run_id, kind, at, data) VALUES (?, ?, ?, ?)",
  );
  const padding = "x".repeat(600);
  for (let i = 0; i < runs; i++) {
    const startedAt = NOW - 80 * DAY + Math.floor((i / runs) * 80 * DAY);
    const id = `run-${i}`;
    addRun.run(
      id,
      `seat-${i % 6}`,
      i,
      startedAt,
      startedAt + 600_000,
      `repo#${i % 200}`,
      i % 50 < 25 ? "m1" : "m2",
      `p${Math.floor(i / 400)}`,
    );
    for (let s = 0; s < snapshotsPerRun; s++)
      addAttempt.run(id, "run", startedAt + s, JSON.stringify({ model: "m", padding, s }));
    addAttempt.run(
      id,
      "loop",
      startedAt + 1,
      JSON.stringify(i % 20 === 0 ? { phase: "ci", hold: { kind: "x" } } : { phase: null }),
    );
  }
  db().exec("COMMIT");
}

describe("the Audit read on a large database", () => {
  it("answers a 30 day range in under a second", () => {
    seed(3000, 30);
    const started = performance.now();
    const view = store.audit(NOW - 30 * DAY, NOW, new Map());
    expect(performance.now() - started).toBeLessThan(1000);
    expect(view.deathLoops.length).toBeGreaterThan(0);
  });

  it("has the indexes its readers need on run_attempts", () => {
    const names = (
      db()
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
        .all("run_attempts") as { name: string }[]
    ).map((r) => r.name);
    expect(names).toContain("run_attempts_kind_at");
    expect(names).toContain("run_attempts_run_kind");
  });

  it("leaves the event loop free between sections: no turn waits over 100 ms", async () => {
    seed(3000, 30);
    let longest = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const t = performance.now();
      longest = Math.max(longest, t - last);
      last = t;
    }, 1);
    const view = await store.auditStepped(NOW - 30 * DAY, NOW, new Map());
    clearInterval(timer);
    longest = Math.max(longest, performance.now() - last);
    expect(view.range.until).toBe(NOW);
    expect(longest).toBeLessThanOrEqual(100);
  });

  it("builds the same view stepped as in one go", async () => {
    seed(300, 3);
    const one = store.audit(NOW - 30 * DAY, NOW, new Map());
    const stepped = await store.auditStepped(NOW - 30 * DAY, NOW, new Map());
    expect(stepped).toEqual(one);
  });

  it("measures a change against the seat's last run before the range", () => {
    const add = (id: string, at: number, model: string) =>
      db()
        .prepare(
          `INSERT INTO runs (id, agent_id, repo_id, seq, started_at, status, transcript_path, model)
           VALUES (?, 'seat-a', 'repo', 1, ?, 'done', '/x', ?)`,
        )
        .run(id, at, model);
    add("old", NOW - 200 * DAY, "m1");
    add("before", NOW - 40 * DAY, "m1");
    add("in", NOW - 10 * DAY, "m2");
    const changes = store.audit(NOW - 30 * DAY, NOW, new Map()).changes;
    expect(changes.map((c) => [c.kind, c.from, c.to])).toEqual([["model", "m1", "m2"]]);
  });
});

/** A crew whose seats change prompt and model every few runs: the worst case for the changes list. */
it("reads 30 days of Audit with thousands of prompt and model changes in under a second", () => {
  const own = new Store(":memory:");
  const db = (own as unknown as { db: import("node:sqlite").DatabaseSync }).db;
  db.exec("BEGIN");
  const run = db.prepare(
    `INSERT INTO runs (id, agent_id, repo_id, seq, started_at, ended_at, status, ticket, transcript_path,
       model, prompt_hash, cost_usd) VALUES (?, ?, 'repo', ?, ?, ?, 'done', ?, '/x', ?, ?, ?)`,
  );
  const runs = 20_000;
  for (let i = 0; i < runs; i++) {
    const at = NOW - 100 * DAY + Math.floor((i / runs) * 100 * DAY);
    run.run(
      `r${i}`,
      `seat-${i % 12}`,
      i,
      at,
      at + 600_000,
      `repo#${i % 900}`,
      `m${Math.floor(i / 7) % 3}`,
      `p${Math.floor(i / 5)}`,
      1 + (i % 17),
    );
  }
  const pr = db.prepare(
    "INSERT INTO pr_history (repo_id, number, merged_at, record) VALUES (?, ?, ?, ?)",
  );
  for (let i = 0; i < 2_500; i++) {
    const at = NOW - 100 * DAY + Math.floor((i / 2_500) * 100 * DAY);
    pr.run("repo", i, at, JSON.stringify({ number: i, ticket: `repo#${i % 900}`, mergedAt: at }));
  }
  db.exec("COMMIT");
  const started = performance.now();
  const audit = own.audit(NOW - 30 * DAY, NOW, new Map());
  const took = performance.now() - started;
  own.close();
  expect(audit.changes?.length).toBeGreaterThan(1_000);
  expect(took).toBeLessThan(1_000);
}, 60_000);
