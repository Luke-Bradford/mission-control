/**
 * Real-browser coverage of the HUD screenshot confinement: a local hub, a second "off-hub" loopback
 * server that must never be reached, and the system Chrome. Skipped where there is no Chrome.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import type { Run, SeatSessionRow } from "@mc/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import {
  type HudRenderGuard,
  hudRenderRequest,
  renderHudInHelper,
  renderHudWithPlaywright,
} from "../src/flight/hud-render.ts";
import { createFlightTools, type FlightToolsDeps } from "../src/flight/tools.ts";
import { Store } from "../src/store.ts";
import { WEB_CSP } from "../src/web.ts";

/** A Chrome or Chromium to render with: the override, else the usual macOS and Linux installs. */
const CHROME = [
  process.env.MC_BROWSER_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((path): path is string => path !== undefined && existsSync(path));

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const sockets = new Set<Socket>();

async function listen(
  handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void,
) {
  const requests: string[] = [];
  const upgrades: string[] = [];
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? "");
    handler(req, res);
  });
  server.on("upgrade", (req, socket) => {
    upgrades.push(req.url ?? "");
    socket.destroy();
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, port, origin: `http://127.0.0.1:${port}`, requests, upgrades };
}

// Like the real hub, pages carry its CSP (script-src 'self': no inline script, no eval), so a
// renderer that evaluates strings in the page fails here as it would live.
const scripts = new Map<string, string>();
const html = (body: string, script = "") => {
  const path = `/s/${scripts.size}.js`;
  scripts.set(path, `document.documentElement.dataset.hudReady='1';${script}`);
  return `<!doctype html><html><body><main>${body}</main><script src="${path}"></script></body></html>`;
};

let hub: Awaited<ReturnType<typeof listen>>;
let other: Awaited<ReturnType<typeof listen>>;
const ready: string[] = [];

const startServers = async (): Promise<void> => {
  other = await listen((_req, res) => res.end("off-hub"));
  hub = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://hub");
    const send = (body: string) =>
      res
        .setHeader("content-type", "text/html")
        .setHeader("content-security-policy", WEB_CSP)
        .end(body);
    const script = scripts.get(url.pathname);
    if (script !== undefined)
      return void res.setHeader("content-type", "text/javascript").end(script);
    switch (url.pathname) {
      case "/map":
        // the lazy page's placeholder, then its data, 600 ms later
        return send(
          html(
            "<p>Loading…</p>",
            `fetch('/api/slow').then(()=>{document.querySelector('main').innerHTML='<h1>Map</h1>';
             return fetch('/api/beacon?page=map')});`,
          ),
        );
      case "/api/slow":
        return void setTimeout(() => res.end("{}"), 600);
      case "/api/beacon":
        ready.push(url.search);
        return void res.end("{}");
      case "/board":
        return void res.writeHead(302, { location: `${other.origin}/secret` }).end();
      case "/flight":
        return send(
          html(
            `<h1>Flight</h1><a id=a target=_blank href='${other.origin}/link'>x</a>`,
            `window.open('${other.origin}/pop');document.getElementById('a').click();`,
          ),
        );
      case "/comms":
        return send(
          html("<h1>Comms</h1>", "navigator.serviceWorker?.register('/sw.js').catch(()=>{});"),
        );
      case "/telemetry":
        return send(
          html(
            "<h1>Telemetry</h1>",
            `new WebSocket('ws://127.0.0.1:${hub.port}/ws');new WebSocket('ws://127.0.0.1:${other.port}/ws');`,
          ),
        );
      case "/overview":
        return send(
          html(
            "<h1>Overview</h1>",
            "fetch('/api/%6Fperator/%62ootstrap');fetch('/api/%73tream');fetch('/api/x',{method:'POST'});",
          ),
        );
      case "/setup":
        return; // never answers: the render must hit its deadline
      case "/sw.js":
        return void res.setHeader("content-type", "text/javascript").end("");
      default:
        return void res.end("{}");
    }
  });
};

const stopServers = async (): Promise<void> => {
  for (const s of sockets) s.destroy();
  await Promise.all([hub, other].map((x) => new Promise((r) => x.server.close(r))));
};

const chromeCount = (): number => {
  try {
    return execFileSync("ps", ["-axo", "command"], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.includes("playwright_chromiumdev_profile")).length;
  } catch {
    return 0;
  }
};

const render = (path: string, over: { deadlineMs?: number } = {}) => {
  const guard = hudRenderRequest(hub.origin);
  return renderHudWithPlaywright(guard.page(path), guard, {
    executablePath: CHROME as string,
    deadlineMs: over.deadlineMs ?? 20_000,
  });
};

// CI must prove the confinement: a missing browser there is a failure, not a skip. Only a developer
// machine without Chrome skips.
if (CHROME === undefined && process.env.CI)
  describe("HUD screenshots in a real browser", () => {
    it("needs a Chrome executable on CI (set MC_BROWSER_EXECUTABLE)", () => {
      throw new Error("no Chrome or Chromium found; the real-browser HUD suite cannot run");
    });
  });

describe.skipIf(CHROME === undefined)("HUD screenshots in a real browser", () => {
  beforeAll(startServers);
  afterAll(stopServers);

  it("waits for the lazy page and its data before capturing", async () => {
    const png = await render("/map");
    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    // the beacon is sent only after the placeholder was replaced; the capture came after it
    expect(ready).toEqual(["?page=map"]);
  }, 30_000);

  it("refuses a redirect off the hub and never reaches the other server", async () => {
    await expect(render("/board")).rejects.toThrow();
    expect(other.requests).toEqual([]);
  }, 30_000);

  it("closes popups and never reaches the other server from them", async () => {
    const before = other.requests.length;
    const png = await render("/flight");
    expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
    expect(other.requests).toHaveLength(before);
  }, 30_000);

  it("blocks service workers", async () => {
    await render("/comms");
    expect(hub.requests.filter((u) => u === "/sw.js")).toEqual([]);
  }, 30_000);

  it("blocks WebSockets, to the hub and anywhere else", async () => {
    await render("/telemetry");
    expect(hub.upgrades).toEqual([]);
    expect(other.upgrades).toEqual([]);
  }, 30_000);

  it("denies encoded spellings of the bootstrap and the stream, and every write", async () => {
    await render("/overview");
    const seen = hub.requests.map((u) => decodeURIComponent(u).toLowerCase());
    expect(seen).not.toContain("/api/operator/bootstrap");
    expect(seen).not.toContain("/api/stream");
    expect(seen).not.toContain("/api/x");
  }, 30_000);

  it("rejects encoded and dot-segment spellings of non-HUD paths before launching", () => {
    const guard = hudRenderRequest(hub.origin);
    for (const page of ["/%61pi/health", "/map/%2e%2e/api/health", "//example.test/map", "/mcp"])
      expect(() => guard.page(page)).toThrow("HUD page required");
  });

  it("leaves no Chrome behind after a deadline in the owned helper", async () => {
    const baseline = chromeCount();
    const guard = hudRenderRequest(hub.origin);
    await expect(
      renderHudInHelper(guard.page("/setup"), guard, {
        executablePath: CHROME as string,
        deadlineMs: 3_000,
      }),
    ).rejects.toThrow("timed out");
    await expect.poll(chromeCount, { timeout: 10_000 }).toBeLessThanOrEqual(baseline);
  }, 60_000);

  it("releases a queued screenshot_hud render after the render before it failed", async () => {
    const NOW = Date.now();
    const store = new Store(":memory:");
    store.upsertRun({
      id: "r-flight",
      agentId: "flight-1",
      repoId: "mc",
      seq: 1,
      startedAt: NOW,
      endedAt: null,
      status: "running",
      sessionId: "cli",
      model: "opus",
      branch: null,
      ticket: null,
      costUsd: null,
      tokens: null,
      transcriptPath: "/x",
      prs: [],
      summary: null,
    } satisfies Run);
    store.setSeatSession({
      seatId: "flight-1",
      runId: "r-flight",
      cliSessionId: "cli",
      state: "idle",
      reason: null,
      worktree: null,
      updatedAt: NOW,
    } satisfies SeatSessionRow);
    const config: CcConfig = {
      operator: { id: "op", timezone: "UTC" },
      accounts: [{ id: "claude-main", vendor: "claude", alertAt: 80, stopAt: 95 }],
      repos: [
        {
          id: "mc",
          github: "o/mc",
          project: 1,
          statusMap: {},
          autonomy: "draft",
          flightPowers: "superuser",
        },
      ],
      loops: [],
      poll: { usageMinutes: 30, githubSeconds: 60 },
      crew: {
        worktrees: "/tmp/none",
        maxSeats: 8,
        sessions: [
          {
            id: "s1",
            repoId: "mc",
            checkout: "/tmp/none/clone",
            seats: [
              { id: "flight-1", role: "FLIGHT", accountId: "claude-main", model: "opus", area: [] },
            ],
          },
        ],
      },
    };
    const events: string[] = [];
    // only screenshot_hud is called; the other deps are never reached
    const tools = createFlightTools({
      config,
      store,
      bus: new ChangeBus(),
      hubOrigin: hub.origin,
      // the production renderer: a real helper process and Chrome per call
      screenshotHud: async (url: string, guard: HudRenderGuard) => {
        const page = new URL(url).pathname;
        events.push(`launch ${page}`);
        try {
          return await renderHudInHelper(url, guard, {
            executablePath: CHROME as string,
            deadlineMs: 20_000,
          });
        } catch (e) {
          events.push(`failed ${page}`);
          throw e;
        }
      },
    } as unknown as FlightToolsDeps);
    const shot = tools.find((t) => t.name === "screenshot_hud");
    if (!shot) throw new Error("no screenshot_hud tool");
    const ctx = { seatId: "flight-1", runId: "r-flight" };

    // /board redirects off the hub and fails; /overview is a good page queued behind it
    const first = shot.call(ctx, { page: "/board" });
    const second = shot.call(ctx, { page: "/overview" });
    const [a, b] = await Promise.all([first, second]);

    expect(a.isError).toBe(true);
    expect(b.isError).toBeUndefined();
    expect(b.image?.mimeType).toBe("image/png");
    // the second helper only launched once the first render had failed and left the queue
    expect(events).toEqual(["launch /board", "failed /board", "launch /overview"]);
  }, 60_000);
});
