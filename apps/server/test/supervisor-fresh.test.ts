// Register the shared mocks before importing the modules under test.
import "./supervisor-harness.ts";

import { readFileSync } from "node:fs";
import { freshEventText, NEW_LOOP, RUN_NOTES_LINE, SEAT_FRESH_MAX } from "@mc/core";
import { describe, expect, it } from "vitest";
import { blockedHere, skipTestsIf } from "./sandbox-gaps.ts";
import {
  type FetchTicket,
  make,
  recorded,
  seatState,
  store,
  TICKET,
  until,
  userLines,
} from "./supervisor-harness.ts";

skipTestsIf(await blockedHere("crew-run"));

/** The fake CLI's start records, in order: each holds the argv it was started with. */
const starts = (): string[][] =>
  recorded()
    .filter((l) => Array.isArray(l.argv))
    .map((l) => l.argv as string[]);
const flagOf = (argv: string[], name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i < 0 ? undefined : argv[i + 1];
};
const loopEvents = (runId: string) =>
  store
    .loopEvents(0)
    .filter((e) => e.runId === runId)
    .map((e) => e.text);

type Line = { type?: string; subtype?: string; session_id?: string };
/** The run's transcript, as complete JSON lines. */
const transcriptLines = (runId: string): Line[] =>
  readFileSync(store.run(runId)?.transcriptPath ?? "", "utf8")
    .split("\n")
    .filter((l) => l.startsWith("{") && l.endsWith("}"))
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Line];
      } catch {
        return [];
      }
    });
const isResult = (l: Line): boolean => l.type === "result";
/** Long enough for a turn end's fresh-session check to have run. */
const settle = () => new Promise((r) => setTimeout(r, 300));

async function loopRun(over: Parameters<typeof make>[0] = {}, prNumber: number | null = null) {
  const m = make(over);
  m.sup.start();
  const { runId } = await m.sup.startRun("guido-1", 42, { loop: { ...NEW_LOOP, prNumber } });
  return { ...m, runId };
}

describe("fresh sessions (#2319)", () => {
  it("restarts a crashed run in a fresh session that starts from its run notes", async () => {
    const { sup, runId } = await loopRun();
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    const run = store.run(runId);
    const ticket = run?.ticket ?? "";
    store.seatMemory.putRunNotes({
      repoId: "mc",
      ticket,
      runId,
      seatId: "guido-1",
      updatedAt: Date.now(),
      done: ["store tables committed as abc1234"],
      next: "write the run_notes tool",
      blockers: [],
      decisions: ["notes are kept per ticket"],
    });
    const first = run?.sessionId ?? "";

    await sup.message("guido-1", "DIE", { interrupt: false });
    await until(() => expect(starts()).toHaveLength(2));
    await until(() => expect(userLines().at(-1)).toContain("Fresh session"));
    await until(() => expect(seatState("guido-1")).toBe("idle"));

    // the same run carries on: not ended, no second run, a new session started fresh
    expect(store.run(runId)).toMatchObject({ status: "running", endedAt: null });
    expect(store.runs("guido-1", 5)).toHaveLength(1);
    const argv = starts()[1] ?? [];
    expect(argv).not.toContain("--resume");
    const fresh = flagOf(argv, "--session-id");
    expect(fresh).toBeDefined();
    expect(fresh).not.toBe(first);
    expect(store.run(runId)?.sessionId).toBe(fresh);
    expect(store.seatSession("guido-1")?.cliSessionId).toBe(fresh);

    // its first line is the fresh brief: the notes, and the order not to redo committed work
    const brief = userLines().at(-1) ?? "";
    expect(brief).toContain("Fresh session");
    expect(brief).toContain("its CLI stopped mid-run");
    expect(brief).toContain("Do not redo committed work");
    expect(brief).toContain("store tables committed as abc1234");
    expect(brief).toContain("Next: write the run_notes tool");
    expect(brief).toContain("notes are kept per ticket");
    expect(loopEvents(runId)).toContain(freshEventText("crash"));
  });

  it("puts lessons FLIGHT accepted in the next start brief, and run notes the ticket already has", async () => {
    const lesson = (text: string) =>
      store.seatMemory.proposeLesson({
        repoId: "mc",
        text,
        seatId: "guido-2",
        runId: "guido-2:r",
        at: Date.now(),
      });
    const accepted = lesson("pnpm dev -- drops the port flags; set PORT instead.");
    lesson("still only proposed");
    const rejected = lesson("rejected by FLIGHT");
    expect(store.seatMemory.decideLesson("mc", accepted, true, "flight-1", Date.now())).toBe(true);
    expect(store.seatMemory.decideLesson("mc", rejected, false, "flight-1", Date.now())).toBe(true);
    // another repo's lesson stays with that repo
    const elsewhere = store.seatMemory.proposeLesson({
      repoId: "other",
      text: "another repo's lesson",
      seatId: "guido-9",
      runId: "guido-9:r",
      at: Date.now(),
    });
    store.seatMemory.decideLesson("other", elsewhere, true, "flight-1", Date.now());

    await loopRun();
    await until(() => expect(userLines()).toHaveLength(1));
    const brief = userLines()[0] ?? "";
    expect(brief).toContain("## Repo lessons");
    expect(brief).toContain("pnpm dev -- drops the port flags; set PORT instead.");
    expect(brief).not.toContain("still only proposed");
    expect(brief).not.toContain("rejected by FLIGHT");
    expect(brief).not.toContain("another repo's lesson");
    expect(brief).toContain(RUN_NOTES_LINE);
  });

  it("starts a fresh session at the end of a turn once the context passes the threshold", async () => {
    const { runId } = await loopRun({ seatContextRotateTokens: 1 });
    // every turn ends past the line: fresh sessions follow until the hour's cap, then it carries on
    await until(() => expect(starts()).toHaveLength(1 + SEAT_FRESH_MAX));
    await until(() => expect(userLines()).toHaveLength(1 + SEAT_FRESH_MAX));
    await until(() =>
      expect(transcriptLines(runId).filter(isResult)).toHaveLength(1 + SEAT_FRESH_MAX),
    );
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await settle();
    expect(starts()).toHaveLength(1 + SEAT_FRESH_MAX);
    expect(store.run(runId)).toMatchObject({ status: "running", endedAt: null });
    expect(loopEvents(runId).filter((t) => t === freshEventText("context"))).toHaveLength(
      SEAT_FRESH_MAX,
    );
    expect(new Set(starts().map((a) => flagOf(a, "--session-id"))).size).toBe(1 + SEAT_FRESH_MAX);

    // never mid-turn: each session's turn has its result before the next session starts
    const lines = transcriptLines(runId);
    const sessions = lines.filter((l) => l.type === "system" && l.subtype === "init");
    for (let i = 1; i < sessions.length; i++) {
      const prev = sessions[i - 1]?.session_id;
      const at = lines.indexOf(sessions[i] as (typeof lines)[number]);
      expect(lines.slice(0, at).some((l) => l.type === "result" && l.session_id === prev)).toBe(
        true,
      );
    }
  });

  it("starts a fresh session at the end of a turn after a CLI version change", async () => {
    let version = "1.0.0";
    const { sup, runId } = await loopRun({ cliVersion: async () => version });
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    expect(starts()).toHaveLength(1);
    expect(store.run(runId)?.cliVersion).toBe("1.0.0");

    version = "2.0.0";
    await sup.message("guido-1", "hello", { interrupt: false });
    await until(() => expect(starts()).toHaveLength(2));
    await until(() => expect(userLines().at(-1)).toContain("the Claude CLI was updated"));
    expect(store.run(runId)).toMatchObject({ status: "running", cliVersion: "2.0.0" });
    await until(() => expect(transcriptLines(runId).filter(isResult)).toHaveLength(3));
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await until(() => expect(loopEvents(runId)).toContain(freshEventText("cli-version")));
    // on the new CLI now: the next turn's end starts nothing
    await sup.message("guido-1", "hello again", { interrupt: false });
    await until(() => expect(transcriptLines(runId).filter(isResult)).toHaveLength(4));
    await settle();
    expect(starts()).toHaveLength(2);
  });
});

describe("what a fresh session starts from (#2319 review)", () => {
  /** The ticket reads once (the start), then GitHub cannot be reached. */
  const readsOnce = (): FetchTicket => {
    let reads = 0;
    return async () => {
      reads++;
      if (reads > 1) throw new Error("gh: could not reach GitHub");
      return TICKET;
    };
  };

  it("carries the ticket body and the PR's open review findings, file, line and fix", async () => {
    const { sup, runId } = await loopRun({}, 9);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    const review = store.requestReview({
      authorRunId: runId,
      repoId: "mc",
      seatId: "retro",
      prNumber: 9,
      sha: "a".repeat(40),
      epoch: 0,
      attempt: 1,
      round: 1,
      at: 4,
    });
    if (review === null) throw new Error("missing review");
    store.setReviewState(review, ["queued"], "running", { runId: "retro:review", at: 4 });
    store.recordFindings(review, "retro:review", {
      verdict: { spec: "fail", quality: "pass" },
      summary: "findings",
      findings: [
        {
          severity: "Important",
          file: "apps/server/src/stop.ts",
          line: 12,
          summary: "stop() races the exit handler",
          scenario: "exit during stop",
          fix: "await the exit before clearing the seat",
        },
      ],
      at: 5,
    });

    await sup.message("guido-1", "DIE", { interrupt: false });
    await until(() => expect(userLines().at(-1)).toContain("Fresh session"));
    const brief = userLines().at(-1) ?? "";
    expect(brief).toContain(TICKET.body);
    expect(brief).toContain("## Open review findings");
    expect(brief).toContain(
      "Open Important finding at apps/server/src/stop.ts:12: stop() races the exit handler. Required next action: await the exit before clearing the seat",
    );
  });

  it("resumes the crashed session, never a fresh one without its ticket, when the ticket cannot be read", async () => {
    const { sup, runId } = await loopRun({ fetchTicket: readsOnce() });
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    const first = store.run(runId)?.sessionId ?? "";

    await sup.message("guido-1", "DIE", { interrupt: false });
    await until(() => expect(starts()).toHaveLength(2));
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    expect(flagOf(starts()[1] ?? [], "--resume")).toBe(first);
    expect(starts()[1]).not.toContain("--session-id");
    expect(store.run(runId)).toMatchObject({ status: "running", endedAt: null, sessionId: first });
    expect(userLines().some((l) => l.includes("Fresh session"))).toBe(false);
    expect(loopEvents(runId)).not.toContain(freshEventText("crash"));
  });

  it("past the context line, carries on in its session while the ticket cannot be read", async () => {
    const { runId } = await loopRun({ fetchTicket: readsOnce(), seatContextRotateTokens: 1 });
    await until(() => expect(transcriptLines(runId).filter(isResult)).toHaveLength(1));
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    await settle();
    expect(starts()).toHaveLength(1);
    expect(store.run(runId)).toMatchObject({ status: "running", endedAt: null });
    expect(loopEvents(runId)).not.toContain(freshEventText("context"));
  });
});
