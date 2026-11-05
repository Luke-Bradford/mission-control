/**
 * Real-browser coverage of design previews: the branch's real web app boots in Demo on the preview
 * origin, and a hostile preview script cannot reach the hub's operator routes. Needs real ports and
 * Chrome, so it is skipped in a seat's sandbox (CI and the hub run it).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as netServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { DesignPreviews } from "../src/design-previews.ts";
import { Store } from "../src/store.ts";
import { blockedHere, skipTestsIf } from "./sandbox-gaps.ts";

const CHROME = [
  process.env.MC_BROWSER_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((path): path is string => path !== undefined && existsSync(path));

const TOKEN = "secret-op-token";
const input = (ticket: number, worktree: string) => ({
  ticket,
  branch: `feature/${ticket}-x`,
  sha: "a".repeat(40),
  worktree,
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = netServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-design-browser-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

if (CHROME === undefined && process.env.CI) {
  describe("design previews in a real browser", () => {
    it("needs a Chrome executable on CI (set MC_BROWSER_EXECUTABLE)", () => {
      throw new Error("no Chrome or Chromium found; the design preview browser suite cannot run");
    });
  });
}

skipTestsIf(CHROME === undefined || (await blockedHere("listen")));

describe("design previews in a real browser", () => {
  it("the real app built on a branch boots in Demo on the preview origin", async () => {
    const worktree = join(dir, "real");
    mkdirSync(join(worktree, "apps", "web"), { recursive: true });
    execFileSync("pnpm", ["-s", "--filter", "@mc/web", "build"], {
      env: { ...process.env, MC_WEB_OUTDIR: join(worktree, "apps", "web", "dist") },
      stdio: "ignore",
      timeout: 300_000,
    });
    const port = await freePort();
    const previews = new DesignPreviews({
      root: join(dir, "real-store"),
      port,
      hubPort: 7420,
      prOf: () => null,
    });
    await previews.publish(input(1, worktree));
    await previews.open(1);
    await previews.listen();
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1920, height: 940 } });
      const errors: string[] = [];
      const apiCalls: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("request", (r) => {
        if (new URL(r.url()).pathname.startsWith("/api/")) apiCalls.push(r.url());
      });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector(".demo-marker");
      expect((await page.locator(".demo-marker").first().textContent())?.trim()).toContain("DEMO");
      await page.waitForFunction(
        'document.querySelectorAll("#agentsList .trow:not(.head)").length >= 10',
        undefined,
        { timeout: 30_000 },
      );
      expect(await page.evaluate("document.documentElement.dataset.mcPreview")).toBe("1");
      expect(errors).toEqual([]);
      expect(apiCalls).toEqual([]);
    } finally {
      await browser.close();
      await previews.close();
    }
  }, 360_000);

  it("a preview cannot reach the hub's operator routes", async () => {
    // the hub: real routes, the operator token, and a log of every /api request it answers
    const store = new Store(":memory:");
    const hub = buildApp({
      config: {
        operator: { id: "operator", timezone: "UTC" },
        accounts: [],
        repos: [],
        loops: [],
        poll: { usageMinutes: 30, githubSeconds: 60 },
      },
      store,
      bus: new ChangeBus(),
      operatorToken: TOKEN,
    });
    // every request that arrives, counted at the HTTP server before any of the hub's guards
    // can refuse it; and the status each one was answered with
    const arrived: string[] = [];
    const answered: Array<{ method: string; url: string; status: number }> = [];
    hub.server.on("request", (req) => {
      if (req.url?.startsWith("/api/")) arrived.push(`${req.method} ${req.url}`);
    });
    hub.server.on("upgrade", (req) => {
      if (req.url?.startsWith("/api/")) arrived.push(`UPGRADE ${req.url}`);
    });
    hub.addHook("onResponse", async (req, reply) => {
      if (req.url.startsWith("/api/"))
        answered.push({ method: req.method, url: req.url, status: reply.statusCode });
    });
    await hub.listen({ host: "127.0.0.1", port: 0 });
    const hubPort = (hub.server.address() as { port: number }).port;
    const hubOrigin = `http://127.0.0.1:${hubPort}`;

    // the hostile build: its own script, loaded from its own origin, tries every way in
    const worktree = join(dir, "hostile");
    const built = join(worktree, "apps", "web", "dist");
    mkdirSync(built, { recursive: true });
    writeFileSync(
      join(built, "index.html"),
      '<!doctype html><html><head><title>hostile</title></head><body><pre id="out"></pre><script src="/attack.js"></script></body></html>',
    );
    writeFileSync(
      join(built, "attack.js"),
      `
const HUB = ${JSON.stringify(hubOrigin)};
const out = [];
const note = (k, v) => { out.push(k + ": " + v); document.getElementById("out").textContent = out.join("\\n"); };
const tries = [
  () => fetch(HUB + "/api/operator/bootstrap", { mode: "cors" }).then((r) => r.text()),
  () => fetch(HUB + "/api/operator/bootstrap", { mode: "no-cors" }).then((r) => r.type),
  () => fetch(HUB + "/api/flight/approvals", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.text()),
  () => Promise.resolve(String(navigator.sendBeacon(HUB + "/api/flight/approvals", "{}"))),
  () => new Promise((ok) => { const e = new EventSource(HUB + "/api/stream"); e.onerror = () => { e.close(); ok("error"); }; e.onopen = () => { e.close(); ok("open"); }; }),
  () => new Promise((ok) => { const i = new Image(); i.onload = () => ok("loaded"); i.onerror = () => ok("error"); i.src = HUB + "/api/crew"; }),
  () => new Promise((ok) => { try { const w = new WebSocket(HUB.replace("http", "ws") + "/api/stream"); w.onerror = () => ok("error"); w.onopen = () => { w.close(); ok("open"); }; } catch (e) { ok("threw"); } }),
];
Promise.allSettled(tries.map((t, i) => t().then((v) => note("try" + i, "ok " + v), (e) => note("try" + i, "failed " + e)))).then(() => { document.documentElement.dataset.done = "1"; });
`,
    );

    const port = await freePort();
    const previews = new DesignPreviews({
      root: join(dir, "hostile-store"),
      port,
      hubPort,
      prOf: () => null,
    });
    await previews.publish(input(2, worktree));
    await previews.listen();

    // the same files with no CSP, on another origin: what the hub itself must refuse
    const noCsp: Server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      try {
        const body = readFileSync(join(dir, "hostile-store", "2", "site", file));
        res
          .setHeader("content-type", file.endsWith(".js") ? "text/javascript" : "text/html")
          .end(body);
      } catch {
        res.statusCode = 404;
        res.end();
      }
    });
    await new Promise<void>((r) => noCsp.listen(0, "127.0.0.1", r));
    const noCspPort = (noCsp.address() as { port: number }).port;

    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    try {
      const run = async (url: string) => {
        const page = await browser.newPage();
        await page.goto(url);
        await page.waitForFunction('document.documentElement.dataset.done === "1"', undefined, {
          timeout: 30_000,
        });
        const text = (await page.locator("#out").textContent()) ?? "";
        await page.close();
        return text;
      };

      // with the preview's own CSP the browser stops every request before it leaves
      const guarded = await run(`http://127.0.0.1:${port}/`);
      expect(arrived).toEqual([]);
      expect(answered).toEqual([]);
      expect(guarded).not.toContain(TOKEN);

      // with no CSP, every request that reaches the hub is refused: it is same-site, not same-origin
      const ungated = await run(`http://127.0.0.1:${noCspPort}/`);
      expect(ungated).not.toContain(TOKEN);
      expect(arrived.length).toBeGreaterThan(0);
      expect(answered.length).toBeGreaterThan(0);
      for (const s of answered) expect(s.status, `${s.method} ${s.url}`).toBe(403);
    } finally {
      await browser.close();
      await new Promise<void>((r) => noCsp.close(() => r()));
      await previews.close();
      await hub.close();
    }
  }, 120_000);
});
