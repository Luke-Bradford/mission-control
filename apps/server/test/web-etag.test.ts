import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { webHandler } from "../src/web.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-web-"));
  writeFileSync(join(root, "index.html"), "<html>app</html>");
  writeFileSync(join(root, "icon.svg"), "<svg/>");
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "app-abc.js"), "console.log(1)");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const serve = () => {
  const app = Fastify();
  app.get("/*", webHandler(root));
  return app;
};

describe("static file ETag", () => {
  for (const url of ["/", "/icon.svg", "/assets/app-abc.js"]) {
    it(`${url} carries a strong ETag and answers a matching If-None-Match with 304`, async () => {
      const app = serve();
      const first = await app.inject({ url });
      expect(first.statusCode).toBe(200);
      const etag = first.headers.etag as string;
      expect(etag).toMatch(/^"[^"]+"$/);
      const again = await app.inject({ url, headers: { "if-none-match": etag } });
      expect(again.statusCode).toBe(304);
      expect(again.body).toBe("");
      const other = await app.inject({ url, headers: { "if-none-match": '"nope"' } });
      expect(other.statusCode).toBe(200);
      await app.close();
    });
  }

  it("changes the ETag when the file changes", async () => {
    const app = serve();
    const a = (await app.inject({ url: "/icon.svg" })).headers.etag;
    writeFileSync(join(root, "icon.svg"), "<svg>changed</svg>");
    const b = (await app.inject({ url: "/icon.svg" })).headers.etag;
    expect(b).not.toBe(a);
    await app.close();
  });
});
