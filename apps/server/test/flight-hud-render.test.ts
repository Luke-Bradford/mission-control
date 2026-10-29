import { HUD_RENDERER_HEADER, OPERATOR_BOOTSTRAP_PATH } from "@mc/core";
import { describe, expect, it, vi } from "vitest";
import {
  HUD_RENDER_DEADLINE_MS,
  HUD_SCREENSHOT_MAX_BYTES,
  type HudPlaywright,
  hudRenderRequest,
  renderHudWithPlaywright,
} from "../src/flight/hud-render.ts";

const URL = "http://127.0.0.1:7420/map";

class FakeRoute {
  readonly continued = vi.fn(async () => {});
  readonly aborted = vi.fn(async () => {});
  private readonly method: string;
  private readonly target: string;

  constructor(method: string, target: string) {
    this.method = method;
    this.target = target;
  }

  request() {
    return { method: () => this.method, url: () => this.target };
  }
  continue() {
    return this.continued();
  }
  abort() {
    return this.aborted();
  }
}

function fakePlaywright(
  over: {
    screenshot?: Buffer | (() => Promise<Buffer>);
    goto?: () => Promise<void>;
    pageUrl?: string;
    close?: () => Promise<void>;
  } = {},
) {
  const order: string[] = [];
  let requestHandler: ((route: FakeRoute) => Promise<void>) | undefined;
  let websocketHandler: ((route: { close: ReturnType<typeof vi.fn> }) => Promise<void>) | undefined;
  let pageHandler: ((page: { close(): Promise<void> }) => void) | undefined;
  const popupClose = vi.fn(async () => {});
  const page = {
    goto: vi.fn(async () => {
      order.push("goto");
      pageHandler?.({ close: popupClose });
      await over.goto?.();
    }),
    waitForFunction: vi.fn(async () => {}),
    screenshot: vi.fn(async () =>
      typeof over.screenshot === "function"
        ? over.screenshot()
        : (over.screenshot ?? Buffer.from("png")),
    ),
    url: vi.fn(() => over.pageUrl ?? URL),
  };
  const contextClose = vi.fn(over.close ?? (async () => {}));
  const context = {
    route: vi.fn(async (_pattern: string, handler: typeof requestHandler) => {
      order.push("route");
      requestHandler = handler;
    }),
    routeWebSocket: vi.fn(async (_pattern: string, handler: typeof websocketHandler) => {
      order.push("websocket");
      websocketHandler = handler;
    }),
    newPage: vi.fn(async () => {
      order.push("page");
      return page;
    }),
    on: vi.fn((event: string, handler: typeof pageHandler) => {
      if (event === "page") pageHandler = handler;
    }),
    close: contextClose,
  };
  const browserClose = vi.fn(over.close ?? (async () => {}));
  const browser = {
    newContext: vi.fn(async () => context),
    close: browserClose,
  };
  const kill = vi.fn();
  const serverClose = vi.fn(over.close ?? (async () => {}));
  const server = {
    wsEndpoint: vi.fn(() => "ws://browser"),
    process: vi.fn(() => ({ kill })),
    close: serverClose,
  };
  const chromium = {
    launchServer: vi.fn(async () => server),
    connect: vi.fn(async () => browser),
  };
  return {
    playwright: { chromium } as unknown as HudPlaywright,
    chromium,
    browser,
    context,
    page,
    order,
    popupClose,
    contextClose,
    browserClose,
    serverClose,
    kill,
    request: (method: string, url: string) => {
      if (!requestHandler) throw new Error("request route not installed");
      const route = new FakeRoute(method, url);
      return requestHandler(route).then(() => route);
    },
    websocket: async () => {
      if (!websocketHandler) throw new Error("websocket route not installed");
      const route = { close: vi.fn(async () => {}) };
      await websocketHandler(route);
      return route;
    },
  };
}

const options = (playwright: HudPlaywright) => ({
  executablePath: "/chrome",
  fileExists: () => true,
  loadPlaywright: async () => playwright,
});

describe("hudRenderRequest", () => {
  it("permits only GET requests to the hub origin", () => {
    const guard = hudRenderRequest("http://127.0.0.1:7420");
    expect(guard("GET", URL)).toBe(true);
    expect(guard("POST", "http://127.0.0.1:7420/api/board")).toBe(false);
    expect(guard("GET", "https://example.test/")).toBe(false);
  });

  it("rejects non-HUD pages before launching a browser", () => {
    const guard = hudRenderRequest("http://127.0.0.1:7420");
    expect(guard.page("/map")).toBe(URL);
    expect(() => guard.page("/mcp")).toThrow("HUD page");
    expect(() => guard.page("https://example.test/")).toThrow("HUD page");
  });
});

describe("renderHudWithPlaywright", () => {
  it("sandboxes Chrome and installs context routes before creating the main page", async () => {
    const fake = fakePlaywright();
    const png = await renderHudWithPlaywright(URL, hudRenderRequest(URL), options(fake.playwright));

    expect(png).toEqual(Buffer.from("png"));
    expect(fake.chromium.launchServer).toHaveBeenCalledWith(
      expect.objectContaining({
        headless: true,
        executablePath: "/chrome",
        chromiumSandbox: true,
        timeout: HUD_RENDER_DEADLINE_MS,
      }),
    );
    expect(fake.chromium.launchServer).toHaveBeenCalledWith(
      expect.objectContaining({ host: "127.0.0.1" }),
    );
    expect(fake.browser.newContext).toHaveBeenCalledWith({
      serviceWorkers: "block",
      extraHTTPHeaders: { [HUD_RENDERER_HEADER]: "1" },
      viewport: { width: 1600, height: 1000 },
    });
    expect(fake.order).toEqual(["route", "websocket", "page", "goto"]);
    expect(fake.page.goto).toHaveBeenCalledWith(URL, {
      waitUntil: "load",
      timeout: expect.any(Number),
    });
    expect(fake.page.waitForFunction).toHaveBeenCalledWith(
      "document.documentElement.dataset.hudReady === '1'",
      undefined,
      { timeout: expect.any(Number) },
    );
    expect(fake.popupClose).toHaveBeenCalledOnce();
    expect((await fake.websocket()).close).toHaveBeenCalledWith({
      code: 1008,
      reason: "HUD screenshot blocks WebSockets",
    });
  });

  it("aborts bootstrap, SSE and every non-GET before consulting the generic guard", async () => {
    const fake = fakePlaywright();
    const base = hudRenderRequest(URL);
    const guard = Object.assign(vi.fn(base), { page: base.page });
    await renderHudWithPlaywright(URL, guard, options(fake.playwright));

    const bootstrap = await fake.request("GET", `http://127.0.0.1:7420${OPERATOR_BOOTSTRAP_PATH}`);
    const stream = await fake.request("GET", "http://127.0.0.1:7420/api/stream");
    const post = await fake.request("POST", "http://127.0.0.1:7420/api/board");
    expect(bootstrap.aborted).toHaveBeenCalledOnce();
    expect(stream.aborted).toHaveBeenCalledOnce();
    expect(post.aborted).toHaveBeenCalledOnce();
    for (const spelling of [
      "/api/operator/%62ootstrap",
      "/API/Operator/Bootstrap",
      "/api/operator/bootstrap/",
      "/api/%73tream",
      "/api/operator/%E0%A4%A",
    ]) {
      const variant = await fake.request("GET", `http://127.0.0.1:7420${spelling}`);
      expect(variant.aborted).toHaveBeenCalledOnce();
    }
    expect(guard).not.toHaveBeenCalled();

    const asset = await fake.request("GET", "http://127.0.0.1:7420/assets/app.js");
    expect(asset.continued).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledOnce();
    expect(JSON.stringify({ png: Buffer.from("png").toString("base64") })).not.toContain(
      "operator-secret",
    );
  });

  it("checks the main-frame URL immediately before capture", async () => {
    const fake = fakePlaywright({ pageUrl: "https://example.test/stolen" });
    await expect(
      renderHudWithPlaywright(URL, hudRenderRequest(URL), options(fake.playwright)),
    ).rejects.toThrow("left the hub origin");
    expect(fake.page.screenshot).not.toHaveBeenCalled();
  });

  it.each(["navigation", "screenshot"])(
    "closes on the overall deadline during %s and kills Chrome when close hangs",
    async (stage) => {
      const never = () => new Promise<void>(() => {});
      const fake = fakePlaywright({
        ...(stage === "navigation"
          ? { goto: never }
          : { screenshot: () => new Promise<Buffer>(() => {}) }),
        close: never,
      });
      await expect(
        renderHudWithPlaywright(URL, hudRenderRequest(URL), {
          ...options(fake.playwright),
          deadlineMs: 10,
          closeTimeoutMs: 10,
        }),
      ).rejects.toThrow("timed out");
      expect(fake.contextClose).toHaveBeenCalledOnce();
      expect(fake.browserClose).toHaveBeenCalledOnce();
      expect(fake.serverClose).toHaveBeenCalledOnce();
      expect(fake.kill).toHaveBeenCalledWith("SIGKILL");
    },
  );

  it("refuses an oversized PNG", async () => {
    const fake = fakePlaywright({ screenshot: Buffer.alloc(HUD_SCREENSHOT_MAX_BYTES + 1) });
    await expect(
      renderHudWithPlaywright(URL, hudRenderRequest(URL), options(fake.playwright)),
    ).rejects.toThrow("exceeds");
  });

  it("fails closed for missing Chrome, a missing package, and other initialization failures", async () => {
    const fake = fakePlaywright();
    await expect(
      renderHudWithPlaywright(URL, hudRenderRequest(URL), {
        ...options(fake.playwright),
        fileExists: () => false,
      }),
    ).rejects.toThrow("no system Chrome");
    expect(fake.chromium.launchServer).not.toHaveBeenCalled();

    const missing = Object.assign(new Error("Cannot find package 'playwright-core'"), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    await expect(
      renderHudWithPlaywright(URL, hudRenderRequest(URL), {
        ...options(fake.playwright),
        loadPlaywright: async () => Promise.reject(missing),
      }),
    ).rejects.toThrow("playwright-core is not installed");
    await expect(
      renderHudWithPlaywright(URL, hudRenderRequest(URL), {
        ...options(fake.playwright),
        loadPlaywright: async () => Promise.reject(new Error("loader policy refused")),
      }),
    ).rejects.toThrow("could not initialize playwright-core: loader policy refused");
  });
});
