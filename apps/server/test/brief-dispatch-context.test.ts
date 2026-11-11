import { expect, it } from "vitest";
import {
  boundBriefIdentity,
  checkBriefDispatch,
  withinBriefDispatch,
  withoutBriefDispatch,
} from "../src/brief/dispatch-context.ts";

it("does not leak a completed choice guard into a later background callback", async () => {
  let current = true,
    checks = 0,
    error: unknown;
  let finished!: () => void;
  const later = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await withinBriefDispatch(
    () => {
      checks++;
      if (!current) throw new Error("Old source");
    },
    async () => {
      setImmediate(() => {
        try {
          checkBriefDispatch();
        } catch (caught) {
          error = caught;
        } finally {
          finished();
        }
      });
    },
  );
  current = false;
  await later;
  expect(error).toBeUndefined();
  expect(checks).toBe(0);
});
it("ends the old choice binding once its explicit effect has committed", async () => {
  let checks = 0;
  await withinBriefDispatch(
    () => {
      checks++;
    },
    async () => {
      checkBriefDispatch();
      expect(boundBriefIdentity()).toBe("fixture-epoch");
      await withoutBriefDispatch(async () => {
        checkBriefDispatch();
        expect(boundBriefIdentity()).toBeUndefined();
      });
      checkBriefDispatch();
      expect(boundBriefIdentity()).toBeUndefined();
    },
    "fixture-epoch",
  );
  expect(checks).toBe(1);
});
