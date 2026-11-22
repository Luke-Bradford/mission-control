import "./temp-home.ts";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CONTROLLER_HEADER, HUB_SETTINGS, type HubSettingKey, OPERATOR_HEADER } from "@mc/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildApp, HUB_SETTINGS_OPERATOR_ONLY } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { ConfigWriteError } from "../src/config/config-write.ts";
import {
  CREW_FIRST_TEXT,
  readHubSettings,
  removeRepo,
  repoInUseText,
  setHubSetting,
} from "../src/config/hub-settings.ts";
import { loadConfig } from "../src/config.ts";
import { restartNeeded } from "../src/crew-apply.ts";
import { Store } from "../src/store.ts";

const EXAMPLE = resolve(import.meta.dirname, "../../../config.example.yaml");
const NOW = Date.parse("2026-11-22T12:00:00Z");
let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-hub-settings-"));
  path = join(dir, "config.yaml");
  writeFileSync(
    path,
    readFileSync(EXAMPLE, "utf8").replace("\ncrew:\n", `\ncrew:\n  node: ${process.execPath}\n`),
    { mode: 0o600 },
  );
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SAMPLES: Record<Exclude<HubSettingKey, `repo.${string}`>, unknown> = {
  "operator.timezone": "Europe/Paris",
  "operator.github_logins": ["octocat"],
  "poll.usage_minutes": 31,
  "poll.github_seconds": 61,
  "poll.board_minutes": 16,
  "updates.hub": "auto",
  "updates.cli": "between_runs",
  "audit.question_wait_minutes": 5,
  "audit.controller_wait_minutes": 6,
  "audit.ticket_text_factor": 3,
  "audit.notice_repeats": 4,
  "crew.worktrees": "~/code/other-worktrees",
  "crew.max_seats": 3,
  "crew.node": "/usr/local/bin/node",
  "crew.deny_read": ["~/.secrets"],
  "crew.allow_read": ["~/shared"],
  "crew.run_token_budget": 1234567,
  "crew.max_open_runs_per_seat": 3,
  "crew.lane": "work",
  "crew.lane_default": true,
  "crew.machine_capacity.disk_free_gb": 7,
  "crew.machine_capacity.disk_free_pct": 9,
  "crew.machine_capacity.swap_used_pct": 55,
  "crew.machine_capacity.memory_free_pct": 12,
  "crew.machine_capacity.load_per_core": 1.7,
  "crew.machine_capacity.load_window_min": 7,
  "crew.machine_capacity.clear_after_min": 8,
};
const REPO_SAMPLES: Record<string, unknown> = {
  "repo.status_map": {
    Todo: "planned",
    "In Progress": "in progress",
    Done: "done",
    Stuck: "blocked",
  },
  "repo.autonomy": "merge",
  "repo.flight_powers": "superuser",
};

const base = async () => (await readHubSettings(path)).base;

describe("hub settings", () => {
  it("each setting saves and applies when it says", async () => {
    // a merge repo needs a crew session
    const crewRepo = loadConfig(path).crew?.sessions[0]?.repoId;
    const firstRepo = { id: crewRepo };
    expect(firstRepo).toBeDefined();
    const entries: [HubSettingKey, unknown, string | undefined][] = [
      ...Object.entries(SAMPLES).map(([k, v]) => [k as HubSettingKey, v, undefined] as const),
      ...Object.entries(REPO_SAMPLES).map(
        ([k, v]) => [k as HubSettingKey, v, firstRepo?.id] as const,
      ),
    ].map((e) => [...e] as [HubSettingKey, unknown, string | undefined]);
    expect(entries.map((e) => e[0]).sort()).toEqual(Object.keys(HUB_SETTINGS).sort());
    for (const [key, value, repoId] of entries) {
      const before = loadConfig(path);
      await setHubSetting(path, await base(), key, value, NOW, repoId);
      const after = loadConfig(path);
      const needs = restartNeeded(before, after).length > 0;
      expect(needs, key).toBe(HUB_SETTINGS[key].applies === "restart");
      const view = await readHubSettings(path);
      const shown = repoId === undefined ? view.values[key] : view.repos[repoId]?.[key];
      expect(shown, key).toEqual(value);
    }
  });

  it("refuses a stale base, a bad value and a missing crew folder, leaving the file alone", async () => {
    const good = await base();
    await setHubSetting(path, good, "poll.board_minutes", 20, NOW);
    const before = readFileSync(path, "utf8");
    const stale = await setHubSetting(path, good, "poll.board_minutes", 21, NOW).catch((e) => e);
    expect(stale).toMatchObject({ kind: "conflict" });
    const bad = await setHubSetting(path, await base(), "poll.usage_minutes", 1, NOW).catch(
      (e) => e,
    );
    expect(bad).toBeInstanceOf(ConfigWriteError);
    expect(bad.kind).toBe("invalid");
    expect(readFileSync(path, "utf8")).toBe(before);
    const noCrew = join(dir, "bare.yaml");
    writeFileSync(
      noCrew,
      "operator:\n  timezone: UTC\naccounts: []\nrepos: []\nloops: []\npoll:\n  usage_minutes: 30\n  github_seconds: 60\n",
    );
    const view = await readHubSettings(noCrew);
    await expect(setHubSetting(noCrew, view.base, "crew.max_seats", 2, NOW)).rejects.toThrow(
      CREW_FIRST_TEXT,
    );
    await setHubSetting(noCrew, view.base, "crew.worktrees", join(dir, "crew"), NOW);
    expect(loadConfig(noCrew).crew?.sessions).toEqual([]);
  });

  it("null removes an optional key", async () => {
    await setHubSetting(path, await base(), "audit.notice_repeats", 4, NOW);
    await setHubSetting(path, await base(), "audit.notice_repeats", null, NOW);
    expect((await readHubSettings(path)).values["audit.notice_repeats"]).toBeUndefined();
  });

  it("removeRepo refuses a repo a loop or session uses, and removes a free one", async () => {
    const cfg = loadConfig(path);
    const used = cfg.loops[0]?.repoId ?? "";
    await expect(removeRepo(path, used, NOW)).rejects.toThrow(
      repoInUseText(used, [`loop ${cfg.loops[0]?.id}`]),
    );
    const free = cfg.repos.find(
      (r) =>
        !cfg.loops.some((l) => l.repoId === r.id) &&
        !cfg.crew?.sessions.some((s) => s.repoId === r.id),
    );
    if (free) {
      await removeRepo(path, free.id, NOW);
      expect(loadConfig(path).repos.some((r) => r.id === free.id)).toBe(false);
    }
  });

  describe("routes", () => {
    const changes = {
      sessions: [],
      pending: [],
      restartNeeded: [],
      error: null,
      checkedAt: NOW,
      applied: [],
    };
    const build = () => {
      const reload = vi.fn(async () => changes);
      const app = buildApp({
        config: loadConfig(path),
        store: new Store(":memory:"),
        operatorToken: "op",
        controllerToken: "ctl",
        bus: new ChangeBus(),
        configPath: path,
        seatWrites: true,
        crewReloader: {
          start: () => {},
          stop: () => {},
          settle: () => [],
          reload,
          status: () => changes,
        },
      });
      return { app, reload };
    };
    const call = async (app: ReturnType<typeof build>["app"], headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/api/config/settings",
        headers,
        payload: { base: await base(), key: "poll.board_minutes", value: 22 },
      });

    it("the operator saves and the config reloads; FLIGHT and the controller get 403", async () => {
      const { app, reload } = build();
      expect((await call(app, { [OPERATOR_HEADER]: "op" })).statusCode).toBe(200);
      expect(reload).toHaveBeenCalledTimes(1);
      const flight = await call(app, {
        [OPERATOR_HEADER]: "op",
        "x-mc-flight-actor": JSON.stringify({ seatId: "flight-1", runId: "r" }),
      });
      expect(flight.statusCode).toBe(403);
      const controller = await call(app, { [CONTROLLER_HEADER]: "ctl" });
      expect(controller.statusCode).toBe(403);
      expect(controller.json()).toEqual({ error: HUB_SETTINGS_OPERATOR_ONLY });
      expect(reload).toHaveBeenCalledTimes(1);
      expect((await readHubSettings(path)).values["poll.board_minutes"]).toBe(22);
    });
  });
});
