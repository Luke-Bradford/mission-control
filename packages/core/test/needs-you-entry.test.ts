import { describe, expect, it } from "vitest";
import { FLIGHT_LEFT_NOTE_KEY, FLIGHT_NOT_TRIAGING_KEY } from "../src/flight.ts";
import { guardAckKey } from "../src/guard.ts";
import {
  NEEDS_YOU_ASK_MAX,
  needsYouAlert,
  needsYouEntryFaults,
  QUEUE_REORDER_ITEM_PREFIX,
} from "../src/needs-you-entry.ts";
import type { AttentionBrief, AttentionItem } from "../src/types.ts";

const brief = (over: Partial<AttentionBrief> = {}): AttentionBrief => ({
  for: "operator",
  ask: "Merge the change to the away-mode rules now that review and the checks have passed?",
  context:
    "The crew changed how away mode decides what to do while you are out. Review found nothing wrong and the checks passed. If you do not decide, it stays open and the crew moves on to other work.",
  recommendation: "Merge: review is clean on the most capable model.",
  options: [
    { id: "merge", label: "Merge", answer: "Merge: the change goes live and the crew moves on." },
    { id: "hold", label: "Hold", answer: "Hold: it stays open until you say." },
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
    for (const key of [FLIGHT_NOT_TRIAGING_KEY, "note:hub-update-held", `note:${guardAckKey(7)}`]) {
      expect(needsYouAlert({ key, kind: "blocked" })).toBe(true);
      expect(needsYouEntryFaults(item({ key, kind: "blocked", brief: undefined }))).toEqual([]);
    }
    expect(needsYouEntryFaults(item({ kind: "ratelimit", brief: undefined }))).toEqual([]);
    // the operator's own queue reorder: its choices are the hub's, not FLIGHT's
    const bare = { kind: "approval" as const, ticket: null, url: null };
    expect(needsYouEntryFaults(item({ ...bare, key: `${QUEUE_REORDER_ITEM_PREFIX}abc` }))).toEqual(
      [],
    );
    // another approval (a loop's mvp-ready escalation) needs FLIGHT's brief like anything else
    expect(needsYouAlert({ key: "esc:shop#9", kind: "approval" })).toBe(false);
  });

  it("keeps unfinished-wake reminders outside the operator's own alerts", () => {
    expect(needsYouAlert({ key: `note:${FLIGHT_LEFT_NOTE_KEY}`, kind: "blocked" })).toBe(false);
  });

  it("treats an old brief with no `for` as the operator's", () => {
    const { for: _for, ...legacy } = brief();
    expect(needsYouEntryFaults(item({ brief: legacy }))).toEqual([]);
  });

  it("takes the ticket FLIGHT names when the item has none", () => {
    const bare = { ticket: null, url: null };
    expect(needsYouEntryFaults(item({ ...bare, brief: brief({ ticket: "mc#7" }) }))).toEqual([]);
    expect(needsYouEntryFaults(item(bare))).toEqual([
      "no ticket or PR: name it with ticket in brief_item",
    ]);
  });

  it("wants the question to end with ?", () => {
    expect(needsYouEntryFaults(item({ brief: brief({ ask: "Merge? It is ready." }) }))).toEqual([
      "the question does not end with ?: ask one question",
    ]);
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
      "the question does not end with ?: ask one question",
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

  const SEATS = ["guido-1", "inco-2", "guido-cx"];
  const asking = (ask: string) => needsYouEntryFaults(item({ brief: brief({ ask }) }), SEATS);
  const context = (c: string) => needsYouEntryFaults(item({ brief: brief({ context: c }) }), SEATS);

  it.each([
    ["Merge PR 1412 now?", "a ticket or PR number"],
    ["Merge PR #1412 now?", "a ticket or PR number"],
    ["Merge repo#1412 now?", "a ticket or PR number"],
    ["Merge #1412 now?", "a ticket or PR number"],
    ["Merge commit a1b2c3d now?", "a commit code"],
    ["Merge 0123456789abcdef0123456789abcdef01234567 now?", "a commit code"],
    ["Is packages/core/src/away.ts right?", "a file path"],
    ["Is /etc/hosts.conf right?", "a file path"],
    ["Should guido-1 carry on?", "a seat id"],
    ["Should INCO-2 carry on?", "a seat id"],
    ["Should GUIDO-CX carry on?", "a seat id"],
    ["Should @CAPCOM decide?", "the CAPCOM tag"],
    ["Run mcp__mc__brief_item first?", "a tool name"],
    ["Run mc brief_item first?", "a tool name"],
    ["Run mc ask_flight first?", "a tool name"],
    ["Run mc flight_state first?", "a tool name"],
  ])("refuses an id in the question, naming it: %s", (ask, what) => {
    expect(asking(ask)).toEqual([`the question has ${what}: say it in words`]);
  });

  it("refuses the same ids in the context, naming the part", () => {
    const sentence = (x: string) =>
      `The crew changed ${x} last week. Nothing happens until you decide.`;
    expect(context(sentence("PR 1412"))).toEqual([
      "the context has a ticket or PR number: say it in words",
    ]);
    expect(context(sentence("deadbee1"))).toEqual([
      "the context has a commit code: say it in words",
    ]);
    expect(context(sentence("docs/away.md"))).toEqual([
      "the context has a file path: say it in words",
    ]);
    expect(context(sentence("guido-1"))).toEqual(["the context has a seat id: say it in words"]);
    expect(context(sentence("@capcom"))).toEqual([
      "the context has the CAPCOM tag: say it in words",
    ]);
    expect(context(sentence("mc ask_flight"))).toEqual([
      "the context has a tool name: say it in words",
    ]);
  });

  it("lets plain words through, including words that look a little like ids", () => {
    expect(asking("Approve the new dependencies view and/or hold it until Friday?")).toEqual([]);
    expect(asking("Is a decade of data enough, or 24/7 coverage?")).toEqual([]);
    expect(asking("Should we switch to UTF-8 and SHA-256, or keep the top-3 list?")).toEqual([]);
  });

  it("wants a context of at least one sentence", () => {
    const missing =
      "no context: write two or three sentences saying what this is and why it comes up now";
    const notFull = "the context is not a full sentence: say what this is and why it comes up now";
    expect(context("")).toEqual([missing]);
    expect(context("Away mode.")).toEqual([notFull]);
    // an id is still named when the context is not a full sentence
    expect(context("See PR 1412")).toEqual([
      notFull,
      "the context has a ticket or PR number: say it in words",
    ]);
    // markdown after the full stop is fine
    expect(context("The crew changed **away mode** and review passed.*")).toEqual([]);
    expect(context("The crew changed away mode and review passed._")).toEqual([]);
    expect(context("The crew changed away mode and review passed.")).toEqual([]);
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
      "no ticket or PR: name it with ticket in brief_item",
      "no time raised",
    ]);
  });
});
