import { expect, it } from "vitest";
import { runFirstClean } from "../src/disk/first-clean.ts";

function setting() {
  let value: string | null = null;
  return {
    get: () => value,
    set: (v: string) => {
      value = v;
    },
  };
}

it("marks the one-off clean done only after a sweep ran to the end, and retries until then", async () => {
  const s = setting();
  const graces: (number | undefined)[] = [];
  let ok = false;
  const sweep = async (grace?: number) => {
    graces.push(grace);
    return ok;
  };
  await runFirstClean(s, sweep, () => 7);
  expect(s.get()).toBeNull();
  ok = true;
  await runFirstClean(s, sweep, () => 7);
  expect(s.get()).toBe("7");
  await runFirstClean(s, sweep, () => 9);
  expect(s.get()).toBe("7");
  expect(graces).toEqual([0, 0, undefined]);
});
