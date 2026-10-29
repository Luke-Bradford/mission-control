import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MapSnapshot, PullRequestView } from "@mc/core";
import { afterEach, expect, it } from "vitest";
import { MAP_HISTORY_WINDOW_MS, mapTree } from "../src/map/snapshot.ts";

import { mapCheckout } from "./map-checkout.ts";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const NOW = Date.parse("2026-10-28T12:00:00Z");
const git = (checkout: string, ...args: string[]) =>
  execFileSync(
    "git",
    [
      "-C",
      checkout,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      ...args,
    ],
    { encoding: "utf8" },
  ).trim();

function mergedFixture(checkout: string, number: number, files: string[]): string {
  git(checkout, "checkout", "-qb", `feature/${number}`);
  for (const path of files) writeFileSync(join(checkout, path), `// ${number}\n`);
  git(checkout, "add", ".");
  git(checkout, "commit", "--allow-empty", "-qm", `change ${number}`);
  git(checkout, "checkout", "main");
  git(checkout, "merge", "--no-ff", `feature/${number}`, "-m", `merge ${number}`);
  return git(checkout, "rev-parse", "HEAD");
}

function storedPr(
  number: number,
  mergeCommitSha: string,
  branch = `feature/${number}`,
): PullRequestView {
  return {
    repoId: "sample",
    number,
    title: `PR ${number}`,
    url: "",
    branch,
    ticket: `sample#${number}`,
    state: "merged",
    isDraft: false,
    review: null,
    ci: null,
    createdAt: NOW,
    updatedAt: NOW,
    mergedAt: NOW - number,
    headSha: null,
    mergeCommitSha,
    mergeable: null,
  };
}

it("reads a fixture repo's committed tree and imports within the snapshot budget", async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-map-snapshot-"));
  const data = await mapTree(mapCheckout(dir));
  const snapshot: MapSnapshot = {
    repoId: "sample",
    ...data,
    hist: { since: 0, prCount: 0, fixCount: 0, files: {}, coupling: [] },
    seats: [],
    findings: [],
    conflicts: [],
    conflictsUnchecked: [],
    rules: { areas: {}, hardRules: [] },
    seq: 0,
  };
  expect(snapshot.tree).toContainEqual(
    expect.objectContaining({ path: "packages/core/src/map.ts", lines: expect.any(Number) }),
  );
  expect(snapshot.imports).toContainEqual({
    from: "packages/core/src/map.ts",
    to: "packages/core/src/types.ts",
  });
  expect(snapshot.imports).toContainEqual({
    from: "apps/server/src/map/ring.ts",
    to: "packages/core/src/types.ts",
  });
  expect(snapshot.imports).toContainEqual({
    from: "apps/server/src/map/ring.ts",
    to: "packages/core/src/index.ts",
  });
  expect(snapshot.tree.every((f) => !f.path.startsWith("/") && f.lines >= 0)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(300_000);
});

it("derives first-parent merged history, bug fixes, and bounded change partners", async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-map-history-"));
  const checkout = mapCheckout(dir);
  git(checkout, "branch", "-M", "main");
  const merges = [1, 2, 3, 4].map((number) =>
    mergedFixture(checkout, number, ["packages/core/src/map.ts", "packages/core/src/types.ts"]),
  );
  const many = Array.from({ length: 26 }, (_, i) => `large-${i}.ts`);
  const large = mergedFixture(checkout, 5, ["packages/core/src/map.ts", ...many]);
  git(checkout, "update-ref", "refs/remotes/origin/main", "HEAD");
  const prs = [
    ...merges.map((sha, i) => storedPr(i + 1, sha, i === 0 ? "fix/one" : `feature/${i + 1}`)),
    storedPr(5, large),
  ];
  const data = await mapTree(
    checkout,
    "origin/HEAD",
    prs,
    [{ repoId: "sample", issueNumber: 2, labels: ["bug"] } as never],
    NOW,
  );
  const map = data.tree.findIndex((file) => file.path === "packages/core/src/map.ts");
  const types = data.tree.findIndex((file) => file.path === "packages/core/src/types.ts");
  expect(data.hist).toMatchObject({ since: NOW - MAP_HISTORY_WINDOW_MS, prCount: 5, fixCount: 2 });
  expect(data.hist.files[String(map)]).toEqual([5, 2, NOW - 1, [1, 2, 3, 4, 5]]);
  expect(data.hist.coupling).toContainEqual([Math.min(map, types), Math.max(map, types), 4, 1]);
  expect(data.hist.coupling.every((pair) => pair[2] >= 4 && pair[3] >= 0.5)).toBe(true);
});

it("keeps oversized PRs out of coupling frequency and caps qualifying pairs", async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-map-coupling-"));
  const checkout = mapCheckout(dir);
  git(checkout, "branch", "-M", "main");
  const merges: string[] = [];
  let number = 0;
  const merge = (files: string[]) => {
    number++;
    merges.push(mergedFixture(checkout, number, files));
  };
  for (let i = 0; i < 5; i++) merge(["coupled-a.ts", "coupled-b.ts"]);
  for (let i = 0; i < 5; i++) {
    merge(["coupled-a.ts", ...Array.from({ length: 25 }, (_, n) => `large-a-${i}-${n}.ts`)]);
    merge(["coupled-b.ts", ...Array.from({ length: 25 }, (_, n) => `large-b-${i}-${n}.ts`)]);
  }
  for (let i = 0; i < 4; i++) merge(["below-half-a.ts", "below-half-b.ts"]);
  for (let i = 0; i < 5; i++) {
    merge(["below-half-a.ts"]);
    merge(["below-half-b.ts"]);
  }
  for (let group = 0; group < 3; group++) {
    const files = Array.from({ length: 25 }, (_, n) => `group-${group}-${n}.ts`);
    for (let i = 0; i < 4; i++) merge(files);
  }
  git(
    checkout,
    "rm",
    ...Array.from({ length: 5 }, (_, i) => [
      ...Array.from({ length: 25 }, (_, n) => `large-a-${i}-${n}.ts`),
      ...Array.from({ length: 25 }, (_, n) => `large-b-${i}-${n}.ts`),
    ]).flat(),
  );
  git(checkout, "commit", "-qm", "remove oversized files");
  git(checkout, "update-ref", "refs/remotes/origin/main", "HEAD");
  const data = await mapTree(
    checkout,
    "origin/HEAD",
    merges.map((sha, i) => storedPr(i + 1, sha)),
    [],
    NOW,
  );
  const a = data.tree.findIndex((file) => file.path === "coupled-a.ts");
  const b = data.tree.findIndex((file) => file.path === "coupled-b.ts");
  const belowA = data.tree.findIndex((file) => file.path === "below-half-a.ts");
  const belowB = data.tree.findIndex((file) => file.path === "below-half-b.ts");
  expect(data.hist.coupling).toContainEqual([Math.min(a, b), Math.max(a, b), 5, 1]);
  expect(data.hist.coupling).not.toContainEqual(
    expect.arrayContaining([Math.min(belowA, belowB), Math.max(belowA, belowB)]),
  );
  expect(data.hist.coupling).toHaveLength(600);
});

it("recomputes history when an empty default-branch merge keeps the same tree", async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-map-history-cache-"));
  const checkout = mapCheckout(dir);
  git(checkout, "branch", "-M", "main");
  const first = mergedFixture(checkout, 1, ["packages/core/src/map.ts"]);
  git(checkout, "update-ref", "refs/remotes/origin/main", "HEAD");
  const firstPr = storedPr(1, first);
  expect((await mapTree(checkout, "origin/HEAD", [firstPr], [], NOW)).hist.prCount).toBe(1);
  const second = mergedFixture(checkout, 2, []);
  git(checkout, "update-ref", "refs/remotes/origin/main", "HEAD");
  expect(
    (await mapTree(checkout, "origin/HEAD", [firstPr, storedPr(2, second)], [], NOW)).hist,
  ).toMatchObject({ prCount: 2, files: expect.any(Object) });
});

it("persists the tree, imports and each merge's files, and reuses them without recomputing", async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-map-persist-"));
  const checkout = mapCheckout(dir);
  git(checkout, "branch", "-M", "main");
  const merge = mergedFixture(checkout, 1, ["packages/core/src/map.ts"]);
  git(checkout, "update-ref", "refs/remotes/origin/main", "HEAD");
  const rows = new Map<string, string>();
  const persist = {
    get: (kind: string, scope: string, key: string) => rows.get(`${kind}|${scope}|${key}`) ?? null,
    put: (kind: string, scope: string, key: string, value: string) => {
      rows.set(`${kind}|${scope}|${key}`, value);
    },
  };
  const head = git(checkout, "rev-parse", "origin/HEAD");
  const first = await mapTree(checkout, "origin/HEAD", [storedPr(1, merge)], [], NOW, persist);
  expect(JSON.parse(rows.get(`tree|${checkout}|${head}`) as string).tree).toEqual(first.tree);
  expect(JSON.parse(rows.get(`merge||${merge}`) as string)).toEqual(["packages/core/src/map.ts"]);

  // a second checkout of the same history, as after a restart (the in-memory cache is empty for it)
  const other = mkdtempSync(join(tmpdir(), "mc-map-persist-other-"));
  try {
    const checkout2 = mapCheckout(other);
    git(checkout2, "branch", "-M", "main");
    const head2 = git(checkout2, "rev-parse", "origin/HEAD");
    const marker = { tree: [{ path: "stored.ts", lines: 3 }], imports: [] };
    rows.set(`tree|${checkout2}|${head2}`, JSON.stringify(marker));
    const again = await mapTree(checkout2, "origin/HEAD", [], [], NOW, persist);
    expect(again.tree).toEqual(marker.tree);
    // an unreadable stored row is recomputed, not trusted
    const third = mkdtempSync(join(tmpdir(), "mc-map-persist-third-"));
    try {
      const checkout3 = mapCheckout(third);
      git(checkout3, "branch", "-M", "main");
      rows.set(`tree|${checkout3}|${git(checkout3, "rev-parse", "origin/HEAD")}`, "{not json");
      const cold = await mapTree(checkout3, "origin/HEAD", [], [], NOW, persist);
      expect(cold.tree.length).toBeGreaterThan(1);
    } finally {
      rmSync(third, { recursive: true, force: true });
    }
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
