import {
  type CrewRow,
  OWNER_CONTROLLER,
  OWNER_FLIGHT,
  type PrCheck,
  type PullRequestView,
  startOfLocalDay,
} from "@mc/core";
import { describe, expect, it } from "vitest";
import {
  cardAgent,
  cardColumn,
  cardPr,
  cardQueue,
  cardReviewer,
  cardStep,
  cardYouWait,
  checksText,
  daysAgo,
  doneOutcome,
  NOT_QUEUED,
  needsMe,
  priorityRank,
  type QueueRow,
  sortCards,
  statusOutOfDateTitle,
  ticketRef,
  waitingText,
} from "../src/board/cards.ts";
import { boardItem, crewRow, HOUR, item, NOW } from "./fixtures.ts";

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

describe("cardAgent and needsMe", () => {
  const i = boardItem();
  it.each([OWNER_FLIGHT, OWNER_CONTROLLER, undefined] as const)(
    "ignores attention owned by %s, whether linked to the ticket or its agent",
    (owner) => {
      expect(needsMe(i, [item({ owner, ticket: ticketRef(i) })], [crewRow()])).toBe(false);
      expect(needsMe(i, [item({ owner, ticket: null })], [crewRow()])).toBe(false);
    },
  );
  it.each(["Ready", "In review", "Ready for QA", "Done"])(
    "an agent's need does not follow its card into %s",
    (status) => {
      expect(needsMe(boardItem({ status }), [item({ ticket: null })], [crewRow()])).toBe(false);
    },
  );
  it("only a running run on the ticket marks the card", () => {
    const done = crewRow({ run: { ...RUN, status: "ok", endedAt: NOW } });
    expect(cardAgent(i, [done])).toBeNull();
    expect(cardAgent(i, [crewRow()])?.id).toBe("shop-app-ta");
    expect(cardAgent(i, [crewRow({ ticket: "shop-app#1" })])).toBeNull();
  });
  it("needs me: an escalation on the card, or its worked-by agent has an attention item", () => {
    expect(needsMe(i, [], [crewRow()])).toBe(false);
    expect(needsMe(i, [item({ escalationId: "shop-app#3349", ticket: "shop-app#3349" })], [])).toBe(
      true,
    );
    expect(needsMe(i, [item({ escalationId: "shop-app#9", ticket: "shop-app#9" })], [])).toBe(
      false,
    );
    const stalled = item({ key: "stall:r-12", kind: "stalled", escalationId: null, ticket: null });
    expect(needsMe(i, [stalled], [crewRow({ hudState: "stalled" })])).toBe(true);
    expect(needsMe(i, [stalled], [crewRow({ id: "other", ticket: "shop-app#1" })])).toBe(false);
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

describe("cardYouWait", () => {
  const i = boardItem();
  const old = (over: Partial<PullRequestView> = {}) =>
    pr({ isDraft: true, updatedAt: NOW - 9 * DAY, ...over });
  it("names the action and how long it has waited", () => {
    expect(cardYouWait(i, [old()], [], NOW)).toEqual({
      action: "decide on the draft",
      waiting: "9 days",
    });
  });
  it("nothing while an agent runs on the ticket, with no PR, or when recent", () => {
    expect(cardYouWait(i, [old()], [crewRow()], NOW)).toBeNull();
    expect(cardYouWait(i, [], [], NOW)).toBeNull();
    expect(cardYouWait(i, [pr()], [], NOW)).toBeNull();
  });
  it("nothing on a Done card, whatever its PR", () => {
    // Done by its closed flag, and Done by its Status while GitHub still has it open
    for (const closed of [true, false]) {
      const done = boardItem({ status: "Done", state: "done", closed });
      expect(cardColumn(done)).toBe("Done");
      expect(cardYouWait(done, [old()], [], NOW)).toBeNull();
    }
  });
  it("waitingText", () => {
    expect([HOUR, 5 * HOUR, DAY, 2 * DAY + HOUR].map(waitingText)).toEqual([
      "1 hour",
      "5 hours",
      "1 day",
      "2 days",
    ]);
  });
  it("a PR item on the ticket keeps the card in needs-me", () => {
    const prItem = item({
      key: "pr:shop-app#40:1",
      kind: "pr",
      agentId: null,
      escalationId: null,
      ticket: "shop-app#3349",
    });
    expect(needsMe(i, [prItem], [])).toBe(true);
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

const L = { phase: "working", text: "Working", prNumber: null, parked: null } as const;

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
    });
    expect(cardReviewer(boardItem(), pr({ number: 41 }), [seat])).toBeNull();
    const byRef = retro({ prNumber: 99, sha: "c".repeat(40), ref: ticketRef(boardItem()) });
    expect(cardReviewer(boardItem(), null, [byRef])).toEqual({ id: "RETRO-1", index: 3 });
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
