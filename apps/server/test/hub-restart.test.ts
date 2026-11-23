import "./temp-home.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONTROLLER_HEADER, OPERATOR_HEADER } from "@mc/core";
import { describe, expect, it, vi } from "vitest";
import { buildApp, HUB_SETTINGS_OPERATOR_ONLY, RESTART_OPERATOR_ONLY, RESTART_UNAVAILABLE } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { readHubSettings } from "../src/config/hub-settings.ts";
import { loadConfig } from "../src/config.ts";
import { Store } from "../src/store.ts";

const config = () => loadConfig(resolve(import.meta.dirname, "../../../config.example.yaml"));
const build = (restartHub?: () => void) =>
  buildApp({
    config: config(),
    store: new Store(":memory:"),
    operatorToken: "op",
    controllerToken: "ctl",
    bus: new ChangeBus(),
    restartHub,
  });
const post = (app: ReturnType<typeof build>, headers: Record<string, string>) =>
  app.inject({ method: "POST", url: "/api/hub/restart", headers, payload: {} });

describe("POST /api/hub/restart", () => {
  it("the operator gets 202 and the restart runs once", async () => {
    const restartHub = vi.fn();
    const r = await post(build(restartHub), { [OPERATOR_HEADER]: "op" });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ restarting: true });
    expect(restartHub).toHaveBeenCalledTimes(1);
  });

  it("a FLIGHT actor or the controller gets 403 and nothing runs", async () => {
    const restartHub = vi.fn();
    const app = build(restartHub);
    const flight = await post(app, {
      [OPERATOR_HEADER]: "op",
      "x-mc-flight-actor": JSON.stringify({ seatId: "flight-1", runId: "r" }),
    });
    expect(flight.statusCode).toBe(403);
    const ctl = await post(app, { [CONTROLLER_HEADER]: "ctl" });
    expect(ctl.statusCode).toBe(403);
    expect(ctl.json()).toEqual({ error: RESTART_OPERATOR_ONLY });
    expect(restartHub).not.toHaveBeenCalled();
  });

  it("answers 409 when the hub cannot restart itself", async () => {
    const r = await post(build(), { [OPERATOR_HEADER]: "op" });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: RESTART_UNAVAILABLE });
  });
});

describe("a real FLIGHT actor", () => {
  it("gets 403 from settings, remove-repo and restart, and nothing changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-flight-actor-"));
    try {
      const path = join(dir, "config.yaml");
      const text = readFileSync(
        resolve(import.meta.dirname, "../../../config.example.yaml"),
        "utf8",
      ).replace(
        "        - { id: retro-1,",
        "        - { id: flight-1, role: FLIGHT, account_id: claude-main }\n        - { id: retro-1,",
      );
      writeFileSync(path, text, { mode: 0o600 });
      const cfg = loadConfig(path);
      const store = new Store(":memory:");
      store.upsertRun({
        id: "flight:1",
        agentId: "flight-1",
        repoId: cfg.repos[0]?.id ?? "",
        seq: 1,
        startedAt: 1,
        endedAt: null,
        status: "running",
        sessionId: "s",
        model: "opus",
        branch: null,
        ticket: null,
        costUsd: null,
        tokens: null,
        transcriptPath: "/x",
        prs: [],
        summary: null,
        loop: null,
      });
      const reload = vi.fn();
      const restartHub = vi.fn();
      const app = buildApp({
        config: cfg,
        store,
        operatorToken: "op",
        controllerToken: "ctl",
        bus: new ChangeBus(),
        configPath: path,
        seatWrites: true,
        restartHub,
        crewReloader: {
          start: () => {},
          stop: () => {},
          settle: () => [],
          reload,
          status: () => ({
            sessions: [],
            pending: [],
            restartNeeded: [],
            error: null,
            checkedAt: 1,
            applied: [],
          }),
        } as never,
      });
      const headers = {
        [OPERATOR_HEADER]: "op",
        "x-mc-flight-actor": JSON.stringify({ seatId: "flight-1", runId: "flight:1" }),
      };
      const before = readFileSync(path);
      const base = (await readHubSettings(path)).base;
      const events = store.hubEvents(0);
      const settings = await app.inject({
        method: "POST",
        url: "/api/config/settings",
        headers,
        payload: { base, key: "poll.board_minutes", value: 22 },
      });
      const unused = cfg.repos.find((r) => !cfg.loops.some((l) => l.repoId === r.id))?.id ?? "x";
      const removal = await app.inject({
        method: "DELETE",
        url: `/api/repos/${unused}`,
        headers,
      });
      const restart = await app.inject({
        method: "POST",
        url: "/api/hub/restart",
        headers,
        payload: {},
      });
      expect([settings.statusCode, removal.statusCode, restart.statusCode]).toEqual([403, 403, 403]);
      expect(settings.json()).toEqual({ error: HUB_SETTINGS_OPERATOR_ONLY });
      expect(restart.json()).toEqual({ error: RESTART_OPERATOR_ONLY });
      expect(readFileSync(path)).toEqual(before);
      expect(reload).not.toHaveBeenCalled();
      expect(restartHub).not.toHaveBeenCalled();
      expect(store.hubEvents(0)).toEqual(events);
      await app.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
