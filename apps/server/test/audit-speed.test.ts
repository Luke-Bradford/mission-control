import { expect, it } from "vitest";
import { Store } from "../src/store.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 20, 12);

/** A crew whose seats change prompt and model every few runs: the worst case for the changes list. */
it("reads 30 days of Audit with thousands of prompt and model changes in under a second", () => {
  const store = new Store(":memory:");
  const db = (store as unknown as { db: import("node:sqlite").DatabaseSync }).db;
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
  const audit = store.audit(NOW - 30 * DAY, NOW, new Map());
  const took = performance.now() - started;
  store.close();
  expect(audit.changes?.length).toBeGreaterThan(1_000);
  expect(took).toBeLessThan(1_000);
}, 60_000);
