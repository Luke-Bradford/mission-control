// @vitest-environment node
// vite (esbuild) needs Node's own TextEncoder, which jsdom replaces.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build, type ProxyOptions, type UserConfig } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import config from "../vite.config.ts";

const dev = { command: "serve", mode: "development" } as const;

const resolve = (env: Parameters<typeof config>[0]) => config(env) as UserConfig;
const proxy = (c: UserConfig, path: string) => c.server?.proxy?.[path] as ProxyOptions;
const target = (c: UserConfig) => proxy(c, "/api").target;
const webRoot = fileURLToPath(new URL("../", import.meta.url));
const fixtures: string[] = [];

function fixture(source: string, root = webRoot) {
  const dir = mkdtempSync(join(root, ".vite-guard-test-"));
  fixtures.push(dir);
  writeFileSync(join(dir, "main.js"), source);
  return dir;
}

function outsideFile() {
  const dir = mkdtempSync(join(tmpdir(), "vite-guard-outside-"));
  fixtures.push(dir);
  const file = join(dir, "private.txt");
  writeFileSync(file, "private file that must never enter the web build");
  return file;
}

function buildFixture(dir: string, overrides: UserConfig = {}) {
  return build({
    ...resolve({ command: "build", mode: "production" }),
    configFile: false,
    root: webRoot,
    logLevel: "silent",
    publicDir: false,
    build: { write: false, rollupOptions: { input: join(dir, "main.js") } },
    ...overrides,
  });
}

function buildHtmlFixture(dir: string, overrides: UserConfig = {}) {
  return buildFixture(dir, {
    build: { write: false, rollupOptions: { input: join(dir, "index.html") } },
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("vite config", () => {
  it("proxies to the preview port by default", () => {
    vi.stubEnv("MC_PORT", undefined);
    const c = resolve(dev);
    expect(target(c)).toBe("http://127.0.0.1:7431");
    expect(proxy(c, "/api/stream").target).toBe("http://127.0.0.1:7431");
  });

  it("proxies to MC_PORT when set", () => {
    vi.stubEnv("MC_PORT", "7432");
    expect(target(resolve(dev))).toBe("http://127.0.0.1:7432");
  });

  it("refuses the live hub's port for the dev server", () => {
    vi.stubEnv("MC_PORT", "7420");
    vi.stubEnv("VITEST", undefined);
    expect(() => resolve(dev)).toThrow(/7420/);
  });

  it("accepts it under vitest (which also runs as serve) and for a build", () => {
    vi.stubEnv("MC_PORT", "7420");
    expect(() => resolve(dev)).not.toThrow();
    vi.stubEnv("VITEST", undefined);
    expect(() => resolve({ command: "build", mode: "production" })).not.toThrow();
  });

  it("builds into dist, or into MC_WEB_OUTDIR when set (Update builds beside the live dist)", () => {
    const build = { command: "build", mode: "production" } as const;
    vi.stubEnv("MC_WEB_OUTDIR", undefined);
    expect(resolve(build).build?.outDir).toBe("dist");
    vi.stubEnv("MC_WEB_OUTDIR", "");
    expect(resolve(build).build?.outDir).toBe("dist");
    vi.stubEnv("MC_WEB_OUTDIR", "dist-next");
    expect(resolve(build).build?.outDir).toBe("dist-next");
  });

  it.each(["outside?raw", "../../server/package.json?raw", "../../../package.json?url"])(
    "refuses a build importing %s",
    async (id) => {
      if (id === "outside?raw") id = `${outsideFile()}?raw`;
      const dir = fixture(`import data from ${JSON.stringify(id)}; console.log(data);`);
      await expect(buildFixture(dir)).rejects.toThrow(/Web import outside/);
    },
  );

  it("checks real paths even when Vite preserves symlinks", async () => {
    const dir = fixture('import data from "./outside?raw"; console.log(data);');
    symlinkSync(outsideFile(), join(dir, "outside"));
    await expect(buildFixture(dir, { resolve: { preserveSymlinks: true } })).rejects.toThrow(
      /Web import outside/,
    );
  });

  it("preserves hashes in file paths when checking symlink targets", async () => {
    const dir = fixture('import data from "outside"; console.log(data);');
    const linked = join(dir, "allowed#outside");
    symlinkSync(outsideFile(), linked);
    await expect(
      buildFixture(dir, {
        plugins: [
          ...(resolve({ command: "build", mode: "production" }).plugins ?? []),
          {
            name: "hash-file-fixture",
            resolveId(id) {
              return id === "outside" ? `${linked}?raw` : null;
            },
          },
        ],
      }),
    ).rejects.toThrow(/Web import outside/);
  });

  it("checks aliased imports", async () => {
    const dir = fixture('import data from "outside"; console.log(data);');
    await expect(
      buildFixture(dir, { resolve: { alias: { outside: `${outsideFile()}?raw` } } }),
    ).rejects.toThrow(/Web import outside/);
  });

  it("checks file ids supplied directly to the loader", async () => {
    const outside = outsideFile();
    const dir = fixture('import data from "outside"; console.log(data);');
    await expect(
      buildFixture(dir, {
        plugins: [
          {
            name: "outside-fixture",
            resolveId: {
              order: "pre",
              handler(id) {
                return id === "outside" ? `${outside}?raw` : null;
              },
            },
          },
          ...(resolve({ command: "build", mode: "production" }).plugins ?? []),
        ],
      }),
    ).rejects.toThrow(/Web import outside/);
  });

  it("checks worker imports", async () => {
    const dir = fixture('new Worker(new URL("./worker.js", import.meta.url));');
    writeFileSync(
      join(dir, "worker.js"),
      `import data from ${JSON.stringify(`${outsideFile()}?raw`)}; self.postMessage(data);`,
    );
    await expect(buildFixture(dir)).rejects.toThrow(/Web import outside/);
  });

  it.each([
    ["CSS url absolute", "css", false, ""],
    ["CSS url relative escape", "css", true, ""],
    ["CSS url inline", "css", false, "?inline"],
    ["new URL absolute", "js", false, ""],
    ["new URL relative escape", "js", true, ""],
    ["new URL inline", "js", true, "?inline"],
  ] as const)("refuses %s", async (_name, kind, useRelative, query) => {
    const outside = outsideFile();
    const dir = fixture("");
    const target = (useRelative ? relative(dir, outside) : outside) + query;
    if (kind === "css") {
      writeFileSync(join(dir, "main.js"), 'import "./style.css";');
      writeFileSync(join(dir, "style.css"), `body { background: url(${JSON.stringify(target)}); }`);
    } else {
      writeFileSync(
        join(dir, "main.js"),
        `console.log(new URL(${JSON.stringify(target)}, import.meta.url));`,
      );
    }
    await expect(buildFixture(dir)).rejects.toThrow(/Web import outside/);
  });

  it.each(['"./nested.css"', 'url("./nested.css")'])(
    "checks recursive CSS @import %s before postcss reads it",
    async (importTarget) => {
      const dir = fixture('import "./style.css";');
      writeFileSync(join(dir, "style.css"), `@import ${importTarget};`);
      writeFileSync(join(dir, "nested.css"), '@import "./deep.css";');
      writeFileSync(
        join(dir, "deep.css"),
        `body { background: url(${JSON.stringify(`${relative(dir, outsideFile())}?inline`)}); }`,
      );
      await expect(buildFixture(dir)).rejects.toThrow(/Web import outside/);
    },
  );

  it.each(["relative", "symlink", "inline"])("refuses HTML img %s escapes", async (kind) => {
    const dir = fixture("");
    const outside = outsideFile();
    symlinkSync(outside, join(dir, "lnk.txt"));
    const target = kind === "symlink" ? "./lnk.txt" : relative(dir, outside);
    writeFileSync(
      join(dir, "index.html"),
      `<img src="${target}${kind === "inline" ? "?inline" : ""}">`,
    );
    await expect(buildHtmlFixture(dir)).rejects.toThrow(/Web import outside/);
  });

  it.each([
    "<style>body { background: url(TARGET?inline); }</style>",
    '<div style="background: url(TARGET?inline)"></div>',
    "<style>.safe {} </style><style>body { background: url(TARGET?inline); }</style>",
    '<div style="color: red"></div><div style="background: url(TARGET?inline)"></div>',
    '<link href="TARGET?inline" rel="icon">',
    '<video poster="TARGET?inline"></video>',
    '<img srcset="data:image/png;base64,AA== 1x, TARGET?inline 2x">',
    '<img srcset="https://example.com/a.png 1x,TARGET?inline 2x">',
    '<img data-src="TARGET?inline">',
    "<img SRC=TARGET?inline>",
  ])("refuses HTML escape in %s", async (html) => {
    const dir = fixture("");
    writeFileSync(join(dir, "index.html"), html.replace("TARGET", outsideFile()));
    await expect(buildHtmlFixture(dir)).rejects.toThrow(/Web import outside/);
  });

  it("decodes HTML attribute entities before checking inline escapes", async () => {
    const dir = fixture("");
    symlinkSync(outsideFile(), join(dir, "lnk.txt"));
    writeFileSync(join(dir, "index.html"), '<img src="lnk&#46;txt?inline">');
    await expect(buildHtmlFixture(dir)).rejects.toThrow(/Web import outside/);
  });

  it("checks srcset URLs containing commas", async () => {
    const dir = fixture("");
    symlinkSync(outsideFile(), join(dir, "lnk,secret.txt"));
    writeFileSync(join(dir, "index.html"), '<img srcset="./lnk,secret.txt?inline 2x">');
    await expect(buildHtmlFixture(dir)).rejects.toThrow(/Web import outside/);
  });

  it.each([
    ["image-set", ""],
    ["image-set", "?inline"],
    ["-webkit-image-set", ""],
    ["-webkit-image-set", "?inline"],
  ])("refuses CSS %s string escapes (%s)", async (fn, query) => {
    const dir = fixture('import "./style.css";');
    writeFileSync(
      join(dir, "style.css"),
      `body { background: ${fn}(url("data:image/png;base64,AA==") 1x, "${outsideFile()}${query}" 2x); }`,
    );
    await expect(buildFixture(dir)).rejects.toThrow(/Web import outside/);
  });

  it.each(["", "?inline"])("checks new URL assets in packages (%s)", async (query) => {
    const packagesRoot = fileURLToPath(new URL("../../../packages/", import.meta.url));
    const dir = fixture(
      `console.log(new URL("${outsideFile()}${query}", import.meta.url));`,
      packagesRoot,
    );
    await expect(buildFixture(dir)).rejects.toThrow(/Web import outside/);
  });

  it.each([false, true])(
    "backstops HTML assets added after the scan (symlink: %s)",
    async (symlink) => {
      const dir = fixture("");
      const outside = outsideFile();
      symlinkSync(outside, join(dir, "lnk.txt"));
      writeFileSync(join(dir, "index.html"), "<body></body>");
      await expect(
        buildHtmlFixture(dir, {
          plugins: [
            ...(resolve({ command: "build", mode: "production" }).plugins ?? []),
            {
              name: "late-html-asset",
              transformIndexHtml: {
                order: "pre",
                handler: (html) =>
                  `${html}<img src="${symlink ? "./lnk.txt" : relative(dir, outside)}">`,
              },
            },
          ],
        }),
      ).rejects.toThrow(/Web import outside/);
    },
  );

  it("keeps the default inline size limit for allowed HTML assets", async () => {
    const dir = fixture("");
    writeFileSync(join(dir, "small.txt"), "small allowed asset");
    writeFileSync(join(dir, "large.txt"), "large allowed asset".repeat(1000));
    const rootTarget = `/${relative(webRoot, join(dir, "small.txt"))}`;
    writeFileSync(
      join(dir, "index.html"),
      `<img src="small.txt"><img src="${rootTarget}"><img src="./large.txt">
       <style>body { background: image-set("${rootTarget}" 1x); }</style>
       <div style="background: url(${rootTarget})"></div>`,
    );
    const result = await buildHtmlFixture(dir);
    if (Array.isArray(result) || !("output" in result)) throw new Error("Expected one bundle");
    const html = result.output.find((output) => output.fileName.endsWith(".html"));
    if (html?.type !== "asset") throw new Error("Expected HTML asset");
    expect(html.source).toContain("data:text/plain;base64,");
    expect(result.output.some((output) => /assets\/large-.*\.txt$/.test(output.fileName))).toBe(
      true,
    );
    expect(result.output.some((output) => /assets\/small-.*\.txt$/.test(output.fileName))).toBe(
      false,
    );
  });

  it.each([false, true])("checks emitted asset provenance (relative: %s)", async (useRelative) => {
    const dir = fixture('console.log("asset provenance");');
    const outside = outsideFile();
    await expect(
      buildFixture(dir, {
        plugins: [
          ...(resolve({ command: "build", mode: "production" }).plugins ?? []),
          {
            name: "emitted-outside-fixture",
            buildStart() {
              this.emitFile({
                type: "asset",
                name: "outside.txt",
                source: "already read by another plugin",
                originalFileName: useRelative ? relative(webRoot, outside) : outside,
              });
            },
          },
        ],
      }),
    ).rejects.toThrow(/Web import outside/);
  });

  it.each(["\0", "\0commonjs-proxy:"])(
    "checks paths embedded in virtual ids (%s)",
    async (prefix) => {
      const dir = fixture('import data from "outside"; console.log(data);');
      const outside = outsideFile();
      await expect(
        buildFixture(dir, {
          plugins: [
            ...(resolve({ command: "build", mode: "production" }).plugins ?? []),
            {
              name: "virtual-outside-fixture",
              resolveId(id) {
                return id === "outside" ? `${prefix}${outside}?raw` : null;
              },
              load(id) {
                return id.startsWith(prefix) ? 'export default "outside";' : null;
              },
            },
          ],
        }),
      ).rejects.toThrow(/Web import outside/);
    },
  );

  it("allows relative and root-relative assets, nested CSS and non-file URLs", async () => {
    const dir = fixture("");
    const rootTarget = `/${relative(webRoot, join(dir, "allowed.txt"))}`;
    writeFileSync(
      join(dir, "main.js"),
      `
      import "./style.css";
      console.log(new URL("./allowed.txt", import.meta.url));
      console.log(new URL(${JSON.stringify(rootTarget)}, import.meta.url));
    `,
    );
    writeFileSync(join(dir, "allowed.txt"), "allowed web asset".repeat(1000));
    writeFileSync(join(dir, "style.css"), '@import "./nested.css";');
    writeFileSync(
      join(dir, "nested.css"),
      `
      @import "./style.css";
      @import "https://example.com/fonts.css";
      .relative { background: url('./allowed.txt'); }
      .root { background: url(${JSON.stringify(rootTarget)}); }
      .fragment { filter: url(#filter); }
      .external { background: url(https://example.com/image.png); }
      .data { background: url(data:image/png;base64,AA==); }
    `,
    );
    await expect(buildFixture(dir)).resolves.toBeDefined();
  });

  it("allows web assets, workspace packages, dependencies and Vite's virtual modules", async () => {
    const dir = fixture(`
      import "vite/modulepreload-polyfill";
      import React from "react";
      import * as core from "@mc/core";
      import text from "./allowed.txt?raw";
      console.log(React, core, text);
    `);
    writeFileSync(join(dir, "allowed.txt"), "allowed web asset");
    await expect(buildFixture(dir)).resolves.toBeDefined();
  });
});
