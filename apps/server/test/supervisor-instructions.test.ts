import { defined } from "./defined.ts";
// All process boundaries use the repository's fake CLI/keeper fixture, never a paid provider.
import "./supervisor-harness.ts";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { directionKey, readDirectionContext } from "../src/runtime/instruction-context.ts";
import { crewPromptPath } from "../src/store/crew-paths.ts";
import { blockedHere, skipTestsIf } from "./sandbox-gaps.ts";
import {
  clone,
  dbPath,
  git,
  make,
  noKeepers,
  prep,
  recorded,
  refusal,
  seatState,
  store,
  until,
  userLines,
} from "./supervisor-harness.ts";

skipTestsIf(await blockedHere("crew-run"));

const flight = {
  id: "flight-1",
  role: "FLIGHT",
  accountId: "claude-main",
  model: "opus",
  area: [],
};
function direction(text = "Fixture direction") {
  mkdirSync(join(clone, "docs"), { recursive: true });
  writeFileSync(join(clone, "docs/direction.md"), text);
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "fixture direction");
  git(clone, "push", "-q", "origin", "main");
}
it("delivers current orders after verified direction on initial, repeated, operator and rotated turns", async () => {
  direction();
  const order = store.instructions.create(
    null,
    { kind: "text", text: "First saved order" },
    "operator",
    1,
  ).entry;
  const { sup } = make({ extraSeat: flight });
  sup.start();
  const started = await sup.startWatch(flight.id, { first: "Initial working memory" });
  await until(() => expect(userLines()).toHaveLength(1));
  const initial = userLines()[0] as string;
  const systemBytes = Buffer.byteLength(
    readFileSync(crewPromptPath(dbPath, started.runId), "utf8"),
  );
  expect(initial.indexOf("Fixture direction")).toBeLessThan(
    initial.indexOf('"text":"First saved order"'),
  );
  expect(initial.indexOf('"text":"First saved order"')).toBeLessThan(
    initial.indexOf("Initial working memory"),
  );
  expect(store.getSetting(directionKey(started.runId))).toContain("Fixture direction");
  await until(() => expect(seatState(flight.id)).toBe("idle"));
  const before = store.getSetting(`instruction.delivered:${started.runId}`);
  store.instructions.revoke(order.id, null, "operator", 2);
  store.instructions.create(null, { kind: "text", text: "Current saved order" }, "operator", 3);
  prep.failWrite = true;
  expect(
    await sup.send(started.runId, "instruction-failed", "Repeated memory", { wake: 1, pieces: [] }),
  ).toBe("busy");
  expect(store.getSetting(`instruction.delivered:${started.runId}`)).toBe(before);
  prep.failWrite = false;
  expect(
    await sup.send(started.runId, "instruction-failed", "Repeated memory", { wake: 1, pieces: [] }),
  ).toBe("sent");
  await until(() => expect(userLines()).toHaveLength(2));
  expect(userLines()[1]).toContain('"text":"Current saved order"');
  expect(userLines()[1]).not.toContain('"text":"First saved order"');
  await until(() => expect(seatState(flight.id)).toBe("idle"));
  await sup.message(flight.id, "Original operator message", {
    interrupt: false,
    questions: "none",
  });
  await until(() => expect(userLines()).toHaveLength(3));
  expect(userLines()[2]).toContain('"text":"Current saved order"');
  expect(userLines()[2]).toContain("Original operator message");
  await until(() => expect(seatState(flight.id)).toBe("idle"));
  await sup.endRunByEngine(started.runId);
  await sup.startWatch(flight.id, { first: "Rotated memory" });
  await until(() => expect(userLines()).toHaveLength(4));
  expect(userLines()[3]).toContain('"text":"Current saved order"');
  expect(userLines()[3]).toContain("Rotated memory");
  const firstWake = store.promptWakes(started.runId)[0];
  expect(firstWake.sections.reduce((n, s) => n + s.bytes, 0)).toBe(
    systemBytes + Buffer.byteLength(initial),
  );
});
it("retains verified direction and orders through keeper loss and resume", async () => {
  direction("Retained fixture direction");
  store.instructions.create(null, { kind: "text", text: "Persistent order" }, "operator", 1);
  const first = make({ extraSeat: flight });
  first.sup.start();
  const { runId } = await first.sup.startWatch(flight.id);
  await until(() => expect(seatState(flight.id)).toBe("idle"));
  const source = store.getSetting(directionKey(runId));
  await first.sup.stopAll();
  await noKeepers();
  const second = make({ extraSeat: flight });
  second.sup.start();
  await until(() =>
    expect(store.seatSession(flight.id)?.reason).toBe(
      "resumed after a restart; send a message to continue",
    ),
  );
  await until(() => expect(second.sup.seatFacts(flight.id)).toMatchObject({ inTurn: false }));
  await second.sup.message(flight.id, "Resumed working context", {
    interrupt: false,
    questions: "none",
  });
  await until(() => expect(userLines().length).toBeGreaterThanOrEqual(2));
  expect(store.getSetting(directionKey(runId))).toBe(source);
  expect(userLines().at(-1)).toContain("Retained fixture direction");
  expect(userLines().at(-1)).toContain('"text":"Persistent order"');
});
it("appends current seat instructions after repo rules and delivers a complete revoked snapshot", async () => {
  const entry = store.instructions.create(
    "guido-1",
    { kind: "text", text: "Seat fixture rule" },
    "operator",
    1,
  ).entry;
  const { sup } = make();
  sup.start();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(seatState("guido-1")).toBe("idle"));
  const prompt = readFileSync(crewPromptPath(dbPath, runId), "utf8");
  expect(prompt.indexOf("Repo rule: keep tests green")).toBeLessThan(
    prompt.indexOf("Seat fixture rule"),
  );
  store.instructions.revoke(entry.id, "guido-1", "operator", 2);
  await sup.message("guido-1", "Instruction revoked", { interrupt: false, questions: "none" });
  await until(() => expect(userLines()).toHaveLength(2));
  expect(userLines()[1]).toContain("No active seat instructions.");
  expect(userLines()[1]).not.toContain('"text":"Seat fixture rule"');
});
it("rejects symlink and oversized direction instead of silently omitting or trimming it", async () => {
  direction("x".repeat(64 * 1024 + 1));
  const oversized = git(clone, "rev-parse", "HEAD").trim();
  await expect(readDirectionContext(clone, oversized)).rejects.toThrow(/64 KiB/);
  git(clone, "rm", "-q", "docs/direction.md");
  mkdirSync(join(clone, "docs"), { recursive: true });
  symlinkSync("../README.md", join(clone, "docs/direction.md"));
  git(clone, "add", "-A");
  git(clone, "commit", "-qm", "fixture unsafe direction");
  await expect(readDirectionContext(clone, git(clone, "rev-parse", "HEAD").trim())).rejects.toThrow(
    /unsafe/,
  );
});

it("resolves an order revoked while the actual delivery queue waits on an interrupt", async () => {
  const old = store.instructions.create(
    null,
    { kind: "text", text: "Queued old order" },
    "operator",
    1,
  ).entry;
  const { sup } = make({ extraSeat: flight });
  sup.start();
  await sup.startWatch(flight.id, { first: "SLOW working context" });
  await until(() => expect(userLines()).toHaveLength(1));
  const session = prep.sessions.at(-1);
  if (!session) throw new Error("Fake provider session missing");
  const originalControl = session.control.bind(session);
  let entered = () => {};
  const interruptStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  session.control = async (...args) => {
    entered();
    await gate;
    return originalControl(...args);
  };
  const pending = sup.message(flight.id, "Queued replacement context", {
    interrupt: true,
    questions: "none",
  });
  await interruptStarted;
  store.instructions.revoke(old.id, null, "operator", 2);
  store.instructions.create(null, { kind: "text", text: "Queued current order" }, "operator", 3);
  release();
  await pending;
  session.control = originalControl;
  await until(() => expect(userLines()).toHaveLength(2));
  const delivered = userLines()[1] as string;
  expect(delivered).toContain('"text":"Queued current order"');
  expect(delivered).not.toContain('"text":"Queued old order"');
  expect(delivered).toContain("Queued replacement context");
});

it("rebuilds a missing direction snapshot before delivering to a reattached keeper", async () => {
  direction("Verified keeper direction");
  const first = make({ extraSeat: flight });
  first.sup.start();
  const { runId } = await first.sup.startWatch(flight.id);
  await until(() => expect(seatState(flight.id)).toBe("idle"));
  store.deleteSetting(directionKey(runId));
  await first.sup.stopAll();
  const second = make({ extraSeat: flight });
  second.sup.start();
  await until(() => expect(second.sup.seatFacts(flight.id)).toMatchObject({ inTurn: false }));
  await second.sup.message(flight.id, "Post-reattachment context", {
    interrupt: false,
    questions: "none",
  });
  await until(() => expect(userLines()).toHaveLength(2));
  expect(userLines()[1]).toContain("Verified keeper direction");
  expect(userLines()[1]).toContain("rebuilt on resume");
  expect(userLines()[1]).toContain("Post-reattachment context");
});

it("retains a notice after failed immediate notification and delivers it once on the next real fixture turn", async () => {
  const { commsInboxContext } = await import("../src/comms.ts");
  const { announceInstruction } = await import("../src/instruction-notices.ts");
  const { bus } = await import("./supervisor-harness.ts");
  const { sup, cfg } = make({ inbox: (seatId, runId) => commsInboxContext(store, seatId, runId) });
  sup.start();
  await sup.startRun("guido-1", 42);
  await until(() => expect(seatState("guido-1")).toBe("idle"));
  prep.failWrite = true;
  const change = store.instructions.create(
    "guido-1",
    { kind: "text", text: "Complete live rule" },
    "operator",
    Date.now(),
  );
  const reply = await announceInstruction({ config: cfg, store, bus, supervisor: sup }, change);
  expect(reply.delivery).toBe("inbox");
  const notices = store.commsInbox("guido-1");
  expect(notices).toHaveLength(1);
  expect(store.commsInboxRead("guido-1", notices[0].id)).toBe(false);
  prep.failWrite = false;
  await sup.message("guido-1", "Next ordinary turn", { interrupt: false, questions: "none" });
  await until(() => expect(userLines()).toHaveLength(2));
  expect(userLines()[1]).toContain("Complete live rule");
  expect(userLines()[1]).toContain(`Instruction ${change.entry.id} saved`);
  expect(store.commsInboxRead("guido-1", notices[0].id)).toBe(true);
  expect(store.commsInbox("guido-1")).toHaveLength(1);
});

it("reports an actionable direction failure before launching a fake provider", async () => {
  direction("x".repeat(64 * 1024 + 1));
  const { sup } = make({ extraSeat: flight });
  sup.start();
  await expect(sup.startWatch(flight.id)).rejects.toThrow(/Fix docs\/direction.md/);
  expect(store.seatSession(flight.id)?.reason).toContain("64 KiB");
  expect(userLines()).toEqual([]);
  expect(prep.sessions).toEqual([]);
});

// Permanent coverage of the independent a4fb1f78 review repro; its scratch/log remain unchanged.
it.each(["label:new", null, undefined])(
  "keeps current reloaded focus %s on the existing live run's next delivery",
  async (focus) => {
    const { sup, cfg } = make();
    const session = defined(cfg.crew).sessions[0];
    const index = session.seats.findIndex((s) => s.id === "guido-1");
    const original = session.seats[index];
    original.focus = "label:old";
    store.instructions.syncFocus(original, 1);
    sup.start();
    await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    const { focus: _old, ...base } = original;
    const reloaded = focus === undefined ? base : { ...base, focus };
    session.seats.splice(index, 1, reloaded);
    store.instructions.syncFocus(reloaded, 2);
    const imported = store.instructions.focus("guido-1");
    await sup.message("guido-1", "Next turn after config reload", {
      interrupt: false,
      questions: "none",
    });
    await until(() => expect(userLines()).toHaveLength(2));
    expect(store.instructions.focus("guido-1")).toEqual(imported);
    expect(imported.effectiveFocus).toBe(focus ?? null);
    expect(userLines()[1]).toContain(`"focus":${JSON.stringify(focus ?? null)}`);
    expect(userLines()[1]).not.toContain('"focus":"label:old"');
  },
);

it("refuses a seat removed while its delivery waits without reimporting captured focus", async () => {
  const { sup, cfg } = make();
  const configured = defined(cfg.crew).sessions[0];
  const index = configured.seats.findIndex((s) => s.id === "guido-1");
  configured.seats[index].focus = "label:old";
  store.instructions.syncFocus(configured.seats[index], 1);
  sup.start();
  await sup.startRun("guido-1", 42);
  await until(() => expect(seatState("guido-1")).toBe("idle"));
  await sup.message("guido-1", "SLOW fixture work", { interrupt: false, questions: "none" });
  await until(() => expect(userLines()).toHaveLength(2));
  const before = store.instructions.seat("guido-1");
  const session = prep.sessions.at(-1);
  if (!session) throw new Error("Fixture session missing");
  const originalControl = session.control.bind(session);
  let entered = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  session.control = async (...args) => {
    entered();
    await gate;
    return originalControl(...args);
  };
  const delivery = sup.message("guido-1", "Must not reach a removed seat", {
    interrupt: true,
    questions: "none",
  });
  const refused = expect(delivery).rejects.toThrow(/removed before delivery/);
  await started;
  configured.seats.splice(index, 1);
  release();
  await refused;
  session.control = originalControl;
  expect(userLines()).toHaveLength(2);
  expect(store.instructions.seat("guido-1")).toEqual(before);
});

// Covers the independently confirmed 7b7bb20e pause bypass on each raw-supervisor notification path.
it.each(["saved instruction", "initial legacy focus import"])(
  "keeps %s durable and unread while paused, then delivers on an authorised ordinary turn",
  async (source) => {
    const { commsInboxContext } = await import("../src/comms.ts");
    const { messageUnpausedSeat } = await import("../src/crew-pause.ts");
    const { announceInstruction, flushInstructionNotices, importInstructionFocus } = await import(
      "../src/instruction-notices.ts"
    );
    const { bus } = await import("./supervisor-harness.ts");
    const { sup, cfg } = make({
      inbox: (seatId, runId) => commsInboxContext(store, seatId, runId),
    });
    sup.start();
    await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    const pause = JSON.stringify({
      seats: ["guido-1"],
      reason: "Operator token hold",
      at: Date.now(),
      by: "operator",
    });
    store.setSetting("crew.paused", pause);
    const deps = { config: cfg, store, bus, supervisor: sup };
    if (source === "saved instruction") {
      const saved = store.instructions.create(
        "guido-1",
        { kind: "text", text: "Saved while paused" },
        "operator",
        Date.now(),
      );
      expect((await announceInstruction(deps, saved)).delivery).toBe("inbox");
    } else {
      const seat = defined(cfg.crew).sessions[0].seats.find((s) => s.id === "guido-1");
      if (!seat) throw new Error("Fixture seat missing");
      store.deleteSetting("instruction.config-focus:guido-1");
      seat.focus = "label:legacy";
      importInstructionFocus(deps);
      await flushInstructionNotices(deps);
    }
    const notices = store.commsInbox("guido-1");
    expect(notices).toHaveLength(1);
    expect(userLines()).toHaveLength(1);
    expect(store.commsInboxRead("guido-1", notices[0].id)).toBe(false);
    expect(store.getSetting("crew.paused")).toBe(pause);
    await flushInstructionNotices(deps);
    expect(store.commsInbox("guido-1")).toHaveLength(1);
    expect(userLines()).toHaveLength(1);
    store.setSetting("crew.paused", "null"); // Explicit fixture operator unpause, never done by notification.
    await messageUnpausedSeat(store, sup, "guido-1", "Next ordinary authorised turn", {
      interrupt: false,
      questions: "none",
    });
    await until(() => expect(userLines()).toHaveLength(2));
    expect(userLines()[1]).toContain(notices[0].text);
    expect(userLines()[1]).toContain(
      source === "saved instruction" ? "Saved while paused" : '"focus":"label:legacy"',
    );
    expect(store.commsInboxRead("guido-1", notices[0].id)).toBe(true);
    expect(store.commsInbox("guido-1")).toHaveLength(1);
  },
);

it("rechecks a new operator pause inside the real delivery queue after notification was allowed", async () => {
  const { commsInboxContext } = await import("../src/comms.ts");
  const { announceInstruction } = await import("../src/instruction-notices.ts");
  const { bus } = await import("./supervisor-harness.ts");
  const { sup, cfg } = make({ inbox: (seatId, runId) => commsInboxContext(store, seatId, runId) });
  sup.start();
  await sup.startRun("guido-1", 42);
  await until(() => expect(seatState("guido-1")).toBe("idle"));
  let entered = () => {};
  const admitted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const supervisor = {
    seatFacts: sup.seatFacts,
    message: async (...args: Parameters<typeof sup.message>) => {
      expect(args[2].enforcePause).toBe(true);
      entered();
      await gate;
      return sup.message(...args);
    },
  };
  const saved = store.instructions.create(
    "guido-1",
    { kind: "text", text: "Race rule" },
    "operator",
    Date.now(),
  );
  const delivery = announceInstruction({ config: cfg, store, bus, supervisor }, saved);
  await admitted;
  const pause = JSON.stringify({
    seats: ["guido-1"],
    reason: "Pause before queued write",
    at: Date.now(),
    by: "operator",
  });
  store.setSetting("crew.paused", pause);
  release();
  expect((await delivery).delivery).toBe("inbox");
  expect(userLines()).toHaveLength(1);
  const notice = store.commsInbox("guido-1")[0];
  expect(store.commsInboxRead("guido-1", notice.id)).toBe(false);
  expect(store.getSetting("crew.paused")).toBe(pause);
});

it.each([true, false])(
  "uses only the current run's recorded pause exception for immediate notification (%s)",
  async (matching) => {
    const { commsInboxContext } = await import("../src/comms.ts");
    const { announceInstruction } = await import("../src/instruction-notices.ts");
    const { bus } = await import("./supervisor-harness.ts");
    const { sup, cfg } = make({
      inbox: (seatId, runId) => commsInboxContext(store, seatId, runId),
    });
    sup.start();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(seatState("guido-1")).toBe("idle"));
    const pause = JSON.stringify({
      seats: ["guido-1"],
      reason: "Operator hold with scoped exception",
      at: Date.now(),
      by: "operator",
      except: [
        {
          seat: "guido-1",
          runId: matching ? runId : "another-run",
          by: "controller",
          at: Date.now(),
          reason: "Only this recorded run may continue",
        },
      ],
    });
    store.setSetting("crew.paused", pause);
    const saved = store.instructions.create(
      "guido-1",
      { kind: "text", text: "Scoped exception rule" },
      "operator",
      Date.now(),
    );
    const result = await announceInstruction({ config: cfg, store, bus, supervisor: sup }, saved);
    expect(result.delivery).toBe(matching ? "notified" : "inbox");
    if (matching) await until(() => expect(userLines()).toHaveLength(2));
    else expect(userLines()).toHaveLength(1);
    const notice = store.commsInbox("guido-1")[0];
    expect(store.commsInboxRead("guido-1", notice.id)).toBe(matching);
    expect(store.getSetting("crew.paused")).toBe(pause);
  },
);

it.each(["watch", "writer"])(
  "audits the final %s envelope when guidance changes after the pre-spawn audit",
  async (kind) => {
    direction();
    const { sup } = make({ extraSeat: flight });
    const seatId = kind === "watch" ? flight.id : "guido-1";
    const save = store.setRunPromptVersion.bind(store);
    const versions = vi.spyOn(store, "setRunPromptVersion").mockImplementation((...args) => {
      save(...args);
      if (versions.mock.calls.length === 1)
        store.instructions.create(
          seatId,
          { kind: "text", text: "Guidance changed after preparation" },
          "operator",
          Date.now(),
        );
    });
    sup.start();
    const { runId } =
      kind === "watch" ? await sup.startWatch(seatId) : await sup.startRun(seatId, 42);
    await until(() => expect(userLines()).toHaveLength(1));
    const initial = userLines()[0] as string;
    expect(initial).toContain("Guidance changed after preparation");
    const instructions = readFileSync(crewPromptPath(dbPath, runId), "utf8");
    const expectedHash = createHash("sha256")
      .update(["developer-instructions", instructions, "first-brief", initial].join("\0"))
      .digest("hex");
    expect(store.run(runId)?.promptHash).toBe(expectedHash);
    expect(versions.mock.calls).toHaveLength(2);
    expect(versions.mock.calls[0][1]).not.toBe(expectedHash);
    expect(versions.mock.calls[1][4]).toBe(versions.mock.calls[0][1]);
    expect(() =>
      store.setRunPromptVersion(
        runId,
        "late-replacement",
        "roles/late.md",
        Date.now(),
        expectedHash,
      ),
    ).toThrow("Prepared prompt identity changed before delivery");
    expect(store.run(runId)?.promptHash).toBe(expectedHash);
    expect(store.promptWakes(runId)[0].sections.reduce((n, section) => n + section.bytes, 0)).toBe(
      Buffer.byteLength(instructions + initial),
    );
  },
);

it.each(["watch", "writer"])(
  "refuses the first %s turn when final prompt audit storage fails",
  async (kind) => {
    direction();
    const { sup } = make({ extraSeat: flight });
    const seatId = kind === "watch" ? flight.id : "guido-1";
    const save = store.setRunPromptVersion.bind(store);
    vi.spyOn(store, "setRunPromptVersion").mockImplementation((...args) => {
      if (args[4] !== undefined) throw new Error("final audit unavailable");
      save(...args);
    });
    sup.start();
    const error = await refusal(
      kind === "watch" ? sup.startWatch(seatId) : sup.startRun(seatId, 42),
    );
    expect(error.status).toBe(500);
    expect(error.message).toContain("prompt audit storage");
    expect(recorded().some((line) => Array.isArray(line.argv))).toBe(true);
    expect(userLines()).toEqual([]);
    const run = store.runs(seatId, 1)[0];
    expect(run.status).toBe("failed");
    expect(run.endedAt).not.toBeNull();
    expect(store.getSetting(`instruction.delivered:${run.id}`)).toBeNull();
    expect(store.promptWakes(run.id)).toEqual([]);
  },
);

it("refuses an unexpected prompt identity change instead of overwriting another prepared version", async () => {
  direction();
  const { sup } = make({ extraSeat: flight });
  const save = store.setRunPromptVersion.bind(store);
  vi.spyOn(store, "setRunPromptVersion").mockImplementation((...args) => {
    save(...args);
    if (args[4] === undefined)
      save(args[0], "changed-by-another-writer", args[2], args[3], args[1]);
  });
  sup.start();
  const error = await refusal(sup.startWatch(flight.id));
  expect(error.status).toBe(500);
  expect(userLines()).toEqual([]);
  const run = store.runs(flight.id, 1)[0];
  expect(run.promptHash).toBe("changed-by-another-writer");
  expect(run.status).toBe("failed");
});
