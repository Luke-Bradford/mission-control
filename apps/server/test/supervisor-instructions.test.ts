// All process boundaries use the repository's fake CLI/keeper fixture, never a paid provider.
import "./supervisor-harness.ts";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { directionKey, readDirectionContext } from "../src/runtime/instruction-context.ts";
import { crewPromptPath } from "../src/store.ts";
import {
  clone,
  dbPath,
  git,
  make,
  noKeepers,
  prep,
  seatState,
  store,
  until,
  userLines,
} from "./supervisor-harness.ts";

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
    const session = cfg.crew!.sessions[0];
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
  const configured = cfg.crew!.sessions[0];
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
