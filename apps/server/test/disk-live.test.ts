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

it("holds nothing when the running code is unknown", async () => {
  expect([...(await notLivePrKeys("mc", merged, null, async () => new Set()))]).toEqual([]);
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

it("holds nothing when the history cannot be read (no hub checkout)", async () => {
  expect([...(await notLivePrKeys("mc", merged, running, async () => null))]).toEqual([]);
});
