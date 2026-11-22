import { describe, expect, it, vi } from "vitest";
import { LOG_REDACT } from "../src/api.ts";
import type { GhRunner } from "../src/mcp/gh.ts";
import { PreviewManager } from "../src/preview/previews.ts";
import { trustedPullRequest } from "../src/preview/trust.ts";
import { Store } from "../src/store.ts";

const SHA = "a".repeat(40);
const REPO = "owner/repo";
const NOW = Date.parse("2026-11-22T12:00:00Z");

function ghFor(pull: object, permission: string): GhRunner & ReturnType<typeof vi.fn> {
  return vi.fn(async (args: string[]) => ({
    code: 0,
    stderr: "",
    stdout: args.some((a) => a.includes("/permission"))
      ? JSON.stringify({ permission })
      : JSON.stringify(pull),
  })) as never;
}
const pull = (over: object = {}) => ({
  state: "open",
  head: { sha: SHA, repo: { full_name: REPO } },
  user: { login: "someone" },
  ...over,
});
const check = (gh: GhRunner) =>
  trustedPullRequest(new Store(":memory:"), gh, "/repo", REPO, 7, SHA, NOW);

describe("trustedPullRequest", () => {
  it("accepts an open same-repo PR from a collaborator", async () => {
    expect(await check(ghFor(pull(), "write"))).toBe(true);
  });
  it("reads the permission again, so a revoked collaborator is refused at once", async () => {
    const store = new Store(":memory:");
    expect(
      await trustedPullRequest(store, ghFor(pull(), "write"), "/repo", REPO, 7, SHA, NOW),
    ).toBe(true);
    const revoked = ghFor(pull(), "read");
    expect(await trustedPullRequest(store, revoked, "/repo", REPO, 7, SHA, NOW + 1000)).toBe(false);
    const manager = new PreviewManager({
      exists: () => false,
      capacity: () => ({ blocked: false, reason: null }),
      trusted: ({ pr, sha }) =>
        trustedPullRequest(store, revoked, "/repo", REPO, pr, sha, NOW + 2000),
      start: vi.fn(async () => ({ stop: () => {} })),
      remove: async () => {},
    });
    await expect(
      manager.start({ pr: 7, branch: "b", checkout: "/repo", sha: SHA }),
    ).rejects.toMatchObject({
      code: "untrusted",
    });
  });
  it("refuses a fork, even from a collaborator", async () => {
    const fork = pull({ head: { sha: SHA, repo: { full_name: "stranger/repo" } } });
    expect(await check(ghFor(fork, "admin"))).toBe(false);
  });
  it("refuses a deleted fork", async () => {
    expect(await check(ghFor(pull({ head: { sha: SHA, repo: null } }), "admin"))).toBe(false);
  });
  it("refuses a non-collaborator author", async () => {
    expect(await check(ghFor(pull(), "read"))).toBe(false);
  });
  it("refuses a head that moved, a closed PR and a failed read", async () => {
    expect(
      await check(
        ghFor(pull({ head: { sha: "b".repeat(40), repo: { full_name: REPO } } }), "write"),
      ),
    ).toBe(false);
    expect(await check(ghFor(pull({ state: "closed" }), "write"))).toBe(false);
    expect(await check((async () => ({ code: 1, stdout: "", stderr: "x" })) as GhRunner)).toBe(
      false,
    );
  });
});

describe("PreviewManager trust", () => {
  const manager = (trusted: boolean, start = vi.fn(async () => ({ stop: () => {} }))) => ({
    start,
    manager: new PreviewManager({
      exists: () => false,
      capacity: () => ({ blocked: false, reason: null }),
      trusted: async () => trusted,
      start,
      remove: async () => {},
    }),
  });
  it("refuses an untrusted PR before building anything", async () => {
    const { start, manager: m } = manager(false);
    await expect(
      m.start({ pr: 7, branch: "b", checkout: "/repo", sha: SHA }),
    ).rejects.toMatchObject({
      code: "untrusted",
    });
    expect(start).not.toHaveBeenCalled();
  });
  it("starts a trusted PR", async () => {
    const { manager: m } = manager(true);
    await expect(
      m.start({ pr: 7, branch: "b", checkout: "/repo", sha: SHA }),
    ).resolves.toMatchObject({ pr: 7 });
  });
});

describe("request log", () => {
  it("hides every crew credential header", () => {
    for (const h of [
      "x-mc-operator",
      "x-mc-controller",
      "x-mc-preview-activity",
      "x-mc-hud-renderer",
    ]) {
      expect(LOG_REDACT.paths).toContain(`req.headers["${h}"]`);
    }
  });
});
