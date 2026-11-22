import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runTrial } from "../src/cli/model-trial.ts";
import { Store } from "../src/store.ts";

const NOW = Date.UTC(2026, 10, 20);
let dir: string;
let db: string;
let clone: string;
let sha: string;
let bin: string;
let raw: { db: { prepare(sql: string): { run(...a: (string | number | null)[]): unknown } } };

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: clone, encoding: "utf8" }).trim();
const hash = () => createHash("sha256").update(readFileSync(db)).digest("hex");

/** A fake claude that reads stdin and prints `reply` with the cost. */
function fakeClaude(reply: unknown, cost: number) {
  const body = JSON.stringify({ result: JSON.stringify(reply), total_cost_usd: cost });
  writeFileSync(
    join(bin, "claude"),
    `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${body.replace(/'/g, "'\\''")}'\n`,
  );
  chmodSync(join(bin, "claude"), 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-trial-"));
  bin = join(dir, "bin");
  mkdirSync(bin);
  clone = join(dir, "clone");
  mkdirSync(clone);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  writeFileSync(join(clone, "a.ts"), "one\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-qb", "feature");
  writeFileSync(join(clone, "a.ts"), "one\ntwo\n");
  git("commit", "-qam", "change");
  sha = git("rev-parse", "HEAD");

  db = join(dir, "mc.db");
  const store = new Store(db);
  raw = store as unknown as typeof raw;
  const run = (id: string, model: string, summary: string | null = null) =>
    store.upsertRun({
      id,
      agentId: id.split(":")[0] ?? id,
      repoId: "mc",
      seq: 1,
      startedAt: NOW - 1000,
      endedAt: NOW,
      status: "ok",
      sessionId: null,
      model,
      branch: null,
      ticket: "mc#1",
      costUsd: 1,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary,
      loopKind: "review",
    });
  run("retro:1", "opus-5.5");
  run("flight:1", "opus-5.5");
  run("flight:2", "opus-5.5");
  store.upsertRun({
    id: "guido-1:1",
    agentId: "guido-1",
    repoId: "mc",
    seq: 1,
    startedAt: NOW - 2000,
    endedAt: NOW,
    status: "ok",
    sessionId: null,
    model: "sonnet-5.5",
    branch: null,
    ticket: "mc#1",
    costUsd: 1,
    tokens: null,
    transcriptPath: "",
    prs: [],
    summary: "Added the table.",
    loopKind: "build",
  });
  const id = store.requestReview({
    authorRunId: "guido-1:1",
    repoId: "mc",
    seatId: "retro",
    prNumber: 9,
    sha,
    epoch: 0,
    attempt: 1,
    round: 1,
    at: NOW,
  }) as number;
  store.setReviewState(id, ["queued"], "reported", { at: NOW, runId: "retro:1" });
  raw.db
    .prepare("UPDATE reviews SET blocking = 2, ended_at = ?, run_id = 'retro:1' WHERE id = ?")
    .run(NOW, id);
  const f = raw.db.prepare(
    `INSERT INTO review_findings (review_id, author_run_id, pos, severity, file, line, summary, scenario, fix, state)
     VALUES (?, 'guido-1:1', ?, ?, ?, ?, 's', 'x', 'f', 'open')`,
  );
  f.run(id, 0, "Critical", "a.ts", 5);
  f.run(id, 1, "Important", "b.ts", 50);
  raw.db
    .prepare(
      "INSERT INTO pr_history (repo_id, number, merged_at, record) VALUES ('mc', 9, ?, '{}')",
    )
    .run(NOW);
  // two wakes: one acted on, one only waited
  const wake = raw.db.prepare(
    "INSERT INTO flight_wakes (run_id, at, reasons, wake_id) VALUES (?, ?, ?, ?)",
  );
  wake.run("flight:1", NOW, "a seat called", "w1");
  wake.run("flight:1", NOW + 1, "usage sample", "w2");
  const dec = raw.db.prepare(
    "INSERT INTO flight_decisions (at, kind, about, decision, basis, wake_id) VALUES (?, ?, 'x', 'd', 'b', ?)",
  );
  dec.run(NOW, "answer", "w1");
  dec.run(NOW + 1, "wait", "w2");
  // newer wakes of another repository's FLIGHT must not count
  raw.db.prepare("UPDATE runs SET repo_id = 'other' WHERE id = 'flight:2'").run();
  wake.run("flight:2", NOW + 9, "foreign wake", "w3");
  dec.run(NOW + 9, "answer", "w3");
  store.close();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const opts = (mode: "review" | "wake" | "summary", over = {}) => ({
  mode,
  db,
  repo: "mc",
  clone,
  model: "sonnet-5.5",
  effort: undefined,
  baseline: "opus",
  count: 20,
  path: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  ...over,
});

describe("model trial", () => {
  it("review trial scores catches and cost without writing", async () => {
    fakeClaude(
      { findings: [{ severity: "Important", file: "a.ts", line: 8, summary: "x" }] },
      0.12,
    );
    const before = hash();
    const out = await runTrial(opts("review"));
    expect(out).toContain("Caught 1 of 2 blocking findings");
    expect(out).toContain("Cost $0.12");
    expect(out).toMatch(/^Decision:\s*$/m);
    expect(hash()).toBe(before);
  });

  it("does not count a finding more than 10 lines away, or a minor one", async () => {
    fakeClaude(
      {
        findings: [
          { severity: "Minor", file: "a.ts", line: 5, summary: "x" },
          { severity: "Important", file: "b.ts", line: 70, summary: "x" },
        ],
      },
      0.01,
    );
    expect(await runTrial(opts("review"))).toContain("Caught 0 of 2 blocking findings");
  });

  it("counts only completed replays and reports the skipped one and the shortfall", async () => {
    // a newer eligible review whose commit is not in the clone
    const w = new DatabaseSync(db);
    w.prepare(
      `INSERT INTO reviews (author_run_id, repo_id, seat_id, pr_number, sha, epoch, attempt, round, state, run_id, blocking, created_at, ended_at)
       VALUES ('guido-1:1', 'mc', 'retro', 10, ?, 0, 1, 1, 'reported', 'retro:1', 1, ?, ?)`,
    ).run("f".repeat(40), NOW + 5, NOW + 5);
    w.prepare(
      "INSERT INTO pr_history (repo_id, number, merged_at, record) VALUES ('mc', 10, ?, '{}')",
    ).run(NOW);
    w.close();
    fakeClaude({ findings: [] }, 0.01);
    const out = await runTrial(opts("review", { count: 2 }));
    expect(out).toContain("over 1 completed reviews");
    expect(out).toContain("1 completed, 2 eligible, 1 skipped");
    expect(out).toContain("Shortfall: 1 completed of the 2 asked for");
    const full = await runTrial(opts("review", { count: 1 }));
    expect(full).toContain("1 completed, 2 eligible, 1 skipped");
    expect(full).not.toContain("Shortfall");
  });

  it("wake trial counts false waits", async () => {
    fakeClaude({ action: "wait" }, 0.001);
    const out = await runTrial(opts("wake", { model: "haiku-5.5" }));
    expect(out).toContain("False waits: 1");
    expect(out).toContain("Agreement: 1 of 2");
    expect(out).toMatch(/^Decision:\s*$/m);
  });

  it("wake trial ignores other repositories' wakes", async () => {
    fakeClaude({ action: "act" }, 0.001);
    const out = await runTrial(opts("wake", { model: "haiku-5.5" }));
    expect(out).toContain("Agreement: 1 of 2");
    expect(out).not.toContain("w3");
    expect(out).toContain("Cost $0.00");
  });

  it("does not score malformed replies, and reports them", async () => {
    for (const body of [
      "I cannot help with that.",
      '{"findings":{}}',
      '{"findings":[{"severity":"Huge","file":"a.ts","line":1}]}',
      '{"findings":[',
      '{"findings":[{"severity":"Important","file":"a.ts","line":-1}]}',
      '{"findings":[{"severity":"Important","file":"a.ts","line":5.5}]}',
    ]) {
      writeFileSync(
        join(bin, "claude"),
        `#!/bin/sh\ncat >/dev/null\nprintf '%s' '${JSON.stringify({ result: body, total_cost_usd: 0.05 }).replace(/'/g, "'\\''")}'\n`,
      );
      chmodSync(join(bin, "claude"), 0o755);
      const out = await runTrial(opts("review"));
      expect(out).toContain("over 0 completed reviews");
      expect(out).toContain("1 failed (unusable reply)");
      expect(out).toContain("Cost $0.05");
      const wake = await runTrial(opts("wake", { model: "haiku-5.5" }));
      expect(wake).toContain("Agreement: 0 of 0");
      expect(wake).toContain("0 scored, 2 failed");
      expect(wake).toContain("False waits: 0");
    }
  });

  it("replays a PR merged with a merge commit with its real diff", async () => {
    git("checkout", "-q", "main");
    git("merge", "--no-ff", "-qm", "merge pr", "feature");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    // a fake reviewer that only catches the finding when the changed line is in the prompt
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\nif grep -q '^+two' ; then printf '%s' '${JSON.stringify({ result: JSON.stringify({ findings: [{ severity: "Critical", file: "a.ts", line: 5, summary: "x" }] }), total_cost_usd: 0.01 })}'; else printf '%s' '${JSON.stringify({ result: '{"findings":[]}', total_cost_usd: 0.01 })}'; fi\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    expect(await runTrial(opts("review"))).toContain("Caught 1 of 2 blocking findings");
  });

  it("leaves out changes added to main before the merge", async () => {
    git("checkout", "-q", "main");
    writeFileSync(join(clone, "unrelated.ts"), "other\n");
    git("add", ".");
    git("commit", "-qm", "unrelated");
    git("merge", "--no-ff", "-qm", "merge pr", "feature");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    // the fake reviewer finds nothing when the prompt carries the unrelated file
    writeFileSync(
      join(bin, "claude"),
      `#!/bin/sh\nif grep -q 'unrelated.ts' ; then printf '%s' '${JSON.stringify({ result: '{"findings":[]}', total_cost_usd: 0.01 })}'; else printf '%s' '${JSON.stringify({ result: JSON.stringify({ findings: [{ severity: "Critical", file: "a.ts", line: 5, summary: "x" }] }), total_cost_usd: 0.01 })}'; fi\n`,
    );
    chmodSync(join(bin, "claude"), 0o755);
    expect(await runTrial(opts("review"))).toContain("Caught 1 of 2 blocking findings");
  });

  it("summary trial shows the line beside the stored summary", async () => {
    fakeClaude({ summary: "Built the table." }, 0.002);
    const out = await runTrial(opts("summary", { model: "haiku-5.5" }));
    expect(out).toContain("Added the table.");
    expect(out).toContain("Built the table.");
  });
});
