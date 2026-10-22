// @vitest-environment node
// vite (esbuild) needs Node's own TextEncoder, which jsdom replaces.
import type { ProxyOptions, UserConfig } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import config from "../vite.config.ts";

const dev = { command: "serve", mode: "development" } as const;

const resolve = (env: Parameters<typeof config>[0]) => config(env) as UserConfig;
const proxy = (c: UserConfig, path: string) => c.server?.proxy?.[path] as ProxyOptions;
const target = (c: UserConfig) => proxy(c, "/api").target;

afterEach(() => {
  vi.unstubAllEnvs();
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
});
