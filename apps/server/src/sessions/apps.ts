/** Keeps a live seat's development app in panes of that seat's cmux workspace. */
import { SESSION_APP_STATUS_KEY } from "@mc/core";
import type { Cmux } from "../runtime/cmux.ts";
import { probeLocal } from "./sessions.ts";

/** A crew app action the hub refuses, with the reason the operator or seat reads. */
export class CrewAppError extends Error {}

export const APP_RESTART_MS = 5 * 60_000;
export const APP_PORT_START = 5173;
export const SESSION_APP_HEALTH_STATUS_KEY = "app-health";
export const CREW_APP_STATE_SETTING = "crew-app-panes";
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
  cmux: Pick<Cmux, "closePane" | "newPane" | "setStatus" | "readPane" | "workspaces">;
  repos(): readonly CrewAppRepo[];
  seats(): readonly CrewAppSeat[];
  now?(): number;
  probe?(url: string): Promise<boolean>;
  log?(message: string): void;
  state?: { get(): string | null; set(value: string): void };
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
/** The id of the seat's own cmux workspace (named `<seat> · …`), or null when none is open. */
export async function seatWorkspace(
  cmux: Pick<Cmux, "workspaces">,
  seatId: string,
): Promise<string | null> {
  return (
    (await cmux.workspaces()).find((entry) => entry.name.startsWith(`${seatId} · `))?.id ?? null
  );
}
const urlAt = (url: string, port: number) => url.replaceAll("$PORT", String(port));
const quote = (value: string) => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
export function appCommand(repo: string, command: string, port: number, backendPort: number) {
  const rendered = command
    .replaceAll("$PORT", String(port))
    .replaceAll("$BACKEND_PORT", String(backendPort));
  const proxy =
    repo.toLowerCase() === "ebull" && /cd frontend &&/.test(rendered)
      ? ` VITE_API_PROXY_TARGET=http://127.0.0.1:${backendPort}`
      : "";
  return `exec env PORT=${port} BACKEND_PORT=${backendPort}${proxy} sh -lc ${quote(rendered)}`;
}
export function createCrewApps(deps: CrewAppsDeps): CrewApps {
  const now = deps.now ?? Date.now;
  const probe = deps.probe ?? probeLocal;
  const running = new Map<
    string,
    {
      workspace: string;
      worktree: string;
      repo: CrewAppRepo;
      portStart: number;
      apps: { pane: string; url: string; answers: boolean | null }[];
      restartedAt?: number;
    }
  >();
  const repoOf = (id: string) => deps.repos().find((repo) => repo.id === id);
  const seatOf = (id: string) => deps.seats().find((seat) => seat.id === id);
  const reservedPorts = new Map<string, number>();
  const save = () =>
    deps.state?.set(
      JSON.stringify(
        [...running].map(([seat, app]) => ({
          seat,
          workspace: app.workspace,
          worktree: app.worktree,
          repo: app.repo.id,
          portStart: app.portStart,
          apps: app.apps,
          restartedAt: app.restartedAt,
        })),
      ),
    );
  const portStart = (seatId: string) => {
    const reserved = reservedPorts.get(seatId);
    if (reserved !== undefined) return reserved;
    const occupied = new Set(reservedPorts.values());
    let next = APP_PORT_START;
    while (occupied.has(next)) next += PORT_BLOCK;
    reservedPorts.set(seatId, next);
    return next;
  };
  const portOf = (seatId: string, index: number) => portStart(seatId) + index;
  try {
    const saved = JSON.parse(deps.state?.get() ?? "[]") as unknown;
    if (Array.isArray(saved))
      for (const entry of saved) {
        if (typeof entry !== "object" || entry === null) continue;
        const value = entry as Record<string, unknown>;
        const repo = typeof value.repo === "string" ? repoOf(value.repo) : undefined;
        if (
          !repo ||
          typeof value.seat !== "string" ||
          typeof value.workspace !== "string" ||
          typeof value.worktree !== "string" ||
          typeof value.portStart !== "number" ||
          !Array.isArray(value.apps)
        )
          continue;
        const apps = value.apps.flatMap((app) => {
          if (typeof app !== "object" || app === null) return [];
          const pane = (app as Record<string, unknown>).pane;
          const url = (app as Record<string, unknown>).url;
          const answers = (app as Record<string, unknown>).answers;
          return typeof pane === "string" &&
            typeof url === "string" &&
            (answers === true || answers === false || answers === null)
            ? [{ pane, url, answers }]
            : [];
        });
        if (apps.length !== repo.commands.length) continue;
        running.set(value.seat, {
          workspace: value.workspace,
          worktree: value.worktree,
          repo,
          portStart: value.portStart,
          apps,
          restartedAt: typeof value.restartedAt === "number" ? value.restartedAt : undefined,
        });
        reservedPorts.set(value.seat, value.portStart);
      }
  } catch {
    // A malformed prior record must never prevent a seat from opening its app panes.
  }
  const checkJobs = (repo: CrewAppRepo) => {
    if (
      repo.id.toLowerCase() === "ebull" &&
      repo.commands.some((entry) => /app\.jobs/.test(entry.command))
    )
      throw new CrewAppError("eBull jobs is owned by launchd and cannot be an app command");
  };
  const stop = async (seatId: string) => {
    const app = running.get(seatId);
    if (!app) return;
    await Promise.all(app.apps.map((entry) => deps.cmux.closePane(entry.pane).catch(() => {})));
    await deps.cmux.setStatus(app.workspace, SESSION_APP_STATUS_KEY, "");
    await deps.cmux.setStatus(app.workspace, SESSION_APP_HEALTH_STATUS_KEY, "");
    running.delete(seatId);
    reservedPorts.delete(seatId);
    save();
    deps.log?.(`Stopped ${seatId}'s ${app.repo.id} app panes.`);
  };
  const start = async (seatId: string) => {
    const seat = seatOf(seatId);
    if (!seat) throw new CrewAppError("No live cmux workspace for this seat.");
    const workspace = await seatWorkspace(deps.cmux, seat.id);
    if (!workspace) throw new CrewAppError("No live cmux workspace for this seat.");
    const repo = repoOf(seat.repoId);
    if (!repo || repo.commands.length === 0)
      throw new CrewAppError("This seat's repository has no app commands.");
    checkJobs(repo);
    if (running.has(seatId)) await stop(seatId);
    const startPort = portStart(seat.id);
    const backendPort = startPort;
    const apps = [];
    for (const [index, entry] of repo.commands.entries()) {
      const port = startPort + index;
      const pane = await deps.cmux.newPane(
        workspace,
        seat.worktree,
        appCommand(repo.id, entry.command, port, backendPort),
      );
      apps.push({ pane, url: urlAt(entry.url, port), answers: null });
    }
    await deps.cmux.setStatus(workspace, SESSION_APP_STATUS_KEY, apps[0]?.url ?? "");
    await deps.cmux.setStatus(workspace, SESSION_APP_HEALTH_STATUS_KEY, appStatus(apps));
    running.set(seatId, { workspace, worktree: seat.worktree, repo, portStart: startPort, apps });
    save();
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
      if (!app) return "No app panes are running for this seat.";
      return (
        await Promise.all(
          app.apps.map(
            async (entry, index) =>
              `App ${index + 1} (${entry.url}):\n${await deps.cmux.readPane(entry.pane, 40)}`,
          ),
        )
      ).join("\n\n");
    },
    async tick() {
      for (const [seatId] of running) if (!seatOf(seatId)) await stop(seatId);
      for (const seat of deps.seats()) if (!running.has(seat.id)) await start(seat.id);
      for (const [seatId, app] of running) {
        const answers = await Promise.all(
          app.apps.map((entry) => probe(entry.url).catch(() => false)),
        );
        app.apps.forEach((entry, index) => {
          entry.answers = answers[index] ?? false;
        });
        await deps.cmux.setStatus(
          app.workspace,
          SESSION_APP_HEALTH_STATUS_KEY,
          appStatus(app.apps),
        );
        const alive = await Promise.all(
          app.apps.map((entry) =>
            deps.cmux
              .readPane(entry.pane, 1)
              .then(() => true)
              .catch(() => false),
          ),
        );
        if (
          alive.every(Boolean) ||
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
              app?.apps.map(({ url, answers }) => ({ url, answers })) ??
              repo.commands.map((entry, index) => ({
                url: urlAt(entry.url, portOf(seat.id, index)),
                answers: null,
              })),
          },
        ];
      });
    },
  };
}
function appStatus(apps: { url: string; answers: boolean | null }[]) {
  return apps
    .map(
      ({ url, answers }) =>
        `${url} ${answers === true ? "answers" : answers === false ? "not answering" : "starting"}`,
    )
    .join(" · ");
}
