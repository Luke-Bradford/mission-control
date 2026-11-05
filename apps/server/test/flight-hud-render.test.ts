import {
  HUD_PAGE_PATHS,
  HUD_RENDERER_HEADER,
  OPERATOR_BOOTSTRAP_PATH,
  QA_DISCLOSURE_LABEL,
} from "@mc/core";
import { describe, expect, it, vi } from "vitest";
import {
  HUD_RENDER_DEADLINE_MS,
  HUD_SCREENSHOT_MAX_BYTES,
  type HudPlaywright,
  hudRenderRequest,
  renderHudWithPlaywright,
} from "../src/flight/hud-render.ts";

const URL = "http://127.0.0.1:7420/map";

describe("hudRenderRequest page allowlist", () => {
  const guard = hudRenderRequest("http://127.0.0.1:7420");

  it("accepts every HUD page in the nav, Audit included", () => {
    for (const path of Object.values(HUD_PAGE_PATHS))
      expect(guard.page(path)).toBe(new globalThis.URL(path, guard.origin).toString());
    expect(guard.page("/audit")).toBe("http://127.0.0.1:7420/audit");
    expect(guard.page("/agents/x")).toBe("http://127.0.0.1:7420/agents/x");
  });

  it("still refuses an unknown or look-alike path", () => {
    for (const path of ["/unknown", "/auditing", "/audit-x", "/api/health"])
      expect(() => guard.page(path)).toThrow("HUD page required");
  });
});

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

interface FakeLocator {
  count(): Promise<number>;
  last(): FakeLocator;
  evaluate(fn: unknown): Promise<void>;
}

function fakePlaywright(
  over: {
    screenshot?: Buffer | (() => Promise<Buffer>);
    goto?: () => Promise<void>;
    pageUrl?: string;
    close?: () => Promise<void>;
    /** Resolves the page-level readiness wait; absent: the page is ready at once. */
    pageReady?: Promise<void>;
  } = {},
) {
  const order: string[] = [];
  let requestHandler: ((route: FakeRoute) => Promise<void>) | undefined;
  let websocketHandler: ((route: { close: ReturnType<typeof vi.fn> }) => Promise<void>) | undefined;
  let pageHandler: ((page: { close(): Promise<void> }) => void) | undefined;
  const popupClose = vi.fn(async () => {});
  const pageEvents = new Map<string, Array<() => void>>();
  const fakeLocator = (selector: string): FakeLocator => ({
    count: async () => 1,
    last: () => fakeLocator(selector),
    evaluate: async () => {
      order.push(`scroll ${selector}`);
    },
  });
  const page = {
    click: vi.fn(async (_selector: string) => {
      order.push("click");
    }),
    goto: vi.fn(async () => {
      order.push("goto");
      pageHandler?.({ close: popupClose });
      await over.goto?.();
    }),
    waitForSelector: vi.fn(async (selector: string) => {
      const step = selector.includes("hud-ready")
        ? "hudReady"
        : selector.includes("Loading")
          ? "pageReady"
          : "main";
      order.push(step);
      if (step === "pageReady") await over.pageReady;
    }),
    // a page that already shows the QA view (an older baseline), unless a test says otherwise
    locator: vi.fn((selector: string) => fakeLocator(selector)),
    on: vi.fn((event: string, handler: () => void) => {
      pageEvents.set(event, [...(pageEvents.get(event) ?? []), handler]);
    }),
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
  const proxyClose = vi.fn(async () => {});
  const chromium = {
    launch: vi.fn(async () => browser),
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
    proxyClose,
    emit: (event: string) => {
      for (const h of pageEvents.get(event) ?? []) h();
    },
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

const options = (playwright: HudPlaywright, proxyClose = vi.fn(async () => {})) => ({
  executablePath: "/chrome",
  fileExists: () => true,
  loadPlaywright: async () => playwright,
  startProxy: async () => ({ address: "127.0.0.1:9999", close: proxyClose }),
  quietMs: 5,
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
  it("captures the old Audit readiness view when main predates the QA route", async () => {
    const url = "http://127.0.0.1:7420/qa";
    const fake = fakePlaywright({ pageUrl: "http://127.0.0.1:7420/audit" });
    await renderHudWithPlaywright(url, hudRenderRequest(url), options(fake.playwright));
    expect(fake.page.goto).toHaveBeenCalledTimes(2);
    expect(fake.page.click).toHaveBeenCalledWith(
      '[aria-label="QA view"] button:text-is("PR readiness")',
      expect.anything(),
    );
  });
  it("waits for the old baseline's Audit page to be ready before it reads the QA view", async () => {
    const url = "http://127.0.0.1:7420/qa";
    const fake = fakePlaywright({ pageUrl: "http://127.0.0.1:7420/audit" });
    await renderHudWithPlaywright(url, hudRenderRequest(url), options(fake.playwright));
    const afterRedirect = fake.order.slice(fake.order.lastIndexOf("goto"));
    expect(afterRedirect).toEqual([
      "goto",
      "hudReady",
      "main",
      "pageReady",
      "main",
      "click",
      "main",
      "pageReady",
      `scroll section:has([aria-label="QA view"])`,
    ]);
    // the QA view or its disclosure was waited for (the page may still be drawing) before the
    // view was counted, and with the view present the disclosure was not clicked
    const waited = fake.page.waitForSelector.mock.calls.map((c) => c[0]);
    expect(waited).toContain(`[aria-label="QA view"], button:text-is("${QA_DISCLOSURE_LABEL}")`);
    expect(fake.page.click).toHaveBeenCalledTimes(1);
  });
  it("says which selector never appeared when the render times out", async () => {
    const url = "http://127.0.0.1:7420/audit?evidence-tab=readiness";
    const fake = fakePlaywright({ pageUrl: url });
    fake.page.waitForSelector.mockImplementation(async (selector: string) => {
      if (selector.startsWith('[aria-label="QA view"],'))
        throw Object.assign(new Error("Timeout 30000ms exceeded."), { name: "TimeoutError" });
    });
    await expect(
      renderHudWithPlaywright(url, hudRenderRequest(url), options(fake.playwright)),
    ).rejects.toThrow(
      /timed out: the \d+ ms deadline expired while waiting for \[aria-label="QA view"\], button:text-is\("Workflow history and earlier proposals"\) \(attached\)\./,
    );
  });
  it("says which click timed out", async () => {
    const url = "http://127.0.0.1:7420/audit?evidence-tab=hotspots";
    const fake = fakePlaywright({ pageUrl: url });
    fake.page.click.mockRejectedValue(
      Object.assign(new Error("Timeout"), { name: "TimeoutError" }),
    );
    await expect(
      renderHudWithPlaywright(url, hudRenderRequest(url), options(fake.playwright)),
    ).rejects.toThrow(
      /while waiting for click \[aria-label="QA view"\] button:text-is\("Hotspots"\)\./,
    );
  });
  it("scrolls the section that holds the QA control to the top, after the tab settles and before the shot", async () => {
    const url = "http://127.0.0.1:7420/audit?evidence-tab=readiness";
    const fake = fakePlaywright({ pageUrl: url });
    fake.page.screenshot.mockImplementation(async () => {
      fake.order.push("screenshot");
      return Buffer.from("png");
    });
    await renderHudWithPlaywright(url, hudRenderRequest(url), options(fake.playwright));
    const scroll = fake.order.findIndex((step) => step.startsWith("scroll "));
    expect(fake.order[scroll]).toBe('scroll section:has([aria-label="QA view"])');
    expect(scroll).toBeGreaterThan(fake.order.lastIndexOf("click"));
    expect(scroll).toBeGreaterThan(fake.order.lastIndexOf("pageReady", scroll - 1));
    expect(scroll).toBeLessThan(fake.order.indexOf("screenshot"));
  });
  it("scrolls the control itself when an older baseline has no section around it", async () => {
    const url = "http://127.0.0.1:7420/audit?evidence-tab=hotspots";
    const fake = fakePlaywright({ pageUrl: url });
    fake.page.locator.mockImplementation((selector: string) => {
      const locator: FakeLocator = {
        count: async () => (selector.startsWith("section:") ? 0 : 1),
        last: () => locator,
        evaluate: async () => {
          fake.order.push(`scroll ${selector}`);
        },
      };
      return locator;
    });
    await renderHudWithPlaywright(url, hudRenderRequest(url), options(fake.playwright));
    expect(fake.order).toContain('scroll [aria-label="QA view"]');
  });
  it("selects non-default Audit views before capturing them", async () => {
    for (const [tab, label] of [
      ["readiness", "PR readiness"],
      ["hotspots", "Hotspots"],
    ]) {
      const url = `http://127.0.0.1:7420/audit?evidence-tab=${tab}`;
      const fake = fakePlaywright({ pageUrl: url });
      await renderHudWithPlaywright(url, hudRenderRequest(url), options(fake.playwright));
      expect(fake.page.click).toHaveBeenCalledWith(
        `[aria-label="QA view"] button:text-is("${label}")`,
        expect.anything(),
      );
      expect(fake.order.indexOf("click")).toBeGreaterThan(fake.order.indexOf("pageReady"));
      expect(fake.page.screenshot).toHaveBeenCalledOnce();
    }
  });
  it("opens the Audit workflow-history disclosure first when the QA view control is behind it", async () => {
    for (const [tab, label] of [
      ["readiness", "PR readiness"],
      ["hotspots", "Hotspots"],
    ]) {
      const url = `http://127.0.0.1:7420/audit?evidence-tab=${tab}`;
      const fake = fakePlaywright({ pageUrl: url });
      let open = false;
      fake.page.click.mockImplementation(async (selector: string) => {
        fake.order.push(`click:${selector}`);
        if (selector.includes("Workflow history")) open = true;
        else if (!open) throw new Error("clicked a control that is not on the page");
      });
      Object.assign(fake.page, {
        locator: vi.fn(() => {
          const locator: FakeLocator = {
            count: async () => (open ? 1 : 0),
            last: () => locator,
            evaluate: async () => {},
          };
          return locator;
        }),
      });
      await renderHudWithPlaywright(url, hudRenderRequest(url), options(fake.playwright));
      const clicks = fake.order.filter((step) => step.startsWith("click:"));
      expect(clicks).toEqual([
        `click:button:text-is("${QA_DISCLOSURE_LABEL}")`,
        `click:[aria-label="QA view"] button:text-is("${label}")`,
      ]);
      expect(fake.page.screenshot).toHaveBeenCalledOnce();
    }
  });
  it("opens the page in the colour scheme it is asked for, and in none when it is not", async () => {
    const dark = fakePlaywright();
    await renderHudWithPlaywright(URL, hudRenderRequest(URL), {
      ...options(dark.playwright),
      colorScheme: "dark",
    });
    expect(dark.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ colorScheme: "dark" }),
    );
    const plain = fakePlaywright();
    await renderHudWithPlaywright(URL, hudRenderRequest(URL), options(plain.playwright));
    const opened = (plain.browser.newContext.mock.calls as unknown as [object][])[0]?.[0];
    expect(opened).not.toHaveProperty("colorScheme");
  });

  it("sandboxes Chrome and installs context routes before creating the main page", async () => {
    const fake = fakePlaywright();
    const png = await renderHudWithPlaywright(URL, hudRenderRequest(URL), options(fake.playwright));

    expect(png).toEqual(Buffer.from("png"));
    // launch() (a private pipe), never launchServer() (a control socket), behind the hub-only proxy
    expect(fake.chromium).not.toHaveProperty("launchServer");
    expect(fake.chromium.launch).toHaveBeenCalledWith({
      headless: true,
      executablePath: "/chrome",
      chromiumSandbox: true,
      timeout: expect.any(Number),
      proxy: { server: "http://127.0.0.1:9999" },
    });
    const launched = (fake.chromium.launch.mock.calls as unknown as [{ timeout: number }][])[0];
    expect(launched?.[0].timeout).toBeLessThanOrEqual(HUD_RENDER_DEADLINE_MS);
    expect(fake.browser.newContext).toHaveBeenCalledWith({
      serviceWorkers: "block",
      extraHTTPHeaders: { [HUD_RENDERER_HEADER]: "1" },
      viewport: { width: 1600, height: 1000 },
    });
    expect(fake.order).toEqual([
      "route",
      "websocket",
      "page",
      "goto",
      "hudReady",
      "main",
      "pageReady",
      "pageReady",
    ]);
    expect(fake.page.goto).toHaveBeenCalledWith(URL, {
      waitUntil: "load",
      timeout: expect.any(Number),
    });
    expect(fake.page.waitForSelector).toHaveBeenCalledWith("html[data-hud-ready='1']", {
      state: "attached",
      timeout: expect.any(Number),
    });
    expect(fake.popupClose).toHaveBeenCalledOnce();
    expect((await fake.websocket()).close).toHaveBeenCalledWith({
      code: 1008,
      reason: "HUD screenshot blocks WebSockets",
    });
  });

  it("aborts bootstrap, SSE and every non-GET before consulting the generic guard", async () => {
    const fake = fakePlaywright();
    const base = hudRenderRequest(URL);
    const guard = Object.assign(vi.fn(base), { page: base.page, origin: base.origin });
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
    "closes on the overall deadline during %s even when close hangs",
    async (stage) => {
      const never = () => new Promise<void>(() => {});
      const proxyClose = vi.fn(never);
      const fake = fakePlaywright({
        ...(stage === "navigation"
          ? { goto: never }
          : { screenshot: () => new Promise<Buffer>(() => {}) }),
        close: never,
      });
      await expect(
        renderHudWithPlaywright(URL, hudRenderRequest(URL), {
          ...options(fake.playwright, proxyClose),
          deadlineMs: 10,
          closeTimeoutMs: 10,
        }),
      ).rejects.toThrow("timed out");
      expect(fake.contextClose).toHaveBeenCalledOnce();
      expect(fake.browserClose).toHaveBeenCalledOnce();
      expect(proxyClose).toHaveBeenCalledOnce();
    },
  );

  it("reports the deadline, not the closed browser, when it expires while the page is being created", async () => {
    const fake = fakePlaywright();
    // Chrome is still starting: the page only appears after the deadline closed the browser
    // and, as in Playwright, closing the context fails the pending call at once, before the
    // deadline's own cleanup has finished
    fake.context.newPage.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fake.contextClose.mockImplementationOnce(async () => {
            reject(
              new Error("browserContext.newPage: Target page, context or browser has been closed"),
            );
            await new Promise((r) => setTimeout(r, 40));
          });
        }),
    );
    const failure = await renderHudWithPlaywright(URL, hudRenderRequest(URL), {
      ...options(fake.playwright),
      deadlineMs: 10,
    }).catch((e: Error) => e);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("deadline");
    expect((failure as Error).message).not.toContain("closed");
  });

  it("waits for the requested page to render and the network to settle before capture", async () => {
    let release: () => void = () => {};
    const pageReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakePlaywright({ pageReady });
    const render = renderHudWithPlaywright(URL, hudRenderRequest(URL), options(fake.playwright));
    await vi.waitFor(() => expect(fake.order).toContain("pageReady"));
    await new Promise((r) => setTimeout(r, 30));
    // the shell is ready but the lazy page's placeholder is still up: no capture yet
    expect(fake.page.screenshot).not.toHaveBeenCalled();
    release();
    await render;
    expect(fake.page.screenshot).toHaveBeenCalledOnce();
    // selectors only: the hub's CSP forbids the page-evaluated strings waitForFunction would send
    expect(fake.page).not.toHaveProperty("waitForFunction");
    expect(fake.page.waitForSelector).toHaveBeenCalledWith("main p:text-is('Loading…')", {
      state: "detached",
      timeout: expect.any(Number),
    });
  });

  it("holds the capture while a page request is still in flight", async () => {
    const fake = fakePlaywright();
    fake.page.goto.mockImplementationOnce(async () => {
      fake.emit("request"); // a data fetch that has not answered
    });
    const render = renderHudWithPlaywright(URL, hudRenderRequest(URL), options(fake.playwright));
    await new Promise((r) => setTimeout(r, 60));
    expect(fake.page.screenshot).not.toHaveBeenCalled();
    fake.emit("requestfinished");
    await render;
    expect(fake.page.screenshot).toHaveBeenCalledOnce();
  });

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
    expect(fake.chromium.launch).not.toHaveBeenCalled();

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
