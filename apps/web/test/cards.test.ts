import {
  type AttentionItem,
  type CrewRow,
  OWNER_CONTROLLER,
  OWNER_FLIGHT,
  type PrCheck,
  type PullRequestView,
  startOfLocalDay,
} from "@mc/core";
import { describe, expect, it } from "vitest";
import { needsYouItems } from "../src/attention.ts";
import {
  cardAgent,
  cardColumn,
  cardIdle,
  cardNeeds,
  cardPr,
  cardQueue,
  cardReviewer,
  cardStep,
  cardYou,
  checksText,
  daysAgo,
  doneOutcome,
  NOT_QUEUED,
  needsMe,
  pipelineStage,
  priorityRank,
  type QueueRow,
  reworkLabel,
  sortCards,
  statusOutOfDateTitle,
  ticketRef,
  waitingText,
} from "../src/board/cards.ts";
import { boardItem, crewRow, HOUR, item, itemWithoutOwner, NOW, prView } from "./fixtures.ts";

const DAY = 86_400_000;
const RUN = crewRow().run as NonNullable<CrewRow["run"]>;

function pr(over: Partial<PullRequestView> = {}): PullRequestView {
  return {
    repoId: "shop-app",
    number: 40,
    title: "cache it",
    url: "https://github.com/octo-org/shop-app/pull/40",
    branch: "fix/3349-cache",
    ticket: "shop-app#3349",
    state: "open",
    isDraft: false,
    review: null,
    ci: null,
    createdAt: NOW - DAY,
    updatedAt: NOW - 1000,
    mergedAt: null,
    headSha: null,
    mergeable: null,
    ...over,
  };
}

describe("cardPr", () => {
  const it3349 = boardItem();
  it("none for a ticket with no PR, and ignores other tickets", () => {
    expect(cardPr(it3349, [])).toBeNull();
    expect(cardPr(it3349, [pr({ ticket: "shop-app#1" }), pr({ ticket: null })])).toBeNull();
  });
  it("prefers an open docs/ PR over a closed fix/ one", () => {
    const closedFix = pr({ number: 1, state: "closed", branch: "fix/3349-x" });
    const openDocs = pr({ number: 2, branch: "docs/3349-spec" });
    expect(cardPr(it3349, [closedFix, openDocs])?.number).toBe(2);
  });
  it("prefers fix/feat/feature, then other prefixes, then docs/chore", () => {
    const docs = pr({ number: 1, branch: "docs/3349-spec" });
    const other = pr({ number: 2, branch: "studio/3349" });
    const feat = pr({ number: 3, branch: "feat/studio-1600-x" });
    expect(cardPr(it3349, [docs, other, feat])?.number).toBe(3);
    expect(cardPr(it3349, [docs, other])?.number).toBe(2);
    expect(cardPr(it3349, [pr({ number: 5, branch: "feature/x" }), docs])?.number).toBe(5);
    // chore/ ranks with docs/, below an unlisted prefix whichever comes first
    const chore = pr({ number: 6, branch: "chore/x" });
    expect(cardPr(it3349, [chore, other])?.number).toBe(2);
    expect(cardPr(it3349, [other, chore])?.number).toBe(2);
  });
  it("merged counts like open; ties go to the newest update", () => {
    const merged = pr({ number: 1, state: "merged", updatedAt: NOW - 5000 });
    const open = pr({ number: 2, updatedAt: NOW - 1000 });
    expect(cardPr(it3349, [merged, open])?.number).toBe(2);
    expect(cardPr(it3349, [open, merged])?.number).toBe(2);
  });
});

describe("doneOutcome", () => {
  const i = boardItem({ state: "done" });
  it("Merged when any PR on the ticket is merged, not only the one the card shows", () => {
    const prs = [pr({ number: 1, state: "merged", branch: "docs/x" }), pr({ number: 2 })];
    expect(doneOutcome(i, prs)).toBe("Merged");
  });
  it("Closed otherwise, and for no PR", () => {
    expect(doneOutcome(i, [pr({ state: "closed" })])).toBe("Closed");
    expect(doneOutcome(i, [])).toBe("Closed");
    expect(doneOutcome(i, [pr({ state: "merged", ticket: "shop-app#1" })])).toBe("Closed");
  });
});

/** The Board is handed the canonical set, so what Needs you leaves out never marks a card. */
const canon = (raw: AttentionItem[]) => needsYouItems(raw);

describe("cardAgent and needsMe", () => {
  const i = boardItem();
  it.each([OWNER_FLIGHT, OWNER_CONTROLLER] as const)(
    "ignores attention owned by %s, whether linked to the ticket or its agent",
    (owner) => {
      expect(needsMe(i, canon([item({ owner, ticket: ticketRef(i) })]), [crewRow()])).toBe(false);
      expect(needsMe(i, canon([item({ owner, ticket: null })]), [crewRow()])).toBe(false);
    },
  );
  it("an item with no owner is the operator's, as Needs you counts it", () => {
    expect(needsMe(i, canon([itemWithoutOwner({ ticket: ticketRef(i) })]), [])).toBe(true);
  });
  it.each(["Ready", "In review", "Ready for QA", "Done"])(
    "an agent's need does not follow its card into %s",
    (status) => {
      expect(needsMe(boardItem({ status }), canon([item({ ticket: null })]), [crewRow()])).toBe(
        false,
      );
    },
  );
  it("an agent's item about another ticket chips that ticket's card, not the agent's card", () => {
    // the agent runs #3349 (In progress); its item is about #698
    const other = boardItem({ issueNumber: 698 });
    const about698 = item({ key: "q:698", kind: "question", ticket: "shop-app#698" });
    const needs = canon([about698]);
    expect(cardNeeds(i, needs, [crewRow()])).toEqual([]);
    expect(needsMe(i, needs, [crewRow()])).toBe(false);
    expect(cardNeeds(other, needs, [crewRow()]).map((a) => a.key)).toEqual(["q:698"]);
  });
  it("an escalation names its own ticket, not the loop's running card", () => {
    // escalations carry agentId = the loop id, whatever ticket they are about
    const esc = item({ key: "esc:shop-app#9", escalationId: "shop-app#9", ticket: "shop-app#9" });
    expect(needsMe(i, canon([esc]), [crewRow()])).toBe(false);
  });
  it("only a running run on the ticket marks the card", () => {
    const done = crewRow({ run: { ...RUN, status: "ok", endedAt: NOW } });
    expect(cardAgent(i, [done])).toBeNull();
    expect(cardAgent(i, [crewRow()])?.id).toBe("shop-app-ta");
    expect(cardAgent(i, [crewRow({ ticket: "shop-app#1" })])).toBeNull();
  });
  it("needs me: an escalation on the card, or its worked-by agent has an attention item", () => {
    expect(needsMe(i, canon([]), [crewRow()])).toBe(false);
    expect(
      needsMe(i, canon([item({ escalationId: "shop-app#3349", ticket: "shop-app#3349" })]), []),
    ).toBe(true);
    expect(
      needsMe(i, canon([item({ escalationId: "shop-app#9", ticket: "shop-app#9" })]), []),
    ).toBe(false);
    const stalled = item({ key: "stall:r-12", kind: "stalled", escalationId: null, ticket: null });
    expect(needsMe(i, canon([stalled]), [crewRow({ hudState: "stalled" })])).toBe(true);
    expect(needsMe(i, canon([stalled]), [crewRow({ id: "other", ticket: "shop-app#1" })])).toBe(
      false,
    );
  });
});

describe("sorting and ages", () => {
  it("priority rank: P0 first, none last", () => {
    expect(["P2", null, "P0", "P1"].map(priorityRank)).toEqual([2, 99, 0, 1]);
  });
  it("sorts by priority then newest update", () => {
    const a = boardItem({ issueNumber: 1, priority: "P1", updatedAt: 1 });
    const b = boardItem({ issueNumber: 2, priority: "P0", updatedAt: 1 });
    const c = boardItem({ issueNumber: 3, priority: "P1", updatedAt: 2 });
    const d = boardItem({ issueNumber: 4, priority: null, updatedAt: 9 });
    expect(sortCards([a, b, c, d]).map((x) => x.issueNumber)).toEqual([2, 3, 1, 4]);
  });
  it("daysAgo counts local days", () => {
    const today = startOfLocalDay(NOW, "Europe/London");
    expect(daysAgo(NOW - 10 * DAY, NOW, "Europe/London", today)).toBe(10);
    expect(daysAgo(NOW - 1000, NOW, "Europe/London", today)).toBe(0);
    expect(daysAgo(NOW + DAY, NOW, "Europe/London", today)).toBe(0);
  });
  // #26 A1: the caller works out the start of today once per render, not once per card.
  it("daysAgo counts from the todayStart it is given, and in 24 h days while tz is null", () => {
    const today = startOfLocalDay(NOW, "Europe/London");
    // A todayStart a day later than the real one moves every answer by one day.
    expect(daysAgo(NOW - 3 * DAY, NOW, "Europe/London", today + DAY)).toBe(4);
    expect(daysAgo(NOW - 3 * DAY + 1, NOW, null, null)).toBe(2);
    expect(daysAgo(NOW - 3 * DAY, NOW, null, null)).toBe(3);
  });
});

describe("cardYou", () => {
  const i = boardItem();
  const prItem = (over: Parameters<typeof item>[0] = {}) =>
    item({
      key: "pr:shop-app#40:1",
      kind: "pr",
      text: "PR #40 · You: decide on the draft",
      agentId: null,
      escalationId: null,
      ticket: "shop-app#3349",
      at: NOW - 9 * DAY,
      ...over,
    });
  it("names what the item asks and how long it has waited, and opens that item", () => {
    expect(cardYou(cardNeeds(i, canon([prItem()]), []), NOW)).toEqual({
      key: "pr:shop-app#40:1",
      text: "You: decide on the draft · waiting 9 days",
      title: "PR #40 · You: decide on the draft",
      more: 0,
    });
  });
  it("only a Needs-you item makes a chip: a waiting PR alone does not", () => {
    expect(cardYou(cardNeeds(i, canon([]), []), NOW)).toBeNull();
  });
  it.each([
    ["question", "answer"],
    ["decision", "decide"],
    ["message", "read"],
    ["tag", "read"],
    ["blocked", "unblock"],
    ["parked", "unblock"],
    ["stalled", "check"],
    ["error", "check"],
    ["flag", "check before merging"],
  ] as const)("a %s item asks you to %s", (kind, verb) => {
    const one = item({ key: kind, kind, ticket: "shop-app#3349", at: 0 });
    expect(cardYou(cardNeeds(i, canon([one]), []), NOW)?.text).toBe(`You: ${verb}`);
  });
  it("a PR item whose text has no action still names a verb, never the kind", () => {
    expect(cardYou(cardNeeds(i, canon([prItem({ text: "PR #40", at: 0 })]), []), NOW)?.text).toBe(
      "You: check the PR",
    );
  });
  it("another kind is named by its verb; the most urgent leads and the rest are counted", () => {
    const decision = item({ key: "esc:shop-app#3349", ticket: "shop-app#3349", at: NOW - HOUR });
    const you = cardYou(cardNeeds(i, canon([prItem(), decision]), []), NOW);
    expect(you?.key).toBe("esc:shop-app#3349");
    expect(you?.text).toBe("You: decide · waiting 1 hour");
    expect(you?.more).toBe(1);
  });
  it("an undated item does not say how long", () => {
    expect(cardYou(cardNeeds(i, canon([prItem({ at: 0 })]), []), NOW)?.text).toBe(
      "You: decide on the draft",
    );
  });
  it("waitingText", () => {
    expect([30_000, 5 * 60_000, HOUR, 5 * HOUR, DAY, 2 * DAY + HOUR].map(waitingText)).toEqual([
      "under a minute",
      "5 minutes",
      "1 hour",
      "5 hours",
      "1 day",
      "2 days",
    ]);
  });
  it("a PR item on the ticket keeps the card in needs-me", () => {
    expect(needsMe(i, canon([prItem()]), [])).toBe(true);
  });
});

describe("cardColumn", () => {
  const ready = { status: "Todo", state: "planned" } as const;
  it("an open blocker puts a Ready ticket in Blocked", () => {
    const b = boardItem({ ...ready, blockedBy: [{ ref: "shop-app#2", closed: false }] });
    expect(cardColumn(b)).toBe("Blocked");
  });
  it("a closed blocker leaves the column the Status gives", () => {
    const b = boardItem({ ...ready, blockedBy: [{ ref: "shop-app#2", closed: true }] });
    expect(cardColumn(b)).toBe("Ready");
  });
  it("no blocker leaves the column the Status gives", () => {
    expect(cardColumn(boardItem(ready))).toBe("Ready");
  });
  it("a ticket the hub set to Waiting is in Waiting, whatever its Status or blockers", () => {
    const waiting = { reason: "Needs the migration", freesWhen: "#12 merges", at: NOW };
    expect(cardColumn(boardItem({ waiting }))).toBe("Waiting");
    const blockedBy = [{ ref: "shop-app#2", closed: false }];
    expect(cardColumn(boardItem({ ...ready, blockedBy, waiting }))).toBe("Waiting");
    expect(cardColumn(boardItem({ waiting, closed: true }))).toBe("Done");
  });
  it("work under way or done stays where it is, blocker or not", () => {
    const blockedBy = [{ ref: "shop-app#2", closed: false }];
    expect(cardColumn(boardItem({ blockedBy }))).toBe("In progress");
    expect(cardColumn(boardItem({ ...ready, blockedBy, closed: true }))).toBe("Done");
  });
});

describe("statusOutOfDateTitle", () => {
  it("says what GitHub says and what the board's Status says", () => {
    expect(statusOutOfDateTitle({ closed: false, status: "Done" })).toBe(
      "GitHub says Open; the board's Status says Done",
    );
    expect(statusOutOfDateTitle({ closed: true, status: "Blocked" })).toBe(
      "GitHub says Closed; the board's Status says Blocked",
    );
  });

  it("names an empty Status as none", () => {
    expect(statusOutOfDateTitle({ closed: true, status: "" })).toBe(
      "GitHub says Closed; the board's Status says none",
    );
  });
});

const L = { phase: "working", text: "Working", prNumber: null, hold: null } as const;

describe("cardStep", () => {
  it("a looped run shows its template, step and try", () => {
    const tries = { n: 2, max: 3 };
    expect(
      cardStep(crewRow({ loop: { ...L, profile: "feature", step: "implement", tries } })),
    ).toBe("feature › implement · try 2 of 3");
    expect(
      cardStep(crewRow({ loop: { ...L, profile: "feature", step: "implement", tries: null } })),
    ).toBe("feature › implement");
    expect(cardStep(crewRow({ loop: { ...L, phase: "ci" } }))).toBe("build › CI");
    expect(cardStep(crewRow())).toBe(`run #${RUN.seq} · no template step`);
  });
});

describe("cardQueue", () => {
  const q = (n: number, pos: number) => ({ ref: `shop-app#${n}`, issue: n, pos });
  const guido: QueueRow = {
    ...crewRow({ id: "GUIDO-1", index: 2, kind: "crew" }),
    queue: [q(5, 1), q(7, 2)],
  };
  it("a queued Ready card names its seat and place", () => {
    const seven = boardItem({ issueNumber: 7, status: "Todo", state: "planned" });
    expect(cardQueue(seven, [crewRow(), guido])).toEqual({ id: "GUIDO-1", index: 2, pos: 2 });
    expect(cardQueue({ ...seven, status: "In Progress" }, [crewRow(), guido])).toBeNull();
    expect(cardQueue({ ...seven, issueNumber: 9 }, [crewRow(), guido])).toBeNull();
    expect(cardQueue(seven, [crewRow()])).toBeNull();
  });
});

describe("cardReviewer", () => {
  const retro = (reviewing: CrewRow["reviewing"]) =>
    crewRow({ id: "RETRO-1", index: 3, kind: "crew", reviewing });
  it("names the seat reviewing the card's PR or ticket", () => {
    const seat = retro({ prNumber: 40, sha: "c".repeat(40), ref: null });
    expect(cardReviewer(boardItem(), pr({ number: 40 }), [seat])).toEqual({
      id: "RETRO-1",
      index: 3,
      hudState: "running",
      status: { label: "Checking", tone: "neutral" },
    });
    expect(cardReviewer(boardItem(), pr({ number: 41 }), [seat])).toBeNull();
    const byRef = retro({ prNumber: 99, sha: "c".repeat(40), ref: ticketRef(boardItem()) });
    expect(cardReviewer(boardItem(), null, [byRef])).toEqual({
      id: "RETRO-1",
      index: 3,
      hudState: "running",
      status: { label: "Checking", tone: "neutral" },
    });
    expect(cardReviewer(boardItem(), pr(), [retro(null)])).toBeNull();
  });
});

describe("checksText", () => {
  const c = (name: string, state: PrCheck["state"]): PrCheck => ({
    name,
    kind: "check",
    state,
    conclusion: state,
    attempt: null,
    url: null,
  });
  it("names the checks, without mc/review, worst state per name", () => {
    expect(
      checksText([c("check", "passing"), c("e2e", "failing"), c("mc/review", "failing")]),
    ).toBe("check passing · e2e failing");
    expect(checksText([c("check", "passing"), c("check", "failing")])).toBe("check failing");
    expect(checksText(undefined)).toBeNull();
    expect(checksText([])).toBeNull();
    expect(checksText([c("mc/review", "passing")])).toBeNull();
  });
});

describe("NOT_QUEUED", () => {
  it("tells an unassigned Ready card that FLIGHT will offer it to an agent", () => {
    expect(NOT_QUEUED).toBe("Unassigned · FLIGHT will offer it to an agent");
  });
});

describe("pipelineStage", () => {
  const today = NOW - HOUR;
  it("uses the Overview merged ticket: explicit ticket or first closing reference in the PR repo", () => {
    const merged = pr({ ticket: null, closingIssues: [3349, 3350], mergedAt: NOW - 1000 });
    const stage = (over: Partial<PullRequestView>) =>
      pipelineStage(boardItem({ closed: true }), [], [{ ...merged, ...over }], NOW, today, []);
    expect(stage({})).toBe("merged");
    expect(stage({ ticket: "shop-app#1" })).toBeNull();
    expect(stage({ closingIssues: [3350, 3349] })).toBeNull();
    expect(stage({ repoId: "other" })).toBeNull();
    expect(stage({ mergedAt: today - 1 })).toBeNull();
    expect(stage({ mergedAt: NOW + 1 })).toBeNull();
  });

  it("includes a building ticket in both its active stage and merged today", () => {
    const agent = crewRow({ loop: L });
    const prs = [pr({ mergedAt: NOW - 1000 })];
    expect(pipelineStage(boardItem(), [agent], prs, NOW, today, [])).toBe("building");
    expect(pipelineStage(boardItem(), [agent], prs, NOW, today, [], "merged")).toBe("merged");
  });

  it.each([
    ["ci", "checks"],
    ["review", "review"],
    ["parked", "building"],
  ] as const)("uses an off-seat run in %s for its ticket's %s stage", (phase, stage) => {
    const target = boardItem();
    const agent = crewRow({
      ticket: "shop-app#999",
      loop: { phase: "working", text: "Working elsewhere", prNumber: null, hold: null },
      offSeatRuns: [
        {
          runId: "r-target",
          ticket: ticketRef(target),
          ticketTitle: "Target ticket",
          loop: { phase, text: `Held at ${phase}`, prNumber: null, hold: null },
        },
      ],
    });

    expect(pipelineStage(target, [agent], [], NOW, today, [])).toBe(stage);
  });
});

describe("reworkLabel", () => {
  const facts = { round: 2, blockers: 1, seat: "guido-2", seatBusy: false };
  it("a building card names the round, blockers and seat", () => {
    expect(reworkLabel(facts, { ready: false, onTicket: true, pr: 1432 })).toBe(
      "Rework · round 2 · 1 blocker · GUIDO-2",
    );
    expect(
      reworkLabel(
        { ...facts, blockers: 3, seat: null },
        { ready: false, onTicket: false, pr: null },
      ),
    ).toBe("Rework · round 2 · 3 blockers");
  });
  it("says queued when the seat is busy on something else", () => {
    expect(
      reworkLabel({ ...facts, seatBusy: true }, { ready: false, onTicket: false, pr: 1432 }),
    ).toBe("Rework · queued for GUIDO-2");
  });
  it("a seat busy on this very ticket is working it, not queued", () => {
    expect(
      reworkLabel({ ...facts, seatBusy: true }, { ready: false, onTicket: true, pr: 1432 }),
    ).toBe("Rework · round 2 · 1 blocker · GUIDO-2");
  });
  it("a Ready card whose run ended says it was reviewed, with its PR", () => {
    expect(reworkLabel(facts, { ready: true, onTicket: false, pr: 1432 })).toBe(
      "Reviewed · 1 blocker · PR 1432",
    );
    expect(reworkLabel(facts, { ready: true, onTicket: false, pr: null })).toBe(
      "Reviewed · 1 blocker",
    );
  });
});

describe("cardIdle", () => {
  const DAY_MS = 86_400_000;
  const at = Date.UTC(2026, 9, 15, 12, 0);
  const at2 = (status: string) => boardItem({ status, updatedAt: at });
  const idle = (
    col: Parameters<typeof cardIdle>[1],
    pr: PullRequestView | null,
    over: { agent?: boolean; reviewer?: boolean } = {},
  ) => cardIdle(at2(col), col, pr, over.agent ?? false, over.reviewer ?? false, "UTC");

  it("an In progress or In review card with no run and no PR says nobody is on it", () => {
    expect(idle("In progress", null)).toBe("Nobody on it since 15 Oct");
    expect(idle("In review", null)).toBe("Nobody on it since 15 Oct");
  });

  it("a card whose last PR is closed says so, with no date, in any open column", () => {
    const closed = prView({ state: "closed", updatedAt: at + DAY_MS });
    expect(idle("Blocked", closed)).toBe("PR closed, nothing open");
    expect(idle("In progress", closed)).toBe("PR closed, nothing open");
  });

  it("says nothing when a run, a reviewer or an open PR is on the card, or it is not started", () => {
    expect(idle("In progress", null, { agent: true })).toBeNull();
    expect(idle("In review", null, { reviewer: true })).toBeNull();
    expect(idle("In progress", prView())).toBeNull();
    expect(idle("In review", prView({ state: "merged" }))).toBeNull();
    expect(idle("Ready", null)).toBeNull();
    expect(idle("Done", prView({ state: "closed" }))).toBeNull();
  });

  it("drops the date, not the line, while the timezone is unknown", () => {
    expect(cardIdle(at2("In progress"), "In progress", null, false, false, null)).toBe(
      "Nobody on it",
    );
  });
});
