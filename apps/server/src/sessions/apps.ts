/** Keeps each crew repository's development app in its own cmux workspace. */
import { join } from "node:path";
import { SESSION_APP_STATUS_KEY } from "@mc/core";
import type { Cmux } from "../runtime/cmux.ts";

export const APP_RESTART_MS = 5 * 60_000;
export const APP_PORT_START = 5173;
/** The operator-approved development commands for the two initial crew applications. */
export const CREW_APP_DEFAULTS: Readonly<Record<string, readonly CrewAppCommand[]>> = {
  "autonomy-engine": [
    { command: "cd studio && pnpm install && pnpm dev", url: "http://127.0.0.1:$PORT" },
  ],
  ebull: [
    {
      command:
        "uv run uvicorn app.main:app --reload --reload-dir app --host 127.0.0.1 --port $PORT",
      url: "http://127.0.0.1:$PORT",
    },
    { command: "cd frontend && pnpm dev", url: "http://127.0.0.1:$PORT" },
  ],
};

export interface CrewAppCommand {
  command: string;
  /** A loopback URL. `$PORT` is replaced by this command's reserved port. */
  url: string;
}

export interface CrewAppRepo {
  id: string;
  checkout: string;
  commands: readonly CrewAppCommand[];
}

interface CrewAppsDeps {
  cmux: Pick<Cmux, "ensure" | "workspaces" | "newWorkspace" | "setStatus" | "close"> & {
    newPane(ws: string, cwd: string, command: string): Promise<void>;
  };
  /** Runs git, or starts a shell command when its first argument is `sh`. */
  run(command: string, args: string[]): Promise<string>;
  repos(): readonly CrewAppRepo[];
  root: string;
  now?(): number;
  probe?(url: string): Promise<boolean>;
  log?(message: string): void;
}

export interface CrewApps {
  start(repoId: string): Promise<void>;
  stop(repoId: string): Promise<void>;
  tick(): Promise<void>;
  view(): { id: string; name: string; running: boolean }[];
}

const appName = (repoId: string) => `${repoId} · app`;
const portOf = (repos: readonly CrewAppRepo[], target: string, command: number) => {
  let port = APP_PORT_START;
  for (const repo of repos) {
    if (repo.id === target) return port + command;
    port += repo.commands.length;
  }
  return port + command;
};
const urlAt = (url: string, port: number) => url.replaceAll("$PORT", String(port));

/** App worktrees are private to the hub and always detached at the freshly fetched origin/main. */
export function createCrewApps(deps: CrewAppsDeps): CrewApps {
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? (async () => false);
  const running = new Map<
    string,
    { workspace: string; urls: string[]; main: string; restartedAt?: number }
  >();

  const repoOf = (id: string) => deps.repos().find((repo) => repo.id === id);
  const checkJobs = (repo: CrewAppRepo) => {
    if (repo.id.toLowerCase() !== "ebull") return;
    if (repo.commands.some((command) => /(?:^|\s)app\.jobs(?:\s|$)/.test(command.command)))
      throw new Error("eBull jobs is owned by launchd and cannot be an app command");
  };
  for (const repo of deps.repos()) checkJobs(repo);
  const start = async (repoId: string) => {
    const repo = repoOf(repoId);
    if (!repo || repo.commands.length === 0) return;
    checkJobs(repo);
    const old = running.get(repoId);
    if (old) await deps.cmux.close(old.workspace);
    const worktree = join(deps.root, repo.id);
    await deps.run("git", ["-C", repo.checkout, "fetch", "origin", "main"]);
    const main = (await deps.run("git", ["-C", repo.checkout, "rev-parse", "origin/main"])).trim();
    await deps.run("git", ["-C", repo.checkout, "worktree", "add", "--force", "--detach", worktree, "origin/main"]);
    await deps.cmux.ensure();
    const repos = deps.repos();
    const first = repo.commands[0] as CrewAppCommand;
    const firstPort = portOf(repos, repo.id, 0);
    const workspace = await deps.cmux.newWorkspace({
      name: appName(repo.id),
      cwd: worktree,
      command: `PORT=${firstPort} ${first.command}`,
    });
    const urls = [urlAt(first.url, firstPort)];
    for (const [index, command] of repo.commands.slice(1).entries()) {
      const port = portOf(repos, repo.id, index + 1);
      await deps.cmux.newPane(workspace, worktree, `PORT=${port} ${command.command}`);
      urls.push(urlAt(command.url, port));
    }
    await deps.cmux.setStatus(workspace, SESSION_APP_STATUS_KEY, urls[0] as string);
    running.set(repo.id, { workspace, urls, main });
    deps.log?.(`Started ${appName(repo.id)} from origin/main.`);
  };
  return {
    start,
    async stop(repoId) {
      const app = running.get(repoId);
      if (!app) return;
      await deps.cmux.close(app.workspace);
      running.delete(repoId);
      deps.log?.(`Stopped ${appName(repoId)}.`);
    },
    async tick() {
      for (const repo of deps.repos()) {
        const app = running.get(repo.id);
        if (!app) continue;
        await deps.run("git", ["-C", repo.checkout, "fetch", "origin", "main"]);
        const main = (await deps.run("git", ["-C", repo.checkout, "rev-parse", "origin/main"])).trim();
        if (main !== app.main) {
          deps.log?.(`Restarting ${appName(repo.id)} on the new origin/main.`);
          await start(repo.id);
          continue;
        }
        const answers = await Promise.all(app.urls.map(probe));
        if (answers.every(Boolean)) continue;
        if (app.restartedAt !== undefined && now() - app.restartedAt < APP_RESTART_MS) continue;
        app.restartedAt = now();
        deps.log?.(`Restarting ${appName(repo.id)} because an app stopped.`);
        await start(repo.id);
        const next = running.get(repo.id);
        if (next) next.restartedAt = app.restartedAt;
      }
    },
    view() {
      return deps.repos().map((repo) => ({
        id: repo.id,
        name: appName(repo.id),
        running: running.has(repo.id),
      }));
    },
  };
}
