import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { NEW_LOOP, type PullRequestView, type Run } from "@mc/core";
import { afterEach, beforeEach, expect, it } from "vitest";
import { configFromDb, PARAM_ROUTES, timeOpening } from "../scripts/first-load-timings.ts";
import { buildApp } from "../src/api.ts";
import { ChangeBus } from "../src/bus.ts";
import { Store } from "../src/store.ts";

/** #2219: the timing script times what the pages ask for, and an erring request fails the run. */

const SCRIPT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../scripts/first-load-timings.ts",
);
const NOW = Date.now();
const SHA = "a".repeat(40);
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
        headSha: SHA,
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
  // a ticket on the board, a Comms message and a global order, as the live database has
  const db = (store as unknown as { db: DatabaseSync }).db;
  db.prepare(
    `INSERT INTO board_items (repo_id, issue_number, title, status, state, labels, updated_at, url)
     VALUES ('mission-control', 7, 'Ticket', 'Ready', 'open', '[]', ?, 'u')`,
  ).run(NOW);
  store.addComms({ from: "flight-1", to: "guido-1", text: "hello", at: NOW, ticket: null });
  db.prepare(
    "INSERT INTO standing_instructions (seat_id, kind, text, by, at) VALUES (NULL, 'text', 'Be brief', 'operator', ?)",
  ).run(NOW);
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
      db: writer,
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
  expect(run.notTimed).toContain("/api/config/settings: reads config.yaml; pass --config");
  expect(run.notTimed).toContain("/api/repos/:repoId/rules: reads config.yaml; pass --config");
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

it("times the parameterised requests of the Ticket, QA, Planner and Setup pages with real ids", async () => {
  const run = await time();
  const urls = run.rows.map((r) => r.url);
  for (const url of [
    // Ticket: its history, and the PRs on it
    "/api/tickets/mission-control/7",
    "/api/comms/tickets/%237?ticket=mission-control%237",
    // QA: the list, and the selected PR's detail and UAT
    "/api/qa/history?limit=50",
    "/api/qa-reports?repoId=mission-control&prNumber=1",
    `/api/repos/mission-control/prs/1?head=${SHA}`,
    `/api/qa/uat/mission-control/1?head=${SHA}`,
    `/api/prs/1/evidence?repo=mission-control&sha=${SHA}`,
    // Planner
    "/api/plans?repoId=mission-control",
    // Setup's tabs: repos' rules, seats' orders, sessions, accounts, hub
    "/api/seats/guido-1/instructions?limit=1",
    "/api/crew/sessions",
    "/api/accounts/status",
    "/api/repos",
    // the Agent page's side panels, and FLIGHT's retained order
    "/api/runs/guido-1-r/handoff",
    "/api/seats/guido-1/focus",
    "/api/flight/orders/1",
  ])
    expect(urls).toContain(url);
  expect(run.failed.map((r) => `${r.url} ${r.failure}`)).toEqual([]);
  // each left out with why; the live database has a QA report and an open Needs-you item
  expect(run.notTimed.sort()).toEqual(
    [
      "/api/accounts/:id/models: asks the account's CLI for its models once, then keeps them",
      "/api/agents/:id/files: runs git in the seat's worktree, not a database read",
      "/api/agents/:id/files/diff: runs git in the seat's worktree, not a database read",
      "/api/attention-material-assets/:id: serves a stored image, after the page's data",
      "/api/attention/:key/choice: no open Needs-you item in the database",
      "/api/attention/:key/materials: no open Needs-you item in the database",
      "/api/attention/:key/thread: no open Needs-you item in the database",
      "/api/attention/:key: no open Needs-you item in the database",
      "/api/boards/:repoId/items/:number: reads GitHub live, once per visit",
      "/api/boards/:repoId/setup: reads GitHub live, once per check",
      "/api/config/settings: reads config.yaml; pass --config",
      "/api/hud-screenshots/:id: serves a stored image, after the page's data",
      "/api/plan-assets/:id: serves a stored image, after the page's data",
      "/api/prs/:n/evidence/:sha/:name: serves a stored image, after the page's data",
      "/api/qa-report-assets/:id: serves a stored image, after the page's data",
      "/api/qa-reports/:id/markdown: no QA report in the database",
      "/api/qa-reports/:id: no QA report in the database",
      "/api/qa/history/native/:id: opens on a past native review, by an identity hash the history list carries",
      "/api/qa/review-shots/:id: serves a stored image, after the page's data",
      "/api/repos/:repoId/rules: reads config.yaml; pass --config",
      "/api/seats/:id/context: reads the seat's CLI live, not the database",
    ].sort(),
  );
}, 60_000);

it("accounts for every GET route with a path parameter: timed, or not timed with why", async () => {
  const store = new Store(path);
  const app = buildApp({
    config: configFromDb(new DatabaseSync(path)),
    store,
    bus: new ChangeBus(),
    noLoopWrites: true,
  });
  const routes: string[] = [];
  app.addHook("onRoute", (r) => {
    if ([r.method].flat().includes("GET") && r.url.startsWith("/api/") && r.url.includes(":"))
      routes.push(r.url);
  });
  await app.ready();
  await app.close();
  store.close();
  expect(routes.length).toBeGreaterThan(20);
  expect(routes.filter((r) => !(r in PARAM_ROUTES))).toEqual([]);
});
