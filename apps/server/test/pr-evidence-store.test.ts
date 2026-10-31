import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceManifest } from "@mc/core";
import { afterEach, describe, expect, it } from "vitest";
import { stageReviewEvidence } from "../src/pr-evidence/review.ts";
import { PR_EVIDENCE_KEEP, prEvidenceStore } from "../src/pr-evidence/store.ts";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "mc-evidence-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sha = (c: string): string => c.repeat(40);
const manifest = (head: string, at: number): EvidenceManifest => ({
  repoId: "mc",
  pr: 5,
  sha: head,
  mainSha: sha("f"),
  capturedAt: at,
  pairs: [{ page: "board", scheme: "light", changedPixels: 0, changedPercent: 0, regions: [] }],
});
const png = Buffer.from("png-bytes");

describe("prEvidenceStore", () => {
  it("stores a head's pairs under its sha and reads them back", () => {
    const root = tmp();
    const store = prEvidenceStore(root);
    store.save(manifest(sha("a"), 1), [{ name: "board-light-diff.png", png }]);
    expect(existsSync(join(root, "mc", "5", sha("a"), "board-light-diff.png"))).toBe(true);
    expect(store.manifest("mc", 5, sha("a"))?.sha).toBe(sha("a"));
    expect(store.image("mc", 5, sha("a"), "board-light-diff.png")?.equals(png)).toBe(true);
  });

  it("answers the newest head when no sha is asked for", () => {
    const store = prEvidenceStore(tmp());
    store.save(manifest(sha("a"), 1), []);
    store.save(manifest(sha("b"), 2), []);
    expect(store.manifest("mc", 5)?.sha).toBe(sha("b"));
    expect(store.manifest("mc", 6)).toBeNull();
    expect(store.manifest("mc", 5, sha("c"))).toBeNull();
  });

  it("never turns an odd id, sha or name into a path", () => {
    const root = tmp();
    const store = prEvidenceStore(root);
    store.save(manifest(sha("a"), 1), [{ name: "board-light-diff.png", png }]);
    expect(store.image("mc", 5, sha("a"), "../manifest.json")).toBeNull();
    expect(store.image("mc", 5, sha("a"), "board-light-diff.png/../x")).toBeNull();
    expect(store.image("../mc", 5, sha("a"), "board-light-diff.png")).toBeNull();
    expect(store.image("mc", 5, "../..", "board-light-diff.png")).toBeNull();
    expect(store.manifest("mc", -1)).toBeNull();
    expect(() => store.save({ ...manifest(sha("a"), 1), repoId: "../x" }, [])).toThrow();
    expect(() => store.save(manifest(sha("a"), 1), [{ name: "evil.png", png }])).toThrow();
  });

  it("keeps only the newest heads of a PR", () => {
    const root = tmp();
    const store = prEvidenceStore(root);
    const heads = ["1", "2", "3", "4", "5"].map(sha);
    heads.forEach((h, i) => {
      store.save(manifest(h, i + 1), []);
    });
    const left = readdirSync(join(root, "mc", "5"));
    expect(left).toHaveLength(PR_EVIDENCE_KEEP);
    expect(left).not.toContain(sha("1"));
    expect(left).toContain(sha("5"));
  });

  it("does not count a head whose manifest was never written", () => {
    const root = tmp();
    const store = prEvidenceStore(root);
    store.save(manifest(sha("a"), 1), [{ name: "board-light-diff.png", png }]);
    rmSync(join(root, "mc", "5", sha("a"), "manifest.json"));
    expect(store.manifest("mc", 5, sha("a"))).toBeNull();
  });

  it("lists the repos that have evidence for a PR number", () => {
    const store = prEvidenceStore(tmp());
    store.save(manifest(sha("a"), 1), []);
    store.save({ ...manifest(sha("a"), 1), repoId: "other" }, []);
    expect(store.reposWith(5).sort()).toEqual(["mc", "other"]);
    expect(store.reposWith(9)).toEqual([]);
  });
});

describe("stageReviewEvidence", () => {
  it("copies a head's images into the review copy and describes them", async () => {
    const root = tmp();
    const store = prEvidenceStore(join(root, "evidence"));
    const names = ["before", "after", "diff"].map((k) => `board-light-${k}.png`);
    store.save(
      manifest(sha("a"), 1),
      names.map((name) => ({ name, png: Buffer.from(name) })),
    );
    const scratch = join(root, "scratch");
    mkdirSync(scratch);
    const staged = await stageReviewEvidence(store, "mc", 5, sha("a"), scratch);
    expect(staged?.dir).toBe(".mc-review/evidence");
    expect(staged?.mainSha).toBe(sha("f"));
    expect(staged?.pairs).toHaveLength(1);
    expect(readFileSync(join(scratch, ".mc-review/evidence/board-light-diff.png"), "utf8")).toBe(
      "board-light-diff.png",
    );
  });

  it("gives nothing for a head without pairs, or a hub without a store", async () => {
    const root = tmp();
    const store = prEvidenceStore(join(root, "evidence"));
    expect(await stageReviewEvidence(store, "mc", 5, sha("a"), root)).toBeUndefined();
    expect(await stageReviewEvidence(undefined, "mc", 5, sha("a"), root)).toBeUndefined();
  });
});
