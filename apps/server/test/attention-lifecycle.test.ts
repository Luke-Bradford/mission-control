import { NEW_LOOP, needsYouItems, type Run } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { CcConfig } from "../src/config.ts";
import { attentionItems } from "../src/hud.ts";
import { Store } from "../src/store.ts";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [{ id: "a", vendor: "claude", alertAt: 80, stopAt: 95 }],
  repos: [{ id: "repo", github: "o/repo", project: 1, statusMap: {}, autonomy: "draft" }],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
  crew: {
    worktrees: "/unused",
    maxSeats: 2,
    sessions: [
      {
        id: "session",
        repoId: "repo",
        checkout: "/unused",
        seats: [
          { id: "guido", role: "GUIDO", accountId: "a", model: "haiku", area: [] },
          { id: "flight", role: "FLIGHT", accountId: "a", model: "haiku", area: [] },
        ],
      },
    ],
  },
};
const run = (patch: Partial<Run> = {}): Run => ({
  id: "run",
  agentId: "guido",
  repoId: "repo",
  seq: 1,
  startedAt: NOW - 40 * 60_000,
  endedAt: NOW - 10 * 60_000,
  status: "ok",
  sessionId: null,
  model: "haiku",
  branch: "feature/7",
  ticket: "repo#7",
  costUsd: null,
  tokens: null,
  transcriptPath: "",
  prs: [],
  summary: null,
  loop: NEW_LOOP,
  ...patch,
});
let store: Store;
beforeEach(() => {
  store = new Store(":memory:");
});
afterEach(() => store.close());
it("retires ordinary ended-run blockers while preserving a failed cleanup task for the controller", () => {
  store.upsertRun(run());
  for (const key of ["blocked:run:0", "cleanup:run"])
    store.raiseNote({
      key,
      kind: "blocked",
      runId: "run",
      seatId: "guido",
      repoId: "repo",
      text: key,
      at: NOW - 20 * 60_000,
    });
  const notes = attentionItems(config, store, NOW).filter((i) => i.key.startsWith("note:"));
  expect(notes.map((i) => i.key)).toEqual(["note:cleanup:run"]);
  expect(notes[0]?.owner).toBe("controller");
});
it("keeps a pending controller approval and retires its old blocker after an exact-head pass", () => {
  store.upsertRun(run({ loop: { ...NEW_LOOP, prNumber: 7, controllerCheckRequired: true } }));
  store.raiseNote({
    key: "blocked:run:0",
    kind: "blocked",
    runId: "run",
    seatId: "guido",
    repoId: "repo",
    text: "Controller check",
    at: NOW - 20 * 60_000,
  });
  const visible = () =>
    attentionItems(config, store, NOW).some((i) => i.key === "note:blocked:run:0");
  expect(visible()).toBe(true);
  store.addRunCommit({
    runId: "run",
    repoId: "repo",
    branch: "feature/7",
    sha: "head",
    at: NOW - 30 * 60_000,
  });
  store.setRunLoop("run", {
    ...NEW_LOOP,
    controllerCheckRequired: true,
    controllerCheck: { sha: "head", from: "ci", pass: true },
  });
  expect(visible()).toBe(false);
});
it("keeps an ended budget run's operator-briefed Comms question visible", () => {
  store.upsertRun(
    run({
      loop: {
        ...NEW_LOOP,
        phase: "parked",
        parked: { kind: "budget", reason: "Operator decision", ended: true },
      },
    }),
  );
  const m = store.addComms({
    at: NOW - 20 * 60_000,
    from: "guido",
    to: "CAPCOM",
    ticket: "repo#7",
    text: "May I proceed?",
    label: "question",
  });
  if (!m) throw Error("missing message");
  const key = `comms-open:${m.id}`;
  store.addBrief({
    key,
    for: "operator",
    context: "Held run",
    recommendation: "Keep held",
    options: [{ label: "Hold", answer: "Keep the hold" }],
    basis: "Budget",
    at: NOW,
  });
  expect(needsYouItems(attentionItems(config, store, NOW)).some((i) => i.key === key)).toBe(true);
});
it("routes FLIGHT's own current for:flight brief away from the operator", () => {
  const m = store.addComms({
    at: NOW - 60_000,
    from: "flight",
    to: "CAPCOM",
    ticket: null,
    text: "@CAPCOM Should the controller check this?",
    mentions: ["CAPCOM"],
  });
  if (!m) throw Error("missing message");
  const key = `tag:flight:${m.id}`;
  store.addBrief({
    key,
    for: "flight",
    context: "For the controller",
    recommendation: "Controller will inspect",
    options: [],
    basis: "Existing scope",
    at: NOW,
  });
  const items = attentionItems(config, store, NOW);
  expect(items.find((i) => i.key === key)?.owner).toBe("flight");
  expect(needsYouItems(items).some((i) => i.key === key)).toBe(false);
});

it("routes a controller-owned cleanup to the operator only after an explicit recommended brief", () => {
  store.upsertRun(run());
  store.raiseNote({
    key: "cleanup:run",
    kind: "blocked",
    runId: "run",
    seatId: "guido",
    repoId: "repo",
    text: "Cleanup failed",
    at: NOW - 60_000,
  });
  const key = "note:cleanup:run";
  expect(attentionItems(config, store, NOW).find((i) => i.key === key)?.owner).toBe("controller");
  store.addBrief({
    key,
    for: "operator",
    context: "No controller is available",
    recommendation: "Keep the worktree and ask the operator to inspect the lock",
    options: [],
    basis: "Cleanup failure",
    at: NOW,
  });
  expect(needsYouItems(attentionItems(config, store, NOW)).some((i) => i.key === key)).toBe(true);
});
