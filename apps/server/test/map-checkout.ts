import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A committed snapshot source with its own remote default ref; no clone or network needed. */
export function mapCheckout(root: string): string {
  const checkout = join(root, "map-checkout");
  mkdirSync(checkout);
  const files = {
    "package.json": '{"name":"fixture","private":true}\n',
    "packages/core/package.json": '{"name":"@mc/core","exports":{".":"./src/index.ts"}}\n',
    "packages/core/src/map.ts":
      'import type { Fixture } from "./types.ts";\nexport type Map = Fixture;\n',
    "packages/core/src/types.ts": "export type Fixture = string;\n",
    "packages/core/src/index.ts": 'export type { Fixture } from "./types.ts";\n',
    "apps/server/src/map/ring.ts":
      'import type { Fixture } from "@mc/core";\nexport type Ring = Fixture;\n',
  };
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(checkout, path)), { recursive: true });
    writeFileSync(join(checkout, path), content);
  }
  const git = (...args: string[]) =>
    execFileSync("git", [
      "-C",
      checkout,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ]);
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "snapshot fixture");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return checkout;
}
