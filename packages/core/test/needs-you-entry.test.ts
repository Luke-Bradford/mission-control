import { describe, expect, it } from "vitest";
import { FLIGHT_LEFT_NOTE_KEY, FLIGHT_NOT_TRIAGING_KEY } from "../src/flight.ts";
import { guardAckKey } from "../src/guard.ts";
import { NEEDS_YOU_ASK_MAX, needsYouAlert, needsYouEntryFaults } from "../src/needs-you-entry.ts";
import type { AttentionBrief, AttentionItem } from "../src/types.ts";

const brief = (over: Partial<AttentionBrief> = {}): AttentionBrief => ({
  for: "operator",
  ask: "Merge PR 1412, which changes the away-mode rules, now that review and CI passed?",
  context: "PR 1412 changes packages/core/src/away.ts.",
  recommendation: "Merge: review is clean on the most capable model.",
  options: [
    { id: "merge", label: "Merge", answer: "Merge PR 1412." },
    { id: "hold", label: "Hold", answer: "Leave PR 1412 open." },
  ],
  recommendedOptionId: "merge",
  basis: "RETRO-1 review",
  at: 1_000,
  ...over,
});

const item = (over: Partial<AttentionItem> = {}): AttentionItem => ({
  key: "pr:mission-control#1412:1",
  kind: "pr",
  agentId: null,
  repoId: "mission-control",
  text: "PR #1412 · You: review",
  tool: null,
  at: 1_000,
  url: "https://github.com/o/mission-control/pull/1412",
  escalationId: null,
  ticket: "mission-control#1400",
  brief: brief(),
  acked: false,
  ...over,
});

describe("needsYouEntryFaults", () => {
  it("passes FLIGHT's complete question", () => {
    expect(needsYouEntryFaults(item())).toEqual([]);
  });

  it("passes the hub's alerts without a brief", () => {
    for (const key of [
      FLIGHT_NOT_TRIAGING_KEY,
      `note:${FLIGHT_LEFT_NOTE_KEY}`,
      "note:hub-update-held",
      `note:${guardAckKey(7)}`,
    ]) {
      expect(needsYouAlert({ key, kind: "blocked" })).toBe(true);
      expect(needsYouEntryFaults(item({ key, kind: "blocked", brief: undefined }))).toEqual([]);
    }
    expect(needsYouEntryFaults(item({ kind: "ratelimit", brief: undefined }))).toEqual([]);
  });

  it("refuses an item with no brief, or one FLIGHT kept", () => {
    expect(needsYouEntryFaults(item({ brief: undefined }))[0]).toMatch(
      /^no brief for the operator/,
    );
    expect(needsYouEntryFaults(item({ brief: brief({ for: "flight" }) }))[0]).toMatch(
      /^no brief for the operator/,
    );
  });

  it("refuses a question that does not ask", () => {
    expect(needsYouEntryFaults(item({ brief: brief({ ask: "" }) }))).toEqual([
      "no question: say in one sentence what the operator must decide",
    ]);
    expect(needsYouEntryFaults(item({ brief: brief({ ask: "None for the operator." }) }))).toEqual([
      "the question does not ask anything: end it with ?",
    ]);
  });

  it("refuses a question over the length limit", () => {
    const ask = `${"a".repeat(NEEDS_YOU_ASK_MAX)}?`;
    expect(needsYouEntryFaults(item({ brief: brief({ ask }) }))).toEqual([
      `the question is over ${NEEDS_YOU_ASK_MAX} characters: one sentence`,
    ]);
  });

  it.each([
    ["Merge https://github.com/o/r/pull/1?", /web address/],
    ["Decide prFlow 1407:stage:clearance:1793825335003?", /raw signal id/],
    ["Is 1793825335003 too late?", /raw timestamp/],
    ["[operator-decision] Resume the studio loop?", /\[tag\] prefix/],
  ])("refuses machine text in the question: %s", (ask, fault) => {
    expect(needsYouEntryFaults(item({ brief: brief({ ask }) })).join("; ")).toMatch(fault);
  });

  it("refuses fewer than 2 or more than 4 options, and incomplete ones", () => {
    const one = [{ label: "Merge", answer: "Merge it." }];
    expect(needsYouEntryFaults(item({ brief: brief({ options: one }) }))).toEqual([
      "1 options: give 2 to 4, each with what happens if chosen",
    ]);
    const five = Array.from({ length: 5 }, (_, n) => ({ label: `O${n}`, answer: `A${n}` }));
    expect(needsYouEntryFaults(item({ brief: brief({ options: five }) }))[0]).toMatch(/^5 options/);
    const blank = [
      { label: "Merge", answer: "" },
      { label: "Hold", answer: "Hold it." },
    ];
    expect(needsYouEntryFaults(item({ brief: brief({ options: blank }) }))).toEqual([
      "an option has no label or no answer",
    ]);
  });

  it("lets a person's message use suggested replies instead of options", () => {
    const person = {
      source: { kind: "github" as const, messageId: "m1", revision: "r1" },
      replies: [{ id: "r", label: "Thanks", text: "Thanks, merged." }],
    };
    expect(
      needsYouEntryFaults(item({ kind: "person", brief: brief({ options: [], person }) })),
    ).toEqual([]);
  });

  it("refuses no recommendation, no ticket or PR, and no raised time", () => {
    expect(
      needsYouEntryFaults(
        item({ ticket: null, url: null, at: 0, brief: brief({ recommendation: " " }) }),
      ),
    ).toEqual([
      "no recommendation: say which option FLIGHT would pick, and why",
      "no ticket or PR: name what the question is about",
      "no time raised",
    ]);
  });
});
