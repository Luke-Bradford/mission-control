import "./temp-home.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const EXAMPLE = resolve(import.meta.dirname, "../../../config.example.yaml");
let dir: string;
let configPath: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-plan-setting-"));
  configPath = join(dir, "config.yaml");
  writeFileSync(
    configPath,
    readFileSync(EXAMPLE, "utf8").replace("\ncrew:\n", `\ncrew:\n  node: ${process.execPath}\n`),
    { mode: 0o600 },
  );
  store = new Store(join(dir, "mc.sqlite"));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const appFor = () => {
  const config = loadConfig(configPath);
  const app = buildApp({ config, configPath, store, bus: new ChangeBus(), now: () => 1 });
  return { app, config };
};

describe("the per-repo plan sign-off setting", () => {
  it("plan_signoff is in the rules view with its source", async () => {
    const { app } = appFor();
    const view = (await app.inject("/api/repos/shop-app/rules")).json();
    expect(view.rules.plan_signoff).toEqual({ value: "never", source: "default" });
    await app.close();
  });

  it("POST /api/repos/:repoId/rules saves it and the live rules change at once", async () => {
    const { app, config } = appFor();
    const { base } = (await app.inject("/api/repos/shop-app/rules")).json();
    const saved = await app.inject({
      method: "POST",
      url: "/api/repos/shop-app/rules",
      payload: { base, rules: { plan_signoff: "larger" } },
    });
    expect(saved.statusCode).toBe(200);
    expect(config.repos.find((r) => r.id === "shop-app")?.rules?.planSignoff).toBe("larger");
    expect(readFileSync(configPath, "utf8")).toContain("plan_signoff: larger");
    const view = (await app.inject("/api/repos/shop-app/rules")).json();
    expect(view.rules.plan_signoff).toEqual({ value: "larger", source: "set-here" });
    await app.close();
  });

  it("an unknown value is refused and nothing is written", async () => {
    const { app } = appFor();
    const { base } = (await app.inject("/api/repos/shop-app/rules")).json();
    const before = readFileSync(configPath, "utf8");
    const bad = await app.inject({
      method: "POST",
      url: "/api/repos/shop-app/rules",
      payload: { base, rules: { plan_signoff: "sometimes" } },
    });
    expect(bad.statusCode).toBe(400);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    await app.close();
  });
});
