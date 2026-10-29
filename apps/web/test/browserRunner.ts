// Renders a web page in a real headless browser at a chosen viewport width and measures elements,
// so a layout test checks what the cascade, `transform` and `overflow` actually do rather than
// parsing CSS declarations. Import it only from `*.browser.test.ts` files (node environment).
//
// The page is a Vite production build of a harness entry (`test/*Browser.html`), served to the
// browser through request interception on a made-up origin: no port is opened, so it runs inside a
// seat's sandbox, which refuses local listeners.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterAll, beforeAll, describe } from "vitest";

/** An element's box in CSS pixels, relative to the viewport. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RenderedPage {
  /** The first element matching `selector`; throws if there is none. */
  box(selector: string): Promise<Box>;
  /** Every element matching `selector`, in document order; throws if there is none. */
  boxes(selector: string): Promise<Box[]>;
  /** Runs `fn` in the page and returns its result. */
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  /** Clicks the first element matching `selector`. */
  click(selector: string): Promise<void>;
  /** Writes a PNG of the whole viewport to `path`. */
  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
}

export interface RenderOptions {
  /** The harness page, such as `test/accountsBrowser.html`, relative to `apps/web`. */
  page: string;
  /** The viewport width in CSS pixels. */
  width: number;
  height?: number;
  /** JSON answers by request path and query (`/api/limits`); any other request is a 404. */
  api?: Record<string, unknown>;
}

interface Route {
  request(): { url(): string };
  fulfill(options: { status?: number; contentType?: string; body: string | Buffer }): Promise<void>;
}
interface Page {
  route(url: RegExp, handler: (route: Route) => Promise<void>): Promise<void>;
  goto(url: string, options: { waitUntil: "load" }): Promise<unknown>;
  waitForSelector(selector: string): Promise<unknown>;
  evaluate<T, A>(fn: (arg: A) => T, arg: A): Promise<T>;
  click(selector: string): Promise<void>;
  screenshot(options: { path: string }): Promise<unknown>;
  close(): Promise<void>;
}
interface Browser {
  newPage(options: { viewport: { width: number; height: number } }): Promise<Page>;
  close(): Promise<void>;
}
interface Chromium {
  launch(options: { executablePath: string; headless: boolean; args?: string[] }): Promise<Browser>;
}

const { chromium } = createRequire(new URL("../../server/package.json", import.meta.url))(
  "playwright-core",
) as { chromium: Chromium };

const WEB_ROOT = fileURLToPath(new URL("../", import.meta.url));
/** A made-up origin: every request to it is answered from the build or the `api` map. */
const ORIGIN = "http://mc.test";
const DEFAULT_HEIGHT = 900;
// A cold Vite build and browser start on a loaded runner can exceed Vitest's 10 s hook default.
export const COLD_START_TIMEOUT_MS = 60_000;
// The first page load of a test can outlast Vitest's 5 s test default on a loaded runner.
export const BROWSER_TEST_TIMEOUT_MS = 60_000;

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".svg": "image/svg+xml",
};

/** Playwright's own cached headless shells (`playwright-core install chromium`), newest first. */
function cachedHeadlessShells(): string[] {
  const root =
    process.platform === "darwin"
      ? join(homedir(), "Library/Caches/ms-playwright")
      : join(homedir(), ".cache/ms-playwright");
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => name.startsWith("chromium_headless_shell-"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .flatMap((name) =>
      readdirSync(join(root, name))
        .filter((dir) => dir.startsWith("chrome-headless-shell"))
        .map((dir) => join(root, name, dir, "chrome-headless-shell")),
    );
}

const BROWSER = [
  process.env.MC_BROWSER_EXECUTABLE,
  ...cachedHeadlessShells(),
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((path): path is string => path !== undefined && existsSync(path));

/** Without a browser a local run skips; CI fails, so a layout check can never pass unrendered. */
const MUST_RUN = Boolean(process.env.CI);
const SKIP = !BROWSER && !MUST_RUN;

/** `describe` for rendered tests: skipped locally when no browser is installed, never on CI. */
export const describeRendered = (name: string, body: () => void) =>
  describe.skipIf(SKIP)(name, body);

// A seat's sandbox forbids the Mach port registration Chromium's multi-process mode needs; a
// single-process browser avoids it.
const SANDBOX_FALLBACK_ARGS = ["--single-process", "--no-zygote", "--disable-gpu"];

async function launch(executablePath: string): Promise<Browser> {
  try {
    return await chromium.launch({ executablePath, headless: true });
  } catch {
    return chromium.launch({ executablePath, headless: true, args: SANDBOX_FALLBACK_ARGS });
  }
}

/** Builds the harness pages once. */
async function buildHarness(outDir: string): Promise<void> {
  const pages = readdirSync(join(WEB_ROOT, "test"))
    .filter((file) => file.endsWith("Browser.html"))
    .map((file) => join(WEB_ROOT, "test", file));
  await build({
    root: WEB_ROOT,
    configFile: join(WEB_ROOT, "vite.config.ts"),
    logLevel: "silent",
    build: { outDir, emptyOutDir: true, rollupOptions: { input: pages } },
  });
}

/**
 * Call once at the top of a `*.browser.test.ts`; returns `renderAt`, which opens a harness page
 * at a given width. The harness build is shared by the file's tests; each page gets its own browser.
 */
export function browserSession(): { renderAt(options: RenderOptions): Promise<RenderedPage> } {
  let outDir: string | undefined;

  beforeAll(async () => {
    if (SKIP) return;
    if (!BROWSER) {
      throw new Error(
        "No headless browser found on CI. Install Chrome or Chromium, or set MC_BROWSER_EXECUTABLE.",
      );
    }
    outDir = await mkdtemp(join(tmpdir(), "mc-web-harness-"));
    await buildHarness(outDir);
  }, COLD_START_TIMEOUT_MS);

  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
  }, COLD_START_TIMEOUT_MS);

  return {
    async renderAt({ page: entry, width, height = DEFAULT_HEIGHT, api = {} }) {
      if (!BROWSER || !outDir) throw new Error("the harness did not build");
      const root = outDir;
      // One browser per page: a single-process browser (the sandbox fallback) dies with its page.
      const browser = await launch(BROWSER);
      const page = await browser.newPage({ viewport: { width, height } });
      await page.route(new RegExp(`^${ORIGIN}/`), async (route) => {
        const url = new URL(route.request().url());
        const key = `${url.pathname}${url.search}`;
        if (key in api) {
          await route.fulfill({ contentType: "application/json", body: JSON.stringify(api[key]) });
          return;
        }
        const file = normalize(join(root, url.pathname));
        if (file.startsWith(root) && existsSync(file) && !url.pathname.startsWith("/api/")) {
          await route.fulfill({
            contentType: MIME[extname(file)] ?? "application/octet-stream",
            body: readFileSync(file),
          });
          return;
        }
        await route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: "not found" }),
        });
      });
      await page.goto(`${ORIGIN}/${entry}`, { waitUntil: "load" });
      const measure = (selector: string) =>
        page.evaluate(
          (css) =>
            [...document.querySelectorAll(css)].map((element) => {
              const { x, y, width, height } = element.getBoundingClientRect();
              return { x, y, width, height };
            }),
          selector,
        );
      const boxes = async (selector: string) => {
        await page.waitForSelector(selector);
        return measure(selector);
      };
      return {
        boxes,
        async box(selector) {
          return (await boxes(selector))[0];
        },
        evaluate: (fn, arg) => page.evaluate(fn, arg),
        click: (selector) => page.click(selector),
        screenshot: async (path) => {
          await page.screenshot({ path });
        },
        close: () => browser.close(),
      };
    },
  };
}
