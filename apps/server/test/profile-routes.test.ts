import "./temp-home.ts";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PROFILES, type Run } from "@mc/core";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { profileHash } from "../src/profiles.ts";
import { Store } from "../src/store.ts";

describe("POST /api/profiles", () => {
  it("creates a validated user template, rejects stale or invalid requests and keeps HTTP guards", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mc-template-route-"));
    const path = join(dir, "profiles.yaml");
    const store = new Store(join(dir, "store.sqlite"));
    const app = buildApp({
      config: {
        operator: { id: "operator", timezone: "UTC" },
        accounts: [],
        repos: [],
        loops: [],
        poll: { usageMinutes: 30, githubSeconds: 60 },
      },
      store,
      bus: new ChangeBus(),
      profilesPath: path,
      githubGql: async () => async () => ({ viewer: { login: "operator" } }),
    });
    const profile = DEFAULT_PROFILES[0];
    if (!profile) throw new Error("missing feature profile");
    const snapshot = {
      profile,
      hash: profileHash(profile),
      route: { by: "size" as const, size: "M" },
    };
    store.upsertRun({
      id: "active",
      agentId: "guido-1",
      repoId: "repo",
      seq: 1,
      startedAt: 1,
      endedAt: null,
      status: "running",
      sessionId: null,
      model: null,
      branch: null,
      ticket: null,
      costUsd: null,
      tokens: null,
      transcriptPath: "",
      prs: [],
      summary: null,
      profile: snapshot,
    } satisfies Run);
    try {
      const config = (await app.inject({ method: "GET", url: "/api/config" })).json();
      expect(config.profiles.list).toHaveLength(7);
      const payload = {
        base: config.profiles.version,
        profile: {
          name: "custom",
          labels: ["type:custom"],
          steps: [{ name: "implement", phase: "working" }],
          plan_required: false,
          reviewer: { role: "RETRO", depth: "light" },
          tries: 2,
          rounds: 2,
        },
      };
      const post = (body: object | string, headers = {}) =>
        app.inject({ method: "POST", url: "/api/profiles", payload: body, headers });
      for (const steps of [
        Array.from({ length: 31 }, (_, i) => ({ name: `step-${i}`, phase: "working" })),
        [{ name: "x".repeat(101), phase: "working" }],
      ]) {
        const rejected = await post({ ...payload, profile: { ...payload.profile, steps } });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json().error).toContain("Too big");
      }
      const added = await post(payload);
      expect(added.statusCode).toBe(201);
      expect(added.json().list.at(-1).name).toBe("custom");
      const bytes = readFileSync(path, "utf8");
      expect((await post(payload)).statusCode).toBe(409);
      expect((await post({ ...payload, base: added.json().version })).statusCode).toBe(409);
      expect(
        (
          await post({
            ...payload,
            profile: { ...payload.profile, name: "bad", steps: [{ name: "work", phase: "shell" }] },
          })
        ).statusCode,
      ).toBe(400);
      expect((await post(payload, { origin: "https://untrusted.invalid" })).statusCode).toBe(403);
      expect((await post("plain", { "content-type": "text/plain" })).statusCode).toBe(415);
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(store.run("active")?.profile).toEqual(snapshot);
    } finally {
      await app.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
