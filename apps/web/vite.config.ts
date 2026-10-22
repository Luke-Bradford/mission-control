import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/** The live hub's port (launchd `com.missioncontrol.server`): the dev server never proxies to it. */
const LIVE_PORT = 7420;
/** The preview server's port (`MC_PORT=7431 MC_DB=<copy> MC_NO_LOOP_WRITES=1`, docs/runbook.md). */
const PREVIEW_PORT = "7431";

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
    plugins: [react()],
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
