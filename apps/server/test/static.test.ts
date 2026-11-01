import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import type { CcConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const INDEX = "<!doctype html><title>cc</title><div id=root></div>";
const SECRET = "outside-the-web-root";

let dir: string;
let webRoot: string;
let store: Store;
let app: FastifyInstance;

const config: CcConfig = {
  operator: { id: "operator", timezone: "Europe/London" },
  accounts: [],
  repos: [],
  loops: [],
  poll: { usageMinutes: 30, githubSeconds: 60 },
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mc-static-"));
  webRoot = join(dir, "dist");
  mkdirSync(join(webRoot, "assets"), { recursive: true });
  writeFileSync(join(webRoot, "index.html"), INDEX);
  writeFileSync(join(webRoot, "assets", "app-abc123.js"), "console.log(1)");
  writeFileSync(join(webRoot, "assets", "app-abc123.css"), "body{}");
  writeFileSync(join(dir, "secret.txt"), SECRET);
  store = new Store(join(dir, "mc.sqlite"));
  app = buildApp({ config, store, bus: new ChangeBus(), webRoot });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: "GET", url, headers });

describe("serving the built web app", () => {
  it("compresses a large hashed script for a client that accepts brotli, and leaves a font alone", async () => {
    const script = `console.log("${"x".repeat(20_000)}")`;
    writeFileSync(join(webRoot, "assets", "big-abc123.js"), script);
    writeFileSync(join(webRoot, "assets", "font-abc123.woff2"), Buffer.alloc(20_000, 7));
    for (let i = 0; i < 2; i++) {
      const r = await get("/assets/big-abc123.js", { "accept-encoding": "br" });
      expect(r.headers["content-encoding"]).toBe("br");
      expect(String(r.headers.vary)).toContain("accept-encoding");
      expect(brotliDecompressSync(r.rawPayload).toString()).toBe(script);
    }
    const font = await get("/assets/font-abc123.woff2", { "accept-encoding": "br" });
    expect(font.headers["content-encoding"]).toBeUndefined();
    expect(font.rawPayload).toHaveLength(20_000);
  });

  it("serves index.html at / without a session, with a CSP and no caching", async () => {
    const r = await get("/");
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/html/);
    expect(r.body).toBe(INDEX);
    expect(r.headers["cache-control"]).toBe("no-cache");
    expect(r.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("serves hashed assets with their type and a long cache", async () => {
    const js = await get("/assets/app-abc123.js");
    expect(js.statusCode).toBe(200);
    expect(js.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(js.body).toBe("console.log(1)");
    expect(js.headers["cache-control"]).toContain("immutable");
    const css = await get("/assets/app-abc123.css?v=1");
    expect(css.headers["content-type"]).toMatch(/^text\/css/);
  });

  it("falls back to index.html for SPA routes", async () => {
    for (const url of ["/needs-you", "/boards/shop-app", "/agents?x=1"]) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(200);
      expect(r.body, url).toBe(INDEX);
    }
  });

  it("a missing asset is a 404, not index.html", async () => {
    const r = await get("/assets/missing-000.js");
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toBe(INDEX);
  });

  it("refuses path traversal", async () => {
    for (const url of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/..%5csecret.txt",
      "/assets/%00.js",
    ]) {
      const r = await get(url);
      expect(r.body, url).not.toContain(SECRET);
      expect([400, 404], url).toContain(r.statusCode);
    }
  });

  it("never follows a symlink inside dist to a file outside it", async () => {
    symlinkSync(join(dir, "secret.txt"), join(webRoot, "assets", "leak.js"));
    symlinkSync(join(dir, "secret.txt"), join(webRoot, "leak.txt"));
    symlinkSync(dir, join(webRoot, "assets", "up"));
    for (const url of ["/assets/leak.js", "/leak.txt", "/assets/up/secret.txt"]) {
      const r = await get(url);
      expect(r.body, url).not.toContain(SECRET);
      expect([403, 404], url).toContain(r.statusCode);
    }
  });

  it("a directory request under /assets/ is a 404", async () => {
    for (const url of ["/assets/", "/assets"]) {
      const r = await get(url);
      expect(r.body, url).not.toBe(INDEX);
      expect(r.statusCode, url).toBe(404);
    }
  });

  it("does not shadow /api: unknown /api paths are a JSON 404, not the SPA", async () => {
    for (const url of ["/api/nope", "/api"]) {
      const r = await get(url);
      expect(r.statusCode, url).toBe(404);
      expect(r.body, url).not.toBe(INDEX);
    }
  });

  it("keeps the host allowlist", async () => {
    expect((await get("/", { host: "evil.example" })).statusCode).toBe(421);
  });

  it("answers non-GET unknown routes with a JSON 404", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/nope",
      headers: { "content-type": "application/json" },
      payload: {},
    });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: "not found" });
  });

  it("says the app is not built when the web root has no index.html", async () => {
    await app.close();
    app = buildApp({ config, store, bus: new ChangeBus(), webRoot: join(dir, "nope") });
    const r = await get("/");
    expect(r.statusCode).toBe(404);
    expect(r.body).toContain("pnpm build");
  });
});
