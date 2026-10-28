import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MapSnapshot } from "@mc/core";
import { afterEach, expect, it } from "vitest";
import { mapTree } from "../src/map/snapshot.ts";

import { mapCheckout } from "./map-checkout.ts";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it("reads a fixture repo's committed tree and imports within the snapshot budget", async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-map-snapshot-"));
  const data = await mapTree(mapCheckout(dir));
  const snapshot: MapSnapshot = {
    repoId: "sample",
    ...data,
    seats: [],
    findings: [],
    conflicts: [],
    conflictsUnchecked: [],
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
    to: "packages/core/src/index.ts",
  });
  expect(snapshot.tree.every((f) => !f.path.startsWith("/") && f.lines >= 0)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(300_000);
});
