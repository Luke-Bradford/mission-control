import "./supervisor-harness.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { CliHold } from "../src/cli-update.ts";
import { TestLock } from "../src/guard/lock.ts";
import { crewCodexDir } from "../src/store.ts";
import { codexSupervisor } from "./codex-supervisor-harness.ts";
import {
  dbPath,
  dir,
  make,
  noKeepers,
  prep,
  recorded,
  store,
  until,
} from "./supervisor-harness.ts";

function setup(scenario: Record<string, unknown> = {}) {
  const made = codexSupervisor(scenario);
  const source = join(dir, "source");
  const destination = join(dir, "destination");
  for (const [path, login] of [
    [source, "fictional-source"],
    [destination, "fictional-destination"],
  ] as const) {
    mkdirSync(path);
    writeFileSync(join(path, "auth.json"), JSON.stringify({ tokens: { account_id: login } }));
  }
  const sourceAccount = made.cfg.accounts[0];
  if (!sourceAccount) throw new Error("missing source account");
  sourceAccount.cliProfile = source;
  made.cfg.accounts.push({
    id: "destination",
    vendor: "codex",
    cliProfile: destination,
    alertAt: 80,
    stopAt: 95,
  });
  made.sup.start();
  return { ...made, source, destination };
}

it("resumes on an independent destination binding and keeps the run and checkout", async () => {
  const { sup } = setup();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  const row = store.seatSession("guido-1");
  expect(await sup.transferAccount("guido-1", "destination")).toEqual({ outcome: "resumed" });
  expect(store.seatSession("guido-1")?.worktree).toBe(row?.worktree);
  expect(store.seatSession("guido-1")?.runId).toBe(runId);
  expect(store.run(runId)?.endedAt).toBeNull();
  expect(
    JSON.parse(readFileSync(join(crewCodexDir(dbPath, runId), "codex-home/auth.json"), "utf8"))
      .tokens.account_id,
  ).toBe("fictional-destination");
  expect(recorded().some((r) => r.method === "thread/resume")).toBe(true);
});

it("starts fresh with a handoff if destination resume is refused", async () => {
  const { sup } = setup({ refuseResume: true });
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  expect(await sup.transferAccount("guido-1", "destination")).toEqual({ outcome: "fresh" });
  await until(() =>
    expect(
      recorded()
        .filter((r) => r.method === "turn/start")
        .some((r) => r.params.input[0].text.includes("Account transfer handoff")),
    ).toBe(true),
  );
  expect(store.run(runId)?.endedAt).toBeNull();
});

it("refuses missing runs, different providers, aliases and unsupported isolation without ending the CLI", async () => {
  const { sup, cfg, source, destination } = setup();
  expect(await sup.transferAccount("guido-1", "destination")).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("run"),
  });
  await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  cfg.accounts.push({ id: "other-provider", vendor: "claude", alertAt: 80, stopAt: 95 });
  expect(await sup.transferAccount("guido-1", "other-provider")).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("provider"),
  });
  const target = cfg.accounts[1];
  if (!target) throw new Error("missing destination account");
  target.cliProfile = source;
  expect(await sup.transferAccount("guido-1", "destination")).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("same CLI profile"),
  });
  target.cliProfile = destination;
  writeFileSync(
    join(destination, "auth.json"),
    JSON.stringify({ tokens: { account_id: "fictional-source" } }),
  );
  expect(await sup.transferAccount("guido-1", "destination")).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("same Codex login"),
  });
  expect(recorded().filter((r) => r.type === "spawn")).toHaveLength(1);
});

it("keeps another seat on its shared source binding and sends queued input once", async () => {
  const { sup, cfg } = setup();
  const mate = cfg.crew?.sessions[0]?.seats.find((s) => s.id === "fao-1");
  if (!mate) throw new Error("missing mate");
  mate.model = "gpt-5.4";
  const first = await sup.startRun("guido-1", 42);
  const second = await sup.startRun("fao-1", 43);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  await until(() => expect(store.seatSession("fao-1")?.state).toBe("idle"));
  writeFileSync(
    join(crewCodexDir(dbPath, first.runId), "outbox.json"),
    JSON.stringify([["fictional-pending", "queued before transfer"]]),
  );
  const moving = sup.transferAccount("guido-1", "destination");
  const message = sup.message("guido-1", "fictional queued input", { interrupt: false });
  expect(await moving).toEqual({ outcome: "resumed" });
  await message;
  await until(() =>
    expect(
      recorded().filter(
        (r) =>
          ["turn/start", "turn/steer"].includes(r.method) &&
          r.params.input[0].text === "fictional queued input",
      ),
    ).toHaveLength(1),
  );
  await until(() =>
    expect(
      recorded().filter(
        (r) =>
          ["turn/start", "turn/steer"].includes(r.method) &&
          r.params.input[0].text === "queued before transfer",
      ),
    ).toHaveLength(1),
  );
  await sup.message("fao-1", "source seat continues", { interrupt: false });
  for (const text of ["queued before transfer", "fictional queued input"]) {
    expect(
      recorded().filter(
        (r) => ["turn/start", "turn/steer"].includes(r.method) && r.params.input[0].text === text,
      ),
    ).toHaveLength(1);
  }
  expect(recorded().filter((r) => r.type === "spawn")).toHaveLength(3);
  expect(store.run(second.runId)?.endedAt).toBeNull();
  expect(store.seatSession("fao-1")?.runId).toBe(second.runId);
  expect(
    JSON.parse(
      readFileSync(join(crewCodexDir(dbPath, second.runId), "codex-home/auth.json"), "utf8"),
    ).tokens.account_id,
  ).toBe("fictional-source");
  expect(store.run(first.runId)?.endedAt).toBeNull();
});

it("recovers the source session if both destination attempts fail", async () => {
  const { sup, destination } = setup({ failDestination: true });
  await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  expect(await sup.transferAccount("guido-1", "destination")).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("source"),
  });
  expect(store.seatSession("guido-1")?.state).toBe("idle");
  expect(readFileSync(join(destination, "auth.json"), "utf8")).toContain("fictional-destination");
  await sup.message("guido-1", "after recovery", { interrupt: false });
});

it("recovers a pending transfer after hub restart with its original checkout and run", async () => {
  const { sup, cfg } = setup();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  const outbox = join(crewCodexDir(dbPath, runId), "outbox.json");
  writeFileSync(outbox, JSON.stringify([["fictional-restart", "pending across restart"]]));
  let release!: () => void;
  prep.resumeGate = new Promise<void>((r) => {
    release = r;
  });
  const moving = sup.transferAccount("guido-1", "destination");
  await until(() =>
    expect(store.getSetting(`account-transfer:${runId}`)).toContain('"pending":true'),
  );
  await sup.stopAll();
  // Simulate the source persisting its stale queue before the interrupted transfer restarts.
  writeFileSync(outbox, "[]");
  release();
  await moving;
  prep.resumeGate = null;
  const next = make({ codexCommand: join(dir, "codex") });
  Object.assign(next.cfg, cfg);
  next.sup.start();
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  await until(() =>
    expect(store.getSetting(`account-transfer:${runId}`)).toContain('"pending":false'),
  );
  await until(() =>
    expect(
      recorded().filter(
        (r) =>
          ["turn/start", "turn/steer"].includes(r.method) &&
          r.params.input[0].text === "pending across restart",
      ),
    ).toHaveLength(1),
  );
  expect(store.run(runId)?.endedAt).toBeNull();
  expect(
    JSON.parse(readFileSync(join(crewCodexDir(dbPath, runId), "codex-home/auth.json"), "utf8"))
      .tokens.account_id,
  ).toBe("fictional-destination");
});

it("refuses a launch with two labels for Claude's shared machine login", async () => {
  const { sup, cfg } = make();
  cfg.accounts.push({ id: "claude-other", vendor: "claude", alertAt: 80, stopAt: 95 });
  sup.start();
  await expect(sup.startRun("guido-1", 42)).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining("same CLI profile"),
  });
  expect(recorded().filter((r) => Array.isArray(r.argv))).toHaveLength(0);
});

it("refuses a launch after an external sign-in reuses another Codex login", async () => {
  const { sup, destination } = setup();
  writeFileSync(
    join(destination, "auth.json"),
    JSON.stringify({ tokens: { account_id: "fictional-source" } }),
  );

  await expect(sup.startRun("guido-1", 42)).rejects.toMatchObject({
    status: 409,
    message: expect.stringContaining("same Codex login"),
  });
  expect(recorded().filter((r) => r.type === "spawn")).toHaveLength(0);
});

it("retains pending input if a late source receipt rewrites the outbox during transfer", async () => {
  const { sup } = setup();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  const outbox = join(crewCodexDir(dbPath, runId), "outbox.json");
  writeFileSync(outbox, JSON.stringify([["fictional-pending", "pending through shutdown"]]));
  let release!: () => void;
  prep.resumeGate = new Promise<void>((r) => {
    release = r;
  });
  const moving = sup.transferAccount("guido-1", "destination");
  try {
    await until(() =>
      expect(JSON.parse(store.getSetting(`account-transfer:${runId}`) ?? "{}").queued).toEqual([
        ["fictional-pending", "pending through shutdown"],
      ]),
    );
    // A source driver can persist its older in-memory outbox while shutting down.
    writeFileSync(outbox, "[]");
  } finally {
    release();
    prep.resumeGate = null;
  }
  expect(await moving).toEqual({ outcome: "resumed" });
  await until(() =>
    expect(
      recorded().filter(
        (r) =>
          ["turn/start", "turn/steer"].includes(r.method) &&
          r.params.input[0].text === "pending through shutdown",
      ),
    ).toHaveLength(1),
  );
});

it("honours an engine end requested during transfer after the transfer finishes", async () => {
  const { sup } = setup();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  let release!: () => void;
  prep.resumeGate = new Promise<void>((r) => {
    release = r;
  });
  const moving = sup.transferAccount("guido-1", "destination");
  const ending = sup.endRunByEngine(runId);
  try {
    expect(store.run(runId)?.endedAt).toBeNull();
  } finally {
    release();
    prep.resumeGate = null;
  }
  await moving;
  await ending;
  expect(store.run(runId)?.endedBy).toBe("engine");
  expect(store.seatSession("guido-1")).toMatchObject({ state: "idle", runId: null });
});

it("holds a pending transfer on restart until the CLI smoke-test hold is released", async () => {
  const { sup, cfg } = setup();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  const checkout = store.seatSession("guido-1")?.worktree;
  await sup.stopAll();
  const pending = JSON.stringify({
    source: cfg.accounts[0]?.id,
    target: "destination",
    pending: true,
  });
  store.setSetting(`account-transfer:${runId}`, pending);
  const hold = new CliHold();
  hold.hold("fictional smoke-test failure");
  const next = make({ codexCommand: join(dir, "codex"), cliHold: hold });
  Object.assign(next.cfg, cfg);
  next.sup.start();
  await until(() =>
    expect(next.log).toHaveBeenCalledWith("guido-1: resume held: fictional smoke-test failure"),
  );
  expect(recorded().filter((r) => r.type === "spawn")).toHaveLength(1);
  expect(store.getSetting(`account-transfer:${runId}`)).toBe(pending);
  expect(store.run(runId)?.endedAt).toBeNull();
  expect(next.sup.seatFacts("guido-1")).toBeNull();
  hold.release();
  await until(() =>
    expect(store.getSetting(`account-transfer:${runId}`)).toContain('"pending":false'),
  );
  expect(recorded().filter((r) => r.type === "spawn")).toHaveLength(2);
  expect(store.seatSession("guido-1")).toMatchObject({ runId, worktree: checkout });
  expect(store.run(runId)?.endedAt).toBeNull();
});

it("durably continues every transfer without the ordinary restart nudge", async () => {
  const { sup, cfg } = setup();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  let continuations = 0;
  for (const account of ["destination", cfg.accounts[0]?.id ?? "missing-source", "destination"]) {
    expect(await sup.transferAccount("guido-1", account)).toEqual({ outcome: "resumed" });
    expect(sup.seatFacts("guido-1")?.resumedAt).toBeNull();
    continuations++;
    await until(() =>
      expect(
        recorded().filter(
          (r) =>
            r.method === "turn/start" &&
            r.params.input[0].text === "Continue your work after the account transfer.",
        ),
      ).toHaveLength(continuations),
    );
    await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  }
  await until(() =>
    expect(
      recorded().filter(
        (r) =>
          r.method === "turn/start" &&
          r.params.input[0].text === "Continue your work after the account transfer.",
      ),
    ).toHaveLength(3),
  );
  expect(
    JSON.parse(store.getSetting(`account-transfer:${runId}`) ?? "{}").continuationId,
  ).toBeTruthy();
});

it.each([
  ["missing", true],
  ["provider", true],
  ["missing", false],
  ["provider", false],
] as const)(
  "refuses a persisted %s destination before recovery launch (pending: %s)",
  async (kind, pending) => {
    const { sup, cfg } = setup();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
    await sup.stopAll();
    store.setSetting(
      `account-transfer:${runId}`,
      JSON.stringify({
        source: cfg.accounts[0]?.id ?? "missing-source",
        target: "destination",
        pending,
      }),
    );
    if (kind === "missing") cfg.accounts.splice(1, 1);
    else {
      const target = cfg.accounts[1];
      if (!target) throw new Error("missing destination");
      target.vendor = "claude";
    }
    const next = make({ codexCommand: join(dir, "codex") });
    Object.assign(next.cfg, cfg);
    next.sup.start();
    await until(() => expect(store.seatSession("guido-1")?.state).toBe("error"));
    expect(recorded().filter((r) => r.type === "spawn")).toHaveLength(1);
    expect(store.run(runId)?.endedAt).toBeNull();
  },
);

it("releases restored test locks before replacing a pending transfer keeper", async () => {
  const { sup, cfg } = setup();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  await sup.stopAll();
  store.setSetting(
    `account-transfer:${runId}`,
    JSON.stringify({
      source: cfg.accounts[0]?.id ?? "missing-source",
      target: "destination",
      pending: true,
    }),
  );
  const lock = new TestLock({ holds: store });
  await lock.acquire(
    { runId, toolUseId: "fictional-test" },
    "guido-1",
    "pnpm test",
    100,
    new AbortController().signal,
  );
  const next = make({ codexCommand: join(dir, "codex"), lock });
  Object.assign(next.cfg, cfg);
  let release!: () => void;
  prep.resumeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  next.sup.start();
  try {
    await until(() => expect(lock.state().holder).toBeNull());
    expect(recorded().filter((r) => r.type === "spawn")).toHaveLength(1);
  } finally {
    release();
    prep.resumeGate = null;
  }
  await until(() =>
    expect(store.getSetting(`account-transfer:${runId}`)).toContain('"pending":false'),
  );
});

it("rebuilds a preserved process before recovering with configured profile denies", async () => {
  const { sup, cfg } = setup();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  await sup.stopAll();
  // An older keeper has no recorded proof that its policy denies the profiles.
  store.setSetting(`account-profile-denies:${runId}`, "[]");
  const next = make({ codexCommand: join(dir, "codex") });
  Object.assign(next.cfg, cfg);
  next.sup.start();
  await until(() => expect(recorded().filter((r) => r.type === "spawn")).toHaveLength(2));
  expect(store.run(runId)?.endedAt).toBeNull();
});

it.each([true, false])(
  "recovers a legacy machine-login run with its saved provider (keeper survives: %s)",
  async (keeper) => {
    const first = codexSupervisor();
    first.sup.start();
    const { runId } = await first.sup.startRun("guido-1", 42);
    await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
    await first.sup.stopAll();
    if (!keeper) await noKeepers();
    const next = codexSupervisor();
    const account = next.cfg.accounts[0];
    if (!account) throw new Error("missing account");
    account.vendor = "claude";
    next.sup.start();
    await until(() => expect(next.sup.seatFacts("guido-1")).not.toBeNull());
    expect(store.run(runId)).toMatchObject({ vendor: "codex", endedAt: null });
    expect(store.seatSession("guido-1")).toMatchObject({ vendor: "codex", runId });
    if (!keeper)
      await until(() =>
        expect(recorded().find((r) => r.method === "thread/resume")?.params).toMatchObject({
          threadId: "codex-thread-1",
          model: "gpt-5.4",
        }),
      );
    await next.sup.endRunByEngine(runId);
  },
);

it.each([true, false])(
  "rejects a legacy Codex recovery without its saved model after a provider edit (keeper survives: %s)",
  async (keeper) => {
    const first = codexSupervisor();
    first.sup.start();
    const { runId } = await first.sup.startRun("guido-1", 42);
    await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
    await first.sup.stopAll();
    if (!keeper) await noKeepers();
    const run = store.run(runId);
    if (!run) throw new Error("missing run");
    store.upsertRun({ ...run, model: null });
    const next = codexSupervisor();
    const account = next.cfg.accounts[0];
    if (!account) throw new Error("missing account");
    account.vendor = "claude";
    next.sup.start();
    await until(() => expect(store.run(runId)?.endedAt).not.toBeNull());
    if (keeper) expect(store.seatSession("guido-1")?.reason).toContain("saved model missing");
    else expect(next.log).toHaveBeenCalledWith(expect.stringContaining("saved model missing"));
    expect(recorded().some((r) => r.method === "thread/resume")).toBe(false);
    expect(recorded().filter((r) => r.type === "spawn")).toHaveLength(1);
  },
);

it("excludes launches until a profile update commits its in-memory policy", async () => {
  const { sup, cfg } = setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const profile = join(dir, "fictional-new-profile");
  mkdirSync(profile);
  writeFileSync(
    join(profile, "auth.json"),
    JSON.stringify({ tokens: { account_id: "fictional-new" } }),
  );
  const update = sup.withAccountUpdate(async () => {
    await gate;
    cfg.accounts.push({
      id: "fictional-new",
      vendor: "codex",
      cliProfile: profile,
      alertAt: 80,
      stopAt: 95,
    });
  });
  const starting = sup.startRun("guido-1", 42);
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(recorded().filter((r) => r.type === "spawn")).toHaveLength(0);
  } finally {
    release();
  }
  await update;
  const { runId } = await starting;
  expect(JSON.parse(store.getSetting(`account-profile-denies:${runId}`) ?? "[]")).toContain(
    profile,
  );
});

it.each([true, false])(
  "validates unsafe recovery before a CLI hold (pending: %s)",
  async (pending) => {
    const { sup, cfg } = setup();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
    await sup.stopAll();
    store.setSetting(
      `account-transfer:${runId}`,
      JSON.stringify({ source: cfg.accounts[0]?.id, target: "destination", pending }),
    );
    cfg.accounts.splice(1, 1);
    const seat = cfg.crew?.sessions[0]?.seats[0];
    if (!seat) throw new Error("missing seat");
    seat.modelVendor = "codex";
    const hold = new CliHold();
    hold.hold("fictional hold");
    const next = make({ codexCommand: join(dir, "codex"), cliHold: hold });
    Object.assign(next.cfg, cfg);
    next.sup.start();
    await until(() => expect(store.seatSession("guido-1")?.state).toBe("error"));
    expect(next.sup.seatFacts("guido-1")).toBeNull();
    expect(recorded().filter((r) => r.type === "spawn")).toHaveLength(1);
  },
);

it("renews a receipted continuation when pending recovery replaces its keeper", async () => {
  const { sup, cfg } = setup();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  expect(await sup.transferAccount("guido-1", "destination")).toEqual({ outcome: "resumed" });
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  await until(() =>
    expect(
      recorded().filter(
        (r) =>
          r.method === "turn/start" &&
          r.params.input[0].text === "Continue your work after the account transfer.",
      ),
    ).toHaveLength(1),
  );
  await sup.stopAll();
  const key = `account-transfer:${runId}`;
  const transfer = JSON.parse(store.getSetting(key) ?? "{}");
  const oldId = transfer.continuationId;
  const run = store.run(runId);
  if (!run) throw new Error("missing run");
  writeFileSync(
    run.transcriptPath,
    `${readFileSync(run.transcriptPath, "utf8")}\n${JSON.stringify({ type: "mc_codex_delivery", id: oldId })}\n${JSON.stringify({ type: "mc_codex_delivery", id: "fictional-user" })}\n`,
  );
  store.setSetting(
    key,
    JSON.stringify({
      ...transfer,
      pending: true,
      queued: [
        [oldId, "Continue your work after the account transfer."],
        ["fictional-user", "already delivered user input"],
      ],
    }),
  );
  const next = make({ codexCommand: join(dir, "codex") });
  Object.assign(next.cfg, cfg);
  next.sup.start();
  await until(() => expect(JSON.parse(store.getSetting(key) ?? "{}").pending).toBe(false));
  expect(JSON.parse(store.getSetting(key) ?? "{}").continuationId).not.toBe(oldId);
  await until(() =>
    expect(
      recorded().filter(
        (r) =>
          r.method === "turn/start" &&
          r.params.input[0].text === "Continue your work after the account transfer.",
      ),
    ).toHaveLength(2),
  );
  expect(
    recorded().some(
      (r) => r.method === "turn/start" && r.params.input[0].text === "already delivered user input",
    ),
  ).toBe(false);
});

it.each([false, true])(
  "ends a keeper with stale profile denies before discovery or a CLI hold (pending: %s)",
  async (pending) => {
    const { sup, cfg } = setup();
    const { runId } = await sup.startRun("guido-1", 42);
    await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
    await sup.stopAll();
    store.setSetting(`account-profile-denies:${runId}`, "[]");
    const seat = cfg.crew?.sessions[0]?.seats[0];
    if (!seat) throw new Error("missing seat");
    seat.modelVendor = "codex";
    const lock = new TestLock({ holds: store });
    await lock.acquire(
      { runId, toolUseId: "fictional-test" },
      "guido-1",
      "pnpm test",
      100,
      new AbortController().signal,
    );
    const hold = new CliHold();
    if (pending) {
      hold.hold("fictional hold");
      store.setSetting(
        `account-transfer:${runId}`,
        JSON.stringify({ source: cfg.accounts[0]?.id, target: "destination", pending: true }),
      );
    }
    const next = make({ codexCommand: join(dir, "codex"), lock, cliHold: hold });
    Object.assign(next.cfg, cfg);
    next.sup.start();
    await until(() => expect(lock.state().holder).toBeNull());
    expect(next.sup.seatFacts("guido-1")).toBeNull();
    expect(recorded().filter((r) => r.type === "spawn")).toHaveLength(1);
  },
);

it("holds recovery exclusion while stale-policy checkout validation awaits", async () => {
  const { sup, cfg } = setup();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  await sup.stopAll();
  store.setSetting(`account-profile-denies:${runId}`, "[]");
  const next = make({ codexCommand: join(dir, "codex") });
  Object.assign(next.cfg, cfg);
  let release!: () => void;
  prep.resumeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  prep.resumeChecks = 0;
  next.sup.start();
  try {
    await until(() => expect(prep.resumeChecks).toBeGreaterThan(0));
    await until(async () =>
      expect(await next.sup.send(runId, "fictional-probe", "probe")).toBe("busy"),
    );
  } finally {
    release();
    prep.resumeGate = null;
  }
  await until(() => expect(recorded().filter((r) => r.type === "spawn")).toHaveLength(2));
});

it("filters superseded unreceipted continuations after interrupted replacement", async () => {
  const { sup, cfg } = setup();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  await sup.stopAll();
  const key = `account-transfer:${runId}`;
  const queued = [
    ["fictional-old", "Continue your work after the account transfer."],
    ["fictional-user", "preserved user input"],
  ];
  writeFileSync(join(crewCodexDir(dbPath, runId), "outbox.json"), JSON.stringify(queued));
  store.setSetting(
    key,
    JSON.stringify({
      source: cfg.accounts[0]?.id,
      target: "destination",
      pending: true,
      continuationId: "fictional-replacement",
      supersededContinuationIds: ["fictional-old"],
      queued,
    }),
  );
  const next = make({ codexCommand: join(dir, "codex") });
  Object.assign(next.cfg, cfg);
  let release!: () => void;
  prep.resumeGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  next.sup.start();
  try {
    await until(() =>
      expect(JSON.parse(store.getSetting(key) ?? "{}").continuationId).not.toBe(
        "fictional-replacement",
      ),
    );
    const saved = JSON.parse(store.getSetting(key) ?? "{}");
    expect(saved.supersededContinuationIds).toEqual(["fictional-old", "fictional-replacement"]);
    expect(saved.queued).toEqual([["fictional-user", "preserved user input"]]);
  } finally {
    release();
    prep.resumeGate = null;
  }
  await until(() => expect(JSON.parse(store.getSetting(key) ?? "{}").pending).toBe(false));
  await until(() =>
    expect(
      recorded().filter(
        (r) =>
          ["turn/start", "turn/steer"].includes(r.method) &&
          r.params.input[0].text === "preserved user input",
      ),
    ).toHaveLength(1),
  );
  await until(() =>
    expect(
      recorded().filter(
        (r) =>
          ["turn/start", "turn/steer"].includes(r.method) &&
          r.params.input[0].text === "Continue your work after the account transfer.",
      ),
    ).toHaveLength(1),
  );
  expect(JSON.parse(store.getSetting(key) ?? "{}").supersededContinuationIds).toContain(
    "fictional-replacement",
  );
});
