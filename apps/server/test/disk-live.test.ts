import { expect, it } from "vitest";
import { notLivePrKeys } from "../src/disk/live.ts";

const merged = [
  { key: "mc#1", mergeSha: "a".repeat(40) },
  { key: "mc#2", mergeSha: "b".repeat(40) },
  { key: "mc#3", mergeSha: null },
];
const running = "c".repeat(40);

it("holds a merged PR until the running code holds its merge commit", async () => {
  const held = await notLivePrKeys(merged, running, async (sha) => sha === "a".repeat(40));
  expect([...held]).toEqual(["mc#2"]);
});

it("holds nothing when the running code is unknown", async () => {
  expect([...(await notLivePrKeys(merged, null, async () => false))]).toEqual([]);
});
