import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { NEW_LOOP, type PullRequestView, type Run } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configFromDb, timeOpening } from "../scripts/first-load-timings.ts";
import { Store } from "../src/store.ts";

/** #2219: the timing script times what the pages ask for, and an erring request fails the run. */

const SCRIPT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../scripts/first-load-timings.ts",
);
const NOW = Date.now();
let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-timings-test-"));
  path = join(dir, "mc.sqlite");
  const store = new Store(path);
  store.upsertPullRequests(
    "mission-control",
    [
      {
        repoId: "mission-control",
        number: 1,
        title: "t",
        url: "u",
        branch: "b",
        ticket: null,
        state: "open",
        isDraft: false,
        review: null,
        ci: null,
        createdAt: 1,
        updatedAt: 1,
        mergedAt: null,
        headSha: "h",
        mergeable: null,
        checks: [],
      } satisfies PullRequestView,
    ],
    NOW,
  );
  for (const id of ["flight-1", "guido-1"])
    store.upsertRun({
      id: `${id}-r`,
      agentId: id,
      repoId: "mission-control",
      seq: 1,
      startedAt: NOW - 1000,
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
      loop: { ...NEW_LOOP },
    } satisfies Run);
  store.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function time(urls?: string[]) {
  const writer = new DatabaseSync(path);
  const store = new Store(path);
  try {
    return await timeOpening({
      store,
      config: configFromDb(writer),
      rounds: 1,
      touch: () => {
        writer
          .prepare("UPDATE runs SET summary = ? WHERE id = 'guido-1-r'")
          .run(String(Math.random()));
      },
      ...(urls === undefined ? {} : { urls }),
    });
  } finally {
    store.close();
    writer.close();
  }
}

it("times the shell's reads, each page's first load and its routes with parameters", async () => {
  const run = await time();
  const urls = run.rows.map((r) => r.url);
  for (const url of [
    // the shell's, on every page
    "/api/config",
    "/api/attention",
    "/api/flight/summary",
    "/api/comms/mentions",
    "/api/version",
    // pages' own reads
    "/api/overview",
    "/api/away/digest",
    "/api/telemetry?range=7d",
    // first-load routes with a path parameter, and a query the web always sends
    "/api/repos/mission-control/prs?shape=summary",
    "/api/agents/flight-1/stream?limit=20",
    "/api/comms/agents/guido-1?summary=1",
    "/api/flight/memory?repo=mission-control",
  ])
    expect(urls).toContain(url);
  expect(run.failed.map((r) => `${r.url} ${r.failure}`)).toEqual([]);
  expect(run.notTimed).toEqual(["/api/config/settings: reads config.yaml; pass --config"]);
}, 60_000);

it("fails a request that errs, cold or warm, instead of counting it as fast", async () => {
  const run = await time(["/api/definitely-missing", "/api/overview"]);
  expect(run.failed.map((r) => [r.url, r.failure])).toEqual([
    ["/api/definitely-missing", "answered 404"],
  ]);
  expect(run.slow).toEqual([]);
});

it("exits 1 when a request errs", () => {
  const out = spawnSync(
    process.execPath,
    ["--experimental-strip-types", SCRIPT, "--db", path, "--rounds", "1", "--only", "/api/nope"],
    { encoding: "utf8" },
  );
  expect(out.stdout).toContain("FAILED /api/nope: answered 404");
  expect(out.status).toBe(1);
}, 60_000);
