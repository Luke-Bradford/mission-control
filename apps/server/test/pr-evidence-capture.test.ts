import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvidenceManifest } from "@mc/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createPrEvidence,
  type EvidenceTarget,
  type PrEvidenceDeps,
} from "../src/pr-evidence/capture.ts";
import { decodePng, encodePng } from "../src/pr-evidence/png.ts";
import { prEvidenceStore } from "../src/pr-evidence/store.ts";
import { fixtureRaster } from "./pr-evidence-fixture.ts";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "mc-capture-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const MAIN = "m".repeat(40).replace(/m/g, "9");
const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);

/** The fixture page: main draws a dark box on the left, the PR head draws it on the right. */
const pageBox = (sha: string, scheme: string) =>
  fixtureRaster(
    320,
    200,
    [{ x: sha === MAIN ? 16 : 176, y: 40, w: 96, h: 48, rgb: [20, 20, 20] }],
    scheme === "dark" ? [12, 12, 20] : [250, 250, 250],
  );

function setup(over: Partial<PrEvidenceDeps> = {}) {
  const root = tmp();
  const store = prEvidenceStore(join(root, "evidence"));
  const started: { sha: string; db: string; dbBytes: string }[] = [];
  const stopped: string[] = [];
  const rendered: { sha: string; path: string; scheme: string }[] = [];
  const posted: EvidenceManifest[] = [];
  const snapshots: string[] = [];
  const deps: PrEvidenceDeps = {
    store,
    repoId: "mc",
    workDir: join(root, "work"),
    baseUrl: "http://127.0.0.1:7421",
    mainSha: async () => MAIN,
    snapshot: async (to) => {
      snapshots.push(to);
      writeFileSync(to, "live-db");
    },
    startSide: async ({ sha, db }) => {
      started.push({ sha, db, dbBytes: readFileSync(db, "utf8") });
      return {
        origin: `http://side/${sha}`,
        stop: async () => {
          stopped.push(sha);
        },
      };
    },
    render: async (origin, path, scheme) => {
      const sha = origin.split("/").pop() ?? "";
      rendered.push({ sha, path, scheme });
      return encodePng(pageBox(sha, scheme));
    },
    retryMs: 1000,
    now: () => 5000,
    ...over,
  };
  const evidence = createPrEvidence(deps);
  const ensure = (t: Omit<EvidenceTarget, "repoId"> & { repoId?: string }) =>
    evidence.ensure({
      repoId: "mc",
      onStored: async (m) => {
        posted.push(m);
      },
      ...t,
    });
  return {
    evidence: { ...evidence, ensure },
    store,
    started,
    stopped,
    rendered,
    posted,
    snapshots,
  };
}

const WEB = ["apps/web/src/board/Card.tsx"];

describe("PrEvidence capture", () => {
  it("renders each affected page in light and dark on main and head from one snapshot", async () => {
    const t = setup();
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(t.snapshots).toHaveLength(1);
    expect(t.started.map((s) => s.sha)).toEqual([MAIN, HEAD]);
    // each side opens its own copy, and both hold the one snapshot's data
    expect(new Set(t.started.map((s) => s.db)).size).toBe(2);
    expect(t.started.every((s) => s.dbBytes === "live-db")).toBe(true);
    expect(t.rendered).toEqual([
      { sha: MAIN, path: "/board", scheme: "light" },
      { sha: MAIN, path: "/board", scheme: "dark" },
      { sha: HEAD, path: "/board", scheme: "light" },
      { sha: HEAD, path: "/board", scheme: "dark" },
    ]);
    expect(t.stopped).toEqual([MAIN, HEAD]);
  });

  it("captures a pair for the fixture page and computes its diff", async () => {
    const t = setup();
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    const manifest = t.store.manifest("mc", 7, HEAD);
    expect(manifest?.mainSha).toBe(MAIN);
    expect(manifest?.pairs.map((p) => `${p.page}:${p.scheme}`)).toEqual([
      "board:light",
      "board:dark",
    ]);
    const light = manifest?.pairs[0];
    expect(light?.changedPixels).toBe(2 * 96 * 48);
    expect(light?.regions).toHaveLength(2);
    const before = t.store.image("mc", 7, HEAD, "board-light-before.png");
    const after = t.store.image("mc", 7, HEAD, "board-light-after.png");
    const diff = t.store.image("mc", 7, HEAD, "board-dark-diff.png");
    expect(decodePng(before as Buffer).width).toBe(320);
    expect(
      Buffer.from(decodePng(before as Buffer).data).equals(
        Buffer.from(decodePng(after as Buffer).data),
      ),
    ).toBe(false);
    expect(decodePng(diff as Buffer).height).toBe(200);
  });

  it("captures nothing for a PR that changes no HUD page", async () => {
    const t = setup();
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: ["apps/server/src/api.ts"] });
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: ["apps/web/test/board.test.tsx"] });
    expect(t.started).toEqual([]);
    expect(t.evidence.gate({ repoId: "mc", pr: 7, sha: HEAD, paths: WEB.slice(0, 0) })).toBeNull();
  });

  it("does not capture a head twice, and a new head is captured afresh", async () => {
    const t = setup();
    await Promise.all([
      t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB }),
      t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB }),
    ]);
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(t.started).toHaveLength(2);
    await t.evidence.ensure({ pr: 7, sha: NEXT, paths: WEB });
    expect(t.started).toHaveLength(4);
    expect(t.store.manifest("mc", 7, NEXT)).not.toBeNull();
  });

  it("posts the PR body section once per head, and tries again when that fails", async () => {
    let fail = true;
    const t = setup();
    const target = {
      repoId: "mc",
      pr: 7,
      sha: HEAD,
      paths: WEB,
      onStored: async () => {
        calls += 1;
        if (fail) throw new Error("gh down");
      },
    };
    let calls = 0;
    await t.evidence.ensure(target);
    expect(t.store.manifest("mc", 7, HEAD)).not.toBeNull();
    expect(t.evidence.gate(target)).toContain("links are posted");
    fail = false;
    await t.evidence.ensure(target);
    expect(t.evidence.gate(target)).toBeNull();
    await t.evidence.ensure(target);
    expect(calls).toBe(2); // the failed post was tried again, the good one not repeated
    expect(t.started).toHaveLength(2); // no second capture, only the post
  });

  it("reposts stored pairs after a hub restart before releasing draft", async () => {
    const t = setup();
    const target = { repoId: "mc", pr: 7, sha: HEAD, paths: WEB };
    await t.evidence.ensure(target);
    const restarted = createPrEvidence({
      store: t.store,
      repoId: "mc",
      workDir: tmp(),
      baseUrl: "http://localhost",
      mainSha: async () => MAIN,
      snapshot: async () => {
        throw new Error("must not recapture");
      },
      startSide: async () => {
        throw new Error("must not rebuild");
      },
      render: async () => {
        throw new Error("must not render");
      },
    });
    expect(restarted.gate(target)).toContain("links are posted");
    let posted = false;
    await restarted.ensure({
      ...target,
      onStored: async () => {
        posted = true;
      },
    });
    expect(posted).toBe(true);
    expect(restarted.gate(target)).toBeNull();
  });

  it("stops both hubs and waits before retrying when a capture fails", async () => {
    let now = 5000;
    let broken = true;
    const t = setup({
      now: () => now,
      render: async (origin, _path, scheme) => {
        if (broken && origin.endsWith(HEAD)) throw new Error("page did not render");
        return encodePng(pageBox(origin.split("/").pop() ?? "", scheme));
      },
    });
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(t.store.manifest("mc", 7, HEAD)).toBeNull();
    expect(t.stopped).toEqual([MAIN, HEAD]);
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(t.started).toHaveLength(2); // too soon
    broken = false;
    now += 1001;
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(t.store.manifest("mc", 7, HEAD)).not.toBeNull();
  });
});

describe("PrEvidence gate", () => {
  it("leaves another repo's PR alone", async () => {
    const t = setup();
    const other = { repoId: "other", pr: 7, sha: HEAD, paths: WEB };
    await t.evidence.ensure(other);
    expect(t.started).toEqual([]);
    expect(t.evidence.gate(other)).toBeNull();
  });

  it("names the missing pages until the head's pairs exist, then releases", async () => {
    const t = setup();
    const refusal = t.evidence.gate({ repoId: "mc", pr: 7, sha: HEAD, paths: WEB });
    expect(refusal).toContain("board");
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(t.evidence.gate({ repoId: "mc", pr: 7, sha: HEAD, paths: WEB })).toBeNull();
  });

  it("says a capture failed, and why, instead of holding silently", async () => {
    const t = setup({
      render: async () => {
        throw new Error("page did not render");
      },
    });
    await t.evidence.ensure({ repoId: "mc", pr: 7, sha: HEAD, paths: WEB });
    const text = t.evidence.gate({ repoId: "mc", pr: 7, sha: HEAD, paths: WEB });
    expect(text).toContain("board");
    expect(text).toContain("capture failed: page did not render");
    // another head has no failure to report
    expect(t.evidence.gate({ repoId: "mc", pr: 7, sha: NEXT, paths: WEB })).not.toContain(
      "capture failed",
    );
  });

  it("ends a capture whose step hangs at the deadline, and the next PR is not stuck behind it", async () => {
    const t = setup({
      captureMs: 30,
      startSide: async ({ sha }) => {
        if (sha === HEAD) return new Promise(() => {}); // never answers
        return { origin: `http://side/${sha}`, stop: async () => {} };
      },
    });
    await t.evidence.ensure({ repoId: "mc", pr: 7, sha: HEAD, paths: WEB });
    expect(t.evidence.gate({ repoId: "mc", pr: 7, sha: HEAD, paths: WEB })).toContain(
      "capture failed: the capture ran past its deadline",
    );
    // a second PR is captured: main's side answers, the other head's too
    await t.evidence.ensure({ repoId: "mc", pr: 8, sha: NEXT, paths: WEB });
    expect(t.store.manifest("mc", 8, NEXT)).not.toBeNull();
  });

  it("does not release a head on the pairs of an older head", async () => {
    const t = setup();
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(t.evidence.gate({ repoId: "mc", pr: 7, sha: NEXT, paths: WEB })).toContain("board");
  });

  it("asks for more pages when the head touches more", async () => {
    const t = setup();
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(
      t.evidence.gate({
        repoId: "mc",
        pr: 7,
        sha: HEAD,
        paths: [...WEB, "apps/web/src/map/Treemap.tsx"],
      }),
    ).toContain("map");
  });
});
