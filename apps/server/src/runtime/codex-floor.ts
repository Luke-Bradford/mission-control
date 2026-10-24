/** Codex seat confinement: the server owns filesystem checks; core supplies pure parsing. */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  CODEX_READ_COMMANDS,
  CODEX_SEAT_PROFILE,
  CODEX_SEAT_TOKEN_ENV,
  type CrewMode,
  type CrewSandboxInput,
  codexCommand,
  codexLineCommands,
  codexReadCommand,
  DENIED_TOOLS,
  GIT_READ_TOOLS,
  type GuardEvent,
  isProtectedPath,
  MC_MCP_SERVER,
  pathInArea,
  type SeatCommands,
  sandboxReadDenies,
  seatCommands,
  tomlString,
} from "@mc/core";

/** The hub-written config in one run's isolated CODEX_HOME. */
export function codexSeatConfig(
  i: CrewSandboxInput,
  mode: CrewMode,
  mcpUrl: string,
  tmpDir: string,
): string {
  const denied = sandboxReadDenies(i);
  for (const path of [
    i.cwd,
    i.gitCommonDir,
    i.worktreeGitDir,
    i.home,
    i.dataDir,
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
    "project_doc_max_bytes = 0",
    `web_search = ${tomlString("disabled")}`,
    `default_permissions = ${tomlString(CODEX_SEAT_PROFILE)}`,
    "[features]",
    "unified_exec = false",
    "[shell_environment_policy]",
    `exclude = [${tomlString(CODEX_SEAT_TOKEN_ENV)}]`,
    `[mcp_servers.${MC_MCP_SERVER}]`,
    `url = ${tomlString(mcpUrl)}`,
    `bearer_token_env_var = ${tomlString(CODEX_SEAT_TOKEN_ENV)}`,
    `[permissions.${CODEX_SEAT_PROFILE}.filesystem]`,
    grant(":root", "read"),
    ...denied.map((path) => grant(path, "deny")),
    grant(tmpDir, "write"),
    ...[...new Set([i.gitCommonDir, i.worktreeGitDir])].map((path) => grant(path, "read")),
    `[permissions.${CODEX_SEAT_PROFILE}.filesystem.${tomlString(":workspace_roots")}]`,
    grant(".", mode === "read-only" ? "read" : "write"),
    grant(".git", "read"),
    `[permissions.${CODEX_SEAT_PROFILE}.network]`,
    "enabled = false",
    "",
  ].join("\n");
}

/** Resolve missing leaves through their nearest existing parent; dangling links fail closed. */
function realPathOrParent(path: string): string | null {
  const missing: string[] = [];
  let parent = path;
  for (;;) {
    try {
      return resolve(realpathSync(parent), ...missing.reverse());
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
      missing.push(basename(parent));
      parent = next;
    }
  }
}

/** The relative real path inside an existing worktree, or null. */
function codexRelativePath(path: string, cwd: string): string | null {
  try {
    const root = realpathSync(cwd);
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
): boolean {
  if (path === "" || path === ".") return false;
  const real = codexRelativePath(path, cwd);
  if (real === null || real === "") return false;
  try {
    const rel = isAbsolute(path)
      ? relative(realpathSync(cwd), path)
      : relative(cwd, resolve(cwd, path));
    return (
      !rel.split("/").includes("..") &&
      [rel, real].every((p) => pathInArea(area, p) && !isProtectedPath(p, protectedFiles))
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
    if (!isAbsolute(p.cwd) || !codexReadAllowed(realpathSync(p.cwd), ctx.cwd)) return null;
  } catch {
    return null;
  }
  const parsed = p.proposedExecpolicyAmendment;
  if (parsed != null && (!Array.isArray(parsed) || !parsed.every((w) => typeof w === "string")))
    return null;
  const script = codexCommand(p.command, parsed == null ? null : (parsed as string[]));
  return script === null ? null : [{ tool: "Bash", input: { command: script } }];
}

/** Match the existing CLI's Bash permission entries, including the --output* denies. */
function codexBashEntry(argv: readonly string[], entry: string): boolean {
  if (!entry.startsWith("Bash(")) return false;
  const pattern = entry.slice(5, -1).replace(/:\*$/, "");
  const words = pattern.split(" ");
  return (
    argv.length >= words.length &&
    words.every((w, n) => (w.endsWith("*") ? argv[n].startsWith(w.slice(0, -1)) : argv[n] === w))
  );
}

export function codexCommandAllowed(
  script: string,
  mode: CrewMode,
  commands: SeatCommands,
  approvalCwd: string,
  root: string,
): boolean {
  if (
    [...script].some(
      (c) => c !== "\n" && c !== "\t" && (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
    )
  )
    return false;
  let allowed: readonly string[];
  let cwd: string;
  try {
    if (!isAbsolute(approvalCwd)) return false;
    cwd = realpathSync(approvalCwd);
    if (!codexReadAllowed(cwd, root)) return false;
    allowed = seatCommands(mode, commands);
  } catch {
    return false;
  }
  const parsed = codexLineCommands(script);
  if (parsed === null) return false;
  return parsed.every(({ argv, background, braces }) => {
    if (background || braces || DENIED_TOOLS.some((entry) => codexBashEntry(argv, entry)))
      return false;
    if (Object.hasOwn(CODEX_READ_COMMANDS, argv[0])) {
      return codexReadCommand(argv, (path) =>
        codexReadAllowed(isAbsolute(path) ? path : `${cwd}/${path}`, root),
      );
    }
    return (
      GIT_READ_TOOLS.some((entry) => codexBashEntry(argv, entry)) ||
      allowed.some((entry) => {
        const words = entry.split(" ");
        return argv.length >= words.length && words.every((w, n) => argv[n] === w);
      })
    );
  });
}
