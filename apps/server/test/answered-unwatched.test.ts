import {
  type AttentionBrief,
  NOTE_ITEM_PREFIX,
  needsYouItems,
  repoUnwatchedPanelText,
} from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { closeAnsweredItems } from "../src/attention/answered.ts";
import { closeUnwatchedRepoItems, withRepoWatch } from "../src/attention/unwatched-repos.ts";
import { chooseBrief } from "../src/brief/choices.ts";
import { bindCompleteBrief } from "../src/brief/prepare.ts";
import { routineBriefChoices } from "../src/brief/routine.ts";
import type { CcConfig } from "../src/config.ts";
import { attentionItems } from "../src/hud/hud.ts";
import { Store } from "../src/store.ts";
import { liveBriefSeat } from "./brief-fixture.ts";

const AT = Date.parse("2026-11-03T12:00:00Z");
const KEY = `${NOTE_ITEM_PREFIX}decision:target`;
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 85, stopAt: 95 }],
  repos: [{ id: "repo", github: "o/repo", project: 1, statusMap: {}, autonomy: "merge" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/tmp/wt",
    maxSeats: 2,
    sessions: [
      {
        id: "s",
        repoId: "repo",
        checkout: "/tmp/co",
        seats: [
          { id: "FLIGHT-1", role: "FLIGHT", accountId: "a", model: "x", area: [] },
          { id: "GUIDO-1", role: "GUIDO", accountId: "a", model: "x", area: [] },
        ],
      },
    ],
  },
};
let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
  liveBriefSeat(store, "FLIGHT-1", "flight", AT);
  // the studio repo is not in config.repos: the hub does not watch it
  liveBriefSeat(store, "GUIDO-1", "target", AT, "studio");
  store.raiseNote({
    key: "decision:target",
    kind: "ready",
    runId: "target",
    seatId: "GUIDO-1",
    repoId: "studio",
    text: "Switch over to the new studio?",
    at: AT,
  });
});
afterEach(() => store.close());

/** The item as the Needs you set (the page's list and the header count) holds it. */
const needsYou = () => needsYouItems(attentionItems(config, store, AT)).find((i) => i.key === KEY);
const find = () => attentionItems(config, store, AT).find((i) => i.key === KEY);

async function answer(
  actor: { operator: true } | { seatId: string; runId: string } = { operator: true },
) {
  const item = find();
  if (!item) throw new Error("missing source");
  const content: AttentionBrief = {
    for: "operator",
    at: AT,
    context: "The studio switch-over is old.",
    ask: "Switch over to the new studio?",
    recommendation: "Not now.",
    basis: "Retained fixture source",
    did: [],
    checked: [],
    decision: {
      ...("seatId" in actor
        ? {}
        : {
            whyOperator: {
              kind: "product-direction" as const,
              explanation: "The operator decides.",
            },
          }),
      consulted: [],
      costOfDelay: "None.",
      waiting: "An explicit operator choice.",
    },
    recommendedOptionId: "clear",
    options: [
      {
        id: "clear",
        label: "Not now, clear it",
        answer: "Not now, clear it.",
        consequence: "Record the decision only.",
        reversibility: { kind: "reversible", detail: "Ask again later." },
        action: { kind: "record-decision" },
      },
      {
        id: "wait",
        label: "Wait",
        answer: "Keep waiting.",
        consequence: "Keep the operator hold.",
        reversibility: { kind: "reversible", detail: "Release it." },
        action: {
          kind: "attention-hold",
          reason: "Wait for the operator.",
          condition: { kind: "manual" },
        },
      },
    ],
  };
  const bound = await bindCompleteBrief({ config, store, now: () => AT }, item, content, {
    seatId: "FLIGHT-1",
    runId: "flight",
  });
  store.addBrief({ key: KEY, ...bound });
  const saved = store.briefs().get(KEY);
  if (!saved?.binding || !saved.id) throw new Error("missing bound brief");
  expect(find()).toBeDefined();
  expect(needsYou()).toBeDefined();
  const deps = routineBriefChoices({
    config,
    store,
    now: () => AT,
    knownSecrets: async () => [],
  });
  return await chooseBrief(
    deps,
    KEY,
    {
      briefId: saved.id,
      sourceRevision: saved.binding.sourceRevision,
      optionId: "clear",
      requestId: "r1",
    },
    actor,
  );
}

it("an answered question from an unwatched repo leaves Needs you and moves to Answered", async () => {
  expect((await answer()).state).toBe("applied");
  expect(needsYou()).toBeUndefined();
  expect(store.questionClosures(0, 10)).toEqual([
    expect.objectContaining({
      key: KEY,
      kind: "answered",
      reason: expect.stringContaining("Not now, clear it"),
      operator: true,
    }),
  ]);
});

it("the sweep records an answer chosen before closures were written", async () => {
  await answer();
  (store as unknown as { db: { prepare(s: string): { run(): unknown } } }).db
    .prepare("DELETE FROM question_closures")
    .run();
  // the scheduler's order: answers first, then unwatched cleanup, which must leave them alone
  expect(closeAnsweredItems({ config, store, now: AT })).toBe(1);
  expect(closeUnwatchedRepoItems({ config, store, now: AT })).toBe(0);
  expect(store.questionClosures(0, 10)).toEqual([
    expect.objectContaining({ kind: "answered", reason: "You chose: Not now, clear it." }),
  ]);
  expect(closeAnsweredItems({ config, store, now: AT })).toBe(0);
});

it("flags an item from an unwatched repo so its panel can say its plan is not loaded", () => {
  const item = find();
  if (!item) throw new Error("missing source");
  expect(withRepoWatch(item, config).repoUnwatched).toEqual({
    repoId: "studio",
    text: repoUnwatchedPanelText("studio"),
  });
  expect(
    withRepoWatch({ ...item, repoId: "repo", ticket: "repo#1" }, config).repoUnwatched,
  ).toBeUndefined();
});

it("an applied answer settles the item: it leaves the list, yet the sweeps still read it (#2285)", async () => {
  expect((await answer()).state).toBe("applied");
  expect(find()).toBeUndefined();
  expect(
    attentionItems(config, store, AT, undefined, undefined, null, true).some((i) => i.key === KEY),
  ).toBe(true);
});
