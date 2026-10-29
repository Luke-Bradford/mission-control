import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AttentionItem, DECISION_DEFAULT_WAIT_MS } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decisionDefault } from "../src/attention-holds.ts";
import type { CcConfig } from "../src/config.ts";
import { applyDecisionDefaults } from "../src/decision-defaults.ts";
import { attentionItems, NOTE_KEY } from "../src/hud.ts";
import { Store } from "../src/store.ts";
import { HUB_UPDATE_HELD_KEY } from "../src/update.ts";

const NOW = Date.parse("2026-10-29T12:00:00Z");
const ASKED = NOW - DECISION_DEFAULT_WAIT_MS;
let dir: string;
let store: Store;

const config = (): CcConfig => ({
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
});

const option = { id: "go", label: "Go", answer: "Proceed." };
const item = (key: string, kind: AttentionItem["kind"] = "decision"): AttentionItem => ({
  key,
  kind,
  agentId: "GUIDO-1",
  repoId: "repo",
  text: "Proceed?",
  tool: null,
  at: ASKED,
  url: null,
  escalationId: null,
  ticket: "repo#1",
  owner: "operator",
  acked: false,
  brief: {
    for: "operator",
    context: "c",
    recommendation: "Go",
    options: [option],
    basis: "b",
    at: ASKED,
    recommendedOptionId: "go",
    defaultAt: NOW,
  },
});
const brief = () => {
  const value = item("x").brief;
  if (!value) throw new Error("test brief missing");
  return value;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-default-"));
  store = new Store(join(dir, "db.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("decision defaults", () => {
  async function expectProtectedSweep(key: string): Promise<void> {
    store.addBrief({ key, ...brief() });
    const deliver = vi.fn(async () => {});
    expect(await applyDecisionDefaults({ config: config(), store, now: NOW, deliver })).toBe(0);
    expect(store.acks().has(key)).toBe(false);
    expect(store.pendingDecisionDeliveries()).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();
  }

  it("does not sweep the Update hold", async () => {
    store.raiseNote({
      key: HUB_UPDATE_HELD_KEY,
      kind: "ready",
      runId: null,
      seatId: null,
      repoId: "repo",
      text: "Update",
      at: ASKED,
    });
    await expectProtectedSweep(`${NOTE_KEY}${HUB_UPDATE_HELD_KEY}`);
  });

  it("does not sweep an approval", async () => {
    store.raiseNote({
      key: "approval",
      kind: "approval",
      runId: null,
      seatId: null,
      repoId: "repo",
      text: "Approval",
      at: ASKED,
    });
    await expectProtectedSweep("note:approval");
  });

  it("does not sweep a budget park", async () => {
    store.raiseNote({
      key: "budget",
      kind: "blocked",
      runId: null,
      seatId: null,
      repoId: "repo",
      text: "Budget",
      at: ASKED,
    });
    await expectProtectedSweep("note:budget");
  });

  it("does not sweep an observed-loop escalation", async () => {
    store.replaceEscalations("repo", [
      {
        id: "repo#9",
        repoId: "repo",
        issueNumber: 9,
        title: "Escalated",
        kind: "operator-decision",
        source: "label",
        openedAt: ASKED,
        url: "u",
        question: null,
      },
    ]);
    await expectProtectedSweep("esc:repo#9");
  });

  it("never defaults an operator decision on a confinement-floor PR", () => {
    vi.spyOn(store, "loopRuns").mockReturnValue([
      { repoId: "repo", loop: { prNumber: 9, touches: { paths: ["CLAUDE.md"] } } },
    ] as never);
    expect(decisionDefault(store, item("pr:repo#9:1", "pr"))).toBeNull();
  });

  it("never defaults a non-flag note held by a stopped seat", () => {
    vi.spyOn(store, "notes").mockReturnValue([
      { key: "ready:r", runId: "r", dismissedAt: null },
    ] as never);
    vi.spyOn(store, "run").mockReturnValue({
      id: "r",
      repoId: "repo",
      agentId: "GUIDO-1",
    } as never);
    store.setSeatSession({
      seatId: "GUIDO-1",
      runId: "r",
      cliSessionId: null,
      state: "stopped",
      reason: null,
      worktree: null,
      updatedAt: ASKED,
    });
    expect(decisionDefault(store, item("note:ready:r", "ready"), config(), NOW)).toBeNull();
  });

  it("does not default a brief stored before defaultAt existed", () => {
    const legacy = item("ask:legacy");
    if (legacy.brief) delete legacy.brief.defaultAt;
    expect(decisionDefault(store, legacy)).toBeNull();
  });

  it("starts the wait when a default is first stamped, not at an older ask's time", () => {
    const key = "ask:old";
    const asked = NOW - 5 * 86_400_000;
    // briefed before defaults existed: the same ask, stored with no defaultAt
    store.addBrief({ key, ...brief(), at: asked, defaultEligible: false });
    store.addBrief({ key, ...brief(), at: NOW });
    const stored = store.briefs().get(key);
    expect(stored?.askAt).toBe(asked);
    expect(stored?.defaultAt).toBe(NOW + DECISION_DEFAULT_WAIT_MS);
  });

  it("stores a recommendation on a protected brief without a deadline", () => {
    store.addBrief({
      key: `${NOTE_KEY}${HUB_UPDATE_HELD_KEY}`,
      ...brief(),
      defaultEligible: false,
    });
    expect(store.briefs().get(`${NOTE_KEY}${HUB_UPDATE_HELD_KEY}`)).toMatchObject({
      recommendedOptionId: "go",
    });
    expect(store.briefs().get(`${NOTE_KEY}${HUB_UPDATE_HELD_KEY}`)).not.toHaveProperty("defaultAt");
  });

  it("applies an ordinary reversible decision once at its deadline", async () => {
    const id = store.addQuestion({ agentId: "GUIDO-1", runId: "run", text: "Proceed?", at: ASKED });
    store.setSeatSession({
      seatId: "GUIDO-1",
      runId: "run",
      cliSessionId: null,
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: ASKED,
    });
    store.addBrief({ key: `ask:${id}`, ...brief() });
    const deliver = vi.fn(async () => {});
    expect(await applyDecisionDefaults({ config: config(), store, now: NOW, deliver })).toBe(1);
    expect(attentionItems(config(), store, NOW).find((x) => x.key === `ask:${id}`)?.acked).toBe(
      true,
    );
    expect(deliver).toHaveBeenCalledOnce();
    expect(await applyDecisionDefaults({ config: config(), store, now: NOW + 1, deliver })).toBe(0);
  });
});
