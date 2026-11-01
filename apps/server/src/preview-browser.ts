/**
 * RETRO's browser on a review's preview. It is confined to one origin, the preview's: the browser
 * goes through a loopback proxy that only reaches that host:port, and every request is checked
 * again in the page's routes. Each call opens a fresh page, runs its steps and closes the browser.
 */
import { type ChildProcess, fork } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HUD_RENDERER_HEADER, OPERATOR_BOOTSTRAP_PATH } from "@mc/core";
import { type HudProxy, startHudProxy } from "./flight/hud-proxy.ts";

export const PREVIEW_DEADLINE_MS = 60_000;
export const PREVIEW_CLOSE_MS = 1_000;
/** How long a call waits for a building preview; Codex ends a tool call at 60 s, so it answers before that. */
export const PREVIEW_READY_WAIT_MS = 40_000;
export const PREVIEW_WIDTH_MIN = 320;
export const PREVIEW_WIDTH_MAX = 3840;
export const PREVIEW_HEIGHT = 900;
export const PREVIEW_STEPS_MAX = 20;
export const PREVIEW_SHOTS_MAX = 6;
export const PREVIEW_TEXT_MAX = 6_000;
export const PREVIEW_MEASURE_MAX = 30;
export const PREVIEW_SHOT_MAX_BYTES = 4_000_000;
export const PREVIEW_THEMES = ["dark", "light"] as const;
export type PreviewTheme = (typeof PREVIEW_THEMES)[number];
const STREAM_PATH = "/api/stream";
const HELPER_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "MC_BROWSER_EXECUTABLE"];
const DEFAULT_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const READY = "html[data-hud-ready='1']";
const LOADING = "main p:text-is('Loading…')";

/** One thing to do on the page, in order. */
export type PreviewStep =
  | { click: string }
  | { type: { selector: string; text: string } }
  | { read: string }
  | { measure: string }
  | { screenshot: string };

export interface PreviewJob {
  /** A path on the preview, e.g. `/needs-you`. */
  path: string;
  width: number;
  theme: PreviewTheme;
  steps: PreviewStep[];
}

export interface PreviewShot {
  label: string;
  png: Buffer;
}

export interface PreviewResult {
  url: string;
  /** What the steps read, measured and hit, one line each, then the page's own text. */
  report: string[];
  shots: PreviewShot[];
}

export interface PreviewGuard {
  (method: string, url: string): boolean;
  readonly origin: string;
  /** The URL a path names on the preview; throws for anything that leaves its origin. */
  page(path: string): string;
}

/** The only requests the browser may make: GET only, to the preview's origin, minus the operator's token. */
export function previewRequest(previewOrigin: string): PreviewGuard {
  const origin = new URL(previewOrigin).origin;
  const guard = ((method: string, url: string): boolean => {
    try {
      const target = new URL(url);
      return (
        target.origin === origin &&
        method === "GET" &&
        target.pathname !== OPERATOR_BOOTSTRAP_PATH &&
        target.pathname !== STREAM_PATH
      );
    } catch {
      return false;
    }
  }) as PreviewGuard;
  (guard as { origin: string }).origin = origin;
  guard.page = (path) => {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))
      throw new Error("A path on the preview is required, such as /needs-you.");
    let target: URL;
    try {
      target = new URL(path, origin);
    } catch {
      throw new Error("A path on the preview is required, such as /needs-you.");
    }
    if (target.origin !== origin)
      throw new Error("Refused: the browser only reaches the review's preview.");
    return target.toString();
  };
  return guard;
}

interface Locator {
  first(): Locator;
  all(): Promise<Locator[]>;
  click(o: { timeout: number }): Promise<void>;
  fill(text: string, o: { timeout: number }): Promise<void>;
  innerText(o: { timeout: number }): Promise<string>;
  boundingBox(o: { timeout: number }): Promise<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>;
  count(): Promise<number>;
}
interface BrowserRoute {
  request(): { method(): string; url(): string };
  continue(): Promise<void>;
  abort(): Promise<void>;
}
interface PreviewPage {
  goto(url: string, o: { waitUntil: "load"; timeout: number }): Promise<unknown>;
  waitForSelector(
    s: string,
    o: { state: "attached" | "detached"; timeout: number },
  ): Promise<unknown>;
  locator(selector: string): Locator;
  emulateMedia(o: { colorScheme: PreviewTheme }): Promise<void>;
  screenshot(o: { type: "png"; timeout: number }): Promise<Buffer | Uint8Array>;
  url(): string;
  on(event: "console" | "pageerror", h: (m: unknown) => void): unknown;
}
interface PreviewContext {
  route(pattern: string, h: (route: BrowserRoute) => Promise<void>): Promise<void>;
  routeWebSocket(
    pattern: string,
    h: (route: { close(o: { code: number; reason: string }): Promise<void> }) => Promise<void>,
  ): Promise<void>;
  newPage(): Promise<PreviewPage>;
  on(event: "page", h: (page: PreviewPage) => void): unknown;
  close(): Promise<void>;
}
interface PreviewChrome {
  newContext(o: {
    serviceWorkers: "block";
    extraHTTPHeaders: Record<string, string>;
    viewport: { width: number; height: number };
  }): Promise<PreviewContext>;
  close(): Promise<void>;
}
/** The injected Playwright surface; production loads playwright-core. */
export interface PreviewPlaywright {
  chromium: {
    launch(o: {
      headless: true;
      executablePath: string;
      chromiumSandbox: true;
      timeout: number;
      proxy: { server: string };
    }): Promise<PreviewChrome>;
  };
}

export interface PreviewBrowserOptions {
  executablePath?: string;
  fileExists?: (path: string) => boolean;
  loadPlaywright?: () => Promise<PreviewPlaywright>;
  startProxy?: (origin: string) => Promise<HudProxy>;
  deadlineMs?: number;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}…` : s);

/** Runs the job in this process. Call it through `previewBrowserInHelper` unless testing. */
export async function runPreviewBrowser(
  job: PreviewJob,
  guard: PreviewGuard,
  options: PreviewBrowserOptions = {},
): Promise<PreviewResult> {
  const url = guard.page(job.path);
  const executablePath =
    options.executablePath ?? process.env.MC_BROWSER_EXECUTABLE ?? DEFAULT_CHROME;
  if (!(options.fileExists ?? existsSync)(executablePath))
    throw new Error("Preview browser unavailable: no system Chrome or Chromium executable found.");
  const deadlineMs = options.deadlineMs ?? PREVIEW_DEADLINE_MS;
  const started = Date.now();
  const remaining = (): number => Math.max(1, deadlineMs - (Date.now() - started));
  let proxy: HudProxy | undefined;
  let browser: PreviewChrome | undefined;
  let context: PreviewContext | undefined;
  try {
    let playwright: PreviewPlaywright;
    try {
      playwright = await (
        options.loadPlaywright ??
        (async () => (await import("playwright-core")) as unknown as PreviewPlaywright)
      )();
    } catch (e) {
      throw new Error(`Preview browser unavailable: playwright-core did not load: ${errorText(e)}`);
    }
    proxy = await (options.startProxy ?? startHudProxy)(guard.origin);
    browser = await playwright.chromium.launch({
      headless: true,
      executablePath,
      chromiumSandbox: true,
      timeout: remaining(),
      proxy: { server: `http://${proxy.address}` },
    });
    context = await browser.newContext({
      serviceWorkers: "block",
      // the preview refuses the operator bootstrap to any request carrying this header
      extraHTTPHeaders: { [HUD_RENDERER_HEADER]: "1" },
      viewport: { width: job.width, height: PREVIEW_HEIGHT },
    });
    await context.route("**/*", async (route) => {
      const request = route.request();
      await (guard(request.method(), request.url()) ? route.continue() : route.abort());
    });
    await context.routeWebSocket("**/*", async (route) => {
      await route.close({ code: 1008, reason: "The preview browser blocks WebSockets" });
    });
    const page = await context.newPage();
    context.on("page", (popup) => {
      if (popup !== page) void (popup as unknown as { close(): Promise<void> }).close();
    });
    const report: string[] = [];
    const shots: PreviewShot[] = [];
    page.on("pageerror", (e) => report.push(`page error: ${clip(errorText(e), 300)}`));
    page.on("console", (m) => {
      const msg = m as { type?: () => string; text?: () => string };
      if (msg.type?.() === "error") report.push(`console error: ${clip(msg.text?.() ?? "", 300)}`);
    });
    await page.emulateMedia({ colorScheme: job.theme });
    await page.goto(url, { waitUntil: "load", timeout: remaining() });
    await page.waitForSelector(READY, { state: "attached", timeout: remaining() });
    await page.waitForSelector("main", { state: "attached", timeout: remaining() });
    await page.waitForSelector(LOADING, { state: "detached", timeout: remaining() });
    const shoot = async (label: string): Promise<void> => {
      const png = Buffer.from(await page.screenshot({ type: "png", timeout: remaining() }));
      if (png.byteLength > PREVIEW_SHOT_MAX_BYTES)
        throw new Error(`Screenshot refused: the PNG is over ${PREVIEW_SHOT_MAX_BYTES} bytes.`);
      shots.push({ label, png });
    };
    for (const [i, step] of job.steps.entries()) {
      const n = `step ${i + 1}`;
      try {
        if ("click" in step) {
          await page.locator(step.click).first().click({ timeout: remaining() });
          report.push(`${n}: clicked ${step.click}`);
        } else if ("type" in step) {
          await page.locator(step.type.selector).first().fill(step.type.text, {
            timeout: remaining(),
          });
          report.push(`${n}: typed ${step.type.text.length} characters into ${step.type.selector}`);
        } else if ("read" in step) {
          const text = await page.locator(step.read).first().innerText({ timeout: remaining() });
          report.push(`${n}: text of ${step.read}: ${clip(text, PREVIEW_TEXT_MAX)}`);
        } else if ("measure" in step) {
          const found = await page.locator(step.measure).count();
          const boxes: string[] = [];
          for (const el of (await page.locator(step.measure).all()).slice(0, PREVIEW_MEASURE_MAX)) {
            const b = await el.boundingBox({ timeout: remaining() });
            boxes.push(
              b === null
                ? "hidden"
                : `${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}×${Math.round(b.height)}`,
            );
          }
          report.push(`${n}: ${found} match ${step.measure} (x,y w×h): ${boxes.join("; ")}`);
        } else {
          await shoot(step.screenshot);
          report.push(`${n}: screenshot ${step.screenshot}`);
        }
      } catch (e) {
        // A step that fails is a finding for the reviewer, not the end of the call.
        report.push(`${n} failed: ${clip(errorText(e), 300)}`);
      }
      const now = guard.origin;
      try {
        if (new URL(page.url()).origin !== now) throw new Error("left");
      } catch {
        throw new Error("Refused: the page left the review's preview.");
      }
    }
    report.push(`page ${page.url()}`);
    return { url: page.url(), report, shots };
  } finally {
    await Promise.race([
      Promise.allSettled([
        Promise.resolve().then(() => context?.close()),
        Promise.resolve().then(() => browser?.close()),
        Promise.resolve().then(() => proxy?.close()),
      ]),
      new Promise((resolve) => setTimeout(resolve, PREVIEW_CLOSE_MS)),
    ]);
  }
}

/** What the parent asks the helper to run, and what it answers. */
export interface PreviewHelperJob {
  job: PreviewJob;
  origin: string;
  executablePath?: string;
  deadlineMs: number;
}
export type PreviewHelperReply =
  | { ok: true; url: string; report: string[]; shots: { label: string; png: string }[] }
  | { ok: false; error: string };

export interface PreviewHelperOptions {
  helperPath?: string;
  executablePath?: string;
  deadlineMs?: number;
  graceMs?: number;
}

const HELPER_PATH = fileURLToPath(new URL("./preview-browser-helper.ts", import.meta.url));

function killGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group already exited.
  }
}

/** Runs the job in an owned helper process group, killed however the call ends. */
export function previewBrowserInHelper(
  job: PreviewJob,
  guard: PreviewGuard,
  options: PreviewHelperOptions = {},
): Promise<PreviewResult> {
  // Refused here, before any process starts.
  guard.page(job.path);
  const deadlineMs = options.deadlineMs ?? PREVIEW_DEADLINE_MS;
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
  return new Promise<PreviewResult>((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killGroup(child);
      settle();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Preview browser timed out after ${deadlineMs} ms.`))),
      deadlineMs + (options.graceMs ?? PREVIEW_CLOSE_MS + 2_000),
    );
    child.on("message", (reply: PreviewHelperReply) => {
      if (reply?.ok === true && Array.isArray(reply.shots)) {
        const result: PreviewResult = {
          url: reply.url,
          report: reply.report,
          shots: reply.shots.map((s) => ({ label: s.label, png: Buffer.from(s.png, "base64") })),
        };
        finish(() => resolve(result));
      } else {
        const error = reply?.ok === false ? reply.error : "";
        finish(() => reject(new Error(error || "Preview browser failed.")));
      }
    });
    child.on("error", (e) =>
      finish(() => reject(new Error(`Preview browser failed: ${errorText(e)}`))),
    );
    child.on("exit", () =>
      finish(() => reject(new Error("Preview browser failed: the process exited."))),
    );
    const message: PreviewHelperJob = {
      job,
      origin: guard.origin,
      deadlineMs,
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
    };
    child.send(message);
  });
}
