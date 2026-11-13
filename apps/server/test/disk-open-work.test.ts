import type { QaReport } from "@mc/core";
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

it("keeps only the QA images that a report of an open PR cites", () => {
  const store = new Store(":memory:");
  store.upsertPullRequests(
    "mc",
    [
      prView({ repoId: "mc", number: 5, state: "open" }),
      prView({ repoId: "mc", number: 6, state: "merged" }),
    ],
    NOW,
  );
  const report = (id: string, pr: number, image: string): QaReport =>
    ({
      id,
      repoId: "mc",
      prNumber: pr,
      headSha: "a".repeat(40),
      registeredAt: NOW,
      before: { url: `/api/qa-report-assets/${image}`, sha256: image },
    }) as unknown as QaReport;
  store.putQaReport(report("r5", 5, "a".repeat(64)));
  store.putQaReport(report("r6", 6, "b".repeat(64)));
  expect([...store.qaAssetIdsOfOpenPrs()]).toEqual(["a".repeat(64)]);
});

it("keeps only the Needs-you pictures that a waiting question's packet cites", () => {
  const store = new Store(":memory:");
  const open = "a".repeat(64);
  const answered = "b".repeat(64);
  const packet = (id: string, itemKey: string, image: string) => ({
    id,
    itemKey,
    images: [{ id: image, url: `/api/attention-material-assets/${image}` }],
  });
  store.putAttentionMaterials(packet("p1", "question:1", open) as never);
  store.putAttentionMaterials(packet("p2", "question:2", answered) as never);
  expect([...store.attentionMaterialAssetIds(new Set(["question:1"]))]).toEqual([open]);
});
