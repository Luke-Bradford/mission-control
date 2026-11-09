// Actual keeper/fake CLI boundary only; never a paid provider or live workspace.
import "./supervisor-harness.ts";
import { writeFileSync } from "node:fs";
import { expect, it } from "vitest";
import { checkBriefDispatch, withinBriefDispatch } from "../src/brief-dispatch-context.ts";
import { make, recordFile, seatState, store, until, userLines } from "./supervisor-harness.ts";

it("1389 refuses an expected-run change in the actual queued provider message", async () => {
  const { sup } = make();
  sup.start();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(seatState("guido-1")).toBe("idle"));
  let checks = 0;
  const delivered = sup.message("guido-1", "Never deliver to a replacement run", {
    interrupt: false,
    questions: "none",
    enforcePause: true,
    expectedRunId: runId,
    beforeWrite: () => {
      if (++checks === 1)
        queueMicrotask(() => {
          const row = store.seatSession("guido-1");
          if (!row) throw new Error("Missing seat fixture");
          store.setSeatSession({ ...row, runId: "different-run" });
        });
    },
  });
  await expect(delivered).rejects.toThrow(/changed or ended/);
  expect(checks).toBe(1);
  expect(userLines()).toHaveLength(1);
});
it("1389 invokes the bound source guard again immediately before a real provider write", async () => {
  const { sup } = make();
  sup.start();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(seatState("guido-1")).toBe("idle"));
  let checks = 0;
  const delivered = sup.message("guido-1", "Never deliver a stale choice", {
    interrupt: false,
    questions: "none",
    enforcePause: true,
    expectedRunId: runId,
    beforeWrite: () => {
      checks++;
      if (store.getSetting("fixture:source") === "changed")
        throw new Error("Bound source changed in queue");
      queueMicrotask(() => store.setSetting("fixture:source", "changed"));
    },
  });
  await expect(delivered).rejects.toThrow("Bound source changed in queue");
  expect(checks).toBe(2);
  expect(userLines()).toHaveLength(1);
  await sup.message("guido-1", "Existing direct operator message", {
    interrupt: false,
    questions: "none",
  });
  await until(() => expect(userLines()).toHaveLength(2));
  expect(userLines()[1]).toContain("Existing direct operator message");
});
it("1389 preserves the existing pause check inside the queued message path", async () => {
  const { sup } = make();
  sup.start();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(seatState("guido-1")).toBe("idle"));
  const delivered = sup.message("guido-1", "Never start the paused turn", {
    interrupt: false,
    questions: "none",
    enforcePause: true,
    expectedRunId: runId,
    beforeWrite: () =>
      queueMicrotask(() =>
        store.setSetting(
          "crew.paused",
          JSON.stringify({
            seats: ["guido-1"],
            by: "operator",
            at: Date.now(),
            reason: "Queued pause fixture",
          }),
        ),
      ),
  });
  await expect(delivered).rejects.toThrow(/Paused/);
  expect(userLines()).toHaveLength(1);
});

it("1389 preserves the bound send-back guard in the final real provider queue", async () => {
  const { sup } = make();
  sup.start();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(seatState("guido-1")).toBe("idle"));
  let current = true,
    checks = 0;
  const delivery = withinBriefDispatch(
    () => {
      checks++;
      if (!current) throw new Error("Bound source changed");
    },
    () => {
      checkBriefDispatch();
      const sent = sup.send(
        runId,
        "controller-fail-bound",
        "Stale verdict must never reach provider",
      );
      current = false;
      return sent;
    },
  );
  await expect(delivery).rejects.toThrow("Bound source changed");
  expect(checks).toBe(2);
  expect(userLines()).toHaveLength(1);
});
it("1389 keeps keyed delivery deduplication scoped to the exact bound decision epoch", async () => {
  const { sup } = make();
  sup.start();
  const { runId } = await sup.startRun("guido-1", 42);
  await until(() => expect(seatState("guido-1")).toBe("idle"));
  const initialTurnEnd = store.seatSession("guido-1")?.lastTurnEndedAt ?? 0;
  expect(
    await withinBriefDispatch(
      () => {},
      () => sup.send(runId, "same-controller-line", "QUIET First exact intent"),
      "fixture-epoch-one",
    ),
  ).toBe("sent");
  await until(() => expect(userLines()).toHaveLength(2));
  // The CLI has received the line but has not started it: the old idle state is not completion.
  expect(store.seatSession("guido-1")?.lastTurnEndedAt ?? 0).toBe(initialTurnEnd);
  writeFileSync(`${recordFile}.go`, "release the held fake turn");
  await until(() => {
    expect(store.seatSession("guido-1")?.lastTurnEndedAt ?? 0).toBeGreaterThan(initialTurnEnd);
    expect(seatState("guido-1")).toBe("idle");
  });
  expect(
    await withinBriefDispatch(
      () => {},
      () => sup.send(runId, "same-controller-line", "QUIET First exact intent"),
      "fixture-epoch-one",
    ),
  ).toBe("dup");
  expect(userLines()).toHaveLength(2);
  expect(
    await withinBriefDispatch(
      () => {},
      () => sup.send(runId, "same-controller-line", "A newly inspected different intent"),
      "fixture-epoch-two",
    ),
  ).toBe("sent");
  await until(() => expect(userLines()).toHaveLength(3));
  expect(userLines()[2]).toContain("A newly inspected different intent");
});
