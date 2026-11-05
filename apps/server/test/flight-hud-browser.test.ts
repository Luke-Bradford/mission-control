/**
 * Real-browser coverage of the HUD screenshot confinement: a local hub, a second "off-hub" loopback
 * server that must never be reached, and the system Chrome. Skipped where there is no Chrome.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Socket } from "node:net";
import {
  QA_DISCLOSURE_LABEL,
  QA_TAB_LABELS,
  QA_VIEW_LABEL,
  type Run,
  type SeatSessionRow,
} from "@mc/core";
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
import { blockedHere } from "./sandbox-gaps.ts";

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
/** What the fixture Audit page was clicked on: the disclosure, then a tab. */
const clicks: string[] = [];

/**
 * The Audit page as the capture sees it, built from the shared labels: the QA view with its tabs
 * is drawn 1.2 s after load (a lazy page), behind a disclosure button unless `old` (the older
 * baseline, which shows the view at once). A click is reported to /api/click.
 */
const auditScript = (old: boolean, tall: boolean): string => `
if (${tall}) {
  // a block taller than the 1000 px viewport above the view, as Code Health is on the real page
  const filler = document.createElement('div');
  filler.style.height = '1500px';
  document.querySelector('main').append(filler);
}
const report = (what) => fetch('/api/click?what=' + encodeURIComponent(what));
const drawView = () => {
  const view = document.createElement('div');
  view.setAttribute('aria-label', ${JSON.stringify(QA_VIEW_LABEL)});
  for (const label of ${JSON.stringify(Object.values(QA_TAB_LABELS))}) {
    const tab = document.createElement('button');
    tab.textContent = label;
    tab.setAttribute('aria-pressed', 'false');
    tab.onclick = () => { tab.setAttribute('aria-pressed', 'true'); report('tab:' + label); };
    view.append(tab);
  }
  document.querySelector('main').append(view);
  new IntersectionObserver((entries) => {
    for (const e of entries) report(e.isIntersecting ? 'view:visible' : 'view:hidden');
  }).observe(view);
};
setTimeout(() => {
  if (${old}) return drawView();
  const open = document.createElement('button');
  open.textContent = ${JSON.stringify(QA_DISCLOSURE_LABEL)};
  open.onclick = () => { report('disclosure'); drawView(); };
  document.querySelector('main').append(open);
}, 1200);`;

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
      case "/audit":
        return send(
          html(
            "<h1>Audit</h1>",
            auditScript(url.searchParams.has("old"), url.searchParams.has("tall")),
          ),
        );
      case "/api/click":
        clicks.push(url.searchParams.get("what") ?? "");
        return void res.end("{}");
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

// A cold Chrome start on a loaded CI runner can take most of 20 s; the deadline covers launch too.
// Every render's test timeout must exceed this.
const COLD_START_DEADLINE_MS = 60_000;

const render = (path: string, over: { deadlineMs?: number } = {}) => {
  const guard = hudRenderRequest(hub.origin);
  return renderHudWithPlaywright(guard.page(path), guard, {
    executablePath: CHROME as string,
    deadlineMs: over.deadlineMs ?? COLD_START_DEADLINE_MS,
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

describe.skipIf(CHROME === undefined || (await blockedHere("listen")))(
  "HUD screenshots in a real browser",
  () => {
    beforeAll(startServers);
    afterAll(stopServers);

    it("waits for the lazy page and its data before capturing", async () => {
      const png = await render("/map");
      expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
      // the beacon is sent only after the placeholder was replaced; the capture came after it
      expect(ready).toEqual(["?page=map"]);
    }, 90_000);

    it("opens the Audit disclosure, once the lazy page has drawn it, and selects the tab", async () => {
      for (const [tab, label] of Object.entries(QA_TAB_LABELS)) {
        clicks.length = 0;
        const png = await render(`/audit?evidence-tab=${tab}`);
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
        expect(clicks).toEqual(["disclosure", `tab:${label}`]);
      }
    }, 150_000);

    it("has the QA view on screen when it is photographed, below a block taller than the viewport", async () => {
      clicks.length = 0;
      await render("/audit?evidence-tab=readiness&tall=1");
      expect(clicks.filter((c) => c.startsWith("view:")).at(-1)).toBe("view:visible");
    }, 90_000);

    it("selects the tab without the disclosure on an older baseline that shows the view at once", async () => {
      clicks.length = 0;
      await render("/audit?evidence-tab=hotspots&old=1");
      expect(clicks).toEqual([`tab:${QA_TAB_LABELS.hotspots}`]);
    }, 90_000);

    it("refuses a redirect off the hub and never reaches the other server", async () => {
      await expect(render("/board")).rejects.toThrow();
      expect(other.requests).toEqual([]);
    }, 90_000);

    it("closes popups and never reaches the other server from them", async () => {
      const before = other.requests.length;
      const png = await render("/flight");
      expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
      expect(other.requests).toHaveLength(before);
    }, 90_000);

    it("blocks service workers", async () => {
      await render("/comms");
      expect(hub.requests.filter((u) => u === "/sw.js")).toEqual([]);
    }, 90_000);

    it("blocks WebSockets, to the hub and anywhere else", async () => {
      await render("/telemetry");
      expect(hub.upgrades).toEqual([]);
      expect(other.upgrades).toEqual([]);
    }, 90_000);

    it("denies encoded spellings of the bootstrap and the stream, and every write", async () => {
      await render("/overview");
      const seen = hub.requests.map((u) => decodeURIComponent(u).toLowerCase());
      expect(seen).not.toContain("/api/operator/bootstrap");
      expect(seen).not.toContain("/api/stream");
      expect(seen).not.toContain("/api/x");
    }, 90_000);

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
    }, 150_000);

    it("leaves no Chrome behind when a render is stopped in the owned helper", async () => {
      const baseline = chromeCount();
      const guard = hudRenderRequest(hub.origin);
      const stop = new AbortController();
      const job = renderHudInHelper(guard.page("/setup"), guard, {
        executablePath: CHROME as string,
        deadlineMs: COLD_START_DEADLINE_MS,
        signal: stop.signal,
      });
      const settled = job.then(
        () => "rendered",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      // /setup never answers, so the render is parked on a running Chrome until it is stopped
      await expect.poll(chromeCount, { timeout: 30_000 }).toBeGreaterThan(baseline);
      stop.abort(new Error("stopped by the test"));
      expect(await settled).toBe("stopped by the test");
      // the call settles only after the helper is stopped; Chrome goes with it
      await expect.poll(chromeCount, { timeout: 10_000 }).toBeLessThanOrEqual(baseline);
    }, 150_000);

    it("leaves no Chrome behind when the render is stopped while Chrome is frozen", async () => {
      const baseline = chromeCount();
      const guard = hudRenderRequest(hub.origin);
      const stop = new AbortController();
      const settled = renderHudInHelper(guard.page("/setup"), guard, {
        executablePath: CHROME as string,
        deadlineMs: COLD_START_DEADLINE_MS,
        signal: stop.signal,
      }).then(
        () => "rendered",
        (e: unknown) => (e instanceof Error ? e.message : String(e)),
      );
      await expect.poll(chromeCount, { timeout: 30_000 }).toBeGreaterThan(baseline);
      // freeze every Chrome process, so its own graceful close cannot run
      for (const line of execFileSync("ps", ["-axo", "pid,command"], { encoding: "utf8" }).split(
        "\n",
      ))
        if (line.includes("playwright_chromiumdev_profile"))
          process.kill(Number(line.trim().split(/\s+/)[0]), "SIGSTOP");
      stop.abort(new Error("stopped by the test"));
      expect(await settled).toBe("stopped by the test");
      await expect.poll(chromeCount, { timeout: 10_000 }).toBeLessThanOrEqual(baseline);
    }, 150_000);

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
                {
                  id: "flight-1",
                  role: "FLIGHT",
                  accountId: "claude-main",
                  model: "opus",
                  area: [],
                },
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
              deadlineMs: COLD_START_DEADLINE_MS,
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
    }, 150_000);
  },
);
