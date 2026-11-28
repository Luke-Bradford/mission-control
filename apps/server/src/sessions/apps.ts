/** Keeps a live seat's development app in panes of that seat's cmux workspace. */
import { SESSION_APP_HEALTH_STATUS_KEY, SESSION_APP_STATUS_KEY } from "@mc/core";
import type { Cmux } from "../runtime/cmux.ts";
import { probeLocal } from "./sessions.ts";

/** A crew app action the hub refuses, with the reason the operator or seat reads. */
export class CrewAppError extends Error {}

export const APP_RESTART_MS = 5 * 60_000;
export const APP_PORT_START = 5173;
export const CREW_APP_STATE_SETTING = "crew-app-panes";
const PORT_BLOCK = 10;
/** Each seat's backend listens on the last port of its block; its panes take the first ones. */
const BACKEND_OFFSET = PORT_BLOCK - 1;
export const CREW_APP_DEFAULTS: Readonly<Record<string, readonly CrewAppCommand[]>> = {
  "autonomy-engine": [
    {
      // vite.config.ts sends /api and /health to SERVER_PORT; it retries until the server is up
      command:
        "cd studio && SERVER_PORT=$BACKEND_PORT pnpm --filter @autonomy-studio/web exec vite --host 127.0.0.1 --port $PORT --strictPort",
      url: "http://127.0.0.1:$PORT",
    },
    {
      // the server needs shared built first, as studio's own dev script does
      command:
        "cd studio && pnpm install --frozen-lockfile && pnpm --filter @autonomy-studio/shared build && PORT=$BACKEND_PORT pnpm --filter @autonomy-studio/server dev",
      url: "http://127.0.0.1:$BACKEND_PORT/health",
    },
  ],
  // the web app first: the first pane's address is the one the hub shows
  ebull: [
    {
      // vite itself: `pnpm dev` would drop the port flags
      command: "cd frontend && pnpm exec vite --host 127.0.0.1 --port $PORT --strictPort",
      url: "http://127.0.0.1:$PORT",
    },
    {
      command:
        "uv run uvicorn app.main:app --reload --reload-dir app --host 127.0.0.1 --port $BACKEND_PORT",
      url: "http://127.0.0.1:$BACKEND_PORT",
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
  /** The live run on the seat: an app and a manual stop belong to one run. */
  runId: string;
  repoId: string;
  worktree: string;
}
interface CrewAppsDeps {
  cmux: Pick<
    Cmux,
    "closePane" | "newPane" | "setStatus" | "clearStatus" | "readPane" | "workspaces"
  >;
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
const urlAt = (url: string, port: number, backendPort: number) =>
  url.replaceAll("$BACKEND_PORT", String(backendPort)).replaceAll("$PORT", String(port));
const quote = (value: string) => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;
export function appCommand(repo: string, command: string, port: number, backendPort: number) {
  const rendered = command
    .replaceAll("$BACKEND_PORT", String(backendPort))
    .replaceAll("$PORT", String(port));
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
      /** The run that started it; undefined for a record an earlier hub saved (adopted as is). */
      runId?: string;
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
  /** Seat to run whose app the operator stopped: left stopped until a start or the seat's next run. */
  const stopped = new Map<string, string>();
  const save = () =>
    deps.state?.set(
      JSON.stringify({
        apps: [...running].map(([seat, app]) => ({
          seat,
          run: app.runId,
          workspace: app.workspace,
          worktree: app.worktree,
          repo: app.repo.id,
          portStart: app.portStart,
          apps: app.apps,
          restartedAt: app.restartedAt,
        })),
        stopped: [...stopped].map(([seat, run]) => ({ seat, run })),
      }),
    );
  /** The seat's port block: its reserved one, else the first free one (not reserved by a look). */
  const freePortStart = (seatId: string) => {
    const reserved = reservedPorts.get(seatId);
    if (reserved !== undefined) return reserved;
    const occupied = new Set(reservedPorts.values());
    let next = APP_PORT_START;
    while (occupied.has(next)) next += PORT_BLOCK;
    return next;
  };
  const portStart = (seatId: string) => {
    const next = freePortStart(seatId);
    reservedPorts.set(seatId, next);
    return next;
  };
  const portOf = (seatId: string, index: number) => freePortStart(seatId) + index;
  try {
    const record = JSON.parse(deps.state?.get() ?? "[]") as unknown;
    // an earlier hub saved the bare list of running apps
    const saved = Array.isArray(record)
      ? record
      : typeof record === "object" && record !== null
        ? (record as Record<string, unknown>).apps
        : [];
    const manual =
      typeof record === "object" && record !== null && !Array.isArray(record)
        ? (record as Record<string, unknown>).stopped
        : [];
    if (Array.isArray(manual))
      for (const entry of manual) {
        const { seat, run } = (entry ?? {}) as Record<string, unknown>;
        if (typeof seat === "string" && typeof run === "string") stopped.set(seat, run);
      }
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
          runId: typeof value.run === "string" ? value.run : undefined,
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
  /** Clears both app statuses, each on its own: a failed clear never stops a teardown. */
  const clearStatuses = async (workspace: string) => {
    for (const key of [SESSION_APP_STATUS_KEY, SESSION_APP_HEALTH_STATUS_KEY])
      try {
        await deps.cmux.clearStatus(workspace, key);
      } catch (error) {
        deps.log?.(`Could not clear the ${key} status of ${workspace}: ${String(error)}`);
      }
  };
  const close = async (seatId: string) => {
    const app = running.get(seatId);
    if (!app) return;
    await Promise.all(app.apps.map((entry) => deps.cmux.closePane(entry.pane).catch(() => {})));
    await clearStatuses(app.workspace);
    running.delete(seatId);
    reservedPorts.delete(seatId);
    save();
    deps.log?.(`Stopped ${seatId}'s ${app.repo.id} app panes.`);
  };
  const start = async (seatId: string, restartedAt?: number) => {
    const seat = seatOf(seatId);
    if (!seat) throw new CrewAppError("No live cmux workspace for this seat.");
    const workspace = await seatWorkspace(deps.cmux, seat.id);
    if (!workspace) throw new CrewAppError("No live cmux workspace for this seat.");
    const repo = repoOf(seat.repoId);
    if (!repo || repo.commands.length === 0)
      throw new CrewAppError("This seat's repository has no app commands.");
    checkJobs(repo);
    stopped.delete(seatId);
    if (running.has(seatId)) await close(seatId);
    const startPort = portStart(seat.id);
    const backendPort = startPort + BACKEND_OFFSET;
    const apps: { pane: string; url: string; answers: boolean | null }[] = [];
    // panes and both statuses are one start: any failure undoes all of it
    try {
      for (const [index, entry] of repo.commands.entries()) {
        const port = startPort + index;
        const pane = await deps.cmux.newPane(
          workspace,
          seat.worktree,
          appCommand(repo.id, entry.command, port, backendPort),
        );
        apps.push({ pane, url: urlAt(entry.url, port, backendPort), answers: null });
      }
      await deps.cmux.setStatus(workspace, SESSION_APP_STATUS_KEY, apps[0]?.url ?? "");
      await deps.cmux.setStatus(workspace, SESSION_APP_HEALTH_STATUS_KEY, appStatus(apps));
    } catch (error) {
      // a half-started app holds no panes, no statuses and no ports; the next tick tries again
      await Promise.all(apps.map((entry) => deps.cmux.closePane(entry.pane).catch(() => {})));
      await clearStatuses(workspace);
      reservedPorts.delete(seatId);
      save();
      throw error;
    }
    running.set(seatId, {
      runId: seat.runId,
      workspace,
      worktree: seat.worktree,
      repo,
      portStart: startPort,
      apps,
      restartedAt,
    });
    save();
    deps.log?.(`Started ${seatId}'s ${repo.id} app panes.`);
  };
  const stop = async (seatId: string) => {
    await close(seatId);
    const seat = seatOf(seatId);
    if (seat) stopped.set(seatId, seat.runId);
    save();
  };
  return {
    start: (seatId) => start(seatId),
    async restart(seatId) {
      await close(seatId);
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
      // an app belongs to the run that started it: a seat's next run, or a new worktree, gets its own
      for (const [seatId, app] of running) {
        const seat = seatOf(seatId);
        if (!seat || seat.worktree !== app.worktree) await close(seatId);
        else if (app.runId === undefined) app.runId = seat.runId;
        else if (app.runId !== seat.runId) await close(seatId);
      }
      // a stop lasts for the seat's run: its next run starts its app again
      for (const [seatId, runId] of stopped)
        if (seatOf(seatId)?.runId !== runId) stopped.delete(seatId);
      // one seat's app that cannot start never holds up another's
      const tryStart = (seatId: string, restartedAt?: number) =>
        start(seatId, restartedAt).catch((error) =>
          deps.log?.(`Could not start ${seatId}'s app panes: ${String(error)}`),
        );
      for (const seat of deps.seats())
        if (!running.has(seat.id) && !stopped.has(seat.id)) await tryStart(seat.id);
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
        deps.log?.(`Restarting ${seatId}'s ${app.repo.id} app panes because an app stopped.`);
        // saved with the new panes, so a hub restart inside the window keeps the throttle
        await tryStart(seatId, now());
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
                url: urlAt(entry.url, portOf(seat.id, index), portOf(seat.id, BACKEND_OFFSET)),
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
