/** The fail-closed browser boundary for FLIGHT's read-only HUD screenshots. */
import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HUD_PAGE_PATHS, HUD_RENDERER_HEADER, OPERATOR_BOOTSTRAP_PATH } from "@mc/core";
import { type HudProxy, startHudProxy } from "./hud-proxy.ts";

/**
 * The root, every page in the shared nav catalogue, and the web router's `/overview` and plural
 * `/agents` spellings, each alone or followed by a `/` sub-path. Built from `HUD_PAGE_PATHS` so a
 * new page cannot be missed; the segments are plain words, so the pattern stays anchored.
 */
const HUD_SEGMENTS = [
  ...new Set([...Object.values(HUD_PAGE_PATHS).map((p) => p.slice(1)), "overview", "agents"]),
].filter((s) => /^[a-z]+$/.test(s));
const HUD_PATH = new RegExp(`^/(?:$|(?:${HUD_SEGMENTS.join("|")})(?:/|$))`);
const HUD_STREAM_PATH = "/api/stream";
// Waits use selectors, never page-evaluated strings: the hub's CSP (script-src 'self') forbids eval.
const HUD_READY = "html[data-hud-ready='1']";
/**
 * The requested page itself has rendered: the app shell's lazy-route Suspense fallback
 * (`<p>Loading…</p>` inside `<main>`) is gone. `hudReady` only covers the shell's own data.
 */
const PAGE_MAIN = "main";
const PAGE_LOADING = "main p:text-is('Loading…')";
/** The page's requests must stay quiet this long before it is photographed. */
export const HUD_QUIET_MS = 400;
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Whole launch-to-PNG deadline. Individual Playwright calls also receive its remaining time. */
export const HUD_RENDER_DEADLINE_MS = 30_000;
/** Cleanup gets a short grace period, then the owned Chrome process is killed. */
export const HUD_RENDER_CLOSE_MS = 1_000;
/** Refuse screenshots that would make the MCP/image payload unreasonably large. */
export const HUD_SCREENSHOT_MAX_BYTES = 1_500_000;

export interface HudRenderGuard {
  (method: string, url: string): boolean;
  /** The hub origin this guard confines the browser to. */
  readonly origin: string;
  page(path: string): string;
}

/**
 * The browser is deliberately only allowed to fetch GET resources from this hub. Keeping this
 * as a small pure policy makes the security boundary testable by the browser adapter.
 */
export function hudRenderRequest(hubOrigin: string): HudRenderGuard {
  const origin = new URL(hubOrigin).origin;
  const page = (path: string): string => {
    let target: URL;
    try {
      target = new URL(path, origin);
    } catch {
      throw new Error("HUD page required.");
    }
    if (target.origin !== origin || !HUD_PATH.test(target.pathname))
      throw new Error("HUD page required.");
    return target.toString();
  };
  const guard = ((method: string, url: string): boolean => {
    try {
      return method === "GET" && new URL(url).origin === origin;
    } catch {
      return false;
    }
  }) as HudRenderGuard;
  guard.page = page;
  (guard as { origin: string }).origin = origin;
  return guard;
}

interface BrowserRoute {
  request(): { method(): string; url(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}

interface HudPage {
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  waitForSelector(
    selector: string,
    options: { state: "attached" | "detached"; timeout: number },
  ): Promise<unknown>;
  screenshot(options: { type: "png"; timeout: number }): Promise<Buffer | Uint8Array>;
  on(event: "request" | "requestfinished" | "requestfailed", handler: () => void): unknown;
  url(): string;
  close(): Promise<void>;
}

interface HudBrowserContext {
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  routeWebSocket(
    pattern: string,
    handler: (route: {
      close(options: { code: number; reason: string }): Promise<void>;
    }) => Promise<void>,
  ): Promise<void>;
  newPage(): Promise<HudPage>;
  on(event: "page", handler: (page: HudPage) => void): unknown;
  close(): Promise<void>;
}

interface HudBrowser {
  newContext(options: {
    serviceWorkers: "block";
    extraHTTPHeaders: Record<string, string>;
    viewport: { width: number; height: number };
  }): Promise<HudBrowserContext>;
  close(): Promise<void>;
}

/** The injected Playwright surface used by lifecycle tests; production loads playwright-core. */
export interface HudPlaywright {
  chromium: {
    // launch() talks to Chrome over a private pipe: unlike launchServer(), no control socket exists
    launch(options: {
      headless: true;
      executablePath: string;
      chromiumSandbox: true;
      timeout: number;
      // every request, loopback included, goes through the hub-only proxy
      proxy: { server: string };
    }): Promise<HudBrowser>;
  };
}

export interface HudRenderOptions {
  executablePath?: string;
  fileExists?: (path: string) => boolean;
  loadPlaywright?: () => Promise<HudPlaywright>;
  startProxy?: (hubOrigin: string) => Promise<HudProxy>;
  deadlineMs?: number;
  closeTimeoutMs?: number;
  quietMs?: number;
}

const loadPlaywright = async (): Promise<HudPlaywright> =>
  (await import("playwright-core")) as unknown as HudPlaywright;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function missingPlaywright(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown };
  return (
    e?.code === "ERR_MODULE_NOT_FOUND" &&
    typeof e.message === "string" &&
    e.message.includes("playwright-core")
  );
}

/**
 * The path the hub's router will match: decoded once (Fastify decodes percent-escapes), lower-cased
 * and without trailing slashes. Malformed encoding or a URL that doesn't parse is null, and refused.
 */
const pathOf = (url: string): string | null => {
  try {
    const decoded = decodeURIComponent(new URL(url).pathname).toLowerCase();
    return decoded.length > 1 ? decoded.replace(/\/+$/, "") : decoded;
  } catch {
    return null;
  }
};

/**
 * Counts the page's requests in flight. `quiet` resolves once none has been open, or started or
 * ended, for `quietMs`; a page with a request that never ends runs out the caller's deadline.
 */
function watchNetwork(page: HudPage): {
  quiet(quietMs: number, stop: () => boolean): Promise<void>;
} {
  let open = 0;
  let last = Date.now();
  const touch = (delta: number) => () => {
    open = Math.max(0, open + delta);
    last = Date.now();
  };
  page.on("request", touch(1));
  page.on("requestfinished", touch(-1));
  page.on("requestfailed", touch(-1));
  return {
    async quiet(quietMs, stop) {
      while ((open > 0 || Date.now() - last < quietMs) && !stop()) await sleep(25);
    },
  };
}

/**
 * Starts the hub-only proxy, launches a sandboxed system Chrome behind it, confines one explicit
 * context, and returns a bounded PNG. This runs inside the owned helper process (renderHudInHelper),
 * which the parent kills as a group, so a Chrome that will not close cannot outlive the call.
 */
export async function renderHudWithPlaywright(
  url: string,
  guard: HudRenderGuard,
  options: HudRenderOptions = {},
): Promise<Buffer> {
  const executablePath =
    options.executablePath ?? process.env.MC_BROWSER_EXECUTABLE ?? DEFAULT_CHROME;
  if (!(options.fileExists ?? existsSync)(executablePath))
    throw new Error("HUD screenshot unavailable: no system Chrome or Chromium executable found.");

  const deadlineMs = options.deadlineMs ?? HUD_RENDER_DEADLINE_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? HUD_RENDER_CLOSE_MS;
  const quietMs = options.quietMs ?? HUD_QUIET_MS;
  const started = Date.now();
  const remaining = (): number => Math.max(1, deadlineMs - (Date.now() - started));
  let proxy: HudProxy | undefined;
  let browser: HudBrowser | undefined;
  let context: HudBrowserContext | undefined;
  let cleanup: Promise<void> | undefined;
  let expired = false;
  const timeoutError = (): Error => new Error(`HUD screenshot timed out after ${deadlineMs} ms.`);

  const ensureActive = (): void => {
    if (!expired) return;
    // A launch that ignored its timeout may settle after deadline cleanup took its snapshot.
    void context?.close().catch(() => {});
    void browser?.close().catch(() => {});
    void proxy?.close().catch(() => {});
    throw timeoutError();
  };

  const closeOwned = (): Promise<void> => {
    if (cleanup) return cleanup;
    cleanup = (async () => {
      const closing = Promise.allSettled([
        Promise.resolve().then(() => context?.close()),
        Promise.resolve().then(() => browser?.close()),
        Promise.resolve().then(() => proxy?.close()),
      ]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        closing,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, closeTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
    })();
    return cleanup;
  };

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => {
      expired = true;
      void closeOwned().finally(() => reject(timeoutError()));
    }, deadlineMs);
  });

  const work = async (): Promise<Buffer> => {
    let playwright: HudPlaywright;
    try {
      playwright = await (options.loadPlaywright ?? loadPlaywright)();
    } catch (error) {
      if (missingPlaywright(error))
        throw new Error("HUD screenshot unavailable: playwright-core is not installed.");
      throw new Error(
        `HUD screenshot unavailable: could not initialize playwright-core: ${errorText(error)}`,
      );
    }
    ensureActive();
    proxy = await (options.startProxy ?? startHudProxy)(guard.origin);
    ensureActive();
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath,
      chromiumSandbox: true,
      timeout: remaining(),
      proxy: { server: `http://${proxy.address}` },
    });
    ensureActive();
    context = await browser.newContext({
      serviceWorkers: "block",
      // the hub refuses the operator bootstrap to any request carrying this header
      extraHTTPHeaders: { [HUD_RENDERER_HEADER]: "1" },
      viewport: { width: 1600, height: 1000 },
    });
    ensureActive();
    await context.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method();
      const requestUrl = request.url();
      const path = pathOf(requestUrl);
      // Credentials and writes are denied before the generic origin/GET policy is consulted.
      if (
        method !== "GET" ||
        path === null ||
        path === OPERATOR_BOOTSTRAP_PATH ||
        path === HUD_STREAM_PATH
      ) {
        await route.abort();
        return;
      }
      await (guard(method, requestUrl) ? route.continue() : route.abort());
    });
    ensureActive();
    await context.routeWebSocket("**/*", async (route) => {
      await route.close({ code: 1008, reason: "HUD screenshot blocks WebSockets" });
    });
    ensureActive();
    const page = await context.newPage();
    ensureActive();
    // Installed after the one owned page exists, but before navigation can create a popup.
    context.on("page", (popup) => {
      if (popup !== page) void popup.close().catch(() => {});
    });
    const network = watchNetwork(page);
    await page.goto(url, { waitUntil: "load", timeout: remaining() });
    ensureActive();
    const wait = (selector: string, state: "attached" | "detached"): Promise<unknown> =>
      page.waitForSelector(selector, { state, timeout: remaining() });
    await wait(HUD_READY, "attached");
    ensureActive();
    // The shell is ready; now the requested (lazy) page and its data: wait for the placeholder to
    // go, the requests to settle, and the placeholder to still be gone once they have.
    await wait(PAGE_MAIN, "attached");
    await wait(PAGE_LOADING, "detached");
    await network.quiet(quietMs, () => expired || Date.now() - started >= deadlineMs);
    ensureActive();
    await wait(PAGE_LOADING, "detached");
    ensureActive();
    try {
      guard.page(page.url());
    } catch {
      throw new Error("HUD screenshot refused: the main frame left the hub origin or HUD routes.");
    }
    const png = Buffer.from(await page.screenshot({ type: "png", timeout: remaining() }));
    ensureActive();
    if (png.byteLength > HUD_SCREENSHOT_MAX_BYTES)
      throw new Error(`HUD screenshot refused: PNG exceeds ${HUD_SCREENSHOT_MAX_BYTES} bytes.`);
    return png;
  };

  try {
    return await Promise.race([work(), deadline]);
  } catch (error) {
    // A Playwright call limited to the time remaining can time out just before the deadline timer
    if ((error as { name?: unknown })?.name === "TimeoutError") throw timeoutError();
    throw error;
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    await closeOwned();
  }
}

/** The message the helper process replies with. */
export type HudHelperReply = { ok: true; png: string } | { ok: false; error: string };
/** What the parent asks the helper to render. */
export interface HudHelperJob {
  url: string;
  hubOrigin: string;
  executablePath?: string;
  deadlineMs: number;
}

export interface HudHelperOptions {
  /** The helper entry point; tests substitute a stand-in. */
  helperPath?: string;
  executablePath?: string;
  deadlineMs?: number;
  /** Extra time past the render deadline for the helper's own cleanup before it is killed. */
  graceMs?: number;
}

const HELPER_PATH = fileURLToPath(new URL("./hud-helper.ts", import.meta.url));
/** What the helper (and so Chrome) may inherit: no tokens, only what a browser needs to run. */
const HELPER_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "MC_BROWSER_EXECUTABLE"];

/** Kills the helper's whole process group (the helper and the Chrome it launched). */
function killGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group already exited.
  }
}

/**
 * Renders in an owned helper process, started in its own process group. However the render ends
 * (a PNG, an error, the deadline, a crash) the group is killed afterwards, so no Chrome survives.
 */
export function renderHudInHelper(
  url: string,
  guard: HudRenderGuard,
  options: HudHelperOptions = {},
): Promise<Buffer> {
  const deadlineMs = options.deadlineMs ?? HUD_RENDER_DEADLINE_MS;
  const graceMs = options.graceMs ?? HUD_RENDER_CLOSE_MS + 2_000;
  const env: Record<string, string> = {};
  for (const key of HELPER_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  const child = fork(options.helperPath ?? HELPER_PATH, [], {
    detached: true,
    env,
    execArgv: ["--experimental-strip-types", "--no-warnings"],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  return new Promise<Buffer>((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killGroup(child);
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`HUD screenshot timed out after ${deadlineMs} ms.`))),
      deadlineMs + graceMs,
    );
    child.on("message", (reply: HudHelperReply) => {
      if (reply?.ok === true && typeof reply.png === "string") {
        const png = Buffer.from(reply.png, "base64");
        finish(() => resolve(png));
      } else {
        const error = reply?.ok === false && typeof reply.error === "string" ? reply.error : "";
        finish(() => reject(new Error(error || "HUD screenshot failed.")));
      }
    });
    child.on("error", (e) =>
      finish(() => reject(new Error(`HUD screenshot failed: ${errorText(e)}`))),
    );
    child.on("exit", () =>
      finish(() => reject(new Error("HUD screenshot failed: the renderer process exited."))),
    );
    const job: HudHelperJob = {
      url,
      hubOrigin: guard.origin,
      deadlineMs,
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    };
    child.send(job);
  });
}
