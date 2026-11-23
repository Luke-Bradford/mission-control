/** Small, deliberately boring wrapper around the local cmux command line. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const CMUX_COMMAND = "cmux";
export const CMUX_REFUSED_TEXT =
  'cmux refuses Mission Control: set "automation": { "socketControlMode": "automation" } in ~/.config/cmux/cmux.json';
export const CMUX_DOWN_TEXT = "cmux is not running and could not be started";

export interface CmuxAgent {
  sessionId: string;
  lifecycle: "idle" | "running" | "needsInput";
  pid: number | null;
  workspaceId: string;
  transcriptPath: string | null;
}

export interface Cmux {
  ensure(): Promise<void>;
  newWorkspace(i: { name: string; cwd: string; command: string }): Promise<string>;
  agents(): Promise<CmuxAgent[]>;
  send(workspace: string, text: string): Promise<"sent" | "busy">;
  sendKey(workspace: string, key: string, force?: boolean): Promise<void>;
  readScreen(workspace: string): Promise<string>;
  close(workspace: string): Promise<void>;
}

const run = promisify(execFile);
const UUID = /[0-9a-f]{8}-[0-9a-f-]{27,}/i;
const isDenied = (text: string) => /access denied|not authorised|not authorized/i.test(text);

export interface CmuxOptions {
  /** Starts the cmux app when it is not running (default: `/usr/bin/open -g -a cmux`; empty: never). */
  open?: readonly string[];
  /** How long to wait for it after that (default 10 s). */
  waitMs?: number;
}

/** cmux is local-only; all arguments here are hub generated, never operator text. */
export function createCmux(
  command: readonly string[] = [CMUX_COMMAND],
  log?: (message: string) => void,
  options: CmuxOptions = {},
): Cmux {
  const [bin, ...prefix] = command;
  if (!bin) throw new Error("cmux command is empty");
  let agentsAt = 0;
  let cachedAgents: CmuxAgent[] = [];
  let agentsPending: Promise<CmuxAgent[]> | null = null;
  const call = async (args: string[]) => {
    try {
      return await run(bin, [...prefix, ...args], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      const e = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      const text = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message}`;
      if (isDenied(text)) throw new Error(CMUX_REFUSED_TEXT);
      throw new Error(text.trim() || CMUX_DOWN_TEXT);
    }
  };
  const named = async (name: string): Promise<string[]> => {
    const out = await call(["--id-format", "uuids", "list-workspaces"]);
    return out.stdout
      .split("\n")
      .filter((line) => line.includes(name))
      .flatMap((line) => UUID.exec(line)?.[0] ?? []);
  };
  const wake = async () => {
    if (options.open?.length === 0) return;
    try {
      const [openBin = "/usr/bin/open", ...openArgs] = options.open ?? [
        "/usr/bin/open",
        "-g",
        "-a",
        "cmux",
      ];
      await run(openBin, openArgs, {
        env: {
          HOME: process.env.HOME ?? "",
          USER: process.env.USER ?? "",
          LOGNAME: process.env.LOGNAME ?? "",
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
          SHELL: process.env.SHELL ?? "/bin/zsh",
          LANG: process.env.LANG ?? "en_GB.UTF-8",
        },
      });
    } catch (error) {
      log?.(`could not open cmux: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  return {
    async ensure() {
      try {
        await call(["ping"]);
        return;
      } catch (error) {
        if (error instanceof Error && error.message === CMUX_REFUSED_TEXT) throw error;
        await wake();
        const until = Date.now() + (options.waitMs ?? 10_000);
        while (Date.now() < until) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          try {
            await call(["ping"]);
            return;
          } catch (retry) {
            if (retry instanceof Error && retry.message === CMUX_REFUSED_TEXT) throw retry;
          }
        }
        throw new Error(CMUX_DOWN_TEXT);
      }
    },
    async newWorkspace(i) {
      // UUIDs of workspaces with this name before the new one exists: an older one of the same
      // name (an earlier run's) must never be taken for the new one.
      const before = await named(i.name);
      const out = await call([
        "new-workspace",
        "--name",
        i.name,
        "--cwd",
        i.cwd,
        "--command",
        i.command,
      ]);
      const uuid = UUID.exec(out.stdout)?.[0];
      if (uuid) return uuid;
      // cmux 0.65 prints a short reference after creation: list the workspaces every 0.5 s for up
      // to 5 s, and take the named UUID that was not there before.
      const until = Date.now() + 5000;
      for (;;) {
        const fresh = (await named(i.name)).find((id) => !before.includes(id));
        if (fresh) return fresh;
        if (Date.now() >= until) throw new Error("cmux did not return a workspace id");
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
    async agents() {
      if (Date.now() - agentsAt < 1000) return cachedAgents;
      if (agentsPending) return agentsPending;
      agentsPending = (async () => {
        const out = await call(["sessions", "--agent", "claude", "--json"]);
        const raw: unknown = JSON.parse(out.stdout);
        const sessions = Array.isArray(raw)
          ? raw
          : raw &&
              typeof raw === "object" &&
              Array.isArray((raw as { sessions?: unknown }).sessions)
            ? (raw as { sessions: unknown[] }).sessions
            : null;
        if (sessions === null) throw new Error("cmux returned invalid sessions JSON");
        cachedAgents = sessions.flatMap((v): CmuxAgent[] => {
          if (!v || typeof v !== "object") return [];
          const x = v as Record<string, unknown>;
          const sessionId = x.sessionId ?? x.session_id;
          const lifecycle = x.lifecycle ?? x.agent_lifecycle;
          const workspaceId = x.workspaceId ?? x.workspace_id;
          const transcriptPath = x.transcriptPath ?? x.transcript_path;
          if (
            typeof sessionId !== "string" ||
            (lifecycle !== "idle" && lifecycle !== "running" && lifecycle !== "needsInput") ||
            (typeof x.pid !== "number" && x.pid !== null) ||
            typeof workspaceId !== "string" ||
            (typeof transcriptPath !== "string" && transcriptPath !== null)
          )
            return [];
          return [{ sessionId, lifecycle, pid: x.pid, workspaceId, transcriptPath }];
        });
        agentsAt = Date.now();
        return cachedAgents;
      })();
      try {
        return await agentsPending;
      } finally {
        agentsPending = null;
      }
    },
    async send(workspace, text) {
      try {
        await call(["send", "--workspace", workspace, text]);
        return "sent";
      } catch (error) {
        if (error instanceof Error && /busy|dialog/i.test(error.message)) return "busy";
        throw error;
      }
    },
    async sendKey(workspace, key, force = false) {
      await call(["send-key", "--workspace", workspace, key, ...(force ? ["--force"] : [])]);
    },
    async readScreen(workspace) {
      const out = await call(["read-screen", "--workspace", workspace]);
      return out.stdout;
    },
    async close(workspace) {
      await call(["close-workspace", "--workspace", workspace, "--force"]);
    },
  };
}
