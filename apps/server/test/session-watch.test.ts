import {
  type CmuxSessionRow,
  type CmuxSessionState,
  type FlightMode,
  SESSION_NOTE_PREFIX,
  SESSION_WATCH_MS,
  sessionFinishedText,
  sessionWaitingText,
} from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { attentionItems } from "../src/hud/hud.ts";
import { createSessionWatch, type SessionWatch } from "../src/sessions/watch.ts";
import { Store } from "../src/store.ts";

const T0 = Date.parse("2026-11-25T12:00:00Z");
const HOUR = 60 * 60_000;
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

let store: Store;
let bus: ChangeBus;
let emitted: string[];
let state: CmuxSessionState;
let rows: CmuxSessionRow[] | null;
let mode: FlightMode;
let watch: SessionWatch;

const notes = () => store.notes().filter((n) => n.key.startsWith(SESSION_NOTE_PREFIX));
const tick = async () => {
  await vi.advanceTimersByTimeAsync(SESSION_WATCH_MS);
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  store = new Store(":memory:");
  bus = new ChangeBus();
  emitted = [];
  bus.subscribe((t) => emitted.push(t));
  state = "idle";
  rows = null;
  mode = "watch";
  watch = createSessionWatch({
    sessions: {
      view: async () => ({
        ok: true,
        at: Date.now(),
        sessions: rows ?? [
          {
            id: ID,
            name: "shop (GUIDO)",
            owner: "operator",
            folder: null,
            repo: null,
            repoKey: null,
            state,
            since: T0,
            lastLine: null,
            status: null,
            app: null,
            inbox: { unread: 0, newest: null },
            check: null,
          },
        ],
        repos: [],
      }),
    },
    store,
    bus,
    mode: () => mode,
    now: () => Date.now(),
  });
  watch.start();
});
afterEach(() => {
  watch.stop();
  vi.useRealTimers();
});

describe("the session watch", () => {
  it("a session that starts waiting gives one question note within one tick", async () => {
    await tick();
    expect(notes()).toEqual([]);
    state = "waiting";
    await tick();
    expect(notes()).toMatchObject([
      {
        key: `${SESSION_NOTE_PREFIX}${ID}`,
        kind: "question",
        text: sessionWaitingText("shop (GUIDO)"),
      },
    ]);
    expect(emitted).toContain("attention");
    const at = notes()[0]?.at;
    emitted = [];
    for (let i = 0; i < 10; i++) await tick();
    expect(notes()).toHaveLength(1);
    expect(notes()[0]?.at).toBe(at);
    expect(emitted).toEqual([]);
  });

  it("working to idle gives the finished note, and back to working clears it", async () => {
    state = "working";
    await tick();
    state = "idle";
    await tick();
    expect(notes()).toMatchObject([{ kind: "flag", text: sessionFinishedText("shop (GUIDO)") }]);
    state = "working";
    await tick();
    expect(notes()).toEqual([]);
  });

  it("a first sight raises nothing, and a session gone clears its note", async () => {
    state = "waiting";
    await tick();
    expect(notes()).toEqual([]);
    state = "idle";
    await tick();
    state = "waiting";
    await tick();
    expect(notes()).toHaveLength(1);
    rows = [];
    await tick();
    expect(notes()).toEqual([]);
  });

  it.each(["idle", "no-agent"] as const)(
    "a session that leaves waiting for %s clears its waiting note",
    async (after) => {
      await tick();
      state = "waiting";
      await tick();
      expect(notes()).toHaveLength(1);
      // the operator answered, or Claude exited and left its shell
      state = after;
      await tick();
      expect(notes()).toEqual([]);
    },
  );

  it("clears notes left from before a hub restart that are no longer true", async () => {
    const GONE = "11111111-1111-4111-8111-111111111111";
    const left = (id: string, kind: "question" | "flag", text: string) =>
      store.refreshNote({
        key: `${SESSION_NOTE_PREFIX}${id}`,
        kind,
        runId: null,
        seatId: null,
        repoId: null,
        text,
        at: T0 - HOUR,
      });
    left(ID, "question", sessionWaitingText("shop (GUIDO)"));
    left(GONE, "flag", sessionFinishedText("old"));
    // the session that was waiting is idle now, and the other one is gone
    await tick();
    expect(notes()).toEqual([]);
    // one still true stays: a session that is still waiting keeps its note
    left(ID, "question", sessionWaitingText("shop (GUIDO)"));
    state = "waiting";
    await tick();
    expect(notes()).toHaveLength(1);
  });

  it.each(["crew", "on-call"] as const)("raises nothing in %s mode", async (m) => {
    mode = m;
    await tick();
    state = "waiting";
    await tick();
    expect(notes()).toEqual([]);
  });

  it("leaving watch mode clears every session note and forgets the states", async () => {
    await tick();
    state = "waiting";
    await tick();
    expect(notes()).toHaveLength(1);
    mode = "crew";
    await tick();
    expect(notes()).toEqual([]);
    mode = "watch";
    await tick();
    expect(notes()).toEqual([]);
  });
});

describe("a session note in Needs you", () => {
  it("is the operator's at once, while a live FLIGHT triages other notes", async () => {
    const config: CcConfig = {
      operator: { id: "op", timezone: "Europe/London" },
      accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
      repos: [{ id: "mc", github: "o/mc", project: 1, statusMap: {}, autonomy: "draft" }],
      loops: [],
      poll: { usageMinutes: 30, githubSeconds: 60 },
      crew: {
        worktrees: "/tmp/none",
        maxSeats: 2,
        sessions: [
          {
            id: "s1",
            repoId: "mc",
            checkout: "/tmp/none/clone",
            seats: [
              { id: "flight-1", role: "FLIGHT", accountId: "claude-main", model: "opus", area: [] },
            ],
          },
        ],
      },
    };
    store.upsertRun({
      id: "r-flight",
      agentId: "flight-1",
      repoId: "mc",
      seq: 1,
      startedAt: T0 - HOUR,
      endedAt: null,
      status: "running",
      sessionId: "cli",
      model: "opus",
      branch: null,
      ticket: null,
      costUsd: null,
      tokens: null,
      transcriptPath: "/x",
      prs: [],
      summary: null,
    });
    store.setSeatSession({
      seatId: "flight-1",
      runId: "r-flight",
      cliSessionId: "cli",
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: T0 - HOUR,
    });
    await tick();
    state = "waiting";
    await tick();
    store.raiseNote({
      key: "other",
      kind: "flag",
      runId: null,
      seatId: null,
      repoId: null,
      text: "x",
      at: Date.now(),
    });
    const items = attentionItems(config, store, Date.now() + HOUR);
    const session = items.find((i) => i.key.includes(SESSION_NOTE_PREFIX));
    expect(session).toMatchObject({ owner: "operator", kind: "question" });
    expect(session?.flightTriage).toBeUndefined();
    // the control: an ordinary note waits on FLIGHT's triage
    expect(items.find((i) => i.key.endsWith(":other"))?.flightTriage).toBeDefined();
  });
});
