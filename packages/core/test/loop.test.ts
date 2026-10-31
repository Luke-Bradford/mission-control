import { describe, expect, it } from "vitest";
import { AUDIT_EXPECTED_TOKENS_DEFAULT } from "../src/audit.ts";
import type { LoopAction, LoopSnapshot } from "../src/loop.ts";
import {
  asideEventText,
  asideInCiEventText,
  CI_FAILED_TEXT,
  CI_PENDING_MAX_MS,
  CI_TRIES,
  CONTROLLER_CHECK_PARK,
  ciVerdict,
  controllerCheckOf,
  controllerCheckParkText,
  fillLoopText,
  hardRulesFlagKey,
  isHardRulesFlagKey,
  LOOP_TEXT_CI,
  LOOP_TEXT_CI_REF,
  LOOP_TEXT_DONE,
  LOOP_TEXT_DONE_PR,
  LOOP_TEXT_PARKED,
  LOOP_TEXT_REVIEW,
  LOOP_TEXT_REVIEW_PR,
  LOOP_TEXT_WORKING,
  loopText,
  MERGE_MAIN_TEXT,
  MERGE_STEP_WORDS,
  mergeMainKey,
  mergeStepFailedText,
  NEW_LOOP,
  NO_CI_AFTER_MS,
  NO_NEW_COMMIT_TEXT,
  NUDGE_TEXT,
  noShaDeleteText,
  pendingSeatWork,
  REFUSAL_TRIES,
  RESUME_TEXT,
  reconcile,
  ticketControllerCheck,
  withControllerCheckItem,
  wokenEventText,
} from "../src/loop.ts";
import {
  fixText,
  headMovedText,
  type LoopReviewFacts,
  type ReviewFact,
  type ReviewFinding,
  readyHardRuleText,
  readyRuledText,
  readyText,
  readyWaivedText,
  reviewFailedParkText,
  reviewParkText,
} from "../src/review.ts";
import type { PrCheck, RunLoop } from "../src/types.ts";

const SHA = "aaaaaaa1111";
const SHA2 = "bbbbbbb2222";
const REF = "owner/repo#7";
const NOW = 10_000_000;

describe("pendingSeatWork", () => {
  it("keeps only new failing findings, CI failures and controller messages", () => {
    expect(
      pendingSeatWork({
        lastTurnStartedAt: 100,
        reviews: [
          {
            id: 0,
            round: 1,
            state: "reported",
            blocking: 1,
            verdict: { spec: "fail", quality: "pass" },
            endedAt: 100,
          },
          {
            id: 1,
            round: 2,
            state: "reported",
            blocking: 1,
            verdict: { spec: "fail", quality: "pass" },
            endedAt: 109,
          },
          {
            id: 2,
            round: 1,
            state: "reported",
            blocking: 0,
            verdict: { spec: "pass", quality: "pass" },
            endedAt: 110,
          },
        ],
        events: [
          { key: "ci-at-start", text: "CI failed on c13fd87 tests", at: 100 },
          { key: "ci", text: "CI failed on c13fd87 tests", at: 103 },
        ],
        messages: [
          { key: "flight-at-start", from: "flight-1", at: 100 },
          { key: "cap", from: "CAPCOM", at: 105 },
          { key: "other", from: "other", at: 106 },
        ],
        woken: ["ci:ci"],
      }),
    ).toEqual([
      { key: "ci:ci-at-start", kind: "ci", at: 100, text: "a CI failure on c13fd87" },
      {
        key: "message:flight-at-start",
        kind: "message",
        at: 100,
        text: "a message from flight-1",
      },
      { key: "review:0", kind: "findings", at: 100, text: "RETRO round 1 findings" },
      { key: "message:cap", kind: "message", at: 105, text: "a message from CAPCOM" },
      { key: "review:1", kind: "findings", at: 109, text: "RETRO round 2 findings" },
    ]);
  });
});

function snap(over: Partial<LoopSnapshot> = {}, loop: Partial<RunLoop> = {}): LoopSnapshot {
  return {
    runId: "r1",
    runStartedAt: 1000,
    loop: { ...NEW_LOOP, ...loop },
    ticket: { ref: REF, title: "T", issue: 7 },
    now: NOW,
    tz: "UTC",
    hubStartedAt: 5000,
    seat: {
      call: "SULU",
      state: "running",
      inTurn: false,
      lastTurnEndedAt: null,
      resumedAt: null,
      rateLimitedUntil: null,
      openQuestion: false,
      holdsRun: true,
    },
    evidence: null,
    evidenceCount: 0,
    headCommit: null,
    pushed: null,
    pr: null,
    card: null,
    claimed: {},
    openNotes: [],
    lastEngineLineAt: null,
    tokens: 0,
    budget: 1000,
    ended: null,
    asideOk: false,
    ...over,
  };
}

const seat = (s: LoopSnapshot, over: Partial<LoopSnapshot["seat"]>): LoopSnapshot["seat"] => ({
  ...s.seat,
  ...over,
});

const pr = (
  over: Partial<NonNullable<LoopSnapshot["pr"]>> = {},
): NonNullable<LoopSnapshot["pr"]> => ({
  number: 12,
  state: "open",
  headSha: SHA,
  ci: "pending",
  mergeable: "MERGEABLE",
  polledAt: NOW,
  reviewStatus: "passing",
  ...over,
});

/** A loop in `ci`, pushed and with its PR open, card already moved. */
const inCi = (over: Partial<LoopSnapshot> = {}, loop: Partial<RunLoop> = {}): LoopSnapshot =>
  snap(
    {
      headCommit: SHA,
      pushed: { sha: SHA, at: NOW - 60_000 },
      pr: pr(),
      evidence: { id: 1, at: 2000, ruling: false },
      evidenceCount: 1,
      ...over,
    },
    { phase: "ci", reportedEvidenceId: 1, pushStartedAt: NOW - 120_000, cardFor: "ci:0", ...loop },
  );

/** The one re-run of a failure on `sha`, asked for before the poll under test. */
const reran = (sha: string = SHA): RunLoop["rerun"] => ({ sha, at: NOW - 1000, runs: [] });

const events = (a: LoopAction[]): string[] =>
  a.flatMap((x) => (x.kind === "event" ? [x.text] : []));
const outstanding = (a: LoopAction[]): LoopAction[] => a.filter((x) => x.kind !== "event");
const sends = (a: LoopAction[]): string[] => a.flatMap((x) => (x.kind === "send" ? [x.key] : []));
/** The next pass after the loop was stored but every action was dropped. */
const again = (s: LoopSnapshot, loop: RunLoop): ReturnType<typeof reconcile> =>
  reconcile({ ...s, loop });

describe("constants and texts", () => {
  it("exports the tuning constants and fills templates", () => {
    expect([CI_TRIES, REFUSAL_TRIES, CI_PENDING_MAX_MS, NO_CI_AFTER_MS]).toEqual([
      3,
      3,
      30 * 60_000,
      10 * 60_000,
    ]);
    expect(NEW_LOOP).toMatchObject({ phase: "working", epoch: 0, parked: null, cardFor: null });
    expect(fillLoopText(NO_NEW_COMMIT_TEXT, { sha7: "abc1234" })).toContain("CI failed on abc1234");
    expect(CI_FAILED_TEXT.endsWith("The failing output:\n")).toBe(true);
    expect(RESUME_TEXT).toContain("{ref}");
    expect(NUDGE_TEXT).toContain("{ref}");
    expect(RESUME_TEXT).toContain("no turn or time limit");
    expect(NUDGE_TEXT).toContain("no turn or time limit");
  });
});

describe("state step", () => {
  it("1: a merged PR finishes the run", () => {
    const s = snap(
      { pr: pr({ state: "merged" }), openNotes: [`review:r1:${SHA}`] },
      { phase: "review" },
    );
    const r = reconcile(s);
    expect(r.loop.phase).toBe("done");
    expect(r.actions).toEqual([
      { kind: "move-card", column: "Done" },
      { kind: "end-run" },
      { kind: "take-next" },
      { kind: "event", text: "merged" },
      { kind: "clear-note", key: `review:r1:${SHA}` },
    ]);
  });

  it("1a: done stays done and repeats end-run and take-next, with no event", () => {
    const r = reconcile(snap({}, { phase: "done", cardFor: "done:0" }));
    expect(r.loop.phase).toBe("done");
    expect(r.actions).toEqual([{ kind: "end-run" }, { kind: "take-next" }]);
  });

  it("1a: a done run whose card is not yet in Done moves it once, before end-run", () => {
    const r = reconcile(snap({}, { phase: "done", cardFor: "review:0" }));
    expect(r.actions).toEqual([
      { kind: "move-card", column: "Done" },
      { kind: "end-run" },
      { kind: "take-next" },
    ]);
    const again = reconcile(snap({}, { ...r.loop, cardFor: "done:0" }));
    expect(again.actions.some((a) => a.kind === "move-card")).toBe(false);
  });

  it("1a: done sends no lines, moves no card and clears every note", () => {
    const r = reconcile(
      snap(
        { openNotes: ["a", "b"], headCommit: SHA, seat: { ...snap().seat, resumedAt: 6000 } },
        { phase: "done", cardFor: "done:0" },
      ),
    );
    expect(r.actions).toEqual([
      { kind: "end-run" },
      { kind: "take-next" },
      { kind: "clear-note", key: "a" },
      { kind: "clear-note", key: "b" },
    ]);
  });

  it("2: an ended run parks as ended, once", () => {
    const s = snap({ ended: { reason: "stopped" } });
    const r = reconcile(s);
    expect(r.loop.phase).toBe("parked");
    expect(r.loop.parked).toEqual({ kind: "ended", reason: "run ended (stopped)", ended: true });
    expect(events(r.actions)).toEqual([]);
    const r2 = again(s, r.loop);
    expect(r2.loop).toEqual(r.loop);
  });

  it("2: an ended run that was parked for another reason is marked ended", () => {
    const r = reconcile(
      snap(
        { ended: { reason: "x" } },
        { phase: "parked", parked: { kind: "ci", reason: "r", ended: false } },
      ),
    );
    expect(r.loop.parked?.ended).toBe(true);
  });

  it("3: parked stays parked", () => {
    const l = { phase: "parked" as const, parked: { kind: "ci", reason: "r", ended: false } };
    const r = reconcile(snap({ evidence: { id: 9, at: 1, ruling: false }, headCommit: SHA }, l));
    expect(r.loop).toEqual({ ...NEW_LOOP, ...l });
    expect(events(r.actions)).toEqual([]);
  });

  it("4: a closed PR parks", () => {
    const r = reconcile(snap({ pr: pr({ state: "closed" }) }, { phase: "ci" }));
    expect(r.loop.parked).toEqual({
      kind: "pr-closed",
      reason: "PR #12 was closed without merging",
      ended: false,
    });
    expect(events(r.actions)).toEqual(["parked: PR #12 was closed without merging"]);
  });

  it("5: a report on the sha CI failed on, without a commit, stays working and asks for one", () => {
    const s = snap(
      {
        headCommit: SHA,
        evidence: { id: 3, at: NOW - 1000, ruling: false },
        evidenceCount: 7,
        claimed: { [`ci:r1:${SHA}`]: NOW - 5000 },
        pr: pr(),
      },
      { phase: "working", reportedEvidenceId: 2, ciFailedSha: SHA, relayedSha: SHA, ciFails: 1 },
    );
    const r = reconcile(s);
    expect(r.loop.phase).toBe("working");
    expect(r.loop.reportedEvidenceId).toBe(3);
    expect(r.actions).toContainEqual({
      kind: "send",
      key: "nonew:r1:3",
      text: fillLoopText(NO_NEW_COMMIT_TEXT, { sha7: "aaaaaaa" }),
    });
    // the next pass, the send dropped, sends it again; once claimed it stops
    const r2 = again(s, r.loop);
    expect(sends(r2.actions)).toEqual(["nonew:r1:3"]);
    const r3 = again({ ...s, claimed: { ...s.claimed, "nonew:r1:3": NOW } }, r.loop);
    expect(sends(r3.actions)).toEqual([]);
  });

  it("5: a ruling on the failed sha parks", () => {
    const r = reconcile(
      snap(
        { headCommit: SHA, evidence: { id: 3, at: 1, ruling: true }, evidenceCount: 3 },
        { phase: "working", reportedEvidenceId: 2, ciFailedSha: SHA },
      ),
    );
    expect(r.loop.phase).toBe("parked");
    expect(r.loop.reportedEvidenceId).toBe(3);
    expect(r.loop.parked).toEqual({
      kind: "ruling",
      reason: "SULU ruled on the CI failure on aaaaaaa instead of fixing it; see its last report",
      ended: false,
    });
  });

  it("6: a new report starts the push, in working and in review", () => {
    for (const phase of ["working", "review"] as const) {
      const r = reconcile(
        snap(
          { headCommit: SHA2, evidence: { id: 2, at: 1, ruling: false }, evidenceCount: 2 },
          { phase, reportedEvidenceId: 1, ciFailedSha: SHA },
        ),
      );
      expect(r.loop).toMatchObject({
        phase: "ci",
        reportedEvidenceId: 2,
        pushStartedAt: NOW,
      });
      expect(events(r.actions)).toEqual(["reported; pushing"]);
    }
  });

  it("6: a report with no commit at all parks at once, saying nothing was committed", () => {
    for (const ruling of [false, true]) {
      const r = reconcile(snap({ evidence: { id: 1, at: 1, ruling } }));
      expect(r.loop.phase).toBe("parked");
      expect(r.loop.parked).toEqual({
        kind: "nothing",
        reason: "SULU reported, but nothing was committed, so there is nothing to push",
        ended: false,
      });
      expect(r.loop.reportedEvidenceId).toBe(1);
      expect(r.actions.some((a) => a.kind === "push")).toBe(false);
    }
  });

  it("6: a report starts the push clock for the newest commit", () => {
    const r = reconcile(snap({ headCommit: SHA, evidence: { id: 1, at: 1, ruling: false } }));
    expect(r.loop).toMatchObject({ phase: "ci", pushStartedAt: NOW, pushFor: SHA });
  });

  it("6: an already-handled report does nothing", () => {
    const r = reconcile(
      snap({ evidence: { id: 1, at: 1, ruling: false } }, { reportedEvidenceId: 1 }),
    );
    expect(r.loop.phase).toBe("working");
  });

  it("7: too many refusals park with the last refusal", () => {
    const r = reconcile(inCi({}, { transient: REFUSAL_TRIES, lastRefusal: "push refused" }));
    expect(r.loop.parked).toEqual({ kind: "refused", reason: "push refused", ended: false });
    const r2 = reconcile(inCi({}, { transient: REFUSAL_TRIES - 1, lastRefusal: "x" }));
    expect(r2.loop.phase).toBe("ci");
  });

  it("8: a push or PR that never shows up parks after ten minutes", () => {
    const late = { pushStartedAt: NOW - NO_CI_AFTER_MS - 1 };
    const msg = "the push or PR for aaaaaaa has not shown up on GitHub after 10 minutes";
    const cases: [Partial<LoopSnapshot>, string][] = [
      [{ pushed: null }, "no push is recorded for the run"],
      [{ pr: null }, "no PR of the run has been read from GitHub"],
      [{ pr: pr({ headSha: SHA2 }) }, `PR #${pr().number} has head bbbbbbb, not aaaaaaa`],
      [{ pushed: { sha: SHA2, at: NOW } }, "the push is bbbbbbb, not the newest commit aaaaaaa"],
      [{ headCommit: null }, "no commit is recorded for the run, but aaaaaaa is pushed"],
      [{ pr: pr({ headSha: null }) }, `PR #${pr().number} has no head, not aaaaaaa`],
    ];
    for (const [over, why] of cases) {
      const r = reconcile(inCi(over, late));
      expect(r.loop.parked).toEqual({ kind: "stuck", reason: `${msg}: ${why}`, ended: false });
    }
  });

  it("8: a run stopped on push-not-shown is in CI again once the PR head is the pushed sha", () => {
    const stopped = reconcile(
      inCi({ pr: pr({ headSha: SHA2 }) }, { pushStartedAt: NOW - NO_CI_AFTER_MS - 1 }),
    ).loop;
    expect(stopped.parked?.kind).toBe("stuck");
    // the stored PR row later carries the pushed head
    const r = reconcile(inCi({ pr: pr({ headSha: SHA }) }, stopped));
    expect(r.loop).toMatchObject({
      phase: "ci",
      parked: null,
      pushStartedAt: NOW,
      pushFor: SHA,
      unparkedAt: NOW,
    });
    expect(events(r.actions)).toEqual([`PR #12 shows ${SHA.slice(0, 7)}; back to CI`]);
  });

  it("8: a stuck run stays stopped while the PR head is not the pushed sha, or the PR is closed", () => {
    const stopped = reconcile(
      inCi({ pr: pr({ headSha: SHA2 }) }, { pushStartedAt: NOW - NO_CI_AFTER_MS - 1 }),
    ).loop;
    for (const over of [
      { pr: pr({ headSha: SHA2 }) },
      { pr: pr({ headSha: null }) },
      { pr: null },
      { pr: pr({ state: "closed" as const }) },
      { headCommit: SHA2 },
    ] as Partial<LoopSnapshot>[]) {
      expect(reconcile(inCi(over, stopped)).loop.phase).toBe("parked");
    }
  });

  it("9: a push or PR not there yet, within ten minutes, waits", () => {
    for (const over of [
      { pushed: null },
      { pr: null },
      { pr: pr({ headSha: SHA2 }) },
    ] as Partial<LoopSnapshot>[]) {
      const r = reconcile(inCi(over, { pushStartedAt: NOW - NO_CI_AFTER_MS }));
      expect(r.loop.phase).toBe("ci");
    }
  });

  it("9: a stale passing CI on an older PR head is not trusted", () => {
    const r = reconcile(inCi({ pr: pr({ headSha: SHA2, ci: "passing" }) }));
    expect(r.loop.phase).toBe("ci");
  });

  it("10: a conflicting PR sends the seat to merge main; told once, it parks", () => {
    const s = inCi({ pr: pr({ mergeable: "CONFLICTING", ci: "passing" }) });
    const r = reconcile(s);
    expect(r.loop.phase).toBe("working");
    expect(r.loop.parked).toBeNull();
    expect(r.loop.pendingLine).toEqual({ key: mergeMainKey("r1", SHA), text: MERGE_MAIN_TEXT });
    expect(reconcile({ ...s, claimed: { [mergeMainKey("r1", SHA)]: NOW } }).loop.parked).toEqual({
      kind: "conflict",
      reason: "PR #12 conflicts with main",
      ended: false,
    });
  });

  it("11: passing CI moves to review and resets the failure count", () => {
    const r = reconcile(inCi({ pr: pr({ ci: "passing" }) }, { ciFails: 2 }));
    expect(r.loop).toMatchObject({ phase: "review", ciFails: 0 });
    expect(events(r.actions)).toEqual(["CI passed on aaaaaaa"]);
  });

  it("12a: failing CI on an already-failed sha returns to working without counting", () => {
    const r = reconcile(inCi({ pr: pr({ ci: "failing" }) }, { ciFailedSha: SHA, ciFails: 1 }));
    expect(r.loop).toMatchObject({ phase: "working", ciFails: 1, ciFailedSha: SHA });
    expect(events(r.actions)).toEqual([]);
  });

  it("12: failing CI counts, records the sha and returns to working", () => {
    const r = reconcile(inCi({ pr: pr({ ci: "failing" }) }, { rerun: reran() }));
    expect(r.loop).toMatchObject({ phase: "working", ciFails: 1, ciFailedSha: SHA });
    expect(events(r.actions)).toEqual(["CI failed on aaaaaaa"]);
    expect(r.actions).toContainEqual({ kind: "ci-excerpt", key: `ci:r1:${SHA}`, sha: SHA });
  });

  it("12: the third failure parks", () => {
    const rerun = reran();
    let s = inCi(
      { pr: pr({ ci: "failing" }) },
      { ciFails: CI_TRIES - 1, ciFailedSha: SHA2, rerun },
    );
    const r = reconcile(s);
    expect(r.loop.parked).toEqual({
      kind: "ci",
      reason: "CI failed 3 times; last on aaaaaaa",
      ended: false,
    });
    s = inCi({ pr: pr({ ci: "failing" }) }, { ciFails: CI_TRIES - 2, ciFailedSha: SHA2, rerun });
    expect(reconcile(s).loop.phase).toBe("working");
  });

  it("a profile's try limit parks CI on the first real failure at tries 1", () => {
    const r = reconcile({
      ...inCi({ pr: pr({ ci: "failing" }) }, { rerun: reran() }),
      limits: { tries: 1, rounds: 3 },
    });
    expect(r.loop.parked).toMatchObject({
      kind: "ci",
      reason: "CI failed 1 times; last on aaaaaaa",
    });
  });

  describe("a failed CI is re-run once", () => {
    it("the first failure on a sha asks for a re-run and tells the seat nothing", () => {
      const r = reconcile(inCi({ pr: pr({ ci: "failing" }) }));
      expect(r.loop).toMatchObject({
        phase: "ci",
        ciFails: 0,
        ciFailedSha: null,
        rerun: { sha: SHA, at: NOW, runs: [] },
      });
      expect(r.actions).toContainEqual({ kind: "rerun-ci", sha: SHA });
      expect(r.actions.some((a) => a.kind === "ci-excerpt")).toBe(false);
    });

    it("no second re-run for the same sha", () => {
      const s = inCi({ pr: pr({ ci: "failing" }) }, { rerun: reran() });
      expect(reconcile(s).actions.some((a) => a.kind === "rerun-ci")).toBe(false);
      const stale = inCi({ pr: pr({ ci: "failing", polledAt: NOW - 5000 }) }, { rerun: reran() });
      expect(reconcile(stale).actions.some((a) => a.kind === "rerun-ci")).toBe(false);
    });

    it("a poll from before the re-run is waited out", () => {
      const r = reconcile(
        inCi({ pr: pr({ ci: "failing", polledAt: NOW - 5000 }) }, { rerun: reran() }),
      );
      expect(r.loop).toMatchObject({ phase: "ci", ciFails: 0, ciFailedSha: null });
      expect(r.actions.some((a) => a.kind === "ci-excerpt")).toBe(false);
    });

    it("a second failure is a real one and reaches the seat", () => {
      const r = reconcile(inCi({ pr: pr({ ci: "failing" }) }, { rerun: reran() }));
      expect(r.loop).toMatchObject({ phase: "working", ciFails: 1, ciFailedSha: SHA });
      expect(r.actions).toContainEqual({ kind: "ci-excerpt", key: `ci:r1:${SHA}`, sha: SHA });
    });

    it("a pass after the re-run is recorded as a flake and the run goes on", () => {
      const rerun = { sha: SHA, at: NOW - 1000, runs: [{ id: 99, name: "CI" }] };
      const r = reconcile(inCi({ pr: pr({ ci: "passing" }) }, { rerun }));
      expect(r.loop).toMatchObject({ phase: "review", rerun: { flaked: true } });
      expect(events(r.actions)).toEqual([
        "CI passed on aaaaaaa",
        "CI flaked on aaaaaaa: passed on re-run",
      ]);
      const next = reconcile({ ...inCi({ pr: pr({ ci: "passing" }) }), loop: r.loop });
      expect(next.actions).toContainEqual({
        kind: "note",
        key: `flake:r1:${SHA}`,
        noteKind: "flag",
        text: `${REF}: CI failed on aaaaaaa and passed on re-run (a flake): CI run 99`,
      });
    });

    it("a flake note is never cleared by the loop, at done or after a later sha is re-run", () => {
      const key = `flake:r1:${SHA}`;
      const done = reconcile(
        snap(
          { openNotes: [key], pr: pr({ ci: "passing" }) },
          {
            phase: "done",
            cardFor: "done:0",
            rerun: { sha: SHA, at: NOW - 1000, runs: [], flaked: true },
          },
        ),
      );
      expect(done.actions).not.toContainEqual({ kind: "clear-note", key });
      const later = reconcile(
        inCi({ openNotes: [key], pr: pr({ ci: "failing" }) }, { rerun: reran(SHA2) }),
      );
      expect(later.actions).not.toContainEqual({ kind: "clear-note", key });
    });

    it("the CI-pending clock runs from the re-run, not the push", () => {
      const old = { pushed: { sha: SHA, at: NOW - CI_PENDING_MAX_MS - 1 } };
      const pending = pr({ ci: "pending" });
      const r = reconcile(
        inCi({ ...old, pr: pending }, { rerun: { sha: SHA, at: NOW - 60_000, runs: [] } }),
      );
      expect(r.loop.phase).toBe("ci");
      expect(r.loop.parked).toBeNull();
      const other = reconcile(inCi({ ...old, pr: pending }, { rerun: reran(SHA2) }));
      expect(other.loop.parked?.kind).toBe("ci-pending");
    });

    it("a pass with no failure before is no flake", () => {
      const r = reconcile(inCi({ pr: pr({ ci: "passing" }) }));
      expect(r.loop.rerun ?? null).toBeNull();
      expect(events(r.actions)).toEqual(["CI passed on aaaaaaa"]);
    });
  });

  it("12: the failure names the failing checks", () => {
    const checks = { failing: ["check"], pending: [], missing: [] };
    const r = reconcile(inCi({ pr: pr({ ci: "failing", checks }) }, { rerun: reran() }));
    expect(events(r.actions)).toEqual(["CI failed on aaaaaaa (failing: check)"]);
    const parked = reconcile(
      inCi(
        { pr: pr({ ci: "failing", checks }) },
        { ciFails: CI_TRIES - 1, ciFailedSha: SHA2, rerun: reran() },
      ),
    );
    expect(parked.loop.parked?.reason).toBe("CI failed 3 times; last on aaaaaaa (failing: check)");
  });

  it("12: no checks keeps today's CI texts", () => {
    const checks = { failing: [], pending: [], missing: [] };
    const r = reconcile(inCi({ pr: pr({ ci: "failing", checks }) }, { rerun: reran() }));
    expect(events(r.actions)).toEqual(["CI failed on aaaaaaa"]);
  });

  it("13: the pending park names pending and missing checks", () => {
    const checks = { failing: [], pending: ["check"], missing: ["e2e"] };
    const r = reconcile(
      inCi({ pr: pr({ checks }), pushed: { sha: SHA, at: NOW - CI_PENDING_MAX_MS - 1 } }),
    );
    expect(r.loop.parked?.reason).toBe(
      "CI pending for 30 minutes on aaaaaaa (pending: check; missing: e2e)",
    );
  });

  it("13: CI pending for thirty minutes parks", () => {
    const old = { pushed: { sha: SHA, at: NOW - CI_PENDING_MAX_MS - 1 } };
    const r = reconcile(inCi(old));
    expect(r.loop.parked).toEqual({
      kind: "ci-pending",
      reason: "CI pending for 30 minutes on aaaaaaa",
      ended: false,
    });
    const r2 = reconcile(inCi({ pushed: { sha: SHA, at: NOW - CI_PENDING_MAX_MS } }));
    expect(r2.loop.phase).toBe("ci");
  });

  it("14: no CI reported within ten minutes of the push parks", () => {
    const at = NOW - NO_CI_AFTER_MS - 1;
    const r = reconcile(inCi({ pushed: { sha: SHA, at }, pr: pr({ ci: null, polledAt: NOW }) }));
    expect(r.loop.parked).toEqual({
      kind: "no-ci",
      reason: "no CI reported for aaaaaaa",
      ended: false,
    });
    const r2 = reconcile(
      inCi({ pushed: { sha: SHA, at: NOW - NO_CI_AFTER_MS }, pr: pr({ ci: null }) }),
    );
    expect(r2.loop.phase).toBe("ci");
  });

  it("15: working over budget parks; budgetExtra raises the ceiling", () => {
    const r = reconcile(snap({ tokens: 1001 }));
    expect(r.loop.parked).toEqual({
      kind: "budget",
      reason: "used 1001 input + output tokens of a 1000-token budget",
      ended: false,
    });
    expect(reconcile(snap({ tokens: 1001 }, { budgetExtra: 1 })).loop.phase).toBe("working");
    expect(reconcile(snap({ tokens: 1000 })).loop.phase).toBe("working");
    expect(reconcile(inCi({ tokens: 5000 })).loop.phase).toBe("ci");
  });

  describe("16: silent after three carry-on resumes", () => {
    const keys = ["nudge:r1:0:0:1", "nudge:r1:0:0:2", "nudge:r1:0:0:3"];
    const base = (over: Partial<LoopSnapshot> = {}, loop: Partial<RunLoop> = {}) =>
      snap(
        {
          claimed: Object.fromEntries(keys.map((key, n) => [key, 5000 + n])),
          seat: { ...snap().seat, state: "idle", lastTurnEndedAt: 6000 },
          ...over,
        },
        loop,
      );

    it("parks when the seat stops after three carry-on resumes", () => {
      const r = reconcile(base());
      expect(r.loop.parked).toEqual({
        kind: "silent",
        reason: "stopped after 3 carry-on resumes without reporting",
        ended: false,
      });
    });

    it("never parks with an open question, mid-turn, not idle, or before the nudge", () => {
      const s = base();
      for (const sd of [
        { openQuestion: true },
        { inTurn: true },
        { state: "running" as const },
        { lastTurnEndedAt: 5000 },
      ]) {
        expect(reconcile({ ...s, seat: seat(s, sd) }).loop.phase).toBe("working");
      }
    });

    it("applies in review when a fix is committed but not reported", () => {
      const r = reconcile(
        base(
          { headCommit: SHA2, pushed: { sha: SHA, at: 1 }, evidenceCount: 0 },
          { phase: "review" },
        ),
      );
      expect(r.loop.phase).toBe("parked");
      const r2 = reconcile(
        base({ headCommit: SHA, pushed: { sha: SHA, at: 1 } }, { phase: "review" }),
      );
      expect(r2.loop.phase).toBe("review");
    });
  });

  it("17: otherwise unchanged", () => {
    const s = snap();
    expect(reconcile(s).loop).toEqual(s.loop);
  });
});

describe("desired-state step", () => {
  it("moves the card once per phase and epoch, and not again once cardFor is set", () => {
    const cases: [Partial<RunLoop>, string][] = [
      [{ phase: "working" }, "In progress"],
      [{ phase: "review" }, "In review"],
      [{ phase: "parked", parked: { kind: "x", reason: "r", ended: false } }, "Blocked"],
    ];
    for (const [loop, column] of cases) {
      const r = reconcile(snap({}, loop));
      expect(r.actions).toContainEqual({ kind: "move-card", column });
      const phase = loop.phase;
      const done = reconcile(snap({}, { ...loop, cardFor: `${phase}:0` }));
      expect(done.actions.some((a) => a.kind === "move-card")).toBe(false);
      // a new epoch is a new move
      const next = reconcile(snap({}, { ...loop, cardFor: `${phase}:0`, epoch: 1 }));
      expect(next.actions).toContainEqual({ kind: "move-card", column });
    }
    expect(reconcile(snap({}, { phase: "working" })).actions).toContainEqual({
      kind: "move-card",
      column: "In progress",
    });
    expect(
      reconcile(inCi({}, { cardFor: null })).actions.filter((a) => a.kind === "move-card"),
    ).toEqual([{ kind: "move-card", column: "In progress" }]);
  });

  it("an ended run still gets its Blocked move and note", () => {
    const r = reconcile(snap({ ended: { reason: "stopped" } }));
    expect(r.actions).toContainEqual({ kind: "move-card", column: "Blocked" });
    expect(r.actions).toContainEqual({
      kind: "note",
      key: "blocked:r1:0",
      noteKind: "blocked",
      text: `${REF} parked: run ended (stopped)`,
    });
  });

  it("emits a note for each missing desired key and clears those no longer wanted", () => {
    const parked = {
      phase: "parked" as const,
      parked: { kind: "ci", reason: "boom", ended: false },
      cardFor: "parked:0",
    };
    const r = reconcile(snap({ openNotes: ["old"] }, parked));
    expect(r.actions).toEqual([
      { kind: "note", key: "blocked:r1:0", noteKind: "blocked", text: `${REF} parked: boom` },
      { kind: "clear-note", key: "old" },
    ]);
    expect(reconcile(snap({ openNotes: ["blocked:r1:0"] }, parked)).actions).toEqual([]);
  });

  it("a park's note key changes with the epoch", () => {
    const parked = {
      phase: "parked" as const,
      parked: { kind: "ci", reason: "boom", ended: false },
      cardFor: "parked:1",
      epoch: 1,
    };
    const r = reconcile(snap({ openNotes: ["blocked:r1:0"] }, parked));
    expect(r.actions).toEqual([
      { kind: "note", key: "blocked:r1:1", noteKind: "blocked", text: `${REF} parked: boom` },
      { kind: "clear-note", key: "blocked:r1:0" },
    ]);
  });

  it("review note names the PR and hard-rule flags follow their file set", () => {
    const s = snap(
      { pushed: { sha: SHA, at: 1 }, headCommit: SHA, pr: pr({ ci: "passing" }) },
      { phase: "review", cardFor: "review:0", touches: { sha: SHA, paths: ["a.yml", "b.ts"] } },
    );
    const r = reconcile(s);
    expect(r.actions).toEqual([
      {
        kind: "note",
        key: `review:r1:${SHA}`,
        noteKind: "review",
        text: `${REF}: PR #12 is ready for review (CI passed on aaaaaaa)`,
      },
      {
        kind: "note",
        key: hardRulesFlagKey("r1", ["a.yml", "b.ts"]),
        noteKind: "flag",
        text: `${REF} touches hard-rule files: a.yml, b.ts`,
      },
    ]);
    const sameFiles = reconcile({
      ...s,
      headCommit: SHA2,
      pushed: { sha: SHA2, at: 2 },
      loop: { ...s.loop, touches: { sha: SHA2, paths: ["b.ts", "a.yml"] } },
      openNotes: [hardRulesFlagKey("r1", ["a.yml", "b.ts"])],
    });
    expect(sameFiles.actions).not.toContainEqual(
      expect.objectContaining({ kind: "note", noteKind: "flag" }),
    );
    const addedFile = reconcile({
      ...s,
      headCommit: SHA2,
      pushed: { sha: SHA2, at: 2 },
      loop: { ...s.loop, touches: { sha: SHA2, paths: ["a.yml", "b.ts", "c.md"] } },
      openNotes: [hardRulesFlagKey("r1", ["a.yml", "b.ts"])],
    });
    expect(addedFile.actions).toContainEqual({
      kind: "note",
      key: hardRulesFlagKey("r1", ["a.yml", "b.ts", "c.md"]),
      noteKind: "flag",
      text: `${REF} touches hard-rule files: a.yml, b.ts, c.md`,
    });
    expect(addedFile.actions).toContainEqual({
      kind: "clear-note",
      key: hardRulesFlagKey("r1", ["a.yml", "b.ts"]),
    });
    const empty = reconcile({
      ...s,
      loop: { ...s.loop, touches: { sha: SHA, paths: [] } },
      openNotes: [hardRulesFlagKey("r1", ["a.yml", "b.ts"])],
    });
    expect(empty.actions).toContainEqual({
      kind: "clear-note",
      key: hardRulesFlagKey("r1", ["a.yml", "b.ts"]),
    });
  });

  it("a rate-limited seat gets a note, with the reset time when known", () => {
    const base = snap({}, { cardFor: "working:0" });
    const until = Date.UTC(2026, 9, 21, 14, 5);
    const r = reconcile({
      ...base,
      now: until - 3_600_000,
      tz: "Europe/London",
      seat: seat(base, { state: "parked", rateLimitedUntil: until }),
    });
    expect(r.actions).toContainEqual({
      kind: "note",
      key: "ratelimit:r1",
      noteKind: "ratelimit",
      text: "SULU is rate-limited until 15:05",
    });
    const r2 = reconcile({ ...base, seat: seat(base, { state: "parked" }) });
    expect(r2.actions).toContainEqual({
      kind: "note",
      key: "ratelimit:r1",
      noteKind: "ratelimit",
      text: "SULU is rate-limited",
    });
    const gone = reconcile({ ...base, openNotes: ["ratelimit:r1"] });
    expect(gone.actions).toEqual([{ kind: "clear-note", key: "ratelimit:r1" }]);
  });

  it("pushes the newest commit, then opens the PR, only in ci", () => {
    const r = reconcile(inCi({ pushed: null, pr: null }));
    expect(r.actions).toEqual([{ kind: "push" }]);
    const r2 = reconcile(inCi({ pushed: { sha: SHA2, at: NOW }, pr: null, headCommit: SHA }));
    expect(r2.actions).toEqual([{ kind: "push" }]);
    const r3 = reconcile(inCi({ pr: null }));
    expect(r3.actions).toEqual([{ kind: "open-pr" }]);
    const w = reconcile(snap({ headCommit: SHA }, { cardFor: "working:0" }));
    expect(w.actions).toEqual([]);
  });

  describe("lines", () => {
    const fail = (over: Partial<LoopSnapshot> = {}, loop: Partial<RunLoop> = {}) =>
      snap(
        { headCommit: SHA, pr: pr({ ci: "failing" }), ...over },
        { cardFor: "working:0", ciFailedSha: SHA, ciFails: 1, ...loop },
      );

    it("relays the CI excerpt until the server marks it relayed", () => {
      const r = reconcile(fail());
      expect(r.actions).toEqual([{ kind: "ci-excerpt", key: `ci:r1:${SHA}`, sha: SHA }]);
      expect(reconcile(fail({}, { relayedSha: SHA })).actions).toEqual([]);
      expect(reconcile(fail({ claimed: { [`ci:r1:${SHA}`]: 1 } })).actions).toEqual([]);
    });

    it("relays the failure of FLIGHT's re-run once, keyed by the sha, ahead of the first excerpt", () => {
      const rerun = { sha: SHA, runs: [{ id: 11, attempt: 1 }] };
      const again = { kind: "ci-excerpt", key: `rerun:r1:${SHA}`, sha: SHA, again: true };
      const failed = fail({}, { relayedSha: SHA, rulingRerun: { ...rerun, outcome: "failed" } });
      expect(reconcile(failed).actions).toEqual([again]);
      expect(reconcile({ ...failed, claimed: { [`rerun:r1:${SHA}`]: 1 } }).actions).toEqual([]);
      // a re-run still going, or one that passed, or one on another sha, says nothing
      for (const outcome of ["pending", "passed"] as const) {
        expect(
          reconcile(fail({}, { relayedSha: SHA, rulingRerun: { ...rerun, outcome } })).actions,
        ).toEqual([]);
      }
      const other = { ...rerun, sha: SHA2, outcome: "failed" as const };
      expect(reconcile(fail({}, { relayedSha: SHA, rulingRerun: other })).actions).toEqual([]);
    });

    it("keeps the re-run on the loop it hands back, sharing nothing with the input", () => {
      const s = fail(
        {},
        {
          relayedSha: SHA,
          rulingRerun: { sha: SHA, runs: [{ id: 11, attempt: 1 }], outcome: "pending" },
        },
      );
      const out = reconcile(s).loop.rulingRerun;
      expect(out).toEqual(s.loop.rulingRerun);
      expect(out?.runs).not.toBe(s.loop.rulingRerun?.runs);
    });

    it("sends nothing while the seat is in a turn", () => {
      const s = fail();
      expect(reconcile({ ...s, seat: seat(s, { inTurn: true }) }).actions).toEqual([]);
    });

    it("sends one line per pass, the first due one", () => {
      const s = fail({
        seat: { ...snap().seat, resumedAt: 6000, state: "idle", lastTurnEndedAt: 5500 },
      });
      const r = reconcile(s);
      expect(outstanding(r.actions)).toEqual([
        { kind: "ci-excerpt", key: `ci:r1:${SHA}`, sha: SHA },
      ]);
      const r2 = reconcile({ ...s, loop: { ...s.loop, relayedSha: SHA } });
      expect(sends(r2.actions)).toEqual(["resume:r1:5000"]);
    });

    it("resumes a seat once per hub start, until its next turn ends", () => {
      const s = snap({ seat: { ...snap().seat, resumedAt: 6000 } }, { cardFor: "working:0" });
      expect(reconcile(s).actions).toEqual([
        { kind: "send", key: "resume:r1:5000", text: fillLoopText(RESUME_TEXT, { ref: REF }) },
      ]);
      const claimed = { "resume:r1:5000": 6100 };
      expect(reconcile({ ...s, claimed }).actions).toEqual([]);
      // resumed before this hub started: nothing
      expect(reconcile({ ...s, seat: seat(s, { resumedAt: 4000 }) }).actions).toEqual([]);
      // its turn ended since: no resume line
      expect(reconcile({ ...s, seat: seat(s, { lastTurnEndedAt: 6500 }) }).actions).toEqual([]);
      // an open question: no resume line
      expect(reconcile({ ...s, seat: seat(s, { openQuestion: true }) }).actions).toEqual([]);
    });

    it("a rate-limit reset sends one line; with no reset time, one try per hour", () => {
      const base = snap({}, { cardFor: "working:0" });
      const parkedSeat = (over: Partial<LoopSnapshot["seat"]>) =>
        seat(base, { state: "parked", ...over });
      const until = NOW - 1000;
      const r = reconcile({
        ...base,
        seat: parkedSeat({ rateLimitedUntil: until }),
        openNotes: ["ratelimit:r1"],
      });
      expect(r.actions).toEqual([
        {
          kind: "send",
          key: `ratelimit:r1:${until}`,
          text: fillLoopText(RESUME_TEXT, { ref: REF }),
        },
      ]);
      const claimed = { [`ratelimit:r1:${until}`]: NOW };
      expect(
        reconcile({
          ...base,
          claimed,
          seat: parkedSeat({ rateLimitedUntil: until }),
          openNotes: ["ratelimit:r1"],
        }).actions,
      ).toEqual([]);
      // not yet reset
      expect(
        sends(reconcile({ ...base, seat: parkedSeat({ rateLimitedUntil: NOW + 1000 }) }).actions),
      ).toEqual([]);
      expect(sends(reconcile({ ...base, seat: parkedSeat({}) }).actions)).toEqual([
        "ratelimit:r1:after:0",
      ]);
    });

    it("nudges an idle seat that stopped without reporting, once per epoch and report count", () => {
      const s = snap(
        { seat: { ...snap().seat, state: "idle", lastTurnEndedAt: 3000 } },
        { cardFor: "working:0" },
      );
      expect(reconcile(s).actions).toEqual([
        { kind: "send", key: "nudge:r1:0:0:1", text: fillLoopText(NUDGE_TEXT, { ref: REF }) },
      ]);
      // a turn that ended before the run started, the report or an engine line is not a stop
      for (const over of [
        { runStartedAt: 3000 },
        { evidence: { id: 1, at: 3000, ruling: false } },
        { lastEngineLineAt: 3000 },
      ] as Partial<LoopSnapshot>[]) {
        const o = { ...s, ...over };
        // keep the evidence handled so row 6 does not fire
        const loop = { ...o.loop, reportedEvidenceId: o.evidence?.id ?? 0 };
        expect(sends(reconcile({ ...o, loop }).actions)).toEqual([]);
      }
      expect(sends(reconcile({ ...s, seat: seat(s, { openQuestion: true }) }).actions)).toEqual([]);
      expect(sends(reconcile({ ...s, seat: seat(s, { state: "running" }) }).actions)).toEqual([]);
      expect(sends(reconcile({ ...s, seat: seat(s, { lastTurnEndedAt: null }) }).actions)).toEqual(
        [],
      );
      expect(sends(reconcile({ ...s, claimed: { "nudge:r1:0:0:1": 3500 } }).actions)).toEqual([
        "nudge:r1:0:0:2",
      ]);
    });

    it("nudges in review only when a fix is committed but not reported", () => {
      const s = snap(
        {
          headCommit: SHA2,
          pushed: { sha: SHA, at: 1 },
          pr: pr({ ci: "passing" }),
          seat: { ...snap().seat, state: "idle", lastTurnEndedAt: 3000 },
        },
        { phase: "review", cardFor: "review:0" },
      );
      expect(sends(reconcile(s).actions)).toEqual(["nudge:r1:0:0:1"]);
      expect(sends(reconcile({ ...s, headCommit: SHA }).actions)).toEqual([]);
    });
  });
});

describe("sequences", () => {
  it("happy path: report, push, open-pr, CI pending, passing, review, merged", () => {
    const s0 = snap({
      headCommit: SHA,
      evidence: { id: 1, at: 2000, ruling: false },
      evidenceCount: 1,
    });
    const r0 = reconcile(s0);
    expect(r0.actions).toEqual([
      { kind: "event", text: "reported; pushing" },
      { kind: "move-card", column: "In progress" },
      { kind: "push" },
    ]);

    const l1 = { ...r0.loop, cardFor: "ci:0" };
    const s1 = { ...s0, loop: l1, pushed: { sha: SHA, at: NOW } };
    expect(reconcile(s1).actions).toEqual([{ kind: "open-pr" }]);

    const s2 = { ...s1, pr: pr({ ci: "pending" }) };
    expect(reconcile(s2).actions).toEqual([]);

    const s3 = { ...s2, pr: pr({ ci: "passing" }) };
    const r3 = reconcile(s3);
    expect(r3.actions).toEqual([
      { kind: "event", text: "CI passed on aaaaaaa" },
      { kind: "move-card", column: "In review" },
      {
        kind: "note",
        key: `review:r1:${SHA}`,
        noteKind: "review",
        text: `${REF}: PR #12 is ready for review (CI passed on aaaaaaa)`,
      },
    ]);

    const s4 = {
      ...s3,
      loop: { ...r3.loop, cardFor: "review:0" },
      openNotes: [`review:r1:${SHA}`],
      pr: pr({ state: "merged", ci: "passing" }),
    };
    const r4 = reconcile(s4);
    expect(r4.loop.phase).toBe("done");
    expect(r4.actions).toEqual([
      { kind: "move-card", column: "Done" },
      { kind: "end-run" },
      { kind: "take-next" },
      { kind: "event", text: "merged" },
      { kind: "clear-note", key: `review:r1:${SHA}` },
    ]);
    expect(again(s4, { ...r4.loop, cardFor: "done:0" }).actions).toEqual([
      { kind: "end-run" },
      { kind: "take-next" },
      { kind: "clear-note", key: `review:r1:${SHA}` },
    ]);
  });

  it("a crash after the state is stored repeats push, open-pr and the card move", () => {
    const s0 = snap({
      headCommit: SHA,
      evidence: { id: 1, at: 2000, ruling: false },
      evidenceCount: 1,
    });
    const r0 = reconcile(s0);
    // the loop is stored, every action is dropped
    const r1 = again(s0, r0.loop);
    expect(outstanding(r1.actions)).toEqual(outstanding(r0.actions));
    expect(events(r1.actions)).toEqual([]);
    expect(r1.loop).toEqual(r0.loop);

    const s1 = { ...s0, loop: { ...r0.loop, cardFor: "ci:0" }, pushed: { sha: SHA, at: NOW } };
    const r2 = reconcile(s1);
    expect(again(s1, r2.loop).actions).toEqual(r2.actions);
  });

  it("a crash after a park repeats the card move and the note", () => {
    const s = inCi({
      pr: pr({ mergeable: "CONFLICTING" }),
      claimed: { [mergeMainKey("r1", SHA)]: NOW },
    });
    const r = reconcile(s);
    expect(r.loop.phase).toBe("parked");
    const next = again(s, r.loop);
    expect(outstanding(next.actions)).toEqual(outstanding(r.actions));
    expect(outstanding(r.actions).map((a) => a.kind)).toEqual(["move-card", "note"]);
    expect(events(next.actions)).toEqual([]);
  });

  it("a crash after a CI failure repeats the excerpt", () => {
    const s = inCi({ pr: pr({ ci: "failing" }) }, { rerun: reran() });
    const r = reconcile(s);
    expect(r.loop.phase).toBe("working");
    const next = again(s, r.loop);
    expect(next.actions).toEqual([
      { kind: "move-card", column: "In progress" },
      { kind: "ci-excerpt", key: `ci:r1:${SHA}`, sha: SHA },
    ]);
    expect(next.loop).toEqual(r.loop);
    // the failure stays counted once however often the pass repeats
    expect(next.loop.ciFails).toBe(1);
  });

  it("a busy send is re-emitted until its key is claimed", () => {
    const s = snap({ seat: { ...snap().seat, resumedAt: 6000 } }, { cardFor: "working:0" });
    for (let i = 0; i < 3; i++) expect(sends(reconcile(s).actions)).toEqual(["resume:r1:5000"]);
    expect(sends(reconcile({ ...s, claimed: { "resume:r1:5000": NOW } }).actions)).toEqual([]);
  });

  it("CI failing three times parks, each failure on a new sha", () => {
    let loop: RunLoop = { ...NEW_LOOP, cardFor: "ci:0" };
    const shas = ["1111111aa", "2222222bb", "3333333cc"];
    let last = reconcile(snap());
    for (const [i, sha] of shas.entries()) {
      const ci = inCi(
        {
          headCommit: sha,
          pushed: { sha, at: NOW - 1000 },
          pr: pr({ headSha: sha, ci: "failing" }),
        },
        {
          ...loop,
          phase: "ci",
          ciFails: i,
          ciFailedSha: i === 0 ? null : (shas[i - 1] ?? null),
          rerun: reran(sha),
        },
      );
      last = reconcile(ci);
      loop = last.loop;
    }
    expect(last.loop.phase).toBe("parked");
    expect(last.loop.ciFails).toBe(3);
    expect(last.loop.parked?.reason).toBe("CI failed 3 times; last on 3333333");
  });

  it("a review-round report pushes only", () => {
    const s = snap(
      {
        headCommit: SHA2,
        pushed: { sha: SHA, at: 1000 },
        pr: pr({ ci: "passing" }),
        evidence: { id: 2, at: 9000, ruling: false },
        evidenceCount: 2,
        openNotes: [`review:r1:${SHA}`],
      },
      { phase: "review", reportedEvidenceId: 1, cardFor: "review:0" },
    );
    const r = reconcile(s);
    expect(r.loop.phase).toBe("ci");
    expect(r.actions.filter((a) => a.kind === "push")).toEqual([{ kind: "push" }]);
    expect(r.actions.some((a) => a.kind === "open-pr")).toBe(false);
    expect(r.actions).toContainEqual({ kind: "clear-note", key: `review:r1:${SHA}` });
    expect(r.actions).toContainEqual({ kind: "move-card", column: "In progress" });
  });

  it("a resumed seat gets the resume line once, then the nudge rules apply", () => {
    const base = snap(
      { seat: { ...snap().seat, state: "idle", resumedAt: 6000, lastTurnEndedAt: 3000 } },
      { cardFor: "working:0" },
    );
    // before its next turn ends: resume
    expect(sends(reconcile(base).actions)).toEqual(["resume:r1:5000"]);
    // resume claimed, seat still has not had a turn since: no further line
    const claimed1 = { "resume:r1:5000": 6100 };
    // the engine's own line (the resume) is stamped at its claim time
    const s1 = { ...base, claimed: claimed1, lastEngineLineAt: 6100 };
    expect(reconcile(s1).actions).toEqual([]);
    // its turn ends without a report: the nudge
    const s2 = { ...s1, seat: seat(s1, { lastTurnEndedAt: 7000 }) };
    expect(sends(reconcile(s2).actions)).toEqual(["nudge:r1:0:0:1"]);
    // nudge claimed, nothing yet
    const s3 = { ...s2, claimed: { ...claimed1, "nudge:r1:0:0:1": 7100 } };
    expect(reconcile(s3).loop.phase).toBe("working");
    // it stops again: another carry-on, rather than a park
    const s4 = { ...s3, seat: seat(s3, { lastTurnEndedAt: 8000 }) };
    expect(sends(reconcile(s4).actions)).toEqual(["nudge:r1:0:0:2"]);
    const s5 = { ...s4, claimed: { ...s3.claimed, "nudge:r1:0:0:2": 8100 } };
    const s6 = { ...s5, seat: seat(s5, { lastTurnEndedAt: 9000 }) };
    expect(sends(reconcile(s6).actions)).toEqual(["nudge:r1:0:0:3"]);
    const s7 = { ...s6, claimed: { ...s5.claimed, "nudge:r1:0:0:3": 9100 } };
    const s8 = { ...s7, seat: seat(s7, { lastTurnEndedAt: 10_000 }) };
    const r8 = reconcile(s8);
    expect(r8.loop.parked?.kind).toBe("silent");
    expect(r8.loop.parked?.reason).toBe("stopped after 3 carry-on resumes without reporting");
    expect(sends(r8.actions)).toEqual([]);
    // with an open question it neither nudges nor parks
    const q = { ...s8, seat: seat(s8, { openQuestion: true }) };
    expect(reconcile(q).loop.phase).toBe("working");
    expect(sends(reconcile({ ...q, claimed: claimed1 }).actions)).toEqual([]);
  });
});

describe("review round", () => {
  const PARKED = { kind: "ci", reason: "r", ended: false };
  const ENDED = { kind: "ended", reason: "run ended (stopped)", ended: true };
  const touches = { sha: SHA, paths: ["a.yml"] };
  const limited = (s: LoopSnapshot): LoopSnapshot["seat"] =>
    seat(s, { state: "parked", rateLimitedUntil: null });

  it("an ended run desires only its blocked note and clears the others", () => {
    const loop = { phase: "parked" as const, parked: ENDED, cardFor: "parked:0", touches };
    const base = snap({}, loop);
    const s = { ...base, seat: limited(base) };
    const r = reconcile(s);
    expect(r.actions).toEqual([
      {
        kind: "note",
        key: "blocked:r1:0",
        noteKind: "blocked",
        text: `${REF} parked: run ended (stopped)`,
      },
    ]);
    const open = [`flag:r1:hard-rules:${SHA}`, "ratelimit:r1", "blocked:r1:0"];
    expect(reconcile({ ...s, openNotes: open }).actions).toEqual([
      { kind: "clear-note", key: `flag:r1:hard-rules:${SHA}` },
      { kind: "clear-note", key: "ratelimit:r1" },
    ]);
  });

  it("a parked run that has not ended keeps its flag and rate-limit notes", () => {
    const base = snap({}, { phase: "parked", parked: PARKED, cardFor: "parked:0", touches });
    const keys = reconcile({ ...base, seat: limited(base) }).actions.flatMap((a) =>
      a.kind === "note" ? [a.key] : [],
    );
    expect(keys).toEqual(["blocked:r1:0", hardRulesFlagKey("r1", ["a.yml"]), "ratelimit:r1"]);
  });

  it("6: a new report resets the refusal counter", () => {
    const r = reconcile(
      snap(
        { headCommit: SHA2, evidence: { id: 2, at: 1, ruling: false }, evidenceCount: 2 },
        { phase: "review", reportedEvidenceId: 1, transient: 2, lastRefusal: "old" },
      ),
    );
    expect(r.loop).toMatchObject({ phase: "ci", transient: 0, lastRefusal: null });
  });

  it("returns a fresh loop object even when nothing changed", () => {
    for (const loop of [{}, { phase: "done" as const }, { phase: "parked" as const }]) {
      const s = snap({}, loop);
      const r = reconcile(s);
      expect(r.loop).toEqual(s.loop);
      expect(r.loop).not.toBe(s.loop);
    }
  });

  it("3: a parked run with a closed PR stays parked", () => {
    const l = { phase: "parked" as const, parked: PARKED };
    const r = reconcile(snap({ pr: pr({ state: "closed" }) }, l));
    expect(r.loop.parked).toEqual(PARKED);
    expect(events(r.actions)).toEqual([]);
  });

  it("5: a report on the failed sha in review goes back to working, or parks on a ruling", () => {
    const loop = { phase: "review" as const, reportedEvidenceId: 2, ciFailedSha: SHA };
    const mk = (ruling: boolean) =>
      snap({ headCommit: SHA, evidence: { id: 3, at: 1, ruling }, evidenceCount: 3 }, loop);
    expect(reconcile(mk(false)).loop).toMatchObject({ phase: "working", reportedEvidenceId: 3 });
    expect(reconcile(mk(true)).loop).toMatchObject({ phase: "parked", reportedEvidenceId: 3 });
  });

  it("8: a pushed sha that is not the newest commit does not park or pass the old sha", () => {
    const r = reconcile(
      inCi(
        {
          headCommit: SHA2,
          pushed: { sha: SHA, at: NOW },
          pr: pr({ headSha: SHA, ci: "passing" }),
        },
        { pushStartedAt: NOW - 1000 },
      ),
    );
    expect(r.loop.phase).toBe("ci");
    expect(r.actions).toContainEqual({ kind: "push" });
  });

  it("13: pending is measured from now, not from the poll", () => {
    const at = NOW - CI_PENDING_MAX_MS - 1;
    const stale = reconcile(inCi({ pushed: { sha: SHA, at }, pr: pr({ polledAt: at }) }));
    expect(stale.loop.parked?.kind).toBe("ci-pending");
    const ahead = reconcile(
      inCi({ pushed: { sha: SHA, at: NOW - CI_PENDING_MAX_MS }, pr: pr({ polledAt: NOW + 5 }) }),
    );
    expect(ahead.loop.phase).toBe("ci");
  });

  it("14: no CI is measured from the poll, not from now", () => {
    const at = NOW - 1000;
    const polled = reconcile(
      inCi({
        pushed: { sha: SHA, at },
        pr: pr({ ci: null, polledAt: at + NO_CI_AFTER_MS + 1 }),
      }),
    );
    expect(polled.loop.parked?.kind).toBe("no-ci");
    const old = NOW - NO_CI_AFTER_MS - 100;
    const fresh = reconcile(
      inCi({ pushed: { sha: SHA, at: old }, pr: pr({ ci: null, polledAt: old + 1 }) }),
    );
    expect(fresh.loop.phase).toBe("ci");
  });

  it("15: a run past the default expected use keeps working until the ceiling", () => {
    // the budget is the runaway ceiling; passing AUDIT_EXPECTED_TOKENS_DEFAULT is an Audit finding only
    const past = AUDIT_EXPECTED_TOKENS_DEFAULT + 1;
    expect(reconcile({ ...snap({ tokens: past }), budget: 1_500_000 }).loop.phase).toBe("working");
    const over = reconcile({ ...snap({ tokens: 1_500_001 }), budget: 1_500_000 });
    expect(over.loop.parked?.kind).toBe("budget");
  });

  it("15: only a working run parks over budget", () => {
    const r = reconcile(
      snap({ tokens: 5000, pushed: { sha: SHA, at: 1 }, headCommit: SHA }, { phase: "review" }),
    );
    expect(r.loop.phase).toBe("review");
  });

  it("done clears the flag and rate-limit notes and raises nothing", () => {
    const base = snap(
      { openNotes: [`flag:r1:hard-rules:${SHA}`, "ratelimit:r1"] },
      { phase: "done", touches, cardFor: "done:0" },
    );
    const r = reconcile({ ...base, seat: limited(base) });
    expect(r.actions).toEqual([
      { kind: "end-run" },
      { kind: "take-next" },
      { kind: "clear-note", key: `flag:r1:hard-rules:${SHA}` },
      { kind: "clear-note", key: "ratelimit:r1" },
    ]);
  });

  it("shows the rate-limit reset in the operator's zone, and leaves it out when it cannot", () => {
    const base = snap({}, { cardFor: "working:0" });
    const until = Date.UTC(2026, 9, 21, 13, 5);
    const noteText = (tz: string | null, rateLimitedUntil: number | null): string | undefined => {
      const r = reconcile({ ...base, tz, seat: seat(base, { state: "parked", rateLimitedUntil }) });
      const n = r.actions.find((a) => a.kind === "note");
      return n?.kind === "note" ? n.text : undefined;
    };
    // 13:05 UTC is 14:05 in London in October (BST)
    expect(noteText("Europe/London", until)).toBe("SULU is rate-limited until 14:05");
    expect(noteText(null, until)).toBe("SULU is rate-limited");
    expect(noteText("Not/AZone", until)).toBe("SULU is rate-limited");
    expect(noteText("Europe/London", 9e15)).toBe("SULU is rate-limited");
    expect(noteText("Europe/London", Number.NaN)).toBe("SULU is rate-limited");
  });

  it("2: a seat resumed again in the same hub run still gets its nudge", () => {
    const base = snap(
      {
        seat: { ...snap().seat, state: "idle", resumedAt: 7500, lastTurnEndedAt: 7000 },
        claimed: { "resume:r1:5000": 6100 },
        lastEngineLineAt: 6100,
      },
      { cardFor: "working:0" },
    );
    expect(sends(reconcile(base).actions)).toEqual(["nudge:r1:0:0:1"]);
  });

  it("the nudge key is epoch, report count and carry-on attempt", () => {
    const s = snap(
      {
        seat: { ...snap().seat, state: "idle", lastTurnEndedAt: 3000 },
        evidence: { id: 1, at: 2000, ruling: false },
        evidenceCount: 4,
      },
      { cardFor: "working:2", epoch: 2, reportedEvidenceId: 1 },
    );
    expect(sends(reconcile(s).actions)).toEqual(["nudge:r1:2:4:1"]);
  });

  it("the review note names the pushed sha, not the newest commit", () => {
    const s = snap(
      { headCommit: SHA2, pushed: { sha: SHA, at: 1 }, pr: pr({ ci: "passing" }) },
      { phase: "review", cardFor: "review:0" },
    );
    const notes = reconcile(s).actions.flatMap((a) => (a.kind === "note" ? [a] : []));
    expect(notes).toEqual([
      {
        kind: "note",
        key: `review:r1:${SHA}`,
        noteKind: "review",
        text: `${REF}: PR #12 is ready for review (CI passed on aaaaaaa)`,
      },
    ]);
  });

  it("the review note never reads PR #null", () => {
    const s = snap(
      { headCommit: SHA, pushed: { sha: SHA, at: 1 }, pr: null },
      { phase: "review", cardFor: "review:0" },
    );
    const text = (loop: Partial<RunLoop>): string | undefined => {
      const n = reconcile({ ...s, loop: { ...s.loop, ...loop } }).actions.find(
        (a) => a.kind === "note",
      );
      return n?.kind === "note" ? n.text : undefined;
    };
    expect(text({})).toBe(`${REF}: the PR is ready for review (CI passed on aaaaaaa)`);
    expect(text({ prNumber: 9 })).toBe(`${REF}: PR #9 is ready for review (CI passed on aaaaaaa)`);
  });

  it("8: a report with no commit that never pushes parks with a readable text", () => {
    const r = reconcile(
      inCi(
        { headCommit: null, pushed: null, pr: null },
        { pushStartedAt: NOW - NO_CI_AFTER_MS - 1 },
      ),
    );
    expect(r.loop.parked?.reason).toBe(
      "the push or PR has not shown up on GitHub after 10 minutes: no push is recorded for the run",
    );
  });

  it("15: the budget text names the ceiling", () => {
    const r = reconcile(snap({ tokens: 1500 }, { budgetExtra: 400 }));
    expect(r.loop.parked?.reason).toBe("used 1500 input + output tokens of a 1400-token budget");
  });

  describe("lines", () => {
    const working = { cardFor: "working:0" };

    it("nonew comes before resume; a claimed ci key falls through to the next line", () => {
      const s = snap(
        {
          headCommit: SHA,
          evidence: { id: 3, at: 9000, ruling: false },
          evidenceCount: 3,
          claimed: { [`ci:r1:${SHA}`]: 5000 },
          seat: { ...snap().seat, resumedAt: 6000 },
        },
        { ...working, reportedEvidenceId: 3, ciFailedSha: SHA },
      );
      // relayedSha not yet set, but the excerpt key is claimed: no excerpt, the nonew line is next
      expect(reconcile(s).actions).toEqual([
        {
          kind: "send",
          key: "nonew:r1:3",
          text: fillLoopText(NO_NEW_COMMIT_TEXT, { sha7: "aaaaaaa" }),
        },
      ]);
      expect(
        sends(reconcile({ ...s, claimed: { ...s.claimed, "nonew:r1:3": 9100 } }).actions),
      ).toEqual(["resume:r1:5000"]);
    });

    it("boundaries: nonew needs a strictly later report, resume a turn before the resume, rate-limit a time strictly past", () => {
      const nonew = snap(
        {
          headCommit: SHA,
          evidence: { id: 3, at: 5000, ruling: false },
          claimed: { [`ci:r1:${SHA}`]: 5000 },
        },
        { ...working, reportedEvidenceId: 3, ciFailedSha: SHA },
      );
      expect(sends(reconcile(nonew).actions)).toEqual([]);
      const ev = { id: 3, at: 5001, ruling: false };
      expect(sends(reconcile({ ...nonew, evidence: ev }).actions)).toEqual(["nonew:r1:3"]);

      const resume = snap(
        { seat: { ...snap().seat, resumedAt: 6000, lastTurnEndedAt: 6000 } },
        working,
      );
      expect(sends(reconcile(resume).actions)).toEqual([]);
      expect(
        sends(reconcile({ ...resume, seat: seat(resume, { lastTurnEndedAt: 5999 }) }).actions),
      ).toEqual(["resume:r1:5000"]);

      const rl = snap({}, working);
      const at = (until: number) =>
        sends(
          reconcile({ ...rl, seat: seat(rl, { state: "parked", rateLimitedUntil: until }) })
            .actions,
        );
      expect(at(NOW)).toEqual([]);
      expect(at(NOW - 1)).toEqual([`ratelimit:r1:${NOW - 1}`]);
    });

    it("no nonew line when the excerpt was claimed after the report", () => {
      const s = snap(
        {
          headCommit: SHA,
          evidence: { id: 3, at: 3000, ruling: false },
          evidenceCount: 3,
          claimed: { [`ci:r1:${SHA}`]: 5000 },
        },
        { ...working, reportedEvidenceId: 3, ciFailedSha: SHA, relayedSha: SHA },
      );
      expect(sends(reconcile(s).actions)).toEqual([]);
    });

    it("resume: resumedAt equal to hubStartedAt counts; not in ci or parked", () => {
      const at = (loop: Partial<RunLoop>, resumedAt: number, over: Partial<LoopSnapshot> = {}) => {
        const s = snap(over, loop);
        return sends(reconcile({ ...s, seat: seat(s, { resumedAt }) }).actions);
      };
      expect(at(working, 5000)).toEqual(["resume:r1:5000"]);
      expect(at(working, 4999)).toEqual([]);
      expect(
        at({ phase: "ci", cardFor: "ci:0", pushStartedAt: NOW }, 6000, {
          headCommit: SHA,
          pushed: { sha: SHA, at: NOW },
          pr: pr(),
        }),
      ).toEqual([]);
      expect(at({ phase: "parked", parked: PARKED, cardFor: "parked:0" }, 6000)).toEqual([]);
    });

    it("no rate-limit line while the loop is parked", () => {
      const s = snap({}, { phase: "parked", parked: PARKED, cardFor: "parked:0" });
      const r = reconcile({ ...s, seat: limited(s) });
      expect(sends(r.actions)).toEqual([]);
    });

    it("order: the excerpt beats the nudge and the rate-limit line; resume beats rate-limit", () => {
      const failed = { ...working, ciFailedSha: SHA, ciFails: 1 };
      const idle = snap({ seat: { ...snap().seat, state: "idle", lastTurnEndedAt: 3000 } }, failed);
      // both due: the excerpt wins
      expect(reconcile(idle).actions).toEqual([
        { kind: "ci-excerpt", key: `ci:r1:${SHA}`, sha: SHA },
      ]);
      expect(
        sends(reconcile({ ...idle, loop: { ...idle.loop, relayedSha: SHA } }).actions),
      ).toEqual(["nudge:r1:0:0:1"]);
      // excerpt vs rate-limit
      const rl = snap({}, failed);
      const r = reconcile({ ...rl, seat: limited(rl) });
      expect(outstanding(r.actions).filter((a) => a.kind !== "note")).toEqual([
        { kind: "ci-excerpt", key: `ci:r1:${SHA}`, sha: SHA },
      ]);
      // resume vs rate-limit
      const both = snap({}, working);
      const r2 = reconcile({
        ...both,
        seat: seat(both, { state: "parked", resumedAt: 6000, rateLimitedUntil: NOW - 1 }),
      });
      expect(sends(r2.actions)).toEqual(["resume:r1:5000"]);
    });
  });
});

describe("amendments from the reviews of Task 5", () => {
  const MIN = 60_000;

  it("E3: a commit made in ci after the ten minutes starts a new push, not a park", () => {
    const s = inCi(
      { headCommit: SHA2, pr: pr({ headSha: SHA, ci: "pending" }) },
      { pushFor: SHA, pushStartedAt: NOW - 11 * MIN },
    );
    const r = reconcile(s);
    expect(r.loop).toMatchObject({ phase: "ci", pushFor: SHA2, pushStartedAt: NOW });
    expect(r.actions).toEqual([{ kind: "push" }]);
    // the clock now runs from the new commit: ten minutes on, with the push still missing, it parks
    const later = reconcile({ ...s, now: NOW + 10 * MIN + 1, loop: r.loop });
    expect(later.loop.parked?.kind).toBe("stuck");
    // and a commit resets the refusals counted against the old one
    const refused = reconcile({ ...s, loop: { ...s.loop, transient: 2, lastRefusal: "old" } });
    expect(refused.loop).toMatchObject({ transient: 0, lastRefusal: null });
  });

  it("E3: without a new commit the old clock still parks", () => {
    const s = inCi({ pushed: null, pr: null }, { pushFor: SHA, pushStartedAt: NOW - 11 * MIN });
    expect(reconcile(s).loop.parked?.kind).toBe("stuck");
  });

  it("E4: the review note after a ruling says it was ruled, not that CI passed", () => {
    const s = snap(
      {
        headCommit: SHA,
        pushed: { sha: SHA, at: 1 },
        pr: pr({ ci: "failing" }),
        evidence: { id: 3, at: 1, ruling: true },
      },
      { phase: "review", cardFor: "review:1", epoch: 1, ciFailedSha: SHA, reportedEvidenceId: 3 },
    );
    const note = reconcile(s).actions.find((a) => a.kind === "note");
    expect(note).toEqual({
      kind: "note",
      key: `review:r1:${SHA}`,
      noteKind: "review",
      text: `${REF}: PR #12 needs your review (SULU ruled on the CI failure on aaaaaaa instead of fixing it)`,
    });
    const passed = reconcile({
      ...s,
      loop: { ...s.loop, ciFailedSha: SHA2 },
      pr: pr({ ci: "passing" }),
    });
    expect(JSON.stringify(passed.actions)).toContain("CI passed on aaaaaaa");
  });

  it("E5: a restart while rate-limited sends one Carry on, whichever line goes first", () => {
    const base = snap({}, { cardFor: "working:0" });
    const limited = seat(base, { state: "parked", resumedAt: 6000, rateLimitedUntil: null });
    const first = reconcile({ ...base, seat: limited });
    expect(sends(first.actions)).toEqual(["resume:r1:5000"]);
    // the resume line is claimed; the rate-limit line (no reset time known) says the same
    const HOUR = 3_600_000;
    const sentAt = NOW - 1000;
    const afterResume = { ...base, seat: limited, claimed: { "resume:r1:5000": sentAt } };
    expect(sends(reconcile(afterResume).actions)).toEqual([]);
    expect(sends(reconcile({ ...afterResume, now: sentAt + HOUR - 1 }).actions)).toEqual([]);
    // the reset time arrives in a later turn: that is a new limit and a new line
    const reset = { ...afterResume, seat: { ...limited, rateLimitedUntil: NOW - 1 } };
    expect(sends(reconcile(reset).actions)).toEqual([`ratelimit:r1:${NOW - 1}`]);
    // with no reset time the hourly try goes on: one line per hour, 1 h, 2 h and 5 h later
    const claimed: Record<string, number> = { "resume:r1:5000": sentAt };
    for (const hours of [1, 2, 5]) {
      const now = sentAt + hours * HOUR;
      const due = reconcile({ ...afterResume, now, claimed });
      const key = `ratelimit:r1:after:${Math.max(...Object.values(claimed))}`;
      expect(sends(due.actions)).toEqual([key]);
      claimed[key] = now;
      expect(sends(reconcile({ ...afterResume, now, claimed }).actions)).toEqual([]);
    }
    // the other way round: a rate-limit line sent since the resume makes the resume line redundant
    const sentFirst = {
      ...base,
      seat: { ...limited, rateLimitedUntil: NOW - 1 },
      claimed: { [`ratelimit:r1:${NOW - 1}`]: 6500 },
    };
    expect(sends(reconcile(sentFirst).actions)).toEqual([]);
  });

  it("E5: with no reset time the next try is an hour after the last, across a clock hour", () => {
    const HOUR = 3_600_000;
    const base = snap({}, { cardFor: "working:0" });
    const limited = seat(base, { state: "parked", resumedAt: 6000, rateLimitedUntil: null });
    // the resume goes at HH:59:30
    const resumeAt = Date.UTC(2026, 9, 21, 10, 59, 30);
    const claimed: Record<string, number> = { "resume:r1:5000": resumeAt };
    const at = (now: number, c = claimed) =>
      sends(reconcile({ ...base, now, seat: limited, claimed: c }).actions);
    expect(at(resumeAt + 30_000)).toEqual([]); // 11:00:00
    expect(at(resumeAt + 60_000)).toEqual([]); // 11:00:30
    expect(at(resumeAt + HOUR - 1)).toEqual([]);
    expect(at(resumeAt + HOUR)).toEqual([`ratelimit:r1:after:${resumeAt}`]);
    // and a limit hit at HH:59:30 with nothing sent before goes at once, then waits the hour
    const first = Date.UTC(2026, 9, 21, 10, 59, 30);
    const key = "ratelimit:r1:after:0";
    const noResume = (now: number, c: Record<string, number>) =>
      sends(reconcile({ ...base, now, seat: { ...limited, resumedAt: null }, claimed: c }).actions);
    expect(noResume(first, {})).toEqual([key]);
    expect(noResume(first + 30_000, { [key]: first })).toEqual([]); // 11:00:00
    expect(noResume(first + HOUR - 1, { [key]: first })).toEqual([]);
    expect(noResume(first + HOUR, { [key]: first })).toEqual([`ratelimit:r1:after:${first}`]);
  });

  it("E6: an un-park to ci does not re-park at once on a push made long before", () => {
    const old = NOW - 40 * MIN;
    const pending = inCi(
      { pushed: { sha: SHA, at: old }, pr: pr({ ci: "pending" }) },
      { unparkedAt: NOW - 1000 },
    );
    expect(reconcile(pending).loop.phase).toBe("ci");
    const never = { ...pending, loop: { ...pending.loop, unparkedAt: null } };
    expect(reconcile(never).loop.parked?.kind).toBe("ci-pending");
    const none = inCi(
      { pushed: { sha: SHA, at: old }, pr: pr({ ci: null, polledAt: NOW }) },
      { unparkedAt: NOW - 1000 },
    );
    expect(reconcile(none).loop.phase).toBe("ci");
    // once the un-park is itself old enough, the limits apply again
    const stale = {
      ...pending,
      loop: { ...pending.loop, unparkedAt: NOW - CI_PENDING_MAX_MS - 1 },
    };
    expect(reconcile(stale).loop.parked?.kind).toBe("ci-pending");
  });

  it("the returned loop shares no parked or touches object with the input", () => {
    const touches = { sha: SHA, paths: ["a.yml"], flightPowers: "superuser" as const };
    const parked = { kind: "ci", reason: "r", ended: false };
    const s = snap({}, { phase: "parked", parked, touches, cardFor: "parked:0" });
    const r = reconcile(s);
    expect(r.loop.parked).toEqual(parked);
    expect(r.loop.parked).not.toBe(s.loop.parked);
    expect(r.loop.touches).toEqual(touches);
    expect(r.loop.touches).not.toBe(s.loop.touches);
    expect(r.loop.touches?.paths).not.toBe(s.loop.touches?.paths);
    const gate = { sha: SHA, mainSha: SHA2, containsMain: true, hubOnly: true, strays: ["a"] };
    const merging = { sha: SHA, done: ["ready" as const] };
    const m = reconcile(snap({}, { phase: "parked", parked, gate, merging, cardFor: "parked:0" }));
    expect(m.loop.gate).toEqual(gate);
    expect(m.loop.gate).not.toBe(gate);
    expect(m.loop.gate?.strays).not.toBe(gate.strays);
    expect(m.loop.merging).toEqual(merging);
    expect(m.loop.merging).not.toBe(merging);
    expect(m.loop.merging?.done).not.toBe(merging.done);
    const bare = reconcile(snap({}, { phase: "parked", parked, cardFor: "parked:0" }));
    expect("gate" in bare.loop).toBe(false);
    expect("merging" in bare.loop).toBe(false);
  });

  it("the nonew rule leaves a ruling on the failed sha alone", () => {
    const loop = {
      phase: "working" as const,
      cardFor: "working:1",
      epoch: 1,
      reportedEvidenceId: 3,
      ciFailedSha: SHA,
      relayedSha: SHA,
    };
    const s = snap(
      {
        headCommit: SHA,
        evidence: { id: 3, at: NOW, ruling: true },
        evidenceCount: 3,
        claimed: { [`ci:r1:${SHA}`]: 5000 },
      },
      loop,
    );
    expect(sends(reconcile(s).actions)).toEqual([]);
    const plain = { ...s, evidence: { id: 3, at: NOW, ruling: false } };
    expect(sends(reconcile(plain).actions)).toEqual(["nonew:r1:3"]);
  });
});

describe("loopText", () => {
  const loop = (over: Partial<RunLoop> = {}): RunLoop => ({ ...NEW_LOOP, ...over });
  it("working names the ticket", () => {
    expect(loopText(REF, loop({ phase: "working" }))).toBe("Working on owner/repo#7");
    expect(LOOP_TEXT_WORKING).toBe("Working on {ref}");
  });
  it("ci names the first 7 characters of the pushed sha, else the ticket", () => {
    expect(loopText(REF, loop({ phase: "ci", pushFor: SHA }))).toBe("CI on aaaaaaa");
    expect(loopText(REF, loop({ phase: "ci", pushFor: null }))).toBe("CI on owner/repo#7");
    expect(LOOP_TEXT_CI).toBe("CI on {sha7}");
    expect(LOOP_TEXT_CI_REF).toBe("CI on {ref}");
  });
  it("review names the PR when there is one", () => {
    expect(loopText(REF, loop({ phase: "review", prNumber: 208 }))).toBe("In review · PR #208");
    expect(loopText(REF, loop({ phase: "review", prNumber: null }))).toBe("In review");
    expect(LOOP_TEXT_REVIEW_PR).toBe("In review · PR #{n}");
    expect(LOOP_TEXT_REVIEW).toBe("In review");
  });
  it("parked gives the reason", () => {
    const parked = { kind: "ci", reason: "CI failed 3 times", ended: false };
    expect(loopText(REF, loop({ phase: "parked", parked }))).toBe("Blocked: CI failed 3 times");
    expect(LOOP_TEXT_PARKED).toBe("Blocked: {reason}");
  });
  it("done names the PR when there is one", () => {
    expect(loopText(REF, loop({ phase: "done", prNumber: 9 }))).toBe("Done · PR #9");
    expect(loopText(REF, loop({ phase: "done", prNumber: null }))).toBe("Done");
    expect(LOOP_TEXT_DONE_PR).toBe("Done · PR #{n}");
    expect(LOOP_TEXT_DONE).toBe("Done");
  });
});

describe("review decisions", () => {
  const RETRO = "RETRO-1";
  const fact = (over: Partial<ReviewFact> = {}): ReviewFact => ({
    id: 1,
    sha: SHA,
    epoch: 0,
    attempt: 1,
    state: "reported",
    blocking: 0,
    minor: 0,
    failure: null,
    ...over,
  });
  const finding: ReviewFinding = {
    severity: "Important",
    file: "a.ts",
    line: 3,
    summary: "s",
    scenario: "w",
    fix: "f",
  };
  const withReview = (rows: ReviewFact[], findings: ReviewFinding[] = []): LoopReviewFacts => ({
    retro: RETRO,
    rows,
    findings,
  });
  const inReview = (
    review: LoopReviewFacts | null | undefined,
    over: Partial<LoopSnapshot> = {},
    loop: Partial<RunLoop> = {},
  ): LoopSnapshot =>
    snap(
      {
        headCommit: SHA,
        pushed: { sha: SHA, at: NOW - 60_000 },
        pr: pr({ ci: "passing" }),
        evidence: { id: 1, at: 2000, ruling: false },
        evidenceCount: 1,
        review,
        ...over,
      },
      { phase: "review", reportedEvidenceId: 1, cardFor: "review:0", ...loop },
    );
  const kinds = (a: LoopAction[], kind: LoopAction["kind"]): LoopAction[] =>
    a.filter((x) => x.kind === kind);
  const noteKinds = (a: LoopAction[]): string[] =>
    a.flatMap((x) => (x.kind === "note" ? [x.key.split(":")[0] ?? ""] : []));

  it("7a review note unchanged without a reviewer", () => {
    for (const review of [undefined, null]) {
      const a = reconcile(inReview(review)).actions;
      expect(noteKinds(a)).toEqual(["review"]);
      expect(kinds(a, "request-review")).toEqual([]);
    }
  });

  it("requests the first review", () => {
    const a = reconcile(inReview(withReview([]))).actions;
    expect(outstanding(a)).toEqual([{ kind: "request-review", sha: SHA, attempt: 1 }]);
  });

  it("waits while queued, starting or running", () => {
    for (const state of ["queued", "starting", "running"] as const) {
      const a = reconcile(inReview(withReview([fact({ state })]))).actions;
      expect(outstanding(a)).toEqual([]);
    }
  });

  it("retries a failed review once, then parks", () => {
    const one = reconcile(inReview(withReview([fact({ state: "failed", failure: "x" })])));
    expect(outstanding(one.actions)).toEqual([{ kind: "request-review", sha: SHA, attempt: 2 }]);
    const two = reconcile(
      inReview(
        withReview([
          fact({ id: 1, state: "failed", failure: "x" }),
          fact({ id: 2, attempt: 2, state: "failed", failure: "boom" }),
        ]),
      ),
    );
    expect(two.loop.phase).toBe("parked");
    expect(two.loop.parked).toEqual({
      kind: "review-failed",
      reason: reviewFailedParkText(RETRO, SHA, 2, "boom"),
      ended: false,
    });
    expect(kinds(two.actions, "request-review")).toEqual([]);
  });

  it("re-requests a superseded row with the next attempt", () => {
    const a = reconcile(inReview(withReview([fact({ state: "superseded" })]))).actions;
    expect(kinds(a, "request-review")).toEqual([{ kind: "request-review", sha: SHA, attempt: 2 }]);
  });

  it("blocking findings send one fix line, then the author owes a report", () => {
    const rows = [fact({ id: 5, blocking: 2 })];
    const r = reconcile(inReview(withReview(rows, [finding, finding])));
    expect(r.actions.filter((x) => x.kind === "send")).toEqual([
      {
        kind: "send",
        key: "fix:r1:0:5",
        text: fixText({ retro: RETRO, sha: SHA, findings: [finding, finding] }),
      },
    ]);
    const sent = inReview(withReview(rows, [finding]), { claimed: { "fix:r1:0:5": 1 } });
    expect(sends(reconcile(sent).actions)).toEqual([]);
    const idle = {
      ...sent,
      seat: seat(sent, { state: "idle" as const, lastTurnEndedAt: NOW - 1000 }),
    };
    expect(sends(reconcile(idle).actions)).toEqual([`nudge:r1:0:1:1`]);
  });

  it("the fix line for one blocking finding carries its file, line, summary and fix", () => {
    const rows = [fact({ id: 5, blocking: 1 })];
    const [send] = kinds(reconcile(inReview(withReview(rows, [finding]))).actions, "send");
    expect(send).toMatchObject({
      kind: "send",
      text: expect.stringContaining(`a.ts:3 — ${finding.summary}`),
    });
    expect((send as { text: string }).text).toContain(`Suggested fix: ${finding.fix}`);
  });

  it("a blocking review with no stored finding text wakes the author with nothing", () => {
    const rows = [fact({ id: 5, blocking: 1 })];
    const r = reconcile(inReview(withReview(rows, [])));
    expect(kinds(r.actions, "send")).toEqual([]);
  });

  it("sends an answered finding back to RETRO on the same head", () => {
    const rows = [fact({ id: 5, blocking: 1 })];
    const replied = inReview(
      withReview(rows, [finding]),
      { evidence: { id: 2, at: NOW, ruling: false }, evidenceCount: 2 },
      { reportedEvidenceId: 1, cardFor: "review:0" },
    );
    const r = reconcile(replied);
    expect(r.loop.reviewReplyTo).toBe(5);
    expect(kinds(r.actions, "request-review")).toEqual([
      { kind: "request-review", sha: SHA, attempt: 2 },
    ]);
  });

  it("accepts a developer reply when RETRO's next round is clean", () => {
    const rows = [fact({ id: 5, blocking: 1 }), fact({ id: 6, attempt: 2 })];
    const s = inReview(withReview(rows), {}, { reviewReplyTo: 5, reportedEvidenceId: 2 });
    const a = reconcile(s).actions;
    expect(kinds(a, "request-review")).toEqual([]);
    expect(sends(a)).toEqual([]);
    expect(noteKinds(a)).toEqual(["ready"]);
  });

  it("counts a reply RETRO holds toward the review cap", () => {
    const rows = [fact({ id: 1, blocking: 1 }), fact({ id: 2, attempt: 2, blocking: 1 })];
    const s = inReview(
      withReview(rows, [finding]),
      { claimed: { "fix:r1:0:1": 1 } },
      { reviewReplyTo: 1 },
    );
    expect(sends(reconcile(s).actions)).toEqual(["fix:r1:0:2"]);
  });

  it("the third blocking review sends FLIGHT the last committed-fix report and findings", () => {
    const rows = [
      fact({ id: 1, blocking: 1 }),
      fact({ id: 2, blocking: 1, sha: SHA }),
      fact({ id: 3, blocking: 1 }),
    ];
    const s = inReview(
      withReview(rows, [finding]),
      {
        claimed: { "fix:r1:0:1": 1, "fix:r1:0:2": 2 },
        evidence: { id: 3, at: NOW, ruling: false, note: "Fixed the first two findings." },
      },
      { reportedEvidenceId: 3 },
    );
    const r = reconcile(s);
    expect(r.loop.parked).toMatchObject({
      kind: "review",
      reason: reviewParkText(RETRO, SHA, 3, {
        developer: "Fixed the first two findings.",
        findings: [finding],
      }),
    });
    expect(sends(r.actions)).toEqual([]);
  });

  it("a profile's round limit parks review after one blocking review at rounds 1", () => {
    const s = inReview(withReview([fact({ id: 1, blocking: 1 })], [finding]));
    const r = reconcile({ ...s, limits: { tries: 3, rounds: 1 } });
    expect(r.loop.parked).toMatchObject({ kind: "review", reason: reviewParkText(RETRO, SHA, 1) });
    expect(sends(r.actions)).toEqual([]);
  });

  it("parks the blocking review after FLIGHT's one extra capped rework round", () => {
    const s = inReview(
      withReview([fact({ id: 4, epoch: 1, blocking: 1 })], [finding]),
      {},
      { epoch: 1, flightReworks: { [SHA]: 1 } },
    );
    const r = reconcile(s);
    expect(r.loop.parked).toMatchObject({ kind: "review", reason: reviewParkText(RETRO, SHA, 1) });
    expect(sends(r.actions)).toEqual([]);
  });

  it("a profile's round limit above 3 sends the third fix line instead of parking", () => {
    const rows = [
      fact({ id: 1, blocking: 1 }),
      fact({ id: 2, blocking: 1, sha: SHA }),
      fact({ id: 3, blocking: 1 }),
    ];
    const s = inReview(withReview(rows, [finding]), {
      claimed: { "fix:r1:0:1": 1, "fix:r1:0:2": 2 },
    });
    const r = reconcile({ ...s, limits: { tries: 3, rounds: 4 } });
    expect(r.loop.parked ?? null).toBeNull();
    expect(sends(r.actions)).toEqual(["fix:r1:0:3"]);
  });

  it("withholds the plain ready note until the PR is mergeable", () => {
    const s = inReview(withReview([fact({ id: 4, minor: 2 })]));
    if (!s.pr) throw new Error("missing PR fixture");
    const blocked = reconcile({ ...s, pr: { ...s.pr, mergeable: "CONFLICTING" } });
    expect(noteKinds(blocked.actions)).not.toContain("ready");
    expect(
      noteKinds(reconcile({ ...s, pr: { ...s.pr, mergeable: "MERGEABLE" } }).actions),
    ).toContain("ready");
  });

  it("a clean review accepts a fixed finding and raises the ready note and PR body edit", () => {
    const s = inReview(withReview([fact({ id: 4, minor: 2 })]));
    const a = reconcile(s).actions;
    expect(a).toContainEqual({
      kind: "note",
      key: `ready:r1:${SHA}`,
      noteKind: "ready",
      text: readyText(REF, 12, RETRO, SHA, 2),
    });
    expect(noteKinds(a)).toEqual(["ready"]);
    expect(kinds(a, "pr-body")).toEqual([{ kind: "pr-body", reviewId: 4 }]);
    const done = inReview(
      withReview([fact({ id: 4, minor: 2 })]),
      {},
      { prBody: { reviewId: 4, minor: 2 } },
    );
    expect(kinds(reconcile(done).actions, "pr-body")).toEqual([]);
    const none = inReview(withReview([fact({ id: 4, minor: 0 })]));
    expect(kinds(reconcile(none).actions, "pr-body")).toEqual([]);
  });

  it("a later clean review clears the earlier list", () => {
    const s = inReview(
      withReview([fact({ id: 1, minor: 3 }), fact({ id: 2, minor: 0 })]),
      {},
      { prBody: { reviewId: 1, minor: 3 } },
    );
    expect(kinds(reconcile(s).actions, "pr-body")).toEqual([{ kind: "pr-body", reviewId: 2 }]);
  });

  it("a waived sha is ready with no request and no fix", () => {
    const s = inReview(
      withReview([fact({ blocking: 1 })], [finding]),
      {},
      { reviewWaivedSha: SHA },
    );
    const a = reconcile(s).actions;
    expect(a).toContainEqual({
      kind: "note",
      key: `ready:r1:${SHA}`,
      noteKind: "ready",
      text: readyWaivedText(REF, 12, SHA),
    });
    expect(kinds(a, "request-review")).toEqual([]);
    expect(sends(a)).toEqual([]);
  });

  it("a moved head flags, supersedes and requests nothing", () => {
    const s = inReview(withReview([fact({ id: 8, state: "running" })]), {
      pr: pr({ ci: "passing", headSha: SHA2 }),
    });
    const a = reconcile(s).actions;
    expect(a).toContainEqual({
      kind: "note",
      key: `headmoved:r1:${SHA2}`,
      noteKind: "flag",
      text: headMovedText(REF, 12, SHA2, SHA),
    });
    expect(kinds(a, "supersede-review")).toEqual([{ kind: "supersede-review", reviewId: 8 }]);
    expect(kinds(a, "request-review")).toEqual([]);
  });

  it("supersedes a running row when its facts no longer fit", () => {
    const rows = withReview([fact({ id: 9, state: "running" })]);
    const sup = [{ kind: "supersede-review", reviewId: 9 }];
    expect(kinds(reconcile(inReview(rows)).actions, "supersede-review")).toEqual([]);
    const cases: Partial<LoopSnapshot>[] = [
      { pushed: { sha: SHA2, at: NOW } },
      { ended: { reason: "exit" } },
      { pr: pr({ state: "merged" }) },
      { pr: pr({ state: "closed" }) },
    ];
    for (const over of cases) {
      expect(
        kinds(reconcile(inReview(rows, over)).actions, "supersede-review"),
        JSON.stringify(over),
      ).toEqual(sup);
    }
    const parked = inReview(
      rows,
      {},
      { phase: "parked", parked: { kind: "x", reason: "y", ended: false } },
    );
    expect(kinds(reconcile(parked).actions, "supersede-review")).toEqual(sup);
    const ci = inReview(rows, {}, { phase: "ci", cardFor: "ci:0" });
    expect(kinds(reconcile(ci).actions, "supersede-review")).toEqual([]);
  });

  it("a reply to blocking findings returns to RETRO; a new commit goes to ci", () => {
    const rows = withReview([fact({ blocking: 1 })], [finding]);
    const ruling = { evidence: { id: 2, at: NOW, ruling: true }, evidenceCount: 2 };
    const r = reconcile(inReview(rows, ruling));
    expect(r.loop.reviewReplyTo).toBe(1);
    expect(r.loop.reportedEvidenceId).toBe(2);
    expect(kinds(r.actions, "request-review")).toEqual([
      { kind: "request-review", sha: SHA, attempt: 2 },
    ]);
    const c = reconcile(inReview(rows, { ...ruling, headCommit: SHA2 }));
    expect(c.loop.phase).toBe("ci");
  });

  it("a crashed pass comes out again", () => {
    for (const rows of [
      withReview([]),
      withReview([fact({ id: 2, blocking: 1 })], [finding]),
      withReview([fact({ id: 3, minor: 1 })]),
    ]) {
      const s = inReview(rows);
      const first = reconcile(s);
      expect(again(s, first.loop).actions).toEqual(first.actions);
    }
  });
});

describe("set aside", () => {
  const RETRO = "RETRO-1";
  const fact = (over: Partial<ReviewFact> = {}): ReviewFact => ({
    id: 1,
    sha: SHA,
    epoch: 0,
    attempt: 1,
    state: "reported",
    blocking: 0,
    minor: 0,
    failure: null,
    ...over,
  });
  const finding: ReviewFinding = {
    severity: "Important",
    file: "a.ts",
    line: 3,
    summary: "s",
    scenario: "w",
    fix: "f",
  };
  const facts = (rows: ReviewFact[], findings: ReviewFinding[] = []): LoopReviewFacts => ({
    retro: RETRO,
    rows,
    findings,
  });
  /** In review on its seat: pushed, PR 12 open on the sha, idle, a review seat in the session. */
  const base = (over: Partial<LoopSnapshot> = {}, loop: Partial<RunLoop> = {}): LoopSnapshot => {
    const s = snap(
      {
        headCommit: SHA,
        pushed: { sha: SHA, at: NOW - 60_000 },
        pr: pr({ ci: "passing" }),
        evidence: { id: 1, at: 2000, ruling: false },
        evidenceCount: 1,
        review: facts([fact()]),
        asideOk: true,
        ...over,
      },
      { phase: "review", reportedEvidenceId: 1, cardFor: "review:0", ...loop },
    );
    return { ...s, seat: { ...s.seat, state: "idle", lastTurnEndedAt: NOW - 1000, ...over.seat } };
  };
  const asideOf = (wake = false): Partial<RunLoop> => ({ aside: { worktree: "/w/r1", wake } });
  /** The run off its seat: the seat is another run's, so the snapshot is not current. */
  const off = (over: Partial<LoopSnapshot> = {}, loop: Partial<RunLoop> = asideOf()) => {
    const s = base(over, loop);
    return { ...s, seat: { ...s.seat, state: "stopped" as const, inTurn: true, holdsRun: false } };
  };
  const kindsOf = (a: LoopAction[]): string[] => a.map((x) => x.kind);
  const blocking = facts([fact({ id: 5, blocking: 1 })], [finding]);

  it("texts", () => {
    expect(asideEventText("SULU")).toBe("in review; SULU is free for its next ticket");
    expect(asideInCiEventText("SULU")).toBe("in CI; SULU is free for its next ticket");
    expect(wokenEventText("SULU")).toBe("back to SULU for rework");
    expect(NEW_LOOP.aside).toBeNull();
  });

  it("sets aside at review", () => {
    const a = reconcile(base()).actions;
    expect(a.filter((x) => x.kind === "set-aside")).toHaveLength(1);
    expect(sends(a)).toEqual([]);
  });

  it("sets aside in ci once the PR is open on the pushed sha", () => {
    const ci = (over: Partial<LoopSnapshot> = {}) =>
      base(
        { pr: pr({ ci: "pending" }), review: facts([]), ...over },
        { phase: "ci", pushFor: SHA, pushStartedAt: NOW - 60_000, cardFor: "ci:0" },
      );
    const r = reconcile(ci());
    expect(r.actions.filter((x) => x.kind === "set-aside")).toHaveLength(1);
    expect(r.loop.phase).toBe("ci");
    expect(sends(r.actions)).toEqual([]);
    const b = ci();
    const not: [string, LoopSnapshot][] = [
      ["no PR", ci({ pr: null })],
      ["in turn", ci({ seat: { ...b.seat, inTurn: true } })],
      ["head moved", ci({ pr: pr({ ci: "pending", headSha: SHA2 }) })],
    ];
    for (const [name, s] of not) {
      expect(kindsOf(reconcile(s).actions), name).not.toContain("set-aside");
    }
  });

  it("no review seat: held", () => {
    expect(kindsOf(reconcile(base({ asideOk: false })).actions)).not.toContain("set-aside");
  });

  describe("rework due on the seat", () => {
    /** A new ticket being built, its seat between turns, another run of the seat due back. */
    const building = (over: Partial<LoopSnapshot> = {}, loop: Partial<RunLoop> = {}) => {
      const s = base(
        { headCommit: null, pushed: null, pr: null, review: null, reworkDue: true, ...over },
        { phase: "working", cardFor: "working:0", ...loop },
      );
      return { ...s, seat: { ...s.seat, state: "idle" as const, inTurn: false, ...over.seat } };
    };

    it("sets the working run aside at its turn end, with no review seat needed", () => {
      for (const s of [building(), building({ asideOk: false })]) {
        const r = reconcile(s);
        expect(kindsOf(r.actions).filter((k) => k === "set-aside")).toHaveLength(1);
        expect(r.loop.phase).toBe("working");
      }
    });

    it("waits for the turn to end, and for the seat to be free of questions", () => {
      const b = building();
      const cases: [string, LoopSnapshot][] = [
        ["in turn", building({ seat: { ...b.seat, inTurn: true } })],
        ["open question", building({ seat: { ...b.seat, openQuestion: true } })],
        ["not idle", building({ seat: { ...b.seat, state: "running" } })],
        ["seat does not hold the run", building({ seat: { ...b.seat, holdsRun: false } })],
        ["no rework due", building({ reworkDue: false })],
        ["already pushed", building({ pushed: { sha: SHA, at: NOW - 60_000 } })],
        ["ended", building({ ended: { reason: "done" } })],
      ];
      for (const [name, s] of cases) {
        expect(kindsOf(reconcile(s).actions), name).not.toContain("set-aside");
      }
    });

    it("the displaced run is flagged to come back, behind the rework", () => {
      const r = reconcile(off({ reworkDue: true }, { phase: "working", ...asideOf() }));
      expect(r.loop.aside).toEqual({ worktree: "/w/r1", wake: true });
    });
  });

  it("not set aside", () => {
    const b = base();
    const cases: [string, LoopSnapshot][] = [
      ["in turn", base({ seat: { ...b.seat, inTurn: true } })],
      ["open question", base({ seat: { ...b.seat, openQuestion: true } })],
      ["unpushed commit", base({ headCommit: SHA2 })],
      ["ci failed on it", base({}, { ciFailedSha: SHA })],
      ["head moved", base({ pr: pr({ ci: "passing", headSha: SHA2 }) })],
      ["fix due", base({ review: blocking })],
      ["fix claimed, not reported", base({ review: blocking, claimed: { "fix:r1:0:5": 1 } })],
      ["seat does not hold the run", base({ seat: { ...b.seat, holdsRun: false } })],
      ["not idle", base({ seat: { ...b.seat, state: "running" } })],
    ];
    for (const [name, s] of cases) {
      expect(kindsOf(reconcile(s).actions), name).not.toContain("set-aside");
    }
  });

  it("findings wake it", () => {
    const r = reconcile(off({ review: blocking }));
    expect(r.loop.aside).toEqual({ worktree: "/w/r1", wake: true });
    expect(kindsOf(r.actions).filter((k) => k === "wake")).toHaveLength(1);
    expect(sends(r.actions)).toEqual([]);
  });

  it("a park on the seat's own work wakes it", () => {
    const r = reconcile(
      off(
        {},
        {
          ...asideOf(),
          phase: "parked",
          parked: { kind: "ci", reason: "x", ended: false },
        },
      ),
    );
    expect(r.loop.aside?.wake).toBe(true);
    expect(kindsOf(r.actions)).toContain("wake");
  });

  it("the third blocking review parks and the run stays aside", () => {
    const rows = facts(
      [fact({ id: 1, blocking: 1 }), fact({ id: 2, blocking: 1 }), fact({ id: 3, blocking: 1 })],
      [finding],
    );
    const r = reconcile(off({ review: rows, claimed: { "fix:r1:0:1": 1, "fix:r1:0:2": 2 } }));
    expect(r.loop.phase).toBe("parked");
    expect(r.loop.parked?.kind).toBe("review");
    expect(r.loop.aside?.wake).toBe(false);
    expect(kindsOf(r.actions)).not.toContain("wake");
  });

  it.each(["review", "review-ruling", "ruling", "review-failed"])(
    "a run parked on a %s park waits on someone else: it is set aside, and an aside one is not woken",
    (kind) => {
      const parked: Partial<RunLoop> = {
        phase: "parked",
        parked: { kind, reason: "x", ended: false },
      };
      expect(kindsOf(reconcile(base({}, parked)).actions)).toContain("set-aside");
      const r = reconcile(off({}, { ...parked, ...asideOf(false) }));
      expect(r.loop.aside?.wake).toBe(false);
      expect(kindsOf(r.actions)).not.toContain("wake");
    },
  );

  it("settling the wait brings the run back", () => {
    // the park lifted: the run is working again, and an aside one is woken
    const r = reconcile(off({}, { phase: "working", parked: null, ...asideOf(false) }));
    expect(r.loop.aside?.wake).toBe(true);
    expect(kindsOf(r.actions)).toContain("wake");
  });

  it("clean review stays aside", () => {
    const r = reconcile(off({ review: facts([fact({ minor: 1 })]) }));
    expect(r.loop.aside).toEqual({ worktree: "/w/r1", wake: false });
    expect(kindsOf(r.actions)).not.toContain("wake");
    expect(kindsOf(r.actions)).not.toContain("set-aside");
    expect(sends(r.actions)).toEqual([]);
  });

  it("a run parked on a controller check is set aside, and an aside one is not woken", () => {
    const parked: Partial<RunLoop> = {
      phase: "parked",
      parked: { kind: CONTROLLER_CHECK_PARK, reason: "check", ended: false },
    };
    const a = reconcile(base({}, parked)).actions;
    expect(a.filter((x) => x.kind === "set-aside")).toHaveLength(1);
    const r = reconcile(off({}, { ...parked, ...asideOf(false) }));
    expect(r.loop.aside?.wake).toBe(false);
    expect(kindsOf(r.actions)).not.toContain("wake");
    // any other park brings an aside run back
    const other = reconcile(
      off({}, { phase: "parked", parked: { kind: "ci", reason: "x", ended: false }, ...asideOf() }),
    );
    expect(other.loop.aside?.wake).toBe(true);
  });

  it("back on its seat clears aside", () => {
    const r = reconcile(base({}, asideOf(true)));
    expect(r.loop.aside).toBeNull();
    expect(kindsOf(r.actions)).not.toContain("wake");
  });

  it("ended: no wake", () => {
    const r = reconcile(off({ ended: { reason: "stopped" } }, asideOf(true)));
    expect(kindsOf(r.actions)).not.toContain("wake");
  });
});

describe("merge workspace", () => {
  const RETRO = "RETRO-1";
  const MAIN = "cccccccc3333";
  const rows = (over: Partial<ReviewFact> = {}): LoopReviewFacts => ({
    retro: RETRO,
    rows: [
      {
        id: 1,
        sha: SHA,
        epoch: 0,
        attempt: 1,
        state: "reported",
        blocking: 0,
        minor: 0,
        failure: null,
        ...over,
      },
    ],
    findings: [],
  });
  const gateOf = (over: Partial<NonNullable<RunLoop["gate"]>> = {}): RunLoop["gate"] => ({
    sha: SHA,
    mainSha: MAIN,
    containsMain: true,
    hubOnly: true,
    strays: [],
    ...over,
  });
  const merge = (over: Partial<LoopSnapshot> = {}, loop: Partial<RunLoop> = {}): LoopSnapshot =>
    snap(
      {
        autoMerge: true,
        hardRulesSet: true,
        headCommit: SHA,
        pushed: { sha: SHA, at: NOW - 60_000 },
        pr: pr({ ci: "passing", isDraft: true }),
        evidence: { id: 1, at: 2000, ruling: false },
        evidenceCount: 1,
        review: rows(),
        ...over,
      },
      {
        phase: "review",
        reportedEvidenceId: 1,
        cardFor: "review:0",
        gate: gateOf(),
        touches: { sha: SHA, paths: [] },
        ...loop,
      },
    );
  const kindsOf = (a: LoopAction[]): string[] => a.map((x) => x.kind);
  const readyKey = `ready:r1:${SHA}`;

  it("superuser hard rules await FLIGHT, then merge only the cleared diff", () => {
    const base = merge(
      { flightPowers: "superuser" },
      {
        touches: { sha: SHA, paths: ["apps/server/src/flight/tools.ts"] },
        gate: gateOf(),
      },
    );
    const held = reconcile(base);
    expect(held.loop.awaitingFlight).toBe(SHA);
    expect(kindsOf(held.actions)).not.toContain("merge");
    const cleared = { ...base.loop, flightClearedSha: SHA };
    expect(kindsOf(reconcile({ ...base, loop: cleared }).actions)).toContain("merge");
    const changed = { ...cleared, flightClearedSha: SHA2 };
    expect(kindsOf(reconcile({ ...base, loop: changed }).actions)).not.toContain("merge");
    expect(
      kindsOf(reconcile({ ...base, loop: { ...changed, carry: { from: SHA2, to: SHA } } }).actions),
    ).toContain("merge");
    expect(reconcile({ ...base, flightPowers: "standard" }).loop.awaitingFlight).toBeNull();
  });

  it.each([
    "CLAUDE.md",
    ".github/workflows/ci.yml",
    ".github/CODEOWNERS",
    ".github/actions/setup/action.yml",
  ])("FLIGHT clearance cannot waive %s", (path) => {
    const s = merge(
      { flightPowers: "superuser" },
      {
        touches: { sha: SHA, paths: [path] },
        flightClearedSha: SHA,
      },
    );
    expect(kindsOf(reconcile(s).actions)).not.toContain("merge");
  });

  it("holds Mission Control block changes on a standard repo with no hard-rule touches", () => {
    const unchanged = merge(
      { flightPowers: "standard" },
      { gate: gateOf({ missionControlChanged: false }) },
    );
    expect(kindsOf(reconcile(unchanged).actions)).toContain("merge");
    const changed = merge(
      { flightPowers: "standard" },
      { gate: gateOf({ missionControlChanged: true }) },
    );
    expect(kindsOf(reconcile(changed).actions)).not.toContain("merge");
    expect(reconcile(changed).actions).toContainEqual({
      kind: "note",
      key: readyKey,
      noteKind: "ready",
      text: readyHardRuleText(REF, 12, ["CLAUDE.md"]),
    });
  });

  it("CLAUDE prose outside the Mission Control block can be cleared", () => {
    const s = merge(
      { flightPowers: "superuser" },
      {
        touches: { sha: SHA, paths: ["CLAUDE.md"] },
        flightClearedSha: SHA,
        gate: gateOf({ missionControlChanged: false }),
      },
    );
    expect(kindsOf(reconcile(s).actions)).toContain("merge");
  });

  it("a review waiver still requires passing CI", () => {
    const s = merge(
      { flightPowers: "superuser", pr: pr({ ci: "failing" }) },
      { reviewWaivedSha: SHA, ciFailedSha: SHA },
    );
    expect(kindsOf(reconcile(s).actions)).not.toContain("merge");
  });
  it.each(["apps/other/hard-rule.ts", "package.json"])(
    "clearance never hides a stray: %s",
    (path) => {
      const s = merge(
        { flightPowers: "superuser" },
        {
          flightClearedSha: SHA,
          touches: { sha: SHA, paths: [path] },
          gate: gateOf({ strays: [path] }),
        },
      );
      expect(kindsOf(reconcile(s).actions)).not.toContain("merge");
    },
  );

  it("superuser accepted review merges, but operator stops still hold", () => {
    const s = merge({ flightPowers: "superuser" }, { reviewWaivedSha: SHA });
    expect(kindsOf(reconcile(s).actions)).toContain("merge");
    expect(
      kindsOf(reconcile({ ...s, seat: { ...s.seat, state: "stopped" } }).actions),
    ).not.toContain("merge");
  });

  it("all six facts: mark-ready then merge, and no ready note", () => {
    const r = reconcile(merge());
    expect(r.loop.phase).toBe("review");
    expect(r.actions.filter((x) => x.kind === "mark-ready" || x.kind === "merge")).toEqual([
      { kind: "mark-ready" },
      { kind: "merge", sha: SHA },
    ]);
    expect(kindsOf(r.actions)).not.toContain("note");
  });

  it("records HUD design checks without making them a merge gate", () => {
    const result = reconcile(
      merge(
        { review: rows({ design: { result: "fail", note: "overflow at 1366px" } as never }) },
        { gate: gateOf({ webChanged: true }) },
      ),
    );
    expect(result.actions.filter((x) => x.kind === "mark-ready" || x.kind === "merge")).toEqual([
      { kind: "mark-ready" },
      { kind: "merge", sha: SHA },
    ]);
  });

  it("skips mark-ready for a PR that is not a draft or already marked", () => {
    const a = reconcile(merge({ pr: pr({ ci: "passing", isDraft: false }) })).actions;
    expect(kindsOf(a).filter((k) => k === "mark-ready" || k === "merge")).toEqual(["merge"]);
    const b = reconcile(merge({}, { merging: { sha: SHA, done: ["ready"] } })).actions;
    expect(kindsOf(b).filter((k) => k === "mark-ready" || k === "merge")).toEqual(["merge"]);
  });

  it("draft workspace and absent autoMerge keep today's note and never merge", () => {
    for (const autoMerge of [undefined, false]) {
      const a = reconcile(merge({ autoMerge })).actions;
      expect(kindsOf(a)).not.toContain("merge");
      expect(a).toContainEqual({
        kind: "note",
        key: readyKey,
        noteKind: "ready",
        text: readyText(REF, 12, RETRO, SHA, 0),
      });
    }
  });

  const noMerge = (r: ReturnType<typeof reconcile>): void => {
    expect(kindsOf(r.actions)).not.toContain("merge");
    expect(kindsOf(r.actions)).not.toContain("mark-ready");
  };

  const readyNotes = (r: ReturnType<typeof reconcile>): LoopAction[] =>
    r.actions.filter((x) => x.kind === "note" && x.noteKind === "ready");

  it("CI pending or failing: no merge, no ready note", () => {
    for (const ci of ["pending", "failing"] as const) {
      const r = reconcile(merge({ pr: pr({ ci }) }));
      noMerge(r);
      expect(readyNotes(r), ci).toEqual([]);
    }
  });

  it("mc/review not passing on GitHub: no merge", () => {
    for (const reviewStatus of ["pending", "failing", null] as const) {
      noMerge(reconcile(merge({ pr: pr({ ci: "passing", isDraft: true, reviewStatus }) })));
    }
  });

  it("an unreported head: no merge, no ready note", () => {
    const r = reconcile(merge({ pr: pr({ ci: "passing", headSha: null }) }));
    noMerge(r);
    expect(readyNotes(r)).toEqual([]);
    const draft = reconcile(merge({ autoMerge: false, pr: pr({ ci: "pending" }) }));
    expect(readyNotes(draft)).toHaveLength(1);
  });

  it("mark-ready is skipped only when the ready step is for this sha", () => {
    const old = reconcile(merge({}, { merging: { sha: SHA2, done: ["ready"] } })).actions;
    expect(kindsOf(old)).toContain("mark-ready");
  });

  it("a hard-rule touch does not hide foreign commits or another stray", () => {
    const touches = { sha: SHA, paths: ["CLAUDE.md"] };
    const foreign = reconcile(merge({}, { touches, gate: gateOf({ hubOnly: false }) }));
    noMerge(foreign);
    expect(foreign.loop.parked).toEqual({
      kind: "gate",
      reason: "commits on the branch that Mission Control did not make",
      ended: false,
    });
    const stray = reconcile(
      merge({}, { touches, gate: gateOf({ strays: ["CLAUDE.md", "x/a.ts"] }) }),
    );
    noMerge(stray);
    expect(stray.loop.parked).toEqual({
      kind: "gate",
      reason: "changes outside SULU's area: x/a.ts",
      ended: false,
    });
  });

  describe("parked after the merge", () => {
    const parkedAfter = (prState: "open" | "merged"): LoopSnapshot =>
      merge(
        { pr: pr({ state: prState, ci: "passing" }), openNotes: ["blocked:r1:0"] },
        {
          phase: "parked",
          cardFor: "parked:0",
          parked: { kind: "merge-step", reason: "close the issue failed: x", ended: false },
          merging: { sha: SHA, done: ["ready", "merge"] },
        },
      );
    it("emits nothing and stays parked whatever the poll says", () => {
      for (const st of ["open", "merged"] as const) {
        const s = parkedAfter(st);
        const r = reconcile(s);
        expect(r.loop.phase, st).toBe("parked");
        expect(r.loop.parked?.kind, st).toBe("merge-step");
        expect(r.actions, st).toEqual([]);
      }
    });
  });

  describe("after the merge, in a merge workspace", () => {
    const doneLoop = (done: ("ready" | "merge" | "close" | "delete-remote" | "delete-local")[]) =>
      merge({}, { phase: "done", merging: { sha: SHA, done } });
    const steps = (r: ReturnType<typeof reconcile>): string[] =>
      r.actions.flatMap((x) => (x.kind === "clear-note" ? [] : [x.kind]));

    it("a done run with a partly filled merging emits only the missing steps", () => {
      const r = reconcile(doneLoop(["ready", "merge", "close"]));
      expect(steps(r)).toEqual([
        "file-minor-issue",
        "delete-remote-branch",
        "move-card",
        "end-run",
        "delete-local-branch",
        "take-next",
      ]);
    });

    it("delete-local already done: no delete-local-branch", () => {
      const r = reconcile(doneLoop(["ready", "merge", "delete-local"]));
      expect(steps(r)).toEqual([
        "close-issue",
        "file-minor-issue",
        "delete-remote-branch",
        "move-card",
        "end-run",
        "take-next",
      ]);
    });

    it("a hand-merged PR records the merge", () => {
      const r = reconcile(merge({ pr: pr({ state: "merged", ci: "passing" }) }));
      expect(r.loop.merging).toEqual({ sha: SHA, done: ["merge"] });
      const next = reconcile({ ...merge({ pr: pr({ state: "merged" }) }), loop: r.loop });
      expect(steps(next)).toEqual([
        "close-issue",
        "file-minor-issue",
        "delete-remote-branch",
        "move-card",
        "end-run",
        "delete-local-branch",
        "take-next",
      ]);
    });

    it("no sha at all: the other steps, and a flag that the remote branch stays", () => {
      const s = merge({ pr: pr({ state: "merged", headSha: null }), pushed: null });
      const r = reconcile(s);
      expect(steps(r)).toEqual([
        "close-issue",
        "file-minor-issue",
        "note",
        "move-card",
        "end-run",
        "delete-local-branch",
        "take-next",
        "event",
      ]);
      expect(r.actions).toContainEqual({
        kind: "note",
        key: "flag:r1:no-sha-delete",
        noteKind: "flag",
        text: noShaDeleteText(REF),
      });
      expect(kindsOf(r.actions)).not.toContain("delete-remote-branch");
    });

    it("a merge workspace with no review does not merge and keeps today's note", () => {
      const r = reconcile(merge({ review: null }));
      noMerge(r);
      expect(r.actions).toContainEqual({
        kind: "note",
        key: `review:r1:${SHA}`,
        noteKind: "review",
        text: `${REF}: PR #12 is ready for review (CI passed on ${SHA.slice(0, 7)})`,
      });
    });
  });

  it("a ruling on CI: today's ruled note, no merge", () => {
    const r = reconcile(merge({}, { ciFailedSha: SHA }));
    noMerge(r);
    expect(r.actions).toContainEqual({
      kind: "note",
      key: readyKey,
      noteKind: "ready",
      text: readyRuledText(REF, 12, RETRO, SHA),
    });
  });

  it("a blocking review: no merge, no ready note", () => {
    const r = reconcile(merge({ review: rows({ blocking: 2 }) }));
    noMerge(r);
    expect(r.actions.some((x) => x.kind === "note" && x.noteKind === "ready")).toBe(false);
  });

  it("a waived review: today's waived note, no merge", () => {
    const r = reconcile(merge({}, { reviewWaivedSha: SHA }));
    noMerge(r);
    expect(r.actions).toContainEqual({
      kind: "note",
      key: readyKey,
      noteKind: "ready",
      text: readyWaivedText(REF, 12, SHA),
    });
  });

  it("behind main: a clear, reviewed, green PR merges", () => {
    const r = reconcile(merge({}, { gate: gateOf({ containsMain: false }) }));
    expect(r.loop.phase).toBe("review");
    expect(r.actions).toContainEqual({ kind: "merge", sha: SHA });
    expect(kindsOf(r.actions)).not.toContain("update-branch");
  });

  it("behind main alone raises no hold note", () => {
    const r = reconcile(merge({}, { gate: gateOf({ containsMain: false }) }));
    expect(kindsOf(r.actions)).not.toContain("note");
  });

  it("strays park the run with kind gate", () => {
    const r = reconcile(merge({}, { gate: gateOf({ strays: ["x/a.ts", "y.ts"] }) }));
    noMerge(r);
    expect(r.loop.parked).toEqual({
      kind: "gate",
      reason: "changes outside SULU's area: x/a.ts, y.ts",
      ended: false,
    });
  });

  it("commits Mission Control did not make park the run with kind gate", () => {
    const r = reconcile(merge({}, { gate: gateOf({ hubOnly: false }) }));
    noMerge(r);
    expect(r.loop.parked).toEqual({
      kind: "gate",
      reason: "commits on the branch that Mission Control did not make",
      ended: false,
    });
  });

  it("gate or touches missing or for another sha: nothing merges and nothing parks", () => {
    const cases: Partial<RunLoop>[] = [
      { gate: null },
      { gate: gateOf({ sha: SHA2 }) },
      { touches: null },
      { touches: { sha: SHA2, paths: [] } },
    ];
    for (const loop of cases) {
      const r = reconcile(merge({}, loop));
      noMerge(r);
      expect(r.loop.phase, JSON.stringify(loop)).toBe("review");
    }
  });

  it("a hard-rule touch: the operator merges", () => {
    const r = reconcile(
      merge(
        {},
        { touches: { sha: SHA, paths: ["CLAUDE.md"] }, gate: gateOf({ strays: ["CLAUDE.md"] }) },
      ),
    );
    noMerge(r);
    expect(r.loop.phase).toBe("review");
    expect(r.actions).toContainEqual({
      kind: "note",
      key: readyKey,
      noteKind: "ready",
      text: readyHardRuleText(REF, 12, ["CLAUDE.md"]),
    });
    expect(r.actions).toContainEqual(
      expect.objectContaining({ key: hardRulesFlagKey("r1", ["CLAUDE.md"]), noteKind: "flag" }),
    );
  });

  it("a hard-rule touch behind main: the operator merges", () => {
    const r = reconcile(
      merge(
        {},
        {
          touches: { sha: SHA, paths: ["CLAUDE.md"] },
          gate: gateOf({ strays: ["CLAUDE.md"], containsMain: false }),
        },
      ),
    );
    noMerge(r);
    expect(r.actions).not.toContainEqual(expect.objectContaining({ key: `behind:r1:${SHA}` }));
    expect(r.actions).toContainEqual({
      kind: "note",
      key: readyKey,
      noteKind: "ready",
      text: readyHardRuleText(REF, 12, ["CLAUDE.md"]),
    });
  });

  it("the head moved off the pushed sha: no merge", () => {
    noMerge(reconcile(merge({ pr: pr({ ci: "passing", headSha: SHA2 }) })));
    noMerge(reconcile(merge({ headCommit: SHA2 })));
  });

  const after = (r: ReturnType<typeof reconcile>): string[] =>
    r.actions.flatMap((x) =>
      x.kind === "event"
        ? [`event:${x.text}`]
        : x.kind === "move-card" || x.kind === "clear-note"
          ? []
          : [x.kind],
    );

  it("after the merge: the steps come out in order even while the poll says open", () => {
    const r = reconcile(merge({}, { merging: { sha: SHA, done: ["ready", "merge"] } }));
    expect(r.loop.phase).toBe("done");
    expect(r.actions.filter((x) => x.kind !== "clear-note")).toEqual([
      { kind: "close-issue" },
      { kind: "file-minor-issue" },
      { kind: "delete-remote-branch", sha: SHA },
      { kind: "move-card", column: "Done" },
      { kind: "end-run" },
      { kind: "delete-local-branch" },
      { kind: "take-next" },
      { kind: "event", text: "merged" },
    ]);
  });

  it("the card moves to Done once: after close-issue, before end-run, and not on a second pass", () => {
    const r = reconcile(merge({ pr: pr({ state: "merged", ci: "passing" }) }));
    const kinds = r.actions.map((x) => x.kind);
    expect(r.actions.filter((x) => x.kind === "move-card")).toEqual([
      { kind: "move-card", column: "Done" },
    ]);
    expect(kinds.indexOf("close-issue")).toBeLessThan(kinds.indexOf("move-card"));
    expect(kinds.indexOf("move-card")).toBeLessThan(kinds.indexOf("end-run"));
    const next = reconcile({
      ...merge({ pr: pr({ state: "merged" }) }),
      loop: { ...r.loop, cardFor: "done:0" },
    });
    expect(next.actions.some((x) => x.kind === "move-card")).toBe(false);
  });

  it("a step already done does not come out again", () => {
    const r = reconcile(
      merge(
        {},
        { merging: { sha: SHA, done: ["ready", "merge", "close", "file-minor", "delete-remote"] } },
      ),
    );
    expect(after(r)).toEqual(["end-run", "delete-local-branch", "take-next", "event:merged"]);
  });

  it("a PR merged by hand gets the same sequence", () => {
    const r = reconcile(merge({ pr: pr({ state: "merged", ci: "passing" }) }));
    expect(after(r)).toEqual([
      "close-issue",
      "file-minor-issue",
      "delete-remote-branch",
      "end-run",
      "delete-local-branch",
      "take-next",
      "event:merged",
    ]);
    expect(r.actions).toContainEqual({ kind: "delete-remote-branch", sha: SHA });
  });

  it("a draft workspace's merged PR emits a Done move that the server refuses", () => {
    const r = reconcile(merge({ autoMerge: false, pr: pr({ state: "merged" }) }));
    expect(after(r)).toEqual(["end-run", "take-next", "event:merged"]);
    expect(r.actions.filter((x) => x.kind === "move-card")).toEqual([
      { kind: "move-card", column: "Done" },
    ]);
    expect(r.actions.map((x) => x.kind).indexOf("move-card")).toBeLessThan(
      r.actions.map((x) => x.kind).indexOf("end-run"),
    );
  });

  it("mergeStepFailedText names the step and why", () => {
    expect(mergeStepFailedText(MERGE_STEP_WORDS.merge, "conflict")).toBe("merge failed: conflict");
    expect(MERGE_STEP_WORDS).toEqual({
      ready: "mark ready",
      merge: "merge",
      close: "close the issue",
      "delete-remote": "delete the remote branch",
    });
  });
});

describe("carried review", () => {
  const RETRO = "RETRO-1";
  const SHA3 = "ddddddd4444";
  const fact = (over: Partial<ReviewFact> = {}): ReviewFact => ({
    id: 1,
    sha: SHA,
    epoch: 0,
    attempt: 1,
    state: "reported",
    blocking: 0,
    minor: 0,
    failure: null,
    ...over,
  });
  const finding: ReviewFinding = {
    severity: "Important",
    file: "a.ts",
    line: 3,
    summary: "s",
    scenario: "w",
    fix: "f",
  };
  /** The head moved from SHA (reviewed) to SHA2 by a hub-made merge of main. */
  const carried = (
    over: Partial<LoopSnapshot> = {},
    loop: Partial<RunLoop> = {},
    row: Partial<ReviewFact> = {},
    findings: ReviewFinding[] = [],
  ): LoopSnapshot => {
    const head = over.pushed?.sha ?? SHA2;
    return snap(
      {
        autoMerge: true,
        hardRulesSet: true,
        headCommit: head,
        pushed: { sha: head, at: NOW - 60_000 },
        pr: pr({ ci: "passing", headSha: head }),
        evidence: { id: 1, at: 2000, ruling: false },
        evidenceCount: 1,
        review: { retro: RETRO, rows: [fact(row)], findings },
        ...over,
      },
      {
        phase: "review",
        reportedEvidenceId: 1,
        cardFor: "review:0",
        gate: { sha: head, mainSha: "cccccccc3333", containsMain: true, hubOnly: true, strays: [] },
        touches: { sha: head, paths: [] },
        carry: { from: SHA, to: SHA2 },
        ...loop,
      },
    );
  };
  const of = (a: LoopAction[], kind: LoopAction["kind"]): LoopAction[] =>
    a.filter((x) => x.kind === kind);

  it("a hub-made, conflict-free main merge carries a clean verdict, with no new request-review", () => {
    const a = reconcile(carried()).actions;
    expect(of(a, "request-review")).toEqual([]);
    expect(a).toContainEqual({ kind: "merge", sha: SHA2 });
    const fresh = reconcile(carried({}, { carry: null })).actions;
    expect(of(fresh, "request-review")).toEqual([
      { kind: "request-review", sha: SHA2, attempt: 1 },
    ]);
  });

  it("a running review isn't superseded by such a merge", () => {
    const cases: [Partial<LoopSnapshot>, Partial<RunLoop>][] = [
      [{}, {}],
      [{}, { phase: "ci" }],
      [{ pr: pr({ ci: "passing", headSha: SHA }) }, {}],
    ];
    for (const [over, loop] of cases) {
      const a = reconcile(carried(over, loop, { state: "running" })).actions;
      expect(of(a, "supersede-review")).toEqual([]);
      expect(of(a, "request-review")).toEqual([]);
    }
    const fresh = reconcile(carried({}, { carry: null }, { state: "running" })).actions;
    expect(of(fresh, "supersede-review")).toEqual([{ kind: "supersede-review", reviewId: 1 }]);
  });

  it("a seat commit, a foreign commit, or a changed PR diff each still request a fresh review", () => {
    const seatCommit = reconcile(carried({ pushed: { sha: SHA3, at: NOW - 60_000 } })).actions;
    expect(of(seatCommit, "request-review")).toEqual([
      { kind: "request-review", sha: SHA3, attempt: 1 },
    ]);
    const foreign = reconcile(carried({}, { carry: { from: "eeeeeee5555", to: SHA2 } })).actions;
    expect(of(foreign, "request-review")).toEqual([
      { kind: "request-review", sha: SHA2, attempt: 1 },
    ]);
    const changed = reconcile(carried({}, { carry: null })).actions;
    expect(of(changed, "request-review")).toEqual([
      { kind: "request-review", sha: SHA2, attempt: 1 },
    ]);
    const waived = reconcile(carried({}, { reviewWaivedSha: SHA })).actions;
    expect(of(waived, "request-review")).toEqual([
      { kind: "request-review", sha: SHA2, attempt: 1 },
    ]);
  });

  it("a blocking verdict carries as blocking", () => {
    const r = reconcile(carried({}, {}, { blocking: 1 }, [finding]));
    expect(of(r.actions, "request-review")).toEqual([]);
    expect(of(r.actions, "merge")).toEqual([]);
    expect(sends(r.actions)).toContain("fix:r1:0:1");
  });
});

describe("ciVerdict", () => {
  const chk = (name: string, state: PrCheck["state"]): PrCheck => ({
    name,
    kind: "check",
    state,
    conclusion: state,
    attempt: null,
    url: null,
  });

  it("leaves out a failing mc/review", () => {
    expect(ciVerdict([chk("mc/review", "failing"), chk("check", "passing")], [])).toEqual({
      ci: "passing",
      failing: [],
      pending: [],
      missing: [],
    });
  });

  it("mc/review alone is no CI", () => {
    expect(ciVerdict([chk("mc/review", "passing")], [])).toEqual({
      ci: null,
      failing: [],
      pending: [],
      missing: [],
    });
  });

  it("a required check not reported is missing", () => {
    expect(ciVerdict([chk("check", "passing")], ["check", "e2e"])).toEqual({
      ci: "pending",
      failing: [],
      pending: [],
      missing: ["e2e"],
    });
  });

  it("a failing check outside required does not count", () => {
    expect(ciVerdict([chk("check", "passing"), chk("lint", "failing")], ["check"]).ci).toBe(
      "passing",
    );
  });

  it("a name listed twice takes its worst state", () => {
    const v = ciVerdict([chk("check", "passing"), chk("check", "failing")], []);
    expect(v).toMatchObject({ ci: "failing", failing: ["check"] });
  });
});

describe("isHardRulesFlagKey", () => {
  const hash = "00c296383f2b261b436d5a1d7951db07f82174af";
  it("matches the keys hardRulesFlagKey builds, including run ids that contain a colon", () => {
    expect(isHardRulesFlagKey(hardRulesFlagKey("guido-1:20261021T165337Z", ["a.yml"]))).toBe(true);
    expect(isHardRulesFlagKey(hardRulesFlagKey("guido-1", ["a.yml"]))).toBe(true);
    expect(isHardRulesFlagKey(hardRulesFlagKey("run-1", ["a".repeat(64)]))).toBe(true);
  });
  it("matches nothing else", () => {
    expect(isHardRulesFlagKey(`flag:guido-1:20261021T165337Z:other:${hash}`)).toBe(false);
    expect(isHardRulesFlagKey(`flake:guido-1:hard-rules:${hash}`)).toBe(false);
    expect(isHardRulesFlagKey("flag:guido-1:hard-rules:not-a-sha")).toBe(false);
    expect(isHardRulesFlagKey(`flag:hard-rules:${hash}`)).toBe(false);
    expect(isHardRulesFlagKey(`flag:guido-1:hard-rules:${hash.toUpperCase()}`)).toBe(false);
    expect(isHardRulesFlagKey(`flag:guido-1:hard-rules:${hash.slice(1)}`)).toBe(false);
    expect(isHardRulesFlagKey(`flag:guido-1:hard-rules:${hash}0`)).toBe(false);
    expect(isHardRulesFlagKey(`flag:guido-1:hard-rules:${hash}:x`)).toBe(false);
  });
});

describe("controllerCheckOf", () => {
  it("reads the section up to the next heading of its level", () => {
    const body = "## Done when\n- a\n\n## Controller check\nOpen it.\n- light\n\n## Security\nx";
    expect(controllerCheckOf(body)).toBe("Open it.\n- light");
    expect(controllerCheckOf("## Controller check\r\nLook.\r\n")).toBe("Look.");
    expect(controllerCheckOf("## Controller check\nA\n### Sub\nB\n## End")).toBe("A\n### Sub\nB");
  });
  it("holds on near-miss headings, not on prose", () => {
    for (const h of [
      "## Controller check",
      "### Controller check",
      "## controller check",
      "## Controller checks",
      "## Controller check (browser)",
      "   ## Controller check ##",
      "> ## Controller check",
      "# Controller Check:",
      "## Manual controller check",
      "## Controller-check",
      "> > ## Controller check",
      "- ## Controller check",
    ])
      expect(controllerCheckOf(`${h}\nx`)).toBe("x");
    expect(controllerCheckOf("")).toBeNull();
    expect(controllerCheckOf("## Done when\n- a")).toBeNull();
    expect(controllerCheckOf("text ## Controller check\nx")).toBeNull();
    expect(controllerCheckOf("    ## Controller check\nx")).toBeNull();
    expect(controllerCheckOf("the controller check is below")).toBeNull();
    expect(controllerCheckOf("```md\n## Controller check\nx\n```\n")).toBeNull();
    expect(controllerCheckOf("```pnpm -s lint``` must pass\n## Controller check\nx")).toBe("x");
    expect(controllerCheckOf("```js\nunclosed\n## Controller check\nx")).toBe("x");
    expect(controllerCheckOf("````\n```\n## Controller check\n````\n")).toBeNull();
    expect(controllerCheckOf("~~~\n## Controller check\n~~~\n## Controller check\nreal")).toBe(
      "real",
    );
  });
  it("an empty section is still a check", () => {
    expect(controllerCheckOf("## Controller check\n## Next")).toBe("");
  });
  it("a cut body the reader did not read holds; the reader's own answer wins", () => {
    const t = { body: "x", bodyTruncated: true };
    expect(ticketControllerCheck(t)).toBe("");
    expect(ticketControllerCheck({ ...t, controllerCheck: null })).toBeNull();
    expect(ticketControllerCheck({ ...t, controllerCheck: "look" })).toBe("look");
    expect(ticketControllerCheck({ body: "x", bodyTruncated: false })).toBeNull();
  });
  it("cuts a long reason", () => {
    const r = controllerCheckParkText("a".repeat(40), "word ".repeat(200));
    expect(r.length).toBeLessThan(360);
    expect(r).toContain("see ticket");
  });
});

describe("withControllerCheckItem", () => {
  const item = "Screenshot the HUD";
  it("appends under an existing section, leaving the rest alone", () => {
    const body = "## Why\nx\n\n## Controller check\n- Open it.\n\n## Size\nS\n";
    const r = withControllerCheckItem(body, item);
    expect(r).toEqual({
      body: `## Why\nx\n\n## Controller check\n- Open it.\n- ${item}\n\n## Size\nS\n`,
      added: true,
      removed: false,
    });
  });
  it("fills an empty section", () => {
    expect(withControllerCheckItem("## Controller check\n\n## Size\nS", item).body).toBe(
      `## Controller check\n\n- ${item}\n\n## Size\nS`,
    );
  });
  it("creates the section before Size, before Security, or at the end", () => {
    expect(withControllerCheckItem("## Why\nx\n\n## Size\nS\n", item).body).toBe(
      `## Why\nx\n\n## Controller check\n\n- ${item}\n\n## Size\nS\n`,
    );
    expect(withControllerCheckItem("## Why\nx\n## Security\nnone", item).body).toBe(
      `## Why\nx\n## Controller check\n\n- ${item}\n\n## Security\nnone`,
    );
    expect(withControllerCheckItem("## Why\nx\n", item).body).toBe(
      `## Why\nx\n\n## Controller check\n\n- ${item}\n`,
    );
    expect(withControllerCheckItem("## Why\nx", item).body).toBe(
      `## Why\nx\n\n## Controller check\n\n- ${item}\n`,
    );
    expect(withControllerCheckItem("", item).body).toBe(`## Controller check\n\n- ${item}\n`);
  });
  it("moves an identical done-when line, and only that line", () => {
    const body = `## Done when\n- Tests pass\n- [ ] ${item}\n- Lint\n\n## Size\nS\n`;
    const r = withControllerCheckItem(body, item);
    expect(r.removed).toBe(true);
    expect(r.body).toBe(
      `## Done when\n- Tests pass\n- Lint\n\n## Controller check\n\n- ${item}\n\n## Size\nS\n`,
    );
  });
  it("does not touch a similar line, a fenced one, or another section's", () => {
    const body = `## Why\n- ${item}\n\n## Done when\n- ${item} too\n\`\`\`\n- ${item}\n\`\`\`\n`;
    const r = withControllerCheckItem(body, item);
    expect(r.removed).toBe(false);
    expect(r.body.startsWith(body)).toBe(true);
  });
  it("adds nothing twice, and the result holds the merge", () => {
    const once = withControllerCheckItem("## Why\nx\n", item);
    const twice = withControllerCheckItem(once.body, item);
    expect(twice).toEqual({ body: once.body, added: false, removed: false });
    expect(controllerCheckOf(once.body)).toBe(`- ${item}`);
  });
  it("keeps CRLF line ends", () => {
    expect(withControllerCheckItem("## Why\r\nx\r\n", item).body).toBe(
      `## Why\r\nx\r\n\r\n## Controller check\r\n\r\n- ${item}\r\n`,
    );
  });
});
