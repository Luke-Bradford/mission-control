import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitPlace } from "../src/sessions/branch.ts";
import { createBranchPrs } from "../src/sessions/pr.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe("branch pull requests", () => {
  it("reads a checkout's branch and GitHub origin without git", async () => {
    const folder = mkdtempSync(join(tmpdir(), "mc-session-branch-"));
    folders.push(folder);
    mkdirSync(join(folder, ".git"));
    writeFileSync(join(folder, ".git", "HEAD"), "ref: refs/heads/feature/2262-cmux-sidebar\n");
    writeFileSync(join(folder, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:Acme/App.git\n');
    await expect(gitPlace(folder)).resolves.toEqual({
      branch: "feature/2262-cmux-sidebar",
      github: "acme/app",
    });
  });

  it("follows a worktree gitdir and returns no branch for detached HEAD", async () => {
    const folder = mkdtempSync(join(tmpdir(), "mc-session-worktree-"));
    folders.push(folder);
    const common = join(folder, "common");
    const worktree = join(folder, "worktree");
    mkdirSync(common);
    mkdirSync(worktree);
    writeFileSync(join(worktree, ".git"), "gitdir: ../gitdir\n");
    mkdirSync(join(folder, "gitdir"));
    writeFileSync(join(folder, "gitdir", "HEAD"), "f00ba4\n");
    writeFileSync(join(folder, "gitdir", "commondir"), "../common\n");
    writeFileSync(join(common, "config"), '[remote "origin"]\n\turl = https://github.com/acme/app.git\n');
    await expect(gitPlace(worktree)).resolves.toEqual({ branch: null, github: "acme/app" });
  });
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

  it("maps pending and failed status rollups", async () => {
    const gh = vi.fn(async () => ({
      code: 0,
      stdout:
        '[{"number":2,"url":"https://x","isDraft":false,"reviewDecision":null,"statusCheckRollup":[{"status":"IN_PROGRESS","conclusion":""}]}]',
      stderr: "",
    }));
    const prs = createBranchPrs({ store: { openPullRequests: () => [] }, repos: () => [], gh });
    await expect(prs.prOf("acme/app", "feature/one")).resolves.toMatchObject({
      pr: { ci: "pending" },
    });
    gh.mockResolvedValueOnce({
      code: 0,
      stdout:
        '[{"number":2,"url":"https://x","isDraft":false,"reviewDecision":null,"statusCheckRollup":[{"state":"FAILURE"}]}]',
      stderr: "",
    });
    await expect(prs.prOf("acme/app", "feature/two")).resolves.toMatchObject({
      pr: { ci: "failing" },
    });
  });
});
