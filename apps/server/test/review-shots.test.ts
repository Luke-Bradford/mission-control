import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPERATOR_HEADER, type QaFindingsView } from "@mc/core";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { hudShotStore } from "../src/flight/hud-store.ts";
import { Store } from "../src/store.ts";

const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};
const NOW = Date.now();

function setup() {
  const store = new Store(":memory:");
  const reviewShots = hudShotStore(join(mkdtempSync(join(tmpdir(), "review-shots-")), "shots"));
  const app = buildApp({
    config,
    store,
    bus: new ChangeBus(),
    reviewShots,
    operatorToken: "tok",
  });
  const reviewWith = (pr: number, shots: { label: string; width: number }[]) => {
    const id = store.requestReview({
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
    store.setReviewState(id, ["queued"], "running", { at: NOW, runId: `retro:${pr}` });
    const ids = shots.map((s) => {
      const shotId = reviewShots.save(Buffer.from(`PNG ${s.label}`));
      store.addReviewShot(id, { shotId, label: s.label, width: s.width, theme: "dark" }, NOW + 1);
      return shotId;
    });
    store.recordFindings(id, `retro:${pr}`, {
      verdict: { spec: "pass", quality: "pass" },
      summary: "Clean",
      findings: [],
      at: NOW + 2,
    });
    return { id, ids };
  };
  return { app, store, reviewShots, reviewWith };
}

describe("review screenshots on /api/qa", () => {
  it("lists a review's screenshots with the review", async () => {
    const { app, reviewWith } = setup();
    const { id, ids } = reviewWith(9, [
      { label: "wide", width: 1920 },
      { label: "narrow", width: 1280 },
    ]);
    const empty = reviewWith(10, []);
    const res = await app.inject({
      url: "/api/qa/findings",
      headers: { [OPERATOR_HEADER]: "tok" },
    });
    const view = res.json() as QaFindingsView;
    const review = view.reviews.find((r) => r.reviewId === id);
    expect(review?.screenshots).toEqual([
      { id: ids[0], label: "wide", width: 1920, theme: "dark", at: NOW + 1 },
      { id: ids[1], label: "narrow", width: 1280, theme: "dark", at: NOW + 1 },
    ]);
    expect(view.reviews.find((r) => r.reviewId === empty.id)?.screenshots).toEqual([]);
  });

  it("serves a stored screenshot to the operator only, and 404s a bad id", async () => {
    const { app, reviewWith } = setup();
    const { ids } = reviewWith(9, [{ label: "wide", width: 1920 }]);
    const ok = await app.inject({
      url: `/api/qa/review-shots/${ids[0]}`,
      headers: { [OPERATOR_HEADER]: "tok" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(ok.body).toBe("PNG wide");
    expect((await app.inject({ url: `/api/qa/review-shots/${ids[0]}` })).statusCode).toBe(401);
    for (const id of ["0".repeat(32), "short", "..%2f..%2fetc%2fpasswd"]) {
      const res = await app.inject({
        url: `/api/qa/review-shots/${id}`,
        headers: { [OPERATOR_HEADER]: "tok" },
      });
      expect(res.statusCode, id).toBe(404);
    }
  });
});
