/** Keeps a live seat's development app in panes of that seat's cmux workspace. */
import { SESSION_APP_STATUS_KEY } from "@mc/core";
import type { Cmux } from "../runtime/cmux.ts";
import { probeLocal } from "./sessions.ts";

export const APP_RESTART_MS = 5 * 60_000;
export const APP_PORT_START = 5173;
const PORT_BLOCK = 10;
export const CREW_APP_DEFAULTS: Readonly<Record<string, readonly CrewAppCommand[]>> = {
  "autonomy-engine": [
    {
      command: "cd studio && pnpm install --frozen-lockfile && pnpm dev",
      url: "http://127.0.0.1:$PORT",
    },
  ],
  ebull: [
    {
      command:
        "uv run uvicorn app.main:app --reload --reload-dir app --host 127.0.0.1 --port $BACKEND_PORT",
      url: "http://127.0.0.1:$PORT",
    },
    {
      command: "cd frontend && pnpm dev -- --host 127.0.0.1 --port $PORT",
      url: "http://127.0.0.1:$PORT",
    },
  ],
};
export interface CrewAppCommand {
  command: string;
  url: string;
}
export interface CrewAppRepo {
  id: string;
  commands: readonly CrewAppCommand[];
}
export interface CrewAppSeat {
  id: string;
  repoId: string;
  worktree: string;
}
interface CrewAppsDeps {
  cmux: Pick<Cmux, "newPane" | "setStatus" | "readScreen" | "workspaces">;
  run(command: string, args: string[]): Promise<string>;
  repos(): readonly CrewAppRepo[];
  seats(): readonly CrewAppSeat[];
  now?(): number;
  probe?(url: string): Promise<boolean>;
  log?(message: string): void;
}
export interface CrewApps {
  start(seatId: string): Promise<void>;
  restart(seatId: string): Promise<void>;
  stop(seatId: string): Promise<void>;
  status(seatId: string): Promise<string>;
  tick(): Promise<void>;
  view(): {
    id: string;
    name: string;
    repo: string;
    seat: string;
    running: boolean;
    apps: { url: string; answers: boolean | null }[];
  }[];
}
const urlAt = (url: string, port: number) => url.replaceAll("$PORT", String(port));
const pidOf = (seat: string, index: number) =>
  `.mc-app-${seat.replaceAll(/[^a-zA-Z0-9_-]/g, "-")}-${index}.pid`;
const quote = (value: string) => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
function commandAt(repo: string, command: string, port: number, backendPort: number, pid: string) {
  const rendered = command
    .replaceAll("$PORT", String(port))
    .replaceAll("$BACKEND_PORT", String(backendPort));
  const proxy =
    repo.toLowerCase() === "ebull" && /cd frontend &&/.test(rendered)
      ? ` VITE_API_PROXY_TARGET=http://127.0.0.1:${backendPort}`
      : "";
  return `sh -lc ${quote(`echo $$ > ${quote(pid)}; exec PORT=${port} BACKEND_PORT=${backendPort}${proxy} ${rendered}`)}`;
}
export function createCrewApps(deps: CrewAppsDeps): CrewApps {
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? probeLocal;
  const running = new Map<
    string,
    {
      workspace: string;
      repo: CrewAppRepo;
      urls: { url: string; answers: boolean | null }[];
      restartedAt?: number;
    }
  >();
  const repoOf = (id: string) => deps.repos().find((repo) => repo.id === id);
  const seatOf = (id: string) => deps.seats().find((seat) => seat.id === id);
  const portOf = (seat: CrewAppSeat, index: number) =>
    APP_PORT_START +
    deps
      .seats()
      .filter((item) => item.worktree !== "")
      .sort((a, b) => a.id.localeCompare(b.id))
      .findIndex((item) => item.id === seat.id) *
      PORT_BLOCK +
    index;
  const checkJobs = (repo: CrewAppRepo) => {
    if (
      repo.id.toLowerCase() === "ebull" &&
      repo.commands.some((entry) => /app\.jobs/.test(entry.command))
    )
      throw new Error("eBull jobs is owned by launchd and cannot be an app command");
  };
  const stop = async (seatId: string) => {
    const app = running.get(seatId);
    const seat = seatOf(seatId);
    if (!app || !seat) return;
    for (const index of app.repo.commands.keys()) {
      const pid = `${seat.worktree}/${pidOf(seatId, index)}`;
      await deps.run("sh", [
        "-lc",
        `if test -r ${quote(pid)}; then kill "$(cat ${quote(pid)})" 2>/dev/null || true; fi`,
      ]);
    }
    running.delete(seatId);
    deps.log?.(`Stopped ${seatId}'s ${app.repo.id} app panes.`);
  };
  const start = async (seatId: string) => {
    const seat = seatOf(seatId);
    if (!seat) throw new Error("No live cmux workspace for this seat.");
    const workspace = (await deps.cmux.workspaces()).find((entry) =>
      entry.name.startsWith(`${seat.id} · `),
    )?.id;
    if (!workspace) throw new Error("No live cmux workspace for this seat.");
    const repo = repoOf(seat.repoId);
    if (!repo || repo.commands.length === 0)
      throw new Error("This seat's repository has no app commands.");
    checkJobs(repo);
    if (running.has(seatId)) await stop(seatId);
    const backendPort = portOf(seat, 0);
    const urls = [];
    for (const [index, entry] of repo.commands.entries()) {
      const port = portOf(seat, index);
      await deps.cmux.newPane(
        workspace,
        seat.worktree,
        commandAt(repo.id, entry.command, port, backendPort, pidOf(seatId, index)),
      );
      urls.push({ url: urlAt(entry.url, port), answers: null });
    }
    await deps.cmux.setStatus(workspace, SESSION_APP_STATUS_KEY, urls[0]?.url ?? "");
    running.set(seatId, { workspace, repo, urls });
    deps.log?.(`Started ${seatId}'s ${repo.id} app panes.`);
  };
  return {
    start,
    async restart(seatId) {
      await stop(seatId);
      await start(seatId);
    },
    stop,
    async status(seatId) {
      const app = running.get(seatId);
      return app
        ? deps.cmux.readScreen(app.workspace, 40)
        : "No app panes are running for this seat.";
    },
    async tick() {
      for (const [seatId] of running) if (!seatOf(seatId)) await stop(seatId);
      for (const seat of deps.seats()) if (!running.has(seat.id)) await start(seat.id);
      for (const [seatId, app] of running) {
        const answers = await Promise.all(
          app.urls.map((entry) => probe(entry.url).catch(() => false)),
        );
        app.urls.forEach((entry, index) => {
          entry.answers = answers[index] ?? false;
        });
        if (
          answers.every(Boolean) ||
          (app.restartedAt !== undefined && now() - app.restartedAt < APP_RESTART_MS)
        )
          continue;
        app.restartedAt = now();
        deps.log?.(`Restarting ${seatId}'s ${app.repo.id} app panes because an app stopped.`);
        await start(seatId);
        const restarted = running.get(seatId);
        if (restarted) restarted.restartedAt = app.restartedAt;
      }
    },
    view() {
      return deps.seats().flatMap((seat) => {
        const repo = repoOf(seat.repoId);
        if (!repo) return [];
        const app = running.get(seat.id);
        return [
          {
            id: seat.id,
            name: `${seat.id} · ${repo.id}`,
            repo: repo.id,
            seat: seat.id,
            running: app !== undefined,
            apps:
              app?.urls ??
              repo.commands.map((entry, index) => ({
                url: urlAt(entry.url, portOf(seat, index)),
                answers: null,
              })),
          },
        ];
      });
    },
  };
}
