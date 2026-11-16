import { AUDIT_LIST_CAP, capAudit } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 8, 12);

let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());

const raw = (sql: string, ...args: (string | number | null)[]) =>
  (store as unknown as { db: { prepare(s: string): { run(...a: unknown[]): unknown } } }).db
    .prepare(sql)
    .run(...args);

let nextReview = 1;
/** A recorded review round on `pr` by the run `runId` (ticket `repo#t`), with one finding. */
function round(o: {
  runId: string;
  ticket: string;
  pr: number;
  n: number;
  spec: "pass" | "fail";
  quality: "pass" | "fail";
  text: string;
  ageDays: number;
  doneWhen?: readonly string[];
}) {
  if (o.doneWhen !== undefined || !store.runDoneWhen(o.runId).length) {
    raw(
      `INSERT OR IGNORE INTO runs (id, agent_id, repo_id, seq, started_at, status, ticket, transcript_path)
       VALUES (?, 'guido-1', 'repo', 1, ?, 'done', ?, '/x')`,
      o.runId,
      NOW - 60 * DAY,
      o.ticket,
    );
    if (o.doneWhen !== undefined) store.setRunDoneWhen(o.runId, o.doneWhen);
  }
  const id = nextReview++;
  const at = NOW - o.ageDays * DAY;
  raw(
    `INSERT INTO reviews (id, author_run_id, repo_id, seat_id, pr_number, sha, epoch, attempt, round,
       state, verdict, summary, blocking, minor, created_at, ended_at)
     VALUES (?, ?, 'repo', 'retro-1', ?, ?, 1, 1, ?, 'reported', ?, 'sum', 1, 0, ?, ?)`,
    id,
    o.runId,
    o.pr,
    `sha${id}`,
    o.n,
    JSON.stringify({ spec: o.spec, quality: o.quality }),
    at,
    at,
  );
  raw(
    `INSERT INTO review_findings (review_id, author_run_id, pos, severity, file, line, summary, scenario, fix, state)
     VALUES (?, ?, 0, 'Important', 'a.ts', 1, ?, '', '', 'open')`,
    id,
    o.runId,
    o.text,
  );
}

const bounces = (days = 30) => store.audit(NOW - days * DAY, NOW, new Map()).specBounces;

describe("specBounces", () => {
  it("returns spec-failed rounds per ticket and PR with cause and round count, not quality-only", () => {
    const base = {
      ticket: "repo#7",
      pr: 70,
      spec: "fail",
      quality: "pass",
      doneWhen: ["x"],
    } as const;
    round({ ...base, runId: "r7", n: 1, text: "This is outside the ticket.", ageDays: 5 });
    round({ ...base, runId: "r7", n: 2, text: "Still outside the ticket's scope.", ageDays: 4 });
    round({
      runId: "r8",
      ticket: "repo#8",
      pr: 80,
      n: 1,
      spec: "pass",
      quality: "fail",
      text: "Naming is poor",
      ageDays: 3,
      doneWhen: ["x"],
    });
    round({
      runId: "r9",
      ticket: "repo#9",
      pr: 90,
      n: 1,
      spec: "pass",
      quality: "pass",
      text: "fine",
      ageDays: 3,
      doneWhen: ["x"],
    });
    const out = bounces();
    expect(out?.rows).toHaveLength(1);
    expect(out?.rows[0]).toMatchObject({
      repoId: "repo",
      ticket: "repo#7",
      pr: 70,
      cause: "scope-wider",
      rounds: 2,
    });
    expect(out?.rows[0].findings).toEqual([
      "This is outside the ticket.",
      "Still outside the ticket's scope.",
    ]);
  });

  it("classifies each cause, and a ticket with no Done-when lines lacks one", () => {
    const f = { spec: "fail", quality: "pass", n: 1, ageDays: 2 } as const;
    round({
      ...f,
      runId: "a",
      ticket: "repo#1",
      pr: 1,
      text: "Beyond the ticket.",
      doneWhen: ["x"],
    });
    round({
      ...f,
      runId: "b",
      ticket: "repo#2",
      pr: 2,
      text: "No mockup link given.",
      doneWhen: ["x"],
    });
    round({
      ...f,
      runId: "c",
      ticket: "repo#3",
      pr: 3,
      text: "The wording is ambiguous.",
      doneWhen: ["x"],
    });
    round({
      ...f,
      runId: "d",
      ticket: "repo#4",
      pr: 4,
      text: "No done-when covers this.",
      doneWhen: ["x"],
    });
    round({ ...f, runId: "e", ticket: "repo#5", pr: 5, text: "Wrong header.", doneWhen: ["x"] });
    round({ ...f, runId: "g", ticket: "repo#6", pr: 6, text: "Wrong header.", doneWhen: [] });
    const cause = Object.fromEntries((bounces()?.rows ?? []).map((r) => [r.ticket, r.cause]));
    expect(cause).toEqual({
      "repo#1": "scope-wider",
      "repo#2": "missing-reference",
      "repo#3": "ambiguous-wording",
      "repo#4": "no-done-when",
      "repo#5": "other",
      "repo#6": "no-done-when",
    });
  });

  it("counts rounds per cause over 7 and 30 days", () => {
    const f = { spec: "fail", quality: "pass", doneWhen: ["x"] } as const;
    round({ ...f, runId: "a", ticket: "repo#1", pr: 1, n: 1, text: "Wrong header.", ageDays: 3 });
    round({ ...f, runId: "b", ticket: "repo#2", pr: 2, n: 1, text: "Wrong header.", ageDays: 20 });
    round({ ...f, runId: "c", ticket: "repo#3", pr: 3, n: 1, text: "Out of scope.", ageDays: 20 });
    round({ ...f, runId: "d", ticket: "repo#4", pr: 4, n: 1, text: "Wrong header.", ageDays: 40 });
    const counts = Object.fromEntries(
      (bounces(90)?.counts ?? []).map((c) => [c.cause, [c.days7, c.days30]]),
    );
    expect(counts.other).toEqual([1, 2]);
    expect(counts["scope-wider"]).toEqual([0, 1]);
    expect(counts["no-done-when"]).toEqual([0, 0]);
  });

  it("is cut to the list cap by capAudit", () => {
    for (let i = 0; i < AUDIT_LIST_CAP + 2; i++)
      round({
        runId: `r${i}`,
        ticket: `repo#${i}`,
        pr: i,
        n: 1,
        spec: "fail",
        quality: "pass",
        text: "x",
        ageDays: 1,
        doneWhen: ["x"],
      });
    const capped = capAudit(store.audit(NOW - 30 * DAY, NOW, new Map()));
    expect(capped.specBounces?.rows).toHaveLength(AUDIT_LIST_CAP);
    expect(capped.capped?.["specBounces.rows"]).toBe(AUDIT_LIST_CAP + 2);
  });
});
