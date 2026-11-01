import { OPERATOR_BOOTSTRAP_PATH } from "@mc/core";
import { describe, expect, it, vi } from "vitest";
import {
  type PreviewJob,
  type PreviewPlaywright,
  previewRequest,
  runPreviewBrowser,
} from "../src/preview-browser.ts";

const ORIGIN = "http://127.0.0.1:7431";

describe("previewRequest", () => {
  const guard = previewRequest(ORIGIN);

  it("accepts requests to the preview's origin only", () => {
    expect(guard("GET", `${ORIGIN}/needs-you`)).toBe(true);
    expect(guard("POST", `${ORIGIN}/api/anything`)).toBe(true);
    for (const url of [
      "http://127.0.0.1:7432/",
      "https://127.0.0.1:7431/",
      "http://localhost:7431/",
      "http://127.0.0.1:7420/",
      "http://evil.example/",
      "http://127.0.0.1:7431.evil.example/",
      "http://user@evil.example:7431/",
      "file:///etc/passwd",
      "data:text/html,hi",
      "not a url",
    ])
      expect(guard("GET", url), url).toBe(false);
  });

  it("never carries the operator's token or the live stream", () => {
    expect(guard("GET", `${ORIGIN}${OPERATOR_BOOTSTRAP_PATH}`)).toBe(false);
    expect(guard("GET", `${ORIGIN}/api/stream`)).toBe(false);
  });

  it("turns a path into a preview URL and refuses one that leaves the origin", () => {
    expect(guard.page("/needs-you?x=1")).toBe(`${ORIGIN}/needs-you?x=1`);
    for (const path of ["//evil.example/", "http://evil.example/", "evil", "", "/\\\\evil.example"])
      expect(() => guard.page(path), path).toThrow();
  });
});

class FakeRoute {
  continued = vi.fn(async () => {});
  aborted = vi.fn(async () => {});
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

function fake() {
  const routes: FakeRoute[] = [];
  const closed: string[] = [];
  const clicked: string[] = [];
  const filled: [string, string][] = [];
  let handler: ((r: FakeRoute) => Promise<void>) | undefined;
  const loc = (selector: string) => {
    const l = {
      first: () => l,
      all: async () => [l],
      click: async () => void clicked.push(selector),
      fill: async (t: string) => void filled.push([selector, t]),
      innerText: async () => `text of ${selector}`,
      boundingBox: async () => ({ x: 1, y: 2, width: 300, height: 2700 }),
      count: async () => 1,
    };
    return l;
  };
  const page = {
    goto: vi.fn(async () => {}),
    waitForSelector: vi.fn(async () => {}),
    locator: loc,
    emulateMedia: vi.fn(async () => {}),
    screenshot: vi.fn(async () => Buffer.from("PNG")),
    url: () => `${ORIGIN}/needs-you`,
    on: () => {},
  };
  const playwright: PreviewPlaywright = {
    chromium: {
      launch: async () => ({
        newContext: async (o) => {
          expect(o.viewport.width).toBe(1000);
          return {
            route: async (_p, h) => {
              handler = h as typeof handler;
            },
            routeWebSocket: async () => {},
            newPage: async () => page as never,
            on: () => {},
            close: async () => void closed.push("context"),
          };
        },
        close: async () => void closed.push("browser"),
      }),
    },
  };
  return {
    playwright,
    page,
    closed,
    clicked,
    filled,
    request: async (method: string, url: string) => {
      const r = new FakeRoute(method, url);
      routes.push(r);
      await handler?.(r);
      return r;
    },
  };
}

const JOB: PreviewJob = {
  path: "/needs-you",
  width: 1000,
  theme: "light",
  steps: [
    { click: "text=Open" },
    { type: { selector: "input", text: "x".repeat(300) } },
    { read: "main" },
    { measure: ".row" },
    { screenshot: "wide" },
  ],
};

describe("runPreviewBrowser", () => {
  const options = (f: ReturnType<typeof fake>) => ({
    executablePath: "/chrome",
    fileExists: () => true,
    loadPlaywright: async () => f.playwright,
    startProxy: async () => ({ address: "127.0.0.1:1", close: async () => {} }),
  });

  it("runs the steps, reports the page and returns the screenshot, then closes everything", async () => {
    const f = fake();
    const result = await runPreviewBrowser(JOB, previewRequest(ORIGIN), options(f));
    expect(f.page.emulateMedia).toHaveBeenCalledWith({ colorScheme: "light" });
    expect(f.clicked).toEqual(["text=Open"]);
    expect(f.filled).toEqual([["input", "x".repeat(300)]]);
    expect(result.shots.map((s) => s.label)).toEqual(["wide"]);
    expect(result.report.join("\n")).toContain("1 match .row (x,y w×h): 1,2 300×2700");
    expect(f.closed.sort()).toEqual(["browser", "context"]);
  });

  it("aborts every browser request that is not to the preview", async () => {
    const f = fake();
    await runPreviewBrowser({ ...JOB, steps: [] }, previewRequest(ORIGIN), options(f));
    expect((await f.request("GET", `${ORIGIN}/app.js`)).continued).toHaveBeenCalled();
    for (const url of ["http://evil.example/x", "http://127.0.0.1:7420/", "file:///etc/hosts"]) {
      const r = await f.request("GET", url);
      expect(r.aborted, url).toHaveBeenCalled();
      expect(r.continued, url).not.toHaveBeenCalled();
    }
  });

  it("refuses a path on another host before it launches anything", async () => {
    const f = fake();
    const load = vi.fn(options(f).loadPlaywright);
    await expect(
      runPreviewBrowser({ ...JOB, path: "http://evil.example/" }, previewRequest(ORIGIN), {
        ...options(f),
        loadPlaywright: load,
      }),
    ).rejects.toThrow("path on the preview");
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps going after a step fails and says which one", async () => {
    const f = fake();
    const bad = {
      ...f.playwright,
      chromium: {
        launch: async (o: never) => {
          const b = await f.playwright.chromium.launch(o);
          return {
            ...b,
            newContext: async (c: never) => {
              const ctx = await b.newContext(c);
              return {
                ...ctx,
                newPage: async () => ({
                  ...f.page,
                  locator: () => ({
                    ...f.page.locator("x"),
                    first: () => ({
                      ...f.page.locator("x"),
                      click: async () => {
                        throw new Error("no such element");
                      },
                    }),
                  }),
                }),
              };
            },
          };
        },
      },
    } as unknown as PreviewPlaywright;
    const result = await runPreviewBrowser(
      { ...JOB, steps: [{ click: "#gone" }, { screenshot: "after" }] },
      previewRequest(ORIGIN),
      { ...options(f), loadPlaywright: async () => bad },
    );
    expect(result.report[0]).toContain("step 1 failed: no such element");
    expect(result.shots.map((s) => s.label)).toEqual(["after"]);
  });
});
