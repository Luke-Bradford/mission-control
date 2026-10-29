/**
 * Real-browser coverage of the HUD screenshot confinement: a local hub, a second "off-hub" loopback
 * server that must never be reached, and the system Chrome. Skipped where there is no Chrome.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  hudRenderRequest,
  renderHudInHelper,
  renderHudWithPlaywright,
} from "../src/flight/hud-render.ts";

const CHROME =
  process.env.MC_BROWSER_EXECUTABLE ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const haveChrome = existsSync(CHROME);

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

const html = (body: string, script = "") =>
  `<!doctype html><html><body><main>${body}</main><script>document.documentElement.dataset.hudReady='1';${script}</script></body></html>`;

let hub: Awaited<ReturnType<typeof listen>>;
let other: Awaited<ReturnType<typeof listen>>;
const ready: string[] = [];

const startServers = async (): Promise<void> => {
  other = await listen((_req, res) => res.end("off-hub"));
  hub = await listen((req, res) => {
    const url = new URL(req.url ?? "/", "http://hub");
    const send = (body: string) => res.setHeader("content-type", "text/html").end(body);
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
            "<h1>Flight</h1><a id=a target=_blank href='" + other.origin + "/link'>x</a>",
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
    executablePath: CHROME,
    deadlineMs: over.deadlineMs ?? 20_000,
  });
};

describe.skipIf(!haveChrome)("HUD screenshots in a real browser", () => {
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

  it("leaves no Chrome behind after a deadline in the owned helper, and a queued render still runs", async () => {
    const baseline = chromeCount();
    const guard = hudRenderRequest(hub.origin);
    const hung = renderHudInHelper(guard.page("/setup"), guard, {
      executablePath: CHROME,
      deadlineMs: 3_000,
    });
    const next = renderHudInHelper(guard.page("/overview"), guard, {
      executablePath: CHROME,
      deadlineMs: 20_000,
    });
    const [a, b] = await Promise.allSettled([hung, next]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("fulfilled");
    await expect.poll(chromeCount, { timeout: 10_000 }).toBeLessThanOrEqual(baseline);
  }, 60_000);
});
