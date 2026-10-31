/** Codex seat confinement: the server owns filesystem checks; core supplies pure parsing. */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  CODEX_MIN_VERSION,
  CODEX_PROJECT_DOC_CONFIG,
  CODEX_SEAT_PROFILE,
  CODEX_SEAT_TOKEN_ENV,
  type CrewMode,
  type CrewSandboxInput,
  codexCommand,
  type GuardEvent,
  grantedPath,
  isProtectedPath,
  MC_MCP_SERVER,
  pathInArea,
  sandboxReadDenies,
  tomlString,
} from "@mc/core";

/** The project config folder Codex loads from a thread's cwd: never writable by a seat. */
export const CODEX_PROJECT_DIR = ".codex";

/** The hub-written config in one run's isolated CODEX_HOME. */
export function codexSeatConfig(
  i: CrewSandboxInput,
  mode: CrewMode,
  mcpUrl: string,
  tmpDir: string,
): string {
  if (i.pnpmStoreDir === undefined || !isAbsolute(i.pnpmStoreDir))
    throw new Error("codex seat config: pnpmStoreDir must be absolute");
  const denied = sandboxReadDenies(i);
  for (const path of [
    i.cwd,
    i.gitCommonDir,
    i.worktreeGitDir,
    i.home,
    i.dataDir,
    i.pnpmStoreDir,
    ...denied,
    tmpDir,
  ]) {
    tomlString(path);
  }
  if (!isAbsolute(tmpDir)) throw new Error("codex seat config: tmpDir must be absolute");
  const contains = (parent: string, path: string) => {
    const rel = relative(resolve(parent), resolve(path));
    return rel === "" || (!rel.startsWith("../") && rel !== ".." && !isAbsolute(rel));
  };
  if (denied.some((path) => contains(path, tmpDir)))
    throw new Error("codex seat config: tmpDir is inside a denied path");
  if ([i.cwd, i.home, i.gitCommonDir, i.worktreeGitDir, "/"].some((path) => contains(tmpDir, path)))
    throw new Error("codex seat config: tmpDir contains a seat or operator path");
  const grant = (path: string, access: string) => `${tomlString(path)}=${tomlString(access)}`;
  return [
    `approvals_reviewer = ${tomlString("user")}`,
    `project_doc_max_bytes = ${CODEX_PROJECT_DOC_CONFIG.project_doc_max_bytes}`,
    `web_search = ${tomlString("disabled")}`,
    `default_permissions = ${tomlString(CODEX_SEAT_PROFILE)}`,
    "[features]",
    // Seats cannot install plugins. Avoid downloading the shared remote catalog into every
    // isolated CODEX_HOME when Codex starts.
    "remote_plugin = false",
    "unified_exec = false",
    "shell_snapshot = false",
    // the zsh fork's exec bridge sends several approvals per item and has its own escalation path
    // (EscalateRequest in the 0.154.0 binary); it is off by default, and stays off
    "shell_zsh_fork = false",
    "[shell_environment_policy]",
    `exclude = [${tomlString(CODEX_SEAT_TOKEN_ENV)}]`,
    `[mcp_servers.${MC_MCP_SERVER}]`,
    `url = ${tomlString(mcpUrl)}`,
    `bearer_token_env_var = ${tomlString(CODEX_SEAT_TOKEN_ENV)}`,
    `[permissions.${CODEX_SEAT_PROFILE}.filesystem]`,
    grant(":root", "read"),
    ...denied.map((path) => grant(path, "deny")),
    grant(tmpDir, "write"),
    grant(i.pnpmStoreDir, "read"),
    ...[...new Set([i.gitCommonDir, i.worktreeGitDir])].map((path) => grant(path, "read")),
    `[permissions.${CODEX_SEAT_PROFILE}.filesystem.${tomlString(":workspace_roots")}]`,
    grant(".", mode === "read-only" ? "read" : "write"),
    grant(".git", "read"),
    // codex-cli 0.154.0's thread/start trusts its cwd (it appends `[projects."<cwd>"] trust_level =
    // "trusted"` to this CODEX_HOME's config.toml) and then loads `<cwd>/.codex/config.toml`, hooks
    // and exec policies, which could widen this very profile on the next start or resume. Codex's
    // sandbox already keeps `.codex` (like `.git` and `.agents`) read-only inside a writable root;
    // this says so explicitly rather than rely on that default (docs/spikes/2026-10-24-codex-seat-confinement.md).
    grant(CODEX_PROJECT_DIR, "read"),
    `[permissions.${CODEX_SEAT_PROFILE}.network]`,
    "enabled = false",
    "",
  ].join("\n");
}

/** Native resolution preserves symlink/.. order; only plain missing leaves may be appended. */
export function realPathOrParent(path: string): string | null {
  const missing: string[] = [];
  let parent = path;
  for (;;) {
    try {
      return resolve(realpathSync.native(parent), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      try {
        lstatSync(parent);
        return null;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }
      const next = dirname(parent);
      if (next === parent) return null;
      const leaf = basename(parent);
      // A missing component followed by traversal has no certain filesystem meaning.
      if (leaf === "." || leaf === "..") return null;
      missing.push(leaf);
      parent = next;
    }
  }
}

/** The relative real path inside an existing worktree, or null. */
function codexRelativePath(path: string, cwd: string): string | null {
  try {
    const root = realpathSync.native(cwd);
    const real = realPathOrParent(isAbsolute(path) ? path : `${root}/${path}`);
    if (real === null) return null;
    const rel = relative(root, real);
    return rel.split("/").includes("..") || isAbsolute(rel) ? null : rel;
  } catch {
    return null;
  }
}

export function codexReadAllowed(path: string, cwd: string): boolean {
  return codexRelativePath(path, cwd) !== null;
}

export function codexEditAllowed(
  path: string,
  cwd: string,
  area: readonly string[],
  protectedFiles: readonly string[],
  granted: readonly string[] = [],
): boolean {
  if (path === "" || path === ".") return false;
  const real = codexRelativePath(path, cwd);
  if (real === null || real === "") return false;
  try {
    const rel = isAbsolute(path)
      ? relative(realpathSync.native(cwd), path)
      : relative(cwd, resolve(cwd, path));
    return (
      !rel.split("/").includes("..") &&
      [rel, real].every(
        (p) =>
          grantedPath(granted, p) || (pathInArea(area, p) && !isProtectedPath(p, protectedFiles)),
      )
    );
  } catch {
    return false;
  }
}

export interface CodexApprovalContext {
  cwd: string;
}

/** Only local commands and file edits can become ordinary guard events. */
export function codexApproval(
  req: { method: string; params: unknown },
  paths: readonly string[] | undefined,
  ctx: CodexApprovalContext,
): GuardEvent[] | null {
  if (req.params === null || typeof req.params !== "object" || Array.isArray(req.params))
    return null;
  const p = req.params as Record<string, unknown>;
  if (req.method === "item/fileChange/requestApproval") {
    if (p.grantRoot != null || paths === undefined || paths.length === 0) return null;
    return paths.map((file_path) => ({ tool: "Edit", input: { file_path } }));
  }
  if (
    req.method !== "item/commandExecution/requestApproval" ||
    p.kind !== "command" ||
    typeof p.command !== "string" ||
    typeof p.cwd !== "string"
  )
    return null;
  if (p.networkApprovalContext != null || (p.environmentId != null && p.environmentId !== "local"))
    return null;
  try {
    if (!isAbsolute(p.cwd) || !codexReadAllowed(realpathSync.native(p.cwd), ctx.cwd)) return null;
  } catch {
    return null;
  }
  const parsed = p.proposedExecpolicyAmendment;
  if (parsed != null && (!Array.isArray(parsed) || !parsed.every((w) => typeof w === "string")))
    return null;
  const script = codexCommand(p.command, parsed == null ? null : (parsed as string[]));
  return script === null ? null : [{ tool: "Bash", input: { command: script } }];
}

/** Only a readable, stable CLI release at or above the floor may start a seat. */
export function codexVersionAllowed(output: string): boolean {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)\s*$/.exec(output.trim());
  if (match === null) return false;
  const version = match.slice(1).map(Number);
  const floor = CODEX_MIN_VERSION.split(".").map(Number);
  for (let n = 0; n < floor.length; n++) {
    if (version[n] !== floor[n]) return version[n] > floor[n];
  }
  return true;
}
