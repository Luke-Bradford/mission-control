import "./supervisor-harness.ts";
import { expect, it } from "vitest";
import { resolvedCommsReason } from "../src/comms.ts";
import { make, noKeepers, store, until } from "./supervisor-harness.ts";

it("records a real confirmed same-run recovery and retires only its earlier blocker", async () => {
  const first = make();
  first.sup.start();
  const { runId } = await first.sup.startRun("guido-1", 42);
  await until(() => expect(store.seatSession("guido-1")?.state).toBe("idle"));
  const before = store.addComms({
    at: Date.now(),
    from: "guido-1",
    to: "CAPCOM",
    ticket: null,
    text: "Blocked before recovery",
    label: "blocker",
  });
  if (!before) throw Error("missing blocker");
  expect(resolvedCommsReason(store, before)).toBeNull();
  await first.sup.stopAll();
  await noKeepers();
  const next = make();
  next.sup.start();
  await until(() => expect(next.sup.sessionAlive("guido-1")).toBe(true));
  await next.sup.message("guido-1", "Continue the work", { interrupt: false });
  await until(() =>
    expect(
      store.loopEventsOfRun(runId).some((e) => e.key.startsWith(`${runId}:resume-confirmed:`)),
    ).toBe(true),
  );
  expect(store.run(runId)?.endedAt).toBeNull();
  expect(resolvedCommsReason(store, before)).toBe("The related run resumed.");
  const later = { ...before, at: Date.now() + 1 };
  expect(resolvedCommsReason(store, later)).toBeNull();
});
