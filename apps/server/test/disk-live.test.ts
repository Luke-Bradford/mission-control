import { expect, it, vi } from "vitest";
import { notLivePrKeys } from "../src/disk/live.ts";

const merged = [
  { key: "mc#1", mergeSha: "a".repeat(40) },
  { key: "mc#2", mergeSha: "b".repeat(40) },
  { key: "mc#3", mergeSha: null },
];
const running = "c".repeat(40);

it("holds a merged PR until the running code holds its merge commit", async () => {
  const held = await notLivePrKeys("mc", merged, running, async () => new Set(["a".repeat(40)]));
  expect([...held]).toEqual(["mc#2"]);
});

it("holds every merged PR with a merge commit when the running code is unknown", async () => {
  expect([...(await notLivePrKeys("mc", merged, null, async () => new Set()))]).toEqual([
    "mc#1",
    "mc#2",
  ]);
});

it("does not hold a merged PR of another repo, whose commit the hub checkout cannot know", async () => {
  const held = await notLivePrKeys(
    "mc",
    [...merged, { key: "other#9", mergeSha: "d".repeat(40) }],
    running,
    async () => new Set(),
  );
  expect([...held].sort()).toEqual(["mc#1", "mc#2"]);
});

it("reads the running history once, however many merged PRs there are", async () => {
  const read = vi.fn(async () => new Set(["a".repeat(40)]));
  await notLivePrKeys("mc", merged, running, read);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(running);
});

it("keeps the pictures when the history cannot be read, to try again next sweep", async () => {
  expect([...(await notLivePrKeys("mc", merged, running, async () => null))]).toEqual([
    "mc#1",
    "mc#2",
  ]);
});

it("holds nothing with no hub checkout (no repo id)", async () => {
  expect([...(await notLivePrKeys(undefined, merged, running, async () => null))]).toEqual([]);
});

it("holds an old merge that is still not live", async () => {
  const old = [{ key: "mc#1", mergeSha: "a".repeat(40) }];
  expect([...(await notLivePrKeys("mc", old, running, async () => new Set()))]).toEqual(["mc#1"]);
});
