import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceManifest } from "@mc/core";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { prEvidenceStore } from "../src/pr-evidence/store.ts";
import { Store } from "../src/store.ts";

const config: CcConfig = {
  operator: { id: "operator", timezone: "UTC" },
  accounts: [],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};

const SHA = "a".repeat(40);
const manifest = (repoId = "mc"): EvidenceManifest => ({
  repoId,
  pr: 12,
  sha: SHA,
  mainSha: "b".repeat(40),
  capturedAt: 1,
  pairs: [{ page: "board", scheme: "light", changedPixels: 5, changedPercent: 0.1, regions: [] }],
});

function appWith() {
  const prEvidence = prEvidenceStore(join(mkdtempSync(join(tmpdir(), "ev-route-")), "evidence"));
  prEvidence.save(manifest(), [{ name: "board-light-diff.png", png: Buffer.from("PNGDATA") }]);
  const app = buildApp({ config, store: new Store(":memory:"), bus: new ChangeBus(), prEvidence });
  return { app, prEvidence };
}

describe("GET /api/prs/:n/evidence", () => {
  it("serves the newest head's manifest", async () => {
    const { app } = appWith();
    const res = await app.inject({ url: "/api/prs/12/evidence" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(manifest());
  });

  it("serves one head's manifest by sha, and picks the repo when two have the PR", async () => {
    const { app, prEvidence } = appWith();
    prEvidence.save({ ...manifest("other"), capturedAt: 2 }, []);
    expect((await app.inject({ url: "/api/prs/12/evidence" })).statusCode).toBe(409);
    const one = await app.inject({ url: `/api/prs/12/evidence?repo=other&sha=${SHA}` });
    expect(one.json().repoId).toBe("other");
  });

  it("answers 404 for a PR with no evidence, and 400 for a bad number, repo or sha", async () => {
    const { app } = appWith();
    expect((await app.inject({ url: "/api/prs/13/evidence" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/api/prs/abc/evidence" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/prs/0/evidence" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/prs/12/evidence?sha=zz" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/api/prs/12/evidence?repo=../x" })).statusCode).toBe(400);
    expect(
      (await app.inject({ url: `/api/prs/12/evidence?sha=${"c".repeat(40)}` })).statusCode,
    ).toBe(404);
  });

  it("answers 404 on a hub that stores no evidence", async () => {
    const app = buildApp({ config, store: new Store(":memory:"), bus: new ChangeBus() });
    expect((await app.inject({ url: "/api/prs/12/evidence" })).statusCode).toBe(404);
  });
});

describe("GET /api/prs/:n/evidence/:sha/:name", () => {
  it("serves a stored image as a PNG", async () => {
    const { app } = appWith();
    const res = await app.inject({ url: `/api/prs/12/evidence/${SHA}/board-light-diff.png` });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.body).toBe("PNGDATA");
  });

  it("answers 404 for an unknown sha or image, and for a name that is not an image name", async () => {
    const { app } = appWith();
    for (const url of [
      `/api/prs/12/evidence/${"c".repeat(40)}/board-light-diff.png`,
      `/api/prs/12/evidence/${SHA}/board-dark-diff.png`,
      `/api/prs/12/evidence/${SHA}/manifest.json`,
      `/api/prs/12/evidence/${SHA}/..%2fmanifest.json`,
      `/api/prs/12/evidence/..%2f..%2f/board-light-diff.png`,
    ]) {
      expect((await app.inject({ url })).statusCode, url).toBe(404);
    }
  });
});
