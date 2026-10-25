import "./supervisor-harness.ts";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { crewCodexDir } from "../src/store.ts";
import { codexSupervisor } from "./codex-supervisor-harness.ts";
import { dbPath, dir, make, prep, recorded, store, until } from "./supervisor-harness.ts";

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
        (r) => r.method === "turn/start" && r.params.input[0].text === "fictional queued input",
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
  let release!: () => void;
  prep.resumeGate = new Promise<void>((r) => {
    release = r;
  });
  const moving = sup.transferAccount("guido-1", "destination");
  await until(() =>
    expect(store.getSetting(`account-transfer:${runId}`)).toContain('"pending":true'),
  );
  await sup.stopAll();
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
  expect(store.run(runId)?.endedAt).toBeNull();
  expect(
    JSON.parse(readFileSync(join(crewCodexDir(dbPath, runId), "codex-home/auth.json"), "utf8"))
      .tokens.account_id,
  ).toBe("fictional-destination");
});

it("refuses a provider without independently isolated profiles", async () => {
  const { sup, cfg } = make();
  cfg.accounts.push({ id: "claude-other", vendor: "claude", alertAt: 80, stopAt: 95 });
  sup.start();
  await sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  expect(await sup.transferAccount("guido-1", "claude-other")).toMatchObject({
    outcome: "refused",
    reason: expect.stringContaining("cannot isolate"),
  });
  expect(recorded().filter((r) => Array.isArray(r.argv))).toHaveLength(1);
});
