import { expect, it } from "vitest";
import { prView } from "../../web/test/fixtures.ts";
import { Store } from "../src/store.ts";

const NOW = 1_700_000_000_000;

it("names the open PRs, and the QA images and review shots that open PRs still need", () => {
  const store = new Store(":memory:");
  store.upsertPullRequests(
    "mc",
    [
      prView({ repoId: "mc", number: 5, state: "open" }),
      prView({ repoId: "mc", number: 6, state: "merged" }),
    ],
    NOW,
  );
  expect([...store.openPrKeys()]).toEqual(["mc#5"]);

  const review = (pr: number) =>
    store.requestReview({
      authorRunId: `author:${pr}`,
      repoId: "mc",
      seatId: "retro",
      prNumber: pr,
      sha: "a".repeat(40),
      epoch: 0,
      attempt: 1,
      round: 1,
      at: NOW,
    }) as number;
  store.addReviewShot(review(5), { shotId: "s5", label: "x", width: 1, theme: "dark" }, NOW);
  store.addReviewShot(review(6), { shotId: "s6", label: "x", width: 1, theme: "dark" }, NOW);
  expect([...store.reviewShotIdsOfOpenPrs()]).toEqual(["s5"]);
});
