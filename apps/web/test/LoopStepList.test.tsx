import {
  type CrewLoop,
  type LoopTry,
  pushChecksText,
  type RunLoop,
  type RunLoopView,
  reviewParkText,
} from "@mc/core";
import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LoopSteps } from "../src/agent/LoopSteps.tsx";
import { crewRow, MIN, NOW } from "./fixtures.ts";

const SHA = "c74cdfc1234567";
const BARE = pushChecksText("80001f8abcdef", [{ command: "pnpm -s test", state: "missing" }]);
// as the engine records it when the push never shows up on GitHub
const REFUSAL = `the push or PR for 80001f8 has not shown up on GitHub after 10 minutes (${BARE}): no PR for the pushed commit`;
const FINDINGS = `RETRO-CX reviewed c74cdfc and found 1 issue to resolve before this PR can merge. ${"Please address each finding below. ".repeat(30)}\n\n1. [Important] apps/web/src/x.ts:1 — a long finding\n   Why: ${"because ".repeat(40)}`;

const tryAt = (
  step: LoopTry["step"],
  n: number,
  outcome: LoopTry["outcome"],
  over: Partial<LoopTry> = {},
): LoopTry => ({
  step,
  fix: false,
  n,
  tokens: 100,
  startedAt: NOW - 60 * MIN + n * 2 * MIN,
  endedAt: NOW - 60 * MIN + n * 2 * MIN + MIN,
  outcome,
  reason: null,
  ...over,
});

const loopOf = (over: Partial<CrewLoop>): CrewLoop => ({
  phase: "ci",
  text: "CI is running",
  prNumber: 77,
  parked: null,
  ...over,
});

const show = (loop: CrewLoop, tries: LoopTry[], runLoop: Partial<RunLoop>) => {
  const view = { loop: { phase: loop.phase, ...runLoop }, tries, round: 1 } as RunLoopView;
  return render(
    <LoopSteps
      row={crewRow({ loop, hudState: "idle" })}
      view={view}
      prs={[]}
      limits={{ tries: 3, rounds: 3 }}
      now={NOW}
    />,
  );
};

const longestLine = (el: HTMLElement) =>
  Math.max(...(el.innerText ?? el.textContent ?? "").split("\n").map((l) => l.length));

describe("Loop steps as a list", () => {
  it("collapses 15 identical refusals into one try line with ×15, and keeps lines short", () => {
    const tries = [
      tryAt("working", 1, "pass"),
      ...Array.from({ length: 15 }, (_, i) =>
        tryAt("ci", i + 1, "fail", { reason: REFUSAL, tokens: 470 }),
      ),
    ];
    const { container } = show(loopOf({ phase: "ci", text: "CI is running" }), tries, {});
    const ci = container.querySelectorAll<HTMLElement>(".vstep")[1] as HTMLElement;
    expect(ci.querySelector(".att")).toBeNull();
    fireEvent.click(within(ci).getByRole("button", { name: /tries/ }));
    const lines = ci.querySelectorAll(".att");
    expect(lines).toHaveLength(1);
    expect(lines[0]?.textContent).toContain("×15");
    expect(lines[0]?.textContent).toContain("refused: checks not run");
    const text = container.textContent ?? "";
    expect(text).not.toContain("Not pushed");
    for (const line of (container as HTMLElement).innerHTML.split(/<[^>]+>/)) {
      expect(line.length).toBeLessThanOrEqual(120);
    }
  });

  it("shows a held review as a short reason, and the findings only after details", () => {
    const tries = [
      tryAt("working", 1, "pass"),
      tryAt("ci", 1, "pass"),
      tryAt("review", 1, "parked", { reason: FINDINGS }),
    ];
    const { container } = show(
      loopOf({ phase: "parked", text: `Blocked: ${FINDINGS}`, parked: FINDINGS }),
      tries,
      { pushFor: SHA, parked: { kind: "review", reason: FINDINGS, ended: false } },
    );
    const text = container.textContent ?? "";
    expect(text).toContain("waiting: 1 finding held on c74cdfc");
    expect(text).not.toContain("a long finding");
    fireEvent.click(within(container as HTMLElement).getByRole("button", { name: "details" }));
    expect(container.textContent).toContain("a long finding");
  });

  it("gives each step its time and tokens, and tries only above one", () => {
    const tries = [
      tryAt("working", 1, "pass", { tokens: 1000 }),
      tryAt("ci", 1, "fail", { reason: "server-process" }),
      tryAt("ci", 2, "running", { endedAt: null }),
    ];
    const { container } = show(loopOf({ phase: "ci" }), tries, {});
    const steps = container.querySelectorAll<HTMLElement>(".vstep");
    expect(steps[0]?.querySelector(".titer")).toBeNull();
    expect(steps[0]?.querySelector(".vmeta")?.textContent).toBe("1m · 1.0k");
    expect(steps[1]?.querySelector(".titer")?.textContent).toBe("2 tries");
    expect(longestLine(container as HTMLElement)).toBeLessThan(120);
  });
});

describe("the held step's count and mark", () => {
  it("reads the held count from the review event, not the capped park text", () => {
    const park = reviewParkText("RETRO-CX", SHA, 3, {
      developer: "Fixed it.",
      findings: [
        { severity: "Important", file: "a.ts", line: 1, summary: "one", scenario: "why", fix: "f" },
      ] as never,
    });
    const tries = [tryAt("working", 1, "pass"), tryAt("review", 1, "parked", { reason: park })];
    const view = {
      loop: {
        phase: "parked",
        pushFor: SHA,
        parked: { kind: "review", reason: park, ended: false },
      },
      tries,
      events: [
        { key: "e", runId: "r", at: 1, text: "RETRO-CX reviewed c74cdfc: 1 blocking, 0 minor" },
      ],
      round: 3,
    } as unknown as RunLoopView;
    const { container } = render(
      <LoopSteps
        row={crewRow({
          loop: loopOf({ phase: "parked", parked: park, text: park }),
          hudState: "idle",
        })}
        view={view}
        prs={[]}
        limits={{ tries: 3, rounds: 3 }}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain("waiting: 1 finding held on c74cdfc");
  });

  it("marks a failure park as failed and a review park as waiting", () => {
    const marks = (kind: string, step: LoopTry["step"]) => {
      const tries = [tryAt("working", 1, "pass"), tryAt(step, 1, "parked", { reason: "x" })];
      const { container } = show(
        loopOf({ phase: "parked", parked: "x", text: "Blocked: x" }),
        tries,
        { pushFor: SHA, parked: { kind, reason: "x", ended: false } },
      );
      const held = container.querySelector(".vstep.fail, .vstep.warn") as HTMLElement;
      return [held.className, held.querySelector(".tdot")?.textContent];
    };
    expect(marks("ci", "ci")).toEqual(["vstep fail", "✗"]);
    expect(marks("stuck", "ci")).toEqual(["vstep fail", "✗"]);
    expect(marks("review", "review")).toEqual(["vstep warn", "!"]);
  });
});
