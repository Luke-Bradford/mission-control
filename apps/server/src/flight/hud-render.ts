/** The fail-closed browser boundary for FLIGHT's read-only HUD screenshots. */
import { existsSync } from "node:fs";
import { OPERATOR_BOOTSTRAP_PATH } from "@mc/core";

const HUD_PATH =
  /^\/(?:$|map(?:\/|$)|overview(?:\/|$)|board(?:\/|$)|flight(?:\/|$)|telemetry(?:\/|$)|comms(?:\/|$)|agents?(?:\/|$)|setup(?:\/|$))/;
const HUD_STREAM_PATH = "/api/stream";
const HUD_READY = "document.documentElement.dataset.hudReady === '1'";
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Whole launch-to-PNG deadline. Individual Playwright calls also receive its remaining time. */
export const HUD_RENDER_DEADLINE_MS = 30_000;
/** Cleanup gets a short grace period, then the owned Chrome process is killed. */
export const HUD_RENDER_CLOSE_MS = 1_000;
/** Refuse screenshots that would make the MCP/image payload unreasonably large. */
export const HUD_SCREENSHOT_MAX_BYTES = 1_500_000;

export interface HudRenderGuard {
  (method: string, url: string): boolean;
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
  return guard;
}

interface BrowserRoute {
  request(): { method(): string; url(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}

interface HudPage {
  goto(url: string, options: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  waitForFunction(
    expression: string,
    arg: undefined,
    options: { timeout: number },
  ): Promise<unknown>;
  screenshot(options: { type: "png"; timeout: number }): Promise<Buffer | Uint8Array>;
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
    viewport: { width: number; height: number };
  }): Promise<HudBrowserContext>;
  close(): Promise<void>;
}

interface HudBrowserServer {
  wsEndpoint(): string;
  process(): { kill(signal: "SIGKILL"): unknown };
  close(): Promise<void>;
}

/** The injected Playwright surface used by lifecycle tests; production loads playwright-core. */
export interface HudPlaywright {
  chromium: {
    launchServer(options: {
      headless: true;
      executablePath: string;
      chromiumSandbox: true;
      timeout: number;
    }): Promise<HudBrowserServer>;
    connect(endpoint: string, options: { timeout: number }): Promise<HudBrowser>;
  };
}

export interface HudRenderOptions {
  executablePath?: string;
  fileExists?: (path: string) => boolean;
  loadPlaywright?: () => Promise<HudPlaywright>;
  deadlineMs?: number;
  closeTimeoutMs?: number;
}

const loadPlaywright = async (): Promise<HudPlaywright> =>
  (await import("playwright-core")) as unknown as HudPlaywright;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

function missingPlaywright(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown };
  return (
    e?.code === "ERR_MODULE_NOT_FOUND" &&
    typeof e.message === "string" &&
    e.message.includes("playwright-core")
  );
}

const pathOf = (url: string): string | null => {
  try {
    const parsed = new URL(url);
    return parsed.pathname;
  } catch {
    return null;
  }
};

/**
 * Launches a sandboxed system Chrome, confines one explicit context, and returns a bounded PNG.
 * The browser server gives cleanup an owned process to kill if Playwright close hangs.
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
  const started = Date.now();
  const remaining = (): number => Math.max(1, deadlineMs - (Date.now() - started));
  let server: HudBrowserServer | undefined;
  let browser: HudBrowser | undefined;
  let context: HudBrowserContext | undefined;
  let cleanup: Promise<void> | undefined;
  let expired = false;
  const timeoutError = (): Error => new Error(`HUD screenshot timed out after ${deadlineMs} ms.`);

  const ensureActive = (): void => {
    if (!expired) return;
    // A launch/connect that ignored its timeout may settle after deadline cleanup took its snapshot.
    try {
      server?.process().kill("SIGKILL");
    } catch {
      // The process already exited.
    }
    void context?.close().catch(() => {});
    void browser?.close().catch(() => {});
    void server?.close().catch(() => {});
    throw timeoutError();
  };

  const closeOwned = (): Promise<void> => {
    if (cleanup) return cleanup;
    cleanup = (async () => {
      const closing = Promise.allSettled([
        Promise.resolve().then(() => context?.close()),
        Promise.resolve().then(() => browser?.close()),
        Promise.resolve().then(() => server?.close()),
      ]).then((results) => results.every((result) => result.status === "fulfilled"));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const closed = await Promise.race([
        closing,
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), closeTimeoutMs);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!closed) {
        try {
          server?.process().kill("SIGKILL");
        } catch {
          // The process already exited.
        }
      }
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
    server = await playwright.chromium.launchServer({
      headless: true,
      executablePath,
      chromiumSandbox: true,
      timeout: deadlineMs,
    });
    ensureActive();
    browser = await playwright.chromium.connect(server.wsEndpoint(), { timeout: remaining() });
    ensureActive();
    context = await browser.newContext({
      serviceWorkers: "block",
      viewport: { width: 1600, height: 1000 },
    });
    ensureActive();
    await context.route("**/*", async (route) => {
      const request = route.request();
      const method = request.method();
      const requestUrl = request.url();
      const path = pathOf(requestUrl);
      // Credentials and writes are denied before the generic origin/GET policy is consulted.
      if (method !== "GET" || path === OPERATOR_BOOTSTRAP_PATH || path === HUD_STREAM_PATH) {
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
    await page.goto(url, { waitUntil: "load", timeout: remaining() });
    ensureActive();
    await page.waitForFunction(HUD_READY, undefined, { timeout: remaining() });
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
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    await closeOwned();
  }
}
