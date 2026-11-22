import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EVIDENCE_KINDS, EVIDENCE_SCHEMES, type EvidenceManifest } from "@mc/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPERATOR_TOKEN_FILE } from "../src/operator.ts";
import {
  createPrEvidence,
  type EvidenceTarget,
  evidenceReviewDeps,
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
  vi.useRealTimers();
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
    trusted: async () => true,
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
    workDir: deps.workDir,
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

describe("token-guarded pages", () => {
  it("renders each side with the token its own hub wrote, and never stores or logs it", async () => {
    const logs: string[] = [];
    const seen: { sha: string; token: string | undefined }[] = [];
    const t = setup({
      log: (line) => logs.push(line),
      startSide: async ({ sha, db }) => {
        // each hub writes its own token beside its database copy, as the real hub does
        mkdirSync(dirname(db), { recursive: true });
        writeFileSync(join(dirname(db), OPERATOR_TOKEN_FILE), `token-of-${sha.slice(0, 4)}\n`);
        return { origin: `http://side/${sha}`, stop: async () => {} };
      },
      render: async (origin, _path, scheme, _signal, token) => {
        const sha = origin.split("/").pop() ?? "";
        seen.push({ sha, token });
        // a guarded page shows its data only with the side's own token, else the 401 state
        return encodePng(
          token === `token-of-${sha.slice(0, 4)}`
            ? pageBox(sha, scheme)
            : fixtureRaster(320, 200, [], [200, 0, 0]),
        );
      },
    });
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.token).toBe(`token-of-${s.sha.slice(0, 4)}`);
    const m = t.store.manifest("mc", 7, HEAD) as EvidenceManifest;
    // the 401 state is identical on both sides: any difference is the populated page
    expect(m.pairs.find((p) => p.scheme === "light")?.changedPixels).toBeGreaterThan(0);
    const stored = JSON.stringify(m) + logs.join("\n");
    expect(stored).not.toContain("token-of-");
    expect(t.posted.length).toBe(1);
    expect(JSON.stringify(t.posted)).not.toContain("token-of-");
  });
});

describe("Demo renders of the head", () => {
  const demoShot = encodePng(fixtureRaster(64, 40, [], [30, 60, 90]));
  const asked: { sha: string; path: string; width: number; height: number }[] = [];
  const withDemo = (over: Partial<PrEvidenceDeps> = {}) => {
    asked.length = 0;
    return setup({
      renderDemo: async (origin, path, viewport) => {
        asked.push({ sha: origin.split("/").pop() ?? "", path, ...viewport });
        return demoShot;
      },
      ...over,
    });
  };

  it("asks for each page in Demo at both sizes on the head, and stores them", async () => {
    const t = withDemo();
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(asked).toEqual([
      { sha: HEAD, path: "/board", width: 1920, height: 940 },
      { sha: HEAD, path: "/board", width: 2560, height: 1145 },
    ]);
    const m = t.store.manifest("mc", 7, HEAD) as EvidenceManifest;
    expect(m.demos).toEqual([
      { page: "board", width: 1920, height: 940 },
      { page: "board", width: 2560, height: 1145 },
    ]);
    expect(t.store.image("mc", 7, HEAD, "board-demo-1920.png")).toEqual(demoShot);
    expect(t.store.image("mc", 7, HEAD, "board-demo-2560.png")).toEqual(demoShot);
    // the live pairs are unchanged: 1600x1000 comes from `render`, both sides, light and dark
    expect(m.pairs).toHaveLength(2);
    expect(t.rendered).toHaveLength(4);
    expect(t.posted[0]?.demos).toHaveLength(2);
    expect(t.evidence.gate({ repoId: "mc", pr: 7, sha: HEAD, paths: WEB })).toBeNull();
  });

  it("shows a failed Demo render as missing evidence, naming the page and size", async () => {
    const t = withDemo({
      renderDemo: async (_origin, _path, viewport) => {
        if (viewport.width === 2560) throw new Error("Demo marker never came");
        return demoShot;
      },
    });
    const target = { repoId: "mc", pr: 7, sha: HEAD, paths: WEB };
    await t.evidence.ensure(target);
    expect(t.store.manifest("mc", 7, HEAD)).toBeNull();
    const why = t.evidence.gate(target) ?? "";
    expect(why).toContain("missing pages: board");
    expect(why).toContain("board page, Demo at 2560x1145, head side: Demo marker never came");
  });

  it("recaptures a head stored without Demo renders", async () => {
    const t = withDemo();
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    t.store.save({ ...(t.store.manifest("mc", 7, HEAD) as EvidenceManifest), demos: [] }, []);
    expect(t.evidence.gate({ repoId: "mc", pr: 7, sha: HEAD, paths: WEB })).toContain("Demo");
    asked.length = 0;
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(asked).toHaveLength(2);
    expect((t.store.manifest("mc", 7, HEAD) as EvidenceManifest).demos).toHaveLength(2);
  });
});

it("keeps draft when a graph-only page failed and only folder-page pairs were saved", async () => {
  const t = setup({
    webGraph: async () => ({ "apps/web/src/comms/ItemBrief.tsx": ["needs", "comms"] }),
    render: async (origin, path, scheme) => {
      if (path.startsWith("/needs-you")) throw new Error("Needs unavailable");
      return encodePng(pageBox(origin.split("/").pop() ?? "", scheme));
    },
  });
  const target = { repoId: "mc", pr: 7, sha: HEAD, paths: ["apps/web/src/comms/ItemBrief.tsx"] };
  await t.evidence.ensure(target);
  t.store.save(
    {
      repoId: "mc",
      pr: 7,
      sha: HEAD,
      mainSha: MAIN,
      capturedAt: 5000,
      pairs: EVIDENCE_SCHEMES.map((scheme) => ({
        page: "comms" as const,
        scheme,
        changedPixels: 0,
        changedPercent: 0,
        regions: [],
      })),
    },
    EVIDENCE_SCHEMES.flatMap((scheme) =>
      EVIDENCE_KINDS.map((kind) => ({
        name: `comms-${scheme}-${kind}.png`,
        png: encodePng(pageBox(HEAD, scheme)),
      })),
    ),
  );
  expect(t.evidence.gate(target)).toContain("missing pages: needs");
  expect(t.evidence.gate(target)).not.toContain("missing pages: needs, comms");
});

it("shares an in-flight graph read and retries after a transient failure", async () => {
  let release!: () => void;
  let calls = 0;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = setup({
    webGraph: async () => {
      calls++;
      if (calls === 1) {
        await blocked;
        throw new Error("temporary graph failure");
      }
      return { "apps/web/src/comms/ItemBrief.tsx": ["needs", "comms"] };
    },
  });
  const target = { pr: 7, sha: HEAD, paths: ["apps/web/src/comms/ItemBrief.tsx"] };
  const a = t.evidence.ensure(target),
    b = t.evidence.ensure(target);
  await vi.waitFor(() => expect(calls).toBe(1));
  release();
  await Promise.all([a, b]);
  await t.evidence.ensure(target);
  expect(calls).toBe(2);
  expect(t.store.manifest("mc", 7, HEAD)?.pairs.some((p) => p.page === "needs")).toBe(true);
});

it("aborts and waits for an in-flight graph read on stop", async () => {
  let signal: AbortSignal | undefined;
  const t = setup({
    webGraph: async (_sha, s) => {
      signal = s;
      return new Promise((_resolve, reject) =>
        s.addEventListener("abort", () => reject(s.reason), { once: true }),
      );
    },
  });
  const reading = t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
  await vi.waitFor(() => expect(signal).toBeDefined());
  await t.evidence.stop();
  expect(signal?.aborted).toBe(true);
  await reading;
  expect(t.started).toEqual([]);
});

describe("PrEvidence capture", () => {
  it("photographs the pages the head's import graph names, not the folder's", async () => {
    const seen: string[] = [];
    const t = setup({
      webGraph: async (sha) => {
        seen.push(sha);
        return { "apps/web/src/comms/ItemBrief.tsx": ["needs", "comms"] };
      },
    });
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: ["apps/web/src/comms/ItemBrief.tsx"] });
    expect(seen).toEqual([HEAD]);
    expect([...new Set(t.rendered.map((r) => r.path))]).toEqual(["/needs-you", "/comms"]);
    expect(
      t.evidence.gate({
        repoId: "mc",
        pr: 7,
        sha: HEAD,
        paths: ["apps/web/src/comms/ItemBrief.tsx"],
      }),
    ).toBeNull();
  });

  it("keeps the folder rule when the import graph cannot be read", async () => {
    const t = setup({
      webGraph: async () => {
        throw new Error("no checkout");
      },
    });
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: ["apps/web/src/comms/ItemBrief.tsx"] });
    expect([...new Set(t.rendered.map((r) => r.path))]).toEqual(["/comms"]);
  });

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

  it("keeps a PR in draft when it adds a page no screenshot can show", () => {
    const t = setup();
    const paths = ["apps/web/src/pages/Inbox.tsx", "apps/web/src/inbox/List.tsx"];
    expect(t.evidence.gate({ repoId: "mc", pr: 7, sha: HEAD, paths })).toContain(
      "pages/Inbox.tsx has no screenshot address",
    );
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

  it("builds nothing for an untrusted PR", async () => {
    const t = setup({ trusted: async () => false });
    await t.evidence.ensure({ repoId: "mc", pr: 7, sha: HEAD, paths: WEB });
    expect(t.started).toEqual([]);
    expect(t.snapshots).toEqual([]);
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
      trusted: async () => true,
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

  it("retries a render that times out once straight away, before the attempt fails", async () => {
    let tries = 0;
    const t = setup({
      render: async (origin, _path, scheme) => {
        if (origin.endsWith(HEAD) && scheme === "dark" && tries++ === 0)
          throw new Error("HUD screenshot timed out after 30000 ms");
        return encodePng(pageBox(origin.split("/").pop() ?? "", scheme));
      },
    });
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(tries).toBe(2);
    expect(t.store.manifest("mc", 7, HEAD)).not.toBeNull();
  });

  it("keeps the renders that worked and renders only the missing page on the next attempt", async () => {
    let now = 5000;
    let broken = true;
    const paths = ["apps/web/src/board/Card.tsx", "apps/web/src/comms/ItemBrief.tsx"];
    const seen: { path: string }[] = [];
    const t = setup({
      now: () => now,
      webGraph: async () => ({ "apps/web/src/comms/ItemBrief.tsx": ["comms"] }),
      render: async (origin, path, scheme) => {
        seen.push({ path });
        if (broken && path.startsWith("/comms") && origin.endsWith(HEAD))
          throw new Error("HUD screenshot timed out after 30000 ms");
        return encodePng(pageBox(origin.split("/").pop() ?? "", scheme));
      },
    });
    const target = { repoId: "mc", pr: 7, sha: HEAD, paths };
    await t.evidence.ensure(target);
    expect(t.store.manifest("mc", 7, HEAD)).toBeNull();
    const why = t.evidence.gate(target) ?? "";
    expect(why).toContain("missing pages: comms");
    expect(why).not.toContain("board");
    broken = false;
    now += 1001;
    seen.length = 0;
    await t.evidence.ensure(target);
    expect(new Set(seen.map((r) => r.path))).toEqual(new Set(["/comms"]));
    const m = t.store.manifest("mc", 7, HEAD) as EvidenceManifest;
    expect(m.pairs.map((p) => p.page).sort()).toEqual(["board", "board", "comms", "comms"]);
    expect(t.evidence.gate(target)).toBeNull();
  });

  it("pairs a retried page with renders of the same snapshot, taken once", async () => {
    let now = 5000;
    let broken = true;
    let n = 0;
    const t = setup({
      now: () => now,
      snapshot: async (to) => {
        writeFileSync(to, `data-${++n}`);
      },
      startSide: async ({ sha, db }) => ({
        origin: `http://side/${readFileSync(db, "utf8")}/${sha}`,
        stop: async () => {},
      }),
      render: async (origin, _path, scheme) => {
        const [, , , data, sha] = origin.split("/");
        if (broken && sha === HEAD && scheme === "dark") throw new Error("timed out");
        // the same code on both sides: only the data moves the box
        return encodePng(
          fixtureRaster(
            320,
            200,
            [{ x: data === "data-1" ? 16 : 176, y: 40, w: 96, h: 48, rgb: [20, 20, 20] }],
            scheme === "dark" ? [12, 12, 20] : [250, 250, 250],
          ),
        );
      },
    });
    const target = { repoId: "mc", pr: 7, sha: HEAD, paths: WEB };
    await t.evidence.ensure(target);
    broken = false;
    now += 1001;
    await t.evidence.ensure(target);
    expect(n).toBe(1);
    const m = t.store.manifest("mc", 7, HEAD) as EvidenceManifest;
    expect(m.pairs.map((p) => p.changedPixels)).toEqual([0, 0]);
  });

  it("retries a Demo render once, and skips the Demo renders it already kept", async () => {
    let now = 5000;
    let broken = true;
    const asked: string[] = [];
    let flaked = false;
    const demoShot = encodePng(fixtureRaster(64, 40, [], [30, 60, 90]));
    const t = setup({
      now: () => now,
      render: async (origin, _path, scheme) => {
        if (broken && origin.endsWith(HEAD) && scheme === "dark") throw new Error("timed out");
        return encodePng(pageBox(origin.split("/").pop() ?? "", scheme));
      },
      renderDemo: async (_origin, _path, viewport) => {
        asked.push(String(viewport.width));
        if (viewport.width === 2560 && !flaked) {
          flaked = true;
          throw new Error("Demo timed out");
        }
        return demoShot;
      },
    });
    const target = { repoId: "mc", pr: 7, sha: HEAD, paths: WEB };
    await t.evidence.ensure(target); // live head render fails before any Demo render
    expect(asked).toEqual([]);
    broken = false;
    now += 1001;
    await t.evidence.ensure(target);
    expect(asked).toEqual(["1920", "2560", "2560"]); // 2560 retried once, at once
    expect((t.store.manifest("mc", 7, HEAD) as EvidenceManifest).demos).toHaveLength(2);
  });

  it("does not re-ask for Demo renders an earlier attempt kept", async () => {
    let now = 5000;
    let broken = true;
    const asked: string[] = [];
    const demoShot = encodePng(fixtureRaster(64, 40, [], [30, 60, 90]));
    const paths = ["apps/web/src/board/Card.tsx", "apps/web/src/comms/ItemBrief.tsx"];
    const t = setup({
      now: () => now,
      webGraph: async () => ({ "apps/web/src/comms/ItemBrief.tsx": ["comms"] }),
      renderDemo: async (_origin, path, viewport) => {
        asked.push(`${path}:${viewport.width}`);
        if (broken && path === "/comms") throw new Error("Demo timed out");
        return demoShot;
      },
    });
    const target = { repoId: "mc", pr: 7, sha: HEAD, paths };
    await t.evidence.ensure(target);
    // board's Demo renders worked; comms' failed twice
    expect(asked).toEqual(["/board:1920", "/board:2560", "/comms:1920", "/comms:1920"]);
    asked.length = 0;
    broken = false;
    now += 1001;
    await t.evidence.ensure(target);
    expect(asked).toEqual(["/comms:1920", "/comms:2560"]);
  });

  it("renders main again on the new main when main moves between attempts", async () => {
    let now = 5000;
    let broken = true;
    let main = MAIN;
    const NEWMAIN = "8".repeat(40);
    const seen: string[] = [];
    const t = setup({
      now: () => now,
      mainSha: async () => main,
      render: async (origin, _path, scheme) => {
        const sha = origin.split("/").pop() ?? "";
        seen.push(`${sha}:${scheme}`);
        if (broken && sha === HEAD && scheme === "dark") throw new Error("timed out");
        return encodePng(pageBox(sha === NEWMAIN ? MAIN : sha, scheme));
      },
    });
    const target = { repoId: "mc", pr: 7, sha: HEAD, paths: WEB };
    await t.evidence.ensure(target);
    broken = false;
    main = NEWMAIN;
    now += 1001;
    seen.length = 0;
    await t.evidence.ensure(target);
    expect(seen.filter((x) => x.startsWith(NEWMAIN))).toEqual([
      `${NEWMAIN}:light`,
      `${NEWMAIN}:dark`,
    ]);
    expect((t.store.manifest("mc", 7, HEAD) as EvidenceManifest).mainSha).toBe(NEWMAIN);
  });

  it("keeps the snapshot folder only while a failed head waits for its retry", async () => {
    let now = 5000;
    let broken = true;
    const t = setup({
      now: () => now,
      render: async (origin, _path, scheme) => {
        if (broken && origin.endsWith(HEAD) && scheme === "dark") throw new Error("timed out");
        return encodePng(pageBox(origin.split("/").pop() ?? "", scheme));
      },
    });
    const kept = join(t.workDir, "kept-7");
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(existsSync(kept)).toBe(true);
    broken = false;
    now += 1001;
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(existsSync(kept)).toBe(false);
  });

  it("removes the snapshot folder when the PR gets a new head", async () => {
    let now = 5000;
    const t = setup({
      now: () => now,
      render: async (origin, _path, scheme) => {
        if (origin.endsWith(HEAD) && scheme === "dark") throw new Error("timed out");
        return encodePng(pageBox(origin.split("/").pop() ?? "", scheme));
      },
    });
    const kept = join(t.workDir, "kept-7");
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(existsSync(kept)).toBe(true);
    now += 1001;
    await t.evidence.ensure({ pr: 7, sha: NEXT, paths: WEB });
    // NEXT succeeded, so nothing of the old head or the new one is left
    expect(existsSync(kept)).toBe(false);
  });

  it("throws the kept renders away when the PR gets a new head", async () => {
    let now = 5000;
    let broken = true;
    let renders = 0;
    const t = setup({
      now: () => now,
      render: async (origin, _path, scheme) => {
        renders++;
        if (broken && scheme === "dark" && origin.endsWith(HEAD)) throw new Error("timed out");
        return encodePng(pageBox(origin.split("/").pop() ?? "", scheme));
      },
    });
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    broken = false;
    now += 1001;
    renders = 0;
    await t.evidence.ensure({ pr: 7, sha: NEXT, paths: WEB });
    expect(renders).toBe(4); // both sides, both schemes: nothing reused
    // and the old head's kept renders are gone: going back to it renders everything again
    renders = 0;
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(renders).toBe(4);
  });

  it("names the page, scheme and side of a render that times out, in the log and the gate", async () => {
    const lines: string[] = [];
    const t = setup({
      log: (line) => lines.push(line),
      render: async (origin, _path, scheme) => {
        if (origin.endsWith(HEAD) && scheme === "dark")
          throw new Error("HUD screenshot timed out: the 30000 ms deadline expired.");
        return encodePng(pageBox(origin.split("/").pop() ?? "", scheme));
      },
    });
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    const expected =
      "board page, dark scheme, head side: HUD screenshot timed out: the 30000 ms deadline expired.";
    expect(lines.join("\n")).toContain(expected);
    expect(t.evidence.gate({ repoId: "mc", pr: 7, sha: HEAD, paths: WEB })).toContain(expected);
  });
});

describe("PrEvidence gate", () => {
  it("waits for cancelled startup cleanup before advancing the capture queue", async () => {
    let cleaned!: () => void;
    let cancelling!: () => void;
    const cleaning = new Promise<void>((r) => {
      cancelling = r;
    });
    const release = new Promise<void>((r) => {
      cleaned = r;
    });
    const started: string[] = [];
    const t = setup({
      captureMs: 40,
      startSide: async ({ sha, signal }) => {
        started.push(sha);
        if (sha === HEAD) {
          await new Promise<void>((r) =>
            signal.addEventListener("abort", () => r(), { once: true }),
          );
          cancelling();
          await release;
          throw signal.reason;
        }
        return { origin: `http://side/${sha}`, stop: async () => {} };
      },
    });
    const first = t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    const second = t.evidence.ensure({ pr: 8, sha: NEXT, paths: WEB });
    await cleaning;
    expect(started).toEqual([MAIN, HEAD]);
    cleaned();
    await Promise.all([first, second]);
    expect(started).toEqual([MAIN, HEAD, MAIN, NEXT]);
    expect(t.store.manifest("mc", 7, HEAD)).toBeNull();
  });
  it("stops an expired side before another capture starts and never saves its late render", async () => {
    // unset when the side expires before its render starts, which a loaded CI runner can do in 40 ms
    let release: ((png: Buffer) => void) | undefined;
    let active = 0;
    let maxActive = 0;
    let blocked = true;
    const t = setup({
      captureMs: 40,
      startSide: async ({ sha }) => {
        active++;
        maxActive = Math.max(maxActive, active);
        return {
          origin: `http://side/${sha}`,
          stop: async () => {
            active--;
          },
        };
      },
      render: async (origin, _path, scheme) => {
        if (origin.endsWith(HEAD) && blocked) {
          blocked = false;
          return new Promise((r) => {
            release = r;
          });
        }
        return encodePng(pageBox(origin.split("/").pop() ?? "", scheme));
      },
    });
    await t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    expect(active).toBe(0);
    await t.evidence.ensure({ pr: 8, sha: NEXT, paths: WEB });
    release?.(encodePng(pageBox(HEAD, "light")));
    await new Promise((r) => setTimeout(r, 10));
    expect(maxActive).toBe(1);
    expect(t.store.manifest("mc", 7, HEAD)).toBeNull();
    expect(t.store.manifest("mc", 8, NEXT)).not.toBeNull();
  });

  it("shutdown cancels an in-flight render, cleans up and starts no queued capture", async () => {
    let rendering!: () => void;
    const entered = new Promise<void>((r) => {
      rendering = r;
    });
    const t = setup({
      render: async () => {
        rendering();
        return new Promise(() => {});
      },
    });
    const first = t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    const second = t.evidence.ensure({ pr: 8, sha: NEXT, paths: WEB });
    await entered;
    await t.evidence.stop();
    await Promise.all([first, second]);
    expect(t.started.map((s) => s.sha)).toEqual([MAIN]);
    expect(t.stopped).toEqual([MAIN]);
    expect(t.store.manifest("mc", 7, HEAD)).toBeNull();
  });

  it("blames no page when the capture was stopped mid-render", async () => {
    let rendering!: () => void;
    const entered = new Promise<void>((r) => {
      rendering = r;
    });
    const logged: string[] = [];
    const t = setup({
      render: async () => {
        rendering();
        return new Promise(() => {});
      },
      log: (line) => logged.push(line),
    });
    const going = t.evidence.ensure({ pr: 7, sha: HEAD, paths: WEB });
    await entered;
    await t.evidence.stop();
    await going;
    expect(logged).toEqual(["#7: screenshot capture failed: the hub is shutting down"]);
  });

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
    expect(text).toContain("board page, light scheme, main side: page did not render");
    // another head has no failure to report
    expect(t.evidence.gate({ repoId: "mc", pr: 7, sha: NEXT, paths: WEB })).not.toContain(
      "capture failed",
    );
  });

  it("ends a capture whose step hangs at the deadline, and the next PR is not stuck behind it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let entered!: () => void;
    const hanging = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const t = setup({
      captureMs: 30,
      startSide: async ({ sha, signal }) => {
        if (sha === HEAD) {
          entered();
          return new Promise((_, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        }
        return { origin: `http://side/${sha}`, stop: async () => {} };
      },
    });
    const first = t.evidence.ensure({ repoId: "mc", pr: 7, sha: HEAD, paths: WEB });
    await hanging;
    await vi.advanceTimersByTimeAsync(30);
    await first;
    expect(t.evidence.gate({ repoId: "mc", pr: 7, sha: HEAD, paths: WEB })).toContain(
      "capture failed: the capture ran past its deadline",
    );
    // Keep the clock fixed: a successful capture must not race a 30 ms wall-clock deadline.
    // A second PR is captured: main's side answers, the other head's too
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

describe("evidenceReviewDeps", () => {
  it("hands the review start check the capture's own page resolver", async () => {
    const target: EvidenceTarget = { repoId: "mc", pr: 7, sha: HEAD, paths: ["apps/web/src/x.ts"] };
    const pages = vi.fn(async () => ["board"] as const);
    const deps = evidenceReviewDeps({ pages } as never, {} as never, "mc");
    expect(deps.repoId).toBe("mc");
    await expect(deps.pages(target)).resolves.toEqual(["board"]);
    expect(pages).toHaveBeenCalledWith(target);
  });
});
