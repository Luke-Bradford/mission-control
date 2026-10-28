/** URL confinement shared by the HUD renderer and its tests. */
import { existsSync } from "node:fs";

const HUD_PATH =
  /^\/(?:$|map(?:\/|$)|overview(?:\/|$)|board(?:\/|$)|flight(?:\/|$)|telemetry(?:\/|$)|comms(?:\/|$)|agents?(?:\/|$)|setup(?:\/|$))/;

export interface HudRenderGuard {
  (method: string, url: string): boolean;
  page(path: string): string;
}

/**
 * The browser is deliberately only allowed to fetch GET resources from this hub.  Keeping this
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
interface HudBrowser {
  newPage(options: { viewport: { width: number; height: number } }): Promise<{
    route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
    goto(url: string, options: { waitUntil: "networkidle" }): Promise<void>;
    screenshot(options: { type: "png" }): Promise<Buffer>;
  }>;
  close(): Promise<void>;
}
interface PlaywrightCore {
  chromium: { launch(options: { headless: true; executablePath?: string }): Promise<HudBrowser> };
}

/** Route interception is installed before navigation, blocking every non-GET and off-origin request. */
export async function renderHudWithPlaywright(url: string, guard: HudRenderGuard): Promise<string> {
  const executablePath =
    process.env.MC_BROWSER_EXECUTABLE ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (!existsSync(executablePath))
    throw new Error("HUD screenshot unavailable: no system Chrome or Chromium executable found.");
  let chromium: PlaywrightCore["chromium"];
  try {
    const load = Function("return import('playwright-core')") as () => Promise<PlaywrightCore>;
    ({ chromium } = await load());
  } catch {
    throw new Error("HUD screenshot unavailable: playwright-core is not installed.");
  }
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.route("**/*", async (route) => {
      const request = route.request();
      await (guard(request.method(), request.url()) ? route.continue() : route.abort());
    });
    await page.goto(url, { waitUntil: "networkidle" });
    return `data:image/png;base64,${(await page.screenshot({ type: "png" })).toString("base64")}`;
  } finally {
    await browser.close();
  }
}
