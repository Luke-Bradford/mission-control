import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GhOptions, GhResult, GhRunner } from "../src/mcp/gh.ts";
import { evidenceDemoRender } from "../src/pr-evidence/demo-render.ts";
import {
  publishEvidenceRelease,
  removeFinishedEvidenceReleases,
} from "../src/pr-evidence/releases.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const ok = (stdout = ""): GhResult => ({ code: 0, stdout, stderr: "" });

function fakeGh(reply: (args: string[]) => GhResult = () => ok()) {
  const calls: { args: string[]; files: string[] }[] = [];
  const gh: GhRunner = async (args: string[], _o: GhOptions) => {
    // the files named on the command line exist while gh runs
    calls.push({ args, files: args.filter((a) => a.endsWith(".png")) });
    return reply(args);
  };
  return { gh, calls };
}

describe("publishEvidenceRelease", () => {
  it("replaces the PR's release with the pictures, tagged at the head, as a prerelease", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "mc-rel-"));
    dirs.push(scratch);
    const { gh, calls } = fakeGh();
    const url = await publishEvidenceRelease({
      gh,
      cwd: "/repo",
      repo: "o/r",
      pr: 7,
      sha: "a".repeat(40),
      images: [{ name: "board-light-before.png", png: Buffer.from("x") }],
      scratch,
    });
    expect(url).toBe("https://github.com/o/r/releases/download/qa-pr-7");
    expect(calls[0]?.args).toEqual([
      "release",
      "delete",
      "qa-pr-7",
      "--repo",
      "o/r",
      "--cleanup-tag",
      "--yes",
    ]);
    const create = calls[1]?.args ?? [];
    expect(create.slice(0, 3)).toEqual(["release", "create", "qa-pr-7"]);
    expect(create).toContain("--prerelease");
    expect(create[create.indexOf("--target") + 1]).toBe("a".repeat(40));
    expect(calls[1]?.files[0]?.endsWith("board-light-before.png")).toBe(true);
    // the scratch copies are removed afterwards
    expect(readdirSync(scratch)).toEqual([]);
  });

  it("throws when the release cannot be created, and still cleans up", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "mc-rel-"));
    dirs.push(scratch);
    const { gh } = fakeGh((args) =>
      args[1] === "create" ? { code: 1, stdout: "", stderr: "no" } : ok(),
    );
    await expect(
      publishEvidenceRelease({
        gh,
        cwd: "/repo",
        repo: "o/r",
        pr: 7,
        sha: "a".repeat(40),
        images: [{ name: "board-light-before.png", png: Buffer.from("x") }],
        scratch,
      }),
    ).rejects.toThrow(/could not be created/);
    expect(readdirSync(scratch)).toEqual([]);
  });
});

describe("removeFinishedEvidenceReleases", () => {
  const listing = JSON.stringify([
    { tagName: "qa-pr-5" },
    { tagName: "qa-pr-6" },
    { tagName: "v1.2.0" },
    { tagName: "qa-pr-x" },
  ]);

  it("deletes the picture releases of PRs not held, and never another release", async () => {
    const { gh, calls } = fakeGh((args) => (args[1] === "list" ? ok(listing) : ok()));
    const removed = await removeFinishedEvidenceReleases({
      gh,
      cwd: "/repo",
      repo: "o/r",
      keep: (pr) => pr === 6,
    });
    expect(removed).toEqual([5]);
    const deletes = calls.filter((c) => c.args[1] === "delete").map((c) => c.args[2]);
    expect(deletes).toEqual(["qa-pr-5"]);
    expect(calls[1]?.args).toContain("--cleanup-tag");
  });

  it("leaves a release it could not delete for the next run", async () => {
    const { gh } = fakeGh((args) =>
      args[1] === "list" ? ok(listing) : { code: 1, stdout: "", stderr: "x" },
    );
    expect(
      await removeFinishedEvidenceReleases({ gh, cwd: "/repo", repo: "o/r", keep: () => false }),
    ).toEqual([]);
  });

  it("throws when the list cannot be read", async () => {
    const { gh } = fakeGh(() => ({ code: 1, stdout: "", stderr: "" }));
    await expect(
      removeFinishedEvidenceReleases({ gh, cwd: "/repo", repo: "o/r", keep: () => false }),
    ).rejects.toThrow(/could not be listed/);
  });
});

describe("evidenceDemoRender", () => {
  it("always asks for Demo, in the scheme and viewport, on the side's own origin", async () => {
    let seen: { url: string; options: Record<string, unknown> } | undefined;
    const png = Buffer.from("png");
    const out = await evidenceDemoRender(
      "http://127.0.0.1:9000",
      "/board",
      "dark",
      { width: 1600, height: 1000 },
      new AbortController().signal,
      (async (url: string, _guard: unknown, options: Record<string, unknown>) => {
        seen = { url, options };
        return png;
      }) as never,
    );
    expect(out).toBe(png);
    expect(seen?.url).toBe("http://127.0.0.1:9000/board");
    expect(seen?.options).toMatchObject({
      demo: true,
      colorScheme: "dark",
      viewport: { width: 1600, height: 1000 },
    });
  });
});
