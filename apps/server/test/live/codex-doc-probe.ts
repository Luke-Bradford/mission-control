/** Handshakes only: node --experimental-strip-types apps/server/test/live/codex-doc-probe.ts [candidate]
 * No credentials, MCP servers or turns. A custom provider avoids OpenAI model-catalog refreshes.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CODEX_COMMAND, CODEX_SEAT_PROFILE, CODEX_SHELL, isObj, tomlString } from "@mc/core";

import { writeCodexHostileFiles } from "../fixtures/codex-hostile.ts";

interface Candidate {
  name: string;
  config?: string;
  params?: Record<string, unknown>;
  experimental?: boolean;
  emptyCwd?: boolean;
  emptyProcessCwd?: boolean;
  profileFile?: boolean;
}
// ConfigReadResponse.Config has additionalProperties:true; project_doc_* are not declared.
// These are hypotheses, not supported settings, until the returned sources establish otherwise.
const candidates: Candidate[] = [
  { name: "baseline" },
  { name: "max-zero", config: "project_doc_max_bytes = 0" },
  { name: "fallback-empty", config: "project_doc_fallback_filenames = []" },
  {
    name: "max-zero-fallback-empty",
    config: "project_doc_max_bytes = 0\nproject_doc_fallback_filenames = []",
  },
  { name: "thread-max-only", params: { config: { project_doc_max_bytes: 0 } } },
  {
    name: "thread-config",
    params: { config: { project_doc_max_bytes: 0, project_doc_fallback_filenames: [] } },
  },
  {
    name: "profile",
    config:
      'profile = "no_docs"\n[profiles.no_docs]\nproject_doc_max_bytes = 0\nproject_doc_fallback_filenames = []',
  },
  { name: "profile-file", profileFile: true },
  { name: "instructions-empty", config: 'instructions = ""\nproject_doc_max_bytes = 0' },
  { name: "user-instructions-empty", config: 'user_instructions = ""\nproject_doc_max_bytes = 0' },
  {
    name: "base-instructions",
    params: {
      baseInstructions: "Use only hub instructions.",
      config: { project_doc_max_bytes: 0 },
    },
  },
  {
    name: "developer-instructions",
    params: {
      developerInstructions: "Use only hub instructions.",
      config: { project_doc_max_bytes: 0 },
    },
  },
  { name: "ignore-project-docs", config: "ignore_project_docs = true\nproject_doc_max_bytes = 0" },
  {
    name: "project-docs-disabled",
    config: "project_docs.enabled = false\nproject_doc_max_bytes = 0",
  },
  { name: "root-markers-empty", config: "project_root_markers = []\nproject_doc_max_bytes = 0" },
  { name: "empty-process-cwd", emptyProcessCwd: true, config: "project_doc_max_bytes = 0" },
  { name: "cwd-omitted", params: { cwd: null }, config: "project_doc_max_bytes = 0" },
  {
    name: "empty-thread-cwd",
    emptyCwd: true,
    experimental: true,
    config: "project_doc_max_bytes = 0",
  },
  {
    name: "experimental-profile",
    experimental: true,
    params: { permissions: CODEX_SEAT_PROFILE },
    config: "project_doc_max_bytes = 0",
  },
];
const root = realpathSync(mkdtempSync("/tmp/mc-doc-"));
const repo = join(root, "repo");
const empty = join(root, "empty");
const operator = join(root, "operator");
const command = process.env.MC_CODEX_COMMAND ?? CODEX_COMMAND;
let stop: (() => void) | undefined;
const interrupted = () => {
  stop?.();
  process.exitCode = 1;
};
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);

async function probe(candidate: Candidate): Promise<void> {
  const home = join(root, candidate.name);
  mkdirSync(home);
  const config = [
    'model = "gpt-5.4"',
    'model_provider = "probe"',
    'approvals_reviewer = "user"',
    `default_permissions = ${tomlString(CODEX_SEAT_PROFILE)}`,
    candidate.config ?? "",
    "[model_providers.probe]",
    'name = "handshake only"',
    'base_url = "http://127.0.0.1:1/v1"',
    'wire_api = "responses"',
    "[analytics]",
    "enabled = false",
    "[features]",
    "shell_snapshot = false",
    `[permissions.${CODEX_SEAT_PROFILE}.filesystem]`,
    '":root" = "read"',
    `[permissions.${CODEX_SEAT_PROFILE}.filesystem.":workspace_roots"]`,
    '"." = "write"',
    `[permissions.${CODEX_SEAT_PROFILE}.network]`,
    "enabled = false",
    "",
  ].join("\n");
  writeFileSync(join(home, "config.toml"), config, { mode: 0o600 });
  if (candidate.profileFile)
    writeFileSync(
      join(home, "no_docs.config.toml"),
      "project_doc_max_bytes = 0\nproject_doc_fallback_filenames = []\n",
      { mode: 0o600 },
    );
  const child = spawn(
    command,
    [...(candidate.profileFile ? ["--profile", "no_docs"] : []), "app-server"],
    {
      cwd: candidate.emptyProcessCwd ? empty : repo,
      env: {
        HOME: operator,
        CODEX_HOME: home,
        PATH: process.env.PATH ?? "",
        SHELL: CODEX_SHELL,
        ZDOTDIR: empty,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += String(data);
  });
  const lines = createInterface({ input: child.stdout });
  let result: unknown;
  let error: string | undefined;
  const closed = new Promise<void>((resolve) => {
    child.once("error", (e) => {
      error = e.message;
    });
    child.once("close", () => resolve());
  });
  let kill: NodeJS.Timeout | undefined;
  const close = () => {
    child.stdin.end();
    kill ??= setTimeout(() => child.kill("SIGKILL"), 1000);
  };
  stop = close;
  const timeout = setTimeout(() => {
    error = "handshake timeout";
    close();
  }, 15_000);
  child.stdin.on("error", (e) => {
    error ??= e.message;
    close();
  });
  const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
  lines.on("line", (line) => {
    let m: unknown;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObj(m)) return;
    if (m.id === 1) {
      if (m.error) {
        error = JSON.stringify(m.error);
        close();
        return;
      }
      send({ method: "initialized" });
      send({
        id: 2,
        method: "thread/start",
        params: {
          cwd: candidate.emptyCwd ? empty : repo,
          ...(candidate.emptyCwd ? { runtimeWorkspaceRoots: [repo] } : {}),
          model: "gpt-5.4",
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          ...candidate.params,
          ephemeral: true,
        },
      });
    } else if (m.id === 2) {
      result = m.result;
      if (m.error) error = JSON.stringify(m.error);
      close();
    } else if (typeof m.method === "string" && m.id !== undefined) {
      send({ id: m.id, result: { decision: "decline" } });
    }
  });
  send({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "mc_doc_probe", version: "1" },
      capabilities: { experimentalApi: candidate.experimental === true },
    },
  });
  await closed;
  if (result === undefined) error ??= "process exited before thread/start returned a result";
  clearTimeout(timeout);
  clearTimeout(kill);
  stop = undefined;
  lines.close();
  console.log(
    "CANDIDATE",
    JSON.stringify({
      name: candidate.name,
      error,
      instructionSources: isObj(result) ? result.instructionSources : null,
      sameCwd: isObj(result) && result.cwd === repo,
      result,
      stderr,
    }),
  );
}

try {
  for (const path of [repo, empty, operator]) mkdirSync(path);
  execFileSync("git", ["init", "-q", repo]);
  writeCodexHostileFiles(operator, repo);
  writeFileSync(join(repo, "AGENTS.md"), "PROJECT_DOC_PROBE: this file must not load.\n");
  const selected = candidates.filter(
    (c) => process.argv[2] === undefined || c.name === process.argv[2],
  );
  if (selected.length === 0) throw new Error("unknown candidate");
  for (const candidate of selected) {
    if (process.exitCode) break;
    await probe(candidate);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
  process.off("SIGINT", interrupted);
  process.off("SIGTERM", interrupted);
}
