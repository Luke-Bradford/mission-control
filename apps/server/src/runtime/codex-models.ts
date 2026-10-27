import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CODEX_COMMAND, CODEX_PROJECT_DOC_CONFIG } from "@mc/core";
import { z } from "zod";

const MODEL_TIMEOUT_MS = 20_000;
const MAX_MODEL_BYTES = 1024 * 1024;
export const CODEX_MODELS_UNAVAILABLE = "Codex model/list unavailable";
export const CODEX_MODELS_PENDING = "Codex model discovery pending";
const modelPage = z.object({
  data: z.array(
    z.object({
      model: z.string().min(1),
      supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string().min(1) })),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export interface ModelDeps {
  command?: string;
  authPath?: string;
  spawn?: typeof spawn;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** The hub data directory (denied to seats); defaults to the auth file's directory. */
  dataDir?: string;
}

/** One catalog per hub boot, shared by startup, reloads and config writes. Failed reads may be retried without restarting. */
export class CodexModels {
  private loading?: Promise<void>;
  private models?: Map<string, readonly string[]>;
  reason = CODEX_MODELS_PENDING;

  efforts(model: string): readonly string[] | undefined {
    return this.models?.get(model);
  }

  get available(): boolean {
    return this.models !== undefined;
  }

  /** A copy-safe view for Setup; model discovery never exposes the auth material it read. */
  entries(): { model: string; efforts: readonly string[] }[] {
    return [...(this.models ?? new Map())].map(([model, efforts]) => ({ model, efforts }));
  }

  load(deps: ModelDeps = {}): Promise<void> {
    this.loading ??= readModels(deps).then(
      (models) => {
        this.models = models;
      },
      (error: Error) => {
        this.reason = error.message;
        this.loading = undefined;
        throw error;
      },
    );
    return this.loading;
  }
}

export const codexModels = new CodexModels();

/** The deadline includes filesystem preparation and never depends on child `close`. */
function readModels(deps: ModelDeps): Promise<Map<string, readonly string[]>> {
  const authPath = deps.authPath ?? join(homedir(), ".codex", "auth.json");
  return new Promise((resolve, reject) => {
    let home: string | undefined;
    let child: ChildProcessWithoutNullStreams | undefined;
    let done = false;
    const cleanup = () => {
      if (home) void rm(home, { recursive: true, force: true }).catch(() => {});
    };
    const finish = (reason: string | null, models?: Map<string, readonly string[]>) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      deps.signal?.removeEventListener("abort", aborted);
      if (child) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        // detached gives this discovery its own process group: never enumerate or kill hub/seat processes.
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            /* already exited */
          }
        }
        try {
          child.kill("SIGKILL");
        } catch {
          // Discovery still settles if the OS cannot signal an already exiting child.
        }
        child.unref();
      }
      cleanup();
      if (reason === null && models) resolve(models);
      else reject(new Error(`${CODEX_MODELS_UNAVAILABLE}: ${reason}`));
    };
    const aborted = () => finish("discovery stopped");
    const timer = setTimeout(
      () => finish("discovery timed out"),
      deps.timeoutMs ?? MODEL_TIMEOUT_MS,
    );
    deps.signal?.addEventListener("abort", aborted, { once: true });
    if (deps.signal?.aborted) return aborted();

    const prepare = async () => {
      try {
        home = await mkdtemp(join(deps.dataDir ?? dirname(authPath), "mc-codex-models-"));
        if (done) return;
        const auth = await readFile(authPath);
        if (done) return;
        await writeFile(join(home, "auth.json"), auth, { mode: 0o600 });
        if (done) return;
        await writeFile(
          join(home, "config.toml"),
          `project_doc_max_bytes = ${CODEX_PROJECT_DOC_CONFIG.project_doc_max_bytes}\n`,
          { mode: 0o600 },
        );
        if (done) return;
        const p = (deps.spawn ?? spawn)(deps.command ?? CODEX_COMMAND, ["app-server"], {
          cwd: home,
          env: { ...process.env, CODEX_HOME: home },
          detached: process.platform !== "win32",
          stdio: ["pipe", "pipe", "pipe"],
        });
        child = p;
        let buffer = "";
        let bytes = 0;
        let id = 1;
        const models = new Map<string, readonly string[]>();
        const cursors = new Set<string>();
        const send = (message: unknown) => p.stdin.write(`${JSON.stringify(message)}\n`);
        p.on("error", () => finish("could not start app-server"));
        p.on("exit", () => finish("app-server exited early"));
        p.stdin.on("error", () => finish("app-server stdin closed"));
        p.stdout.on("error", () => finish("app-server stdout closed"));
        p.stderr.on("error", () => finish("app-server stderr closed"));
        p.stderr.resume();
        p.stdout.setEncoding("utf8");
        p.stdout.on("data", (chunk: string) => {
          if (done) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > MAX_MODEL_BYTES) return finish("model/list response too large");
          buffer += chunk;
          for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
            if (done) return;
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            let message: unknown;
            try {
              message = JSON.parse(line);
            } catch {
              return finish("invalid app-server JSON");
            }
            if (!message || typeof message !== "object")
              return finish("invalid app-server response");
            const parsed = message as Record<string, unknown>;
            if (parsed.method && parsed.id !== undefined)
              return finish("unexpected app-server request");
            if (parsed.id !== id) continue;
            if (parsed.error !== undefined || !parsed.result)
              return finish("app-server rejected discovery; check Codex login");
            if (id === 1) {
              send({ method: "initialized" });
              send({ id: ++id, method: "model/list", params: { includeHidden: true } });
              continue;
            }
            const page = modelPage.safeParse(parsed.result);
            if (!page.success) return finish("invalid model/list response");
            for (const model of page.data.data) {
              if (models.has(model.model)) return finish("duplicate model/list entry");
              models.set(
                model.model,
                model.supportedReasoningEfforts.map((e) => e.reasoningEffort),
              );
            }
            const cursor = page.data.nextCursor;
            if (cursor === null) return finish(null, models);
            if (cursors.has(cursor)) return finish("repeated model/list cursor");
            cursors.add(cursor);
            send({ id: ++id, method: "model/list", params: { cursor, includeHidden: true } });
          }
        });
        send({
          id,
          method: "initialize",
          params: { clientInfo: { name: "mission-control", version: "0.0.0" } },
        });
      } catch {
        finish("could not prepare discovery auth or config");
      } finally {
        // A filesystem operation may complete after the deadline; never spawn, and clean its late files.
        if (done) cleanup();
      }
    };
    void prepare();
  });
}
