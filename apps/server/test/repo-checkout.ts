import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** A committed checkout with its own remote default ref; no clone or network needed. */
export function repoCheckout(root: string): string {
  const checkout = join(root, "repo-checkout");
  mkdirSync(checkout);
  const files = {
    "package.json": '{"name":"fixture","private":true}\n',
    "src/index.ts": "export const fixture = 1;\n",
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
  git("commit", "-qm", "fixture");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return checkout;
}
