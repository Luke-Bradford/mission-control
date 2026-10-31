import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { seatToolchainDirs } from "../src/runtime/toolchain.ts";

const tree = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "mc-toolchain-")));
  const exe = (path: string) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "#!/bin/sh\n");
    chmodSync(path, 0o755);
    return path;
  };
  return { root, exe };
};

describe("seatToolchainDirs", () => {
  it("names the install folder of node and of a symlinked pnpm, a bin folder by its parent", () => {
    const { root, exe } = tree();
    const node = exe(join(root, "node/22/bin/node"));
    const real = exe(join(root, "pnpm-lib/bin/pnpm"));
    mkdirSync(join(root, "on-path"));
    symlinkSync(real, join(root, "on-path/pnpm"));
    const dirs = seatToolchainDirs(node, join(root, "on-path"), join(root, "home"), []);
    expect(dirs).toEqual([join(root, "node/22"), join(root, "on-path"), join(root, "pnpm-lib")]);
  });

  it("drops a folder that is or holds the operator's home or a credential folder", () => {
    const { root, exe } = tree();
    const home = join(root, "home");
    const node = exe(join(home, "bin/node"));
    exe(join(home, ".ssh/bin/pnpm"));
    // home/bin is the folder the node binary sits in; its install folder (home) is dropped
    expect(seatToolchainDirs(node, join(home, ".ssh/bin"), home, [])).toEqual([join(home, "bin")]);
    expect(seatToolchainDirs(node, "", join(root, "home/bin"), [])).toEqual([]);
  });

  it("falls back to the binary's own folder when the install folder holds the data dir", () => {
    const { root, exe } = tree();
    const home = join(root, "home");
    const node = exe(join(root, "n/bin/node"));
    exe(join(home, ".local/bin/pnpm"));
    const dirs = seatToolchainDirs(node, join(home, ".local/bin"), home, [
      join(home, ".local/share/mission-control"),
    ]);
    expect(dirs).toContain(join(home, ".local/bin"));
    expect(dirs).not.toContain(join(home, ".local"));
  });

  it("skips a tool not on PATH", () => {
    const { root, exe } = tree();
    const node = exe(join(root, "n/bin/node"));
    expect(seatToolchainDirs(node, join(root, "empty"), join(root, "home"), [])).toEqual([
      join(root, "n"),
    ]);
  });
});
