import { describe, expect, it } from "vitest";
import { githubRepoOfUrl } from "../src/links.ts";

describe("githubRepoOfUrl", () => {
  it.each([
    ["https://github.com/octo-org/other/pull/7", "octo-org/other"],
    ["https://github.com/Octo-Org/shop-app/issues/8", "Octo-Org/shop-app"],
  ])("takes the repo of %s", (url, repo) => {
    expect(githubRepoOfUrl(url)).toBe(repo);
  });

  it.each([
    "https://github.com/a/b",
    "https://github.com/a/b/",
    "https://github.com/a/b/pull/x",
    "https://github.com/a/b/pull/1/files",
    "https://github.com/a/b/commit/1",
    "https://github.com:8443/a/b/pull/1",
    "https://github.com:443/a/b/pull/1",
    "https://user@github.com/a/b/pull/1",
    "https://user:pw@github.com/a/b/pull/1",
    "https://github.com/a/../pull/1",
    "https://github.com/a/b/../pull/1",
    "https://github.com/a/b/c/../pull/1",
    "https://github.com/a/b/%2e%2e/pull/1",
    "https://github.com/./b/pull/1",
    "https://github.com/../b/pull/1",
    "http://github.com/a/b/pull/1",
    "https://example.com/a/b/pull/1",
    "javascript:alert(1)",
    "",
  ])("returns null for %j", (url) => {
    expect(githubRepoOfUrl(url)).toBeNull();
  });
});
