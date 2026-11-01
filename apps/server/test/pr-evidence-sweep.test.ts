import type { EvidenceManifest, PullRequestView } from "@mc/core";
import { describe, expect, it, vi } from "vitest";
import type { EvidenceTarget } from "../src/pr-evidence/capture.ts";
import {
  createEvidenceSweep,
  postPrEvidence,
  trustedEvidenceHead,
} from "../src/pr-evidence/sweep.ts";
import { Store } from "../src/store.ts";

const SHA = "a".repeat(40);
const pr = (number = 7): PullRequestView => ({
  repoId: "mc",
  number,
  title: "HUD",
  url: "http://github/pr",
  branch: "feature/hud",
  ticket: null,
  state: "open",
  isDraft: true,
  review: null,
  ci: null,
  createdAt: 1,
  updatedAt: 1,
  mergedAt: null,
  headSha: SHA,
  mergeable: null,
  changedFiles: 1,
  files: [{ path: "apps/web/src/board/Card.tsx", changeType: "MODIFIED" }],
});
const manifest: EvidenceManifest = {
  repoId: "mc",
  pr: 7,
  sha: SHA,
  mainSha: "b".repeat(40),
  capturedAt: 1,
  pairs: [],
};
const result = (value: unknown) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
describe("open PR evidence sweep", () => {
  it("captures a trusted controller PR without a crew run and skips forks", async () => {
    const store = new Store(":memory:");
    store.upsertPullRequests("mc", [pr(), pr(8)], 1);
    const ensure = vi.fn(async (_target: EvidenceTarget) => {});
    const sweep = createEvidenceSweep({
      store,
      repoId: "mc",
      evidence: { baseUrl: "http://localhost", ensure, gate: () => null, stop: async () => {} },
      trusted: async (p) => p.number === 7,
      post: async () => {},
      log: () => {},
    });
    await sweep.tick();
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(ensure.mock.calls[0]?.[0]).toMatchObject({
      pr: 7,
      sha: SHA,
      paths: ["apps/web/src/board/Card.tsx"],
    });
    sweep.stop();
    await sweep.tick();
    expect(ensure).toHaveBeenCalledTimes(1);
    store.close();
  });
  it("requires a fresh same-repository head before executing PR code", async () => {
    for (const [head, expected] of [
      [{ sha: SHA, repo: { full_name: "Owner/Repo" } }, true],
      [{ sha: SHA, repo: { full_name: "attacker/fork" } }, false],
      [{ sha: "b".repeat(40), repo: { full_name: "Owner/Repo" } }, false],
      [{ sha: SHA, repo: null }, false],
    ] as const)
      expect(
        await trustedEvidenceHead(
          async () => result({ state: "open", head }),
          "/hub",
          "owner/repo",
          pr(),
        ),
      ).toBe(expected);
  });
  it("posts links while keeping the rest of the body, and refuses a stale head", async () => {
    const writes: string[] = [];
    const body = "## What changed\nKeep this.\n\n## Minor findings\nKeep these too.\n\nCloses #7.";
    await postPrEvidence(
      async (args, options) => {
        if (args.includes("PATCH")) writes.push(options.input ?? "");
        return result({ state: "open", head: { sha: SHA }, body });
      },
      "/hub",
      "owner/repo",
      manifest,
      "http://localhost",
    );
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0] ?? "{}").body).toContain("## Screenshot evidence");
    expect(JSON.parse(writes[0] ?? "{}").body).toContain("Keep these too.");
    await expect(
      postPrEvidence(
        async () => result({ state: "open", head: { sha: "b".repeat(40) }, body }),
        "/hub",
        "owner/repo",
        manifest,
        "http://localhost",
      ),
    ).rejects.toThrow("head changed");
  });
});
