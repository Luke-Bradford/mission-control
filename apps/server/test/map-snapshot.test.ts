import { join } from "node:path";
import type { MapSnapshot } from "@mc/core";
import { expect, it } from "vitest";
import { mapTree } from "../src/map/snapshot.ts";

it("reads this repo's committed tree and imports within the snapshot budget", async () => {
  const data = await mapTree(join(import.meta.dirname, "../../.."), "HEAD");
  const snapshot: MapSnapshot = {
    repoId: "sample",
    ...data,
    seats: [],
    findings: [],
    conflicts: [],
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
