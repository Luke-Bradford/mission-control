import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  FLIGHT_BRIEF_TITLES,
  FLIGHT_LEDGER_INDEX_MAX,
  FLIGHT_NOTE_SECTIONS,
  FLIGHT_RECENT_LISTED,
  FLIGHT_TICKETS_LISTED,
  FLIGHT_WAKE_HEAD,
  FLIGHT_WAKE_STORED_BYTES,
  type FlightState,
  wakeKey,
  wakeLine,
} from "@mc/core";
import { describe, expect, it } from "vitest";
import { flightWake, wakeFacts } from "../src/flight/state.ts";
import { changedWakeFacts } from "../src/flight/watch.ts";
import { Store } from "../src/store.ts";

const busyBoard = (): FlightState => ({
  signals: [],
  triage: [],
  time: "12:00",
  repo: "mc",
  lane: null,
  hubLogin: "operator",
  headline: "The crew is building tickets and reviewing PRs.",
  brief: FLIGHT_NOTE_SECTIONS.map((section) => ({
    section,
    title: FLIGHT_BRIEF_TITLES[section],
    text: "Keep project facts, crew notes, operator preferences and lessons current. ".repeat(25),
    ageMin: 5,
  })),
  tickets: Array.from({ length: FLIGHT_TICKETS_LISTED }, (_, n) => ({
    ref: `mc#${n + 1}`,
    title: `Ticket ${n + 1}: improve the crew's board and review workflow`,
    column: n === 0 ? "Ready" : n % 2 === 0 ? "Refinement" : "Backlog",
    ready: n === 0,
    untrustedAuthor: false,
    arrival: { source: "Board", arrivalId: `mc#${n + 1}`, version: "1000", arrivedAt: 1000 },
    priority: "P1",
    labels: ["area:server", "type:feature", "lane:work"],
    blockedBy: [],
    laneLabel: "lane:work",
    assignees: [],
  })),
  seats: Array.from({ length: 8 }, (_, n) => ({
    id: `guido-${n}`,
    runId: `run-${n}`,
    call: `GUIDO-${n}`,
    role: "GUIDO",
    loop: "build",
    area: ["apps/server/**"],
    state: "idle",
    free: false,
    ticket: `mc#${n + 40}`,
    title: `Build ticket ${n + 40}`,
    phase: "working",
    parked: null,
    stalled: false,
    idleMin: 0,
    openQuestion: false,
    atStop: false,
  })),
  prs: Array.from({ length: 12 }, (_, n) => ({
    ref: `mc#${n + 40}`,
    pr: n + 100,
    seat: `guido-${n}`,
    runId: `run-${n}`,
    ready: false,
    state: "open",
    headSha: `head-${n}`,
    readAt: "12:00",
    stale: false,
    review: null,
    failingChecks: [],
  })),
  recent: Array.from({ length: FLIGHT_RECENT_LISTED }, (_, n) => ({
    id: n,
    time: "11:59",
    kind: "note",
    about: `Ticket mc#${n + 40}`,
    decision:
      "Checked the board and review evidence; the crew is continuing the planned work. ".repeat(4),
  })),
  ledger: Array.from({ length: FLIGHT_LEDGER_INDEX_MAX }, (_, n) => ({
    kind: "work",
    key: `work-${n}`,
    title: `Track ticket mc#${n + 40}`,
    status: "active",
    next: "Read the next review and settle the findings",
  })),
  ledgerMore: 3,
  aside: [],
  questions: [{ id: 1, seat: "guido-0", ticket: "mc#40", text: "Which lane?", ageMin: 0 }],
  items: [],
  holds: [],
  limits: { startsLeft: 10, messagesLeft: 30 },
});

describe("wake deltas", () => {
  it("ignores changing evidence on told signals but includes changes while untold", () => {
    const state = busyBoard();
    state.signals = [
      { kind: "github_budget", key: "reset", since: 1, evidence: "100/5000", told: false },
    ];
    const untold = flightWake(state);
    const signal = state.signals[0];
    if (!signal) throw new Error("missing signal");
    signal.evidence = "99/5000";
    expect(flightWake(state, untold.snapshot).digest.signals.entries).toHaveLength(1);
    signal.told = true;
    const told = flightWake(state, untold.snapshot);
    expect(told.digest.signals.entries).toHaveLength(1);
    signal.evidence = "98/5000";
    signal.since = 2;
    expect(flightWake(state, told.snapshot).digest.signals).toEqual({
      entries: [],
      unchanged: 1,
      removed: [],
    });
  });

  it("deltas signals and names the changed wake facts in the stored header", () => {
    const state = busyBoard();
    const before = wakeFacts(state);
    const first = flightWake(state);
    state.signals = [
      { kind: "main_red", key: "main-sha", since: 1, evidence: "main-sha CI failing" },
    ];
    state.items = [
      {
        key: "item",
        kind: "blocked",
        ticket: null,
        text: "blocked",
        ageMin: 0,
        triageRemainingMs: 0,
      },
    ];
    const next = flightWake(state, first.snapshot);
    expect(next.digest.signals).toEqual({ entries: state.signals, unchanged: 0, removed: [] });
    expect(flightWake(state, next.snapshot).digest.signals).toEqual({
      entries: [],
      unchanged: 1,
      removed: [],
    });
    const causes = changedWakeFacts(before, wakeFacts(state));
    expect(causes).toEqual(["signals (1)", "items (1)"]);
    const header = wakeLine(state, next.digest, causes).split("\n")[0] ?? "";
    expect(header).toContain("woke on: signals (1), items (1)");
    expect(
      Buffer.byteLength(header) + Buffer.byteLength(`\nsha256:${"0".repeat(64)}`),
    ).toBeLessThan(FLIGHT_WAKE_STORED_BYTES);
    expect(flightWake({ ...state, signals: [] }, next.snapshot).digest.signals.removed).toEqual([
      "main_red:main-sha",
    ]);
  });

  it("omits unchanged entries and the brief, keeping facts and compact candidates", () => {
    const state = busyBoard();
    const first = flightWake(state);
    const next = flightWake(state, first.snapshot).digest;
    expect(first.digest.brief).toEqual(state.brief);
    expect(first.digest.headline).toBe(state.headline);
    expect(first.digest.briefVersion).toBe(1);
    expect(next).not.toHaveProperty("brief");
    expect(next).not.toHaveProperty("headline");
    expect(next.briefVersion).toBe(first.digest.briefVersion);
    for (const list of ["recent", "prs", "seats", "ledger"] as const) {
      expect(first.digest[list]).toEqual({ entries: state[list], unchanged: 0, removed: [] });
      expect(next[list]).toEqual({ entries: [], unchanged: state[list].length, removed: [] });
    }
    expect(next.facts).toEqual(JSON.parse(wakeFacts(state)));
    expect(next.questions).toEqual(state.questions);
    expect(next.ledgerMore).toBe(state.ledgerMore);
    expect(first.digest.tickets.entries[0]).toEqual(state.tickets[0]);
    expect(first.digest.tickets.entries[1]).toBe(`#2 ${state.tickets[1]?.title}`);
    expect(first.digest.tickets.entries[2]).toBe(`#3 ${state.tickets[2]?.title}`);
    expect(state.tickets[1]).toHaveProperty("labels");
  });

  it("sends changed and new entries by key, including entries that leave and return", () => {
    const state = busyBoard();
    const first = flightWake(state);
    const changed = structuredClone(state);
    for (const pr of changed.prs.slice(0, 1)) pr.stale = true;
    for (const seat of changed.seats.slice(0, 1)) seat.stalled = true;
    for (const decision of changed.recent.slice(0, 1)) decision.decision = "Updated decision";
    for (const entry of changed.ledger.slice(0, 1)) entry.next = "Read new evidence";
    const next = flightWake(changed, first.snapshot);
    for (const list of ["recent", "prs", "seats", "ledger"] as const) {
      expect(next.digest[list]).toEqual({
        entries: [changed[list][0]],
        unchanged: state[list].length - 1,
        removed: [],
      });
    }
    const absent = flightWake({ ...state, ledger: [] }, next.snapshot);
    expect(flightWake(state, absent.snapshot).digest.ledger.entries).toEqual(state.ledger);
    for (const decision of changed.recent.slice(0, 1)) decision.id = 100;
    expect(flightWake(changed, next.snapshot).digest.recent.entries).toEqual([changed.recent[0]]);
  });

  it("versions note and headline changes without treating age as a brief edit", () => {
    const state = busyBoard();
    const first = flightWake(state);
    const note = state.brief[0];
    if (!note) throw new Error("missing note");
    note.ageMin = 65;
    expect(flightWake(state, first.snapshot).digest.brief).toBeUndefined();
    note.text = "New project fact";
    const edit = flightWake(state, first.snapshot);
    expect(edit.digest).toMatchObject({ brief: [note], briefVersion: 2 });
    expect(edit.digest.headline).toBeUndefined();
    state.headline = "New headline";
    const headline = flightWake(state, edit.snapshot);
    expect(headline.digest).toMatchObject({ headline: state.headline, briefVersion: 3 });
    expect(headline.digest.brief).toBeUndefined();
    expect(flightWake(state, headline.snapshot).digest.brief).toBeUndefined();
    expect(flightWake(state).digest.brief).toEqual(state.brief);
  });

  it("keeps ready-labelled Backlog fields and caps the candidate list", () => {
    const state = busyBoard();
    const ticket = state.tickets[1];
    if (!ticket) throw new Error("missing ticket");
    ticket.ready = true;
    state.tickets.push(...state.tickets);
    const { digest } = flightWake(state);
    expect(digest.tickets.entries).toHaveLength(FLIGHT_TICKETS_LISTED);
    expect(digest.tickets.entries[1]).toEqual(state.tickets[1]);
  });

  it.each(["recent", "prs", "seats", "ledger", "tickets"] as const)(
    "reports removed %s keys once, including entries displaced by the list cap",
    (list) => {
      const state = busyBoard();
      const first = flightWake(state);
      const keys = [...first.snapshot[list].keys()];
      const absent = flightWake({ ...state, [list]: state[list].slice(1) }, first.snapshot);
      expect(absent.digest[list]).toEqual({
        entries: [],
        unchanged: state[list].length - 1,
        removed: [keys[0]],
      });
      const stillAbsent = flightWake({ ...state, [list]: state[list].slice(1) }, absent.snapshot);
      expect(stillAbsent.digest[list].removed).toEqual([]);
      const returned = flightWake(state, stillAbsent.snapshot);
      expect(returned.digest[list].entries).toEqual([first.digest[list].entries[0]]);
      expect(returned.digest[list].removed).toEqual([]);
    },
  );

  it("deltas both compact and detailed tickets, retaining trust markers and promotions", () => {
    const state = busyBoard();
    for (const ticket of state.tickets.slice(0, 3)) ticket.untrustedAuthor = true;
    const first = flightWake(state);
    expect(first.digest.tickets.entries.slice(0, 3)).toEqual([
      state.tickets[0],
      `#2 [untrusted] ${state.tickets[1]?.title}`,
      `#3 [untrusted] ${state.tickets[2]?.title}`,
    ]);
    expect(flightWake(state, first.snapshot).digest.tickets).toEqual({
      entries: [],
      unchanged: state.tickets.length,
      removed: [],
    });
    const ready = state.tickets[0];
    const backlog = state.tickets[1];
    const refinement = state.tickets[2];
    if (!ready || !backlog || !refinement) throw new Error("missing tickets");
    ready.priority = "P0";
    backlog.title = "Updated title";
    refinement.ready = true;
    const next = flightWake(state, first.snapshot);
    expect(next.digest.tickets).toEqual({
      entries: [ready, "#2 [untrusted] Updated title", refinement],
      unchanged: state.tickets.length - 3,
      removed: [],
    });
    backlog.untrustedAuthor = false;
    refinement.ready = false;
    expect(flightWake(state, next.snapshot).digest.tickets.entries).toEqual([
      "#2 Updated title",
      `#3 [untrusted] ${refinement.title}`,
    ]);
  });

  it("ignores poll and age churn but retains fresh counters with a substantive change", () => {
    const state = busyBoard();
    const first = flightWake(state);
    for (const seat of state.seats) seat.idleMin = 60;
    for (const pr of state.prs) pr.readAt = "13:00";
    for (const note of state.brief) note.ageMin = 65;
    const tick = flightWake(state, first.snapshot);
    expect(tick.digest.seats.entries).toEqual([]);
    expect(tick.digest.prs.entries).toEqual([]);
    expect(tick.digest.brief).toBeUndefined();
    for (const seat of state.seats.slice(0, 1)) seat.stalled = true;
    for (const pr of state.prs.slice(0, 1)) pr.stale = true;
    const changed = flightWake(state, tick.snapshot).digest;
    expect(changed.seats.entries).toEqual([state.seats[0]]);
    expect(changed.seats.entries[0]?.idleMin).toBe(60);
    expect(changed.prs.entries).toEqual([state.prs[0]]);
    expect(changed.prs.entries[0]?.readAt).toBe("13:00");
  });

  it("prints full, first and typical delta sizes with ticking fields and new work", () => {
    const state = busyBoard();
    const first = flightWake(state);
    const firstBytes = Buffer.byteLength(wakeLine(state, first.digest));
    state.time = "13:00";
    for (const seat of state.seats) seat.idleMin = 60;
    for (const pr of state.prs) pr.readAt = "13:00";
    for (const note of state.brief) note.ageMin = 65;
    for (const question of state.questions) question.ageMin = 60;
    for (const pr of state.prs.slice(0, 1)) pr.stale = true;
    for (const ticket of state.tickets.slice(0, 1)) ticket.priority = "P0";
    state.recent.unshift({
      id: 100,
      time: "13:00",
      kind: "note",
      about: "mc#40",
      decision: "Review again after CI.",
    });
    state.recent.pop();
    const next = flightWake(state, first.snapshot);
    const sizes = {
      full: Buffer.byteLength(wakeLine(state)),
      first: firstBytes,
      typicalDelta: Buffer.byteLength(wakeLine(state, next.digest)),
    };
    console.log(
      `Busy-board wake bytes (ticking ages/readAt, one PR, ticket and decision change): ${JSON.stringify(sizes)}`,
    );
    expect(sizes.typicalDelta).toBeLessThan(sizes.full / 2);
    expect(sizes.typicalDelta).toBeLessThan(sizes.first / 2);
  });
});

describe("stored wakes", () => {
  it("migrates old oversized wakes once at boot, preserving claims and unrelated rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-wake-migration-"));
    const path = join(dir, "mc.sqlite");
    let store = new Store(path);
    const db = new DatabaseSync(path);
    try {
      store.close();
      // Model a database created before the one-off migration existed.
      db.prepare("DELETE FROM settings WHERE key = 'flight-wake-compact-v1'").run();
      const text = wakeLine(busyBoard());
      const unicode = `${FLIGHT_WAKE_HEAD} short\n${JSON.stringify({ text: "🚀".repeat(300) })}`;
      expect(unicode.length).toBeLessThan(FLIGHT_WAKE_STORED_BYTES);
      expect(Buffer.byteLength(unicode)).toBeGreaterThan(FLIGHT_WAKE_STORED_BYTES);
      const small = `${FLIGHT_WAKE_HEAD} small\n{}`;
      const insert = db.prepare(
        "INSERT INTO seat_lines (key, run_id, seat_id, origin, text, at) VALUES (?, 'flight', 'flight-1', 'engine', ?, ?)",
      );
      insert.run(wakeKey("flight", 1), text, 1);
      insert.run(wakeKey("flight", 2), unicode, 2);
      insert.run(wakeKey("flight", 3), small, 3);
      insert.run("other", text, 4);
      store = new Store(path);
      const rows = () => db.prepare("SELECT * FROM seat_lines ORDER BY key").all();
      const migrated = rows();
      for (const [key, original] of [
        [wakeKey("flight", 1), text],
        [wakeKey("flight", 2), unicode],
      ]) {
        const saved = db.prepare("SELECT text FROM seat_lines WHERE key = ?").get(key as string)
          ?.text as string;
        const hash = createHash("sha256")
          .update(original?.split("\n").at(-1) ?? "")
          .digest("hex");
        expect(saved).toBe(`${original?.split("\n")[0]}\nsha256:${hash}`);
        expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(FLIGHT_WAKE_STORED_BYTES);
      }
      expect(
        db.prepare("SELECT text FROM seat_lines WHERE key = ?").get(wakeKey("flight", 3))?.text,
      ).toBe(small);
      expect(db.prepare("SELECT text FROM seat_lines WHERE key = 'other'").get()?.text).toBe(text);
      expect(store.claimedKeys("flight")).toEqual({
        [wakeKey("flight", 1)]: 1,
        [wakeKey("flight", 2)]: 2,
        [wakeKey("flight", 3)]: 3,
        other: 4,
      });
      expect(store.getSetting("flight-wake-compact-v1")).toBe("1");
      store.close();
      store = new Store(path);
      expect(rows()).toEqual(migrated);
      expect(
        store.claimLine(wakeKey("flight", 1), {
          runId: "flight",
          seatId: "flight-1",
          origin: "engine",
          text,
          at: 9,
        }),
      ).toBe(false);
    } finally {
      db.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the header and JSON hash within 1 kB, preserving other lines and claims", () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-wake-"));
    const path = join(dir, "mc.sqlite");
    const store = new Store(path);
    const db = new DatabaseSync(path);
    try {
      const state = busyBoard();
      const text = wakeLine(state, flightWake(state).digest);
      const line = { runId: "flight", seatId: "flight-1", origin: "engine" as const, text, at: 1 };
      const key = wakeKey(line.runId, 1);
      expect(store.claimLine(key, line)).toBe(true);
      expect(store.claimLine(key, line)).toBe(false);
      const saved = (
        db.prepare("SELECT text FROM seat_lines WHERE key = ?").get(key) as { text: string }
      ).text;
      const hash = createHash("sha256")
        .update(text.split("\n").at(-1) ?? "")
        .digest("hex");
      expect(saved).toBe(`${text.split("\n")[0]}\nsha256:${hash}`);
      expect(Buffer.byteLength(saved)).toBeLessThanOrEqual(FLIGHT_WAKE_STORED_BYTES);
      expect(Buffer.byteLength(saved)).toBeLessThan(Buffer.byteLength(text) / 2);
      expect(store.claimedKeys(line.runId)).toEqual({ [key]: 1 });
      expect(store.lastEngineLineAt(line.runId)).toBe(1);
      store.claimLine(wakeKey(line.runId, 2), {
        ...line,
        text: `${FLIGHT_WAKE_HEAD} ${"🚀".repeat(1000)}\n{}`,
      });
      const long = (
        db.prepare("SELECT text FROM seat_lines WHERE key = ?").get(wakeKey(line.runId, 2)) as {
          text: string;
        }
      ).text;
      expect(Buffer.byteLength(long)).toBeLessThanOrEqual(FLIGHT_WAKE_STORED_BYTES);
      expect(long).not.toContain("�");
      store.claimLine("other", line);
      expect(db.prepare("SELECT text FROM seat_lines WHERE key = 'other'").get()).toEqual({ text });
      store.dropLine(key);
      expect(store.claimLine(key, line)).toBe(true);
      console.log(`Busy-board stored wake bytes: ${Buffer.byteLength(saved)}`);
    } finally {
      db.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
