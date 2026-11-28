import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BoardItem,
  COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT,
  FLIGHT_NOT_TRIAGING_KEY,
  needsYouItems,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { holdItem } from "../src/attention/holds.ts";
import type { CcConfig } from "../src/config.ts";
import { attentionItems, markHubStarted, STALE_ITEM_MS } from "../src/hud/hud.ts";
import { Store } from "../src/store.ts";
import { MACHINE_CAPACITY_KEY } from "../src/telemetry/machine-capacity.ts";

const DAY = 24 * 60 * 60_000;
const NOW = COMMS_OPEN_ITEM_ROLLOUT_CUTOFF_AT + 60 * DAY;
let dir: string;
let store: Store;

const config: CcConfig = {
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "repo", github: "o/repo", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  crew: {
    worktrees: "/tmp/wt",
    maxSeats: 2,
    sessions: [
      {
        id: "repo-1",
        repoId: "repo",
        checkout: "/tmp/co",
        seats: [
          { id: "GUIDO-1", role: "GUIDO", accountId: "a", model: "x", area: [] },
          { id: "FLIGHT-1", role: "FLIGHT", accountId: "a", model: "x", area: [] },
        ],
      },
    ],
  },
  poll: { usageMinutes: 30, githubSeconds: 60 },
};

const card = (n: number, closed: boolean): BoardItem => ({
  repoId: "repo",
  issueNumber: n,
  title: `Ticket ${n}`,
  status: closed ? "Done" : "In progress",
  state: "in progress",
  labels: [],
  priority: null,
  updatedAt: NOW,
  url: "u",
  stage: null,
  owner: null,
  parent: null,
  subIssues: null,
  blockedBy: [],
  milestone: null,
  size: null,
  closed,
  prioritySource: null,
  createdAt: NOW - DAY,
  itemId: `I${n}`,
  projectId: "P1",
});

const escalation = (issueNumber: number, openedAt: number) => ({
  id: `repo#${issueNumber}`,
  repoId: "repo",
  issueNumber,
  title: `Escalation ${issueNumber}`,
  kind: "operator-decision" as const,
  source: "label" as const,
  openedAt,
  url: `https://github.com/o/repo/issues/${issueNumber}`,
  question: null,
});

const all = () => attentionItems(config, store, NOW);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-needs-stale-"));
  store = new Store(join(dir, "db.sqlite"));
  // FLIGHT has never run on this hub, which started a day ago: FLIGHT is off, not triaging
  markHubStarted(NOW - DAY);
});
afterEach(() => {
  markHubStarted(null);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Needs you holds only FLIGHT's questions to the operator (#2285)", () => {
  it("leaves FLIGHT's own work and stale items off Needs you while FLIGHT is not triaging", () => {
    store.replaceBoard("repo", [card(5, false), card(6, true)]);
    // a seat's question to FLIGHT
    store.addQuestion({
      agentId: "GUIDO-1",
      runId: "r-guido",
      text: "Which lane?",
      at: NOW - 60_000,
    });
    // a round-limit note and the machine headroom note
    store.raiseNote({
      key: "chatter:FLIGHT-1:GUIDO-1:repo#5",
      kind: "flag",
      runId: null,
      seatId: null,
      repoId: "repo",
      text: "FLIGHT-1 and GUIDO-1 exceeded 6 rounds on repo#5.",
      at: NOW - 60_000,
    });
    store.raiseNote({
      key: MACHINE_CAPACITY_KEY,
      kind: "flag",
      runId: null,
      seatId: null,
      repoId: null,
      text: "Machine headroom is tight.",
      at: NOW - 60_000,
    });
    // escalations from long ago, and one whose ticket is closed
    store.replaceEscalations("repo", [
      escalation(410, NOW - 120 * DAY),
      escalation(450, NOW - 120 * DAY),
    ]);
    // seat lines to FLIGHT from a month ago, and one on a closed ticket
    for (const [at, ticket] of [
      [NOW - 28 * DAY, "repo#5"],
      [NOW - 28 * DAY, null],
      [NOW - DAY, "repo#6"],
    ] as const)
      store.addComms({
        at,
        from: "GUIDO-1",
        to: "FLIGHT-1",
        ticket,
        text: "Is this still wanted?",
        label: "question",
      });

    const items = all();
    expect(needsYouItems(items)).toEqual([]);
    // the summary of what waits on FLIGHT is FLIGHT's own, not the operator's
    expect(items.find((i) => i.key === FLIGHT_NOT_TRIAGING_KEY)).toMatchObject({
      owner: "flight",
    });
    // stale items are settled: gone, not queued
    expect(items.some((i) => i.key.startsWith("esc:"))).toBe(false);
    expect(items.some((i) => i.key.startsWith("comms-open:"))).toBe(false);
    // the live ones wait on FLIGHT
    for (const key of ["ask:1", `note:${MACHINE_CAPACITY_KEY}`])
      expect(items.find((i) => i.key === key)?.owner).toBe("flight");
  });

  it("settles an item just past 14 days, and keeps one just inside them", () => {
    store.replaceEscalations("repo", [
      escalation(1, NOW - STALE_ITEM_MS),
      escalation(2, NOW - STALE_ITEM_MS + 1),
    ]);
    expect(STALE_ITEM_MS).toBe(14 * DAY);
    expect(all().map((i) => i.key)).not.toContain("esc:repo#1");
    expect(all().map((i) => i.key)).toContain("esc:repo#2");
  });

  it("settles an item on a closed ticket even when the ticket closed before it was raised", () => {
    // the card's last update is before the escalation was opened
    store.replaceBoard("repo", [{ ...card(9, true), updatedAt: NOW - 2 * DAY }]);
    store.replaceEscalations("repo", [escalation(9, NOW - DAY)]);
    expect(all().some((i) => i.key === "esc:repo#9")).toBe(false);
  });

  it("keeps an item under a hold however old: a hold is a decision to wait", () => {
    store.replaceEscalations("repo", [escalation(8, NOW - 20 * DAY)]);
    holdItem(store, "esc:repo#8", "Wait for the vendor", { kind: "manual" }, "operator", NOW - DAY);
    const held = attentionItems(config, store, NOW, undefined, undefined, null, true);
    expect(held.find((i) => i.key === "esc:repo#8")?.hold?.reason).toBe("Wait for the vendor");
  });

  it("expires an operator brief 14 days old: the item goes back to FLIGHT", () => {
    store.replaceBoard("repo", [card(7, false)]);
    store.replaceEscalations("repo", [escalation(7, NOW - DAY)]);
    const brief = (at: number) =>
      store.addBrief({
        key: "esc:repo#7",
        for: "operator",
        ask: "Should the importer be replaced?",
        context: "The importer has failed twice this month on large files.",
        recommendation: "Replace it.",
        options: [
          { label: "Replace", answer: "Replace the importer." },
          { label: "Keep", answer: "Keep the importer." },
        ],
        basis: "b",
        at,
      });
    brief(NOW - STALE_ITEM_MS);
    expect(needsYouItems(all())).toEqual([]);
    expect(all().find((i) => i.key === "esc:repo#7")).toMatchObject({ owner: "flight" });
    expect(all().find((i) => i.key === "esc:repo#7")?.brief).toBeUndefined();
    brief(NOW - DAY);
    expect(needsYouItems(all()).map((i) => i.key)).toEqual(["esc:repo#7"]);
  });

  it("shows FLIGHT's own question with a complete brief on Needs you, for the operator to answer", () => {
    store.replaceBoard("repo", [card(5, false)]);
    store.addComms({
      at: NOW - 60_000,
      from: "FLIGHT-1",
      to: "CAPCOM",
      ticket: "repo#5",
      text: "Should the old importer be removed?",
      label: "question",
    });
    const key = all().find((i) => i.agentId === "FLIGHT-1" && i.kind === "question")?.key;
    expect(key).toBeDefined();
    store.addBrief({
      key: key as string,
      for: "operator",
      ask: "Should the old importer be removed?",
      context: "The new importer has run alone for a week without a fault.",
      recommendation: "Remove it.",
      options: [
        { label: "Remove", answer: "Remove the old importer." },
        { label: "Keep", answer: "Keep it a while longer." },
      ],
      basis: "b",
      at: NOW - 30_000,
    });
    const mine = needsYouItems(all());
    expect(mine.map((i) => i.key)).toEqual([key]);
    expect(mine[0]?.brief?.ask).toBe("Should the old importer be removed?");
  });
});
