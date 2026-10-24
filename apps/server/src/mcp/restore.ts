import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isInside, realish } from "../config.ts";
import { GIT_TIMEOUT_MS } from "../files.ts";

const run = promisify(execFile);
const HELPER = fileURLToPath(new URL("./restore-helper.ts", import.meta.url));

export interface RestoreSandboxCall {
  profile: string;
  cwd: string;
  args: string[];
  input: Buffer;
}
export type RestoreSandboxRunner = (call: RestoreSandboxCall) => Promise<void>;

/** No fallback: failure to apply Seatbelt must never run an unconfined helper. */
export const runRestoreSandbox: RestoreSandboxRunner = async (call) => {
  if (process.platform !== "darwin") {
    throw new Error("restore_file requires macOS sandbox-exec; no file was changed");
  }
  const child = run("/usr/bin/sandbox-exec", ["-p", call.profile, process.execPath, ...call.args], {
    cwd: call.cwd,
    timeout: GIT_TIMEOUT_MS,
  });
  const written = new Promise<void>((resolve, reject) => {
    child.child.stdin?.once("error", reject);
    child.child.stdin?.end(call.input, resolve);
  });
  try {
    await Promise.all([child, written]);
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr?.trim();
    throw new Error(
      `sandboxed restore failed (sandbox-exec must apply): ${stderr || "helper failed"}`,
      { cause: e },
    );
  }
};

export interface RestoreBoundary {
  worktreesRoot: string;
  gitCommonDir: string;
  worktreeGitDir: string;
  dataDir: string;
}

function quoted(path: string): string {
  if (
    [...path].some(
      (c) =>
        c === '"' ||
        c === "\\" ||
        c.charCodeAt(0) < 32 ||
        (c.charCodeAt(0) >= 127 && c.charCodeAt(0) <= 159),
    )
  ) {
    throw new Error(
      "restore sandbox paths cannot contain quotes, backslashes or control characters",
    );
  }
  return `"${path}"`;
}

export function assertScratchStorage(worktree: string, dataDir: string): void {
  if (isInside(realish(worktree), realish(dataDir))) {
    throw new Error(
      "scratch worktree must be outside the hub data directory; configure separate scratch storage",
    );
  }
}

export function restoreProfile(root: string, denied: readonly string[]): string {
  if (denied.some((path) => isInside(root, path))) {
    throw new Error(
      "a protected directory covers the scratch worktree; configure separate scratch storage",
    );
  }
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (subpath ${quoted(root)}))`,
    ...[join(root, ".git"), ...denied].map(
      (path) => `(deny file-write* (subpath ${quoted(path)}))`,
    ),
  ].join("\n");
}

export async function restoreWorktreeFile(
  worktree: string,
  path: string,
  entry: { mode: string; body: Buffer } | null,
  boundary: RestoreBoundary,
  runner: RestoreSandboxRunner = runRestoreSandbox,
): Promise<void> {
  // Anchor the grant to the configured worktree root, never to a substituted worktree's target.
  const rel = relative(resolve(boundary.worktreesRoot), resolve(worktree));
  if (!rel || isAbsolute(rel) || rel.split("/").includes("..")) {
    throw new Error("scratch worktree is outside the configured worktree root");
  }
  const root = join(await realpath(boundary.worktreesRoot), rel);
  if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root) {
    throw new Error("scratch worktree was replaced or redirected");
  }
  if (
    isAbsolute(path) ||
    path
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git")
  ) {
    throw new Error("path must be relative to the scratch worktree and outside .git");
  }
  assertScratchStorage(root, boundary.dataDir);
  let current = root;
  const parts = path.split("/");
  for (const [i, part] of parts.entries()) {
    const next = join(current, part);
    const stat = await lstat(next).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (stat === null) break;
    if (
      stat.isSymbolicLink() ||
      (await realpath(next)) !== next ||
      !(await readdir(current)).includes(part)
    ) {
      throw new Error("path contains a symlink or an aliased component");
    }
    if (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error("path is not a regular file or its parent is not a directory");
    }
    current = next;
  }
  const denied = await Promise.all(
    [boundary.gitCommonDir, boundary.worktreeGitDir, boundary.dataDir].map((p) => realpath(p)),
  );
  await runner({
    profile: restoreProfile(root, denied),
    cwd: root,
    args: [
      "--experimental-strip-types",
      HELPER,
      path,
      entry?.mode ?? "",
      entry === null ? "delete" : "restore",
    ],
    input: entry?.body ?? Buffer.alloc(0),
  });
}
