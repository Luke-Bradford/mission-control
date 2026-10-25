import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { type DefaultTreeAdapterTypes, parse } from "parse5";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/** The live hub's port (launchd `com.missioncontrol.server`): the dev server never proxies to it. */
const LIVE_PORT = 7420;
/** The preview server's port (`MC_PORT=7431 MC_DB=<copy> MC_NO_LOOP_WRITES=1`, docs/runbook.md). */
const PREVIEW_PORT = "7431";

function webImportGuard(): Plugin {
  const webRoot = fileURLToPath(new URL("./", import.meta.url));
  let viteRoot = webRoot;
  const sourceRoots = ["./", "../../packages/"].map((path) =>
    realpathSync(fileURLToPath(new URL(path, import.meta.url))),
  );
  const roots = [...sourceRoots];
  try {
    roots.push(realpathSync(fileURLToPath(new URL("../../node_modules/", import.meta.url))));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const cleanId = (id: string) => id.replace(/\?[^/]*$/, "");
  const within = (file: string, root: string) => file === root || file.startsWith(`${root}${sep}`);
  const isInsideRoots = (file: string) => roots.some((root) => within(file, root));
  const guard = (id: string) => {
    let file = cleanId(id);
    if (file.startsWith("\0")) {
      // Virtual wrappers can still carry a real file path; plain virtual names are harmless.
      file = file.slice(1).match(/(?:^|[:=\s])((?:[A-Za-z]:[\\/]|\/).*)/)?.[1] ?? "";
    }
    if (!isAbsolute(file)) return;
    const path = existsSync(file) ? realpathSync(file) : resolve(file);
    if (!isInsideRoots(path)) {
      throw new Error(`Web import outside apps/web, packages and node_modules: ${id}`);
    }
  };
  const checkTarget = (target: string, importer: string, fsFallback = true) => {
    if (/^(?:data:|https?:|\/\/|#)/i.test(target)) return;
    const file = target.replace(/[?#][^/]*$/, "");
    // Bare package specifiers are resolved separately by Vite.
    if (!file.startsWith(".") && !isAbsolute(file)) return;
    let path = file.startsWith("/")
      ? resolve(viteRoot, `.${file}`)
      : resolve(dirname(importer), file);
    guard(path);
    // Vite falls back to an absolute filesystem path when the root-relative file is absent.
    if (fsFallback && isAbsolute(file) && !existsSync(path) && existsSync(file)) {
      guard(file);
      path = file;
    }
    return path;
  };
  const scanCss = (code: string, id: string, visited: Set<string>) => {
    const path = existsSync(id) ? realpathSync(id) : id;
    if (visited.has(path)) return;
    visited.add(path);
    const css = code.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/gi)) {
      checkTarget(decodeURI((match[1] ?? match[2] ?? match[3]).trim()), id);
    }
    // image-set also accepts bare strings; nested functions can precede later candidates.
    for (const match of css.matchAll(
      /\b(?:-webkit-)?image-set\(((?:"[^"]*"|'[^']*'|[^()"']|\([^)]*\))*)\)/gi,
    )) {
      for (const quoted of match[1].matchAll(/"([^"]*)"|'([^']*)'/g)) {
        checkTarget(decodeURI(quoted[1] ?? quoted[2]), id);
      }
    }
    for (const match of css.matchAll(
      /@(?:import|use|forward)\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|"([^"]*)"|'([^']*)')/gi,
    )) {
      const target = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]).trim();
      const imported = checkTarget(decodeURI(target), id);
      // postcss-import reads these files itself, without calling our load/transform hooks.
      if (imported && existsSync(imported)) {
        scanCss(readFileSync(imported, "utf8"), imported, visited);
      }
    }
  };
  return {
    name: "web-import-guard",
    // The dev server is out of scope; server.fs.strict covers it.
    apply: "build",
    // Run before Vite's asset loader and internal CSS/URL transforms can read files.
    enforce: "pre",
    config() {
      return {
        build: {
          // Leave Vite's default size limit intact inside the roots. Outside assets must
          // be emitted so generateBundle can reject their originalFileNames.
          assetsInlineLimit: (file) => (isInsideRoots(realpathSync(file)) ? undefined : false),
        },
      };
    },
    configResolved(config) {
      viteRoot = config.root;
    },
    transformIndexHtml: {
      order: "pre",
      handler(html, ctx) {
        const checkHtmlTarget = (value: string, fsFallback = true) => {
          const target = decodeURI(value.trim());
          if (!target || /^(?:[a-z][\w+.-]*:|\/\/|#)/i.test(target)) return;
          // Unlike module specifiers, bare HTML URLs are relative to the HTML file.
          checkTarget(target.startsWith("/") ? target : `./${target}`, ctx.filename, fsFallback);
        };
        const visit = (node: DefaultTreeAdapterTypes.Node) => {
          if ("tagName" in node) {
            if (node.tagName === "style") {
              const css = node.childNodes
                .map((child) => ("value" in child ? child.value : ""))
                .join("");
              scanCss(css, ctx.filename, new Set());
            }
            for (const { name, value } of node.attrs) {
              if ((node.tagName === "a" || node.tagName === "area") && name === "href") continue;
              if (name === "style") {
                scanCss(value, ctx.filename, new Set());
              } else if (name === "srcset" || name === "imagesrcset") {
                // Match Vite's candidate boundaries, including commas within URLs.
                for (const candidate of value
                  .trim()
                  .matchAll(
                    /(?:^|\s|(?<=,))("[^"]*"|'[^']*'|[^,]\S*[^,])\s*(?:\s\w[^,]+)?(?:,|$)/g,
                  )) {
                  checkHtmlTarget(candidate[1].replace(/^("|')(.*)\1$/, "$2"));
                }
              } else if (
                /^(?:src|href|poster)$/.test(name) ||
                (name.startsWith("data-") && /^(?:\.{1,2}\/|\/)|[/.?]/.test(value.trim()))
              ) {
                checkHtmlTarget(
                  value,
                  !name.startsWith("data-") || /^(?:data-src|data-srcset)$/.test(name),
                );
              }
            }
            if ("content" in node) visit(node.content);
          }
          if ("childNodes" in node) node.childNodes.forEach(visit);
        };
        visit(parse(html));
      },
    },
    async resolveId(source, importer, options) {
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (resolved) guard(resolved.id);
      return resolved;
    },
    load(id) {
      guard(id);
      return null;
    },
    transform(code, id) {
      const file = cleanId(id);
      if (/\.(css|scss|less)$/i.test(file)) {
        scanCss(code, file, new Set());
      } else if (sourceRoots.some((root) => within(file, root)) && /\.[cm]?[jt]sx?$/i.test(file)) {
        for (const match of code.matchAll(
          /\bnew\s+URL\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*,\s*import\.meta\.url\s*,?\s*\)/g,
        )) {
          if (match[1] === "`" && match[2].includes("${")) continue;
          checkTarget(match[2], file);
        }
      }
      return null;
    },
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "asset") continue;
          for (const file of output.originalFileNames) guard(resolve(viteRoot, file));
        }
      },
    },
  };
}

export default defineConfig(({ command }) => {
  // Read here, not at module level, so each resolution (and each test) sees the current env.
  const port = process.env.MC_PORT || PREVIEW_PORT;
  // Update (apps/server/src/update.ts) builds into dist-next beside the live dist, then swaps.
  const outDir = process.env.MC_WEB_OUTDIR || "dist";
  // vitest also resolves this config as `serve`; only the real dev server is refused.
  if (command === "serve" && !process.env.VITEST && Number(port) === LIVE_PORT) {
    throw new Error(
      `MC_PORT=${LIVE_PORT} is the live hub: the dev server proxies to a preview server only, so it ` +
        "cannot post acks, away settings or a PAUSE into live data. Start one with " +
        `MC_PORT=${PREVIEW_PORT} MC_DB=<copy> MC_NO_LOOP_WRITES=1 (docs/runbook.md).`,
    );
  }
  // changeOrigin rewrites Host to 127.0.0.1:<port>, so proxied requests pass the server's host allowlist.
  const proxied = { target: `http://127.0.0.1:${port}`, changeOrigin: true };
  return {
    plugins: [webImportGuard(), react()],
    worker: { plugins: () => [webImportGuard()] },
    server: {
      proxy: {
        "/api/stream": {
          ...proxied,
          // SSE: never buffer or compress the event stream on its way through the proxy.
          configure: (proxy) => {
            // http-proxy pipes the response as it arrives; also drop the upstream stream when the
            // browser goes away, so closed tabs do not leave SSE subscribers on the server.
            proxy.on("proxyReq", (proxyReq, _req, res) => {
              res.on("close", () => proxyReq.destroy());
            });
          },
        },
        "/api": proxied,
      },
    },
    build: { outDir, emptyOutDir: true, sourcemap: false },
    test: {
      name: "web",
      environment: "jsdom",
      include: ["test/**/*.test.{ts,tsx}"],
      setupFiles: ["test/setup.ts"],
    },
  };
});
