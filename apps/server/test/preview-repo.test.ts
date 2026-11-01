import "./temp-home.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolvePreviewRepo } from "../src/preview-repo.ts";

let dir: string;
let hub: string;
let crew: string;
const repos = [
  { id: "hub", github: "example/hub" },
  { id: "other", github: "example/other" },
];
const git = (checkout: string, ...args: string[]) => execFileSync("git", ["-C", checkout, ...args]);
const origin = (checkout: string, url: string) => git(checkout, "config", "remote.origin.url", url);
const sessions = () => [{ repoId: "hub", checkout: crew }];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-preview-repo-"));
  hub = join(dir, "hub");
  crew = join(dir, "crew");
  for (const path of [hub, crew]) execFileSync("git", ["init", "-q", path]);
  origin(hub, "https://github.com/example/hub.git");
  origin(crew, "git@github.com:example/hub.git");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the repository allowed to run branch previews", () => {
  it.each([
    "https://github.com/example/hub.git",
    "git@github.com:example/hub.git",
    "ssh://git@github.com/Example/Hub.git",
    "https://github.com/example/hub",
  ])("recognizes a separate crew clone with origin %s", async (remote) => {
    origin(crew, remote);
    expect(hub).not.toBe(crew);
    await expect(resolvePreviewRepo(hub, repos, sessions())).resolves.toBe("hub");
  });

  it("does not select a configured foreign repository", async () => {
    origin(crew, "https://github.com/example/other.git");
    await expect(
      resolvePreviewRepo(hub, repos, [{ repoId: "other", checkout: crew }]),
    ).resolves.toBeUndefined();
  });

  it("refuses a crew checkout whose origin does not match its configured repository", async () => {
    origin(crew, "https://github.com/foreign/hub.git");
    await expect(resolvePreviewRepo(hub, repos, sessions())).resolves.toBeUndefined();
  });

  it.each([
    "https://example.com/example/hub.git",
    "https://github.com.evil.test/example/hub.git",
    "file:///repos/hub.git",
  ])("refuses hub origin %s", async (remote) => {
    origin(hub, remote);
    await expect(resolvePreviewRepo(hub, repos, sessions())).resolves.toBeUndefined();
  });

  it("fails closed for missing or unreadable origins", async () => {
    git(hub, "config", "--unset", "remote.origin.url");
    await expect(resolvePreviewRepo(hub, repos, sessions())).resolves.toBeUndefined();
    await expect(
      resolvePreviewRepo(join(dir, "absent"), repos, sessions()),
    ).resolves.toBeUndefined();
    await expect(resolvePreviewRepo(null, repos, sessions())).resolves.toBeUndefined();
  });

  it("does not trust a shared path without a matching configured origin", async () => {
    await expect(
      resolvePreviewRepo(
        hub,
        [{ id: "hub", github: "example/other" }],
        [{ repoId: "hub", checkout: hub }],
      ),
    ).resolves.toBeUndefined();
  });

  it("skips an unavailable crew clone and selects a matching one", async () => {
    await expect(
      resolvePreviewRepo(hub, repos, [
        { repoId: "hub", checkout: join(dir, "absent") },
        ...sessions(),
      ]),
    ).resolves.toBe("hub");
  });
});
