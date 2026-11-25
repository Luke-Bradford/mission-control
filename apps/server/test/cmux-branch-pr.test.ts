import { describe, expect, it, vi } from "vitest";
import { createBranchPrs } from "../src/sessions/pr.ts";

describe("branch pull requests", () => {
  it("uses a configured repository's stored open PR without gh", async () => {
    const gh = vi.fn();
    const prs = createBranchPrs({
      store: {
        openPullRequests: () =>
          [
            {
              branch: "feature/2262-x",
              number: 9,
              url: "https://x",
              isDraft: false,
              ci: "passing" as const,
              review: "approved" as const,
            },
          ] as never[],
      },
      repos: () => [{ id: "repo", github: "acme/app" }],
      gh,
    });
    await expect(prs.prOf("acme/app", "feature/2262-x")).resolves.toMatchObject({
      repoId: "repo",
      pr: { number: 9 },
    });
    expect(gh).not.toHaveBeenCalled();
  });

  it("caches one gh lookup and rejects unsafe branches", async () => {
    const gh = vi.fn(async () => ({
      code: 0,
      stdout:
        '[{"number":2,"url":"https://x","isDraft":false,"reviewDecision":"APPROVED","statusCheckRollup":[]}]',
      stderr: "",
    }));
    const prs = createBranchPrs({ store: { openPullRequests: () => [] }, repos: () => [], gh });
    await prs.prOf("acme/app", "feature/2262-x");
    await prs.prOf("acme/app", "feature/2262-x");
    await prs.prOf("acme/app", "-bad");
    expect(gh).toHaveBeenCalledTimes(1);
  });
});
